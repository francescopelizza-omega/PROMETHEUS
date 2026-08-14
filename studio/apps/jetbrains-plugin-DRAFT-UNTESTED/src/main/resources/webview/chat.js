// UNTESTED DRAFT.
//
// `window.appendOutput` is called from the Kotlin side (PrometheusChatPanel,
// via browser.cefBrowser.executeJavaScript) for every line the `prometheus` CLI
// subprocess prints. `window.sendToPrometheus` is injected by the Kotlin side
// after the JBCefJSQuery bridge is created; it is undefined until that
// injection runs, hence the defensive check in the submit handler below rather
// than assuming it exists at page-load time (see the VERIFY note in
// PrometheusChatPanel.kt about the injection timing potentially racing page
// load).

window.appendOutput = (text) => {
  const log = document.getElementById("log");
  const line = document.createElement("div");
  line.className = "line";
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
};

document.getElementById("input-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const box = document.getElementById("input-box");
  const text = box.value;
  if (text.length === 0) {
    return;
  }
  window.appendOutput(`> ${text}`);
  if (typeof window.sendToPrometheus === "function") {
    window.sendToPrometheus(text);
  } else {
    // The Kotlin-side bridge has not been injected yet (or failed to
    // inject) — surface that loudly in the log rather than silently
    // dropping the user's input.
    window.appendOutput("[prometheus-plugin] bridge not ready — input not sent.");
  }
  box.value = "";
});
