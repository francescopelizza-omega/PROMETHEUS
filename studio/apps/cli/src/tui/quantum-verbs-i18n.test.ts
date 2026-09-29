/**
 * quantum-verbs-i18n.test.ts — the working-spinner vocabulary stays English. Permanently.
 *
 * `Entangling…`, `Bose-Einstein-condensating…`, `Wick-rotating…` are the words that entertain
 * the user while the model thinks. They are a joke in a specific register — physics and
 * mathematics terms forced into English `-ing` form — and the joke is the point.
 *
 * Translating them would destroy it in three separate ways:
 *
 *   1. Most have no target-language equivalent. "Hadronizing" is not a word in Polish, and the
 *      nearest real translation is a clinical noun phrase that is not funny and not short.
 *   2. The `-ing` form itself is the gag. Languages without a progressive aspect cannot carry
 *      it; the line becomes a flat status message.
 *   3. They are eponyms. "Bose-Einstein" is a surname pair, and a localised surname is simply
 *      wrong.
 *
 * Today they are English because nothing ever wired i18n into this module. That is luck, not a
 * decision, and luck is what this file converts into a decision. The module is deliberately
 * dependency-free (see its own header: PURE); these assertions fail the moment that changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { i18n } from "@prometheus/core";

import { QUANTUM_VERBS } from "./quantum-verbs.js";

const SOURCE = readFileSync(new URL("./quantum-verbs.ts", import.meta.url), "utf8");

test("the spinner module imports NOTHING from the i18n layer", () => {
  // The structural guard. A translated spinner has to start with an import, so this catches the
  // change at its root rather than after 135 words have been sent to a translator.
  assert.doesNotMatch(SOURCE, /\bi18n\b/, "quantum-verbs must not reference i18n");
  assert.doesNotMatch(SOURCE, /\btranslator\b|\blocale\b|\bt\(/, "no translation machinery here");
});

test("no working verb has leaked into a message catalog", () => {
  // The content guard: if someone copies the list into `messages/`, the words become
  // translatable and the next translator localises them in good faith.
  for (const loc of i18n.LOCALES) {
    const all = Object.values(i18n.CATALOGS[loc]).join(" ");
    for (const verb of QUANTUM_VERBS) {
      assert.ok(!all.includes(verb), `${loc} catalog contains the working verb "${verb}"`);
    }
  }
});

test("every working verb ends in -ing and uses only Latin letters", () => {
  /*
   * Both halves of the register — with one correction the first draft of this test got wrong.
   *
   * "Plain ASCII" was too strict and failed on `Schrödingering` and `Bézier-curving`. Those are
   * not translations: they are EPONYMS, and Schrödinger and Bézier are spelled with ö and é in
   * English too. Stripping the diacritic would misspell a physicist's name.
   *
   * So the rule is Latin script (accents allowed) plus the -ing ending. That still rejects what
   * it is meant to reject — Cyrillic, Greek, CJK, or any word whose shape is not the joke.
   */
  for (const verb of QUANTUM_VERBS) {
    assert.match(verb, /ing$/, `"${verb}" does not end in -ing`);
    assert.match(
      verb,
      /^[A-Za-z\u00C0-\u024F'-]+$/,
      `"${verb}" is not Latin script — a translation crept in`,
    );
  }
});

test("the eponyms keep their diacritics", () => {
  // The flip side: a well-meaning "ASCII-safe" pass that rewrites these to Schrodingering or
  // Bezier-curving has misspelled two names, which is its own small vandalism.
  const eponyms = QUANTUM_VERBS.filter((v) => /[\u00C0-\u024F]/.test(v));
  assert.ok(eponyms.length >= 2, "the accented eponyms must still be present");
  assert.ok(
    eponyms.some((v) => v.startsWith("Schr\u00F6")),
    "Schrödingering kept its umlaut",
  );
});

test("the list is substantial and has no duplicates", () => {
  assert.ok(QUANTUM_VERBS.length > 100, `only ${QUANTUM_VERBS.length} verbs`);
  assert.equal(new Set(QUANTUM_VERBS).size, QUANTUM_VERBS.length, "a verb is listed twice");
});
