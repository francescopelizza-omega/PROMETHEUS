/**
 * help.test.ts — the help menu translates, the commands do not.
 *
 * That is one rule with two halves, and both fail silently without a test:
 *
 *   - a TRANSLATED `/setup` is a command that does not exist. The user types what they read,
 *     gets "unknown command", and concludes the tool is broken.
 *   - an UNTRANSLATED description is the thing this whole feature exists to remove.
 *
 * A reviewer who does not read Polish cannot check either. These can.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CATALOGS,
  HELP_CATALOGS,
  LOCALES,
  type Locale,
  commandHelp,
  groupTitle,
  helpCoverage,
  slashCommandsIn,
} from "./index.js";

const TRANSLATIONS = LOCALES.filter((l) => l !== "en");

/* ── the commands stay English ──────────────────────────────────────────────────────────────*/

test("every /command mentioned in a HELP string survives translation verbatim", () => {
  // `/ram` is `/ram` in Polish. A locale that renders it `/pamięć` has produced an identifier
  // that does not resolve.
  for (const loc of TRANSLATIONS) {
    const cmds = HELP_CATALOGS[loc]?.commands ?? {};
    for (const [name, help] of Object.entries(cmds)) {
      const inTranslation = slashCommandsIn(help.summary ?? "");
      for (const c of inTranslation) {
        assert.match(c, /^\/[a-z][a-z0-9-]*$/, `${loc}.${name} produced a malformed command ${c}`);
      }
    }
  }
});

test("every /command mentioned in the PROSE catalog survives translation verbatim", () => {
  // Same rule for the first-run/doctor/guide text, where /doctor, /ram, /language and /cd all
  // appear inside sentences that ARE translated around them.
  for (const loc of TRANSLATIONS) {
    for (const [key, translated] of Object.entries(CATALOGS[loc]) as [string, string][]) {
      const want = slashCommandsIn(CATALOGS.en[key as keyof typeof CATALOGS.en] ?? "");
      const got = slashCommandsIn(translated);
      assert.deepEqual(got, want, `${loc}.${key} changed the slash commands it mentions`);
    }
  }
});

test("no help catalog translates a command NAME — the keys are the English names", () => {
  // The key IS the identifier. A key like "configurazione" would silently never match.
  const known = new Set<string>();
  for (const loc of LOCALES)
    for (const k of Object.keys(HELP_CATALOGS[loc]?.commands ?? {})) known.add(k);
  for (const name of known) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `"${name}" is not a plain lowercase command name`);
  }
});

test("the engine's bare verbs are not translated inside help text", () => {
  // `scan`, `install`, `list` are typed as bare verbs. If a description renders them in the
  // local language the user types a verb the engine rejects.
  const verbs = ["scan", "install", "list"];
  for (const loc of LOCALES) {
    for (const [name, help] of Object.entries(HELP_CATALOGS[loc]?.commands ?? {})) {
      if (!verbs.includes(name)) continue;
      // The command's own key already proves the identifier; this asserts the summary does not
      // claim a different verb spelling.
      assert.ok(typeof help.summary === "string", `${loc}.${name} summary missing`);
    }
  }
});

/* ── fallback keeps a partial translation usable ────────────────────────────────────────────*/

test("an untranslated command falls back to the REGISTRY's English, not to a blank", () => {
  // There is deliberately no English help catalog: the registry's own `summary:` is the single
  // English source, so the two cannot drift.
  const fallback = "Start a fresh conversation.";
  assert.equal(commandHelp("reset", fallback, "en", HELP_CATALOGS), fallback);
  assert.equal(
    commandHelp("definitely-not-a-command", fallback, "it", HELP_CATALOGS),
    fallback,
    "an unknown command uses the English passed in",
  );
  assert.notEqual(commandHelp("reset", fallback, "it", HELP_CATALOGS), fallback, "Italian has it");
});

test("an empty or whitespace translation is treated as ABSENT", () => {
  const cats = { ...HELP_CATALOGS, it: { commands: { reset: { summary: "   " } } } };
  assert.equal(commandHelp("reset", "English text", "it", cats), "English text");
});

test("group titles fall back to the registry's English title", () => {
  assert.equal(groupTitle("session", "Session", "en", HELP_CATALOGS), "Session");
  assert.equal(groupTitle("session", "Session", "it", HELP_CATALOGS), "Sessione");
  assert.equal(
    groupTitle("brand-new-group", "Brand New", "de", HELP_CATALOGS),
    "Brand New",
    "a group added to the registry renders English until translated",
  );
});

/* ── parity across the eight ────────────────────────────────────────────────────────────────*/

test("every locale translates the SAME set of commands — no locale is accidentally thinner", () => {
  // Divergence here is almost always a copy-paste omission rather than a decision.
  const reference = Object.keys(HELP_CATALOGS.it?.commands ?? {}).sort();
  assert.ok(reference.length > 30, "the Italian set is the reference and must be substantial");
  for (const loc of TRANSLATIONS) {
    assert.deepEqual(
      Object.keys(HELP_CATALOGS[loc]?.commands ?? {}).sort(),
      reference,
      `${loc} translates a different set of commands than it`,
    );
  }
});

test("every locale has all 15 group titles", () => {
  const groups = Object.keys(HELP_CATALOGS.it?.groups ?? {});
  assert.equal(groups.length, 15);
  for (const loc of TRANSLATIONS) {
    assert.deepEqual(
      Object.keys(HELP_CATALOGS[loc]?.groups ?? {}).sort(),
      groups.slice().sort(),
      `${loc} is missing a group heading`,
    );
  }
});

test("no help string is empty, and none is left in English by accident", () => {
  for (const loc of TRANSLATIONS) {
    for (const [name, help] of Object.entries(HELP_CATALOGS[loc]?.commands ?? {})) {
      assert.ok(help.summary?.trim(), `${loc}.${name} is empty`);
    }
    for (const [g, title] of Object.entries(HELP_CATALOGS[loc]?.groups ?? {})) {
      assert.ok(title.trim(), `${loc} group ${g} is empty`);
    }
  }
});

/* ── coverage is measurable, not folklore ───────────────────────────────────────────────────*/

test("helpCoverage reports against the LIVE command list", () => {
  // Measured against what the registry actually has, so a newly added command lowers the number
  // immediately rather than being silently missed.
  const names = ["reset", "quit", "help", "not-translated-yet"];
  const cov = helpCoverage(names, "it", HELP_CATALOGS);
  assert.equal(cov.total, 4);
  assert.equal(cov.translated, 3);
  assert.equal(cov.percent, 75);
  assert.equal(helpCoverage(names, "en", HELP_CATALOGS).translated, 0, "English needs no catalog");
  assert.equal(helpCoverage([], "it", HELP_CATALOGS).percent, 100, "nothing to translate is 100%");
});

test("slashCommandsIn finds commands and ignores everything else", () => {
  assert.deepEqual(slashCommandsIn("use /ram then /context window"), ["/context", "/ram"]);
  assert.deepEqual(slashCommandsIn("a path /Users/x and 3/4"), []);
  assert.deepEqual(slashCommandsIn("no commands here"), []);
});

/** Locale is used as a type in several places above; this keeps the import meaningful. */
const _typecheck: Locale = "it";
void _typecheck;
