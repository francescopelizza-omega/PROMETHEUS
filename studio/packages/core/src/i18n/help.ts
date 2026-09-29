/**
 * i18n/help.ts — translating the help menu without translating the commands.
 *
 * ── THE LINE THIS FILE DRAWS ────────────────────────────────────────────────────────────────
 *
 * A command NAME is not prose. `/setup`, `/scan`, `/cd` are identifiers the user types, and an
 * identifier that changes per language is an identifier that cannot be taught, searched for, or
 * pasted from a forum. The same goes for the engine verbs (`scan`, `install`, `list`) and for
 * the `-ing` progress words the engine emits. They stay English in every locale, permanently.
 *
 * What DOES get translated is everything around them: the one-line description beside each
 * command, the group headings, and the framing sentences. That is the part a newcomer reads to
 * decide what to type — and the part where English costs them confidence for no benefit.
 *
 * ── WHY THIS IS A SEPARATE CATALOG FROM `messages/` ─────────────────────────────────────────
 *
 * `Messages` is `typeof en`, which makes English exhaustive and every key statically checked.
 * That is exactly right for ~80 hand-written strings and exactly wrong for ~122 command
 * descriptions, because:
 *
 *   1. The English source ALREADY EXISTS, in the registry's own `summary:` field. Copying all
 *      122 into an English catalog would create two sources of truth that drift.
 *   2. A key per command in a statically-typed record means adding a command breaks the build
 *      in eight files. A description is not worth that.
 *
 * So: a LOOSE record keyed by command name, holding only what has been translated, and a lookup
 * that falls back to the registry's own English. A locale with no entry for `/cat` shows the
 * English summary — which is correct, useful, and costs nothing.
 */

import type { Locale } from "./locale.js";

/**
 * Translated help text, keyed by the command's own name.
 *
 * `summary` is the one-line description; `args` is the usage hint. Both optional — a locale may
 * translate the description and leave the usage hint alone, which is usually the right call
 * since a usage hint is mostly punctuation and placeholders.
 */
export interface CommandHelp {
  summary?: string;
  args?: string;
}

/** One locale's help: command descriptions plus the group headings. */
export interface HelpCatalog {
  /** keyed by the command's PRIMARY name, without the leading slash. */
  commands?: Readonly<Record<string, CommandHelp>>;
  /** keyed by the group id used in the registry. */
  groups?: Readonly<Record<string, string>>;
}

/**
 * The words that must never be translated, and the test that enforces it.
 *
 * Not a style preference. A translated `/setup` is a command that does not exist, and a
 * translated `scan` is a verb the engine will not accept. Anything matching these patterns
 * inside a translated string has to survive verbatim.
 */
export const PRESERVED_PATTERNS: readonly RegExp[] = Object.freeze([
  /\/[a-z][a-z0-9-]*/g, // slash commands: /setup, /cd, /context
  /\b(?:scan|install|list|uninstall|toggle|doctor|serve|update)\b/g, // engine verbs
]);

/**
 * Every slash command mentioned in a string, for the parity check.
 *
 * ANCHORED to a separator, because a bare `/[a-z]+` also matches the tail of a file path:
 * `/Users/x` yielded `/x`, which would make a sentence mentioning a path look like it mentions
 * a command and quietly weaken the parity test that depends on this.
 */
export function slashCommandsIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s(\[·—,:])(\/[a-z][a-z0-9-]*)/g)]
    .map((m) => m[1] as string)
    .sort();
}

/**
 * The help text for a command, in a locale, falling back to the registry's English.
 *
 * `fallback` is the registry's own `summary:` — the single English source of truth. Passing it
 * in rather than duplicating it into an English catalog is what stops the two drifting.
 */
export function commandHelp(
  name: string,
  fallback: string,
  locale: Locale,
  catalogs: Partial<Record<Locale, HelpCatalog>>,
): string {
  const t = catalogs[locale]?.commands?.[name]?.summary;
  return t?.trim() ? t : fallback;
}

/** A group heading, falling back to the English one. */
export function groupTitle(
  group: string,
  fallback: string,
  locale: Locale,
  catalogs: Partial<Record<Locale, HelpCatalog>>,
): string {
  const t = catalogs[locale]?.groups?.[group];
  return t?.trim() ? t : fallback;
}

/**
 * How much of the help is translated for a locale, against the commands that actually exist.
 *
 * Measured against the LIVE registry rather than a fixed list, so a newly added command
 * immediately lowers the figure instead of being silently missed. `/language` shows this, and
 * it is the honest answer to "is my language finished?".
 */
export function helpCoverage(
  commandNames: readonly string[],
  locale: Locale,
  catalogs: Partial<Record<Locale, HelpCatalog>>,
): { translated: number; total: number; percent: number } {
  const cat = catalogs[locale]?.commands ?? {};
  const translated = commandNames.filter((n) => {
    const s = cat[n]?.summary;
    return typeof s === "string" && s.trim() !== "";
  }).length;
  const total = commandNames.length;
  return { translated, total, percent: total === 0 ? 100 : Math.round((translated / total) * 100) };
}
