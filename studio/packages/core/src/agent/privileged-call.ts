// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/privileged-call.ts — is this TOOL CALL a request for root?
 *
 * Used wherever a decision could otherwise be answered from memory or policy instead of by a
 * human: remembered grants, permission rules, auto-approve ladders. A privileged call is never
 * auto-approved, never answered by a stored grant, and never stored as one — "always allow"
 * does not exist for root.
 *
 * Its own module (not authorization.ts) because it needs the exec classifier, and
 * `exec/classify.ts` already imports authorization.ts.
 */
import { classifyPrivileged } from "./exec/privileged.js";

/** Tools whose whole purpose is a privileged command. */
export const PRIVILEGED_TOOLS: ReadonlySet<string> = new Set(["propose_elevated"]);

export function isPrivilegedCall(call: { name: string; args?: Record<string, unknown> }): boolean {
  if (PRIVILEGED_TOOLS.has(call.name)) return true;
  const command = call.args?.command;
  if (typeof command === "string" && command && classifyPrivileged(command).privileged) return true;
  const argv = call.args?.argv;
  return (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((a) => typeof a === "string") &&
    classifyPrivileged(argv as string[]).privileged
  );
}
