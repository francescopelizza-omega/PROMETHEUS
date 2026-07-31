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

import type { ReviewChangeSet, ReviewFile, ReviewHunk } from "../state/diff-review-state.js";
import { reviewFileFromTexts } from "../state/diff-review-state.js";
import type { AiMsg, ChatTurnResult, RendererEndpoint, ToolCall } from "./ai-client.js";
import { runChatTurn } from "./ai-client.js";

/** The agent's system prompt (read-before-act; edits are reviewed; commands need approval). */
export const AGENT_SYSTEM =
  "You are a coding agent inside Prometheus Studio. You can call tools to read files, " +
  "list directories, propose file edits (propose_edit — the user reviews the diff and " +
  "applies it; the tool itself never writes to disk), and PROPOSE shell commands (the " +
  "user must approve each command before it runs). Prefer reading the relevant files " +
  "before acting. When you have enough information, answer the user directly without " +
  "calling a tool.";

/** The OpenAI function-tool schemas the model is offered. */
export const AGENT_TOOLS: readonly unknown[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file in the workspace and return its contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "workspace-relative or absolute path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries (files + folders) of a directory in the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "directory path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search the workspace for files whose CONTENT contains a substring; returns " +
        "matching file:line locations. Use to find where something is defined or used.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "the substring to search for" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_edit",
      description:
        "Propose edits to ONE file as a reviewable diff. NOTHING is written to disk — " +
        "the user reviews and applies hunks in the Diff Review panel, so keep working " +
        "after calling this. Each edit replaces oldText (an EXACT, UNIQUE substring of " +
        "the current file — include surrounding lines to make it unique) with newText. " +
        "To create a new file, send exactly one edit with an empty oldText and the full " +
        "file content as newText.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "workspace-relative file path (never absolute)",
          },
          edits: {
            type: "array",
            description: "the edits to apply to this file (length 1 for a single edit)",
            items: {
              type: "object",
              properties: {
                oldText: {
                  type: "string",
                  description:
                    "exact unique span of the current file ('' only when creating a new file)",
                },
                newText: { type: "string", description: "the replacement text" },
              },
              required: ["oldText", "newText"],
            },
          },
          description: {
            type: "string",
            description: "one-line rationale shown to the reviewer",
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Propose a shell command to run in the workspace root. It does NOT run until " +
        "the user approves it. Use for tests, builds, linters, git status, etc.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "the shell command line" } },
        required: ["command"],
      },
    },
  },
];

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
  proposeCommand(command: string): string;
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
export interface AgentLoopDeps {
  endpoint: RendererEndpoint;
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
  /** max model round-trips before the loop stops (default 6). */
  maxIters?: number;
  /** injectable turn-runner (defaults to runChatTurn) — lets tests script turns. */
  runTurn?: (
    endpoint: RendererEndpoint,
    messages: AiMsg[],
    opts: {
      tools?: unknown[];
      neverSendToCloud?: boolean;
      signal?: AbortSignal;
      onText?: (d: string) => void;
    },
  ) => Promise<ChatTurnResult>;
}

/** Defensively parse a tool call's JSON-string arguments → an object. */
export function parseToolArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const o = JSON.parse(tc.arguments || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The cap for a tool RESULT fed back into the loop (mirrors readFile's 8000-char cap). */
export const TOOL_OUTPUT_CAP = 8000;

/**
 * Byte-cap a string, truncating from the MIDDLE (keep head + tail with a marker). A
 * command's error/exit context is usually at the TAIL, so head-only truncation would
 * hide the reason the model needs. Pure.
 */
export function truncateMiddle(text: string, cap = TOOL_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const keep = Math.max(0, cap - 24);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const elided = text.length - keep;
  return `${text.slice(0, head)}\n…[${elided} chars elided]…\n${text.slice(text.length - tail)}`;
}

/** A pending, human-gated command from a paused turn (carried through resume). */
export interface PendingCommand {
  command: string;
}

/** The result of running (or denying) one approved command. */
export interface CommandResult {
  command: string;
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** the user denied the command → the model re-plans instead of hanging. */
  denied?: boolean;
}

/**
 * Format ONE command result as a tool-result message mirroring the loop's existing
 * `[tool <name> …]` envelope (or the model won't recognize it and re-proposes). Always
 * includes `exit <code>` (a missing exit reads as "still running"), labels stdout vs
 * stderr, and mid-truncates the combined output to TOOL_OUTPUT_CAP.
 */
export function formatCommandResult(r: CommandResult): string {
  if (r.denied) {
    return `[tool run_command ${r.command}] denied by user — do not retry this command; re-plan or ask the user.`;
  }
  const parts: string[] = [`exit ${r.exit ?? 0}`];
  if (r.stdout?.length) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr?.length) parts.push(`stderr:\n${r.stderr}`);
  return `[tool run_command ${r.command}]\n${truncateMiddle(parts.join("\n"))}`;
}

/** The outcome of a (possibly resumable) agent loop run. */
export type AgentLoopOutcome =
  | { status: "done" }
  | {
      /** the model proposed command(s); the loop waits for the human to Run/Deny each. */
      status: "paused";
      /** the FULL conversation so far (resume continues honoring maxIters). */
      convo: AiMsg[];
      pending: PendingCommand[];
      /** iterations consumed (so resume continues from here, never a fresh budget). */
      itersUsed: number;
    };

/** The core iteration engine, shared by runAgentLoop + resumeAgentLoop. */
async function iterate(
  convo: AiMsg[],
  deps: AgentLoopDeps,
  startIter: number,
  maxIters: number,
): Promise<AgentLoopOutcome> {
  const runTurn = deps.runTurn ?? runChatTurn;
  for (let iter = startIter; iter < maxIters; iter++) {
    if (deps.signal.aborted) return { status: "done" };
    const turn = await runTurn(deps.endpoint, convo, {
      tools: AGENT_TOOLS as unknown[],
      neverSendToCloud: deps.neverSendToCloud,
      signal: deps.signal,
      onText: deps.onText,
    });
    const { text, toolCalls } = turn;
    if (turn.usage) deps.onUsage?.(turn.usage); // APP-055: fold usage into the spend meter
    if (text.trim()) {
      convo.push({ role: "assistant", content: text });
      deps.onTurnComplete();
    }
    if (toolCalls.length === 0) return { status: "done" }; // a plain answer → done

    const pending: PendingCommand[] = [];
    for (const tc of toolCalls) {
      if (deps.signal.aborted) return { status: "done" };
      const args = parseToolArgs(tc);
      if (tc.name === "read_file") {
        const path = String(args.path ?? "");
        deps.onToolNote(`read ${path}`);
        const content = await deps.tools.readFile(path);
        convo.push({ role: "user", content: `[tool read_file ${path}]\n${content}` });
      } else if (tc.name === "list_dir") {
        const path = String(args.path ?? "");
        deps.onToolNote(`list ${path}`);
        const listing = await deps.tools.listDir(path);
        convo.push({ role: "user", content: `[tool list_dir ${path}]\n${listing}` });
      } else if (tc.name === "grep") {
        const query = String(args.query ?? "");
        deps.onToolNote(`grep "${query}"`);
        const out = await deps.tools.grep(query);
        convo.push({ role: "user", content: `[tool grep ${query}]\n${out}` });
      } else if (tc.name === "propose_edit") {
        const parsed = parseProposeEditArgs(args);
        if (!parsed.ok) {
          deps.onToolNote(`✎ propose_edit rejected: ${parsed.error}`);
          convo.push({ role: "user", content: `[tool propose_edit] error: ${parsed.error}` });
        } else {
          deps.onToolNote(`✎ edit ${parsed.edit.path}`);
          const note = await deps.tools.proposeEdit(parsed.edit);
          convo.push({ role: "user", content: `[tool propose_edit ${parsed.edit.path}]\n${note}` });
        }
        // review is ASYNC (§7.4) — the loop keeps going; only run_command pauses.
      } else if (tc.name === "run_command") {
        const command = String(args.command ?? "");
        deps.onToolNote(deps.tools.proposeCommand(command));
        pending.push({ command }); // human-in-the-loop: collect, then pause after this turn
      } else {
        convo.push({ role: "user", content: `[tool ${tc.name}] unsupported tool; ignored.` });
      }
    }
    // Pause AFTER the whole turn's tool calls so ALL proposed commands are carried
    // together (resume once with all results → provider-safe tool-call/result ordering).
    if (pending.length) return { status: "paused", convo, pending, itersUsed: iter + 1 };
  }
  deps.onToolNote("(agent reached the step limit — ask it to continue if needed)");
  return { status: "done" };
}

/**
 * Run the agent loop over `messages` (which must already include the system prompt +
 * the user's request). Streams text, auto-runs read-only tools + feeds results back,
 * and PAUSES (returns `{status:"paused", …}`) when the model proposes command(s) — a
 * task card awaits the human; the caller resumes via `resumeAgentLoop`.
 */
export async function runAgentLoop(
  messages: AiMsg[],
  deps: AgentLoopDeps,
): Promise<AgentLoopOutcome> {
  return iterate([...messages], deps, 0, deps.maxIters ?? 6);
}

/**
 * Resume a PAUSED loop after the user Ran or Denied the proposed command(s). Appends one
 * tool-result message per pending command (POSITIONALLY matched to `results`; a missing
 * result is treated as denied) then re-enters the SAME loop from `itersUsed`, honoring
 * the remaining maxIters budget. Abort-while-paused (stop / new prompt) drops cleanly.
 */
export async function resumeAgentLoop(
  paused: { convo: AiMsg[]; pending: PendingCommand[]; itersUsed: number },
  results: CommandResult[],
  deps: AgentLoopDeps,
): Promise<AgentLoopOutcome> {
  if (deps.signal.aborted) return { status: "done" }; // the user hit stop / re-prompted
  const convo: AiMsg[] = [...paused.convo];
  paused.pending.forEach((cmd, i) => {
    const r = results[i];
    convo.push({
      role: "user",
      content: formatCommandResult(
        r ? { ...r, command: cmd.command } : { command: cmd.command, denied: true },
      ),
    });
  });
  return iterate(convo, deps, paused.itersUsed, deps.maxIters ?? 6);
}
