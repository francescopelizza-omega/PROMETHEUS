/**
 * shell/ barrel — the desktop IDE-frame React components (file 08 §4).
 *
 * These BIND the pure shell model from @prometheus/ui (activity routing, ⌘K
 * palette filter, nemesis-shield state, the §6 theme-resolution brain) to React
 * + the DOM. The frame: ActivityBar (48px rail) · Sidebar (contextual) ·
 * ShellStatusBar (the nemesis shield + facts) · CommandPalette (⌘K) · RightRail
 * (AI/inspector, ⌥⌘B) · BottomPanel (Terminal/Problems/Security/…, ⌃`), plus the
 * ThemeProvider/useTheme (§6 theming) the renderer root wraps everything in.
 */
export { ActivityBar } from "./ActivityBar.js";
export type { ActivityBarProps } from "./ActivityBar.js";
export { Sidebar } from "./Sidebar.js";
export type { SidebarProps } from "./Sidebar.js";
export { ShellStatusBar } from "./StatusBar.js";
export type { ShellStatusBarProps } from "./StatusBar.js";
export { CommandPalette } from "./CommandPalette.js";
export type { CommandPaletteProps } from "./CommandPalette.js";
export { RightRail } from "./RightRail.js";
export type { RightRailProps, RightRailMode } from "./RightRail.js";
export { BottomPanel, BOTTOM_TABS } from "./BottomPanel.js";
export type { BottomPanelProps, BottomTab } from "./BottomPanel.js";
export { ThemeProvider, useTheme } from "./ThemeProvider.js";
export type { ThemeContextValue } from "./ThemeProvider.js";
