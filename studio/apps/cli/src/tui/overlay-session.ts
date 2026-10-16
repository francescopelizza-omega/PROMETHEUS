// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tui/overlay-session.ts — a full-screen program shown OVER the TUI, that can be minimised and
 * resumed without stopping it (`/disk-space` opens disk_space.py's own curses TUI this way).
 *
 * The program runs under `python/tools/pty_host.py`, a stdlib pseudo-terminal relay: it
 * believes it owns a terminal; its screen bytes come back on a pipe; keystrokes go in on
 * another; a resize line on fd 3 changes its window size (and the kernel sends it SIGWINCH).
 *
 * Keys, while it is shown:
 *   - Ctrl+]  minimises it. It keeps running — a half-finished disk scan carries on — and its
 *             output is drained but never painted over Prometheus. Ctrl+] at the Prometheus
 *             prompt (or `/disk-space` again) shows it again.
 *   - Ctrl+D  ends it: SIGTERM, then SIGKILL after 2 s if it lingers. Prometheus takes the
 *             screen back.
 *   - ESC and everything else are the program's own keys and pass through untouched.
 *
 * Hiding a curses program means undoing what it did to the terminal, so the modes it turns on
 * (alternate screen, mouse reporting, bracketed paste, application cursor keys, a hidden
 * cursor) are tracked from its output, switched off on minimise and replayed on resume. Its
 * screen is then repainted by a resize nudge — rows−1, a moment, rows — because a SIGWINCH
 * with an unchanged size is ignored by curses.
 *
 * `child_process` is reached through `createRequire` (C5), like the CLI's other spawns.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

export const CTRL_RIGHT_BRACKET = "\x1d";
export const CTRL_D = "\x04";
const MINIMIZE = 0x1d;
const TERMINATE = 0x04;
const KILL_GRACE_MS = 2000;
const REPAINT_NUDGE_MS = 80;

export type OverlayState = "attached" | "minimized" | "exited";

/** What a command asks the TUI to show as an overlay. */
export interface OverlayLaunch {
  label: string;
  /** the program and its arguments */
  argv: string[];
  python: string;
  ptyHost: string;
  cwd: string;
}

interface OverlayChild {
  pid?: number;
  stdin: {
    write(data: Buffer | string): unknown;
    on?(event: "error", cb: (err: unknown) => void): unknown;
  } | null;
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): unknown } | null;
  stdio?: readonly unknown[];
  on(event: "close" | "error", cb: (a?: unknown, b?: unknown) => void): unknown;
  kill(signal?: string): unknown;
}

type OverlaySpawn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: unknown[] },
) => OverlayChild;

export interface OverlayTerminal {
  write(data: string): void;
  size(): { cols: number; rows: number };
}

export interface OverlayOptions {
  /** shown in Prometheus's notices: "disk-space minimized …" */
  label: string;
  /** the program and its arguments */
  argv: string[];
  python: string;
  ptyHost: string;
  cwd: string;
  term: OverlayTerminal;
  env?: NodeJS.ProcessEnv;
  /**
   * false when there is nothing to minimise TO (`prometheus disk-space` run straight from the
   * shell): Ctrl+] is then the program's own key and only Ctrl+D is Prometheus's. Default true.
   */
  minimizable?: boolean;
  /** the overlay was minimised: the program runs on, Prometheus gets the screen back */
  onDetach(why: "minimized"): void;
  /** the program ended; `attached` says whether it was on screen at that moment */
  onExit(code: number | null, attached: boolean): void;
  spawn?: OverlaySpawn;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Private modes worth carrying across a minimise (DECSET numbers). */
const TRACKED = new Set([1, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1047, 1049, 2004]);
const ALT_SCREEN = [1049, 1047, 47];
const DECSET = /\x1b\[\?([\d;]+)([hl])|\x1b([=>])/g;

export class OverlaySession {
  private child: OverlayChild | null = null;
  private current: OverlayState = "exited";
  /** DECSET mode → on/off, as the program last set it */
  private readonly modes = new Map<number, boolean>();
  private keypadApp = false;
  /** the end of the previous output chunk, so a split escape sequence is still seen */
  private tail = "";
  private killTimer: unknown = null;
  private endedByCtrlD = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly o: OverlayOptions;

  constructor(o: OverlayOptions) {
    this.o = o;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get state(): OverlayState {
    return this.current;
  }

  get label(): string {
    return this.o.label;
  }

  /** the human ended it with Ctrl+D (as opposed to the program quitting on its own) */
  get terminated(): boolean {
    return this.endedByCtrlD;
  }

  start(): void {
    const { cols, rows } = this.o.term.size();
    const spawn =
      this.o.spawn ?? (nodeRequire("node:child_process") as { spawn: OverlaySpawn }).spawn;
    const child = spawn(
      this.o.python,
      // -I: the relay may run as root (`sudo prometheus disk-space`) with the user's HOME
      ["-I", this.o.ptyHost, String(cols), String(rows), "--", ...this.o.argv],
      {
        cwd: this.o.cwd,
        env: this.o.env ?? process.env,
        stdio: ["pipe", "pipe", "inherit", "pipe"],
      },
    );
    this.child = child;
    this.current = "attached";
    // a key typed after the program ended hits a closed pipe: EPIPE is expected, not a crash
    child.stdin?.on?.("error", () => {});
    (child.stdio?.[3] as { on?(e: "error", cb: () => void): unknown } | undefined)?.on?.(
      "error",
      () => {},
    );
    child.stdout?.on("data", (chunk: Buffer) => this.onOutput(chunk));
    child.on("close", (code) => this.onClose(typeof code === "number" ? code : null));
    child.on("error", () => this.onClose(null));
  }

  /** Raw keystrokes while attached. Ctrl+] and Ctrl+D are ours; everything else is the program's. */
  input(chunk: Buffer): void {
    if (this.current !== "attached" || !this.child) return;
    const minimizable = this.o.minimizable !== false;
    const stop = chunk.findIndex((b) => (minimizable && b === MINIMIZE) || b === TERMINATE);
    if (stop < 0) {
      this.child.stdin?.write(chunk);
      return;
    }
    if (stop > 0) this.child.stdin?.write(chunk.subarray(0, stop));
    if (chunk[stop] === MINIMIZE) this.minimize();
    else {
      this.endedByCtrlD = true;
      this.terminate();
    }
  }

  minimize(): void {
    if (this.current !== "attached") return;
    this.current = "minimized";
    this.o.term.write(this.undoModes());
    this.o.onDetach("minimized");
  }

  resume(): void {
    if (this.current !== "minimized") return;
    this.current = "attached";
    this.o.term.write(this.replayModes());
    const { cols, rows } = this.o.term.size();
    this.sendResize(cols, Math.max(1, rows - 1));
    this.setTimer(() => {
      if (this.current === "attached") this.sendResize(cols, rows);
    }, REPAINT_NUDGE_MS);
  }

  terminate(): void {
    if (!this.child || this.current === "exited") return;
    this.child.kill("SIGTERM");
    this.killTimer = this.setTimer(() => {
      if (this.current !== "exited") this.child?.kill("SIGKILL");
    }, KILL_GRACE_MS);
  }

  /** The real terminal changed size. A minimised program is resized when it is resumed. */
  resize(): void {
    if (this.current !== "attached") return;
    const { cols, rows } = this.o.term.size();
    this.sendResize(cols, rows);
  }

  private sendResize(cols: number, rows: number): void {
    const ctl = this.child?.stdio?.[3] as { write?(s: string): unknown } | undefined;
    ctl?.write?.(`resize ${cols} ${rows}\n`);
  }

  private onOutput(chunk: Buffer): void {
    const text = chunk.toString("latin1");
    this.track(this.tail + text);
    this.tail = text.slice(-16);
    if (this.current === "attached") this.o.term.write(chunk.toString());
  }

  private track(text: string): void {
    for (const m of text.matchAll(DECSET)) {
      if (m[3]) {
        this.keypadApp = m[3] === "=";
        continue;
      }
      const on = m[2] === "h";
      for (const n of (m[1] ?? "").split(";").map(Number)) {
        if (TRACKED.has(n)) this.modes.set(n, on);
      }
    }
  }

  /** Switch off what the program switched on, so Prometheus gets its normal screen back. */
  private undoModes(): string {
    let s = "\x1b[0m";
    for (const [n, on] of this.modes) {
      if (on && n !== 25 && !ALT_SCREEN.includes(n)) s += `\x1b[?${n}l`;
    }
    if (this.keypadApp) s += "\x1b>";
    s += "\x1b[?25h";
    if (ALT_SCREEN.some((n) => this.modes.get(n))) s += "\x1b[?1049l";
    return s;
  }

  /** Put the program's terminal back the way it had it, on a clean screen. */
  private replayModes(): string {
    let s = ALT_SCREEN.some((n) => this.modes.get(n)) ? "\x1b[?1049h" : "";
    s += "\x1b[0m\x1b[2J\x1b[H";
    for (const [n, on] of this.modes) {
      if (!ALT_SCREEN.includes(n) && n !== 25) s += `\x1b[?${n}${on ? "h" : "l"}`;
    }
    if (this.keypadApp) s += "\x1b=";
    if (this.modes.get(25) === false) s += "\x1b[?25l";
    return s;
  }

  private onClose(code: number | null): void {
    if (this.current === "exited") return;
    const wasAttached = this.current === "attached";
    this.current = "exited";
    if (this.killTimer) this.clearTimer(this.killTimer);
    // the screen is handed back here; the app restores its own UI from `onExit(…, true)`
    if (wasAttached) this.o.term.write(this.undoModes());
    this.o.onExit(code, wasAttached);
  }
}
