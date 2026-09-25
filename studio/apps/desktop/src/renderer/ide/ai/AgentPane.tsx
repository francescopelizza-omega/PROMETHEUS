/**
 * ide/ai/AgentPane.tsx — the agent / chat side pane (file 07 §7.2/§7.3/§7.5).
 *
 * The right pane: a conversational agent that reads the workspace, proposes multi-file
 * edits (rendered by DiffReview), and runs tools via CONFIRM-GATED task cards (§7.3) —
 * the agent NEVER types into the user's terminal silently and NEVER bypasses nemesis
 * by shelling out (install/clone commands route through the engine gate). The model
 * picker (top) is sourced from the Model Hub (§7.5): local endpoints first; a
 * per-workspace "never send to cloud" toggle greys cloud endpoints before any request.
 *
 * MULTI-TAB (#): the pane hosts many INDEPENDENT chat sessions. Each tab owns its own
 * transcript + streaming buffer + task cards + busy flag, so a run in one tab is fully
 * independent of another — start a prompt in tab A, switch to tab B and start another,
 * and both stream concurrently into their own session.
 *
 * BACKGROUND RUNS (APP-056): the in-flight state (AbortControllers, paused/pending-command
 * bookkeeping, per-session usage) lives in the MODULE-LEVEL `agentRuns` controller, NOT on
 * this component. So a run keeps progressing (its writes go through lifecycle-free store
 * actions) even with the pane fully UNMOUNTED — leaving the route no longer aborts it. A
 * run ends ONLY on user cancel (■ stop / tab close / turn revert) or a supersede-restart.
 * The tab strip shows a ◍ busy glyph on any tab whose run is live in the background.
 *
 * No model is served in this env, so a real chat cannot run — the pane composes the
 * streaming wiring + task-card discipline correctly and DEGRADES to an honest notice;
 * we never fake an agent turn.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + ai-client + the stores +
 * window.prometheus only.
 */

// PURE subpath ONLY (`@prometheus/core/rules` = node-free logic) — importing the core
// BARREL would eagerly evaluate node:fs modules (providers/policy, ai/providers), which
// Vite externalizes for the browser and THROWS on eval → the whole renderer fails to
// mount (black window). Never import the bare `@prometheus/core` from the renderer (C5).
import { makeCheckpoint, restorePlan, shouldSnapshot } from "@prometheus/core/agent-checkpoint";
import {
  type Session,
  deserializeSession,
  searchSessions,
  serializeSession,
  truncateAfter,
} from "@prometheus/core/agent-session";
import {
  EFFORT_TIERS,
  type EffortTier,
  type TraitCell,
  describeEffort,
  isEffortTier,
  moveTraitFocus,
  traitRail,
} from "@prometheus/core/ai-effort";
import * as rules from "@prometheus/core/rules";
import {
  type ActivityId,
  type AiProviderRow,
  AiProvidersScreen,
  Button,
  type CostWarningConfirm,
  Input,
  Panel,
  SpendMeter,
  Z,
  useAnchoredLayer,
} from "@prometheus/ui";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  LatencyCard,
  type LatencyPhases,
  VerdictCard,
  type VerdictCardFinding,
} from "@prometheus/ui";
import type {
  AgentSystemToolResult,
  GateResult,
  IdeLoadedCommandFile,
  IdeTreeNode,
} from "../../../shared/ipc-contract.js";
import { commandPaletteRows } from "../../commands/registry.js";
import { readStoredOverrides } from "../../settings/keymap-overrides.js";
import { useAuthorisationStore } from "../../stores/authorisation.js";
import { useSecurityStore } from "../../stores/features.js";

import { DEFAULT_COMPACT_IDLE_TIMEOUT_MS } from "@prometheus/core/agent-idle-watchdog";
import { AuthPill } from "../../shell/AuthPill.js";
import { getActiveEditorSelection } from "../EditorPane.js";
import { NOTEBOOK_EDIT_TOOL_NAME, runNotebookTool } from "../notebook/notebook-tool.js";
import { useCodeIndexStore } from "../state/code-index-store.js";

import { type IndexedSymbol, searchSymbols, shortlistFiles } from "../state/code-index.js";
import { fuzzyRank } from "../state/fuzzy.js";
import { useAiSessionStore, useTabsStore } from "../state/stores.js";
import { DiffReview } from "./DiffReview.js";
import { type AgentLoopDeps, createProposeEditTool } from "./agent-loop.js";
import { runChatTurn } from "./ai-client.js";
import { compactTurns } from "./compaction.js";
import { AGENT_PANE_SYSTEM } from "./core-agent.js";

/**
 * Run a `notebook_edit` task card in the renderer and shape it like an `agent:systemTool`
 * result, so the card's own reporting path below needs no second branch.
 */
async function notebookCardResult(
  args: Record<string, unknown>,
): Promise<AgentSystemToolResult | undefined> {
  const out = await runNotebookTool(NOTEBOOK_EDIT_TOOL_NAME, args);
  if (!out) return undefined;
  return {
    ok: out.ok,
    summary: out.summary,
    data: { exitCode: out.ok ? 0 : 1 },
  };
}
import { hasFolderOpen } from "../../../routes/no-folder-guard.js";
import { expandCommandFile, matchCommandFileInvocation } from "./command-files.js";
import { effortFor, useEffortStore } from "./effort-store.js";
import { ensureLocalServerStarted, useActiveEndpoint } from "./endpoint-hook.js";
import {
  type CatalogModelLite,
  contextWindowOf,
  endpointMeta,
  formatContextWindow,
} from "./endpoints.js";
import {
  BUILTIN_SLASH_ROWS,
  type CatInvocation,
  type InInvocation,
  type LsInvocation,
  extractInDirective,
  formatCatTurn,
  formatInTurn,
  formatLsTurn,
  lsTarget,
  matchCatCommand,
  matchInCommand,
  matchLsCommand,
  outputDirNote,
} from "./local-commands.js";
import { Markdown, Verbatim } from "./markdown.js";
import { createMemoryBlock } from "./memory-block.js";
import {
  type ActiveMention,
  type MentionChip,
  type MentionKind,
  addChip,
  capFolderFiles,
  chipsToContext,
  detectActiveMention,
  discoverDocs,
  folderList,
  removeChip,
  replaceMention,
  sliceSymbolRegion,
} from "./mention.js";
import { type RevertStepResult, revertOutcome } from "./revert-outcome.js";
import { agentRuns } from "./run-controller.js";
import { isSafeSessionId, liveToSession, sessionToLive } from "./session-map.js";
import { activeSlashQuery, clampSlashIndex, filterSlashCommands } from "./slash.js";
import { loadSteeringSources } from "./steering-load.js";

/**
 * The heights the composer's floating layers are CLAMPED against (§9.2).
 *
 * Declared, not measured: the clamp decides where the layer will paint, so it has to run
 * before the layer exists. Each value is the `maxHeight` its layer renders with — keep the
 * two in step or a full list will hang past the viewport edge the clamp thought it cleared.
 */
const MENTION_H = 200;
const SLASH_H = 240;
const ENDPOINT_H = 220;
/** The MCP surface, or a stub that refuses honestly when the preload did not expose one. */
function mcpApi(): NonNullable<Window["prometheus"]["mcp"]> {
  const api = typeof window !== "undefined" ? window.prometheus?.mcp : undefined;
  if (api) return api;
  throw new Error("the MCP bridge is unavailable");
}

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Copy text to the clipboard (best-effort; clipboard may be blocked). */
function copyText(text: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
}

const EMPTY_TURNS: never[] = [];
const EMPTY_CARDS: never[] = [];

/** Cap on the @-mention file index (a huge tree can't flood the picker). */
const MENTION_MAX_FILES = 2000;

/** Recursively collect file paths RELATIVE to `root` for the @-mention picker. */
async function collectRelFiles(root: string, dir: string, acc: string[]): Promise<void> {
  if (acc.length >= MENTION_MAX_FILES) return;
  const nodes = ((await ide()?.fsTree(dir)) ?? []) as IdeTreeNode[];
  for (const n of nodes) {
    if (acc.length >= MENTION_MAX_FILES) return;
    if (n.kind === "dir") await collectRelFiles(root, n.path, acc);
    else acc.push(n.path.startsWith(`${root}/`) ? n.path.slice(root.length + 1) : n.path);
  }
}

/** APP-051 snapshot bounds — a per-turn walk must never freeze the send button. */
const SNAPSHOT_MAX_FILES = 800;
const SNAPSHOT_TOTAL_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_POLICY = { maxBytes: 1_000_000 };

/**
 * Walk the workspace via the path-guarded fs IPC → a bounded {relPath: content} map for a
 * checkpoint (APP-051). DEFAULT_IGNORE dirs (.git/node_modules/dist/…) are skipped DURING
 * the walk (never fsRead — perf + secrets), non-text/oversize files are dropped by
 * shouldSnapshot, and the walk stops at the file/byte caps (marked `partial`).
 */
async function snapshotWorkspace(
  root: string,
): Promise<{ files: Record<string, string>; partial: boolean }> {
  const api = typeof window !== "undefined" ? window.prometheus?.ide : undefined;
  const files: Record<string, string> = {};
  let total = 0;
  let partial = false;
  if (!api) return { files, partial: true };
  const rel = (abs: string): string =>
    abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  const walk = async (dir: string): Promise<void> => {
    if (partial) return;
    const nodes = ((await api.fsTree(dir).catch(() => [])) ?? []) as IdeTreeNode[];
    for (const n of nodes) {
      if (partial) return;
      const r = rel(n.path);
      if (n.kind === "dir") {
        // skip ignored dirs BEFORE descending (never fsRead .git/node_modules).
        if (!shouldSnapshot(`${r}/_probe`, "", SNAPSHOT_POLICY)) continue;
        await walk(n.path);
      } else {
        if (Object.keys(files).length >= SNAPSHOT_MAX_FILES) {
          partial = true;
          return;
        }
        const res = await api.fsRead(`file://${n.path}`).catch(() => undefined);
        if (!res?.ok || typeof res.text !== "string") continue;
        if (!shouldSnapshot(r, res.text, SNAPSHOT_POLICY)) continue;
        total += res.text.length;
        if (total > SNAPSHOT_TOTAL_BYTES) {
          partial = true;
          return;
        }
        files[r] = res.text;
      }
    }
  };
  await walk(root);
  return { files, partial };
}

/** APP-052: where durable JSONL session archives live, under the workspace. */
function sessionsDirUri(root: string): string {
  return `file://${root}/.prometheus/sessions`;
}
/** Cap the archive scan so a huge history never stalls the pane mount. */
const SESSIONS_MAX = 500;

/** Write ONE session to its JSONL file (creates the nested dir; fail-soft). */
async function writeSessionFile(session: Session, root: string): Promise<boolean> {
  const api = typeof window !== "undefined" ? window.prometheus?.ide : undefined;
  if (!api || !isSafeSessionId(session.id)) return false;
  // mkdir is non-recursive → build both levels; an already-existing dir (EEXIST) is fine.
  await api.fsMkdir(`file://${root}/.prometheus`).catch(() => undefined);
  await api.fsMkdir(sessionsDirUri(root)).catch(() => undefined);
  const w = await api
    .fsWrite(`${sessionsDirUri(root)}/${session.id}.jsonl`, serializeSession(session))
    .catch(() => undefined);
  return !!w?.ok;
}

/**
 * Enumerate + deserialize all stored sessions under `.prometheus/sessions` (APP-052).
 * Fail-soft: a missing dir, an unsafe filename, or a corrupt/zero-turn file is skipped
 * (never a ghost session). Sorted newest-first by the deserialized `updatedAt`.
 */
async function loadArchivedSessions(root: string): Promise<Session[]> {
  const api = typeof window !== "undefined" ? window.prometheus?.ide : undefined;
  if (!api) return [];
  const dir = sessionsDirUri(root);
  const nodes = ((await api.fsTree(dir).catch(() => [])) ?? []) as IdeTreeNode[];
  const files = nodes
    .filter((n) => n.kind === "file" && n.name.endsWith(".jsonl"))
    .slice(0, SESSIONS_MAX);
  const out: Session[] = [];
  for (const f of files) {
    const id = f.name.replace(/\.jsonl$/, "");
    if (!isSafeSessionId(id)) continue; // a hand-edited id could path-escape — never load it
    const res = await api.fsRead(`file://${f.path}`).catch(() => undefined);
    if (!res?.ok || typeof res.text !== "string") continue;
    const s = deserializeSession(res.text);
    if (s && s.turns.length > 0) out.push(s);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The sessionStorage key Home's ask bar writes its draft into. */
const HOME_PROMPT_KEY = "prometheus.home.prompt";

/** A gate result's findings in the §4 card's shape (array-guarded, fail-soft). */
function chatVerdictFindings(v: GateResult): VerdictCardFinding[] {
  const raw = v.detail?.findings;
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => ({
    rule: f.rule,
    description: f.klass,
    where: f.where,
    severity: f.severity,
  }));
}

/**
 * A card the agent uses to ASK the human something, mid-turn.
 *
 * Why a card and not a modal: the turn is already suspendable this way (the same
 * `proposed`/`awaiting` machinery a command card uses), and a modal would steal focus from
 * whatever the user is doing while the agent works. A question is a message, not an alarm.
 *
 * Skip is a first-class answer, not a cancel: core renders an empty answer as "the user gave
 * no answer, proceed with the most reasonable interpretation and say which one you chose", so
 * dismissing a question never hangs the run.
 */
function QuestionCard(props: {
  id: string;
  prompt: string;
  status: string;
  output: string;
  onAnswer: (id: string, prompt: string, answer: string) => void;
}): ReactElement {
  const { id, prompt, status, output, onAnswer } = props;
  const [text, setText] = useState("");
  const pending = status === "pending";
  return (
    <Panel title={`question · ${status}`} elevation="e1">
      <div style={{ fontSize: "0.78rem", marginBottom: 6, whiteSpace: "pre-wrap" }}>{prompt}</div>
      {pending ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Input
            value={text}
            placeholder="your answer"
            aria-label={prompt}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onAnswer(id, prompt, text.trim());
              }
            }}
          />
          <Button size="sm" variant="primary" onClick={() => onAnswer(id, prompt, text.trim())}>
            answer
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAnswer(id, prompt, "")}>
            skip
          </Button>
        </div>
      ) : (
        <pre style={{ margin: 0, fontSize: "0.7rem", whiteSpace: "pre-wrap" }}>{output}</pre>
      )}
    </Panel>
  );
}

export function AgentPane({
  onNavigate,
  onRunCommand,
}: {
  /** jump to another activity (Model Hub / Chat) from the no-backend CTAs. */
  onNavigate?: (id: ActivityId) => void;
  /** APP-092: run a shell command by id (the composer `/` slash menu). Wired from App.tsx. */
  onRunCommand?: (id: string) => void;
} = {}): ReactElement {
  // shared endpoint resolution (privacy-classified, auto-select first) — see endpoints.ts.
  const { endpoints, active, neverSendToCloud, loaded } = useActiveEndpoint();
  const endpointId = useAiSessionStore((s) => s.endpointId);
  const selectEndpoint = useAiSessionStore((s) => s.selectEndpoint);
  /**
   * Auto-start a previously-served-but-now-stopped local model when chat has no endpoint at all
   * — "it must start automatically when prompting" (the user's own words). Tried ONCE per mount.
   *
   * `loaded` is the real precondition and is not optional. The endpoint list starts EMPTY and is
   * filled by an async effect, so `!active && endpoints.length === 0` is true on the first commit
   * of every mount no matter how many local endpoints exist — the two conditions meant to express
   * "there is no endpoint" were dead, the single attempt was consumed unconditionally, and this
   * spawned a real llama.cpp/vLLM runner on every AgentPane mount. It is not a safe no-op either:
   * with nothing to restart it starts the ollama daemon and reassigns the selected endpoint.
   *
   * The `.catch` is not optional either: `ensureLocalServerStarted` awaits `svc.serving()` /
   * `svc.library()` unguarded, and a rejection would escape `.finally` as an unhandled rejection.
   */
  const autoStartAttempted = useRef(false);
  const [autoStarting, setAutoStarting] = useState(false);
  useEffect(() => {
    if (!loaded || active || endpoints.length > 0 || autoStartAttempted.current) return;
    autoStartAttempted.current = true;
    setAutoStarting(true);
    void ensureLocalServerStarted(selectEndpoint)
      .catch(() => false)
      .finally(() => setAutoStarting(false));
  }, [loaded, active, endpoints.length, selectEndpoint]);
  const setNeverSendToCloud = useAiSessionStore((s) => s.setNeverSendToCloud);
  const replaceTurns = useAiSessionStore((s) => s.replaceTurns);
  const ghostText = useAiSessionStore((s) => s.ghostText);
  const setGhostText = useAiSessionStore((s) => s.setGhostText);

  // ── multi-tab session state ──────────────────────────────────────────────
  const order = useAiSessionStore((s) => s.order);
  const activeId = useAiSessionStore((s) => s.activeId);
  const sessions = useAiSessionStore((s) => s.sessions);
  const activeSession = sessions[activeId];
  const turns = activeSession?.turns ?? EMPTY_TURNS;
  const streaming = activeSession?.streaming ?? "";
  // §9 "reasoning surfacing": the model's thinking and the wrapper's watchdog line. Both
  // are EPHEMERAL (see AiSession.thinking) — rendered live, never appended to `turns`.
  const thinking = activeSession?.thinking ?? "";
  const runStatus = activeSession?.status ?? "";
  const taskCards = activeSession?.taskCards ?? EMPTY_CARDS;
  const busy = activeSession?.busy ?? false;
  const changeSet = activeSession?.changeSet ?? null;
  // anchor for the "edits proposed — review" chip → scrolls the DiffReview into view.

  const pushTurn = useAiSessionStore((s) => s.pushTurn);
  const appendStreaming = useAiSessionStore((s) => s.appendStreaming);
  const commitStreaming = useAiSessionStore((s) => s.commitStreaming);
  const setBusy = useAiSessionStore((s) => s.setBusy);
  const clearTurns = useAiSessionStore((s) => s.clearTurns);
  const addTaskCard = useAiSessionStore((s) => s.addTaskCard);
  const updateTaskCard = useAiSessionStore((s) => s.updateTaskCard);
  const takeCheckpoint = useAiSessionStore((s) => s.takeCheckpoint);
  const getCheckpoint = useAiSessionStore((s) => s.getCheckpoint);
  const revertToTurn = useAiSessionStore((s) => s.revertToTurn);
  const setStatus = useAiSessionStore((s) => s.setStatus);
  const newSession = useAiSessionStore((s) => s.newSession);
  const closeSession = useAiSessionStore((s) => s.closeSession);
  const selectSession = useAiSessionStore((s) => s.selectSession);
  const openSessionTab = useAiSessionStore((s) => s.openSessionTab);

  // ── APP-052: the session browser (disk-archived past chats) ────────────────
  const [showSessions, setShowSessions] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [archived, setArchived] = useState<Session[]>([]);
  // createdAt per session id (first-seen) so persist keeps a stable createdAt while
  // bumping updatedAt each write (newest-first ordering).
  const sessionCreatedRef = useRef<Map<string, string>>(new Map());

  const [input, setInput] = useState("");
  /**
   * `/in` — the session output folder for produced files, or null for the workspace folder.
   *
   * Component state, not the persisted session store: the write approval it rides on is
   * itself session-scoped and cleared when the roots change, so persisting the folder across
   * a reload would show a destination the agent is no longer allowed to write to.
   */
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Task #5 (desktop parity): custom slash commands from markdown — the list itself is
  // populated once `workspaceRoot` is in scope, just below.
  const [customCommands, setCustomCommands] = useState<IdeLoadedCommandFile[]>([]);
  // APP-092: `/` slash-command menu (rows from the shell registry) + the highlighted row.
  // Custom commands are prefixed `custom:` so `acceptSlash` can tell them apart from a shell
  // registry action — picking one fills the composer for the user to type args, rather than
  // executing immediately (a custom command isn't an action, it's a prompt template).
  const commandRows = useMemo(
    () => [
      // local built-ins FIRST (`/ls`): answered here, no model call — see local-commands.ts
      ...BUILTIN_SLASH_ROWS,
      ...commandPaletteRows(undefined, readStoredOverrides()),
      ...customCommands.map((c) => ({
        id: `custom:${c.file.name}`,
        title: `/${c.file.name}${c.file.description ? ` — ${c.file.description}` : ""}`,
        category: c.scope === "project" ? "Custom (project)" : "Custom",
      })),
    ],
    [customCommands],
  );
  const [slashActive, setSlashActive] = useState(0);
  // APP-092: the open-models catalog slice (context window + capability tags) for the picker.
  const [catalog, setCatalog] = useState<CatalogModelLite[]>([]);
  // @-mentions (Cursor parity): a file index + the in-progress mention token.
  const [fileList, setFileList] = useState<string[]>([]);
  // APP-054: the caret-anchored active @-mention (file / sym / folder / docs) + chips.
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const [chips, setChips] = useState<MentionChip[]>([]);
  const composingRef = useRef(false); // IME: suppress the picker while composing

  // ── APP-055: per-session token/cost meter + the AI Providers screen ─────────
  // usage lives in the `agentRuns` controller (survives unmount, APP-056); this tick just
  // re-renders the meter on a controller notification.
  const [, setUsageTick] = useState(0);
  const [showProviders, setShowProviders] = useState(false);
  // §2.5 composer chips: the compact model picker popover + the reasoning-effort tier.
  const [showEndpointPicker, setShowEndpointPicker] = useState(false);
  // §2.3.2: Home's ask bar hands its draft to THIS composer (the rail is always present,
  // so the draft follows the user instead of a route change). Also drains the
  // sessionStorage seed on mount, which covers a cold open straight into the rail.
  useEffect(() => {
    const seed = (text: string): void => {
      if (!text.trim()) return;
      setInput(text);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    try {
      const stored = sessionStorage.getItem(HOME_PROMPT_KEY);
      if (stored) {
        sessionStorage.removeItem(HOME_PROMPT_KEY);
        seed(stored);
      }
    } catch {
      /* sessionStorage blocked — the rail still opens, just unseeded. */
    }
    const onSeed = (e: Event): void => {
      // The home route writes HOME_PROMPT_KEY *and* dispatches this event, so a rail that is
      // already mounted must clear the key here too — otherwise the mount-time read above
      // replays a stale prompt the next time a pane or the chat route mounts.
      try {
        sessionStorage.removeItem(HOME_PROMPT_KEY);
      } catch {
        /* sessionStorage blocked — nothing to clear. */
      }
      seed((e as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("prometheus:seed-agent-prompt", onSeed);
    return () => window.removeEventListener("prometheus:seed-agent-prompt", onSeed);
  }, []);
  const effortTier = useEffortStore((s) => s.tier);
  const setEffortTier = useEffortStore((s) => s.setTier);
  const effortForce = useEffortStore((s) => s.force);
  const hydrateEffort = useEffortStore((s) => s.hydrate);
  /**
   * Adopt the persisted `ai.effort` / `ai.effortForce` settings, once per mount.
   *
   * Both keys were added to the schema with NO reader — validated on write and ignored on
   * read, so a user who set a starting tier in Settings got it silently dropped. (The settings
   * IPC also gates on `findNodeBySchemaKey`, so until they were registered in `SETTINGS_TREE`
   * they could not even be written.) The tier only lands when the user has made no explicit
   * choice on this machine; see `hydrate`.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const api = window.prometheus?.settings;
      if (!api) return;
      const [tier, force] = await Promise.all([
        api.get("ai.effort").catch(() => undefined),
        api.get("ai.effortForce").catch(() => undefined),
      ]);
      if (!alive) return;
      hydrateEffort(
        isEffortTier(tier?.value) ? tier.value : undefined,
        typeof force?.value === "boolean" ? force.value : undefined,
      );
    })();
    return () => {
      alive = false;
    };
  }, [hydrateEffort]);
  const effortResolution = useMemo(
    () => effortFor(effortTier, active, { force: effortForce }),
    [effortTier, active, effortForce],
  );
  /**
   * The model's traits beside the composer: what it can DO (the runner's own capability
   * words) and then the one setting the user can move.
   *
   * Order and grid shape come from core (`ai/effort/traits.ts`) — the SAME functions the CLI's
   * composer strip uses — so the two surfaces cannot drift into presenting the same facts
   * differently. `pills` is the inline rendering; `grid` is non-null only past the point where
   * one line stops fitting the ~330px rail.
   */
  const railCells = useMemo(
    () =>
      traitRail({
        capabilities: active?.probedCapabilities,
        // Studio has no tools switch — it always sends the set — so the cell is an indicator
        // here and core says so out loud rather than offering a control that does nothing.
        toolsEnabled: true,
        toolsSwitchable: false,
        // The APPLIED tier, not the requested one — `max` on a three-level model is served as
        // `high`, and showing the request would be the same misreport the CLI badge was fixed
        // for. With no endpoint bound yet there is nothing to resolve against, so the local
        // setting is reported as-is rather than the dial vanishing from the rail.
        effort:
          effortResolution === undefined
            ? { tier: effortTier, available: true }
            : {
                tier: effortResolution.applied ?? effortTier,
                available: effortResolution.applied !== null,
              },
      }),
    [active, effortResolution, effortTier],
  );

  /** ⌘T (⌃T off macOS) focus over the rail; null = the rail is a readout. */
  const [traitFocus, setTraitFocus] = useState<number | null>(null);
  /** the tier thinking was last ON at, so `think` off→on is a round trip and not a demotion. */
  const lastThinkingTier = useRef<EffortTier>(effortTier === "off" ? "medium" : effortTier);
  useEffect(() => {
    if (effortTier !== "off") lastThinkingTier.current = effortTier;
  }, [effortTier]);

  const adjustTrait = useCallback(
    (cell: TraitCell, delta: 1 | -1) => {
      if (cell.id === "thinking") {
        setEffortTier(delta > 0 ? lastThinkingTier.current : "off");
        return;
      }
      if (cell.id === "effort") {
        const cur = EFFORT_TIERS.indexOf(effortTier);
        const next = Math.max(0, Math.min(EFFORT_TIERS.length - 1, (cur < 0 ? 2 : cur) + delta));
        setEffortTier(EFFORT_TIERS[next] as EffortTier);
      }
    },
    [effortTier, setEffortTier],
  );

  /**
   * The rail's keyboard mode. ⌘T opens it, ←/→ walk it, ↑/↓ throw the focused switch, Esc
   * leaves — the same contract as the terminal's ⌃T, so the gesture transfers between surfaces.
   *
   * Bound at the window because the rail itself is not focusable: the user is typing in the
   * composer when they reach for the chord, and stealing DOM focus to a chip row would cost
   * them their caret. While the mode is open the arrows are captured, which is why it has to be
   * explicitly left rather than lingering.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const chord = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "t";
      if (chord) {
        e.preventDefault();
        setTraitFocus((prev) =>
          prev !== null
            ? null
            : railCells.length === 0
              ? null
              : Math.max(
                  0,
                  railCells.findIndex((c) => c.actionable),
                ),
        );
        return;
      }
      if (traitFocus === null) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setTraitFocus(null);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setTraitFocus((i) => moveTraitFocus(railCells, i ?? 0, e.key === "ArrowLeft" ? -1 : 1));
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const cell = railCells[traitFocus];
        if (cell?.actionable) adjustTrait(cell, e.key === "ArrowUp" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [railCells, traitFocus, adjustTrait]);

  /**
   * The dial's tooltip — the one place the DEGRADATION sentence fits.
   *
   * An emulated tier still shows its tier on the rail: no parameter went out, but a graded
   * instruction did, so the dial genuinely is at that setting. The tooltip is where "by prompt,
   * not by parameter" gets said in full.
   */
  const effortTitle = effortResolution?.degraded
    ? `effort ${effortTier} — ${effortResolution.degraded.message}`
    : `Reasoning effort (applied: ${describeEffort(effortResolution)})`;

  // §3: the last settled run's phase totals for THIS tab. Read from the module-level
  // controller (not local state) so switching tabs shows each tab's own attribution.
  const [runPhases, setRunPhases] = useState<LatencyPhases | undefined>(undefined);
  const lastVerdict = useSecurityStore((st) => st.lastVerdict);
  useEffect(
    () => agentRuns.subscribe(() => setRunPhases(agentRuns.getPhases(activeId))),
    [activeId],
  );
  useEffect(() => setRunPhases(agentRuns.getPhases(activeId)), [activeId]);
  // metered per-provider caps (typed-confirm-gated), persisted (no secrets — just caps).
  const [meteredCaps, setMeteredCaps] = useState<
    Record<string, { capUsd: number; autoDisable: boolean }>
  >(() => {
    try {
      return JSON.parse(window.localStorage.getItem("prometheus.ai.meteredCaps") ?? "{}");
    } catch {
      return {};
    }
  });

  // APP-056: in-flight runs, paused state, proposed cards + usage now live in the
  // MODULE-LEVEL `agentRuns` controller (NOT on this component), so leaving the pane no
  // longer aborts anything — a run keeps writing to the store with zero components mounted,
  // and a returning pane reattaches to the live store state. Abort is user-only (cancel).
  // Re-render this pane on run-status transitions (busy glyph / spend meter / running set).
  useEffect(() => agentRuns.subscribe(() => setUsageTick((t) => t + 1)), []);

  // PROJECT RULES (Cursor/OpenCode/Codex parity): steer the agent with the workspace's
  // AGENTS.md + CLAUDE.md, prepended to the system prompt. The pure precedence-assembler
  // lives in @prometheus/core; here we READ the files (fsRead) and assemble. Loaded once
  // per workspace root into a ref so the async `send` reads the latest without a dep.
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  // Task #5 (desktop parity): (re)discover custom slash commands whenever the workspace root
  // changes — the SAME `@prometheus/core/command-loader` the CLI's `/command` loader uses, run
  // by MAIN (node:fs, C5) and reached over `window.prometheus.ide.commandFilesList`. A command
  // file dropped in mid-session is usable on the very next render, not after a restart.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!workspaceRoot) {
        if (alive) setCustomCommands([]);
        return;
      }
      const r = await ide()?.commandFilesList(workspaceRoot);
      if (alive) setCustomCommands(r?.ok ? r.commands : []);
    })();
    return () => {
      alive = false;
    };
  }, [workspaceRoot]);
  const [rulesInfo, setRulesInfo] = useState<{ order: string[] }>({ order: [] });
  const projectRulesRef = useRef<string>("");
  useEffect(() => {
    let alive = true;
    const root = workspaceRoot;
    projectRulesRef.current = "";
    setRulesInfo({ order: [] });
    if (!root) return;
    void (async () => {
      const api = ide();
      if (!api) return;
      const sources = await loadSteeringSources({
        readProjectFile: async (name) => (await api.fsRead(`file://${root}/${name}`))?.text,
        readGlobal: async () => (await api.steeringGlobal()).sources,
      });
      if (!alive) return;
      const assembled = sources.length > 0 ? rules.assembleRules(sources) : { text: "", order: [] };
      projectRulesRef.current = assembled.text;
      setRulesInfo({ order: assembled.order });
    })();
    return () => {
      alive = false;
    };
  }, [workspaceRoot]);

  // DURABLE CROSS-SESSION MEMORY: the `memory_write`-authored index for this workspace,
  // prepended to the system prompt alongside the AGENTS.md/CLAUDE.md rules above. Same
  // "load once per root into a ref" posture — the async `send` reads the latest without a
  // dep — but reached through `memory_read` over the `agent:systemTool` IPC channel (core owns
  // the fs; the renderer is sandboxed) rather than `fsRead`. `data.count === 0` (nothing ever
  // recorded for this project) is treated the same as "no rules": nothing is injected.
  /**
   * The block is REFRESHED after every turn, not read once per workspace.
   *
   * It used to be loaded once into a ref, so a fact the agent recorded with `memory_write`
   * mid-session stayed invisible for the rest of that session — the model would re-ask something
   * it had just been told to remember, and only an app restart or a workspace switch brought it
   * back. The rule lives in `memory-block.ts` because `.tsx` cannot be unit-tested, which is
   * exactly why this survived.
   */
  const memoryBlockRef = useRef(
    createMemoryBlock({
      read: async () => {
        const api = ide();
        const root = workspaceRootRef.current;
        if (!api || !root) return undefined;
        return await api.systemTool({ name: "memory_read", args: {}, cwd: root });
      },
    }),
  );
  const workspaceRootRef = useRef<string | undefined>(workspaceRoot);
  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
    memoryBlockRef.current.clear();
    if (!workspaceRoot) return;
    void memoryBlockRef.current.refresh();
  }, [workspaceRoot]);

  // index the workspace files for the @-mention picker (one walk per root).
  useEffect(() => {
    let alive = true;
    const root = workspaceRoot;
    setFileList([]);
    if (!root) return;
    void (async () => {
      const acc: string[] = [];
      await collectRelFiles(root, root, acc);
      if (alive) setFileList(acc);
    })();
    return () => {
      alive = false;
    };
  }, [workspaceRoot]);

  // the fuzzy-ranked file suggestions for the in-progress @mention (top 8).
  /** One picker row: kind-aware (file / sym / folder / docs). */
  type Suggestion = {
    key: string;
    label: string;
    kind: MentionKind;
    value: string;
    sym?: IndexedSymbol;
  };

  const mentionMatches = useMemo<Suggestion[]>(() => {
    if (!activeMention) return [];
    const q = activeMention.query;
    if (activeMention.kind === "sym") {
      const idx = useCodeIndexStore.getState().index;
      return searchSymbols(idx, q, 8).map((s) => ({
        key: `${s.uri}:${s.name}:${s.line}`,
        label: s.container ? `${s.name}  ·  ${s.container.split("/").pop()}` : s.name,
        kind: "sym" as const,
        value: `sym:${s.name}`,
        sym: s,
      }));
    }
    if (activeMention.kind === "folder") {
      return fuzzyRank(q, folderList(fileList), (f) => f)
        .slice(0, 8)
        .map((m) => ({
          key: m.item,
          label: m.item,
          kind: "folder" as const,
          value: `folder:${m.item}`,
        }));
    }
    if (activeMention.kind === "docs") {
      return discoverDocs(fileList, q, 8).map((f) => ({
        key: f,
        label: f,
        kind: "docs" as const,
        value: `docs:${f}`,
      }));
    }
    // @file: rank by NAME (fuzzy path) UNION by CONTENT — the repo-wide word index (APP-065)
    // surfaces an UNOPENED file that mentions the query even when its filename doesn't match.
    const byName = fuzzyRank(q, fileList, (f) => f)
      .slice(0, 8)
      .map((m) => m.item);
    const root = workspaceRoot;
    const byContent = root
      ? shortlistFiles(useCodeIndexStore.getState().words, q, 8)
          .map((uri) => uri.replace(/^file:\/\//, "").replace(`${root}/`, ""))
          .filter((rel) => rel.length > 0 && !rel.startsWith("/"))
      : [];
    return [...new Set([...byName, ...byContent])]
      .slice(0, 8)
      .map((f) => ({ key: f, label: f, kind: "file" as const, value: f }));
  }, [activeMention, fileList, workspaceRoot]);

  // caret-anchored detection (APP-054): read selectionStart; suppress during IME compose.
  const onInput = useCallback((v: string) => {
    setInput(v);
    if (composingRef.current) return;
    const caret = inputRef.current?.selectionStart ?? v.length;
    setActiveMention(detectActiveMention(v, caret));
    setMentionActive(0);
    setSlashActive(0);
    // APP-092: auto-grow the composer textarea to fit (capped by max-height + scroll).
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  // APP-092: the active `/` slash query + the filtered command rows (the composer popup).
  const slashQuery = activeSlashQuery(input);
  const slashMatches = useMemo(
    () => (slashQuery !== null ? filterSlashCommands(commandRows, slashQuery) : []),
    [slashQuery, commandRows],
  );
  /* ── §9.2 "the rail cage": the composer's floating layers are PORTALED ────────
   *
   * These three pickers used to be `position: absolute` children of the composer. That
   * anchors them inside the right rail — a 330px column whose island root is
   * `overflow: hidden` — so a completion list could never be wider than the rail and was
   * clipped at its edges. Portaling to document.body as `position: fixed`, with
   * viewport-space coordinates from `useAnchoredLayer`, takes them out of the cage; the
   * clamp inside that hook is what keeps them on screen once they are free to leave it.
   *
   * Heights are declared here (not measured) because the clamp has to decide where to
   * paint BEFORE the layer paints. They match the `maxHeight` each layer renders with.
   */
  const composerRef = useRef<HTMLDivElement | null>(null);
  const chipRowRef = useRef<HTMLDivElement | null>(null);
  const mentionBox = useAnchoredLayer(
    composerRef,
    activeMention !== null && mentionMatches.length > 0,
    { width: "anchor-min", maxWidth: 460, height: MENTION_H },
  );
  const noSymbolsBox = useAnchoredLayer(
    composerRef,
    activeMention?.kind === "sym" && mentionMatches.length === 0,
    { width: 320, height: 26 },
  );
  const slashBox = useAnchoredLayer(composerRef, slashQuery !== null && slashMatches.length > 0, {
    width: "anchor-min",
    maxWidth: 460,
    height: SLASH_H,
  });
  const endpointBox = useAnchoredLayer(chipRowRef, showEndpointPicker, {
    width: 300,
    height: ENDPOINT_H,
  });

  /**
   * `/ls` — answered LOCALLY, no model call: the files in the folder the agent works in, the
   * same check the terminal TUI's `/ls` gives, so the user can confirm Prometheus is on the
   * right project. Posted as a LOCAL turn: shown here, never sent to the model, never archived.
   */
  const runLocalLs = useCallback(
    async (inv: LsInvocation | { error: string }): Promise<void> => {
      const sid = activeId;
      if ("error" in inv) {
        pushTurn(sid, { role: "assistant", content: `**/ls** — ${inv.error}`, local: true });
        return;
      }
      const root = useTabsStore.getState().workspaceRoot;
      const folderOpen = hasFolderOpen(root);
      // The same fallback the agent itself uses (`workspaceRoot || "."`), so /ls shows exactly
      // the folder a tool call would run in.
      const dir = lsTarget(folderOpen && root ? root : ".", inv.path);
      let nodes: Awaited<ReturnType<Window["prometheus"]["ide"]["fsTree"]>> = [];
      try {
        nodes = (await ide()?.fsTree(dir)) ?? [];
      } catch {
        /* an IPC failure reads as "(empty, or not readable)", never as a crash */
      }
      pushTurn(sid, {
        role: "assistant",
        content: formatLsTurn({ dir, nodes, all: inv.all, folderOpen }),
        local: true,
      });
    },
    [activeId, pushTurn],
  );

  /**
   * `/cat <file>` — answered LOCALLY, the pane's twin of the terminal's `/cat`. The turn is
   * posted with `pre: true` so the file renders VERBATIM: file text is data, and a markdown
   * pass over it would mangle any file that contains a fence (see local-commands.ts).
   */
  const runLocalCat = useCallback(
    async (inv: CatInvocation | { error: string }): Promise<void> => {
      const sid = activeId;
      if ("error" in inv) {
        pushTurn(sid, { role: "assistant", content: `**/cat** — ${inv.error}`, local: true });
        return;
      }
      const root = useTabsStore.getState().workspaceRoot;
      // lsTarget resolves a sub-path against the workspace folder exactly as /ls does, so both
      // commands agree on what a relative path means.
      const path = lsTarget(hasFolderOpen(root) && root ? root : ".", inv.path);
      let read: Awaited<ReturnType<Window["prometheus"]["ide"]["fsRead"]>> = {
        ok: false,
        error: "the IDE bridge is unavailable",
      };
      try {
        read = (await ide()?.fsRead(path)) ?? read;
      } catch (e) {
        read = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      pushTurn(sid, {
        role: "assistant",
        content: formatCatTurn({ path, read, all: inv.all }),
        local: true,
        pre: read.ok,
      });
    },
    [activeId, pushTurn],
  );

  /**
   * `/in <folder>` — where produced files go (downloads, conversions), the pane's twin of the
   * terminal's `/in`.
   *
   * Setting it APPROVES that folder for writing via `approveOutsideWorkingSet(path,"session")`.
   * That call is the sanctioned way to widen the agent's write scope — one explicit path,
   * cleared when the roots change — and it is legitimate here precisely because the human typed
   * the path into the composer. `ide:workingSet.set` deliberately cannot do this.
   */
  const runLocalIn = useCallback(
    async (inv: InInvocation): Promise<void> => {
      const sid = activeId;
      const root = useTabsStore.getState().workspaceRoot || ".";
      if ("error" in inv) {
        pushTurn(sid, { role: "assistant", content: `**/in** — ${inv.error}`, local: true });
        return;
      }
      if (inv.action === "show") {
        pushTurn(sid, { role: "assistant", content: formatInTurn(outputDir, root), local: true });
        return;
      }
      if (inv.action === "clear") {
        setOutputDir(null);
        pushTurn(sid, {
          role: "assistant",
          content: `**/in** — cleared. Produced files go to \`${root}\`.`,
          local: true,
        });
        return;
      }
      const dir = lsTarget(root, inv.path);
      const res = await ide()
        ?.approveOutsideWorkingSet(dir, "session")
        .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      if (!res?.ok) {
        pushTurn(sid, {
          role: "assistant",
          content: `**/in** — ${res?.error ?? "could not approve that folder"}`,
          local: true,
        });
        return;
      }
      setOutputDir(dir);
      pushTurn(sid, { role: "assistant", content: formatInTurn(dir, root), local: true });
    },
    [activeId, pushTurn, outputDir],
  );

  const acceptSlash = useCallback(
    (id: string) => {
      if (id === "builtin:ls") {
        setInput("");
        setSlashActive(0);
        void runLocalLs({ path: "", all: false });
        return;
      }
      // `/cat` needs a filename, so picking it from the popup FILLS the composer rather than
      // running — the same rule custom commands follow a few lines down.
      if (id === "builtin:cat") {
        setInput("/cat ");
        setSlashActive(0);
        return;
      }
      if (id === "builtin:in") {
        setInput("/in ");
        setSlashActive(0);
        return;
      }
      // Task #5 (desktop parity): a custom command isn't an action to RUN, it's a prompt
      // template — fill the composer with `/name ` so the user types args and Enter sends it
      // (send() below does the actual expansion), instead of executing + clearing like a
      // shell-registry command.
      if (id.startsWith("custom:")) {
        const name = id.slice("custom:".length);
        setInput(`/${name} `);
        setSlashActive(0);
        inputRef.current?.focus();
        return;
      }
      onRunCommand?.(id);
      setInput("");
      setSlashActive(0);
      const el = inputRef.current;
      if (el) el.style.height = "auto";
    },
    [onRunCommand, runLocalLs],
  );

  // APP-092: Cmd/Ctrl-L "attach selection" → read the active editor selection and add a
  // removable file:line context chip (the block is included in the sent prompt via chips).
  useEffect(() => {
    const onAttach = (): void => {
      const sel = getActiveEditorSelection();
      if (!sel || !sel.selectedText.trim()) return;
      const rel =
        sel.uri
          .replace(/^file:\/\//, "")
          .split("/")
          .pop() ?? sel.uri;
      const range =
        sel.startLine === sel.endLine ? `${sel.startLine}` : `${sel.startLine}-${sel.endLine}`;
      const label = `${rel}:${range}`;
      const chip: MentionChip = {
        id: `sel:${sel.uri}:${sel.startLine}-${sel.endLine}`,
        kind: "file",
        label,
        block: `### ${label}\n\n\`\`\`\n${sel.selectedText}\n\`\`\``,
      };
      setChips((cur) => addChip(cur, chip));
    };
    window.addEventListener("ide:attach-selection", onAttach);
    return () => window.removeEventListener("ide:attach-selection", onAttach);
  }, []);

  // APP-092: load the open-models catalog slice (context window + capability tags) once so
  // the model picker can badge each endpoint. Fail-soft — the picker degrades to id + local/cloud.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const models = typeof window !== "undefined" ? window.prometheus?.models : undefined;
      const res = await models?.search?.({}).catch(() => undefined);
      if (!alive || !res?.ok || !Array.isArray(res.models)) return;
      const lite: CatalogModelLite[] = res.models
        .map((m: unknown) => {
          const row = m as Record<string, unknown>;
          const item: CatalogModelLite = { id: String(row.id ?? "") };
          if (typeof row.family === "string") item.family = row.family;
          if (typeof row.contextLen === "number") item.contextLen = row.contextLen;
          if (Array.isArray(row.tags))
            item.tags = (row.tags as unknown[]).filter((t): t is string => typeof t === "string");
          return item;
        })
        .filter((m) => m.id);
      setCatalog(lite);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Complete a mention. A FILE stays INLINE (bare `@relpath`, resolved at send — the
   * existing behaviour is untouched); sym/folder/docs RESOLVE their context now and add a
   * removable CHIP, then drop the token from the input.
   */
  const completeMention = useCallback(
    async (s: Suggestion): Promise<void> => {
      const am = activeMention;
      if (!am) return;
      if (s.kind === "file") {
        setInput((cur) => `${replaceMention(cur, am, `@${s.value}`)} `);
        setActiveMention(null);
        inputRef.current?.focus();
        return;
      }
      // strip the in-progress token first (the chip carries the context now).
      setInput((cur) => replaceMention(cur, am, ""));
      setActiveMention(null);
      const api = ide();
      const root = useTabsStore.getState().workspaceRoot || ".";
      let block: string | null = null;
      let label = s.label;
      let id = s.value;
      if (s.kind === "sym" && s.sym) {
        const uri = s.sym.uri.startsWith("file://") ? s.sym.uri : `file://${s.sym.uri}`;
        const r = await api?.fsRead(uri).catch(() => undefined);
        if (r?.ok && typeof r.text === "string") {
          const region = sliceSymbolRegion(r.text, s.sym.line + 1); // index line is 0-based
          const rel = s.sym.container || uri;
          label = `sym ${s.sym.name}`;
          id = `sym:${rel}:${s.sym.name}`;
          block = `### @sym ${s.sym.name} (${rel})\n\n\`\`\`\n${region}\n\`\`\``;
        }
      } else if (s.kind === "docs") {
        const rel = s.value.slice("docs:".length);
        const r = await api?.fsRead(`file://${root}/${rel}`).catch(() => undefined);
        if (r?.ok && typeof r.text === "string") {
          const body = r.text.length > 12000 ? `${r.text.slice(0, 12000)}\n…(truncated)` : r.text;
          label = `docs ${rel.split("/").pop()}`;
          id = `docs:${rel}`;
          block = `### @docs ${rel}\n\n${body}`;
        }
      } else if (s.kind === "folder") {
        const rel = s.value.slice("folder:".length);
        const inFolder = fileList.filter((f) => f === rel || f.startsWith(`${rel}/`));
        const read: { path: string; text: string }[] = [];
        for (const f of inFolder.slice(0, 60)) {
          const r = await api?.fsRead(`file://${root}/${f}`).catch(() => undefined);
          if (r?.ok && typeof r.text === "string") read.push({ path: f, text: r.text });
          if (read.length >= 20) break;
        }
        const { kept, truncated } = capFolderFiles(read);
        label = `folder ${rel.split("/").pop()}`;
        id = `folder:${rel}`;
        const parts = kept.map((k) => `#### ${k.path}\n\n\`\`\`\n${k.text}\n\`\`\``);
        block = `### @folder ${rel}${truncated ? " (truncated to cap)" : ""}\n\n${parts.join("\n\n")}`;
      }
      if (block) setChips((cur) => addChip(cur, { id, kind: s.kind, label, block }));
      inputRef.current?.focus();
    },
    [activeMention, fileList],
  );

  // APP-056: the loop lifecycle (settle/pause-stash/resume) + per-command result routing
  // now live in the MODULE-LEVEL `agentRuns` controller so a run + its resume survive pane
  // unmount. The task cards call `agentRuns.agentRuns.resolveCommand(sid, cardId, result)` directly.

  /** APP-052: serialize the live tab to `<ws>/.prometheus/sessions/<id>.jsonl` (fail-soft). */
  const persistSession = useCallback(async (sid: string): Promise<void> => {
    const api = ide();
    if (!api || !isSafeSessionId(sid)) return;
    const s = useAiSessionStore.getState().sessions[sid];
    if (!s || s.turns.length === 0) return;
    const root = useTabsStore.getState().workspaceRoot || ".";
    const now = new Date().toISOString();
    const createdAt = sessionCreatedRef.current.get(sid) ?? now;
    sessionCreatedRef.current.set(sid, createdAt);
    const session = liveToSession(
      { id: sid, title: s.title, workspacePath: root, createdAt, updatedAt: now },
      s.turns,
    );
    if (await writeSessionFile(session, root)) {
      setArchived((prev) => [session, ...prev.filter((p) => p.id !== sid)]);
    }
  }, []);

  /** Resume a stored session → open its transcript as a live tab (id preserved). */
  const resumeArchived = useCallback(
    (session: Session): void => {
      sessionCreatedRef.current.set(session.id, session.createdAt || new Date().toISOString());
      openSessionTab({ id: session.id, title: session.title, turns: sessionToLive(session) });
      setShowSessions(false);
    },
    [openSessionTab],
  );

  /** Fork the active chat from a user turn → a NEW session (turns 1..N); original untouched. */
  const forkFrom = useCallback(
    async (liveIndex: number): Promise<void> => {
      const sid = activeId;
      const s = useAiSessionStore.getState().sessions[sid];
      if (!s) return;
      const root = useTabsStore.getState().workspaceRoot || ".";
      const now = new Date().toISOString();
      // Kth user turn = how many user turns up to & including the clicked one.
      const k = s.turns.slice(0, liveIndex + 1).filter((t) => t.role === "user").length;
      const full = liveToSession(
        { id: sid, title: s.title, workspacePath: root, createdAt: now, updatedAt: now },
        s.turns,
      );
      const truncated = truncateAfter(full, k, now); // pure copy — original untouched
      const forkId = crypto.randomUUID();
      const forkTitle = `${s.title} (fork @turn ${k})`;
      const forked: Session = {
        ...truncated,
        id: forkId,
        title: forkTitle,
        createdAt: now,
        updatedAt: now,
      };
      // write the branch to disk BEFORE opening the tab so a crash can't lose it.
      sessionCreatedRef.current.set(forkId, now);
      await writeSessionFile(forked, root);
      setArchived((prev) => [forked, ...prev]);
      openSessionTab({ id: forkId, title: forkTitle, turns: sessionToLive(forked) });
    },
    [activeId, openSessionTab],
  );

  const send = useCallback(async () => {
    const sid = activeId;
    const store = useAiSessionStore.getState();
    // `/ls [path] [-a]` typed out (or with the popup closed) is answered locally, before any
    // model gating: it needs no endpoint and never becomes a prompt.
    const ls = matchLsCommand(input);
    if (ls && !store.sessions[sid]?.busy) {
      setInput("");
      void runLocalLs(ls);
      return;
    }
    // `/cat <file>` likewise: no endpoint needed, never becomes a prompt.
    const cat = matchCatCommand(input);
    if (cat && !store.sessions[sid]?.busy) {
      setInput("");
      void runLocalCat(cat);
      return;
    }
    // `/in [folder]` on its own line: a local setting, never a prompt.
    const inCmd = matchInCommand(input);
    if (inCmd && !store.sessions[sid]?.busy) {
      setInput("");
      void runLocalIn(inCmd);
      return;
    }
    if (!active || !input.trim() || store.sessions[sid]?.busy) return;
    let text = input.trim();
    // `/in <folder>` INLINE — "download this video … and save it /in ~/Downloads". Pulled out
    // of the message, approved for writing, and replaced by a plain statement of where to write,
    // exactly as the terminal hosts do (apps/cli/src/session/in.ts `applyInDirective`).
    // Read into a LOCAL: `setOutputDir` below does not land before this turn is assembled, so
    // an inline `/in` would not reach the model on the very turn that asked for it.
    let turnOutputDir = outputDir;
    {
      const { prompt, dir } = extractInDirective(text);
      if (dir !== null) {
        text = prompt;
        const abs = lsTarget(useTabsStore.getState().workspaceRoot || ".", dir);
        const res = await ide()
          ?.approveOutsideWorkingSet(abs, "session")
          .catch(() => ({ ok: false }));
        if (res?.ok) {
          turnOutputDir = abs;
          setOutputDir(abs);
        } else {
          // Reported, never silent: the turn still runs and the files land in the workspace
          // folder, which is far better than writing somewhere the user did not expect.
          pushTurn(sid, {
            role: "assistant",
            content: `**/in** — could not use \`${abs}\`; using the workspace folder.`,
            local: true,
          });
        }
      }
    }
    // Task #5 (desktop parity): a typed `/name args…` that matches a loaded custom command
    // EXPANDS into the prompt the agent receives — the same `@file`/`!cmd` resolution + LAST
    // argument substitution as the CLI's `/name`. Expansion happens here (send time), not at
    // popup-pick time, so the user can type args after the name exactly as in the terminal.
    const invocation = matchCommandFileInvocation(text, customCommands);
    if (invocation) {
      const expandRoot = useTabsStore.getState().workspaceRoot;
      const expanded = await expandCommandFile(invocation.cmd, invocation.args, {
        readFile: async (rel) => {
          const uri = rel.startsWith("file://") ? rel : `file://${expandRoot ?? "."}/${rel}`;
          const r = await ide()?.fsRead(uri);
          if (!r?.ok || r.text === undefined) throw new Error(r?.error ?? "could not read file");
          return r.text;
        },
        // See command-files.ts's module doc: desktop has no pre-send confirm dialog yet, so a
        // `!`cmd`` injection always refuses (visibly, via the refusal marker) rather than
        // either running ungated or faking a gate.
        runShell: async () => null,
      });
      text = expanded.prompt;
    }
    // Tell the model where to write. Appended to the USER message, not injected as a preamble:
    // it costs tokens only on turns that actually have an output folder, and it stays visible in
    // the transcript so a later reader can see why a file landed where it did.
    if (turnOutputDir) text = `${text}\n\n${outputDirNote(turnOutputDir)}`;
    setInput("");
    setActiveMention(null);
    // capture the prior transcript BEFORE we append the new user turn (so the message
    // list carries the new prompt exactly once).
    const allTurns = store.sessions[sid]?.turns ?? [];
    // LOCAL turns (`/ls` output) are the user's own view, never model context.
    const priorTurns = allTurns.filter((t) => !t.local);
    // APP-051: snapshot the workspace BEFORE this turn runs → a per-turn revert point.
    // Bounded walk (skip-and-warn, never blocks); the checkpoint id rides on the user turn.
    const root0 = useTabsStore.getState().workspaceRoot || ".";
    const turnNumber = allTurns.length;
    let checkpointId: string | undefined;
    try {
      const snap = await snapshotWorkspace(root0);
      checkpointId = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      takeCheckpoint(
        sid,
        makeCheckpoint(
          checkpointId,
          sid,
          turnNumber,
          new Date().toISOString(),
          snap.files,
          SNAPSHOT_POLICY,
        ),
      );
    } catch {
      checkpointId = undefined; // a failed snapshot must never block the turn
    }
    pushTurn(sid, { role: "user", content: text, ...(checkpointId ? { checkpointId } : {}) });
    const root = useTabsStore.getState().workspaceRoot || ".";
    // propose_edit → the §7.4 review pipeline. The OWNING session id (sid) is captured
    // HERE — a background tab's edits must land in ITS session, not whichever tab is
    // active when the tool returns. Nothing here writes disk (fsRead only); the sole
    // write path stays the user-approved Apply in DiffReview.
    const proposeEdit = createProposeEditTool({
      changeSetId: `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      toUri: (rel) => `file://${root}/${rel}`,
      readOriginal: async (uri) => {
        const r = await ide()?.fsRead(uri);
        return r?.ok && typeof r.text === "string" ? r.text : null;
      },
      dispatch: (cs) => useAiSessionStore.getState().proposeChangeSet(cs, sid),
      // lets the tool DROP its accumulated entries once the user Applied/Discarded
      // them mid-run — re-dispatching them would resurrect stale-anchored hunks.
      currentChangeSetId: () => useAiSessionStore.getState().sessions[sid]?.changeSet?.id ?? null,
    });
    // the agent's tools: read/list are auto + read-only; propose_edit stages a review
    // ChangeSet (never writes); run_command becomes a gated task card (executed only
    // on the user's Run click via the screened ide.exec).
    const tools = {
      readFile: async (p: string): Promise<string> => {
        const abs = p.startsWith("/") || p.startsWith("file://") ? p : `${root}/${p}`;
        const uri = abs.startsWith("file://") ? abs : `file://${abs}`;
        const r = await ide()?.fsRead(uri);
        if (!r?.ok || r.text === undefined)
          return `(could not read ${p}: ${r?.error ?? "no result"})`;
        return r.text.length > 8000 ? `${r.text.slice(0, 8000)}\n…(truncated)` : r.text;
      },
      listDir: async (p: string): Promise<string> => {
        const dir = p === "" || p === "." ? root : p.startsWith("/") ? p : `${root}/${p}`;
        const nodes = ((await ide()?.fsTree(dir)) ?? []) as IdeTreeNode[];
        return (
          nodes.map((n) => `${n.kind === "dir" ? "d" : "-"} ${n.name}`).join("\n") || "(empty)"
        );
      },
      grep: async (query: string): Promise<string> => {
        const r = await ide()?.search({ root, query, mode: "content", maxResults: 50 });
        if (!r?.ok) return `(search failed: ${r?.error ?? "no result"})`;
        if (r.matches.length === 0) return "(no matches)";
        const lines = r.matches.map((m) => `${m.rel}${m.line ? `:${m.line}` : ""}`);
        return `${lines.join("\n")}${r.truncated ? "\n…(truncated)" : ""}`;
      },
      proposeEdit,
      proposeCommand: (command: string, tool?: string, args?: Record<string, unknown>): string => {
        const cardId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        addTaskCard(sid, {
          id: cardId,
          command,
          cwd: root,
          status: "pending",
          output: "",
          ...(tool ? { tool } : {}),
          ...(args ? { args } : {}),
        });
        // register the card so the controller can find it: core's `confirm` suspends the
        // turn on THIS card's id and `resolveCommand(sid, cardId, …)` releases it (§9c).
        agentRuns.recordProposed(sid, { id: cardId, command });
        return `proposed command (approve below to run): ${command}`;
      },
      // The agent asking the human something. A card rather than a modal: the turn is already
      // suspendable this way, and a modal would steal focus from whatever the user is doing
      // while the agent works.
      askQuestion: (prompt: string): void => {
        const cardId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        addTaskCard(sid, {
          id: cardId,
          command: prompt,
          cwd: root,
          status: "pending",
          output: "",
          kind: "question",
        });
        agentRuns.recordProposed(sid, { id: cardId, command: prompt });
      },
    };
    // @-mentions: resolve any `@relpath` tokens to their file contents and attach them
    // as a context block on the user message (the displayed turn keeps the raw @mention).
    let userContent = text;
    const mentions = [...text.matchAll(/@(\S+)/g)].map((m) => m[1]);
    const unique = [...new Set(mentions)].filter(Boolean);
    // APP-053: `@codebase` attaches the ranked repo-map (budget-trimmed) as context.
    const wantsCodebase = unique.includes("codebase");
    const uniqueMentions = unique.filter((m) => m !== "codebase").slice(0, 8);
    const blocks: string[] = [];
    if (wantsCodebase) {
      const map = await ide()
        ?.repoMap.build({ root, budget: 6000, query: text })
        .catch(() => undefined);
      if (map?.ok && map.files.length) {
        const lines = map.files
          .flatMap((f) => f.symbols.map((s) => ({ path: f.path, ...s })))
          .sort((a, b) => b.rank - a.rank)
          .map((s) => `${s.path}:${s.line} ${s.kind} ${s.name}`);
        blocks.push(
          `### @codebase (ranked symbol map${map.truncated ? ", trimmed to budget" : ""})\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``,
        );
      }
    }
    for (const rel of uniqueMentions) {
      const r = await ide()?.fsRead(`file://${root}/${rel}`);
      if (r?.ok && typeof r.text === "string") {
        const body = r.text.length > 8000 ? `${r.text.slice(0, 8000)}\n…(truncated)` : r.text;
        blocks.push(`### @${rel}\n\n\`\`\`\n${body}\n\`\`\``);
      }
    }
    // APP-054: attach the resolved mention CHIPS (sym/folder/docs), then clear them.
    const chipContext = chipsToContext(chips);
    if (chipContext) blocks.push(chipContext);
    setChips([]);
    if (blocks.length > 0) {
      userContent = `${text}\n\n---\nReferenced context:\n\n${blocks.join("\n\n")}`;
    }
    // prepend the workspace AGENTS.md/CLAUDE.md rules (if any), then durable memory (if any),
    // to the system prompt — same order as the CLI (steering, then memory).
    const projectRules = projectRulesRef.current;
    const memoryBlock = memoryBlockRef.current.current();
    const systemContent = [AGENT_PANE_SYSTEM, projectRules, memoryBlock]
      .filter((s) => s.trim() !== "")
      .join("\n\n");
    // Deps carry NO signal — the controller mints the AbortController in `start` and injects
    // it, so the run + its abort live in the module controller (survive pane unmount, 056).
    const deps: Omit<AgentLoopDeps, "signal"> = {
      // The context window the picker already derives from the open-models catalogue rides
      // along, because it SIZES THE TOOL PREAMBLE. Without it the preamble is budgeted for an
      // 8192 window and the degrade ladder drops every tool description — the part that tells
      // the model which tool to reach for. The picker has shown this number in the UI all
      // along; it just never reached the turn.
      endpoint: { ...active, ...contextWindowOf(active, catalog) },
      neverSendToCloud,
      tools,
      /**
       * The bridge to core's tools in main — and the workspace they run against.
       *
       * These were never passed. `AgentLoopDeps.ide` and `.root` are optional (so a headless
       * harness degrades instead of throwing), and the pane simply never filled them in, so
       * `systemTool` resolved to undefined and every tool the broker AUTO-approved — which at
       * A1 "read freely" is every read — came back `"read_file" is unavailable in this
       * environment`. The only tools that worked were the ones a human clicked Run on, because
       * the task card calls `ide()` directly. A whole tool tier was dark, and nothing failed
       * loudly enough to say so.
       */
      root,
      ide: {
        systemTool: (req) =>
          ide()?.systemTool(req) ??
          Promise.resolve({ ok: false, summary: "the editor bridge is unavailable" }),
        engineTool: (req) =>
          ide()?.engineTool(req) ??
          Promise.resolve({ ok: false, summary: "the engine bridge is unavailable" }),
        // Task #5 (desktop parity): sub-agent personas from markdown for `spawn_agent`, the
        // SAME `@prometheus/core/agent-files` clamping the CLI applies.
        agentFilesList: (r) =>
          ide()?.agentFilesList(r) ??
          Promise.resolve({ ok: false, personas: [], error: "the editor bridge is unavailable" }),
        // Lifecycle hooks: the pane lists them and proxies each run; MAIN is the only thing
        // that spawns (the renderer cannot, by C5, and must not decide what may run).
        hookRun: (req) =>
          ide()?.hookRun(req) ??
          Promise.resolve({ ok: false, error: "the editor bridge is unavailable" }),
        // Point 6b: MAIN owns the canary audit disk; the renderer only forwards the trip.
        canaryTrip: (req) => ide()?.canaryTrip(req) ?? Promise.resolve({ ok: false }),
      },
      // The MCP surface is a separate main-side module with its own manager, so it is a
      // separate seam: the pane reads the descriptors per turn and calls one tool at a time.
      ...(typeof window !== "undefined" && window.prometheus?.mcp
        ? {
            mcp: {
              agentTools: () => mcpApi().agentTools(),
              agentCall: (req) => mcpApi().agentCall(req),
            },
          }
        : {}),
      // handoff §2.5: the composer's effort chip is load-bearing — resolve the requested
      // tier against THIS endpoint's real capability and forward the patch to every turn.
      // A model with no reasoning control resolves to `applied: null` and nothing is sent.
      ...(() => {
        const e = effortFor(effortTier, active, { force: effortForce });
        return e ? { effort: e } : {};
      })(),
      onText: (d) => appendStreaming(sid, d),
      onTurnComplete: () => {
        commitStreaming(sid);
        void persistSession(sid); // APP-052: archive the transcript as it grows
        // Pick up anything the turn recorded with `memory_write` — see `memoryBlockRef`.
        void memoryBlockRef.current.refresh();
      },
      onToolNote: (note) => pushTurn(sid, { role: "assistant", content: `🔧 ${note}` }),
      // APP-055/056: usage folds into the module controller (survives unmount).
      onUsage: (u) => agentRuns.recordUsage(sid, u),
      // §3: the measured phase totals for THIS run — the latency card's only data source.
      onPhases: (p) => agentRuns.recordPhases(sid, p),
    };
    /**
     * AUTO-COMPACT before the turn, the way both CLI hosts do.
     *
     * The pane has never compacted, so a long conversation simply grew until the model began
     * refusing or truncating — with no warning and no recovery. Raising the round cap to 32 made
     * that likelier, which is what turned the gap into debt.
     *
     * Fail-soft by construction: `compactTurns` returns the transcript UNCHANGED on any
     * summarizer error, so a failed attempt at saving the conversation can never be what loses
     * it. The store is written only when something actually changed.
     */
    let sendTurns = priorTurns;
    try {
      const win = contextWindowOf(active, catalog).contextWindow;
      const res = await compactTurns(priorTurns, win, async (older) => {
        const out = await runChatTurn(
          { ...active, ...contextWindowOf(active, catalog) },
          [
            {
              role: "system",
              content:
                "Summarize the conversation so far. Keep decisions, file paths and open questions; drop pleasantries.",
            },
            { role: "user", content: older.map((t) => `${t.role}: ${t.content}`).join("\n\n") },
          ],
          // A background helper the user's real turn is waiting behind, not the user's own
          // work — bounded to a SHORTER idle window than the main turn's (10 min default) for
          // exactly that reason, matching the CLI's `makeSummarizer` (same constant, same
          // rationale — see its own doc comment). Before this, a cold-loading/wedged model
          // stalled the summarizer silently for up to 10x longer than the CLI's own budget for
          // this exact role, since `runChatTurn` otherwise falls back to the full-turn default.
          { neverSendToCloud, idleTimeoutMs: DEFAULT_COMPACT_IDLE_TIMEOUT_MS },
        );
        return out.text;
      });
      if (res.compacted) {
        replaceTurns(sid, res.turns);
        sendTurns = res.turns;
        if (res.note) pushTurn(sid, { role: "assistant", content: `⎿ ${res.note}` });
      }
    } catch {
      /* compaction is best-effort; the turn proceeds on the full transcript */
    }

    // Hand the run to the controller: it supersedes any prior run for this tab, drives the
    // loop to completion (even with the pane unmounted), and settles the outcome + busy flag.
    await agentRuns.start(sid, {
      messages: [
        { role: "system", content: systemContent },
        ...sendTurns.map((t) => ({ role: t.role, content: t.content }) as const),
        { role: "user", content: userContent },
      ],
      deps,
    });
  }, [
    active,
    input,
    activeId,
    neverSendToCloud,
    effortTier,
    pushTurn,
    appendStreaming,
    commitStreaming,
    addTaskCard,
    takeCheckpoint,
    persistSession,
    chips,
    runLocalLs,
    runLocalCat,
    runLocalIn,
    outputDir,
  ]);

  // APP-052: load the disk-archived sessions on mount / workspace change (fail-soft).
  useEffect(() => {
    let alive = true;
    const root = useTabsStore.getState().workspaceRoot;
    if (!root) return;
    void loadArchivedSessions(root).then((list) => {
      if (alive) {
        setArchived(list);
        for (const s of list) sessionCreatedRef.current.set(s.id, s.createdAt || s.updatedAt);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * APP-051 revert: restore the workspace to a turn's pre-turn checkpoint (writes+deletes
   * per restorePlan via the path-guarded fs IPC — fs FIRST), then truncate the transcript
   * to before that turn. Any in-flight/paused run for the tab is aborted.
   */
  const revertTurn = useCallback(
    async (turnIndex: number, checkpointId: string): Promise<void> => {
      const sid = activeId;
      const cp = getCheckpoint(sid, checkpointId);
      const api = ide();
      if (!cp || !api) return;
      const root = useTabsStore.getState().workspaceRoot || ".";
      const cur = await snapshotWorkspace(root);
      const plan = restorePlan(cp, Object.keys(cur.files));
      /**
       * fs FIRST, settle, THEN truncate — else a failed write shows a reverted chat over an
       * unreverted disk (revert-ordering, Fable-5 refinement).
       *
       * The ordering was right and nothing read the result it was ordered for: both calls ended
       * in `.catch(() => undefined)`, which swallows a throw, and the resolved `{ok:false}` was
       * never inspected — so the chat rolled back unconditionally. The outcomes are collected
       * now and `revertOutcome` decides whether truncating is honest.
       */
      const steps: RevertStepResult[] = [];
      for (const [rel, content] of Object.entries(plan.write)) {
        const res = await api.fsWrite(`file://${root}/${rel}`, content).catch((e: unknown) => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }));
        steps.push({
          path: rel,
          kind: "write",
          ok: res?.ok === true,
          ...(res?.error ? { error: res.error } : {}),
        });
      }
      for (const rel of plan.delete) {
        const res = await api.fsDelete(`file://${root}/${rel}`).catch((e: unknown) => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }));
        steps.push({
          path: rel,
          kind: "delete",
          ok: res?.ok === true,
          ...(res?.error ? { error: res.error } : {}),
        });
      }
      agentRuns.cancel(sid); // APP-056: abort run + drop paused/proposed for this tab
      setBusy(sid, false);
      const outcome = revertOutcome(steps);
      if (!outcome.truncate) {
        // Keep the transcript: it is the only remaining record of what is still on disk.
        setStatus(sid, outcome.notice);
        return;
      }
      revertToTurn(sid, turnIndex);
    },
    [activeId, getCheckpoint, revertToTurn, setBusy, setStatus],
  );

  const stopActive = useCallback(() => {
    agentRuns.cancel(activeId);
  }, [activeId]);

  const closeTab = useCallback(
    (id: string) => {
      agentRuns.cancel(id); // a closed tab's run is abandoned (no unmount-abort anymore)
      closeSession(id);
    },
    [closeSession],
  );

  // Execute an APPROVED task-card command via the gated exec IPC (§7.3). Clicking Run IS
  // the human approval; main screens it (fail-closed blocklist) + spawns hardened. The
  // captured output is shown on the card (and can be fed back to the agent by the user).
  /**
   * Answer a question card, releasing the suspended turn.
   *
   * An EMPTY answer is still an answer: core renders it as "the user gave no answer, proceed
   * with the most reasonable interpretation", which is what keeps a skipped question from
   * hanging the run.
   */
  const answerCard = useCallback(
    (cardId: string, prompt: string, answer: string) => {
      const sid = activeId;
      updateTaskCard(sid, cardId, { status: "done", output: answer || "(no answer)" });
      agentRuns.resolveCommand(sid, cardId, { command: prompt, answer });
    },
    [activeId, updateTaskCard],
  );

  const runCard = useCallback(
    async (
      cardId: string,
      command: string,
      cwd: string,
      tool = "run_command",
      args: Record<string, unknown> = { command },
      /**
       * "…and stop asking." Rides the card's RESULT rather than a separate channel, so the
       * approval and the memory are one decision and cannot end up disagreeing. The grants
       * file has persisted `project`/`user` scopes from the start and `withRememberedGrants`
       * has consulted them on every call — no surface ever produced one until now.
       */
      remember?: "project" | "user",
    ): Promise<void> => {
      const sid = activeId;
      const root = cwd || useTabsStore.getState().workspaceRoot || ".";
      updateTaskCard(sid, cardId, { status: "running", output: "running…" });
      try {
        // Phase 6: core's `run_command`, NOT `ide:exec`. The task card is unchanged — it is
        // still the human approval (layer 5) — but what runs underneath it is now the same
        // parse → registry → classify → nemesis → ladder → screen path the CLI uses, with
        // no shell anywhere. `ide:exec` spawned `shell -c <command>` behind a regex list.
        /**
         * `notebook_edit` is dispatched in the RENDERER, not over `agent:systemTool`.
         *
         * Main's channel guard (`isHostDispatchTool`) rejects any name that is not one of
         * core's host-dispatched tools, so sending it there would present the user a card,
         * take their approval, and then fail with `unknown tool "notebook_edit"` — the exact
         * "offered but unreachable" shape this pane has been bitten by before.
         */
        const st =
          tool === NOTEBOOK_EDIT_TOOL_NAME
            ? await notebookCardResult(args)
            : await ide()?.systemTool({
                name: tool,
                args,
                cwd: root,
                // Same reason as run-controller's seam: main's OS sandbox for `run_command`
                // opens the network only at the level the pill already permits, so the level
                // has to travel with the call rather than be assumed.
                authLevel: useAuthorisationStore.getState().level,
              });
        const r = st && {
          ok: st.ok,
          exitCode: typeof st.data?.exitCode === "number" ? st.data.exitCode : st.ok ? 0 : 1,
          stdout: st.summary,
          stderr: st.ok ? "" : st.summary,
          blocked: !st.ok && Boolean(st.verdict),
          reason: st.ok ? undefined : st.summary,
          timedOut: false,
        };
        if (!r) {
          updateTaskCard(sid, cardId, {
            status: "done",
            output: "exec unavailable in this environment",
          });
          // release the suspended turn even without an exec backend (so it never hangs).
          agentRuns.resolveCommand(sid, cardId, { command, stderr: "exec unavailable", exit: 1 });
          return;
        }
        const body = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd();
        const head = r.blocked
          ? `⛔ blocked: ${r.reason ?? "screened"}`
          : r.timedOut
            ? "⏱ timed out"
            : `exit ${r.exitCode}`;
        updateTaskCard(sid, cardId, {
          status: "done",
          exitCode: r.exitCode,
          output: body ? `${head}\n${body}` : head,
        });
        // feed the REAL stdout/stderr/exit back into the suspended agent turn (APP-050).
        const exit =
          typeof r.exitCode === "number" ? r.exitCode : r.blocked ? 126 : r.timedOut ? 124 : 1;
        const stderr = [
          r.stderr,
          r.blocked ? `blocked: ${r.reason ?? "screened"}` : "",
          r.timedOut ? "timed out" : "",
        ]
          .filter(Boolean)
          .join("\n");
        agentRuns.resolveCommand(sid, cardId, {
          command,
          ...(r.stdout ? { stdout: r.stdout } : {}),
          ...(stderr ? { stderr } : {}),
          exit,
          // The unflattened result rides along so the runner can replay it verbatim. Without
          // it the gate `verdict` is lost in the mapping to stdout/stderr, and a BLOCKED
          // command comes back looking like an ordinary non-zero exit — so core's loop, which
          // aborts the turn on a block, would carry on instead.
          ...(st ? { raw: st } : {}),
          ...(remember ? { remember } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        updateTaskCard(sid, cardId, { status: "done", output: `error: ${msg}` });
        agentRuns.resolveCommand(sid, cardId, { command, stderr: msg, exit: 1 });
      }
    },
    [activeId, updateTaskCard],
  );

  /** Deny a proposed command: mark the card + release the turn with a denial the model sees. */
  const denyCard = useCallback(
    (cardId: string, command: string) => {
      const sid = activeId;
      updateTaskCard(sid, cardId, { status: "denied" });
      agentRuns.resolveCommand(sid, cardId, { command, denied: true });
    },
    [activeId, updateTaskCard],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 8 }}>
      {/* ── chat tabs (multi-session) ──────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Chat tabs"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          overflowX: "auto",
          borderBottom: "1px solid var(--border-subtle)",
          paddingBottom: 4,
        }}
      >
        {order.map((id) => {
          const s = sessions[id];
          if (!s) return null;
          const selected = id === activeId;
          return (
            <div
              key={id}
              role="tab"
              aria-selected={selected}
              onClick={() => selectSession(id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") selectSession(id);
              }}
              tabIndex={0}
              title={s.title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                maxWidth: 140,
                padding: "3px 6px",
                borderRadius: 5,
                cursor: "pointer",
                fontSize: "0.74rem",
                whiteSpace: "nowrap",
                color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                background: selected
                  ? "color-mix(in srgb, var(--accent) 18%, var(--bg-surface-2))"
                  : "transparent",
                border: `1px solid ${selected ? "var(--border-strong)" : "transparent"}`,
              }}
            >
              {/* APP-056: run-status glyph. `s.busy` is a STORE flag, so it stays lit while
                  the run loops in the BACKGROUND (pane/tab unmounted) — accent = running.
                  A paused tab (busy cleared, awaiting Run/Deny) gets an amber ring so a
                  background tab needing the human's approval is visible in the strip. */}
              {s.busy ? (
                <span
                  aria-hidden="true"
                  title="running"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: "var(--accent)",
                  }}
                />
              ) : agentRuns.isAwaiting(id) ? (
                <span
                  aria-hidden="true"
                  title="awaiting approval"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    flexShrink: 0,
                    border: "1.5px solid var(--warn)",
                  }}
                />
              ) : null}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0,
                  whiteSpace: "nowrap",
                }}
              >
                {s.title}
              </span>
              {order.length > 1 && (
                <button
                  type="button"
                  aria-label={`close ${s.title}`}
                  title="Close chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(id);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.72rem",
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          aria-label="new chat tab"
          title="New chat"
          onClick={() => newSession()}
          style={{
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            borderRadius: 5,
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: "0.8rem",
            padding: "2px 8px",
            flexShrink: 0,
          }}
        >
          +
        </button>
        <button
          type="button"
          aria-label="session browser"
          title="Browse past sessions (resume / fork)"
          aria-pressed={showSessions}
          onClick={() => setShowSessions((v) => !v)}
          style={{
            background: showSessions ? "var(--bg-inset)" : "transparent",
            border: "1px solid var(--border-subtle)",
            borderRadius: 5,
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: "0.8rem",
            padding: "2px 8px",
            flexShrink: 0,
          }}
        >
          🗂
        </button>
      </div>

      {/* APP-052: the session browser — disk-archived past chats (resume / newest-first). */}
      {showSessions && (
        <Panel title="Sessions" elevation="e1">
          <input
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.currentTarget.value)}
            placeholder="search sessions"
            aria-label="search sessions"
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "var(--bg-app)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm, 4px)",
              padding: "3px 6px",
              fontSize: "0.78rem",
              marginBottom: 6,
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 3,
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            {(() => {
              const list = searchSessions(archived, {
                ...(sessionQuery.trim() ? { text: sessionQuery.trim(), includeContent: true } : {}),
              });
              if (list.length === 0) {
                return (
                  <div style={{ color: "var(--text-secondary)", fontSize: "0.76rem", padding: 4 }}>
                    {archived.length === 0 ? "no saved sessions yet" : "no matches"}
                  </div>
                );
              }
              return list.map((sesh) => (
                <button
                  key={sesh.id}
                  type="button"
                  onClick={() => resumeArchived(sesh)}
                  title={`Resume — ${sesh.turns.length} turns`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 1,
                    textAlign: "left",
                    background: "transparent",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm, 4px)",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    padding: "4px 6px",
                    font: "inherit",
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.8rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                      whiteSpace: "nowrap",
                      maxWidth: "100%",
                    }}
                  >
                    {sesh.title}
                  </span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.68rem" }}>
                    {sesh.turns.length} turns · {sesh.updatedAt.slice(0, 16).replace("T", " ")}
                    {sesh.workspacePath ? ` · ${sesh.workspacePath.split("/").pop()}` : ""}
                  </span>
                </button>
              ));
            })()}
          </div>
        </Panel>
      )}

      {/* model picker (§7.5) */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.78rem" }}>
        <span style={{ color: "var(--text-secondary)" }}>model:</span>
        <select
          value={endpointId ?? ""}
          onChange={(e) => selectEndpoint(e.target.value || null)}
          aria-label="model endpoint"
          style={{
            flex: 1,
            background: "var(--bg-surface-2)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 4,
            padding: "3px 6px",
          }}
        >
          {endpoints.length === 0 && <option value="">no served model</option>}
          {endpoints.map((e) => {
            // APP-092: enrich the option with provider kind, context window, and capability
            // markers derived from the open-models catalog (fail-soft to id + local/cloud).
            const m = endpointMeta(e, catalog);
            const ctx = formatContextWindow(m.contextWindow);
            const caps = [m.caps.tools && "tools", m.caps.vision && "vision", m.caps.fim && "fim"]
              .filter(Boolean)
              .join("/");
            const parts = [
              m.locality === "local" ? "local" : "cloud",
              ctx ? `${ctx} ctx` : null,
              caps || null,
            ].filter(Boolean);
            return (
              <option key={e.id} value={e.id} disabled={neverSendToCloud && e.locality === "cloud"}>
                {e.id} · {parts.join(" · ")}
              </option>
            );
          })}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <input
            type="checkbox"
            checked={neverSendToCloud}
            onChange={(e) => setNeverSendToCloud(e.target.checked)}
            aria-label="never send to cloud"
          />
          <span style={{ color: "var(--text-secondary)" }}>no-cloud</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <input
            type="checkbox"
            checked={ghostText}
            onChange={(e) => setGhostText(e.target.checked)}
            aria-label="AI ghost-text completions"
          />
          <span style={{ color: "var(--text-secondary)" }}>ghost</span>
        </label>
      </div>

      {/* APP-092: the ACTIVE endpoint's capability badges (provider kind · context · caps). */}
      {active &&
        (() => {
          const m = endpointMeta(active, catalog);
          const ctx = formatContextWindow(m.contextWindow);
          const badges: { label: string; role: string }[] = [
            {
              label: m.locality === "local" ? "local" : "cloud",
              role: m.locality === "local" ? "ok" : "warn",
            },
            ...(ctx ? [{ label: `${ctx} ctx`, role: "text-secondary" }] : []),
            ...(m.caps.tools ? [{ label: "tools", role: "accent" }] : []),
            ...(m.caps.vision ? [{ label: "vision", role: "accent" }] : []),
            ...(m.caps.fim ? [{ label: "FIM", role: "accent" }] : []),
          ];
          return (
            <div
              aria-label="model capabilities"
              style={{ display: "flex", flexWrap: "wrap", gap: 4, fontSize: "0.66rem" }}
            >
              {badges.map((b) => (
                <span
                  key={b.label}
                  style={{
                    padding: "0 5px",
                    borderRadius: "var(--radius-sm, 4px)",
                    border: "1px solid var(--border-subtle)",
                    color: `var(--${b.role})`,
                  }}
                >
                  {b.label}
                </span>
              ))}
            </div>
          );
        })()}

      {/* APP-055: per-session token/cost meter + the AI Providers screen. */}
      {(() => {
        const totals = agentRuns.usageFor(activeId);
        const isCloud = active?.locality === "cloud";
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.72rem" }}>
            {totals.costUsd !== null && endpointId ? (
              // cloud with a known cost → the real $-meter (banded, capped).
              <SpendMeter
                compact
                providerLabel={active?.id ?? "provider"}
                spentUsd={totals.costUsd}
                capUsd={meteredCaps[endpointId]?.capUsd ?? 20}
              />
            ) : totals.totalTokens > 0 ? (
              <span style={{ color: "var(--text-secondary)" }}>
                {totals.totalTokens.toLocaleString()} tokens this session ·{" "}
                {totals.lastTurnTokens.toLocaleString()} last turn
                {isCloud ? " · cost unknown" : ""}
              </span>
            ) : (
              <span style={{ color: "var(--text-secondary)" }}>no usage yet</span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              aria-pressed={showProviders}
              onClick={() => setShowProviders((v) => !v)}
              style={{
                background: showProviders ? "var(--bg-inset)" : "transparent",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "0.72rem",
                padding: "2px 6px",
              }}
            >
              AI Providers ▾
            </button>
          </div>
        );
      })()}
      {showProviders && (
        <Panel title="AI Providers" elevation="e1">
          {(() => {
            const rows: AiProviderRow[] = endpoints.map((e) => ({
              id: e.id,
              label: e.id,
              tier: e.locality === "local" ? "A" : "C",
              kind: e.locality === "local" ? "local-serve" : "api-key",
              warnLevel: e.locality === "local" ? "none" : "loud",
              caption: e.locality === "local" ? "local · free" : "metered",
              openWeight: e.locality === "local",
              modelId: e.model ?? e.id,
            }));
            const meters = Object.entries(meteredCaps).map(([id, cap]) => ({
              providerLabel: id,
              spentUsd: agentRuns.usageFor(activeId).costUsd ?? 0,
              capUsd: cap.capUsd,
              ...(cap.autoDisable ? { onCapNote: "auto-disable at cap" } : {}),
            }));
            return (
              <AiProvidersScreen
                surfaces={[{ id: "chat", label: "Chat / Agent" }]}
                selectedSurfaceId="chat"
                onSurfaceChange={() => {}}
                activeBrainLabel={active ? `${active.id} (${active.locality})` : undefined}
                rows={rows}
                {...(endpointId ? { activeId: endpointId } : {})}
                activeMeters={meters}
                onSelect={(row) => {
                  selectEndpoint(row.id);
                  setShowProviders(false);
                }}
                onConfirmMetered={(row, confirm: CostWarningConfirm) => {
                  // typed-confirm ("ENABLE METERED") already passed inside the modal.
                  setMeteredCaps((cur) => {
                    const next = {
                      ...cur,
                      [row.id]: {
                        capUsd: confirm.monthlyCapUsd,
                        autoDisable: confirm.autoDisableAtCap,
                      },
                    };
                    try {
                      window.localStorage.setItem(
                        "prometheus.ai.meteredCaps",
                        JSON.stringify(next),
                      );
                    } catch {
                      /* private mode — cap just won't persist */
                    }
                    return next;
                  });
                  selectEndpoint(row.id);
                }}
              />
            );
          })()}
        </Panel>
      )}

      {/* chat controls: + New opens a fresh TAB; Clear wipes THIS tab; Stop aborts it. */}
      <div style={{ display: "flex", gap: 6, fontSize: "0.74rem" }}>
        <Button size="sm" variant="ghost" onClick={() => newSession()}>
          + New
        </Button>
        {turns.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              stopActive();
              clearTurns(activeId);
            }}
          >
            ⌫ Clear
          </Button>
        )}
        {busy && (
          <Button size="sm" variant="ghost" onClick={stopActive}>
            ◼ Stop
          </Button>
        )}
        {turns.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => copyText(turns.map((t) => `${t.role}: ${t.content}`).join("\n\n"))}
          >
            ⧉ Copy chat
          </Button>
        )}
        <span style={{ flex: 1 }} />
        {rulesInfo.order.length > 0 && (
          <span
            title={`Project rules steering the agent: ${rulesInfo.order.join(", ")}`}
            style={{ color: "var(--text-secondary)", alignSelf: "center" }}
          >
            📏 {rulesInfo.order.join(" · ")}
          </span>
        )}
      </div>

      {/* NO-BACKEND NOTICE — the chat can't run without a served model, an API endpoint,
          or a CLI. Instead of silently doing nothing (the old behaviour), tell the user
          exactly why and give one-click routes to fix it. */}
      {!active && (
        <div
          style={{
            border: "1px solid var(--border-strong)",
            background: "var(--bg-surface-2)",
            borderRadius: 6,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <strong style={{ fontSize: "0.82rem", color: "var(--text-primary)" }}>
            {autoStarting ? "⏳ Starting your local model server…" : "⚠ No model backend connected"}
          </strong>
          <span style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
            {autoStarting
              ? "It was served before and just needs a moment to come back up — send your prompt again shortly."
              : endpoints.length === 0
                ? "This chat needs a local model, an API endpoint, or an agent CLI — none is installed or served yet. Pick a path:"
                : "A model is available but none is selected. Choose one from the selector above to start chatting."}
          </span>
          {endpoints.length === 0 && !autoStarting && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Button size="sm" variant="primary" onClick={() => onNavigate?.("models")}>
                ⬇ Install a local model
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onNavigate?.("chat")}>
                ◆ Use an AI CLI
              </Button>
            </div>
          )}
        </div>
      )}

      {/* transcript */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {/* `!thinking` too: a reasoning model's first phase produces no text, so without it
            the empty-state prompt sits above the thinking block for the whole think. */}
        {turns.length === 0 && !streaming && !thinking && active && (
          <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
            Ask the agent to read, grep, or propose an edit.
          </p>
        )}
        {turns.map((t, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: transcript turns are append-only + stable
            key={i}
            style={{
              position: "relative",
              alignSelf: t.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "90%",
              // role-aware right gutter: a user turn stacks copy/revert/fork (out to right:34
              // + glyph) → needs 48px; assistant has only copy → tight 24px. 22px overlapped text.
              padding: t.role === "user" ? "6px 48px 6px 8px" : "6px 24px 6px 8px",
              borderRadius: 6,
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word", // long paths/URLs/shas must break inside the bubble, not widen it
              // user bubble = a soft accent TINT (distinct from the assistant) with normal
              // text — solid --accent + --brand-fg (a different token's fg) was a loud,
              // low-contrast combo.
              background:
                t.role === "user"
                  ? "color-mix(in srgb, var(--accent) 22%, var(--bg-surface-2))"
                  : "var(--bg-surface-2)",
              color: "var(--text-primary)",
            }}
          >
            {/* assistant replies render as (safe) markdown; user text stays literal (#12). */}
            {t.role === "assistant" ? (
              t.pre ? (
                <Verbatim text={t.content} />
              ) : (
                <Markdown source={t.content} />
              )
            ) : (
              t.content
            )}
            <button
              type="button"
              aria-label="copy message"
              title="Copy message"
              onClick={() => copyText(t.content)}
              style={{
                position: "absolute",
                top: 2,
                right: 3,
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "0.7rem",
                padding: 0,
                lineHeight: 1,
              }}
            >
              ⧉
            </button>
            {/* APP-051: revert the workspace + chat to BEFORE this turn (user turns w/ a snapshot). */}
            {t.role === "user" && t.checkpointId && (
              <button
                type="button"
                aria-label="revert to before this turn"
                title="Revert workspace + chat to before this turn"
                onClick={() => void revertTurn(i, t.checkpointId as string)}
                style={{
                  position: "absolute",
                  top: 2,
                  right: 18,
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: "0.7rem",
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ⤺
              </button>
            )}
            {/* APP-052: fork a NEW session from this user turn (turns 1..N; original kept). */}
            {t.role === "user" && (
              <button
                type="button"
                aria-label="fork from this turn"
                title="Fork a new chat from here (keeps turns up to this one)"
                onClick={() => void forkFrom(i)}
                style={{
                  position: "absolute",
                  top: 2,
                  right: t.checkpointId ? 34 : 18,
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: "0.7rem",
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ⑂
              </button>
            )}
          </div>
        ))}
        {/*
          The model's THINKING, while it thinks (§9). A reasoning model streams nothing on
          `content` during this phase, so without a surface for it the pane shows an empty
          turn for 10–60s and the run is indistinguishable from a hang.

          Deliberately quieter than an answer — dimmed, italic, and capped with its own
          scroll — because it is scratch work the user may want to glance at, not read. It
          disappears when the turn settles; it is never part of the transcript.
        */}
        {thinking && (
          <details
            open
            style={{
              alignSelf: "stretch",
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px dashed var(--border-subtle)",
              background: "var(--bg-inset)",
              color: "var(--text-secondary)",
              fontSize: "0.74rem",
            }}
          >
            <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>
              thinking… ({thinking.length} chars)
            </summary>
            <div
              style={{
                marginTop: 4,
                maxHeight: 160,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                fontStyle: "italic",
                overflowWrap: "break-word",
              }}
            >
              {thinking}
            </div>
          </details>
        )}
        {/* the wrapper's watchdog heartbeat — one line, replaced not appended */}
        {runStatus && (
          <div
            role="status"
            style={{
              alignSelf: "flex-start",
              color: "var(--text-muted)",
              fontSize: "0.72rem",
              fontStyle: "italic",
            }}
          >
            {runStatus}
          </div>
        )}
        {streaming && (
          <div
            style={{
              alignSelf: "flex-start",
              maxWidth: "90%",
              padding: "6px 8px",
              borderRadius: 6,
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word", // long paths/URLs/shas must break inside the bubble, not widen it
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
            }}
          >
            {streaming}
            <span aria-hidden="true">▍</span>
          </div>
        )}
      </div>

      {/*
        §9.2 — the DECISION region is PINNED, not part of the transcript.

        Every one of these (the gate verdict, the proposed-edit review with its permission
        card, the confirm-gated command cards) is something the run is BLOCKED on. They used
        to render as the last children of the `overflow:auto` transcript above, which meant a
        long answer could scroll the thing the agent is waiting for out of sight — inside a
        rail island that is itself `overflow:hidden`. The mitigation was a "review ↓" chip
        that called `scrollIntoView`; a chip that scrolls you to the prompt is an admission
        that the prompt is in the wrong place, so the chip is gone with the defect.

        It scrolls WITHIN itself when several decisions stack up, and is capped in vh so it
        can never push the composer off the bottom of the rail.
      */}
      <div
        style={{
          flex: "none",
          maxHeight: "min(46vh, 520px)",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {/* §4: the LAST gate verdict, in chat, in the same card shape as everywhere else.
          AI-authored new files go to the run-gate (DiffReview enqueues them), so the
          verdict that lands here is usually about work this conversation just did. */}
        {lastVerdict && (
          <div
            style={{
              borderRadius: 11,
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <VerdictCard
              verdict={lastVerdict.verdict}
              artifact={lastVerdict.target}
              sourceKind={lastVerdict.signed ? "signed" : "unsigned"}
              riskScore={lastVerdict.riskScore}
              findings={chatVerdictFindings(lastVerdict)}
              maxFindings={3}
              onDetails={() => onNavigate?.("security")}
            />
          </div>
        )}
        {/* §3: the latency attribution card — after EVERY run, never during one (a
          half-measured bar would misattribute the time still being spent). */}
        {!busy && runPhases && <LatencyCard phases={runPhases} />}
        <div>
          <DiffReview />
        </div>

        {/* confirm-gated task cards (§7.3), and the agent's own questions */}
        {taskCards.map((card) =>
          card.kind === "question" ? (
            <QuestionCard
              key={card.id}
              id={card.id}
              prompt={card.command}
              status={card.status}
              output={card.output}
              onAnswer={answerCard}
            />
          ) : (
            <Panel
              key={card.id}
              title={`${card.tool ?? "run_command"} · ${card.status}`}
              elevation="e1"
            >
              <code style={{ fontSize: "0.72rem", display: "block", marginBottom: 4 }}>
                {card.cwd} $ {card.command}
              </code>
              {card.status === "pending" ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      void runCard(
                        card.id,
                        card.command,
                        card.cwd,
                        card.tool ?? "run_command",
                        card.args ?? { command: card.command },
                      )
                    }
                  >
                    ▶ Run (gated)
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="run it, and stop asking for this exact command in this workspace"
                    onClick={() =>
                      void runCard(
                        card.id,
                        card.command,
                        card.cwd,
                        card.tool ?? "run_command",
                        card.args ?? { command: card.command },
                        "project",
                      )
                    }
                  >
                    ▶ always
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => copyText(card.command)}>
                    ⧉ copy
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => denyCard(card.id, card.command)}>
                    ✗ deny
                  </Button>
                </div>
              ) : (
                <pre style={{ margin: 0, fontSize: "0.7rem", whiteSpace: "pre-wrap" }}>
                  {card.output}
                </pre>
              )}
            </Panel>
          ),
        )}
      </div>

      {/* APP-054: resolved mention chips (removable before send). */}
      {chips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {chips.map((c) => (
            <span
              key={c.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 6px",
                borderRadius: "var(--radius-sm, 4px)",
                background: "color-mix(in srgb, var(--accent) 18%, var(--bg-surface-2))",
                color: "var(--text-primary)",
                fontSize: "0.7rem",
              }}
            >
              <span aria-hidden="true">
                {c.kind === "sym" ? "◈" : c.kind === "folder" ? "▤" : "📄"}
              </span>
              {c.label}
              <button
                type="button"
                aria-label={`remove ${c.label}`}
                onClick={() => setChips((cur) => removeChip(cur, c.id))}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* composer (with @-mention picker: file / sym / folder / docs) */}
      <div ref={composerRef} style={{ position: "relative" }}>
        {mentionBox &&
          createPortal(
            <div
              aria-label="mention picker"
              style={{
                position: "fixed",
                left: mentionBox.left,
                top: mentionBox.top,
                width: mentionBox.width,
                maxHeight: MENTION_H,
                overflow: "auto",
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border-strong)",
                borderRadius: 6,
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                zIndex: Z.dropdown,
              }}
            >
              {mentionMatches.map((sug, i) => (
                <button
                  key={sug.key}
                  type="button"
                  aria-current={i === mentionActive ? "true" : undefined}
                  onMouseEnter={() => setMentionActive(i)}
                  onClick={() => void completeMention(sug)}
                  style={{
                    display: "flex",
                    gap: 6,
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    padding: "4px 8px",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "0.72rem",
                    background: i === mentionActive ? "var(--bg-inset)" : "transparent",
                    color: "var(--text-primary)",
                  }}
                >
                  <span aria-hidden="true" style={{ color: "var(--text-secondary)" }}>
                    {sug.kind === "sym"
                      ? "◈"
                      : sug.kind === "folder"
                        ? "▤"
                        : sug.kind === "docs"
                          ? "📄"
                          : "@"}
                  </span>
                  {sug.label}
                </button>
              ))}
            </div>,
            document.body,
          )}
        {noSymbolsBox &&
          createPortal(
            <div
              style={{
                position: "fixed",
                left: noSymbolsBox.left,
                top: noSymbolsBox.top,
                padding: "3px 8px",
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 6,
                color: "var(--text-secondary)",
                fontSize: "0.7rem",
                zIndex: Z.dropdown,
              }}
            >
              no indexed symbols — open files or build the repo map
            </div>,
            document.body,
          )}
        {/* APP-092: `/` slash-command menu (executes a shell registry command). */}
        {slashBox &&
          createPortal(
            <div
              aria-label="slash command menu"
              style={{
                position: "fixed",
                left: slashBox.left,
                top: slashBox.top,
                width: slashBox.width,
                maxHeight: SLASH_H,
                overflow: "auto",
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border-strong)",
                borderRadius: 6,
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                zIndex: Z.dropdown,
              }}
            >
              {slashMatches.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  aria-current={i === slashActive ? "true" : undefined}
                  onMouseEnter={() => setSlashActive(i)}
                  onClick={() => acceptSlash(cmd.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    padding: "4px 8px",
                    cursor: "pointer",
                    fontSize: "0.74rem",
                    background: i === slashActive ? "var(--bg-inset)" : "transparent",
                    color: "var(--text-primary)",
                  }}
                >
                  <span aria-hidden="true" style={{ color: "var(--accent)" }}>
                    ／
                  </span>
                  <span>{cmd.title}</span>
                  {cmd.category && (
                    <span
                      style={{
                        marginLeft: "auto",
                        color: "var(--text-secondary)",
                        fontSize: "0.68rem",
                      }}
                    >
                      {cmd.category}
                    </span>
                  )}
                </button>
              ))}
            </div>,
            document.body,
          )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          // handoff §2.5: an INPUT ISLAND — inset ground, its own border + radius, with the
          // gradient send button riding inside it rather than sitting beside a bare field.
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            padding: "8px 10px",
            borderRadius: "var(--radius-lg)",
            background: "var(--bg-inset)",
            border: "1px solid var(--border-chip)",
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => onInput(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              onInput(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              // APP-092: the `/` slash menu takes the arrow/enter/tab/esc keys when open.
              if (slashQuery !== null && slashMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashActive((a) => clampSlashIndex(a + 1, slashMatches.length));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashActive((a) => clampSlashIndex(a - 1, slashMatches.length));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const pick = slashMatches[clampSlashIndex(slashActive, slashMatches.length)];
                  if (pick) acceptSlash(pick.id);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setInput("");
                  return;
                }
              }
              // the @-mention picker owns those keys when it is open (APP-054).
              if (activeMention && mentionMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionActive((a) => Math.min(a + 1, mentionMatches.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionActive((a) => Math.max(a - 1, 0));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const pick = mentionMatches[mentionActive];
                  if (pick) void completeMention(pick);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setActiveMention(null);
                  return;
                }
              }
              // Enter = send (IME-safe: never send a half-typed CJK composition); Shift-Enter
              // = newline (the textarea's default, so we do nothing and let it insert).
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              active
                ? "message the agent…  (/ commands · @ file · @sym: · Shift-Enter = newline)"
                : "connect a model above to chat →"
            }
            aria-label="agent message"
            disabled={!active || busy}
            style={{
              flex: 1,
              padding: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text-primary)",
              resize: "none",
              maxHeight: "12rem",
              overflowY: "auto",
              fontFamily: "var(--font-ui)",
              fontSize: 12.5,
              lineHeight: 1.45,
            }}
          />
          <button
            type="submit"
            aria-label="Send"
            title="Send (⏎)"
            disabled={!active || busy || !input.trim()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              flex: "none",
              borderRadius: "var(--radius-md)",
              border: "none",
              background: "var(--gradient-brand)",
              // `--on-brand` is the computed label colour for the `--brand` FILL (tokens/contrast.ts `onFill`).
              // The old `--brand-fg` here was WHITE on the dark scheme over a saturated light fill (~2:1),
              // and a plain `--bg-app` would be near-white over the same fill on the LIGHT scheme.
              color: "var(--on-brand)",
              fontSize: 13,
              lineHeight: 1,
              cursor: !active || busy || !input.trim() ? "default" : "pointer",
              opacity: !active || busy || !input.trim() ? 0.4 : 1,
            }}
          >
            ↑
          </button>
        </form>

        {/* §2.5 chip row: the model picker, the effort tier, and the A{n} auth readout —
            the three facts that decide what this next message will actually do. */}
        <div
          ref={chipRowRef}
          style={{
            display: "flex",
            alignItems: "center",
            // the rail is ~330px and the model chip's label is arbitrary length (§9)
            minWidth: 0,
            gap: 7,
            marginTop: 7,
            fontSize: 11,
            color: "var(--text-muted)",
            position: "relative",
          }}
        >
          <button
            type="button"
            onClick={() => setShowEndpointPicker((v) => !v)}
            aria-expanded={showEndpointPicker}
            aria-haspopup="listbox"
            title={active ? `${active.id} · ${active.baseUrl}` : "No model connected"}
            style={{ ...composerChip(), fontFamily: "var(--font-mono)" }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: active ? "var(--ok)" : "var(--text-disabled)",
              }}
            />
            <span
              style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
              title={active ? (active.model ?? active.id) : "no model"}
            >
              {active ? (active.model ?? active.id) : "no model"}
            </span>
            <span aria-hidden="true" style={{ flex: "none" }}>
              ⌄
            </span>
          </button>
          {endpointBox &&
            createPortal(
              <div
                role="listbox"
                tabIndex={-1}
                aria-label="Model endpoint"
                style={{
                  position: "fixed",
                  left: endpointBox.left,
                  top: endpointBox.top,
                  width: endpointBox.width,
                  maxHeight: ENDPOINT_H,
                  overflowY: "auto",
                  zIndex: Z.dropdown,
                  borderRadius: "var(--radius-island)",
                  background: "var(--bg-surface-2)",
                  border: "1px solid var(--border-strong)",
                  boxShadow: "var(--elevation-e3)",
                }}
              >
                {endpoints.length === 0 && (
                  <div style={{ padding: "10px 12px", color: "var(--text-muted)" }}>
                    No served model. Open the Model Hub to start one.
                  </div>
                )}
                {endpoints.map((e) => {
                  const blocked = neverSendToCloud && e.locality === "cloud";
                  const selected = e.id === endpointId;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={blocked}
                      onClick={() => {
                        selectEndpoint(e.id);
                        setShowEndpointPicker(false);
                      }}
                      title={blocked ? "blocked by the never-send-to-cloud policy" : e.baseUrl}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "7px 11px",
                        border: "none",
                        borderBottom: "1px solid var(--border-row)",
                        background: selected ? "var(--bg-active)" : "transparent",
                        color: blocked ? "var(--text-disabled)" : "var(--text-title)",
                        cursor: blocked ? "not-allowed" : "pointer",
                        fontFamily: "var(--font-mono)",
                        fontSize: 11.5,
                        textAlign: "left",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          flex: "none",
                          background: e.locality === "local" ? "var(--ok)" : "var(--accent)",
                        }}
                      />
                      <span
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                          whiteSpace: "nowrap",
                        }}
                      >
                        {e.model ?? e.id}
                      </span>
                      <span style={{ color: "var(--text-muted)", flex: "none" }}>{e.locality}</span>
                    </button>
                  );
                })}
              </div>,
              document.body,
            )}
          <span style={{ flex: 1 }} />
          <AuthPill compact />
        </div>
        {/* One row, fixed slots: a capability the model LACKS keeps its place, dimmed, because
            absence is information the old present-only grid could not report — and a row whose
            cells never move is one the ⌘T arrows can walk. The dial is always last. */}
        <TraitRail
          cells={railCells}
          focus={traitFocus}
          effortTitle={effortTitle}
          onFocus={setTraitFocus}
          onAdjust={adjustTrait}
        />
      </div>
    </div>
  );
}

/**
 * The trait rail: one row of fixed slots, then the dial.
 *
 * Green = live this turn, amber = switched off, dim = the model does not have it at all. The
 * three states are what the old strip could not say: it listed what was present and was silent
 * about everything else, so "this model cannot see" and "you turned vision off" looked identical
 * (both absent) and neither was distinguishable from a rendering bug.
 *
 * ⌘T focuses a cell; ←/→ walk, ↑/↓ throw the switch, Esc leaves. Clicking a cell does the same
 * thing as focusing it, so the rail is usable without ever learning the chord.
 */
function TraitRail({
  cells,
  focus,
  effortTitle,
  onFocus,
  onAdjust,
}: {
  cells: readonly TraitCell[];
  focus: number | null;
  effortTitle: string;
  onFocus: (i: number | null) => void;
  onAdjust: (cell: TraitCell, delta: 1 | -1) => void;
}): JSX.Element | null {
  if (cells.length === 0) return null;
  const focused = focus === null ? null : cells[focus];
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
        {cells.map((cell, i) => (
          <TraitCellChip
            key={cell.id}
            cell={cell}
            focused={focus === i}
            {...(cell.id === "effort" ? { title: effortTitle } : {})}
            onSelect={() => onFocus(focus === i ? null : i)}
            onAdjust={(delta) => onAdjust(cell, delta)}
          />
        ))}
      </div>
      {focused ? (
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
          {focused.actionable
            ? focused.id === "effort"
              ? "↑/↓ raise/lower effort · ←/→ move · esc done"
              : "↑ on · ↓ off · ←/→ move · esc done"
            : `${focused.label}: ${focused.reason ?? "no switch here"} · esc done`}
        </div>
      ) : null}
    </div>
  );
}

/** One rail cell. An indicator renders as a chip; an actionable one as a button. */
function TraitCellChip({
  cell,
  focused,
  title,
  onSelect,
  onAdjust,
}: {
  cell: TraitCell;
  focused: boolean;
  /** overrides the generated tooltip — the dial carries the degradation sentence. */
  title?: string;
  onSelect: () => void;
  onAdjust: (delta: 1 | -1) => void;
}): JSX.Element {
  const color =
    cell.state === "on" ? "var(--ok)" : cell.state === "off" ? "var(--warn)" : "var(--text-muted)";
  return (
    <button
      type="button"
      onClick={() => (cell.actionable ? onAdjust(cell.state === "on" ? -1 : 1) : onSelect())}
      title={
        title ??
        (cell.actionable
          ? `${cell.label} — ${cell.state === "on" ? "on" : "off"}; click to toggle, ⌘T for the keyboard rail`
          : `${cell.label} — ${cell.reason ?? "no switch here"}`)
      }
      style={{
        ...composerChip(),
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        cursor: cell.actionable ? "pointer" : "default",
        color,
        // the focus ring is a BORDER, not a hue: the three state colors already own hue here,
        // and a fourth would make the selection compete with the thing it is selecting.
        outline: focused ? "1px solid var(--accent)" : "none",
        outlineOffset: 1,
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {cell.label}
    </button>
  );
}

/**
 * The composer's chip shell (model picker / effort) — §2.5.
 *
 * `minWidth: 0` + `overflow: hidden` because these chips sit in the RIGHT RAIL, ~330px
 * wide, and the model chip renders an arbitrary-length id (`hf.co/…-GGUF:Q4_K_M`). Without
 * it the chip's min-content width is the whole id and the row pushes past the rail edge,
 * taking the effort chip and the A{n} readout with it.
 */
function composerChip(): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
    overflow: "hidden",
    padding: "2px 8px",
    borderRadius: "var(--radius-md)",
    background: "var(--bg-surface-2)",
    border: "1px solid var(--border-chip)",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
    lineHeight: 1.6,
  };
}

export default AgentPane;
