/**
 * session/exec-runner.ts — run a PARSED pipeline with real pipes and no shell (Phase 2).
 *
 * The parser gave us `Stage[]`; this spawns them. Everything that makes it safe was decided
 * upstream — what remains here is making sure the execution matches the thing that was
 * approved, and that nothing outlives the turn:
 *
 *   - `spawn(argv[0], argv.slice(1), {shell:false})` per stage, `stdout → stdin` wired
 *     between them. A shell is never involved, so the `|` the model wrote is implemented by
 *     us rather than interpreted by anything.
 *   - Hardened env via `safeChildEnv()`, and the process gets its own GROUP so a timeout
 *     kills grandchildren too.
 *   - Every child is registered with the orphan-guard, with `command` matching what
 *     `ps -o command=` prints — the post-mortem sweep refuses to reap anything it cannot
 *     positively identify, so a mismatch here means a leaked process later.
 *   - Wall-clock timeout, SIGTERM then SIGKILL, and output capped per stream.
 *
 * `child_process` is engine-bridge's exclusive static import (C5); the sanctioned escape
 * hatch for a host module is a runtime `createRequire`, which is what `orphan-guard-boot.ts`
 * and `spawn-capture.ts` already do.
 */

import { openSync } from "node:fs";
import { createRequire } from "node:module";
// aliased: the plain name is shadowed by the Promise executor's own `resolve` in this scope.
import { resolve as resolvePath } from "node:path";

import { safeChildEnv } from "@prometheus/engine-bridge";
import type { ParsedCommand, Stage } from "../../exec/index.js";

import { type SandboxPlan, sandboxArgv } from "./exec-sandbox.js";
import { trackChild } from "./reaper/child-reaper.js";

// `node:child_process` is engine-bridge's EXCLUSIVE static import (C5). A runtime require is
// the sanctioned escape hatch for a host module that must spawn — `orphan-guard-boot.ts` and
// `orchestration/spawn-capture.ts` do the same, with the same `nodeRequire` name.
const nodeRequire = createRequire(import.meta.url);

/** The pieces of `child_process` this module needs, resolved at runtime (C5). */
interface SpawnLike {
  spawn(
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
  ): {
    pid?: number;
    stdout: { on(e: "data", cb: (c: Buffer) => void): void } | null;
    stderr: { on(e: "data", cb: (c: Buffer) => void): void } | null;
    stdin: { end(): void; write(c: Buffer): void } | null;
    on(e: "error" | "close", cb: (a?: unknown, b?: unknown) => void): void;
    kill(sig?: string): void;
  };
}

/** Per-stream capture ceiling. A runaway `cat` must not balloon the host's memory. */
const MAX_STREAM_BYTES = 256 * 1024;
/** Default wall-clock for one pipeline. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Hard ceiling a caller may not exceed. */
export const MAX_EXEC_TIMEOUT_MS = 600_000;
/** Grace between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

export interface ExecPipelineResult {
  /** the exit code of the LAST stage — the pipeline's code, as a shell would report it. */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * The pipeline was CANCELLED — a job kill, or the turn's abort signal.
   *
   * Reported separately because the exit code cannot carry it. A child killed by SIGTERM
   * closes with `code === null`, `typeof null !== "number"`, and the close handler therefore
   * left `lastCode` at its initial `0` — so a cancelled `npm test` came back as `exit 0`,
   * indistinguishable from a passing one. A model reading that concludes the tests passed and
   * moves on, which is the worst possible reading of "the user pressed ESC".
   */
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
  /** exactly what ran, post-parse — the audit record. */
  argvExecuted: string[][];
}

export interface RunPipelineOptions {
  cwd: string;
  timeoutMs?: number;
  /**
   * Live output, as it arrives.
   *
   * A `ToolRunner` resolves ONCE — the agent loop has no way for a tool to emit anything
   * mid-flight — so streaming has to leave through a side channel the host owns. This is it:
   * the CLI passes its terminal writer, and a four-minute `pip install` shows progress
   * instead of four minutes of nothing followed by a wall of text.
   */
  onOutput?: (chunk: string) => void;
  /** aborts the pipeline (a background job being killed, a turn being cancelled). */
  signal?: AbortSignal;
  /** injected for tests so no suite ever spawns a real process. */
  spawnImpl?: SpawnLike["spawn"];
  /**
   * The OS-level confinement to apply, decided by the caller (exec-sandbox.ts).
   *
   * REQUIRED for a REAL spawn — see `sandboxRefusal` below. It is optional in the type only
   * because a `spawnImpl` test fake never reaches the operating system, and forcing every
   * such test to build a Seatbelt profile would make the tests less honest, not more.
   */
  sandbox?: SandboxPlan;
}

/**
 * Fail-closed guard: a REAL spawn must carry an explicit sandbox decision.
 *
 * The decision itself is the caller's (system-tools.ts knows the working set and the
 * authorization level; this module does not). What this refuses is the case that has
 * historically been the actual bug — a new call site that simply forgot, and therefore ran
 * with the user's full ambient authority while everyone assumed it was confined. `{kind:
 * "none"}` is a valid, deliberate answer ("no sandbox exists on this platform"); `undefined`
 * is not an answer at all.
 *
 * A `spawnImpl` is exempt because it is a fake by construction — it cannot reach the kernel.
 */
function sandboxRefusal(opts: RunPipelineOptions): string | null {
  if (opts.spawnImpl) return null;
  if (!opts.sandbox) {
    return "refused: this call reached the process runner with no sandbox decision, and a real spawn is never made unconfined";
  }
  // A plan that FAILED to build is refused here too, not merely at the caller. `sandboxArgv`
  // returns the bare argv for anything that is not a built profile, so an `error` plan
  // reaching the spawn would be an unconfined run — the exact silent downgrade this whole
  // module exists to prevent.
  if (opts.sandbox.kind === "error") {
    return `refused: the OS sandbox could not be established (${opts.sandbox.error})`;
  }
  return null;
}

/**
 * Append, capping from the MIDDLE — keep the head AND the tail.
 *
 * The first version kept only the head, which is the wrong half for what this most often
 * caps. A failed `pip install` or `tsc` build puts its error at the END, so head-only
 * truncation shows the boring preamble and drops the reason. Tail-only would be wrong the
 * other way (a `cat` of a large file is most useful from the top), so this keeps both and
 * states how much it dropped — the shape core's `capBytes` already uses on the thread budget.
 */
function cap(buf: string, extra: string): { text: string; truncated: boolean } {
  const next = buf + extra;
  if (next.length <= MAX_STREAM_BYTES) return { text: next, truncated: false };
  const half = Math.floor(MAX_STREAM_BYTES / 2);
  const dropped = next.length - 2 * half;
  return {
    text: `${next.slice(0, half)}\n…[${dropped} characters elided]…\n${next.slice(next.length - half)}`,
    truncated: true,
  };
}

/**
 * Run ONE pipeline (the `|`-joined stages of a single command).
 *
 * Stages are spawned together and wired in-process, which is what a shell does — the
 * difference is that we hold the argv arrays the classifier approved rather than re-parsing
 * a string.
 */
async function runOnePipeline(
  stages: Stage[],
  opts: RunPipelineOptions,
): Promise<ExecPipelineResult> {
  const spawn = opts.spawnImpl ?? (nodeRequire("node:child_process") as SpawnLike).spawn;
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);
  const startedAt = Date.now();

  let stdout = "";
  let stderr = "";
  let truncated = false;
  let timedOut = false;
  /** latched by `onAbort` — a cancel, not a clean exit. */
  let aborted = false;

  const children: { pid?: number; kill(sig?: string): void }[] = [];
  const untrackers: (() => void)[] = [];

  const result = await new Promise<number>((resolve) => {
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve(code);
    };

    const procs = stages.map((stage, idx) => {
      const isLast = idx === stages.length - 1;
      const redirOut = stage.redirects.find((r) => r.stream === "stdout" && r.kind === "file");
      const redirIn = stage.redirects.find((r) => r.stream === "stdin" && r.kind === "file");
      const mergeErr = stage.redirects.some((r) => r.kind === "merge");

      // A file redirect is opened HERE, by us, with an explicit flag — never handed to a
      // shell to interpret. `>` truncates, `>>` appends, exactly as the parse recorded.
      let outFd: number | undefined;
      if (redirOut?.target) {
        try {
          // Resolve against the SESSION cwd, which is what the path guard checked. `openSync`
          // resolves a relative path against the HOST process cwd, so with `--cwd` set (or
          // after a `cd`) the guard validated `<session>/x` while the runner wrote
          // `<host>/x` — measured, and enough to append to `~/.zshrc` from a working set
          // that did not contain it.
          outFd = openSync(resolvePath(opts.cwd, redirOut.target), redirOut.append ? "a" : "w");
        } catch {
          /* fall back to capture; the command will usually fail on its own terms */
        }
      }
      let inFd: number | undefined;
      if (redirIn?.target) {
        try {
          inFd = openSync(resolvePath(opts.cwd, redirIn.target), "r");
        } catch {
          /* leave stdin as a pipe we immediately close */
        }
      }

      // The LAST thing that happens to the argv: hooks, ladder, confirm, nemesis and the
      // screen have all already said yes, and this only narrows what the approved argv may
      // do. Unwrapped when there is no confinement to apply — a platform without a primitive,
      // or a `spawnImpl` fake, which is not a process and cannot be confined by a kernel
      // policy (a suite asserting on the argv it was handed must see the argv, not the
      // wrapper). Only a REAL spawn reaches `sandboxArgv`, and `sandboxRefusal` above has
      // already guaranteed that a real spawn carries a plan.
      const argv = opts.spawnImpl ? [...stage.argv] : sandboxArgv(opts.sandbox, stage.argv);
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: opts.cwd,
        shell: false,
        env: safeChildEnv(),
        // own process group: a timeout must be able to kill grandchildren too
        detached: true,
        stdio: [
          inFd !== undefined ? inFd : idx === 0 ? "ignore" : "pipe",
          outFd !== undefined ? outFd : "pipe",
          "pipe",
        ],
      });
      children.push(child);
      if (typeof child.pid === "number") {
        // The registry stamps its own pid-reuse identity (the process START TIME, read from
        // `ps` by the delegate), so `command` here is purely what a human reads in the
        // registry file. An earlier version had this call site compute the identity itself
        // and got it wrong: it sampled `ps -o command=` right after spawn, which for a
        // shebang or wrapper child returns the PRE-exec command line and therefore never
        // matched at sweep time. `pip install` — this phase's acceptance criterion — leaked
        // an orphan every run because of it.
        untrackers.push(
          trackChild({
            pid: child.pid,
            group: true,
            label: "agent-exec",
            command: stage.argv.join(" "),
          }),
        );
      }
      child.stderr?.on("data", (c) => {
        const text = c.toString();
        opts.onOutput?.(text);
        if (mergeErr) {
          const r = cap(stdout, text);
          stdout = r.text;
          truncated ||= r.truncated;
        } else {
          const r = cap(stderr, text);
          stderr = r.text;
          truncated ||= r.truncated;
        }
      });
      return { child, isLast, outFd };
    });

    // wire stdout → next stdin
    for (let i = 0; i < procs.length - 1; i++) {
      const from = procs[i]?.child;
      const to = procs[i + 1]?.child;
      from?.stdout?.on("data", (c) => to?.stdin?.write(c));
      from?.on("close", () => to?.stdin?.end());
    }

    // capture the LAST stage's stdout (unless it was redirected to a file)
    const last = procs[procs.length - 1];
    if (last && last.outFd === undefined) {
      last.child.stdout?.on("data", (c) => {
        const text = c.toString();
        opts.onOutput?.(text);
        const r = cap(stdout, text);
        stdout = r.text;
        truncated ||= r.truncated;
      });
    }

    let remaining = procs.length;
    let lastCode = 0;
    for (const p of procs) {
      p.child.on("error", (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        stderr = cap(stderr, `${msg}\n`).text;
        if (p.isLast) lastCode = 127;
        if (--remaining === 0) finish(lastCode);
      });
      p.child.on("close", (code) => {
        if (p.isLast) lastCode = typeof code === "number" ? code : 0;
        if (--remaining === 0) finish(lastCode);
      });
    }

    // An external abort (job kill / turn cancel) tears the group down the same way a timeout
    // does — SIGTERM, then SIGKILL after the grace period.
    const onAbort = (): void => {
      // Latched BEFORE the kill, so the `close` handler that fires next cannot settle the
      // pipeline as a clean exit before the deferred `finish(130)` ever runs.
      aborted = true;
      for (const c of children) killGroup(c, "SIGTERM");
      setTimeout(() => {
        for (const c of children) killGroup(c, "SIGKILL");
        finish(130);
      }, KILL_GRACE_MS).unref?.();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      for (const c of children) killGroup(c, "SIGTERM");
      setTimeout(() => {
        for (const c of children) killGroup(c, "SIGKILL");
        finish(124);
      }, KILL_GRACE_MS).unref?.();
    }, timeoutMs);

    // The timer is cleared in `finish()` — i.e. when the LAST stage closes. Clearing it on
    // every `close` meant the first stage to exit disarmed the whole budget: measured,
    // `echo hi | sleep 5` with an 800ms limit ran the full 5s and reported `timedOut: false`.
    // Any pipeline with a fast head (`cat f | …`, `git log | …`) was effectively unbounded.
    timers.push(killTimer);
  });

  for (const u of untrackers) u();

  return {
    // 130 is the conventional "terminated by SIGINT" code, which is exactly what a cancel is.
    exitCode: timedOut ? 124 : aborted ? 130 : result,
    stdout,
    stderr,
    timedOut,
    aborted,
    truncated,
    durationMs: Date.now() - startedAt,
    argvExecuted: stages.map((s) => s.argv),
  };
}

/** Signal a child's whole GROUP, falling back to the pid when the group send fails. */
function killGroup(child: { pid?: number; kill(sig?: string): void }, sig: string): void {
  if (typeof child.pid === "number" && child.pid > 1) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      /* the group may already be gone */
    }
  }
  try {
    child.kill(sig);
  } catch {
    /* already exited */
  }
}

/**
 * Run a whole parsed command — every pipeline, honouring `&&` / `||` / `;`.
 *
 * The sequencing is evaluated HERE rather than by a shell, which is the only way it can mean
 * what the confirm dialog said: `a && b` runs `b` only when `a` succeeded, and a `&&` chain
 * that stops early reports the code of the pipeline that actually failed.
 */
export async function runParsedCommand(
  cmd: ParsedCommand,
  opts: RunPipelineOptions,
): Promise<ExecPipelineResult> {
  const started = Date.now();

  // Fail-closed, BEFORE any stage is spawned: no sandbox decision (or a failed one) means no
  // process. 126 is the shell's "found but not executable" code — the closest honest thing to
  // "we refused to start it", and distinct from 127 (not found) and 124 (timed out).
  const refusal = sandboxRefusal(opts);
  if (refusal) {
    return {
      exitCode: 126,
      stdout: "",
      stderr: `${refusal}\n`,
      timedOut: false,
      aborted: false,
      truncated: false,
      durationMs: 0,
      argvExecuted: [],
    };
  }

  let out = "";
  let err = "";
  let code = 0;
  let timedOut = false;
  let aborted = false;
  let truncated = false;
  const argvExecuted: string[][] = [];

  for (const part of cmd.parts) {
    if (part.sequencing === "and" && code !== 0) continue;
    if (part.sequencing === "or" && code === 0) continue;
    const r = await runOnePipeline(part.pipeline.stages, opts);
    out += r.stdout;
    err += r.stderr;
    code = r.exitCode;
    timedOut ||= r.timedOut;
    aborted ||= r.aborted;
    truncated ||= r.truncated;
    argvExecuted.push(...r.argvExecuted);
    // A timeout stops the whole command — continuing would run the rest with an unknown
    // amount of the previous stage's work done.
    if (r.timedOut) break;
    /**
     * A CANCEL stops the whole command, deterministically.
     *
     * The exit code alone very nearly does this already: a cancelled part now reports 130, so
     * an `&&` chain short-circuits on its own. Two cases it does NOT cover, which is why this
     * is here rather than left to the code:
     *   - `||` sequencing, where a NON-zero code is exactly the reason to run the next part;
     *   - the race inside `runOnePipeline`, which spawns the children and only then attaches
     *     the abort listener. A short command (`rm`) can finish in that window.
     * Not starting the next part at all closes both. Measured, the second part is usually
     * killed by the still-aborted signal anyway — this makes "usually" into "never".
     */
    if (r.aborted) break;
  }

  return {
    exitCode: code,
    stdout: out,
    stderr: err,
    timedOut,
    aborted,
    truncated,
    durationMs: Date.now() - started,
    argvExecuted,
  };
}
