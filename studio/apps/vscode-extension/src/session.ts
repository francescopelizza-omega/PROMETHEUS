/**
 * session.ts — one chat session: core's `runAgentTurn`, driven for the VS Code host.
 *
 * There is NO loop in this file. That is the point. The `for await` below iterates core's
 * `runAgentTurn` and translates its `AgentEvent`s onto sinks the webview renders — exactly
 * what `runCoreAgentTurn` does for the desktop pane. Every invariant that matters (the
 * `--force` ban, the §4.3 annotation broker, confirm-default-deny, the 16KB byte cap on tool
 * output, the multi-round fold) lives in core and is inherited rather than re-implemented.
 */

import type {
  AgentTuning,
  ConfirmResult,
  LLMClient,
  PermissionModeId,
  Thread,
  ToolCall,
  ToolOutcome,
} from "@prometheus/core/agent-loop";
import { runAgentTurn } from "@prometheus/core/agent-loop";
import type { ToolDef } from "@prometheus/core/agent-tools";

import { VSCODE_EXTRA_TOOLS, VSCODE_TOOL_ALLOW } from "./tool-runner.js";

/* ── the system prompt ───────────────────────────────────────────────────────*/

/**
 * The PERSONA string only — "who Prometheus is" and the editor-specific framing. Behavioral
 * rules (call the tool instead of printing code, smallest exact hunks, the pre-write recheck,
 * effort-as-text) are no longer baked in here: `llm.ts`'s `withPreamble` adds the SAME
 * contributor set the CLI and desktop pane get (`agent/protocol/contributors`), every round,
 * so the three surfaces can no longer drift into differently-worded paraphrases.
 */
export const VSCODE_SYSTEM_PROMPT = [
  "You are Prometheus, an agentic coding assistant embedded in the user's VS Code editor, with REAL tools over their open workspace.",
  "`read_file`, `list_dir`, `glob` and `grep` inspect it; `write_file` creates a NEW file; `propose_edit` changes an EXISTING one; `apply_patch` changes several at once.",
  "Edits are applied through VS Code's own edit API, so they land in the editor as undoable changes the user can review with Ctrl+Z.",
  "Paths are relative to the workspace root. Absolute paths are refused.",
].join(" ");

/**
 * Build the session tuning.
 *
 * `yes` needs the same care it needs everywhere: it does NOT mean "approve everything".
 * `autoApprovable` refuses any tool carrying `destructiveHint` even WITH the grant, so
 * `authLevel >= 1` only ever lifts READ-ONLY tools out of the confirm path. `write_file`,
 * `propose_edit`, `apply_patch`, `delete_file` and `move_file` reach a human at every level.
 *
 * Getting it wrong in either direction is a real failure: left off, the agent asks permission
 * to READ a file — dozens of modal dialogs per turn, which is exactly the pressure that makes
 * a user click a blanket allow.
 */
export function vscodeTuning(
  model: string,
  authLevel = 1,
  permissionMode: PermissionModeId = "default",
): AgentTuning {
  return {
    model: { provider: "local", modelId: model },
    systemPrompt: VSCODE_SYSTEM_PROMPT,
    tools: {
      enabled: true,
      allow: [...VSCODE_TOOL_ALLOW],
      deny: [],
      extra: [...VSCODE_EXTRA_TOOLS],
    },
    gateMode: "enforce",
    dryRun: false,
    verbosity: "normal",
    yes: authLevel >= 1,
    permissionMode,
  };
}

/* ── the sinks the webview renders ───────────────────────────────────────────*/

export interface SessionSinks {
  onText(delta: string): void;
  onReasoning?(delta: string): void;
  onStatus?(text: string): void;
  onToolNote(note: string): void;
  onTurnComplete(): void;
  onError(message: string): void;
  onCapped?(rounds: number): void;
  /** The turn PAUSED on inactivity (idle-watchdog), not a completion — resumable, nothing
   *  lost. Without this a paused turn was visually indistinguishable from one that simply
   *  finished: `runAgentTurn` still yields a trailing `done` after a `paused` round (so the UI
   *  never hangs), but nothing told the user WHY it stopped short. */
  onPaused?(idleMs: number): void;
}

export interface SessionDeps {
  llm: LLMClient;
  runTool: (tool: ToolDef, args: Record<string, unknown>) => Promise<ToolOutcome>;
  /**
   * Ask the human about a tool call the broker routed to confirm.
   *
   * REQUIRED, not optional, and the reason is core's own default: `runAgentTurn` DENIES when no
   * confirm is supplied. A host that forgot to pass one would silently refuse every write and
   * look broken rather than look strict.
   */
  confirm(call: ToolCall): Promise<ConfirmResult>;
  tuning: AgentTuning;
  /**
   * The endpoint's context window, in tokens, so a session can WARN before it wedges.
   *
   * This host has no compaction: the thread grows without bound and nothing trims it (measured:
   * ~110 tokens per turn with short replies, linear, forever). Past the window the provider
   * rejects every request and the session is stuck — each new message re-sends the same
   * oversized thread and fails identically, with no way back except a new session.
   *
   * Compaction proper belongs in core, shared with the CLI and desktop implementations rather
   * than written a third time here; until then, saying so is the honest half.
   */
  contextWindow?: number;
}

/**
 * A conversation. `thread` is MUTATED by core across rounds and turns — that accumulation IS
 * the conversation, so the same object is deliberately kept and reused.
 */
export class ChatSession {
  readonly thread: Thread;
  private readonly deps: SessionDeps;
  private running = false;
  /**
   * Minted fresh per turn, cleared in `send`'s `finally`. `cancel()` only ever sees the
   * controller for the turn CURRENTLY running — there is no way to cancel a turn that already
   * finished, or one that has not started yet, which matches "Cancel Current Turn"'s own name.
   */
  private controller: AbortController | undefined;
  /**
   * The IN-FLIGHT turn's abort signal, or undefined between turns.
   *
   * The model client is built once per session rebuild, so it cannot be handed a per-turn signal
   * at construction. Without this the signal reached `runAgentTurn` but never the model stream:
   * core's loop only tests `aborted` between rounds and before a tool call, so for a text-only
   * answer Cancel was not observed until the model had finished streaming the entire round, and
   * the HTTP request was never aborted at all. On a slow local model that is minutes of
   * un-cancellable output. The client reads this per turn instead.
   */
  get currentSignal(): AbortSignal | undefined {
    return this.controller?.signal;
  }
  /**
   * The in-flight turn's own promise (set in `send`, cleared in its `finally`) — so a caller
   * that needs to know the turn has ACTUALLY finished (not just that `cancel()` was requested,
   * which only sets an abort flag the loop observes asynchronously) has something to await.
   * Used by `reset()` and `stopAndWaitIdle()`.
   */
  private currentSend: Promise<void> | undefined;

  /** Set once the context-pressure warning has been shown, so it is said once, not every turn. */
  private warnedNearLimit = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.thread = { messages: [{ role: "system", content: deps.tuning.systemPrompt }] };
  }

  /**
   * Rough token count for the whole thread — the same chars/4 estimate the CLI's meter uses.
   * An estimate is enough: this decides when to WARN, never what to send.
   */
  private estimatedTokens(): number {
    let chars = 0;
    for (const m of this.thread.messages) chars += m.content.length;
    return Math.ceil(chars / 4);
  }

  /** Warn ONCE when the conversation is close to the window it will be rejected at. */
  private warnIfNearContextLimit(sinks: SessionSinks): void {
    const window = this.deps.contextWindow;
    if (!window || this.warnedNearLimit) return;
    const used = this.estimatedTokens();
    if (used < window * 0.75) return;
    this.warnedNearLimit = true;
    sinks.onStatus?.(
      `⚠ this conversation is using roughly ${used.toLocaleString()} of ${window.toLocaleString()} tokens. There is no automatic compaction on this host yet — when it exceeds the window every message will start failing. Run “Prometheus: New Session” to start fresh.`,
    );
  }

  get busy(): boolean {
    return this.running;
  }

  /**
   * Cancel any in-flight turn and wait for it to have ACTUALLY finished (its `send`'s `finally`
   * to have run) — idempotent, resolves immediately when already idle.
   *
   * This exists for a caller about to discard this whole session instance (e.g. a VS Code
   * config/workspace-folder change rebuilding the session) — swapping the instance out from
   * under a still-running turn used to leave that turn's sinks (which route through the
   * `ChatViewProvider`, unaffected by the swap) still streaming into the webview, while
   * `cancel()`/`submit()` calls resolved against the NEW, idle instance instead — silently
   * disabling Cancel and allowing a second, concurrent turn to start.
   */
  async stopAndWaitIdle(): Promise<void> {
    if (!this.running) return;
    this.cancel();
    await this.currentSend;
  }

  /**
   * Reset to a fresh conversation, keeping the same tuning.
   *
   * Cancels and WAITS OUT any in-flight turn first: `runAgentTurn` is handed `this.thread` by
   * reference and pushes its own round-end messages directly onto `thread.messages` — a reset
   * that only truncated the array in place, without first stopping the still-running turn,
   * could have that turn's own end-of-round fold push its trailing content right back onto the
   * array this just cleared, silently undoing the reset a moment later.
   */
  async reset(): Promise<void> {
    await this.stopAndWaitIdle();
    this.thread.messages.length = 0;
    this.thread.messages.push({ role: "system", content: this.deps.tuning.systemPrompt });
  }

  /**
   * Stop the turn currently running, if any. Returns whether there was one to stop.
   *
   * Core's `runAgentTurn` checks `signal.aborted` before each round and before each tool call
   * (see loop.ts's own `AgentTurnDeps.signal` doc) — it does not throw on abort, it yields one
   * `{kind:"blocked", reason:"cancelled…"}` event (no `tool` field: this is a TURN-level stop,
   * not a specific tool being refused) and ends the generator cleanly. `send`'s `finally` still
   * runs normally; this is a request to stop, not a kill. Synchronous — it only SIGNALS the
   * abort; the turn finishes asynchronously (see `stopAndWaitIdle`/`currentSend` for a caller
   * that needs to know it has actually stopped).
   */
  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  /** Run one user turn to completion, streaming onto `sinks`. */
  async send(text: string, sinks: SessionSinks): Promise<void> {
    if (this.running) {
      sinks.onError("a turn is already running");
      return;
    }
    this.running = true;
    this.controller = new AbortController();
    this.thread.messages.push({ role: "user", content: text });
    this.warnIfNearContextLimit(sinks);
    const run = this.runTurn(sinks);
    this.currentSend = run;
    return run;
  }

  private async runTurn(sinks: SessionSinks): Promise<void> {
    let streamed = false;
    try {
      for await (const ev of runAgentTurn(this.thread, this.deps.tuning, {
        llm: this.deps.llm,
        runTool: this.deps.runTool,
        confirm: this.deps.confirm,
        signal: this.controller?.signal,
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
            // The note for a RUN is emitted by the tool runner, which knows the arguments.
            // Emitting here too would double every line in the transcript.
            break;
          case "tool_result":
            if (!ev.ok) sinks.onToolNote(`✗ ${ev.call.name}: ${ev.summary}`);
            break;
          case "blocked":
            // `ev.tool` is absent for a turn-level cancel (as opposed to one specific tool call
            // being refused) — rendering it through the tool-note phrasing would literally print
            // "⛔ undefined blocked — …", so a tool-less block gets its own, honest status line.
            if (ev.tool) sinks.onToolNote(`⛔ ${ev.tool} blocked — ${ev.reason}`);
            else sinks.onStatus?.(`stopped — ${ev.reason}`);
            break;
          case "capped":
            sinks.onCapped?.(ev.rounds);
            break;
          case "paused":
            sinks.onPaused?.(ev.idleMs);
            break;
          case "done":
            if (streamed) sinks.onTurnComplete();
            break;
          default:
            break;
        }
      }
      // A turn that produced no text at all still has to close, or the webview shows a
      // spinner forever waiting for a completion event that is never coming.
      if (!streamed) sinks.onTurnComplete();
    } catch (e) {
      /**
       * A turn the USER stopped is not an error.
       *
       * `cancel()` aborts the controller; the client's fetch rejects with an AbortError and it
       * lands here, so pressing "Cancel Current Turn" painted a red error bubble reading
       * "This operation was aborted" — as if something had gone wrong with the thing the user
       * had just deliberately stopped. Reproduced end to end through `ChatSession.send`.
       *
       * `status` is the webview's neutral channel (media/main.js renders `error` in red and
       * `status` as ordinary text), which is what a deliberate stop deserves.
       */
      if (this.controller?.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
        sinks.onStatus?.("⏹ turn cancelled");
      } else {
        sinks.onError(e instanceof Error ? e.message : String(e));
      }
      sinks.onTurnComplete();
    } finally {
      this.running = false;
      this.controller = undefined;
      this.currentSend = undefined;
    }
  }
}
