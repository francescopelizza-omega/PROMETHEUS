// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/ask-cancellable.ts — a readline question the user may walk away from.
 *
 * The plain `rl.question` waits for a line forever. Ctrl-C aborts the turn but leaves the
 * question registered, so the NEXT line typed becomes its answer; Ctrl-D closes readline WITHOUT
 * firing the callback, and a host that waits on that answer then hangs its teardown for good. For
 * a question whose yes authorises installs — "Do you want to update everything right now? y/N" —
 * every way of walking away must read as no:
 *   • the signal (Ctrl-C) answers "" and, passed to readline, withdraws the question there too;
 *   • a close (Ctrl-D, stdin EOF) answers "";
 *   • keys typed earlier without Return are emptied first (pending-line.ts), and when they cannot
 *     be, the question is not asked at all.
 *
 * Out of host.ts so each of those is testable against a readline-faithful fake: every one of
 * them could be deleted from the host with all of its tests still green.
 */
import { type LineBuffer, discardPendingLine } from "./pending-line.js";

/** The slice of node:readline's `Interface` a cancellable question uses. */
export interface QuestionLine extends LineBuffer {
  question(query: string, cb: (answer: string) => void): void;
  question(query: string, options: { signal?: AbortSignal }, cb: (answer: string) => void): void;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

/**
 * Ask `query` on `rl`; resolves with the answer, or "" for every way of not answering.
 * `note` receives the one-line explanations shown when earlier keystrokes are discarded.
 */
export function askCancellableOn(
  rl: QuestionLine,
  query: string,
  opts: { signal?: AbortSignal; closed: () => boolean; note: (text: string) => void },
): Promise<string> {
  return new Promise<string>((resolve) => {
    const { signal } = opts;
    if (signal?.aborted || opts.closed()) {
      resolve("");
      return;
    }
    let settled = false;
    const settle = (answer: string): void => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onClose = (): void => settle("");
    const onAbort = (): void => settle("");
    rl.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    const pending = discardPendingLine(rl);
    if (pending === "stuck") {
      opts.note("(keys typed before the question are still pending — nothing was run)");
      settle("");
      return;
    }
    if (pending === "discarded") opts.note("(discarded keys typed before the question)");
    try {
      // With the signal, readline itself withdraws the question on Ctrl-C, so the next line goes
      // back to the prompt instead of answering a question nobody is waiting on.
      if (signal) rl.question(query, { signal }, (answer) => settle(answer));
      else rl.question(query, (answer) => settle(answer));
    } catch {
      settle(""); // readline is already closed
    }
  });
}
