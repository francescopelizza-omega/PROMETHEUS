/**
 * tokens/ barrel (file 08 §2/§3). The CANONICAL token source remains ../tokens.ts
 * (ramps + semantic maps + role maps + glyphs + typography/space/density), already
 * surfaced by the package barrel. This dir adds the file-08 artifacts:
 *   - primitives.ts / semantic.ts : the §2 structure (re-exports of ../tokens.ts)
 *   - contrast.ts                 : WCAG contrast math (§7)
 *   - tailwind-preset.ts          : the Tailwind theme extension (§2/§6)
 *   - monaco-theme.ts             : editor + xterm theme generated from tokens (§6)
 *   - tokens.json / tokens.css    : generated build artifacts (run build-tokens.ts)
 * Only the NEW modules are re-exported here (primitives/semantic come via ../tokens.js
 * to avoid duplicate-export collisions at the package barrel).
 */
export * from "./contrast.js";
export * from "./ansi.js";
export * from "./pelly-syntax.js";
export { tailwindPreset } from "./tailwind-preset.js";
export * from "./monaco-theme.js";
export { Z, LAYER_VARS, type LayerName } from "./layers.js";
