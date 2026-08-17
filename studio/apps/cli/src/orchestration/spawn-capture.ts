/**
 * orchestration/spawn-capture.ts — the hardened "run a CLI headlessly, capture stdout".
 *
 * Spawning vendor AI CLIs as agents is a minefield (the design pre-mortem): they hang
 * waiting on a TTY, fail to exit (cursor/kilocode), lie with exit 0 on a rate-limit, and
 * leave zombie subprocesses. This seam neutralizes all of that:
 *   • own PROCESS GROUP (detached) → kill the whole group, never orphan grandchildren;
 *   • headless env (TERM=dumb NO_COLOR CI FORCE_COLOR=0) + stdin=EOF → no TTY prompt;
 *   • WALL-CLOCK timeout AND an IDLE-OUTPUT watchdog (a hung prompt emits 0 bytes);
 *   • capped ring buffers (no OOM) + ANSI strip + a MULTI-SIGNAL outcome classifier
 *     (never trust the exit code alone) + secret redaction.
 * The pure helpers (classifyOutcome / stripAnsi / redactSecrets) are unit-tested; the
 * spawn itself is the one node:child_process boundary (injectable for tests).
 */
import { createRequire } from "node:module";

import { OWNER_PID_ENV, trackChild } from "../child-reaper.js";

// node:child_process is engine-bridge's EXCLUSIVE static import (C5). We spawn vendor AI
// CLIs as agents, so — like onboarding's ollama pull — we load spawn LAZILY via
// createRequire (a runtime call, NOT a restricted static import) to respect the boundary.
const nodeRequire = createRequire(import.meta.url);

/** The minimal child-process surface we drive (avoids importing node:child_process types). */
interface ChildLike {
  pid?: number;
  stdout?: { on(ev: "data", cb: (d: Buffer) => void): void } | null;
  stderr?: { on(ev: "data", cb: (d: Buffer) => void): void } | null;
  stdin?: { on(ev: "error", cb: () => void): void; end(s?: string): void } | null;
  on(ev: "error", cb: (e: unknown) => void): void;
  on(ev: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(sig?: string): boolean;
}
type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildLike;

/** How a CLI invocation actually ended (never the exit code alone). */
export type Outcome =
  | "ok"
  | "empty"
  | "rate_limited"
  | "auth_error"
  | "truncated"
  | "crashed"
  | "timeout";

export interface CaptureOpts {
  args: string[];
  /** piped to the child's stdin (then EOF). Omit ⇒ stdin is /dev/null (EOF immediately). */
  stdin?: string;
  /** hard wall-clock budget; the group is killed past it. */
  timeoutMs: number;
  /** kill if zero output bytes for this long (catches TTY-prompt freezes fast). Default 90s. */
  idleMs?: number;
  env?: Record<string, string>;
  cwd?: string;
  /** require this terminal marker in stdout (json modes) → else "truncated". */
  requireMarker?: string;
}

export interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outcome: Outcome;
}

export type SpawnCapture = (bin: string, opts: CaptureOpts) => Promise<CaptureResult>;

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]/g;
/** Strip ANSI/OSC escape noise CLIs emit even in "headless" mode. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,})\b|((?:ANTHROPIC|OPENAI|GEMINI|GOOGLE|CURSOR|OPENROUTER|DEEPSEEK)_API_KEY)=\S+/g;
/** Redact API keys from any text crossing an agent boundary or hitting the trace. */
export function redactSecrets(s: string): string {
  return s.replace(SECRET_RE, (_m, key, envname) =>
    envname ? `${envname}=‹redacted›` : "‹redacted-key›",
  );
}

const RATE_RE = /\b(rate.?limit|429|quota|overloaded|too many requests|529)\b/i;
const AUTH_RE =
  /\b(unauthorized|401|403|invalid api key|not logged in|authenticate|login required|expired token)\b/i;

/** Classify the run from ALL signals — a CLI can exit 0 on a rate-limit or truncation. */
export function classifyOutcome(r: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  killedByTimeout?: boolean;
  requireMarker?: string;
}): Outcome {
  if (r.killedByTimeout) return "timeout";
  const blob = `${r.stderr}\n${r.stdout}`;
  if (AUTH_RE.test(blob)) return "auth_error";
  if (RATE_RE.test(blob)) return "rate_limited";
  if (r.signal) return "crashed";
  if (r.requireMarker && !r.stdout.includes(r.requireMarker)) return "truncated";
  if (r.code !== 0) return "crashed";
  if (r.stdout.trim() === "") return "empty";
  return "ok";
}

const MAX_BUF = 8 * 1024 * 1024; // 8MB ring cap per stream

/** Append with a hard cap so a runaway child can't OOM the orchestrator. */
function capped(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > MAX_BUF ? next.slice(next.length - MAX_BUF) : next;
}

/**
 * The real hardened capture. Spawns `bin args` in its own process group, feeds stdin (or
 * EOF), drains both streams immediately, and kills the GROUP on the wall-clock OR idle
 * watchdog. Resolves with the classified outcome — it never rejects (a crash/timeout is
 * data the coordinator routes), so the swarm survives any single bad child.
 */
export function makeSpawnCapture(): SpawnCapture {
  const spawn = (nodeRequire("node:child_process") as { spawn: SpawnFn }).spawn;
  return (bin, opts) =>
    new Promise<CaptureResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killedByTimeout = false;
      let settled = false;

      const child = spawn(bin, opts.args, {
        detached: true, // own process group → we can kill grandchildren too
        stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        cwd: opts.cwd,
        // ONLY cosmetic, output-formatting env (no spinners / no color) + the parent env.
        // We deliberately DO NOT set CI=1 — some CLIs change CORE behavior under CI, which
        // would violate the standalone invariant. Non-interactivity comes from the CLI's
        // OWN headless flag (-p / exec / --yolo) + stdin=EOF, not from faking a CI env.
        env: {
          ...process.env,
          TERM: "dumb",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          // Stamp the owning CLI's pid so a child that survives a SIGKILL of the parent
          // (the one case no exit handler can cover) is still identifiable afterwards.
          [OWNER_PID_ENV]: String(process.pid),
          ...opts.env,
        },
      });

      // `detached: true` is what makes group-kill possible — and also what makes this child
      // OUTLIVE the CLI. The watchdogs below live in this process, so if the user quits the
      // TUI or hits Ctrl-C mid-run they die with it and the agent runs forever. Registering
      // with the reaper is what closes that hole; `untrack` fires on the child's own exit so
      // a recycled pid is never signalled later.
      // `command` must match what `ps -o command=` will later report, or the post-mortem
      // sweep will (correctly, safely) refuse to touch it. argv joined by single spaces is
      // what ps prints for a spawn without a shell.
      const untrack = trackChild({
        pid: child.pid,
        group: true,
        label: `agent:${bin}`,
        command: [bin, ...opts.args].join(" "),
      });

      const idleMs = opts.idleMs ?? 90_000;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const bumpIdle = (): void => {
        // Once settled, a late buffered data chunk must NOT re-arm the idle timer — it
        // would later fire killGroup against an already-exited child whose PGID the OS
        // may have recycled, signalling an unrelated process group.
        if (settled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => killGroup(true), idleMs);
      };
      const wallTimer = setTimeout(() => killGroup(true), opts.timeoutMs);

      function killGroup(timedOut: boolean): void {
        if (settled) return; // the child already closed — never signal a recycled PGID
        killedByTimeout = killedByTimeout || timedOut;
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        }
        // hard kill after a grace period so the CLI can cancel its in-flight call first.
        killTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            /* gone */
          }
          // A detached grandchild can hold the stdout/stderr pipe open so `close` never
          // fires; resolve here too (idempotent via `settled`) so the turn can't hang.
          finish(null, "SIGKILL");
        }, 5000);
        killTimer.unref?.();
      }

      child.stdout?.on("data", (d: Buffer) => {
        stdout = capped(stdout, d.toString("utf8"));
        bumpIdle();
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr = capped(stderr, d.toString("utf8"));
        bumpIdle();
      });
      if (opts.stdin !== undefined && child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(opts.stdin);
      }
      bumpIdle();

      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        untrack(); // this pid is done — never signal it again (the OS may recycle it)
        clearTimeout(wallTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (killTimer) clearTimeout(killTimer); // don't leave the grace timer dangling
        // CLASSIFY on the ANSI-stripped RAW text (so a rate-limit/auth phrase is never
        // accidentally hidden), but RETURN the redacted text (no key leaks downstream).
        const rawOut = stripAnsi(stdout);
        const rawErr = stripAnsi(stderr);
        resolve({
          code,
          signal,
          stdout: redactSecrets(rawOut),
          stderr: redactSecrets(rawErr),
          outcome: classifyOutcome({
            code,
            signal,
            stdout: rawOut,
            stderr: rawErr,
            killedByTimeout,
            ...(opts.requireMarker ? { requireMarker: opts.requireMarker } : {}),
          }),
        });
      };

      child.on("error", (err) => {
        // e.g. ENOENT when the bin isn't on PATH → surface it so the backend can fall back.
        stderr = capped(stderr, `\n[spawn error] ${String(err)}`);
        finish(null, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });
}
