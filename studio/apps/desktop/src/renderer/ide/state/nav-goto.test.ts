/**
 * nav-goto.test.ts — node:test for the Go-to family LSP→nav mapping (APP-075).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregateRelated, itemToNavTarget, itemsToNavTargets, normalizeUri } from "./nav-goto.js";

test("itemToNavTarget: Location, LocationLink, and TypeHierarchyItem shapes", () => {
  // plain Location (uri + range)
  assert.deepEqual(
    itemToNavTarget({ uri: "file:///a.py", range: { start: { line: 4, character: 2 } } }, "impl"),
    {
      uri: "file:///a.py",
      line: 4,
      column: 3,
      label: "impl: a.py",
    },
  );
  // LocationLink (targetUri + targetSelectionRange preferred over targetRange)
  assert.deepEqual(
    itemToNavTarget(
      {
        targetUri: "file:///b.py",
        targetRange: { start: { line: 0, character: 0 } },
        targetSelectionRange: { start: { line: 9, character: 4 } },
      },
      "type",
    ),
    { uri: "file:///b.py", line: 9, column: 5, label: "type: b.py" },
  );
  // TypeHierarchyItem (name + selectionRange)
  assert.deepEqual(
    itemToNavTarget(
      { name: "Base", uri: "file:///c.py", selectionRange: { start: { line: 1, character: 0 } } },
      "super",
    ),
    { uri: "file:///c.py", line: 1, column: 1, label: "super: Base" },
  );
  assert.equal(itemToNavTarget(null, "x"), null);
  assert.equal(itemToNavTarget({ no: "uri" }, "x"), null);
});

test("itemsToNavTargets: maps arrays, drops junk", () => {
  const out = itemsToNavTargets(
    [{ uri: "file:///a", range: { start: { line: 0, character: 0 } } }, 42, null],
    "impl",
  );
  assert.equal(out.length, 1);
  assert.equal(itemsToNavTargets("not-an-array", "x").length, 0);
});

test("normalizeUri: decodes percent-encoding + strips trailing slash (dedup key)", () => {
  assert.equal(normalizeUri("file:///C%3A/x/"), "file:///C:/x");
  assert.equal(normalizeUri("file:///a"), "file:///a");
});

test("aggregateRelated: unions kinds + dedupes by uri+line+col (first kind wins)", () => {
  const impl = [{ uri: "file:///a.py", range: { start: { line: 2, character: 0 } } }];
  const type = [
    { uri: "file:///a.py", range: { start: { line: 2, character: 0 } } }, // dup of impl → dropped
    { uri: "file:///d.py", range: { start: { line: 0, character: 0 } } },
  ];
  const supers = [
    { name: "Base", uri: "file:///a.py", selectionRange: { start: { line: 9, character: 0 } } },
  ];
  const out = aggregateRelated([
    { kind: "impl", items: impl },
    { kind: "type", items: type },
    { kind: "super", items: supers },
  ]);
  assert.deepEqual(
    out.map((t) => t.label),
    ["impl: a.py", "type: d.py", "super: Base"], // a.py:2 kept once (impl wins), d.py + Base added
  );
});
