// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/privileged-prompt.ts — the terminal half of the privileged gate's approval.
 *
 * Shared by the TUI and the readline host: both have a line writer, a y/N question and a
 * free-text question, and both must show the SAME facts before asking. The gate decides what
 * those facts are (`formatApprovalView`); this only prints them and asks.
 *
 * The default is DENY: only an explicit yes approves, and a catastrophic command needs its
 * target typed. There is no "always" — the question has two answers. When the gate's timer has
 * already denied the request, a late answer is reported rather than silently dropped, so the
 * human is never left believing a command ran.
 */
import { type Approver, formatApprovalView } from "@prometheus/core/agent-system-host";

export interface TerminalPromptIo {
  write: (line: string) => void;
  confirm: (prompt: string) => Promise<boolean>;
  ask: (prompt: string) => Promise<string>;
}

export function makeTerminalApprover(io: TerminalPromptIo): Approver {
  return async (view, signal) => {
    for (const line of formatApprovalView(view)) io.write(`  ⎿ ${line}`);
    const secs = Math.round(view.timeoutMs / 1000);
    let answer: Awaited<ReturnType<Approver>>;
    if (view.phrase) {
      const typed = (
        await io.ask(`type ${view.phrase} to approve once (Enter denies, ${secs} s): `)
      ).trim();
      answer = typed ? { decision: "approve", phrase: typed } : { decision: "deny" };
    } else {
      const yes = await io.confirm(
        `approve once? y approves · anything else denies · ${secs} s then deny`,
      );
      answer = yes ? { decision: "approve" } : { decision: "deny" };
    }
    if (signal.aborted) {
      io.write("  ⎿ that prompt had already timed out — nothing ran");
      return { decision: "deny" };
    }
    return answer;
  };
}
