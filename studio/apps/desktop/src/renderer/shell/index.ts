// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/ barrel — the desktop IDE-frame React components (file 08 §4).
 *
 * These BIND the pure shell model from @prometheus/ui (activity routing, ⌘K
 * palette filter, nemesis-shield state, the §6 theme-resolution brain) to React
 * + the DOM. The frame (handoff §2): TopBar (42px) · ActivityBar (46px rail) ·
 * Sidebar (contextual island) · RightRail (the always-present agent island / 42px
 * tray, ⌥⌘B) · BottomPanel (Terminal/Problems/Security/…, ⌃`) · ShellStatusBar
 * (26px, the nemesis shield + facts) · CommandPalette (⌘K), plus the
 * ThemeProvider/useTheme (§6 theming) the renderer root wraps everything in.
 */
export { ActivityBar } from "./ActivityBar.js";
export type { ActivityBarProps } from "./ActivityBar.js";
export { TopBar } from "./TopBar.js";
export type { TopBarProps } from "./TopBar.js";
export { AuthPill, AuthPicker } from "./AuthPill.js";
export { PrometheusMark } from "./PrometheusMark.js";
export type { PrometheusMarkProps } from "./PrometheusMark.js";
export { DecisionOverlay } from "./DecisionOverlay.js";
export { ForceGate, useForceGate } from "./ForceGate.js";
export { EngineGate } from "./EngineGate.js";
export { Sidebar } from "./Sidebar.js";
export type { SidebarProps } from "./Sidebar.js";
export { ShellStatusBar } from "./StatusBar.js";
export type { ShellStatusBarProps } from "./StatusBar.js";
export { CommandPalette } from "./CommandPalette.js";
export type { CommandPaletteProps } from "./CommandPalette.js";
export { RightRail } from "./RightRail.js";
export type { RightRailProps, RightRailMode, AgentActivity } from "./RightRail.js";
export { BottomPanel, BOTTOM_TABS } from "./BottomPanel.js";
export type { BottomPanelProps, BottomTab } from "./BottomPanel.js";
export { ThemeProvider, useTheme } from "./ThemeProvider.js";
export type { ThemeContextValue } from "./ThemeProvider.js";
