/**
 * tui/index.ts — the raw-mode interactive TUI barrel.
 *
 * The public entry is `launchTui(parsed)`; everything else (keys / input-box /
 * autocomplete / status / palette / reducer / frame / redraw / sudo / session-bridge)
 * is a PURE, individually-tested module the app composes. bin.ts calls launchTui for a
 * TTY session and falls back to the readline host when it returns TUI_NOT_TTY.
 */
export { launchTui, TUI_NOT_TTY } from "./app.js";
export type { TuiDeps } from "./app.js";
