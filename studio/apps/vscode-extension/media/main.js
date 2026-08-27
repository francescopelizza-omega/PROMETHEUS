/**
 * media/main.js — the sidebar chat panel's script.
 *
 * WHY THIS IS HAND-WRITTEN AND NOT A PORT OF AgentPane.tsx
 * -------------------------------------------------------
 * `apps/desktop/src/renderer/ide/ai/AgentPane.tsx` is ~2700 lines of React that reaches for
 * `@prometheus/ui`'s design system, Monaco, the DiffReview change-set store, the checkpoint /
 * session stores, and — structurally — the Electron preload bridge (`window.prometheus.*`),
 * which is a synchronous, request/response IPC surface. A VS Code webview has none of that: it
 * is a sandboxed iframe whose ONLY channel is asynchronous `postMessage`, under a strict CSP,
 * with the editor's own theme variables instead of the studio token set.
 *
 * Porting it would have meant reimplementing the bridge as a promise-multiplexer over
 * postMessage, vendoring the UI package and Monaco into the bundle, and cutting out the panes
 * that have no VS Code analogue — a large, awkward adapter around components whose whole value
 * is the surrounding IDE. The chat surface itself is a transcript, a composer and a busy state.
 * Written directly against the editor's own theme variables it is ~120 lines, has no build
 * step, and looks native in every VS Code theme.
 *
 * What is NOT re-implemented is anything that matters for correctness: the agent loop, the tool
 * gating and the file IO all live in the extension host, on `@prometheus/core`.
 */
// @ts-check
(() => {
  const vscode = acquireVsCodeApi();

  const log = document.getElementById("log");
  const form = document.getElementById("composer");
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("prompt"));
  const send = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
  const cancel = /** @type {HTMLButtonElement} */ (document.getElementById("cancel"));

  /** The assistant bubble currently being streamed into, if any. */
  let open = null;
  /** The dimmed reasoning block for the current turn (discarded when it ends). */
  let thinking = null;

  function el(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  function add(node) {
    // Only auto-scroll when the user is already at the bottom — yanking the viewport away
    // from someone who has scrolled up to read an earlier answer is the single most annoying
    // thing a streaming transcript can do.
    const stick = atBottom();
    log.appendChild(node);
    if (stick) log.scrollTop = log.scrollHeight;
    return node;
  }

  function setBusy(busy) {
    send.disabled = busy;
    input.disabled = busy;
    send.textContent = busy ? "Running…" : "Send";
    // Cancel is the ONLY control enabled while busy — everything else about the composer stays
    // locked for the same reason it always has (one turn at a time).
    cancel.hidden = !busy;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "user":
        open = null;
        add(el("msg user", msg.text));
        break;
      case "delta":
        if (!open) open = add(el("msg assistant", ""));
        // textContent, never innerHTML: model output is untrusted text and this panel has no
        // business executing it. The CSP would block inline script anyway; this stops the
        // subtler injections (an <img onerror>) from ever being parsed.
        open.textContent += msg.text;
        if (atBottom()) log.scrollTop = log.scrollHeight;
        break;
      case "reasoning":
        if (!thinking) thinking = add(el("msg thinking", ""));
        thinking.textContent += msg.text;
        break;
      case "tool":
        open = null;
        add(el("msg tool", msg.note));
        break;
      case "status":
        open = null;
        add(el("msg status", msg.text));
        break;
      case "error":
        open = null;
        add(el("msg error", msg.text));
        break;
      case "done":
        open = null;
        if (thinking) thinking.remove();
        thinking = null;
        setBusy(false);
        break;
      case "busy":
        setBusy(msg.busy);
        break;
      case "reset":
        log.replaceChildren();
        open = null;
        thinking = null;
        setBusy(false);
        break;
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    setBusy(true);
    vscode.postMessage({ type: "send", text });
  });

  cancel.addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });

  // Enter sends, Shift+Enter makes a newline — the convention every chat surface uses, and
  // the one users try first.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
