// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tmux/multiplexer.ts — the P6 tmux multiplexer entry point.
 *
 * `launchTmuxSession(parsed)` is the multi-window surface bare `prometheus session`
 * (and `prometheus session --tmux NAME`) lands in. Its contract is a single, sharp
 * decision:
 *
 *   - tmux is NOT available, OR the user did not enable it  ⇒  FALL BACK to the
 *     P4 single-window session host (`launchSession(parsed)`) and return its code.
 *     A CLI-only box (no tmux binary) still gets the full REPL — degraded, never
 *     crashed.
 *   - tmux IS available AND enabled  ⇒  build a multi-window LAYOUT (a `main`
 *     window running the REPL, plus on-demand `chat` / `health` / `logs` / `env`
 *     windows), hand it to `runTmux` (idempotent `has-session` guard, then attach).
 *
 * The window MODEL is NOT bespoke: it is the SAME `@prometheus/core` terminal
 * launcher state (`initialLauncherState` / `launcherReducer` / `sessionsByGroup`)
 * the GUI uses — so a window here is a `TerminalSession` grouped exactly as the IDE
 * groups them (project / ai / floating), and the grouped order is what fixes the
 * window arrangement. The pure `buildSessionLayout` turns the parsed args into that
 * launcher state + an injection-safe `TmuxSpec` (the sibling tmux.ts type); it does
 * NOT spawn, so it unit-tests with zero tmux/pty/engine.
 *
 * Every spawning/tmux seam (`tmuxAvailable` / `tmuxEnabled` / `runTmux` /
 * `launchSession`) is INJECTED via `deps` (defaults lazily bind the real siblings),
 * so the whole flow is driven by a scripted fake in the test — no real tmux, no
 * real readline. Crash-free: a thrown seam renders a friendly line and returns a
 * non-zero code; it NEVER escapes as a stack, and it ALWAYS falls back to the
 * single window so the user is never left without a session.
 *
 * NEVER hand-builds a terminal argv: the REPL command is the engine-blessed
 * `prometheus repl` invocation; the chat window's argv (when wired) comes from the
 * engine's `chatPreview` envelope via the engine-handoff sibling — this unit only
 * lays out WINDOWS, it decides nothing about safety (C5). Color flows ONLY through
 * ../render.ts (c.*), which sources its SGR from @prometheus/ui/tokens — no raw hex.
 */
import { terminal } from "@prometheus/core";

import type { ParsedArgs } from "../parse.js";
import { c } from "../render.js";

// The `TmuxSpec` + tmux seams live in the sibling tmux/tmux.ts (the fixed
// cross-unit API). We import the SPEC type + the value seams; the value seams are
// referenced ONLY inside the default deps (a test that injects fakes never calls
// them), so nothing real spawns under test.
import type { TmuxSpec, TmuxWindow } from "./tmux.js";
import {
  runTmux as siblingRunTmux,
  tmuxAvailable as siblingTmuxAvailable,
  tmuxEnabled as siblingTmuxEnabled,
} from "./tmux.js";

/** The launcher-state types we model windows with (re-exported by core `terminal`). */
type TerminalSession = terminal.TerminalSession;
type LauncherState = terminal.LauncherState;

/**
 * The injectable seams. Defaults bind the REAL siblings (so a test can drive the
 * entire flow with fakes). `launchSession` is the P4 single-window host (lazily
 * imported by default so this module never eagerly pulls the readline host in); the
 * three tmux helpers are the sibling tmux.ts surface.
 */
export interface TmuxSessionDeps {
  /** Is the `tmux` binary available? (default: sibling `tmuxAvailable`). */
  tmuxAvailable?: () => boolean;
  /** Did the user enable tmux for this invocation? (default: sibling `tmuxEnabled`). */
  tmuxEnabled?: (parsed: ParsedArgs) => boolean;
  /** Run a tmux session from a spec + attach (default: sibling `runTmux`). */
  runTmux?: (spec: TmuxSpec) => Promise<number>;
  /** The single-window fallback (default: P4 `launchSession`). */
  launchSession?: (parsed: ParsedArgs) => Promise<number>;
  /** Output sink for the friendly status lines (default: process.stdout). */
  write?: (line: string) => void;
}

/** The default tmux session name when `--tmux` is a bare flag / no name is given. */
export const DEFAULT_TMUX_SESSION = "prometheus";

/**
 * One aux window's declaration: name + launcher group + title + the engine-blessed
 * argv it runs. They are opened lazily by the user inside the session; the
 * multiplexer only DECLARES them so the layout (and its tmux command shape) is
 * deterministic + testable. `health` watches `prometheus health` (the §8
 * diagnostics loop); chat/logs/env round out a working multiplexer.
 */
interface AuxWindow {
  readonly name: string;
  readonly group: terminal.SessionGroup;
  readonly title: string;
  readonly argv: string[];
}

const AUX_WINDOWS: readonly AuxWindow[] = [
  { name: "chat", group: "ai", title: "Chat", argv: ["prometheus", "chat"] },
  { name: "health", group: "project", title: "Health", argv: ["prometheus", "health", "--watch"] },
  { name: "logs", group: "project", title: "Logs", argv: ["prometheus", "app", "logs"] },
  { name: "env", group: "project", title: "Env", argv: ["prometheus", "env", "list"] },
];

/** The main (REPL) window name + its launcher-session stem. */
export const MAIN_WINDOW = "main";

/** A stable launcher-session id for a window (deterministic — testable). */
function windowSessionId(name: string): string {
  return `tmux-${name}`;
}

/**
 * Build the launcher STATE that models a tmux session's windows. The `main` window
 * (the REPL) is always present + active; the aux windows are appended in declared
 * order. Pure: it only folds `launcherReducer` over the window list — no spawning,
 * no tmux. Exposed so the layout can be asserted directly in a unit test.
 */
export function buildLauncherState(cwd: string): LauncherState {
  const main: TerminalSession = {
    id: windowSessionId(MAIN_WINDOW),
    profileId: "shell.project",
    title: "Prometheus REPL",
    status: "running",
    openAs: "tab",
    group: "project",
    cwd,
    persist: true,
  };
  let state = terminal.launcherReducer(terminal.initialLauncherState(), {
    type: "open",
    session: main,
  });
  for (const win of AUX_WINDOWS) {
    const session: TerminalSession = {
      id: windowSessionId(win.name),
      profileId: win.group === "ai" ? "ai.chat" : "shell.project",
      title: win.title,
      status: "idle",
      openAs: "tab",
      group: win.group,
      cwd,
      persist: false,
    };
    state = terminal.launcherReducer(state, { type: "open", session });
  }
  // keep `main` focused as the entry window (the aux opens shifted activeId).
  return terminal.launcherReducer(state, { type: "focus", id: windowSessionId(MAIN_WINDOW) });
}

/**
 * The pure builder: parsed args → the tmux SPEC the runner consumes. Resolves the
 * session name (`--tmux NAME` / positional, else the default), the cwd, the `main`
 * REPL window (windows[0], the engine-blessed `prometheus repl`), and the aux
 * windows (modeled through the core launcher + grouped via `sessionsByGroup` so the
 * arrangement order matches the IDE). Injection-safety is the runner's job (it
 * shlex-quotes each token); this only assembles discrete token arrays. NO side
 * effects — unit-tested without tmux.
 */
export function buildSessionLayout(parsed: ParsedArgs): TmuxSpec {
  const cwd = parsed.cwd ?? process.cwd();
  const session = resolveSessionName(parsed);

  const state = buildLauncherState(cwd);
  // sessionsByGroup yields project → ai → floating; the aux windows follow `main`
  // in that grouped order, giving a stable, IDE-consistent arrangement.
  const grouped = terminal.sessionsByGroup(state);
  const auxById = new Map(AUX_WINDOWS.map((w) => [windowSessionId(w.name), w]));

  // windows[0] is ALWAYS the main REPL window (the runner's new-session target).
  const windows: TmuxWindow[] = [{ name: MAIN_WINDOW, argv: ["prometheus", "repl"], cwd }];

  for (const { sessions } of grouped) {
    for (const s of sessions) {
      const aux = auxById.get(s.id);
      if (!aux) continue; // the `main` launcher session has no aux entry — skip it.
      windows.push({ name: aux.name, argv: [...aux.argv], cwd });
    }
  }

  // a single-window spec leaves the layout alone; >1 window tiles (sibling default).
  return { session, windows };
}

/** Resolve the tmux session name: `--tmux NAME` wins, then a positional, else default. */
function resolveSessionName(parsed: ParsedArgs): string {
  const flag = parsed.flags.tmux;
  if (typeof flag === "string" && flag.trim() !== "") return flag.trim();
  const pos = parsed.positionals[0];
  if (pos && pos.trim() !== "") return pos.trim();
  return DEFAULT_TMUX_SESSION;
}

/* ── default seam binding ────────────────────────────────────────────────────── */

/** Lazy single-window fallback — imported on demand so this module is host-free. */
async function defaultLaunchSession(parsed: ParsedArgs): Promise<number> {
  const mod = await import("../session/host.js");
  return mod.launchSession(parsed);
}

/* ── the entry point ────────────────────────────────────────────────────────── */

/**
 * Launch a multi-window tmux session, or fall back to the single-window REPL.
 *
 * Decision:
 *   1. resolve `tmuxAvailable` + `tmuxEnabled` (injected, else the real siblings),
 *   2. if either is false → `launchSession(parsed)` (single window) and return it,
 *   3. else build the layout (`buildSessionLayout`) and `runTmux` it.
 *
 * Crash-free: ANY thrown seam (tmux probe, runner, or even the fallback) is caught,
 * a friendly one-liner is written, and a non-zero code is returned — never a stack.
 * When tmux itself fails AFTER we chose it, we still try the single-window fallback
 * so the user lands in a working session rather than nothing.
 */
export async function launchTmuxSession(
  parsed: ParsedArgs,
  deps: TmuxSessionDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const launchSingle = deps.launchSession ?? defaultLaunchSession;

  const available = deps.tmuxAvailable ?? (() => siblingTmuxAvailable());
  const enabled = deps.tmuxEnabled ?? ((p: ParsedArgs) => siblingTmuxEnabled(p));
  const runTmux = deps.runTmux ?? ((spec: TmuxSpec) => siblingRunTmux(spec));

  // 1) decide whether to multiplex. A probe that throws is treated as "no tmux".
  let multiplex = false;
  try {
    multiplex = Boolean(available()) && Boolean(enabled(parsed));
  } catch {
    multiplex = false; // a broken probe never blocks the user — degrade to single.
  }

  // 2) single-window fallback (tmux absent or disabled).
  if (!multiplex) {
    return runSingleWindow(parsed, launchSingle, write);
  }

  // 3) multiplex: build the layout + run tmux. On any tmux failure, degrade.
  try {
    const spec = buildSessionLayout(parsed);
    write(
      c.dim(`tmux: session "${spec.session}" — main REPL + ${spec.windows.length - 1} window(s).`),
    );
    return await runTmux(spec);
  } catch (err) {
    write(
      c.yellow(
        `prometheus: tmux launch failed (${errMessage(err)}) — falling back to a single window.`,
      ),
    );
    return runSingleWindow(parsed, launchSingle, write);
  }
}

/**
 * Run the single-window REPL fallback, guarded so even a fallback failure renders a
 * friendly line + a non-zero code (never a stack). This is the floor: the user
 * always lands somewhere sensible.
 */
async function runSingleWindow(
  parsed: ParsedArgs,
  launchSingle: (parsed: ParsedArgs) => Promise<number>,
  write: (line: string) => void,
): Promise<number> {
  try {
    return await launchSingle(parsed);
  } catch (err) {
    write(c.red(`prometheus: could not start a session (${errMessage(err)}).`));
    return 1;
  }
}

/** Coerce any thrown value into a single-line message (never throws). */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
