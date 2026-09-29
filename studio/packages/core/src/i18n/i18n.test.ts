/**
 * i18n.test.ts — the invariants that keep eight catalogs from rotting.
 *
 * A translation layer fails quietly. Nobody notices a key that reverted to English, a
 * placeholder that got translated into uselessness, or a command that a well-meaning translator
 * localised. These assert the things a reviewer cannot hold in their head across 8 × ~70 keys.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CATALOGS,
  FALLBACK_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  type Locale,
  type MessageKey,
  completeness,
  createTranslator,
  interpolate,
  isLocale,
  localeFromEnv,
  localeFromPosix,
  missingKeys,
  resolveLocale,
  translator,
} from "./index.js";

const KEYS = Object.keys(CATALOGS.en) as MessageKey[];
const TRANSLATIONS = LOCALES.filter((l) => l !== FALLBACK_LOCALE);

/* ── the catalogs agree with each other ─────────────────────────────────────────────────────*/

test("every shipped locale has a catalog and a name", () => {
  for (const l of LOCALES) {
    assert.ok(CATALOGS[l], `${l} is in LOCALES but has no catalog`);
    assert.ok(LOCALE_NAMES[l]?.endonym, `${l} has no endonym — the picker would show a blank row`);
    assert.ok(LOCALE_NAMES[l]?.english, `${l} has no English name`);
  }
});

test("no translation invents a key that English does not have", () => {
  // A key only English lacks is dead weight the type system cannot see at runtime, and usually
  // means a rename landed in one file and not the schema.
  const known = new Set<string>(KEYS);
  for (const l of TRANSLATIONS) {
    for (const k of Object.keys(CATALOGS[l])) {
      assert.ok(known.has(k), `${l} defines "${k}", which is not in the English catalog`);
    }
  }
});

test("no catalog contains an empty string — that is treated as missing, so it is a trap", () => {
  for (const l of LOCALES) {
    for (const [k, v] of Object.entries(CATALOGS[l])) {
      assert.notEqual(v, "", `${l}.${k} is empty; delete the key instead, the meaning is the same`);
    }
  }
});

/* ── placeholders: the failure mode that survives review ────────────────────────────────────*/

test("every translation carries the SAME placeholders as its English source", () => {
  /*
   * The one mistake that gets past a reviewer who does not speak the language. A dropped {model}
   * silently loses the model name; an invented {tool} renders as a literal "{tool}" forever.
   * Order may differ — that is the whole point of named placeholders, since German and Polish
   * need a different clause order than English — so this compares SETS, not sequences.
   */
  const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  for (const l of TRANSLATIONS) {
    for (const [k, translated] of Object.entries(CATALOGS[l]) as [MessageKey, string][]) {
      const want = placeholders(CATALOGS.en[k]);
      const got = placeholders(translated);
      assert.deepEqual(
        [...got].sort(),
        [...want].sort(),
        `${l}.${k} placeholders differ from English`,
      );
    }
  }
});

test("shell commands are NOT translated — a localised command does not run", () => {
  // These appear inside prose the translator rewrites freely. The command itself must survive
  // verbatim or the instruction is worse than useless: it looks authoritative and fails.
  const commands: [MessageKey, string][] = [
    ["runner.notrunning", "ollama serve"],
    ["runner.nomodels", "ollama pull"],
  ];
  for (const l of LOCALES) {
    for (const [key, cmd] of commands) {
      const text = CATALOGS[l][key];
      if (text === undefined) continue; // not translated yet is fine; wrong is not
      assert.ok(text.includes(cmd), `${l}.${key} lost the literal command "${cmd}"`);
    }
  }
});

test("slash commands referenced in prose survive translation", () => {
  for (const l of LOCALES) {
    const text = CATALOGS[l]["guide.step5.body"];
    if (text === undefined) continue;
    for (const cmd of ["/help", "/doctor", "/language", "/ram"]) {
      assert.ok(text.includes(cmd), `${l}.guide.step5.body lost ${cmd}`);
    }
  }
});

/* ── lookup and fallback ────────────────────────────────────────────────────────────────────*/

test("a missing key falls back to English PER KEY, not per locale", () => {
  const partial = createTranslator("it", {
    ...CATALOGS,
    it: { "doctor.title": "Solo questa" },
  } as typeof CATALOGS);
  assert.equal(partial.t("doctor.title"), "Solo questa", "the translated key is used");
  assert.equal(
    partial.t("doctor.ready.title"),
    CATALOGS.en["doctor.ready.title"],
    "and the untranslated one falls back to English rather than breaking",
  );
  assert.equal(partial.has("doctor.title"), true);
  assert.equal(partial.has("doctor.ready.title"), false);
});

test("an empty translation falls back rather than erasing the line", () => {
  const t = createTranslator("it", { ...CATALOGS, it: { "doctor.title": "" } } as typeof CATALOGS);
  assert.equal(t.t("doctor.title"), CATALOGS.en["doctor.title"]);
});

test("interpolation substitutes, and leaves an UNKNOWN placeholder visible", () => {
  assert.equal(interpolate("hello {name}", { name: "world" }), "hello world");
  assert.equal(interpolate("{a} and {b}", { a: 1, b: 2 }), "1 and 2");
  // "undefined" in a terminal is a mystery; a literal {missing} is a bug report.
  assert.equal(interpolate("x {missing} y", { other: 1 }), "x {missing} y");
  assert.equal(interpolate("no params"), "no params");
});

test("every English message renders with no placeholder left unfilled, given its params", () => {
  // A smoke test over the whole catalog: nothing should contain a stray brace pair that no
  // caller could ever fill, which is what a typo in a placeholder name looks like.
  for (const k of KEYS) {
    const raw = CATALOGS.en[k];
    const names = [...raw.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
    const params = Object.fromEntries(names.map((n) => [n, "X"]));
    assert.ok(!/\{\w+\}/.test(interpolate(raw, params)), `${k} has an unfillable placeholder`);
  }
});

/* ── completeness reporting ─────────────────────────────────────────────────────────────────*/

test("English is 100% and reports no missing keys, by definition", () => {
  assert.equal(completeness("en", CATALOGS), 100);
  assert.deepEqual(missingKeys("en", CATALOGS), []);
});

test("every shipped translation is complete — a locale in the picker must not be a stub", () => {
  // Per-key fallback makes a partial catalog SAFE, not acceptable to ship unnoticed. If this
  // fails, either finish the keys or drop the locale from LOCALES; both are fine, silence is not.
  for (const l of TRANSLATIONS) {
    const missing = missingKeys(l, CATALOGS);
    assert.deepEqual(
      missing,
      [],
      `${l} is ${completeness(l, CATALOGS)}% translated, missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
    );
  }
});

/* ── choosing a locale ──────────────────────────────────────────────────────────────────────*/

test("POSIX locale strings reduce to a language we ship", () => {
  assert.equal(localeFromPosix("it_IT.UTF-8"), "it");
  assert.equal(localeFromPosix("de_AT@euro"), "de");
  assert.equal(localeFromPosix("pt-BR"), "pt", "one Portuguese: near-miss beats English");
  assert.equal(localeFromPosix("fr"), "fr");
  assert.equal(localeFromPosix("EN_GB.UTF-8"), "en", "case-insensitive");
});

test("the no-locale sentinels are not a language preference", () => {
  // Every CI runner and minimal container sets one of these. Reading them as a choice would
  // give the whole world an accidental locale.
  for (const raw of ["C", "C.UTF-8", "POSIX", "", undefined]) {
    assert.equal(localeFromPosix(raw), null, `${String(raw)} must not resolve to a language`);
  }
  assert.equal(localeFromPosix("ja_JP.UTF-8"), null, "a language we do not ship is not a match");
});

test("environment precedence is LANGUAGE, then LC_ALL, then LC_MESSAGES, then LANG", () => {
  assert.equal(localeFromEnv({ LANG: "es_ES.UTF-8" }), "es");
  assert.equal(localeFromEnv({ LANG: "es_ES.UTF-8", LC_ALL: "de_DE.UTF-8" }), "de");
  assert.equal(localeFromEnv({ LC_ALL: "de_DE.UTF-8", LANGUAGE: "it:fr" }), "it");
  // LANGUAGE is a PREFERENCE LIST: the first entry we ship wins, which is what the user asked
  // for by writing it that way.
  assert.equal(localeFromEnv({ LANGUAGE: "ca:es:en" }), "es", "skip a language we do not ship");
  assert.equal(localeFromEnv({}), null);
});

test("a stored setting beats the environment and is never second-guessed", () => {
  // Running an English shell while wanting Italian output is the NORMAL case, not a conflict
  // to resolve in the environment's favour.
  const r = resolveLocale({ setting: "it", env: { LANG: "en_US.UTF-8" } });
  assert.deepEqual(r, { locale: "it", source: "setting" });
});

test("no setting falls to the environment, then to English", () => {
  assert.deepEqual(resolveLocale({ env: { LANG: "fr_FR.UTF-8" } }), {
    locale: "fr",
    source: "environment",
  });
  assert.deepEqual(resolveLocale({ env: { LANG: "C" } }), { locale: "en", source: "fallback" });
  assert.deepEqual(resolveLocale({}), { locale: "en", source: "fallback" });
});

test("a nonsense setting is ignored rather than trusted", () => {
  // The settings file is hand-editable; "klingon" must not become the active locale.
  assert.equal(resolveLocale({ setting: "klingon" }).source, "fallback");
  assert.equal(isLocale("klingon"), false);
  assert.equal(isLocale("it"), true);
});

test("the shipped translator resolves a real message in each language", () => {
  for (const l of LOCALES) {
    const t = translator(l as Locale);
    const s = t.t("doctor.title");
    assert.ok(s.length > 0 && !s.startsWith("⟨"), `${l} produced no text for doctor.title`);
  }
});
