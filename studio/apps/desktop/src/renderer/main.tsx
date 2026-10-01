// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/main.tsx — the React 19 root (sandboxed renderer entry).
 *
 * Mounts <App/> into #root with the React 19 createRoot API, wrapped in:
 *   - <ThemeProvider> (file 08 §6): flips <html data-theme>/<data-density>, follows
 *     the OS scheme, and writes the token CSS vars — so the shell is themed with no
 *     reload/flicker and the Monaco/xterm theme-gen reads the same tokens.
 *   - <QueryClientProvider> (§5): one TanStack Query cache for every hook
 *     (useScan/useHealth/useCatalog/useStatus/useInstall).
 *
 * It first imports the single renderer stylesheet (styles/global.css), which pulls
 * @prometheus/ui tokens.css + the Tailwind layers (file 08 §6). This module runs in
 * the hardened renderer (contextIsolation:true, sandbox:true) and reaches the engine
 * ONLY through `window.prometheus` (the contextBridge seam) — nothing privileged.
 */

import "./styles/global.css";

// Bundled Space Grotesk — the BRAND face (handoff §1): the wordmark, the Home greeting
// and every island/card title. Offline, self-hosted via @fontsource (no network/CSP
// fetch). 500/600/700 cover title → wordmark; --font-brand-weight is 700.
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

// Montserrat stays bundled for the legacy brand surfaces that still name it (the
// onboarding hero); nothing new should reach for it — use --font-brand.
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";

// Bundled monospace families (offline, self-hosted via @fontsource) — the coding
// fonts PyCharm/the JetBrains IDEs ship or list for the editor + terminal, so the
// user can pick any of them (Settings → Fonts) exactly like PyCharm's font picker.
// JetBrains Mono is PyCharm's default. @font-face declares them but the browser
// only fetches a family when it is actually used, so importing all is cheap. We
// load regular + bold (+ italics where the family provides them) to cover normal/
// bold/italic editor tokens and bright/bold terminal cells. Keep in sync with
// ide/fonts/registry.ts (the picker's source of truth).
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/700-italic.css";
import "@fontsource/cascadia-code/400.css";
import "@fontsource/cascadia-code/700.css";
import "@fontsource/cascadia-code/400-italic.css";
import "@fontsource/cascadia-code/700-italic.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/700-italic.css";
import "@fontsource/inconsolata/400.css";
import "@fontsource/inconsolata/700.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/700.css";
import "@fontsource/roboto-mono/400-italic.css";
import "@fontsource/roboto-mono/700-italic.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/700.css";
import "@fontsource/source-code-pro/400-italic.css";
import "@fontsource/source-code-pro/700-italic.css";
import "@fontsource/ubuntu-mono/400.css";
import "@fontsource/ubuntu-mono/700.css";
import "@fontsource/ubuntu-mono/400-italic.css";
import "@fontsource/ubuntu-mono/700-italic.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { VisualHarness, visualHarnessRequested } from "./visual-harness.js";

import App from "./App.js";
import { hydrateEffortFromDisk } from "./ide/ai/effort-store.js";
import { createQueryClient } from "./query/client.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";
import { ThemeProvider } from "./shell/index.js";
import { hydrateAuthLevel } from "./stores/authorisation.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("renderer: #root element not found in index.html");
}

// Renderer-wide safety net: a fire-and-forget IPC call (e.g. `void x().then(...)`
// with no .catch) that rejects must NOT surface as an uncaught error overlay or
// noisy console crash — log it and swallow. Per-handler try/catch + the
// <ErrorBoundary> handle the user-facing cases; this catches the rest.
window.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.warn("[renderer] unhandled promise rejection (swallowed):", e.reason);
  e.preventDefault();
});
window.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("[renderer] uncaught error:", e.error ?? e.message);
});

// One QueryClient for the renderer's lifetime (created outside render so HMR /
// StrictMode double-invoke never spawns a second cache).
const queryClient = createQueryClient();

/**
 * Adopt the SHARED autonomy level before the first interaction.
 *
 * The level lives in `~/.prometheus/config/authorisation.json` — the same file `prometheus`
 * reads on the terminal — and reaching it means IPC, which is async. The store seeds itself
 * synchronously from this window's local mirror so the pill never flashes a wrong value, and
 * this replaces the seed with the file's value a tick later. Fire-and-forget on purpose: a
 * missing bridge or an unreadable home must not delay or block the mount.
 */
void hydrateAuthLevel();

/**
 * …and the shared thinking-effort tier, for the same reason and from the same config root.
 *
 * Both are fire-and-forget: a missing bridge or an unreadable home must not delay the mount,
 * and each store seeds itself synchronously from this window's own mirror first.
 */
void hydrateEffortFromDisk();

/**
 * The §9 decision-card baseline surface, in place of the workbench.
 *
 * Swapped at the ROOT rather than routed inside App: the two cards need to be the only
 * thing on screen for their screenshots, and reaching them through the workbench would
 * make the baseline a picture of the workbench. It mounts only when the e2e spec has set
 * the localStorage key — see visual-harness.tsx for why that is inert.
 */
const rootElement = visualHarnessRequested() ? <VisualHarness /> : <App />;

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary label="app">{rootElement}</ErrorBoundary>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
