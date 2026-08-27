/**
 * session/context-window-setting.ts — the user-chosen CEILING auto-compaction budgets against.
 *
 * Independent of (and always combined with `Math.min`, by the caller) the model's own MEASURED
 * or assumed context window: a user on a local model whose real window is huge but whose quality
 * degrades past some point — or who simply wants to keep sessions light — can cap the number
 * auto-compact treats as "the window" via `/context window`. Defaults to 250,000 tokens, since
 * that is the ceiling most locally-run open models are actually good up to, whatever a bigger
 * number their metadata claims.
 *
 * Persisted in the SAME global settings blob `apps/cli/src/home.ts` already owns
 * (`~/.prometheus/config/settings.json`) — one more key, no new file, no new store.
 */
import { loadSettings, saveSettings } from "../home.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 250_000;

/** The `/context window` menu (CLI-style "dropdown" — a numbered pick in a terminal). */
export const CONTEXT_WINDOW_PRESETS: readonly number[] = Object.freeze([
  100_000, 250_000, 400_000, 500_000, 600_000, 750_000, 900_000, 1_000_000, 1_500_000,
]);

const MIN_TOKENS = 1_000;
const MAX_TOKENS = 10_000_000;

const SETTINGS_KEY = "contextWindowTokens";

/** `"300000"` / `"300k"` / `"1.5m"` → a token count, or null when unparseable / out of range. */
export function parseContextWindowInput(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(s);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
  const n = Math.round(base * mult);
  return n >= MIN_TOKENS && n <= MAX_TOKENS ? n : null;
}

/** The active context-window ceiling — the saved setting, or the 250k default. Fail-soft. */
export function loadContextWindowTokens(home: string): number {
  const raw = loadSettings(home)[SETTINGS_KEY];
  return typeof raw === "number" && raw >= MIN_TOKENS && raw <= MAX_TOKENS
    ? raw
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** Persist a new ceiling. Caller validates range (e.g. via `parseContextWindowInput`). */
export function saveContextWindowTokens(home: string, tokens: number): void {
  saveSettings({ [SETTINGS_KEY]: tokens }, home);
}
