// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * chat-view.ts — the sidebar webview view provider, and the permission-confirm surface.
 *
 * This is the only module besides workspace-io.ts that imports `vscode`. It owns the view's
 * HTML, the postMessage bridge, and the human confirm seam core's loop calls into.
 */

import * as vscode from "vscode";

import type { ConfirmResult, ToolCall } from "@prometheus/core/agent-loop";

import type { FromWebview, ToWebview } from "./protocol.js";
import type { ChatSession, SessionSinks } from "./session.js";

export const CHAT_VIEW_ID = "prometheus.chatView";

/* ── the permission-confirm surface ──────────────────────────────────────────*/

/**
 * Ask the human about a gated tool call, as a NATIVE MODAL DIALOG.
 *
 * CHOICE (and why it is this and not a webview modal): a `showWarningMessage({modal: true})`
 * is a real, OS-level VS Code dialog. It cannot be missed, it cannot be styled away, it steals
 * focus, and — decisively — it does not depend on the sidebar being visible. A webview modal
 * would be prettier and would be a lie: the webview is destroyed whenever the user collapses
 * the view or switches to another activity-bar container, so a confirm rendered there would
 * silently never appear and the turn would hang waiting on a dialog nobody could see. The
 * native dialog is also the surface VS Code users already recognise as "this is about to
 * change something".
 *
 * The cost is that it is modal and cannot show a rich diff. That is the honest trade for an
 * MVP: the alternative surface is not "a nicer confirm", it is "a confirm that sometimes does
 * not exist".
 *
 * The `remember: "session"` answer is carried on the result. Core's loop ignores it — it is
 * read by `withRememberedGrants` — so offering it here costs nothing and the button is honest
 * only once that wrapper is wired; see README.md "Scoped out".
 */
export async function confirmToolCall(call: ToolCall): Promise<ConfirmResult> {
  const detail = summarizeArgs(call);
  const choice = await vscode.window.showWarningMessage(
    `Prometheus wants to run \`${call.name}\``,
    { modal: true, detail },
    "Allow",
    "Deny",
  );
  // `undefined` is the user dismissing the dialog (Esc / clicking away). That is a DENY, and
  // it must be, because core treats a missing confirm as deny and an ambiguous dismissal must
  // never be the one path that grants a destructive tool.
  if (choice !== "Allow") {
    return { approved: false, reason: "the user declined this tool call" };
  }
  return { approved: true };
}

/** A compact, readable rendering of a call's arguments for the dialog body. */
function summarizeArgs(call: ToolCall): string {
  const entries = Object.entries(call.args ?? {});
  if (entries.length === 0) return "No arguments.";
  return entries
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      // Truncated because a `write_file` content argument is an entire file, and a modal that
      // is thirty screens tall cannot be read or dismissed comfortably.
      const short = s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
      return `${k}: ${short}`;
    })
    .join("\n");
}

/* ── the view provider ───────────────────────────────────────────────────────*/

export interface ChatViewDeps {
  extensionUri: vscode.Uri;
  /** Resolves the session lazily — a workspace may not be open when the view first resolves. */
  session(): ChatSession | undefined;
  /** Explains why there is no session, for the transcript. */
  unavailableReason(): string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly deps: ChatViewDeps;

  /**
   * Every message posted to the webview, kept for the integration tests.
   *
   * The alternative — reaching into the webview's DOM from a test — is not possible: the
   * webview is a sandboxed iframe in a separate process that the extension host cannot script.
   * Recording what was posted is therefore the closest observable to "what the user sees", and
   * it is the real production path (nothing reaches the panel except through `post`). Capped
   * so a long session cannot grow it without bound.
   */
  readonly posted: ToWebview[] = [];

  /** Whether a turn is running right now — survives the backlog cap. See `post`. */
  private busyState = false;

  constructor(deps: ChatViewDeps) {
    this.deps = deps;
  }

  get resolved(): boolean {
    return this.view !== undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // The ONLY directory the webview may load from. Without this a compromised panel could
      // ask for any file on disk by Uri.
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebview) => {
      void this.onMessage(msg);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    /**
     * REPLAY what this view missed.
     *
     * VS Code disposes and re-creates a webview when the user collapses the sidebar or switches
     * activity-bar container. Setting fresh HTML and posting nothing left the panel EMPTY —
     * while `posted`, the 1000-message history right below, held the whole conversation the
     * entire time. A turn running at that moment had already sent its `busy` to the OLD view, so
     * the new one showed no spinner: an idle, empty panel while the model was still working.
     *
     * Deferred a tick because the webview's script has not loaded yet at resolve time; posting
     * synchronously would drop every message on the floor for the same reason.
     */
    const backlog = [...this.posted];
    // Re-assert the busy state LAST, after the backlog: whatever the (capped) history contains,
    // the panel must end up in the state the turn is actually in.
    if (this.busyState && !backlog.some((m) => m.type === "busy" && m.busy)) {
      backlog.push({ type: "busy", busy: true });
    }
    if (backlog.length > 0) {
      setTimeout(() => {
        if (this.view !== view) return; // superseded again before the replay landed
        for (const msg of backlog) void view.webview.postMessage(msg);
      }, 0);
    }
  }

  /** Post to the panel. Safe to call when no view is resolved — the record still happens. */
  post(msg: ToWebview): void {
    // The CURRENT busy state is tracked outside the capped backlog. A `busy:true` is posted once,
    // at the start of a turn, and a long streaming turn easily posts more than 1000 deltas after
    // it — at which point the cap below splices the marker off the FRONT. The replay then had no
    // `busy` in it, so a webview re-created mid-turn (collapse the sidebar, switch container)
    // came back UNLOCKED while the model was still working, and the user could send into a
    // running turn.
    if (msg.type === "busy") this.busyState = msg.busy;
    this.posted.push(msg);
    if (this.posted.length > 1000) this.posted.splice(0, this.posted.length - 1000);
    void this.view?.webview.postMessage(msg);
  }

  /** The sinks a turn streams onto. */
  sinks(): SessionSinks {
    return {
      onText: (text) => this.post({ type: "delta", text }),
      onReasoning: (text) => this.post({ type: "reasoning", text }),
      onStatus: (text) => this.post({ type: "status", text }),
      onToolNote: (note) => this.post({ type: "tool", note }),
      onTurnComplete: () => this.post({ type: "done" }),
      onError: (text) => this.post({ type: "error", text }),
      onCapped: (rounds) =>
        this.post({
          type: "status",
          text: `paused after ${rounds} rounds — send another message to continue`,
        }),
      onPaused: (idleMs) =>
        this.post({
          type: "status",
          text: `⏸ paused after ${Math.round(idleMs / 1000)}s of inactivity — nothing lost, send another message to continue`,
        }),
    };
  }

  /** Run a user turn. Exposed so the commands and the tests can drive it without the DOM. */
  async submit(text: string): Promise<void> {
    const session = this.deps.session();
    this.post({ type: "user", text });
    if (!session) {
      this.post({ type: "error", text: this.deps.unavailableReason() });
      this.post({ type: "done" });
      return;
    }
    this.post({ type: "busy", busy: true });
    await session.send(text, this.sinks());
  }

  /**
   * Cancels and WAITS OUT any in-flight turn (via `ChatSession.reset()`) before clearing the
   * webview's transcript and posting `{type:"reset"}` — posting first used to let main.js call
   * `setBusy(false)` (hiding Cancel, re-enabling Send) while the extension host's session was
   * still genuinely running, so the only control that could stop it disappeared from view.
   */
  async reset(): Promise<void> {
    await this.deps.session()?.reset();
    this.post({ type: "reset" });
  }

  /**
   * Stop the turn currently running, if any. Used by both the `prometheus.cancel` command and
   * the webview's Cancel button — same method, same session, so the two surfaces can never
   * disagree about whether a turn is actually running.
   */
  cancel(): boolean {
    return this.deps.session()?.cancel() ?? false;
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({ type: "ready" });
        break;
      case "send":
        await this.submit(msg.text);
        break;
      case "reset":
        await this.reset();
        break;
      case "cancel":
        this.cancel();
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const uri = (...p: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, ...p));
    const nonce = makeNonce();
    // A strict CSP with a per-load nonce. `default-src 'none'` means the panel cannot reach the
    // network at all, so no model output can ever cause it to phone home; scripts are limited
    // to the one nonced file, which is why the panel renders model text with `textContent`
    // rather than relying on the CSP alone.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri("media", "style.css")}" rel="stylesheet">
<title>Prometheus</title>
</head>
<body>
<div id="log"></div>
<form id="composer">
<textarea id="prompt" rows="1" placeholder="Ask Prometheus about this workspace…" aria-label="Message"></textarea>
<button id="send" type="submit">Send</button>
<button id="cancel" type="button" hidden>Cancel</button>
</form>
<script nonce="${nonce}" src="${uri("media", "main.js")}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
