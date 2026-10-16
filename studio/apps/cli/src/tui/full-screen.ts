// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tui/full-screen.ts — run a full-screen program as the whole of a one-shot command.
 *
 * `prometheus disk-space` typed at a shell (including `sudo prometheus disk-space`) has no
 * Prometheus screen to return to, so it does not open an overlay: it gives disk_space.py the
 * terminal, relays it through the same `OverlaySession` + `pty_host.py` pair the TUI uses, and
 * resolves when the program ends — on its own (q) or because the human pressed Ctrl+D. The
 * caller then exits.
 *
 * There is nothing to minimise to, so Ctrl+] is the program's key here; Ctrl+D is the one key
 * Prometheus keeps. The terminal is put back the way it was found: raw mode off, the program's
 * screen modes undone, every listener removed.
 */
import { type OverlayLaunch, OverlaySession } from "./overlay-session.js";

interface FullScreenStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(on: boolean): unknown;
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  off(event: "data", cb: (chunk: Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

interface FullScreenStdout {
  columns?: number;
  rows?: number;
  write(data: string): unknown;
  on(event: "resize", cb: () => void): unknown;
  off(event: "resize", cb: () => void): unknown;
}

export interface FullScreenResult {
  /** the program's exit code (128 + N when a signal ended it) */
  code: number | null;
  /** true when the human ended it with Ctrl+D */
  terminated: boolean;
}

export function runFullScreen(
  launch: OverlayLaunch,
  io: { stdin: FullScreenStdin; stdout: FullScreenStdout },
  seams: Pick<
    ConstructorParameters<typeof OverlaySession>[0],
    "spawn" | "setTimer" | "clearTimer" | "env"
  > = {},
): Promise<FullScreenResult> {
  const { stdin, stdout } = io;
  const wasRaw = stdin.isRaw === true;
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => session.input(Buffer.from(chunk));
    const onResize = (): void => session.resize();
    const session: OverlaySession = new OverlaySession({
      ...launch,
      ...seams,
      minimizable: false,
      term: {
        write: (s) => void stdout.write(s),
        size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
      },
      onDetach: () => {},
      onExit: (code) => {
        stdin.off("data", onData);
        stdout.off("resize", onResize);
        if (!wasRaw) stdin.setRawMode?.(false);
        stdin.pause();
        resolve({ code, terminated: session.terminated });
      },
    });
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
    stdout.on("resize", onResize);
    stdin.resume();
    session.start();
  });
}
