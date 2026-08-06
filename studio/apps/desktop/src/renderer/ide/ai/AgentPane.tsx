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
import * as rules from "@prometheus/core/rules";
import {
  type ActivityId,
  type AiProviderRow,
  AiProvidersScreen,
  Button,
  type CostWarningConfirm,
  Panel,
  SpendMeter,
} from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IdeTreeNode } from "../../../shared/ipc-contract.js";
import { commandPaletteRows } from "../../commands/registry.js";
import { getActiveEditorSelection } from "../EditorPane.js";
import { useCodeIndexStore } from "../state/code-index-store.js";
import { type IndexedSymbol, searchSymbols, shortlistFiles } from "../state/code-index.js";
import { fuzzyRank } from "../state/fuzzy.js";
import { useAiSessionStore, useTabsStore } from "../state/stores.js";
import { DiffReview } from "./DiffReview.js";
import { AGENT_SYSTEM, type AgentLoopDeps, createProposeEditTool } from "./agent-loop.js";
import { useActiveEndpoint } from "./endpoint-hook.js";
import { type CatalogModelLite, endpointMeta, formatContextWindow } from "./endpoints.js";
import { Markdown } from "./markdown.js";
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
import { agentRuns } from "./run-controller.js";
import { isSafeSessionId, liveToSession, sessionToLive } from "./session-map.js";
import { activeSlashQuery, clampSlashIndex, filterSlashCommands } from "./slash.js";

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
  const { endpoints, active, neverSendToCloud } = useActiveEndpoint();
  const endpointId = useAiSessionStore((s) => s.endpointId);
  const selectEndpoint = useAiSessionStore((s) => s.selectEndpoint);
  const setNeverSendToCloud = useAiSessionStore((s) => s.setNeverSendToCloud);
  const ghostText = useAiSessionStore((s) => s.ghostText);
  const setGhostText = useAiSessionStore((s) => s.setGhostText);

  // ── multi-tab session state ──────────────────────────────────────────────
  const order = useAiSessionStore((s) => s.order);
  const activeId = useAiSessionStore((s) => s.activeId);
  const sessions = useAiSessionStore((s) => s.sessions);
  const activeSession = sessions[activeId];
  const turns = activeSession?.turns ?? EMPTY_TURNS;
  const streaming = activeSession?.streaming ?? "";
  const taskCards = activeSession?.taskCards ?? EMPTY_CARDS;
  const busy = activeSession?.busy ?? false;
  const changeSet = activeSession?.changeSet ?? null;
  // anchor for the "edits proposed — review" chip → scrolls the DiffReview into view.
  const diffRef = useRef<HTMLDivElement | null>(null);

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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // APP-092: `/` slash-command menu (rows from the shell registry) + the highlighted row.
  const commandRows = useMemo(() => commandPaletteRows(), []);
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
      const sources: rules.RuleSource[] = [];
      for (const kind of ["agents", "claude"] as const) {
        const file = kind === "agents" ? "AGENTS.md" : "CLAUDE.md";
        const r = await api.fsRead(`file://${root}/${file}`).catch(() => undefined);
        if (r?.ok && typeof r.text === "string" && r.text.trim()) {
          sources.push({ scope: "project", kind, path: file, content: r.text });
        }
      }
      if (!alive) return;
      const assembled = sources.length > 0 ? rules.assembleRules(sources) : { text: "", order: [] };
      projectRulesRef.current = assembled.text;
      setRulesInfo({ order: assembled.order });
    })();
    return () => {
      alive = false;
    };
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
  const acceptSlash = useCallback(
    (id: string) => {
      onRunCommand?.(id);
      setInput("");
      setSlashActive(0);
      const el = inputRef.current;
      if (el) el.style.height = "auto";
    },
    [onRunCommand],
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
    if (!active || !input.trim() || store.sessions[sid]?.busy) return;
    const text = input.trim();
    setInput("");
    setActiveMention(null);
    // capture the prior transcript BEFORE we append the new user turn (so the message
    // list carries the new prompt exactly once).
    const priorTurns = store.sessions[sid]?.turns ?? [];
    // APP-051: snapshot the workspace BEFORE this turn runs → a per-turn revert point.
    // Bounded walk (skip-and-warn, never blocks); the checkpoint id rides on the user turn.
    const root0 = useTabsStore.getState().workspaceRoot || ".";
    const turnNumber = priorTurns.length;
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
      proposeCommand: (command: string): string => {
        const cardId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        addTaskCard(sid, { id: cardId, command, cwd: root, status: "pending", output: "" });
        // record the proposed card (id + command) so the pause can positionally match
        // each pending command → its Run/Deny result → one resume (APP-050/056 controller).
        agentRuns.recordProposed(sid, { id: cardId, command });
        return `proposed command (approve below to run): ${command}`;
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
    // prepend the workspace AGENTS.md/CLAUDE.md rules (if any) to the system prompt.
    const projectRules = projectRulesRef.current;
    const systemContent = projectRules ? `${AGENT_SYSTEM}\n\n${projectRules}` : AGENT_SYSTEM;
    // Deps carry NO signal — the controller mints the AbortController in `start` and injects
    // it, so the run + its abort live in the module controller (survive pane unmount, 056).
    const deps: Omit<AgentLoopDeps, "signal"> = {
      endpoint: active,
      neverSendToCloud,
      tools,
      onText: (d) => appendStreaming(sid, d),
      onTurnComplete: () => {
        commitStreaming(sid);
        void persistSession(sid); // APP-052: archive the transcript as it grows
      },
      onToolNote: (note) => pushTurn(sid, { role: "assistant", content: `🔧 ${note}` }),
      // APP-055/056: usage folds into the module controller (survives unmount).
      onUsage: (u) => agentRuns.recordUsage(sid, u),
    };
    // Hand the run to the controller: it supersedes any prior run for this tab, drives the
    // loop to completion (even with the pane unmounted), and settles the outcome + busy flag.
    await agentRuns.start(sid, {
      messages: [
        { role: "system", content: systemContent },
        ...priorTurns.map((t) => ({ role: t.role, content: t.content }) as const),
        { role: "user", content: userContent },
      ],
      deps,
    });
  }, [
    active,
    input,
    activeId,
    neverSendToCloud,
    pushTurn,
    appendStreaming,
    commitStreaming,
    addTaskCard,
    takeCheckpoint,
    persistSession,
    chips,
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
      // fs FIRST, settle, THEN truncate — else a failed write shows a reverted chat over
      // an unreverted disk (revert-ordering, Fable-5 refinement).
      for (const [rel, content] of Object.entries(plan.write)) {
        await api.fsWrite(`file://${root}/${rel}`, content).catch(() => undefined);
      }
      for (const rel of plan.delete) {
        await api.fsDelete(`file://${root}/${rel}`).catch(() => undefined);
      }
      agentRuns.cancel(sid); // APP-056: abort run + drop paused/proposed for this tab
      setBusy(sid, false);
      revertToTurn(sid, turnIndex);
    },
    [activeId, getCheckpoint, revertToTurn, setBusy],
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
  const runCard = useCallback(
    async (cardId: string, command: string, cwd: string): Promise<void> => {
      const sid = activeId;
      const root = cwd || useTabsStore.getState().workspaceRoot || ".";
      updateTaskCard(sid, cardId, { status: "running", output: "running…" });
      try {
        const r = await ide()?.exec({ command, cwd: root });
        if (!r) {
          updateTaskCard(sid, cardId, {
            status: "done",
            output: "exec unavailable in this environment",
          });
          // resume the paused loop even without an exec backend (so it never hangs).
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
        // feed the REAL stdout/stderr/exit back into the paused agent loop (APP-050).
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
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        updateTaskCard(sid, cardId, { status: "done", output: `error: ${msg}` });
        agentRuns.resolveCommand(sid, cardId, { command, stderr: msg, exit: 1 });
      }
    },
    [activeId, updateTaskCard],
  );

  /** Deny a proposed command: mark the card + resume the loop with a denial note. */
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
          borderBottom: "1px solid var(--border-subtle, #232329)",
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
                border: `1px solid ${selected ? "var(--border-strong, #313139)" : "transparent"}`,
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
                    background: "var(--accent, #6d5ef0)",
                  }}
                />
              ) : agentRuns.getPaused(id) ? (
                <span
                  aria-hidden="true"
                  title="awaiting approval"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    flexShrink: 0,
                    border: "1.5px solid var(--warn, #d8a13a)",
                  }}
                />
              ) : null}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
                    color: "var(--text-secondary, #9a9aa3)",
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
            border: "1px solid var(--border-subtle, #232329)",
            borderRadius: 5,
            color: "var(--text-secondary, #9a9aa3)",
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
            background: showSessions ? "var(--bg-inset, #0b0b0e)" : "transparent",
            border: "1px solid var(--border-subtle, #232329)",
            borderRadius: 5,
            color: "var(--text-secondary, #9a9aa3)",
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
              border: "1px solid var(--border-subtle, #232329)",
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
                    border: "1px solid var(--border-subtle, #232329)",
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
        <span style={{ color: "var(--text-secondary, #9a9aa3)" }}>model:</span>
        <select
          value={endpointId ?? ""}
          onChange={(e) => selectEndpoint(e.target.value || null)}
          aria-label="model endpoint"
          style={{
            flex: 1,
            background: "var(--bg-surface-2, #16161b)",
            color: "var(--text-primary, #e7e7ea)",
            border: "1px solid var(--border-subtle, #232329)",
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
          <span style={{ color: "var(--text-secondary, #9a9aa3)" }}>no-cloud</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <input
            type="checkbox"
            checked={ghostText}
            onChange={(e) => setGhostText(e.target.checked)}
            aria-label="AI ghost-text completions"
          />
          <span style={{ color: "var(--text-secondary, #9a9aa3)" }}>ghost</span>
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
                    border: "1px solid var(--border-subtle, #232329)",
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
              <span style={{ color: "var(--text-secondary, #9a9aa3)" }}>
                {totals.totalTokens.toLocaleString()} tokens this session ·{" "}
                {totals.lastTurnTokens.toLocaleString()} last turn
                {isCloud ? " · cost unknown" : ""}
              </span>
            ) : (
              <span style={{ color: "var(--text-secondary, #9a9aa3)" }}>no usage yet</span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              aria-pressed={showProviders}
              onClick={() => setShowProviders((v) => !v)}
              style={{
                background: showProviders ? "var(--bg-inset, #0b0b0e)" : "transparent",
                border: "1px solid var(--border-subtle, #232329)",
                borderRadius: 4,
                color: "var(--text-secondary, #9a9aa3)",
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
            style={{ color: "var(--text-secondary, #9a9aa3)", alignSelf: "center" }}
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
            border: "1px solid var(--border-strong, #313139)",
            background: "var(--bg-surface-2, #16161b)",
            borderRadius: 6,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <strong style={{ fontSize: "0.82rem", color: "var(--text-primary, #e7e7ea)" }}>
            ⚠ No model backend connected
          </strong>
          <span style={{ fontSize: "0.76rem", color: "var(--text-secondary, #9a9aa3)" }}>
            {endpoints.length === 0
              ? "This chat needs a local model, an API endpoint, or an agent CLI — none is installed or served yet. Pick a path:"
              : "A model is available but none is selected. Choose one from the selector above to start chatting."}
          </span>
          {endpoints.length === 0 && (
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
        {turns.length === 0 && !streaming && active && (
          <p style={{ color: "var(--text-secondary, #9a9aa3)", fontSize: "0.8rem" }}>
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
            {t.role === "assistant" ? <Markdown source={t.content} /> : t.content}
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
                color: "var(--text-secondary, #9a9aa3)",
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
                  color: "var(--text-secondary, #9a9aa3)",
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
                  color: "var(--text-secondary, #9a9aa3)",
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
        {streaming && (
          <div
            style={{
              alignSelf: "flex-start",
              maxWidth: "90%",
              padding: "6px 8px",
              borderRadius: 6,
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
              background: "var(--bg-surface-2, #16161b)",
              color: "var(--text-primary, #e7e7ea)",
            }}
          >
            {streaming}
            <span aria-hidden="true">▍</span>
          </div>
        )}

        {/* the proposed-edit ChangeSet (§7.4) — a chip links to the review card */}
        {changeSet && (
          <button
            type="button"
            aria-label="review proposed edits"
            onClick={() =>
              diffRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
            }
            style={{
              alignSelf: "flex-start",
              padding: "3px 10px",
              borderRadius: 999,
              border: "1px solid var(--border-strong, #313139)",
              background: "color-mix(in srgb, var(--accent) 14%, var(--bg-surface-2))",
              color: "var(--text-primary, #e7e7ea)",
              cursor: "pointer",
              fontSize: "0.72rem",
            }}
          >
            ✎ edits proposed — {changeSet.edits.length} file
            {changeSet.edits.length === 1 ? "" : "s"} · review ↓
          </button>
        )}
        <div ref={diffRef}>
          <DiffReview />
        </div>

        {/* confirm-gated task cards (§7.3) */}
        {taskCards.map((card) => (
          <Panel key={card.id} title={`run_command · ${card.status}`} elevation="e1">
            <code style={{ fontSize: "0.72rem", display: "block", marginBottom: 4 }}>
              {card.cwd} $ {card.command}
            </code>
            {card.status === "pending" ? (
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void runCard(card.id, card.command, card.cwd)}
                >
                  ▶ Run (gated)
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
        ))}
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
      <div style={{ position: "relative" }}>
        {activeMention && mentionMatches.length > 0 && (
          <div
            aria-label="mention picker"
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              marginBottom: 4,
              maxHeight: 200,
              overflow: "auto",
              background: "var(--bg-surface-2, #16161b)",
              border: "1px solid var(--border-strong, #313139)",
              borderRadius: 6,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              zIndex: 20,
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
                  color: "var(--text-primary, #e7e7ea)",
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
          </div>
        )}
        {activeMention && activeMention.kind === "sym" && mentionMatches.length === 0 && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              marginBottom: 4,
              padding: "3px 8px",
              background: "var(--bg-surface-2, #16161b)",
              border: "1px solid var(--border-subtle, #232329)",
              borderRadius: 6,
              color: "var(--text-secondary)",
              fontSize: "0.7rem",
              zIndex: 20,
            }}
          >
            no indexed symbols — open files or build the repo map
          </div>
        )}
        {/* APP-092: `/` slash-command menu (executes a shell registry command). */}
        {slashQuery !== null && slashMatches.length > 0 && (
          <div
            aria-label="slash command menu"
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              marginBottom: 4,
              maxHeight: 240,
              overflow: "auto",
              background: "var(--bg-surface-2, #16161b)",
              border: "1px solid var(--border-strong, #313139)",
              borderRadius: 6,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              zIndex: 20,
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
                  color: "var(--text-primary, #e7e7ea)",
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
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          style={{ display: "flex", gap: 6 }}
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
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid var(--border-subtle, #232329)",
              background: "var(--bg-surface-2, #16161b)",
              color: "var(--text-primary, #e7e7ea)",
              resize: "none",
              maxHeight: "12rem",
              overflowY: "auto",
              fontFamily: "var(--font-ui, system-ui)",
              lineHeight: 1.4,
            }}
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!active || busy || !input.trim()}
          >
            send
          </Button>
        </form>
      </div>
    </div>
  );
}

export default AgentPane;
