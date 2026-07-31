/**
 * symbol-federation.test.ts — node:test for Cmd-T cross-server merge/dedupe (APP-077).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeFederatedSymbols, normalizeSymbolUri, symbolKey } from "./symbol-federation.js";

test("normalizeSymbolUri: decode percent-encoding + lower-case the drive letter", () => {
  assert.equal(normalizeSymbolUri("file:///C%3A/x/y.ts"), "file:///c:/x/y.ts");
  assert.equal(normalizeSymbolUri("file:///C:/x/y.ts"), "file:///c:/x/y.ts");
  assert.equal(normalizeSymbolUri("file:///a/b.py"), "file:///a/b.py");
});

test("symbolKey: line included only when a real range is present (>0)", () => {
  const base = { name: "Foo", container: "", uri: "file:///a.py", character: 0 };
  assert.equal(symbolKey({ ...base, line: 10, lang: "python" }), "file:///a.py|Foo||10");
  assert.equal(symbolKey({ ...base, line: 0, lang: "python" }), "file:///a.py|Foo|"); // resolve-deferred
});

test("mergeFederatedSymbols: tags language, dedupes cross-server, first (list-order) wins", () => {
  const py = { name: "handler", container: "app", uri: "file:///a.py", line: 5, character: 0 };
  const ts = { name: "Widget", container: "", uri: "file:///b.ts", line: 2, character: 0 };
  const dupFromTs = {
    name: "handler",
    container: "app",
    uri: "file:///a.py",
    line: 5,
    character: 0,
  };
  const out = mergeFederatedSymbols([
    { lang: "python", symbols: [py] },
    { lang: "typescript", symbols: [ts, dupFromTs] }, // dupFromTs collapses into py's row
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((s) => [s.name, s.lang]),
    [
      ["handler", "python"], // python server (list-order first) owns the deduped row
      ["Widget", "typescript"],
    ],
  );
});

test("mergeFederatedSymbols: percent-encoding difference across servers still collapses", () => {
  const a = { name: "F", container: "", uri: "file:///C%3A/x.ts", line: 1, character: 0 };
  const b = { name: "F", container: "", uri: "file:///c:/x.ts", line: 1, character: 0 };
  const out = mergeFederatedSymbols([
    { lang: "typescript", symbols: [a] },
    { lang: "typescript", symbols: [b] },
  ]);
  assert.equal(out.length, 1);
});
