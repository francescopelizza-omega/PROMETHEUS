/**
 * format — file 14 §3.5: formatter presets (opencode set) + format-on-save/after-edit
 * policy + argv builder. Pure settings-data; each formatter is gate-registered by the
 * caller (C12).
 */
export type { FormatPolicy, FormatterPreset } from "./registry.js";
export {
  BUILTIN_FORMATTERS,
  DEFAULT_FORMAT_POLICY,
  buildFormatArgv,
  extOf,
  formatOnSaveEnabled,
  formatterForExt,
  resolveFormatter,
  shouldFormatAfterEdit,
  shouldFormatOnSave,
} from "./registry.js";

// EditorConfig resolver (APP-019 — pure `.editorconfig` parse/glob/merge + save transforms)
export type {
  EditorConfigEntry,
  EditorConfigSection,
  ParsedEditorConfig,
  ResolvedEditorConfig,
} from "./editorconfig.js";
export {
  applyEditorConfigTextRules,
  editorConfigMatches,
  parseEditorConfig,
  resolveEditorConfig,
} from "./editorconfig.js";
