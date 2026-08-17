/**
 * catalog-browse-view.test.ts — the §2 view model.
 *
 * The two things worth pinning here are both correctness-of-meaning, not rendering: that an
 * unscanned row says QUEUED rather than ALLOW, and that the stepper's active step follows the
 * run's real signals. Everything else in §2 is layout, which a screenshot checks and a unit
 * test cannot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CATALOG_VERDICT_CHIP,
  INSTALL_STEPS,
  type InstallRunState,
  catalogVerdictOf,
  filterByKind,
  filterBySearch,
  installPhase,
  kindGlyph,
  stepStates,
} from "./catalog-browse-view.js";

/* ── the chip ────────────────────────────────────────────────────────────────*/

test("an unknown / missing verdict reads QUEUED — never ALLOW", () => {
  // The failure this prevents: `CatalogItem` has no verdict field, so a default of "allow"
  // would paint every row in the catalog green before nemesis had scanned a single one.
  for (const raw of [undefined, null, "", "unknown", "clean", "ok"]) {
    assert.equal(catalogVerdictOf(raw), "queued", `${JSON.stringify(raw)} was not queued`);
  }
  assert.equal(CATALOG_VERDICT_CHIP.queued.label, "QUEUED");
});

test("the real tiers pass through with the §2 glyphs", () => {
  assert.equal(catalogVerdictOf("allow"), "allow");
  assert.equal(catalogVerdictOf("warn"), "warn");
  assert.equal(catalogVerdictOf("block"), "block");
  assert.deepEqual(
    (["allow", "warn", "block", "queued"] as const).map((v) => CATALOG_VERDICT_CHIP[v].glyph),
    ["●", "◑", "✕", "◌"],
  );
});

test("`error` is NOT folded into BLOCK — a scan that failed is a different fact", () => {
  assert.equal(catalogVerdictOf("error"), "error");
  assert.notEqual(CATALOG_VERDICT_CHIP.error.label, CATALOG_VERDICT_CHIP.block.label);
  // …but it still paints at the danger role, because it is still not safe to proceed.
  assert.equal(CATALOG_VERDICT_CHIP.error.role, "danger");
});

test("every chip resolves to a semantic role, never a raw colour", () => {
  for (const [key, chip] of Object.entries(CATALOG_VERDICT_CHIP)) {
    assert.ok(chip.role.length > 0, `${key} has no role`);
    assert.doesNotMatch(chip.role, /^#/, `${key} carries a hex instead of a role token`);
  }
});

/* ── the stepper ─────────────────────────────────────────────────────────────*/

const IDLE: InstallRunState = {
  running: false,
  leg: null,
  hasOutput: false,
  awaitingVerdict: false,
  completed: false,
};

test("idle leaves every step pending", () => {
  assert.equal(installPhase(IDLE), "idle");
  assert.deepEqual(stepStates("idle"), ["pending", "pending", "pending", "pending", "pending"]);
});

test("the dry leg is `fetch` until the engine speaks, then `dry-run`", () => {
  // The transition is the FIRST STREAMED LINE, not a timer. A stepper that advances on a
  // timer says "Dry-run" while a slow clone is still fetching, which is decoration.
  const fetching: InstallRunState = { ...IDLE, running: true, leg: "dry" };
  assert.equal(installPhase(fetching), "fetch");
  assert.equal(installPhase({ ...fetching, hasOutput: true }), "dryRun");
});

test("a verdict on screen parks the stepper at Verdict with the first two done", () => {
  const s: InstallRunState = { ...IDLE, awaitingVerdict: true };
  assert.equal(installPhase(s), "verdict");
  assert.deepEqual(stepStates("verdict"), ["done", "done", "active", "pending", "pending"]);
});

test("a verdict outranks a running leg — the human is the blocker, not the engine", () => {
  const s: InstallRunState = { ...IDLE, running: true, leg: "dry", awaitingVerdict: true };
  assert.equal(installPhase(s), "verdict");
});

test("the commit leg is `install`, and completion marks every step done", () => {
  assert.equal(installPhase({ ...IDLE, running: true, leg: "commit" }), "install");
  assert.deepEqual(stepStates("install"), ["done", "done", "done", "done", "active"]);
  assert.equal(installPhase({ ...IDLE, completed: true }), "done");
  assert.deepEqual(stepStates("done"), ["done", "done", "done", "done", "done"]);
});

test("the steps are the five §2 names, in order", () => {
  assert.deepEqual([...INSTALL_STEPS], ["Fetch", "Dry-run", "Verdict", "Confirm", "Install"]);
  assert.equal(stepStates("idle").length, INSTALL_STEPS.length);
});

/* ── the filters ─────────────────────────────────────────────────────────────*/

const ITEMS = [
  { kind: "plugin", tier: "official", title: "Alpha", summary: "a code graph" },
  { kind: "app", tier: "community", title: "Comfy", summary: "an image app" },
  { kind: "model-tool", tier: "community", title: "Ollama", summary: "serves models" },
  { kind: "worldsim", tier: "community", title: "Sim", summary: "a world" },
  { kind: "plugin", tier: "documented", title: "Excluded", summary: "read-only reference" },
];

test("`documented` is a TIER — it never leaks into the installable buckets", () => {
  // A documented-only entry is `installable:false` upstream, so listing it beside plugins
  // puts a missing Install button next to it, which reads as a bug rather than as policy.
  assert.deepEqual(
    filterByKind(ITEMS, "plugin").map((i) => i.title),
    ["Alpha"],
  );
  assert.deepEqual(
    filterByKind(ITEMS, "documented").map((i) => i.title),
    ["Excluded"],
  );
  assert.equal(filterByKind(ITEMS, "all").length, 4);
});

test("each registry kind stays reachable after the §1 merge", () => {
  // The regression this guards: the rail lost four nouns, and a merge that dropped the
  // apps / model-tool / worldsim registries would make them unreachable from the GUI.
  for (const [kind, title] of [
    ["app", "Comfy"],
    ["model-tool", "Ollama"],
    ["worldsim", "Sim"],
  ] as const) {
    assert.deepEqual(
      filterByKind(ITEMS, kind).map((i) => i.title),
      [title],
    );
  }
});

test("search matches title OR summary, case-insensitively; empty matches all", () => {
  assert.deepEqual(
    filterBySearch(ITEMS, "IMAGE").map((i) => i.title),
    ["Comfy"],
  );
  assert.deepEqual(
    filterBySearch(ITEMS, "alpha").map((i) => i.title),
    ["Alpha"],
  );
  assert.equal(filterBySearch(ITEMS, "   ").length, ITEMS.length);
});

test("the row glyph follows kind, and documented overrides it", () => {
  assert.equal(kindGlyph("app", "community"), "▣");
  assert.equal(kindGlyph("plugin", "documented"), "▤");
  assert.equal(kindGlyph("something-new", "community"), "⬚", "an unknown kind still gets a chip");
});
