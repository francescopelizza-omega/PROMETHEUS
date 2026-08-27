/**
 * settings/index.ts — the settings + profiles barrel (file 09 §7.1).
 */
export type { Settings } from "./schema.js";
export { DEFAULT_SETTINGS, validateSettings } from "./schema.js";
export type { KeyProvenance, SettingsLayerId, SettingsLayerInput } from "./layering.js";
export {
  deepMerge,
  explainKey,
  flattenSettings,
  isSetAt,
  layerSettings,
  rawValueAt,
} from "./layering.js";
export type { Profile } from "./profiles.js";
export {
  BUILTIN_PROFILES,
  DEFAULT_PROFILE_ID,
  getProfile,
  applyProfile,
  resolveProfileLayer,
} from "./profiles.js";

// The four security settings, turned into decisions something can actually enforce.
export type { EgressKind, NetworkPolicy, SecurityPosture } from "./posture.js";
export {
  cloudAllowed,
  describePosture,
  effectiveGateMode,
  egressAllowed,
  isRestrictive,
  sanitizeWorkspaceLayer,
  securityPosture,
} from "./posture.js";

// --- keymap (file 13 §2.2): presets + conflict detection ------------------- //
export type {
  BindableCommand,
  BindingSource,
  ConflictResolution,
  KeyBinding,
  KeyConflict,
  Keymap,
} from "./keymap.js";
export {
  BINDABLE_COMMANDS,
  BUILTIN_KEYMAPS,
  DEFAULT_KEYMAP_ID,
  KEYMAP_PYCHARM,
  KEYMAP_VIM,
  KEYMAP_VSCODE,
  detectConflicts,
  getKeymap,
  isChord,
  normalizeKeys,
  resolveBindings,
  resolveConflict,
  setBinding,
} from "./keymap.js";

// --- settings tree (file 13 §2.1/§2.7): the PyCharm-parity tree + search ---- //
export type {
  SettingsControl,
  SettingsLayerName,
  SettingsNode,
  SettingsScope,
  SettingsValueRow,
} from "./tree.js";
export {
  PROFILE_CONTRIBUTIONS,
  SETTINGS_TREE,
  findNode,
  findNodeBySchemaKey,
  flattenTree,
  nodePath,
  resetInLayer,
  resolveProvenance,
  resolveRows,
  searchSettings,
  setInLayer,
} from "./tree.js";
