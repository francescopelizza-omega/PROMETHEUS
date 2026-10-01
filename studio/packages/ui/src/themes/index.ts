// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * themes — file 13 Area 3: the theming authoring surface on top of 08's token engine.
 * The registry (builtin = 08's 20 schemes, single source + user customs), the loader
 * (parse/apply/save wiring 08's resolution + Monaco/xterm gen), and the §3.4 WCAG
 * contrast save-gate (verdict tokens fail-closed). Re-exported as the `themes` NAMESPACE
 * so `CustomThemeFile`/`ContrastReport` never collide with the flat `ThemeTokens`.
 */
export type {
  AnsiOverrides,
  AnsiSlot,
  ContrastBadge,
  ContrastPair,
  ContrastPairKind,
  ContrastReport,
  CustomThemeFile,
  ParseOutcome,
  SaveOutcome,
  SchemeBase,
  SemanticColors,
  SyntaxTokenOverrides,
  UiTokenOverrides,
} from "./types.js";
export {
  autoFix,
  blockReason,
  canSave,
  checkContrast,
  contrastVerdictFor,
  measurePairs,
  saveBlockers,
} from "./contrast.js";
export type { TokenVerdict } from "./contrast.js";
export type { ActiveSelection, ThemeRegistry } from "./registry.js";
export {
  activeScheme,
  activeSchemeId,
  addUserScheme,
  clearWindowOverride,
  createThemeRegistry,
  customFileToScheme,
  getSchemeById,
  listSchemes,
  monacoBaseFor,
  removeUserScheme,
  schemeToCustomFile,
  setActive,
} from "./registry.js";
export type { SchemeAssets } from "./loader.js";
export { applySchemeToRoot, parseCustomThemeFile, prepareSave, schemeAssets } from "./loader.js";
