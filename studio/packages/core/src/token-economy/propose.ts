// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * token-economy/propose.ts — pick the token-saving toolkit Prometheus surfaces to a
 * user, given how they're working (a paid closed model vs a free local one). PURE.
 */
import { type BestFor, TOKEN_TOOLS, type TokenTool } from "./techniques.js";

export interface ProposeOptions {
  /** the user is on a PAID closed model (Claude/GPT/Gemini API) — $ savings matter most. */
  usingPaidModel?: boolean;
  /** include opt-in tools (not just defaultOn). */
  includeOptIn?: boolean;
}

/** Does a tool apply given the paid/free context? (free-local users still see "both" tools.) */
function applies(tool: TokenTool, paid: boolean): boolean {
  const want: BestFor[] = paid ? ["paid-closed", "both"] : ["free-local", "both"];
  return want.includes(tool.bestFor);
}

/** Sort key: paid-savers first when on a paid model; then by impact (defaultOn, category). */
function score(tool: TokenTool, paid: boolean): number {
  let s = 0;
  if (tool.defaultOn) s += 100;
  if (paid && tool.bestFor === "paid-closed") s += 50;
  if (!paid && tool.bestFor === "free-local") s += 50;
  // output + caching are the lowest-friction wins.
  if (tool.category === "prompt-caching") s += 20;
  if (tool.category === "output-compression") s += 15;
  if (tool.category === "context-pruning") s += 10;
  if (tool.maturity === "production") s += 5;
  if (tool.maturity === "experimental") s -= 30;
  return s;
}

/**
 * The proposed toolkit, ranked. By default returns the `defaultOn` low-friction set
 * relevant to the user's paid/free context; pass includeOptIn for the full menu.
 */
export function proposeToolkits(opts: ProposeOptions = {}): TokenTool[] {
  const paid = opts.usingPaidModel ?? false;
  // The default proposal is the relevant `defaultOn` set; `includeOptIn` is the FULL
  // browse-all menu (every tool, paid + free, so a user can see the whole toolkit).
  // Defensive `?? []`: if a stale/missing built dist makes this module's
  // TOKEN_TOOLS binding resolve undefined in the renderer bundle, the Save-tokens
  // panel must show an empty toolkit, never crash with "reading 'filter'".
  return (TOKEN_TOOLS ?? [])
    .filter((t) => (opts.includeOptIn ? true : t.defaultOn && applies(t, paid)))
    .sort((a, b) => score(b, paid) - score(a, paid));
}

/** A one-line headline for the onboarding nudge (different emphasis paid vs free). */
export function proposeHeadline(usingPaidModel: boolean): string {
  return usingPaidModel
    ? "Cut your API bill: terse output + prompt caching + a repo map can save 40–80% of tokens."
    : "Save compute: terse output + a repo map + sub-agent offloading keep prompts small + fast.";
}
