/**
 * ai/index.ts — the AI-Providers surface (file 12 §4/§5): the Tier-A-first picker, the
 * loud §4.1 typed-confirm cost modal, the §4.3 live spend meter, and the §5.1 screen
 * that assembles them. Plus the PURE projections (sort/group/copy/meter) the
 * components + the prometheus CLI both render. Presentational; the container wires the engine.
 */
// NB: `CostTier` is intentionally NOT re-exported here — the root index already
// exports it from components/CostLight; re-exporting via this barrel's `export *`
// would shadow that. Import CostTier from the package root (or CostLight) instead.
export type {
  AiProviderRow,
  CostWarningCopy,
  CostWarningInput,
  SpendMeterModel,
  WarnLevel,
  WiringKind,
} from "./types.js";
export {
  ENABLE_METERED_PHRASE,
  TIER_SECTION,
  confirmEnabled,
  costWarningCopy,
  groupByTier,
  sortProviderRows,
  spendBarText,
  spendMeterModel,
} from "./types.js";
export { CostWarningModal } from "./CostWarningModal.js";
export type { CostWarningModalProps, CostWarningConfirm } from "./CostWarningModal.js";
export { SpendMeter } from "./SpendMeter.js";
export type { SpendMeterProps } from "./SpendMeter.js";
export { ProviderPicker } from "./ProviderPicker.js";
export type { ProviderPickerProps } from "./ProviderPicker.js";
export { AiProvidersScreen } from "./AiProvidersScreen.js";
export type { AiProvidersScreenProps, ActiveMeter, BrainSurface } from "./AiProvidersScreen.js";
