/**
 * live.test.ts — node:test for the PURE live/postfix/surround template engine (APP-020).
 *
 * Pins the macro/snippet syntax-collision guarantee (a body with BOTH `$NAME$` macros and
 * Monaco `${2:default}`/`$0`), the Monaco-insertion mapping ($END$→$0, $SELECTION$→
 * ${TM_SELECTED_TEXT}, $EXPR$→receiver), preview expansion, validation, the untyped-JSON
 * sanitizer, deterministic $DATE$, and the parser-free receiver heuristic edge cases.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type LiveTemplateDef,
  expandMacros,
  isValidLiveTemplate,
  isoDate,
  previewExpand,
  receiverExpression,
  sanitizeUserTemplates,
  stripMonacoPlaceholders,
  toMonacoSnippet,
  validateLiveTemplate,
} from "./live.js";

test("expandMacros touches $NAME$ ONLY — Monaco ${2:default}/$1/$0 survive untouched", () => {
  // a body that mixes BOTH syntaxes (the core trap the plan calls out)
  const body = "log($EXPR$, ${1:label}, $2)$END$"; // $0 target + monaco tabstops
  const out = expandMacros(body, { EXPR: "x", END: "$0" });
  assert.equal(out, "log(x, ${1:label}, $2)$0");
});

test("expandMacros leaves an UNKNOWN macro verbatim (user data, not ours to drop)", () => {
  assert.equal(expandMacros("$FOO$ and $END$", { END: "" }), "$FOO$ and ");
});

test("expandMacros does not re-scan replacement text ($SELECTION$ → ${TM_SELECTED_TEXT})", () => {
  // ${TM_SELECTED_TEXT} contains no `$NAME$` and must not be re-expanded to empty.
  assert.equal(
    expandMacros("[$SELECTION$]", { SELECTION: "${TM_SELECTED_TEXT}" }),
    "[${TM_SELECTED_TEXT}]",
  );
});

test("toMonacoSnippet maps $END$→$0 and $SELECTION$→${TM_SELECTED_TEXT} for surround", () => {
  assert.equal(
    toMonacoSnippet("if (${1:cond}) {\n\t$SELECTION$\n}$END$"),
    "if (${1:cond}) {\n\t${TM_SELECTED_TEXT}\n}$0",
  );
});

test("toMonacoSnippet substitutes the literal receiver for postfix $EXPR$", () => {
  assert.equal(
    toMonacoSnippet("console.log($EXPR$)$END$", { receiver: "user.name" }),
    "console.log(user.name)$0",
  );
});

test("toMonacoSnippet leaves $DATE$ intact when no clock supplied (no phantom empty)", () => {
  assert.equal(toMonacoSnippet("// $DATE$"), "// $DATE$");
  assert.equal(
    toMonacoSnippet("// $DATE$", { now: new Date("2026-07-05T10:00:00Z") }),
    "// 2026-07-05",
  );
});

test("isoDate is deterministic ISO YYYY-MM-DD regardless of the instant's time", () => {
  assert.equal(isoDate(new Date("2026-07-05T23:59:59.999Z")), "2026-07-05");
});

test("stripMonacoPlaceholders reduces tabstops to their defaults", () => {
  assert.equal(stripMonacoPlaceholders("f(${1:name}, ${2}, $3)$0"), "f(name, , )");
  assert.equal(stripMonacoPlaceholders("${1|a,b,c|}"), "a");
});

test("previewExpand yields human-readable sample output (macros + stripped tabstops)", () => {
  const out = previewExpand("console.log(${1:msg})$END$", {});
  assert.equal(out, "console.log(msg)");
  const surround = previewExpand("<b>$SELECTION$</b>$END$", { selection: "hi" });
  assert.equal(surround, "<b>hi</b>");
});

test("validateLiveTemplate flags empty abbrev, whitespace abbrev, empty body, no lang, bad kind", () => {
  assert.deepEqual(
    validateLiveTemplate({ abbrev: "log", body: "x", languages: ["javascript"], kind: "live" }),
    [],
  );
  assert.equal(
    validateLiveTemplate({ abbrev: "", body: "x", languages: ["js"], kind: "live" }).length,
    1,
  );
  assert.equal(
    validateLiveTemplate({ abbrev: "a b", body: "x", languages: ["js"], kind: "live" }).length,
    1,
  );
  assert.equal(
    validateLiveTemplate({ abbrev: "a", body: "", languages: ["js"], kind: "live" }).length,
    1,
  );
  assert.equal(
    validateLiveTemplate({ abbrev: "a", body: "x", languages: [], kind: "live" }).length,
    1,
  );
  assert.equal(
    // exercising an invalid kind on purpose (cast through unknown, no `any`)
    validateLiveTemplate({
      abbrev: "a",
      body: "x",
      languages: ["js"],
      kind: "nope" as unknown as "live",
    }).length,
    1,
  );
});

test("isValidLiveTemplate narrows a good def", () => {
  const t: Partial<LiveTemplateDef> = {
    abbrev: "fn",
    body: "$1",
    languages: ["javascript"],
    kind: "live",
  };
  assert.equal(isValidLiveTemplate(t), true);
});

test("sanitizeUserTemplates drops malformed rows and keeps valid ones", () => {
  const raw = [
    { abbrev: "ok", description: "d", body: "x$0", languages: ["python"], kind: "live" },
    { abbrev: "", body: "x", languages: ["python"], kind: "live" }, // bad abbrev
    { abbrev: "no", body: "x", languages: [], kind: "live" }, // no language
    { abbrev: "kind", body: "x", languages: ["python"], kind: "weird" }, // bad kind
    "not-an-object",
    null,
  ];
  const clean = sanitizeUserTemplates(raw);
  assert.equal(clean.length, 1);
  assert.equal(clean[0]?.abbrev, "ok");
  assert.equal(clean[0]?.kind, "live");
});

test("sanitizeUserTemplates returns [] for non-array input", () => {
  assert.deepEqual(sanitizeUserTemplates({}), []);
  assert.deepEqual(sanitizeUserTemplates(undefined), []);
});

// --- receiver heuristic edge cases (the plan's required cases) ----------------
test("receiverExpression: bare identifier", () => {
  assert.equal(receiverExpression("x"), "x");
});
test("receiverExpression: call + index + member chain a.b().c", () => {
  assert.equal(receiverExpression("a.b().c"), "a.b().c");
});
test("receiverExpression: index arr[i]", () => {
  assert.equal(receiverExpression("arr[i]"), "arr[i]");
});
test("receiverExpression: string literal", () => {
  assert.equal(receiverExpression('"str"'), '"str"');
});
test("receiverExpression: stops at whitespace/operator — foo = bar → bar", () => {
  assert.equal(receiverExpression("foo = bar"), "bar");
});
test("receiverExpression: captures only the receiver in a call arg — f(a, b.c) → b.c", () => {
  assert.equal(receiverExpression("f(a, b.c"), "b.c");
});
test("receiverExpression: nested call chain foo.bar(a,b).baz", () => {
  assert.equal(receiverExpression("foo.bar(a,b).baz"), "foo.bar(a,b).baz");
});
test("receiverExpression: empty when nothing precedes", () => {
  assert.equal(receiverExpression(""), "");
  assert.equal(receiverExpression("  "), "");
});
