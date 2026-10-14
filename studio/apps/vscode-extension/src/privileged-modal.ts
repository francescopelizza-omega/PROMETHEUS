// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * privileged-modal.ts — VS Code's approver for the privileged gate.
 *
 * A NATIVE modal, for the same reason `confirmToolCall` uses one: a webview dialog disappears
 * when the sidebar is collapsed, and a privileged prompt nobody can see would just time out.
 * The modal carries the exact command, then every fact `formatApprovalView` lists, and ONE
 * button — "Approve once". Dismissing it (Escape, Cancel, clicking away) denies. There is no
 * "always". A catastrophic command additionally asks for its target to be typed.
 *
 * VS Code cannot close a modal it opened, so when the gate's timer denies first, a click that
 * arrives afterwards is reported rather than acted on. The password is never here: `sudo -A`
 * runs the askpass helper, which hands it to sudo directly.
 *
 * `vscode.window` is injected (a structural subset) so this is testable without the editor.
 */
import {
  type ApprovalAnswer,
  type Approver,
  formatApprovalView,
} from "@prometheus/core/agent-system-host";

export interface ModalWindow {
  showWarningMessage(
    message: string,
    options: { modal: boolean; detail?: string },
    ...items: string[]
  ): PromiseLike<string | undefined>;
  showInputBox(options: { prompt: string; ignoreFocusOut?: boolean }): PromiseLike<
    string | undefined
  >;
  showInformationMessage(message: string): PromiseLike<unknown>;
}

export const APPROVE_ONCE = "Approve once";

export function makeVsCodeApprover(win: ModalWindow): Approver {
  return async (view, signal) => {
    const [title = "", command = "", ...rest] = formatApprovalView(view);
    const choice = await win.showWarningMessage(
      `${title}\n${command.trim()}`,
      { modal: true, detail: rest.join("\n") },
      APPROVE_ONCE,
    );
    let answer: ApprovalAnswer = { decision: "deny" };
    if (choice === APPROVE_ONCE) {
      if (view.phrase) {
        const typed = (
          await win.showInputBox({
            prompt: `This can destroy data. Type ${view.phrase} to approve once.`,
            ignoreFocusOut: true,
          })
        )?.trim();
        answer = typed ? { decision: "approve", phrase: typed } : { decision: "deny" };
      } else {
        answer = { decision: "approve" };
      }
    }
    if (signal.aborted) {
      void win.showInformationMessage(
        "Prometheus: that prompt had already timed out — nothing ran.",
      );
      return { decision: "deny" };
    }
    return answer;
  };
}
