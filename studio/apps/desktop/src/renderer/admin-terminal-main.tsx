// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/admin-terminal-main.tsx — the React root of the root terminal window.
 *
 * A third renderer entry (beside index.html and floating-terminal.html). MAIN opens it only after
 * the human approved the exact command (main/root-terminal-window.ts); it mounts the display-only
 * <RootTerminalView>. Hardened like every window: contextIsolation, sandbox, the contextBridge.
 */

import "./styles/global.css";
import "@xterm/xterm/css/xterm.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { RootTerminalView } from "./ide/disk-space/RootTerminalView.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";
import { ThemeProvider } from "./shell/index.js";

const container = document.getElementById("root");
if (!container) throw new Error("admin-terminal: #root element not found");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ErrorBoundary label="admin-terminal">
        <RootTerminalView />
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
);
