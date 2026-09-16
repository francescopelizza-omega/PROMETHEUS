/**
 * tui/session-bridge.ts — the TUI's backend: routes a submitted line to the SAME
 * brains the readline host + GUI use (slash registry → verb router → agent runtime),
 * derives the status model from the live tuning, and threads the permission MODE into
 * the agent's tool-confirm so the user is asked before any non-auto action.
 *
 * It owns the mutable session state (repl state, history thread, endpoint, subagent
 * count, permission mode) behind IO seams (write / confirm / ask / askPath / quit) the
 * app injects — `write` is the renderer's print-above sink, the confirms are in-TUI
 * modals. Kept separate from session/host.ts (zero regression to its 1433 tests); the
 * shared logic is the imported modules, not a copy of the loop.
 */
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

import {
  createHookRunner,
  expandHome,
  loadMemoryIndexBlock,
  loadPermissionRules,
  nodePreviewIo,
  resolveEffectiveHooks,
  runSystemTool,
} from "@prometheus/core/agent-system-host";
import { type EngineClient, createEngineClient, verdictReasons } from "@prometheus/engine-bridge";
import { type HooksSource, loadHooksDetailed } from "../session/hooks-config.js";
import { createKeyResolver, keychainProviders } from "../session/key-resolver.js";

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { PROM_VERSION } from "../commands/help.js";
import {
  type InvokeDeps,
  dispatchInvoke,
  fetchCatalogRows,
  presenceOf,
  runInvoke,
} from "../commands/invoke.js";
import { readTokenToggles } from "../commands/token-toggles.js";
import type { CommandOutcome } from "../context.js";
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
import { shortCwd } from "../path-display.js";
import { appendPermissionAudit } from "../permission-audit.js";
import { defaultOpenEditor } from "../profile-store.js";
import { c } from "../render.js";
import { loadAgentFiles } from "../session/agent-file-store.js";
import {
  type CheckpointHook,
  type ContextComponent,
  type EditRecord,
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
  revertEdit,
  runMessageTurn,
  sessionUsage,
  shouldAutoCompact,
  turnsFromRecords,
  warmupLocalModel,
} from "../session/agent-runtime.js";
import { readSavedAuthLevel, saveAuthLevel } from "../session/authorisation-store.js";
import { type SessionCtx as VerbCtx, execVerb } from "../session/command-exec.js";
import { type LoadedCommand, expandCommand, loadCommandFiles } from "../session/command-files.js";
import {
  loadContextWindowTokens,
  saveContextWindowTokens,
} from "../session/context-window-setting.js";
import { loadEffortRules } from "../session/effort-rules.js";
import {
  type ExecDecision,
  appendExecAudit,
  execAuditEntry,
  scanCommand,
  verdictBlocks,
} from "../session/exec-gate.js";
import { realGitSpawn } from "../session/git-helpers.js";
import { loadGrantsInto, saveGrants } from "../session/grants-store.js";
import {
  type SessionRecord,
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
} from "../session/history-store.js";
import { makeBudgetGuard, banner as renderBanner, seedTuningWithNotes } from "../session/host.js";
import { loadIdleTimeoutMs, saveIdleTimeoutMs } from "../session/idle-timeout-setting.js";
import { type McpSession, openMcpSession, withMcpTools } from "../session/mcp-session.js";
import { modelCandidates, resolveModelCandidate } from "../session/model-candidates.js";
import {
  type Backends,
  backendSummary,
  detectBackends,
  emptyBackends,
  renderOnboarding,
  runPathsWizard,
  runSetup,
  stopSelfStartedRunners,
} from "../session/onboarding.js";
import {
  DEFAULT_SUBAGENTS,
  detachedRunNote,
  orchestratorNote,
  spawnCapFor,
  startDetachedRun,
} from "../session/orchestrator.js";
import { applyRepoMapVerb, makeRepoMapState, repoMapStats } from "../session/repo-map-state.js";
import { maybeStopServicesOnExit } from "../session/service-shutdown.js";
import { newSessionId } from "../session/session-id.js";
import {
  type SessionCtx as LegacySlashCtx,
  type SlashResult,
  execSlash,
} from "../session/slash-exec.js";
import {
  type AuthLevelOrigin,
  type HookListing,
  type HookTestOutcome,
  type SlashCtx,
  allSlashNames,
  findSlash,
} from "../session/slash-registry.js";
import { createSteeringController } from "../session/steering.js";
import { execVarsFromEnv } from "../session/system-tools.js";
import { turnSummaryOf } from "../session/turn-summary.js";
import { createWorkingSet, isPathAllowed } from "../session/working-set.js";
import { insideTmux } from "../tmux/tmux.js";
import { runUpdates } from "../updates/updates-cmd.js";
import { copyReplyStatus, lastAssistantReply, osc52Sequence } from "./clipboard.js";
import { fleetLegendLines } from "./fleet-bar.js";
import { CODE_STATE, detectLanguage, highlightLine, isHighlightable } from "./highlight.js";
import type { InvokeItem } from "./invoke-overlay.js";
import { type KeymapResolution, resolveKeymap } from "./keys.js";
import { type ColorCaps, type Role, paint, spanHighlight } from "./palette.js";
import type { StatusModel } from "./status.js";

type PermissionModeId = agent.PermissionModeId;
type ToolCall = agent.ToolCall;
const PROMETHEUS_TOOLS: readonly mcpServer.ToolDef[] = mcpServer.PROMETHEUS_TOOLS;

/** Providers that actually run on a LOCAL OpenAI-compatible runner (else "cloud"). */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "vllm", "llamacpp", "local"]);

/** Total-bytes cap over per-session transcripts before oldest-first rotation (CLI-012). */
const SESSION_TRANSCRIPT_CAP_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Context-compaction tuning (CLI-016): keep the last N turns verbatim; auto-compact at
 * this approximate context-usage %. Threshold 0 disables the auto-check entirely. */
const COMPACT_KEEP_RECENT = 4;
const COMPACT_THRESHOLD_PCT = 85;

/** Single-token verbs a bare line may run in-session (mirrors the host's set). */
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

/** Resolve the effective TUI keymap (CLI-096) from the user config's `[keymap]`; fail-soft to
 *  defaults. Duplicated from host.ts (not imported) to avoid the host↔session-bridge import cycle. */
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
 * Render up to N code lines with Pelly syntax highlighting inferred from the file extension.
 * Falls back to dim grey when the language isn't highlightable or color is off — so a plain
 * text/config file still reads calmly, but a `.py`/`.ts`/… card lights up (the whole point).
 */
function highlightPreview(
  lines: string[],
  path: string,
  caps: ColorCaps,
  indent = "    ",
): string[] {
  const ext = path.includes(".") ? (path.split(".").pop() ?? "") : "";
  const lang = detectLanguage(ext);
  const colored = isHighlightable(lang) && caps !== "none";
  let state = CODE_STATE;
  return lines.map((l) => {
    if (!colored) return c.dim(`${indent}${l}`);
    const { text, state: next } = highlightLine(l, lang, state, caps);
    state = next;
    return `${indent}${text}`;
  });
}

/**
 * Paint the SURGICAL EDIT card: a line-numbered diff of `oldText`→`newText` with context lines
 * syntax-highlighted, removed lines red / added green, and WORD-LEVEL span tints for the exact
 * tokens that changed. Pure — the caller supplies the resolved old/new content + caps. Shared by
 * propose_edit and by write_file when it OVERWRITES an existing file.
 */
function renderDiffCard(
  header: string,
  oldText: string,
  newText: string,
  path: string,
  caps: ColorCaps,
  note: string,
): string[] {
  const ext = path.includes(".") ? (path.split(".").pop() ?? "") : "";
  const lang = detectLanguage(ext);
  const view = agent.buildEditView(oldText, newText, { context: 2 });
  const maxNo = Math.max(
    1,
    ...view.hunks.flatMap((h) => h.rows.map((r) => Math.max(r.oldNo ?? 0, r.newNo ?? 0))),
  );
  const w = String(maxNo).length;
  const gut = (o: number | null, n: number | null): string =>
    paint(
      `${(o?.toString() ?? "·").padStart(w)} ${(n?.toString() ?? "·").padStart(w)}`,
      "diffGutter",
      caps,
    );
  const spans = (
    sp: agent.WordSpan[] | undefined,
    text: string,
    role: Role,
    which: "add" | "del",
  ): string =>
    sp
      ? sp
          .map((s) =>
            s.changed ? spanHighlight(s.text, role, which, caps) : paint(s.text, role, caps),
          )
          .join("")
      : paint(text, role, caps);

  const out: string[] = [
    `${paint(header, "toolAction", caps)}  ${c.dim(
      `+${view.added} −${view.removed} · ${view.hunks.length} hunk${
        view.hunks.length === 1 ? "" : "s"
      }${note ? ` · ${note}` : ""}`,
    )}`,
  ];
  if (view.hunks.length === 0) {
    out.push(c.dim("  (no changes)"));
    return out;
  }
  const MAX_ROWS = 80;
  let shown = 0;
  for (const h of view.hunks) {
    if (shown >= MAX_ROWS) break;
    out.push(
      paint(`@@ −${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`, "diffLoc", caps),
    );
    for (const r of h.rows) {
      if (shown++ >= MAX_ROWS) {
        out.push(c.dim("  … (diff truncated)"));
        break;
      }
      if (r.kind === "context") {
        const code =
          isHighlightable(lang) && caps !== "none"
            ? highlightLine(r.text, lang, CODE_STATE, caps).text
            : r.text;
        out.push(`${gut(r.oldNo, r.newNo)}   ${code}`);
      } else if (r.kind === "del") {
        out.push(
          `${gut(r.oldNo, r.newNo)} ${paint("−", "diffDel", caps)} ${spans(r.spans, r.text, "diffDel", "del")}`,
        );
      } else {
        out.push(
          `${gut(r.oldNo, r.newNo)} ${paint("+", "diffAdd", caps)} ${spans(r.spans, r.text, "diffAdd", "add")}`,
        );
      }
    }
  }
  return out;
}

export interface BridgeDeps {
  parsed: ParsedArgs;
  /** print a line ABOVE the chrome (renderer.printAbove). */
  write: (text: string) => void;
  /** in-TUI yes/no modal (never-force: default deny). */
  confirm: (prompt: string) => Promise<boolean>;
  /** in-TUI typed-confirm modal (resolves true only on an exact phrase match). */
  confirmPhrase: (prompt: string, phrase: string) => Promise<boolean>;
  /** in-TUI free-text prompt. */
  ask: (prompt: string) => Promise<string>;
  /** in-TUI folder prompt. */
  askPath: (prompt: string, def: string) => Promise<string>;
  /** `/traits` — focus the composer's trait rail (the ⌃T mode). Absent ⇒ the command says so. */
  focusTraitRail?: () => boolean;
  /** end the session (control:quit). */
  quit: () => void;
  /** the resolved color depth (for the /demos live view). */
  caps?: ColorCaps;
  client?: EngineClient;
  home?: string;
  backends?: Backends;
  /** terminal columns for streamed word-wrap (CLI-003); read per turn. */
  width?: () => number;
  /** `prometheus --continue` — resume the newest past session on startup (CLI-013). */
  continueSession?: boolean;
  /**
   * The OS home the SHARED `<home>/.config/prometheus-studio` tree resolves from — where the
   * persisted permission grants live. Separate from `home` because that tree is shared with the
   * desktop app and is keyed off the real user home, not PROMETHEUS_HOME.
   */
  configHome?: string;
  /** the session's MCP surface (tests inject; default: connect the configured servers). */
  mcp?: McpSession;
  /**
   * Repaint the chrome NOW.
   *
   * The fleet bar changes on a clock nobody typed into: a peer appearing, a peer dying, the CPU
   * crossing 80%. Without this the new state sits invisible until the user's next keystroke —
   * which, for `needs-you`, is precisely the keystroke they are not making because they are
   * waiting on the window that needs them.
   */
  redraw?: () => void;
}

export interface SessionBridge {
  readonly slashCtx: SlashCtx;
  /** route one submitted line (slash / verb / agent message). Optional `signal` aborts the turn (Ctrl-C). */
  submit: (input: string, opts?: { signal?: AbortSignal }) => Promise<void>;
  /** the live status model (tuning + permission mode). */
  statusModel: () => StatusModel;
  /** the active permission mode (the app keeps the reducer + this in sync). */
  getPermMode: () => PermissionModeId;
  setPermMode: (mode: PermissionModeId) => void;
  /** the active 0–7 authorisation level (fine autonomy scale). */
  getAuthLevel: () => number;
  /**
   * Set the 0–7 authorisation level; also syncs the coarse permMode/indicator.
   *
   * `origin` decides whether the change reaches disk — `user` is an explicit numbered choice and
   * becomes the next session's default, `session` is anything that moved the level for this run
   * only (startup restore, a launch flag, a safety clamp). Required, so a new call site cannot
   * silently inherit the wrong one.
   */
  setAuthLevel: (level: number, origin: AuthLevelOrigin) => void;
  /**
   * Set BOTH halves of the posture independently, session-scoped.
   *
   * `setPermMode` and `setAuthLevel` each derive the other field, and the derivation is lossy in
   * both directions — so there is no ordering of the two that can express `--permission-mode plan
   * --authorisation 7`: `setAuthLevel(7)` rewrites the mode to "yolo", and calling `setPermMode`
   * after it drops the level back to 0. Launch flags are the one caller that has an explicit,
   * independent value for each, so they get a setter that does not guess.
   *
   * Nothing reaches disk, exactly like `setPermMode` — a launch flag is a one-off override.
   */
  setPosture: (mode: PermissionModeId, level: number) => void;
  /** the startup banner + onboarding hint block. */
  banner: () => string;
  /** undo the last applied propose_edit; returns the reverted path (or undefined). CLI-010. */
  revertLastEdit: () => string | undefined;
  /** quick-toggle all agent tools (Ctrl+T); returns the new global enabled state. CLI-018. */
  toggleTools: () => boolean;
  /** set the tools switch explicitly — the trait rail's ↑/↓ set a STATE, not a flip. */
  setToolsEnabled: (on: boolean) => boolean;
  /**
   * Move the effort tier by ±1 on the `off < low < medium < high < max` ladder and report where
   * it landed, clamped at both ends. Returns the tier that is now SET (what `/effort` would
   * print), not the one that will be applied — the badge beside the rail already reports the
   * resolution, degradation and all.
   */
  stepEffort: (delta: number) => ai.EffortTier;
  /** set the effort tier outright (the rail's `think` cell switches between `off` and a tier). */
  setEffort: (tier: ai.EffortTier) => ai.EffortTier;
  /** put thinking back at the tier it was last ON at (the rail's `think` ↑). */
  resumeThinking: () => ai.EffortTier;
  /** the `/invoke` overlay's catalog rows (name · summary · install presence), CLI-059. [] on error. */
  invokeCatalog: () => Promise<InvokeItem[]>;
  /** dispatch the overlay's pick+args through the SAME nemesis-gated install path (CLI-059). */
  invokeInstall: (name: string, args: string) => Promise<void>;
  /**
   * Release session-owned resources — today, the MCP transports.
   *
   * Without it every session leaves its connector subprocesses running: exactly the orphan
   * class the reaper exists to clean up after, created on purpose by us.
   */
  dispose: () => Promise<void>;
}

/** Build the TUI session backend (async: detects local backends once at startup). */
export async function createSessionBridge(deps: BridgeDeps): Promise<SessionBridge> {
  const { parsed } = deps;
  const client = deps.client ?? createEngineClient();
  const home = deps.home ?? prometheusHome();
  const tokenToggles = readTokenToggles(); // CLI-088: session-scoped token-economy toggles, read once
  ensureHomeTree(home);
  process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);

  // Connect the configured MCP servers so their tools join this session's catalog. Fail-soft,
  // and free when nothing is configured — `openMcpSession` starts no process in that case.
  const mcp =
    deps.mcp ?? (await openMcpSession({ home, write: deps.write }).catch(() => undefined));

  const seeded = seedTuningWithNotes(parsed);
  // Same report as the readline host: a repo that tried to weaken the posture says so out loud.
  for (const r of seeded.rejected) {
    deps.write(`  ! .prometheus.toml: ${r.key} ignored — ${r.reason}`);
  }
  /**
   * The last `/think` tier, restored — the effort twin of the authorisation level below.
   *
   * Precedence, most specific first: a `--think/--effort` FLAG (the human at the keyboard, this
   * launch) > the SAVED tier (the human at the keyboard, last session) > the profile layers
   * (a static default). A saved tier is the more recent expression of the same intent as
   * `[agent] effort`, which is why it outranks it; a flag is more recent still.
   *
   * What is restored is the REQUESTED tier. It is resolved against whatever model is bound, per
   * request, by `agent-runtime` — so restoring `xhigh` onto a session that opens on a small
   * local model applies that model's ceiling and reports the clamp, and switching later to a
   * model that has `xhigh` gets `xhigh` with no further action.
   */
  const savedEffort = cliProfiles.readSavedEffort(deps.configHome);
  if (savedEffort && parsed.effort === undefined) seeded.tuning.effort = savedEffort;
  let state = repl.initialReplState(seeded.tuning, resolveCwd(parsed.cwd, deps.write));
  // capture the profile's system prompt BEFORE any /system override → /system reset (CLI-017).
  const systemPromptDefault = state.tuning.systemPrompt;
  let permMode: PermissionModeId = "default";
  // the fine-grained 0–7 autonomy scale (--authorisation). The SOURCE OF TRUTH for allow/ask;
  // permMode is kept synced as the coarse Shift-Tab/indicator companion. Default 1 = ask-for-changes.
  // Restored from the last-saved level (mirrors the readline host) — `readSavedAuthLevel` was
  // imported but never actually called here, so "last-set becomes the next-session default"
  // (the very comment on `saveAuthLevel`'s call sites below) was never true for this TUI host.
  let authLevel: number = readSavedAuthLevel(deps.configHome) ?? agent.DEFAULT_AUTH_LEVEL;
  let history: agent.ThreadMessage[] = [];
  let session: agent.Session | undefined;
  // CLI-072: resume state for `/continue` — a capped turn's full non-system thread (tool results
  // included) is stashed here; `continueCount` shows "resumed N×". Mirrors the host.
  let capturedResume: agent.ThreadMessage[] | null = null;
  let continueCount = 0;
  // /recall (/restore) session-history (mirrors the host): per-session id + one-time
  // first-prompt record. `let`, not `const`: `/cd` mints a fresh one when it rotates projects.
  let sessionId = newSessionId();
  let sessionRecorded = false;
  /**
   * Cross-terminal presence (the fleet bar). Declared here because the confirm/ask wrappers
   * below need to flip this window to `needs-you`, and it is only STARTED further down, once
   * there is a cwd and a model to report. Null until then, and null forever on a surface where
   * the heartbeat could not be written — every reader treats that as "no fleet", never as an error.
   */
  let fleet: FleetTicker | null = null;
  /**
   * The state this window last reported, mirrored locally.
   *
   * The ticker is the writer, but it has no getter and starts existing only later, so
   * `whileBlocked` needs its own record of what to go back TO.
   */
  let selfState: "working" | "idle" | "needs-you" = "idle";
  const fleetState = (s: "working" | "idle" | "needs-you"): void => {
    selfState = s;
    fleet?.setState(s);
  };
  /**
   * Run something while this window reports `needs-you`, then go back.
   *
   * Wrapping the four prompt primitives ONCE is the point: `deps.confirm` alone has fifteen call
   * sites in this file — an edit approval, a command approval, a clipboard copy, the exit
   * sweep — and a per-site flag would have been fifteen chances to forget one. The whole value
   * of the state is that it is never wrong.
   */
  const whileBlocked = async <T>(fn: () => Promise<T>): Promise<T> => {
    // Restore whatever was in force, rather than assuming `working`.
    //
    // "A confirm only ever interrupts a turn that is already running" is not true: the `/invoke`
    // overlay dispatches `invokeInstall` straight onto `submitChain`, bypassing `submit()` — and
    // `submit()`'s `finally` is the ONLY thing that ever returns this window to `idle`. So a
    // prompt raised from that path left the window reporting `working` forever, in the one table
    // other windows consult to see who is busy.
    //
    // Captured verbatim (no needs-you → working remap): when `whileBlocked` nests, the inner
    // `finally` must restore `needs-you`, because the OUTER prompt is still blocking.
    const prev = selfState;
    fleetState("needs-you");
    try {
      return await fn();
    } finally {
      fleetState(prev);
    }
  };
  const askConfirm = (prompt: string): Promise<boolean> => whileBlocked(() => deps.confirm(prompt));
  const askPhrase = (prompt: string, phrase: string): Promise<boolean> =>
    whileBlocked(() => deps.confirmPhrase(prompt, phrase));
  const askText = (prompt: string): Promise<string> => whileBlocked(() => deps.ask(prompt));
  const askFolder = (prompt: string, def: string): Promise<string> =>
    whileBlocked(() => deps.askPath(prompt, def));
  // /context window: the user-chosen ceiling auto-compact budgets against (mirrors the host).
  let contextWindowSetting = loadContextWindowTokens(home);
  // (A) `/timeout` — the inactivity-pause threshold this session's turns use (default 10 min).
  let idleTimeoutMsSetting = loadIdleTimeoutMs(home);

  const backends: Backends =
    deps.backends ?? (await detectBackends({ client }).catch(() => emptyBackends()));
  let endpoint: AiEndpoint | undefined = backends.localEndpoint;
  /**
   * The in-flight context-window/capability probe, if one was kicked off below — awaited
   * (bounded) exactly once, right before the FIRST turn reads `endpoint.contextWindow`. See the
   * readline host's identical `contextProbe` and `CONTEXT_PROBE_AWAIT_MS`.
   */
  let contextProbe: Promise<unknown> | undefined;
  /**
   * The session's ONE measuring seam, cache and all. See `ai/endpoint-probe.ts` — the short
   * version is that `/model`, `/worker` and `/setup` each rebind `endpoint` to a freshly built
   * object that carries neither a measured window nor `probedCapabilities`, and before this
   * existed nothing re-measured, so switching model silently reverted compaction to the 8192
   * floor and `/think` to "not available".
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
    deps.write(`  ! effort rules: ${note}`);
  }
  /**
   * What THIS endpoint has been observed to do about tool calls, across the whole session.
   *
   * Declared HERE, above `adoptEndpoint`, because that function assigns it and is CALLED during
   * session setup (the fire-and-forget probe below). The declaration used to sit ~700 lines
   * further down, so the setup call touched a `let` still in its temporal dead zone and threw
   * `Cannot access 'toolCapability' before initialization` — which `launchTui` catches and
   * reports as "Prometheus's modern terminal UI failed to start", silently dropping every
   * session to the readline compatibility host. The TUI was unreachable, and the only clue was
   * one warning line. The readline host declares its twin before use, which is why `--plain`
   * was unaffected.
   */
  let toolCapability = agent.protocol.initialCapability();

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
          // `source:"default"` means the probe FAILED (unreachable runner, unrecognised
          // shape, wrong runner) — not that 8192 is this model's real window. Silently
          // keeping the floor is indistinguishable, to the user, from a real 8k model: a
          // 128k+ model whose probe failed would compact as though it were about to
          // overflow for the whole session with no visible sign anything went wrong.
          deps.write(
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
   * The cloud providers configured on this machine.
   *
   * Identical to the readline host's block, and it has to be — these two hosts have drifted
   * repeatedly (the readline one had no task list and no context probe long after this one
   * did), and every drift was a capability the user had on one surface and not the other.
   */
  const cloudKeys = await keychainProviders(orchestration.API_PROVIDER_IDS).catch(
    () => new Set<string>(),
  );
  const cloudEndpoints = ai.discoverCloudEndpoints({
    env: process.env,
    hasKeychainKey: (id) => cloudKeys.has(id),
  });
  const resolveKey = createKeyResolver();
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
    // Warm the model AND ask the runner how big its context ACTUALLY is / what it can do.
    // Every endpoint builder in this repo hard-codes 8192, which on this machine is right for
    // gemma4:12b and wrong by 32x for qwen3.6 (262144). That number is what compaction budgets
    // against, so the assumption made a long run compact a huge-window model as if it were
    // about to overflow. Fire-and-forget here (the bounded wait ahead of the first turn closes
    // the race); `/model` and `/setup` await the same seam instead.
    void adoptEndpoint(endpoint);
  }

  const orchestrating = insideTmux();
  let subagentCount = orchestrating ? DEFAULT_SUBAGENTS : 1;
  /**
   * The delegation cap for the CURRENT turn, recomputed per message.
   *
   * Lives here rather than inside `turnCtx()` because it depends on the PROMPT (a complex one
   * scales it up) and `turnCtx` has no prompt. Seeded with the default so a turn that somehow
   * reaches the context before `runAgentMessage` is capped, not uncapped.
   */
  let spawnCap = agent.DEFAULT_MAX_SPAWNS;
  /**
   * The number the USER typed at `/agents`, or null while they have not.
   *
   * Distinct from `subagentCount`, which carries a display default (3 under tmux, 1 without)
   * that must never become the delegation cap — capping at 1 for everyone without a
   * multiplexer would be a silent downgrade of a setting nobody touched.
   */
  let explicitAgents: number | null = null;
  // per-session working set of extra readable dirs (/add-dir, CLI-004). `let`: /cd resets it for
  // the new project — every OTHER piece of project-scoped state in changeProjectDirectory is
  // deliberately reset with a comment justifying it; this was the one omission, so a directory
  // granted access in the OLD project silently kept its read/write scope in an unrelated new one.
  let ws = createWorkingSet();
  // pre-image log for applied propose_edit calls (CLI-010) → /revert.
  const editHistory: EditRecord[] = [];
  // turn-atomic workspace checkpoints for /revert + /checkpoints (CLI-015).
  const checkpointStore = new agent.CheckpointStore(50);
  // the built-in repo map (CLI-053): session-scoped, default OFF; `/repomap` builds + injects it.
  const repoMapState = makeRepoMapState(state.cwd);
  // model-aware pricing table for /stats cost (CLI-058) — loaded once from providers.config.json.
  const pricing = loadPricing();
  // The profile's `[budget]` caps (CLI-030), at parity with the readline host. `--force-budget`
  // is a per-RUN flag and never a profile key.
  const budgetGuard = makeBudgetGuard(
    seeded.budget,
    pricing,
    parsed.flags["force-budget"] === true,
  );
  // steering controller (CLI-061). $EDITOR needs a cooked TTY — suspend raw mode around the spawn,
  // then restore (the write sink triggers a repaint), so vim/nano don't get raw keystrokes.
  const steering = createSteeringController({
    cwd: () => state.cwd,
    write: (p, content) => writeFileSync(p, content),
    openEditor: (file) => {
      const wasRaw = process.stdin.isRaw === true;
      try {
        process.stdin.setRawMode?.(false);
      } catch {
        /* not a TTY */
      }
      const status = defaultOpenEditor(file);
      try {
        if (wasRaw) process.stdin.setRawMode?.(true);
      } catch {
        /* not a TTY */
      }
      return status;
    },
    confirm: askConfirm,
  });
  // Durable cross-session memory: the `memory_write`-authored index, re-read every turn — same
  // getter posture as `steering` above, and the same PROMETHEUS_HOME `home` (not `deps.configHome`,
  // which is a different config root) that `ctx.home` gives `memory_write` itself.
  const loadMemory = (): string | null => loadMemoryIndexBlock(home, state.cwd);

  const write = deps.write;

  /**
   * LIFECYCLE HOOKS — the TUI's half of the readline host's wiring, deliberately identical.
   *
   * Both hosts load the same two settings layers and hand the same `hooks` + `hookRunner` to the
   * SAME shared loop, so a PreToolUse hook means one thing regardless of which binary the user
   * launched. That is the specific failure plan mode had before it moved into the loop, and it
   * is not worth repeating for hooks.
   *
   * The workspace layer can only NARROW the global hooks (select from the user's own set) or ADD
   * ones that pass a nemesis scan and a one-time trust confirmation — never silently replace or
   * auto-run a repo-supplied command. See hooks-trust.ts.
   */
  const rawHooks = loadHooksDetailed({ home, cwd: state.cwd });
  const { hooks: sessionHooks, refused: hookRefusals } = await resolveEffectiveHooks({
    home,
    cwd: state.cwd,
    globalHooks: rawHooks.globalHooks,
    workspaceHooks: rawHooks.workspaceHooks,
    confirm: askConfirm,
  });
  const hooksSource: HooksSource = rawHooks.workspaceHooks !== undefined ? "workspace" : "global";
  for (const r of hookRefusals) {
    write(c.dim(`  hook refused (${r.event}): ${r.command} — ${r.reason}`));
  }
  const hookRunner =
    sessionHooks.length > 0 ? createHookRunner({ cwd: state.cwd, env: process.env }) : undefined;
  /** SessionStart output, captured once (not awaited — a slow script must not delay the UI). */
  let sessionStartBlock: string | null = null;
  if (hookRunner) {
    void agent
      .runSessionStartHooks(sessionHooks, hookRunner, {
        cwd: state.cwd,
        onError: (m) => write(`  hook: ${m}`),
      })
      .then((block) => {
        sessionStartBlock = block ?? null;
      })
      .catch(() => {
        /* fail-soft: hooks never take the session down */
      });
  }

  /**
   * Drop our fleet heartbeat and stop any local model daemon THIS session started.
   *
   * Lives here, not inside `doQuit`, because `/quit` is the ONE exit that used to run it. Ctrl-D
   * and a double Ctrl-C emit `{type:"exit"}`, SIGINT/SIGTERM/SIGHUP go through `onSignal`, a dead
   * stdin/stdout gives 129 and a crash gives 1 — all of which call `finish()` → `dispose()` and
   * never came anywhere near this code. Since the ticker's interval is `unref`'d, the process
   * exited promptly and simply left `<home>/run/<pid>.json` behind with a dead pid, so every
   * other window showed this one as `dead` for five minutes.
   *
   * Idempotent: `/quit` reaches it and then `dispose()` reaches it again.
   *
   * ORDER MATTERS. `finish()` fire-and-forgets `dispose()` (`void session.dispose().catch(...)`),
   * so anything after an `await` in this function may never run at all. `fleet.stop()` is
   * synchronous (clearInterval + unlink) and goes FIRST; `stopSelfStartedRunners` does network
   * probes and a graceful stop with a 15 s timeout, so parking the heartbeat removal behind it
   * would leave the exact stale file this exists to remove whenever the user hits Ctrl-C again.
   */
  let fleetTornDown = false;
  const teardownFleet = async (): Promise<void> => {
    if (fleetTornDown) return;
    fleetTornDown = true;
    // Snapshot peers BEFORE stopping the ticker: `stopSelfStartedRunners` needs to know who else
    // is still using a runner, and our own row is filtered out by its `!p.self` test anyway.
    const peers = fleet?.peers() ?? [];
    fleet?.stop();
    await stopSelfStartedRunners(backends.startedRunners, peers).catch(() => {});
  };

  // Quit hook (CLI-SVC): before tearing down, offer to free local-AI memory (unload the
  // resident Ollama model). Fire-and-forget is safe — `deps.quit()` is what actually exits,
  // so the process stays alive until the prompt resolves; a failure never blocks the exit.
  //
  // `maybeStopServicesOnExit` stays HERE and only here: it prompts, and a hangup or crash path
  // has nobody to answer it.
  const doQuit = async (): Promise<void> => {
    try {
      await maybeStopServicesOnExit({ confirm: askConfirm, write });
    } catch {
      /* never let a shutdown-prompt error trap the user in the session */
    }
    // Stop any local model DAEMON this session itself started, before it's too late to ask the
    // fleet who else is still using it — `maybeStopServicesOnExit` above only ever unloads a
    // resident model's memory and deliberately leaves the daemon running (see its own comment);
    // this is that daemon's stop, autonomous rather than prompted, and never touches one Prometheus
    // did not start itself. Shared with `dispose()` so it also happens on the exits that never
    // reach here — see `teardownFleet`.
    await teardownFleet();
    deps.quit();
  };

  // ── per-handler context projectors ──────────────────────────────────────── //

  const verbCtx: VerbCtx = {
    client,
    json: parsed.json,
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    confirm: askPhrase,
    write,
  };

  // render the surgical edit card for a pending propose_edit: read the file, apply the hunks
  // in-memory, and show the line-numbered old→new diff (word-level) at its real position.
  const renderEditCard = (path: string, hunks: agent.EditHunk[]): string => {
    const caps = deps.caps ?? "none";
    const abs = isAbsolute(path) ? path : resolve(state.cwd, path);
    let oldText: string | null = null;
    try {
      oldText = readFileSync(abs, "utf8");
    } catch {
      oldText = null;
    }
    if (oldText === null) {
      // no file to diff against (new / unreadable) → per-hunk text-diff fallback.
      const body: string[] = [];
      for (const h of hunks) {
        for (const dl of agent.diffHunk(h.old, h.new)) {
          body.push(
            dl.tag === "+"
              ? paint(`  + ${dl.text}`, "diffAdd", caps)
              : dl.tag === "-"
                ? paint(`  − ${dl.text}`, "diffDel", caps)
                : c.dim(`    ${dl.text}`),
          );
        }
      }
      return [paint(`✎ edit ${path}`, "toolAction", caps), ...body].join("\n");
    }
    // preview: apply the exact/fuzzy match now so the card shows precisely what will land (and,
    // if the old text can't be uniquely located, that the edit will be REJECTED — never guessed).
    const res = agent.applyProposedEdit(oldText, hunks, { fallback: true });
    if (!res.ok) {
      return [
        paint(`✎ edit ${path}`, "toolAction", caps),
        paint(
          `  ⎿ can't locate this edit — it will be REJECTED on apply: ${res.message}`,
          "stErr",
          caps,
        ),
      ].join("\n");
    }
    const rungs = [...new Set(res.rungs.filter((r) => r !== "exact"))];
    const note = rungs.length > 0 ? `recovered via ${rungs.join(", ")}` : "matched exact";
    return renderDiffCard(`✎ edit ${path}`, oldText, res.next, path, caps, note).join("\n");
  };

  // audit ONE line per no-prompt auto-approval (CLI-033): bypassPermissions AND yolo log; no other mode.
  const auditBypass = (call: ToolCall): void => {
    if (permMode === "bypassPermissions" || permMode === "yolo") {
      appendPermissionAudit(call.name, call.args, "auto-approved", home);
    }
  };

  // a file-write annotation (propose_edit/write_file both classify as the "write" category).
  const WRITE_ANN = { destructiveHint: true } as const;

  // The live read/write scope: cwd (implicit root) + every `/add-dir` dir — the SAME list the
  // tool runner path-guards against (turnCtx.workingSet). Recomputed per call (dirs change live).
  const scopeRoots = (): string[] => [state.cwd, ...ws.list()];

  // Is a write target inside the working set? Fail-closed: an unresolvable path counts as OUTSIDE
  // (so it prompts rather than silently auto-approving).
  const insideScope = (path: string): boolean =>
    isPathAllowed(isAbsolute(path) ? path : resolve(state.cwd, path), scopeRoots());

  // propose_edit gating (CLI-010): show the diff card, then decide by the 0–7 authorisation level
  // (auto ≥ level 2 "edits"; plan mode still refuses read-only; else prompt the human).
  const confirmEdit = async (call: ToolCall): Promise<agent.ConfirmResult> => {
    const path = typeof call.args.path === "string" ? call.args.path : "?";
    write(renderEditCard(path, agent.parseHunks(call.args.hunks)));
    if (permMode === "plan") {
      // read-only refusal fed back to the model so it re-plans (CLI-033 + CLI-032 channel).
      return { approved: false, reason: JSON.stringify(agent.planModeRefusal(call.name)) };
    }
    if (agent.authDecision(authLevel, "propose_edit", WRITE_ANN) === "allow") {
      auditBypass(call);
      return true;
    }
    const ok = await askConfirm(`apply edit to ${path}?`);
    if (ok) return true;
    const reason = (await askText("reject reason (optional):").catch(() => "")).trim();
    return { approved: false, reason: reason || "rejected" };
  };

  // write_file gating: show a create/overwrite card + a short content preview, then decide by the
  // 0–7 authorisation level (mirrors confirmEdit — auto ≥ level 2, plan refuses, else prompt).
  const confirmWrite = async (call: ToolCall): Promise<agent.ConfirmResult> => {
    const path = typeof call.args.path === "string" ? call.args.path : "?";
    const content = typeof call.args.content === "string" ? call.args.content : "";
    const caps = deps.caps ?? "none";
    const abs = isAbsolute(path) ? path : resolve(state.cwd, path);
    let existing: string | null = null;
    try {
      existing = readFileSync(abs, "utf8");
    } catch {
      existing = null;
    }
    if (existing !== null && existing !== content) {
      // OVERWRITE of an existing file → show the actual old→new diff, not just the new blob,
      // and nudge toward the surgical path.
      for (const ln of renderDiffCard(
        `✎ overwrite ${path}`,
        existing,
        content,
        path,
        caps,
        "existing file",
      )) {
        write(ln);
      }
      write(
        paint(
          "  ↳ overwrites an existing file — propose_edit would touch only the changed lines",
          "stWait",
          caps,
        ),
      );
    } else {
      // NEW file (or byte-identical) → a create preview of the first lines.
      const allLines = content.length === 0 ? [] : content.split("\n");
      write(
        `${paint(`✎ write_file ${path}`, "toolAction", caps)} ${c.dim(`(${allLines.length} line${allLines.length === 1 ? "" : "s"}, ${content.length} bytes)`)}`,
      );
      for (const styled of highlightPreview(allLines.slice(0, 12), path, caps)) write(styled);
      if (allLines.length > 12) write(c.dim(`    … (${allLines.length - 12} more)`));
    }
    if (permMode === "plan") {
      return { approved: false, reason: JSON.stringify(agent.planModeRefusal(call.name)) };
    }
    // SCOPED auto-approve: `write_file` has no working-set guard of its own (the confirm prompt IS
    // its authorization), so a target outside cwd + /add-dir must always reach a human — otherwise
    // level ≥ 2 ("auto-approve edits") would silently authorize writes to ~/.ssh, ~/.zshrc, …
    const inScope = insideScope(path);
    if (agent.scopedWriteDecision(authLevel, "write_file", WRITE_ANN, inScope) === "allow") {
      auditBypass(call);
      return true;
    }
    if (!inScope) {
      write(
        paint(
          `  ⚠ ${abs} is OUTSIDE the working set (${scopeRoots().join(", ")}) — approval required`,
          "stErr",
          caps,
        ),
      );
      // an outside-scope write is always human-authorized → audit it whatever the mode.
      const okOut = await askConfirm(`write file OUTSIDE the working set: ${abs}?`);
      if (okOut) {
        appendPermissionAudit(call.name, call.args, "approved-outside-working-set", home);
        return true;
      }
      const why = (await askText("reject reason (optional):").catch(() => "")).trim();
      return { approved: false, reason: why || "rejected (outside the working set)" };
    }
    const ok = await askConfirm(`write file ${path}?`);
    if (ok) return true;
    const reason = (await askText("reject reason (optional):").catch(() => "")).trim();
    return { approved: false, reason: reason || "rejected" };
  };

  /**
   * The authorization decision for `run_command`, made on the PARSED command.
   *
   * `classifyAuth` can only see the tool NAME, and it maps `run_command` to the `command`
   * category — which would put `ls` and `rm -rf build` on the same rung and auto-run both at
   * A4. So the tier comes from the CONTENT instead: parse it, classify it, and ask the
   * ladder about that tier. A parse or classification refusal never reaches the runner at
   * all; the model gets the reason and can rewrite.
   *
   * The prompt shows the RE-RENDERED command, not the model's string, so what the human
   * approves is what will actually run.
   */
  const confirmRunCommand = async (call: ToolCall): Promise<agent.ConfirmResult> => {
    const line = typeof call.args.command === "string" ? call.args.command : "";
    const parsed = agent.parseCommand(line, { vars: execVarsFromEnv() });
    /** Set once the command is classified; "-" for anything refused before that. */
    let auditTier: agent.ExecTier | "-" = "-";
    /** One audit line per decision — including the refusals that never reach a human. */
    const audit = (decision: ExecDecision, verdict: string, reason?: string): void =>
      appendExecAudit(
        prometheusHome(),
        execAuditEntry({
          // On a parse failure there is no rendered form, so the raw line is the only record
          // there is — and an unparseable command the model tried is worth keeping.
          command: parsed.ok ? agent.formatCommand(parsed.command) : line,
          tier: auditTier,
          verdict: verdict as never,
          decision,
          authLevel,
          ...(reason ? { reason } : {}),
        }),
      );
    if (!parsed.ok) {
      write(`  ⎿ run_command refused: ${parsed.error}`);
      appendExecAudit(
        prometheusHome(),
        execAuditEntry({
          command: line,
          tier: "-",
          verdict: "-",
          decision: "refused",
          authLevel,
          reason: parsed.error,
        }),
      );
      return {
        approved: false,
        reason: `${parsed.error}${parsed.hint ? ` — ${parsed.hint}` : ""}`,
      };
    }
    const cls = agent.classifyCommand(parsed.command);
    if (!cls.ok) {
      write(`  ⎿ run_command refused: ${cls.error}`);
      audit("refused", "-", cls.error);
      return { approved: false, reason: cls.error };
    }
    auditTier = cls.tier;
    // plan mode is a read-only DENY override, orthogonal to the autonomy scale.
    if (permMode === "plan" && cls.tier !== "read") {
      write(`  ⎿ run_command: blocked by plan mode (${cls.tier})`);
      audit("refused", "-", "blocked by plan mode");
      return { approved: false, reason: JSON.stringify(agent.planModeRefusal("run_command")) };
    }

    // ── layer 3: nemesis, BEFORE the human is asked ────────────────────────
    // Scanning here rather than only in the runner means the confirm prompt can show the
    // verdict — a human being asked to approve a command should not have to guess what the
    // scanner thought of it. The result is latched, so the runner reuses it instead of
    // paying a second scan.
    const gateMode = state.tuning.gateMode ?? "enforce";
    const verdict =
      gateMode === "off" ? null : await scanCommand(agent.formatCommand(parsed.command));
    if (verdict && verdictBlocks(verdict, gateMode)) {
      const why = verdictReasons(verdict).join("; ") || verdict.verdict;
      write(`  ⎿ run_command REFUSED by the nemesis gate (${verdict.verdict}): ${why}`);
      audit("blocked", verdict.verdict, why);
      // Refused at EVERY level, A7 included — the ladder decides how often a human is asked,
      // never whether the scanner is obeyed.
      return { approved: false, reason: `nemesis ${verdict.verdict}: ${why}` };
    }

    const tierLabel = verdict && verdict.verdict !== "allow" ? ` · nemesis ${verdict.verdict}` : "";
    if (agent.execAuthDecision(authLevel, cls.tier) === "allow") {
      auditBypass(call);
      audit("auto", verdict?.verdict ?? "-");
      return true;
    }
    const approved = await askConfirm(
      `run: ${agent.describeCommand(parsed.command, cls)}${tierLabel}?`,
    );
    audit(approved ? "approved" : "declined", verdict?.verdict ?? "-");
    return approved;
  };

  /**
   * `propose_elevated` — render the block, then Copy or Dismiss (§7 step 2/3).
   *
   * The generic path would have asked *"run tool propose_elevated?"*, which tells a human
   * nothing they need in order to decide about root. §7 is explicit that the human must see
   * the exact argv, the cwd, the reason and the nemesis verdict BEFORE answering, so this
   * renders all four and then asks the only question that matters.
   *
   * "Approve" here means COPY, not RUN — nothing in this process will execute the command,
   * at any answer. The clipboard write is the whole action, and it is deliberately the most
   * this product will ever do toward elevation: the sudo prompt is answered in the human's
   * own terminal, by the human, with no password passing through us.
   */
  const confirmProposeElevated = async (call: ToolCall): Promise<agent.ConfirmResult> => {
    const check = agent.checkElevated(
      (call.args.argv ?? []) as readonly unknown[],
      call.args.why,
      call.args.cwd,
    );
    if (!check.ok) {
      write(`  ⎿ propose_elevated refused: ${check.error}`);
      return { approved: false, reason: check.error };
    }
    const proposal = {
      ...check.proposal,
      cwd: typeof call.args.cwd === "string" && call.args.cwd ? call.args.cwd : state.cwd,
    };
    const line = agent.elevatedCommandLine(proposal);

    const gateMode = state.tuning.gateMode ?? "enforce";
    const verdict = gateMode === "off" ? null : await scanCommand(line);
    if (verdict && verdictBlocks(verdict, gateMode)) {
      const why = verdictReasons(verdict).join("; ") || verdict.verdict;
      write(`  ⎿ propose_elevated REFUSED by the nemesis gate (${verdict.verdict}): ${why}`);
      appendExecAudit(
        prometheusHome(),
        execAuditEntry({
          command: line,
          tier: "destructive",
          verdict: verdict.verdict,
          decision: "blocked",
          authLevel,
          reason: why,
        }),
      );
      return { approved: false, reason: `nemesis ${verdict.verdict}: ${why}` };
    }

    // The human reads the block, THEN answers. Never the other way round.
    for (const l of agent
      .renderElevated(proposal, verdict ? { verdict: verdict.verdict } : undefined)
      .split("\n")) {
      write(`  ⎿ ${l}`);
    }
    const approved = await askConfirm("copy this command to your clipboard?");
    if (approved) {
      // OSC 52 rather than pbcopy/xclip: it is the terminal that owns the clipboard, so this
      // also works over SSH and tmux, which is where "just run it yourself" most often lands.
      const osc = osc52Sequence(line, { tmux: Boolean(process.env.TMUX) });
      if (osc.sequence) process.stdout.write(osc.sequence);
      write(
        osc.sequence
          ? "  ⎿ copied — run it in your own terminal, where the sudo prompt is yours to answer"
          : `  ⎿ could not copy (${osc.reason}) — the command is printed above`,
      );
    }
    appendExecAudit(
      prometheusHome(),
      execAuditEntry({
        command: line,
        tier: "destructive",
        verdict: verdict?.verdict ?? "-",
        decision: approved ? "proposed" : "declined",
        authLevel,
        argv: [[...proposal.argv]],
        reason: proposal.why,
      }),
    );
    return approved;
  };

  /**
   * The destructive-mutator card: `apply_patch`, `delete_file`, `move_file`.
   *
   * These three were approved by NAME. `confirmPrompt` later taught the plain host to name
   * their paths, but naming a path is not showing a change, and these are precisely the calls
   * where the change is the decision: a patch spanning six files (approved ONCE, by design),
   * a delete whose contents are gone afterwards, an `overwrite:true` move that destroys the
   * destination silently.
   *
   * `previewMutation` models a delete as a diff to the empty string and a clobbering move as a
   * diff of the DESTINATION, so all three paint through `renderDiffCard` — the same
   * word-level, syntax-highlighted card `propose_edit` already gets — instead of growing three
   * bespoke renderers that would drift from it.
   */
  const showMutationCard = (call: ToolCall): boolean => {
    const caps = deps.caps ?? "none";
    const preview = agent.previewMutation(
      call,
      (p) => (p && isAbsolute(p) ? p : p ? resolve(state.cwd, p) : p),
      nodePreviewIo(),
    );
    if (!preview) return false;
    write(
      preview.willFail
        ? paint(`⚠ ${preview.headline}`, "stErr", caps)
        : paint(preview.headline, "toolAction", caps),
    );
    for (const ch of preview.changes) {
      if (ch.kind === "blocked") {
        write(paint(`  ⎿ ${ch.path ? `${ch.path}: ` : ""}${ch.message}`, "stErr", caps));
        continue;
      }
      if (ch.kind === "delete-dir") {
        for (const e of ch.entries) write(paint(`  − ${e}`, "diffDel", caps));
        if (ch.truncated) write(c.dim(`  … and ${ch.total - ch.entries.length} more`));
        continue;
      }
      if (ch.kind === "move") {
        write(`  ${ch.from}`);
        write(`  → ${ch.to}`);
        // A clobbering move is a delete of the destination — show it as one.
        if (ch.clobbers && ch.lostText !== null) {
          for (const ln of renderDiffCard(
            `✗ replaced ${ch.to}`,
            ch.lostText,
            "",
            ch.to,
            caps,
            "lost to the move",
          )) {
            write(ln);
          }
        } else if (ch.clobbers) {
          write(paint("  ⚠ REPLACES the destination (contents not previewable)", "stErr", caps));
        }
        continue;
      }
      // an `edit` — a patched file, or a delete (newText === "").
      const isDelete = ch.newText === "";
      for (const ln of renderDiffCard(
        isDelete ? `✗ delete ${ch.path}` : `✎ patch ${ch.path}`,
        ch.oldText,
        ch.newText,
        ch.path,
        caps,
        ch.note ?? "",
      )) {
        write(ln);
      }
    }
    return true;
  };

  // authorisation-aware tool confirm: allow → run, plan-mode mutation → refusal, else → modal.
  const turnConfirm = async (call: ToolCall): Promise<agent.ConfirmResult> => {
    if (call.name === "propose_edit") return confirmEdit(call);
    if (call.name === "write_file") return confirmWrite(call);
    if (call.name === "run_command") return confirmRunCommand(call);
    if (call.name === "propose_elevated") return confirmProposeElevated(call);
    // The card is drawn BEFORE the ladder and before plan mode, so a human who is about to be
    // asked has already seen what they are being asked about. It is drawn before the
    // auto-approve check too: at a raised authorisation level the agent deletes files without
    // asking, and "without asking" must not also mean "without telling you what went".
    const previewed = showMutationCard(call);
    // Resolve annotations from the tools ACTUALLY EXPOSED this turn, not from the 14 engine
    // verbs. This lookup used to be `PROMETHEUS_TOOLS.find(...)`, so every tool outside that
    // list — `web_fetch`, and now the whole Tier-R read set — resolved to `undefined`
    // annotations. `classifyAuth` then fell through to its `config` default, which A3
    // auto-approves: `web_fetch` was auto-running two levels below the "network allowed"
    // rung its own `openWorldHint` asks for. Reads must classify as `read` (A1) on their
    // annotation, not by accident of which array they happen to live in.
    const tool = agent.exposedTools(state.tuning.tools).find((t) => t.name === call.name);
    // plan mode is a read-only DENY override, orthogonal to the autonomy scale.
    if (permMode === "plan") {
      if (agent.decideToolForMode("plan", tool?.annotations) === "allow") return true;
      write(`  ⎿ ${call.name}: blocked by plan mode`);
      return { approved: false, reason: JSON.stringify(agent.planModeRefusal(call.name)) };
    }
    if (agent.authDecision(authLevel, call.name, tool?.annotations) === "allow") {
      auditBypass(call);
      return true;
    }
    // A previewed call gets the INFORMED prompt (`confirmPrompt` names the command, the
    // absolute paths, and whether any of them escape the working set); everything else keeps
    // the terse form it already had. "run tool delete_file?" was never a question anyone could
    // answer responsibly.
    return askConfirm(
      previewed ? confirmPrompt(call, state.cwd, scopeRoots()) : `run tool ${call.name}?`,
    );
  };

  // One store per session. `clearOnce` runs after each turn so a `once` grant cannot leak
  // into the next one; `project`/`user` grants are loaded from and written back to disk, so
  // "don't ask again" survives a restart — which is the only reading of those words.
  // The user's `[permissions]` rules — the same loader the readline host and headless use.
  // `let`: `/cd` re-derives this for the NEW cwd — a project's own tightened rules must govern
  // it, not whatever the OLD project declared.
  let permissionRules = loadPermissionRules({
    home: deps.configHome,
    // `state.cwd` was already resolved through `resolveCwd` above — reusing it here (rather than
    // recomputing `parsed.cwd ?? process.cwd()`) is what keeps this in sync with the guard: a run
    // redirected away from Prometheus's own repo must have ITS permission rules loaded for the
    // redirected directory, never the original one.
    cwd: state.cwd,
  });
  const grants = new agent.ScopedPermissionStore();
  const loadedGrants = loadGrantsInto(grants, deps.configHome);
  // Sub-agent personas, clamped by scope — see the readline host's twin. `let`: `/cd` re-derives
  // this for the NEW cwd — a persona from the OLD project keeping its trust in a different one
  // would be a correctness (and trust) bug, not a convenience.
  let agentFiles = loadAgentFiles(state.cwd, home);
  // User-defined `/name` commands (project/user .prometheus/command/*.md) — see the readline
  // host's twin. Built-in names are refused at load time, and `submit` below consults the
  // built-in registry first, so a repo cannot redefine `/gate`. This was entirely missing from
  // the TUI: a command file that worked under --plain/--tmux (host.ts) silently did not exist
  // on the default raw-mode TUI surface — the same shape of gap as /background before it was
  // fixed. `let`: `/cd` re-derives this for the new cwd, same reason as agentFiles above.
  let commandFiles = loadCommandFiles(state.cwd, new Set(allSlashNames()), home);
  if (loadedGrants.refused > 0) {
    // The file asked for something the UI would never have accepted — say so rather than
    // dropping it silently, because a hand-edited or hostile grants file is the case that
    // matters here.
    write(`  ! ${loadedGrants.refused} saved grant(s) refused as too broad`);
  }
  // One task list per session. It is agent memory, not a file — cleared when the session ends,
  // never written to the user's repo.
  const todos = new agent.TodoStore();

  /**
   * `writeOverride` lets a caller redirect a turn's output away from the live pane — the seam
   * `/background` needs so a detached run's text feeds the run's own ring buffer (`agents
   * attach`) instead of interleaving into whatever the user is doing at the prompt right now.
   * Every ordinary call site omits it and gets the pane's `write`, unchanged.
   */
  const turnCtx = (writeOverride?: (s: string) => void): TurnCtx => {
    const w = writeOverride ?? write;
    const cols = deps.width?.();
    return {
      client,
      // Resolve a cloud endpoint's key lazily, per request — the seam no host ever assigned.
      resolveKey,
      // MCP tools join the catalog per turn — servers connect asynchronously, so a value
      // frozen at startup would go stale with nothing to say so.
      //
      // `permissionMode` rides ALONG WITH the tuning so the shared loop enforces plan mode
      // itself. The confirm seams below (`confirmEdit`/`confirmWrite`/`confirmRunCommand`/
      // `turnConfirm`) still check it and still show the human-facing refusal line — they are
      // not redundant, they are the layer that can PRINT. The loop check is the one that also
      // covers the calls confirm never sees: `tuning.yes` lifts read-only tools straight past
      // the confirm seam, and a tool whose annotations are missing or wrong classifies as
      // `edit`, which plan mode must refuse whether or not a host remembered to ask.
      tuning: {
        ...withMcpTools(state.tuning, mcp?.tools() ?? []),
        permissionMode: permMode,
        // Lifecycle hooks ride the TUNING (not the deps) so `childTuning` carries them into a
        // `spawn_agent` child — delegation must not be a way to shed a user's PreToolUse guard.
        ...(sessionHooks.length > 0 ? { hooks: sessionHooks } : {}),
        ...(hookRunner ? { hookRunner } : {}),
      },
      // (A) `/timeout` — the session's inactivity-pause threshold.
      idleTimeoutMs: idleTimeoutMsSetting,
      json: parsed.json,
      ...(endpoint ? { endpoint } : {}),
      // The session's effective effort capability table (builtins ⊕ user ⊕ workspace
      // override files). Loaded once at startup — see `session/effort-rules.ts`.
      effortRules: effortRulesLoad.rules,
      confirm: turnConfirm,
      // The `question` tool's seam — the TUI already has a free-text modal.
      ask: askText,
      ...(agentFiles.length > 0 ? { agentFiles } : {}),
      // Remembered "don't ask again" grants (deny-priority, narrow subjects, safe-defaults
      // forced to `once`).
      grants,
      permissionRules: permissionRules.rules,
      // The exec audit's two inputs — declared and consumed but assigned by no host, so every
      // runner-side audit line was silently dropped. See the readline host's twin.
      home,
      authLevel,
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
      /**
       * The delegation cap the model actually runs under.
       *
       * `SessionCtx.subagentBudget` was declared, read once by `runMessageTurn`, and assigned
       * by NO host — so `initialBudget({})` always won and `/agents N` could not move it. This
       * is the assignment that was missing.
       */
      subagentBudget: { maxSpawns: spawnCap },
      onTodos: (items) => w(`  ▤ ${agent.todoSummary(items)}`),
      onRemember: (subject, scope) => {
        w(`  ✓ remembered: ${subject} (${scope})`);
        // Written now, not at exit: a session that ends in a crash or a kill would otherwise
        // lose exactly the answer the user took the trouble to give.
        if (scope === "project" || scope === "user") saveGrants(grants, deps.configHome);
      },
      onAutoApprove: (subject) => w(`  ↩ auto-approved from a remembered grant: ${subject}`),
      ...(mcp ? { callMcpTool: (id, tool, args) => mcp.callTool(id, tool, args) } : {}),
      write: w,
      ...(cols && cols > 0 ? { width: cols } : {}),
      // terminal color depth → Pelly syntax highlighting of code inside the reasoning stream.
      ...(deps.caps ? { caps: deps.caps } : {}),
      // read scope = cwd (implicit root) + every /add-dir dir, resolved fail-closed.
      workingSet: [state.cwd, ...ws.list()],
      // propose_edit resolves paths against cwd + logs pre-images for /revert (CLI-010).
      cwd: state.cwd,
      editHistory,
      // turn-atomic checkpoints (CLI-015) — snapshot pre-images before an edit applies.
      checkpoint: { store: checkpointStore, sessionId },
      // Token accounting (CLI-029) + the spend cap. Neither host set these, so
      // `prometheus tokens report` read an empty store and a configured cap could not evaluate.
      accounting: { home, sessionId },
      ...(budgetGuard ? { budget: budgetGuard } : {}),
      // the built-in repo map (CLI-053): inject the rendered block only while enabled (getter → live).
      repoMap: () => (repoMapState.enabled ? repoMapState.rendered : null),
      // steering (CLI-061): the assembled AGENTS.md/CLAUDE.md/PROMETHEUS.md block, re-read per turn.
      steering: () => steering.block(),
      // durable cross-session memory: the `memory_write`-authored index, re-read per turn.
      memory: loadMemory,
      // SessionStart hook output, captured once at session start and replayed per turn.
      sessionStartHooks: () => sessionStartBlock,
      // CLI-088: token-economy toggles, read ONCE at session start.
      tokenToggles,
    };
  };

  /** Undo the most-recent applied propose_edit by restoring its kept pre-image. */
  const revertLastEdit = (): string | undefined => {
    const rec = editHistory.pop();
    if (!rec) return undefined;
    return revertEdit(rec) ? rec.path : undefined;
  };

  const runAgentMessage = async (input: string, opts?: { signal?: AbortSignal }): Promise<void> => {
    /**
     * The turn's DELEGATION CAP — a number that now does something.
     *
     * `subagentCount` reached exactly one consumer: the announcement string. So `/agents 5`
     * printed "scaling 3 → 5 subagents", the user believed five agents were working, and the
     * cap the model actually ran under stayed at its hard-coded default forever. The cap is
     * computed here, announced here, and carried into `SubagentBudget.maxSpawns` by
     * `turnCtx()` — one number, one meaning.
     */
    spawnCap = spawnCapFor(input, explicitAgents, agent.DEFAULT_MAX_SPAWNS);
    if (orchestrating) {
      const note = orchestratorNote(input, subagentCount);
      if (note) write(`🛸 ${note}`);
    }
    if (contextProbe) {
      // Bounded: see the readline host's identical wait ahead of `maybeAutoCompact`.
      await Promise.race([
        contextProbe.catch(() => undefined),
        new Promise((r) => setTimeout(r, CONTEXT_PROBE_AWAIT_MS)),
      ]);
      contextProbe = undefined;
    }
    // auto-compact BEFORE the turn when the transcript nears the context budget (CLI-016). The
    // window is the SMALLER of the endpoint's own window and `contextWindowSetting` (`/context
    // window`, default 250k) — a user-chosen ceiling always wins over a bigger number the
    // model's metadata claims, and a genuinely smaller real window always wins over an
    // optimistic setting. See the readline host's `maybeAutoCompact` for the full rationale.
    const policy = autoCompactPolicy(
      COMPACT_THRESHOLD_PCT,
      Math.min(endpoint?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, contextWindowSetting),
      COMPACT_KEEP_RECENT,
    );
    if (session && shouldAutoCompact(session, policy) && policy) {
      const { summarize, offline } = makeSummarizer(turnCtx(), {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        onStatus: write,
      });
      const auto = await compactSession(
        sessionId,
        session,
        policy,
        summarize,
        new Date().toISOString(),
        { offline },
      );
      if (auto.compacted) {
        session = auto.session;
        history = auto.history;
        write(auto.notice);
      }
    }
    state = repl.reduce(state, { type: "message", role: "you", text: input });
    const res = await runMessageTurn(session, input, {
      ctx: turnCtx(),
      history,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    // A `once` grant answers exactly one turn; anything longer-lived survives.
    grants.clearOnce();
    session = res.session;
    // persist the turn transcript: user prompt + every AgentEvent (CLI-012). Fail-soft.
    appendTurnEvents(home, sessionId, [{ role: "user", text: input }, ...res.events]);
    rotateSessions(home, { maxBytes: SESSION_TRANSCRIPT_CAP_BYTES, liveId: sessionId });
    // /restore's picker column: what THIS turn actually did (mechanical, no model round-trip).
    updateSessionSummary(home, sessionId, turnSummaryOf(input, res.events));
    if (res.reply.trim()) {
      state = repl.reduce(state, { type: "message", role: "prometheus", text: res.reply });
    }
    /**
     * Carry the WHOLE turn forward — tool results included. See the readline host's twin.
     *
     * A user/assistant text pair means the model begins every turn having read nothing, and
     * putting the update inside `if (res.reply.trim())` meant a turn that ran tools and
     * produced no prose dropped the user's message from history as well.
     */
    history = res.thread?.length
      ? agent.carryForward(res.thread, {
          budgetTokens: agent.carryBudgetFor(endpoint?.contextWindow),
        })
      : [...history, { role: "user", content: input }, { role: "assistant", content: res.reply }];
    continueCount = 0; // CLI-072: a fresh turn resets the continue chain.
    settleCap(res);
    // yolo (run-to-done): auto-answer /continue until the task finishes or a budget/safety stop.
    if (agent.isRunToDoneMode(permMode) && res.capped) {
      await autoRunToDone(res, opts?.signal);
    }
  };

  /** CLI-072: fold a turn's cap OR idle-pause outcome into resume state (stash, clear on clean end). */
  const settleCap = (res: {
    capped: boolean;
    paused?: boolean;
    pausedIdleMs?: number;
    thread: agent.ThreadMessage[];
  }): void => {
    if (res.capped || res.paused) {
      capturedResume = res.thread;
      // yolo (run-to-done) only auto-resumes a CAPPED turn (below) — an idle pause is left for
      // the user to notice and act on, matching "pause forever until the user gets back".
      if (!agent.isRunToDoneMode(permMode) || res.paused) {
        const again = continueCount > 0 ? ` (resumed ${continueCount}×)` : "";
        const why = res.paused
          ? `paused after ${Math.round((res.pausedIdleMs ?? 0) / 1000)}s of inactivity`
          : "paused at the step cap";
        write(c.dim(`⎿ ${why} — /continue to resume, or just keep typing${again}`));
      }
    } else {
      capturedResume = null;
    }
  };

  /** Resume a capped turn with full prior tool state (CLI-072). Honest no-op when nothing paused. */
  const runContinue = async (opts?: { signal?: AbortSignal }) => {
    if (!capturedResume) {
      write(c.dim("nothing to continue — the last turn finished within its step budget."));
      return null;
    }
    continueCount++;
    const res = await runMessageTurn(session, "/continue", {
      ctx: turnCtx(),
      resumeThread: capturedResume,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    grants.clearOnce();
    session = res.session;
    appendTurnEvents(home, sessionId, [{ role: "user", text: "/continue" }, ...res.events]);
    rotateSessions(home, { maxBytes: SESSION_TRANSCRIPT_CAP_BYTES, liveId: sessionId });
    updateSessionSummary(home, sessionId, turnSummaryOf("/continue", res.events));
    if (res.reply.trim()) {
      state = repl.reduce(state, { type: "message", role: "prometheus", text: res.reply });
    }
    /**
     * A continuation carries its thread forward too — see the readline host's twin.
     *
     * This kept only the text and dropped `res.thread`, discarding every tool result the
     * continuation produced. It matters more here than anywhere: a yolo run-to-done chain is
     * nothing BUT continuations, so a long autonomous run remembered none of its own work.
     */
    history = res.thread?.length
      ? agent.carryForward(res.thread, {
          budgetTokens: agent.carryBudgetFor(endpoint?.contextWindow),
        })
      : history;
    settleCap(res);
    // A pause (idle-timeout) is still an open chain, exactly like a round cap — `settleCap`
    // above already re-stashed the resume state for it, so the counter must not reset either,
    // or "resumed N×" understates how many times this SAME chain has had to be continued.
    if (!res.capped && !res.paused) continueCount = 0;
    return res;
  };

  /**
   * yolo run-to-done: auto-answer `/continue` past each round-cap until the task finishes, a budget
   * is hit, no progress is made, or the nemesis gate BLOCKs (hard stop). Orthogonal to bypass — it
   * only removes the per-TURN pause; every per-tool safety gate still runs each round.
   */
  const autoRunToDone = async (
    first: Awaited<ReturnType<typeof runMessageTurn>>,
    signal?: AbortSignal,
  ): Promise<void> => {
    let acState = agent.initAutoContinue(Date.now());
    let tokens = 0;
    let cur: Awaited<ReturnType<typeof runMessageTurn>> | null = first;
    for (;;) {
      if (!cur) break;
      tokens += Math.ceil((cur.reply ?? "").length / 4); // ~4 chars/token, budget proxy
      acState = cur.events.reduce(agent.observeEvent, acState);
      const decision = agent.decideAutoContinue({
        mode: permMode,
        capped: cur.capped,
        state: acState,
        budget: agent.DEFAULT_AUTO_CONTINUE_BUDGET,
        nowMs: Date.now(),
        tokensSpent: tokens,
        progressDigest: agent.progressDigest(cur.events),
      });
      if (!decision.resume) {
        if (cur.capped) write(c.dim(`⎿ yolo auto-continue stopped: ${decision.reason}`));
        break;
      }
      acState = decision.state;
      if (signal?.aborted) {
        write(c.dim("⎿ yolo auto-continue: interrupted"));
        break;
      }
      write(c.dim(`⎿ yolo: auto-continuing (step ${acState.continues})…`));
      cur = await runContinue(signal ? { signal } : undefined);
    }
  };

  /** Restore a past session: rebuild the LLM history, repaint the transcript, reset cwd. CLI-013. */
  const restoreSession = (r: SessionRecord): void => {
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
      write(
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
    capturedResume = null; // CLI-072: a restored session has no in-flight capped turn.
    continueCount = 0;
    if (r.cwd) state = repl.reduce(state, { type: "cwd", dir: r.cwd });
    write(c.bold(`↻ resumed session ${r.id.slice(0, 8)} · ${r.ts.replace("T", " ").slice(0, 16)}`));
    if (elided > 0) {
      write(c.dim(`  restored ${messages.length} msgs · ${elided} older elided for context`));
    }
    // model + system prompt are NOT persisted per-session (index.jsonl is metadata-only) —
    // keep the current tuning so resuming never spawns a pull/serve you didn't consent to.
    write(c.dim("  model + system prompt kept from the current session"));
    for (const p of painted) {
      if (p.role === "you") {
        state = repl.reduce(state, { type: "message", role: "you", text: p.text });
        write(`› ${p.text}`);
      } else if (p.role === "prometheus") {
        state = repl.reduce(state, { type: "message", role: "prometheus", text: p.text });
        write(p.text);
      } else {
        write(c.dim(p.text));
      }
    }
  };

  /**
   * Run a user-defined command file (a project/user `.prometheus/command/*.md`) — mirrors the
   * readline host's identical `runCommandFile`. `@ref` reads and `!cmd` shell requests inside the
   * file are expanded here (never inside the model's own context), with a real confirm prompt
   * for the shell case — a command file authored months ago has not earned the ladder's
   * auto-approval the way a command the model just composed in response to a live request has.
   */
  const runCommandFile = async (cmd: LoadedCommand, rest: string): Promise<void> => {
    const argv = rest.trim() ? rest.trim().split(/\s+/) : [];
    const { prompt, rejected } = await expandCommand(cmd, argv, {
      readFile: async (rel) => {
        const out = await runSystemTool(
          "read_file",
          { path: rel },
          { cwd: state.cwd, roots: [state.cwd, ...ws.list()] },
        );
        if (!out?.ok) throw new Error(out?.summary ?? "unreadable");
        return out.summary;
      },
      runShell: async (command) => {
        write(c.dim(`  ${cmd.file.name}: wants to run  ${command}`));
        if (!(await askConfirm(`run \`${command}\` from ${cmd.path}?`))) return null;
        const out = await runSystemTool(
          "run_command",
          { command },
          {
            cwd: state.cwd,
            roots: [state.cwd, ...ws.list()],
            gateMode: state.tuning.gateMode,
            home,
            // The session's level, so this human-approved run is confined by the OS sandbox
            // to exactly what the ladder already permits — omitting it would silently pin
            // every command-file shell to the safe default however the session is set.
            authLevel,
          },
        );
        return out?.ok ? out.summary : null;
      },
    });
    for (const r of rejected) write(c.yellow(`  ! ${r.what} — ${r.reason}`));
    if (!prompt.trim()) {
      write(c.red(`/${cmd.file.name}: expanded to nothing`));
      return;
    }
    await runAgentMessage(prompt);
  };

  const runHostSetup = async (): Promise<void> => {
    const r = await runSetup({ client, write, ask: askText, askPath: askFolder, home });
    if (r.endpoint) {
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
    }
  };
  const runHostPaths = async (): Promise<void> => {
    await runPathsWizard({ client, write, ask: askText, askPath: askFolder, home });
    process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);
  };

  /**
   * `/cd` — move to a different project WITHOUT quitting and relaunching. Mirrors the readline
   * host's `changeProjectDirectory` exactly (see its header there for the full rationale): the
   * target is validated FIRST (a bad path is a no-op, not a wrecked conversation), then the
   * session rotates — fresh id, empty transcript/history, project-scoped state (personas,
   * permission rules, the built-in repo map, steering docs) re-derived for the NEW directory —
   * while tuning (model/system prompt/tools/gate/dry-run/verbosity/effort/authLevel/permMode)
   * carries over unchanged. This host has no `/name` command-file layer, so there is nothing
   * equivalent to reload for it.
   */
  /**
   * Re-point every PROJECT-SCOPED binding at `target`. Shared by `/cd` and `/cwd`.
   *
   * `/cwd` used to do only the `cwd` reduce, so it moved the session and reloaded NOTHING: the
   * new project's AGENTS.md/CLAUDE.md/PROMETHEUS.md were never read, `/memory` kept listing the
   * OLD project's steering paths, and permission rules, project command files, personas, the
   * repo-map root and the effort table all stayed pinned to the launch directory. Proven with a
   * live model: an AGENTS.md saying "begin every reply with ZORBLAX" is obeyed when the session
   * starts in that directory and after `/cd`, and ignored after `/cwd`.
   *
   * `/worktree switch` routes through the same `setCwd` seam, so it had the bug too.
   *
   * The cwd reduce comes FIRST, before the reloads: `steering` was built with a live
   * `cwd: () => state.cwd` getter (unlike agentFiles/permissionRules/repoMapState, which take
   * `target` explicitly), so calling `steering.reload()` while `state.cwd` still held the OLD
   * directory silently re-discovered the OLD project's files.
   *
   * What this deliberately does NOT touch is the session: transcript, history and session id
   * are `/cd`'s business (it rotates), and keeping them is the whole point of `/cwd`.
   */
  /**
   * Re-print the banner after the working directory moves.
   *
   * The banner's `cwd` line is the ONE place the session says where it is, and it was printed
   * exactly once at startup — so after a `/cwd` or `/cd` the header kept naming the launch
   * directory for the rest of the session. A terminal cannot rewrite scrollback, so the only
   * way to make that line current is to print it again.
   *
   * The whole frame, not a one-line echo, and deliberately: a directory change re-points the
   * agent files, the permission rules, the repo map and the effort table (see
   * `moveProjectRoot`), and `/cd` additionally rotates the session. Re-showing the frame is
   * the honest marker for "everything above this belongs to a different project".
   */
  const announceCwd = (_target: string): void => {
    write("");
    write(banner());
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
    repoMapState.enabled = false;
    repoMapState.root = target;
    repoMapState.map = null;
    repoMapState.rendered = null;
    steering.reload();
    // The effort capability table is project-scoped too: a repo may ship its own
    // `.prometheus/effort-capabilities.json`, and keeping the OLD project's overrides in force
    // after a move is the same staleness every reload above exists to prevent.
    effortRulesLoad = loadEffortRules(target, home);
    for (const note of effortRulesLoad.notes) write(`  ! effort rules: ${note}`);
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

  // Shared /invoke deps (CLI-059): the number-pick slash AND the arrow-nav overlay both dispatch
  // through THIS one gated seam, so the nemesis dry-run+confirm sequence is byte-identical.
  const invokeDeps: InvokeDeps = {
    client,
    write,
    ask: askText,
    confirm: askConfirm,
    install: async (name, opts) => {
      const extra = (opts?.args ?? "").split(/\s+/).filter(Boolean);
      const outcome = await execVerb(
        [
          "install",
          name,
          ...(opts?.dryRun ? ["--dry-run"] : []),
          ...(opts?.yes ? ["--yes"] : []),
          ...extra,
        ],
        verbCtx,
      );
      if (outcome.text) write(outcome.text);
    },
  };

  const slashCtx: SlashCtx = {
    write,
    json: parsed.json,
    tuning: () => state.tuning,
    cwd: () => state.cwd,
    /**
     * `/fleet` — refresh first, then report.
     *
     * Refreshing is not politeness: the table is read at the exact moment a user noticed
     * something on the bar, so a two-second-stale row is the difference between "peer 3 died"
     * and a table that still lists it as working.
     */
    fleet: async () => {
      if (!fleet) return [c.dim("this surface does not track other Prometheus windows")];
      await fleet.refresh();
      return fleetReport(fleet.peers(), fleet.meters(), Date.now());
    },
    runVerb: async (tokens) => {
      const outcome = await execVerb(tokens, verbCtx);
      if (outcome.text) write(outcome.text);
    },
    sendToAgent: runAgentMessage,
    continueTurn: async () => {
      await runContinue();
    },
    tune: (patch) => {
      state = repl.reduce(state, { type: "tune", patch });
    },
    effortResolution,
    // `/think` reaches the SAME setter the trait rail uses, so the tier is persisted whichever
    // way the user changed it. It used to write a bare tuning patch and be forgotten at exit.
    setEffort: (tier) => {
      setEffort(tier);
    },
    getAuthLevel: () => authLevel,
    setAuthLevel: (level, origin) => {
      authLevel = agent.authLevelMeta(level).level; // clamp 0–7
      permMode = agent.authLevelToMode(authLevel); // sync the coarse mode/indicator
      if (origin === "user") saveAuthLevel(authLevel, deps.configHome);
    },
    /**
     * `/permission-mode` reaches the SAME dial Shift-Tab drives, including the authLevel sync.
     * Two ways to set one posture that disagreed about the companion level would show a
     * "⏸ plan mode on" indicator over an authLevel that still auto-approves edits.
     *
     * SESSION-SCOPED: the level moves in memory so the approval decisions follow the posture,
     * but nothing is written. mode→level is lossy (five modes, eight levels), so persisting the
     * derived value overwrote the user's explicit `/authorisation N` with a coarse approximation.
     */
    getPermMode: () => permMode,
    setPermMode: (mode) => {
      permMode = mode;
      authLevel = agent.modeToAuthLevel(mode);
    },
    control: (signal) => {
      if (signal === "quit") void doQuit();
      else {
        state = repl.reduce(state, { type: "clear" });
        history = [];
        capturedResume = null; // CLI-072: nothing to /continue after a fresh conversation.
        continueCount = 0;
        write("(context cleared — fresh conversation)");
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
        write(
          `⚠ Prometheus refuses to operate inside its own repository (${move.redirectedFrom}) — redirected to ${move.cwd}.`,
        );
      }
      // Moves in place AND re-points the project-scoped state — see `moveProjectRoot`. Doing
      // only the reduce here is what left the model reading the launch directory's rules.
      moveProjectRoot(move.cwd);
      return move;
    },
    compact: async (focus) => {
      // manual /compact: summarize everything before the recent tail (force, regardless of size).
      if (!session || session.turns.length <= COMPACT_KEEP_RECENT) {
        write("⎿ nothing to compact yet");
        return;
      }
      const { summarize, offline } = makeSummarizer(turnCtx(), { onStatus: write });
      const sum = focus
        ? async (older: readonly agent.SessionTurn[]) =>
            `Focus: ${focus}\n${await summarize(older)}`
        : summarize;
      const res = await compactSession(
        sessionId,
        session,
        { maxTokens: 1, keepRecentTurns: COMPACT_KEEP_RECENT },
        sum,
        new Date().toISOString(),
        { offline },
      );
      session = res.session;
      history = res.history;
      write(res.notice);
    },
    exportTranscript: (file) => {
      try {
        const body = state.transcript
          .map((m) => {
            const e = m as { role?: string; text?: string };
            return `[${e.role ?? "?"}] ${e.text ?? ""}`;
          })
          .join("\n");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const out = file?.trim()
          ? file.trim()
          : join(home, "logs", "sessions", `session-${stamp}.txt`);
        writeFileSync(out, `${body}\n`);
        return out;
      } catch {
        return "";
      }
    },
    // CLI-082: additive structured export — reads CLI-012's persisted per-turn JSONL and writes a
    // `{sessionId, exportedAt, turns}` .json doc (never perturbs the plain-text path above).
    exportTranscriptJson: (file) => {
      try {
        const doc = buildSessionExport(
          sessionId,
          loadTurns(home, sessionId),
          new Date().toISOString(),
        );
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dir = join(home, "logs", "sessions");
        mkdirSync(dir, { recursive: true });
        const out = file?.trim() ? file.trim() : join(dir, `session-${stamp}.json`);
        writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
        return out;
      } catch {
        return "";
      }
    },
    ask: askText,
    confirm: askConfirm,
    askPath: askFolder,
    ...(deps.focusTraitRail ? { focusTraitRail: deps.focusTraitRail } : {}),
    runSetup: runHostSetup,
    runPaths: runHostPaths,
    runDemos: (rest) =>
      runDemos(rest, {
        client,
        ...(endpoint ? { endpoint } : {}),
        home,
        cwd: state.cwd,
        caps: deps.caps ?? "none",
        write,
        ask: askText,
        confirm: askConfirm,
        localModels: async () => (endpoint?.model ? [endpoint.model] : []),
      }),
    runUpdates: async (rest) => {
      // the slash handler is void — CLI-047's widened return (report|null) is discarded here.
      await runUpdates(rest, {
        home,
        promVersion: PROM_VERSION,
        client,
        write,
        env: process.env,
        ...(process.argv[1] ? { scriptPath: process.argv[1] } : {}),
        cwd: state.cwd,
      });
    },
    usage: () => {
      // local via endpoint locality (a remote OpenAI-compatible endpoint also sets `endpoint`),
      // falling back to the provider-name heuristic offline (CLI-058).
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
    runInvoke: (rest) => runInvoke(rest, invokeDeps),
    runRecall: async (rest?: string) => {
      // Headless runs are recorded but kept out of the picker — see `interactiveSessions`.
      const records = interactiveSessions(listSessions(home));
      const arg = (rest ?? "").trim();
      // /resume <id|number> → restore directly; bare → numbered picker → restore.
      if (arg) {
        const n = Number(arg);
        const r =
          Number.isInteger(n) && n >= 1 && n <= records.length
            ? records[n - 1]
            : records.find((x) => x.id === arg || x.id.startsWith(arg));
        if (!r) {
          write(c.red(`no session matching "${arg}"`));
          return;
        }
        restoreSession(r);
        return;
      }
      write(formatPicker(records));
      if (records.length === 0) return;
      const ans = (await askText("recall #: ")).trim();
      const n = Number(ans);
      if (!Number.isInteger(n) || n < 1 || n > records.length) {
        write("(cancelled)");
        return;
      }
      const r = records[n - 1];
      if (r) restoreSession(r);
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
    /**
     * `/background <task>` — run a turn DETACHED and register it so `agents list` sees it.
     *
     * The default raw-mode TUI never wired this at all — every `/background`/`/bg`/`/detach`
     * unconditionally printed "this surface cannot run a detached agent", regardless of the
     * task, on the surface almost every interactive user actually runs (the readline host only
     * activates via --plain/--tmux/PROMETHEUS_TMUX=1). Mirrors the readline host's identical
     * wiring: a FRESH session (two turns appending to the live transcript concurrently would
     * interleave, and a detached run isn't part of the conversation at the prompt), output
     * redirected to the run's own ring buffer via `turnCtx`'s write-override seam so it never
     * interleaves into the live pane, and the registry's own abort signal so `agents kill` works.
     */
    startBackground: (task) => {
      const { id } = startDetachedRun({
        model: state.tuning.model.modelId,
        provider: state.tuning.model.provider,
        task,
        run: async (rc) => {
          // Recompute the delegation cap from the BACKGROUND task's own prompt — the shared
          // `spawnCap` closure variable is only ever reassigned by the FOREGROUND turn
          // (runAgentMessage), so /agents N followed immediately by /background (no prior
          // foreground message this session) used to run the background task at the untouched
          // default (8) instead of N. Overriding subagentBudget directly on this one ctx, rather
          // than reassigning the shared `spawnCap` variable, also avoids racing a concurrently
          // dequeued foreground turn's own recompute.
          const ctx = turnCtx(rc.append);
          const res = await runMessageTurn(undefined, task, {
            ctx: {
              ...ctx,
              subagentBudget: {
                maxSpawns: spawnCapFor(task, explicitAgents, agent.DEFAULT_MAX_SPAWNS),
              },
              // A DEDICATED checkpoint namespace, not the shared (possibly-since-rotated)
              // `sessionId` — this run mints a genuinely fresh in-memory session (`undefined`
              // above) precisely so it isn't part of the live conversation, but without this the
              // file-edit checkpoint it records still landed under the SAME sessionId string the
              // foreground /revert and /checkpoints read from. If this background run's
              // checkpoint happened to be inserted last, a foreground /revert would silently
              // restore-then-PERMANENTLY-DELETE the background task's edits instead of the
              // user's own last turn, with no warning the reverted work wasn't theirs.
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
    workingSet: {
      list: () => ws.list(),
      add: (dir) => ws.add(dir, state.cwd),
      remove: (dir) => ws.remove(dir, state.cwd),
    },
    // the built-in repo map (CLI-053): stats (no-arg) + on|off|refresh; walks the current cwd.
    repoMap: {
      stats: () => repoMapStats(repoMapState),
      apply: (verb) => {
        repoMapState.root = state.cwd;
        return applyRepoMapVerb(repoMapState, verb);
      },
    },
    // the git spawn seam for /worktree (CLI-054): the engine-bridge safe-env spawn (C5).
    git: realGitSpawn,
    // CLI-096: effective keymap for /keys, resolved from the [keymap] config table.
    // `deps.configHome`, NOT `home` (the ~/.prometheus STATE tree) — see host.ts's twin.
    keymap: loadKeymap(deps.configHome),
    // OSC 52 clipboard (CLI-068): raw passthrough to the tty (frame-safe — moves no cursor).
    copyToClipboard: (text) =>
      copyReplyStatus(text ?? lastAssistantReply(history), !!process.env.TMUX, (s) =>
        process.stdout.write(s),
      ),
    // /apply (CLI wrapper): pull SEARCH/REPLACE + ```diff edit blocks out of the last reply and
    // put them on disk through the SAME fallback-laddered + verify-gated + atomic applier as
    // propose_edit. Confirm-gated (destructive), path-guarded to the working set.
    applyFromLastReply: async () => {
      const intents = agent.extractEditIntents(lastAssistantReply(history));
      if (intents.length === 0) {
        write(c.dim("/apply: no SEARCH/REPLACE or ```diff blocks in the last reply."));
        return;
      }
      write(c.dim(`/apply: found ${intents.length} edit block(s):`));
      for (const it of intents) {
        write(c.dim(`  • ${it.path ?? "(no path)"} · ${it.hunks.length} hunk(s) [${it.kind}]`));
      }
      const ok = await askConfirm(`apply ${intents.length} edit block(s) to disk?`);
      if (!ok) {
        write(c.dim("/apply: cancelled."));
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
        write(o.ok ? c.green(`  ✓ ${o.summary}`) : c.red(`  ✗ ${o.path}: ${o.summary}`));
      }
    },
    // steering files (CLI-061): /memory list/reload/edit/create over the shared controller.
    steering: {
      list: () => steering.list(),
      reload: () => steering.reload(),
      edit: (target) => steering.edit(target),
      create: () => steering.create(),
    },
    // lifecycle-hook diagnostics (CLI-102): the TUI's half of the readline host's wiring,
    // deliberately identical — `test` spawns the SAME injected `hookRunner` a real turn would
    // (§ above) with a synthesized payload on stdin, never through runPreToolUseHooks/
    // firePostToolUseHooks/runSessionStartHooks, so it can only ever observe a hook, never gate
    // or delay a live call.
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
          chars: JSON.stringify(effectiveTools(PROMETHEUS_TOOLS, t)).length,
        },
      ];
      if (repoMapState.enabled && repoMapState.rendered) {
        parts.push({ label: "repo map", chars: repoMapState.rendered.length });
      }
      return { parts, ...(endpoint?.contextWindow ? { window: endpoint.contextWindow } : {}) };
    },
    // /context window: the persisted auto-compact ceiling (default 250k) — mirrors the host.
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

  const legacySlashCtx: LegacySlashCtx = {
    state,
    json: parsed.json,
    write,
    confirm: askConfirm,
    execVerb: (tokens) => execVerb(tokens, verbCtx),
  };

  const handleSlash = async (name: string, rest: string): Promise<void> => {
    const res: SlashResult = await execSlash(name, rest, { ...legacySlashCtx, state });
    switch (res.kind) {
      case "tune":
        state = repl.reduce(state, { type: "tune", patch: res.patch });
        if (res.text) write(res.text);
        break;
      case "pane":
        state = repl.reduce(state, { type: "set-pane", pane: res.pane });
        write(res.text);
        break;
      case "verb":
        if (res.outcome.text) write(res.outcome.text);
        break;
      case "control":
        if (res.text) write(res.text);
        if (res.control === "quit") void doQuit();
        else if (res.control === "clear") state = repl.reduce(state, { type: "clear" });
        else if (res.control === "cwd" && res.rest.trim())
          state = repl.reduce(state, { type: "cwd", dir: res.rest.trim() });
        // `/save` printed `saving → out.jsonl…` and fell off the end of this chain, writing
        // nothing. The export function it needed is two hundred lines below and has always
        // worked; this host just never reached for it.
        else if (res.control === "save") {
          const out = slashCtx.exportTranscript(res.rest.trim() || undefined);
          write(out ? c.dim(`saved → ${out}`) : c.red("save failed (could not write the file)"));
        }
        break;
      case "error":
        write(res.text);
        break;
    }
  };

  const submit = async (input: string, opts?: { signal?: AbortSignal }): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // Peers see this window as `working` for the WHOLE submission — a slash command that opens
    // a folder prompt is every bit as much "busy, do not expect an answer from me" as a model
    // turn. `finally`, so an abort or a thrown handler cannot strand the window as busy forever.
    fleetState("working");
    try {
      return await runSubmit(trimmed, opts);
    } finally {
      fleetState("idle");
    }
  };

  const runSubmit = async (trimmed: string, opts?: { signal?: AbortSignal }): Promise<void> => {
    state = repl.reduce(state, { type: "history", input: trimmed });
    const parsedInput = repl.parseSlash(trimmed);
    if (parsedInput.kind === "slash") {
      const cmd = findSlash(parsedInput.name);
      if (cmd) {
        await cmd.run(parsedInput.rest, slashCtx);
        return;
      }
      // A user-defined command file — consulted ONLY after the built-in registry, so a file
      // called `gate.md` can never change what `/gate` does (mirrors the readline host).
      const custom = commandFiles.find((c) => c.file.name === parsedInput.name);
      if (custom) {
        await runCommandFile(custom, parsedInput.rest);
        return;
      }
      await handleSlash(parsedInput.name, parsedInput.rest);
      return;
    }
    // record this session once, on the first real (non-slash) prompt → /recall history.
    if (!sessionRecorded) {
      sessionRecorded = true;
      recordSession(home, {
        id: sessionId,
        ts: new Date().toISOString(),
        descriptor: descriptorOf(trimmed),
        cwd: state.cwd,
      });
    }
    const tokens = trimmed.split(/\s+/);
    if (tokens.length === 1 && tokens[0] && SESSION_VERBS.has(tokens[0])) {
      const outcome: CommandOutcome = await execVerb(tokens, verbCtx);
      if (outcome.text) write(outcome.text);
      state = repl.reduce(state, { type: "message", role: "system", text: `$ ${trimmed}` });
      return;
    }
    await runAgentMessage(trimmed, opts);
  };

  /**
   * What the ACTIVE endpoint would really do with a tier. Recomputed per call because the
   * model can change mid-session (`/model`), and this is precisely the moment the answer
   * flips — `high` on a thinking model, `not available` on the next one.
   */
  // a hoisted declaration: the SlashCtx literal above closes over this before it is reached.
  function effortResolution(tier: ai.EffortTier): ai.EffortResolution | undefined {
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
    // Report what the session will ACTUALLY do, forcing included — `/think` and `/status` must
    // not describe a knob the transport is about to override.
    return ai.resolveEffort(tier, cap, {
      ...(state.tuning.effortForce ? { force: true } : {}),
    });
  }

  const setToolsEnabled = (on: boolean): boolean => {
    state = repl.reduce(state, {
      type: "tune",
      patch: { tools: { ...state.tuning.tools, enabled: on } },
    });
    return on;
  };

  /**
   * The last NON-off tier, so the rail's `think` cell can put back what the user had.
   *
   * Switching thinking off and on again has to be a round trip: dropping the user back on a
   * hard-coded default would quietly demote a `max` session to `medium` every time they glanced
   * at the rail.
   */
  /**
   * Seeded from the tuning the session actually OPENED with, not a literal.
   *
   * `state` still holds the seeded tuning at this point, so this picks up `--effort <tier>`, the
   * tier restored from `effort.json`, and the profile's `[agent] effort` — in that precedence
   * order. A hard-coded `"medium"` knew about none of them, so a `max` operator who pressed ⌃T
   * down and up again came back at `medium`, and `setEffort` now PERSISTS that, ratcheting the
   * demotion into the next session too — exactly what the docblock below says must not happen.
   */
  let lastThinkingTier: ai.EffortTier =
    state.tuning.effort && state.tuning.effort !== "off" ? state.tuning.effort : "medium";

  /**
   * Set the tier the user ASKED for, and remember it for next time.
   *
   * `tier` — never a resolved/clamped value — is what reaches both the tuning and the disk. The
   * clamp is a property of the model bound right now, not of the user's preference, and saving
   * it would ratchet that preference down to whichever model happened to be loaded: one session
   * on a small local model would rewrite a `max` operator to `medium`, permanently.
   */
  const setEffort = (tier: ai.EffortTier): ai.EffortTier => {
    if (tier !== "off") lastThinkingTier = tier;
    state = repl.reduce(state, { type: "tune", patch: { effort: tier } });
    cliProfiles.saveEffort(tier, deps.configHome); // last-set becomes the next-session default
    return tier;
  };

  const stepEffort = (delta: number): ai.EffortTier => {
    const tiers = ai.EFFORT_TIERS;
    const cur = tiers.indexOf(state.tuning.effort ?? "medium");
    const next = Math.max(0, Math.min(tiers.length - 1, (cur < 0 ? 2 : cur) + delta));
    return setEffort(tiers[next] as ai.EffortTier);
  };

  /** Restore the tier thinking was last ON at (the rail's `think` ↑). */
  const resumeThinking = (): ai.EffortTier => setEffort(lastThinkingTier);

  const statusModel = (): StatusModel => {
    const model = state.tuning.model.modelId ?? "";
    const provider = state.tuning.model.provider;
    const source: StatusModel["modelSource"] =
      !model || model === "default" ? "none" : LOCAL_PROVIDERS.has(provider) ? "local" : "cloud";
    // Live context meter (CLI-052): the SAME chars/4 estimate usage() reports, against the SAME
    // model window auto-compact uses (endpoint.contextWindow; undefined ⇒ unknown ⇒ no percent).
    // `estimated:true` — the chars/4 heuristic; only exact provider counts (S029) drop the `~`.
    const chars = history.reduce(
      (n, m) =>
        n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
      0,
    );
    // Live cost ticker (CLI-089): the SAME sessionUsage()/costOf() the `/stats` pull uses (no
    // second pricing path). Set the chip only with real tokens AND a known price (local ⇒ 0 is
    // valid; unknown model ⇒ cost:null ⇒ OMITTED, never a misleading $0.00). Re-derived every
    // render, so it refreshes after every turn without polling.
    const isLocal = endpoint?.locality === "local" || LOCAL_PROVIDERS.has(provider);
    const u = sessionUsage(history, provider, model, isLocal, pricing);
    const cost =
      u.estTokens > 0 && u.cost !== null ? { estTokens: u.estTokens, estUsd: u.cost } : undefined;
    const fleetModel = fleet?.model() ?? undefined;
    return {
      permMode,
      authLevel,
      model,
      modelSource: source,
      tools: state.tuning.tools.enabled,
      gate: state.tuning.gateMode,
      dryRun: state.tuning.dryRun,
      profile: parsed.profile ?? "default",
      cwd: shortCwd(state.cwd),
      agents: subagentCount,
      ctxUsage: {
        used: Math.ceil(chars / 4),
        ...(endpoint?.contextWindow ? { window: endpoint.contextWindow } : {}),
        estimated: true,
      },
      ...(cost ? { cost } : {}),
      // What the runner says this model can DO, shown beside the effort tier in the composer
      // chrome. `thinking` in that list is the precondition for the tier next to it meaning
      // anything at all, so the two belong in one glance rather than on separate chrome.
      ...(endpoint?.probedCapabilities ? { capabilities: endpoint.probedCapabilities } : {}),
      // The other windows on this machine. Absent until the ticker has read the run directory
      // once, and rendered as nothing at all while this is the only instance.
      ...(fleetModel ? { fleet: fleetModel } : {}),
      ...(effortStatus() ?? {}),
    };
  };

  /** The composer-border effort badge input. Omitted entirely when no endpoint is bound yet. */
  const effortStatus = (): Pick<StatusModel, "effort"> | undefined => {
    const tier = state.tuning.effort ?? "medium";
    const res = effortResolution(tier);
    if (!res) return undefined;
    return {
      effort: {
        tier: res.applied ?? tier,
        available: res.applied !== null,
        degraded: res.degraded !== null,
        ...(res.degraded ? { detail: res.degraded.message } : {}),
      },
    };
  };

  /**
   * The one-time legend, shown the first time this user ever sees a second window.
   *
   * Once, ever, and then never again: a legend you have already read is three rows of scrollback
   * you did not ask for. It fires on the CHANGE that first makes the bar appear, so it lands
   * directly above the thing it explains rather than at a startup the user has scrolled past.
   */
  let legendShown = loadSettings(home).fleetLegendSeen === true;
  function maybeShowFleetLegend(): void {
    if (legendShown) return;
    const m = fleet?.model();
    if (!m || m.peers.total <= 1) return;
    legendShown = true;
    write(["", ...fleetLegendLines(deps.caps ?? "none"), ""].join("\n"));
    try {
      saveSettings({ fleetLegendSeen: true }, home);
    } catch {
      /* an unwritable home costs the user a repeat legend, never a crashed session */
    }
  }

  /**
   * Register this window in the fleet and start watching the others.
   *
   * Started here, after the cwd and the model binding exist, because the very first heartbeat
   * should already carry them — a peer that shows up as `—  —` for its first two seconds looks
   * broken in exactly the table a user opened to check whether something is broken.
   */
  fleet = startFleetTicker({
    home,
    id: sessionId,
    cwd: () => state.cwd,
    model: () => state.tuning.model.modelId ?? "",
    onChange: () => {
      maybeShowFleetLegend();
      deps.redraw?.();
    },
    // ACTIVE EVICTION: a Prometheus-managed local model server was force-stopped somewhere —
    // this session's own watchdog, another CLI shell's, or the desktop app's — to prevent a
    // machine-wide freeze. Every live session learns this, not just whichever one was mid-turn
    // against it: `write` puts it straight into the transcript, same as the fleet legend above.
    onEviction: (event) => {
      write(
        `\n⚠ Prometheus stopped ${event.name} to prevent a machine-wide freeze (${event.reason}). Some work may have been interrupted — it will restart automatically once resources are available.\n`,
      );
      deps.redraw?.();
    },
  });

  // The startup banner MUST include the ZEUS titan + PROMETHEUS wordmark — reuse the
  // host's exported `renderBanner` (the single source). NEVER replace it with a
  // backend-only summary (that hid the figure on 2026-06-24). See host.ts banner().
  const banner = (): string => {
    const lines = [renderBanner(state, backendSummary(backends))];
    if (!endpoint) lines.push("", renderOnboarding(backends));
    return lines.join("\n");
  };

  // `prometheus --continue`: resume the newest past session, or honestly start fresh (CLI-013).
  if (deps.continueSession) {
    const newest = [...interactiveSessions(listSessions(home))].sort(
      (a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id),
    )[0];
    if (newest) restoreSession(newest);
    else write("(no past sessions to continue — starting fresh)");
  }

  return {
    slashCtx,
    submit,
    statusModel,
    getPermMode: () => permMode,
    /**
     * Shift-Tab / `/permission-mode`: SESSION-SCOPED, and that is why nothing here touches disk.
     *
     * The fine level still follows the coarse mode in memory, because every approval decision
     * reads `authLevel` and a mode that did not move it would be decoration. But mode→level is
     * lossy, so writing the derived value back to `authorisation.json` destroyed the user's
     * explicit choice: `/authorisation 7` + one Shift-Tab used to persist 2, and a full cycle
     * back to `default` persisted 1.
     */
    setPermMode: (mode) => {
      permMode = mode;
      authLevel = agent.modeToAuthLevel(mode);
    },
    // Both fields, neither derived from the other — see `setPosture`'s doc on the interface.
    setPosture: (mode, level) => {
      permMode = mode;
      authLevel = agent.authLevelMeta(level).level; // clamp 0–7
    },
    getAuthLevel: () => authLevel,
    setAuthLevel: (level, origin) => {
      authLevel = agent.authLevelMeta(level).level; // clamp 0–7
      permMode = agent.authLevelToMode(authLevel); // sync the coarse mode/indicator
      // ONLY an explicit numbered choice becomes the next-session default. Restoring the saved
      // level at startup, a `--authorisation` launch flag and a post-sudo clamp all arrive here
      // as `session` — the startup call used to persist unconditionally, which made every read
      // miss and every safety clamp permanent the moment it happened.
      if (origin === "user") saveAuthLevel(authLevel, deps.configHome);
    },
    banner,
    revertLastEdit,
    toggleTools: () => setToolsEnabled(!state.tuning.tools.enabled),
    setToolsEnabled,
    stepEffort,
    setEffort,
    resumeThinking,
    // the /invoke overlay (CLI-059): catalog rows for the picker + the gated dispatch.
    invokeCatalog: async (): Promise<InvokeItem[]> => {
      const res = await fetchCatalogRows(client, "");
      return res.rows.map((r) => ({
        name: r.name,
        summary: r.summary ?? "",
        presence: presenceOf(r),
      }));
    },
    invokeInstall: async (name: string, args: string): Promise<void> => {
      const res = await fetchCatalogRows(client, "");
      const row = res.rows.find((r) => r.name === name);
      if (!row) {
        write(c.red(`/invoke: "${name}" is not in the catalog`));
        return;
      }
      await dispatchInvoke(row, invokeDeps, args);
    },
    dispose: async (): Promise<void> => {
      // The one path EVERY exit takes — see `teardownFleet` for why the heartbeat removal cannot
      // live in `doQuit` alone.
      await teardownFleet();
      await mcp?.close().catch(() => {});
    },
  };
}
