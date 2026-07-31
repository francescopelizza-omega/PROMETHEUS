/**
 * renderer/floating-terminal-main.tsx — the React root for the APP-090 tear-out window.
 *
 * This is the SECOND renderer entry (electron.vite renderer multi-input, beside index.html).
 * The MAIN process opens a hardened secondary BrowserWindow loading floating-terminal.html
 * with `ptyId`/`title`/`scheme` in the URL query; this reads them, resolves the scheme id to
 * a ColorScheme, and mounts <FloatingTerminalWindow> (which ATTACHES to the existing PTY over
 * the same window.prometheus bridge — it never spawns one). Wrapped in <ThemeProvider> so the
 * float follows the global theme, plus the per-window scheme override (§3.5).
 *
 * Hardened renderer (contextIsolation:true, sandbox:true) exactly like the main window; it
 * reaches the engine ONLY through window.prometheus (the contextBridge seam).
 */

import "./styles/global.css";

import { getScheme } from "@prometheus/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { FloatingTerminalWindow } from "./ide/FloatingTerminalWindow.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";
import { ThemeProvider } from "./shell/index.js";

const params = new URLSearchParams(window.location.search);
const ptyId = params.get("ptyId") ?? "";
const title = params.get("title") ?? "Terminal";
const schemeId = params.get("scheme");
// resolve the scheme id → a ColorScheme (getScheme falls back to the default for unknown ids);
// omitted = the float follows the global theme via ThemeProvider (no per-window override).
const scheme = schemeId ? getScheme(schemeId) : undefined;

document.title = title;

window.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.warn("[floating-terminal] unhandled promise rejection (swallowed):", e.reason);
  e.preventDefault();
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("floating-terminal: #root element not found");
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ErrorBoundary label="floating-terminal">
        <FloatingTerminalWindow ptyId={ptyId} title={title} {...(scheme ? { scheme } : {})} />
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
);
