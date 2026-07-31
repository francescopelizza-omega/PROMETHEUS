/**
 * structsearch-map.test.ts — node:test for the structural-match → preview mapping (APP-076).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IdeStructMatch } from "../../../shared/ipc-contract.js";
import {
  structMatchToLineMatch,
  structMatchesToLineMatches,
  substituteBindings,
} from "./structsearch-map.js";

test("substituteBindings: $X → binding; unbound stays literal", () => {
  assert.equal(substituteBindings("log($X)", { X: "1 + 2" }), "log(1 + 2)");
  assert.equal(substituteBindings("f($X, $Y)", { X: "a", Y: "b" }), "f(a, b)");
  assert.equal(substituteBindings("g($Z)", { X: "a" }), "g($Z)"); // unbound → literal (visible typo)
});

const m = (over: Partial<IdeStructMatch>): IdeStructMatch => ({
  file: "/p/a.py",
  line: 3,
  col: 1,
  endLine: 3,
  endCol: 8,
  snippet: "print(x)",
  bindings: { X: "x" },
  ...over,
});

test("structMatchToLineMatch: 1-based → 0-based, snippet end, rewrite applied", () => {
  const lm = structMatchToLineMatch(m({}), "log($X)");
  assert.equal(lm.line, 2); // 3 → 0-based 2
  assert.equal(lm.start, 0); // col 1 → 0-based 0
  assert.equal(lm.end, "print(x)".length);
  assert.equal(lm.matchText, "print(x)");
  assert.equal(lm.replacement, "log(x)");
  assert.equal(lm.id, "2:0");
});

test("structMatchesToLineMatches: sorted by line then column", () => {
  const out = structMatchesToLineMatches(
    [m({ line: 5, col: 3 }), m({ line: 2, col: 1 }), m({ line: 2, col: 9 })],
    "",
  );
  assert.deepEqual(
    out.map((x) => [x.line, x.start]),
    [
      [1, 0],
      [1, 8],
      [4, 2],
    ],
  );
});

test("multi-line snippet: end is the FIRST line length", () => {
  const lm = structMatchToLineMatch(m({ snippet: "foo(\n  bar)" }), "");
  assert.equal(lm.end, 0 + "foo(".length);
  assert.equal(lm.matchText, "foo(\n  bar)"); // full text kept for the apply
});
