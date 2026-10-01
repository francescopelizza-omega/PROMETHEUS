// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * i18n — the language layer.
 *
 * Three pieces, deliberately small:
 *   `locale.ts`    which language, and how we decided (setting > environment > English)
 *   `catalog.ts`   the lookup, with PER-KEY fallback to English
 *   `messages/*`   one file per language; English is the schema
 *
 * ── WHAT THIS IS AND IS NOT FOR ─────────────────────────────────────────────────────────────
 *
 * It covers the first ten minutes: choosing a language, finding out what is missing, and being
 * told exactly how to fix it. NOT the whole application. That is a scoping decision, not an
 * unfinished one — an experienced user reading `/ram` in English is mildly inconvenienced,
 * whereas a beginner who cannot tell "not configured yet" from "broken" simply stops. The
 * budget goes where it changes the outcome.
 *
 * Adding a language is two steps: a file in `messages/`, and a row in `LOCALES` and
 * `LOCALE_NAMES`. Nothing else, because every lookup already falls back per key — a catalog
 * that is 30% done ships 30% of the language and no broken screens.
 *
 * ── THERE IS A SECOND CATALOG, AND THIS IS NOT IT ───────────────────────────────────────────
 *
 * `packages/ui/src/i18n/` already exists and is LIVE: ~33 keys for the security components
 * (VerdictPanel, FindingRow, VerdictSheet…), with its own `t()`, `registerLocale()` and
 * `setLocale()`. It is English-only today only because nothing has ever called `setLocale` —
 * the API was built for this and left unwired.
 *
 * The two are NOT rivals and must not be merged:
 *
 *   core/i18n  decides WHICH language, and owns the application's own prose.
 *   ui/i18n    owns the accessible labels of a handful of React components.
 *
 * They cannot import each other — `core` and `ui` are siblings, neither depends on the other
 * (core depends only on engine-bridge). So the join belongs in the HOST, which depends on both:
 * resolve the locale here, then hand it to `ui.setLocale(locale)`. That is one line in the
 * desktop's startup, and it is the ONLY correct place for it.
 *
 * If you are about to add a third message catalog: don't. Add keys here for prose, or to
 * `packages/ui` for a component label.
 */

import { type Catalogs, createTranslator } from "./catalog.js";
import { commandHelp, groupTitle } from "./help.js";
import { type Locale, resolveLocale } from "./locale.js";
import { de } from "./messages/de.js";
import { en } from "./messages/en.js";
import { es } from "./messages/es.js";
import { fr } from "./messages/fr.js";
import { HELP_CATALOGS } from "./messages/help.js";
import { it } from "./messages/it.js";
import { nl } from "./messages/nl.js";
import { pl } from "./messages/pl.js";
import { pt } from "./messages/pt.js";

export type {
  Catalogs,
  MessageCatalog,
  MessageKey,
  MessageParams,
  Messages,
  Translator,
} from "./catalog.js";
export { completeness, createTranslator, interpolate, missingKeys } from "./catalog.js";
// The HELP menu is a SEPARATE, loose catalog — command names stay English, descriptions do not.
// See `help.ts` for why it is not part of the statically-typed `Messages`.
export type { CommandHelp, HelpCatalog } from "./help.js";
export {
  PRESERVED_PATTERNS,
  commandHelp,
  groupTitle,
  helpCoverage,
  slashCommandsIn,
} from "./help.js";
export { HELP_CATALOGS } from "./messages/help.js";
export type { Locale, LocaleSource, ResolvedLocale } from "./locale.js";
export {
  FALLBACK_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  isLocale,
  localeFromEnv,
  localeFromPosix,
  resolveLocale,
} from "./locale.js";

/** Every shipped catalog. English is required by the type; the rest are partial. */
export const CATALOGS: Catalogs = Object.freeze({ en, it, fr, es, de, pt, nl, pl });

/**
 * The translator for a locale, using the shipped catalogs.
 *
 * The common entry point. A caller that needs to inject its own catalogs (a test, or a future
 * user-supplied translation) uses `createTranslator` directly.
 */
export function translator(locale: Locale) {
  return createTranslator(locale, CATALOGS);
}

/**
 * The help text for one command, in a locale.
 *
 * `fallback` is the registry's own English `summary:` — the single source of truth for English,
 * which is why there is no English help catalog to drift from it.
 */
export function helpFor(name: string, fallback: string, locale: Locale): string {
  return commandHelp(name, fallback, locale, HELP_CATALOGS);
}

/** A group heading, falling back to the registry's English title. */
export function helpGroup(group: string, fallback: string, locale: Locale): string {
  return groupTitle(group, fallback, locale, HELP_CATALOGS);
}

/**
 * Work out the language and return a translator in one step.
 *
 * What a surface calls at startup: hand it the stored setting and the environment, get back the
 * translator plus WHERE the choice came from — surfaces show that, so a user who did not expect
 * Italian can see it came from `$LANG` rather than from nowhere.
 */
export function translatorFor(opts: {
  setting?: string | undefined;
  env?: Record<string, string | undefined>;
}) {
  const resolved = resolveLocale(opts);
  return { ...resolved, t: translator(resolved.locale) };
}
