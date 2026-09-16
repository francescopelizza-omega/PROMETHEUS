/**
 * session/host.ts — the P4 single-window interactive SESSION host.
 *
 * `launchSession(parsed)` is the ONE interactive surface bare `prometheus`, `prometheus repl`,
 * `prometheus tui`, and bare `prometheus chat` all land in. It is built on node:readline + node
 * built-ins ONLY — no ink/react/.tsx (the Ink view under apps/cli/src/repl/ stays
 * EXCLUDED). It owns the readline lifecycle: seed the agent tuning from `--profile`
 * (via @prometheus/core cliProfiles), boot the PURE core REPL state machine, print a
 * banner + footer, then loop on each input line —
 *   - a leading "/"  → execSlash       (the slash registry / tuning verbs / panes)
 *   - a known verb   → execVerb        (the SAME parity registry the GUI palette uses)
 *   - anything else  → runMessageTurn  (the agentic loop)
 * Every line is handled in try/catch so one bad turn renders a friendly line and the
 * loop CONTINUES — the session is never crashed by an engine/llm error (C5 / crash-free).
 *
 * Control keys (claude-parity):
 *   Ctrl-C   cancels the CURRENT turn (an in-flight agent/verb), NOT the session.
 *   Ctrl-D   ends the session cleanly (exit 0).
 *   /quit    ends the session cleanly (exit 0).
 *
 * INTEGRATION NOTE — the shared SessionCtx:
 *   The three line-handler siblings (slash-exec / command-exec / agent-runtime)
 *   each declare their OWN minimal context shape (they were authored independently
 *   and each only needs a slice). Rather than force one struct on all three (their
 *   `confirm` signatures alone differ — message vs message+phrase vs ToolCall), the
 *   HOST owns a single superset context — `SessionCtx`, exported here — and PROJECTS
 *   it into each sibling's expected shape at the call site. The host stays the one
 *   source of truth for the live state; the siblings stay decoupled + independently
 *   testable. (See sharedEditsProposed for the recommended convergence.)
 *
 * The readline interface, the writer, the clock, the engine client, and the three
 * line-handlers are all INJECTED seams so the whole loop is unit-testable with a
 * scripted fake driver (see host.test.ts) — no real TTY, engine, or model needed.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type Interface as ReadlineInterface, createInterface } from "node:readline";

import {
  repl,
  type AiEndpoint,
  CONTEXT_PROBE_AWAIT_MS,
  DEFAULT_CONTEXT_WINDOW,
  agent,
  ai,
  cliProfiles,
  createEndpointProbe,
  loadPricing,
  mcpServer,
  orchestration,
} from "@prometheus/core";

import type { ConfirmResult } from "@prometheus/core/agent-loop";
import type { ToolAnnotations } from "@prometheus/core/agent-tools";
import { type EngineClient, createEngineClient } from "@prometheus/engine-bridge";
import { defaultOpenEditor, loadEffectiveStartupProfileWithNotes } from "../profile-store.js";

import { PROM_VERSION } from "../commands/help.js";
import { runInvoke } from "../commands/invoke.js";
import { readTokenToggles } from "../commands/token-toggles.js";
import { type CommandOutcome, outcomeFromError } from "../context.js";
import { type CwdMove, guardOwnRepo, resolveCwd, resolveCwdMove } from "../cwd-guard.js";
import { fleetReport } from "../fleet/report.js";
import type { FleetTicker } from "../fleet/ticker.js";
import { startFleetTicker } from "../fleet/ticker.js";
import {
  ensureHomeTree,
  loadSettings,
  prometheusHome,
  resolveCategory,
  saveSettings,
} from "../home.js";
import { runDemos } from "../orchestration/demos-cmd.js";
import type { ParsedArgs } from "../parse.js";
import { bannerCwd, shortCwd } from "../path-display.js";
import { box, c, defaultColorEnabled, padEnd, visibleLen } from "../render.js";
import { insideTmux } from "../tmux/tmux.js";
import { fleetBarLine, fleetLegendLines } from "../tui/fleet-bar.js";
import { type KeymapResolution, resolveKeymap } from "../tui/keys.js";
import { detectColorCaps } from "../tui/palette.js";
import { runUpdates, updatesStartupNotice } from "../updates/updates-cmd.js";
import { loadContextWindowTokens, saveContextWindowTokens } from "./context-window-setting.js";
import {
  type SessionRecord,
  type TurnLine,
  appendTurnEvents,
  buildSessionExport,
  descriptorOf,
  formatPicker,
  interactiveSessions,
  listSessions,
  loadTurns,
  recordSession,
  rotateSessions,
  updateSessionSummary,
} from "./history-store.js";
import { loadIdleTimeoutMs, saveIdleTimeoutMs } from "./idle-timeout-setting.js";
import { createKeyResolver, keychainProviders } from "./key-resolver.js";
import { newSessionId } from "./session-id.js";
import { turnSummaryOf } from "./turn-summary.js";

import {
  createHookRunner,
  expandHome,
  loadMemoryIndexBlock,
  loadPermissionRules,
  nodePreviewIo,
  resolveEffectiveHooks,
  runSystemTool,
} from "@prometheus/core/agent-system-host";
import { copyReplyStatus, lastAssistantReply } from "../tui/clipboard.js";
import { runElevationGate } from "../tui/sudo.js";
import {
  type BudgetGuard,
  type CheckpointHook,
  type ContextComponent,
  type EditRecord,
  type MessageTurnResult,
  type SessionCtx as TurnCtx,
  applyEditIntentsLocal,
  autoCompactPolicy,
  compactSession,
  confirmPrompt,
  effectiveTools,
  makeSummarizer,
  measuredSessionUsage,
  rebuildThread,
  restoreCheckpoint,
  runMessageTurn,
  sessionUsage,
  shouldAutoCompact,
  turnsFromRecords,
  warmupLocalModel,
} from "./agent-runtime.js";
import { readSavedAuthLevel, saveAuthLevel } from "./authorisation-store.js";
import { type SessionCtx as VerbCtx, execVerb } from "./command-exec.js";
import { realGitSpawn } from "./git-helpers.js";

import { loadAgentFiles } from "./agent-file-store.js";
import { type LoadedCommand, expandCommand, loadCommandFiles } from "./command-files.js";
import { loadEffortRules } from "./effort-rules.js";
import { loadGrantsInto, saveGrants } from "./grants-store.js";
import { type HooksSource, loadHooksDetailed } from "./hooks-config.js";
import { type McpSession, openMcpSession, withMcpTools } from "./mcp-session.js";
import { modelCandidates, resolveModelCandidate } from "./model-candidates.js";
import {
  type Backends,
  backendSummary,
  detectBackends,
  emptyBackends,
  renderOnboarding,
  runPathsWizard,
  runSetup,
  stopSelfStartedRunners,
} from "./onboarding.js";
import {
  DEFAULT_SUBAGENTS,
  detachedRunNote,
  orchestratorNote,
  spawnCapFor,
  startDetachedRun,
} from "./orchestrator.js";
import { completePath, completeSlashArg } from "./path-completer.js";
import { applyRepoMapVerb, makeRepoMapState, repoMapStats } from "./repo-map-state.js";
import { type SessionCtx as LegacySlashCtx, type SlashResult, execSlash } from "./slash-exec.js";
import {
  type HookListing,
  type HookTestOutcome,
  type SlashCtx,
  allSlashNames,
  findSlash,
} from "./slash-registry.js";
import { createSteeringController } from "./steering.js";
import { execVarsFromEnv } from "./system-tools.js";
import { createWorkingSet, isPathAllowed } from "./working-set.js";

/** The live AgentTuning type (re-exported by core under the `agent` namespace). */
type AgentTuning = agent.AgentTuning;

// ── the host's superset session context (the one this unit exports) ────────── //

/**
 * SessionCtx — the host-owned SUPERSET context. It carries everything any of the
 * three line-handlers might need; the host projects the relevant slice into each
 * sibling's narrower `SessionCtx` at the call site. Kept flat + small:
 *   - `client`   the single JS→engine gateway (C5),
 *   - `state`    the LIVE core ReplState (transcript + tuning + activePane + cwd + history),
 *   - `json`     the inherited --json flag (human text → stderr; machine → stdout),
 *   - `profile`  the active profile name (drives the §4 force-forbidding hard block),
 *   - `confirm`  a yes/no prompt over readline (the never-force / typed-confirm seam),
 *   - `write`    the single output sink (so tests capture output deterministically),
 *   - `signal`   RESERVED: a per-turn AbortSignal seam. Ctrl-C trips the host's
 *                AbortController, but neither the session siblings nor the core
 *                runAgentTurn accept a signal yet, so mid-turn cancellation is
 *                cosmetic (the host announces the cancel; the turn runs to
 *                completion). Wire through once those APIs grow a signal param.
 */
export interface SessionCtx {
  readonly client: EngineClient;
  state: repl.ReplState;
  readonly json: boolean;
  readonly profile: string | undefined;
  readonly confirm: (prompt: string) => Promise<boolean>;
  readonly write: (line: string) => void;
  readonly signal: AbortSignal;
}

/** The three pluggable line-handlers, in their REAL sibling signatures (for tests). */
export interface SessionHandlers {
  execSlash(name: string, rest: string, ctx: LegacySlashCtx): Promise<SlashResult>;
  execVerb(tokens: string[], ctx: VerbCtx): Promise<CommandOutcome>;
  runMessageTurn: typeof runMessageTurn;
}

/** Injectable seams (readline / writer / clock / client / handlers) for testability. */
export interface SessionDeps {
  /** Build the readline interface (default: createInterface over stdin/stdout). */
  makeReadline?: () => ReadlineInterface;
  /** The output sink (default: process.stdout.write). */
  write?: (s: string) => void;
  /** The clock (default: () => new Date()). */
  now?: () => Date;
  /** The engine gateway (default: createEngineClient()). */
  client?: EngineClient;
  /** Override any of the three line-handlers (default: the real siblings). */
  handlers?: Partial<SessionHandlers>;
  /** Override TTY detection (default: process.stdin.isTTY === true). */
  isTty?: boolean;
  /** Pre-computed backends (tests inject to skip the startup network probe). */
  backends?: Backends;
  /** the ~/.prometheus home root (tests point this at a temp dir to avoid touching $HOME). */
  home?: string;
  /**
   * The OS home the SHARED `<home>/.config/prometheus-studio` tree resolves from — where the
   * persisted permission grants live. Separate from `home` because that tree is shared with the
   * desktop app and is keyed off the real user home, not PROMETHEUS_HOME.
   */
  configHome?: string;
  /** the session's MCP surface (tests inject; default: connect the configured servers). */
  mcp?: McpSession;
}

// ── verb recognition: which single tokens are real §2 verbs (vs a chat message) ── //

/**
 * The single-token verbs a BARE line (no leading "/") may invoke in-session. Multi-
 * word nouns (`plugin install`, `model pull`) are NOT auto-routed from a bare line —
 * that keeps natural-language messages (which often start with a noun) from being
 * mis-read as commands. To run a multi-word verb in-session, prefix it with "/" or
 * the verb still routes when it is the ONLY token (e.g. `scan`).
 */
const SESSION_VERBS = new Set([
  // `agents` — the background-run table. In-session ONLY works because `runRegistry` is a
  // module singleton: a run started by `/background` lives in THIS process, so listing it
  // from a second `prometheus` invocation would correctly show nothing. Routing the bare
  // verb here is what makes the table observable at all from the session that owns it.
  "agents",
  "scan",
  "superscan",
  "doctor",
  "matrix",
  "inventory",
  "list",
  "info",
  "describe",
  "tutorial",
  "methods",
  "harden",
  "status",
  "where",
  "vault",
]);

/** Providers that run on a LOCAL runner → priced $0 for /stats (CLI-058); mirrors session-bridge. */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "vllm", "llamacpp", "local"]);

/** Is a bare line a recognized single-token verb? (exactly one token, in the set). */
function looksLikeVerb(tokens: string[]): boolean {
  return tokens.length === 1 && tokens[0] !== undefined && SESSION_VERBS.has(tokens[0]);
}

// ── tuning seed: --profile → CliProfile → AgentTuning (flags win) ──────────── //

/**
 * Resolve the starting AgentTuning from the parsed args: the named (or default)
 * built-in profile, with the §1 engine global flags layered on top (flags win, §6).
 * Falls back to the `default` profile when an unknown profile name is given.
 */
export function seedTuning(parsed: ParsedArgs): AgentTuning {
  return seedTuningWithNotes(parsed).tuning;
}

/**
 * The same seed, plus what the project `.prometheus.toml` was refused.
 *
 * The project layer may tighten the safety posture and never loosen it — it arrives with the
 * code, so a checked-in `gateMode = "off"` would otherwise disable the scanner for anyone who
 * ran `prometheus` in that directory. The refusals come back here so the host can SAY so at
 * startup rather than dropping the line in silence.
 */
export function seedTuningWithNotes(parsed: ParsedArgs): {
  tuning: AgentTuning;
  rejected: cliProfiles.ProjectLayerRejection[];
  /** the profile's `[budget]` caps, if it declared any (CLI-030). */
  budget?: cliProfiles.CliProfile["budget"];
} {
  // Effective profile = builtin ⊕ user(--profile flag > persisted active) ⊕ project `.prom.toml`
  // (project TIGHTENS ONLY, CLI-046); then the §1 engine flags layer on top (flags win, CLI-044).
  // The flags are the human at the keyboard, so they still win outright — including downward.
  const { profile, rejected } = loadEffectiveStartupProfileWithNotes(parsed);
  const merged = cliProfiles.mergeFlags(profile, {
    ...(parsed.gateMode ? { gateMode: parsed.gateMode } : {}),
    ...(parsed.dryRun ? { dryRun: true } : {}),
    ...(parsed.yes ? { yes: true } : {}),
    // The `/think` ladder, pinned from the command line. Flags are the human at the keyboard,
    // so they win outright over `[agent] effort` in every config layer.
    ...(parsed.effort ? { effort: parsed.effort } : {}),
    ...(parsed.forceEffort ? { effortForce: true } : {}),
  });
  return {
    tuning: cliProfiles.resolveTuning(merged),
    rejected,
    ...(merged.budget ? { budget: merged.budget } : {}),
  };
}

/**
 * Build the spend guard from a profile's `[budget]` table, or undefined when it declared none.
 *
 * The price mapping is deliberate rather than a spread: the registry says
 * `inputUsdPerMTok`/`outputUsdPerMTok` and the guardrail wants `pricePerMTokIn`/`pricePerMTokOut`.
 * Every field on both is optional, so passing the wrong shape is NOT a type error — it silently
 * prices every turn at $0 and the cap never fires. That is the exact failure this whole task is
 * about, so it is spelled out.
 */
/**
 * Is this model served from the user's own machine, and therefore genuinely free?
 *
 * Matches how the rest of the session decides locality (`LOCAL_PROVIDERS` + the endpoint's
 * own `locality`), degraded to a name test because the accounting store records only a model
 * id. A false negative here costs a fail-closed block with a nameable remedy; a false positive
 * would silently disable the cap, so the test is deliberately narrow.
 */
export function isLocalModelId(model: string): boolean {
  const m = model.toLowerCase();
  if (m.startsWith("local:") || m.startsWith("ollama:") || m.startsWith("lmstudio:")) return true;
  return [...LOCAL_PROVIDERS].some((p) => m.startsWith(`${p}:`) || m.startsWith(`${p}/`));
}

export function makeBudgetGuard(
  budget: cliProfiles.CliProfile["budget"] | undefined,
  pricing: ai.Pricing,
  forceBudget: boolean,
): BudgetGuard | undefined {
  if (!budget) return undefined;
  const config: ai.BudgetConfig = {
    ...(budget.sessionUsd !== undefined ? { sessionUsd: budget.sessionUsd } : {}),
    ...(budget.dailyUsd !== undefined ? { dailyUsd: budget.dailyUsd } : {}),
    ...(budget.warnAtPercent !== undefined ? { warnAtPercent: budget.warnAtPercent } : {}),
    ...(budget.unpricedPolicy !== undefined ? { unpricedPolicy: budget.unpricedPolicy } : {}),
  };
  if (config.sessionUsd === undefined && config.dailyUsd === undefined) return undefined;
  return {
    config,
    /**
     * `undefined` means WE DO NOT KNOW; `{null,null}` means known-free.
     *
     * The distinction decides whether a USD cap can be enforced at all. Thirteen of the
     * eighteen cloud providers have no price entry, and an unpriced record used to contribute
     * $0 — so a `session_usd = 1` cap let an enormous Groq session through reporting $0 spent
     * while the same tokens on Claude blocked at $1800. `evaluateBudgets` now fails closed on
     * ignorance, which only works if genuine zeroes are reported as zeroes.
     *
     * A LOCAL model is a genuine zero: it is the user's own hardware and no cap can be
     * exceeded by it, whatever the price table does or does not contain.
     */
    priceFor: (model: string) => {
      const p = ai.priceForModel(pricing, model);
      if (p) return { pricePerMTokIn: p.inputUsdPerMTok, pricePerMTokOut: p.outputUsdPerMTok };
      if (isLocalModelId(model)) return { pricePerMTokIn: null, pricePerMTokOut: null };
      return undefined;
    },
    forceBudget,
    warned: new Set<string>(),
  };
}

// ── banner + footer rendering (pure presentation over render.ts helpers) ───── //

/**
 * The ZEUS mark — a SHORT, wide, muscular Titan (Claude-Code-logo height) with a
 * thunderbolt in his raised hand. Drawn in single-width block glyphs and colored per
 * SEGMENT (each row is an array of [glyphs, tint]) so one line can mix skin, muscle,
 * and a bright-yellow bolt while the box stays visible-length aligned. Muscle zones:
 * silver hair · skin face · cyan arms+pecs · brand abs · blue quads · yellow bolt.
 */
type ZeusSeg = readonly [string, (s: string) => string];
const ABS = (s: string): string => c.role(s, "brand");
const ZEUS_ROWS: ReadonlyArray<ReadonlyArray<ZeusSeg>> = [
  [
    ["        ", c.gray],
    ["Ϟ", c.yellow],
  ], // thunderbolt (in the raised hand)
  [
    ["  ▟▀▀▙  ", c.gray],
    ["▟", c.cyan],
  ], // head + raised forearm
  [
    [" ██▀▀██", c.yellow],
    ["▟▘", c.cyan],
  ], // face (eyes) + raised arm
  [["▟████████▙", c.cyan]], // shoulders / traps
  [["███▟█▙▟█▙███", c.cyan]], // arms + PECTORALS (two domes)
  [[" █ █▀█▀█ █", ABS]], // ABS (six-pack grid)
  [["  ▐██▌██▌", c.blue]], // QUADS (thighs)
];

/** Render one segmented Zeus row to a single (colored) string. */
function zeusRow(row: ReadonlyArray<ZeusSeg>): string {
  return row.map(([s, tint]) => tint(s)).join("");
}

/**
 * The big block WORDMARK — "PROMETHEUS" drawn 5 rows tall in full-block glyphs,
 * one strong-palette tint per letter so the title sweeps cool→warm
 * (cyan → blue → magenta → red → yellow). Each glyph is a fixed 5-col cell; rows
 * are assembled column-aligned, so the colored output stays visible-length even.
 */
type Glyph = readonly [string, string, string, string, string];
const WORDMARK: ReadonlyArray<readonly [Glyph, (s: string) => string]> = [
  [["███ ", "█  █", "███ ", "█   ", "█   "], c.cyan], // P
  [["███ ", "█  █", "███ ", "█ █ ", "█  █"], c.cyan], // R
  [["▟██▙", "█  █", "█  █", "█  █", "▜██▛"], c.blue], // O
  [["█   █", "██ ██", "█ █ █", "█   █", "█   █"], c.blue], // M
  [["████", "█   ", "███ ", "█   ", "████"], c.magenta], // E
  [["█████", "  █  ", "  █  ", "  █  ", "  █  "], c.magenta], // T
  [["█  █", "█  █", "████", "█  █", "█  █"], c.red], // H
  [["████", "█   ", "███ ", "█   ", "████"], c.red], // E
  [["█  █", "█  █", "█  █", "█  █", "▜██▛"], c.yellow], // U  (rounded bowl ≠ V)
  [["▟███", "█   ", "▜██▙", "   █", "███▛"], c.yellow], // S
];

/** Assemble the 5-row big wordmark, each letter tinted, joined by a space column. */
function wordmarkRows(): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    rows.push(WORDMARK.map(([g, tint]) => tint(g[r] ?? "")).join(" "));
  }
  return rows;
}

/**
 * The Claude-Code-style startup banner: a rounded box with the muscular ZEUS mark +
 * the PROMETHEUS wordmark, the active backend (model), the cwd — then a dim tips +
 * composer-hint block. `backendLine` is the detected backend (e.g. "local · qwen").
 *
 * ⚠ DO NOT HIDE THIS BANNER. The ZEUS·CRONOS titan figure (ZEUS_ROWS, thunderbolt)
 * + the big "PROMETHEUS" wordmark (WORDMARK) are the product's identity and MUST show
 * at startup on EVERY interactive surface. This function is EXPORTED so the raw-mode
 * TUI (apps/cli/src/tui/) prints the SAME banner — never substitute a backend-only
 * summary (that is exactly the regression that dropped the figure on 2026-06-24).
 * If you add a new front-end, call THIS, don't re-derive a shorter banner.
 */
export function banner(state: repl.ReplState, backendLine: string): string {
  const tagline = c.dim("the AI-everything control plane");
  // The human figure (left) and the big PROMETHEUS wordmark (right, right-aligned)
  // share the SAME rows, so the header stays short. Glyphs/colors are untouched —
  // only their placement changes. The wordmark is vertically centered against the
  // figure; the dim tagline rides the row just below it.
  const figure = ZEUS_ROWS.map(zeusRow);
  const figW = Math.max(...figure.map(visibleLen));
  const wm = wordmarkRows();
  const top = Math.floor((figure.length - wm.length) / 2);
  const GAP = "    ";
  const mark = figure.map((row, i) => {
    const left = padEnd(row, figW);
    const wmIdx = i - top;
    if (wmIdx >= 0 && wmIdx < wm.length) return `${left}${GAP}${wm[wmIdx]}`;
    if (wmIdx === wm.length) return `${left}${GAP}${tagline}`;
    return left;
  });
  const lines = [
    ...mark,
    "",
    `${c.dim("model")}   ${backendLine}`,
    `${c.dim("cwd")}     ${c.dim(bannerCwd(state.cwd))}`,
  ];
  const tips = [
    c.dim("Tips:"),
    c.dim(" • type a message to chat · a verb (scan / list / harden) runs it"),
    c.dim(" • /setup pick a model · /help commands · /quit (Ctrl-D) exit"),
    c.dim(" • ⏎ send · / commands · ↑ history · Ctrl-C interrupt a turn"),
  ].join("\n");
  return [box(lines, { border: "brand" }), "", tips].join("\n");
}

/**
 * Resolve the effective TUI keymap (CLI-096) from the user config's `[keymap]` table. Fail-soft: a
 * missing/unreadable/corrupt config ⇒ the default keymap. The resolution itself surfaces any
 * conflict/reserved errors (`/keys` prints them) — this only handles the fs read.
 */
function loadKeymap(home: string | undefined): KeymapResolution {
  try {
    const table = cliProfiles.parseToml(readFileSync(cliProfiles.configPath(home), "utf8"));
    const km = cliProfiles.getPath(table, "keymap");
    return resolveKeymap(
      km && typeof km === "object" ? (km as Record<string, unknown>) : undefined,
    );
  } catch {
    return resolveKeymap(undefined);
  }
}

/**
 * The live status bar (Claude-Code footer): pipe-separated, dim, with the model
 * accent-tinted — cwd │ model · tools · gate · dry-run · verbosity. Re-rendered
 * before each prompt so tuning changes (/gate, /model) show immediately.
 */
function footer(state: repl.ReplState, fleet?: FleetFooter): string {
  const dir = shortCwd(state.cwd);
  // repl.footerLine carries "model X · tools:on · gate:warn · dry-run:off · verbosity:normal".
  const line = `${c.dim(dir)}  ${c.dim("│")}  ${c.dim(repl.footerLine(state.tuning))}`;
  /**
   * The fleet bar is a SECOND footer row on this host too.
   *
   * Parity is not decoration here: the readline host is what runs when the terminal cannot do
   * raw mode — over a plain ssh pipe, inside CI, on a dumb $TERM — and those are exactly the
   * sessions a user is most likely to have several of and least likely to be watching. A
   * presence bar that existed only on the pretty host would be missing from the case that needs
   * it. Both hosts call the SAME renderer, so the two cannot drift into disagreeing about what
   * `needs-you` looks like.
   */
  const bar = fleet?.model ? fleetBarLine(fleet.model, fleet.width, fleet.caps) : null;
  return bar ? `${line}\n${bar}` : line;
}

/** What `footer` needs to paint the fleet row. Absent ⇒ no fleet row, same as a fleet of one. */
interface FleetFooter {
  model: Parameters<typeof fleetBarLine>[0] | null;
  width: number;
  caps: Parameters<typeof fleetBarLine>[2];
}

// ── default handler wiring (the real siblings) ─────────────────────────────── //

function resolveHandlers(over?: Partial<SessionHandlers>): SessionHandlers {
  return {
    execSlash: over?.execSlash ?? execSlash,
    execVerb: over?.execVerb ?? execVerb,
    runMessageTurn: over?.runMessageTurn ?? runMessageTurn,
  };
}

// ── the host loop ──────────────────────────────────────────────────────────── //

/**
 * Launch the interactive session and return the process exit code.
 *
 * Pure-ish at the edges: all I/O goes through the injected `write` + `readline`
 * seams so a scripted fake can drive the whole loop in a unit test. The ONLY real
 * side effect when run for real is the readline interface over stdin/stdout.
 */
export async function launchSession(parsed: ParsedArgs, deps: SessionDeps = {}): Promise<number> {
  const write = deps.write ?? ((s: string) => void process.stdout.write(s));
  const writeLine = (line: string): void => write(`${line}\n`);

  // An interactive session needs a TTY for stdin; without one (piped / CI) refuse
  // gracefully with a hint rather than hang on a dead readline.
  const isTty = deps.isTty ?? process.stdin.isTTY === true;
  if (!isTty && deps.makeReadline === undefined) {
    writeLine(
      `${c.yellow("prometheus: the interactive session needs a TTY.")}\n${c.dim(
        "Run a one-shot command instead — e.g. `prometheus scan`, `prometheus plugin list`.",
      )}`,
    );
    return 1;
  }

  const now = deps.now ?? (() => new Date());
  const client = deps.client ?? createEngineClient();
  const handlers = resolveHandlers(deps.handlers);

  // First contact: ensure the ~/.prometheus tree exists, and point the engine's model
  // downloads at the resolved open_models dir (paths.json override > default) via the env
  // the modelhub sidecar reads — so a `model pull` lands where the user chose.
  const home = deps.home ?? prometheusHome();
  const tokenToggles = readTokenToggles(); // CLI-088: session-scoped token-economy toggles, read once
  ensureHomeTree(home);
  process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);

  // Seed the PURE core REPL state from the profile (+ flags) and the cwd.
  const {
    tuning,
    rejected: projectRejections,
    budget: profileBudget,
  } = seedTuningWithNotes(parsed);
  /**
   * The last `/think` tier, restored — the effort twin of the authorisation level.
   *
   * Precedence, most specific first: a `--think/--effort` FLAG (this launch) > the SAVED tier
   * (last session) > the profile layers (a static default). Restored as the REQUESTED tier and
   * re-resolved per request against whatever model is bound, so changing model re-applies it.
   */
  const savedEffort = cliProfiles.readSavedEffort(deps.configHome);
  if (savedEffort && parsed.effort === undefined) tuning.effort = savedEffort;
  const cwd = resolveCwd(parsed.cwd, writeLine);
  let state = repl.initialReplState(tuning, cwd);
  // capture the profile's system prompt BEFORE any /system override → /system reset (CLI-017).
  const systemPromptDefault = state.tuning.systemPrompt;
  // per-session working set of extra readable dirs (/add-dir, CLI-004). `let`: /cd resets it for
  // the new project — see session-bridge.ts's identical fix/comment.
  let ws = createWorkingSet();
  // pre-image log for applied propose_edit calls (CLI-010).
  const editHistory: EditRecord[] = [];
  // turn-atomic workspace checkpoints for /revert + /checkpoints (CLI-015).
  const checkpointStore = new agent.CheckpointStore(50);
  void now; // reserved for future session timestamping; keeps the seam wired.
  // the built-in repo map (CLI-053): session-scoped, default OFF (a huge repo shouldn't pay the
  // walk unbidden). `/repomap on|refresh` builds it; turnCtx injects it as a system-context block.
  const repoMapState = makeRepoMapState(state.cwd);
  // model-aware pricing table for /stats cost (CLI-058) — loaded once from providers.config.json.
  const pricing = loadPricing();
  // The spend cap, if the profile declared one. `--force-budget` is a per-RUN flag and never a
  // profile key: a config file must not be able to pre-authorise blowing through its own cap.
  const budgetGuard = makeBudgetGuard(
    profileBudget,
    pricing,
    parsed.flags["force-budget"] === true,
  );
  // steering controller (CLI-061): AGENTS.md/CLAUDE.md/PROMETHEUS.md discovery + edit + reload.
  const steering = createSteeringController({
    cwd: () => state.cwd,
    write: (p, content) => writeFileSync(p, content),
    openEditor: defaultOpenEditor,
    confirm: (prompt) => confirm(prompt),
  });
  // Durable cross-session memory: the `memory_write`-authored index, re-read every turn (same
  // "getter, not a value" posture as `steering`) so a write earlier in THIS session is visible
  // on the next turn with no restart. null when this project has never had an entry written.
  // `home` here is PROMETHEUS_HOME (line ~526) — the SAME root `memory_write` itself resolves
  // to via `ctx.home` in agent-runtime's `makeToolRunner`, so the index this reads is always
  // the one a call in this same session just wrote.
  const loadMemory = (): string | null => loadMemoryIndexBlock(home, state.cwd);

  // Remembered "don't ask again" grants, and the session task list.
  //
  // Both existed and were wired in the TUI host only, so which agent capabilities you had
  // depended on which front end you happened to launch: in this host `todowrite` reported
  // itself unavailable and every approval was asked again, every time. Same stores, same
  // lifetimes, same rendering — the two hosts are siblings and had drifted.
  /**
   * The user's `[permissions]` allow/ask/deny rules — the producer the engine never had.
   *
   * Loaded once per session from `~/.config/prometheus-studio/config.toml` (plus a project
   * `.prometheus.toml`, which may only TIGHTEN). `ctx.permissionRules` had two mentions in the
   * whole repository — a declaration and a read — and no assignment, so the rule list was
   * always empty and the documented feature could not be reached at all.
   *
   * `let`, not `const`: `/cd` (below) re-derives this for the NEW cwd when it rotates projects —
   * a project's own tightened rules must govern it, not whatever the OLD project declared.
   */
  let permissionRules = loadPermissionRules({ home: deps.configHome, cwd });
  /** What THIS endpoint has been observed to do about tool calls, across the whole session. */
  let toolCapability = agent.protocol.initialCapability();
  const grants = new agent.ScopedPermissionStore();
  const loadedGrants = loadGrantsInto(grants, deps.configHome);
  // Sub-agent personas from markdown. Already clamped by SCOPE inside `loadAgentFile`: a file
  // that arrived with a cloned repo is read-only, cannot pick a model, and its text is fenced
  // as untrusted persona guidance rather than becoming the system prompt.
  //
  // `let`: `/cd` re-derives this for the NEW cwd — a persona file from the OLD project silently
  // keeping its trust in a different one would be a correctness (and trust) bug, not a convenience.
  let agentFiles = loadAgentFiles(cwd, home);
  // User-defined `/name` commands. Built-in names are refused at load time, and the dispatcher
  // consults the built-in registry first — a repo cannot redefine `/gate`. `let`: re-derived by
  // `/cd` for the same reason as `agentFiles` above.
  let commandFiles = loadCommandFiles(cwd, new Set(allSlashNames()), home);
  const todos = new agent.TodoStore();

  // Backend detection (fail-soft): probe for a live local runner+model, else note the
  // paid CLIs. When a local model is found, ADOPT it as the session endpoint + model so
  // chat works with zero config; otherwise keep the profile model and point at /setup.
  const backends: Backends =
    deps.backends ?? (await detectBackends({ client }).catch(() => emptyBackends()));
  let endpoint: AiEndpoint | undefined = backends.localEndpoint;
  /**
   * The in-flight context-window/capability probe, if one was kicked off below — awaited
   * (bounded) exactly once, right before the FIRST turn reads `endpoint.contextWindow`, so that
   * turn budgets against the real number instead of racing it. See `CONTEXT_PROBE_AWAIT_MS`.
   */
  let contextProbe: Promise<unknown> | undefined;
  /**
   * The session's ONE measuring seam, cache and all — the TUI bridge's twin. See
   * `ai/endpoint-probe.ts`: `/model`, `/worker` and `/setup` each rebind `endpoint` to a
   * freshly built object carrying neither a measured window nor `probedCapabilities`, and
   * before this existed nothing re-measured, so a model switch silently reverted compaction
   * and the tool preamble to the 8192 floor and `/think` to "not available".
   */
  const endpointProbe = createEndpointProbe({ fetch: fetch as never });
  /**
   * The session's EFFECTIVE effort capability table: the builtins, plus any user or workspace
   * override file. Loaded ONCE — it is disk-backed, and re-reading it per turn would put two
   * file stats on the request path for a table that only changes when a human edits it.
   *
   * Malformed entries are reported rather than swallowed: a rule the user believes is in force
   * but which was silently dropped is worse than no override at all.
   */
  let effortRulesLoad = loadEffortRules(state.cwd, home);
  // Say what was refused. A malformed override is the one case where silence is worse than
  // noise: the user edited a file specifically to change this behaviour.
  for (const note of effortRulesLoad.notes) {
    writeLine(`  ! effort rules: ${note}`);
  }
  /**
   * Point the session at `next` AND (re)measure it. EVERY rebind goes through here.
   *
   * Returns the in-flight probe so an interactive caller (`/model`, `/setup` — the user is
   * already waiting on a command) can await it and have `/think`/`/status` be right on the very
   * next line, while session start stays fire-and-forget and lets the existing bounded
   * `contextProbe` wait ahead of the first turn cover the race.
   */
  const adoptEndpoint = (next: AiEndpoint): Promise<void> => {
    /**
     * A new endpoint starts with a CLEAN capability slate.
     *
     * `toolCapability` is documented as "what THIS endpoint has been observed to do about tool
     * calls" but was a single session-scoped variable that nothing ever reset. So one model
     * rejecting native tool calls latched the whole session into the text protocol, and
     * `/model` to a model that supports them natively kept the degraded transport for the rest
     * of the session — with the preamble still teaching a text syntax the new model does not
     * need. The observation is only ever true of the endpoint it was made against.
     */
    toolCapability = agent.protocol.initialCapability();
    endpoint = next;
    // pre-load the local model NOW (fire-and-forget) so the user's next prompt is warm.
    warmupLocalModel(next, home);
    const settled = endpointProbe
      .attach(next)
      .then((r) => {
        // A slow probe for a model the user has ALREADY switched away from must not resurrect
        // it. Identity is (id, model): `/model` rebuilds the object, so reference equality
        // would never hold, and the id alone is not unique across a runner's models.
        if (endpoint?.id !== next.id || endpoint?.model !== next.model) return;
        if (r.measured) {
          endpoint = r.endpoint;
          return;
        }
        if (r.failed) {
          // `source:"default"` means the probe FAILED, not that 8192 is real. Silently keeping
          // the floor is indistinguishable from a genuinely small model, so a large-window
          // model whose probe failed would compact and budget the tool preamble as if it were
          // about to overflow all session, with no visible sign anything went wrong.
          writeLine(
            `  ! could not measure ${next.model}'s real context window — using the ${DEFAULT_CONTEXT_WINDOW}-token floor (context budgeting may be too conservative)`,
          );
        }
      })
      .catch(() => {
        /* fail-soft: the documented floor stands */
      });
    contextProbe = settled;
    /**
     * Interactive callers await THIS, not `settled`.
     *
     * `probeContextWindow` bounds each request at `PROBE_TIMEOUT_MS`, but it makes TWO of them
     * in sequence, so a wedged runner could still freeze `/model` for ~5s with no output. This
     * caps the wait at the same `CONTEXT_PROBE_AWAIT_MS` the pre-turn wait uses; the probe is
     * NOT cancelled — it keeps running and adopts its answer when it lands, guarded against
     * having been switched away from in the meantime.
     *
     * The timer is unref'd so a one-shot run is never held open by a wait nobody is watching.
     */
    return Promise.race([
      settled,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, CONTEXT_PROBE_AWAIT_MS);
        t.unref?.();
      }),
    ]);
  };
  /**
   * The cloud providers configured on this machine — the endpoints an interactive session
   * could never reach.
   *
   * `detectBackends` probes exactly two hardcoded LOCAL runners, so no cloud provider was ever
   * a candidate: `endpoint.apiKeyRef` was always undefined and the transport took its
   * `Bearer local` branch. The swarm lane has resolved these same providers, from these same
   * env vars and the same keychain accounts, from one call site — an ordinary chat could not.
   *
   * Fail-soft: a machine with no keychain tool (Windows) simply discovers whatever the
   * environment declares.
   */
  const cloudKeys = await keychainProviders(orchestration.API_PROVIDER_IDS).catch(
    () => new Set<string>(),
  );
  const cloudEndpoints = ai.discoverCloudEndpoints({
    env: process.env,
    hasKeychainKey: (id) => cloudKeys.has(id),
  });
  // Read per request, never cached: a resolved key held in a closure outlives the user
  // revoking it. This assignment is what makes `SessionCtx.resolveKey` — declared, threaded
  // and consumed all along — reachable for the first time.
  const resolveKey = createKeyResolver();
  // A cloud endpoint is selected only when the user has no local runner; otherwise the local
  // one stays the default, because it is free, private and already warm.
  if (!endpoint && cloudEndpoints.length > 0) {
    endpoint = cloudEndpoints[0]?.endpoint;
  }
  if (endpoint) {
    state = repl.reduce(state, {
      type: "tune",
      patch: {
        model: { provider: backends.localRunner?.name ?? "ollama", modelId: endpoint.model ?? "" },
      },
    });
    /**
     * Warm the local model AND ask the runner how big its context ACTUALLY is / what it can do.
     *
     * Every endpoint builder hard-codes 8192. THREE things budget against that number and all
     * three were wrong here by up to 32x on a 262144-window model: auto-compaction, which
     * compacted a huge-window session as though it were about to overflow; the TOOL PREAMBLE,
     * whose budget decides whether the model is shown tool descriptions at all; and — via the
     * same probe's `capabilities` array — whether `/think` has any mechanism to work with.
     *
     * Fire-and-forget here (the bounded wait ahead of the first turn closes the race);
     * `/model` and `/setup` await the same seam instead.
     */
    void adoptEndpoint(endpoint);
  }

  // Orchestrator mode: when we're inside a live tmux session, start with 3 subagents by
  // default; the main agent scales that up per prompt (decideSubagentCount). Outside tmux
  // it's a single agent. `subagentCount` is the live default the orchestrator scales from.
  const orchestrating = deps.isTty !== false && insideTmux();
  let subagentCount = orchestrating ? DEFAULT_SUBAGENTS : 1;
  /** The delegation cap for the CURRENT turn — see the TUI host's twin. */
  let spawnCap = agent.DEFAULT_MAX_SPAWNS;
  /**
   * The number the USER typed at `/agents`, or null while they have not.
   *
   * Distinct from `subagentCount`, which carries a display default (3 under tmux, 1 without)
   * that must never become the delegation cap — capping at 1 for everyone without a
   * multiplexer would be a silent downgrade of a setting nobody touched.
   */
  let explicitAgents: number | null = null;

  // `pathMode` flips the readline completer into filesystem-path tab-completion for the
  // duration of an askPath() prompt (a folder picker). Outside such a prompt Tab is no longer
  // a dead key: it completes the path ARGUMENT of a path-taking slash command (`/cd ~/pro`),
  // the same set the TUI's dropdown completes, so the two hosts behave identically.
  let pathMode = false;
  /**
   * Does the autonomy ladder auto-approve this call WITHOUT asking a human?
   *
   * This host used to answer with `agent.authDecision(level, name, annotations)` alone, while
   * the TUI host and the one-shot host both refine that answer for the two tools where the tool
   * NAME is not enough to know the risk:
   *
   *   - `write_file` has no working-set guard of its own — the confirm prompt IS its
   *     authorization. `authDecision` alone auto-approved it at level >= 2 ("auto-approve
   *     edits") for ANY absolute path, so `write_file {path:"~/.zshrc"}` was written without a
   *     prompt under `prometheus --plain` while the same level under the TUI asked. The
   *     authorisation level is persisted and shared by both surfaces, so the user's setting
   *     silently meant something weaker depending on which one they launched.
   *   - `run_command`'s risk is its COMMAND, not its name. `execAuthDecision` grades the parsed
   *     command's tier (read / write / install / destructive); `authDecision` cannot see it, so
   *     level 4 auto-ran installs and destructive shell commands here that the TUI still asked
   *     about.
   *
   * Fail-closed throughout: an unparseable command or an unresolvable path is NOT auto-approved,
   * it falls through to the prompt.
   */
  const hostAutoApproves = (call: agent.ToolCall, annotations?: ToolAnnotations): boolean => {
    const level = hostAuthLevel;
    if (call.name === "write_file") {
      const raw = typeof call.args.path === "string" ? call.args.path : "";
      if (!raw) return false;
      const abs = isAbsolute(raw) ? raw : resolve(state.cwd, raw);
      const inScope = isPathAllowed(abs, [state.cwd, ...ws.list()]);
      return agent.scopedWriteDecision(level, call.name, annotations, inScope) === "allow";
    }
    if (call.name === "run_command") {
      const line = typeof call.args.command === "string" ? call.args.command : "";
      if (!line) return false;
      const parsed = agent.parseCommand(line, { vars: execVarsFromEnv() });
      if (!parsed.ok) return false; // unparseable ⇒ the prompt decides, never the ladder
      const cls = agent.classifyCommand(parsed.command);
      if (!cls.ok) return false;
      return agent.execAuthDecision(level, cls.tier) === "allow";
    }
    return agent.authDecision(level, call.name, annotations) === "allow";
  };

  const rl =
    deps.makeReadline?.() ??
    createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "",
      completer: (line: string): [string[], string] =>
        pathMode ? completePath(line) : (completeSlashArg(line) ?? [[], line]),
    });

  // Connect the configured MCP servers so their tools join the catalog for this session.
  // Fail-soft and, with no connectors configured, free: `openMcpSession` starts nothing.
  const mcp = deps.mcp ?? (await openMcpSession({ home, write: writeLine }).catch(() => undefined));

  writeLine(banner(state, backendSummary(backends)));
  {
    // A project config that tried to loosen the safety posture is reported, never silently
    // dropped: someone wrote that line expecting it to work, and this is also the only signal
    // a user gets that a repo they just cloned tried to turn their scanner off.
    for (const r of projectRejections) {
      writeLine(c.yellow(`! .prometheus.toml: ${r.key} ignored — ${r.reason}`));
    }
    const line = mcp?.banner();
    if (line) writeLine(c.dim(line));
    if (loadedGrants.loaded > 0) {
      writeLine(c.dim(`✓ ${loadedGrants.loaded} remembered permission(s) restored`));
    }
    // A refusal means the file on disk asked for something the UI would never have accepted.
    if (loadedGrants.refused > 0) {
      writeLine(c.yellow(`! ${loadedGrants.refused} saved grant(s) refused as too broad`));
    }
  }
  // First-run onboarding: no usable local model → show the picker hint up front.
  if (!endpoint) {
    writeLine("");
    writeLine(renderOnboarding(backends));
  }
  // Throttled, fail-soft update nudge (cached ≤6h; never blocks the prompt). A one-liner
  // pointing at /updates when a vendor CLI / local model / Prometheus itself has an update.
  void updatesStartupNotice({
    home,
    promVersion: PROM_VERSION,
    client,
    write: writeLine,
    env: process.env,
    ...(process.argv[1] ? { scriptPath: process.argv[1] } : {}),
    cwd: state.cwd,
  })
    .then((line) => {
      if (line) writeLine(line);
    })
    .catch(() => {
      /* an update check must never break the session */
    });
  // tmux → orchestrator mode: announce the default subagent fan-out (auto-scales per prompt).
  if (orchestrating) {
    writeLine(
      c.dim(
        `🛸 orchestrator: ${subagentCount} subagents (tmux active) — auto-scales for complex prompts · /agents to set`,
      ),
    );
  }

  // Per-turn cancellation: Ctrl-C aborts the in-flight turn (NOT the session). A
  // fresh AbortController is created per line and tripped on SIGINT during that turn.
  let turnAbort: AbortController | null = null;
  let exitCode = 0;
  let closing = false;
  // The running conversation history threaded to the agent runtime across turns.
  let history: agent.ThreadMessage[] = [];
  // CLI-072: when a turn pauses at its step cap, its full non-system thread (incl. tool results)
  // is stashed here so `/continue` resumes with intact state; null when nothing is resumable.
  // `continueCount` tracks consecutive `/continue`s (shown as "resumed N×"), reset on a clean end.
  let capturedResume: agent.ThreadMessage[] | null = null;
  let continueCount = 0;
  // The persisted session (created lazily on the first agentic turn).
  let session: agent.Session | undefined;
  // /recall (/restore) session-history: a per-session id + a one-time record on the first real
  // prompt. `let`, not `const`: `/cd` (below) mints a fresh one when it rotates to a new project.
  let sessionId = newSessionId();
  let sessionRecorded = false;
  /**
   * Cross-terminal presence (the fleet bar) — the readline host's half of the pair.
   *
   * Same ticker, same renderer, same heartbeat file as the raw-mode TUI. The two CLI hosts have
   * drifted on capability after capability in this file's history; a feature whose whole subject
   * is "what are the OTHER windows doing" must not be one of them, because a window running the
   * plain host would simply be missing from every other window's count.
   */
  let fleet: FleetTicker | null = null;
  const fleetState = (s: "working" | "idle" | "needs-you"): void => fleet?.setState(s);
  /** Report `needs-you` for the duration of a prompt, then hand the window back to `working`. */
  const whileBlocked = async <T>(fn: () => Promise<T>): Promise<T> => {
    fleetState("needs-you");
    try {
      return await fn();
    } finally {
      fleetState("working");
    }
  };
  /** What `footer()` needs to paint the fleet row — resolved fresh, so `/cd` and `/model` show. */
  const fleetFooter = (): FleetFooter => ({
    model: fleet?.model() ?? null,
    width: Math.max(20, (process.stdout.columns ?? 80) - 1),
    caps: detectColorCaps(process.env, !parsed.json && !parsed.noColor && defaultColorEnabled()),
  });
  /** The one-time legend — the same first-run contract the raw TUI honours, same settings key. */
  let legendShown = loadSettings(home).fleetLegendSeen === true;
  const maybeShowFleetLegend = (): void => {
    if (legendShown) return;
    const m = fleet?.model();
    if (!m || m.peers.total <= 1) return;
    legendShown = true;
    writeLine("");
    for (const line of fleetLegendLines(fleetFooter().caps)) writeLine(line);
    writeLine("");
    try {
      saveSettings({ fleetLegendSeen: true }, home);
    } catch {
      /* an unwritable home costs a repeat legend, never a crashed session */
    }
  };
  // /context window: the user-chosen ceiling auto-compact budgets against (default 250k tokens),
  // independent of — and always combined via Math.min with — the model's own measured window.
  let contextWindowSetting = loadContextWindowTokens(home);
  // (A) `/timeout` — the inactivity-pause threshold this session's turns use (default 10 min).
  let idleTimeoutMsSetting = loadIdleTimeoutMs(home);

  const promptLine = (): void => write(`${c.role("›", "brand")} `);

  // Ctrl-C: cancel an in-flight turn; otherwise a no-op nudge (Ctrl-D / /quit exit).
  const onSigint = (): void => {
    if (turnAbort) {
      turnAbort.abort();
      writeLine(c.dim("\n(cancelled — press Ctrl-D or type /quit to exit)"));
    } else {
      writeLine(c.dim("\n(nothing running — Ctrl-D or /quit to exit)"));
      promptLine();
    }
  };
  rl.on("SIGINT", onSigint);

  // The confirm seam: a yes/no over readline. Honors never-force — the host never
  // auto-approves; a human must answer. Defaults to deny on EOF/blank.
  const confirm = (prompt: string): Promise<boolean> => whileBlocked(() => askYesNo(prompt));
  const askYesNo = (prompt: string): Promise<boolean> =>
    new Promise<boolean>((resolveConfirm) => {
      rl.question(`${c.yellow("?")} ${prompt} ${c.dim("[y/N]")} `, (answer) => {
        const a = answer.trim().toLowerCase();
        resolveConfirm(a === "y" || a === "yes");
      });
    });

  /**
   * LIFECYCLE HOOKS (`agent/hooks.ts`) — settings-configured shell run around the turn.
   *
   * Loaded ONCE per session, and only built into a runner when the user actually configured
   * something: with an empty list `hookRunner` stays undefined and every hook seam in the loop
   * is a cheap array check, so the zero-config path costs nothing.
   *
   * The runner is created HERE, in the host, because `agent/loop.ts` is pure — it may not
   * import `node:child_process` (C5), and the desktop's copy of the loop runs in a renderer
   * that could not spawn even if it wanted to.
   *
   * The workspace layer can only NARROW the global hooks or ADD ones that pass a nemesis scan
   * and a one-time trust confirmation over `confirm` — never silently replace or auto-run a
   * repo-supplied command. That confirmation is why hook resolution waits until after `confirm`
   * is defined rather than sitting at the top of the function with the rest of session setup.
   */
  const rawHooks = loadHooksDetailed({ home, cwd: state.cwd });
  const { hooks: sessionHooks, refused: hookRefusals } = await resolveEffectiveHooks({
    home,
    cwd: state.cwd,
    globalHooks: rawHooks.globalHooks,
    workspaceHooks: rawHooks.workspaceHooks,
    confirm,
  });
  const hooksSource: HooksSource = rawHooks.workspaceHooks !== undefined ? "workspace" : "global";
  for (const r of hookRefusals) {
    writeLine(c.dim(`hook refused (${r.event}): ${r.command} — ${r.reason}`));
  }
  const hookRunner =
    sessionHooks.length > 0 ? createHookRunner({ cwd: state.cwd, env: process.env }) : undefined;
  /**
   * SessionStart output, captured once and replayed by the getter on every turn.
   *
   * Kicked off eagerly (not awaited) so a slow session-open script never delays the first
   * prompt: whatever has landed by the time a turn assembles its thread is injected, and a hook
   * that finishes later is picked up by the next turn. A hook that fails contributes nothing.
   */
  let sessionStartBlock: string | null = null;
  if (hookRunner) {
    void agent
      .runSessionStartHooks(sessionHooks, hookRunner, {
        cwd: state.cwd,
        onError: (m) => writeLine(c.dim(`hook: ${m}`)),
      })
      .then((block) => {
        sessionStartBlock = block ?? null;
      })
      .catch(() => {
        /* fail-soft: hooks never take the session down */
      });
  }

  /**
   * The AGENT's confirm: yes/no, plus the two answers that make "don't ask again" real.
   *
   * `ScopedPermissionStore` has had `project` and `user` scopes from the start, the grants file
   * has persisted them, and `withRememberedGrants` has consulted them on every call — and NO
   * host ever returned `remember`, on any surface. The whole mechanism was reachable only by
   * hand-editing `grants.json`. This is the missing half: `a` remembers for THIS project, `A`
   * for every project.
   *
   * Anything else is a no, including a blank line and EOF — the default must never be the
   * permanent answer.
   */
  const confirmTool = (prompt: string): Promise<ConfirmResult> =>
    new Promise<ConfirmResult>((resolveConfirm) => {
      rl.question(
        `${c.yellow("?")} ${prompt} ${c.dim("[y/N/a=always here/A=always]")} `,
        (answer) => {
          const a = answer.trim();
          if (a === "a") return resolveConfirm({ approved: true, remember: "project" });
          if (a === "A") return resolveConfirm({ approved: true, remember: "user" });
          const lower = a.toLowerCase();
          resolveConfirm(lower === "y" || lower === "yes");
        },
      );
    });

  /**
   * Paint the "what will this actually change?" card for a destructive mutator.
   *
   * One node-backed IO seam per call rather than one per session: a preview reads the CURRENT
   * bytes, and a seam captured at startup would happily show a diff against a file the agent
   * rewrote three turns ago. `previewMutation` answers null for every tool that already has a
   * card (or has nothing to show), so this is silent for the common case.
   *
   * A doomed call is announced as doomed. Approving a patch whose hunks no longer match writes
   * NOTHING — the human should learn that here, not from a tool result afterwards.
   */
  const showMutationPreview = (call: { name: string; args?: Record<string, unknown> }): void => {
    const preview = agent.previewMutation(
      call,
      (p) => (p && isAbsolute(p) ? p : p ? resolve(state.cwd, p) : p),
      nodePreviewIo(),
    );
    if (!preview) return;
    for (const line of agent.renderMutationPreview(preview)) {
      write(preview.willFail ? c.yellow(line) : line);
    }
  };

  // A free-text question over readline (the /setup wizard's input seam).
  const ask = (prompt: string): Promise<string> =>
    whileBlocked(
      () =>
        new Promise<string>((resolveAsk) => {
          rl.question(`${c.cyan("›")} ${prompt} `, (answer) => resolveAsk(answer));
        }),
    );

  // A FOLDER picker with `tab` path-completion: flips the completer into path mode,
  // pre-fills the editable default, and returns the typed path (default on blank).
  const askPath = (prompt: string, def: string): Promise<string> =>
    whileBlocked(() => askPathInner(prompt, def));
  const askPathInner = (prompt: string, def: string): Promise<string> =>
    new Promise<string>((resolveAsk) => {
      pathMode = true;
      let answered = false;
      // if stdin EOFs (Ctrl-D) mid-prompt, readline closes WITHOUT firing the question
      // callback — without this guard pathMode would stay true and hijack tab forever.
      const onClose = (): void => {
        if (!answered) {
          pathMode = false;
          resolveAsk(def);
        }
      };
      rl.once("close", onClose);
      rl.question(
        `${c.cyan("›")} ${prompt}\n  ${c.dim("(Tab completes · ⏎ keeps the default)")}\n  `,
        (answer) => {
          answered = true;
          pathMode = false;
          rl.off("close", onClose);
          resolveAsk(answer.trim() || def);
        },
      );
      // pre-fill the default so the user can edit / Tab-extend / accept it.
      if (def) rl.write(def);
    });

  /** /setup: run the onboarding wizard; adopt a chosen local endpoint into the session. */
  const runHostSetup = async (): Promise<void> => {
    const r = await runSetup({ client, write: writeLine, ask, askPath, home });
    if (r.endpoint) {
      // a model dir change in /setup repointed paths.json — refresh the engine env.
      process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);
      state = repl.reduce(state, {
        type: "tune",
        patch: { model: { provider: "ollama", modelId: r.endpoint.model ?? "" } },
      });
      // Adopt = point at it, warm it, AND measure it. `/setup` used to rebind without probing,
      // which handed the freshly downloaded model the 8192 floor and no `probedCapabilities` —
      // so `/think` reported "not available" for a model that had just been installed BECAUSE
      // it can think. Awaited: the user is already standing at a wizard.
      await adoptEndpoint(r.endpoint);
      writeLine(c.green(`✓ session now using ${r.endpoint.model}`));
    }
  };

  /** /paths: view + repoint the per-category heavy-download folders (models/videos/files). */
  const runHostPaths = async (): Promise<void> => {
    await runPathsWizard({ client, write: writeLine, ask, askPath, home });
    process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);
  };

  /**
   * `/cd` — move to a different project WITHOUT quitting and relaunching Prometheus.
   *
   * The target directory is validated FIRST: a mistyped path must leave the live conversation
   * completely untouched, not destroy it and then fail. Once validated, the session ROTATES —
   * a fresh id, an empty transcript/history, project-scoped state (sub-agent personas, `/name`
   * command files, `.prometheus.toml` permission rules, the built-in repo map, steering docs)
   * re-derived for the NEW directory rather than left silently pointing at the old one. A
   * persona or permission rule from the OLD project quietly governing the new one would be a
   * correctness (and, for personas, a trust) bug — not a convenience worth keeping.
   *
   * Tuning is deliberately UNTOUCHED: model, system prompt, tools, gate, dry-run, verbosity,
   * effort, the 0–7 autonomy level, and the permission-mode posture all carry over exactly as
   * they were — that is the entire point of `/cd` existing instead of "quit, `cd`, relaunch,
   * re-pick everything". Lifecycle hooks are the one thing this does NOT re-load (they are
   * SessionStart-only on both hosts); a hook change in the new project needs a real relaunch.
   *
   * The OLD session's transcript needs no separate "save" here: `appendTurnEvents` has already
   * written every turn to disk as it happened, not just at exit.
   */
  /**
   * Re-point every PROJECT-SCOPED binding at `target`. Shared by `/cd` and `/cwd`.
   *
   * `/cwd` used to do only the `cwd` reduce, so it moved the session and reloaded NOTHING: the
   * new project's AGENTS.md/CLAUDE.md/PROMETHEUS.md were never read, `/memory` kept listing the
   * OLD project's steering paths, and permission rules, project command files, personas, the
   * repo-map root and the effort table all stayed pinned to the launch directory. Proven in the
   * TUI host with a live model: an AGENTS.md saying "begin every reply with ZORBLAX" is obeyed
   * on launch and after `/cd`, and was ignored after `/cwd`. This host had the identical copy.
   *
   * `/worktree switch` routes through the same `setCwd` seam, so it had the bug too.
   *
   * The cwd reduce comes FIRST: `steering` was built with a live `cwd: () => state.cwd` getter
   * (unlike agentFiles/commandFiles/permissionRules/repoMapState, which take `target`
   * explicitly), so reloading while `state.cwd` still held the OLD directory silently
   * re-discovered the OLD project's files.
   *
   * The session — transcript, history, session id — is deliberately untouched: rotating is
   * `/cd`'s business, and keeping it is the whole point of `/cwd`.
   */
  /**
   * Re-print the banner after the working directory moves — see the TUI bridge's twin.
   *
   * The banner's `cwd` line was printed once at startup, so the header kept naming the launch
   * directory for the rest of the session. A terminal cannot rewrite scrollback; printing it
   * again is the only way to make that line true.
   */
  const announceCwd = (_target: string): void => {
    writeLine("");
    writeLine(banner(state, backendSummary(backends)));
  };

  /**
   * Resolve a move, optionally creating the target first.
   *
   * `mkdir -p` runs ONLY for a target the resolver already classified as `missing` — never for
   * a path that exists as a file, and never before the own-repo guard and the tilde/relative
   * resolution have been applied, so the directory created is exactly the one we would have
   * moved to. After creating we re-resolve rather than trusting the mkdir: that keeps one
   * code path deciding what a valid destination is.
   */
  const resolveMoveMaybeCreating = (dir: string, create: boolean): CwdMove => {
    const first = resolveCwdMove(dir, state.cwd);
    if (first.ok || !create || !first.missing || !first.path) return first;
    try {
      mkdirSync(first.path, { recursive: true });
    } catch (err) {
      return { ok: false, error: `could not create ${first.path}: ${(err as Error).message}` };
    }
    return resolveCwdMove(dir, state.cwd);
  };

  const moveProjectRoot = (target: string): void => {
    state = repl.reduce(state, { type: "cwd", dir: target });

    agentFiles = loadAgentFiles(target, home);
    commandFiles = loadCommandFiles(target, new Set(allSlashNames()), home);
    permissionRules = loadPermissionRules({ home: deps.configHome, cwd: target });
    ws = createWorkingSet();
    // A stale map (or one still pointing at the OLD root) injected into the NEW project's
    // context would be actively misleading — off, and rebuilt fresh, until the user re-enables.
    repoMapState.enabled = false;
    repoMapState.root = target;
    repoMapState.map = null;
    repoMapState.rendered = null;
    steering.reload();
    // The effort capability table is project-scoped too: a repo may ship its own
    // `.prometheus/effort-capabilities.json`, and keeping the OLD project's overrides in force
    // after a move is the same staleness every reload above exists to prevent.
    effortRulesLoad = loadEffortRules(target, home);
    for (const note of effortRulesLoad.notes) writeLine(`  ! effort rules: ${note}`);
    // EVERY project move refreshes the frame — `/cwd`, `/cd` and `/worktree switch` all
    // land here, so none of them can be the one that forgets.
    announceCwd(target);
  };

  const changeProjectDirectory = (
    dir: string,
    opts?: { create?: boolean },
  ):
    | {
        ok: true;
        movedTo: string;
        newSessionId: string;
        rotated: boolean;
        redirectedFromOwnRepo?: string;
      }
    | { ok: false; error: string } => {
    // `~`/`~/…` first — `isAbsolute("~/x")` is false, so without this a tilde path resolves
    // ONE resolver for both commands. `/cd` used to hand-roll expand → resolve → guard → stat
    // right here while `/cwd` had its own copy elsewhere, which is exactly how only one of
    // them ended up with the existence check.
    const move = resolveMoveMaybeCreating(dir, opts?.create === true);
    if (!move.ok) {
      return {
        ok: false,
        error: move.error,
        ...(move.missing ? { missing: true } : {}),
        ...(move.path ? { path: move.path } : {}),
      };
    }
    const target = move.cwd;
    const redirectedFromOwnRepo = move.redirectedFrom;
    // A no-op move (the pre-filled default accepted verbatim, or `/cd .`) must be genuinely
    // harmless — askPath's own hint promises a bare Enter "keeps the default", so rotating the
    // session (fresh id, cleared transcript/todos, dropped repo map) for a directory the user is
    // ALREADY in would silently break that promise.
    if (resolve(target) === resolve(state.cwd)) {
      return {
        ok: true,
        movedTo: target,
        newSessionId: sessionId,
        rotated: false,
        ...(redirectedFromOwnRepo ? { redirectedFromOwnRepo } : {}),
      };
    }

    sessionId = newSessionId();
    sessionRecorded = false;
    session = undefined;
    history = [];
    capturedResume = null;
    continueCount = 0;
    todos.clear();
    state = repl.reduce(state, { type: "clear" });
    moveProjectRoot(target);

    return {
      ok: true,
      movedTo: target,
      newSessionId: sessionId,
      rotated: true,
      ...(redirectedFromOwnRepo ? { redirectedFromOwnRepo } : {}),
    };
  };

  // ── per-handler context projectors (the host superset → each sibling shape) ── //

  const slashCtxFor = (write: (s: string) => void): LegacySlashCtx => ({
    state,
    json: parsed.json,
    write,
    confirm,
    // run a verb (from a verb-slash) through the same projected verb ctx.
    execVerb: (tokens) => handlers.execVerb(tokens, verbCtxFor(write)),
  });

  const verbCtxFor = (write: (s: string) => void): VerbCtx => ({
    client,
    json: parsed.json,
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    // command-exec's confirm is (prompt, phrase): it shows `prompt` (which already
    // instructs the human to type `phrase`) and expects an exact-phrase match. The
    // host's readline confirm asks the human to type that exact phrase; we resolve
    // true ONLY on an exact, case-sensitive match (never-force: deny by default).
    confirm: (prompt, phrase) =>
      new Promise<boolean>((resolveConfirm) => {
        rl.question(`${c.yellow("?")} ${prompt}: `, (answer) => {
          resolveConfirm(answer.trim() === phrase);
        });
      }),
    write,
  });

  const turnCtxFor = (write: (s: string) => void): TurnCtx => ({
    client,
    // The readline host used to omit both, so agent-runtime computed wrapWidth 0 (no
    // wrapping at all) and fell back to caps "none" (paint() returns plain text) — the
    // non-raw REPL printed unwrapped monochrome while the raw TUI printed neither.
    // Re-read per turn: turnCtxFor is re-invoked on every turn, so a resize is picked up.
    width: Math.max(20, (process.stdout.columns ?? 80) - 1),
    caps: detectColorCaps(process.env, !parsed.json && !parsed.noColor && defaultColorEnabled()),
    /**
     * Resolve a cloud endpoint's key, lazily, per request.
     *
     * The field was declared on `SessionCtx`, threaded through three call sites, consumed by
     * the transport and covered by a test — and assigned by no host, on any surface. So the
     * branch that attaches `Authorization` was unreachable and the "needs an API key but no
     * key resolver was provided" message could never be printed either.
     */
    resolveKey,
    // MCP tools are merged HERE, per turn, not baked into the seed: servers connect
    // asynchronously and `repl.reduce` spreads `...tuning.tools` in several places, so a value
    // written once at startup would go stale without anything saying so.
    /**
     * The live tuning + the autonomy POSTURE (`/permission-mode`).
     *
     * This host had no notion of a permission mode at all: `/plan` was a prompt MACRO that
     * asked the model nicely to outline first, and nothing stopped it writing a file mid
     * "plan". The TUI enforced the real read-only deny at its own confirm seam, so the same
     * words meant two different things depending on which binary you launched. The mode now
     * travels on the tuning and the SHARED loop enforces it, so both hosts (and headless)
     * refuse identically.
     */
    tuning: {
      ...withMcpTools(state.tuning, mcp?.tools() ?? []),
      permissionMode: hostPermMode,
      // Lifecycle hooks ride the TUNING, not the deps, so a `spawn_agent` child inherits them
      // through `childTuning` — a PreToolUse guard that delegation could shed would be no guard.
      ...(sessionHooks.length > 0 ? { hooks: sessionHooks } : {}),
      ...(hookRunner ? { hookRunner } : {}),
    },
    // (A) `/timeout` — the session's inactivity-pause threshold.
    idleTimeoutMs: idleTimeoutMsSetting,
    json: parsed.json,
    // Per-turn token accounting (CLI-029). Two things depended on this field and neither host
    // ever set it: `prometheus tokens report` read a store nothing wrote, so it was always
    // empty; and `checkBudgetGate` returns "ok" without it, so a configured cap could not
    // evaluate. Writing records is unconditional and gates nothing — see `budget` below for
    // the half that can actually refuse a turn.
    accounting: { home, sessionId },
    // The spend cap from the profile's `[budget]` table. Parsed since CLI-030 and read by
    // nobody, so `session_usd = 5` in a config was decoration.
    ...(budgetGuard ? { budget: budgetGuard } : {}),
    // The `question` tool's seam: free text back from the human, distinct from confirm's yes/no.
    ask,
    ...(agentFiles.length > 0 ? { agentFiles } : {}),
    // Remembered grants + the task list, at parity with the TUI host.
    grants,
    // The user's allow/ask/deny rules reach the engine here — see `loadPermissionRules`.
    permissionRules: permissionRules.rules,
    /**
     * PROMETHEUS_HOME and the live autonomy level — declared, consumed, assigned by nobody.
     *
     * `agent-runtime` writes the Phase-3 exec audit line only when `ctx.home` is set and
     * records `ctx.authLevel` on it. Neither host ever set either, so every runner-side exec
     * audit line was silently dropped: the record of what the agent ran, at what autonomy, did
     * not exist. Both are optional fields, so nothing ever failed to compile.
     */
    home,
    authLevel: hostAuthLevel,
    /**
     * The endpoint's learned tool capability, owned HERE so it outlives the per-message client.
     *
     * `makeLlmClient` is rebuilt for every user message, so the observation it accumulates was
     * thrown away each time and the two-strike demotion threshold could never be reached: a
     * model that cannot function-call was re-probed natively on every single message.
     */
    capability: () => toolCapability,
    onCapability: (next) => {
      toolCapability = next;
    },
    todos,
    // The delegation cap the model actually runs under — see the TUI host's twin. The seam was
    // declared, read once, and assigned by no host, so `/agents N` could not move it.
    subagentBudget: { maxSpawns: spawnCap },
    onTodos: (items) => write(c.dim(`  ▤ ${agent.todoSummary(items)}`)),
    onRemember: (subject, scope) => {
      write(c.dim(`  ✓ remembered: ${subject} (${scope})`));
      // Persist immediately, not at exit: a session that ends in a crash or a ^C would
      // otherwise lose exactly the answer the user took the trouble to give.
      if (scope === "project" || scope === "user") saveGrants(grants, deps.configHome);
    },
    onAutoApprove: (subject) =>
      write(c.dim(`  ↩ auto-approved from a remembered grant: ${subject}`)),
    ...(mcp ? { callMcpTool: (id, tool, args) => mcp.callTool(id, tool, args) } : {}),
    // a detected/adopted local endpoint → the real streaming path (not the offline fallback).
    ...(endpoint ? { endpoint } : {}),
    // The session's effective effort capability table (builtins ⊕ user ⊕ workspace override
    // files). Loaded once at startup — see `session/effort-rules.ts`.
    effortRules: effortRulesLoad.rules,
    /**
     * The autonomy ladder decides FIRST, then the prompt — as it does in the TUI.
     *
     * `hostAuthLevel` was read from disk, exposed through `getAuthLevel`, written back by
     * `/authorisation N`, persisted as the next session's default — and consulted by nothing.
     * The TUI host consults its equivalent at eight decision points; this host had none, so
     * `/authorisation 5` printed "(saved as default)" and changed nothing at all. A user who
     * deliberately raised their autonomy was still asked about every single read, and a user
     * who deliberately LOWERED it to `paranoid` was not protected: the level was inert in
     * both directions, which is the worse half of the defect.
     *
     * The prompt (`confirmPrompt`) still governs everything the ladder does not auto-approve,
     * and it names the exact command or path — so raising the level trades prompts for
     * autonomy without ever trading away an informed decision.
     */
    confirm: (call) => {
      const tool = agent.exposedTools(tuning.tools).find((t) => t.name === call.name);
      if (hostAutoApproves(call, tool?.annotations)) {
        return Promise.resolve(true as ConfirmResult);
      }
      // The PREVIEW comes before the prompt, not instead of it.
      //
      // `confirmPrompt` names the paths; it cannot show what is in them. For `apply_patch`,
      // `delete_file` and `move_file` that gap is the whole decision — a patch across six
      // files, the contents of a file about to be deleted, the destination an `overwrite:true`
      // move is about to destroy. `previewMutation` returns null for every other tool, so this
      // adds nothing to the prompts that were already informed.
      showMutationPreview(call);
      return confirmTool(confirmPrompt(call, state.cwd, [state.cwd, ...ws.list()]));
    },
    write,
    // read scope = cwd (implicit) + every /add-dir dir (CLI-004), resolved fail-closed.
    workingSet: [state.cwd, ...ws.list()],
    // propose_edit resolves paths against cwd + logs pre-images for revert (CLI-010).
    cwd: state.cwd,
    editHistory,
    // turn-atomic checkpoints (CLI-015).
    checkpoint: { store: checkpointStore, sessionId },
    // the built-in repo map (CLI-053): inject the rendered block only while enabled (getter → live).
    repoMap: () => (repoMapState.enabled ? repoMapState.rendered : null),
    // steering (CLI-061): the assembled AGENTS.md/CLAUDE.md/PROMETHEUS.md block, re-read per turn.
    steering: () => steering.block(),
    // durable cross-session memory: the `memory_write`-authored index, re-read per turn.
    memory: loadMemory,
    // SessionStart hook output, captured once at session start and replayed per turn.
    sessionStartHooks: () => sessionStartBlock,
    // CLI-088: token-economy toggles (terse-output / prompt-caching), read ONCE at session start.
    tokenToggles,
  });

  /**
   * Restore a past session: rebuild the LLM thread, repaint the transcript, reset the cwd.
   *
   * The model and system prompt are deliberately NOT restored. They are not recorded per
   * session (the index is metadata only), and guessing them would risk silently pulling or
   * serving a model the user did not ask for on what looks like a read-only action.
   */
  const restorePastSession = (r: SessionRecord): void => {
    /**
     * A FAILED restore must be a no-op on live state.
     *
     * `history = messages` ran unconditionally, so resuming a session whose transcript is gone
     * — rotated away, deleted, or written by a build that never persisted turn content —
     * replaced the live conversation with an EMPTY one and then printed "\u21bb resumed session"
     * as though it had worked. The user lost the thread they were in the middle of, and the
     * only signal was that the agent suddenly knew nothing.
     */
    const records = loadTurns(home, r.id);
    const restored = rebuildThread(records, {
      // The restore budget is the model's, not a hard-coded 6000 — see `rebuildThread`.
      maxTokens: agent.carryBudgetFor(endpoint?.contextWindow),
    });
    if (restored.messages.length === 0) {
      writeLine(
        c.yellow(
          `\u26a0 session ${r.id.slice(0, 8)} has no transcript on disk \u2014 nothing to resume, so the current conversation is untouched`,
        ),
      );
      return;
    }
    const { messages, painted, elided } = restored;
    history = messages;
    /**
     * The SESSION is restored too, not just the history.
     *
     * `history` and `session.turns` are two views of one conversation, and compaction rebuilds
     * the first from the second. Restoring only `history` left a fresh, EMPTY session behind
     * it, so the first compaction (or an immediate `/condense`) replaced the entire restored
     * conversation with `turnsToHistory([])` — nothing at all, silently.
     */
    /**
     * Build the session when there ISN'T one — `if (session)` skipped exactly the case that
     * matters.
     *
     * `session` stays undefined until the first turn of THIS process assigns it, and a resume
     * is by definition the thing you do BEFORE any turn has run. So on a fresh
     * `prometheus` + `/recall`, the restore repainted the transcript, refilled `history`, and
     * left `session` undefined — the comment above describing a fix that never fired. Compaction
     * then rebuilt `history` from the handful of turns worked since, silently deleting the whole
     * restored conversation: the exact failure this line was written to prevent.
     */
    session = {
      ...(session ??
        agent.createSession(sessionId, r.descriptor || "resumed", r.ts, r.cwd || state.cwd)),
      turns: turnsFromRecords(records),
    };
    capturedResume = null;
    continueCount = 0;
    if (r.cwd) state = repl.reduce(state, { type: "cwd", dir: r.cwd });
    writeLine(
      c.bold(`↻ resumed session ${r.id.slice(0, 8)} · ${r.ts.replace("T", " ").slice(0, 16)}`),
    );
    if (elided > 0) {
      writeLine(c.dim(`  restored ${messages.length} msgs · ${elided} older elided for context`));
    }
    writeLine(c.dim("  model + system prompt kept from the current session"));
    // `RestoredLine.role` is only ever "you" or "tool" (never "user") — matching against "user"
    // (the previous bug) was always false, so EVERY restored line, including the human's own
    // past prompts, was mislabeled role:"prometheus" here: no "you" indicator when printed, and
    // tool-activity summary lines folded into the same bucket as if Prometheus had said them.
    // This also fed exportTranscript/exportTranscriptJson, which read this same state.transcript.
    // Mirrors session-bridge.ts's restoreSession exactly (its three-way branch on the real
    // "you"/"prometheus"/tool values).
    for (const p of painted) {
      if (p.role === "you") {
        state = repl.reduce(state, { type: "message", role: "you", text: p.text });
        writeLine(`${c.dim("you")} ${p.text}`);
      } else if (p.role === "prometheus") {
        state = repl.reduce(state, { type: "message", role: "prometheus", text: p.text });
        writeLine(p.text);
      } else {
        writeLine(c.dim(p.text));
      }
    }
  };

  /** Same cap the TUI host uses — rotation drops the oldest, never the live session. */
  const SESSION_TRANSCRIPT_CAP_BYTES = 50 * 1024 * 1024; // 50 MiB

  /** Write the transcript to a file (given, or under ~/.prometheus/logs/sessions). "" on failure. */
  const exportTranscript = (file?: string): string => {
    try {
      const body = state.transcript
        .map((m) => {
          const e = m as { role?: string; text?: string };
          return `[${e.role ?? "?"}] ${e.text ?? ""}`;
        })
        .join("\n");
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      const out = file?.trim()
        ? file.trim()
        : join(home, "logs", "sessions", `session-${stamp}.txt`);
      writeFileSync(out, `${body}\n`);
      return out;
    } catch {
      return "";
    }
  };

  // CLI-082: structured JSON export sibling — this host DOES maintain the same rich per-turn
  // JSONL store the TUI does (appendTurnEvents below, read back via loadTurns for /recall), so
  // it reads THAT instead of projecting the thin in-memory transcript. The projection used to
  // force every non-user line to kind:"text" with no timestamp, so tool_use/verdict lines and
  // per-turn `at` never appeared in this host's JSON export no matter what happened in the
  // session — even though the richer data was sitting on disk the whole time. Matches
  // session-bridge.ts's identical exportTranscriptJson. Additive; never perturbs the plain-text
  // path above.
  const exportTranscriptJson = (file?: string): string => {
    try {
      const doc = buildSessionExport(sessionId, loadTurns(home, sessionId), now().toISOString());
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      const dir = join(home, "logs", "sessions");
      mkdirSync(dir, { recursive: true });
      const out = file?.trim() ? file.trim() : join(dir, `session-${stamp}.json`);
      writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
      return out;
    } catch {
      return "";
    }
  };

  /** Keep-recent + threshold, shared by the auto path and the manual `/compact`. */
  const COMPACT_KEEP_RECENT = 4;
  const COMPACT_THRESHOLD_PCT = 85;

  /**
   * Compact the transcript when it approaches the model's window.
   *
   * Guarded on `session` and on a live policy: `autoCompactPolicy` returns null when the
   * threshold is 0, which DISABLES the check — that sentinel is load-bearing, so it is passed
   * through rather than defaulted around.
   *
   * The window fed to the policy is the SMALLER of the endpoint's own (measured or assumed)
   * window and `contextWindowSetting` (`/context window`, default 250k) — a user-chosen ceiling
   * always wins over a bigger number the model's metadata claims, and a genuinely smaller real
   * window always wins over an optimistic setting. Compaction still fires at 85% of that number,
   * not "at" it exactly — the margin is what gives a compaction round room to finish before the
   * window is actually exhausted.
   */
  const maybeAutoCompact = async (): Promise<void> => {
    if (!session) return;
    const window = Math.min(
      endpoint?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      contextWindowSetting,
    );
    const policy = autoCompactPolicy(COMPACT_THRESHOLD_PCT, window, COMPACT_KEEP_RECENT);
    if (!policy || !shouldAutoCompact(session, policy)) return;
    try {
      // `turnAbort` is already armed by the time this runs (`handleLine` creates it before
      // dispatching to `runAgentMessage`) — threading it is root cause 3's actual fix: this
      // inner call used to get NO signal, so Esc/Ctrl-C could never reach it.
      const { summarize, offline } = makeSummarizer(turnCtxFor(writeLine), {
        ...(turnAbort ? { signal: turnAbort.signal } : {}),
        onStatus: writeLine,
      });
      const res = await compactSession(sessionId, session, policy, summarize, now().toISOString(), {
        offline,
      });
      session = res.session;
      history = res.history;
      writeLine(c.dim(`⎿ ${res.notice}`));
    } catch {
      // Fail-soft on purpose: an unreachable summarizer must not take the user's turn with it.
    }
  };

  /**
   * Run a user-defined `/name` command file: expand it, then send it as an ordinary prompt.
   *
   * The two dangerous halves are both delegated to code that already does them safely — a file
   * read goes through the SAME working-set + secret guards `read_file` uses, and a shell
   * injection goes through the SAME parse → nemesis → confirm path `run_command` uses, and is
   * ALWAYS asked about regardless of authorisation level. A string stored in a markdown file
   * months ago has not earned the ladder's auto-approval the way a command the model just
   * composed in response to a live request has.
   */
  const runCommandFile = async (cmd: LoadedCommand, rest: string): Promise<void> => {
    const argv = rest.trim() ? rest.trim().split(/\s+/) : [];
    const { prompt, rejected } = await expandCommand(cmd, argv, {
      readFile: async (rel) => {
        const out = await runSystemTool(
          "read_file",
          { path: rel },
          {
            cwd: state.cwd,
            roots: [state.cwd, ...ws.list()],
          },
        );
        if (!out?.ok) throw new Error(out?.summary ?? "unreadable");
        return out.summary;
      },
      runShell: async (command) => {
        writeLine(c.dim(`  ${cmd.file.name}: wants to run  ${command}`));
        if (!(await confirm(`run \`${command}\` from ${cmd.path}?`))) return null;
        const out = await runSystemTool(
          "run_command",
          { command },
          {
            cwd: state.cwd,
            roots: [state.cwd, ...ws.list()],
            gateMode: state.tuning.gateMode,
            home,
            // The session's level, so this human-approved run is confined by the OS sandbox
            // to exactly what the ladder already permits (below A5 the kernel refuses the
            // network). Omitting it would silently pin every command-file shell to the safe
            // default however the session is set.
            authLevel: hostAuthLevel,
          },
        );
        return out?.ok ? out.summary : null;
      },
    });
    for (const r of rejected) writeLine(c.yellow(`  ! ${r.what} — ${r.reason}`));
    if (!prompt.trim()) {
      writeLine(c.red(`/${cmd.file.name}: expanded to nothing`));
      return;
    }
    await runAgentMessage(prompt);
  };

  /** Run ONE message through the agent loop (the default branch + the /macro sink). */
  const runAgentMessage = async (input: string): Promise<void> => {
    // orchestrator: under tmux, the main agent decides whether 3 subagents are enough.
    // The turn's DELEGATION CAP — see the TUI host's twin. `/agents N` was a printed
    // number with no consumer; this is what makes it the real `maxSpawns`.
    spawnCap = spawnCapFor(input, explicitAgents, agent.DEFAULT_MAX_SPAWNS);
    if (orchestrating) {
      const note = orchestratorNote(input, subagentCount);
      if (note) writeLine(c.dim(`🛸 ${note}`));
    }
    state = repl.reduce(state, { type: "message", role: "you", text: input });
    if (contextProbe) {
      // Bounded, and UNCONDITIONAL on `session` existing — the previous placement (inside
      // `maybeAutoCompact`, gated on `if (!session) return`) never ran on a brand-new
      // session's first message (`session` is undefined until the first `persist()`), which
      // is exactly the scenario root cause #1 was written to close. Mirrors the TUI bridge's
      // own (already-correct) unconditional placement.
      await Promise.race([
        contextProbe.catch(() => undefined),
        new Promise((r) => setTimeout(r, CONTEXT_PROBE_AWAIT_MS)),
      ]);
      contextProbe = undefined;
    }
    // AUTO-COMPACT before the turn, exactly as the TUI host does.
    //
    // This host had manual `/compact` only, while `tui/session-bridge.ts` compacted on a
    // schedule — both calling the same `compactSession`. A long readline session therefore
    // just overflowed the window, with no recovery and no warning. Fail-soft: a summarizer
    // error leaves the transcript untouched (core's `compact()` guarantees that), so the
    // worst case is the behaviour that existed before this line.
    await maybeAutoCompact();
    /**
     * Ctrl-C has to reach the TURN, not just the prompt.
     *
     * `turnAbort` was created, aborted by the SIGINT handler, and never handed to anything:
     * `runMessageTurn` takes an optional `signal` (the TUI passes it — session-bridge.ts) and
     * this host omitted it. So Ctrl-C printed "(cancelled — press Ctrl-D or type /quit to
     * exit)" and returned to the prompt while the turn kept running underneath: the model
     * kept streaming, and every remaining tool in the round still executed. A user who hit
     * Ctrl-C to stop a destructive command watched it run anyway, with the UI insisting it
     * had been cancelled.
     *
     * Read into a local first: `turnAbort` is nulled in the caller's `finally`, and the
     * property read must not race that.
     */
    const abort = turnAbort;
    const res: MessageTurnResult = await handlers.runMessageTurn(session, input, {
      ctx: turnCtxFor(writeLine),
      history,
      ...(abort ? { signal: abort.signal } : {}),
    });
    // A `once` grant answers exactly ONE turn. Leaving it in place would turn "yes, this time"
    // into "yes, always" without the user ever choosing that.
    grants.clearOnce();
    session = res.session;
    /**
     * Persist the turn transcript (CLI-012). THIS is what was missing.
     *
     * The TUI host has written every turn's prompt + AgentEvents to
     * `~/.prometheus/sessions/<id>.jsonl` since the store was built; this host recorded only
     * the INDEX entry — id, timestamp, first fifteen words, cwd. So `/recall` here could list
     * past sessions and never restore one, because there was no transcript on disk to restore
     * FROM. The picker was not the bug; the empty store behind it was.
     *
     * Fail-soft, exactly as in the TUI: a read-only home must not take the turn with it.
     */
    appendTurnEvents(home, sessionId, [{ role: "user", text: input }, ...res.events]);
    rotateSessions(home, { maxBytes: SESSION_TRANSCRIPT_CAP_BYTES, liveId: sessionId });
    // /restore's picker column: what THIS turn actually did, refreshed every turn (mechanical —
    // no model round-trip; see turn-summary.ts). A no-op until the index record exists, which it
    // always does by now — `recordSession` runs earlier in the SAME `handleLine` call.
    updateSessionSummary(home, sessionId, turnSummaryOf(input, res.events));
    if (res.reply.trim()) {
      state = repl.reduce(state, { type: "message", role: "prometheus", text: res.reply });
    }
    /**
     * Carry the WHOLE turn forward, tool results included — not a user/assistant text pair.
     *
     * `res.thread` is the post-turn thread the loop folded every call and every result into.
     * This host rebuilt `history` from `input` + `res.reply` instead and dropped it, so the
     * model started each turn having read nothing: it could spend six rounds reading a file,
     * answer, and then be unable to answer a follow-up without reading it again. `carryForward`
     * budgets it against the model's window (tool output is an order of magnitude larger than
     * prose, so carrying it unbounded overflows in about three turns).
     *
     * Also unconditional now. It used to sit inside `if (res.reply.trim())`, so a turn that ran
     * tools and produced no prose — a capped turn, an interrupted one — dropped the user's
     * message from history entirely, and the next turn saw a conversation in which they had
     * never asked.
     */
    history = res.thread?.length
      ? agent.carryForward(res.thread, {
          budgetTokens: agent.carryBudgetFor(endpoint?.contextWindow),
        })
      : [...history, { role: "user", content: input }, { role: "assistant", content: res.reply }];
    // CLI-072: a fresh (non-continued) turn resets the continue counter; stash/clear resume state.
    continueCount = 0;
    settleCap(res);
    // yolo / level-7: keep going to the end of the task rather than stopping at the step cap and
    // asking the human the mode explicitly promised would not be asked. Same seam as the TUI's.
    if (agent.isRunToDoneMode(hostPermMode) && res.capped) {
      await autoRunToDone(res, turnAbort?.signal);
    }
  };

  /** CLI-072: fold a turn's cap OR idle-pause outcome into the resume state (stash, clear on clean end). */
  const settleCap = (res: MessageTurnResult): void => {
    if (res.capped || res.paused) {
      capturedResume = res.thread;
      // yolo (run-to-done) auto-resumes a CAPPED turn, so telling the user to /continue would
      // contradict what is about to happen on its own. An idle PAUSE is still surfaced: that
      // one waits for the human by design. Mirrors the TUI's settleCap exactly.
      if (!agent.isRunToDoneMode(hostPermMode) || res.paused) {
        const again = continueCount > 0 ? ` (resumed ${continueCount}×)` : "";
        const why = res.paused
          ? `paused after ${Math.round((res.pausedIdleMs ?? 0) / 1000)}s of inactivity`
          : "paused at the step cap";
        writeLine(c.dim(`⎿ ${why} — /continue to resume, or just keep typing${again}`));
      }
    } else {
      capturedResume = null;
    }
  };

  /** Resume a capped turn with full prior tool state (CLI-072). Honest no-op when nothing paused. */
  const runContinue = async (): Promise<MessageTurnResult | null> => {
    if (!capturedResume) {
      writeLine(c.dim("nothing to continue — the last turn finished within its step budget."));
      return null;
    }
    continueCount++;
    const resumeThread = capturedResume;
    // Same as `runAgentMessage`: a continuation is a full turn and must be interruptible.
    const abort = turnAbort;
    const res: MessageTurnResult = await handlers.runMessageTurn(session, "/continue", {
      ctx: turnCtxFor(writeLine),
      resumeThread,
      ...(abort ? { signal: abort.signal } : {}),
    });
    grants.clearOnce();
    session = res.session;
    if (res.reply.trim()) {
      state = repl.reduce(state, { type: "message", role: "prometheus", text: res.reply });
    }
    /**
     * A continuation carries its thread forward too — it used to keep only the text.
     *
     * This merged `res.reply` into the last assistant message and dropped `res.thread`,
     * throwing away every tool result the continuation produced: exactly the defect fixed one
     * function above, still live here. It matters MORE here, because a yolo run-to-done chain
     * is nothing but continuations, so a long autonomous run remembered none of its own work.
     */
    history = res.thread?.length
      ? agent.carryForward(res.thread, {
          budgetTokens: agent.carryBudgetFor(endpoint?.contextWindow),
        })
      : history;
    settleCap(res);
    // A pause (idle-timeout) is still an open chain, exactly like a round cap — `settleCap`
    // above already re-stashed `capturedResume` for it, so the counter must not reset either,
    // or "resumed N×" understates how many times this SAME chain has had to be continued.
    if (!res.capped && !res.paused) continueCount = 0; // chain complete
    return res;
  };

  /**
   * yolo / level-7 RUN-TO-DONE: keep continuing a capped turn until the task finishes.
   *
   * `yolo` is defined as "bypass + run to done (auto-/continue, no pauses)" and `/permission-mode`
   * prints that verbatim — "no prompts, no pauses". This host implemented only the confirm-skip
   * half: `runAgentMessage` ended at `settleCap` and `isRunToDoneMode` appeared nowhere in the
   * file, so a yolo turn hit the step cap and printed "paused at the step cap — /continue to
   * resume", waiting for the human the mode had just promised it would not need. The TUI had
   * done this since CLI-072; the same words meant two different things depending on which host
   * you launched.
   *
   * Same budget/abort/stall logic as the TUI's copy — `decideAutoContinue` owns the policy, both
   * hosts only drive it.
   */
  const autoRunToDone = async (first: MessageTurnResult, signal?: AbortSignal): Promise<void> => {
    let acState = agent.initAutoContinue(Date.now());
    let tokens = 0;
    let cur: MessageTurnResult | null = first;
    for (;;) {
      if (!cur) break;
      tokens += Math.ceil((cur.reply ?? "").length / 4); // ~4 chars/token, budget proxy
      acState = cur.events.reduce(agent.observeEvent, acState);
      const decision = agent.decideAutoContinue({
        mode: hostPermMode,
        capped: cur.capped,
        state: acState,
        budget: agent.DEFAULT_AUTO_CONTINUE_BUDGET,
        nowMs: Date.now(),
        tokensSpent: tokens,
        progressDigest: agent.progressDigest(cur.events),
      });
      if (!decision.resume) {
        if (cur.capped) writeLine(c.dim(`⎿ yolo auto-continue stopped: ${decision.reason}`));
        break;
      }
      acState = decision.state;
      if (signal?.aborted) {
        writeLine(c.dim("⎿ yolo auto-continue: interrupted"));
        break;
      }
      writeLine(c.dim(`⎿ yolo: auto-continuing (step ${acState.continues})…`));
      cur = await runContinue();
    }
  };

  // the 0–7 --authorisation level for the plain host: persisted across sessions like the TUI.
  // `deps.configHome`, NOT `home` (== prometheusHome(), the accounting/state tree) — this store
  // lives under `<configHome>/.config/prometheus-studio/` (cliProfiles.configDir), the SAME
  // os.homedir()-rooted tree permissionRules/grants already correctly use a few lines below.
  // Passing `home` here (a real, shipped bug found via a stray `~/.prometheus/.config/...`
  // artifact on disk) silently wrote the saved level to `<prometheusHome>/.config/...` instead.
  let hostAuthLevel = readSavedAuthLevel(deps.configHome) ?? agent.DEFAULT_AUTH_LEVEL;
  /**
   * `--authorisation(s)` / `--authorization(s)` — parsed, accepted, and until now DROPPED here.
   *
   * The TUI read this flag; this host never did. `prometheus --plain --authorisation 7`, every
   * `--tmux` launch and every non-TTY fallback (SSH, CI, a TUI init failure) therefore ran at
   * whatever was persisted while printing nothing to say the flag had been ignored. Same flag,
   * same binary, two different behaviours depending on which host bin.ts happened to pick.
   *
   * SESSION-SCOPED: a launch flag is a one-off override, so it is applied but never saved. The
   * `/authorisation` command remains the only thing that rewrites the stored default.
   */
  const authFlag =
    parsed.flags.authorisations ??
    parsed.flags.authorisation ??
    parsed.flags.authorizations ??
    parsed.flags.authorization ??
    parsed.flags.auth;
  if (authFlag !== undefined) {
    const parsedLevel = typeof authFlag === "string" ? agent.parseAuthLevel(authFlag) : null;
    if (parsedLevel === null) {
      writeLine(
        `unknown --authorisation "${authFlag === true ? "" : authFlag}" — use a level 0–7 or a name: ${agent.authLevelLegend()}`,
      );
    } else {
      hostAuthLevel = parsedLevel;
    }
  }
  /**
   * ELEVATED-PRIVILEGE GATE — this host had none at all.
   *
   * The red warning, the mandatory acknowledgement and the bypass clamp lived inside the TUI
   * and nowhere else, so `sudo prometheus --plain` (and `--tmux`, and the non-TTY fallback into
   * this host) restored the persisted authorisation level UNCLAMPED and auto-approved against it
   * as root, with nothing printed. The same `sudo prometheus` in the default TUI stopped for a
   * full-screen acknowledgement first — same machine, same posture, same sudo. And this is the
   * surface used over SSH and inside tmux, where a sudo launch is most likely of all.
   *
   * Declining is SAFE, not an abort: it forces ask-before-everything and locks bypass. The clamp
   * mirrors the TUI's (`bypassLocked` ⇒ no full-autonomy tier).
   */
  const elevationDecision = await runElevationGate({
    write: writeLine,
    ask: (prompt) => new Promise<string>((res) => rl.question(prompt, (a) => res(a))),
    red: (t) => (parsed.noColor ? t : `\x1b[1;37;41m${t}\x1b[0m`),
  });
  /**
   * The coarse autonomy POSTURE (`/permission-mode`), session-scoped.
   *
   * Deliberately NOT persisted, unlike the authorisation level. `plan` is a temporary stance
   * you take for one investigation; silently resuming it three days later would look like the
   * agent had stopped working. The TUI's equivalent (`permMode` in session-bridge) is
   * session-scoped for the same reason.
   */
  let hostPermMode: agent.PermissionModeId = agent.DEFAULT_PERMISSION_MODE;
  /**
   * `--permission-mode <mode>` — the launch-flag twin of `/permission-mode`, and the sibling of
   * the `--authorisation` handling above. Parsed by parse.ts and read by nobody on any host
   * until now, so `prometheus --plain --permission-mode plan` started an ordinary session in
   * silence. Session-scoped, and refused (not silently downgraded) when the elevated-privilege
   * gate has locked the bypass tiers.
   */
  const modeFlag = parsed.flags["permission-mode"] ?? parsed.flags.permissionMode;
  /** whether an explicit, accepted `--permission-mode` is in force (see the clamp below). */
  let modeFlagApplied = false;
  if (typeof modeFlag === "string") {
    const wanted = agent.PERMISSION_MODES.find((m) => m.id === modeFlag.trim());
    if (!wanted) {
      writeLine(
        `unknown --permission-mode "${modeFlag}" — use one of: ${agent.PERMISSION_MODES.map((m) => m.id).join(" · ")}`,
      );
    } else if (
      elevationDecision.bypassLocked &&
      (wanted.id === "bypassPermissions" || wanted.id === "yolo")
    ) {
      writeLine(`--permission-mode ${wanted.id} is locked (elevated-privilege decline)`);
    } else {
      hostPermMode = wanted.id;
      modeFlagApplied = true;
      // an explicit mode flag overrides the stored default, exactly as it does in the TUI
      if (authFlag === undefined) hostAuthLevel = agent.modeToAuthLevel(wanted.id);
    }
  }
  // The cap comes from the DECISION, not from a hand-written 5 in each host — see sudo.ts's
  // `maxAuthLevel`. A declined gate now really is ask-before-every-change rather than a session
  // that auto-approves installs as root while the note claims the opposite.
  const authLevelBeforeClamp = hostAuthLevel;
  if (hostAuthLevel > elevationDecision.maxAuthLevel) {
    hostAuthLevel = elevationDecision.maxAuthLevel;
  }
  /**
   * Re-derive the posture from the level ONLY when the clamp actually moved it, and never over an
   * explicit `--permission-mode`.
   *
   * mode → level → mode does not round-trip: `modeToAuthLevel("plan")` is 0 (the fine scale cannot
   * express "deny") and `authLevelToMode(0)` is "default", so an unconditional re-derivation threw
   * `plan` away every time — the one mode where that matters, because `permissionMode` is the only
   * thing enforcing plan's read-only deny on this host (loop.ts checks it above the broker).
   * `prometheus --plain --permission-mode plan` therefore asked before mutating actions instead of
   * refusing them, and `--permission-mode plan --authorisation 7` came out as "yolo" — read-only
   * exploration turned into full-autonomy run-to-done, silently.
   */
  if (!modeFlagApplied || hostAuthLevel !== authLevelBeforeClamp) {
    hostPermMode = agent.authLevelToMode(hostAuthLevel);
  }

  // The rich context handed to every host-side /command (slash-registry).
  const slashCtx: SlashCtx = {
    write: writeLine,
    json: parsed.json,
    tuning: () => state.tuning,
    cwd: () => state.cwd,
    /** `/fleet` — refresh, then report. See the TUI bridge's twin: one renderer, both hosts. */
    fleet: async () => {
      if (!fleet) return [c.dim("this surface does not track other Prometheus windows")];
      await fleet.refresh();
      return fleetReport(fleet.peers(), fleet.meters(), Date.now());
    },
    getAuthLevel: () => hostAuthLevel,
    // `/authorisation` and `/permission-mode` must sync the SAME two fields the TUI does
    // (session-bridge.ts's identical setAuthLevel/setPermMode) — this host used to leave
    // hostPermMode/hostAuthLevel as two fully independent variables, so `/permission-mode
    // bypassPermissions`/`yolo` changed nothing about real approval behavior here (the confirm
    // callback below consults ONLY hostAuthLevel), even though the command's own printed
    // description claimed it had.
    setAuthLevel: (level, origin) => {
      hostAuthLevel = agent.authLevelMeta(level).level;
      hostPermMode = agent.authLevelToMode(hostAuthLevel); // sync the coarse mode/indicator
      // only an explicit numbered choice becomes the next-session default (see AuthLevelOrigin)
      if (origin === "user") saveAuthLevel(hostAuthLevel, deps.configHome);
    },
    getPermMode: () => hostPermMode,
    /**
     * Session-scoped, exactly as the comment on `hostPermMode` above promises — and it did not
     * used to be: this wrote the mode-derived level to disk 27 lines under a docblock saying the
     * posture is "deliberately NOT persisted". mode→level is lossy, so one `/permission-mode`
     * replaced an explicit `/authorisation 7` with 2 (or with 1, back at `default`) forever.
     */
    setPermMode: (mode) => {
      hostPermMode = mode;
      hostAuthLevel = agent.modeToAuthLevel(mode);
    },
    /**
     * `/background <task>` — run a turn DETACHED and register it so `agents list` sees it.
     *
     * The turn is the SAME `runMessageTurn` an ordinary message takes, with two substitutions:
     * the write sink is the run's ring buffer (so `agents attach` can replay and follow it)
     * instead of the pane, and the abort signal is the registry's, so `agents kill` really
     * stops it. It gets a FRESH session rather than the live one — two turns appending to one
     * transcript concurrently would interleave, and the detached run is not part of the
     * conversation the user is having at the prompt.
     */
    startBackground: (task) => {
      const { id } = startDetachedRun({
        model: state.tuning.model.modelId,
        provider: state.tuning.model.provider,
        task,
        run: async (rc) => {
          // `undefined` session ⇒ runMessageTurn mints a fresh one. Deliberate: two turns
          // appending to the live transcript concurrently would interleave, and a detached
          // run is not part of the conversation happening at the prompt.
          //
          // Recompute the delegation cap from the BACKGROUND task's own prompt — the shared
          // `spawnCap` closure variable is only ever reassigned by the FOREGROUND message
          // handler, so `/agents N` followed immediately by `/background` (no prior foreground
          // message this session) ran the background task at the untouched default (8) instead
          // of N. Overriding subagentBudget directly on this one ctx, rather than reassigning
          // the shared `spawnCap` variable, also avoids racing a concurrently dequeued
          // foreground turn's own recompute. Mirrors the TUI's identical fix.

          const ctx = turnCtxFor((s) => rc.append(s));
          const res = await handlers.runMessageTurn(undefined, task, {
            ctx: {
              ...ctx,
              subagentBudget: {
                maxSpawns: spawnCapFor(task, explicitAgents, agent.DEFAULT_MAX_SPAWNS),
              },
              // A DEDICATED checkpoint namespace, not the shared (possibly-since-rotated)
              // `sessionId` — see the TUI's identical fix/comment. Without this, a background
              // run's file-edit checkpoint could land as the "most recent" one under the LIVE
              // session's id, so a foreground /revert would silently restore-then-permanently-
              // delete the background task's edits instead of the user's own last turn.
              ...(ctx.checkpoint
                ? { checkpoint: { store: ctx.checkpoint.store, sessionId: `bg-${rc.id}` } }
                : {}),
            },
            signal: rc.signal,
          });
          const reply = res.reply.trim();
          return { ok: reply.length > 0, summary: reply.slice(0, 120) || "(no answer)" };
        },
      });
      return detachedRunNote(id);
    },
    runVerb: async (tokens) => {
      const outcome = await handlers.execVerb(tokens, verbCtxFor(writeLine));
      if (outcome.text) writeLine(outcome.text);
    },
    sendToAgent: runAgentMessage,
    // the slash seam wants a void promise; the chain driver wants the result
    continueTurn: async () => {
      await runContinue();
    },
    applyFromLastReply: async () => {
      const intents = agent.extractEditIntents(lastAssistantReply(history));
      if (intents.length === 0) {
        writeLine("/apply: no SEARCH/REPLACE or ```diff blocks in the last reply.");
        return;
      }
      writeLine(`/apply: found ${intents.length} edit block(s):`);
      for (const it of intents) {
        writeLine(`  • ${it.path ?? "(no path)"} · ${it.hunks.length} hunk(s) [${it.kind}]`);
      }
      if (!(await confirm(`apply ${intents.length} edit block(s) to disk?`))) {
        writeLine("/apply: cancelled.");
        return;
      }
      const roots = [state.cwd, ...ws.list()];
      // Without a real CheckpointHook here, /apply wrote files but never recorded a
      // checkpoint — /checkpoints never listed the change and /revert couldn't undo it (or,
      // worse, silently restored an unrelated earlier one instead). A synthetic turnId is fine:
      // CheckpointStore only ever looks these up by sessionId, most-recent-first.
      const checkpoint: CheckpointHook = {
        store: checkpointStore,
        turnId: `apply-${Date.now()}`,
        sessionId,
        turnNumber: (session?.turns.length ?? 0) + 1,
        now: () => new Date().toISOString(),
      };
      for (const o of applyEditIntentsLocal(intents, roots, state.cwd, checkpoint)) {
        writeLine(o.ok ? `  ✓ ${o.summary}` : `  ✗ ${o.path}: ${o.summary}`);
      }
    },
    tune: (patch) => {
      state = repl.reduce(state, { type: "tune", patch });
    },
    // Lets `/effort` report what the ACTIVE model will really do, instead of echoing a tier
    // it may quietly drop. Re-derived per call — `/setup` and `/model` can rebind `endpoint`.
    effortResolution: (tier) => {
      if (!endpoint) return undefined;
      const cap = ai.resolveCapability(
        {
          modelId: endpoint.model ?? endpoint.id,
          runtime: ai.runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
          locality: endpoint.locality,
          probedCapabilities: endpoint.probedCapabilities,
        },
        effortRulesLoad.rules,
      ).cap;
      // Report what the session will ACTUALLY do, forcing included — `/think` and `/status`
      // must not describe a knob the transport is about to override.
      return ai.resolveEffort(tier, cap, {
        ...(state.tuning.effortForce ? { force: true } : {}),
      });
    },
    /**
     * `/think <tier>` — the REQUESTED tier, into the tuning and onto disk.
     *
     * The readline host's twin of the TUI bridge's setter. What is stored is what was asked
     * for, never `resolution.applied`: the clamp belongs to the model bound right now, and
     * persisting it would ratchet the preference down to that model's ceiling for good.
     */
    setEffort: (tier) => {
      state = repl.reduce(state, { type: "tune", patch: { effort: tier } });
      cliProfiles.saveEffort(tier, deps.configHome);
    },
    control: (signal) => {
      if (signal === "quit") {
        closing = true;
        exitCode = 0;
      } else {
        state = repl.reduce(state, { type: "clear" });
        history = [];
        capturedResume = null; // CLI-072: a fresh conversation has nothing to /continue.
        continueCount = 0;
        writeLine(c.dim("(context cleared — fresh conversation)"));
      }
    },
    setCwd: (dir, opts) => {
      /**
       * `/cwd` moves in place (no session rotation), but it is guarded and VALIDATED exactly
       * like `/cd` — through the one shared resolver, because these two hosts each had their
       * own copy of the sequence and only `/cd`'s had ever grown the existence check.
       *
       * Without it, `/cwd /definitely/not/here` printed a confident `cwd → …` and pointed the
       * session, its agent files, its permission rules and its repo map at nothing.
       *
       * Returns the result instead of swallowing it: the COMMAND decides what to do about a
       * missing directory (it can ask), the HOST owns the filesystem.
       */
      const move = resolveMoveMaybeCreating(dir, opts?.create === true);
      if (!move.ok) return move;
      if (move.redirectedFrom) {
        writeLine(
          `⚠ Prometheus refuses to operate inside its own repository (${move.redirectedFrom}) — redirected to ${move.cwd}.`,
        );
      }
      // Moves in place AND re-points the project-scoped state — see `moveProjectRoot`. Doing
      // only the reduce here is what left the model reading the launch directory's rules.
      moveProjectRoot(move.cwd);
      return move;
    },
    compact: async (focus) => {
      if (!session || session.turns.length <= COMPACT_KEEP_RECENT) {
        writeLine(c.dim("⎿ nothing to compact yet"));
        return;
      }
      const { summarize, offline } = makeSummarizer(turnCtxFor(writeLine), { onStatus: writeLine });
      const sum = focus
        ? async (older: readonly agent.SessionTurn[]) =>
            `Focus: ${focus}\n${await summarize(older)}`
        : summarize;
      const res = await compactSession(
        sessionId,
        session,
        { maxTokens: 1, keepRecentTurns: COMPACT_KEEP_RECENT },
        sum,
        now().toISOString(),
        { offline },
      );
      session = res.session;
      history = res.history;
      writeLine(c.dim(res.notice));
    },
    exportTranscript: (file) => exportTranscript(file),
    exportTranscriptJson: (file) => exportTranscriptJson(file),
    ask,
    confirm,
    askPath,
    runSetup: runHostSetup,
    runPaths: runHostPaths,
    runDemos: (rest) =>
      runDemos(rest, {
        client,
        ...(endpoint ? { endpoint } : {}),
        home,
        cwd: state.cwd,
        // CLI-097: delegate to render.ts's ONE predicate (NO_COLOR/dumb/pipe/FORCE_COLOR) so the
        // TUI painter never diverges from `c` — no second color-enable path.
        caps: detectColorCaps(
          process.env,
          !parsed.json && !parsed.noColor && defaultColorEnabled(),
        ),
        write: writeLine,
        ask,
        confirm,
        localModels: async () => (endpoint?.model ? [endpoint.model] : []),
      }),
    runUpdates: async (rest) => {
      // the slash handler is void — CLI-047's widened return (report|null) is discarded here.
      await runUpdates(rest, {
        home,
        promVersion: PROM_VERSION,
        client,
        write: writeLine,
        env: process.env,
        ...(process.argv[1] ? { scriptPath: process.argv[1] } : {}),
        cwd: state.cwd,
      });
    },
    usage: () => {
      // model-aware cost (CLI-058): local via endpoint locality (a remote OpenAI-compatible
      // endpoint also sets `endpoint`), fallback to the provider-name heuristic offline.
      const provider = state.tuning.model.provider;
      const isLocal = endpoint?.locality === "local" || LOCAL_PROVIDERS.has(provider);
      /**
       * Prefer the PROVIDER'S counts; fall back to the estimate only when there are none.
       *
       * `sessionUsage` is chars/4 over the transcript, and it counts each message once — but
       * every turn re-sends the whole thread, so on an N-turn session it undercounts the
       * billed input by roughly a factor of N. The real counts have been written to
       * `<id>.acct.jsonl` every round the whole time and read by nothing but the separate
       * `prometheus tokens report`. This is the number a user checks before deciding whether
       * they can afford to keep going, so it has to be the measured one.
       */
      const estimate = sessionUsage(
        history,
        provider,
        state.tuning.model.modelId,
        isLocal,
        pricing,
      );
      return measuredSessionUsage(
        home,
        sessionId,
        estimate,
        state.tuning.model.modelId,
        isLocal,
        pricing,
      );
    },
    runInvoke: (rest) =>
      runInvoke(rest, {
        client,
        write: writeLine,
        ask,
        confirm,
        install: async (name, opts) => {
          const outcome = await handlers.execVerb(
            [
              "install",
              name,
              ...(opts?.dryRun ? ["--dry-run"] : []),
              ...(opts?.yes ? ["--yes"] : []),
            ],
            verbCtxFor(writeLine),
          );
          if (outcome.text) writeLine(outcome.text);
        },
      }),
    /**
     * `/recall` (aliased `/resume`) — actually restore a past session.
     *
     * This used to print the session's metadata and then say, in dim text, that replay was "a
     * follow-up". It also ignored its argument, so `/resume <id>` silently showed a picker. The
     * TUI host has restored properly all along; this is the same operation, and it is the same
     * three functions — `loadTurns`, `rebuildThread`, and a cwd reset.
     */
    runRecall: async (rest?: string) => {
      // Headless runs are recorded but kept out of the picker — see `interactiveSessions`.
      const records = interactiveSessions(listSessions(home));
      const arg = (rest ?? "").trim();
      let target: SessionRecord | undefined;
      if (arg) {
        const n = Number(arg);
        target =
          Number.isInteger(n) && n >= 1 && n <= records.length
            ? records[n - 1]
            : records.find((x) => x.id === arg || x.id.startsWith(arg));
        if (!target) {
          writeLine(c.red(`no session matching "${arg}"`));
          return;
        }
      } else {
        writeLine(formatPicker(records));
        if (records.length === 0) return;
        const ans = (await ask("recall #: ")).trim();
        const n = Number(ans);
        if (!Number.isInteger(n) || n < 1 || n > records.length) {
          writeLine(c.dim("(cancelled)"));
          return;
        }
        target = records[n - 1];
      }
      if (target) restorePastSession(target);
    },
    modelPicker: {
      candidates: () => modelCandidates(backends, cloudEndpoints, endpoint?.id),
      // ASYNC because the switch is not complete until the new model has been MEASURED:
      // `modelCandidates` mints an endpoint with the 8192 floor and no `probedCapabilities`, so
      // returning before the probe lands is what made `/model qwen3.6` followed by `/think high`
      // answer "not available" for a model that advertises `thinking`. One loopback POST.
      select: async (id) => {
        const candidates = modelCandidates(backends, cloudEndpoints, endpoint?.id);
        const picked =
          candidates.find((cd) => cd.id === id) ?? resolveModelCandidate(candidates, id);
        if (!picked) return { ok: false, reason: `no model matching "${id}"` };
        state = repl.reduce(state, { type: "tune", patch: { model: picked.model } });
        await adoptEndpoint(picked.endpoint);
        return { ok: true, label: picked.label };
      },
    },
    agents: {
      count: () => subagentCount,
      setCount: (n) => {
        subagentCount = n;
        // …and this is now the REAL cap the model runs under, not just a number to print.
        explicitAgents = n;
      },
      insideTmux: orchestrating,
      recommend: (prompt) =>
        orchestratorNote(prompt, subagentCount).length > 0 ? subagentCount + 1 : subagentCount,
    },
    home,
    systemPromptDefault,
    workingSet: {
      list: () => ws.list(),
      add: (dir) => ws.add(dir, state.cwd),
      remove: (dir) => ws.remove(dir, state.cwd),
    },
    checkpoints: {
      revert: () => {
        const last = checkpointStore.list(sessionId).at(-1);
        if (!last) return "nothing to revert";
        const { restored, deleted, skipped } = restoreCheckpoint(last, {
          roots: [state.cwd, ...ws.list()],
        });
        // KEEP the checkpoint when anything was skipped: those entries are the only surviving
        // copy of the original bytes, and deleting it would destroy exactly the pre-images
        // `/revert` exists to restore. Say so — a silent "reverted 0 file(s)" reads as "there
        // was nothing to do", not as "I could not touch your file".
        if (skipped.length === 0) checkpointStore.delete(last.id);
        const note = skipped.length
          ? ` · ${skipped.length} outside the working set NOT reverted (checkpoint kept — ` +
            `/add-dir ${skipped[0]} then /revert again)`
          : "";
        return `↩ reverted ${restored.length} file(s)${deleted.length ? ` · deleted ${deleted.length}` : ""}${note}`;
      },
      list: () => {
        const cps = checkpointStore.list(sessionId);
        if (cps.length === 0) return "no checkpoints yet";
        return cps
          .map(
            (cp) =>
              `  ${cp.label ?? cp.id} · ${cp.createdAt.replace("T", " ").slice(0, 16)} · ${agent.checkpointSize(cp)} file(s)`,
          )
          .join("\n");
      },
    },
    // the built-in repo map (CLI-053): stats (no-arg) + on|off|refresh. Walks the CURRENT cwd on
    // (re)build; the turnCtx getter injects the rendered block while enabled.
    repoMap: {
      stats: () => repoMapStats(repoMapState),
      apply: (verb) => {
        repoMapState.root = state.cwd;
        return applyRepoMapVerb(repoMapState, verb);
      },
    },
    // the git spawn seam for /worktree (CLI-054): the engine-bridge safe-env spawn (C5).
    git: realGitSpawn,
    // the effective TUI keymap (CLI-096): resolved once from `[keymap]` config at session start.
    // `deps.configHome`, NOT `home` — `home` is prometheusHome() (the ~/.prometheus STATE tree),
    // so this resolved `<state>/.prometheus/config/config.toml`, a path nothing creates. The
    // `[keymap]` table the CLI's own `config set` writes was therefore never read by anything:
    // a rebind appeared to save and did nothing. Same config-tree-vs-state-tree confusion that
    // lost the authorisation level.
    keymap: loadKeymap(deps.configHome),
    // OSC 52 clipboard (CLI-068): raw passthrough to stdout (works over SSH/tmux; no cursor move).
    copyToClipboard: (text) =>
      copyReplyStatus(text ?? lastAssistantReply(history), !!process.env.TMUX, (s) =>
        process.stdout.write(s),
      ),
    // steering files (CLI-061): /memory list/reload/edit/create over the shared controller.
    steering: {
      list: () => steering.list(),
      reload: () => steering.reload(),
      edit: (target) => steering.edit(target),
      create: () => steering.create(),
    },
    // lifecycle-hook diagnostics (CLI-102): /hooks list + /hooks test <event> [tool]. `test`
    // spawns the SAME injected `hookRunner` a real turn would (§ above), with a synthesized
    // payload on stdin — it is never wired into runPreToolUseHooks/firePostToolUseHooks/
    // runSessionStartHooks, so it can only ever observe a hook, never gate or delay a live call.
    hooks: {
      list: (): HookListing[] =>
        sessionHooks.map((h) => ({
          event: h.event,
          ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
          command: h.command,
          source: hooksSource,
        })),
      test: async (event, payload, tool): Promise<HookTestOutcome[]> => {
        const matched = agent.matchingHooks(sessionHooks, event, tool);
        if (matched.length === 0 || !hookRunner) return [];
        const timeoutMs = agent.DEFAULT_HOOK_TIMEOUT_MS;
        const out: HookTestOutcome[] = [];
        for (const spec of matched) {
          const base = spec.matcher !== undefined ? { matcher: spec.matcher } : {};
          try {
            const outcome = await hookRunner({
              event,
              command: spec.command,
              stdin: payload,
              timeoutMs,
            });
            out.push({ ...base, command: spec.command, ...outcome });
          } catch (e) {
            out.push({
              ...base,
              command: spec.command,
              exitCode: -1,
              stdout: "",
              stderr: "",
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return out;
      },
    },
    // per-component context sizes for /context (CLI-057) — the same chars the model actually sees.
    contextBreakdown: () => {
      const t = state.tuning;
      const parts: ContextComponent[] = [
        { label: "system prompt", chars: t.systemPrompt.length },
        {
          label: "transcript",
          chars: history.reduce(
            (n, m) =>
              n +
              (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
            0,
          ),
        },
        {
          label: "tool definitions",
          chars: JSON.stringify(effectiveTools(mcpServer.PROMETHEUS_TOOLS, t)).length,
        },
      ];
      if (repoMapState.enabled && repoMapState.rendered) {
        parts.push({ label: "repo map", chars: repoMapState.rendered.length });
      }
      return { parts, ...(endpoint?.contextWindow ? { window: endpoint.contextWindow } : {}) };
    },
    // /context window: the persisted auto-compact ceiling (default 250k) — see host.ts's
    // `maybeAutoCompact` for how it combines with the endpoint's own window via Math.min.
    contextWindowTokens: {
      get: () => contextWindowSetting,
      set: (n) => {
        contextWindowSetting = n;
        saveContextWindowTokens(home, n);
      },
    },
    // `/timeout` — the persisted inactivity-pause threshold (default 10 min).
    idleTimeoutSetting: {
      get: () => idleTimeoutMsSetting,
      set: (ms) => {
        idleTimeoutMsSetting = ms;
        saveIdleTimeoutMs(home, ms);
      },
    },
    // /cd — see `changeProjectDirectory`'s own header for the full rotation semantics.
    changeProjectDirectory: (dir, opts) => changeProjectDirectory(dir, opts),
  };

  /** Handle ONE input line. Always wrapped by the caller's try/catch. */
  const handleLine = async (raw: string): Promise<void> => {
    const input = raw.trim();
    if (input === "") return; // empty line → just re-prompt
    // Peers see this window as `working` for the whole line, and `idle` again when it ends.
    //
    // Not decoration, and not merely parity with the TUI host: `whileBlocked` hands the window
    // back to `working` when a prompt closes, so WITHOUT an owner that returns it to `idle` the
    // first `[y/N]` on this host would latch the window as busy for the rest of its life. The
    // two halves of the state machine have to live on the same surface.
    fleetState("working");
    try {
      return await runLine(input);
    } finally {
      fleetState("idle");
    }
  };

  const runLine = async (input: string): Promise<void> => {
    // Record the input in history (pure reducer).
    state = repl.reduce(state, { type: "history", input });

    const parsedInput = repl.parseSlash(input);
    // record this session once, on the first real (non-slash) prompt → /recall history.
    if (!sessionRecorded && parsedInput.kind !== "slash") {
      sessionRecorded = true;
      recordSession(home, {
        id: sessionId,
        ts: new Date().toISOString(),
        descriptor: descriptorOf(input),
        cwd: state.cwd,
      });
    }
    turnAbort = new AbortController();
    try {
      if (parsedInput.kind === "slash") {
        // host-side registry first (80+ commands); unknown names fall to the legacy brain.
        const cmd = findSlash(parsedInput.name);
        if (cmd) {
          await cmd.run(parsedInput.rest, slashCtx);
          return;
        }
        // A user-defined command file — consulted ONLY after the built-in registry, so a file
        // called `gate.md` can never change what `/gate` does. `loadCommandFiles` refuses
        // built-in names at load time too; this ordering is the belt to that's braces.
        const custom = commandFiles.find((c) => c.file.name === parsedInput.name);
        if (custom) {
          await runCommandFile(custom, parsedInput.rest);
          return;
        }
        await handleSlash(parsedInput.name, parsedInput.rest);
        return;
      }

      const tokens = input.split(/\s+/);
      if (looksLikeVerb(tokens)) {
        const outcome = await handlers.execVerb(tokens, verbCtxFor(writeLine));
        if (outcome.text) writeLine(outcome.text);
        state = repl.reduce(state, { type: "message", role: "system", text: `$ ${input}` });
        return;
      }

      // default: the agentic loop.
      await runAgentMessage(input);
    } finally {
      turnAbort = null;
    }
  };

  /** Apply a slash result against the live host state (the host is the single owner). */
  const handleSlash = async (name: string, rest: string): Promise<void> => {
    const res = await handlers.execSlash(name, rest, slashCtxFor(writeLine));
    switch (res.kind) {
      case "tune":
        state = repl.reduce(state, { type: "tune", patch: res.patch });
        if (res.text) writeLine(res.text);
        break;
      case "pane":
        state = repl.reduce(state, { type: "set-pane", pane: res.pane });
        writeLine(res.text);
        break;
      case "verb":
        if (res.outcome.text) writeLine(res.outcome.text);
        break;
      case "control":
        await handleControl(res);
        break;
      case "error":
        writeLine(res.text);
        break;
    }
  };

  /** Host-owned slash controls (clear / quit / save / resume / cwd / profile). */
  const handleControl = async (res: Extract<SlashResult, { kind: "control" }>): Promise<void> => {
    if (res.text) writeLine(res.text);
    switch (res.control) {
      case "quit":
        closing = true;
        exitCode = 0;
        break;
      case "clear":
        state = repl.reduce(state, { type: "clear" });
        break;
      case "cwd":
        if (res.rest.trim()) state = repl.reduce(state, { type: "cwd", dir: res.rest.trim() });
        break;
      case "profile": {
        // hot-swap the whole tuning from the named seed (flags no longer apply).
        const next = seedTuning({ ...parsed, profile: res.rest.trim() });
        state = repl.reduce(state, { type: "tune", patch: next });
        break;
      }
      /**
       * `/save [file]` — actually write the transcript.
       *
       * This printed `saving → out.jsonl…` and then did nothing, which is the worst shape a
       * bug can take: the user is TOLD it worked. `exportTranscript` has existed and worked
       * the whole time (it is what `/export` calls); this arm simply never called it.
       *
       * `case "resume"` used to sit alongside and was unreachable dead code — `/resume` is an
       * alias of `/recall` and resolves in the registry long before this switch.
       */
      case "save": {
        const out = exportTranscript(res.rest.trim() || undefined);
        writeLine(out ? c.dim(`saved → ${out}`) : c.red("save failed (could not write the file)"));
        break;
      }
    }
  };

  // Drive the loop over readline "line" events, awaiting each handler in turn so
  // streamed output for line N completes before line N+1 begins. Crash-free: every
  // line is guarded — a thrown engine/llm error renders a friendly line + continues.
  await new Promise<void>((resolveLoop) => {
    let chain: Promise<void> = Promise.resolve();

    const finish = (): void => {
      rl.off("SIGINT", onSigint);
      resolveLoop();
    };

    rl.on("line", (raw) => {
      chain = chain.then(async () => {
        if (closing) return;
        try {
          await handleLine(raw);
        } catch (err) {
          // Never surface a raw stack. Map known engine errors, else a one-liner.
          const out = outcomeFromError(err);
          writeLine(c.red(out.text ?? "error"));
        }
        if (closing) {
          rl.close();
          return;
        }
        // a blank line for breathing room, then the status bar + prompt (Claude-Code spacing).
        // Wrapped: a render throw here (footer/promptLine) must NEVER crash the readline loop —
        // the session's crash-free invariant covers the chrome, not just handleLine.
        try {
          writeLine("");
          writeLine(footer(state, fleetFooter()));
          promptLine();
        } catch {
          try {
            promptLine();
          } catch {
            /* even the bare prompt failed — the loop still reads the next line */
          }
        }
      });
    });

    /**
     * Register this window in the fleet.
     *
     * Deliberately started after the first prompt is on screen: the heartbeat's first write is
     * the moment other windows start counting us, and counting a session that has not finished
     * booting would make `working`/`idle` wrong for its first second.
     */
    fleet = startFleetTicker({
      home,
      id: sessionId,
      cwd: () => state.cwd,
      model: () => state.tuning.model.modelId ?? "",
      onChange: maybeShowFleetLegend,
      /**
       * A kill by ANY surface's watchdog must be visible on this one too.
       *
       * `checkEvictions()` already ran on every tick here and its result was thrown away —
       * this host paid the file read every 2 s and told the operator nothing, so a `--plain`
       * session whose model was force-stopped just saw its next turn fail for no stated reason.
       * The wording is copied from the TUI's callback verbatim so the two surfaces cannot drift.
       *
       * No `promptLine()` afterwards: the notice can land mid-turn while output is streaming,
       * and injecting a stray prompt into that stream is worse than the missing redraw — the
       * fleet legend above already lives with exactly that.
       */
      onEviction: (event) => {
        writeLine(
          `\n⚠ Prometheus stopped ${event.name} to prevent a machine-wide freeze (${event.reason}). Some work may have been interrupted — it will restart automatically once resources are available.\n`,
        );
      },
    });

    rl.on("close", () => {
      /**
       * Ctrl-D / rl.close(): finish the in-flight chain, THEN tear down.
       *
       * The teardown used to START synchronously here and only AWAIT after the chain — but
       * `stopSelfStartedRunners` runs `lms server stop` / SIGTERMs the matching pids as a side
       * effect, and when this session autostarted the runner, that is the very process serving
       * the SSE stream the chain is still reading. Ctrl-D mid-turn therefore killed the reply
       * it had just promised to finish.
       *
       * `.catch` keeps a rejected chain (e.g. a broken write sink / EPIPE) from escaping as an
       * unhandled rejection — the loop always resolves cleanly.
       *
       * Keeping the ticker alive across the final turn is correct, not a leak: the process
       * really is still working, so the heartbeat is honest, and the interval is `unref`'d so it
       * cannot hold the event loop open.
       */
      chain
        .then(() => {
          if (!closing) writeLine(c.dim("\nsession ended."));
        })
        .catch(() => {})
        .finally(() => {
          // Peers read while the ticker is still live, so "is anyone else using this runner?" is
          // answered from a snapshot at most one tick old — snapshotting at `close` instead
          // would have made it stale by the whole length of that last turn.
          const peers = fleet?.peers() ?? [];
          // Then drop our own heartbeat: a clean exit that left the file behind shows every
          // other window `dead 1` for five minutes — the bar crying wolf about the one event it
          // exists to report truthfully.
          fleet?.stop();
          // Then stop any local model daemon THIS session started (never one it didn't) that no
          // other live peer still needs.
          stopSelfStartedRunners(backends.startedRunners, peers)
            .catch(() => {})
            .finally(finish);
        });
    });

    /**
     * `prometheus --continue` — resume the newest past session (CLI-013).
     *
     * The flag has existed and been parsed since CLI-013, and only the TUI host ever read it.
     * `prometheus --plain --continue` accepted it, said nothing, and started fresh — a flag
     * that is silently ignored is indistinguishable to the user from one that did not work.
     */
    if (parsed.flags.continue === true) {
      const newest = [...interactiveSessions(listSessions(home))].sort(
        (a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id),
      )[0];
      if (newest) restorePastSession(newest);
      else writeLine(c.dim("(no past sessions to continue — starting fresh)"));
    }

    // first prompt
    promptLine();
  });

  // Shut the MCP transports down. Without this, every session leaves its connector
  // subprocesses behind — the orphan class the reaper exists to clean up after.
  await mcp?.close().catch(() => {});

  return exitCode;
}
