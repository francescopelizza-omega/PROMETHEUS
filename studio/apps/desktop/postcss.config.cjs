/*
 * postcss.config.cjs — the PostCSS pipeline for the desktop renderer (file 08 §6).
 *
 * Two plugins, in order: tailwindcss (compiles @tailwind base/components/utilities
 * against tailwind.config.ts → the token-mapped utility layer) then autoprefixer
 * (vendor prefixes for the Electron/Chromium target). The electron-vite renderer
 * points its `css.postcss` at this directory (see electron.vite.config.ts) so the
 * @tailwind directives in styles/global.css compile during the renderer build.
 *
 * CommonJS (`.cjs`) so it loads regardless of the package's `type: module`, the
 * canonical shape PostCSS/Vite expect. tailwindcss + autoprefixer are DECLARED in
 * package.json but installed by the orchestrator AFTER this pass; this config is
 * source-only and activates once they land.
 */

const { resolve } = require("node:path");

module.exports = {
  plugins: {
    tailwindcss: { config: resolve(__dirname, "tailwind.config.ts") },
    autoprefixer: {},
  },
};
