/**
 * session/agent-runtime.ts — the P4 in-session agent runtime (file 11 §3.2 wiring).
 *
 * This is the LLM⇄tool wiring the single-window interactive session host drives. It
 * bridges three already-built, already-tested pieces — none of which knew about each
 * other — without inventing a new agent loop or a new tool catalog:
 *
 *   1. `makeLlmClient(endpoint, deps)` adapts the provider-agnostic streaming AI
 *      client (`@prometheus/core` `createAiClient` — an OpenAI-compatible
 *      `/v1/chat/completions` SSE *text* stream) to the agent loop's `LLMClient`
 *      contract: it yields `LlmTurn {kind:"text"}` for each delta, then a single
 *      `{kind:"final"}`. The OpenAI SSE the core client parses carries *text* only
 *      (no native tool-call frames), so we are HONEST: tool calls require
 *      `endpoint.supportsTools` AND a tool-call-capable transport; until that
 *      transport exists we stay text-only and never fabricate a tool call.
 *
 *   2. `makeToolRunner(client)` returns the loop's `ToolRunner`: it maps an
 *      (already broker-approved, already --force-stripped) `ToolDef` to a
 *      prometheus.py argv via the tool's own `toArgv`, runs it through the ONLY
 *      JS→engine gateway (`EngineClient.runPrometheus`), and folds the engine
 *      envelope (incl. its `forced_danger` block) into a `ToolOutcome` carrying the
 *      engine's nemesis verdict. Nothing here decides "safe" (C5) — it renders the
 *      verdict the engine produced.
 *
 *   3. `runMessageTurn(state, message, deps)` drives `runAgentTurn` for one user
 *      message, streams every `AgentEvent` to `deps.ctx.write` (so the host renders
 *      live), persists the turn via the shared session store
 *      (`createSession`/`appendTurn`/`serializeSession`), and returns the updated
 *      session + collected events + the assistant's final text.
 *
 * INVARIANTS (load-bearing, inherited from the loop and re-asserted here):
 *   - never-force: `confirm` DEFAULTS TO DENY; the agent may never emit --force
 *     (the loop blocks it; the runner double-strips it defensively).
 *   - crash-free: every turn is wrapped — an engine/LLM error renders a friendly
 *     line and the session continues; no raw stack ever reaches the transcript.
 *   - offline-first: if no endpoint is configured the runtime falls back to the
 *     engine's local chat (`chat --local`) for a plain reply, or — failing that —
 *     a clear, actionable message. It NEVER throws for "no model".
 *
 * PLAIN .ts — node built-ins + the injected seams only. No ink/react/.tsx. The host
 * (session/host.ts) owns readline; this module owns the agent wiring it calls.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
// The agent loop, session store, and the 14-tool catalog live under the `agent`
// and `mcpServer` NAMESPACES of @prometheus/core (see core/index.ts: `export * as
// agent` / `export * as mcpServer`). The provider-agnostic AI client stays FLAT at
// top-level (`createAiClient` + its types). We alias the namespace types we touch.
import { agent, ai, costOf, createAiClient, type mcpServer } from "@prometheus/core";
import type {
  AiClient,
  AiClientDeps,
  AiEndpoint,
  FetchLike,
  Msg,
  Pricing,
  SseTokenUsage,
  WorkspacePolicy,
} from "@prometheus/core";

import {
  type EngineClient,
  type SafeFetchOptions,
  type SafeFetchResult,
  safeFetch,
} from "@prometheus/engine-bridge";
import { hasMeteredConsent } from "../metered-consent.js";
// syntax highlighting for code inside the reasoning stream (Pelly scheme). Pure, self-contained.
import { CODE_STATE, detectLanguage, highlightLine, isHighlightable } from "../tui/highlight.js";
import { type ColorCaps, type Role, paint } from "../tui/palette.js";
// pure display-width helper (ANSI + wide-char aware); no TUI/presentation deps.
import { wrapLine } from "../tui/width.js";
import { type AccountingRecord, appendAccounting, readAccounting } from "./history-store.js";
// fail-closed read-scope guard for the session working set (CLI-004).
import { isPathAllowed, pathArgsOf } from "./working-set.js";

const {
  applyProposedEdit,
  parseHunksResult,
  verifyEdit,
  diagnoseFailedEdit,
  makeCheckpoint,
  restorePlan,
} = agent;
const { compact, shouldCompact, estimateTokens } = agent;
type Checkpoint = agent.Checkpoint;
type CheckpointStore = agent.CheckpointStore;
type SessionTurn = agent.SessionTurn;
type CompactPolicy = agent.CompactPolicy;
type Summarizer = agent.Summarizer;
type SessionEventBus = agent.SessionEventBus;

// --- type aliases for the namespaced agent/mcp types (used throughout) ------ //
type AgentEvent = agent.AgentEvent;
type AgentTuning = agent.AgentTuning;
type GateVerdictTier = agent.GateVerdictTier;
type LLMClient = agent.LLMClient;
type LlmTurn = agent.LlmTurn;
type Session = agent.Session;
type Thread = agent.Thread;
type ThreadMessage = agent.ThreadMessage;
type ToolCall = agent.ToolCall;
type ConfirmResult = agent.ConfirmResult;
type ToolOutcome = agent.ToolOutcome;
type ToolRunner = agent.ToolRunner;
type ToolDef = mcpServer.ToolDef;
type EffortCapability = ai.EffortCapability;
type EffortResolution = ai.EffortResolution;
const { applyEffort, applyEffortToMessages, resolveCapability, resolveEffort, runtimeFromBaseUrl } =
  ai;

// runtime fns off the namespace (re-bound locally for terse call sites).
const { appendTurn, createSession, runAgentTurn, serializeSession } = agent;

/**
 * PURE tool filter for the model's schema (CLI-018): global-off (tuning.tools.enabled
 * === false) → []; else drop denied tools (and, when an allow-list is set, keep only
 * allowed). This mirrors core exposedTools — the loop ALREADY applies this at the
 * single `_tools` seam via `tuning.tools`, so flipping tuning.tools.enabled/deny
 * disarms tools everywhere. NEVER mutate the shared registry (desktop shares the defs).
 */
export function effectiveTools(all: readonly ToolDef[], tuning: AgentTuning): ToolDef[] {
  const p = tuning.tools;
  if (!p.enabled) return [];
  return all.filter(
    (t) => !p.deny.includes(t.name) && (p.allow.length === 0 || p.allow.includes(t.name)),
  );
}

/* ── context breakdown (CLI-057) ─────────────────────────────────────────── */

/** The ONE chars→tokens estimator (identical to session-bridge's `usage()` + the CLI-052 meter):
 *  `Math.ceil(chars/4)`. English-prose heuristic — JSON/code tokenize denser, so keep the
 *  `(estimated, chars/4)` label honest; never imply precision. */
export function estTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/* ── CLI-088: token-economy runtime wiring (terse directive + prompt-caching) ─────── */

/** The terse/caveman OUTPUT directive injected as a system block when `terse-output` is enabled —
 *  bans preamble/hedging, prefers fragments, preserves code/errors/paths verbatim (id: terse-output). */
export function terseDirective(): string {
  return (
    "Output mode: TERSE. No preamble, no restating the question, no closing pleasantries, no " +
    "hedging. Prefer fragments + bullets. Preserve code, identifiers, errors, and file paths " +
    "VERBATIM. Answer first; explain only if asked."
  );
}

/** Which providers natively support prompt caching (input billed at a discount). */
export function providerSupportsPromptCaching(provider: string): boolean {
  return ["anthropic", "openai", "google", "gemini"].includes(provider.toLowerCase());
}

/** Should the request set the prompt-caching flag? Only when the toggle is on AND the active
 *  provider supports it (unsupported providers no-op — CLI-088 deliverable 4). */
export function shouldEnablePromptCaching(
  toggles: Record<string, boolean> | undefined,
  provider: string,
): boolean {
  return toggles?.["prompt-caching"] === true && providerSupportsPromptCaching(provider);
}

/** The extra SYSTEM blocks a session's token toggles inject into a turn (today: the terse directive
 *  when `terse-output` is enabled). Read once at session start; PURE + injected into runMessageTurn. */
export function tokenSystemBlocks(toggles: Record<string, boolean> | undefined): string[] {
  return toggles?.["terse-output"] === true ? [terseDirective()] : [];
}

/** One measured context component (a label + its raw char count). */
export interface ContextComponent {
  label: string;
  chars: number;
}

/** One rendered breakdown row: estimated tokens + percent-of-window (null when window unknown). */
export interface ContextRow {
  label: string;
  estTokens: number;
  pct: number | null;
}

/**
 * PURE context breakdown (CLI-057): turn measured components into est-token rows + an exact total.
 * The total is the SUM of integer row tokens (so "rows sum to total" holds exactly); the `pct`
 * column is display-only, derived from the summed tokens vs `window`. A missing/0/NaN/Infinite
 * window ⇒ every `pct` is null (the `% n/a` + no-warning path — fail-honest, never invented).
 */
export function contextBreakdown(
  parts: readonly ContextComponent[],
  window?: number,
): { rows: ContextRow[]; total: number; window?: number } {
  const w = window && Number.isFinite(window) && window > 0 ? window : undefined;
  const rows: ContextRow[] = parts.map((p) => {
    const estTokens = estTokensFromChars(Math.max(0, p.chars));
    return { label: p.label, estTokens, pct: w ? (estTokens * 100) / w : null };
  });
  const total = rows.reduce((n, r) => n + r.estTokens, 0);
  return { rows, total, ...(w ? { window: w } : {}) };
}

/* ── session usage + model-aware cost (CLI-058) ──────────────────────────── */

/** The `/stats` usage shape: in/out token split, whether it's estimated (chars/4) vs provider-
 *  reported, and the model-aware cost (`null` = unpriced model ⇒ n/a; `0` = local). `estTokens`/
 *  `estCostUsd` are kept for back-compat with existing consumers. */
export interface UsageStats {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estTokens: number;
  /** true when counts come from the chars/4 heuristic (no provider token frame). */
  estimated: boolean;
  /** model-aware cost: `null` ⇒ unknown model (render n/a), `0` ⇒ local, else USD. */
  cost: number | null;
  model: string;
  /** back-compat: `cost ?? 0` (older callers read a number). */
  estCostUsd: number;
}

/**
 * Compute session usage from the transcript (CLI-058): input = every non-assistant message,
 * output = assistant messages (chars/4 each — the honest estimate, flagged `estimated:true`);
 * cost via the model-aware pricing table (`costOf`: local ⇒ 0, unknown ⇒ null). Pure + shared by
 * BOTH the host and the TUI bridge so `/stats` reports one number everywhere.
 */
export function sessionUsage(
  history: readonly { role: string; content: unknown }[],
  modelProvider: string,
  modelId: string,
  isLocal: boolean,
  pricing: Pricing,
): UsageStats {
  let inChars = 0;
  let outChars = 0;
  for (const m of history) {
    const len = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
    if (m.role === "assistant") outChars += len;
    else inChars += len;
  }
  const inputTokens = estTokensFromChars(inChars);
  const outputTokens = estTokensFromChars(outChars);
  const cost = costOf({ inputTokens, outputTokens }, modelId, pricing, isLocal);
  return {
    turns: history.filter((m) => m.role === "user").length,
    inputTokens,
    outputTokens,
    estTokens: inputTokens + outputTokens,
    estimated: true, // chars/4 heuristic — no provider token frame is accumulated yet
    cost,
    model: `${modelProvider}:${modelId}`,
    estCostUsd: cost ?? 0,
  };
}

/* ------------------------------------------------------------------------- *
 * SessionCtx — the minimal shared shape every session/* unit threads.
 *
 * Defined HERE (and re-exported) so the host, slash-exec, command-exec, and
 * pane-render units all agree on one tiny context object. Deliberately small:
 * the engine client (the single gateway), the live tuning, the json flag, a
 * confirm fn (default = deny), and a write sink the host points at stdout.
 * ------------------------------------------------------------------------- */

/** The minimal context every in-session unit receives. */
export interface SessionCtx {
  /** the single JS→engine gateway (C5) — never spawn python elsewhere. */
  client: EngineClient;
  /** the live agent tuning (model/tools/gate/dryRun/yes) the session edits. */
  tuning: AgentTuning;
  /** the selected AI endpoint (from the Model Hub), or undefined when offline. */
  endpoint?: AiEndpoint;
  /** the per-workspace privacy policy (cloud refusal). Defaults to permissive. */
  policy?: WorkspacePolicy;
  /** --json mode: machine envelope to stdout, human text to stderr (host-owned). */
  json?: boolean;
  /** asked before a non-auto-approvable tool runs; DEFAULT = deny (never-force). A
   * rejection may carry a reason (propose_edit, CLI-010) → surfaced as a tool_result. */
  confirm?: (call: ToolCall) => ConfirmResult | Promise<ConfirmResult>;
  /** the host's render sink — receives ONE complete line WITHOUT a trailing newline
   * (the sink adds the break: writeLine/printAbove); tests capture it. */
  write: (text: string) => void;
  /** terminal columns for streamed word-wrap (CLI-003); undefined ⇒ pass-through. */
  width?: number;
  /** terminal color depth — enables Pelly syntax highlighting of code inside reasoning. */
  caps?: ColorCaps;
  /** resolved read-scope roots = [cwd, ...added dirs] (CLI-004). A path-scoped tool
   * touching anything outside is denied fail-closed. undefined ⇒ no path guard. */
  workingSet?: string[];
  /** the session working directory `propose_edit` paths resolve against (defaults to cwd). */
  cwd?: string;
  /** pre-image log for applied propose_edit calls (CLI-010) — the host owns it for revert. */
  editHistory?: EditRecord[];
  /** turn-atomic workspace checkpoints for /revert + /checkpoints (CLI-015). */
  checkpoint?: { store: CheckpointStore; sessionId: string };
  /** per-session token accounting sink (CLI-029): each turn's usage is persisted here. */
  accounting?: { home: string; sessionId: string };
  /** cost budget guardrail (CLI-030): evaluated before each METERED turn; local turns bypass. */
  budget?: BudgetGuard;
  /** metered-consent gate (CLI-031): set ONLY for a Tier-C api-key endpoint; the first call
   * refuses until `prometheus provider enable-metered <id>` mints the consent receipt. */
  metered?: { providerId: string; home: string };
  /** the built-in repo map (CLI-053): a getter returning the rendered file+symbol map to inject
   * as a dedicated system-context block, or null when OFF / not yet built. A getter (not a value)
   * so `/repomap on|off|refresh` toggles + rebuilds live without reconstructing the SessionCtx. */
  repoMap?: () => string | null;
  /** assembled AGENTS.md/CLAUDE.md/PROMETHEUS.md steering (CLI-061): a getter returning the rules
   * block to inject as a dedicated system-context block, or null/"" when none loaded. A getter so
   * `/memory edit`→reload re-assembles it for the NEXT turn without reconstructing the SessionCtx. */
  steering?: () => string | null;
  /** CLI-088: the token-economy toggles ({ [id]: boolean }) read ONCE at session start — `terse-output`
   *  injects a terse system block, `prompt-caching` sets the request flag on a capable provider. */
  tokenToggles?: Record<string, boolean>;
}

/**
 * The metered-consent gate (CLI-031): a Tier-C api-key turn is refused until the user has
 * run `enable-metered`. Not set (local/subscription) ⇒ no gate. Fail-closed: no receipt ⇒
 * block with the exact how-to instruction, BEFORE any network call.
 */
export function checkMeteredConsent(
  ctx: SessionCtx,
  has: (providerId: string, home: string) => boolean = hasMeteredConsent,
): { blocked: boolean; message?: string } {
  const m = ctx.metered;
  if (!m) return { blocked: false };
  if (has(m.providerId, m.home)) return { blocked: false };
  return {
    blocked: true,
    message: `metered provider "${m.providerId}" not enabled — run: prometheus provider enable-metered ${m.providerId}`,
  };
}

/** Session/daily USD budget guard (CLI-030). The warn-latch lives here (per window per session). */
export interface BudgetGuard {
  config: ai.BudgetConfig;
  /** model → per-MTok price (null/local ⇒ $0). */
  priceFor: ai.PriceFor;
  /** the per-run `--force-budget` flag — proceeds past a block. NEVER a profile key. */
  forceBudget?: boolean;
  /** fired-warn windows (mutated) so a warning prints exactly once per window per session. */
  warned: Set<string>;
}

export interface BudgetGateResult {
  action: "ok" | "warn" | "block";
  /** a rendered warn/block/force line for the host to print (absent when silent). */
  message?: string;
}

/**
 * The pre-turn cost gate (CLI-030). Fail-closed like nemesis: a metered turn over budget (or
 * an unreadable accounting store) BLOCKS unless `--force-budget`. A `locality:"local"` turn —
 * or no budget config — bypasses ENTIRELY (never reads the store, so a corrupt store never
 * blocks a free turn). Warns exactly once per window (latched in `ctx.budget.warned`).
 */
export function checkBudgetGate(
  ctx: SessionCtx,
  nowIso: string,
  readRecords: (home: string, sessionId: string) => AccountingRecord[] = readAccounting,
): BudgetGateResult {
  const b = ctx.budget;
  if (!b || !ctx.accounting || !ctx.endpoint || ctx.endpoint.locality === "local") {
    return { action: "ok" };
  }
  let decision: ai.BudgetDecision;
  try {
    const records = readRecords(ctx.accounting.home, ctx.accounting.sessionId);
    decision = ai.evaluateBudgets(records, b.config, nowIso, b.priceFor);
  } catch (e) {
    if (b.forceBudget) return { action: "ok" };
    return {
      action: "block",
      message: `budget check failed (fail-closed block): ${(e as Error).message}. Use --force-budget to override.`,
    };
  }
  if (decision.action === "block") {
    if (b.forceBudget) {
      return {
        action: "ok",
        message: `⚠ over ${decision.window} budget ($${decision.spentUsd.toFixed(2)}/$${decision.capUsd.toFixed(2)}) — proceeding (--force-budget)`,
      };
    }
    return {
      action: "block",
      message: `budget hard-stop — ${decision.reason}. Use --force-budget to override this run.`,
    };
  }
  if (decision.action === "warn") {
    const key = decision.window ?? "session";
    if (b.warned.has(key)) return { action: "ok" };
    b.warned.add(key);
    return { action: "warn", message: `⚠ ${decision.reason}` };
  }
  return { action: "ok" };
}

/* ------------------------------------------------------------------------- *
 * rebuildThread — reconstruct a resumable conversation from persisted turns
 * (CLI-013). Pure: no fs. Consumes the CLI-012 transcript event lines.
 * ------------------------------------------------------------------------- */

/** A repaint line for a restored transcript (the pane replays these). */
export interface RestoredLine {
  role: "you" | "prometheus" | "tool";
  text: string;
}

export interface RebuiltThread {
  /** user/assistant messages (NO system — runMessageTurn prepends tuning.systemPrompt). */
  messages: ThreadMessage[];
  /** lines to repaint in the pane, in order. */
  painted: RestoredLine[];
  /** how many oldest turns were elided to fit the context budget. */
  elided: number;
}

/** cheap token heuristic (~4 chars/token) — no tokenizer dep. */
const approxTokens = (s: string): number => Math.ceil(s.length / 4);

function summarizeToolLine(t: Record<string, unknown>): string {
  const kind = String(t.kind ?? "");
  if (kind === "tool_use") {
    const name = (t.call as { name?: string })?.name ?? "tool";
    return `● ${name}`;
  }
  if (kind === "tool_result") {
    const name = (t.call as { name?: string })?.name ?? "tool";
    return `  ⎿ ${name}: ${String(t.summary ?? "")}`;
  }
  if (kind === "verdict") return `  ⎿ ${String(t.tool ?? "")}: ${String(t.verdict ?? "")}`;
  if (kind === "blocked") return `● blocked: ${String(t.reason ?? "")}`;
  return `● ${kind}`;
}

/**
 * Rebuild `ThreadMessage[]` + repaint lines from persisted transcript turns. Merges
 * consecutive same-role text (Anthropic 400s on two same-role turns in a row / a
 * leading assistant turn), folds tool events into the assistant's context (+ dim
 * repaint lines), and caps to a token budget dropping OLDEST first (always keeping the
 * most recent user turn), reporting the elided count.
 */
export function rebuildThread(
  turns: readonly Record<string, unknown>[],
  opts: { maxTokens?: number } = {},
): RebuiltThread {
  const maxTokens = opts.maxTokens ?? 6000;
  const messages: ThreadMessage[] = [];
  const painted: RestoredLine[] = [];
  let asstBuf = ""; // concatenates assistant text deltas + folded tool notes

  const flushAsst = (): void => {
    if (asstBuf) {
      messages.push({ role: "assistant", content: asstBuf });
      asstBuf = "";
    }
  };

  for (const t of turns) {
    if (t.role === "user") {
      flushAsst();
      const text = String(t.text ?? "");
      const prev = messages.at(-1);
      if (prev?.role === "user")
        prev.content += `\n${text}`; // merge adjacent same-role
      else messages.push({ role: "user", content: text });
      painted.push({ role: "you", text });
    } else if (t.kind === "text") {
      asstBuf += String(t.text ?? "");
    } else if (
      t.kind === "tool_use" ||
      t.kind === "tool_result" ||
      t.kind === "verdict" ||
      t.kind === "blocked"
    ) {
      const line = summarizeToolLine(t);
      painted.push({ role: "tool", text: line });
      asstBuf += `\n[${line.trim()}]`;
    }
    // a "done" event carries no content — ignored.
  }
  flushAsst();
  // an assistant flush may have produced consecutive assistant entries after a merge —
  // merge them so roles strictly alternate.
  const alt: ThreadMessage[] = [];
  for (const m of messages) {
    const prev = alt.at(-1);
    if (prev && prev.role === m.role) prev.content += `\n${m.content}`;
    else alt.push({ ...m });
  }

  // context budget: drop OLDEST first, but always keep the most recent user turn.
  let elided = 0;
  let total = alt.reduce((a, m) => a + approxTokens(m.content), 0);
  while (total > maxTokens && alt.length > 1) {
    const dropped = alt.shift() as ThreadMessage;
    total -= approxTokens(dropped.content);
    elided++;
  }
  // a leading assistant turn is invalid — drop it (its user context was elided).
  while (alt.length > 0 && alt[0]?.role === "assistant") {
    alt.shift();
    elided++;
  }
  return { messages: alt, painted, elided };
}

/* ------------------------------------------------------------------------- *
 * context compaction (CLI-016) — wraps the PURE core agent/compact.ts.
 * core compact() operates on SessionTurn[]; the CLI compacts session.turns and
 * REBUILDS the ThreadMessage history the model sees from the result.
 * ------------------------------------------------------------------------- */

function assistantTextOf(t: SessionTurn): string {
  return t.events
    .filter((e) => e.kind === "text")
    .map((e) => (e as { text: string }).text)
    .join("");
}

/** A DETERMINISTIC extractive summary of older turns (the offline fallback). */
export function extractiveSummary(older: readonly SessionTurn[], maxChars = 2000): string {
  const parts = older.map((t) => {
    const a = assistantTextOf(t);
    return `- ${t.prompt}${a ? ` → ${a.slice(0, 240)}` : ""}`;
  });
  const s = parts.join("\n");
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** Rebuild the model's ThreadMessage history from (possibly compacted) turns. */
export function turnsToHistory(turns: readonly SessionTurn[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const t of turns) {
    const asst = assistantTextOf(t);
    if (t.prompt === "[compacted history]") {
      // the synthetic summary turn → ONE assistant message marked [summary] (distinct in /export).
      out.push({ role: "assistant", content: `[summary] ${asst}` });
      continue;
    }
    out.push({ role: "user", content: t.prompt });
    if (asst) out.push({ role: "assistant", content: asst });
  }
  return out;
}

/**
 * A summarizer over the SAME model adapter as normal turns (no second transport;
 * summaries need no tools → []). When no endpoint/llm is available, fall back to a
 * reproducible extractive summary (tests assert a stated fact survives that path).
 */
export function makeSummarizer(
  ctx: SessionCtx,
  deps: { llm?: LLMClient } = {},
): { summarize: Summarizer; offline: boolean } {
  const llm =
    deps.llm ??
    (ctx.endpoint
      ? makeLlmClient(ctx.endpoint, ctx.policy ? { policy: ctx.policy } : {})
      : undefined);
  if (!llm) {
    return {
      offline: true,
      summarize: async (older) => `(offline summary)\n${extractiveSummary(older)}`,
    };
  }
  return {
    offline: false,
    summarize: async (older) => {
      const thread: Thread = {
        messages: [
          {
            role: "system",
            content:
              "You compress a conversation into a concise summary, preserving key facts, decisions, and file paths.",
          },
          {
            role: "user",
            content: `Summarize this conversation:\n${extractiveSummary(older, 8000)}`,
          },
        ],
      };
      let text = "";
      try {
        for await (const turn of llm.turn(thread, ctx.tuning, [])) {
          if (turn.kind === "text") text += turn.text;
        }
      } catch {
        /* model error → deterministic fallback below */
      }
      return text.trim() || `(summary)\n${extractiveSummary(older)}`;
    },
  };
}

/** Build an auto-compact policy from a threshold %; null (disabled) when pct ≤ 0. */
export function autoCompactPolicy(
  thresholdPct: number,
  contextWindow: number,
  keepRecentTurns = 4,
): CompactPolicy | null {
  if (thresholdPct <= 0) return null; // 0 disables the auto-check entirely
  return {
    maxTokens: Math.max(1, Math.floor((contextWindow * thresholdPct) / 100)),
    keepRecentTurns,
  };
}

/** True when the session's turns exceed the (enabled) auto-compact policy. */
export function shouldAutoCompact(session: Session, policy: CompactPolicy | null): boolean {
  return policy !== null && shouldCompact(session.turns, policy);
}

/**
 * Compact a session's older turns into one summary turn + rebuild the model history.
 * Returns the new session + history + a notice reporting approximate tokens reclaimed.
 * Fail-soft (a summarizer error keeps the transcript intact, per core compact()).
 */
export async function compactSession(
  sessionId: string,
  session: Session,
  policy: CompactPolicy,
  summarize: Summarizer,
  now: string,
  opts: { offline?: boolean; bus?: SessionEventBus } = {},
): Promise<{ session: Session; history: ThreadMessage[]; notice: string; compacted: boolean }> {
  const before = estimateTokens(session.turns);
  const result = await compact(sessionId, session.turns, policy, summarize, now, opts.bus);
  const history = turnsToHistory(result.turns);
  if (!result.compacted) {
    return {
      session,
      history,
      notice: result.error ? `⎿ compact failed: ${result.error}` : "⎿ nothing to compact yet",
      compacted: false,
    };
  }
  const reclaimed = Math.max(0, before - estimateTokens(result.turns));
  const tag = opts.offline ? " (offline summary)" : "";
  return {
    session: { ...session, turns: result.turns },
    history,
    notice: `⎿ compacted: ~${reclaimed} tokens reclaimed (${session.turns.length} turns → ${result.turns.length})${tag}`,
    compacted: true,
  };
}

/** A kept pre-image for one applied `propose_edit`, enabling revert (CLI-010). */
export interface EditRecord {
  /** the absolute file path that was edited. */
  path: string;
  /** the file's exact bytes BEFORE the edit. */
  preImage: string;
}

/** Construction seams for the AI client (injected in tests; defaults use global fetch). */
export interface LlmClientDeps extends AiClientDeps {
  /** the per-workspace privacy policy; defaults to permissive (local-first). */
  policy?: WorkspacePolicy;
  /** abort the in-flight SSE request + stop yielding deltas (Ctrl-C, CLI-002). */
  signal?: AbortSignal;
  /** per-turn token accounting sink (CLI-029): fed the SSE `usage`, else a chars/4 estimate. */
  onUsage?: (rec: AccountingRecord) => void;
  /** A probe-backed effort capability (e.g. from Ollama's /api/show `capabilities`). When
   *  omitted the client falls back to matching the model NAME, which is strictly worse —
   *  Gemma 3 and Gemma 4 differ on this within one family. */
  effortCapability?: EffortCapability;
  /** clock for the accounting timestamp (injected in tests). */
  now?: () => string;
}

/** An aborted `fetch` rejects with a DOMException `name === "AbortError"` (code 20). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/* ------------------------------------------------------------------------- *
 * makeLlmClient — adapt the SSE text stream → the agent loop's LLMClient
 * ------------------------------------------------------------------------- */

/** Map an agent `Thread` (system|user|assistant|tool) to the AI client's `Msg[]`. */
function threadToMessages(thread: Thread): Msg[] {
  return thread.messages.map((m: ThreadMessage): Msg => ({ role: m.role, content: m.content }));
}

/** Map the agent's `ToolDef`s → OpenAI function-tool schemas so a tool-capable local model
 *  (ollama/lmstudio) can emit NATIVE tool_calls. `ToolSchema` is Record<field, FieldSpec>. */
function toOpenAiTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [field, spec] of Object.entries(t.schema)) {
      const s = spec as { type?: string; required?: boolean; description?: string };
      properties[field] = {
        type: s.type ?? "string",
        ...(s.description ? { description: s.description } : {}),
      };
      if (s.required) required.push(field);
    }
    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: "object", properties, required },
      },
    };
  });
}

/**
 * Fire-and-forget: pre-load a LOCAL model into memory at session start so the FIRST real
 * prompt is warm (no multi-second cold RELOAD). Sends a 1-token request with `keep_alive`
 * to pin the model resident. Never throws, never blocks the session — a down/absent runner
 * just means the first prompt loads cold, exactly as before. Local endpoints only (never a
 * cloud request, never a non-standard field to a non-Ollama endpoint).
 */
export function warmupLocalModel(endpoint: AiEndpoint | undefined): void {
  if (!endpoint || endpoint.locality !== "local") return;
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  const url = /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
    body: JSON.stringify({
      model: endpoint.model ?? endpoint.id,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
      keep_alive: "30m",
    }),
  }).catch(() => {
    /* best-effort: a down/absent runner just means the first prompt loads cold */
  });
}

/** One tool call being reassembled from OpenAI streaming deltas (name once, args in fragments). */
interface ToolCallAccum {
  name: string;
  args: string;
}

/** The tool-call-capable transport (CLI-*): send the agent's tools and STREAM the
 *  OpenAI-compatible SSE so text tokens surface immediately (no wait for the whole
 *  completion) while native `tool_calls` are reassembled from their delta fragments.
 *  Yields text deltas live, then one `{kind:"tool_call"}` per completed call, then final.
 *  The agent loop routes each call through the §4.3 broker (permission prompt / gate) and
 *  applies it — so `propose_edit`/`write_file` land on disk ONLY after the human approves. */
async function* toolTurn(
  endpoint: AiEndpoint,
  messages: Msg[],
  tools: ToolDef[],
  policy: WorkspacePolicy,
  signal?: AbortSignal,
  effort?: EffortResolution,
  // The injected fetch seam `createAiClient` already honors. Without it this transport —
  // the one nearly every agentic turn takes — could not be intercepted by a test at all.
  doFetch: FetchLike = fetch,
): AsyncIterable<LlmTurn> {
  if (policy.neverSendToCloud && endpoint.locality === "cloud") {
    yield { kind: "text", text: "cloud endpoint refused (workspace never-send-to-cloud is on)" };
    yield { kind: "final" };
    return;
  }
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  const url = /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const model = endpoint.model ?? endpoint.id;
  // accumulate tool-call fragments by their stream index (args arrive in pieces).
  const calls = new Map<number, ToolCallAccum>();
  // progress watchdog: a large local model can take 30–90s to START (cold prefill/reload).
  // Without a heartbeat the user can't tell a slow MODEL from a hung WRAPPER — so we emit a
  // status every FIRST_TOKEN_TICK until the first byte, and hard-abort after HARD_TIMEOUT.
  const FIRST_TOKEN_TICK_MS = 8_000;
  const STREAM_IDLE_TICK_MS = 15_000;
  const HARD_TIMEOUT_MS = 180_000;
  // our own controller so a HARD TIMEOUT (or the user's Ctrl-C) cancels the fetch + reader.
  const ac = new AbortController();
  const onUserAbort = (): void => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onUserAbort, { once: true });
  }
  const startMs = Date.now();
  const hardTimer = setTimeout(() => ac.abort(), HARD_TIMEOUT_MS);
  try {
    yield { kind: "status", text: `→ ${model}: sending request…` };
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer local",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(
        applyEffort(
          {
            model,
            // Our tool results are already human-readable (`[tool_result …]`) and carry no
            // OpenAI `tool_call_id` linkage; send them as plain `user` context so a strict
            // endpoint never rejects an unpaired `role:"tool"` message on the follow-up round.
            messages: applyEffortToMessages(messages, effort).map((m) => ({
              role: m.role === "tool" ? "user" : m.role,
              content: m.content,
            })),
            tools: toOpenAiTools(tools),
            tool_choice: "auto",
            stream: true,
            // Ollama extension (ignored by other endpoints): keep the model resident 30m so a
            // second prompt doesn't pay the multi-second cold RELOAD. Only for LOCAL runners —
            // never send a non-standard field to a cloud endpoint.
            ...(endpoint.locality === "local" ? { keep_alive: "30m" } : {}),
          },
          // Same discipline as `keep_alive` above: a field goes on the wire only when THIS
          // model is known to accept it. A knobless model gets nothing rather than a 400.
          effort,
        ),
      ),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      yield { kind: "text", text: `model error: HTTP ${res.status} ${res.statusText}` };
      yield { kind: "final" };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    let firstByte = false;
    // hold ONE in-flight read across watchdog ticks (calling read() twice concurrently throws).
    let pendingRead = reader.read();
    while (!done) {
      if (signal?.aborted || ac.signal.aborted) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<"TICK">((r) => {
        timer = setTimeout(() => r("TICK"), firstByte ? STREAM_IDLE_TICK_MS : FIRST_TOKEN_TICK_MS);
      });
      const raced = await Promise.race([pendingRead, tick]);
      if (timer) clearTimeout(timer);
      if (raced === "TICK") {
        // no byte within the tick window — tell the user it's the MODEL we're waiting on.
        const s = Math.round((Date.now() - startMs) / 1000);
        yield {
          kind: "status",
          text: firstByte
            ? `▼ ${model} still generating… (${s}s)`
            : `⏳ waiting for ${model} — no output yet (${s}s). A large local model can take 30–90s to start.`,
        };
        continue; // pendingRead is still pending — re-race it next iteration
      }
      const { value, done: streamDone } = raced;
      if (streamDone) break;
      if (!firstByte) {
        firstByte = true;
        yield { kind: "status", text: `▼ ${model}: responding…` };
      }
      buf += decoder.decode(value, { stream: true });
      // SSE frames are newline-delimited `data: <json>` lines; process whole lines only.
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          done = true;
          break;
        }
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              // reasoning models stream thinking here (content stays empty meanwhile);
              // Ollama uses `reasoning`, some servers `reasoning_content`.
              reasoning?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{
                index?: number;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // a partial/keepalive frame — skip
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (reasoning) yield { kind: "reasoning", text: reasoning };
        if (delta.content) yield { kind: "text", text: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = calls.get(idx) ?? { name: "", args: "" };
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          calls.set(idx, acc);
        }
      }
      pendingRead = reader.read(); // queue the next chunk
    }
    // emit each fully-reassembled tool call (ordered by stream index).
    for (const [, acc] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(acc.args || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      yield { kind: "tool_call", call: { name: acc.name as agent.ToolCall["name"], args } };
    }
  } catch (err) {
    // our HARD TIMEOUT aborted the fetch (ac aborted but NOT via the user's Ctrl-C).
    if (ac.signal.aborted && !signal?.aborted) {
      const s = Math.round((Date.now() - startMs) / 1000);
      yield {
        kind: "status",
        text: `✗ ${model} timed out after ${s}s with no complete response — aborting this turn. Try a smaller model via /setup, or check the local runner.`,
      };
    } else if (!(isAbortError(err) || signal?.aborted)) {
      yield {
        kind: "text",
        text: `model error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } finally {
    clearTimeout(hardTimer);
    if (signal) signal.removeEventListener("abort", onUserAbort);
  }
  yield { kind: "final" };
}

/**
 * Build the agent loop's `LLMClient` from a Model-Hub endpoint.
 *
 * It streams the endpoint's OpenAI-compatible SSE chat response as `LlmTurn`
 * text deltas, then yields exactly one `{kind:"final"}` to close the turn. The
 * core `createAiClient` enforces the cloud-policy guard BEFORE any request leaves
 * the machine; we surface a refusal as an honest text turn rather than a throw,
 * so a single bad endpoint never crashes the session.
 *
 * Tool calls: the OpenAI SSE the core client parses is TEXT-ONLY (it extracts
 * `choices[].delta.content`), so this adapter cannot synthesise a structured tool
 * call from it. We therefore stay text-only regardless — and when the host wants
 * tools it must supply a tool-call-capable transport. `endpoint.supportsTools`
 * gates *whether tools are even offered*; this adapter never fabricates one.
 */
export function makeLlmClient(endpoint: AiEndpoint, deps: LlmClientDeps = {}): LLMClient {
  const policy: WorkspacePolicy = deps.policy ?? { neverSendToCloud: false };
  const { policy: _omit, signal, ...aiDeps } = deps;
  const client: AiClient = createAiClient(endpoint, policy, aiDeps);

  // The model's effort capability is a property of the endpoint, so resolve it once here and
  // only the TIER varies per turn. `deps.effortCapability` lets the host pass a probe-backed
  // capability (Ollama /api/show) instead of the name-matched guess.
  const capability: EffortCapability =
    deps.effortCapability ??
    resolveCapability({
      modelId: endpoint.model ?? endpoint.id,
      runtime: runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
      locality: endpoint.locality,
    }).cap;

  return {
    async *turn(thread: Thread, tuning: AgentTuning, tools: ToolDef[]): AsyncIterable<LlmTurn> {
      const messages = threadToMessages(thread);
      // The `/think` tier finally reaches the wire (it was stored and discarded here before).
      // `resolveEffort` returns null-applied for a model with no knob, and `applyEffort`
      // then adds nothing — so an unsupported model is a no-op, never a 400.
      const effort = tuning.effort ? resolveEffort(tuning.effort, capability) : undefined;
      // Tool-capable transport: when the agent offers tools AND the model supports them, use a
      // non-streaming request so a capable local model returns native tool_calls (which the
      // text-only SSE below never carries). This is what lets Prometheus ACT — create/edit
      // files, run gated verbs — instead of only describing.
      if (tools.length > 0 && endpoint.supportsTools) {
        yield* toolTurn(endpoint, messages, tools, policy, signal, effort, deps.fetch);
        return;
      }
      let any = false;
      let usage: SseTokenUsage | undefined;
      let received = "";
      try {
        // thread the signal so fetch() aborts AND the SSE reader is cancelled — a bare
        // fetch abort still lets the parser drain buffered bytes (post-abort deltas).
        for await (const chunk of client.chat(messages, {
          ...(signal ? { signal } : {}),
          ...(effort ? { effort } : {}),
        })) {
          if (signal?.aborted) break; // stop yielding the instant Ctrl-C fires
          if (chunk.delta) {
            any = true;
            received += chunk.delta;
            yield { kind: "text", text: chunk.delta };
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.done) break;
        }
      } catch (err) {
        // abort is NOT an error: swallow it into the interrupted path (never retry —
        // an AbortError counting toward resilience would silently re-request).
        if (isAbortError(err) || signal?.aborted) {
          // intentionally silent
        } else {
          // a refused/unreachable endpoint becomes an honest text turn, not a crash.
          const message = err instanceof Error ? err.message : String(err);
          if (!any) yield { kind: "text", text: `model error: ${message}` };
        }
      }
      // CLI-029 accounting: SSE usage is exact; otherwise chars/4 over the EXACT text
      // actually sent + received, flagged estimated (a spend floor for budget math).
      if (deps.onUsage) {
        const nowIso = (deps.now ?? (() => new Date().toISOString()))();
        const rec: AccountingRecord = usage
          ? {
              model: endpoint.model ?? endpoint.id,
              endpointId: endpoint.id,
              promptTokens: usage.inputTokens,
              completionTokens: usage.outputTokens,
              estimated: false,
              atIso: nowIso,
              // prompt-cache counters (CLI-090) — only when the provider reported them (undefined
              // ⇒ omitted ⇒ report shows "not available for this provider", not a misleading 0).
              ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
              ...(usage.cacheCreate !== undefined ? { cacheCreate: usage.cacheCreate } : {}),
            }
          : {
              model: endpoint.model ?? endpoint.id,
              endpointId: endpoint.id,
              promptTokens: approxTokens(messages.map((m) => m.content).join("\n")),
              completionTokens: approxTokens(received),
              estimated: true,
              atIso: nowIso,
            };
        deps.onUsage(rec);
      }
      yield { kind: "final" };
    },
  };
}

/* ------------------------------------------------------------------------- *
 * makeToolRunner — run a broker-approved ToolDef through the engine bridge
 * ------------------------------------------------------------------------- */

/** Coerce the engine envelope's verdict tier (if any) into the loop's shape. */
function verdictFromEnvelope(env: Record<string, unknown>): ToolOutcome["verdict"] {
  // forced_danger present ⇒ a nemesis BLOCK/error was overridden (ok:false too).
  const forced = env.forced_danger;
  if (Array.isArray(forced) && forced.length > 0) {
    const tier = (forced[0] as { verdict?: string }).verdict;
    const v: GateVerdictTier = tier === "error" ? "error" : "block";
    const risk = (forced[0] as { risk_score?: number }).risk_score;
    return typeof risk === "number" ? { verdict: v, riskScore: risk } : { verdict: v };
  }
  // a verdict envelope (gate/scan path) carries its own tier + risk_score.
  const verdict = env.verdict;
  if (verdict && typeof verdict === "object") {
    const tier = (verdict as { verdict?: string }).verdict;
    if (tier === "allow" || tier === "warn" || tier === "block" || tier === "error") {
      const risk = (verdict as { risk_score?: number }).risk_score;
      return typeof risk === "number" ? { verdict: tier, riskScore: risk } : { verdict: tier };
    }
  }
  return undefined;
}

/** A short, human one-liner summarising an engine envelope outcome. */
function summarizeEnvelope(name: string, env: Record<string, unknown>): string {
  if (typeof env.error === "string" && env.error) return env.error;
  const command = typeof env.command === "string" ? env.command : name;
  return env.ok === false ? `${command}: failed` : `${command}: ok`;
}

/**
 * Build the agent loop's `ToolRunner` over the engine bridge.
 *
 * The loop hands us an (already broker-approved, already --force-stripped) ToolDef
 * + args. We map them to a prometheus.py argv via the tool's OWN `toArgv` (the
 * single source of the CLI mapping — never re-derived), run it through the ONLY
 * gateway, and fold the envelope into a `ToolOutcome`. The engine runs nemesis
 * itself; we surface the verdict it produced (C5 — no JS-side scoring).
 */
/** Rename `tmp`→`path`, retrying a few times so a transient Windows AV/indexer EPERM/EBUSY hold
 *  doesn't fail an otherwise-valid edit. POSIX rename is atomic and never needs the retries. */
function renameWithRetry(tmp: string, path: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, path); // atomic on same-filesystem POSIX; overwrites on Windows
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    rmSync(tmp, { force: true }); // don't leave a stray temp behind on a hard failure
  } catch {
    /* best-effort cleanup */
  }
  throw lastErr;
}

/**
 * Atomic, durable file write preserving the original mode: refuse a symlinked target
 * (O_NOFOLLOW spirit — a classic in-workspace escape vector), same-dir temp + fsync +
 * chmod + atomic rename, then fsync the PARENT DIR so the rename survives a crash (POSIX).
 * The path-guard (isPathAllowed) already realpath-canonicalizes the DIRECTORY, so this only
 * has to refuse the final component being a link.
 */
function atomicWrite(path: string, next: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to write through a symlink: ${path}`);
    }
  } catch (err) {
    // rethrow our refusal; a missing file (new-file write / revert) is fine — proceed.
    if (err instanceof Error && err.message.startsWith("refusing to write through a symlink")) {
      throw err;
    }
  }
  const dir = dirname(path);
  const tmp = join(dir, `.prom-edit.${process.pid}.${Date.now().toString(36)}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, next);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, statSync(path).mode); // a fresh temp is 0600 — restore original bits (+x scripts)
  } catch {
    /* mode read/set best-effort; the rename still lands the content */
  }
  renameWithRetry(tmp, path);
  try {
    const dfd = openSync(dir, "r"); // fsync the directory so the rename is durable across a crash
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* dir fsync is best-effort (Windows can't fsync a directory handle) */
  }
}

/**
 * Apply a `propose_edit` call to a LOCAL file (CLI-010). Path-guarded (resolve within
 * the working set, refuse option-shaped/escaping paths), exact-unique-match via the
 * pure core applier, atomic write preserving mode. Returns the outcome + a pre-image
 * for revert. NEVER throws.
 */
function applyLocalEdit(
  args: Record<string, unknown>,
  roots: string[] | undefined,
  cwd: string,
): { outcome: ToolOutcome; record?: EditRecord } {
  const rawPath = typeof args.path === "string" ? args.path : "";
  if (!rawPath || rawPath.startsWith("-")) {
    return { outcome: { ok: false, summary: `propose_edit: refusing invalid path: ${rawPath}` } };
  }
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  // fail-closed: an edit must land inside the working set (mirrors CLI-004 add-dir rules).
  if (roots && roots.length > 0 && !isPathAllowed(abs, roots)) {
    return {
      outcome: { ok: false, summary: `propose_edit: path outside the working set: ${rawPath}` },
    };
  }
  // parse + reject a malformed / partially-dropped hunks arg (a silent partial apply is a bug).
  const parsed = parseHunksResult(args.hunks);
  if (parsed.malformed) {
    return {
      outcome: { ok: false, summary: "propose_edit: hunks must be an array of {old,new} strings" },
    };
  }
  if (parsed.hunks.length === 0) {
    return { outcome: { ok: false, summary: "propose_edit: no hunks to apply" } };
  }
  if (parsed.dropped > 0) {
    return {
      outcome: {
        ok: false,
        summary: `propose_edit: ${parsed.dropped} hunk(s) malformed (each needs string old+new) — nothing applied`,
      },
    };
  }
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return { outcome: { ok: false, summary: `propose_edit: cannot read ${rawPath}` } };
  }
  // fallback ladder ON: recover whitespace/indent drift deterministically (unique-or-ambiguous).
  const res = applyProposedEdit(content, parsed.hunks, { fallback: true });
  if (!res.ok) {
    // turn the typed failure into a copy-pasteable retry hint so the model self-corrects next round.
    let hint = res.message;
    const failing = parsed.hunks[res.hunk];
    if (failing && res.code !== "empty") {
      const d = diagnoseFailedEdit(
        content.replace(/\r\n/g, "\n"),
        failing.old.replace(/\r\n/g, "\n"),
        res.code,
      );
      hint = `${res.message}. ${d.message}`;
      if (d.correctedOld) hint += `\n--- exact text to use as \`old\` ---\n${d.correctedOld}`;
    }
    return { outcome: { ok: false, summary: `propose_edit: ${hint}` } };
  }
  // post-apply verify (free rollback — nothing written yet): block a splice that drops a bracket.
  const verdict = verifyEdit(content, res.next);
  if (!verdict.ok) {
    return {
      outcome: {
        ok: false,
        summary: `propose_edit: rejected — ${verdict.reason}; no change written. Re-check the edit.`,
      },
    };
  }
  try {
    atomicWrite(abs, res.next);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { outcome: { ok: false, summary: `propose_edit: write failed: ${detail}` } };
  }
  // note which rungs beyond exact fired, so an operator can see when drift was recovered.
  const recovered = [...new Set(res.rungs.filter((r) => r !== "exact"))];
  const via = recovered.length > 0 ? ` [recovered via ${recovered.join(", ")}]` : "";
  return {
    outcome: { ok: true, summary: `edited ${rawPath} (${res.applied} hunk(s))${via}` },
    record: { path: abs, preImage: content },
  };
}

/**
 * Apply a `write_file` call to a LOCAL file: CREATE a new file or OVERWRITE an existing one
 * with exact content. Path-guarded (resolve within the working set), parent dirs created,
 * atomic write, pre-image kept for revert (empty string when the file is newly created).
 * Mirrors applyLocalEdit's guards; this is the "author a brand-new file" path. Never throws.
 */
function applyWriteFile(
  args: Record<string, unknown>,
  roots: string[] | undefined,
  cwd: string,
  approvedOutside?: ReadonlySet<string>,
): { outcome: ToolOutcome; record?: EditRecord } {
  const rawPath = typeof args.path === "string" ? args.path : "";
  if (!rawPath || rawPath.startsWith("-")) {
    return { outcome: { ok: false, summary: `write_file: refusing invalid path: ${rawPath}` } };
  }
  if (typeof args.content !== "string") {
    return { outcome: { ok: false, summary: "write_file: content must be a string" } };
  }
  const content = args.content;
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  // Working-set boundary (defense in depth). `write_file` is the one applier with no scope guard
  // of its own — the human confirm IS its authorization — so this checks that an OUT-OF-SCOPE
  // target really did pass a confirm seam for THIS exact path (`approvedOutside`, recorded by
  // runMessageTurn when the call was approved). In-scope writes are untouched, so the legitimate
  // `~/hello.py`-while-cwd-is-the-repo case still works: the confirm layer asks, the human says
  // yes, the path lands in the set, and the write proceeds. Without an approval seam wired up
  // (a bare makeToolRunner) an out-of-scope write is refused rather than silently applied.
  if (roots && roots.length > 0 && !isPathAllowed(abs, roots) && !approvedOutside?.has(abs)) {
    return {
      outcome: {
        ok: false,
        summary: `write_file: path outside the working set (not approved): ${rawPath}`,
      },
    };
  }
  // capture the pre-image (for revert): existing content, or "" when the file is new.
  let preImage = "";
  let existed = false;
  try {
    preImage = readFileSync(abs, "utf8");
    existed = true;
  } catch {
    preImage = "";
  }
  // a new file may name directories that don't exist yet — create the parent chain.
  try {
    mkdirSync(dirname(abs), { recursive: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { outcome: { ok: false, summary: `write_file: cannot create directory: ${detail}` } };
  }
  try {
    atomicWrite(abs, content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { outcome: { ok: false, summary: `write_file: write failed: ${detail}` } };
  }
  const verb = existed ? "overwrote" : "created";
  const lines = content.length === 0 ? 0 : content.split("\n").length;
  return {
    outcome: { ok: true, summary: `${verb} ${rawPath} (${lines} line${lines === 1 ? "" : "s"})` },
    record: { path: abs, preImage },
  };
}

/** Restore a kept pre-image (revertLastEdit). Returns true on success. */
export function revertEdit(record: EditRecord): boolean {
  try {
    atomicWrite(record.path, record.preImage);
    return true;
  } catch {
    return false;
  }
}

/** The outcome of applying one extracted edit block (for the `/apply` command). */
export interface ApplyIntentOutcome {
  path: string;
  ok: boolean;
  summary: string;
}

/**
 * Apply edit intents parsed out of raw model text (extractEditIntents) to disk, reusing the SAME
 * path-guarded, fallback-laddered, verify-gated, atomic applier as `propose_edit` (applyLocalEdit).
 * Powers `/apply` — the "the model wrote the edits as prose, put them on disk" path. Never throws.
 */
export function applyEditIntentsLocal(
  intents: readonly agent.EditIntent[],
  roots: string[] | undefined,
  cwd: string,
): ApplyIntentOutcome[] {
  const out: ApplyIntentOutcome[] = [];
  for (const intent of intents) {
    if (!intent.path) {
      out.push({ path: "(no path)", ok: false, summary: "edit block had no target file path" });
      continue;
    }
    const { outcome } = applyLocalEdit({ path: intent.path, hunks: intent.hunks }, roots, cwd);
    out.push({ path: intent.path, ok: outcome.ok, summary: outcome.summary });
  }
  return out;
}

/** The per-turn checkpoint accumulation hook passed to the tool runner (CLI-015). */
export interface CheckpointHook {
  store: CheckpointStore;
  turnId: string;
  sessionId: string;
  turnNumber: number;
  now: () => string;
}

/** Fold a first-touch pre-image into this turn's checkpoint (turn-atomic grouping). */
function captureIntoCheckpoint(hook: CheckpointHook, path: string, preImage: string): void {
  const existing = hook.store.get(hook.turnId);
  const files = existing ? { ...existing.files } : {};
  if (path in files) return; // FIRST-touch only — keep the truly pre-turn content
  files[path] = preImage;
  hook.store.record(
    makeCheckpoint(
      hook.turnId,
      hook.sessionId,
      hook.turnNumber,
      hook.now(),
      files,
      {},
      `turn ${hook.turnNumber}`,
    ),
  );
}

/**
 * Restore a checkpoint's captured files (rewriting pre-images, deleting files created
 * after the snapshot). Path-guarded within `roots` (a checkpoint must never become an
 * arbitrary-write primitive); atomic writes preserve mode. Never throws.
 */
export function restoreCheckpoint(
  cp: Checkpoint,
  opts: { roots?: string[]; currentPaths?: string[] } = {},
): { restored: string[]; deleted: string[] } {
  const plan = restorePlan(cp, opts.currentPaths ?? Object.keys(cp.files));
  const allowed = (p: string): boolean =>
    !opts.roots || opts.roots.length === 0 || isPathAllowed(p, opts.roots);
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const [path, content] of Object.entries(plan.write)) {
    if (!allowed(path)) continue;
    try {
      atomicWrite(path, content);
      restored.push(path);
    } catch {
      /* skip an un-writable path, restore the rest */
    }
  }
  for (const path of plan.delete) {
    if (!allowed(path)) continue;
    try {
      rmSync(path);
      deleted.push(path);
    } catch {
      /* already gone / un-removable */
    }
  }
  return { restored, deleted };
}

/** The URL-fetch seam (default = engine-bridge safeFetch); injected in tests. CLI-011. */
export type FetchImpl = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;

const WEB_FETCH_MAX_BYTES = 200 * 1024; // ~200 KiB
const WEB_FETCH_TIMEOUT_SEC = 20;

/** Cap a string to `maxBytes` UTF-8 bytes on a codepoint boundary (no  tail). */
function capUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { text: s, truncated: false };
  const sliced = Buffer.from(s, "utf8").subarray(0, maxBytes);
  let text = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  if (text.endsWith("�")) text = text.slice(0, -1); // drop a half-cut codepoint
  return { text, truncated: true };
}

/**
 * Dispatch `web_fetch` through the fail-closed safeFetch L6 proxy (CLI-011). NEVER
 * touches global fetch. Fail-closed: a throw, a blocked/`verdict:"block"` result, or a
 * data-less envelope → refusal with NO content. `warn` returns content WITH the warning
 * riding along. Content is framed as UNTRUSTED DATA to blunt prompt injection (C5 —
 * the verdict is rendered verbatim, never re-scored in TS).
 */
async function fetchWebLocally(
  args: Record<string, unknown>,
  fetchImpl: FetchImpl,
): Promise<ToolOutcome> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return { ok: false, summary: "web_fetch: no url given" };
  let res: SafeFetchResult;
  try {
    res = await fetchImpl(url, {
      maxBytes: WEB_FETCH_MAX_BYTES,
      timeoutSec: WEB_FETCH_TIMEOUT_SEC,
    });
  } catch (err) {
    // a wedged/throwing sidecar spawn fails closed — the turn continues.
    return { ok: false, summary: `web_fetch blocked (fail-closed): ${errMsg(err)}` };
  }
  // fail-closed order: blocked OR verdict=block OR missing/unparseable data → refuse.
  if (!res || res.blocked === true || res.verdict === "block" || typeof res.data !== "string") {
    const reason = (res && (res.reason ?? res.error)) || "blocked (fail-closed)";
    return {
      ok: false,
      summary: `web_fetch blocked: ${reason}`,
      verdict: { verdict: "block" },
    };
  }
  const { text, truncated } = capUtf8(res.data, WEB_FETCH_MAX_BYTES);
  const note = truncated ? `\n[truncated at ${WEB_FETCH_MAX_BYTES} bytes]` : "";
  // `warn` is NOT a block — return content but surface the warning to the model.
  const warn =
    res.verdict === "warn" ? `\n[warning: ${res.reason ?? "flagged as suspicious"}]` : "";
  // The redirect target is attacker-controlled (a hostile server sets Location); strip the chars
  // that could break OUT of the `source="…"` frame (`" < > \r \n`), else the untrusted web data
  // could inject a forged `<<trusted>>`-style delimiter into the model's view. URLs never need them.
  const src = (res.final_url || url).replace(/[<>"\r\n]/g, "");
  const framed = `<<untrusted-web-data source="${src}">>\n${text}${note}\n<<end untrusted-web-data>>${warn}`;
  return {
    ok: true,
    summary: framed,
    data: {
      url,
      final_url: res.final_url,
      verdict: res.verdict,
      provenance: res.provenance,
      datamark: true,
    },
    ...(res.verdict === "warn" ? { verdict: { verdict: "warn" as const } } : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Tools whose only authorization is the confirm prompt itself → the prompt MUST name the target. */
const PATH_CONFIRM_TOOLS = new Set(["write_file", "propose_edit"]);

/**
 * The human-facing confirm prompt for ONE tool call (the plain-host seam). For a file writer it
 * resolves and shows the EXACT absolute path, and flags a target that escapes the working set —
 * "run tool write_file?" is uninformed consent for the one call that can create/overwrite any
 * file. PURE (path resolution + an isPathAllowed scope test); every other tool keeps the terse form.
 */
export function confirmPrompt(call: ToolCall, cwd: string, roots?: string[]): string {
  const raw = typeof call.args?.path === "string" ? call.args.path : "";
  if (!PATH_CONFIRM_TOOLS.has(call.name) || !raw) return `run tool ${call.name}?`;
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const verb = call.name === "write_file" ? "write file" : "edit file";
  const outside = roots && roots.length > 0 && !isPathAllowed(abs, roots);
  return outside ? `${verb} OUTSIDE the working set: ${abs}?` : `${verb} ${abs}?`;
}

export function makeToolRunner(
  client: EngineClient,
  opts: {
    roots?: string[];
    cwd?: string;
    editHistory?: EditRecord[];
    fetchImpl?: FetchImpl;
    checkpoint?: CheckpointHook;
    /** absolute paths a confirm seam approved for an OUT-OF-working-set `write_file` this turn
     *  (populated by runMessageTurn's confirm wrapper). Unset ⇒ out-of-scope writes are refused. */
    approvedWrites?: ReadonlySet<string>;
  } = {},
): ToolRunner {
  const roots = opts.roots;
  return async (tool: ToolDef, args: Record<string, unknown>): Promise<ToolOutcome> => {
    // web_fetch (CLI-011): the ONLY network path — the fail-closed safeFetch L6 proxy,
    // never global fetch. Reaches here only AFTER human confirm (openWorldHint).
    if (tool.name === "web_fetch") {
      return fetchWebLocally(args, opts.fetchImpl ?? safeFetch);
    }
    // propose_edit (CLI-010) is applied LOCALLY, not via the engine — path-guarded,
    // atomic, pre-image kept for revert. Reaches here only AFTER human confirm.
    if (tool.name === "propose_edit") {
      const { outcome, record } = applyLocalEdit(args, roots, opts.cwd ?? process.cwd?.() ?? ".");
      if (record) {
        if (opts.editHistory) opts.editHistory.push(record);
        // record.preImage is the TOCTOU-safe pre-write content — snapshot per turn (CLI-015).
        if (opts.checkpoint) captureIntoCheckpoint(opts.checkpoint, record.path, record.preImage);
      }
      return outcome;
    }
    // write_file: CREATE a new file or OVERWRITE an existing one (path-guarded, atomic,
    // pre-image kept). Reaches here only AFTER human confirm (destructiveHint ⇒ always confirm).
    if (tool.name === "write_file") {
      const { outcome, record } = applyWriteFile(
        args,
        roots,
        opts.cwd ?? process.cwd?.() ?? ".",
        opts.approvedWrites,
      );
      if (record) {
        if (opts.editHistory) opts.editHistory.push(record);
        if (opts.checkpoint) captureIntoCheckpoint(opts.checkpoint, record.path, record.preImage);
      }
      return outcome;
    }
    // fail-closed read scope (CLI-004): when a working set is configured, any path
    // argument outside [cwd, ...added dirs] is denied BEFORE it reaches the engine.
    // (Only PATH SCOPE widens — nemesis gating for exec-flavored tools is untouched;
    // this is a pure additional restriction on already-broker-approved calls.)
    if (roots && roots.length > 0) {
      for (const p of pathArgsOf(args)) {
        if (!isPathAllowed(p, roots)) {
          return { ok: false, summary: `path outside the working set (denied): ${p}` };
        }
      }
    }
    const argv = tool.toArgv(args);
    try {
      const env = (await client.runPrometheus(argv)) as unknown as Record<string, unknown>;
      const verdict = verdictFromEnvelope(env);
      return {
        ok: env.ok !== false,
        summary: summarizeEnvelope(tool.name, env),
        data: env,
        ...(verdict ? { verdict } : {}),
      };
    } catch (err) {
      // engine/transport failure → fail-closed outcome (never throws into the loop).
      return {
        ok: false,
        summary: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/* ------------------------------------------------------------------------- *
 * runMessageTurn — drive one user message through the agent loop + persist
 * ------------------------------------------------------------------------- */

/** Deps for one message turn (the host injects the ctx + a clock + an id source). */
export interface MessageTurnDeps {
  ctx: SessionCtx;
  /** ISO timestamp source (injected for deterministic tests). Defaults to now. */
  now?: () => string;
  /** id source for new sessions/turns (injected for deterministic tests). */
  newId?: (kind: "session" | "turn") => string;
  /** prior thread messages (the running conversation) the host carries. */
  history?: ThreadMessage[];
  /** CLI-072 resume: the FULL prior non-system thread (incl. `{role:"tool"}` results) from a
   *  capped turn. When set, the loop continues from it WITHOUT appending a new user message —
   *  the model sees the whole transcript (last round's tool results included) and picks up where
   *  it paused. `message` becomes the transcript label only. Takes precedence over `history`. */
  resumeThread?: ThreadMessage[];
  /** override the LLM client (tests inject a fake; default = endpoint-or-offline). */
  llm?: LLMClient;
  /** override the tool runner (tests inject a fake; default = engine bridge). */
  runTool?: ToolRunner;
  /** Ctrl-C abort: cancels the SSE stream + breaks the tool loop mid-turn (CLI-002). */
  signal?: AbortSignal;
}

/** What one message turn returns: the persisted session + the event stream + text. */
export interface MessageTurnResult {
  session: Session;
  events: AgentEvent[];
  /** the assistant's concatenated text reply (for the running thread history). */
  reply: string;
  /** the JSONL serialization of the (updated) session — the host persists it. */
  jsonl: string;
  /** CLI-072: the loop hit its iteration cap with more tool work pending — the host offers
   *  `/continue`. False for every turn that finishes under the cap (no cap notice then). */
  capped: boolean;
  /** CLI-072: the full non-system conversation thread AFTER this turn (incl. `{role:"tool"}`
   *  results). The host stashes it on a capped turn so `/continue` resumes with intact tool
   *  state. Empty for the non-agent-loop paths (offline / gate-blocked). */
  thread: ThreadMessage[];
}

const ISO_NOW = (): string => new Date().toISOString();
let _idSeq = 0;
const DEFAULT_ID = (kind: "session" | "turn"): string =>
  `${kind}-${Date.now().toString(36)}-${(_idSeq++).toString(36)}`;

/**
 * Render one AgentEvent as a short transcript line (no color decisions here — the
 * host/pane-render owns coloring; this is the crash-safe fallback sink the runtime
 * writes through so a turn is never silent even if the host forgets to render).
 */
function eventLine(ev: AgentEvent): string | null {
  switch (ev.kind) {
    // reasoning + status are rendered live+dimmed in emit() before here; null = no reprint.
    case "reasoning":
    case "status":
      return null;
    case "text":
      return ev.text;
    // Claude-Code framing: `●` bullet for an action, `⎿` connector for its result.
    case "tool_use":
      return `● ${ev.call.name}`;
    case "verdict":
      return `  ⎿ ${ev.tool}: ${ev.verdict}${ev.riskScore !== undefined ? ` (risk ${ev.riskScore})` : ""}`;
    case "tool_result":
      return `  ⎿ ${ev.call.name}: ${ev.summary}`;
    case "blocked":
      return `● blocked${ev.tool ? ` ${ev.tool}` : ""}: ${ev.reason}`;
    // CLI-072: the turn paused at its iteration cap — name /continue so the human can resume
    // (the host augments this with the consecutive-continue counter).
    case "capped":
      return `● hit the ${ev.rounds}-step cap${ev.canContinue ? " — /continue to resume" : ""}`;
    case "done":
      return null;
  }
}

/**
 * Offline fallback: when no endpoint is configured, try the engine's LOCAL chat
 * (`chat --local <model> "<prompt>"`) for a plain reply. The model id comes from the
 * tuning's modelId. Returns the reply text, or a clear actionable message — NEVER
 * throws (a missing local runner just yields guidance).
 */
/** Providers whose models can actually run on a LOCAL OpenAI-compatible runner. */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "vllm", "llamacpp", "local"]);

async function offlineReply(ctx: SessionCtx, message: string): Promise<string> {
  const model = ctx.tuning.model.modelId;
  const provider = ctx.tuning.model.provider;
  if (!model || model === "default") {
    return (
      "No model configured yet. Type /setup to download a free local model (Ollama) " +
      "or connect a paid CLI — or set one with /model <provider:id>."
    );
  }
  // NEVER route a paid/cloud model name (e.g. claude-opus) to the LOCAL runner: it isn't
  // an Ollama model and would just fail with a confusing 'server unreachable'. Guide instead.
  if (!LOCAL_PROVIDERS.has(provider)) {
    return `'${model}' is a paid/cloud model (${provider}) — it can't run on the local runner. Type /setup to download a free local model, or launch a paid CLI (e.g. \`prometheus chat --cli claude --open\`). To force a local model: /model ollama:<tag>.`;
  }
  try {
    // `--` end-of-options separator: the user message may legitimately start with `-`,
    // which must reach the engine as the prompt positional, never as an injected flag.
    const argv = ["chat", "--local", model, "--", message];
    const env = (await ctx.client.runPrometheus(argv)) as unknown as Record<string, unknown>;
    if (env.ok === false) {
      const detail = typeof env.error === "string" ? env.error : "local chat unavailable";
      return `local chat (${model}) error: ${detail}. Is the local runner (ollama/lmstudio) running?`;
    }
    const reply = env.response;
    return typeof reply === "string" && reply.trim()
      ? reply
      : `local model ${model} returned no text.`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `local chat (${model}) failed: ${detail}. Is the local runner running?`;
  }
}

/**
 * Run ONE user message through the agent loop, streaming events to the host and
 * persisting the turn. Crash-safe end to end: any unexpected error is folded into a
 * friendly transcript line and a `blocked`/error event so the session continues.
 *
 * Flow:
 *   1. resolve the LLMClient (explicit override → endpoint adapter → offline path);
 *   2. when offline, short-circuit to the engine local chat (no tool loop);
 *   3. else drive `runAgentTurn(thread, tuning, {llm, runTool, confirm})`, writing
 *      each event through `ctx.write` and collecting them;
 *   4. append the turn to the session and re-serialize it for the host to persist.
 */
export async function runMessageTurn(
  session: Session | undefined,
  message: string,
  deps: MessageTurnDeps,
): Promise<MessageTurnResult> {
  const { ctx } = deps;
  const now = deps.now ?? ISO_NOW;
  const newId = deps.newId ?? DEFAULT_ID;
  const live: Session =
    session ?? createSession(newId("session"), "session", now(), process.cwd?.());

  const events: AgentEvent[] = [];
  let reply = "";

  // Display-path line buffer (CLI-003): text deltas accumulate and only COMPLETE,
  // width-wrapped lines reach ctx.write — WITHOUT a trailing newline, because the
  // sink (writeLine / printAbove) already adds the break; emitting one here was the
  // per-delta double-spacing bug. reply/events keep the RAW deltas untouched.
  const wrapWidth = ctx.width && ctx.width > 0 ? ctx.width : 0;
  let pending = "";
  const safeWrite = (s: string): void => {
    try {
      ctx.write(s);
    } catch {
      // a broken write sink must never abort the turn.
    }
  };
  // wrap one logical line to the terminal width, joining physical lines with "\n"
  // (both sinks split on "\n" and add their own break, so no trailing newline here).
  const writeLogical = (logical: string): void => {
    safeWrite(wrapWidth > 0 ? wrapLine(logical, wrapWidth).join("\n") : logical);
  };
  const pushDelta = (text: string): void => {
    pending += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      writeLogical(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  };
  // flush the trailing partial exactly once; a second call no-ops (idempotent — the
  // abort path AND the done event both call it).
  const flushPending = (): void => {
    if (pending.length === 0) return;
    const partial = pending;
    pending = "";
    writeLogical(partial);
  };

  // --- live "thinking" channel (CLI): reasoning models stream thinking BEFORE any
  // answer; without this the screen sits blank for the whole reasoning phase ("taking
  // ages, no output"). We stream it DIMMED, wrapped, and NEVER persist it (not in
  // `events`, not in `reply`). ANSI dim wraps each PHYSICAL line so wrapLine never
  // measures the escape bytes. ---------------------------------------------------- //
  const DIM = "\x1b[2m";
  const DIM_OFF = "\x1b[22m";
  const caps: ColorCaps = ctx.caps ?? "none";
  // paint each PHYSICAL line by `role` (wrap raw first so SGR bytes aren't width-measured).
  const paintWrapped = (logical: string, role: Role): void => {
    const physical = wrapWidth > 0 ? wrapLine(logical, wrapWidth) : [logical];
    safeWrite(physical.map((p) => paint(p, role, caps)).join("\n"));
  };
  const dimWrapped = (logical: string): void => {
    const physical = wrapWidth > 0 ? wrapLine(logical, wrapWidth) : [logical];
    safeWrite(physical.map((p) => `${DIM}${p}${DIM_OFF}`).join("\n"));
  };
  // status lines carry a leading glyph → colour by phase (→ send · ▼ resp · ⏳ wait · round · ✗ err).
  const statusRole = (t: string): Role => {
    const s = t.trimStart();
    if (s.startsWith("→")) return "stSend";
    if (s.startsWith("▼")) return "stResp";
    if (s.startsWith("⏳")) return "stWait";
    if (s.startsWith("✗")) return "stErr";
    if (s.startsWith("continuing")) return "stRound";
    return "muted";
  };
  let reasoningPending = "";
  let thinkingStarted = false;
  // reasoning often contains ```fenced code``` the model is drafting — light it up with the
  // Pelly scheme; prose is soft violet ("reasoning"), the ``` markers stay dim.
  const FENCE_RX = /^\s*```(\w+)?\s*$/;
  let fenceLang: string | null = null;
  let fenceState = CODE_STATE;
  const writeReasoningLine = (logical: string): void => {
    const fm = FENCE_RX.exec(logical);
    if (fm) {
      // the ``` marker line itself stays dim; toggle the fence for the lines between.
      if (fenceLang === null) {
        fenceLang = detectLanguage(fm[1]);
        fenceState = CODE_STATE;
      } else {
        fenceLang = null;
      }
      dimWrapped(logical);
      return;
    }
    if (fenceLang && caps !== "none" && isHighlightable(fenceLang)) {
      // code inside a fence → highlighted (NOT re-wrapped: highlightLine is line-based and
      // wrapping mid-token would split an escape); lexer state threads across lines.
      const { text, state } = highlightLine(logical, fenceLang, fenceState, caps);
      fenceState = state;
      safeWrite(text);
      return;
    }
    paintWrapped(logical, "reasoning"); // thinking prose → soft violet, no longer flat grey
  };
  const pushReasoning = (text: string): void => {
    if (!thinkingStarted) {
      thinkingStarted = true;
      safeWrite(paint("✻ thinking…", "thinkMark", caps));
    }
    reasoningPending += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let nl = reasoningPending.indexOf("\n");
    while (nl !== -1) {
      writeReasoningLine(reasoningPending.slice(0, nl));
      reasoningPending = reasoningPending.slice(nl + 1);
      nl = reasoningPending.indexOf("\n");
    }
  };
  const flushReasoning = (): void => {
    if (reasoningPending.length === 0) return;
    const partial = reasoningPending;
    reasoningPending = "";
    writeReasoningLine(partial);
  };

  const emit = (ev: AgentEvent): void => {
    // reasoning is LIVE-ONLY progress: render it, but do not persist or count it.
    if (ev.kind === "reasoning") {
      pushReasoning(ev.text);
      return;
    }
    // status is LIVE-ONLY wrapper progress (contacting/waiting/round/timeout): colour by phase,
    // close any thinking block first, never persist.
    if (ev.kind === "status") {
      flushReasoning();
      paintWrapped(ev.text, statusRole(ev.text));
      return;
    }
    events.push(ev);
    if (ev.kind === "text") {
      flushReasoning(); // close any trailing thinking line before the real answer
      reply += ev.text; // RAW accumulation — persistence/tests depend on it
      pushDelta(ev.text); // display buffering ONLY
      return;
    }
    // a non-text event flushes any pending thinking + partial FIRST so ordering holds.
    flushReasoning();
    flushPending();
    const line = eventLine(ev);
    if (line !== null) {
      // colour the tool lines (● action · ⎿ result/verdict/blocked) by outcome.
      const role: Role | null =
        ev.kind === "tool_use"
          ? "toolAction"
          : ev.kind === "tool_result"
            ? ev.ok
              ? "stResp"
              : "stErr"
            : ev.kind === "verdict"
              ? ev.verdict === "block" || ev.verdict === "error"
                ? "stErr"
                : "stWait"
              : ev.kind === "blocked"
                ? "stErr"
                : ev.kind === "capped"
                  ? "stWait"
                  : null;
      if (role) paintWrapped(line, role);
      else writeLogical(line);
    }
  };

  // --- offline / no-endpoint path: engine local chat, no tool loop ---------- //
  if (!deps.llm && !ctx.endpoint) {
    let text: string;
    try {
      text = await offlineReply(ctx, message);
    } catch (err) {
      // belt-and-braces: offlineReply already swallows, but never let this throw.
      text = `chat unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
    emit({ kind: "text", text });
    emit({ kind: "done" });
    return persist(live, message, events, reply, now, newId);
  }

  // --- metered-consent gate (CLI-031): refuse a Tier-C call until enabled ------- //
  const consent = checkMeteredConsent(ctx);
  if (consent.blocked) {
    emit({ kind: "text", text: consent.message ?? "metered provider not enabled" });
    emit({ kind: "done" });
    return persist(live, message, events, reply, now, newId);
  }

  // --- cost budget gate (CLI-030): fail-closed BEFORE the metered turn fires ---- //
  const gate = checkBudgetGate(ctx, now());
  if (gate.action === "block") {
    emit({ kind: "text", text: gate.message ?? "budget hard-stop" });
    emit({ kind: "done" });
    return persist(live, message, events, reply, now, newId);
  }
  if (gate.message) emit({ kind: "text", text: gate.message }); // a warn / force-proceed note

  // --- agent loop path: stream model ⇄ tool ⇄ gate ⇄ result ------------------ //
  const llm =
    deps.llm ??
    // ctx.endpoint is defined here (the offline branch above returned otherwise).
    makeLlmClient(ctx.endpoint as AiEndpoint, {
      ...(ctx.policy ? { policy: ctx.policy } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(ctx.accounting
        ? {
            onUsage: (rec) =>
              appendAccounting(
                (ctx.accounting as { home: string }).home,
                (ctx.accounting as { sessionId: string }).sessionId,
                rec,
              ),
          }
        : {}),
    });
  // Absolute paths an OUT-OF-working-set `write_file` was approved for through the confirm seam
  // this turn. The loop always routes write_file through confirm (destructiveHint is never
  // auto-approvable in the broker), so recording on approval is complete; applyWriteFile refuses
  // any out-of-scope target that isn't in here.
  const approvedWrites = new Set<string>();
  const runTool =
    deps.runTool ??
    makeToolRunner(ctx.client, {
      approvedWrites,
      ...(ctx.workingSet ? { roots: ctx.workingSet } : {}),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      ...(ctx.editHistory ? { editHistory: ctx.editHistory } : {}),
      ...(ctx.checkpoint
        ? {
            checkpoint: {
              store: ctx.checkpoint.store,
              turnId: newId("turn"),
              sessionId: ctx.checkpoint.sessionId,
              turnNumber: (live.turns?.length ?? 0) + 1,
              now,
            },
          }
        : {}),
    });
  // never-force: confirm DEFAULTS TO DENY — a human must type the confirmation.
  const rawConfirm = ctx.confirm ?? (() => false);
  // …wrapped so an APPROVED write_file records its resolved absolute path: that approval is what
  // authorizes a target outside the working set (see applyWriteFile). Approval-only — a decline
  // records nothing, and the path is resolved exactly as the applier resolves it.
  const confirm = async (call: ToolCall): Promise<ConfirmResult> => {
    const answer = await rawConfirm(call);
    const approved = typeof answer === "boolean" ? answer : answer.approved;
    if (approved && call.name === "write_file" && typeof call.args.path === "string") {
      const p = call.args.path;
      approvedWrites.add(isAbsolute(p) ? p : resolve(ctx.cwd ?? process.cwd?.() ?? ".", p));
    }
    return answer;
  };

  // CLI-053: inject the budgeted repo map as a SECOND system block when the technique is enabled,
  // so the agent grounds "where is X defined" from the map instead of a grep. Getter → toggles live.
  const repoMapBlock = ctx.repoMap?.();
  // CLI-061: inject assembled AGENTS.md/CLAUDE.md/PROMETHEUS.md steering as a system block; the
  // getter re-reads after `/memory edit`→reload so edited steering affects the NEXT turn (no restart).
  const steeringBlock = ctx.steering?.();
  // CLI-072 resume: continue the SAME non-system thread (its tail already ends on the last
  // round's tool results — a valid user-terminal state) with NO new user message. Otherwise the
  // normal path: prior history + this user message. System context is (re)assembled fresh either way.
  const conversation: ThreadMessage[] = deps.resumeThread
    ? [...deps.resumeThread]
    : [...(deps.history ?? []), { role: "user", content: message }];
  const thread: Thread = {
    messages: [
      { role: "system", content: ctx.tuning.systemPrompt },
      ...(steeringBlock ? [{ role: "system" as const, content: steeringBlock }] : []),
      ...(repoMapBlock ? [{ role: "system" as const, content: repoMapBlock }] : []),
      // CLI-088: token-economy system blocks (terse-output → the terse directive), when enabled.
      ...tokenSystemBlocks(ctx.tokenToggles).map((b) => ({ role: "system" as const, content: b })),
      ...conversation,
    ],
  };

  let aborted = false;
  try {
    for await (const ev of runAgentTurn(thread, ctx.tuning, { llm, runTool, confirm })) {
      // check BEFORE emit: a delta/tool_use produced after Ctrl-C is dropped, and the
      // lazy generator suspends here so the NEXT tool never dispatches (no post-abort work).
      if (deps.signal?.aborted) {
        aborted = true;
        break;
      }
      emit(ev);
    }
  } catch (err) {
    if (isAbortError(err) || deps.signal?.aborted) {
      aborted = true; // aborted fetch surfaced as a throw — fold into the interrupted path
    } else {
      // the loop is already crash-resistant per tool; this is the outermost net.
      const detail = err instanceof Error ? err.message : String(err);
      emit({ kind: "blocked", reason: `turn aborted: ${detail}` });
      emit({ kind: "done" });
      return persist(live, message, events, reply, now, newId);
    }
  }

  if (aborted) {
    // retain the partial streamed output already in `reply`, mark it interrupted
    // (reuse the warn-painted `blocked` line style), and close the turn exactly once.
    emit({ kind: "blocked", reason: "interrupted" });
    emit({ kind: "done" });
  }

  // CLI-072: hand back the post-turn non-system thread (the loop folded each round's assistant
  // text + tool results into it in place) so a capped turn can be resumed via `/continue`.
  const resumable = thread.messages.filter((m) => m.role !== "system");
  return persist(live, message, events, reply, now, newId, resumable);
}

/** Append the turn to the session + re-serialize (shared store, fail-soft). */
function persist(
  session: Session,
  prompt: string,
  events: AgentEvent[],
  reply: string,
  now: () => string,
  newId: (kind: "session" | "turn") => string,
  thread: ThreadMessage[] = [],
): MessageTurnResult {
  const updated = appendTurn(session, {
    id: newId("turn"),
    prompt,
    events,
    createdAt: now(),
  });
  return {
    session: updated,
    events,
    reply,
    jsonl: serializeSession(updated),
    capped: events.some((e) => e.kind === "capped"),
    thread,
  };
}
