/**
 * tailwind.config.ts — the @prometheus/ui Tailwind config (file 08 §3 scaffolding).
 *
 * It spreads the design-system token preset (src/tokens/tailwind-preset.ts), which
 * maps every utility color to a token CSS variable (NO raw hex — the §6 lint rule).
 * The vendored shadcn primitives express their look as token-mapped utility classes
 * (`bg-bg-surface`, `text-text-primary`, …); this config is what compiles them once
 * `tailwindcss` + `postcss` + `autoprefixer` are installed by the orchestrator. The
 * primitives ALSO carry an inline-style token fallback so they render before that
 * (see components/primitives/styles.ts).
 *
 * `tailwindcss` is DECLARED in package.json (devDependency) but NOT installed this
 * pass; this file is config-only and is not compiled by `tsc -b` (it lives outside
 * `src/`). The `satisfies` is dropped to keep it importable without the tailwind
 * types present — the orchestrator can re-add `satisfies Config` after install.
 */

import { tailwindPreset } from "./src/tokens/tailwind-preset.js";

const config = {
  // Scan our component sources + the desktop renderer that consumes them.
  content: [
    "./src/**/*.{ts,tsx}",
    "../../apps/desktop/src/renderer/**/*.{ts,tsx}",
    "../../apps/desktop/src/routes/**/*.{ts,tsx}",
  ],
  // Dark is the default theme (08 §2.1); theme swap flips <html data-theme>.
  darkMode: ["selector", '[data-theme="dark"]'],
  presets: [tailwindPreset],
  theme: { extend: {} },
  plugins: [],
};

export default config;
