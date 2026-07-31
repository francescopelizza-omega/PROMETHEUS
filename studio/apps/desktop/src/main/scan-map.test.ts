/**
 * scan-map.test.ts — node:test for the PURE scan-envelope mappers (file 02 §6).
 *
 * Decoupled: no electron, no engine spawn. Pins the two normalisations the MAIN
 * process applies to the loose `scan` envelope before it crosses the contextBridge,
 * grounded against the REAL engine shape (`python3 prometheus.py --json scan`):
 *
 *   os:     { family:"macos", pkg_manager:"brew" }  → "macos · brew"   (OBJECT!)
 *   agents: [{ name,label,kind,present,where }, …]  → typed AgentRow[]
 *
 * The OS case is the regression guard: the engine emits `os` as an OBJECT, so a
 * `typeof os === "string"` check would silently drop it and render an empty OS.
 *
 * Run: node --import ../../../cli/dev-register.mjs --test scan-map.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { osLabel, toAgentRows } from "./scan-map.js";

/* ── osLabel ────────────────────────────────────────────────────────────────*/

test("osLabel flattens the REAL engine os OBJECT to 'family · pkg'", () => {
  assert.equal(osLabel({ family: "macos", pkg_manager: "brew" }), "macos · brew");
  assert.equal(osLabel({ family: "linux", pkg_manager: "apt" }), "linux · apt");
});

test("osLabel renders family alone when no package manager is present", () => {
  assert.equal(osLabel({ family: "windows" }), "windows");
  assert.equal(osLabel({ family: "macos", pkg_manager: "" }), "macos");
});

test("osLabel renders the package manager alone when family is missing", () => {
  assert.equal(osLabel({ pkg_manager: "brew" }), "brew");
});

test("osLabel accepts a forward-compat bare string", () => {
  assert.equal(osLabel("macos"), "macos");
  assert.equal(osLabel("  linux  "), "linux");
});

test("osLabel returns undefined for absent / unparseable / empty shapes", () => {
  assert.equal(osLabel(undefined), undefined);
  assert.equal(osLabel(null), undefined);
  assert.equal(osLabel({}), undefined);
  assert.equal(osLabel(""), undefined);
  assert.equal(osLabel(42), undefined);
  assert.equal(osLabel([]), undefined);
});

test("osLabel never throws on a hostile shape (the seam must not crash)", () => {
  assert.doesNotThrow(() => osLabel({ family: 7, pkg_manager: { nested: true } }));
  assert.equal(osLabel({ family: 7, pkg_manager: { nested: true } }), undefined);
});

/* ── toAgentRows ────────────────────────────────────────────────────────────*/

test("toAgentRows maps the REAL engine agent shape to typed rows", () => {
  const rows = toAgentRows([
    {
      name: "claude",
      label: "Claude Code",
      kind: "cli",
      present: true,
      where: "/Users/x/.local/bin/claude",
    },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    name: "claude",
    label: "Claude Code",
    kind: "cli",
    present: true,
    where: "/Users/x/.local/bin/claude",
  });
});

test("toAgentRows defaults a missing label to name, kind to 'cli', present to false", () => {
  const rows = toAgentRows([{ name: "cursor" }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { name: "cursor", label: "cursor", kind: "cli", present: false });
});

test("toAgentRows omits `where` when it is not a string (exactOptionalPropertyTypes)", () => {
  const rows = toAgentRows([{ name: "x", present: false, where: 123 }]);
  assert.equal(rows.length, 1);
  assert.equal("where" in (rows[0] as object), false);
});

test("toAgentRows coerces present to a strict boolean (only literal true ⇒ true)", () => {
  const rows = toAgentRows([
    { name: "a", present: true },
    { name: "b", present: "yes" },
    { name: "c", present: 1 },
  ]);
  assert.equal(rows[0]?.present, true);
  assert.equal(rows[1]?.present, false);
  assert.equal(rows[2]?.present, false);
});

test("toAgentRows skips non-object entries and tolerates a non-array input", () => {
  const rows = toAgentRows([null, 7, "str", { name: "ok", present: true }, undefined]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "ok");
  assert.deepEqual(toAgentRows(undefined), []);
  assert.deepEqual(toAgentRows("not-an-array"), []);
  assert.deepEqual(toAgentRows({}), []);
});
