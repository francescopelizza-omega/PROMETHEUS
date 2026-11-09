// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/ToastHost.tsx — renders the app-wide toast queue (stores/toasts.ts) through
 * @prometheus/ui's ToastViewport. Mounted once, at the root of App.tsx.
 */

import { ToastViewport } from "@prometheus/ui";
import type { ReactElement } from "react";

import { useToastStore } from "../stores/toasts.js";

export function ToastHost(): ReactElement {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  // top-right under the 42px TopBar: the bottom-right corner holds the agent composer, the
  // autonomy pill and the status bar, which a toast must never cover
  return <ToastViewport toasts={toasts} onDismiss={dismiss} placement="top-right" offsetTop={42} />;
}

export default ToastHost;
