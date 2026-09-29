/**
 * i18n/catalog.ts — the message lookup, and the two rules that keep it honest.
 *
 * ── RULE 1: THE ENGLISH CATALOG IS THE SCHEMA ───────────────────────────────────────────────
 *
 * `Messages` is derived FROM the English catalog with `typeof`, so English is exhaustive by
 * construction: adding a key there is what creates it, and a translation file is typed as a
 * `Partial` of it. That gives the property this needs most — a translator can land ten keys
 * without breaking the build, and a DELETED or MISSPELLED key in a translation is a type error
 * rather than a silent gap discovered by a user.
 *
 * ── RULE 2: FALLBACK IS PER KEY, NOT PER LOCALE ─────────────────────────────────────────────
 *
 * An all-or-nothing switch ("Italian is only 60% done, so show English") is what makes
 * translations never ship. Per-key fallback means a half-finished catalog is immediately
 * useful and improves monotonically. The cost is a mixed-language screen during the gap, which
 * is strictly better than no Italian at all — and `missingKeys` exists so the gap is
 * measurable rather than folklore.
 *
 * ── INTERPOLATION ───────────────────────────────────────────────────────────────────────────
 *
 * `{name}` placeholders, substituted from a params object. Deliberately not a template
 * literal: a translator must be able to REORDER them, because the clause order that reads
 * naturally in English is wrong in German ("nach der Installation von {tool}") and wrong again
 * in Polish. Positional `%s` would forbid that; named placeholders do not.
 *
 * An unknown placeholder is left as-is rather than replaced with "undefined" — a visible
 * `{tool}` in output is a bug report, where the word "undefined" is a mystery.
 *
 * PURE. No fs, no network, no state beyond the catalogs passed in.
 */

import { FALLBACK_LOCALE, type Locale } from "./locale.js";
import type { en } from "./messages/en.js";

/** The full key set, defined by the English catalog. */
export type Messages = typeof en;
export type MessageKey = keyof Messages;

/** A translation: any subset of the keys. Missing ones fall back to English, per key. */
export type MessageCatalog = Partial<Record<MessageKey, string>>;

/** Values a message may interpolate. Numbers are formatted by the CALLER, not here. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Substitute `{name}` placeholders.
 *
 * Exported because the doctor's install commands and the first-run prompt build strings the
 * same way, and two implementations of this would drift.
 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    // Leave an unknown placeholder visible. "undefined" in a user's terminal is a mystery;
    // a literal {tool} is a bug report that names its own cause.
    return v === undefined ? whole : String(v);
  });
}

/** The registry a translator adds a file to. Keyed by locale; English is required. */
export type Catalogs = Readonly<Record<Locale, MessageCatalog>> & { en: Messages };

/**
 * A bound translator.
 *
 * Returned rather than exported as a global `t()`, because the desktop renders two surfaces at
 * once during a locale switch and a module-level mutable locale would make that a race.
 */
export interface Translator {
  readonly locale: Locale;
  /** The message, interpolated, falling back to English for a key this locale lacks. */
  t(key: MessageKey, params?: MessageParams): string;
  /** True when this locale has its own text for the key (not the English fallback). */
  has(key: MessageKey): boolean;
}

export function createTranslator(locale: Locale, catalogs: Catalogs): Translator {
  const own = catalogs[locale] ?? {};
  const base = catalogs[FALLBACK_LOCALE];
  return {
    locale,
    has: (key) => typeof own[key] === "string" && own[key] !== "",
    t(key, params) {
      // An empty string in a translation is treated as ABSENT, not as a deliberate blank. A
      // blank message is never the intent, and a stray `""` would otherwise erase a line with
      // no way to tell it from a real translation.
      const raw = own[key] || base[key];
      if (raw === undefined) {
        // Unreachable while `Messages` is derived from `en` — but a catalog loaded from disk at
        // runtime would not have that guarantee, so this fails visibly instead of returning
        // `undefined` into a template.
        return `⟨${String(key)}⟩`;
      }
      return interpolate(raw, params);
    },
  };
}

/**
 * Which keys this locale has not translated yet.
 *
 * The point of per-key fallback is that a gap is invisible to the user; this is what keeps it
 * visible to the PROJECT. `/language --status` prints the count, and a test asserts no locale
 * silently regresses.
 */
export function missingKeys(locale: Locale, catalogs: Catalogs): MessageKey[] {
  if (locale === FALLBACK_LOCALE) return [];
  const own = catalogs[locale] ?? {};
  return (Object.keys(catalogs[FALLBACK_LOCALE]) as MessageKey[]).filter(
    (k) => typeof own[k] !== "string" || own[k] === "",
  );
}

/** How complete a translation is, 0–100. Shown in the language picker. */
export function completeness(locale: Locale, catalogs: Catalogs): number {
  const total = Object.keys(catalogs[FALLBACK_LOCALE]).length;
  if (total === 0) return 100;
  return Math.round(((total - missingKeys(locale, catalogs).length) / total) * 100);
}
