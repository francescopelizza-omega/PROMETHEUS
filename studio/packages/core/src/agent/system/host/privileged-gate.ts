// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/host/privileged-gate.ts — the ONLY code that may start a privileged process.
 *
 * The principle it enforces:
 *
 *   Prometheus may run sudo, but never on its own authority. Every privileged command is
 *   shown to the human verbatim and runs only after that human approves that exact command,
 *   every time. No authorization level, flag, setting, agent or tool can pre-approve,
 *   remember or skip this approval.
 *
 * How the code keeps that promise, rather than how the docs state it:
 *
 *  - **Nothing here reads an authorization level, a `--yes`, a grant or a setting.** The gate
 *    has no input through which any of them could arrive. The one thing that turns a request
 *    into a spawn is an `approve` answer from the `approver` callback — and the approver is
 *    wired by a HOST (the TUI modal, the Studio dialog, the VS Code modal), never by a tool
 *    argument. A surface with no human attached (MCP, `-p`/`--json`, CI) simply has no
 *    approver, and gets the command back as a proposal.
 *  - **What was approved is what runs.** The approval mints a one-time token bound to the
 *    elevator, argv, cwd and (for a script) its SHA-256. Immediately before spawn the live
 *    request is re-read, the script re-hashed, and the token consumed; any difference refuses.
 *  - **One shape only.** `<elevator> -- program args…` (see `exec/privileged.ts`). Elevator
 *    options, shell strings, launchers, pipelines and redirects never reach a prompt.
 *  - **The elevator binary is never looked up on PATH.** A fake `sudo` earlier on PATH would
 *    receive the password. Only fixed system paths, root-owned and not group/other-writable.
 *  - **The password never passes through Prometheus.** In a terminal sudo reads it from the
 *    TTY (the host suspends its own UI first). In a GUI, `sudo -A` runs a fixed askpass helper
 *    (`askpass.ts`) whose answer goes straight to sudo. In TTY mode `SUDO_ASKPASS` is REMOVED
 *    from the child's env: sudo consults it whenever no terminal is available, so an inherited
 *    value would route the password to whatever program it names.
 *  - **sudo's own credential cache is respected** — and this prompt still appears every time.
 *  - **Catastrophic commands** (`catastrophicTarget`) additionally require typing their target.
 *  - **Every request leaves one audit line** in `<PROMETHEUS_HOME>/audit/sudo.log` (0600): who,
 *    what, where, why, the decision, the exit code. Never the environment, the output or the
 *    typed phrase.
 *
 * `child_process` is reached through `createRequire` (C5), like `exec-runner.ts`.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { safeChildEnv } from "@prometheus/engine-bridge";
import { shellQuote } from "../../exec/parse.js";
import {
  type GateElevator,
  catastrophicTarget,
  classifyPrivileged,
} from "../../exec/privileged.js";
import { renderElevated } from "../elevated.js";
import { PY_LOADER, type VerifyMode, trustedBinary, verifiedRun } from "./privileged-verify.js";

const nodeRequire = createRequire(import.meta.url);

export type Surface = "tui" | "cli" | "studio" | "vscode" | "mcp" | "headless";

/** What a caller asks the gate to run. `argv` is the command WITHOUT the elevator. */
export interface PrivilegedRequest {
  argv: string[];
  cwd: string;
  why: string;
  surface: Surface;
  /** who asked: `agent`, `/disk-space --sudo`, `Studio: Rescan as root`, … */
  requester: string;
  elevator?: GateElevator;
}

export interface ScriptInfo {
  path: string;
  size: number;
  sha256: string;
  head: string[];
}

/** Everything the human is shown. Hosts render this; they never build their own text. */
export interface ApprovalView {
  id: string;
  /** what a person would type: `sudo apt-get install -y ripgrep` */
  commandLine: string;
  /** the exact spawn argv, elevator options included */
  execArgv: string[];
  elevator: GateElevator;
  argv: string[];
  cwd: string;
  surface: Surface;
  requester: string;
  why: string;
  script?: ScriptInfo;
  /** when set, the human must type exactly this to approve */
  phrase?: string;
  timeoutMs: number;
  passwordVia: "tty" | "askpass";
  /** it opens interactively in a window of its own (keys from the keyboard only), not as a job */
  terminal?: boolean;
  /** how root is held to the approved script bytes (absent when no script runs) */
  verified?: Exclude<VerifyMode, "none">;
}

export type ApprovalAnswer = { decision: "approve"; phrase?: string } | { decision: "deny" };

/** Wired by a HOST, never reachable from a tool argument. */
export type Approver = (view: ApprovalView, signal: AbortSignal) => Promise<ApprovalAnswer>;

export type GateDecision = "approved" | "denied" | "timeout" | "refused" | "blocked" | "no-human";

export interface PrivilegedResult {
  ok: boolean;
  decision: GateDecision;
  commandLine: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  timedOut?: boolean;
  /** the command printed more than the capture limit; `stdout`/`stderr` hold only the start */
  outputTruncated?: boolean;
  /** for `no-human`: the block a human can run themselves */
  proposal?: string;
  reason?: string;
}

/** The pieces of `child_process.spawn` the gate uses — a seam tests replace. */
type SpawnFn = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
) => {
  pid?: number;
  stdout: { on(e: "data", cb: (c: Buffer) => void): void; destroy?(): void } | null;
  stderr: { on(e: "data", cb: (c: Buffer) => void): void; destroy?(): void } | null;
  stdin?: {
    write(data: string | Buffer): unknown;
    on?(e: "error", cb: (err: unknown) => void): unknown;
  } | null;
  stdio?: readonly unknown[];
  on(e: "error" | "close" | "exit", cb: (a?: unknown, b?: unknown) => void): void;
  kill(sig?: string): void;
};

/**
 * Run the approved command INTERACTIVELY, on a pseudo-terminal a GUI host shows in a terminal
 * view (Studio's "Open disk space as administrator"). The stdlib relay `pty_host.py` runs as the
 * USER and execs the approved elevator command on a pty; screen bytes arrive through `onOutput`,
 * keystrokes go in through the handle `onStart` receives.
 *
 * Only with the native password dialog (`sudo -A`): with a terminal view the password would
 * otherwise be typed into Prometheus's own window and pass through its process on the way to
 * sudo. The relay decides what sudo is handed, so its SHA-256 is bound to the approval exactly
 * like a script's and re-checked immediately before the spawn.
 */
export interface PrivilegedTerminal {
  /** the interpreter that runs the relay, as the user */
  python: string;
  /** `studio/python/tools/pty_host.py` */
  ptyHost: string;
  cols: number;
  rows: number;
  onStart(handle: { write(data: string): void; resize(cols: number, rows: number): void }): void;
}

export interface GateDeps {
  /** absent ⇒ no human attached ⇒ every request becomes a proposal */
  approver?: Approver;
  /** `tty`: the host suspends its UI and sudo reads the terminal. `askpass`: `sudo -A`. */
  passwordVia: "tty" | "askpass";
  /** path of the askpass helper, or null when this machine has none */
  askpass?: () => Promise<string | null>;
  /** nemesis — a block is final and never offered to the human */
  scan?: (commandLine: string) => Promise<{ blocked: boolean; reason?: string }>;
  /** PROMETHEUS_HOME, for the audit log */
  home?: string;
  /** the user's home, for catastrophic-target detection (`rm -rf ~`) */
  userHome?: string;
  suspendTerminal?: () => void | Promise<void>;
  resumeTerminal?: () => void | Promise<void>;
  /** execution wall clock (default 30 min — package installs are slow) */
  timeoutMs?: number;
  /** how long the prompt waits before it denies (default 120 s) */
  approvalTimeoutMs?: number;
  /**
   * After sudo exits, how long to wait for its output pipes to close (default 2 s). A root
   * grandchild that outlives sudo keeps them open, and `close` would never come.
   */
  exitGraceMs?: number;
  /** test seam: resolve an elevator to a trusted absolute path */
  resolveElevator?: (e: GateElevator) => string | null;
  /** test seam: is this script's whole path controlled by root (so it may run as it is)? */
  rootControlled?: (path: string) => boolean;
  /** test seam */
  spawnImpl?: SpawnFn;
}

export interface PrivilegedGate {
  requestAndRun(
    req: PrivilegedRequest,
    io?: {
      onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
      signal?: AbortSignal;
      /** how much of each stream to keep (default 1 MiB) — a caller that parses output asks for more */
      captureBytes?: number;
      /** run it interactively on a pseudo-terminal the host shows (see PrivilegedTerminal) */
      terminal?: PrivilegedTerminal;
      /** this call's wall clock, replacing the gate's default (an interactive session is long) */
      timeoutMs?: number;
    },
  ): Promise<PrivilegedResult>;
}

export const SUDO_PROMPT = "[PROMETHEUS] password for %u: ";
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const DEFAULT_PRIVILEGED_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 5_000;
const MAX_CAPTURE = 1024 * 1024;
const TOKEN_TTL_MS = 30_000;
const SCRIPT_HEAD_LINES = 20;

/* ── the elevator binary ──────────────────────────────────────────────────── */

const CANDIDATES: Readonly<Record<GateElevator, readonly string[]>> = Object.freeze({
  sudo: ["/usr/bin/sudo", "/bin/sudo"],
  doas: ["/usr/bin/doas", "/usr/local/bin/doas", "/bin/doas"],
  pkexec: ["/usr/bin/pkexec"],
  run0: ["/usr/bin/run0", "/bin/run0"],
});

/** Root-owned and not writable by group/other: a binary only root could have put there. */
export { trustedBinary };

function defaultResolveElevator(e: GateElevator): string | null {
  return CANDIDATES[e].find(trustedBinary) ?? null;
}

/* ── scripts ──────────────────────────────────────────────────────────────── */

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "python",
  "perl",
  "ruby",
  "node",
]);

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The script a canonical argv runs, if any: `./x.sh`, or `bash x.sh` / `python3 tool.py`. */
function scriptPathOf(argv: readonly string[], cwd: string): string | null {
  const head = argv[0] ?? "";
  const name = (head.split("/").pop() ?? "").toLowerCase().replace(/[\d.]+$/, "");
  if (INTERPRETERS.has(name)) {
    const operand = argv.slice(1).find((a) => !a.startsWith("-"));
    if (!operand) return null;
    const p = resolvePath(cwd, operand);
    return isFile(p) ? p : null;
  }
  if (!head.includes("/")) return null;
  const p = resolvePath(cwd, head);
  if (!isFile(p)) return null;
  try {
    return readFileSync(p).subarray(0, 2).toString("latin1") === "#!" ? p : null;
  } catch {
    return null;
  }
}

function scriptInfo(path: string): ScriptInfo | null {
  try {
    const bytes = readFileSync(path);
    const head = bytes
      .subarray(0, 64 * 1024)
      .toString("utf8")
      .split("\n")
      .slice(0, SCRIPT_HEAD_LINES)
      .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "?").slice(0, 200))
      .filter((l, i, all) => i < all.length - 1 || l !== "");
    return {
      path,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      head,
    };
  } catch {
    return null;
  }
}

/* ── audit ────────────────────────────────────────────────────────────────── */

export function sudoAuditPath(home: string): string {
  return join(home, "audit", "sudo.log");
}

interface AuditEntry {
  time: string;
  surface: Surface;
  requester: string;
  why: string;
  argv: string[];
  cwd: string;
  elevator: GateElevator;
  script?: { path: string; sha256: string; size: number };
  decision: GateDecision;
  phraseRequired: boolean;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  reason?: string;
}

/** Never throws: an audit that can break the action it records gets removed, then nothing is recorded. */
function appendAudit(home: string | undefined, entry: AuditEntry): void {
  if (!home) return;
  try {
    const file = sudoAuditPath(home);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/* ── the gate ─────────────────────────────────────────────────────────────── */

function digestOf(
  elevator: string,
  argv: readonly string[],
  cwd: string,
  sha: string | null,
): string {
  return createHash("sha256")
    .update(JSON.stringify([elevator, argv, cwd, sha]))
    .digest("hex");
}

function execArgsFor(elevator: GateElevator, argv: readonly string[], askpass: boolean): string[] {
  switch (elevator) {
    // `-k`: ignore (and do not refresh) sudo's cached credential, so EVERY approved command asks
    // for the password again. Without it an approval within sudo's timestamp window ran with no
    // password at all — the view's "sudo asks for the password" was false, and on the desktop the
    // renderer's click was then the only thing between a request and root.
    case "sudo":
      return ["-k", "-p", SUDO_PROMPT, ...(askpass ? ["-A"] : []), "--", ...argv];
    case "pkexec":
      return [...argv];
    default:
      return ["--", ...argv];
  }
}

export function createPrivilegedGate(deps: GateDeps): PrivilegedGate {
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PRIVILEGED_TIMEOUT_MS;
  const exitGraceMs = deps.exitGraceMs ?? 2000;
  const resolveElevator = deps.resolveElevator ?? defaultResolveElevator;
  /** one-time approvals: token → what it approved. Never leaves this closure. */
  const approvals = new Map<string, { digest: string; expires: number }>();

  return {
    async requestAndRun(req, io = {}) {
      const elevator: GateElevator = req.elevator ?? "sudo";
      const okShape =
        Array.isArray(req.argv) &&
        req.argv.every((a) => typeof a === "string") &&
        typeof req.cwd === "string" &&
        req.cwd.startsWith("/");
      // a snapshot: what the human is shown, and what the live request is compared against
      const argv = okShape ? [...req.argv] : [];
      const cwd = okShape ? req.cwd : "";
      const commandLine = `${elevator} ${argv.map(shellQuote).join(" ")}`.trim();
      const why = typeof req.why === "string" ? req.why.trim() : "";
      const base = {
        time: new Date().toISOString(),
        surface: req.surface,
        requester: req.requester,
        why,
        argv,
        cwd,
        elevator,
      };
      const finish = (
        decision: GateDecision,
        extra: Partial<PrivilegedResult> & {
          script?: ScriptInfo | null;
          phrase?: string | null;
        } = {},
      ): PrivilegedResult => {
        const { script, phrase, ...result } = extra;
        appendAudit(deps.home, {
          ...base,
          ...(script
            ? { script: { path: script.path, sha256: script.sha256, size: script.size } }
            : {}),
          decision,
          phraseRequired: Boolean(phrase),
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        });
        return { ok: false, decision, commandLine, ...result };
      };

      if (!okShape)
        return finish("refused", { reason: "argv must be strings and cwd an absolute path" });

      const cls = classifyPrivileged([elevator, ...argv]);
      if (!cls.canonical) {
        return finish("refused", { reason: cls.refusal ?? "not a command the gate can run" });
      }

      if (deps.scan) {
        const v = await deps.scan(commandLine);
        if (v.blocked)
          return finish("blocked", { reason: v.reason ?? "blocked by the nemesis gate" });
      }

      if (!deps.approver) {
        return finish("no-human", {
          reason: "no human is attached to this surface to approve a privileged command",
          proposal: renderElevated({ argv, why, cwd }, undefined, elevator),
        });
      }

      const binary = resolveElevator(elevator);
      if (!binary) {
        return finish("refused", {
          reason: `no trusted \`${elevator}\` binary (root-owned, in a system directory) on this machine`,
        });
      }
      let askpassPath: string | null = null;
      if (deps.passwordVia === "askpass") {
        if (elevator === "doas") {
          return finish("refused", {
            reason: "`doas` reads its password from a terminal only — run this from a terminal",
          });
        }
        if (elevator === "sudo") {
          askpassPath = deps.askpass ? await deps.askpass() : null;
          if (!askpassPath) {
            return finish("refused", {
              reason:
                "no graphical password helper is available here — run this from a terminal (prometheus TUI)",
            });
          }
        }
      }

      const term = io.terminal;
      if (term && (!isAbsolute(term.python) || !isAbsolute(term.ptyHost))) {
        // the relay is hashed HERE but opened by a child whose cwd is the request's folder: a
        // relative path would name two different files
        return finish("refused", {
          reason: "the terminal relay and its interpreter must be absolute paths",
        });
      }
      if (term && (elevator !== "sudo" || askpassPath === null)) {
        return finish("refused", {
          reason:
            "an interactive root program in a window needs sudo's native password dialog — a password typed into the window would pass through Prometheus",
        });
      }
      const relay = term ? scriptInfo(term.ptyHost) : null;
      if (term && !relay) {
        return finish("refused", { reason: `the terminal relay is unreadable (${term.ptyHost})` });
      }

      const scriptPath = scriptPathOf(argv, cwd);
      const script = scriptPath ? scriptInfo(scriptPath) : null;
      if (scriptPath && !script) {
        return finish("refused", { reason: `the script ${scriptPath} could not be read` });
      }
      // root must run EXACTLY the approved bytes: the file is opened by root only after the
      // password, seconds after the last check here (privileged-verify.ts)
      const plan = verifiedRun(argv, cwd, script, {
        ...(deps.rootControlled ? { rootControlled: deps.rootControlled } : {}),
      });
      if ("refusal" in plan) return finish("refused", { script, reason: plan.refusal });
      const phrase = catastrophicTarget(argv, deps.userHome);
      const execArgs = execArgsFor(elevator, plan.argv, askpassPath !== null);
      const view: ApprovalView = {
        id: randomBytes(8).toString("hex"),
        commandLine,
        execArgv: [binary, ...execArgs],
        elevator,
        argv: [...argv],
        cwd,
        surface: req.surface,
        requester: req.requester,
        why,
        ...(script ? { script } : {}),
        ...(phrase ? { phrase } : {}),
        timeoutMs: approvalTimeoutMs,
        passwordVia: deps.passwordVia,
        ...(term ? { terminal: true } : {}),
        ...(plan.mode !== "none" ? { verified: plan.mode } : {}),
      };

      // A caller that has already given up is never asked, and never run: an abort listener
      // added to an already-aborted signal never fires, so a session cancelled while the
      // dialog waited used to start anyway — as root, with no view and nothing left to stop it.
      const cancelled = (): PrivilegedResult =>
        finish("refused", { script, phrase, reason: "cancelled before it ran" });
      if (io.signal?.aborted) return cancelled();

      // ── ask. No answer in time is a deny; a late answer is ignored. ──
      const ac = new AbortController();
      io.signal?.addEventListener("abort", () => ac.abort(), { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        Promise.resolve()
          .then(() => (deps.approver as Approver)(view, ac.signal))
          .catch((): ApprovalAnswer => ({ decision: "deny" })),
        new Promise<"timeout">((res) => {
          timer = setTimeout(() => res("timeout"), approvalTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (answer === "timeout") {
        ac.abort();
        return finish("timeout", {
          script,
          phrase,
          reason: "no answer before the prompt timed out",
        });
      }
      if (answer.decision !== "approve") return finish("denied", { script, phrase });
      if (io.signal?.aborted) return cancelled();
      if (phrase && (answer.phrase ?? "").trim() !== phrase) {
        return finish("refused", {
          script,
          phrase,
          reason: `confirmation text did not match \`${phrase}\``,
        });
      }

      // ── bind the approval, then re-read everything it covered ──
      const token = randomBytes(32).toString("hex");
      approvals.set(token, {
        digest: digestOf(elevator, argv, cwd, script?.sha256 ?? null),
        expires: Date.now() + TOKEN_TTL_MS,
      });
      const liveArgv = Array.isArray(req.argv) ? [...req.argv] : [];
      const liveScriptPath = scriptPathOf(liveArgv, req.cwd);
      const liveSha = liveScriptPath ? (scriptInfo(liveScriptPath)?.sha256 ?? "unreadable") : null;
      const grant = approvals.get(token);
      approvals.delete(token);
      const liveRelaySha = term ? (scriptInfo(term.ptyHost)?.sha256 ?? "unreadable") : null;
      if (
        !grant ||
        grant.expires < Date.now() ||
        grant.digest !== digestOf(req.elevator ?? "sudo", liveArgv, req.cwd, liveSha) ||
        liveRelaySha !== (relay?.sha256 ?? null)
      ) {
        return finish("refused", {
          script,
          phrase,
          reason: "the command, its folder or its script changed after approval",
        });
      }

      // ── run ──
      const spawn =
        deps.spawnImpl ?? (nodeRequire("node:child_process") as { spawn: SpawnFn }).spawn;
      // In TTY mode SUDO_ASKPASS is DROPPED: sudo consults it whenever no terminal is available,
      // so an inherited value would route the password to whatever program it names.
      const { SUDO_ASKPASS: _inherited, ...baseEnv } = safeChildEnv();
      const env = askpassPath ? { ...baseEnv, SUDO_ASKPASS: askpassPath } : baseEnv;
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputTruncated = false;
      await deps.suspendTerminal?.();
      let outcome: { code?: number | null; error?: unknown; lingering?: boolean };
      try {
        outcome = await new Promise((done) => {
          let settled = false;
          const settle = (v: {
            code?: number | null;
            error?: unknown;
            lingering?: boolean;
          }): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timers.kill);
            clearTimeout(timers.grace);
            clearTimeout(timers.exit);
            done(v);
          };
          const timers: {
            kill?: ReturnType<typeof setTimeout>;
            grace?: ReturnType<typeof setTimeout>;
            exit?: ReturnType<typeof setTimeout>;
          } = {};
          const dim = (n: number): string =>
            String(Math.min(1000, Math.max(1, Math.floor(n) || 1)));
          const child = ((): ReturnType<SpawnFn> | null => {
            try {
              if (term) {
                return spawn(
                  term.python,
                  // the relay chooses what sudo is handed: it too runs from its verified bytes
                  [
                    "-I",
                    "-c",
                    PY_LOADER,
                    (relay as ScriptInfo).sha256,
                    term.ptyHost,
                    dim(term.cols),
                    dim(term.rows),
                    "--",
                    binary,
                    ...execArgs,
                  ],
                  { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"] },
                );
              }
              return spawn(binary, execArgs, {
                cwd,
                env,
                shell: false,
                stdio: [askpassPath ? "ignore" : "inherit", "pipe", "pipe"],
              });
            } catch (error) {
              settle({ error });
              return null;
            }
          })();
          if (!child) return;
          if (term) {
            const ctl = child.stdio?.[3] as
              | { write?(s: string): unknown; on?(e: "error", cb: () => void): unknown }
              | undefined;
            // a key typed after the program ended hits a closed pipe: EPIPE is expected, not a crash
            child.stdin?.on?.("error", () => {});
            ctl?.on?.("error", () => {});
            term.onStart({
              write: (data) => void child.stdin?.write(data),
              resize: (c, r) => void ctl?.write?.(`resize ${dim(c)} ${dim(r)}\n`),
            });
          }
          // Signal the sudo process itself, never a group: its children run as root, so a
          // group signal is EPERM — and sudo relays SIGTERM to the command it started.
          const stop = (): void => {
            child.kill("SIGTERM");
            timers.grace = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
          };
          timers.kill = setTimeout(() => {
            timedOut = true;
            stop();
          }, io.timeoutMs ?? timeoutMs);
          if (io.signal?.aborted) stop();
          else io.signal?.addEventListener("abort", stop, { once: true });
          const cap = Math.max(1, io.captureBytes ?? MAX_CAPTURE);
          const keep = (have: string, more: string): string => {
            if (have.length + more.length <= cap) return have + more;
            outputTruncated = true;
            return have + more.slice(0, Math.max(0, cap - have.length));
          };
          const sink = (stream: "stdout" | "stderr") => (c: Buffer) => {
            const s = c.toString("utf8");
            if (stream === "stdout") stdout = keep(stdout, s);
            else stderr = keep(stderr, s);
            io.onOutput?.(s, stream);
          };
          child.stdout?.on("data", sink("stdout"));
          child.stderr?.on("data", sink("stderr"));
          child.on("error", (error) => settle({ error }));
          child.on("close", (code) => settle({ code: typeof code === "number" ? code : null }));
          // sudo is gone but something it started may still hold the pipes: give them a moment,
          // then stop waiting (and stop reading) rather than hang the caller forever
          child.on("exit", (code) => {
            timers.exit = setTimeout(() => {
              child.stdout?.destroy?.();
              child.stderr?.destroy?.();
              settle({ code: typeof code === "number" ? code : null, lingering: true });
            }, exitGraceMs);
          });
        });
      } finally {
        await deps.resumeTerminal?.();
      }
      const durationMs = Date.now() - started;
      if (outcome.error !== undefined) {
        const reason =
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        return finish("approved", { script, phrase, durationMs, reason, stdout, stderr });
      }
      const exitCode = outcome.code ?? -1;
      const result = finish("approved", {
        ...(outcome.lingering
          ? {
              reason:
                "the command ended, but something it started still holds its output open — it may still be running as root",
            }
          : {}),
        script,
        phrase,
        exitCode,
        durationMs,
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true } : {}),
        ...(outputTruncated ? { outputTruncated: true } : {}),
      });
      return { ...result, ok: exitCode === 0 && !timedOut };
    },
  };
}

/**
 * Every character of an approval field, made visible. The view is printed to terminals and
 * shown in dialogs, and its fields carry model-chosen text (argv, cwd, the reason). A raw ESC,
 * CR or backspace there could redraw the lines above it — show `ls` while `rm -rf` runs — and a
 * bidi override or zero-width character could make the text read differently from what runs.
 * Each such character is shown as an escape instead, so what the human reads is what runs.
 */
export function visibleText(s: string): string {
  return s.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c <= 0xff
        ? `\\x${c.toString(16).padStart(2, "0")}`
        : `\\u${c.toString(16).padStart(4, "0")}`;
    },
  );
}

/**
 * The lines every host shows before asking. One renderer, so the TUI, the readline host, the
 * VS Code modal and an audit reader all see the same facts in the same order — the command
 * first, because it is the thing being decided.
 */
/**
 * The exact spawn argv, quoted — except that a shell script's own bytes, passed inline with
 * `-c`, are named rather than dumped: they are the script shown below (path, size, SHA-256, first
 * lines), and repeating thousands of characters here would bury the command.
 */
function runsLine(v: ApprovalView): string {
  const argv = [...v.execArgv];
  if (v.verified === "python-loader") {
    // shown in full, line by line, right below — an escaped one-line blob is unreadable
    const i = argv.indexOf(PY_LOADER);
    if (i >= 0) {
      return argv
        .map((a, k) => (k === i ? "<the verifying loader below>" : shellQuote(a)))
        .join(" ");
    }
  }
  if (v.verified === "shell-inline" && v.script) {
    const i = argv.findIndex((a, k) => a === "-c" && argv[k + 2] === v.script?.path);
    if (i >= 0) argv[i + 1] = `<approved bytes of ${v.script.path}>`;
    return argv.map((a, k) => (k === i + 1 ? a : shellQuote(a))).join(" ");
  }
  return argv.map(shellQuote).join(" ");
}

const VERIFIED_LINE: Record<Exclude<VerifyMode, "none">, string> = {
  "python-loader":
    "verified: root runs exactly the bytes you approved — the loader re-hashes the script as root and refuses if it changed",
  "shell-inline":
    "verified: root runs exactly the bytes you approved — they are handed to the shell directly; the file is not read again",
  "root-owned": "verified: only root can change this script or any folder above it",
};

export function formatApprovalView(v: ApprovalView): string[] {
  const t = visibleText;
  const lines = [
    "PRIVILEGED COMMAND — approve this exact command, once?",
    `  ${t(v.commandLine)}`,
    `runs: ${t(runsLine(v))}`,
    `in:       ${t(v.cwd)}`,
    `asked by: ${t(v.requester)} (${t(v.surface)})`,
    `why:      ${t(v.why)}`,
  ];
  if (v.script) {
    lines.push(`script: ${t(v.script.path)} (${v.script.size} bytes, sha256 ${v.script.sha256})`);
    for (const l of v.script.head) lines.push(`  │ ${t(l)}`);
    if (v.verified) lines.push(VERIFIED_LINE[v.verified]);
    if (v.verified === "python-loader") {
      lines.push("loader: runs as root before the script (fixed text, verbatim):");
      for (const l of PY_LOADER.split("\n")) lines.push(`  │ ${t(l)}`);
    }
  }
  lines.push(
    v.passwordVia === "tty"
      ? "password: your terminal asks for the password (sudo itself) — Prometheus never sees it"
      : "password: a system dialog asks for the password (sudo itself) — Prometheus never sees it",
  );
  if (v.terminal) {
    lines.push(
      "opens: an interactive root terminal in its own window — only your keyboard can type into it; Ctrl+D or Stop ends it",
    );
  }
  if (v.phrase) {
    lines.push(`THIS CAN DESTROY DATA — to approve, type ${t(v.phrase)} exactly`);
  }
  lines.push(
    `approve once or deny · no "always" · no answer in ${Math.round(v.timeoutMs / 1000)} s = deny`,
  );
  return lines;
}
