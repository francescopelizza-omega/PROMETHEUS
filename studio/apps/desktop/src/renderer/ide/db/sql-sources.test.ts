/**
 * sql-sources.test.ts — the PURE data-source reducers + redaction (APP-043).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addSource,
  dialectOf,
  redactConnString,
  removeSource,
  selectSource,
} from "./sql-sources.js";

const empty = { sources: [], selectedId: null };

test("redactConnString strips the password for display/persist", () => {
  assert.equal(redactConnString("postgresql://u:secret@h:5432/db"), "postgresql://u:***@h:5432/db");
  assert.equal(redactConnString("sqlite:///tmp/a.db"), "sqlite:///tmp/a.db");
  assert.doesNotMatch(redactConnString("mysql://u:hunter2@h/db"), /hunter2/);
});

test("dialectOf classifies the driver", () => {
  assert.equal(dialectOf("sqlite:///a.db"), "sqlite");
  assert.equal(dialectOf("postgresql://h/db"), "postgresql");
  assert.equal(dialectOf("mysql://h/db"), "mysql");
});

test("addSource stores the REDACTED conn + selects it; no plaintext password", () => {
  const s = addSource(empty, { id: "a", label: "Prod", connString: "postgresql://u:secret@h/db" });
  assert.equal(s.selectedId, "a");
  assert.equal(s.sources.length, 1);
  assert.equal(s.sources[0]?.dialect, "postgresql");
  assert.doesNotMatch(s.sources[0]?.redactedConn ?? "", /secret/);
});

test("addSource with a blank label falls back to the redacted conn", () => {
  const s = addSource(empty, { id: "a", label: "  ", connString: "sqlite:///a.db" });
  assert.equal(s.sources[0]?.label, "sqlite:///a.db");
});

test("addSource replaces a duplicate id in place", () => {
  let s = addSource(empty, { id: "a", label: "one", connString: "sqlite:///a.db" });
  s = addSource(s, { id: "a", label: "two", connString: "sqlite:///b.db" });
  assert.equal(s.sources.length, 1);
  assert.equal(s.sources[0]?.label, "two");
});

test("selectSource only selects a known id", () => {
  const s = addSource(empty, { id: "a", label: "x", connString: "sqlite:///a.db" });
  assert.equal(selectSource(s, "ghost"), s); // no-op (same reference)
  assert.equal(selectSource(s, "a").selectedId, "a");
});

test("removeSource drops it + reselects the first remaining", () => {
  let s = addSource(empty, { id: "a", label: "x", connString: "sqlite:///a.db" });
  s = addSource(s, { id: "b", label: "y", connString: "sqlite:///b.db" }); // b selected
  const after = removeSource(s, "b");
  assert.equal(after.sources.length, 1);
  assert.equal(after.selectedId, "a");
});
