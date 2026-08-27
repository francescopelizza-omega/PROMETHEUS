/**
 * effort-rules.test.ts — the disk half of the capability table.
 *
 * The behaviour worth pinning is mostly about FAILURE: a missing file is the normal case and
 * must be silent, while a malformed one must be loud, because the user edited it specifically
 * to change this behaviour and a silently dropped rule looks exactly like a working one.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ai } from "@prometheus/core";

import { loadEffortRules } from "./effort-rules.js";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "prom-effort-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** Write a user-layer file into a fake `~/.prometheus` root. */
function writeUser(home: string, body: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ai.EFFORT_RULES_FILENAME), JSON.stringify(body));
}

/** Write a project-layer file into `<cwd>/.prometheus/`. */
function writeProject(cwd: string, body: unknown): void {
  const dir = join(cwd, ".prometheus");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ai.EFFORT_RULES_FILENAME), JSON.stringify(body));
}

const OVERRIDE = {
  id: "gemma-3-thinks-on-my-box",
  match: { modelIdRegex: "(^|[/:_-])gemma-?3([^0-9]|$)" },
  cap: {
    mechanism: "effort-enum",
    field: "reasoning_effort",
    supported: ["low", "high"],
    enumMap: { low: "low", high: "high" },
    note: "my build of gemma3 does think",
  },
};

test("no files at all ⇒ the builtins, silently — this is the normal case", () => {
  const home = tmp();
  const cwd = tmp();
  const r = loadEffortRules(cwd, home);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.sources, []);
  assert.equal(r.rules.length, ai.builtinRules().length);
});

test("a user file is APPENDED after the builtins, so it wins a specificity tie", () => {
  const home = tmp();
  const cwd = tmp();
  writeUser(home, { rules: [OVERRIDE] });
  const r = loadEffortRules(cwd, home);
  assert.equal(r.sources.length, 1);
  assert.deepEqual(r.notes, []);
  const { rule, cap } = ai.resolveCapability({ modelId: "gemma3:12b" }, r.rules);
  assert.equal(rule?.id, "gemma-3-thinks-on-my-box");
  assert.equal(cap.mechanism, "effort-enum");
});

test("a PROJECT file is found by walking up, and outranks the user file", () => {
  // Later layer wins the tie, and the walk means the file works from a subdirectory — which is
  // where anyone actually runs a command.
  const home = tmp();
  const cwd = tmp();
  writeUser(home, { rules: [OVERRIDE] });
  writeProject(cwd, {
    rules: [{ ...OVERRIDE, id: "project-says-no", cap: { mechanism: "none", supported: [] } }],
  });
  const deep = join(cwd, "src", "nested");
  mkdirSync(deep, { recursive: true });
  const r = loadEffortRules(deep, home);
  assert.equal(r.sources.length, 2);
  assert.equal(
    ai.resolveCapability({ modelId: "gemma3:12b" }, r.rules).rule?.id,
    "project-says-no",
  );
});

test("unparseable JSON is REPORTED and the builtins still stand", () => {
  const home = tmp();
  const cwd = tmp();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ai.EFFORT_RULES_FILENAME), "{ not json");
  const r = loadEffortRules(cwd, home);
  assert.equal(r.rules.length, ai.builtinRules().length, "a bad file must not lose the builtins");
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0] ?? "", /not valid JSON/);
});

test("a malformed RULE is reported by index, and its siblings still load", () => {
  const home = tmp();
  const cwd = tmp();
  writeUser(home, {
    rules: [{ id: "broken", match: {}, cap: { mechanism: "telepathy", supported: [] } }, OVERRIDE],
  });
  const r = loadEffortRules(cwd, home);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0] ?? "", /rule\[0\].*unknown mechanism/);
  assert.equal(ai.resolveCapability({ modelId: "gemma3:12b" }, r.rules).rule?.id, OVERRIDE.id);
});

test("PROM_NO_PROJECT_CONFIG=1 turns the project layer off, exactly as it does for .prom.toml", () => {
  const home = tmp();
  const cwd = tmp();
  writeProject(cwd, { rules: [OVERRIDE] });
  const before = process.env.PROM_NO_PROJECT_CONFIG;
  process.env.PROM_NO_PROJECT_CONFIG = "1";
  try {
    const r = loadEffortRules(cwd, home);
    assert.deepEqual(r.sources, []);
    assert.equal(r.rules.length, ai.builtinRules().length);
  } finally {
    // biome-ignore lint/performance/noDelete: restoring an env var to ABSENT is the only correct restore — assigning "" would leave a set-but-empty variable behind for every later test in this process.
    if (before === undefined) delete process.env.PROM_NO_PROJECT_CONFIG;
    else process.env.PROM_NO_PROJECT_CONFIG = before;
  }
});
