// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/language-host.ts — the active language, and the question asked once.
 *
 * ── ABSENT IS NOT "en" ──────────────────────────────────────────────────────────────────────
 *
 * The whole first-run flow turns on that distinction. `ui.language` absent means NEVER ASKED,
 * which is what triggers the question; `"en"` means asked and answered English. Collapsing the
 * two would either re-ask an English speaker on every launch, or silently adopt `$LANG` for
 * someone who had deliberately chosen otherwise.
 *
 * ── WHY THE QUESTION IS IN ENGLISH ──────────────────────────────────────────────────────────
 *
 * It is the one screen shown before we know what the person reads, so it uses the language
 * most likely to be understood by someone who has not chosen yet — and every option carries
 * its own endonym ("Italiano", "Deutsch") so the right row is recognisable even to a reader
 * with no English at all.
 */
import { i18n } from "@prometheus/core";

import { loadSettings, saveSettings } from "../home.js";

const KEY = "ui.language";

/** The stored choice, or undefined when the user has never been asked. */
export function storedLocale(home?: string): string | undefined {
  const raw = (loadSettings(home) as Record<string, unknown>)[KEY];
  return typeof raw === "string" && raw ? raw : undefined;
}

/** Has the user ever answered the language question? */
export function languageChosen(home?: string): boolean {
  // A value we do not recognise counts as UNANSWERED: a hand-edited "klingon" should re-ask,
  // not silently run in English forever with a setting that looks deliberate.
  return i18n.isLocale(storedLocale(home));
}

/** Persist a choice. */
export function saveLocale(locale: i18n.Locale, home?: string): void {
  saveSettings({ [KEY]: locale }, home);
}

/** The translator for this session, plus where the choice came from. */
export function activeTranslator(home?: string, env: NodeJS.ProcessEnv = process.env) {
  return i18n.translatorFor({ setting: storedLocale(home), env });
}

/** One row of the first-run picker. */
export interface LanguageChoice {
  index: number;
  locale: i18n.Locale;
  endonym: string;
  english: string;
  /** the environment suggested this one, so Enter should take it. */
  suggested: boolean;
}

/**
 * The picker rows, with the environment's suggestion marked.
 *
 * English is always first — it is the fallback and the language the prompt is written in — and
 * the rest keep `LOCALES` order so the list does not reshuffle between runs.
 */
export function languageChoices(env: NodeJS.ProcessEnv = process.env): LanguageChoice[] {
  const suggested = i18n.localeFromEnv(env);
  return i18n.LOCALES.map((locale, i) => ({
    index: i + 1,
    locale,
    endonym: i18n.LOCALE_NAMES[locale].endonym,
    english: i18n.LOCALE_NAMES[locale].english,
    suggested: locale === suggested,
  }));
}

/**
 * Interpret what the user typed at the picker.
 *
 * Accepts a NUMBER, a language code, or an endonym/English name — because a person who reads
 * "2) Italiano" may equally type `2`, `it`, or `Italiano`, and refusing two of those three is
 * a needless way to fail someone's first interaction.
 *
 * Empty input takes the suggestion if there is one, else English. `null` means "not
 * understood", and the caller re-asks rather than picking something.
 */
export function parseLanguageAnswer(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): i18n.Locale | null {
  const answer = raw.trim().toLowerCase();
  const rows = languageChoices(env);
  if (!answer) return rows.find((r) => r.suggested)?.locale ?? i18n.FALLBACK_LOCALE;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= rows.length) return rows[n - 1]?.locale ?? null;
  if (i18n.isLocale(answer)) return answer;
  const byName = rows.find(
    (r) => r.endonym.toLowerCase() === answer || r.english.toLowerCase() === answer,
  );
  return byName?.locale ?? null;
}

/** The picker, as lines. English on purpose — see the module header. */
export function renderLanguagePrompt(env: NodeJS.ProcessEnv = process.env): string[] {
  const en = i18n.translator("en");
  const rows = languageChoices(env);
  const out = [en.t("firstrun.language.title"), "", en.t("firstrun.language.intro"), ""];
  for (const r of rows) {
    const same = r.endonym === r.english;
    const label = same ? r.endonym : `${r.endonym}  (${r.english})`;
    out.push(`  ${String(r.index).padStart(2)}) ${label}${r.suggested ? "   ←" : ""}`);
  }
  out.push("");
  const suggested = rows.find((r) => r.suggested);
  if (suggested) {
    out.push(en.t("firstrun.language.detected", { language: suggested.endonym }));
  }
  out.push(en.t("firstrun.language.prompt"));
  return out;
}

/** What to say once a language is chosen — in THAT language, as the first proof it worked. */
export function renderLanguageConfirmed(locale: i18n.Locale): string[] {
  const t = i18n.translator(locale);
  const out = [t.t("firstrun.language.confirmed", { language: i18n.LOCALE_NAMES[locale].endonym })];
  const pct = i18n.completeness(locale, i18n.CATALOGS);
  // Only said when it is true, and it tells the user what they will actually see rather than
  // letting them discover a mixed-language screen and assume something is broken.
  if (pct < 100) {
    out.push(
      t.t("firstrun.language.partial", {
        language: i18n.LOCALE_NAMES[locale].endonym,
        percent: pct,
      }),
    );
  }
  return out;
}
