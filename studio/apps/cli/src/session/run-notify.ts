/**
 * session/run-notify.ts — an OS notification when a DETACHED agent run finishes.
 *
 * The point of `/background <task>` is that you stop watching. Before this, the only way to
 * learn that a run had finished was to type `agents list` and look — so the feature that exists
 * to let you walk away required you to keep checking, and a run that finished in ninety seconds
 * sat unread until the next time you happened to look.
 *
 * TERMINAL-SIDE, not Electron. Detached runs are started by the CLI's `/background` command
 * through `startDetachedRun`; there is no Electron `Notification` anywhere in this repo and
 * none would help here, because the process that owns the run is a terminal process.
 *
 *   macOS    `osascript -e 'display notification …'`  (always present on a Mac)
 *   Linux    `notify-send`                             (present wherever libnotify is)
 *   Windows  NO-OP, deliberately and openly. There is no equivalent that does not mean either
 *            shelling into PowerShell to construct a toast (a multi-second process launch, and
 *            a script string built from user text) or adding a native dependency. Rather than
 *            fake it, `notifyCommand("win32")` returns null and nothing is spawned.
 *
 * FAIL-SOFT, non-negotiable: this runs inside the registry's `onSettle` callback, which is
 * invoked SYNCHRONOUSLY inside `for (const cb of e.onSettle)`. A throw here would abort that
 * loop and skip every other subscriber — including `agents attach`'s finish handler. Nothing
 * in this module may throw, ever, for any reason.
 */
import { createRequire } from "node:module";

import { which } from "../updates/probe.js";

// `node:child_process` is engine-bridge's exclusive static import (C5); a runtime require is
// the sanctioned escape hatch, the same one `updates/probe.ts` and `tmux/tmux.ts` use.
const nodeRequire = createRequire(import.meta.url);

/** The minimal spawn seam (injected in tests so no suite ever posts a real notification). */
export type NotifySpawn = (
  bin: string,
  args: readonly string[],
  opts: Record<string, unknown>,
) => { unref?(): void; on?(e: "error", cb: (err: Error) => void): void };

/** A notification to post: the binary and its argv. */
export interface NotifyCommand {
  bin: string;
  args: string[];
}

/**
 * Escape a string for embedding in an AppleScript double-quoted literal.
 *
 * Load-bearing: the body carries the RUN'S TASK, which is user text. An unescaped `"` would
 * terminate the literal and let the rest of the task be read as AppleScript — this is the one
 * place in this feature where untrusted text meets an interpreter. Newlines and control
 * characters are folded to spaces because AppleScript string literals cannot contain a raw
 * newline at all (the script would simply fail to compile, so the notification would silently
 * never appear).
 */
export function escapeAppleScript(s: string): string {
  return (
    s
      // Control characters (and DEL) fold to a space: an AppleScript string literal cannot
      // contain a raw newline, so leaving one in makes the script fail to COMPILE — the
      // notification then silently never appears, which is worse than a mangled one.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      // Backslash FIRST. Escaping quotes first would then double-escape the backslashes this
      // step adds, and `a\"b` would come out wrong.
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
  );
}

/** Keep a notification short — a wall of text is truncated by every notification centre anyway. */
export function clampNotificationText(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/**
 * Build the platform's notification command, or `null` when this platform has no clean
 * mechanism (Windows) or the required binary is absent (Linux without libnotify).
 *
 * PURE apart from the `which` probe, which only reads the filesystem — so a test can drive
 * every branch by passing a platform and a stub probe, with no OS of that kind in sight.
 */
export function notifyCommand(
  platform: string,
  title: string,
  body: string,
  opts: { hasBin?: (bin: string) => boolean } = {},
): NotifyCommand | null {
  const t = clampNotificationText(title);
  const b = clampNotificationText(body);
  if (platform === "darwin") {
    // One `-e` argument, built here rather than by a shell: `osascript` is spawned with
    // shell:false, so the only interpreter involved is AppleScript itself.
    return {
      bin: "osascript",
      args: [
        "-e",
        `display notification "${escapeAppleScript(b)}" with title "${escapeAppleScript(t)}"`,
      ],
    };
  }
  if (platform === "linux" || platform === "freebsd") {
    const has = opts.hasBin ?? ((bin: string) => which(bin));
    if (!has("notify-send")) return null; // no libnotify → silently no notification
    // `--` first: a task beginning with a dash must not be parsed as an option.
    return { bin: "notify-send", args: ["--", t, b] };
  }
  // win32 (and anything unknown): no clean mechanism — see the header. Deliberately nothing.
  return null;
}

/** The terminal states worth interrupting a human for, mapped to a title. */
const TITLES: Record<string, string> = {
  done: "Prometheus — background run finished",
  failed: "Prometheus — background run FAILED",
  killed: "Prometheus — background run killed",
};

/** The settled run, as the registry reports it (a structural subset of `RunRecord`). */
export interface SettledRun {
  id: string;
  state: string;
  model?: string;
  exitSummary?: string;
}

export interface NotifyDeps {
  platform?: string;
  spawnImpl?: NotifySpawn;
  hasBin?: (bin: string) => boolean;
  /** opt-out seam: `PROMETHEUS_NO_NOTIFY=1` (or any truthy value) silences notifications. */
  env?: Record<string, string | undefined>;
}

/**
 * Post ONE notification for a settled detached run.
 *
 * Returns what was spawned (or null when nothing was) so a test can assert the argv without
 * a real notification centre. NEVER THROWS — see this module's header for why that is not
 * merely good manners here.
 */
export function notifyRunSettled(run: SettledRun, deps: NotifyDeps = {}): NotifyCommand | null {
  try {
    const env = deps.env ?? process.env;
    const optOut = env.PROMETHEUS_NO_NOTIFY;
    if (optOut && optOut !== "0" && optOut !== "false") return null;
    const title = TITLES[run.state];
    // A non-terminal state is not a completion. `setState` only fires onSettle for terminal
    // states today, but a notification that could fire mid-run is not worth the coupling.
    if (!title) return null;
    const detail = (run.exitSummary ?? "").trim();
    const body = detail ? `${run.id}: ${detail}` : `${run.id} (${run.model ?? "agent"})`;
    const cmd = notifyCommand(
      deps.platform ?? process.platform,
      title,
      body,
      deps.hasBin ? { hasBin: deps.hasBin } : {},
    );
    if (!cmd) return null;
    const spawn =
      deps.spawnImpl ?? (nodeRequire("node:child_process") as { spawn: NotifySpawn }).spawn;
    const child = spawn(cmd.bin, cmd.args, {
      // Detached + unref'd + ignored stdio: posting a notification must not keep the CLI alive
      // at exit, and must not write anything into the user's terminal.
      stdio: "ignore",
      detached: true,
      shell: false,
    });
    // An ENOENT on a probed-away binary would otherwise surface as an unhandled 'error' event.
    child.on?.("error", () => {});
    child.unref?.();
    return cmd;
  } catch {
    return null; // a notification is never worth a failure anywhere else
  }
}
