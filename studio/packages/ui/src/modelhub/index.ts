/**
 * modelhub/index.ts — the Model-Hub component barrel (file 05 §7/§8).
 *
 * The four presentational components the renderer wires `window.prometheus.
 * model.*` to (ModelHub shell · FitScorePanel · DownloadQueue · ServingPanel),
 * plus the pure MODEL-HUB-UNIQUE display helpers + the renderer-facing display
 * shapes. EVERYTHING here is C5-sandboxed: it imports only `react` + its own
 * modules + the @prometheus/ui security barrel (for the re-used VerdictSheet via
 * the route) — never node:*, electron, or the engine-bridge / core runtime. The
 * fit/gate decision NEVER originates here: it comes from the sidecar / engine,
 * carried in as data props.
 *
 * NOTE on collisions (mirrors env/index.ts): the helpers `inert`, `roleVar`,
 * `gateRole`, `gateGlyph`, `gateLabel`, `gateRefuses`, `formatBytes`, and
 * `gateToVerdict` ALSO exist on the env / security barrels at the top-level
 * @prometheus/ui surface — re-exporting them here would collide (TS2308). They
 * stay modelhub-internal (the components use them directly); only the
 * MODEL-HUB-UNIQUE helpers are re-exported.
 */

/* ── components (§7/§8) ──────────────────────────────────────────────────────── */
export { ModelHub } from "./ModelHub.js";
export type { ModelHubProps, HubTab } from "./ModelHub.js";
export { FitScorePanel } from "./FitScorePanel.js";
export type { FitScorePanelProps } from "./FitScorePanel.js";
export { DownloadQueue } from "./DownloadQueue.js";
export type { DownloadQueueProps } from "./DownloadQueue.js";
export { ServingPanel } from "./ServingPanel.js";
export type { ServingPanelProps } from "./ServingPanel.js";

/* ── pure MODEL-HUB-UNIQUE display helpers (§4/§5/§7/§8/§10) ─────────────────── */
export {
  // §4.2 fit verdict projection
  fitRole,
  fitGlyph,
  fitLabel,
  fitChipText,
  // §5 download-state projection
  downloadRole,
  downloadGlyph,
  downloadLabel,
  isDownloadTerminal,
  isDownloadBlocked,
  // §2.4 serve-status projection
  serveRole,
  serveGlyph,
  serveLabel,
  serveActions,
  // formatting
  formatGb,
  formatCount,
  qualityBar,
  // §10 modalities + §6 free-license + §5.3 pickle hint
  MODALITIES,
  modalityLabel,
  isFreeOpenLicense,
  recommendedExplainer,
  isPickleFile,
} from "./util.js";
export type {
  ModelRole,
  FitVerdict as FitVerdictTier,
  DownloadState as DownloadStateTier,
  GateTier as ModelGateTier,
  ServeRowStatus,
  ModalityFacet,
} from "./util.js";

/* ── renderer-facing display shapes (structural mirrors of the engine types) ─── */
export type {
  HardwareGpuData,
  HardwareCapsData,
  HardwareProfileData,
  ModelData,
  ScoredQuantData,
  FitResultData,
  ModelGateBadge,
  DownloadRowState,
  DownloadRowData,
  ServeEndpointData,
  ServeArgsData,
  ServeProfileData,
  EndpointData,
} from "./types.js";
