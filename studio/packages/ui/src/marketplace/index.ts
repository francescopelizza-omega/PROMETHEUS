/**
 * marketplace/index.ts — the in-GUI marketplace barrel (file 09 §6).
 *
 * The four-tab browser + verdict chip + MCP server list + extension card, plus the
 * pure projections (verdictChip/filterRows/sortRows/healthDot/tierGlyph). All
 * presentational: data + handlers come from props; the gated install flow runs in
 * the container (the engine decides — C5).
 */
export type {
  MarketplaceTab,
  WorstVerdict,
  CatalogTier,
  McpHealth,
  SortBy,
  MarketplaceRow,
  McpServerRow,
  ExtensionRow,
  ChipDisplay,
} from "./types.js";
export {
  verdictChip,
  verdictRank,
  tierGlyph,
  healthDot,
  filterRows,
  sortRows,
} from "./types.js";
export { VerdictChip } from "./VerdictChip.js";
export type { VerdictChipProps } from "./VerdictChip.js";
export { MarketplaceView } from "./MarketplaceView.js";
export type { MarketplaceViewProps } from "./MarketplaceView.js";
export { McpServerList } from "./McpServerList.js";
export type { McpServerListProps } from "./McpServerList.js";
export { ExtensionCard } from "./ExtensionCard.js";
export type { ExtensionCardProps } from "./ExtensionCard.js";
