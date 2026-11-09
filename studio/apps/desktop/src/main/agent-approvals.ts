// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/agent-approvals.ts — MAIN decides whether an agent tool call needs a human.
 *
 * The Studio agent loop runs in the renderer, and so did the only copy of the autonomy ladder:
 * `agent:systemTool` executed whatever arrived, trusting that the renderer had asked whoever it
 * should have. Main clamped the LEVEL (to the saved file, the posture, sudo) for the OS sandbox,
 * and then never used that clamped level to ask the ladder's actual question. So a renderer
 * whose ladder said "allow" where main's said "ask" — a stale level, the `autoApprove:false`
 * posture the renderer never applies, a bug in either list, a forged request — ran the call
 * with nobody asked.
 *
 * Now:
 *   1. Main computes the decision itself, with core's own functions (`execAuthDecision` on the
 *      parsed command's tier for `run_command`; `authDecision` / `scopedWriteDecision` with the
 *      tool's real annotations otherwise) at the CLAMPED level.
 *   2. When a human approves a call in the pane (its task card, or a remembered grant), the
 *      renderer asks main to mint an approval TOKEN for that exact call — name + canonical args,
 *      single-use, minutes-long. `agent:systemTool` consumes it: a token never covers a
 *      different command, a changed argument, or a second run.
 *   3. When main's ladder says "ask" and the call carries no valid token, main asks the human
 *      ITSELF with a native dialog — the one prompt a renderer cannot answer for itself — and
 *      runs the call only on "Run".
 *
 * What this does not claim: a fully compromised renderer can still mint a token for whatever it
 * likes, exactly as it can type into the terminal it already owns. The binding stops drift,
 * replay and argument swaps; the native dialog stops a ladder disagreement from running
 * anything silently.
 *
 * Everything here except `nativeApprove` is pure and unit-tested.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  type AuthToolEffect,
  authDecision,
  classifyAuth,
  scopedWriteDecision,
} from "@prometheus/core/agent-authorization";
import { classifyCommand, execAuthDecision, parseCommand } from "@prometheus/core/agent-exec";
import { HOST_DISPATCH_TOOLS } from "@prometheus/core/agent-system";

/** Canonical JSON: object keys sorted at every depth, so `{a,b}` and `{b,a}` digest alike. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** The identity of one tool call: what a token is bound to. */
export function callDigest(name: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${name}\u0000${canonical(args)}`)
    .digest("hex");
}

export const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_OUTSTANDING = 256;

/** Single-use approval tokens, each bound to one call digest. */
export class ApprovalLedger {
  private readonly tokens = new Map<string, { digest: string; at: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  mint(name: string, args: Record<string, unknown>): string {
    this.sweep();
    while (this.tokens.size >= MAX_OUTSTANDING) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    const token = randomBytes(18).toString("base64url");
    this.tokens.set(token, { digest: callDigest(name, args), at: this.now() });
    return token;
  }

  /** True once per token, and only for the exact call it was minted for. */
  consume(token: unknown, name: string, args: Record<string, unknown>): boolean {
    if (typeof token !== "string" || token.length === 0) return false;
    this.sweep();
    const rec = this.tokens.get(token);
    if (!rec) return false;
    this.tokens.delete(token); // spent whether or not it matches: a probe burns it
    return rec.digest === callDigest(name, args);
  }

  get size(): number {
    return this.tokens.size;
  }

  private sweep(): void {
    const cutoff = this.now() - APPROVAL_TTL_MS;
    for (const [t, rec] of this.tokens) if (rec.at < cutoff) this.tokens.delete(t);
  }
}

/**
 * ONE ledger for the process: `agent:approveToolCall` (ide-ipc) mints into it, and both
 * `agent:systemTool` and `mcp:agent-call` consume from it.
 */
export const sharedApprovals = new ApprovalLedger();

/**
 * Main's ladder for a tool whose annotations the caller resolved itself (an MCP tool: core's
 * `ladderAnnotations` over the server's own descriptor). Undefined annotations on an `mcp__`
 * name classify as `install` in core, i.e. ask below the network rung.
 */
export function mainNeedsApprovalFor(
  name: string,
  annotations: AuthToolEffect | undefined,
  level: number,
): boolean {
  return authDecision(level, name, annotations) !== "allow";
}

const ANNOTATIONS: ReadonlyMap<string, AuthToolEffect | undefined> = new Map(
  HOST_DISPATCH_TOOLS.map((t) => [t.name, t.annotations as AuthToolEffect | undefined]),
);

export interface ApprovalContext {
  /** the CLAMPED level (saved file ∧ posture ∧ elevation) — never the renderer's claim */
  level: number;
  /** every path argument resolved inside the working set (fail-closed: unknown ⇒ false) */
  insideWorkingSet: boolean;
}

/**
 * Main's own answer to "does a human need to approve this call?". Mirrors the pane's
 * `autoApprovesToolCall` + `scopedWriteDecision`, from core's functions, so the two can only
 * disagree when their INPUTS do — which is exactly the case main must not trust.
 * FAIL-CLOSED: anything unparseable or unknown needs a human.
 */
export function mainNeedsApproval(
  name: string,
  args: Record<string, unknown>,
  ctx: ApprovalContext,
): boolean {
  if (name === "run_command") {
    const line = typeof args.command === "string" ? args.command : "";
    if (!line) return true;
    const parsed = parseCommand(line, {});
    if (!parsed.ok) return true;
    const cls = classifyCommand(parsed.command);
    if (!cls.ok) return true;
    return execAuthDecision(ctx.level, cls.tier) !== "allow";
  }
  if (!ANNOTATIONS.has(name)) return true;
  const ann = ANNOTATIONS.get(name);
  if (classifyAuth(name, ann) === "write") {
    return scopedWriteDecision(ctx.level, name, ann, ctx.insideWorkingSet) !== "allow";
  }
  return authDecision(ctx.level, name, ann) !== "allow";
}

const WHY_ASKING =
  "Your autonomy level does not run this without asking, and the editor did not show you an " +
  "approval for it — so Prometheus is asking here instead.";

/** Longest command a person can be asked to review in the dialog. Past it, the request is
 *  DENIED rather than shown clipped: "1500 chars of padding, then `; curl …|sh`" displayed only
 *  its harmless start and an ellipsis, and a click on Run executed the whole line. */
export const MAX_REVIEWABLE = 4000;

/** Control and bidi-override characters, made visible (`\u202e`) instead of rendered. */
function visible(s: string): string {
  return s.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** What the native dialog shows — the exact thing that will run, every character. Pure. */
export function approvalPrompt(
  name: string,
  args: Record<string, unknown>,
): { message: string; detail: string; reviewable: boolean } {
  const body =
    name === "run_command" && typeof args.command === "string"
      ? args.command
      : `${name} ${canonical(args)}`;
  if (body.length > MAX_REVIEWABLE) {
    return {
      message: "Denied: too long to review",
      detail: `The agent asked to run ${body.length} characters, more than can be shown here in full (${MAX_REVIEWABLE}). It was not run. Ask the agent for a shorter step.`,
      reviewable: false,
    };
  }
  return {
    message:
      name === "run_command"
        ? "Allow the agent to run this command?"
        : `Allow the agent to use ${name}?`,
    detail: `${visible(body)}\n\n${WHY_ASKING}`,
    reviewable: true,
  };
}

/** Ask the person — but never for a request that cannot be shown in full (denied outright). */
export async function askApproval(
  approver: NativeApprover,
  prompt: { message: string; detail: string; reviewable: boolean },
): Promise<boolean> {
  if (!prompt.reviewable) return false;
  return approver(prompt);
}

/** The native prompt. Injected so tests never reach Electron. */
export type NativeApprover = (prompt: { message: string; detail: string }) => Promise<boolean>;

export async function electronNativeApprover(prompt: {
  message: string;
  detail: string;
}): Promise<boolean> {
  try {
    const { BrowserWindow, dialog } = await import("electron");
    const parent = BrowserWindow.getFocusedWindow() ?? undefined;
    const opts = {
      type: "warning" as const,
      buttons: ["Deny", "Run"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: prompt.message,
      detail: prompt.detail,
    };
    const r = parent
      ? await dialog.showMessageBox(parent, opts)
      : await dialog.showMessageBox(opts);
    return r.response === 1;
  } catch {
    return false; // no dialog ⇒ no consent
  }
}
