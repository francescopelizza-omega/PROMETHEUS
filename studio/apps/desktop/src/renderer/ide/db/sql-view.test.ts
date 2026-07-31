/**
 * sql-view.test.ts — PURE result export (APP-087). RFC-4180 CSV + JSON.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type SqlResult, tablesToErMermaid, toCsv, toJson } from "./sql-view.js";

const RESULT: SqlResult = {
  columns: ["id", "name", "note"],
  rows: [
    [1, "plain", null],
    [2, "has,comma", 'has"quote'],
    [3, "has\nnewline", "has\r\ncrlf"],
  ],
  rowCount: 3,
};

test("toCsv: RFC-4180 quoting for commas/quotes/newlines; CRLF endings", () => {
  const csv = toCsv(RESULT);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "id,name,note"); // header
  assert.equal(lines[1], "1,plain,"); // null → empty field
  assert.equal(lines[2], '2,"has,comma","has""quote"'); // comma + doubled quote
  // an embedded newline field is quoted (so it spans, but stays one field)
  assert.match(csv, /"has\nnewline"/);
  assert.match(csv, /"has\r\ncrlf"/);
  assert.ok(csv.endsWith("\r\n"));
});

test("toCsv: header-only for an empty result; BOM opt-in", () => {
  const empty: SqlResult = { columns: ["a", "b"], rows: [], rowCount: 0 };
  assert.equal(toCsv(empty), "a,b\r\n");
  assert.ok(toCsv(empty, { bom: true }).startsWith("﻿"));
});

test("toJson: array of column-keyed row objects; nulls preserved", () => {
  const parsed = JSON.parse(toJson(RESULT)) as Record<string, unknown>[];
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { id: 1, name: "plain", note: null });
  assert.equal(parsed[1]?.name, "has,comma");
});

test("tablesToErMermaid: entities with PK/FK marks + FK edges; dangling FK → no edge", () => {
  const m = tablesToErMermaid([
    { name: "items", columns: [{ name: "id", dtype: "INTEGER", pk: true }] },
    {
      name: "orders",
      columns: [
        { name: "id", dtype: "INTEGER", pk: true },
        { name: "item_id", dtype: "INTEGER", pk: false, fk: { table: "items", to: "id" } },
        { name: "ext", dtype: "INTEGER", pk: false, fk: { table: "gone", to: "id" } },
      ],
    },
  ]);
  assert.ok(m.startsWith("erDiagram"));
  assert.match(m, /INTEGER id PK/);
  assert.match(m, /INTEGER item_id FK/);
  assert.match(m, /items \|\|--o\{ orders : "item_id"/);
  assert.ok(!m.includes("gone")); // FK to a non-exported table → no edge
});
