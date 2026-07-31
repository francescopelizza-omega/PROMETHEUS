/**
 * palette-commands.test.ts — every palette entry has a real dispatcher (APP-004).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isEditorActionId } from "./editor-commands.js";
import { EDITOR_DISPATCHED_IDS, PALETTE_COMMANDS } from "./palette-commands.js";

test("exhaustiveness: every PALETTE_COMMANDS id is Monaco-routed or editor-dispatched", () => {
  for (const c of PALETTE_COMMANDS) {
    assert.ok(
      isEditorActionId(c.id) || EDITOR_DISPATCHED_IDS.has(c.id),
      `palette id "${c.id}" has no dispatcher — add a runCommand case (editor.tsx) and list it in EDITOR_DISPATCHED_IDS, or it dies in the default branch`,
    );
  }
});

test("ai.openAgent is no longer surfaced (documented no-op removed, APP-004)", () => {
  assert.equal(
    PALETTE_COMMANDS.some((c) => c.id === "ai.openAgent"),
    false,
  );
});

test("Go-to family entries exist in the Go category (APP-075)", () => {
  const go = new Map(PALETTE_COMMANDS.filter((c) => c.category === "Go").map((c) => [c.id, c]));
  for (const id of ["nav.goToLine", "nav.goToSuper", "nav.relatedSymbol"]) {
    assert.ok(go.has(id), `${id} present in the Go category`);
  }
});

test("panel + picker entries are surfaced and dispatched", () => {
  for (const id of [
    "panel.tokens",
    "panel.health",
    "panel.metadata",
    "python.selectInterpreter",
    "models.selectEndpoint",
  ]) {
    assert.ok(
      PALETTE_COMMANDS.some((c) => c.id === id),
      `${id} missing from palette`,
    );
    assert.ok(EDITOR_DISPATCHED_IDS.has(id), `${id} missing from dispatcher set`);
  }
});

test("no duplicate ids in the palette surface", () => {
  const seen = new Set<string>();
  for (const c of PALETTE_COMMANDS) {
    assert.ok(!seen.has(c.id), `duplicate palette id ${c.id}`);
    seen.add(c.id);
  }
});
