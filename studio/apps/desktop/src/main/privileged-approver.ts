// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/privileged-approver.ts — Studio's approver for the privileged gate (Electron-free).
 *
 * The gate (core `privileged-gate.ts`) asks; this sends the view to the window and resolves
 * with THAT window's decision for THAT request id — a decision from any other webContents is
 * refused, so a second window (or anything else running this preload) cannot answer for it. The decision is one-shot: the pending entry
 * is removed the moment it is answered, so a replayed or forged decision finds nothing to
 * approve. Anything malformed denies. When the gate times out, the dialog is told to close and
 * the request denies — a click that arrives afterwards is refused.
 *
 * The renderer only ever returns `approve`/`deny` (+ the typed phrase). It never sees a
 * password: sudo's askpass helper talks to sudo directly (`askpass.ts`).
 */
import { classifyPrivileged } from "@prometheus/core/agent-exec";
import {
  type ApprovalAnswer,
  type ApprovalView,
  type Approver,
  formatApprovalView,
} from "@prometheus/core/agent-system-host";
import {
  IPC,
  type PrivilegedDecideResult,
  type PrivilegedPromptView,
} from "../shared/ipc-contract.js";

/**
 * Send to the approving window. Returns that window's webContents id (the only sender whose
 * decision is accepted for this request), or false when there is no window to ask.
 */
export type PrivilegedSend = (channel: string, payload: unknown) => number | false;

export function toPromptView(v: ApprovalView): PrivilegedPromptView {
  return {
    id: v.id,
    commandLine: v.commandLine,
    execArgv: [...v.execArgv],
    cwd: v.cwd,
    surface: v.surface,
    requester: v.requester,
    why: v.why,
    ...(v.script ? { script: { ...v.script, head: [...v.script.head] } } : {}),
    ...(v.phrase ? { phrase: v.phrase } : {}),
    timeoutMs: v.timeoutMs,
    passwordVia: v.passwordVia,
    lines: formatApprovalView(v),
  };
}

export function createStudioApprover(send: PrivilegedSend): {
  approver: Approver;
  decide: (arg: unknown, senderId: number) => PrivilegedDecideResult;
} {
  const pending = new Map<string, { resolve: (a: ApprovalAnswer) => void; senderId: number }>();

  const approver: Approver = (view, signal) =>
    new Promise<ApprovalAnswer>((resolve) => {
      const senderId = send(IPC.privilegedRequest, toPromptView(view));
      if (senderId === false) {
        resolve({ decision: "deny" });
        return;
      }
      pending.set(view.id, { resolve, senderId });
      signal.addEventListener(
        "abort",
        () => {
          if (!pending.delete(view.id)) return;
          send(IPC.privilegedClose, { id: view.id });
          resolve({ decision: "deny" });
        },
        { once: true },
      );
    });

  const decide = (arg: unknown, senderId: number): PrivilegedDecideResult => {
    const a = arg as { id?: unknown; decision?: unknown; phrase?: unknown } | null;
    if (!a || typeof a.id !== "string") return { ok: false, error: "malformed decision" };
    const entry = pending.get(a.id);
    if (!entry) return { ok: false, error: "no such request (answered, timed out or unknown)" };
    // Not the window that was asked: refused, and the request stays open for that window.
    if (entry.senderId !== senderId) {
      return { ok: false, error: "this window was not asked to approve that request" };
    }
    const { resolve } = entry;
    pending.delete(a.id);
    if (a.decision === "approve") {
      resolve(
        typeof a.phrase === "string" && a.phrase
          ? { decision: "approve", phrase: a.phrase }
          : { decision: "approve" },
      );
    } else {
      resolve({ decision: "deny" });
    }
    return { ok: true };
  };

  return { approver, decide };
}

/**
 * Why a grant subject may not be stored, or null. Root is never remembered: core never asks
 * to store one (`withRememberedGrants`), so a privileged subject reaching `agent:grants.add`
 * was forged or hand-built, and is refused either way.
 */
export function privilegedGrantRefusal(subject: string): string | null {
  if (!subject.startsWith("bash:")) return null;
  return classifyPrivileged(subject.slice("bash:".length)).privileged
    ? "privileged commands are never remembered"
    : null;
}
