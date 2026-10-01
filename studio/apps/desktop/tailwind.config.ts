// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tailwind.config.ts — Tailwind for the desktop renderer (file 08 §6 / §2).
 *
 * Consumes @prometheus/ui's `tailwindPreset` (the §2 token → utility mapping;
 * every color is a `var(--token)`, NO raw hex per §6). The preset is imported
 * from its SOURCE module directly (not via the package barrel) so loading this
 * config in the PostCSS/Node context never drags in the React component tree.
 *
 * `content` scans the renderer + the extracted routes + the @prometheus/ui source
 * so Tailwind can tree-shake to only the utility classes actually used. EXISTING
 * components style via inline CSS vars and need no classes — only the NEW shadcn/
 * Radix components emit utilities; either way the content globs cover them.
 *
 * Declared-not-installed (the orchestrator installs tailwindcss/postcss/
 * autoprefixer after this pass). This config is source-only and compiles once the
 * toolchain lands; the electron-vite renderer wires PostCSS to pick it up.
 */

import { resolve } from "node:path";
import type { Config } from "tailwindcss";

// The token→utility preset lives in @prometheus/ui; import its SOURCE directly to
// keep this Node-context config free of the React barrel.
import { tailwindPreset } from "../../packages/ui/src/tokens/tailwind-preset.js";

const ROOT = resolve(__dirname, "..", "..");

const config: Config = {
  // dark-default chrome; the data-theme attribute (not Tailwind's class strategy)
  // drives theming, so Tailwind's own dark: variant keys off the same attribute.
  darkMode: ["selector", '[data-theme="dark"]'],
  content: [
    resolve(__dirname, "src/renderer/**/*.{ts,tsx,html}"),
    resolve(__dirname, "src/routes/**/*.{ts,tsx}"),
    resolve(ROOT, "packages/ui/src/**/*.{ts,tsx}"),
  ],
  // The preset carries the entire token theme extension; we add nothing on top so
  // the design system stays single-sourced.
  presets: [tailwindPreset as unknown as Config],
  theme: {},
  plugins: [],
};

export default config;
