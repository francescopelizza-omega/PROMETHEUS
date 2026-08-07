/**
 * keymap.test.ts — `prometheus keymap list [--preset <id>]` over pure core settings.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { runKeymap } from "./keymap.js";

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));

test("keymap list: --json lists the built-in presets + default", () => {
  const out = runKeymap(ctxFor(["keymap", "list", "--json"]));
  assert.equal(out.exitCode, 0);
  const j = out.json as { ok: boolean; default: string; keymaps: { id: string }[] };
  assert.equal(j.ok, true);
  assert.ok(j.keymaps.length >= 3);
  assert.ok(j.keymaps.some((k) => k.id === j.default));
});

test("keymap list --preset <id>: dumps bindings + conflict report", () => {
  const out = runKeymap(ctxFor(["keymap", "list", "--preset", "vscode", "--json"]));
  assert.equal(out.exitCode, 0);
  const j = out.json as { ok: boolean; keymap: string; bindings: unknown[] };
  assert.equal(j.keymap, "vscode");
  assert.ok(Array.isArray(j.bindings) && j.bindings.length > 0);
});

test("keymap list --preset <unknown>: not found (exit 2)", () => {
  const out = runKeymap(ctxFor(["keymap", "list", "--preset", "no-such-map"]));
  assert.equal(out.exitCode, 2);
});
