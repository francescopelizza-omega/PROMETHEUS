// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
import { ai } from "@prometheus/core";
import { authLevelToMode } from "@prometheus/core/agent-authorization";
import type { ConfirmResult, LLMClient, ToolCall } from "@prometheus/core/agent-loop";

import { resolveAuthLevel } from "./auth-level.js";
import { CHAT_VIEW_ID, ChatViewProvider, confirmToolCall } from "./chat-view.js";
import { resolveEffortTier } from "./effort-pref.js";
import { createEndpointLlmClient } from "./llm.js";
import { touchModelActivity } from "./model-activity-store.js";
import { ChatSession, vscodeTuning } from "./session.js";
import { createVsCodeToolRunner } from "./tool-runner.js";
import { createVsCodeWorkspaceIo, normalizeWorkspaceRelPath } from "./workspace-io.js";

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
  /**
   * Replace the model client. Pass undefined to restore the configured endpoint.
   *
   * AWAIT IT. Swapping the client rebuilds the session, and the rebuild is asynchronous because
   * it stops and waits out any in-flight turn first. These setters used to return `void` while
   * firing `void rebuild()`, so a caller that set a client and immediately submitted raced the
   * rebuild and drove the OLD session — the one still wired to the configured endpoint. In the
   * integration suite that is every test after the activation ones: they injected a scripted
   * model, submitted, and got nothing back, because the turn went to an endpoint that is not
   * there. The whole point of this API is injection, so the injection has to be awaitable.
   */
  setLlmClient(llm: LLMClient | undefined): Promise<void>;
  /** Replace the human confirm surface (the tests auto-answer; a modal would hang them). AWAIT IT — see `setLlmClient`. */
  setConfirm(fn: ((call: ToolCall) => Promise<ConfirmResult>) | undefined): Promise<void>;
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
   *
   * The OUTGOING session is stopped and AWAITED before being discarded: an ordinary action
   * (the user changing a `prometheus.*` setting, or a workspace-folder change) firing mid-turn
   * used to swap `session` out from under a still-running turn. The old ChatSession kept
   * streaming into the webview via sinks that route through `ChatViewProvider.post` (unaffected
   * by the swap), while `cancel()`/`submit()` — which always re-resolve `session()` fresh —
   * started acting on the brand-new, idle instance instead: Cancel silently stopped working
   * ("no turn is currently running"), and sending a new message started a SECOND, fully
   * independent turn concurrently with the still-running orphaned one.
   */
  /**
   * What the LAST rebuild was keyed to, so the next one can tell a cosmetic settings change from
   * a real change of model or workspace. `undefined` before the first build.
   */
  let sessionKey: string | undefined;
  /**
   * Bumped every time an LLM client is injected. Swapping the client IS a change of model, so it
   * belongs in the session key — otherwise a fresh client inherits the previous conversation,
   * which is both wrong in principle and what made two integration tests see an earlier test's
   * tool result in their thread.
   */
  let llmEpoch = 0;

  const rebuild = async (): Promise<void> => {
    const outgoing = session;
    if (outgoing) await outgoing.stopAndWaitIdle();
    /**
     * The conversation so far, MINUS the system prompt (the new session writes its own).
     *
     * Any `prometheus.*` setting change calls `rebuild()`, which constructs a fresh `ChatSession`
     * with an empty thread — while the webview transcript is left on screen untouched. So
     * nudging `authLevel` or `contextWindow` silently erased the model's whole memory of the
     * conversation, and the user's next message landed on a model that had never seen any of it.
     * Reproduced: 5 messages before, 1 (the system prompt) after.
     *
     * A rebuild that genuinely changes the MODEL or the WORKSPACE is a different conversation and
     * should start clean — that is what `rebuild`'s own docstring intends. This only preserves
     * the thread when neither changed, and says so out loud when it does reset.
     */
    const carried = outgoing ? outgoing.thread.messages.slice(1) : [];

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      session = undefined;
      unavailable = "Open a folder to chat with Prometheus about your workspace.";
      return;
    }
    // Resolved AGAINST THE FOLDER: `inspect()` only reports `workspaceFolderValue` when the
    // configuration was resolved against a resource, so without this a per-folder
    // `prometheus.effort` (the one setting declaring `"scope": "resource"`) was silently ignored.
    // Harmless for the window-scoped reads on `cfg` — VS Code ignores folder values for those.
    const cfg = vscode.workspace.getConfiguration("prometheus", folder.uri);
    const io = createVsCodeWorkspaceIo(folder);

    /**
     * The model id may be EMPTY, and that is fine: `createEndpointLlmClient` discovers one from
     * the endpoint at first use.
     *
     * The shipped default used to be the literal `prometheus-local`, which no Modelfile, install
     * step or any other artifact in this repo ever creates — so a user who installed the .vsix
     * and typed one word got `HTTP 404 … model 'prometheus-local' not found` on their very first
     * message. Verified against a real Ollama. Substituting a different hardcoded tag would fail
     * the same way on a machine that does not happen to have it, so the id is DISCOVERED.
     *
     * The discovery is deliberately NOT done here. `rebuild()` is fired as `void rebuild()` on
     * activation, so an `await` on this path means `api.session()` is still undefined when
     * `activate()` returns — which broke the integration suite's very first API assertion. Doing
     * it lazily also means a probe only happens when a turn actually needs one.
     */
    const model = (cfg.get<string>("model") ?? "").trim();
    // Resolved once: it feeds the tuning, the permission mode AND the session's own ladder.
    const authLevel = resolveAuthLevel(cfg);

    /**
     * ONE endpoint object, shared by the LLM client and the session's own budget.
     *
     * It used to be built inline here and the `contextWindow` read a SECOND time below, so the
     * two could disagree — and both defaulted to a literal 8192, which is the number CLAUDE.md
     * §2.8 records as "the bug, not the guard": this repo's own prompt (system text plus ~46
     * tool schemas) measures ~7.2k tokens, leaving a thinking model ~900 to work in. It spends
     * them reasoning and is cut off mid-thought, producing a turn with no answer at all.
     *
     * Sharing the object also means the probe below refines BOTH.
     */
    const endpoint = endpointFromConfig(cfg, model);
    // Fire-and-forget, exactly as `ai/context-window.ts` documents for session start: awaiting
    // here would leave `api.session()` undefined when `activate()` returns (see above).
    void refineContextWindow(endpoint);

    session = new ChatSession({
      llm:
        llmOverride ??
        createEndpointLlmClient({
          endpoint,
          // read lazily: `session` is assigned just below, and this is only ever called
          // mid-turn, long after that.
          getSignal: () => session?.currentSignal,
          // Real activation opts INTO the autostart gates; llm.ts's own tests never do — see
          // EndpointLlmOptions.ensureOllamaRunningFn's doc for why that split exists.
          ensureOllamaRunningFn: ai.ensureOllamaRunning,
          ensureLmStudioRunningFn: ai.ensureLmStudioRunning,
          onLocalActivity: touchModelActivity,
        }),
      runTool: createVsCodeToolRunner({
        io,
        onToolNote: (note) => provider.post({ type: "tool", note }),
      }),
      confirm: (call) => (confirmOverride ?? confirmToolCall)(call),
      // the SAME resolved id the endpoint got — keying the tuning to a different (phantom)
      // model was half of what made the old default so confusing to diagnose.
      // The autonomy level AND the reasoning-effort tier, both resolved from the same
      // precedence: an explicit VS Code setting, else the store shared with the CLI and the app.
      //
      // `authLevelToMode(level)` rather than `undefined` for the permission mode: the two knobs
      // are two views of one posture, and leaving the mode unset let them disagree (the loop
      // honours the mode matrix's `deny` verdict, so an unset mode simply forfeits that check).
      // It cannot WIDEN anything — the matrix only ever denies.
      tuning: vscodeTuning(model, authLevel, authLevelToMode(authLevel), resolveEffortTier(cfg)),
      // The level as a NUMBER too, so the session can apply the whole ladder rather than the
      // single bit `tuning.yes` collapses it to — see `SessionDeps.authLevel`.
      authLevel,
      /**
       * The scope test for a write the level would otherwise auto-approve.
       *
       * `normalizeWorkspaceRelPath` IS the containment rule this host already enforces at the
       * runner: it returns null for an absolute path, a `file://` URI, a `~` path, or anything
       * that climbs out with `..`. Non-null therefore means "inside the folder the user opened",
       * which is exactly this surface's working set (a multi-root workspace is scoped to the
       * first folder — see the README).
       */
      insideWorkingSet: (p) => normalizeWorkspaceRelPath(p) !== null,
      // so the session can warn before the window it will be rejected at — see `SessionDeps`.
      // Read off the SHARED endpoint, not the setting a second time: two independent reads of
      // the same config could disagree, and only this one is refined by the probe.
      contextWindow: endpoint.contextWindow,
    });

    const key = `${folder.uri.fsPath}|${cfg.get<string>("baseUrl") ?? ""}|${model}|${llmEpoch}`;
    if (carried.length > 0) {
      if (sessionKey === undefined || sessionKey === key) {
        session.thread.messages.push(...carried); // same model, same folder — keep the thread
      } else {
        provider.post({
          type: "status",
          text: "⟳ model or workspace changed — starting a fresh conversation.",
        });
      }
    }
    sessionKey = key;
  };

  void rebuild();

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
    vscode.commands.registerCommand("prometheus.newSession", async () => {
      await provider.reset();
    }),
    vscode.commands.registerCommand("prometheus.cancel", () => {
      if (!provider.cancel()) {
        void vscode.window.showInformationMessage("Prometheus: no turn is currently running.");
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void rebuild()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("prometheus")) void rebuild();
    }),
  );

  return {
    view: provider,
    setLlmClient(llm) {
      llmOverride = llm;
      llmEpoch += 1; // a different client is a different model — start a fresh conversation
      return rebuild();
    },
    setConfirm(fn) {
      confirmOverride = fn;
      return rebuild();
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
function endpointFromConfig(cfg: vscode.WorkspaceConfiguration, model: string): AiEndpoint {
  const baseUrl = cfg.get<string>("baseUrl") ?? "http://localhost:11434/v1";
  // `locality` gates core's cloud policy, so it is derived from the URL rather than trusted
  // from a setting: a loopback address is local, anything else may leave the machine.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseUrl);
  return {
    id: `vscode:${model}`,
    baseUrl,
    locality: local ? "local" : "cloud",
    // A POSITIVE setting is an explicit override and is honoured. Anything else (0, absent,
    // nonsense) means "ask the server", and `refineContextWindow` does that — so the floor here
    // is only what the first turn budgets against while the probe is in flight.
    contextWindow: configuredContextWindow(cfg) ?? ai.DEFAULT_CONTEXT_WINDOW,
    supportsTools: true,
    model,
    ...(cfg.get<string>("apiKeyRef") ? { apiKeyRef: cfg.get<string>("apiKeyRef") as string } : {}),
  };
}

/** The user's explicit window, or undefined when they have left it on auto. */
export function configuredContextWindow(cfg: vscode.WorkspaceConfiguration): number | undefined {
  const raw = cfg.get<number>("contextWindow");
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/**
 * Replace the placeholder window with the one the server actually serves.
 *
 * This surface was the last one still ASSERTING a context window instead of measuring it. The
 * CLI and the desktop both probe (`ai/context-window.ts`); the extension shipped a hardcoded
 * 8192, which on a 262,144-window model under-states it by 32x — and under-stating is not the
 * harmless direction. Every budget that scales with the window shrinks with it: the tool
 * preamble drops tool descriptions, compaction fires on a conversation that had ample room, and
 * the reply reserve leaves a thinking model no space to answer in.
 *
 * Never throws and never blocks: an unreachable runner, an unrecognised shape or an implausible
 * number all leave the endpoint exactly as it was. An explicit user setting is not overridden —
 * asking the server is the DEFAULT, not a correction of something they chose.
 */
export async function refineContextWindow(
  endpoint: AiEndpoint,
  probe: typeof ai.probeContextWindow = ai.probeContextWindow,
  doFetch: typeof fetch = fetch,
): Promise<void> {
  try {
    const res = await probe(
      endpoint.baseUrl,
      endpoint.model ?? endpoint.id,
      doFetch as Parameters<typeof ai.probeContextWindow>[2],
      ai.PROBE_TIMEOUT_MS,
    );
    // `source === "default"` means nothing answered — the probe is fail-soft and returns the
    // floor rather than throwing, so it must not be mistaken for a measurement. And only ever
    // GROW the window: a user who typed a deliberate smaller value keeps it.
    if (res.source !== "default" && res.contextWindow > endpoint.contextWindow) {
      endpoint.contextWindow = res.contextWindow;
    }
  } catch {
    /* the configured floor stands; a probe failure must never cost a session */
  }
}
