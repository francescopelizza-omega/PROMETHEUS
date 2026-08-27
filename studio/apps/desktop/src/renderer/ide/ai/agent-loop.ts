/**
 * ide/ai/agent-loop.ts — the agentic tool-calling loop (file 07 §7.2/§7.3, leap #2).
 *
 * Turns the chat pane into an AGENT: the model may call tools to read files / list
 * directories (auto, read-only), to propose file EDITS (propose_edit — validated,
 * hunked and handed to the §7.4 DiffReview ChangeSet; the tool NEVER writes disk, the
 * user applies), and to propose a shell command (run_command), which is
 * NEVER auto-run — it becomes a confirm-gated §7.3 task card the user must approve
 * (executed via the screened, hardened `ide.exec`). The loop feeds tool results back as
 * `user`-role context (the AiMsg union has no "tool" role, and many local models don't
 * implement the tool/tool_call_id protocol — plain context is model-agnostic + robust).
 *
 * Bounded (maxIters) and pause-on-approval: when the model asks to run a command the
 * auto-loop STOPS and waits for the human; nothing executes without a click. The
 * turn-runner is injectable so the orchestration is unit-testable without a model.
 *
 * Pattern reference: Continue/Cline/OpenHands agentic loops (Apache-2.0 / MIT) — the
 * shape only, no code copied. Renderer-SANDBOXED (C5).
 */

import { AGENT_TOOL_DISCIPLINE } from "@prometheus/core/agent-loop";
import type { EffortResolution } from "@prometheus/core/ai-effort";
import type {
  AgentCanaryTripRequest,
  AgentCanaryTripResult,
  AgentEngineToolRequest,
  AgentGrant,
  AgentGrantsResult,
  AgentHookRunRequest,
  AgentHookRunResult,
  AgentSystemToolRequest,
  AgentSystemToolResult,
  IdeAgentFilesListResult,
  McpAgentCallRequest,
  McpAgentToolsResult,
} from "../../../shared/ipc-contract.js";
import type { ReviewChangeSet, ReviewFile, ReviewHunk } from "../state/diff-review-state.js";
import { reviewFileFromTexts } from "../state/diff-review-state.js";

import type { AiMsg, ChatTurnResult, RendererEndpoint, ToolCall } from "./ai-client.js";
import { runChatTurn, splitTiming } from "./ai-client.js";

// re-exported: run-controller builds a message list for the loop and should take its shape
// from the module that defines the loop's inputs, not reach past it into the transport.
export type { AiMsg } from "./ai-client.js";

/** The agent's system prompt (read-before-act; edits are reviewed; commands need approval). */
/**
 * §9 ("GUI chat = CLI agent"): the tool-discipline half is now the SHARED constant from
 * `@prometheus/core/agent-loop`, so the GUI stops maintaining a weaker paraphrase of the
 * rules the CLI learned the hard way — in particular "printing does nothing on disk",
 * which the previous GUI prompt never said.
 *
 * The surrounding sentences describe THIS surface's actual tools and are deliberately
 * narrower than the CLI's: the desktop has no `write_file` and no prometheus verbs (the
 * preload exposes fixed verbs only — there is no generic engine channel yet), so promising
 * them would have the model narrate actions it cannot take.
 */
/** The OpenAI function-tool schemas the model is offered. */
/** The side-effecting tool implementations the loop drives (injected by AgentPane). */
export interface AgentTools {
  /** read a file → its contents (already capped/normalized by the caller). */
  readFile(path: string): Promise<string>;
  /** list a directory → a newline list of entries. */
  listDir(path: string): Promise<string>;
  /** grep file CONTENT → matching file:line locations. */
  grep(query: string): Promise<string>;
  /** stage a validated edit into the §7.4 review ChangeSet (NEVER writes disk) → note. */
  proposeEdit(edit: ProposedEdit): Promise<string>;
  /** create a pending, confirm-gated task card for `command`; return a short note. */
  proposeCommand(command: string, tool?: string, args?: Record<string, unknown>): string;
  /**
   * Mint a QUESTION card and register it, so the controller can suspend the turn on it.
   *
   * Optional: a host without a question surface simply has no `question` tool, and the model
   * is told so rather than left waiting for an answer nobody can give.
   */
  askQuestion?(prompt: string): void;
}

/* ── propose_edit — validation + hunk math (pure; the fail-closed §7.4 seam) ─────────
 * The tool NEVER writes disk: it turns exact old/new spans into ReviewHunks (the
 * locally-mirrored plain shapes of diff-review-state — the renderer never imports
 * core's runtime, C5) and hands the accumulated ChangeSet to the store. The ONLY
 * disk-mutation route stays the user-approved Apply in DiffReview. */

/** One exact-span replacement ('' oldText only when creating a new file). */
export interface ProposedEditSpan {
  oldText: string;
  newText: string;
}

/** A validated propose_edit call: a workspace-relative path + its spans. */
export interface ProposedEdit {
  path: string;
  spans: ProposedEditSpan[];
  description?: string;
}

/**
 * Lexically normalize a model-supplied path to workspace-relative form, or null if it
 * is absolute / escapes the root. Absolute paths are REJECTED outright (models often
 * emit them; silently relativizing can retarget the wrong file). Dot segments resolve
 * BEFORE the containment decision, so `a/../../x` is caught. The renderer has no
 * node:path (C5); main's path-guarded fs IPC re-enforces on any later read.
 */
export function normalizeWorkspaceRelPath(p: string): string | null {
  if (!p || p.startsWith("file://") || p.startsWith("~")) return null;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p)) return null;
  const out: string[] = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // would climb above the workspace root
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.length > 0 ? out.join("/") : null;
}

/** Validate raw propose_edit tool args → a ProposedEdit, or a model-actionable error. */
/**
 * Parse `apply_patch`'s `edits: [{path, hunks:[{old,new}]}]` into per-file proposed edits.
 *
 * The CLI applies a multi-file patch itself, two-phase, because it writes to disk directly and
 * has to guarantee that a half-applied tree is impossible. The desktop does not need that
 * machinery and should not copy it: every edit here lands in the SAME review ChangeSet, and the
 * user's single Apply in DiffReview is already the atomic step. Reusing the review queue also
 * means a multi-file patch is approved the way every other edit is, rather than through a second
 * surface the user has to learn.
 *
 * Note the field names differ from `propose_edit` — core's `EditHunk` is `{old, new}` while the
 * renderer's span is `{oldText, newText}`. They are the same idea and the mapping is one-for-one;
 * accepting both spellings here would be inviting a model to guess.
 */
export function parseApplyPatchArgs(
  args: Record<string, unknown>,
): { ok: true; edits: ProposedEdit[] } | { ok: false; error: string } {
  const raw = args.edits;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? (() => {
          // Models send a JSON string for an array constantly; losing the whole patch over that
          // is a far worse outcome than a lenient parse (the same tolerance parseHunks has).
          try {
            const p: unknown = JSON.parse(raw);
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
      : [];
  if (list.length === 0) {
    return { ok: false, error: "edits must be a non-empty array of {path, hunks:[{old,new}]}" };
  }
  const out: ProposedEdit[] = [];
  for (const entry of list) {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e !== "object") return { ok: false, error: "each entry must be an object" };
    const rawPath = typeof e.path === "string" ? e.path.trim() : "";
    if (!rawPath) return { ok: false, error: "each entry needs a path" };
    const rel = normalizeWorkspaceRelPath(rawPath);
    if (rel === null) {
      return {
        ok: false,
        error: `path must be workspace-relative and stay inside the workspace (got "${rawPath}")`,
      };
    }
    const hunks = Array.isArray(e.hunks) ? e.hunks : [];
    if (hunks.length === 0) return { ok: false, error: `no hunks for ${rawPath}` };
    const spans: ProposedEditSpan[] = [];
    for (const h of hunks) {
      const o = h as Record<string, unknown> | null;
      if (!o || typeof o !== "object" || typeof o.old !== "string" || typeof o.new !== "string") {
        return { ok: false, error: "each hunk needs a string `old` and a string `new`" };
      }
      spans.push({ oldText: o.old, newText: o.new });
    }
    out.push({ path: rel, spans });
  }
  return { ok: true, edits: out };
}

export function parseProposeEditArgs(
  args: Record<string, unknown>,
): { ok: true; edit: ProposedEdit } | { ok: false; error: string } {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) return { ok: false, error: "path is required" };
  const rel = normalizeWorkspaceRelPath(rawPath);
  if (rel === null) {
    return {
      ok: false,
      error: `path must be workspace-relative and stay inside the workspace (got "${rawPath}")`,
    };
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    return { ok: false, error: "edits must be a non-empty array of {oldText, newText}" };
  }
  const spans: ProposedEditSpan[] = [];
  for (const raw of args.edits) {
    const o = raw as Record<string, unknown> | null;
    if (
      !o ||
      typeof o !== "object" ||
      typeof o.oldText !== "string" ||
      typeof o.newText !== "string"
    ) {
      return { ok: false, error: "each edit needs a string oldText and a string newText" };
    }
    spans.push({ oldText: o.oldText, newText: o.newText });
  }
  const description =
    typeof args.description === "string" && args.description.trim()
      ? args.description.trim()
      : undefined;
  return { ok: true, edit: { path: rel, spans, description } };
}

/** Do any two hunks (sorted by originalStart) claim the same original lines? */
function hunksOverlap(sorted: readonly ReviewHunk[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && prev.originalStart + prev.originalLines > cur.originalStart) return true;
  }
  return false;
}

/**
 * Turn exact spans over `original` into a ReviewFile of whole-line hunks (the splice
 * unit of applyReviewFile). `original === null` means the file does not exist: only a
 * single ''-oldText span is accepted (a NEW file — untrusted-until-gated downstream).
 * Every oldText must be a UNIQUE substring (the Edit-tool uniqueness contract); a
 * miss/dup returns a clear error so the model retries with more context. Pure.
 */
export function buildReviewFile(
  uri: string,
  original: string | null,
  spans: readonly ProposedEditSpan[],
  idBase: string,
): { ok: true; file: ReviewFile } | { ok: false; error: string } {
  if (original === null) {
    const only = spans.length === 1 ? spans[0] : undefined;
    if (!only || only.oldText !== "") {
      return {
        ok: false,
        error:
          'file does not exist — to create it, send exactly one edit with oldText "" ' +
          "and the full file content as newText",
      };
    }
    if (only.newText === "") {
      // an EMPTY new file would hunk to zero lines and never be written — keep one
      // explicit all-add hunk so accepting it still creates the (empty) file.
      const hunk: ReviewHunk = {
        id: `${idBase}-0`,
        originalStart: 0,
        originalLines: 0,
        oldLines: [],
        newLines: [""],
      };
      return { ok: true, file: { uri, isNew: true, hunks: [hunk] } };
    }
    // whole-file content goes through the canonical (uri, before, after) converter.
    return { ok: true, file: reviewFileFromTexts(uri, "", only.newText, idBase) };
  }
  const hunks: ReviewHunk[] = [];
  for (const [i, s] of spans.entries()) {
    if (s.oldText === "") {
      return {
        ok: false,
        error:
          'oldText must be a non-empty exact span of the current file ("" is only for ' +
          "creating a new file)",
      };
    }
    const first = original.indexOf(s.oldText);
    if (first === -1) {
      return {
        ok: false,
        error: `oldText #${i + 1} not found — re-read the file and copy an exact span`,
      };
    }
    if (original.indexOf(s.oldText, first + 1) !== -1) {
      return {
        ok: false,
        error: `oldText #${i + 1} occurs more than once — include more surrounding context to make it unique`,
      };
    }
    // expand the matched span to WHOLE lines (hunks splice whole lines).
    const lineStart = original.lastIndexOf("\n", first - 1) + 1;
    const end = first + s.oldText.length;
    const nlAfter = original.indexOf("\n", end);
    const lineEnd = nlAfter === -1 ? original.length : nlAfter;
    const oldBlock = original.slice(lineStart, lineEnd);
    const newBlock = original.slice(lineStart, first) + s.newText + original.slice(end, lineEnd);
    // a no-op span (oldText === newText) contributes ZERO hunks — the pane shows
    // "no changes", never a phantom hunk whose accept would rewrite identical lines.
    if (newBlock === oldBlock) continue;
    hunks.push({
      id: `${idBase}-${i}`,
      originalStart: original.slice(0, lineStart).split("\n").length - 1,
      originalLines: oldBlock.split("\n").length,
      oldLines: oldBlock.split("\n"),
      // '' = the whole line range was deleted → an empty splice (not one blank line).
      newLines: newBlock === "" ? [] : newBlock.split("\n"),
    });
  }
  hunks.sort((a, b) => a.originalStart - b.originalStart);
  if (hunksOverlap(hunks)) {
    return {
      ok: false,
      error: "edits overlap on the same lines — merge them into one {oldText, newText} span",
    };
  }
  return { ok: true, file: { uri, hunks } };
}

/** The injected effects createProposeEditTool composes (all read-only or store-only). */
export interface ProposeEditSink {
  /** current on-disk content of a file:// uri, or null if missing/unreadable. */
  readOriginal(uri: string): Promise<string | null>;
  /** hand the accumulated ChangeSet to the OWNING session's store slot. */
  dispatch(cs: ReviewChangeSet): void;
  /** file:// uri for a validated workspace-relative path. */
  toUri(relPath: string): string;
  /** stable ChangeSet id for this agent turn. */
  changeSetId: string;
  /** the session's CURRENTLY-pending changeset id (null when none). Lets the tool
   *  drop its accumulated entries once the user Applied/Discarded them mid-run —
   *  re-dispatching them would resurrect stale-anchored hunks as pending again. */
  currentChangeSetId?(): string | null;
}

/**
 * Build the AgentTools.proposeEdit implementation for ONE agent turn: each call is
 * validated + hunked against the CURRENT disk content and accumulated into a single
 * ReviewChangeSet, re-dispatched (whole) after every successful call so the review
 * panel always shows the full picture. Disk is never touched here — `dispatch` only
 * stores state; the user's Apply in DiffReview is the sole write path (§7.4).
 */
export function createProposeEditTool(
  sink: ProposeEditSink,
): (edit: ProposedEdit) => Promise<string> {
  const byUri = new Map<string, ReviewFile>();
  const rationales: string[] = [];
  let seq = 0;
  let dispatchedOnce = false;
  return async (edit: ProposedEdit): Promise<string> => {
    // if the user Applied or Discarded this turn's set mid-run (the pane no longer
    // holds OUR changeset id), the accumulated entries are anchored to a disk state
    // that no longer exists — drop them so the next dispatch can't resurrect them.
    if (dispatchedOnce && sink.currentChangeSetId) {
      const live = sink.currentChangeSetId();
      if (live !== sink.changeSetId) {
        byUri.clear();
        rationales.length = 0;
      }
    }
    const uri = sink.toUri(edit.path);
    const original = await sink.readOriginal(uri);
    const built = buildReviewFile(uri, original, edit.spans, `pe${seq++}`);
    if (!built.ok) return `✗ ${edit.path}: ${built.error}`;
    const prev = byUri.get(uri);
    let next = built.file;
    if (prev && !prev.isNew && !built.file.isNew) {
      // a later call touching the same EXISTING file merges (both hunk sets are
      // anchored to the same on-disk original); a re-proposed NEW file replaces.
      const merged = [...prev.hunks, ...built.file.hunks].sort(
        (a, b) => a.originalStart - b.originalStart,
      );
      if (hunksOverlap(merged)) {
        return `✗ ${edit.path}: an earlier proposed edit already touches those lines — combine them into one propose_edit call`;
      }
      next = { ...prev, hunks: merged };
    }
    byUri.set(uri, next);
    if (edit.description) rationales.push(edit.description);
    sink.dispatch({
      id: sink.changeSetId,
      rationale: rationales.join(" · ") || "agent-proposed edits",
      edits: [...byUri.values()],
    });
    dispatchedOnce = true;
    const n = built.file.hunks.length;
    const plural = n === 1 ? "" : "s";
    const isNew = built.file.isNew ? " (new file)" : "";
    return `✓ proposed ${n} edit${plural} to ${edit.path}${isNew} — pending user review in Diff Review; nothing is written until the user applies.`;
  };
}

/** Streaming + transcript callbacks the loop emits into. */
/** The result of running (or denying) one human-approved command. */
export interface CommandResult {
  command: string;
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** the user denied the command → core re-plans instead of the loop hanging. */
  denied?: boolean;
  /** a question card's typed answer. Absent/empty is a real answer ("nothing"), not an error. */
  answer?: string;
  /** the user chose "always allow" — the scope to remember this approval at. */
  remember?: "project" | "user";
  /**
   * The UNMAPPED result main returned, carried through so the tool runner can replay it
   * faithfully instead of reconstructing it from stdout/stderr/exit.
   *
   * The `verdict` is why this exists and it is load-bearing: core's loop ABORTS the turn on a
   * `block` (`agent/loop.ts:372`). Flattening a tool result into text loses it, so a blocked
   * command would come back looking like an ordinary failure and the turn would continue.
   */
  raw?: AgentSystemToolResult;
}

export interface AgentLoopDeps {
  endpoint: RendererEndpoint;
  /**
   * Phase 6: the bridge to core's shared system tools in main, and the workspace root they
   * run against. The pane passes `window.prometheus.ide`; a test passes a fake. Optional so
   * a headless/harness context degrades to "unavailable" rather than throwing.
   */
  /**
   * The MCP surface: the tool descriptors the pane turns into defs, and the one call channel.
   *
   * Separate from `ide` because it is a separate main-side module with its own manager and its
   * own lifecycle — folding it in would make the pane's one optional seam mean two things.
   */
  mcp?: {
    agentTools(): Promise<McpAgentToolsResult>;
    agentCall(req: McpAgentCallRequest): Promise<AgentSystemToolResult>;
  };
  ide?: {
    systemTool(req: AgentSystemToolRequest): Promise<AgentSystemToolResult>;
    /** run one `prometheus_*` verb through the engine (no cwd — the verbs are machine-global). */
    engineTool(req: AgentEngineToolRequest): Promise<AgentSystemToolResult>;
    /** the persisted "don't ask again" grants, shared on disk with the CLI. */
    grantsList?(): Promise<AgentGrantsResult>;
    grantsAdd?(grant: AgentGrant): Promise<AgentGrantsResult>;
    /** Task #5 (desktop parity): sub-agent personas from markdown for `spawn_agent`, via the
     *  SAME `@prometheus/core/agent-files` clamping the CLI applies. Optional so a headless
     *  harness degrades to "no personas" rather than throwing. */
    agentFilesList?(root: string): Promise<IdeAgentFilesListResult>;
    /** list/run the user's lifecycle hooks — MAIN spawns; the renderer only proxies.
     *  Optional so a harness (or an older preload) degrades to "no hooks", never a throw. */
    hookRun?(req: AgentHookRunRequest): Promise<AgentHookRunResult>;
    /** record a tripped canary token (point 6b) — MAIN owns the audit disk, not the renderer.
     *  Optional so a harness (or an older preload) degrades to "not recorded", never a throw. */
    canaryTrip?(req: AgentCanaryTripRequest): Promise<AgentCanaryTripResult>;
  };
  root?: string;
  neverSendToCloud: boolean;
  signal: AbortSignal;
  tools: AgentTools;
  /** stream an assistant text delta (token-by-token). */
  onText(delta: string): void;
  /** a finished assistant text turn is complete (commit the streamed buffer). */
  onTurnComplete(): void;
  /** a visible tool-activity note for the transcript. */
  onToolNote(note: string): void;
  /** APP-055: a turn reported token usage (fed to the session spend meter). */
  onUsage?(usage: { inputTokens: number; outputTokens: number; totalTokens: number }): void;
  /**
   * handoff §3: the run's measured phase totals, emitted once when the loop settles.
   * `wrapper` is the residual — total wall time minus what model/load/tools accounted
   * for — so the four legs always sum to the real elapsed time and the bar cannot lie.
   */
  onPhases?(p: { model: number; load: number; tools: number; wrapper: number }): void;
  /** max model round-trips before the loop stops (default 6). */
  maxIters?: number;
  /** the composer's resolved reasoning effort for THIS endpoint (handoff §2.5 chip) —
   *  forwarded verbatim to every turn so a run's depth is the depth the chip showed. */
  effort?: EffortResolution;
}

/**
 * The retired fork.
 *
 * `parseToolArgs`, `TOOL_OUTPUT_CAP`, `truncateMiddle`, `formatCommandResult`,
 * `PendingCommand`, `AgentLoopOutcome`, `runAgentLoop` and `resumeAgentLoop` used to live
 * below this line: a second agent loop, with its own char-based output cap, its own
 * pause/resume snapshot, its own `{role:"user"}` pseudo-tool-results, and none of the
 * broker / --force / gate invariants core enforces. It is gone (HANDOFF_2 §9c) — the pane
 * runs `@prometheus/core/agent-loop` via `ai/core-agent.ts`.
 *
 * What survives here is what was never part of the loop: the propose-edit tool (argument
 * parsing, the workspace-relative path guard, the review-file builder, the sink) and the
 * `AgentTools` / `AgentLoopDeps` shapes the pane and the run controller pass around.
 */
