/**
 * @prometheus/ui — the Prometheus Studio design system (08-design-system-ux.md).
 *
 * Public surface: design tokens (the single source of truth for color/space/type,
 * 08 §2), the theme@1 loader/applier (08 §6 + schemas/theme/v1.json), the 20
 * built-in color schemes (13 §3.1), and the minimal-but-real component set.
 *
 * Tokens are the only artifact shared with the CLI (08 §8) — the prometheus TUI reads
 * the same token data to drive its ANSI palette. Components import `react` only.
 */

/* ── design tokens (08 §2) + the 20-scheme registry (13 §3.1) ──────────────── */
export type {
  VerdictTier,
  Severity,
  ComponentState,
  FindingKlass,
  Ramp,
  RampName,
  SemanticColors,
  RoleToken,
  DensityMode,
  SchemeBase,
  ColorScheme,
} from "./tokens.js";
export {
  // primitive ramps
  neutral,
  violet,
  cyan,
  green,
  amber,
  red,
  slate,
  ramps,
  // semantic maps
  darkSemantic,
  lightSemantic,
  highContrastSemantic,
  // role maps + glyphs
  VERDICT_ROLE,
  SEVERITY_ROLE,
  STATE_ROLE,
  KLASS_ROLE,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  SEVERITY_GLYPH,
  DOT,
  // scale tokens
  typography,
  space,
  radius,
  elevation,
  density,
  motion,
  // scheme registry
  BUILTIN_SCHEMES,
  DEFAULT_SCHEME_ID,
  getScheme,
  baseSemantic,
  resolveScheme,
} from "./tokens.js";

/* ── formal tokens/ artifacts (08 §2/§6/§7): WCAG contrast math, Tailwind preset,
 *    Monaco/xterm theme-gen. primitives/semantic come via ./tokens.js above. ──── */
export * from "./tokens/index.js";

/* ── shell model (08 §4): activity routing + ⌘K palette filter + nemesis-shield
 *    state + the §6 theme-resolution brain. PURE + framework-free, shared with the
 *    prometheus TUI (08 §8). The desktop shell/ components bind these to React + the DOM. */
export * from "./shell/index.js";

/* ── custom activity-icon set (08 §4.1): bold inline-SVG glyphs for the rail.
 *    React component — kept OUT of the pure shell/ barrel so the TUI stays DOM-free. */
export type { ActivityIconProps } from "./shell/icons.js";
export { ActivityIcon, hasActivityIcon } from "./shell/icons.js";

/* ── theme@1 type + load/apply (08 §6, C12) ────────────────────────────────── */
export type { ThemeTokens, ThemeBase, ThemeMeta, SyntaxStyle } from "./theme.js";
export {
  loadTheme,
  validateTheme,
  exportTheme,
  applyTheme,
  applyDensity,
  themeToCssVars,
  schemeToTheme,
  defaultTheme,
  themeFromBase,
} from "./theme.js";

/* ── components (08 §3) ─────────────────────────────────────────────────────── */
export { VerdictBadge } from "./components/VerdictBadge.js";
export type { VerdictBadgeProps } from "./components/VerdictBadge.js";
export { CostLight } from "./components/CostLight.js";
export type { CostLightProps, CostTier } from "./components/CostLight.js";
export { StatusBar } from "./components/StatusBar.js";
export type { StatusBarProps, StatusItem } from "./components/StatusBar.js";
export { Button } from "./components/Button.js";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./components/Button.js";
export { Panel } from "./components/Panel.js";
export type { PanelProps, Elevation } from "./components/Panel.js";

/* ── Reliability & Polish pack: health visuals + polish atoms (token-only) ───── */
export { HealthGauge } from "./components/HealthGauge.js";
export type { HealthGaugeProps } from "./components/HealthGauge.js";
export { StatusPill } from "./components/StatusPill.js";
export type { StatusPillProps } from "./components/StatusPill.js";
export { EmptyState } from "./components/EmptyState.js";
export type { EmptyStateProps } from "./components/EmptyState.js";
export { ProgressRing, Spinner } from "./components/ProgressRing.js";
export type { ProgressRingProps } from "./components/ProgressRing.js";
export type {
  HealthBand,
  HealthRow,
  HealthViewStatus,
  HealthViewTier,
  SystemHealthView,
} from "./components/health-view.js";
export {
  clampScore,
  ringGeometry,
  scoreBand,
  scoreRole,
  statusGlyph as healthStatusGlyph,
  statusRole as healthStatusRole,
  tierGlyph as healthTierGlyph,
  tierRole as healthTierRole,
} from "./components/health-view.js";

/* ── primitive components (08 §3.1): the full vendored shadcn/Radix-equivalent set
 *    (Button is exported above from components/; the primitives barrel does NOT
 *    re-export a Button, so this is purely additive — Dialog, Command, Table, Tree,
 *    Tabs, Select, Toast, Badge, … all become reachable from the package root). ── */
export * from "./components/primitives/index.js";

/* ── icons (08 §2.5 + §3 tree): custom flame/shield/verdict glyphs + lucide set ── */
export * from "./icons/index.js";

/* ── hooks (08 §3 tree): useTheme/useDensity/useStreamLog/useEngine ─────────────── */
export * from "./hooks/index.js";

/* ── i18n (08 §7): the message catalog + t() so copy is translatable, never inline ── */
export { t, en, registerLocale, setLocale, locale } from "./i18n/index.js";
export type { MessageKey, Catalog } from "./i18n/index.js";

/* ── security center (file 03 §4–§9): 10 components + pure helpers + shapes ──── */
export * from "./security/index.js";

/* ── environments (file 04 §3/§5): env picker + package table + wizard + cuda ── */
export * from "./env/index.js";

/* ── model hub (file 05 §7/§8): hub shell + fit table + download queue + serving ── */
export * from "./modelhub/index.js";

/* ── product patterns (file 08 §3.2): the components that ARE Prometheus ─────────
 *    The UNIQUE pattern components are exported directly. The two NAME-CLASHING
 *    ones — VerdictBadge (already exported above from components/) and FindingRow
 *    (the security/ one, exported above) — are NOT re-flattened here: the §3.2
 *    pattern FindingRow + the full helper set live under the `patterns` namespace
 *    below, so both the engine-data FindingRow and the security one stay reachable. */
export { VerdictPanel } from "./patterns/VerdictPanel.js";
export type { VerdictPanelProps } from "./patterns/VerdictPanel.js";
export { ModelCard } from "./patterns/ModelCard.js";
export type { ModelCardProps } from "./patterns/ModelCard.js";
export { VenvRow, PackageRow } from "./patterns/VenvRow.js";
export type { VenvRowProps, PackageRowProps } from "./patterns/VenvRow.js";
export { CatalogItem } from "./patterns/CatalogItem.js";
export type { CatalogItemProps } from "./patterns/CatalogItem.js";
export { StatusMark } from "./patterns/StatusMark.js";
export type { StatusMarkProps, Presence } from "./patterns/StatusMark.js";
export { AgentStatusDot } from "./patterns/AgentStatusDot.js";
export type { AgentStatusDotProps } from "./patterns/AgentStatusDot.js";
export { StreamLog } from "./patterns/StreamLog.js";
export type { StreamLogProps } from "./patterns/StreamLog.js";
export { RiskGauge } from "./patterns/RiskGauge.js";
export type { RiskGaugeProps } from "./patterns/RiskGauge.js";
export { EngineState } from "./patterns/EngineState.js";
export type { EngineStateProps } from "./patterns/EngineState.js";
export type {
  PatternFinding,
  PatternVerdictReport,
  ModelQuant,
  ModelCardData,
  VenvRowData,
  PackageRowData,
  CatalogItemData,
  AgentPresence,
  AgentCounts,
  StreamLogLine,
  EngineStateData,
} from "./patterns/types.js";
/** The full §3.2 surface (incl. the engine-data FindingRow + every pure helper)
 *  under one namespace — avoids the VerdictBadge/FindingRow root name clashes. */
export * as patterns from "./patterns/index.js";

/* ── marketplace (file 09 §6): the four-tab browser + VerdictChip + MCP/extension
 *    rows + pure projections (verdictChip/filterRows/sortRows/healthDot). All
 *    presentational; the gated install flow runs in the container (C5). ────────── */
export * from "./marketplace/index.js";

/* ── AI providers + billing (file 12 §4/§5): the Tier-A-first provider picker, the
 *    loud §4.1 PAY-PER-USE typed-confirm cost modal, the §4.3 live spend meter, and
 *    the §5.1 AI-Providers settings screen, plus the pure sort/copy/meter projections
 *    the prometheus CLI shares. Presentational; the container wires core's ai.* + keychain. */
export * from "./ai/index.js";

/* ── theming (file 13 Area 3): the scheme registry (08's 20 builtins + user customs),
 *    the loader (parse/apply/save over 08's resolution + Monaco/xterm gen), and the
 *    §3.4 WCAG contrast save-gate (verdict tokens fail-closed). Namespaced `themes` so
 *    CustomThemeFile/ContrastReport never collide with the flat ThemeTokens (08). ──── */
export * as themes from "./themes/index.js";
