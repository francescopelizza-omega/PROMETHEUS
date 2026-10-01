// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * semantic.ts — the role-named, theme-swappable semantic tokens (file 08 §2.1/§2.2).
 * Apps + the component library reference ONLY semantic tokens (never primitives). The
 * dark/light/high-contrast maps + the verdict/severity/state/klass role maps live in
 * ../tokens.ts (canonical); re-exported here under the file-08 structure.
 */
export {
  darkSemantic,
  lightSemantic,
  highContrastSemantic,
  baseSemantic,
  resolveScheme,
  VERDICT_ROLE,
  SEVERITY_ROLE,
  STATE_ROLE,
  KLASS_ROLE,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  SEVERITY_GLYPH,
  DOT,
} from "../tokens.js";
export type {
  SemanticColors,
  RoleToken,
  ColorScheme,
  SchemeBase,
  VerdictTier,
  Severity,
  ComponentState,
  FindingKlass,
} from "../tokens.js";
