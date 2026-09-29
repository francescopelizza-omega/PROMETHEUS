/**
 * help-i18n.test.ts — the help catalogs must describe commands that EXIST.
 *
 * This lives in the CLI, not in core, for the reason the bug it catches exists at all: core
 * holds the translations and cannot see `SLASH_REGISTRY`, so nothing there can tell a real
 * command name from a plausible one. Two entries were keyed on ALIASES — `model` (an alias of
 * `worker`) and `restore` (an alias of `recall`) — and `commandHelp` looks up by PRIMARY name,
 * so both were dead in all seven languages. They rendered English while appearing translated,
 * and the `model` entry carried the ACCURATE description while the live `worker` entry carried
 * a wrong one.
 *
 * Nothing about that is visible by reading either file alone. It needs the join.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { i18n } from "@prometheus/core";

import { SLASH_REGISTRY } from "./slash-registry.js";

const PRIMARY = new Set(SLASH_REGISTRY.map((c) => c.name));
const ALIASES = new Map<string, string>();
for (const c of SLASH_REGISTRY) for (const a of c.aliases ?? []) ALIASES.set(a, c.name);

test("every translated command key is a PRIMARY command name, never an alias", () => {
  for (const loc of i18n.LOCALES) {
    for (const name of Object.keys(i18n.HELP_CATALOGS[loc]?.commands ?? {})) {
      if (PRIMARY.has(name)) continue;
      const primary = ALIASES.get(name);
      assert.fail(
        primary
          ? `${loc}: "${name}" is an ALIAS of /${primary} — lookup is by primary name, so this ` +
              `entry is dead. Re-key it to "${primary}".`
          : `${loc}: "${name}" is not a command at all.`,
      );
    }
  }
});

test("every group id in a help catalog is a group the registry actually uses", () => {
  const groups = new Set(SLASH_REGISTRY.map((c) => c.group as string));
  for (const loc of i18n.LOCALES) {
    for (const g of Object.keys(i18n.HELP_CATALOGS[loc]?.groups ?? {})) {
      assert.ok(groups.has(g), `${loc}: group "${g}" is not used by any command`);
    }
  }
});

test("the translated set is the same in every language, measured against the live registry", () => {
  const names = SLASH_REGISTRY.map((c) => c.name);
  const cov = i18n.LOCALES.filter((l) => l !== "en").map((l) => ({
    l,
    ...i18n.helpCoverage(names, l, i18n.HELP_CATALOGS),
  }));
  const first = cov[0];
  assert.ok(first, "there must be translations to compare");
  for (const c of cov) {
    assert.equal(
      c.translated,
      first.translated,
      `${c.l} translates ${c.translated} commands but ${first.l} translates ${first.translated}`,
    );
  }
  // A floor, not a target: this is what stops a merge silently gutting the catalogs. Raising
  // it is a deliberate act, which is the point.
  assert.ok(first.translated >= 40, `only ${first.translated} commands translated`);
});

test("a command's translated description never renames the command itself", () => {
  // `/setup` is an identifier the user types. If its own description says `/configurazione`,
  // the user types something that does not resolve.
  for (const loc of i18n.LOCALES) {
    for (const [name, help] of Object.entries(i18n.HELP_CATALOGS[loc]?.commands ?? {})) {
      for (const mentioned of i18n.slashCommandsIn(help.summary ?? "")) {
        const bare = mentioned.slice(1);
        assert.ok(
          PRIMARY.has(bare) || ALIASES.has(bare),
          `${loc}.${name} mentions ${mentioned}, which is not a command`,
        );
      }
    }
  }
});
