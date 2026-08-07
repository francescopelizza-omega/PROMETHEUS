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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Interface as ReadlineInterface, createInterface } from "node:readline";

import {
  repl,
  type AiEndpoint,
  agent,
  ai,
  cliProfiles,
  loadPricing,
  mcpServer,
} from "@prometheus/core";

import { type EngineClient, createEngineClient } from "@prometheus/engine-bridge";
import { defaultOpenEditor, loadEffectiveStartupProfile } from "../profile-store.js";

import { PROM_VERSION } from "../commands/help.js";
import { runInvoke } from "../commands/invoke.js";
import { readTokenToggles } from "../commands/token-toggles.js";
import { type CommandOutcome, outcomeFromError } from "../context.js";
import { ensureHomeTree, prometheusHome, resolveCategory } from "../home.js";
import { runDemos } from "../orchestration/demos-cmd.js";
import type { ParsedArgs } from "../parse.js";
import { box, c, defaultColorEnabled, padEnd, visibleLen } from "../render.js";
import { insideTmux } from "../tmux/tmux.js";
import { type KeymapResolution, resolveKeymap } from "../tui/keys.js";
import { detectColorCaps } from "../tui/palette.js";
import { runUpdates, updatesStartupNotice } from "../updates/updates-cmd.js";
import {
  type TurnLine,
  buildSessionExport,
  descriptorOf,
  formatPicker,
  listSessions,
  recordSession,
} from "./history-store.js";

import { copyReplyStatus, lastAssistantReply } from "../tui/clipboard.js";
import {
  type ContextComponent,
  type EditRecord,
  type MessageTurnResult,
  type SessionCtx as TurnCtx,
  applyEditIntentsLocal,
  compactSession,
  confirmPrompt,
  effectiveTools,
  makeSummarizer,
  restoreCheckpoint,
  runMessageTurn,
  sessionUsage,
  warmupLocalModel,
} from "./agent-runtime.js";
import { readSavedAuthLevel, saveAuthLevel } from "./authorisation-store.js";
import { type SessionCtx as VerbCtx, execVerb } from "./command-exec.js";
import { realGitSpawn } from "./git-helpers.js";
import {
  type Backends,
  backendSummary,
  detectBackends,
  renderOnboarding,
  runPathsWizard,
  runSetup,
} from "./onboarding.js";
import { DEFAULT_SUBAGENTS, orchestratorNote } from "./orchestrator.js";
import { completePath } from "./path-completer.js";
import { applyRepoMapVerb, makeRepoMapState, repoMapStats } from "./repo-map-state.js";
import { type SessionCtx as LegacySlashCtx, type SlashResult, execSlash } from "./slash-exec.js";
import { type SlashCtx, findSlash } from "./slash-registry.js";
import { createSteeringController } from "./steering.js";
import { createWorkingSet } from "./working-set.js";

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
  // Effective profile = builtin ⊕ user(--profile flag > persisted active) ⊕ project `.prom.toml`
  // (project wins, CLI-046); then the §1 engine flags layer on top (flags win, CLI-044).
  const profile = loadEffectiveStartupProfile(parsed);
  const merged = cliProfiles.mergeFlags(profile, {
    ...(parsed.gateMode ? { gateMode: parsed.gateMode } : {}),
    ...(parsed.dryRun ? { dryRun: true } : {}),
    ...(parsed.yes ? { yes: true } : {}),
  });
  return cliProfiles.resolveTuning(merged);
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
    `${c.dim("cwd")}     ${c.dim(shortCwd(state.cwd))}`,
  ];
  const tips = [
    c.dim("Tips:"),
    c.dim(" • type a message to chat · a verb (scan / list / harden) runs it"),
    c.dim(" • /setup pick a model · /help commands · /quit (Ctrl-D) exit"),
    c.dim(" • ⏎ send · / commands · ↑ history · Ctrl-C interrupt a turn"),
  ].join("\n");
  return [box(lines, { border: "brand" }), "", tips].join("\n");
}

/** Shorten an absolute path under $HOME to a leading `~` (Claude-Code-style). Boundary-checked so a
 *  sibling like `/home/user-x` (home `/home/user`) is not mis-collapsed to `~-x`. */
function shortCwd(dir: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return dir;
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`)
    ? `~${dir.slice(home.length)}`
    : dir;
}

/**
 * Resolve the effective TUI keymap (CLI-096) from the user config's `[keymap]` table. Fail-soft: a
 * missing/unreadable/corrupt config ⇒ the default keymap. The resolution itself surfaces any
 * conflict/reserved errors (`/keys` prints them) — this only handles the fs read.
 */
function loadKeymap(home: string): KeymapResolution {
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
function footer(state: repl.ReplState): string {
  const dir = shortCwd(state.cwd);
  // repl.footerLine carries "model X · tools:on · gate:warn · dry-run:off · verbosity:normal".
  return `${c.dim(dir)}  ${c.dim("│")}  ${c.dim(repl.footerLine(state.tuning))}`;
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
  const tuning = seedTuning(parsed);
  const cwd = parsed.cwd ?? process.cwd();
  let state = repl.initialReplState(tuning, cwd);
  // capture the profile's system prompt BEFORE any /system override → /system reset (CLI-017).
  const systemPromptDefault = state.tuning.systemPrompt;
  // per-session working set of extra readable dirs (/add-dir, CLI-004).
  const ws = createWorkingSet();
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
  // steering controller (CLI-061): AGENTS.md/CLAUDE.md/PROMETHEUS.md discovery + edit + reload.
  const steering = createSteeringController({
    cwd: () => state.cwd,
    write: (p, content) => writeFileSync(p, content),
    openEditor: defaultOpenEditor,
    confirm: (prompt) => confirm(prompt),
  });

  // Backend detection (fail-soft): probe for a live local runner+model, else note the
  // paid CLIs. When a local model is found, ADOPT it as the session endpoint + model so
  // chat works with zero config; otherwise keep the profile model and point at /setup.
  const backends: Backends =
    deps.backends ??
    (await detectBackends({ client }).catch(() => ({ liveRunners: [], paidClis: [] }) as Backends));
  let endpoint: AiEndpoint | undefined = backends.localEndpoint;
  if (endpoint) {
    state = repl.reduce(state, {
      type: "tune",
      patch: {
        model: { provider: backends.localRunner?.name ?? "ollama", modelId: endpoint.model ?? "" },
      },
    });
    // pre-load the local model NOW (fire-and-forget) so the user's first prompt is warm.
    warmupLocalModel(endpoint);
  }

  // Orchestrator mode: when we're inside a live tmux session, start with 3 subagents by
  // default; the main agent scales that up per prompt (decideSubagentCount). Outside tmux
  // it's a single agent. `subagentCount` is the live default the orchestrator scales from.
  const orchestrating = deps.isTty !== false && insideTmux();
  let subagentCount = orchestrating ? DEFAULT_SUBAGENTS : 1;

  // `pathMode` flips the readline completer into filesystem-path tab-completion for the
  // duration of an askPath() prompt (a folder picker); otherwise tab is a no-op.
  let pathMode = false;
  const rl =
    deps.makeReadline?.() ??
    createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "",
      completer: (line: string): [string[], string] => (pathMode ? completePath(line) : [[], line]),
    });

  writeLine(banner(state, backendSummary(backends)));
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
  // /recall session-history: a per-session id + a one-time record on the first real prompt.
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let sessionRecorded = false;

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
  const confirm = (prompt: string): Promise<boolean> =>
    new Promise<boolean>((resolveConfirm) => {
      rl.question(`${c.yellow("?")} ${prompt} ${c.dim("[y/N]")} `, (answer) => {
        const a = answer.trim().toLowerCase();
        resolveConfirm(a === "y" || a === "yes");
      });
    });

  // A free-text question over readline (the /setup wizard's input seam).
  const ask = (prompt: string): Promise<string> =>
    new Promise<string>((resolveAsk) => {
      rl.question(`${c.cyan("›")} ${prompt} `, (answer) => resolveAsk(answer));
    });

  // A FOLDER picker with `tab` path-completion: flips the completer into path mode,
  // pre-fills the editable default, and returns the typed path (default on blank).
  const askPath = (prompt: string, def: string): Promise<string> =>
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
      endpoint = r.endpoint;
      // a model dir change in /setup repointed paths.json — refresh the engine env.
      process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);
      state = repl.reduce(state, {
        type: "tune",
        patch: { model: { provider: "ollama", modelId: r.endpoint.model ?? "" } },
      });
      // pre-load the just-chosen model so the next prompt is warm.
      warmupLocalModel(endpoint);
      writeLine(c.green(`✓ session now using ${r.endpoint.model}`));
    }
  };

  /** /paths: view + repoint the per-category heavy-download folders (models/videos/files). */
  const runHostPaths = async (): Promise<void> => {
    await runPathsWizard({ client, write: writeLine, ask, askPath, home });
    process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);
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
    tuning: state.tuning,
    json: parsed.json,
    // a detected/adopted local endpoint → the real streaming path (not the offline fallback).
    ...(endpoint ? { endpoint } : {}),
    // agent-runtime's confirm is (call: ToolCall) — surface the tool name AND, for the file
    // writers, the EXACT absolute target (+ a warning when it escapes the working set). The
    // prompt is write_file's only authorization, so "run tool write_file?" was uninformed consent.
    confirm: (call) => confirm(confirmPrompt(call, state.cwd, [state.cwd, ...ws.list()])),
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
    // CLI-088: token-economy toggles (terse-output / prompt-caching), read ONCE at session start.
    tokenToggles,
  });

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

  // CLI-082: structured JSON export sibling — the readline host has no per-turn JSONL store, so it
  // projects the in-memory transcript (you→user, prometheus/tool→assistant text) through the SAME
  // buildSessionExport. Additive; never perturbs the plain-text path above.
  const exportTranscriptJson = (file?: string): string => {
    try {
      const lines: TurnLine[] = state.transcript.map((m) => {
        const e = m as { role?: string; text?: string };
        return e.role === "you"
          ? { role: "user", text: e.text ?? "" }
          : { kind: "text", text: e.text ?? "" };
      });
      const doc = buildSessionExport(sessionId, lines, now().toISOString());
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

  /** Run ONE message through the agent loop (the default branch + the /macro sink). */
  const runAgentMessage = async (input: string): Promise<void> => {
    // orchestrator: under tmux, the main agent decides whether 3 subagents are enough.
    if (orchestrating) {
      const note = orchestratorNote(input, subagentCount);
      if (note) writeLine(c.dim(`🛸 ${note}`));
    }
    state = repl.reduce(state, { type: "message", role: "you", text: input });
    const res: MessageTurnResult = await handlers.runMessageTurn(session, input, {
      ctx: turnCtxFor(writeLine),
      history,
    });
    session = res.session;
    if (res.reply.trim()) {
      state = repl.reduce(state, { type: "message", role: "prometheus", text: res.reply });
      history = [
        ...history,
        { role: "user", content: input },
        { role: "assistant", content: res.reply },
      ];
    }
    // CLI-072: a fresh (non-continued) turn resets the continue counter; stash/clear resume state.
    continueCount = 0;
    settleCap(res);
  };

  /** CLI-072: fold a turn's cap outcome into the resume state (stash on cap, clear on clean end). */
  const settleCap = (res: MessageTurnResult): void => {
    if (res.capped) {
      capturedResume = res.thread;
      const again = continueCount > 0 ? ` (resumed ${continueCount}×)` : "";
      writeLine(c.dim(`⎿ paused at the step cap — /continue to resume${again}`));
    } else {
      capturedResume = null;
    }
  };

  /** Resume a capped turn with full prior tool state (CLI-072). Honest no-op when nothing paused. */
  const runContinue = async (): Promise<void> => {
    if (!capturedResume) {
      writeLine(c.dim("nothing to continue — the last turn finished within its step budget."));
      return;
    }
    continueCount++;
    const resumeThread = capturedResume;
    const res: MessageTurnResult = await handlers.runMessageTurn(session, "/continue", {
      ctx: turnCtxFor(writeLine),
      resumeThread,
    });
    session = res.session;
    if (res.reply.trim()) {
      state = repl.reduce(state, { type: "message", role: "prometheus", text: res.reply });
      // merge the continuation into the last assistant turn (keep history as user/assistant text).
      const last = history.at(-1);
      if (last?.role === "assistant") last.content += res.reply;
      else history = [...history, { role: "assistant", content: res.reply }];
    }
    settleCap(res);
    if (!res.capped) continueCount = 0; // chain complete
  };

  // the 0–7 --authorisation level for the plain host: persisted across sessions like the TUI.
  let hostAuthLevel = readSavedAuthLevel(home) ?? agent.DEFAULT_AUTH_LEVEL;

  // The rich context handed to every host-side /command (slash-registry).
  const slashCtx: SlashCtx = {
    write: writeLine,
    json: parsed.json,
    tuning: () => state.tuning,
    cwd: () => state.cwd,
    getAuthLevel: () => hostAuthLevel,
    setAuthLevel: (level) => {
      hostAuthLevel = agent.authLevelMeta(level).level;
      saveAuthLevel(hostAuthLevel, home); // last-set becomes the next-session default
    },
    runVerb: async (tokens) => {
      const outcome = await handlers.execVerb(tokens, verbCtxFor(writeLine));
      if (outcome.text) writeLine(outcome.text);
    },
    sendToAgent: runAgentMessage,
    continueTurn: runContinue,
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
      for (const o of applyEditIntentsLocal(intents, roots, state.cwd)) {
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
      const cap = ai.resolveCapability({
        modelId: endpoint.model ?? endpoint.id,
        runtime: ai.runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
        locality: endpoint.locality,
      }).cap;
      return ai.resolveEffort(tier, cap);
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
    setCwd: (dir) => {
      state = repl.reduce(state, { type: "cwd", dir });
    },
    compact: async (focus) => {
      if (!session || session.turns.length <= 4) {
        writeLine(c.dim("⎿ nothing to compact yet"));
        return;
      }
      const { summarize, offline } = makeSummarizer(turnCtxFor(writeLine));
      const sum = focus
        ? async (older: readonly agent.SessionTurn[]) =>
            `Focus: ${focus}\n${await summarize(older)}`
        : summarize;
      const res = await compactSession(
        sessionId,
        session,
        { maxTokens: 1, keepRecentTurns: 4 },
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
      return sessionUsage(history, provider, state.tuning.model.modelId, isLocal, pricing);
    },
    runInvoke: (rest) =>
      runInvoke(rest, {
        client,
        write: writeLine,
        ask,
        confirm,
        install: async (name, opts) => {
          const outcome = await handlers.execVerb(
            ["install", name, ...(opts?.yes ? ["--yes"] : [])],
            verbCtxFor(writeLine),
          );
          if (outcome.text) writeLine(outcome.text);
        },
      }),
    runRecall: async () => {
      const records = listSessions(home);
      writeLine(formatPicker(records));
      if (records.length === 0) return;
      const ans = (await ask("recall #: ")).trim();
      const n = Number(ans);
      if (!Number.isInteger(n) || n < 1 || n > records.length) {
        writeLine(c.dim("(cancelled)"));
        return;
      }
      const r = records[n - 1];
      if (!r) return;
      writeLine(c.cyan(`session ${r.id.slice(0, 8)} · ${r.ts.replace("T", " ").slice(0, 16)}`));
      writeLine(`  ${r.descriptor}`);
      writeLine(c.dim(`  cwd: ${r.cwd}`));
      writeLine(c.dim("  (shows the recorded session; full context replay is a follow-up)"));
    },
    agents: {
      count: () => subagentCount,
      setCount: (n) => {
        subagentCount = n;
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
        const { restored, deleted } = restoreCheckpoint(last, {
          roots: [state.cwd, ...ws.list()],
        });
        checkpointStore.delete(last.id);
        return `↩ reverted ${restored.length} file(s)${deleted.length ? ` · deleted ${deleted.length}` : ""}`;
      },
      list: () => {
        const cps = checkpointStore.list(sessionId);
        if (cps.length === 0) return "no checkpoints yet";
        return cps
          .map(
            (cp) =>
              `  ${cp.label ?? cp.id} · ${cp.createdAt.replace("T", " ").slice(0, 16)} · ${Object.keys(cp.files).length} file(s)`,
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
    keymap: loadKeymap(home),
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
  };

  /** Handle ONE input line. Always wrapped by the caller's try/catch. */
  const handleLine = async (raw: string): Promise<void> => {
    const input = raw.trim();
    if (input === "") return; // empty line → just re-prompt

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
      case "save":
      case "resume":
        // persistence is the host's concern; a no-op-with-echo until wired (the
        // echo already printed). Kept non-throwing so the loop continues.
        break;
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
          writeLine(footer(state));
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

    rl.on("close", () => {
      // Ctrl-D / rl.close(): finish the in-flight chain, then resolve the loop.
      // .catch keeps a rejected chain (e.g. a broken write sink / EPIPE) from
      // escaping as an unhandled rejection — the loop always resolves cleanly.
      chain
        .then(() => {
          if (!closing) writeLine(c.dim("\nsession ended."));
        })
        .catch(() => {})
        .finally(finish);
    });

    // first prompt
    promptLine();
  });

  return exitCode;
}
