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

/**
 * The HUMAN's final word, owned by main: a native dialog that names the exact command, its
 * working directory and the script digest. The renderer's card is informational — the renderer
 * is not trusted to approve root for itself (a compromised one could start a request through
 * `agent:systemTool` and answer `privilegedDecide` on its own, and sudo's password prompt never
 * names the command it is about to run).
 */
export type NativeConfirm = (view: ApprovalView) => Promise<boolean>;

export function createStudioApprover(
  send: PrivilegedSend,
  nativeConfirm?: NativeConfirm,
): {
  approver: Approver;
  decide: (arg: unknown, senderId: number) => Promise<PrivilegedDecideResult>;
} {
  const pending = new Map<
    string,
    { resolve: (a: ApprovalAnswer) => void; senderId: number; view: ApprovalView; aborted: boolean }
  >();

  const approver: Approver = (view, signal) =>
    new Promise<ApprovalAnswer>((resolve) => {
      const senderId = send(IPC.privilegedRequest, toPromptView(view));
      if (senderId === false) {
        resolve({ decision: "deny" });
        return;
      }
      const entry = { resolve, senderId, view, aborted: false };
      pending.set(view.id, entry);
      signal.addEventListener(
        "abort",
        () => {
          entry.aborted = true;
          if (!pending.delete(view.id)) return;
          send(IPC.privilegedClose, { id: view.id });
          resolve({ decision: "deny" });
        },
        { once: true },
      );
    });

  const decide = async (arg: unknown, senderId: number): Promise<PrivilegedDecideResult> => {
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
    if (a.decision !== "approve") {
      resolve({ decision: "deny" });
      return { ok: true };
    }
    // The renderer said yes; the human says it in a dialog main owns, or it is a no.
    const human = nativeConfirm ? await nativeConfirm(entry.view).catch(() => false) : true;
    if (!human || entry.aborted) {
      resolve({ decision: "deny" });
      return { ok: true };
    }
    resolve(
      typeof a.phrase === "string" && a.phrase
        ? { decision: "approve", phrase: a.phrase }
        : { decision: "approve" },
    );
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
