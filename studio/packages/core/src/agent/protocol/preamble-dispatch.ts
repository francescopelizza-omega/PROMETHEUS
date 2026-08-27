/**
 * agent/protocol/preamble-dispatch.ts — the preamble DISPATCH PIPELINE.
 *
 * Every host in this repo (CLI, Desktop's agent pane, the VS Code extension, a `spawn_agent`
 * child) needs to hand the model instructional text ALONGSIDE the user's own message — "you
 * must call a tool, not print code", "re-read the file before you rewrite it", "think harder
 * about this one", the tool catalog itself, the project's AGENTS.md. Every one of those grew
 * its own bespoke wiring over time (`DEFAULT_SYSTEM` in cli-profiles/profile.ts,
 * `AGENT_TOOL_DISCIPLINE` in agent/loop.ts reachable only from tests and Desktop,
 * `protocol/preamble.ts`'s tool-catalog ladder with its OWN isolated budget, steering/memory/
 * repo-map/token-economy each pushed unconditionally with NO budget at all) — with no shared
 * registry, no shared budget accounting, and no one place a new feature author could look to
 * learn how to get text in front of the model.
 *
 * This module is that one place. It does not replace `protocol/preamble.ts` — the tool
 * catalog's own full→signatures→required-only→names→drop ladder is unchanged and still lives
 * there; this generalizes the ONE THING that was missing, which is priority ordering and a
 * SHARED token budget across every contributor, not just the tool catalog.
 *
 * PURE: no node, no IO, no randomness. A per-round volatile need (see `agent/canary.ts`) is
 * deliberately NOT expressible here — see that module's doc comment for why.
 */
import type { PermissionModeId } from "../permission-modes.js";
import type { ToolDef } from "../tools.js";
import type { ToolTransport } from "./negotiate.js";

/** The hosts that assemble a preamble today. Purely informational — no built-in contributor
 *  branches on it; it exists so a FUTURE contributor can, without a type change. */
export type PreambleSurface = "cli" | "desktop" | "vscode" | "subagent";

/**
 * Everything a contributor might need to decide whether it applies, and what to say.
 *
 * Deliberately a superset across BOTH assembly cadences a turn actually has: `transport`/
 * `demonstratedToolSyntax` are only ever set on the round-scope call (see the CLI's `withPreamble`
 * and `CORE_ROUND_CONTRIBUTORS`) — they don't exist yet when a turn's thread is first built.
 */
export interface PreambleCtx {
  surface: PreambleSurface;
  /** true for a `spawn_agent` child's turn — never true for the primary conversation. */
  isSubAgent: boolean;
  subagentRole?: "explore" | "scout" | "plan" | "build";
  /** true when the acting tuning cannot reach ANY mutating tool (read-only sub-agent roles,
   *  or the primary turn while in `permissionMode:"plan"`). Narrower than `isSubAgent`. */
  readOnly: boolean;

  modelId?: string;
  locality: "local" | "cloud" | "unknown";
  /** the model's measured context window, when known. Sizes `instructionBudget`. */
  contextWindow?: number;

  /** the `/think`-style tier in force, if any. */
  effortTier?: "off" | "low" | "medium" | "high" | "max";
  /**
   * The RESOLVED request-parameter mechanism for this model (`ai/effort/types.ts`'s
   * `EffortMechanism`), when known. `undefined` ⇒ not yet resolved — treated conservatively
   * (the textual fallback still offers the nudge) rather than assumed fine.
   */
  effortMechanism?: string;

  /** ROUND-SCOPE ONLY: which transport this round negotiated. Absent at turn-assembly time. */
  transport?: ToolTransport;
  /** ROUND-SCOPE ONLY: has this endpoint already proven it can produce the text-call syntax. */
  demonstratedToolSyntax?: boolean;
  /** the exposed tool set for THIS turn (post allow/deny). Required even when a given call
   *  site's contributors don't look at it, so every contributor CAN. */
  tools: readonly ToolDef[];

  authLevel?: number;
  permissionMode?: PermissionModeId;
  gateMode?: "enforce" | "warn" | "off";

  /** chars-per-token, matching `agent/compact.ts`'s / `preamble.ts`'s estimator. */
  charsPerToken?: number;
}

export type PreambleMergeTarget = "persona" | "block";

export interface PreambleUnit {
  text: string;
  /** default "persona" — persona-target text is folded into the SAME system message as the
   *  host's own persona string; block-target text becomes its own trailing system message. */
  mergeTarget?: PreambleMergeTarget;
  /** what a contributor with its OWN internal ladder (the tool catalog) had to drop to fit. */
  degraded?: { detail: string; omitted?: readonly string[] };
}

export interface PreambleContributor {
  id: string;
  /** ascending = claims the shared budget first. Ties keep registration order (stable sort). */
  priority: number;
  applies(ctx: PreambleCtx): boolean;
  /**
   * `budgetTokens` is what remains after every higher-priority contributor already claimed
   * its share. A contributor with no internal ladder should just render its (small, fixed)
   * text and let the assembler drop it whole if it doesn't fit; a contributor WITH an internal
   * ladder (the tool catalog) should degrade itself against this ceiling and report what it
   * dropped via `degraded`, rather than being dropped whole.
   */
  render(ctx: PreambleCtx, budgetTokens: number): PreambleUnit | null;
}

/** One contributor's outcome, for logging/telemetry/tests. Deliberately carries NO raw text —
 *  a contributor's rendered string is already available to whoever called `render` directly in
 *  a unit test; this is the INTROSPECTION surface (what fired, how big, what degraded), and
 *  keeping it text-free is what makes it safe to log or snapshot without a future contributor
 *  (see `agent/canary.ts`'s doc comment) accidentally becoming loggable through this channel. */
export interface RenderedContribution {
  id: string;
  mergeTarget: PreambleMergeTarget;
  approxTokens: number;
  degraded?: { detail: string; omitted?: readonly string[] };
}

export interface PreambleAssembly {
  /** "persona"-target contributions, in priority order, "\n\n"-joined. Append this to the
   *  host's own persona/system-prompt string — never prepend, never reorder ahead of it. */
  personaAppend: string;
  /** "block"-target contributions' texts, in priority order — one trailing system message
   *  each, exactly as steering/memory/repo-map/token-economy blocks are pushed today. */
  blocks: string[];
  /** every contributor that actually fired, for logging and for tests. */
  contributions: RenderedContribution[];
  /** contributor ids that `applies()` but did not fit the remaining budget AT ALL. */
  omittedForBudget: string[];
  totalApproxTokens: number;
  budgetTokens: number;
}

/**
 * Assemble every applicable contributor, in priority order, against ONE shared token budget.
 *
 * A contributor's OWN internal degrade (the tool catalog) always sees a ceiling of at most
 * `budgetTokens` remaining when it's their turn — they cannot see more than the pool actually
 * has left. A contributor with no internal ladder is all-or-nothing: it either fits in what's
 * left or is skipped whole and recorded in `omittedForBudget` — silently dropping a fraction of
 * a one-sentence rule is worse than dropping it cleanly and being able to say so.
 */
export function assemblePreamble(
  contributors: readonly PreambleContributor[],
  ctx: PreambleCtx,
  budgetTokens: number,
): PreambleAssembly {
  const charsPerToken = ctx.charsPerToken ?? 4;
  const approxTokens = (s: string): number => Math.ceil(s.length / charsPerToken);
  const ordered = [...contributors].sort((a, b) => a.priority - b.priority);

  let remaining = budgetTokens;
  const personaParts: string[] = [];
  const blocks: string[] = [];
  const contributions: RenderedContribution[] = [];
  const omittedForBudget: string[] = [];

  for (const c of ordered) {
    if (!c.applies(ctx)) continue;
    const unit = c.render(ctx, Math.max(0, remaining));
    if (!unit || unit.text.trim() === "") continue;
    const tokens = approxTokens(unit.text);
    if (tokens > Math.max(0, remaining)) {
      omittedForBudget.push(c.id);
      continue;
    }
    remaining -= tokens;
    const mergeTarget = unit.mergeTarget ?? "persona";
    (mergeTarget === "persona" ? personaParts : blocks).push(unit.text);
    contributions.push({
      id: c.id,
      mergeTarget,
      approxTokens: tokens,
      ...(unit.degraded ? { degraded: unit.degraded } : {}),
    });
  }

  return {
    personaAppend: personaParts.join("\n\n"),
    blocks,
    contributions,
    omittedForBudget,
    totalApproxTokens: budgetTokens - remaining,
    budgetTokens,
  };
}

/* ── the shared budget ───────────────────────────────────────────────────────*/

/**
 * Share of the model's context window the WHOLE preamble pipeline may occupy.
 *
 * Deliberately larger than `preamble.ts`'s `PREAMBLE_WINDOW_SHARE` (0.08 / 700 / 4000): that
 * constant was sized for the tool catalog ALONE. This pool now also covers tool-discipline,
 * the pre-write-recheck checklist, effort-as-text, and (via host adapters) steering, memory,
 * the repo map and token-economy blocks — categories that previously had NO budget ceiling at
 * all. `preamble.ts`'s own constants are unchanged and still apply, as the tool-catalog
 * contributor's OWN inner ceiling (see `contributors/tool-catalog.ts`) — this is the OUTER one.
 *
 * FLAGGED: unlike the 0.08 figure (checked against a live 45-tool catalog), these three numbers
 * are reasoned by analogy rather than measured against real steering/memory/repo-map sizes in
 * this repo — worth instrumenting `PreambleAssembly.totalApproxTokens`/`omittedForBudget`
 * across a few real repos before treating them as final.
 */
export const INSTRUCTION_BUDGET_SHARE = 0.15;
export const INSTRUCTION_BUDGET_MIN = 1200;
export const INSTRUCTION_BUDGET_MAX = 6000;

/** The whole-pipeline budget for a model with `contextWindow` tokens. Same clamp shape as
 *  `preamble.ts`'s `preambleBudget` — deliberately named differently so the two are never
 *  confused for each other at a call site. */
/** Mirrors `ai/context-window.ts`'s `DEFAULT_CONTEXT_WINDOW` (not imported, to avoid coupling
 *  this pure protocol module to the ai/ layer for one literal) — the no-window fallback below
 *  computes what THAT default would actually produce, rather than an unrelated formula that
 *  happened to land in the same ballpark. */
const FALLBACK_CONTEXT_WINDOW = 8192;

export function instructionBudget(contextWindow: number | undefined): number {
  const window =
    contextWindow && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : FALLBACK_CONTEXT_WINDOW;
  const share = Math.floor(window * INSTRUCTION_BUDGET_SHARE);
  return Math.min(Math.max(share, INSTRUCTION_BUDGET_MIN), INSTRUCTION_BUDGET_MAX);
}
