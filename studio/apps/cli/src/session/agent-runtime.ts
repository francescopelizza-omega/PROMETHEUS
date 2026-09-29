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
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
import {
  ModelIdlePausedError,
  agent,
  ai,
  costOf,
  createAiClient,
  type mcpServer,
  usageFromPayload,
} from "@prometheus/core";
// The shared model-request path: one retrying POST, one failure classification. Every
// transport in this repo made a single attempt before this.
const { AiHttpError, describeAiFailure, endpointBreaker, fetchModelWithRetry } = ai;
import { DEFAULT_CONTEXT_WINDOW, localKeepAliveField } from "@prometheus/core";
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
  clearHostToolCache,
  probeHostTools,
  readTextExact,
} from "@prometheus/core/agent-system-host";

import {
  type EngineClient,
  type SafeFetchOptions,
  type SafeFetchResult,
  findRecentEviction,
  safeFetch,
} from "@prometheus/engine-bridge";
import { loadSettings } from "../home.js";
import { hasMeteredConsent } from "../metered-consent.js";
// syntax highlighting for code inside the reasoning stream (Pelly scheme). Pure, self-contained.
import { CODE_STATE, detectLanguage, highlightLine, isHighlightable } from "../tui/highlight.js";
import { type ColorCaps, type Role, paint } from "../tui/palette.js";
// pure display-width helper (ANSI + wide-char aware); no TUI/presentation deps.
import { wrapLine } from "../tui/width.js";
// fail-closed read-scope guard for the session working set (CLI-004).
import { makeStreamSink } from "./exec-stream.js";
import {
  type AccountingRecord,
  appendAccounting,
  readAccounting,
  readAccountingSince,
  withLocalRowsFree,
} from "./history-store.js";
import { touchModelActivity } from "./model-activity-store.js";
import { recordEndpointHealth } from "./model-health-store.js";
import {
  type SystemToolDeps,
  appendCanaryAudit,
  execVarsFromEnv,
  runEngineVerb,
  runSystemTool,
  runWebTool,
} from "./system-tools.js";
import { isPathAllowed, pathArgsOf, scopedAbsolute } from "./working-set.js";

const {
  applyProposedEdit,
  parseHunksResult,
  verifyEdit,
  diagnoseFailedEdit,
  makeCheckpoint,
  restorePlan,
} = agent;
const { compact, shouldCompact, estimateTokens } = agent;
const { withRememberedGrants } = agent;
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
type ToolCapabilityState = agent.protocol.ToolCapabilityState;
type ScopedPermissionStore = agent.ScopedPermissionStore;
type GrantScope = agent.GrantScope;
type PermissionRule = agent.PermissionRule;
type TodoStore = agent.TodoStore;
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

/**
 * Which providers natively support prompt caching (input billed at a discount).
 *
 * Delegates to core, which keys off the RUNTIME derived from the base URL. This function used
 * to compare a "provider" string against `["anthropic","openai","google","gemini"]` — while
 * every provider catalogue in this repo names those rows `claude`, `chatgpt` and `gemini`. So
 * even once it had a caller, the id it would naturally have been handed could never have
 * matched. It is kept as a thin adapter because `prometheus tokens` reports against it.
 */
export function providerSupportsPromptCaching(provider: string): boolean {
  const p = provider.toLowerCase();
  const runtime =
    p === "anthropic" || p === "claude"
      ? "anthropic"
      : p === "openai" || p === "chatgpt"
        ? "openai"
        : p === "google" || p === "gemini"
          ? "gemini"
          : "none-of-them";
  return ai.promptCachingSupported(runtime as never);
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

/**
 * Host-specific TURN contributors for the preamble dispatch pipeline — thin adapters over
 * `SessionCtx` getters that already do their OWN vetting upstream (steering's remote-instruction
 * filter + `rules/loader.ts`'s `PROJECT_PROVENANCE` framing for project-scope sources; the repo
 * map's own size cap). Each is a `block`-target contributor: its own trailing system message,
 * exactly as these blocks have always been pushed — just now priority-ordered and budgeted
 * alongside every other contributor instead of appended unconditionally with no ceiling at all.
 */
function hostTurnContributors(ctx: SessionCtx): agent.protocol.PreambleContributor[] {
  const block = (
    id: string,
    priority: number,
    get: () => string | null | undefined,
  ): agent.protocol.PreambleContributor => ({
    id,
    priority,
    applies: (): boolean => Boolean(get()?.trim()),
    render: (): agent.protocol.PreambleUnit => ({ text: get() ?? "", mergeTarget: "block" }),
  });
  return [
    block("steering", 30, () => ctx.steering?.() ?? null),
    block("memory", 40, () => ctx.memory?.() ?? null),
    block("session-start-hooks", 50, () => ctx.sessionStartHooks?.() ?? null),
    block("repo-map", 80, () => ctx.repoMap?.() ?? null),
    {
      id: "token-economy",
      priority: 90,
      applies: (): boolean => tokenSystemBlocks(ctx.tokenToggles).length > 0,
      render: (): agent.protocol.PreambleUnit => ({
        text: tokenSystemBlocks(ctx.tokenToggles).join("\n\n"),
        mergeTarget: "block",
      }),
    },
  ];
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

/** Provider-reported usage for one session, rolled up from its `<id>.acct.jsonl`. */
export interface MeasuredUsage {
  /** model round-trips recorded — NOT user turns; one prompt with a tool loop bills several. */
  roundTrips: number;
  /** Σ promptTokens: the BILLED input, which is far larger than the transcript. */
  inputTokens: number;
  outputTokens: number;
  /** the last record's promptTokens — the true tokenized size of the most recent request. */
  lastPromptTokens: number;
  /** true when every record came from a provider usage frame rather than a chars/4 fallback. */
  exact: boolean;
}

/**
 * Roll up a session's accounting records. `[]` ⇒ null — never a fabricated zero.
 *
 * `/stats` and `/context` were computed from the text transcript by `sessionUsage` above, while
 * the provider's REAL counts were written to `<id>.acct.jsonl` every round and read by nobody
 * except the separate `prometheus tokens report` command. That is worse than a stale label:
 * `sessionUsage` counts each message ONCE, and every turn re-sends the whole thread, so on an
 * N-turn session the billed input is undercounted by roughly a factor of N. The number was not
 * "an estimate", it was structurally wrong, and it is the number a user checks before deciding
 * whether they can afford to keep going.
 */
export function rollupMeasured(records: readonly AccountingRecord[]): MeasuredUsage | null {
  if (records.length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimated = 0;
  for (const r of records) {
    inputTokens += r.promptTokens;
    outputTokens += r.completionTokens;
    if (r.estimated) estimated += 1;
  }
  return {
    roundTrips: records.length,
    inputTokens,
    outputTokens,
    lastPromptTokens: (records[records.length - 1] as AccountingRecord).promptTokens,
    exact: estimated === 0,
  };
}

/**
 * A session's usage, MEASURED where the provider reported it and estimated only where it did not.
 *
 * Fail-soft by design: `readAccounting` throws on an unreadable store because the budget gate
 * fails closed on it, but a read-only display must not take the session down — an unreadable
 * store degrades to the estimate, which is exactly what it was before.
 */
export function measuredSessionUsage(
  home: string,
  sessionId: string,
  fallback: UsageStats,
  modelId: string,
  isLocal: boolean,
  pricing: Pricing,
  read: (h: string, id: string) => AccountingRecord[] = readAccounting,
): UsageStats {
  let m: MeasuredUsage | null = null;
  try {
    m = rollupMeasured(read(home, sessionId));
  } catch {
    return fallback;
  }
  if (!m) return fallback;
  const cost = costOf(
    { inputTokens: m.inputTokens, outputTokens: m.outputTokens },
    modelId,
    pricing,
    isLocal,
  );
  return {
    ...fallback,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    estTokens: m.inputTokens + m.outputTokens,
    estimated: !m.exact,
    cost,
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

/**
 * The external-tool manifest for this process, rendered once — the getter the terminal hosts
 * put on `SessionCtx.hostTools`.
 *
 * Memoised on top of the probe's own cache so the STRING is built once too: it lands inside the
 * prompt-cache prefix, so it must be byte-identical every turn or the cache misses on each one.
 * `clearHostToolCache()` + `resetHostToolManifest()` (after an install) is what makes it
 * recompute, which is exactly when a cache miss is the correct outcome.
 */
let hostToolManifestCache: string | null | undefined;
export function hostToolManifest(): string | null {
  if (hostToolManifestCache === undefined) {
    hostToolManifestCache = agent.renderHostToolManifest(probeHostTools(), externalToolDefaults());
  }
  return hostToolManifestCache;
}

/**
 * The per-tool defaults, read from `settings.json` over the shipped ones.
 *
 * Stated in the manifest so the model applies them rather than inventing a JPEG quality per
 * turn. FLAT dotted keys (`tools.externalTools.imageFormat`) because the CLI's `saveSettings`
 * is a shallow merge that rewrites the whole file — a nested blob would lose its siblings on
 * the first terminal-side write. A value outside the allowed set is IGNORED rather than passed
 * through: this string reaches the model, and `validateSettings` does not run at load time.
 */
function externalToolDefaults(): agent.ExternalToolDefaults {
  const raw = loadSettings();
  const d = { ...agent.DEFAULT_EXTERNAL_TOOLS };
  const str = (k: keyof agent.ExternalToolDefaults, allowed?: readonly string[]): void => {
    const v = raw[`tools.externalTools.${k}`];
    if (typeof v === "string" && v.trim() && (!allowed || allowed.includes(v))) {
      (d as Record<string, unknown>)[k] = v;
    }
  };
  const num = (k: keyof agent.ExternalToolDefaults, min: number, max: number): void => {
    const v = raw[`tools.externalTools.${k}`];
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) {
      (d as Record<string, unknown>)[k] = v;
    }
  };
  str("imageFormat", agent.EXTERNAL_TOOL_CHOICES.imageFormat);
  str("imageResizeFilter", agent.EXTERNAL_TOOL_CHOICES.imageResizeFilter);
  str("videoContainer", agent.EXTERNAL_TOOL_CHOICES.videoContainer);
  str("ocrLang");
  str("ytdlpFormat");
  num("imageQuality", 1, 100);
  num("pdfDpi", 1, 2400);
  num("videoMaxHeight", 0, 8192);
  return d;
}

/** Forget the rendered manifest (after `/install`), so the next turn re-probes. */
export function resetHostToolManifest(): void {
  hostToolManifestCache = undefined;
  clearHostToolCache();
}

/** The minimal context every in-session unit receives. */
export interface SessionCtx {
  /** the single JS→engine gateway (C5) — never spawn python elsewhere. */
  client: EngineClient;
  /** the live agent tuning (model/tools/gate/dryRun/yes) the session edits. */
  tuning: AgentTuning;
  /** PROMETHEUS_HOME — where the Phase-3 exec audit line lands. Omitted ⇒ no audit. */
  home?: string;
  /**
   * The endpoint's LEARNED tool-transport capability, owned by the host so it survives the
   * per-message client. A getter, because the host updates it through `onCapability`.
   */
  capability?: () => ToolCapabilityState;
  /** fired when the observation changes, so the host can keep it for the next message. */
  onCapability?: (state: ToolCapabilityState) => void;
  /** the A0–A7 level in force, recorded on every exec audit line. */
  authLevel?: number;
  /** the selected AI endpoint (from the Model Hub), or undefined when offline. */
  endpoint?: AiEndpoint;
  /**
   * The session's EFFECTIVE effort capability table — builtins plus any user/workspace
   * override file (`session/effort-rules.ts`).
   *
   * Loaded once per session by the host, not per turn: it is disk-backed, and re-reading it on
   * every message would put two file stats on the request path for a table that changes when a
   * human edits it. Omitted ⇒ the builtins alone, which is exactly the behaviour before the
   * override files existed.
   */
  effortRules?: readonly ai.EffortRule[];
  /**
   * Resolve `endpoint.apiKeyRef` → the raw key, LAZILY (the secret is read per request and
   * never stored in JS state).
   *
   * The connectors already return this beside the endpoint they build
   * (`ai/connectors/apiKey.ts`, `oauthBridge.ts`) — it simply had nowhere to go, so no
   * cloud endpoint's key ever reached the request. Omitted ⇒ local endpoints work exactly as
   * before and a cloud endpoint says so plainly instead of taking an opaque 401.
   */
  resolveKey?: (apiKeyRef: string) => Promise<string>;
  /** the per-workspace privacy policy (cloud refusal). Defaults to permissive. */
  policy?: WorkspacePolicy;
  /** `/timeout` — the user's inactivity-pause threshold in ms (default 10 min, see
   *  `agent.idleWatchdog.DEFAULT_IDLE_TIMEOUT_MS`). Undefined ⇒ the default applies. */
  idleTimeoutMs?: number;
  /** override for the auto-compaction summarizer's OWN (shorter) idle window — see
   *  `makeSummarizer`. Undefined ⇒ `agent.idleWatchdog.DEFAULT_COMPACT_IDLE_TIMEOUT_MS`. Not
   *  currently exposed via a slash command; present for testability/future tuning. */
  compactIdleTimeoutMs?: number;
  /** --json mode: machine envelope to stdout, human text to stderr (host-owned). */
  json?: boolean;
  /** asked before a non-auto-approvable tool runs; DEFAULT = deny (never-force). A
   * rejection may carry a reason (propose_edit, CLI-010) → surfaced as a tool_result. */
  confirm?: (call: ToolCall) => ConfirmResult | Promise<ConfirmResult>;
  /**
   * Remembered "don't ask again" grants. Absent ⇒ every gated call asks, every time (the
   * behaviour before this existed). The host owns the lifetime: `clearOnce` after each
   * decision, `clearSession` at session end, and it serializes `all()` for project/user scope.
   */
  grants?: ScopedPermissionStore;
  /** override the delegation budget (depth / total spawns) for this turn. */
  subagentBudget?: Partial<agent.SubagentBudget>;
  /**
   * Ask the human a free-text question mid-turn (the `question` tool).
   *
   * Separate from `confirm`, which answers yes/no about a specific call. Absent ⇒ the tool
   * reports honestly that nobody can answer and tells the model to proceed on a stated
   * assumption — it must never hang waiting for a user who is not there.
   */
  ask?: (prompt: string) => Promise<string>;
  /**
   * Sub-agent personas loaded from markdown, already CLAMPED by scope.
   *
   * A persona may narrow the child further and add persona text; it can never widen what
   * `childTuning` produced. Absent ⇒ only the three built-in roles exist.
   */
  agentFiles?: readonly agent.LoadedAgent[];
  /** the session's task list (todowrite/todoread). Agent memory — never a file. */
  todos?: TodoStore;
  /** fired after a todo write so the host can render a one-line status. */
  onTodos?: (items: readonly agent.TodoItem[]) => void;
  /**
   * Dispatch an `mcp__<server>__<tool>` call to a connected MCP server.
   *
   * The host owns the `McpHostManager`; injecting the call keeps the MCP transports (and the
   * SDK behind them) out of this module's dependency graph.
   */
  callMcpTool?: (
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; summary: string; data?: unknown }>;
  /** base permission rules from config; scoped grants merge AROUND these, never into them. */
  permissionRules?: readonly PermissionRule[];
  /** a grant was stored — the host persists it and can say so in the transcript. */
  onRemember?: (subject: string, scope: GrantScope) => void;
  /** a remembered grant skipped a prompt — worth one honest transcript line. */
  onAutoApprove?: (subject: string, reason: string) => void;
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
  /**
   * The external-tool manifest (`agent/host-tools.ts`): which of `HOST_TOOLS` are on PATH here,
   * as ~100 tokens of names, or null when this host did not probe.
   *
   * A getter for the same reason `repoMap` and `steering` are: `/install` clears the probe cache
   * and the NEXT turn must see the newly installed tool without rebuilding the SessionCtx. It is
   * also the seam that keeps turn assembly deterministic in tests — a fixture that does not
   * supply it gets no block, so a suite's expectations never depend on what the CI box happens
   * to have installed.
   */
  hostTools?: () => string | null;
  /** assembled AGENTS.md/CLAUDE.md/PROMETHEUS.md steering (CLI-061): a getter returning the rules
   * block to inject as a dedicated system-context block, or null/"" when none loaded. A getter so
   * `/memory edit`→reload re-assembles it for the NEXT turn without reconstructing the SessionCtx. */
  steering?: () => string | null;
  /**
   * Durable cross-session project memory: a getter returning the `memory_write`-authored index
   * as a system-context block, or null when this project has never had an entry written. Unlike
   * `steering` this is agent-AUTHORED rather than human-maintained (see
   * `@prometheus/core/agent-system-host`'s `loadMemoryIndexBlock`) — but the injection mechanics
   * are deliberately identical: a getter, re-read every turn, so a `memory_write` earlier in the
   * SAME session is visible on the next one without restarting.
   */
  memory?: () => string | null;
  /**
   * SessionStart HOOK output (`agent/hooks.ts`): a getter returning the combined stdout of the
   * user's `SessionStart` hooks as a system-context block, or null when none are configured or
   * none printed anything.
   *
   * Deliberately the SAME mechanics as `steering`/`memory` — a getter injected as a
   * `{role:"system"}` block — so a hook that prints "current sprint: CLI-090" is context the
   * model reads exactly the way a `PROMETHEUS.md` line is. Unlike those two the value is
   * captured ONCE, at session start (that is what the event means); the getter just replays it.
   */
  sessionStartHooks?: () => string | null;
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
 *
 * The fail-closed half is real only because `readAccounting` now THROWS on an unreadable file
 * rather than swallowing the error and returning `[]`. It used to do the latter, which meant a
 * deleted or chmod-000 store read as "$0 spent" and the cap silently stopped enforcing — the
 * documented guarantee inverted into a one-command bypass. A file that was never written is
 * still `[]`, because that is the normal first run.
 */
export function checkBudgetGate(
  ctx: SessionCtx,
  nowIso: string,
  readRecords: (home: string, sessionId: string) => AccountingRecord[] = readAccounting,
  readDay: (home: string, sinceMs: number) => AccountingRecord[] = readAccountingSince,
): BudgetGateResult {
  const b = ctx.budget;
  // A local turn, or no configured cap, bypasses ENTIRELY — the store is never even read, so a
  // corrupt accounting file can never block a turn that could not have cost anything.
  if (!b || !ctx.accounting || !ctx.endpoint || ctx.endpoint.locality === "local") {
    return { action: "ok" };
  }
  const { home, sessionId } = ctx.accounting;
  /**
   * The READING is this host's half; the DECISION is `ai.decideBudget`, shared with the
   * desktop. It used to be inlined here, which is precisely why the desktop had no cap at
   * all — there was nothing to reuse without dragging `node:fs` into a sandboxed renderer.
   *
   * The readers are called INSIDE the try that `decideBudget` also guards, because a throw
   * from `readAccounting` (an unreadable/chmod-000 store) is the fail-closed case: it must
   * BLOCK, not read as "$0 spent". Passing already-read arrays in would move that throw
   * outside the guard and lose the property.
   */
  const warned = b.warned;
  try {
    // Local rows are priced as the free rows they are (see withLocalRowsFree).
    const sessionRecords = withLocalRowsFree(readRecords(home, sessionId));
    const dayRecords =
      b.config.dailyUsd !== undefined
        ? withLocalRowsFree(readDay(home, ai.startOfLocalDayMs(nowIso)))
        : undefined;
    return ai.decideBudget({
      sessionRecords,
      ...(dayRecords ? { dayRecords } : {}),
      config: b.config,
      nowIso,
      priceFor: b.priceFor,
      warned,
      ...(b.forceBudget !== undefined ? { forceBudget: b.forceBudget } : {}),
    });
  } catch (e) {
    if (b.forceBudget) return { action: "ok" };
    return {
      action: "block",
      message: `budget check failed (fail-closed block): ${(e as Error).message}. Use --force-budget to override.`,
    };
  }
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
  /**
   * The restore budget, from the MODEL — 6000 was a hard-coded floor for every endpoint.
   *
   * It truncated every resumed session to roughly 24k characters whether the model held 8k
   * tokens or a million, so resuming a long session on Claude threw away 97% of it and told
   * the user only that some turns were "elided for context". The caller passes the real
   * budget; the old constant survives solely as the no-information fallback.
   */
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

/**
 * Regroup persisted transcript RECORDS back into `SessionTurn`s.
 *
 * A restore used to set `history` and leave `session` untouched — a fresh, empty Session. The
 * two are supposed to be views of the same conversation, and compaction rebuilds `history` from
 * `session.turns`, so the FIRST compaction after a `/resume` or `--continue` replaced the whole
 * restored conversation with `turnsToHistory([])` — nothing. The user resumed a long session,
 * worked in it, and then watched the agent silently forget all of it at the moment the session
 * grew long enough to compact. `/condense` did the same thing immediately.
 *
 * `appendTurnEvents` writes one JSON record per line: `{role:"user",text}` opens a turn and the
 * `AgentEvent`s that follow belong to it, which is exactly the grouping `SessionTurn` wants.
 */
export function turnsFromRecords(records: readonly Record<string, unknown>[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const r of records) {
    if (r.role === "user") {
      turns.push({
        id: `restored-${turns.length}`,
        turnNumber: turns.length + 1,
        prompt: String(r.text ?? ""),
        events: [],
        createdAt: typeof r.ts === "string" ? r.ts : new Date(0).toISOString(),
      });
      continue;
    }
    // An event before any user record (a truncated or hand-edited transcript) gets a turn to
    // live in rather than being dropped — losing it would be the silent half of this defect.
    if (turns.length === 0) {
      turns.push({
        id: "restored-0",
        turnNumber: 1,
        prompt: "",
        events: [],
        createdAt: typeof r.ts === "string" ? r.ts : new Date(0).toISOString(),
      });
    }
    (turns[turns.length - 1] as SessionTurn).events.push(r as unknown as AgentEvent);
  }
  return turns;
}

/**
 * Rebuild the model's ThreadMessage history from (possibly compacted) turns.
 *
 * TOOL RESULTS ARE INCLUDED. They used to be dropped here exactly as the two hosts dropped them
 * live, so the two paths agreed — and were wrong in the same direction, which is why neither
 * looked suspicious. The consequence was sharper here than in the live path: a compaction, or a
 * `/resume`, replaced a thread that contained the agent's work with one that contained only its
 * prose about the work, so the agent's memory of every file it had read vanished at exactly the
 * moment the session got long enough to need it.
 *
 * The result is reconstructed from the stored `tool_result` events' summaries rather than from a
 * second store: the events are what the transcript already persists, and `summary` is the same
 * text the model was shown at the time.
 */
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
    for (const e of t.events) {
      if (e.kind !== "tool_result") continue;
      const r = e as { call: { name: string }; ok: boolean; summary: string };
      // Named, so the model can tell WHICH tool produced it; the pairing ids are deliberately
      // not reconstructed — a `tool_call_id` with no matching announced call is a provider
      // error, and the content has been self-describing since the text protocol was written.
      out.push({
        role: "user",
        content: `[tool_result ${r.call.name}${r.ok ? "" : " (failed)"}] ${r.summary}`,
      });
    }
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
  deps: { llm?: LLMClient; signal?: AbortSignal; onStatus?: (text: string) => void } = {},
): { summarize: Summarizer; offline: boolean } {
  const llm =
    deps.llm ??
    (ctx.endpoint
      ? makeLlmClient(ctx.endpoint, {
          ...(ctx.policy ? { policy: ctx.policy } : {}),
          ...(ctx.resolveKey ? { resolveKey: ctx.resolveKey } : {}),
          // (B) root cause 3's fix: this inner call used to get NO signal at all, so Esc/
          // Ctrl-C could never reach it, and it died on its own undifferentiated 180s timer
          // with its status silently discarded (see the for-await loop below).
          ...(deps.signal ? { signal: deps.signal } : {}),
          // A background helper the user's real turn is waiting behind — bounded to a SHORTER
          // idle window than the main turn's (10 min default) for exactly that reason.
          idleTimeoutMs:
            ctx.compactIdleTimeoutMs ?? agent.idleWatchdog.DEFAULT_COMPACT_IDLE_TIMEOUT_MS,
          ...(ctx.home ? { onLocalActivity: () => touchModelActivity(ctx.home as string) } : {}),
        })
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
      deps.onStatus?.("⎿ compacting session (summarizing older turns)…");
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
          else if (turn.kind === "status") deps.onStatus?.(`⎿ compacting: ${turn.text}`);
          else if (turn.kind === "paused") {
            // (B): fail-soft rather than making the user's real turn wait out the full
            // compact-idle window a SECOND time — the caller's extractive fallback below is
            // always safe (compact.ts is fail-soft by contract), and this is now VISIBLE
            // instead of a silent 180s death.
            deps.onStatus?.(
              `⎿ compacting: the summarizer model went idle for ${Math.round(turn.idleMs / 1000)}s — using an offline summary for this pass`,
            );
            break;
          }
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
  /** the file's exact bytes BEFORE the edit — `""` when it was empty OR did not exist. */
  preImage: string;
  /**
   * Did the file EXIST before this edit?
   *
   * The fact `preImage` cannot carry, and the reason `/revert` used to leave a trail of
   * zero-byte files: a created file has no previous content, `preImage` was `""`, and reverting
   * wrote that empty string back instead of removing the file. Optional so an older caller
   * still type-checks; ABSENT is read as "existed", which is the safe reading — a revert that
   * rewrites a file it should have deleted loses nothing, while the reverse deletes a file the
   * user wrote.
   */
  existed?: boolean;
}

/** Construction seams for the AI client (injected in tests; defaults use global fetch). */
export interface LlmClientDeps extends AiClientDeps {
  /**
   * Sub-agent personas to advertise in `spawn_agent`'s description.
   *
   * Carried on the CLIENT deps rather than read from a session context because this is where
   * the preamble is rendered — and the description has to be folded in before the tool list is
   * serialized, not after.
   */
  personas?: readonly agent.LoadedAgent[];
  /** the per-workspace privacy policy; defaults to permissive (local-first). */
  policy?: WorkspacePolicy;
  /** abort the in-flight SSE request + stop yielding deltas (Ctrl-C, CLI-002). */
  signal?: AbortSignal;
  /** the inactivity-pause threshold for THIS client's requests (root cause 1's fix) — see
   *  `agent.idleWatchdog`. Undefined ⇒ `DEFAULT_IDLE_TIMEOUT_MS` (10 min). */
  idleTimeoutMs?: number;
  /** test-only clock injection for the idle watchdog — see `toolTurn`'s identical fields. */
  idleWatchdogNow?: () => number;
  idleWatchdogSetTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  idleWatchdogClearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * The session's `prompt-caching` token toggle. Undefined ⇒ on (the previous behaviour).
   *
   * Carried on the CLIENT deps because the transport is what emits `cache_control`, and the
   * toggle is a per-session user decision rather than a per-request one.
   */
  promptCache?: boolean;
  /** per-turn token accounting sink (CLI-029): fed the SSE `usage`, else a chars/4 estimate. */
  onUsage?: (rec: AccountingRecord) => void;
  /** A probe-backed effort capability (e.g. from Ollama's /api/show `capabilities`). When
   *  omitted the client falls back to matching the model NAME, which is strictly worse —
   *  Gemma 3 and Gemma 4 differ on this within one family. */
  effortCapability?: EffortCapability;
  /** the session's effective capability table (builtins ⊕ user ⊕ workspace) — see SessionCtx. */
  effortRules?: readonly ai.EffortRule[];
  /** clock for the accounting timestamp (injected in tests). */
  now?: () => string;
  /**
   * What this endpoint has already been observed to do about tool calls.
   *
   * Passed in so a host that keeps one capability record per endpoint does not re-learn
   * "this model cannot do native tool calls" on every `/model` round-trip — each relearn
   * costs the user a wasted turn.
   */
  capability?: ToolCapabilityState;
  /** fired whenever the observation changes, so the host can persist it. */
  onCapability?: (state: ToolCapabilityState) => void;
  /**
   * Fired after every turn with this endpoint's fresh health record (Model Health: transport,
   * breaker, context window). Omitted (every existing test) ⇒ no persistence at all — a host
   * that wants it on disk wires it to `recordEndpointHealth` itself; this client never writes
   * anything on its own.
   */
  onModelHealth?: (record: ai.EndpointHealthRecord) => void;
  /**
   * The TURN-SCOPE preamble assembly's own spend (`PreambleAssembly.totalApproxTokens` from
   * `runMessageTurn`'s `CORE_TURN_CONTRIBUTORS` pass — tool-discipline, pre-write-recheck,
   * effort-text), so the ROUND-SCOPE assembly (`withPreamble`, below — tool-catalog, called once
   * per round rather than once per turn) draws against what is genuinely LEFT of one combined
   * pool instead of its own separate full `instructionBudget(contextWindow)`. Before this, a
   * model whose turn-scope contributors spent nearly the whole budget still got tool-catalog's
   * own FULL budget on top — two independent ceilings, not the one the design intends. Mutated
   * on the SAME `LlmClientDeps` object after `makeLlmClient` is constructed but before any round
   * runs (see `runMessageTurn`) — `turn()`'s closures read it fresh from `deps` each round, so
   * the mutation is visible without needing to reorder the two assemblies relative to each other.
   */
  turnScopeSpentTokens?: number;
}

/** An aborted `fetch` rejects with a DOMException `name === "AbortError"` (code 20). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Build the OpenAI message array for the NATIVE transport, pairing results to their calls.
 *
 * A `tool` message is only sent as `role:"tool"` when it has a `tool_call_id` AND the
 * assistant message that made that call is present with its `tool_calls`. Anything less is
 * flattened to `user`, because a HALF-paired transcript is worse than an honestly unpaired
 * one: OpenAI rejects a `tool` message whose id matches no preceding call, and that rejection
 * takes the whole turn with it.
 */
function toNativeMessages(messages: readonly ThreadMsg[]): Record<string, unknown>[] {
  const announced = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) for (const c of m.toolCalls) announced.add(c.id);
  }
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
    if (m.role === "tool") {
      if (m.toolCallId && announced.has(m.toolCallId)) {
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      }
      return { role: "user", content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Map the loop's thread to the NEUTRAL wire shape, keeping the call pairing intact.
 *
 * The OpenAI-shaped `toNativeMessages` above cannot serve here: Anthropic has no `tool` role
 * at all (a result is a `tool_result` block on the next user turn) and Gemini issues no call
 * ids (a result is paired by the function's NAME). Emitting one provider's shape and hoping
 * the others tolerate it is what made those two unreachable in the first place, so the shape
 * that goes to `wire.body` is provider-neutral and each format renders its own dialect.
 *
 * `toolName` is recovered from the assistant turn that made the call, because the thread
 * records the id on the result and the name on the call — Gemini needs the name.
 */
function toWireMessages(messages: readonly ThreadMsg[]): ai.WireMessage[] {
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) nameById.set(c.id, c.name);
  }
  return messages.map((m): ai.WireMessage => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content,
        toolCalls: m.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          argsJson: JSON.stringify(c.args),
        })),
      };
    }
    if (m.role === "tool") {
      const name = m.toolCallId ? nameById.get(m.toolCallId) : undefined;
      // An UNPAIRED result degrades to plain user context rather than being dropped — the
      // same choice `flattenToolRoles` documents, for the same reason.
      if (m.toolCallId && name) {
        return { role: "tool", content: m.content, toolCallId: m.toolCallId, toolName: name };
      }
      return { role: "user", content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Reasoning text, which no format models because it is not standard.
 *
 * Reasoning models stream their thinking here while `content` stays empty. Ollama spells the
 * field `reasoning` and other OpenAI-compatible servers `reasoning_content`; neither is in
 * the OpenAI spec, so it stays out of `WireEvent` and is read alongside it.
 */
function reasoningFromPayload(payload: string): string | undefined {
  if (!payload.includes("reasoning")) return undefined;
  try {
    const o = JSON.parse(payload) as {
      choices?: Array<{ delta?: { reasoning?: string | null; reasoning_content?: string | null } }>;
    };
    const d = o.choices?.[0]?.delta;
    return d?.reasoning ?? d?.reasoning_content ?? undefined;
  } catch {
    return undefined;
  }
}

/** The exposed tools in the neutral wire shape, via the ONE schema mapping. */
function toWireTools(tools: readonly ToolDef[]): ai.WireTool[] {
  // Reuses `toOpenAiTools` rather than re-deriving the schema: that mapping already gets enum
  // and default right and already filters `force`, which the loop hard-blocks. A second
  // derivation here is exactly the drift this repo has paid for before.
  return toOpenAiTools(tools).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as unknown as Record<string, unknown>,
  }));
}

/* ------------------------------------------------------------------------- *
 * makeLlmClient — adapt the SSE text stream → the agent loop's LLMClient
 * ------------------------------------------------------------------------- */

/** A wire message that may still carry the loop's native call pairing. */
type ThreadMsg = Msg & {
  toolCalls?: readonly { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
};

/**
 * Map an agent `Thread` to wire messages, KEEPING the `tool` role and the call pairing.
 *
 * Each transport then decides: the native one rebuilds `assistant.tool_calls` +
 * `{role:"tool", tool_call_id}`, and the text one flattens (see `flattenToolRoles`).
 */
function threadToMessages(thread: Thread): ThreadMsg[] {
  return thread.messages.map(
    (m: ThreadMessage): ThreadMsg => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    }),
  );
}

/**
 * Flatten `tool` messages to `user` for a transport with no call ids.
 *
 * The text protocol has no `tool_call_id` — there is no call to pair a result with — so an
 * OpenAI `role:"tool"` message is UNPAIRED, and unpaired is exactly what endpoints disagree
 * about: a strict one rejects the request, and a lenient one (Ollama, with a template that
 * has no `.ToolResults` branch) silently renders NOTHING for it. That second case is the bad
 * one, and it is invisible: the transcript shows the result, the thread contains the result,
 * and the model never saw it. Pointed at a real gemma4:12b, it called `list_dir` four times
 * in a row because as far as it could tell its first call had produced no output at all.
 *
 * The content is already self-describing (`[tool_result …]`), so nothing is lost by the
 * flattening except the structure the endpoint could not have used anyway.
 */
function flattenToolRoles(messages: readonly ThreadMsg[]): Msg[] {
  return messages.map((m) => ({
    role: m.role === "tool" ? "user" : m.role,
    content: m.content,
  }));
}

/**
 * Map the agent's `ToolDef`s → OpenAI function-tool schemas.
 *
 * This was a local copy that emitted the FieldSpec type verbatim, so `{type:"enum"}` — not a
 * JSON Schema type — went on the wire with the enum's values dropped, and `default` was
 * dropped too. The renderer had a second copy that got enum right and default wrong. Both are
 * gone: `agent.protocol.toOpenAiTools` is the one mapping, and it also filters `force`, which
 * the loop hard-blocks and which neither copy knew to hide.
 */
const toOpenAiTools = agent.protocol.toOpenAiTools;

/**
 * Fire-and-forget: pre-load a LOCAL model into memory at session start so the FIRST real
 * prompt is warm (no multi-second cold RELOAD). Sends a 1-token request with `keep_alive`
 * to pin the model resident. Never throws, never blocks the session — a down/absent runner
 * just means the first prompt loads cold, exactly as before. Local endpoints only (never a
 * cloud request, never a non-standard field to a non-Ollama endpoint).
 */
/**
 * How long a warm-up may take before it is abandoned.
 *
 * Long enough that a genuine cold load of a large model completes (30–90 s is normal on this
 * hardware); short enough that a dead endpoint is not held onto for the life of the session.
 */
export const WARMUP_TIMEOUT_MS = 120_000;

export function warmupLocalModel(endpoint: AiEndpoint | undefined, home?: string): void {
  if (!endpoint || endpoint.locality !== "local") return;
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  const url = /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  void fetch(url, {
    method: "POST",
    /**
     * BOUNDED. This fetch carried no signal at all, which was survivable while "local" could
     * only mean loopback: a refused connection fails immediately and a listening runner always
     * answers eventually.
     *
     * It is not survivable now. A host declared with `/remote add … --ssh` resolves to
     * `locality: "local"` for the egress decision, so this fire-and-forget POST reaches a
     * machine across a network — or an ssh tunnel whose far end has gone away without an RST,
     * which never fails and never answers. An unbounded fetch there hangs for the life of the
     * process, holding a socket, with nothing watching it.
     *
     * The budget is generous on purpose: warm-up blocks until the model is resident, and a
     * large local model can legitimately take 30–90 s to load. This is not a latency target —
     * it is the difference between giving up and never giving up.
     */
    signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
    body: JSON.stringify({
      model: endpoint.model ?? endpoint.id,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
      ...localKeepAliveField(endpoint.locality),
    }),
  })
    .then((res) => {
      if (res.ok) touchModelActivity(home);
    })
    .catch(() => {
      /* best-effort: a down/absent runner just means the first prompt loads cold */
    });
}

/** One tool call being reassembled from OpenAI streaming deltas (name once, args in fragments). */
interface ToolCallAccum {
  name: string;
  args: string;
  /**
   * The provider's own call id.
   *
   * It was not captured — not even present in the delta type — so there was nothing to pair a
   * result back to, and every follow-up round had to flatten `role:"tool"` down to a plain
   * `user` message. That works, but it is off-distribution for exactly the cloud models that
   * were trained on the paired form, and it is the shape a strict endpoint rejects outright.
   */
  id?: string;
}

/** The tool-call-capable transport (CLI-*): send the agent's tools and STREAM the
 *  OpenAI-compatible SSE so text tokens surface immediately (no wait for the whole
 *  completion) while native `tool_calls` are reassembled from their delta fragments.
 *  Yields text deltas live, then one `{kind:"tool_call"}` per completed call, then final.
 *  The agent loop routes each call through the §4.3 broker (permission prompt / gate) and
 *  applies it — so `propose_edit`/`write_file` land on disk ONLY after the human approves. */
async function* toolTurn(
  endpoint: AiEndpoint,
  messages: ThreadMsg[],
  tools: ToolDef[],
  policy: WorkspacePolicy,
  signal?: AbortSignal,
  effort?: EffortResolution,
  // The injected fetch seam `createAiClient` already honors. Without it this transport —
  // the one nearly every agentic turn takes — could not be intercepted by a test at all.
  doFetch: FetchLike = fetch,
  // Written in place so the caller can fold this turn into the endpoint's capability state.
  observed: {
    nativeCalls: number;
    textCalls: number;
    rejectedForTools: boolean;
    /**
     * Every content byte this turn produced, for the accounting FLOOR when the provider sends
     * no usage frame.
     *
     * The caller used to pass a literal `""` as the received text, so on a native turn without
     * an SSE `usage` frame — every local runner that omits `stream_options.include_usage`, and
     * that is the default — the record read `completionTokens: 0`. The same bytes on the
     * tool-less path were estimated and counted. So the expensive turns, the agentic ones,
     * were exactly the ones that cost nothing on the budget report, which is the failure mode
     * a cap exists to prevent.
     */
    receivedText: string;
  } = {
    nativeCalls: 0,
    textCalls: 0,
    rejectedForTools: false,
    receivedText: "",
  },
  /**
   * Resolve `endpoint.apiKeyRef` → the raw key, and receive the turn's token usage.
   *
   * Both exist because this transport was written for local runners and never revisited: it
   * hard-coded `Authorization: Bearer local`, so every CLOUD endpoint with tools enabled
   * (which is all of them — `connectors/apiKey.ts` and `oauthBridge.ts` both set
   * `supportsTools: true`) authenticated as the literal string "local" and took a 401. Cloud
   * models could use tools only by failing over to the text protocol.
   */
  aux: {
    resolveKey?: (ref: string) => Promise<string>;
    onUsage?: (u: SseTokenUsage) => void;
    /**
     * The user's `prompt-caching` token toggle, already resolved to a plain boolean.
     *
     * Combined with the provider-support check via `ai.shouldRequestPromptCache` at the actual
     * `applyPromptCache` call site below — this transport used to call `applyPromptCache`
     * unconditionally instead, so turning prompt caching OFF changed nothing on the path nearly
     * every agentic turn takes. Undefined ⇒ on, which is the previous behaviour.
     */
    promptCache?: boolean;
    /** this transport's inactivity-pause threshold — see `agent.idleWatchdog`. */
    idleTimeoutMs?: number;
    /**
     * `EffortCapability.reasoningTag` for this endpoint — the tag an R1-style model wraps its
     * inline thinking in (`"think"`, `"thought"`).
     *
     * Passed IN rather than resolved here because the capability is an endpoint fact the
     * caller already computed once, and because it must apply whether or not a `/think` tier
     * was ever set: these models leak `<think>` regardless of what effort is requested.
     */
    reasoningTag?: string;
    /**
     * Test-only clock injection for the idle watchdog, mirroring this file's existing `now?:
     * () => string` / `RetryOptions.sleep` pattern for timing-sensitive code. Production never
     * sets these (the watchdog uses the real `Date.now`/`setTimeout`); a test can inject a
     * TIME-COMPRESSED clock (e.g. 1 real ms = 1000 fake ms) to verify a real 30-second-minimum
     * idle threshold fires in milliseconds of actual test time, without weakening
     * `MIN_IDLE_TIMEOUT_MS` itself or waiting out real minutes in the suite.
     */
    idleWatchdogNow?: () => number;
    idleWatchdogSetTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    idleWatchdogClearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
    /** mirrors `AiClientDeps.onLocalActivity` for this transport — see request.ts's doc. */
    onLocalActivity?: () => void;
  } = {},
): AsyncIterable<LlmTurn> {
  if (policy.neverSendToCloud && endpoint.locality === "cloud") {
    yield { kind: "text", text: "cloud endpoint refused (workspace never-send-to-cloud is on)" };
    yield { kind: "final" };
    return;
  }
  const model = endpoint.model ?? endpoint.id;
  /**
   * The FORMAT this endpoint speaks. Every part of the request comes from it.
   *
   * This transport used to hard-code the OpenAI URL, the OpenAI bearer header, the OpenAI
   * body and an inline OpenAI SSE parser — a fifth copy of a transport that had already
   * drifted four ways. That is why Anthropic and Gemini could not run tools natively: not a
   * missing capability, just a hand-rolled request that only one provider understood.
   */
  const runtime = ai.runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality);
  const wire = ai.selectWire(runtime);
  const url = wire.url(endpoint.baseUrl, model);
  // accumulate tool-call fragments by their stream index (args arrive in pieces).
  /**
   * Accumulated native tool calls, keyed by the wire's grouping key — NOT bare `tc.index`.
   *
   * `index` groups the fragments of ONE streamed call, which is what OpenAI and Anthropic need.
   * But a provider that hands over a call whole (Gemini) numbers it by its position within the
   * chunk it arrived in, so one call per chunk means `index: 0` for every call. Keyed on that
   * alone, two different calls shared a slot: the later name won and the argument objects were
   * concatenated into `{"path":"a.txt"}{"path":"."}`, which does not parse — so BOTH calls were
   * destroyed and the model was handed a `malformed_tool_call` blaming its own output.
   */
  const calls = new Map<string, ToolCallAccum>();
  /** Monotonic key for calls that arrive COMPLETE — never merged, never colliding. */
  let completeCallSeq = 0;
  /** Preserves emit order: the sequence in which each key was first seen. */
  const callOrder = new Map<string, number>();
  let callSeen = 0;
  function callKey(tc: { index: number; complete?: boolean }): string {
    return tc.complete === true ? `whole:${completeCallSeq++}` : `idx:${tc.index}`;
  }
  // …and a text scanner for the same turn, because a model with a native channel may still
  // answer in prose (see where `delta.content` is consumed).
  const textScanner = new agent.protocol.ToolCallScanner();
  const textCalls: agent.protocol.TextToolCall[] = [];
  /**
   * Splits inline `<think>…</think>` out of the content stream — a no-op pass-through when this
   * endpoint's capability names no tag. See `ai/effort/reasoning-tag.ts`; it must run BEFORE
   * `textScanner`, so a model's private deliberation never reaches the tool-call parser.
   */
  const reasoningSplitter = ai.createReasoningTagSplitter(aux.reasoningTag);
  /**
   * Our own controller so an IDLE PAUSE (or the user's Ctrl-C) cancels the fetch + reader —
   * RE-ARMED per attempt, which is the part a retry loop makes load-bearing. `ac` is a `let`
   * and the watchdog's `onIdle` closes over it, so it always aborts whichever attempt is
   * CURRENT, without needing its own per-attempt timer any more (see below).
   */
  let ac = new AbortController();
  /**
   * STABLE across every retry attempt (never reassigned) — this is what the idle watchdog
   * actually aborts, and what is threaded into `fetchModelWithRetry` below as `userSignal` so
   * `retry()`'s own abort checks (before each attempt, and right after a failed one,
   * `resilience/retry.ts:80,86`) see it regardless of whether a fetch is live or the loop is in
   * its backoff SLEEP between attempts.
   *
   * Without this (verification pass #2's CRITICAL finding, `ai/client.ts`'s twin of this exact
   * pattern): `onIdle` aborting the per-attempt `ac` directly means an idle-fire landing during
   * the backoff sleep (nothing pending on `ac` at that instant — the previous attempt already
   * settled, the next hasn't started) aborts a controller nothing is listening to, is silently
   * lost, and — because `IdleWatchdog` is a documented ONE-SHOT — can never fire again for the
   * rest of this call, so a genuine LATER stall in the same request hangs forever instead of
   * pausing.
   */
  const outerAc = new AbortController();
  const onUserAbort = (): void => outerAc.abort();
  if (signal) {
    if (signal.aborted) outerAc.abort();
    else signal.addEventListener("abort", onUserAbort, { once: true });
  }
  // propagate immediately to whichever per-attempt controller is CURRENTLY live, so an active
  // fetch/read is torn down right away rather than only on the NEXT attempt noticing.
  outerAc.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const startMs = Date.now();
  // set when THIS watchdog (not the user) ends the turn — a PAUSE, never a discard (root
  // cause 1's fix: was a flat, hardcoded 180s "abort and lose the turn").
  let pausedByIdle = false;
  // WHY the model stopped, when the provider says (OpenAI finish_reason / Anthropic
  // stop_reason). "length" means the reply was cut off — the difference between a silent
  // empty turn and one that can explain itself.
  let stopReason: ai.WireEvent["stopReason"];
  let sawReasoning = false;
  // Hoisted: the notice at the end of the turn reports the same budget the preflight checked.
  let estimatedPromptTokens = 0;
  const watchdog = new agent.idleWatchdog.IdleWatchdog({
    idleTimeoutMs: aux.idleTimeoutMs,
    onIdle: () => outerAc.abort(),
    ...(aux.idleWatchdogNow ? { now: aux.idleWatchdogNow } : {}),
    ...(aux.idleWatchdogSetTimeout ? { setTimeoutFn: aux.idleWatchdogSetTimeout } : {}),
    ...(aux.idleWatchdogClearTimeout ? { clearTimeoutFn: aux.idleWatchdogClearTimeout } : {}),
  });
  watchdog.arm();
  const armAttempt = (): AbortSignal => {
    ac = new AbortController();
    // an idle-fire/cancel that landed during the backoff sleep (before this attempt even
    // started) must still stop it from firing its own fetch.
    if (outerAc.signal.aborted) ac.abort();
    return ac.signal;
  };
  /**
   * Interrupt the backoff sleep itself the INSTANT `outerAc` aborts, rather than letting the
   * full delay elapse before `retry()`'s next top-of-loop check ever notices — see `ai/client.ts`'s
   * identical helper for the full rationale. This transport has no existing injectable sleep for
   * tests, so there is nothing to defer to; production always uses the real timer below.
   */
  const abortableSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (outerAc.signal.aborted) {
        resolve();
        return;
      }
      const t = setTimeout(resolve, ms);
      outerAc.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  // Hoisted so the `finally` below can always release it — declared once per call (unlike
  // `ac`), which is fine: the body is only ever read once per turn, retries happen inside
  // `fetchModelWithRetry` before this reader is ever created.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  /**
   * Emit whatever tool calls/prose have FULLY reassembled so far — shared between the normal
   * completion path (below) and the idle-pause catch branch, so a pause never discards a call
   * the model already finished deciding on (verification pass #2's CRITICAL finding: the catch
   * block used to set `pausedByIdle` and return without ever draining `calls`/`textScanner`,
   * silently losing a fully-formed tool call and contradicting the turn's own "no work lost"
   * status line).
   */
  function* flushAccumulated(): Generator<LlmTurn> {
    /**
     * Drain the reasoning splitter FIRST, so its tail reaches the text scanner before that is
     * itself flushed. An unterminated `<think>` comes back as reasoning rather than text — a
     * model cut off mid-thought was still thinking, and promoting a truncated deliberation to
     * "the answer" is the failure the splitter exists to prevent.
     */
    const tail = reasoningSplitter.end();
    if (tail.reasoning) yield { kind: "reasoning", text: tail.reasoning };
    if (tail.text) yield* pumpText(textScanner.push(tail.text), textCalls);
    yield* pumpText(textScanner.end(), textCalls);
    // emit each fully-reassembled tool call (ordered by stream index).
    for (const [, acc] of [...calls.entries()].sort(
      (a, b) => (callOrder.get(a[0]) ?? 0) - (callOrder.get(b[0]) ?? 0),
    )) {
      if (!acc.name) continue;
      let args: Record<string, unknown> = {};
      let broken: string | undefined;
      try {
        args = JSON.parse(acc.args || "{}") as Record<string, unknown>;
      } catch {
        // Substituting `{}` here ran the tool with no arguments and told the model nothing,
        // so it had no way to know its own output was unparseable — and repeated it.
        broken = "the streamed arguments were not valid JSON";
      }
      if (broken) {
        yield {
          kind: "tool_call",
          call: { name: MALFORMED_CALL_TOOL, args: { reason: broken, wrote: acc.args } },
        };
        continue;
      }
      observed.nativeCalls += 1;
      yield {
        kind: "tool_call",
        call: {
          name: acc.name as agent.ToolCall["name"],
          args,
          ...(acc.id ? { id: acc.id } : {}),
        },
      };
    }
    // Native calls win: when both arrived, the prose was almost certainly the model narrating
    // the call it also made properly, and running it twice would double every side effect.
    if (observed.nativeCalls === 0) {
      observed.textCalls = textCalls.length;
      for (const call of textCalls) {
        yield { kind: "tool_call", call: { name: call.name, args: call.args } };
      }
    }
  }
  try {
    // (D) defensive guard: this endpoint may still have a generation from an EARLIER paused
    // turn running/queued server-side (Ollama's own queue, not Prometheus's) — see
    // `agent.idleWatchdog`'s header for why we can't verify or force real cancellation. Purely
    // informative: we still send the request, we just say why it might queue.
    const orphanRemainingMs = agent.idleWatchdog.orphanGraceRemainingMs(endpoint.id);
    if (orphanRemainingMs > 0) {
      yield {
        kind: "status",
        text: `⚠ ${endpoint.id} may still be finishing a generation from an earlier paused turn — this request can queue behind it for up to ${Math.ceil(orphanRemainingMs / 1000)}s.`,
      };
    }
    yield { kind: "status", text: `→ ${model}: sending request…` };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    let key = "";
    if (endpoint.apiKeyRef) {
      // Same keychain seam `createAiClient` uses — the RAW key never lives in JS state.
      if (!aux.resolveKey) {
        yield {
          kind: "text",
          text: `model error: ${endpoint.id} needs an API key but no key resolver was provided`,
        };
        yield { kind: "final" };
        return;
      }
      key = await aux.resolveKey(endpoint.apiKeyRef);
    } else if (endpoint.locality === "local") {
      // Local runners ignore the value but some shims insist on the header being present.
      // A keyless CLOUD endpoint gets NO header at all: sending a bogus bearer turns a
      // "you forgot to configure a key" into an opaque 401.
      key = "local";
    }
    // The format owns the credential's SHAPE: a bearer for OpenAI, `x-api-key` plus the
    // mandatory `anthropic-version` for Anthropic, `x-goog-api-key` for Gemini. Hard-coding
    // the bearer here is what authenticated every Anthropic request incorrectly.
    Object.assign(headers, wire.headers(key));
    // The tool SCHEMAS are part of the prompt (they travel in the body's `tools:[]`, not in the
    // messages), and the window must hold the ANSWER too — neither was counted, so a prompt that
    // filled 89% of the real window passed a check that thought it used 9% and reserved nothing.
    const wireTools = toWireTools(tools);
    estimatedPromptTokens = ai.estimateRequestTokens(
      messages.map((m) => m.content),
      wireTools,
    );
    // Reserve room for the ANSWER, not just the prompt (ai/retry-policy.ts explains why).
    const replyReserve = ai.replyReserveFor(endpoint.contextWindow);
    const requestBody = JSON.stringify(
      applyEffort(
        {
          ...wire.body(
            // The PAIRED form when the provider gave us call ids, flattened otherwise.
            // This used to flatten unconditionally, with a comment saying our results "carry
            // no OpenAI tool_call_id linkage" — which was true only because the streamed
            // `tool_calls[].id` was being thrown away. Cloud models are trained on the paired
            // shape, and it is the shape a strict endpoint expects.
            // Ask for the prompt cache this repo has measured all along. Applied BEFORE the
            // body is built, because the cache breakpoint goes on the stable system prefix
            // and the format decides where that prefix ends up. A no-op on every provider
            // that caches on its own (or not at all) — see `ai/prompt-cache.ts`.
            (ai.shouldRequestPromptCache(aux.promptCache, runtime)
              ? ai.applyPromptCache(
                  toWireMessages(applyEffortToMessages(messages, effort)),
                  ai.cacheDialectFor(runtime),
                )
              : toWireMessages(applyEffortToMessages(messages, effort))) as ai.WireMessage[],
            {
              model,
              tools: wireTools,
              // Ask for a terminal usage frame so an AGENTIC turn is accounted like a chat
              // one — for LOCAL endpoints too. "local tokens are free so an estimate costs
              // nothing" was wrong in the one way that matters: the estimate is also what the
              // context budget and the truncation notice read, and it under-counted a real
              // 7,254-token prompt as 755. ollama's /v1 accepts the field; a server that does
              // not simply omits the frame and the estimate below still applies.
              includeUsage: true,
            },
          ),
          // Ollama extension (ignored by other endpoints): keep the model resident 30m so a
          // second prompt doesn't pay the multi-second cold RELOAD. Only for LOCAL runners —
          // never send a non-standard field to a cloud endpoint.
          ...localKeepAliveField(endpoint.locality),
        },
        // Same discipline as `keep_alive` above: a field goes on the wire only when THIS
        // model is known to accept it. A knobless model gets nothing rather than a 400.
        effort,
      ),
    );

    /**
     * The request, with bounded retries (CLI-1xx).
     *
     * This is the path nearly every agentic CLI turn takes, and it made exactly one attempt: a
     * 429 became the text `model error: HTTP 429 Too Many Requests` and the turn was over. The
     * loop, the classification and the `Retry-After` handling are core's, shared with the other
     * three transports.
     *
     * The retry notes are QUEUED rather than yielded, because a generator cannot yield from
     * inside an awaited callback. They are flushed the moment the request settles, so a user
     * who waited eleven seconds is told why — after the fact, but told.
     */
    /**
     * Refuse an impossible request before paying for it.
     *
     * Overflow used to arrive as a provider 400 and end the turn. `looksLikeToolsRejection`
     * deliberately does not match it, so it did not even demote the transport — it just read
     * as a bug in Prometheus.
     */
    /**
     * A REFUSAL needs a MEASURED window. An unmeasured one is a budgeting hint.
     *
     * Every local endpoint starts at `DEFAULT_CONTEXT_WINDOW` (8192) as an admitted placeholder
     * — `onboarding.ts` labels it "A FLOOR, not a measurement" — and a failed probe leaves it
     * there. Passing that floor here turned "we could not ask the runner" into
     * "model error: this request is about N tokens but the model's context window is 8192", and
     * the turn ended without the model being called at all. On a 262,144-window local model,
     * with this repo's own ~7.2k-token prompt, that leaves the user about 800 tokens before
     * every turn is refused over a number nobody measured.
     *
     * `preflightContext` already handles the unknown case correctly and says why — an unknown
     * window disables the check, because "no information" must not mean "refuse".
     *
     * ONE flag covers both localities. A cloud endpoint is never probed by design, so
     * `cloud-endpoints.ts` sets the flag from whether the provider registry DECLARED a window —
     * 16 of its 18 rows do, and the two that do not (`nexos`, `abacus`, both routed gateways
     * onto frontier models) were being refused at roughly 4% of their real window. Keying on
     * locality instead would have re-trusted exactly those two.
     */
    const windowIsTrustworthy = endpoint.contextWindowMeasured === true;
    const pre = ai.preflightContext({
      estimatedPromptTokens,
      contextWindow: windowIsTrustworthy ? endpoint.contextWindow : 0,
      maxTokens: replyReserve,
    });
    if (!pre.ok) {
      yield { kind: "text", text: `model error: ${pre.reason}` };
      yield { kind: "final" };
      return;
    }

    /**
     * A format that genuinely cannot carry tools still degrades to the TEXT protocol here.
     *
     * All three formats carry tools now, so this is a backstop rather than the routine path
     * it used to be — but it stays, because it is the honest behaviour for any format added
     * later that cannot, and because `negotiateTransport` consults the same flag when picking
     * the opening move.
     *
     * NO `final` here: the caller (`makeLlmClient`'s `turn()`) sees `rejectedForTools` and
     * retries THIS SAME turn in the text protocol before yielding its own `final`. Yielding
     * `final` from here used to end the turn immediately — the external consumer breaks its
     * `for await` the moment it sees one — so the retry the status line promised never ran and
     * the user's message was silently eaten.
     */
    if (!wire.supportsTools) {
      observed.rejectedForTools = true;
      yield {
        kind: "status",
        text: `${model} speaks a protocol without native tool calls — using the text protocol`,
      };
      return;
    }

    const progressNotes: string[] = [];
    let res: Awaited<ReturnType<typeof doFetch>>;
    try {
      const pending = fetchModelWithRetry({
        endpointId: endpoint.id,
        url,
        init: { method: "POST", headers, body: requestBody },
        doFetch,
        signalFor: armAttempt,
        // A dead local server (down, still loading, wrong port) fails FAST after a run of
        // exhausted turns instead of paying the full retry schedule on every subsequent round.
        breaker: endpointBreaker(endpoint.id),
        // ALWAYS `outerAc.signal`, not just when the caller passed one: this is what makes an
        // idle-fire landing during the backoff sleep observable to `retry()`'s own checks —
        // `signal`'s abort already propagates into it via the listener above.
        userSignal: outerAc.signal,
        // …but only the CALLER's signal means "the human stopped it". An idle-watchdog abort
        // reaches `outerAc` too and must still count against the endpoint.
        userAborted: () => signal?.aborted === true,
        sleep: abortableSleep,
        onRetry: (info: { attempt: number; delayMs: number; reason: string }) => {
          // a response — even a failing one — is evidence the endpoint is alive.
          watchdog.touch();
          progressNotes.push(
            `${model}: ${info.reason} — retrying in ${Math.round(info.delayMs / 1000)}s`,
          );
        },
        ...(endpoint.locality === "local" && aux.onLocalActivity
          ? { onLocalActivity: aux.onLocalActivity }
          : {}),
      });
      // (C) pre-first-byte watchdog: from the moment the request is SENT, not from the first
      // response byte — a cold model load or a queue wait behind something else is never
      // silent for the whole `idleTimeoutMs` window any more.
      const ticker = agent.idleWatchdog.raceTicks(
        pending,
        agent.idleWatchdog.WATCHDOG_FIRST_TICK_MS,
        () => {
          const s = Math.round((Date.now() - startMs) / 1000);
          return `⏳ still waiting for ${model} to start responding… (${s}s — a large local model can take 30–90s to start; esc to cancel)`;
        },
      );
      let step = await ticker.next();
      while (!step.done) {
        for (const n of progressNotes.splice(0)) yield { kind: "status", text: n };
        yield { kind: "status", text: step.value };
        step = await ticker.next();
      }
      res = step.value;
    } catch (err) {
      for (const n of progressNotes.splice(0)) yield { kind: "status", text: n };
      if (err instanceof AiHttpError) {
        // Was the request refused BECAUSE it carried tools? If so the caller retries THIS turn
        // in the text protocol (see the comment on the `!wire.supportsTools` branch above for
        // why this must NOT yield `final`) and demotes the endpoint for every turn after. A
        // generic 4xx (context overflow, bad key) must not demote it — that would strand a
        // perfectly capable model on the weaker transport for the rest of the session.
        if (agent.protocol.looksLikeToolsRejection(err.status, err.detail)) {
          observed.rejectedForTools = true;
          yield {
            kind: "status",
            text: `${model} rejected native tool calls — retrying in text protocol`,
          };
          return;
        }
        // The body is included now. It used to be read and discarded, so a 400 that said
        // exactly what was wrong reached the user as a bare status number.
        yield { kind: "text", text: `model error: ${describeAiFailure(err)}` };
        yield { kind: "final" };
        return;
      }
      throw err;
    }
    for (const n of progressNotes.splice(0)) yield { kind: "status", text: n };
    if (!res.body) {
      yield { kind: "text", text: `model error: ${endpoint.id} returned an empty response body` };
      yield { kind: "final" };
      return;
    }
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    /** The reader is exhausted; drain the last unterminated frame, then stop. */
    let streamEnded = false;
    let firstByte = false;
    // hold ONE in-flight read across watchdog ticks (calling read() twice concurrently throws)
    // — `raceTicks` never re-issues `pendingRead`, only re-races it.
    let pendingRead = reader.read();
    while (!done) {
      if (signal?.aborted || outerAc.signal.aborted) {
        // Do NOT silently fall through to "the model finished" here: a plain `break` used to
        // exit the loop and flow straight into `pumpText`/the tool-call flush below, treating
        // whatever had accumulated so far as a COMPLETE answer — including a tool call's
        // arguments truncated mid-stream, which then failed to parse and was reported as
        // malformed rather than genuinely paused. `raceTicks` has no pending operation to
        // naturally reject in this exact gap (an abort landing BETWEEN reads, before the next
        // one is even issued) — the narrow race root cause #6's verification pass found — so
        // this throws instead, letting the SAME catch block below make the idle-vs-user
        // distinction uniformly for both exit paths, and skip the flush a real completion
        // still needs.
        throw new DOMException("idle watchdog (or user) aborted mid-turn", "AbortError");
      }
      const ticker = agent.idleWatchdog.raceTicks(
        pendingRead,
        firstByte
          ? agent.idleWatchdog.WATCHDOG_STREAM_TICK_MS
          : agent.idleWatchdog.WATCHDOG_FIRST_TICK_MS,
        () => {
          const s = Math.round((Date.now() - startMs) / 1000);
          return firstByte
            ? `▼ ${model} still generating… (${s}s)`
            : `⏳ waiting for ${model} — no output yet (${s}s). A large local model can take 30–90s to start.`;
        },
      );
      let tickStep = await ticker.next();
      while (!tickStep.done) {
        yield { kind: "status", text: tickStep.value };
        tickStep = await ticker.next();
      }
      const { value, done: streamDone } = tickStep.value;
      if (streamDone) {
        /**
         * The stream ended. Anything still in `buf` is a frame the server sent WITHOUT a
         * terminating newline — and that last frame can carry the closing sentence of the
         * answer or the tail of a tool call's arguments. Breaking here dropped it: the reply
         * was truncated with nothing to say so. Reproduced against a real HTTP server that
         * `res.end()`s mid-frame — the text arrived as `"first "` and the final frame was gone.
         *
         * Terminate the frame and let the SAME parsing loop below drain it, then leave — this
         * is exactly what core's own `client.ts` does with `parseSseChunk(`${buf}\n`)`.
         */
        if (buf.trim() === "") break;
        buf += "\n";
        streamEnded = true;
      } else {
        watchdog.touch(); // REAL evidence of life — reset the idle countdown (root cause 1's fix)
        if (!firstByte) {
          firstByte = true;
          agent.idleWatchdog.clearPossibleOrphan(endpoint.id); // (D) confirmed alive again
          yield { kind: "status", text: `▼ ${model}: responding…` };
        }
        buf += decoder.decode(value, { stream: true });
      }
      // SSE frames are newline-delimited `data: <json>` lines; process whole lines only.
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        // The usage frame arrives on its own choice-less event, so it must be read BEFORE
        // any early return below. `usageFromPayload` already normalizes all three providers.
        const u = usageFromPayload(payload);
        if (u) aux.onUsage?.(u);
        /**
         * The FORMAT decodes the frame — this used to be an inline OpenAI parser.
         *
         * Reasoning is read separately because it is an OpenAI-family extension with two
         * spellings (`reasoning` on Ollama, `reasoning_content` elsewhere) and no equivalent
         * in the neutral event; a format that does not emit it simply never matches.
         */
        const ev = wire.parse(payload);
        /**
         * A mid-stream provider failure ENDS the turn, loudly.
         *
         * The status was 200 and the bytes kept flowing, so nothing downstream would ever
         * have noticed: the stream simply stopped producing text and the turn returned an
         * empty answer. An Anthropic `overloaded_error` and a Gemini SAFETY stop both looked
         * exactly like the model declining to speak.
         */
        if (ev.error) {
          yield { kind: "text", text: `model error: ${ev.error}` };
          done = true;
          break;
        }
        if (ev.done) {
          done = true;
          break;
        }
        if (ev.stopReason) stopReason = ev.stopReason;
        const reasoning = reasoningFromPayload(payload);
        if (reasoning) {
          sawReasoning = true;
          yield { kind: "reasoning", text: reasoning };
        }
        if (ev.delta) {
          /**
           * Split inline `<think>…</think>` OUT of the content first.
           *
           * R1-style models put their thinking in the ordinary content stream rather than in a
           * `reasoning` field, and a server that does not split it for us hands it straight
           * through. `capability.reasoningTag` has named those models since the type existed
           * and nothing read it, so the deliberation arrived as the answer — and, worse, was
           * fed to the tool scanner below, where a model musing about calling `write_file`
           * could trip the text protocol into really calling it.
           *
           * A no-op splitter when the capability names no tag, so the ordinary path is
           * byte-identical.
           */
          // Counted RAW, before the thinking is split out and before the scanner reclassifies
          // any of it: the provider billed every one of these bytes, whatever we do with them.
          observed.receivedText += ev.delta;
          const split = reasoningSplitter.push(ev.delta);
          if (split.reasoning) {
            sawReasoning = true;
            yield { kind: "reasoning", text: split.reasoning };
          }
          if (split.text) {
            // Scanned even here. A small model handed a working native channel very often
            // answers with `<tool_call>` prose anyway; dropping those reads to the user as the
            // model refusing to act, and the scanner also keeps the markup out of the transcript.
            yield* pumpText(textScanner.push(split.text), textCalls);
          }
        }
        // EVERY call in the frame — a provider may batch a turn's parallel calls into one,
        // and reading only `ev.toolCall` executed the first and silently dropped the rest.
        for (const tc of ev.toolCalls ?? (ev.toolCall ? [ev.toolCall] : [])) {
          const key = callKey(tc);
          const acc = calls.get(key) ?? { name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.name) acc.name = tc.name;
          if (tc.argsFragment) acc.args += tc.argsFragment;
          if (!callOrder.has(key)) callOrder.set(key, callSeen++);
          calls.set(key, acc);
        }
      }
      if (streamEnded) break;
      // Only queue the next read if we're still going — `done` may have just been set by an
      // `ev.done`/`ev.error` frame above, and queuing a read here left it dangling: the outer
      // `while (!done)` exits before anyone awaits it, and the reader's lock never gets
      // released either (nothing downstream ever cancels it).
      if (!done) pendingRead = reader.read();
    }
    yield* flushAccumulated();
  } catch (err) {
    // OUR idle watchdog aborted the fetch (ac aborted but NOT via the user's Ctrl-C) — a
    // PAUSE, not a failure. Nothing is discarded: the `text` deltas already yielded above are
    // already in the caller's (`runAgentTurn`'s) `assistantText`, which the loop folds into
    // the thread the moment it sees the `paused` LlmTurn below — /continue (or the user's very
    // next message) resumes from exactly here. A tool call the model had ALREADY fully decided
    // on before going silent is flushed too (`flushAccumulated`, below) — a pause never gets to
    // discard real, completed work, matching the status line's own promise.
    if (outerAc.signal.aborted && !signal?.aborted) {
      pausedByIdle = true;
      agent.idleWatchdog.markPossibleOrphan(endpoint.id); // (D)
      // Flush BEFORE the status note: a tool call the model already fully decided on is real
      // work, not a symptom of the pause, and the loop needs it in order to actually run it.
      yield* flushAccumulated();
      const idleS = Math.round(watchdog.idleForMs() / 1000);
      yield {
        kind: "status",
        text: `⏸ ${model} has been silent for ${idleS}s — pausing this turn (no work lost). Send any message, or /continue, to resume.`,
      };
    } else if (!(isAbortError(err) || signal?.aborted)) {
      yield {
        kind: "text",
        text: `model error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } finally {
    watchdog.dispose();
    if (signal) signal.removeEventListener("abort", onUserAbort);
    // Runs on EVERY exit — normal completion, the abort break, or an error thrown above —
    // so the reader's lock and the underlying connection are never left dangling. `cancel()`
    // on an already-closed/errored reader is a documented no-op, not a throw.
    await reader?.cancel().catch(() => {});
  }
  if (pausedByIdle) {
    yield { kind: "paused", idleMs: watchdog.idleForMs() };
    return;
  }
  /**
   * A turn that produced NOTHING says so.
   *
   * Nothing downstream could tell "the model answered with silence" from "the model was cut off
   * mid-thought": both arrived as a bare `final` with no text, the hosts skip an empty reply,
   * and the transcript recorded only `{"kind":"done"}`. The user saw the thinking stream, then
   * the clock, then nothing — and concluded Prometheus had stopped working.
   *
   * Yielded as `text` so it IS the turn's reply: visible in the pane, persisted in the
   * transcript, and carried into the next prompt, where it tells the model its previous attempt
   * was truncated rather than leaving a hole in the conversation.
   */
  if (observed.nativeCalls === 0 && observed.textCalls === 0) {
    if (observed.receivedText.trim() === "") {
      yield {
        kind: "text",
        text: ai.emptyTurnNotice({
          ...(stopReason ? { stopReason } : {}),
          sawReasoning,
          promptTokens: estimatedPromptTokens,
          contextWindow: endpoint.contextWindow,
          runtime,
        }),
      };
    } else if (stopReason === "length") {
      // There IS an answer, but the provider says it was cut short: flag it rather than let a
      // half-written file or a truncated explanation read as complete.
      yield {
        kind: "text",
        text: `\n\n${ai.truncationNotice({
          stopReason,
          promptTokens: estimatedPromptTokens,
          contextWindow: endpoint.contextWindow,
          runtime,
        })}`,
      };
    }
    yield { kind: "final" };
  }
}

/** Stream scanned prose, collecting any tool calls found in it. Shared by both transports. */
function* pumpText(
  events: agent.protocol.ScanEvent[],
  sink: agent.protocol.TextToolCall[],
): Generator<LlmTurn> {
  for (const ev of events) {
    if (ev.kind === "text") {
      if (ev.text) yield { kind: "text", text: ev.text };
    } else if (ev.kind === "call") sink.push(ev.call);
    // A malformed call on the NATIVE path is left as prose: the model has a working structured
    // channel, so half-written markup is far more likely to be it talking about a call than
    // attempting one.
  }
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
 * Tool calls reach the model by ONE of two transports, chosen per turn by
 * `negotiateTransport` and corrected by what the endpoint actually does:
 *
 *   - NATIVE (`toolTurn`): send `tools:[…]`, read `delta.tool_calls` off the SSE.
 *   - TEXT: send no `tools`, teach the call syntax in the preamble, and read the
 *     calls back out of the model's prose with core's `ToolCallScanner`.
 *
 * The text transport is what makes this work at all on the endpoints Prometheus is
 * most often pointed at. `endpoint.supportsTools` is a GUESS — `connectors/
 * localServe.ts` defaults it true for every local runner, `orchestration/
 * backends.ts` hard-codes it false for own-key cloud — and it used to be a cliff:
 * false meant the model got an empty tool list and could only ever describe the
 * work. Now it only decides the opening move.
 *
 * Text calls are scanned for on BOTH paths. A small local model handed a perfectly
 * good native channel very often answers with `<tool_call>` prose anyway, and
 * dropping those is indistinguishable, to the user, from the model refusing to act.
 */

/**
 * Build this endpoint's health record (transport, breaker, context window) after a turn — the
 * Model Health feature (`/model-health`, and the desktop's Settings ▸ Model Health page).
 *
 * Deliberately does NOT write anything itself: every other per-turn side effect on this
 * client (`onUsage`, `onCapability`) is an OPTIONAL INJECTED CALLBACK that the host wires to
 * a real implementation and a test simply omits — a client built with no `onModelHealth`
 * (every existing test) must be a complete no-op, not a write to the real
 * `~/.prometheus/state/model-health.json` on whatever machine happens to run the suite.
 *
 * `contextWindowSource` is approximated rather than threaded through as its own dep: a host
 * that successfully probed the real window already folds the measured number into
 * `endpoint.contextWindow` before this client is (re)built for the next message (see
 * session-bridge.ts's/host.ts's `probeContextWindow` wiring), so a LOCAL endpoint whose
 * current number is still the bare default is treated as unmeasured, and any other number as
 * measured. The only case this mislabels is a local model whose real window happens to BE
 * exactly the default (8192) — an honest, harmless edge case, not a wrong warning.
 */
function buildModelHealthRecord(
  endpoint: AiEndpoint,
  capability: ToolCapabilityState,
  transport: agent.protocol.ToolTransport,
): ai.EndpointHealthRecord | undefined {
  if (transport === "none") return undefined; // nothing was offered — nothing learned.
  return ai.buildHealthRecord({
    endpointId: endpoint.id,
    model: endpoint.model ?? endpoint.id,
    locality: endpoint.locality,
    transport,
    capability,
    breaker: endpointBreaker(endpoint.id).snapshot(),
    contextWindow: endpoint.contextWindow,
    contextWindowSource:
      endpoint.locality === "cloud"
        ? "declared"
        : endpoint.contextWindow === DEFAULT_CONTEXT_WINDOW
          ? "default"
          : "ollama",
    nowIso: new Date().toISOString(),
  });
}
export function makeLlmClient(endpoint: AiEndpoint, deps: LlmClientDeps = {}): LLMClient {
  const policy: WorkspacePolicy = deps.policy ?? { neverSendToCloud: false };
  const { policy: _omit, signal, ...aiDeps } = deps;
  const client: AiClient = createAiClient(endpoint, policy, aiDeps);
  // What this endpoint has been observed to actually do, accumulated across the session.
  // Owned per-client so a `/model` switch starts a fresh hypothesis.
  let capabilityState: ToolCapabilityState = deps.capability ?? agent.protocol.initialCapability();

  /**
   * CLI-029 accounting, shared by both transports.
   *
   * Extracted because the native branch `return`ed before the inline copy ever ran, so the
   * expensive turns — the agentic ones — were the only turns that cost nothing on the budget
   * report. SSE usage is exact; otherwise chars/4 over the EXACT text sent + received, flagged
   * estimated (a spend FLOOR for budget math, never a ceiling).
   */
  function recordUsage(usage: SseTokenUsage | undefined, sent: Msg[], received: string): void {
    if (!deps.onUsage) return;
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
          promptTokens: approxTokens(sent.map((m) => m.content).join("\n")),
          completionTokens: approxTokens(received),
          estimated: true,
          atIso: nowIso,
        };
    deps.onUsage(rec);
  }

  // The model's effort capability is a property of the endpoint, so resolve it once here and
  // only the TIER varies per turn. `deps.effortCapability` lets the host pass a probe-backed
  // capability (Ollama /api/show) instead of the name-matched guess.
  const capability: EffortCapability =
    deps.effortCapability ??
    resolveCapability(
      {
        modelId: endpoint.model ?? endpoint.id,
        runtime: runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
        locality: endpoint.locality,
        probedCapabilities: endpoint.probedCapabilities,
      },
      deps.effortRules,
    ).cap;

  return {
    async *turn(thread: Thread, tuning: AgentTuning, tools: ToolDef[]): AsyncIterable<LlmTurn> {
      // The `/think` tier finally reaches the wire (it was stored and discarded here before).
      // `resolveEffort` returns null-applied for a model with no knob, and `applyEffort`
      // then adds nothing — so an unsupported model is a no-op, never a 400.
      const effort = tuning.effort
        ? resolveEffort(tuning.effort, capability, {
            // `--force-effort` / `[agent] effortForce`. Off by default; when on, the resolution
            // comes back `degraded.reason:"forced"` so the override is never mistaken for
            // support this table vouched for.
            ...(tuning.effortForce ? { force: true } : {}),
          })
        : undefined;
      /**
       * The WIRE's tool capability is part of the opening guess, not a discovery.
       *
       * `endpoint.supportsTools` is set to `true` for every own-key cloud endpoint
       * (`ai/cloud-endpoints.ts`), including Anthropic and Gemini — whose wire formats in
       * `ai/wire.ts` declare `supportsTools: false`. Opening in `native` on those meant
       * `toolTurn` got as far as building the request, noticed the mismatch, emitted a status
       * line and `final`, and RETURNED WITH NO ANSWER. The demotion was recorded in the
       * `finally`, so the SECOND prompt worked — the user's first one was simply eaten, which
       * reads exactly like the model ignoring them.
       *
       * This is knowable before the request, so it belongs in the opening guess. `observed`
       * still overrides it in both directions, so a wire that later grows tool support is not
       * pinned to the text protocol.
       */
      const wireCarriesTools = ai.selectWire(
        ai.runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
      ).supportsTools;
      // `let`, not `const`: a native attempt that gets rejected for tools falls through to a
      // same-turn text retry below, which reassigns this so the text-transport code (and the
      // capability observation it records) reflects what actually happened this turn.
      let transport = agent.protocol.negotiateTransport({
        toolCount: tools.length,
        declaredNative: endpoint.supportsTools && wireCarriesTools,
        observed: capabilityState,
      });
      /**
       * TRIM BEFORE SENDING, rather than refusing at the door.
       *
       * Compaction only ever ran BETWEEN turns, from the host — so it could not help where a
       * session actually overflows, which is inside a long agentic turn. Rounds three through
       * thirty append tool output to the thread with nothing watching, and the first thing
       * that noticed was `preflightContext`, whose only move is to refuse. The result was a
       * turn that failed halfway through real work, after the user had committed to it, with
       * "the request does not fit" — while the mechanism for making it fit sat one layer up,
       * waiting for the turn to end.
       *
       * So the thread is budgeted here, every round, against the model's REAL window. This is
       * the one place that always runs and always knows the window; putting it behind an
       * optional dep on the loop would have made it the codebase's signature defect — a
       * complete implementation nothing calls.
       *
       * `carryForward` drops whole rounds and elides old tool output, never splitting a
       * call/result pair, so what is sent is always a request the provider will accept.
       */
      const budget = agent.carryBudgetFor(endpoint.contextWindow);
      const body = threadToMessages(thread);
      const trimmed = agent.carryForward(body, { budgetTokens: budget }) as ThreadMsg[];
      /**
       * Count what `carryForward` actually governs.
       *
       * It returns the CONVERSATION only — the system messages are stripped and re-added below
       * by `withPreamble`, which is why the line under this one filters them back out of `body`.
       * Comparing raw lengths therefore counted every system message as "dropped": on the very
       * first turn of a session, with a 100k budget and nothing trimmed at all, `body` is
       * [system, steering, repo map, user] and `trimmed` is [user] — so every single round
       * printed "3 older message(s) dropped from this turn". A warning that fires when nothing
       * happened trains the user to ignore it, which is worse than not having it: the turn where
       * context really IS being lost looks identical to all the others.
       */
      const carried = body.filter((m) => m.role !== "system");
      const dropped = carried.length - trimmed.length;
      if (dropped > 0) {
        yield {
          kind: "status",
          text: `⎿ context trimmed to fit ${endpoint.model ?? endpoint.id}: ${dropped} older message(s) dropped from this turn`,
        };
      }
      // The preamble is merged into the OUTGOING system message only — never into the
      // persisted thread. It is derived state (it changes with the transport and with the
      // exposed tool set), so storing it would pin one turn's answer into the transcript.
      let messages = withPreamble(
        [...body.filter((m) => m.role === "system"), ...trimmed],
        tools,
        transport,
        endpoint.contextWindow,
        capabilityState.textSyntaxCalls > 0,
        deps.turnScopeSpentTokens,
        endpoint.locality,
      );

      if (transport === "native") {
        const observed = {
          nativeCalls: 0,
          textCalls: 0,
          rejectedForTools: false,
          receivedText: "",
        };
        let toolUsage: SseTokenUsage | undefined;
        // `finally`, NOT straight-line code after the `yield*`.
        //
        // `runAgentTurn` BREAKS its `for await` the moment it sees `final`, which invokes
        // this generator's `.return()` — so anything written after the delegation simply
        // never runs on a turn that ended with `final`, i.e. every turn that produced an
        // answer rather than a tool call. The accounting and the capability observation were
        // both being dropped on exactly those turns, and no unit test could see it because a
        // test that drains the iterator directly never breaks early. A live cloud round-trip
        // reported two rounds served and one usage record, which is how this surfaced.
        try {
          yield* toolTurn(endpoint, messages, tools, policy, signal, effort, deps.fetch, observed, {
            ...(deps.resolveKey ? { resolveKey: deps.resolveKey } : {}),
            // Applies whether or not a `/think` tier was ever set: an R1-style model leaks its
            // inline `<think>` regardless of what effort was requested.
            ...(capability.reasoningTag ? { reasoningTag: capability.reasoningTag } : {}),
            ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
            ...(deps.idleWatchdogNow ? { idleWatchdogNow: deps.idleWatchdogNow } : {}),
            ...(deps.idleWatchdogSetTimeout
              ? { idleWatchdogSetTimeout: deps.idleWatchdogSetTimeout }
              : {}),
            ...(deps.idleWatchdogClearTimeout
              ? { idleWatchdogClearTimeout: deps.idleWatchdogClearTimeout }
              : {}),
            ...(deps.onLocalActivity ? { onLocalActivity: deps.onLocalActivity } : {}),
            // The user's `prompt-caching` switch, honoured on the path that actually sends
            // `cache_control`. `shouldRequestPromptCache` also answers "does this provider
            // support it", which `applyPromptCache` already handles per dialect — so what
            // travels here is only the half that was missing: the human's decision.
            ...(deps.promptCache === false ? { promptCache: false } : {}),
            /**
             * MERGED, not overwritten.
             *
             * Anthropic reports a turn's usage across TWO frames: `message_start` carries
             * `input_tokens` plus the prompt-cache counters, and `message_delta` later carries
             * `output_tokens` with `input_tokens: 0`. Assigning each frame in turn meant the
             * last one won, so every agentic Anthropic turn was recorded as
             * `promptTokens: 0` — /cost, the session usage report, the budget gate and the USD
             * cap all under-counted by the entire input side, usually the larger half of the
             * bill, and both cache counters vanished. Reproduced against a live HTTP server:
             * a stream carrying input_tokens 12345 / cache_read 9000 / cache_create 500
             * recorded `{promptTokens: 0, completionTokens: 77}`.
             *
             * `mergeWireUsage` is the same recombiner core's own `chat()` and the desktop
             * transport already use — this was the one transport of three that did not.
             */
            onUsage: (u) => {
              toolUsage = ai.mergeWireUsage(toolUsage, u);
            },
          });
        } finally {
          capabilityState = agent.protocol.observeTurn(capabilityState, {
            transport,
            nativeCalls: observed.nativeCalls,
            textCalls: observed.textCalls,
            rejectedForTools: observed.rejectedForTools,
          });
          deps.onCapability?.(capabilityState);
          recordUsage(toolUsage, messages, observed.receivedText);
          const health = buildModelHealthRecord(endpoint, capabilityState, transport);
          if (health) deps.onModelHealth?.(health);
        }
        if (!observed.rejectedForTools) return;
        /**
         * The endpoint just proved (or, for a statically-known-incapable wire, confirmed) it
         * cannot carry native tools THIS turn. `observeTurn` above already recorded the
         * demotion for every turn after, but stopping here with no answer is exactly what
         * silently ate the user's first message to a fresh local endpoint — see the comment
         * on `wireCarriesTools` above. Retry the SAME turn in the text protocol rather than
         * leaving them with nothing; `toolTurn` already told the user this was happening via
         * its own status line, and it yielded no `final`, so we are still running normally
         * here rather than via a `.return()`-driven teardown.
         */
        transport = "text";
        messages = withPreamble(
          [...body.filter((m) => m.role === "system"), ...trimmed],
          tools,
          transport,
          endpoint.contextWindow,
          capabilityState.textSyntaxCalls > 0,
          deps.turnScopeSpentTokens,
          endpoint.locality,
        );
      }

      // ── the TEXT transport (and the plain no-tools chat path) ──────────────────
      // One scanner for the whole turn: a call routinely spans several SSE deltas, so the
      // hold-back has to live across them.
      const scanner = transport === "text" ? new agent.protocol.ToolCallScanner() : undefined;
      /**
       * The SAME inline-`<think>` splitter the native path uses, on the path that actually
       * needs it more.
       *
       * P4 wired `toolTurn` and the desktop's main-process stream and called that "both
       * transports". It is not: THIS path serves every no-tools chat AND every model demoted
       * from native — and a demoted small local model is precisely the population that emits
       * R1-style inline thinking. Without this, `<think>…</think>` reached the transcript as
       * the answer and was fed to `scanner` below, where a model reasoning aloud about a tool
       * call could trip the text protocol into making one.
       *
       * A no-op pass-through when the capability names no tag, so the ordinary path stays
       * byte-identical.
       */
      const reasoningSplit = ai.createReasoningTagSplitter(capability.reasoningTag);
      const calls: agent.protocol.TextToolCall[] = [];
      const malformed: agent.protocol.MalformedToolCall[] = [];
      /** Route one scanned event: prose streams live, calls are held until the turn ends. */
      // Tracked separately from `received`, which still counts bytes the scanner consumed as
      // protocol. A turn whose ENTIRE output was a stray `</tool_call>` has a non-empty
      // `received` and nothing to show the user — see the empty-turn handling below.
      let shownText = "";
      /** The REQUEST failed (refused, unreachable, unauthorised) — distinct from a turn that
       *  ran and produced nothing, which is what the synthetic correction below is for. */
      let requestFailed = false;
      const pump = function* (events: agent.protocol.ScanEvent[]): Generator<LlmTurn> {
        for (const ev of events) {
          if (ev.kind === "text") {
            if (ev.text) {
              shownText += ev.text;
              yield { kind: "text", text: ev.text };
            }
          } else if (ev.kind === "call") calls.push(ev.call);
          else malformed.push(ev.error);
        }
      };

      let any = false;
      let usage: SseTokenUsage | undefined;
      let received = "";
      let pausedIdleMs: number | undefined;
      try {
        // thread the signal so fetch() aborts AND the SSE reader is cancelled — a bare
        // fetch abort still lets the parser drain buffered bytes (post-abort deltas).
        //
        // idleTimeoutMs/idleWatchdog* thread through to `stream()`'s own `IdleWatchdog` (see
        // `ai/client.ts`) — this transport used to have ZERO inactivity protection, the ONLY
        // one of the four the repo runs (native tool-calling, text-fallback, VS Code, the
        // background summarizer) with that gap, so a cold-loading or wedged model on THIS path
        // hung forever instead of pausing like `toolTurn` already did.
        for await (const chunk of client.chat(flattenToolRoles(messages), {
          // With tools exposed, an empty turn is CORRECTED (the synthetic "nothing usable"
          // call below) rather than narrated; with none, there is nothing to correct toward,
          // so the client's own notice is what keeps the turn from ending in silence.
          emptyTurnNotice: transport === "none",
          ...(signal ? { signal } : {}),
          ...(effort ? { effort } : {}),
          ...(deps.idleTimeoutMs !== undefined ? { idleTimeoutMs: deps.idleTimeoutMs } : {}),
          ...(deps.idleWatchdogNow ? { idleWatchdogNow: deps.idleWatchdogNow } : {}),
          ...(deps.idleWatchdogSetTimeout
            ? { idleWatchdogSetTimeout: deps.idleWatchdogSetTimeout }
            : {}),
          ...(deps.idleWatchdogClearTimeout
            ? { idleWatchdogClearTimeout: deps.idleWatchdogClearTimeout }
            : {}),
        })) {
          if (signal?.aborted) break; // stop yielding the instant Ctrl-C fires
          if (chunk.delta) {
            any = true;
            received += chunk.delta;
            // Thinking comes out FIRST, and never reaches `scanner`.
            const split = reasoningSplit.push(chunk.delta);
            if (split.reasoning) yield { kind: "reasoning", text: split.reasoning };
            if (split.text) {
              // With no tools exposed there is nothing to scan for, so the delta streams
              // straight through and the transcript is byte-identical to before.
              if (scanner) yield* pump(scanner.push(split.text));
              else yield { kind: "text", text: split.text };
            }
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.done) break;
        }
        // Drain the splitter BEFORE the scanner, so its tail still reaches the scanner. An
        // unterminated `<think>` flushes as reasoning — a model cut off mid-thought was still
        // thinking, and promoting a truncated deliberation to "the answer" is the failure this
        // exists to prevent.
        const reasoningTail = reasoningSplit.end();
        if (reasoningTail.reasoning) {
          yield { kind: "reasoning", text: reasoningTail.reasoning };
        }
        if (reasoningTail.text) {
          if (scanner) yield* pump(scanner.push(reasoningTail.text));
          else yield { kind: "text", text: reasoningTail.text };
        }
        if (scanner) yield* pump(scanner.end());
      } catch (err) {
        if (err instanceof ModelIdlePausedError) {
          // A PAUSE, not a failure — nothing discarded: the `text`/tool-call events already
          // yielded above are already folded into the caller's thread by the time it sees the
          // `paused` LlmTurn below, exactly like the native `toolTurn`'s own idle pause.
          agent.idleWatchdog.markPossibleOrphan(endpoint.id);
          pausedIdleMs = err.idleMs;
          yield {
            kind: "status",
            text: `⏸ ${endpoint.model ?? endpoint.id} has been silent for ${Math.round(err.idleMs / 1000)}s — pausing this turn (no work lost). Send any message, or /continue, to resume.`,
          };
        } else if (isAbortError(err) || signal?.aborted) {
          // abort is NOT an error: swallow it into the interrupted path (never retry —
          // an AbortError counting toward resilience would silently re-request).
          // intentionally silent
        } else {
          // a refused/unreachable endpoint becomes an honest text turn, not a crash.
          requestFailed = true;
          // ACTIVE EVICTION: this endpoint's local runner was JUST force-stopped under critical
          // RAM pressure (possibly by a DIFFERENT Prometheus shell's watchdog) — the same
          // "end the turn, never hammer a dead endpoint" contract as any other refused/
          // unreachable endpoint, but with the honest reason instead of a raw connection-error
          // string the user has to puzzle out. See engine-bridge's eviction-log.ts.
          const recentEviction = findRecentEviction(ai.runnerForBaseUrl(endpoint.baseUrl)?.id);
          if (recentEviction && !any) {
            yield {
              kind: "text",
              text: `⏸ ${endpoint.model ?? endpoint.id} was stopped to prevent a machine-wide freeze (${recentEviction.reason}). Try again once resources are available — Prometheus will bring it back automatically.`,
            };
          } else if (!any) {
            const message = err instanceof Error ? err.message : String(err);
            yield { kind: "text", text: `model error: ${message}` };
          }
        }
      }
      recordUsage(usage, messages, received);
      if (pausedIdleMs !== undefined) {
        // A call (or a malformed one) the model already fully produced before going silent is
        // real work, not a symptom of the pause — flush it before reporting `paused` (verification
        // pass #2's CRITICAL finding: this used to `return` here unconditionally, silently
        // discarding an already-complete `<tool_call>` the scanner had fully parsed, contradicting
        // the status line's own "no work lost" promise). Deliberately NOT the empty-turn synthetic
        // correction below (that's for a turn that genuinely finished saying nothing) and NOT the
        // capability/model-health bookkeeping after it (a paused turn is not a completed one).
        for (const bad of malformed) {
          yield {
            kind: "tool_call",
            call: { name: MALFORMED_CALL_TOOL, args: { reason: bad.reason, wrote: bad.raw } },
          };
        }
        for (const call of calls) {
          yield { kind: "tool_call", call: { name: call.name, args: call.args } };
        }
        yield { kind: "paused", idleMs: pausedIdleMs };
        return;
      }

      // An EMPTY turn: no prose, no call, nothing malformed. A real gemma4:12b does this by
      // opening a turn with a stray `</tool_call>` and stopping — the scanner correctly
      // discards the residue, and what is left is a turn that answered nothing. Ending there
      // hands the user a blank reply and calls it done. Feeding it back as a correction costs
      // one round (bounded by maxRounds) and usually recovers, for the same reason a
      // malformed call does: the model cannot fix what it is never told about.
      if (
        transport === "text" &&
        calls.length === 0 &&
        malformed.length === 0 &&
        shownText.trim() === "" &&
        // NOT an empty turn — a turn that never happened.
        //
        // `shownText` grows only through `pump`, and the `model error: …` line above is yielded
        // straight to the consumer, so a 401 or a dead endpoint left every one of these four
        // conditions true. The model was then told "you replied with nothing usable" — about a
        // reply it was never asked for — and the loop re-requested the same dead endpoint every
        // round to the cap, printing the same error each time. A failure must END the turn.
        !requestFailed &&
        !signal?.aborted
      ) {
        malformed.push({
          raw: received.slice(0, 200),
          dialect: "tool_call_tag",
          reason: "you replied with nothing usable — call a tool, or answer the question",
        });
      }

      // A call the model MEANT but wrote wrongly is surfaced as an unexposed-tool call, so it
      // comes back through the loop as a `[tool_result]` the model can correct on the next
      // round. Silently dropping it is what makes a small model repeat the same broken syntax
      // until the round cap: it never learns that anything went wrong.
      for (const bad of malformed) {
        yield {
          kind: "tool_call",
          call: { name: MALFORMED_CALL_TOOL, args: { reason: bad.reason, wrote: bad.raw } },
        };
      }
      for (const call of calls) {
        yield { kind: "tool_call", call: { name: call.name, args: call.args } };
      }
      capabilityState = agent.protocol.observeTurn(capabilityState, {
        transport,
        nativeCalls: 0,
        textCalls: calls.length,
      });
      deps.onCapability?.(capabilityState);
      {
        const health = buildModelHealthRecord(endpoint, capabilityState, transport);
        if (health) deps.onModelHealth?.(health);
      }
      // `final` ONLY when nothing was called. Emitting it alongside calls is what made the
      // native path single-round — the loop now folds results regardless, but a transport
      // that says "I am done" while asking for a tool is lying about its own state.
      if (calls.length === 0 && malformed.length === 0) yield { kind: "final" };
    },
  };
}

/**
 * The reserved name an unreadable call is reported under.
 *
 * Core owns it (`agent/protocol/feedback.ts`) because the LOOP is what must recognise it: an
 * earlier version defined it here and let it fall through the loop's "tool is not exposed"
 * branch, which replaced the diagnosis with a message about a tool that was never called.
 */
const MALFORMED_CALL_TOOL = agent.protocol.PROTOCOL_FEEDBACK_TOOL;

/**
 * Merge the tool preamble into the outgoing system message.
 *
 * The host's prompt is kept first and whole (it carries the persona and any `/system`
 * override), and a session with no system message gets one rather than going out with the
 * tool list buried in the user's turn.
 */
/**
 * Fold the loaded personas into `spawn_agent`'s description.
 *
 * A persona nobody told the model about is a persona nobody uses. The names go in the tool's
 * own description rather than a separate prompt block so they travel with the tool through the
 * preamble's degrade ladder — and disappear with it when the budget is tight, instead of
 * outliving the tool they belong to.
 */
export function withPersonas(tools: ToolDef[], personas: readonly agent.LoadedAgent[]): ToolDef[] {
  if (personas.length === 0) return tools;
  const list = personas.map((p) => `${p.name} (${p.description})`).join("; ");
  return tools.map((t) =>
    t.name === "spawn_agent"
      ? { ...t, description: `${t.description} Custom roles available: ${list}.` }
      : t,
  );
}

function withPreamble(
  messages: ThreadMsg[],
  tools: ToolDef[],
  transport: agent.protocol.ToolTransport,
  contextWindow?: number,
  demonstrated?: boolean,
  turnScopeSpentTokens?: number,
  locality: "local" | "cloud" | "unknown" = "unknown",
): ThreadMsg[] {
  if (transport === "none" || tools.length === 0) return messages;
  // ROUND-SCOPE dispatch: the tool catalog is the only built-in contributor whose content
  // depends on the transport negotiated for THIS round, so it is assembled here — once per
  // round, exactly where it was assembled before — rather than at thread-build time with
  // everything else. See `agent/protocol/contributors/tool-catalog.ts`.
  //
  // `locality` is threaded from the real endpoint (rather than left "unknown") for consistency
  // with Desktop's/VS Code's round-scope ctx, even though `CORE_ROUND_CONTRIBUTORS` (today, just
  // tool-catalog) does not itself read it — a latent-drift guard for the next contributor
  // registered here, not a live behavior change (verification pass #2's LOW finding).
  const preambleCtx: agent.protocol.PreambleCtx = {
    surface: "cli",
    isSubAgent: false,
    readOnly: false,
    locality,
    ...(contextWindow ? { contextWindow } : {}),
    transport,
    ...(demonstrated ? { demonstratedToolSyntax: demonstrated } : {}),
    tools,
  };
  // ONE combined pool across BOTH assemblies, not two independent ones: `runMessageTurn`'s
  // turn-scope pass (tool-discipline/pre-write-recheck/effort-text) already spent
  // `turnScopeSpentTokens` of this SAME ceiling before this round-scope pass (tool-catalog) ever
  // runs — without subtracting it, a model whose turn-scope contributors used nearly the whole
  // budget still got tool-catalog's own FULL budget on top, on every single round.
  const roundBudget = Math.max(
    0,
    agent.protocol.instructionBudget(contextWindow) - (turnScopeSpentTokens ?? 0),
  );
  const assembled = agent.protocol.assemblePreamble(
    agent.protocol.CORE_ROUND_CONTRIBUTORS,
    preambleCtx,
    roundBudget,
  );
  if (!assembled.personaAppend) return messages;
  const at = messages.findIndex((m) => m.role === "system");
  if (at === -1) return [{ role: "system", content: assembled.personaAppend }, ...messages];
  const base = (messages[at]?.content ?? "").trim();
  const merged = base ? `${base}\n\n${assembled.personaAppend}` : assembled.personaAppend;
  return messages.map((m, i) => (i === at ? { ...m, content: merged } : m));
}

/* ------------------------------------------------------------------------- *
 * makeToolRunner — run a broker-approved ToolDef through the engine bridge
 * ------------------------------------------------------------------------- */

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
  /**
   * REFUSE a file whose bytes do not round-trip through UTF-8.
   *
   * `readFileSync(abs, "utf8")` does not throw on binary — it substitutes U+FFFD for every
   * invalid sequence — so this read "succeeded", the splice ran against the lossy string, and
   * `atomicWrite` put that back on disk as the file. Measured: a 1032-byte PNG became 2058 bytes
   * of replacement characters, reported as `ok: true, "edited logo.png (1 hunk(s))"`. Worse, the
   * pre-image recorded for `/revert` was the same lossy text, so the corruption could not be
   * undone. The identical mistake was already fixed once in `delete_file`; `readTextExact` is
   * that fix, shared, so the two cannot drift apart again.
   */
  let content: string;
  try {
    const text = readTextExact(abs);
    if (text === null) {
      return {
        outcome: {
          ok: false,
          summary: `propose_edit: ${rawPath} is not a UTF-8 text file — refusing to edit it. Editing it as text would rewrite every byte that is not valid UTF-8 and destroy the file.`,
        },
      };
    }
    content = text;
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
    // `propose_edit` only edits files it just read — the file existed by construction.
    record: { path: abs, preImage: content, existed: true },
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
): { outcome: ToolOutcome; record?: EditRecord; unrevertable?: string } {
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
  // Capture the pre-image (for revert): existing content, or "" when the file is new.
  // `readTextExact`, not `readFileSync(abs, "utf8")`: the raw read never throws on binary, it
  // returns U+FFFD mush, and /revert then wrote that mush over the original bytes (the same
  // defect already closed for delete_file, move_file and redirects). And `existed` comes from
  // existsSync, not from the read succeeding: an existing but unreadable file was recorded as
  // "did not exist", so /revert DELETED it. A file whose bytes do not round-trip is simply not
  // revertible, and no record is kept for it.
  const existed = existsSync(abs);
  let preImage = "";
  let revertible = true;
  if (existed) {
    try {
      const text = readTextExact(abs);
      if (text === null) revertible = false;
      else preImage = text;
    } catch {
      revertible = false;
    }
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
  const note = revertible ? "" : " — not revertible: the old contents were binary or unreadable";
  return {
    outcome: {
      ok: true,
      summary: `${verb} ${rawPath} (${lines} line${lines === 1 ? "" : "s"})${note}`,
    },
    // `existed` is what makes a CREATE revertible to nothing rather than to an empty file.
    ...(revertible ? { record: { path: abs, preImage, existed } } : { unrevertable: abs }),
  };
}

/**
 * `apply_patch` — resolve every hunk in every file, then write, or write nothing.
 *
 * The path guard runs over ALL files before any resolution, so a patch that reaches outside
 * the working set is refused whole rather than applying its in-scope half.
 */
function applyMultiFilePatch(
  args: Record<string, unknown>,
  roots: string[] | undefined,
  cwd: string,
  approvedOutside?: ReadonlySet<string>,
): { outcome: ToolOutcome; records: EditRecord[] } {
  const files = agent.parsePatchFiles(args.edits);
  if (files.length === 0) {
    return {
      outcome: { ok: false, summary: "apply_patch: edits must be [{path, hunks:[{old,new}]}]" },
      records: [],
    };
  }
  /**
   * A malformed hunk fails the WHOLE patch, exactly as it does for propose_edit above.
   *
   * The parser used to discard hunks that were not `{old:string, new:string}` and say nothing,
   * so a patch with one bad hunk among good ones applied the survivors and reported ok — and
   * `describePatch` printed the reduced count as though it were the whole change. For the
   * atomic multi-file tool that is the precise failure it exists to prevent: a partially
   * applied refactor, reported as success, with no signal that anything was missing.
   */
  const droppedHunks = files.reduce((n, f) => n + f.dropped, 0);
  if (droppedHunks > 0) {
    const where = files
      .filter((f) => f.dropped > 0)
      .map((f) => `${f.path} (${f.dropped})`)
      .join(", ");
    return {
      outcome: {
        ok: false,
        summary: `apply_patch: ${droppedHunks} hunk(s) malformed (each needs string old+new) in ${where} — nothing applied`,
      },
      records: [],
    };
  }
  // Resolve every path FIRST — a refusal must not leave earlier files already written.
  const abs = new Map<string, string>();
  for (const f of files) {
    const r = resolveMutatePath("apply_patch", f.path, roots, cwd, approvedOutside);
    if (!r.ok) return { outcome: { ok: false, summary: r.summary }, records: [] };
    abs.set(f.path, r.abs);
  }
  const preImages = new Map<string, string>();
  // `readTextExact`, not `readFileSync(..., "utf8")` — the same fix propose_edit, write_file,
  // delete_file and move_file already carry. The raw read never throws on non-UTF-8 bytes; it
  // returns U+FFFD mush, so one hunk in the ASCII part of a Latin-1 file rewrote every other
  // byte of it, reported ok, and recorded the mush as the pre-image /revert would restore.
  let nonText: string | undefined;
  const result = agent.resolvePatch(files, (p) => {
    try {
      const text = readTextExact(abs.get(p) as string);
      if (text === null) {
        nonText ??= p;
        return null;
      }
      preImages.set(p, text);
      return text;
    } catch {
      return null;
    }
  });
  // Checked before `result.ok`: a null read would otherwise be reported as a missing file.
  if (nonText !== undefined) {
    return {
      outcome: {
        ok: false,
        summary: `apply_patch: nothing was written — ${nonText} is not a UTF-8 text file; refusing to edit it`,
      },
      records: [],
    };
  }
  if (!result.ok) {
    // `result.message` already carries its own `hunk N:` label (0-based, from the edit ladder).
    // Prefixing a second, 1-BASED one produced "src/math.ts hunk 1: hunk 0: old text not found"
    // — two labels and two different numbers for one hunk, which is worse than no label at all.
    return {
      outcome: {
        ok: false,
        summary: `apply_patch: nothing was written — ${result.path}: ${result.message}`,
      },
      records: [],
    };
  }
  const records: EditRecord[] = [];
  for (const f of result.files) {
    const target = abs.get(f.path) as string;
    try {
      atomicWrite(target, f.next);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // A mid-write failure is the one case the two-phase design cannot fully prevent (the
      // disk can still refuse). Report exactly how far it got so the user can /revert.
      return {
        outcome: {
          ok: false,
          summary: `apply_patch: wrote ${records.length} of ${result.files.length} files, then ${f.path} failed: ${detail} — use /revert`,
        },
        records,
      };
    }
    // `resolvePatch` refuses a missing file (`no-file`), so every patched path existed.
    records.push({ path: target, preImage: preImages.get(f.path) ?? "", existed: true });
  }
  return {
    outcome: { ok: true, summary: agent.describePatch(result.files, result.totalHunks) },
    records,
  };
}

/* ── Tier W: the file mutators (delete / move / mkdir) ──────────────────────── */

/**
 * Resolve a Tier-W path argument and enforce the working-set boundary.
 *
 * The SAME rule `applyWriteFile` uses, and for the same reason: these tools have no scope
 * guard of their own — the human confirm IS their authorization — so an out-of-scope target
 * must have been approved for THIS exact path, or it is refused. `mkdir` is included: a
 * directory created outside the working set is how a subsequent write gets a home there.
 */
function resolveMutatePath(
  tool: string,
  raw: unknown,
  roots: string[] | undefined,
  cwd: string,
  approvedOutside?: ReadonlySet<string>,
): { ok: true; abs: string; raw: string } | { ok: false; summary: string } {
  const rawPath = typeof raw === "string" ? raw : "";
  if (!rawPath || rawPath.startsWith("-")) {
    return { ok: false, summary: `${tool}: refusing invalid path: ${rawPath}` };
  }
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  if (roots && roots.length > 0 && !isPathAllowed(abs, roots) && !approvedOutside?.has(abs)) {
    return {
      ok: false,
      summary: `${tool}: path outside the working set (not approved): ${rawPath}`,
    };
  }
  return { ok: true, abs, raw: rawPath };
}

/**
 * Restore a kept pre-image (revertLastEdit). Returns true on success.
 *
 * A record whose file DID NOT EXIST is reverted by DELETING it. Writing `preImage` back was
 * the old behaviour and it was wrong in the one case users notice: undoing "create this file"
 * left a zero-byte file behind, which a build then tried to compile. `existed === undefined`
 * still writes, so an older record keeps its old meaning.
 */
export function revertEdit(record: EditRecord): boolean {
  try {
    if (record.existed === false) {
      // Already gone is a SUCCESS: the state the caller asked for is the state on disk.
      if (existsSync(record.path)) rmSync(record.path);
      return true;
    }
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
 *
 * `checkpoint`, when given, folds each successfully-applied intent's pre-image into it — without
 * this, /apply wrote real files but NEVER recorded a checkpoint (the pre-image `record` was
 * silently discarded), so `/checkpoints` never listed an /apply-made change and `/revert` either
 * said "nothing to revert" or, worse, silently restored an unrelated earlier checkpoint instead.
 */
export function applyEditIntentsLocal(
  intents: readonly agent.EditIntent[],
  roots: string[] | undefined,
  cwd: string,
  checkpoint?: CheckpointHook,
): ApplyIntentOutcome[] {
  const out: ApplyIntentOutcome[] = [];
  for (const intent of intents) {
    if (!intent.path) {
      out.push({ path: "(no path)", ok: false, summary: "edit block had no target file path" });
      continue;
    }
    const { outcome, record } = applyLocalEdit(
      { path: intent.path, hunks: intent.hunks },
      roots,
      cwd,
    );
    if (outcome.ok && record && checkpoint) captureIntoCheckpoint(checkpoint, record);
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

/**
 * Fold a first-touch pre-image into this turn's checkpoint (turn-atomic grouping).
 *
 * `existed === false` records the path as ABSENT instead of as empty content, which is what
 * lets `/revert` DELETE a file the agent created rather than truncating it to zero bytes.
 */
function captureIntoCheckpoint(hook: CheckpointHook, rec: EditRecord): void {
  const existing = hook.store.get(hook.turnId);
  const files = existing ? { ...existing.files } : {};
  const absent = new Set(existing?.absent ?? []);
  const unrevertable = existing?.unrevertable ?? [];
  // FIRST-touch only — keep the truly pre-turn state. A path already known either way has
  // already been captured at its earliest point in the turn (an unrevertable one included:
  // its pre-turn bytes are gone, and a later capture would only record an intermediate state).
  if (rec.path in files || absent.has(rec.path) || unrevertable.includes(rec.path)) return;
  if (rec.existed === false) absent.add(rec.path);
  else files[rec.path] = rec.preImage;
  recordTurnCheckpoint(hook, files, [...absent], unrevertable);
}

/**
 * A path this turn changed but could not capture still CLAIMS the turn: without a checkpoint
 * for it, `/revert` fell through to the previous turn and undid accepted work there. It is
 * reported by /revert as not revertible, and it blocks later first-touch captures of the path.
 */
function claimUnrevertable(hook: CheckpointHook, path: string): void {
  const existing = hook.store.get(hook.turnId);
  const files = existing ? { ...existing.files } : {};
  const absent = existing?.absent ?? [];
  const unrevertable = existing?.unrevertable ?? [];
  if (path in files || absent.includes(path) || unrevertable.includes(path)) return;
  recordTurnCheckpoint(hook, files, absent, [...unrevertable, path]);
}

function recordTurnCheckpoint(
  hook: CheckpointHook,
  files: Record<string, string>,
  absent: string[],
  unrevertable: string[],
): void {
  const cp = makeCheckpoint(
    hook.turnId,
    hook.sessionId,
    hook.turnNumber,
    hook.now(),
    files,
    {},
    `turn ${hook.turnNumber}`,
  );
  hook.store.record({
    ...cp,
    ...(absent.length > 0 ? { absent } : {}),
    ...(unrevertable.length > 0 ? { unrevertable } : {}),
  });
}

/**
 * Restore a checkpoint's captured files (rewriting pre-images, deleting files created
 * after the snapshot). Path-guarded within `roots` (a checkpoint must never become an
 * arbitrary-write primitive); atomic writes preserve mode. Never throws.
 */
export function restoreCheckpoint(
  cp: Checkpoint,
  opts: { roots?: string[]; currentPaths?: string[] } = {},
): {
  restored: string[];
  deleted: string[];
  skipped: string[];
  failed: string[];
  /** paths the turn changed but could not capture (binary/unreadable) — nothing to write back */
  unrevertable: string[];
} {
  const plan = restorePlan(cp, opts.currentPaths ?? Object.keys(cp.files));
  const allowed = (p: string): boolean =>
    !opts.roots || opts.roots.length === 0 || isPathAllowed(p, opts.roots);
  const restored: string[] = [];
  const deleted: string[] = [];
  /**
   * Paths the scope guard refused — REPORTED, not swallowed.
   *
   * A `write_file` outside the working set is reachable: the confirm seam asks, and the human
   * can approve it. Its pre-image is captured like any other. But `/revert` then skipped it here
   * (correctly — a checkpoint must not become an arbitrary-write primitive) and said nothing,
   * while the caller deleted the checkpoint on the strength of a successful-looking return. The
   * original bytes of a file the user explicitly approved a write to were destroyed by the
   * command whose entire purpose is to bring them back.
   */
  const skipped: string[] = [];
  /** Paths that could not be written or deleted, or whose delete was WITHHELD (below). */
  const failed: string[] = [];
  for (const [path, content] of Object.entries(plan.write)) {
    if (!allowed(path)) {
      skipped.push(path);
      continue;
    }
    try {
      // A revert write may target a path whose DIRECTORY is gone (a moved-away file's old
      // folder, deleted later in the same turn). atomicWrite never creates it, so the write
      // threw ENOENT and the file could not come back. The path passed the scope guard, and
      // so does its parent.
      mkdirSync(dirname(path), { recursive: true });
      atomicWrite(path, content);
      restored.push(path);
    } catch {
      // An un-writable path is REPORTED, not swallowed: `/revert` counted it as neither
      // restored nor skipped, so the caller saw a clean return, dropped the checkpoint, and the
      // pre-image of a file that was never actually rewritten went with it.
      failed.push(path);
    }
  }
  // Deletes run only once EVERY write-back succeeded. A move is recorded as a pair — write
  // the source back, delete the destination — and running the delete after the write failed
  // (or was out of scope) removed the moved file at BOTH paths. Withheld, the checkpoint is
  // kept and a later /revert can finish the job.
  const unrevertable = [...(cp.unrevertable ?? [])];
  if (skipped.length > 0 || failed.length > 0) {
    failed.push(...plan.delete);
    return { restored, deleted, skipped, failed, unrevertable };
  }
  for (const path of plan.delete) {
    if (!allowed(path)) {
      skipped.push(path);
      continue;
    }
    try {
      rmSync(path);
      deleted.push(path);
    } catch (e) {
      // "already gone" IS success for a delete; anything else failed and must be reported.
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") failed.push(path);
    }
  }
  return { restored, deleted, skipped, failed, unrevertable };
}

/**
 * Where a turn's usage goes: this session's accounting file always, and the SHARED daily ledger
 * the desktop's budget gate prices only for a METERED turn. A local row carries a bare model id
 * ("gemma3:4b") that the desktop prices as unknown, so one local CLI turn blocked every Studio
 * cloud call for the day. Exported so a test exercises the exact decision the turn runs.
 */
export function accountingSink(
  ctx: Pick<SessionCtx, "accounting" | "endpoint">,
): ((rec: AccountingRecord) => void) | undefined {
  const acct = ctx.accounting;
  if (!acct) return undefined;
  return (rec) =>
    appendAccounting(acct.home, acct.sessionId, rec, {
      metered: ctx.endpoint?.locality !== "local",
    });
}

/** The URL-fetch seam (default = engine-bridge safeFetch); injected in tests. CLI-011. */
export type FetchImpl = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;

/** Stringify a thrown value for a tool summary. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How to DESCRIBE one consequential tool call to the human who must approve it.
 *
 * A table rather than a chain of per-tool branches, and rather than the previous
 * `PATH_CONFIRM_TOOLS` set which covered `write_file` and `propose_edit` and nothing else.
 * Everything not listed here fell through to the literal string `run tool <name>?` — so the
 * human approving `run_command` was shown the WORDS "run tool run_command?" and never the
 * command line, which is the one thing that decides whether approving is safe. `rm -rf ~` and
 * `ls` presented identically. `delete_file`, `move_file` and `apply_patch` were the same:
 * approved by name, with no path, no destination and no file list.
 *
 * Each entry returns the prompt BODY; the caller adds the working-set warning and the "?".
 * `paths` names the absolute paths the call touches, so the escape check covers every tool
 * rather than only the two that used to be listed.
 */
const CONFIRM_DESCRIBERS: Record<
  string,
  (args: Record<string, unknown>, abs: (p: string) => string) => { body: string; paths: string[] }
> = {
  write_file: (a, abs) => {
    const p = abs(String(a.path ?? ""));
    return { body: `write file ${p}`, paths: [p] };
  },
  propose_edit: (a, abs) => {
    const p = abs(String(a.path ?? ""));
    return { body: `edit file ${p}`, paths: [p] };
  },
  run_command: (a) => {
    const cmd = String(a.command ?? "").trim();
    const where = typeof a.cwd === "string" && a.cwd ? ` (in ${a.cwd})` : "";
    const bg = a.mode === "background" ? " in the BACKGROUND" : "";
    // The command line itself, verbatim and untruncated. A shortened command line is a
    // command line the human did not actually read.
    return { body: `run${bg}${where}: ${cmd}`, paths: [] };
  },
  delete_file: (a, abs) => {
    const p = abs(String(a.path ?? ""));
    // A recursive delete is the one file operation with no undo — say so where it is decided.
    return {
      body: a.recursive
        ? `DELETE the directory ${p} and everything inside it (cannot be undone)`
        : `delete file ${p}`,
      paths: [p],
    };
  },
  move_file: (a, abs) => {
    const from = abs(String(a.from ?? ""));
    const to = abs(String(a.to ?? ""));
    const clobber = a.overwrite ? ", REPLACING the destination" : "";
    return { body: `move ${from} → ${to}${clobber}`, paths: [from, to] };
  },
  apply_patch: (a, abs) => {
    const edits = Array.isArray(a.edits) ? a.edits : [];
    const paths = edits
      .map((e) => (e && typeof e === "object" ? String((e as { path?: unknown }).path ?? "") : ""))
      .filter(Boolean)
      .map(abs);
    const list = paths.length > 0 ? `:\n  ${paths.join("\n  ")}` : "";
    return { body: `apply a patch to ${paths.length} file(s)${list}`, paths };
  },
};

/**
 * The human-facing confirm prompt for ONE tool call (the plain-host seam).
 *
 * Consent is only consent if it is informed: the prompt names the exact command, the exact
 * absolute paths, and whether any of them escape the working set. PURE — path resolution and
 * an `isPathAllowed` scope test; a tool with nothing consequential to say keeps the terse form.
 */
export function confirmPrompt(call: ToolCall, cwd: string, roots?: string[]): string {
  const describe = CONFIRM_DESCRIBERS[call.name];
  if (!describe) return `run tool ${call.name}?`;
  const abs = (p: string): string => (p && isAbsolute(p) ? p : p ? resolve(cwd, p) : p);
  const { body, paths } = describe(call.args ?? {}, abs);
  // A describer with nothing to describe (a malformed call) must not produce a prompt that
  // reads as though it named a target.
  if (!body.trim() || /(?::|\s)$/.test(body)) return `run tool ${call.name}?`;
  const escapes = roots && roots.length > 0 && paths.some((p) => p && !isPathAllowed(p, roots));
  // The warning LEADS. It used to be spliced mid-sentence ("write file OUTSIDE the working
  // set: /x?"), which reads as part of the description rather than as an alarm, and which
  // has no sensible position at all for a tool with two paths like `move_file`.
  return escapes ? `OUTSIDE the working set — ${body}?` : `${body}?`;
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
    /** test seam: replace the shell-free capture the Tier-R tools probe the machine with. */
    execImpl?: SystemToolDeps["exec"];
    /** test seam: replace the pipeline spawn `run_command` uses. */
    spawnImpl?: SystemToolDeps["spawnImpl"];
    /** test seam: replace the nemesis scan `run_command` gates on. */
    gateImpl?: SystemToolDeps["gateImpl"];
    /** the gate posture (`enforce` | `warn` | `off`) — mirrors tuning.gateMode. */
    gateMode?: SystemToolDeps["gateMode"];
    /** PROMETHEUS_HOME, for the exec audit line. */
    home?: string;
    /**
     * Dispatch an `mcp__<server>__<tool>` call to a connected MCP server.
     *
     * Injected rather than imported so this module never pulls the MCP transports (and the
     * SDK behind them) into the CLI's dependency graph. The host owns the manager; this only
     * needs "run that tool, give me text back".
     */
    /** run a delegated sub-agent turn. Absent ⇒ `spawn_agent` reports itself unavailable. */
    spawnSubagent?: (args: Record<string, unknown>) => Promise<ToolOutcome>;
    /** ask the human a free-text question. Absent ⇒ `question` refuses honestly. */
    askUser?: (args: Record<string, unknown>) => Promise<ToolOutcome>;
    /** which search provider `web_search` uses; absent ⇒ the keyless default. */
    searchProvider?: string;
    /** the session's task list (todowrite/todoread). Absent ⇒ those tools report unavailable. */
    todos?: TodoStore;
    /** fired after a write so the host can render the list as a status line. */
    onTodos?: (items: readonly agent.TodoItem[]) => void;
    callMcpTool?: (
      serverId: string,
      tool: string,
      args: Record<string, unknown>,
    ) => Promise<{ ok: boolean; summary: string; data?: unknown }>;
    /** the authorization level in force, recorded in the audit. */
    authLevel?: number;
    /** live output sink for `run_command` mode:"stream" — the host's terminal writer. */
    onProgress?: SystemToolDeps["onProgress"];
    /**
     * The turn's cancel, forwarded to every tool that can be interrupted.
     *
     * Today that means `run_command`'s child process. It matters most there: the loop can stop
     * calling the model instantly, but a spawned build does not care that the user pressed
     * ESC unless someone tells it.
     */
    signal?: AbortSignal;
  } = {},
): ToolRunner {
  const roots = opts.roots;
  return async (tool: ToolDef, args: Record<string, unknown>): Promise<ToolOutcome> => {
    // Tier R (full_wrapper_compose Phase 1): the read-only view of the machine — files, git,
    // hardware. Dispatched HERE, never through the engine (their `toArgv` throws). They are
    // `readOnlyHint`, so `classifyAuth` puts them in the `read` category and A1 auto-approves
    // them: reading `git diff` is not a riskier act than reading a file, which A1 already
    // allows. Returns null for anything that is not a system tool, so the chain falls through.
    /**
     * Fail-closed path scope (CLI-004) — FIRST, so it covers every tool.
     *
     * This check used to sit ~120 lines below, immediately above `runEngineVerb`. But the
     * system-tool arm right underneath this comment returns for every tool core recognises —
     * read_file, list_dir, grep, glob, git_status/diff/log/show, run_command — so the guard was
     * only ever reached by `prometheus_*` engine verbs. With a session scoped to one repo, the
     * model could still `read_file {path:"/etc/hosts"}`, `list_dir` any directory on the
     * machine, `git_status {cwd:"/some/other/repo"}`, and hand `run_command` a cwd outside the
     * working set — none of which the working set was ever consulted about.
     *
     * Three comments in the two modules asserted the opposite and were simply wrong about the
     * code as written (system-tools.ts's header, its `cwd` note, and working-set.ts's reason
     * for putting `cwd` in PATH_KEYS — "without `cwd` in this set the fail-closed scope check
     * simply would not see the argument it needs to check", describing a check that never saw
     * these tools at all). Those comments describe the intent; this placement implements it.
     *
     * A path the human APPROVED through the confirm seam this turn is exempt — that is the
     * whole point of `approvedWrites`, and re-denying it here would break out-of-scope writes
     * the user explicitly said yes to.
     */
    if (roots && roots.length > 0) {
      const cwdForScope = opts.cwd ?? process.cwd?.() ?? ".";
      for (const p of pathArgsOf(args)) {
        // Resolve against the SESSION cwd, not `process.cwd()`. `isPathAllowed` resolves a
        // relative path against the process directory, which is the repo the CLI was launched
        // from — not necessarily the session's. A relative `note.txt` would then be tested
        // against the wrong directory and denied inside its own working set.
        // `scopedAbsolute` expands `~` BEFORE resolving. Without that, `~/.ssh/id_rsa` tested as
        // `<cwd>/~/.ssh/id_rsa` — nonexistent, so the check walked up to `<cwd>`, which is a
        // root, and ALLOWED it — while `read_file` expanded the same `~` for real and opened the
        // home file. Guard and tool must judge the same string.
        const abs = scopedAbsolute(p, cwdForScope);
        if (opts.approvedWrites?.has(abs)) continue;
        if (!isPathAllowed(abs, roots)) {
          return { ok: false, summary: `path outside the working set (denied): ${p}` };
        }
      }
    }
    {
      const sys = await runSystemTool(tool.name, args, {
        cwd: opts.cwd ?? process.cwd?.() ?? ".",
        // The SAME allowlist the confirm seam parsed with. If these two disagreed, a command
        // could be approved in one form and executed in another — the exact substitution the
        // parser exists to prevent, reintroduced by the host.
        vars: execVarsFromEnv(),
        // Phase 3: the runner is the LAST gate before a spawn, so it scans too. The confirm
        // seam has usually latched the verdict already, making this a cache hit rather than
        // a second subprocess — but a host that skipped the confirm still cannot reach a
        // spawn unscanned.
        ...(opts.gateMode ? { gateMode: opts.gateMode } : {}),
        ...(opts.home ? { home: opts.home } : {}),
        ...(opts.authLevel !== undefined ? { authLevel: opts.authLevel } : {}),
        ...(roots && roots.length > 0 ? { roots } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        // ESC / Ctrl-C reaches the child process, not just the model stream.
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.execImpl ? { exec: opts.execImpl } : {}),
        ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
        ...(opts.gateImpl ? { gateImpl: opts.gateImpl } : {}),
        ...(opts.approvedWrites ? { approvedOutside: opts.approvedWrites } : {}),
        /**
         * Tier-W pre-image capture rides the SAME dispatch.
         *
         * The mutators moved into core so the desktop could reach them, which means this call
         * now answers `delete_file` before any host-local arm below could — so the capture has
         * to happen here or `/revert` silently stops working for deletes. Found by the test
         * that pins exactly that.
         */
        onPreImage: (rec) => {
          if (opts.editHistory) opts.editHistory.push(rec);
          if (opts.checkpoint) captureIntoCheckpoint(opts.checkpoint, rec);
        },
      });
      if (sys) return sys;
    }
    // web_fetch (CLI-011): the ONLY network path — the fail-closed safeFetch L6 proxy,
    // never global fetch. Reaches here only AFTER human confirm (openWorldHint).
    // spawn_agent: re-enter the SAME loop with a child thread, a narrower policy and a
    // budget. Guarded in the runner (not the loop) because the loop deliberately holds no
    // state — which is exactly why an unguarded spawn would recurse forever.
    if (tool.name === "spawn_agent") {
      if (!opts.spawnSubagent) {
        return { ok: false, summary: "spawn_agent is not available in this session" };
      }
      return opts.spawnSubagent(args);
    }
    // `question`: the one tool whose whole job is to stop and ask. Dispatched here rather than
    // through the confirm seam because confirm answers yes/no about a CALL — a question needs
    // free text back, and overloading the rejection `reason` for it would make a refusal and an
    // answer indistinguishable.
    if (tool.name === "question") {
      if (!opts.askUser) return { ok: false, summary: agent.NO_ASKER_MESSAGE };
      return opts.askUser(args);
    }
    // web_search / web_fetch (CLI-011): the ONLY network path — the fail-closed safeFetch L6
    // proxy, never global fetch. Implemented in CORE so the desktop gets them too; this passes
    // the real proxy and the process env the keyed providers resolve from.
    {
      const web = runWebTool(tool.name, args, (opts.fetchImpl ?? safeFetch) as never, {
        ...(opts.searchProvider ? { providerId: opts.searchProvider } : {}),
        env: process.env,
      });
      if (web) return web;
    }
    // propose_edit (CLI-010) is applied LOCALLY, not via the engine — path-guarded,
    // atomic, pre-image kept for revert. Reaches here only AFTER human confirm.
    if (tool.name === "propose_edit") {
      const { outcome, record } = applyLocalEdit(args, roots, opts.cwd ?? process.cwd?.() ?? ".");
      if (record) {
        if (opts.editHistory) opts.editHistory.push(record);
        // record.preImage is the TOCTOU-safe pre-write content — snapshot per turn (CLI-015).
        if (opts.checkpoint) captureIntoCheckpoint(opts.checkpoint, record);
      }
      return outcome;
    }
    // write_file: CREATE a new file or OVERWRITE an existing one (path-guarded, atomic,
    // pre-image kept). Reaches here only AFTER human confirm (destructiveHint ⇒ always confirm).
    if (tool.name === "write_file") {
      const { outcome, record, unrevertable } = applyWriteFile(
        args,
        roots,
        opts.cwd ?? process.cwd?.() ?? ".",
        opts.approvedWrites,
      );
      if (record) {
        if (opts.editHistory) opts.editHistory.push(record);
        if (opts.checkpoint) captureIntoCheckpoint(opts.checkpoint, record);
      } else if (unrevertable && opts.checkpoint) {
        claimUnrevertable(opts.checkpoint, unrevertable);
      }
      return outcome;
    }
    // apply_patch: N files, all-or-nothing. Every hunk in every file is resolved against the
    // CURRENT bytes before a single byte is written, so a half-migrated tree is impossible.
    if (tool.name === "apply_patch") {
      const { outcome, records } = applyMultiFilePatch(
        args,
        roots,
        opts.cwd ?? process.cwd?.() ?? ".",
        opts.approvedWrites,
      );
      for (const record of records) {
        if (opts.editHistory) opts.editHistory.push(record);
        // Every pre-image goes into the SAME turn checkpoint, so one /revert undoes the whole
        // patch rather than leaving the user to undo it file by file.
        if (opts.checkpoint) captureIntoCheckpoint(opts.checkpoint, record);
      }
      return outcome;
    }

    // The task list: agent memory, never the filesystem. Auto-approved (readOnlyHint) because
    // there is nothing to approve — requiring a click for the model to write down its own
    // plan would make the feature unusable.
    if (opts.todos) {
      const todo = agent.runTodoTool(tool.name, args, opts.todos);
      if (todo) {
        opts.onTodos?.(opts.todos.list());
        return todo;
      }
    }

    // An external MCP server's tool. Routed on the NAME PREFIX alone, which is the other
    // half of why the names are namespaced: a server cannot publish a `write_file` that
    // reaches this arm, and this arm cannot accidentally swallow a built-in.
    const mcpRef = agent.protocol.parseMcpToolName(tool.name);
    if (mcpRef) {
      if (!opts.callMcpTool) {
        return {
          ok: false,
          summary: `MCP server "${mcpRef.serverId}" is not reachable from this session`,
        };
      }
      try {
        return await opts.callMcpTool(mcpRef.serverId, mcpRef.tool, args);
      } catch (err) {
        // A server that is down, blocked, or refused the call is a tool_result the model can
        // re-plan on — never a crashed turn.
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, summary: `${tool.name} failed: ${detail}` };
      }
    }

    // Tier W (delete / move / mkdir): applied LOCALLY like propose_edit and write_file, with
    // the same working-set guard and the same pre-image capture, so a deleted file lands in
    // the checkpoint and `/revert` can bring it back. Reaches here only AFTER human confirm
    // (delete_file and move_file are destructiveHint ⇒ the broker always asks).
    // NOTE: delete_file / move_file / mkdir are dispatched ABOVE, by core's `runSystemTool`.
    // They used to have host-local arms here; once the implementation moved into core those
    // arms became unreachable, and the pre-image capture moved up with the dispatch.
    // The engine verbs, through core's shared runner — the same one the desktop pane reaches
    // over IPC, so the envelope's nemesis verdict is lifted in exactly one place. It also
    // VALIDATES the args first, which this call site did not: `toArgv(args)` skipped the
    // schema, so `prometheus_install`'s `dryRun: true` default never applied and an agent
    // asking to install something got a real install where the schema promised a rehearsal.
    const engine = runEngineVerb(
      tool.name,
      args,
      (argv: string[]) => client.runPrometheus(argv) as unknown as Promise<Record<string, unknown>>,
      // The CLI holds the ToolDef the loop dispatched, so a host-declared engine tool outside
      // the shipped catalogue still runs here — this is the terminal arm, as it always was.
      { tool },
    );
    if (engine) return engine;
    return { ok: false, summary: `tool "${tool.name}" has no implementation on this host` };
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
  /** the turn PAUSED on inactivity (idle-watchdog.ts) rather than finishing or hitting the
   *  round cap. The SAME `/continue` + `thread` resume this exact same turn — see `capped`'s
   *  own doc comment; the two are resumed identically, only the reported REASON differs. */
  paused: boolean;
  /** how long the turn had been silent when it paused — undefined when `paused` is false. */
  pausedIdleMs?: number;
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
    case "paused":
      return `⏸ paused after ${Math.round(ev.idleMs / 1000)}s of inactivity${ev.canContinue ? " — /continue to resume, or just keep typing" : ""}`;
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
                : ev.kind === "capped" || ev.kind === "paused"
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
  // Built as a NAMED variable (not inline in the `??` below) so `turnScopeSpentTokens` can be
  // set on it once the turn-scope preamble assembly further down computes its own spend — the
  // SAME object `makeLlmClient`'s `turn()` closures read `deps.*` off of each round, so mutating
  // it here (before any round actually runs) reaches them without reordering the two assemblies.
  const llmDeps: LlmClientDeps = {
    ...(ctx.policy ? { policy: ctx.policy } : {}),
    // The loaded personas travel to the client because that is where the tool list is
    // rendered — `spawn_agent`'s description has to name them before it is serialized.
    ...(ctx.agentFiles && ctx.agentFiles.length > 0 ? { personas: ctx.agentFiles } : {}),
    // Without this a CLOUD endpoint's key never reaches the request — the transport
    // resolves the ref, but nothing ever handed it a resolver.
    ...(ctx.resolveKey ? { resolveKey: ctx.resolveKey } : {}),
    // `/timeout` — the session's inactivity-pause threshold (root cause 1's fix).
    ...(ctx.idleTimeoutMs !== undefined ? { idleTimeoutMs: ctx.idleTimeoutMs } : {}),
    /**
     * The user's `prompt-caching` switch, finally consulted.
     *
     * `tokenToggles` reached the SYSTEM BLOCKS (`tokenSystemBlocks`) and stopped there, while
     * the transport applied `cache_control` unconditionally. So switching prompt caching off
     * changed the prompt the model was told about and not the request that was sent, and
     * `tokens report` kept crediting savings from a technique the user had turned off.
     */
    ...(ctx.tokenToggles?.["prompt-caching"] === false ? { promptCache: false } : {}),
    /**
     * Carry the endpoint's LEARNED tool capability across turns.
     *
     * A fresh `makeLlmClient` is built for every user message, and the capability state it
     * accumulates — "this endpoint answered a tools request with prose twice, stop offering
     * native tools" — lives inside that client. So it was discarded the moment the turn
     * ended, and `negotiateTransport`'s two-observation threshold could never be reached:
     * a model that cannot function-call was re-probed natively on every single message,
     * wasting the first round of each one, forever. Both `capability` and `onCapability`
     * are optional, which is why nothing ever noticed.
     */
    ...(ctx.capability ? { capability: ctx.capability() } : {}),
    ...(ctx.onCapability ? { onCapability: ctx.onCapability } : {}),
    // Model Health (`/model-health`, the desktop's Settings ▸ Model Health page): persisted
    // ONLY when a real host is running (it has a real `ctx.home`) — never inside a test,
    // which builds this same client with no `ctx.home` at all and gets a pure no-op.
    ...(ctx.home
      ? {
          onModelHealth: (record: ai.EndpointHealthRecord) =>
            recordEndpointHealth(record, ctx.home as string),
          // Feeds the ollama idle-shutdown watchdog's "last used" clock — same real-host-only
          // gate as onModelHealth just above, for the same reason (never touches disk in a test).
          onLocalActivity: () => touchModelActivity(ctx.home as string),
        }
      : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(accountingSink(ctx) ? { onUsage: accountingSink(ctx) } : {}),
  };
  // ctx.endpoint is defined here (the offline branch above returned otherwise).
  const llm = deps.llm ?? makeLlmClient(ctx.endpoint as AiEndpoint, llmDeps);
  // Absolute paths an OUT-OF-working-set `write_file` was approved for through the confirm seam
  // this turn. The loop always routes write_file through confirm (destructiveHint is never
  // auto-approvable in the broker), so recording on approval is complete; applyWriteFile refuses
  // any out-of-scope target that isn't in here.
  const approvedWrites = new Set<string>();
  // One budget per USER TURN, shared by the whole delegation tree. Per-parent counting would
  // let ten sequential spawns each start fresh, which is the same runaway with extra steps.
  const spawnBudget = agent.initialBudget(ctx.subagentBudget ?? {});
  // One asking budget per USER TURN, for the same reason: a per-call cap is not a cap, because
  // the loop just makes another call. Three funds a genuine multi-part ambiguity and does not
  // fund holding a conversation instead of working.
  const questionBudget = agent.initialQuestionBudget();
  /**
   * Ask the human a question and hand the answer back to the model.
   *
   * The budget refusal is phrased as an INSTRUCTION ("choose the most reasonable
   * interpretation, say which one, continue") rather than a bare denial: a model told only
   * "no" tends to ask again in different words, which spends the rest of the turn.
   */
  const askUser = async (args: Record<string, unknown>): Promise<ToolOutcome> => {
    const decision = agent.canAsk(questionBudget);
    if (!decision.allowed) return { ok: false, summary: decision.reason };
    const prompt = agent.renderQuestion(args);
    if (!prompt) return { ok: false, summary: "question: `question` is required" };
    if (!ctx.ask) return { ok: false, summary: agent.NO_ASKER_MESSAGE };
    questionBudget.asked += 1;
    ctx.write(`  ? ${prompt}`);
    try {
      const answer = await ctx.ask(prompt);
      return { ok: true, summary: agent.renderAnswer(answer) };
    } catch (err) {
      // A closed stdin / cancelled prompt is not an answer. Say so and let the model proceed.
      return { ok: false, summary: `${agent.NO_ASKER_MESSAGE} (${errMsg(err)})` };
    }
  };
  /**
   * Run a delegated sub-agent.
   *
   * Declared here so the child re-enters the SAME `runAgentTurn` with the SAME runner and the
   * SAME confirm — its tools are gated exactly as the parent's are. Delegation must not become
   * a way to reach a tool the parent was denied.
   */
  const spawnSubagent = async (args: Record<string, unknown>): Promise<ToolOutcome> => {
    const decision = agent.canSpawn(spawnBudget);
    if (!decision.allowed) return { ok: false, summary: decision.reason };
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) return { ok: false, summary: "spawn_agent: `task` is required" };
    /**
     * The role may be a BUILT-IN name or a loaded persona.
     *
     * Resolved here rather than through the tool's JSON-Schema enum, deliberately: that enum is
     * advisory (nothing on this path validates against it), `SUBAGENT_ROLES` is frozen so a new
     * role cannot be registered into it, and mutating `SPAWN_AGENT_TOOL.schema` in place would
     * leak across every session in the process. `isSubagentRole` is the real gate and stays so.
     */
    const requested = typeof args.role === "string" ? args.role : "";
    const persona = agent.isSubagentRole(requested)
      ? undefined
      : (ctx.agentFiles ?? []).find((a) => a.name === requested);
    const role = agent.isSubagentRole(requested) ? requested : (persona?.base ?? "explore");
    spawnBudget.spawned += 1;
    const exposed = agent.exposedTools(ctx.tuning.tools);
    const base = agent.childTuning(
      ctx.tuning,
      role,
      task,
      exposed,
      typeof args.maxRounds === "number" ? args.maxRounds : undefined,
      // The child's preamble is assembled against the SAME endpoint facts the parent's own
      // turn already resolved — not the permanent "unknown"/no-window placeholder `childTuning`
      // falls back to when this is omitted. Without `effortMechanism` specifically, a child on
      // a model with a WORKING native mechanism got the textual effort nudge on top of it —
      // double-injecting the tier in two registers at once.
      ctx.endpoint
        ? {
            locality: ctx.endpoint.locality,
            contextWindow: ctx.endpoint.contextWindow,
            effortMechanism: resolveCapability(
              {
                modelId: ctx.endpoint.model ?? ctx.endpoint.id,
                runtime: runtimeFromBaseUrl(ctx.endpoint.baseUrl, ctx.endpoint.locality),
                locality: ctx.endpoint.locality,
                probedCapabilities: ctx.endpoint.probedCapabilities,
              },
              ctx.effortRules,
            ).cap.mechanism,
          }
        : undefined,
    );
    // A persona layers on top of the child tuning the ROLE already produced — it can add denies
    // and add prompt text, and it cannot undo either. `childTuning` has already applied the
    // parent's deny list, the read-only narrowing and the `yes` rule before this runs.
    const childTune = persona
      ? {
          ...base,
          systemPrompt: agent.personaSystemPrompt(persona, task),
          tools: {
            ...base.tools,
            deny: [...new Set([...base.tools.deny, ...agent.personaDeny(persona, exposed)])],
          },
        }
      : base;
    const label = persona ? `${persona.name} (${persona.scope})` : role;
    ctx.write(`  ⤷ ${label} sub-agent: ${task.slice(0, 80)}${task.length > 80 ? "…" : ""}`);
    // `depth` tracks how many spawns are LIVE right now, not a running total — incremented for
    // exactly the duration of this child's turn, and decremented once it returns, so a sibling
    // spawned afterward at the top level still sees depth 0. `childTuning` already removes the
    // `spawn_agent` tool from a child's catalog, which is what stops recursion in practice
    // today — but `runTool` is the SAME closure at every level (the child reuses the parent's),
    // so if that deny-list line were ever bypassed, `canSpawn` reading a real depth here is the
    // backstop the budget's own field name has always promised.
    spawnBudget.depth += 1;
    // The child re-enters `runAgentTurn` with the SAME `llm` client (so capability observation
    // stays shared across parent and child) — but that means it also shares `llmDeps`, the ONE
    // object the round-scope `withPreamble` reads `turnScopeSpentTokens` off of. Left alone, the
    // PARENT's own turn-scope spend (tool-discipline/pre-write-recheck/effort-text tokens that
    // exist in the PARENT's prompt, not the child's) would reduce the CHILD's round-scope
    // tool-catalog budget for reasons entirely unrelated to what the child's own prompt holds —
    // in the worst case clamping it to 0 and truncating the tools the child is told about
    // (verification pass #2's MAJOR finding). Suspend it for the child's turn, restore the
    // parent's own value once the child returns — `childTune`'s own turn-scope spend was already
    // baked into `childTune.systemPrompt` by `childTuning` itself, so the child's round-scope
    // pass correctly falls back to the full, un-reduced budget rather than a wrong one.
    const parentTurnScopeSpentTokens = llmDeps.turnScopeSpentTokens;
    llmDeps.turnScopeSpentTokens = undefined;
    try {
      const out = await agent.runSubagent(
        (thread, tuning, d) => runAgentTurn(thread, tuning, d),
        childTune,
        task,
        {
          llm,
          runTool,
          confirm,
          // Point 6b: a sub-agent is exactly the surface most likely to touch untrusted content
          // (that's what `touchedUntrustedSurface` above is for) — it must not run with the
          // canary tripwire silently disabled just because it's a delegated turn.
          ...(ctx.home
            ? {
                onCanaryTripped: (info: { textSnippet: string }) =>
                  appendCanaryAudit(ctx.home as string, {
                    event: "canary-tripped",
                    subagent: true,
                    ...info,
                  }),
              }
            : {}),
        },
      );
      ctx.write(`  ⤶ sub-agent done (${out.toolCalls} tool call${out.toolCalls === 1 ? "" : "s"})`);
      // ONLY the final text crosses back. Forwarding the child's transcript would defeat the
      // entire reason for delegating: keeping its intermediate work out of the parent.
      return { ok: out.ok, summary: out.text };
    } catch (err) {
      return { ok: false, summary: `sub-agent failed: ${errMsg(err)}` };
    } finally {
      spawnBudget.depth -= 1;
      llmDeps.turnScopeSpentTokens = parentTurnScopeSpentTokens;
    }
  };
  const runTool: ToolRunner =
    deps.runTool ??
    makeToolRunner(ctx.client, {
      spawnSubagent,
      askUser,
      approvedWrites,
      // Phase 3: the gate posture + the audit destination travel with the runner, so a
      // `run_command` is scanned and recorded under the SAME tuning the rest of the turn
      // uses rather than a default of its own.
      gateMode: ctx.tuning.gateMode,
      // `mode:"stream"` writes here as output arrives. The agent loop cannot carry mid-flight
      // output (a ToolRunner resolves once), so the host's own sink is the only live channel.
      onProgress: makeStreamSink((line) => ctx.write(`  ⎿ ${line}`)),
      // ESC / Ctrl-C: the turn's cancel travels with the runner so a spawned child dies with
      // the turn instead of outliving it.
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(ctx.home ? { home: ctx.home } : {}),
      ...(ctx.authLevel !== undefined ? { authLevel: ctx.authLevel } : {}),
      ...(ctx.workingSet ? { roots: ctx.workingSet } : {}),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      ...(ctx.editHistory ? { editHistory: ctx.editHistory } : {}),
      ...(ctx.todos ? { todos: ctx.todos } : {}),
      ...(ctx.onTodos ? { onTodos: ctx.onTodos } : {}),
      ...(ctx.callMcpTool ? { callMcpTool: ctx.callMcpTool } : {}),
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
  const hostConfirm = ctx.confirm ?? (() => false);
  // REMEMBERED GRANTS. `ScopedPermissionStore` and the whole pure permission engine existed,
  // tested, with no production caller — so every destructive call re-prompted forever, in
  // this session and every session after it. This is the seam that consults them: a grant may
  // only ever REMOVE a question (a decisive allow), never manufacture an approval the engine
  // would not have given, and deny always wins. Absent a store the behaviour is unchanged.
  /**
   * The engine runs when there are RULES OR grants — it used to require grants.
   *
   * `ctx.grants ? … : hostConfirm` meant the headless run, which has no grant store because
   * nobody is there to remember anything for, could never see a user rule even once rules
   * existed. That is precisely the surface where a `deny` matters most: unattended, with no
   * human to catch the call. A rules-only session gets a throwaway store so the one seam still
   * applies; nothing is ever written to it.
   */
  const permissionRules = ctx.permissionRules ?? [];
  /**
   * The permission ENGINE always runs — it used to be skipped whenever a surface had no
   * remembered-grant store.
   *
   * `withRememberedGrants` is the only production caller of `evaluatePermission`, and that is
   * where the engine's SAFE DEFAULTS live: the `.env` hard deny, the external-directory ask,
   * and the user's remembered denies. Gating it on `ctx.grants` meant the headless run — which
   * has no grant store because nobody is there to remember an answer for — skipped all of
   * them. The consequence was not theoretical: `guardSecretPath` is applied on the READ side
   * only, never in `applyWriteFile`, so `prometheus -p "…" --allow-writes` would auto-approve
   * `write_file {path:".env"}` and overwrite the user's credentials, while both interactive
   * hosts refuse it before a human is even asked.
   *
   * An empty store changes nothing for a surface that has one; it simply means the engine is
   * never absent. Nothing is ever written to a throwaway store.
   */
  const grantStore = ctx.grants ?? new agent.ScopedPermissionStore();
  const rawConfirm = withRememberedGrants(hostConfirm, grantStore, {
    workspaceRoot: ctx.cwd ?? process.cwd?.() ?? ".",
    ...(permissionRules.length > 0 ? { baseRules: permissionRules } : {}),
    ...(ctx.onRemember ? { onRemember: ctx.onRemember } : {}),
    ...(ctx.onAutoApprove ? { onAutoApprove: ctx.onAutoApprove } : {}),
  });
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

  // CLI-072 resume: continue the SAME non-system thread (its tail already ends on the last
  // round's tool results — a valid user-terminal state) with NO new user message. Otherwise the
  // normal path: prior history + this user message. System context is (re)assembled fresh either way.
  const conversation: ThreadMessage[] = deps.resumeThread
    ? [...deps.resumeThread]
    : [...(deps.history ?? []), { role: "user", content: message }];

  /**
   * The PREAMBLE DISPATCH PIPELINE — the single assembly point for every piece of instructional
   * text that is not the user's own conversation. Replaces six independently wired blocks
   * (tool-discipline was never wired for this host at all; pre-write-recheck and effort-as-text
   * did not exist; steering/memory/session-start/repo-map/token-economy were each pushed
   * unconditionally, with no shared budget accounting) with ONE call, in ONE declared priority
   * order, against ONE shared token budget. See
   * `packages/core/src/agent/protocol/preamble-dispatch.ts`.
   */
  const preambleCtx: agent.protocol.PreambleCtx = {
    surface: "cli",
    isSubAgent: false,
    readOnly: ctx.tuning.permissionMode === "plan",
    modelId: ctx.tuning.model.modelId,
    locality: ctx.endpoint?.locality ?? "unknown",
    contextWindow: ctx.endpoint?.contextWindow,
    effortTier: ctx.tuning.effort,
    effortMechanism: ctx.endpoint
      ? resolveCapability(
          {
            modelId: ctx.endpoint.model ?? ctx.endpoint.id,
            runtime: runtimeFromBaseUrl(ctx.endpoint.baseUrl, ctx.endpoint.locality),
            locality: ctx.endpoint.locality,
            probedCapabilities: ctx.endpoint.probedCapabilities,
          },
          ctx.effortRules,
        ).cap.mechanism
      : undefined,
    tools: agent.exposedTools(ctx.tuning.tools),
    authLevel: ctx.authLevel,
    permissionMode: ctx.tuning.permissionMode,
    gateMode: ctx.tuning.gateMode,
    // Which external tools this machine has (agent/host-tools.ts). Read through the ctx getter,
    // never probed here: `PreambleCtx` is documented pure, and the probe reads the filesystem.
    ...((): { hostTools?: string } => {
      const m = ctx.hostTools?.();
      return m ? { hostTools: m } : {};
    })(),
  };
  const assembled = agent.protocol.assemblePreamble(
    [...agent.protocol.CORE_TURN_CONTRIBUTORS, ...hostTurnContributors(ctx)],
    preambleCtx,
    agent.protocol.instructionBudget(preambleCtx.contextWindow),
  );
  // ONE combined budget across this turn-scope pass and the ROUND-scope one (`withPreamble`,
  // tool-catalog) — mutating the SAME `llmDeps` object `makeLlmClient` was already constructed
  // with, read fresh by its `turn()` closures on every round from here on. No round has run yet
  // (the agent loop below hasn't started), so this always reaches them in time regardless of
  // `deps.llm` having been used instead (in which case this is an inert, unread field).
  llmDeps.turnScopeSpentTokens = assembled.totalApproxTokens;
  const systemPrompt = assembled.personaAppend
    ? `${ctx.tuning.systemPrompt}\n\n${assembled.personaAppend}`
    : ctx.tuning.systemPrompt;

  const thread: Thread = {
    messages: [
      { role: "system", content: systemPrompt },
      ...assembled.blocks.map((content) => ({ role: "system" as const, content })),
      ...conversation,
    ],
  };

  let aborted = false;
  try {
    for await (const ev of runAgentTurn(thread, ctx.tuning, {
      llm,
      runTool,
      confirm,
      // The loop's own cancel check. Without it the abort stopped the SSE stream and the loop
      // simply started another round.
      ...(deps.signal ? { signal: deps.signal } : {}),
      // Point 6b: a tripped canary means something got the model to act against an explicit
      // instruction — recorded to its own audit stream so a security review can find it.
      ...(ctx.home
        ? {
            onCanaryTripped: (info: { textSnippet: string }) =>
              appendCanaryAudit(ctx.home as string, { event: "canary-tripped", ...info }),
          }
        : {}),
    })) {
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
  const pausedEvent = events.find(
    (e): e is Extract<AgentEvent, { kind: "paused" }> => e.kind === "paused",
  );
  return {
    session: updated,
    events,
    reply,
    jsonl: serializeSession(updated),
    capped: events.some((e) => e.kind === "capped"),
    paused: pausedEvent !== undefined,
    ...(pausedEvent ? { pausedIdleMs: pausedEvent.idleMs } : {}),
    thread,
  };
}
