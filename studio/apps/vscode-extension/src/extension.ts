/**
 * extension.ts — activation.
 *
 * Registers the sidebar webview view provider and the commands, and builds the session out of
 * the three seams core's loop asks for:
 *
 *   LLMClient  → llm.ts             (an OpenAI-compatible endpoint, via core's createAiClient)
 *   ToolRunner → tool-runner.ts     (pure dispatch) over workspace-io.ts (vscode.workspace.*)
 *   confirm    → chat-view.ts       (a native modal dialog)
 *
 * Nothing here reimplements any part of the agent loop; `runAgentTurn` is imported from
 * `@prometheus/core` and driven in session.ts.
 */

import * as vscode from "vscode";

import type { AiEndpoint } from "@prometheus/core";
import type { ConfirmResult, LLMClient, ToolCall } from "@prometheus/core/agent-loop";

import { CHAT_VIEW_ID, ChatViewProvider, confirmToolCall } from "./chat-view.js";
import { createEndpointLlmClient } from "./llm.js";
import { ChatSession, vscodeTuning } from "./session.js";
import { createVsCodeToolRunner } from "./tool-runner.js";
import { createVsCodeWorkspaceIo } from "./workspace-io.js";

/**
 * The object `activate` resolves to.
 *
 * VS Code hands whatever `activate` returns to `extensions.getExtension(id).exports`, which is
 * the ONLY supported way for an integration test to reach inside a running extension. The two
 * setters are the injection seams the tests use — the same "inject a fake, drive the real
 * thing" discipline the rest of this repo's suites use, rather than a mock of the loop itself.
 */
export interface PrometheusApi {
  readonly view: ChatViewProvider;
  /** Replace the model client. Pass undefined to restore the configured endpoint. */
  setLlmClient(llm: LLMClient | undefined): void;
  /** Replace the human confirm surface (the tests auto-answer; a modal would hang them). */
  setConfirm(fn: ((call: ToolCall) => Promise<ConfirmResult>) | undefined): void;
  /** Send a user turn and resolve when it completes. */
  submit(text: string): Promise<void>;
  /** The live session, or undefined when no workspace folder is open. */
  session(): ChatSession | undefined;
}

export function activate(context: vscode.ExtensionContext): PrometheusApi {
  let llmOverride: LLMClient | undefined;
  let confirmOverride: ((call: ToolCall) => Promise<ConfirmResult>) | undefined;
  let session: ChatSession | undefined;

  /** The reason there is no session, phrased for a user rather than a log. */
  let unavailable = "Open a folder to chat with Prometheus about your workspace.";

  const provider = new ChatViewProvider({
    extensionUri: context.extensionUri,
    session: () => session,
    unavailableReason: () => unavailable,
  });

  /**
   * (Re)build the session.
   *
   * Called on activation and whenever the workspace folders or the relevant settings change.
   * The session holds the thread, so rebuilding deliberately starts a fresh conversation — the
   * old one was about a different workspace or a different model.
   */
  const rebuild = (): void => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      session = undefined;
      unavailable = "Open a folder to chat with Prometheus about your workspace.";
      return;
    }
    const cfg = vscode.workspace.getConfiguration("prometheus");
    const io = createVsCodeWorkspaceIo(folder);

    session = new ChatSession({
      llm: llmOverride ?? createEndpointLlmClient({ endpoint: endpointFromConfig(cfg) }),
      runTool: createVsCodeToolRunner({
        io,
        onToolNote: (note) => provider.post({ type: "tool", note }),
      }),
      confirm: (call) => (confirmOverride ?? confirmToolCall)(call),
      tuning: vscodeTuning(
        cfg.get<string>("model") ?? "prometheus-local",
        cfg.get<number>("authLevel") ?? 1,
      ),
    });
  };

  rebuild();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      // The transcript survives the user collapsing the sidebar. Without this the view is torn
      // down and rebuilt empty every time they switch activity-bar containers, which reads as
      // the extension losing the conversation.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("prometheus.focusChat", async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("prometheus.newSession", () => {
      provider.reset();
    }),
    vscode.commands.registerCommand("prometheus.cancel", () => {
      // Honest about its limits: the turn's abort plumbing is not wired in this MVP (see
      // README.md "Scoped out"), and a command that silently did nothing would be worse than
      // one that says so.
      void vscode.window.showInformationMessage(
        "Prometheus: cancelling a turn mid-flight is not supported yet.",
      );
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => rebuild()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("prometheus")) rebuild();
    }),
  );

  return {
    view: provider,
    setLlmClient(llm) {
      llmOverride = llm;
      rebuild();
    },
    setConfirm(fn) {
      confirmOverride = fn;
      rebuild();
    },
    submit: (text) => provider.submit(text),
    session: () => session,
  };
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is on `context.subscriptions`, and the session holds
  // no handle (no process, no socket) that outlives the extension host.
}

/** Build the endpoint from settings. Defaults to a local Ollama, the common local-first case. */
function endpointFromConfig(cfg: vscode.WorkspaceConfiguration): AiEndpoint {
  const baseUrl = cfg.get<string>("baseUrl") ?? "http://localhost:11434/v1";
  const model = cfg.get<string>("model") ?? "prometheus-local";
  // `locality` gates core's cloud policy, so it is derived from the URL rather than trusted
  // from a setting: a loopback address is local, anything else may leave the machine.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseUrl);
  return {
    id: `vscode:${model}`,
    baseUrl,
    locality: local ? "local" : "cloud",
    contextWindow: cfg.get<number>("contextWindow") ?? 8192,
    supportsTools: true,
    model,
    ...(cfg.get<string>("apiKeyRef") ? { apiKeyRef: cfg.get<string>("apiKeyRef") as string } : {}),
  };
}
