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
  agent,
  ai,
  cliProfiles,
  loadPricing,
  mcpServer,
  orchestration,
  probeContextWindow,
} from "@prometheus/core";

import {
  createHookRunner,
  loadMemoryIndexBlock,
  loadPermissionRules,
  nodePreviewIo,
} from "@prometheus/core/agent-system-host";
import { type EngineClient, createEngineClient } from "@prometheus/engine-bridge";
import { loadHooksDetailed } from "../session/hooks-config.js";
import { createKeyResolver, keychainProviders } from "../session/key-resolver.js";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { ensureHomeTree, prometheusHome, resolveCategory } from "../home.js";
import { runDemos } from "../orchestration/demos-cmd.js";
import type { ParsedArgs } from "../parse.js";
import { appendPermissionAudit } from "../permission-audit.js";
import { defaultOpenEditor } from "../profile-store.js";
import { c } from "../render.js";
import { loadAgentFiles } from "../session/agent-file-store.js";
import {
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
} from "../session/history-store.js";
import { makeBudgetGuard, banner as renderBanner, seedTuningWithNotes } from "../session/host.js";
import { type McpSession, openMcpSession, withMcpTools } from "../session/mcp-session.js";
import {
  type Backends,
  backendSummary,
  detectBackends,
  renderOnboarding,
  runPathsWizard,
  runSetup,
} from "../session/onboarding.js";
import { DEFAULT_SUBAGENTS, orchestratorNote } from "../session/orchestrator.js";
import { applyRepoMapVerb, makeRepoMapState, repoMapStats } from "../session/repo-map-state.js";
import { maybeStopServicesOnExit } from "../session/service-shutdown.js";
import {
  type SessionCtx as LegacySlashCtx,
  type SlashResult,
  execSlash,
} from "../session/slash-exec.js";
import {
  type HookListing,
  type HookTestOutcome,
  type SlashCtx,
  findSlash,
} from "../session/slash-registry.js";
import { createSteeringController } from "../session/steering.js";
import { execVarsFromEnv } from "../session/system-tools.js";
import { createWorkingSet, isPathAllowed } from "../session/working-set.js";
import { insideTmux } from "../tmux/tmux.js";
import { runUpdates } from "../updates/updates-cmd.js";
import { copyReplyStatus, lastAssistantReply, osc52Sequence } from "./clipboard.js";
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

/** Shorten an absolute path under $HOME to a leading `~`. */
function shortCwd(dir: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  // boundary-checked: `dir === home` or a real child (`home/…`), so a SIBLING like `/home/user-x`
  // (home `/home/user`) is NOT collapsed to a bogus `~-x`.
  if (!home) return dir;
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`)
    ? `~${dir.slice(home.length)}`
    : dir;
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
  /** set the 0–7 authorisation level; also syncs the coarse permMode/indicator. */
  setAuthLevel: (level: number) => void;
  /** the startup banner + onboarding hint block. */
  banner: () => string;
  /** undo the last applied propose_edit; returns the reverted path (or undefined). CLI-010. */
  revertLastEdit: () => string | undefined;
  /** quick-toggle all agent tools (Ctrl+T); returns the new global enabled state. CLI-018. */
  toggleTools: () => boolean;
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
  let state = repl.initialReplState(seeded.tuning, parsed.cwd ?? process.cwd());
  // capture the profile's system prompt BEFORE any /system override → /system reset (CLI-017).
  const systemPromptDefault = state.tuning.systemPrompt;
  let permMode: PermissionModeId = "default";
  // the fine-grained 0–7 autonomy scale (--authorisation). The SOURCE OF TRUTH for allow/ask;
  // permMode is kept synced as the coarse Shift-Tab/indicator companion. Default 1 = ask-for-changes.
  let authLevel: number = agent.DEFAULT_AUTH_LEVEL;
  let history: agent.ThreadMessage[] = [];
  let session: agent.Session | undefined;
  // CLI-072: resume state for `/continue` — a capped turn's full non-system thread (tool results
  // included) is stashed here; `continueCount` shows "resumed N×". Mirrors the host.
  let capturedResume: agent.ThreadMessage[] | null = null;
  let continueCount = 0;
  // /recall session-history (mirrors the host): per-session id + one-time first-prompt record.
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let sessionRecorded = false;

  const backends: Backends =
    deps.backends ??
    (await detectBackends({ client }).catch(() => ({ liveRunners: [], paidClis: [] }) as Backends));
  let endpoint: AiEndpoint | undefined = backends.localEndpoint;
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
    // pre-load the local model NOW (fire-and-forget) so the user's first prompt is warm.
    warmupLocalModel(endpoint);
    // …and ask the runner how big this model's context ACTUALLY is. Every endpoint builder
    // in this repo hard-coded 8192, which on this machine is right for gemma4:12b and wrong
    // by 32x for qwen3.6 (262144). That number is what compaction budgets against, so the
    // assumption made a long run compact a huge-window model as if it were about to
    // overflow. Fire-and-forget and fail-soft: an unreachable runner keeps the floor.
    if (endpoint.locality === "local" && endpoint.model) {
      void probeContextWindow(endpoint.baseUrl, endpoint.model, fetch as never)
        .then((r) => {
          if (r.source !== "default" && r.contextWindow !== endpoint?.contextWindow) {
            endpoint = { ...(endpoint as AiEndpoint), contextWindow: r.contextWindow };
          }
        })
        .catch(() => {
          /* fail-soft: the documented floor stands */
        });
    }
  }

  const orchestrating = insideTmux();
  let subagentCount = orchestrating ? DEFAULT_SUBAGENTS : 1;
  // per-session working set of extra readable dirs (/add-dir, CLI-004).
  const ws = createWorkingSet();
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
    confirm: deps.confirm,
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
   */
  const { hooks: sessionHooks, source: hooksSource } = loadHooksDetailed({ home, cwd: state.cwd });
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

  // Quit hook (CLI-SVC): before tearing down, offer to free local-AI memory (unload the
  // resident Ollama model). Fire-and-forget is safe — `deps.quit()` is what actually exits,
  // so the process stays alive until the prompt resolves; a failure never blocks the exit.
  const doQuit = async (): Promise<void> => {
    try {
      await maybeStopServicesOnExit({ confirm: deps.confirm, write });
    } catch {
      /* never let a shutdown-prompt error trap the user in the session */
    }
    deps.quit();
  };

  // ── per-handler context projectors ──────────────────────────────────────── //

  const verbCtx: VerbCtx = {
    client,
    json: parsed.json,
    ...(parsed.profile ? { profile: parsed.profile } : {}),
    confirm: deps.confirmPhrase,
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
    const ok = await deps.confirm(`apply edit to ${path}?`);
    if (ok) return true;
    const reason = (await deps.ask("reject reason (optional):").catch(() => "")).trim();
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
      const okOut = await deps.confirm(`write file OUTSIDE the working set: ${abs}?`);
      if (okOut) {
        appendPermissionAudit(call.name, call.args, "approved-outside-working-set", home);
        return true;
      }
      const why = (await deps.ask("reject reason (optional):").catch(() => "")).trim();
      return { approved: false, reason: why || "rejected (outside the working set)" };
    }
    const ok = await deps.confirm(`write file ${path}?`);
    if (ok) return true;
    const reason = (await deps.ask("reject reason (optional):").catch(() => "")).trim();
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
      const why = verdict.findings.map((f) => f.where).join("; ") || verdict.verdict;
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
    const approved = await deps.confirm(
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
      const why = verdict.findings.map((f) => f.where).join("; ") || verdict.verdict;
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
    const approved = await deps.confirm("copy this command to your clipboard?");
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
    return deps.confirm(
      previewed ? confirmPrompt(call, state.cwd, scopeRoots()) : `run tool ${call.name}?`,
    );
  };

  // One store per session. `clearOnce` runs after each turn so a `once` grant cannot leak
  // into the next one; `project`/`user` grants are loaded from and written back to disk, so
  // "don't ask again" survives a restart — which is the only reading of those words.
  // The user's `[permissions]` rules — the same loader the readline host and headless use.
  const permissionRules = loadPermissionRules({
    home: deps.configHome,
    cwd: parsed.cwd ?? process.cwd(),
  });
  /** What THIS endpoint has been observed to do about tool calls, across the whole session. */
  let toolCapability = agent.protocol.initialCapability();
  const grants = new agent.ScopedPermissionStore();
  const loadedGrants = loadGrantsInto(grants, deps.configHome);
  // Sub-agent personas, clamped by scope — see the readline host's twin.
  const agentFiles = loadAgentFiles(parsed.cwd ?? process.cwd(), home);
  if (loadedGrants.refused > 0) {
    // The file asked for something the UI would never have accepted — say so rather than
    // dropping it silently, because a hand-edited or hostile grants file is the case that
    // matters here.
    write(`  ! ${loadedGrants.refused} saved grant(s) refused as too broad`);
  }
  // One task list per session. It is agent memory, not a file — cleared when the session ends,
  // never written to the user's repo.
  const todos = new agent.TodoStore();

  const turnCtx = (): TurnCtx => {
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
      json: parsed.json,
      ...(endpoint ? { endpoint } : {}),
      confirm: turnConfirm,
      // The `question` tool's seam — the TUI already has a free-text modal.
      ask: deps.ask,
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
      onTodos: (items) => write(`  ▤ ${agent.todoSummary(items)}`),
      onRemember: (subject, scope) => {
        write(`  ✓ remembered: ${subject} (${scope})`);
        // Written now, not at exit: a session that ends in a crash or a kill would otherwise
        // lose exactly the answer the user took the trouble to give.
        if (scope === "project" || scope === "user") saveGrants(grants, deps.configHome);
      },
      onAutoApprove: (subject) => write(`  ↩ auto-approved from a remembered grant: ${subject}`),
      ...(mcp ? { callMcpTool: (id, tool, args) => mcp.callTool(id, tool, args) } : {}),
      write,
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
    if (orchestrating) {
      const note = orchestratorNote(input, subagentCount);
      if (note) write(`🛸 ${note}`);
    }
    // auto-compact BEFORE the turn when the transcript nears the context budget (CLI-016).
    const policy = autoCompactPolicy(
      COMPACT_THRESHOLD_PCT,
      endpoint?.contextWindow ?? 8192,
      COMPACT_KEEP_RECENT,
    );
    if (session && shouldAutoCompact(session, policy) && policy) {
      const { summarize, offline } = makeSummarizer(turnCtx());
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

  /** CLI-072: fold a turn's cap outcome into resume state (stash on cap, clear on clean end). */
  const settleCap = (res: { capped: boolean; thread: agent.ThreadMessage[] }): void => {
    if (res.capped) {
      capturedResume = res.thread;
      // yolo (run-to-done) auto-resumes the chain itself — don't print the manual "/continue" hint.
      if (!agent.isRunToDoneMode(permMode)) {
        const again = continueCount > 0 ? ` (resumed ${continueCount}×)` : "";
        write(c.dim(`⎿ paused at the step cap — /continue to resume${again}`));
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
    if (!res.capped) continueCount = 0;
    return res;
  };

  /** A stable digest of a round's tool activity — an identical repeat ⇒ no progress (auto-continue halt). */
  const digestOf = (events: readonly agent.AgentEvent[]): string => {
    const parts: string[] = [];
    for (const e of events) {
      if (e.kind === "tool_use") parts.push(`u:${e.call.name}`);
      else if (e.kind === "tool_result") parts.push(`r:${e.call.name}:${e.ok}`);
    }
    return parts.join("|").slice(0, 2000);
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
        progressDigest: digestOf(cur.events),
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
    if (session) session = { ...session, turns: turnsFromRecords(records) };
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

  const runHostSetup = async (): Promise<void> => {
    const r = await runSetup({ client, write, ask: deps.ask, askPath: deps.askPath, home });
    if (r.endpoint) {
      endpoint = r.endpoint;
      process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);
      state = repl.reduce(state, {
        type: "tune",
        patch: { model: { provider: "ollama", modelId: r.endpoint.model ?? "" } },
      });
      // pre-load the just-chosen model so the next prompt is warm.
      warmupLocalModel(endpoint);
    }
  };
  const runHostPaths = async (): Promise<void> => {
    await runPathsWizard({ client, write, ask: deps.ask, askPath: deps.askPath, home });
    process.env.PROMETHEUS_MODELS_DIR = resolveCategory("open_models", home);
  };

  // Shared /invoke deps (CLI-059): the number-pick slash AND the arrow-nav overlay both dispatch
  // through THIS one gated seam, so the nemesis dry-run+confirm sequence is byte-identical.
  const invokeDeps: InvokeDeps = {
    client,
    write,
    ask: deps.ask,
    confirm: deps.confirm,
    install: async (name, opts) => {
      const extra = (opts?.args ?? "").split(/\s+/).filter(Boolean);
      const outcome = await execVerb(
        ["install", name, ...(opts?.yes ? ["--yes"] : []), ...extra],
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
    getAuthLevel: () => authLevel,
    setAuthLevel: (level) => {
      authLevel = agent.authLevelMeta(level).level; // clamp 0–7
      permMode = agent.authLevelToMode(authLevel); // sync the coarse mode/indicator
      saveAuthLevel(authLevel, home); // last-set becomes the next-session default
    },
    /**
     * `/permission-mode` reaches the SAME dial Shift-Tab drives, including the authLevel sync.
     * Two ways to set one posture that disagreed about the companion level would show a
     * "⏸ plan mode on" indicator over an authLevel that still auto-approves edits.
     */
    getPermMode: () => permMode,
    setPermMode: (mode) => {
      permMode = mode;
      authLevel = agent.modeToAuthLevel(mode);
      saveAuthLevel(authLevel, home);
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
    setCwd: (dir) => {
      state = repl.reduce(state, { type: "cwd", dir });
    },
    compact: async (focus) => {
      // manual /compact: summarize everything before the recent tail (force, regardless of size).
      if (!session || session.turns.length <= COMPACT_KEEP_RECENT) {
        write("⎿ nothing to compact yet");
        return;
      }
      const { summarize, offline } = makeSummarizer(turnCtx());
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
    ask: deps.ask,
    confirm: deps.confirm,
    askPath: deps.askPath,
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
        ask: deps.ask,
        confirm: deps.confirm,
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
      const ans = (await deps.ask("recall #: ")).trim();
      const n = Number(ans);
      if (!Number.isInteger(n) || n < 1 || n > records.length) {
        write("(cancelled)");
        return;
      }
      const r = records[n - 1];
      if (r) restoreSession(r);
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
    keymap: loadKeymap(home), // CLI-096: effective keymap for /keys, resolved from [keymap] config
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
      const ok = await deps.confirm(`apply ${intents.length} edit block(s) to disk?`);
      if (!ok) {
        write(c.dim("/apply: cancelled."));
        return;
      }
      const roots = [state.cwd, ...ws.list()];
      for (const o of applyEditIntentsLocal(intents, roots, state.cwd)) {
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
  };

  const legacySlashCtx: LegacySlashCtx = {
    state,
    json: parsed.json,
    write,
    confirm: deps.confirm,
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
    state = repl.reduce(state, { type: "history", input: trimmed });
    const parsedInput = repl.parseSlash(trimmed);
    if (parsedInput.kind === "slash") {
      const cmd = findSlash(parsedInput.name);
      if (cmd) {
        await cmd.run(parsedInput.rest, slashCtx);
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
    const cap = ai.resolveCapability({
      modelId: endpoint.model ?? endpoint.id,
      runtime: ai.runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
      locality: endpoint.locality,
    }).cap;
    return ai.resolveEffort(tier, cap);
  }

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
    setPermMode: (mode) => {
      permMode = mode;
      // keep the fine autonomy level in sync when the user Shift-Tabs the coarse mode,
      // and PERSIST it so the last posture is the default for the next session.
      authLevel = agent.modeToAuthLevel(mode);
      saveAuthLevel(authLevel, home);
    },
    getAuthLevel: () => authLevel,
    setAuthLevel: (level) => {
      authLevel = agent.authLevelMeta(level).level; // clamp 0–7
      permMode = agent.authLevelToMode(authLevel); // sync the coarse mode/indicator
      saveAuthLevel(authLevel, home); // last-set becomes the next-session default
    },
    banner,
    revertLastEdit,
    toggleTools: () => {
      const enabled = !state.tuning.tools.enabled;
      state = repl.reduce(state, {
        type: "tune",
        patch: { tools: { ...state.tuning.tools, enabled } },
      });
      return enabled;
    },
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
      await mcp?.close().catch(() => {});
    },
  };
}
