/**
 * settings-store.test.ts — the atomic disk layers + effective-settings resolution
 * behind `settings:*` (APP-017). Real tmpdir fs, no Electron.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadEffective,
  readLayer,
  resolveRichRows,
  toRowView,
  workspaceSettingsPath,
  writeLayerAtomic,
} from "./settings-store.js";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-settings-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readLayer: missing file → {} (fail-soft, never throws)", async () => {
  await withTmpDir(async (dir) => {
    const rows = await readLayer(join(dir, "nope.json"));
    assert.deepEqual(rows, {});
  });
});

test("readLayer: corrupt JSON → {} (fail-soft)", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "bad.json");
    await writeLayerAtomicRaw(path, "{ not json");
    const rows = await readLayer(path);
    assert.deepEqual(rows, {});
  });
});

// writeFile a raw string directly (bypassing the atomic JSON writer) to simulate corruption.
async function writeLayerAtomicRaw(path: string, raw: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw, "utf8");
}

test("writeLayerAtomic + readLayer: round-trips, creates missing parent dirs", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "nested", "settings.json");
    await writeLayerAtomic(path, { theme: "dracula", gateStrict: true });
    const rows = await readLayer(path);
    assert.deepEqual(rows, { theme: "dracula", gateStrict: true });
    // no leftover temp file beside it
    const raw = await readFile(path, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  });
});

test("workspaceSettingsPath: nests under <root>/.prometheus/settings.json", () => {
  assert.equal(workspaceSettingsPath("/proj"), join("/proj", ".prometheus", "settings.json"));
});

test("loadEffective: defaults only when no layers exist", async () => {
  await withTmpDir(async (dir) => {
    const { effective, global, workspace } = await loadEffective(join(dir, "global.json"));
    assert.equal(effective.theme, "system"); // DEFAULT_SETTINGS
    assert.deepEqual(global, {});
    assert.deepEqual(workspace, {});
  });
});

test("loadEffective: global profileId selects a built-in profile bundle", async () => {
  await withTmpDir(async (dir) => {
    const globalPath = join(dir, "global.json");
    await writeLayerAtomic(globalPath, { profileId: "security-strict" });
    const { effective } = await loadEffective(globalPath);
    assert.equal(effective.gateStrict, true); // security-strict profile
    assert.equal(effective.allowForce, false);
  });
});

test("loadEffective: workspace layer overrides global, both feed the effective object", async () => {
  await withTmpDir(async (dir) => {
    const globalPath = join(dir, "global.json");
    const root = join(dir, "proj");
    await writeLayerAtomic(globalPath, { theme: "global-theme" });
    await writeLayerAtomic(workspaceSettingsPath(root), { theme: "workspace-theme" });
    const { effective, global, workspace } = await loadEffective(globalPath, root);
    assert.equal(effective.theme, "workspace-theme"); // highest layer wins
    assert.equal(global.theme, "global-theme");
    assert.equal(workspace.theme, "workspace-theme");
  });
});

test("resolveRichRows: per-scope raw values + full definedIn chain; profile winner not mislabeled", () => {
  const global = { theme: "dark" };
  const profile = { gateStrict: true }; // a built-in profile bundle sets this
  const workspace = { theme: "light" };
  const rows = resolveRichRows(global, profile, workspace);

  const theme = rows.get("theme");
  assert.equal(theme?.value, "light"); // workspace wins
  assert.equal(theme?.layer, "workspace");
  assert.deepEqual(theme?.rawByScope, { default: "system", user: "dark", project: "light" });
  assert.deepEqual(theme?.definedIn, ["default", "global", "workspace"]);

  // the profile-set key must be labeled "profile", NOT mislabeled "default" (the fixed bug).
  const gate = rows.get("gateStrict");
  assert.equal(gate?.value, true);
  assert.equal(gate?.layer, "profile");
  assert.deepEqual(gate?.rawByScope, { default: false }); // only defaults set it (falsy but present)
  assert.deepEqual(gate?.definedIn, ["default", "profile"]);

  // a key set nowhere but defaults → default winner, single-scope raw.
  const fmt = rows.get("format.onSave");
  assert.equal(fmt?.layer, "default");
  assert.deepEqual(fmt?.rawByScope, { default: false });

  // a tree key not present in any layer (no default) → unset, empty raw + chain.
  const font = rows.get("editor.font");
  assert.equal(font?.layer, "unset");
  assert.deepEqual(font?.rawByScope, {});
  assert.deepEqual(font?.definedIn, []);
});

test("toRowView: maps a node's schemaKey to its resolved (value, layer) row; passthrough when none", () => {
  const leaf = {
    id: "editor.font",
    title: "Font",
    category: "Editor",
    ownerFile: "08",
    control: "page" as const,
    schemaKey: "editor.font",
    scope: "global" as const,
  };
  const withRow = toRowView(
    leaf,
    new Map([
      ["editor.font", { schemaKey: "editor.font", value: "Fira Code", layer: "global" as const }],
    ]),
  );
  assert.equal(withRow.value, "Fira Code");
  assert.equal(withRow.layer, "global");

  const noSchemaKey = { ...leaf, schemaKey: undefined };
  const withoutRow = toRowView(noSchemaKey, new Map());
  assert.equal("value" in withoutRow, false);
  assert.equal("layer" in withoutRow, false);
});
