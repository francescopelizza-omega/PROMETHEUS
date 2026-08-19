/**
 * ide/ai/core-agent.ts — the agent pane runs CORE's loop (HANDOFF_2 §9c).
 *
 * The pane used to drive its own `agent-loop.ts`: a for-loop that streamed a turn, matched
 * `tc.name` against four hard-coded strings, and pushed `{role:"user"}` pseudo-tool-results
 * back into the conversation. It worked, and it was missing every invariant the CLI agent
 * enforces:
 *
 *   - **the --force ban (§4)** — the fork had none, so a model that emitted
 *     `{"force": true}` got it forwarded verbatim. Core refuses the call outright.
 *   - **the §4.3 tool broker** — the fork's approval logic was "is the name run_command".
 *     Core classifies by ANNOTATION, so read-only is the only auto path and anything
 *     destructive always reaches a human. A tool added later is safe by default rather
 *     than by whoever remembers to add a branch.
 *   - **the nemesis gate abort** — a BLOCK verdict aborts the call in core. The fork had
 *     no notion of a verdict at all.
 *   - **byte-accurate output capping** — 16KB on UTF-8 boundaries, versus the fork's 8000
 *     JS chars (which splits surrogate pairs and under-counts multibyte output badly).
 *   - **`{role:"tool"}` messages and the `capped` event** — the fork disguised tool output
 *     as user turns and announced its step limit as a chat note.
 *
 * What this module is: the two INJECTED seams core's `runAgentTurn` asks for — an
 * `LLMClient` and a `ToolRunner` — implemented against the renderer's bridge, plus the
 * editor-local tool DEFINITIONS (read_file / list_dir / grep / run_command) that only make
 * sense in an editor and are therefore passed as `tools.extra` rather than added to the
 * shared catalog.
 *
 * Renderer-SANDBOXED (C5): `@prometheus/core/agent-loop` and `/agent-tools` are node-free
 * (verified by an import-graph walk); the model request itself goes through
 * `window.prometheus.ai` and runs in main.
 */

import type { LoadedAgent } from "@prometheus/core/agent-files";
import type {
  AgentTuning,
  ConfirmResult,
  HookRunner,
  HookSpec,
  LLMClient,
  LlmTurn,
  PermissionModeId,
  Thread,
  ToolCall,
  ToolOutcome,
} from "@prometheus/core/agent-loop";
import { AGENT_TOOL_DISCIPLINE, runAgentTurn } from "@prometheus/core/agent-loop";
import { APPLY_PATCH_TOOL } from "@prometheus/core/agent-patch";
import type {
  ScanEvent,
  TextToolCall,
  ToolCapabilityState,
  ToolTransport,
} from "@prometheus/core/agent-protocol";
import {
  ToolCallScanner,
  toOpenAiTool as coreToOpenAiTool,
  initialCapability,
  negotiateTransport,
  observeTurn,
  parseMcpToolName,
  preambleModeFor,
  renderToolPreamble,
  withToolPreamble,
} from "@prometheus/core/agent-protocol";
import { NO_ASKER_MESSAGE, QUESTION_TOOL } from "@prometheus/core/agent-question";
import { SPAWN_AGENT_TOOL } from "@prometheus/core/agent-subagent";
import {
  BROWSER_TOOLS,
  SYSTEM_FS_WRITE_TOOLS,
  SYSTEM_MEMORY_TOOLS,
  SYSTEM_TOOLS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  isHostDispatchTool,
} from "@prometheus/core/agent-system";
import { TODO_TOOLS } from "@prometheus/core/agent-todo";
import { ENGINE_VERBS, type ToolDef, isEngineVerb } from "@prometheus/core/agent-tools";
import type { EffortResolution } from "@prometheus/core/ai-effort";
import { NOTEBOOK_EDIT_TOOL, NOTEBOOK_EDIT_TOOL_NAME } from "../notebook/notebook-tool.js";

import type { AgentSystemToolResult } from "../../../shared/ipc-contract.js";

import { type AgentTools, parseApplyPatchArgs, parseProposeEditArgs } from "./agent-loop.js";
import { type AiMsg, type RendererEndpoint, runChatTurn, splitTiming } from "./ai-client.js";

/* ── the tools: core's shared set (Phase 6) ──────────────────────────────────*/

/**
 * Studio exposes core's `SYSTEM_TOOLS` — the SAME list the CLI exposes, from the same file.
 *
 * What this replaced: four ToolDefs declared right here, with their own schemas and their
 * own descriptions, dispatched to `ide:exec` → `spawn(shell, ["-c", command])` behind an
 * 11-pattern regex denylist. They had drifted from core's in every way that mattered —
 * `run_command` here took `{command, cwd}` while core's takes `{command, cwd,
 * timeoutSeconds, mode}`; this one was annotated `destructiveHint` while core's classifies
 * as `command`; and this one's description said "run a shell command" when core's runs no
 * shell at all. The two lists were never going to converge by being maintained carefully in
 * parallel — that IS what produced the drift — so there is now one list and one dispatcher.
 *
 * The definitions are node-free (`agent/system/tools.ts` is pure data), so the C5-sandboxed
 * renderer can import them directly. The IMPLEMENTATION lives in main and is reached over
 * `window.prometheus.ide.systemTool`, which is the only shape the sandbox permits.
 */
export const EDITOR_TOOLS: readonly ToolDef[] = [
  ...SYSTEM_TOOLS,
  // Tier W. These were CLI-local until the implementation moved into core's `runSystemTool`,
  // which is why the pane could read, edit and write a file but not remove or rename one — a
  // refactor had to detour through `run_command`, a shell at a higher tier for a structured op.
  ...SYSTEM_FS_WRITE_TOOLS,
  // Durable cross-session memory (`memory_write`/`memory_read`) — same core dispatch the CLI
  // uses via `runSystemTool`, reached here over the same `agent:systemTool` IPC channel as
  // every other host-dispatched tool.
  ...SYSTEM_MEMORY_TOOLS,
  ...TODO_TOOLS,
  APPLY_PATCH_TOOL,
  // `web_search` is not in the base catalogue (the CLI adds it as `extra` too); `web_fetch` is,
  // so it needs no entry here — only a place in the allow-list below.
  WEB_SEARCH_TOOL,
  // browser_navigate / browser_screenshot / browser_extract_text — desktop-only (the CLI has
  // no browser to drive), and a SCOPED MVP: drive the agent's own isolated tab to a URL, then
  // look at it or read it. No click/type — see `agent/browser.ts`'s header for why that is
  // deliberate. `navigate` reaches main's fail-closed L6 proxy exactly as `web_fetch` does.
  ...BROWSER_TOOLS,
  // Delegation and asking. Both were CLI-only, and both are ordinary tools rather than chat
  // conventions: without `question` a model facing an ambiguity either guesses or stalls, and
  // without `spawn_agent` a wide subtask has to be done inline, burning the parent's window.
  SPAWN_AGENT_TOOL,
  QUESTION_TOOL,
  /**
   * Notebooks. Desktop-only for the same reason the browser tools are: the pipeline it drives
   * (`parseIpynb` → mutate → `serializeIpynb`, via the notebook store) lives in the renderer,
   * and the CLI has no notebook surface at all. Without it a model asked to fix a cell reached
   * for `write_file` and rewrote the whole .ipynb JSON, destroying every other cell's outputs.
   */
  NOTEBOOK_EDIT_TOOL,
];

/**
 * The tools the agent pane exposes.
 *
 * This list used to end with a comment explaining that the 14 `prometheus_*` verbs stayed OUT
 * because the pane had no seam to the engine. That was true, and it meant the GUI could not
 * scan a machine, list what was installed, or install anything — the product's own reason for
 * existing — while the CLI agent could do all of it. There is a seam now (`agent:engineTool`),
 * so they are in.
 */
export const AGENT_PANE_ALLOW: readonly string[] = [
  // The engine verbs. The four mutators carry `destructiveHint`, so NO authorization level
  // auto-approves them: each one reaches a human task card first, exactly as in the CLI.
  ...ENGINE_VERBS,
  ...SYSTEM_TOOLS.map((t) => t.name),
  ...SYSTEM_FS_WRITE_TOOLS.map((t) => t.name),
  ...SYSTEM_MEMORY_TOOLS.map((t) => t.name),
  ...TODO_TOOLS.map((t) => t.name),
  "propose_edit",
  "write_file",
  // The pane had no network at all: a user could paste a link and the agent could not read it,
  // and nothing could be looked up. Both go out through main's fail-closed L6 proxy, and both
  // are refused outright when the security profile's `defaultNetwork` does not permit the web.
  WEB_FETCH_TOOL.name,
  WEB_SEARCH_TOOL.name,
  ...BROWSER_TOOLS.map((t) => t.name),
  SPAWN_AGENT_TOOL.name,
  QUESTION_TOOL.name,
  // A multi-file edit was the one thing the pane could not express: the model had to send N
  // separate propose_edit calls for a rename-and-update-its-callers, and each was reviewed on
  // its own. It lands in the same ChangeSet, so there is no new write path.
  APPLY_PATCH_TOOL.name,
  // Notebook cell editing — a structured alternative to rewriting the .ipynb JSON by hand.
  NOTEBOOK_EDIT_TOOL_NAME,
];

/* ── the system prompt ───────────────────────────────────────────────────────*/

/**
 * The pane's system prompt, composing core's `AGENT_TOOL_DISCIPLINE` verbatim.
 *
 * Only the FRAMING differs from the CLI's (an editor with an open workspace rather than a
 * terminal). The rules that actually change behaviour — call the tool instead of printing
 * code, smallest exact hunks, act directly because the gate handles safety — are the same
 * sentences, because the surfaces kept drifting when they were paraphrases.
 */
export const AGENT_PANE_SYSTEM = [
  "You are Prometheus, an agentic coding assistant embedded in the user's editor, with REAL tools over their open workspace.",
  "`read_file`, `list_dir` and `grep` inspect it; `write_file` creates a NEW file; `propose_edit` changes an EXISTING one; `run_command` runs a command the user must approve.",
  AGENT_TOOL_DISCIPLINE,
  "Do NOT rewrite a whole existing file with `write_file` — that is for brand-new files only, and overwriting loses precision.",
  "Paths are relative to the workspace root.",
].join(" ");

/* ── the LLMClient seam ──────────────────────────────────────────────────────*/

/**
 * Turn a core `ToolDef` into the OpenAI tool schema the endpoint expects.
 *
 * Now a re-export of core's single converter. This file's own copy handled `enum` correctly
 * but dropped every `default`; the CLI's copy did the opposite and emitted an invalid
 * `{"type":"enum"}`. Neither knew to hide `force`, which the loop hard-blocks. Two hand-kept
 * copies of one mapping is exactly the drift this pane was rebuilt to end.
 */
export const toOpenAiTool: (t: ToolDef) => unknown = coreToOpenAiTool;

/** Per-turn timings the pane's §3 latency card accumulates. */
export interface TurnPhaseSink {
  addModelMs(ms: number): void;
  addLoadMs(ms: number): void;
  onUsage?(u: { inputTokens: number; outputTokens: number; totalTokens: number }): void;
}

export interface RendererLlmOptions {
  endpoint: RendererEndpoint;
  neverSendToCloud: boolean;
  signal: AbortSignal;
  effort?: EffortResolution;
  phases?: TurnPhaseSink;
  /** injectable turn-runner (defaults to runChatTurn) — lets tests script turns. */
  runTurn?: typeof runChatTurn;
  /**
   * Whether to OPEN with native tool calls. Defaults to true, which is what the pane always
   * did; observation demotes it when the endpoint proves otherwise.
   */
  declaredNative?: boolean;
  /** a capability record carried over from an earlier session with this endpoint. */
  capability?: ToolCapabilityState;
  /** fired when the observation changes, so the host can persist it. */
  onCapability?: (state: ToolCapabilityState) => void;
}

/**
 * Adapt the renderer's chat transport to core's `LLMClient`.
 *
 * Core hands us a `Thread` of `{role, content}` and expects `LlmTurn`s back. The mapping is
 * mechanical except for one thing worth stating: a turn that produced tool calls yields
 * `tool_call` events and NO `final`, because `final` ends the turn — core would never run
 * the tools. A turn with no tool call yields `final`, which is what stops a text-only model
 * from looping.
 */
export function createRendererLlmClient(opts: RendererLlmOptions): LLMClient {
  const runTurn = opts.runTurn ?? runChatTurn;
  // What this endpoint has been observed to do about tool calls, across the session. The
  // pane always sent `tools` and only ever read native `tool_calls`, so a model whose
  // template cannot render tools had no way to act at all — it would describe the edit and
  // the pane would show a confident answer with nothing on disk.
  let capability: ToolCapabilityState = opts.capability ?? initialCapability();

  return {
    async *turn(thread: Thread, _tuning: AgentTuning, tools: ToolDef[]): AsyncIterable<LlmTurn> {
      const transport = negotiateTransport({
        toolCount: tools.length,
        // `RendererEndpoint` carries no capability flag, and the pane's previous behaviour
        // was to always offer tools — so native stays the opening move and observation
        // corrects it.
        declaredNative: opts.declaredNative ?? true,
        observed: capability,
      });

      // Core owns the thread; the transport wants its own message shape.
      const messages: AiMsg[] = thread.messages.map((m) => ({
        // `tool` has no renderer-side equivalent; main re-maps it to `user` on the wire
        // (an unpaired OpenAI `role:"tool"` is rejected by strict endpoints).
        role: m.role === "tool" ? "user" : m.role,
        content: m.content,
      })) as AiMsg[];
      const outgoing = withPreamble(
        messages,
        tools,
        transport,
        opts.endpoint.contextWindow,
        capability.textSyntaxCalls > 0,
      );

      // Deltas arrive through callbacks while `runTurn` is awaited, so they are queued and
      // drained after — an async generator cannot yield from inside a callback.
      const pending: LlmTurn[] = [];
      // Scanned on BOTH transports: a model handed a working native channel very often
      // answers with `<tool_call>` prose anyway, and the scanner also keeps that markup out
      // of the transcript instead of showing the user raw protocol.
      const scanner = new ToolCallScanner();
      const textCalls: TextToolCall[] = [];
      const take = (events: ScanEvent[]): void => {
        for (const ev of events) {
          if (ev.kind === "text") {
            if (ev.text) pending.push({ kind: "text", text: ev.text });
          } else if (ev.kind === "call") textCalls.push(ev.call);
        }
      };
      // Every byte actually handed to the scanner via `onText`, RAW — kept separately from
      // `pending` because the scanner legitimately reclassifies some of it (a `<tool_call>`
      // span becomes a `call` event, not a `text` one) and reconstructing from `pending` alone
      // cannot tell "reclassified" apart from "never arrived" (see the safety net below).
      let deliveredText = "";

      const result = await runTurn(opts.endpoint, outgoing, {
        ...(transport === "native" && tools.length > 0 ? { tools: tools.map(toOpenAiTool) } : {}),
        neverSendToCloud: opts.neverSendToCloud,
        signal: opts.signal,
        ...(opts.effort ? { effort: opts.effort } : {}),
        onText: (d) => {
          deliveredText += d;
          take(scanner.push(d));
        },
        onReasoning: (d) => pending.push({ kind: "reasoning", text: d }),
        onStatus: (t) => pending.push({ kind: "status", text: t }),
      });
      take(scanner.end());
      /**
       * SAFETY NET — found live, by an e2e test driving a real chat turn against a stub model
       * fast enough to expose it: `onText` progress deltas (`ai:progress`) and `ai:stream`'s
       * own invoke REPLY are two separate Electron IPC deliveries, and nothing guarantees they
       * arrive in the order they were sent. An almost-instant reply (a fast local model, or
       * any stub — which is exactly what surfaced this) can have its invoke promise resolve
       * BEFORE the progress event carrying its last delta lands, so the scanner never SAW the
       * tail of a real answer at all — and the bare `{kind:"final"}` yielded below carries no
       * text of its own (by design: repeating it there would duplicate whatever already
       * streamed), so nothing else ever looks at `result.text` again.
       *
       * `result.text` is main's own authoritative accumulation, built directly off the SSE
       * reads and independent of the progress feed's delivery. Comparing it against `pending`
       * would be wrong (a `<tool_call>` span the scanner correctly consumed is not "missing"
       * text — it is a `call` event instead), so this compares against `deliveredText`, the RAW
       * bytes actually pushed: only a genuine gap between what was delivered and what main
       * says it sent triggers a catch-up push, through the SAME scanner so a marker split
       * exactly at the gap is still handled. A no-op whenever every delta arrived on time.
       */
      if (result.text.length > deliveredText.length && result.text.startsWith(deliveredText)) {
        const missing = result.text.slice(deliveredText.length);
        take(scanner.push(missing));
        take(scanner.end());
      }
      for (const ev of pending) yield ev;

      if (result.timing && opts.phases) {
        const split = splitTiming(result.timing);
        opts.phases.addModelMs(split.model);
        opts.phases.addLoadMs(split.load);
      }
      if (result.usage) opts.phases?.onUsage?.(result.usage);

      for (const tc of result.toolCalls) {
        yield {
          kind: "tool_call",
          call: { name: tc.name, args: parseToolArgs(tc.arguments), id: tc.id },
        };
      }
      // Native calls win when both arrived: the prose is almost certainly the model narrating
      // the call it also made properly, and running it twice doubles every side effect.
      const usedText = result.toolCalls.length === 0 ? textCalls : [];
      for (const call of usedText) {
        yield { kind: "tool_call", call: { name: call.name, args: call.args } };
      }

      capability = observeTurn(capability, {
        transport,
        nativeCalls: result.toolCalls.length,
        textCalls: usedText.length,
      });
      opts.onCapability?.(capability);

      // No tool call ⇒ the model answered. `final` with no text: the text already streamed
      // as `text` deltas above, and repeating it here would duplicate it in the thread.
      if (result.toolCalls.length === 0 && usedText.length === 0) yield { kind: "final" };
    },
  };
}

/**
 * Merge the tool preamble into the outgoing system message.
 *
 * The pane's own prompt (`AGENT_PANE_SYSTEM`, plus any project rules `AgentPane` appends)
 * stays first and whole, and the preamble is added to the OUTGOING copy only — it is derived
 * from the transport and the exposed tool set, so persisting it would freeze one turn's
 * answer into the thread.
 */
function withPreamble(
  messages: AiMsg[],
  tools: ToolDef[],
  transport: ToolTransport,
  contextWindow?: number,
  demonstrated?: boolean,
): AiMsg[] {
  if (transport === "none" || tools.length === 0) return messages;
  const mode = preambleModeFor(transport);
  // The measured window sizes the budget — see the CLI's twin. Without it the budget is the one
  // sized for an 8192 window, which drops every tool DESCRIPTION from the listing.
  const opts = {
    mode,
    ...(contextWindow ? { contextWindow } : {}),
    ...(demonstrated ? { demonstrated } : {}),
  };
  const at = messages.findIndex((m) => m.role === "system");
  if (at === -1) {
    const { text } = renderToolPreamble(tools, opts);
    return [{ role: "system", content: text } as AiMsg, ...messages];
  }
  const { prompt } = withToolPreamble(messages[at]?.content ?? "", tools, opts);
  return messages.map((m, i) => (i === at ? { ...m, content: prompt } : m));
}

/** Defensively parse a tool call's JSON-string arguments → an object. */
export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const o = JSON.parse(raw || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ── the ToolRunner seam ─────────────────────────────────────────────────────*/

/** A command the human approved, and what running it produced. */
export interface CommandOutcome {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

export interface RendererToolDeps {
  tools: AgentTools;
  /**
   * Run one of core's system tools in main (Phase 6).
   *
   * Replaces the old `runCommand(command, cwd)` seam, which could only express "a shell
   * string" — the shape that forced Studio to have its own executor in the first place.
   */
  systemTool(name: string, args: Record<string, unknown>): Promise<AgentSystemToolResult>;
  /**
   * Dispatch a todo call against the session's list; null when it is not a todo tool.
   *
   * Injected rather than owned here because the STORE has to outlive the pane — it lives on the
   * run controller, next to the abort handles, for the same reason those do.
   */
  todo?(name: string, args: Record<string, unknown>): { ok: boolean; summary: string } | null;
  /**
   * Dispatch `notebook_edit` against the notebook store; null when it is not a notebook tool.
   *
   * Injected, like `todo`, rather than called directly here — the run controller owns the
   * task-card REPLAY stash, and a notebook edit reaches a human card (it is `destructiveHint`).
   * Without the replay the card would run the edit and the tool runner would then run it a
   * SECOND time, which for a cell overwrite is invisible rather than merely noisy.
   */
  notebook?(name: string, args: Record<string, unknown>): Promise<ToolOutcome> | null;
  /**
   * Run one `prometheus_*` verb in main (the engine, prometheus.py).
   *
   * Optional because a host without an engine is a real state (a packaged build whose python
   * side failed to resolve), and the honest answer there is a refusal that names the reason —
   * not a tool that silently does nothing.
   */
  engineTool?(name: string, args: Record<string, unknown>): Promise<AgentSystemToolResult>;
  /**
   * Delegate a subtask to a sub-agent, returning only its final text.
   *
   * Injected rather than built here because a nested turn needs the LLM client, the parent's
   * tuning and the SPAWN BUDGET — and the budget must outlive a single tool call or it counts
   * nothing. The run controller owns all three, exactly as the CLI's session host does.
   */
  spawn?(args: Record<string, unknown>): Promise<ToolOutcome>;
  /**
   * Ask the human a free-text question mid-turn.
   *
   * Separate from `confirm`, which answers yes/no about a CALL. Overloading confirm's `reason`
   * to carry an answer would make "the user declined" and "the user said X" indistinguishable.
   */
  askUser?(args: Record<string, unknown>): Promise<ToolOutcome>;
  /**
   * Call a tool on a configured MCP server, through main.
   *
   * Absent means the pane has no MCP surface, and the model is told exactly that rather than
   * being handed a tool that quietly fails — the failure a user reads as "the connector is
   * broken" when in fact nothing ever tried.
   */
  mcpTool?(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<AgentSystemToolResult>;
  /** a visible tool-activity note for the transcript. */
  onToolNote(note: string): void;
  /** time a tool await into the §3 `tools` latency leg. */
  time?<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Dispatch an (already broker-approved, already force-stripped) tool call.
 *
 * Core has done the gating by the time this runs — do NOT re-decide anything here, or the
 * two policies drift and the one that matters becomes whichever ran last.
 */
export function createRendererToolRunner(
  deps: RendererToolDeps,
): (tool: ToolDef, args: Record<string, unknown>) => Promise<ToolOutcome> {
  const timed = deps.time ?? (<T>(fn: () => Promise<T>) => fn());
  return async (tool, args) => {
    switch (tool.name) {
      case "apply_patch": {
        // A multi-file patch is N proposed edits into ONE review ChangeSet. The CLI's two-phase
        // resolve-then-write exists because it writes disk directly; here the user's single
        // Apply in DiffReview already IS the atomic step, so copying that machinery would add a
        // second write path and a second thing to keep correct.
        const parsed = parseApplyPatchArgs(args);
        if (!parsed.ok) {
          deps.onToolNote(`✎ apply_patch rejected: ${parsed.error}`);
          return { ok: false, summary: parsed.error };
        }
        const notes: string[] = [];
        for (const edit of parsed.edits) {
          deps.onToolNote(`✎ edit ${edit.path}`);
          notes.push(await timed(() => deps.tools.proposeEdit(edit)));
        }
        return {
          ok: true,
          summary: `queued ${parsed.edits.length} file(s) for review: ${parsed.edits
            .map((e: { path: string }) => e.path)
            .join(", ")}`,
        };
      }
      case "propose_edit":
      case "write_file": {
        // Both land in the same review queue: `write_file` is a propose_edit whose pre-image
        // is empty. Keeping ONE review surface means the user approves new and changed files
        // the same way instead of learning two.
        const parsed = parseProposeEditArgs(args);
        if (!parsed.ok) {
          deps.onToolNote(`✎ ${tool.name} rejected: ${parsed.error}`);
          return { ok: false, summary: parsed.error };
        }
        deps.onToolNote(`✎ edit ${parsed.edit.path}`);
        // Review is ASYNC (§7.4): this returns once the edit is QUEUED, not once it is
        // applied. The model is told exactly that, so it does not claim the file changed.
        return { ok: true, summary: await timed(() => deps.tools.proposeEdit(parsed.edit)) };
      }
      case "spawn_agent": {
        if (!deps.spawn) return { ok: false, summary: "spawn_agent is not available here" };
        return timed(() => (deps.spawn as NonNullable<typeof deps.spawn>)(args));
      }
      case "question": {
        if (!deps.askUser) return { ok: false, summary: NO_ASKER_MESSAGE };
        return timed(() => (deps.askUser as NonNullable<typeof deps.askUser>)(args));
      }
      case "todowrite":
      case "todoread": {
        const out = deps.todo?.(tool.name, args);
        return out ?? { ok: false, summary: `${tool.name} is unavailable in this session` };
      }
      case NOTEBOOK_EDIT_TOOL_NAME: {
        /**
         * Dispatched in the RENDERER, not over `agent:systemTool`.
         *
         * The pipeline it must go through — `parseIpynb` → mutate `cells[i].source` →
         * `serializeIpynb`, via the notebook store — lives here, and going through the store
         * is what keeps an OPEN notebook tab consistent with what lands on disk. The store's
         * own `save` still writes through the same `ide:fs.write` IPC every other edit uses,
         * so there is no new write path and no new guard to keep in sync.
         */
        deps.onToolNote(toolNote(tool.name, args));
        const nb = deps.notebook?.(tool.name, args);
        if (!nb) return { ok: false, summary: "notebook_edit is unavailable in this session" };
        return timed(() => nb);
      }
      default: {
        // An MCP tool belongs to a server the user configured, so it is checked BEFORE the
        // built-in guards: its name is namespaced (`mcp__server__tool`) and can never collide
        // with one of ours, and it is dispatched by server id rather than by a membership list.
        const ref = parseMcpToolName(tool.name);
        if (ref) {
          if (!deps.mcpTool) {
            return { ok: false, summary: `MCP server "${ref.serverId}" is not reachable here` };
          }
          deps.onToolNote(`⟐ ${ref.serverId}: ${ref.tool}`);
          const m = await timed(() =>
            (deps.mcpTool as NonNullable<typeof deps.mcpTool>)(ref.serverId, ref.tool, args),
          );
          return {
            ok: m.ok,
            summary: m.summary,
            ...(m.data ? { data: m.data } : {}),
          };
        }
        // The engine verbs go to prometheus.py, through main. Checked FIRST because the two
        // channels are guarded by different lists and admit different things — the system
        // channel is scoped to a workspace path, and these verbs have no workspace scope at
        // all (they rewrite machine-global state).
        if (isEngineVerb(tool.name)) {
          if (!deps.engineTool) {
            return { ok: false, summary: `${tool.name} needs the engine, which is unavailable` };
          }
          deps.onToolNote(toolNote(tool.name, args));
          const e = await timed(() =>
            (deps.engineTool as NonNullable<typeof deps.engineTool>)(tool.name, args),
          );
          return {
            ok: e.ok,
            summary: e.summary,
            ...(e.data ? { data: e.data } : {}),
            ...(e.verdict ? { verdict: e.verdict } : {}),
          };
        }
        // ── Phase 6: every system tool goes to core's shared implementation ──
        // No per-tool `case` arms here on purpose. A switch over tool names is exactly how
        // the renderer's four tools drifted from core's nineteen: each arm was a second
        // place to encode what a tool does. This forwards the name and the args and lets
        // the ONE implementation decide, so adding a tool to core adds it to Studio.
        // Membership is core's ONE list, shared with main's identical guard. This check used to
        // name `SYSTEM_TOOLS` alone while main had been widened, so every Tier-W mutator was
        // advertised to the model, approved by the human, and then refused right here.
        if (!isHostDispatchTool(tool.name)) {
          return { ok: false, summary: `tool "${tool.name}" is not available in the editor` };
        }
        deps.onToolNote(toolNote(tool.name, args));
        const r = await timed(() => deps.systemTool(tool.name, args));
        return {
          ok: r.ok,
          summary: r.summary,
          ...(r.data ? { data: r.data } : {}),
          ...(r.verdict ? { verdict: r.verdict } : {}),
        };
      }
    }
  };
}

/** A short human note for the transcript — what the pane shows while a tool runs. */
function toolNote(name: string, args: Record<string, unknown>): string {
  const a = (k: string): string => (args[k] === undefined ? "" : ` ${String(args[k])}`);
  switch (name) {
    case "read_file":
      return `read${a("path")}`;
    case "list_dir":
      return `list${a("path")}`;
    case "grep":
      return `grep "${String(args.query ?? args.pattern ?? "")}"`;
    case "run_command":
      return `run ${String(args.command ?? "")}`;
    case "propose_elevated":
      return "propose an elevated command";
    case "web_fetch":
      return `fetch ${String(args.url ?? "")}`;
    case "web_search":
      return `search "${String(args.query ?? "")}"`;
    case NOTEBOOK_EDIT_TOOL_NAME:
      // Names the cell as well as the file: "edit notebook.ipynb" would not tell a reviewer
      // which of forty cells is about to be overwritten.
      return `edit cell ${String(args.cellIndex ?? "?")} of ${String(args.path ?? "")}`;
    case "prometheus_install":
    case "prometheus_uninstall":
    case "prometheus_enable":
    case "prometheus_disable":
      return `${name.slice("prometheus_".length)} ${String(args.name ?? "")}`;
    default:
      return name;
  }
}

/* ── the tuning ──────────────────────────────────────────────────────────────*/

/**
 * Task #5 (desktop parity): fold the loaded personas into `spawn_agent`'s description — the
 * SAME treatment the CLI's `withPersonas` (agent-runtime.ts) applies. A persona nobody told the
 * model about is a persona nobody uses; the names travel IN the tool's own description so they
 * ride along the preamble's degrade ladder and disappear with the tool rather than outliving it
 * in a separate prompt block.
 */
export function withPersonas(
  tools: readonly ToolDef[],
  personas: readonly LoadedAgent[],
): ToolDef[] {
  if (personas.length === 0) return [...tools];
  const list = personas.map((p) => `${p.name} (${p.description})`).join("; ");
  return tools.map((t) =>
    t.name === SPAWN_AGENT_TOOL.name
      ? { ...t, description: `${t.description} Custom roles available: ${list}.` }
      : t,
  );
}

/**
 * Build the pane's `AgentTuning` for the operator's current authorisation level (§5).
 *
 * `yes` needs care, because its name suggests more than it does. It does NOT mean "approve
 * everything": `autoApprovable` refuses any tool carrying `destructiveHint` even WITH the
 * grant, so `yes` only ever lifts READ-ONLY tools out of the confirm path. `run_command`,
 * `propose_edit` and `write_file` reach a human at every level, including A7.
 *
 * So it maps exactly onto the ladder's own words: A0 is "ask everything" and A1 is "read
 * freely". `level >= 1` is the same sentence in code.
 *
 * Getting this wrong in either direction is a real failure. Left off, the pane asks
 * permission to READ a file — dozens of prompts per turn, which is precisely the pressure
 * that makes a user click a blanket allow. Turned on for destructive tools, the gate stops
 * meaning anything. `maxRounds` is left at core's default (8) rather than the fork's 6.
 */
export function agentPaneTuning(
  model: string,
  authLevel = 1,
  mcpTools: readonly ToolDef[] = [],
  permissionMode: PermissionModeId = "default",
  // Task #5 (desktop parity): loaded sub-agent personas, folded into `spawn_agent`'s
  // description below — the SAME `withPersonas` treatment the CLI applies (agent-runtime.ts).
  personas: readonly LoadedAgent[] = [],
  /**
   * The user's lifecycle HOOKS and the runner that executes them (`core/agent/hooks.ts`).
   *
   * Desktop parity with both CLI hosts: the SAME loop enforces a PreToolUse veto here, so a
   * hook a user wrote to guard `write_file` guards it in the editor too. Empty/absent ⇒ the
   * hook seams in the loop are a cheap array check and nothing is ever spawned.
   */
  hooks: readonly HookSpec[] = [],
  hookRunner?: HookRunner,
): AgentTuning {
  // The allow-list is a WHITELIST, so MCP tools have to be named in it as well as supplied in
  // `extra` — putting them only in `extra` (which is what the CLI does, because its allow-list
  // is empty) would filter every one of them back out, silently. A built-in wins a name
  // collision: the `mcp__` prefix makes one impossible today, and this keeps it impossible if
  // the prefix ever changes.
  const taken = new Set([...AGENT_PANE_ALLOW, ...EDITOR_TOOLS.map((t) => t.name)]);
  const mcp = mcpTools.filter((t) => !taken.has(t.name));
  return {
    model: { provider: "local", modelId: model },
    systemPrompt: AGENT_PANE_SYSTEM,
    tools: {
      enabled: true,
      allow: [...AGENT_PANE_ALLOW, ...mcp.map((t) => t.name)],
      deny: [],
      extra: withPersonas([...EDITOR_TOOLS, ...mcp], personas),
    },
    gateMode: "enforce",
    dryRun: false,
    verbosity: "normal",
    // A1 "read freely" and up: reads stop prompting. Destructive tools are unaffected.
    yes: authLevel >= 1,
    /**
     * The autonomy POSTURE. The pane had none — no plan mode, no read-only stance, nothing.
     * Both CLI hosts have shipped one for a while, so "put Prometheus in plan mode and let it
     * survey the repo" was a thing you could do in the terminal and not in the editor, and a
     * user who believed otherwise got a plan with edits queued behind it.
     *
     * Core's loop enforces the DENY side (see `AgentTuning.permissionMode`), so this is the
     * whole wiring — there is no pane-side branch to keep in sync, which is the point.
     */
    permissionMode,
    // Hooks ride the TUNING so `childTuning` carries them into a `spawn_agent` child — the
    // same reason both CLI hosts put them here rather than on the deps.
    ...(hooks.length > 0 ? { hooks } : {}),
    ...(hookRunner ? { hookRunner } : {}),
  };
}

/* ── lifecycle hooks: the renderer lists + proxies, MAIN spawns ───────────────*/

/** The `agent:hookRun` slice of the IDE bridge this module needs (structural, for testing). */
export interface HookIdeBridge {
  /** OPTIONAL: a harness (or an older preload) may not expose the channel at all. */
  hookRun?(req: {
    op: "list" | "run";
    event?: "PreToolUse" | "PostToolUse" | "SessionStart";
    command?: string;
    stdin?: string;
    timeoutMs?: number;
    cwd?: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    hooks?: {
      event: "PreToolUse" | "PostToolUse" | "SessionStart";
      matcher?: string;
      command: string;
    }[];
    outcome?: {
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut?: boolean;
      error?: string;
    };
  }>;
}

/**
 * Ask main for the user's configured hooks. Fail-soft to `[]` — an older main without the
 * channel, or no bridge at all, means "no hooks", never a broken turn.
 */
export async function listPaneHooks(ide: HookIdeBridge | undefined): Promise<HookSpec[]> {
  if (!ide?.hookRun) return [];
  try {
    const res = await ide.hookRun({ op: "list" });
    return res.ok && Array.isArray(res.hooks) ? (res.hooks as HookSpec[]) : [];
  } catch {
    return [];
  }
}

/**
 * A `HookRunner` that proxies every run to main over `agent:hookRun`.
 *
 * The renderer NEVER spawns — it cannot (C5), and it should not: main re-checks the command
 * against the configured list before running anything, so this proxy cannot be used to execute
 * a shell string the renderer chose. A failed round trip resolves an `error` outcome, which
 * core reads as "no hook fired" rather than as a deny.
 */
export function makeIdeHookRunner(ide: HookIdeBridge, cwd?: string): HookRunner {
  return async (inv) => {
    if (!ide.hookRun) {
      return { exitCode: -1, stdout: "", stderr: "", error: "agent:hookRun is unavailable" };
    }
    try {
      const res = await ide.hookRun({
        op: "run",
        event: inv.event,
        command: inv.command,
        stdin: inv.stdin,
        timeoutMs: inv.timeoutMs,
        ...(cwd ? { cwd } : {}),
      });
      if (!res.ok || !res.outcome) {
        return { exitCode: -1, stdout: "", stderr: "", error: res.error ?? "agent:hookRun failed" };
      }
      return res.outcome;
    } catch (e) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };
}

/* ── the run ─────────────────────────────────────────────────────────────────*/

export interface CoreAgentSinks {
  /** an assistant text delta. */
  onText(delta: string): void;
  /** a thinking delta (never persisted into the thread). */
  onReasoning?(delta: string): void;
  /** a wrapper status line (watchdog heartbeat, round counter). */
  onStatus?(text: string): void;
  /** a finished assistant text turn (commit the streamed buffer). */
  onTurnComplete(): void;
  /** a visible tool-activity note. */
  onToolNote(note: string): void;
  /** a gate verdict for a tool call. */
  onVerdict?(tool: string, verdict: string, riskScore?: number): void;
  /** the loop hit `maxRounds` with the model still wanting a tool — a pause, not a failure. */
  onCapped?(rounds: number): void;
  /** ask the human about a tool call the broker routed to `confirm`. */
  confirm(call: ToolCall): Promise<ConfirmResult>;
  /**
   * The run's cancel — the SAME `AbortController` the pane's stop button trips.
   *
   * It already reached the model stream (`RendererLlmOptions.signal`) and nothing else, so
   * stopping a run in Studio stopped the tokens and let the loop start another round and run
   * more tools. Identical to the CLI's defect, in a second copy of the same wiring.
   */
  signal?: AbortSignal;
}

/**
 * Run one agent turn on core's loop, translating its events onto the pane's sinks.
 *
 * `thread` is MUTATED by core (that is how a multi-round turn accumulates), so the caller
 * should keep the same object across turns — that is the conversation.
 *
 * NOTE on `confirm`: core DEFAULTS TO DENY when no confirm is supplied, so a pane that
 * forgets to pass one would silently refuse every write. It is required here for that
 * reason.
 */
export async function runCoreAgentTurn(
  thread: Thread,
  tuning: AgentTuning,
  llm: LLMClient,
  runTool: (tool: ToolDef, args: Record<string, unknown>) => Promise<ToolOutcome>,
  sinks: CoreAgentSinks,
): Promise<void> {
  let streamed = false;
  for await (const ev of runAgentTurn(thread, tuning, {
    llm,
    runTool,
    confirm: sinks.confirm,
    ...(sinks.signal ? { signal: sinks.signal } : {}),
  })) {
    switch (ev.kind) {
      case "text":
        streamed = true;
        sinks.onText(ev.text);
        break;
      case "reasoning":
        sinks.onReasoning?.(ev.text);
        break;
      case "status":
        sinks.onStatus?.(ev.text);
        break;
      case "tool_use":
        // the note for a RUN is emitted by the runner (it knows the arguments); this event
        // fires for every tool including ones the runner rejects, so it would double up.
        break;
      case "tool_result":
        if (!ev.ok) sinks.onToolNote(`✗ ${ev.call.name}: ${ev.summary}`);
        break;
      case "verdict":
        sinks.onVerdict?.(ev.tool, ev.verdict, ev.riskScore);
        break;
      case "blocked":
        sinks.onToolNote(`⛔ ${ev.tool} blocked — ${ev.reason}`);
        break;
      case "capped":
        sinks.onCapped?.(ev.rounds);
        break;
      case "done":
        if (streamed) sinks.onTurnComplete();
        break;
      default:
        break;
    }
  }
}
