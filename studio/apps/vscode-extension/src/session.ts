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
import { AGENT_TOOL_DISCIPLINE, runAgentTurn } from "@prometheus/core/agent-loop";
import type { ToolDef } from "@prometheus/core/agent-tools";

import { VSCODE_EXTRA_TOOLS, VSCODE_TOOL_ALLOW } from "./tool-runner.js";

/* ── the system prompt ───────────────────────────────────────────────────────*/

/**
 * Composes core's `AGENT_TOOL_DISCIPLINE` VERBATIM — the same sentences the CLI and the
 * desktop pane use. Only the framing differs (an editor with an open workspace). The rules
 * that actually change behaviour are shared text because paraphrasing them is what made the
 * surfaces drift last time.
 */
export const VSCODE_SYSTEM_PROMPT = [
  "You are Prometheus, an agentic coding assistant embedded in the user's VS Code editor, with REAL tools over their open workspace.",
  "`read_file`, `list_dir`, `glob` and `grep` inspect it; `write_file` creates a NEW file; `propose_edit` changes an EXISTING one; `apply_patch` changes several at once.",
  AGENT_TOOL_DISCIPLINE,
  "Do NOT rewrite a whole existing file with `write_file` — that is for brand-new files only, and overwriting loses precision.",
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
}

/**
 * A conversation. `thread` is MUTATED by core across rounds and turns — that accumulation IS
 * the conversation, so the same object is deliberately kept and reused.
 */
export class ChatSession {
  readonly thread: Thread;
  private readonly deps: SessionDeps;
  private running = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.thread = { messages: [{ role: "system", content: deps.tuning.systemPrompt }] };
  }

  get busy(): boolean {
    return this.running;
  }

  /** Reset to a fresh conversation, keeping the same tuning. */
  reset(): void {
    this.thread.messages.length = 0;
    this.thread.messages.push({ role: "system", content: this.deps.tuning.systemPrompt });
  }

  /** Run one user turn to completion, streaming onto `sinks`. */
  async send(text: string, sinks: SessionSinks): Promise<void> {
    if (this.running) {
      sinks.onError("a turn is already running");
      return;
    }
    this.running = true;
    this.thread.messages.push({ role: "user", content: text });
    let streamed = false;
    try {
      for await (const ev of runAgentTurn(this.thread, this.deps.tuning, {
        llm: this.deps.llm,
        runTool: this.deps.runTool,
        confirm: this.deps.confirm,
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
      // A turn that produced no text at all still has to close, or the webview shows a
      // spinner forever waiting for a completion event that is never coming.
      if (!streamed) sinks.onTurnComplete();
    } catch (e) {
      sinks.onError(e instanceof Error ? e.message : String(e));
      sinks.onTurnComplete();
    } finally {
      this.running = false;
    }
  }
}
