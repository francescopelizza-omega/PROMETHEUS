// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * i18n/locale.ts — which language, and how we decided.
 *
 * ── WHY ENGLISH IS THE FALLBACK AND NOT "THE DEFAULT" ───────────────────────────────────────
 *
 * Those are different things and the difference is load-bearing. English is the language every
 * key is guaranteed to exist in, so it is what a MISSING key falls back to — per key, not per
 * locale. A half-finished Italian catalog therefore yields Italian where it has been written and
 * English where it has not, rather than an empty string, a key name leaking into the UI, or an
 * all-or-nothing switch that discourages partial translation.
 *
 * The locale a user is SHOWN is a separate decision, made by `resolveLocale` below.
 *
 * ── WHY WE ASK RATHER THAN SNIFF ────────────────────────────────────────────────────────────
 *
 * `$LANG` is a poor proxy for "what language does this person want their tools in": developers
 * routinely run an English-locale shell while preferring their own language for prose, and CI
 * sets `LANG=C.UTF-8`. So the environment is only ever a SUGGESTION — it pre-selects an answer
 * in the first-run prompt and never decides silently. Once the user has answered, the setting
 * wins and the environment is not consulted again.
 *
 * PURE: no fs, no process access except an explicitly injected env. That is what lets the first
 * -run flow, the CLI and the desktop all reach the same answer without three copies of it.
 */

/**
 * The languages PROMETHEUS ships.
 *
 * The five the product was asked for, plus the next three largest EU languages by speakers —
 * a line has to be drawn somewhere and "the ones most users actually have" is a defensible
 * place to draw it. Adding another is a catalog file and one row here; nothing else changes,
 * because every lookup falls back per key.
 */
export const LOCALES = ["en", "it", "fr", "es", "de", "pt", "nl", "pl"] as const;

export type Locale = (typeof LOCALES)[number];

/** The language every key is guaranteed to exist in. */
export const FALLBACK_LOCALE: Locale = "en";

/**
 * How each language names ITSELF.
 *
 * Endonyms, not English names. A first-run picker that offers "German" to someone who does not
 * read English has failed at the one job it has; "Deutsch" is recognisable to the person who
 * needs it. The English name rides along for the same reason in reverse — the prompt is shown
 * in English, so the person choosing may only recognise that side.
 */
export const LOCALE_NAMES: Readonly<Record<Locale, { endonym: string; english: string }>> =
  Object.freeze({
    en: { endonym: "English", english: "English" },
    it: { endonym: "Italiano", english: "Italian" },
    fr: { endonym: "Français", english: "French" },
    es: { endonym: "Español", english: "Spanish" },
    de: { endonym: "Deutsch", english: "German" },
    pt: { endonym: "Português", english: "Portuguese" },
    nl: { endonym: "Nederlands", english: "Dutch" },
    pl: { endonym: "Polski", english: "Polish" },
  });

/** Is this one of the languages we ship? */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Reduce a POSIX locale string to a language we ship, or null.
 *
 * Handles what actually appears in the wild: `it_IT.UTF-8`, `pt-BR`, `de_AT@euro`, `C`,
 * `C.UTF-8`, `POSIX`, and an empty string. Only the LANGUAGE subtag is used — `pt_BR` and
 * `pt_PT` both resolve to `pt`, because shipping one Portuguese is a translation decision and
 * pretending otherwise would give a Brazilian user English instead of near-miss Portuguese.
 */
export function localeFromPosix(raw: string | undefined): Locale | null {
  if (!raw) return null;
  // `C` and `POSIX` are the "no locale" sentinels; treating them as a language gives every CI
  // runner and every minimal container an accidental preference.
  const head = raw.split(/[.@:]/)[0]?.trim() ?? "";
  if (!head || head === "C" || head === "POSIX") return null;
  const lang = head.split(/[_-]/)[0]?.toLowerCase() ?? "";
  return isLocale(lang) ? lang : null;
}

/**
 * The environment's suggestion, in POSIX precedence order.
 *
 * `LC_ALL` overrides everything, then `LC_MESSAGES` (the category that actually governs program
 * text), then `LANG`. `LANGUAGE` is a GNU extension holding a colon-separated PREFERENCE LIST,
 * so it is read as one and the first language we ship wins — that is exactly what a user who
 * sets `LANGUAGE=ca:es:en` is asking for.
 */
export function localeFromEnv(env: Record<string, string | undefined>): Locale | null {
  for (const candidate of (env.LANGUAGE ?? "").split(":")) {
    const hit = localeFromPosix(candidate);
    if (hit) return hit;
  }
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const hit = localeFromPosix(env[key]);
    if (hit) return hit;
  }
  return null;
}

/** Where the active locale came from. Surfaces SHOW this, so a surprise is explainable. */
export type LocaleSource = "setting" | "environment" | "fallback";

export interface ResolvedLocale {
  locale: Locale;
  source: LocaleSource;
}

/**
 * The language to use right now.
 *
 * A stored setting is a decision the user made and is never second-guessed — not even when the
 * environment disagrees, because someone running an English shell while wanting Italian output
 * is the normal case, not an inconsistency to correct.
 */
export function resolveLocale(opts: {
  setting?: string | undefined;
  env?: Record<string, string | undefined>;
}): ResolvedLocale {
  if (isLocale(opts.setting)) return { locale: opts.setting, source: "setting" };
  const fromEnv = opts.env ? localeFromEnv(opts.env) : null;
  if (fromEnv) return { locale: fromEnv, source: "environment" };
  return { locale: FALLBACK_LOCALE, source: "fallback" };
}
