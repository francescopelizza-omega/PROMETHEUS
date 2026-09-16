/**
 * agent/system/host/hook-runner.ts — the REAL, spawn-backed `HookRunner` (see `agent/hooks.ts`).
 *
 * `agent/hooks.ts` is pure so the C5-sandboxed renderer can import the types and the matching
 * logic; this is the half that actually runs a user's shell command, and it lives under
 * `system/host` with the rest of the node-dependent implementations (the CLI process and the
 * Electron MAIN process are the only two things that may import it).
 *
 * FAIL-SOFT BY CONSTRUCTION: every failure mode — spawn error, missing shell, timeout, a child
 * that never exits — resolves a `HookOutcome` carrying `error`/`timedOut` rather than
 * rejecting. `runPreToolUseHooks` reads those as "no hook fired", so the only way a hook can
 * stop a tool call is by cleanly exiting nonzero.
 */
import { createRequire } from "node:module";

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookInvocation,
  type HookOutcome,
  type HookRunner,
} from "../../hooks.js";

// `node:child_process` is engine-bridge's EXCLUSIVE static import (C5). A runtime require is
// the sanctioned escape hatch for a host module that must spawn — `exec-runner.ts` and
// `orphan-guard-boot.ts` do the same, with the same `nodeRequire` name.
const nodeRequire = createRequire(import.meta.url);

/** The child handle this module needs (a structural subset of ChildProcess). */
export interface HookChildLike {
  stdout: { on(e: "data", cb: (c: Buffer | string) => void): void } | null;
  stderr: { on(e: "data", cb: (c: Buffer | string) => void): void } | null;
  stdin: { end(data?: string): void; on(e: "error", cb: (err: Error) => void): void } | null;
  on(e: "error", cb: (err: Error) => void): void;
  on(e: "close", cb: (code: number | null, signal: string | null) => void): void;
  kill(sig?: string): void;
}

/** The `spawn` seam, resolved at runtime (C5) and injectable so no test spawns a real shell. */
export type HookSpawnLike = (
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
) => HookChildLike;

/** Per-stream capture ceiling — a hook that prints a gigabyte must not take the session down. */
const MAX_HOOK_STREAM_BYTES = 64 * 1024;

/** Grace between SIGTERM and SIGKILL for a hook that ignores the polite signal. */
const KILL_GRACE_MS = 1_000;

export interface HookRunnerOptions {
  /** working directory for hook commands (defaults to the process cwd). */
  cwd?: string;
  /** environment for hook commands (defaults to the process env). */
  env?: Record<string, string | undefined>;
  /** injected for tests. */
  spawnImpl?: HookSpawnLike;
  /** platform override for tests (defaults to `process.platform`). */
  platform?: string;
}

/** The shell + flag a hook command line is handed to, per platform. */
export function hookShell(platform: string): { shell: string; flag: string } {
  return platform === "win32"
    ? { shell: process.env.COMSPEC ?? "cmd.exe", flag: "/d /s /c" }
    : { shell: "/bin/sh", flag: "-c" };
}

/**
 * Build a `HookRunner` that executes each hook command through the platform shell, writes the
 * event payload to its stdin, and captures (capped) stdout/stderr under a hard timeout.
 *
 * A shell IS used, deliberately and unlike the agent's own `run_command` path: a hook is a
 * line the USER put in their own settings file, so pipes and redirects are the point. The
 * agent can neither author nor reach one — `hooks` is settings-only, never a tool argument.
 */
export function createHookRunner(opts: HookRunnerOptions = {}): HookRunner {
  const platform = opts.platform ?? process.platform;
  const { shell, flag } = hookShell(platform);
  return (inv: HookInvocation): Promise<HookOutcome> =>
    new Promise<HookOutcome>((resolve) => {
      const timeoutMs =
        Number.isFinite(inv.timeoutMs) && inv.timeoutMs > 0
          ? inv.timeoutMs
          : DEFAULT_HOOK_TIMEOUT_MS;
      let settled = false;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      /**
       * Every timer this invocation armed, cleared together on settle.
       *
       * A list rather than two `let` bindings: the kill-grace timer is created INSIDE the
       * timeout callback, so a pair of variables means the settle path has to reason about
       * which of them exists yet. An un-cleared timer keeps the event loop alive, which for a
       * five-second hook means a CLI that takes five seconds to exit.
       */
      const timers: ReturnType<typeof setTimeout>[] = [];

      const finish = (out: HookOutcome): void => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        resolve(out);
      };

      let child: HookChildLike;
      try {
        const spawn =
          opts.spawnImpl ?? (nodeRequire("node:child_process") as { spawn: HookSpawnLike }).spawn;
        // `/d /s /c` is ONE cmd.exe argument group but three tokens; split so argv is right on
        // both platforms without a special case at the call site.
        const args = [...flag.split(" "), inv.command];
        child = spawn(shell, args, {
          cwd: opts.cwd ?? process.cwd(),
          env: opts.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        // A spawn that throws SYNCHRONOUSLY (bad cwd, unresolvable shell) never produces an
        // 'error' event, so without this the promise would hang and take the turn with it.
        finish({ exitCode: -1, stdout: "", stderr: "", error: errText(e) });
        return;
      }

      const append = (buf: Buffer | string, into: "out" | "err"): void => {
        const text = typeof buf === "string" ? buf : buf.toString("utf8");
        if (into === "out") {
          if (stdout.length < MAX_HOOK_STREAM_BYTES) stdout += text;
        } else if (stderr.length < MAX_HOOK_STREAM_BYTES) stderr += text;
      };
      child.stdout?.on("data", (c) => append(c, "out"));
      child.stderr?.on("data", (c) => append(c, "err"));
      child.on("error", (err) => finish({ exitCode: -1, stdout, stderr, error: errText(err) }));
      child.on("close", (code, signal) => {
        if (timedOut) finish({ exitCode: code ?? -1, stdout, stderr, timedOut: true });
        // `code === null` with a signal means the hook was KILLED — it never got to vote.
        // Reported as a bare nonzero exit it was indistinguishable from a deliberate DENY,
        // so a hook that segfaulted (or that anything else on the box killed) silently
        // vetoed every tool call. Naming it an error lets the caller tell the two apart.
        else if (code === null && signal)
          finish({ exitCode: -1, stdout, stderr, error: `hook killed by ${signal}` });
        else finish({ exitCode: code ?? -1, stdout, stderr });
      });

      timers.push(
        setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          timers.push(
            setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                /* already gone */
              }
              // A child that survives SIGKILL (or a stubbed kill that does nothing) must not
              // pin the turn open — resolve regardless once the grace elapsed.
              finish({ exitCode: -1, stdout, stderr, timedOut: true });
            }, KILL_GRACE_MS),
          );
        }, timeoutMs),
      );

      // An EPIPE from a hook that never reads stdin (`echo hi`) is normal, not an error.
      child.stdin?.on("error", () => {});
      try {
        child.stdin?.end(inv.stdin);
      } catch {
        /* closed stdin — the hook simply does not get its payload */
      }
    });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
