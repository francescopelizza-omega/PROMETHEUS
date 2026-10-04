// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/run-step.ts — run ONE package-manager step for "update everything", streaming its output.
 *
 * ── WHY NOT THE AGENT'S `run_command` RUNNER ────────────────────────────────────────────────
 *
 * That runner sandboxes every command to the working set, denies the network below A5, forbids
 * `sudo` and every shell, and cannot exec setuid binaries — so `brew upgrade` fails there "even
 * when fully approved" (session/install-tools.ts). That is correct for the agent and means a
 * package upgrade is unreachable from it at every level. A human-confirmed upgrade runs here
 * instead, unsandboxed — and, unlike `/deps install`, with no nemesis gate in front of it and not
 * through engine-bridge: the owner's trust decision, recorded in core's updates/dispatch.ts.
 *
 * ── WHAT THIS DOES INSTEAD OF A SANDBOX ─────────────────────────────────────────────────────
 *
 *   • argv only, `shell: false` — nothing is ever interpreted by a shell;
 *   • `detached: true` puts the child in its own session with NO controlling terminal, and stdin
 *     is `ignore`: a tool that wants a password cannot draw a prompt over the TUI or steal its
 *     keystrokes — it gets EOF and fails, which the caller reports;
 *   • when a step must be stopped (the caller's abort, or the wall clock) the whole process GROUP
 *     is signalled, so a grandchild (brew's curl, npm's node-gyp) goes with it — behind a pid
 *     guard, because kill(2) reads a non-positive pid as a broadcast (CLAUDE.md §2, Hazard A) —
 *     and never once the leader has been reaped, when that group id may be someone else's;
 *   • the child is registered with the reaper: if Prometheus is killed or exits mid-step, the step
 *     is stopped with it rather than left running unowned — the one way a package step does not
 *     get to finish (see dispatch-cmd.ts, CTRL-C);
 *   • output is split into whole lines and stripped of every escape sequence and control byte
 *     before it reaches the terminal — a stray cursor move or OSC would repaint the TUI chrome.
 *
 * No idle watchdog, deliberately: without a terminal brew downloads with `curl --silent` and
 * prints nothing until a download finishes, so a large cask is silent for minutes while working.
 * The wall clock is the backstop, and Ctrl-C is the user's.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";

import { trackChild } from "../child-reaper.js";

// node:child_process is engine-bridge's EXCLUSIVE static import (C5). Like
// orchestration/spawn-capture.ts and onboarding's ollama pull, spawn is loaded lazily through
// createRequire — a runtime call, not a restricted static import.
const nodeRequire = createRequire(import.meta.url);

/** The minimal child-process surface driven here (no node:child_process types imported). */
export interface ChildLike {
  pid?: number;
  stdout?: { on(ev: "data", cb: (d: Buffer) => void): void; destroy?(): void } | null;
  stderr?: { on(ev: "data", cb: (d: Buffer) => void): void; destroy?(): void } | null;
  on(ev: "error", cb: (e: unknown) => void): void;
  /** the leader process was reaped — its pid may be recycled from this moment on. */
  on(ev: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** the leader exited AND every stdio pipe closed (a grandchild can hold them open). */
  on(ev: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}
export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: Record<string, unknown>,
) => ChildLike;

export interface StepOptions {
  /** the child's whole environment — the caller builds it (see `updateEnv`). */
  env: NodeJS.ProcessEnv;
  /** defaults to the home directory: never the project, whose config a manager might read. */
  cwd?: string;
  /** one call per complete, cleaned, non-blank output line (stdout and stderr alike). */
  onLine?: (line: string) => void;
  /** aborting stops the step: SIGTERM to the group, SIGKILL after a grace period. */
  signal?: AbortSignal;
  /** wall-clock budget; past it the step is stopped like an abort. */
  timeoutMs?: number;
  /** for the reaper's diagnostics. */
  label?: string;
}

export interface StepResult {
  /** the exit code; 124 = timed out, 130 = cancelled, 127 = could not start. */
  code: number;
  /** the last 256 KB of each stream, uncleaned — `stdout` is parsed by callers. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export type StepRunner = (argv: readonly string[], opts: StepOptions) => Promise<StepResult>;

/**
 * The backstop for a step that never ends: three hours. A package step is otherwise ALWAYS let
 * finish (an interrupted cask swap is not rolled back), and a bottle-less formula building from
 * source can legitimately take most of that; a step still running past it is hung, and stopping
 * it is the lesser harm.
 */
export const STEP_TIMEOUT_MS = 3 * 60 * 60_000;
/**
 * How long SIGTERM gets before SIGKILL. Generous on purpose: brew and npm clean up on SIGTERM,
 * and a SIGKILL mid-install is how a half-written keg or a stale lock is left behind.
 */
export const KILL_GRACE_MS = 30_000;

/**
 * How long to wait for the pipes after the leader has exited. A grandchild that daemonises can
 * hold stdout open for good; the step is over when its leader is, and waiting for the pipes past
 * this would only end at the wall clock — reported as a timeout of a step that succeeded.
 */
export const EXIT_DRAIN_MS = 3_000;

const CAPTURE_CAP = 256 * 1024;
const LINE_CAP = 2_000;
/** a "line" that never ends (a `\r` progress bar with no newline) is flushed rather than grown. */
const PENDING_CAP = 64 * 1024;

/** Conventional 128+signo statuses for the signals a child may die of. */
const SIGNO: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/** CSI, OSC (BEL- or ST-terminated) and the two-byte escapes. */
const ESC_SEQ =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** C0 controls except tab, DEL and the C1 range. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/**
 * One raw output line, made safe to print above the TUI.
 *
 * A carriage return redraws a line in place, so only what follows the LAST one would have been
 * visible on a terminal; printing the whole run would show every frame of a progress bar.
 */
export function cleanLine(raw: string): string {
  const frames = raw.replace(ESC_SEQ, "").split("\r");
  let visible = "";
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i] ?? "";
    if (f.trim() !== "") {
      visible = f;
      break;
    }
  }
  visible = visible.replace(CONTROL, "");
  return visible.length > LINE_CAP ? `${visible.slice(0, LINE_CAP)}…` : visible;
}

/** Whole lines out of arbitrary chunks, with the unfinished tail capped. */
function lineSplitter(onLine: ((line: string) => void) | undefined): {
  push(chunk: string): void;
  flush(): void;
} {
  let buf = "";
  const emit = (raw: string): void => {
    const line = cleanLine(raw);
    if (line.trim() !== "") onLine?.(line);
  };
  return {
    push(chunk) {
      if (!onLine) return;
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        emit(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      if (buf.length > PENDING_CAP) {
        emit(buf);
        buf = "";
      }
    },
    flush() {
      if (buf !== "") emit(buf);
      buf = "";
    },
  };
}

function capTail(s: string): string {
  return s.length > CAPTURE_CAP ? s.slice(s.length - CAPTURE_CAP) : s;
}

/**
 * Signal a whole process group.
 *
 * The guard is not decoration. `process.kill(-pgid)` with pgid 0 signals OUR group and with -1
 * signals every process this user owns — the defect that took this machine's whole session down
 * four times (scripts/check-broadcast-kill.mjs). A real ChildProcess pid can never be ≤ 1; the
 * guard makes that a property of this function rather than of its callers. `killFn` exists only so
 * the guard can be tested without ever handing a dangerous pid to the real `process.kill` — which
 * stays a literal call below the guard, where scripts/check-broadcast-kill.mjs can see both.
 */
export function killGroup(
  pgid: number,
  signal: NodeJS.Signals,
  killFn?: (pid: number, signal: NodeJS.Signals) => unknown,
): void {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try {
    if (killFn) killFn(-pgid, signal);
    else process.kill(-pgid, signal);
  } catch {
    /* the group is already gone */
  }
}

/**
 * Build a step runner. Every seam is injectable so tests never spawn, never register a fake pid
 * with the process-wide reaper, and never reach a real `process.kill`.
 */
export function makeStepRunner(
  seams: {
    spawnImpl?: SpawnFn;
    killImpl?: (pgid: number, signal: NodeJS.Signals) => void;
    trackImpl?: typeof trackChild;
    graceMs?: number;
    drainMs?: number;
  } = {},
): StepRunner {
  const kill = seams.killImpl ?? ((pgid: number, sig: NodeJS.Signals) => killGroup(pgid, sig));
  const track = seams.trackImpl ?? trackChild;
  const graceMs = seams.graceMs ?? KILL_GRACE_MS;
  const drainMs = seams.drainMs ?? EXIT_DRAIN_MS;

  return (argv, opts) =>
    new Promise<StepResult>((resolve) => {
      const [cmd, ...args] = argv;
      if (!cmd) {
        resolve({
          code: 127,
          stdout: "",
          stderr: "empty command",
          timedOut: false,
          aborted: false,
        });
        return;
      }
      // Cancelled before it began: start nothing.
      if (opts.signal?.aborted) {
        resolve({ code: 130, stdout: "", stderr: "", timedOut: false, aborted: true });
        return;
      }

      const spawn =
        seams.spawnImpl ?? (nodeRequire("node:child_process") as { spawn: SpawnFn }).spawn;
      let child: ChildLike;
      try {
        child = spawn(cmd, args, {
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: opts.cwd ?? homedir(),
          env: opts.env,
          windowsHide: true,
        });
      } catch (err) {
        resolve({ code: 127, stdout: "", stderr: String(err), timedOut: false, aborted: false });
        return;
      }

      // `command` is for humans reading the registry; the reaper identifies the process by the
      // start time the registry stamps (orphan-guard.ts), so if Prometheus dies without running
      // its handlers, the orphan sentinel still stops this step.
      const untrackChild = track({
        pid: child.pid,
        group: true,
        label: opts.label ?? `updates:${cmd}`,
        command: argv.join(" "),
      });
      let tracked = true;
      /** this pid is done — never signal it again (the OS may recycle it). Idempotent. */
      const release = (): void => {
        if (!tracked) return;
        tracked = false;
        untrackChild();
      };

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let failedToStart = false;
      let settled = false;
      /** set on 'exit': from then on the pid belongs to the OS, not to us. */
      let reaped: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let lastResort: ReturnType<typeof setTimeout> | undefined;
      const out = lineSplitter(opts.onLine);
      const err = lineSplitter(opts.onLine);

      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        release();
        clearTimeout(wall);
        if (killTimer) clearTimeout(killTimer);
        if (lastResort) clearTimeout(lastResort);
        if (drainTimer) clearTimeout(drainTimer);
        opts.signal?.removeEventListener("abort", onAbort);
        out.flush();
        err.flush();
        // A daemonised grandchild can still hold the pipes: let go of them, or its late output
        // lands under the NEXT step's heading and the handles keep this process from exiting.
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        const status = failedToStart
          ? 127
          : timedOut
            ? 124
            : aborted
              ? 130
              : (code ?? (signal ? 128 + (SIGNO[signal] ?? 0) : 1));
        resolve({ code: status, stdout, stderr, timedOut, aborted });
      };

      const stop = (why: "timeout" | "abort"): void => {
        if (settled || killTimer) return;
        if (why === "timeout") timedOut = true;
        else aborted = true;
        // The leader is already gone: its group id may belong to a stranger now, so nothing is
        // signalled — the step simply stops being waited for.
        if (reaped) {
          finish(reaped.code, reaped.signal);
          return;
        }
        const pid = child.pid;
        if (typeof pid === "number") kill(pid, "SIGTERM");
        killTimer = setTimeout(() => {
          if (settled) return;
          // Not after 'exit': the group id may already be someone else's.
          if (!reaped && typeof pid === "number") kill(pid, "SIGKILL");
          // A detached grandchild can hold the pipes open so `close` never fires; settle anyway
          // so the batch cannot hang on a process that is already dead.
          lastResort = setTimeout(() => finish(null, "SIGKILL"), 5_000);
        }, graceMs);
      };
      const onAbort = (): void => stop("abort");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const wall = setTimeout(() => stop("timeout"), opts.timeoutMs ?? STEP_TIMEOUT_MS);

      child.stdout?.on("data", (d: Buffer) => {
        if (settled) return;
        const s = d.toString("utf8");
        stdout = capTail(stdout + s);
        out.push(s);
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (settled) return;
        const s = d.toString("utf8");
        stderr = capTail(stderr + s);
        err.push(s);
      });
      child.on("error", (e) => {
        // ENOENT and friends: the program is not there. Reported, never thrown.
        failedToStart = true;
        stderr = capTail(
          `${stderr}${stderr ? "\n" : ""}${e instanceof Error ? e.message : String(e)}`,
        );
        finish(null, null);
      });
      child.on("exit", (code, signal) => {
        reaped = { code, signal };
        release();
        drainTimer = setTimeout(() => finish(code, signal), drainMs);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });
}
