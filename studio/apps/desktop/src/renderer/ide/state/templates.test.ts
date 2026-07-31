/**
 * templates.test.ts — node:test for the PURE live-templates registry.
 *
 * Pins the seed's integrity (unique abbrev per language, non-empty bodies, ≥1 language),
 * language filtering, and the user-override merge semantics.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIVE_TEMPLATES,
  type LiveTemplate,
  type LiveTemplateDef,
  POSTFIX_TEMPLATES,
  SURROUND_TEMPLATES,
  mergeTemplates,
  mergedTemplatesForLang,
  seedTemplatesForKind,
  templatesForLang,
} from "./templates.js";

test("seed integrity: non-empty abbrev/body and ≥1 language", () => {
  for (const t of LIVE_TEMPLATES) {
    assert.equal(t.abbrev.length > 0, true);
    assert.equal(t.body.length > 0, true);
    assert.equal(t.languages.length > 0, true, t.abbrev);
  }
});

test("abbreviations are unique WITHIN a language", () => {
  const langs = new Set(LIVE_TEMPLATES.flatMap((t) => t.languages));
  for (const lang of langs) {
    const abbrevs = templatesForLang(lang).map((t) => t.abbrev);
    assert.equal(new Set(abbrevs).size, abbrevs.length, `dup abbrev in ${lang}`);
  }
});

test("templatesForLang filters by language", () => {
  const py = templatesForLang("python");
  assert.equal(
    py.some((t) => t.abbrev === "main"),
    true,
  );
  assert.equal(
    py.some((t) => t.abbrev === "log"),
    false,
  ); // log is JS-only
  assert.deepEqual(templatesForLang("cobol"), []);
});

test("python and js both define a `try` template with different bodies", () => {
  const pyTry = templatesForLang("python").find((t) => t.abbrev === "try");
  const jsTry = templatesForLang("typescript").find((t) => t.abbrev === "try");
  assert.ok(pyTry && jsTry);
  assert.notEqual(pyTry.body, jsTry.body);
});

test("mergeTemplates overrides a seed template on (abbrev, language)", () => {
  const custom: LiveTemplate[] = [
    { abbrev: "pr", description: "custom print", body: "print(f${1})$0", languages: ["python"] },
  ];
  const merged = mergeTemplates(LIVE_TEMPLATES, custom);
  const pyPr = templatesForLang("python", merged).filter((t) => t.abbrev === "pr");
  assert.equal(pyPr.length, 1); // not duplicated
  assert.equal(pyPr[0]?.body, "print(f${1})$0"); // custom wins
});

test("mergeTemplates: a single-language override keeps a multi-language seed for its OTHER languages", () => {
  // a multi-language seed (js/ts/jsx/tsx) overridden for ONE language must survive for the rest.
  const seed: LiveTemplate[] = [
    {
      abbrev: "log",
      description: "console.log",
      body: "console.log(${1})$0",
      languages: ["javascript", "typescript", "javascriptreact", "typescriptreact"],
    },
  ];
  const custom: LiveTemplate[] = [
    { abbrev: "log", description: "ts log", body: "logger.log(${1})$0", languages: ["typescript"] },
  ];
  const merged = mergeTemplates(seed, custom);
  // javascript still has the built-in log; typescript has the override; both present, no loss.
  assert.equal(
    templatesForLang("javascript", merged).find((t) => t.abbrev === "log")?.body,
    "console.log(${1})$0",
  );
  assert.equal(
    templatesForLang("javascriptreact", merged).find((t) => t.abbrev === "log")?.body,
    "console.log(${1})$0",
  );
  assert.equal(
    templatesForLang("typescript", merged).find((t) => t.abbrev === "log")?.body,
    "logger.log(${1})$0",
  );
});

test("mergeTemplates keeps non-conflicting seed + adds new custom", () => {
  const custom: LiveTemplate[] = [
    {
      abbrev: "guard",
      description: "early return",
      body: "if not ${1}:\n    return$0",
      languages: ["python"],
    },
  ];
  const merged = mergeTemplates(LIVE_TEMPLATES, custom);
  assert.equal(merged.length, LIVE_TEMPLATES.length + 1);
  assert.equal(
    templatesForLang("python", merged).some((t) => t.abbrev === "guard"),
    true,
  );
});

// --- postfix / surround seeds + the merged runtime path (APP-020) -------------

test("postfix + surround seed integrity: unique abbrev within a (kind, language)", () => {
  for (const [set, kind] of [
    [POSTFIX_TEMPLATES, "postfix"],
    [SURROUND_TEMPLATES, "surround"],
  ] as const) {
    for (const t of set) {
      assert.equal(t.kind, kind);
      assert.equal(t.abbrev.length > 0, true);
      assert.equal(t.body.length > 0, true);
      assert.equal(t.languages.length > 0, true, t.abbrev);
    }
    const langs = new Set(set.flatMap((t) => t.languages));
    for (const lang of langs) {
      const abbrevs = set.filter((t) => t.languages.includes(lang)).map((t) => t.abbrev);
      assert.equal(new Set(abbrevs).size, abbrevs.length, `dup ${kind} abbrev in ${lang}`);
    }
  }
});

test("a postfix .log exists for JS and its body rewrites the receiver via $EXPR$", () => {
  const jsLog = POSTFIX_TEMPLATES.find(
    (t) => t.abbrev === "log" && t.languages.includes("javascript"),
  );
  assert.ok(jsLog);
  assert.match(jsLog.body, /\$EXPR\$/);
});

test("seedTemplatesForKind('live') derives from LIVE_TEMPLATES with kind:'live' (shape kept)", () => {
  const live = seedTemplatesForKind("live");
  assert.equal(live.length, LIVE_TEMPLATES.length);
  assert.equal(
    live.every((t) => t.kind === "live"),
    true,
  );
  // the seed bodies (Monaco placeholders) are copied verbatim — not mutated
  const seedMain = LIVE_TEMPLATES.find((t) => t.abbrev === "main");
  const liveMain = live.find((t) => t.abbrev === "main");
  assert.equal(liveMain?.body, seedMain?.body);
});

test("mergedTemplatesForLang consumes mergeTemplates: user overrides a seed on (abbrev, language)", () => {
  const user: LiveTemplateDef[] = [
    {
      abbrev: "log",
      description: "custom log",
      body: "console.debug($1)$0",
      languages: ["typescript"],
      kind: "live",
    },
  ];
  const merged = mergedTemplatesForLang("live", "typescript", user);
  const logs = merged.filter((t) => t.abbrev === "log");
  assert.equal(logs.length, 1); // not duplicated
  assert.equal(logs[0]?.body, "console.debug($1)$0"); // custom wins
});

test("mergedTemplatesForLang override is PER-LANGUAGE — a ts override does not shadow py", () => {
  // seed `main` is python-only. A user live `main`/typescript must not remove the py seed.
  const user: LiveTemplateDef[] = [
    {
      abbrev: "main",
      description: "ts main",
      body: "// main$0",
      languages: ["typescript"],
      kind: "live",
    },
  ];
  const py = mergedTemplatesForLang("live", "python", user);
  assert.equal(
    py.some((t) => t.abbrev === "main"),
    true,
  );
});

test("mergedTemplatesForLang keeps kinds separate — a user live `log` never appears as postfix", () => {
  const user: LiveTemplateDef[] = [
    {
      abbrev: "zzz",
      description: "live only",
      body: "zzz$0",
      languages: ["javascript"],
      kind: "live",
    },
  ];
  const postfix = mergedTemplatesForLang("postfix", "javascript", user);
  assert.equal(
    postfix.some((t) => t.abbrev === "zzz"),
    false,
  );
});
