/**
 * session-restore.test.ts — node:test for crash-recovery persistence (APP-067).
 *
 * DOM-free: a Map-backed StorageLike drives the injected seam. Pins the round-trip
 * (persist → reload → identical state), migration idempotency + fail-soft, the byte-capped
 * dirty-buffer eviction, and the ai single→multi fold.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Migration } from "@prometheus/core/migrations";
import {
  type DirtyRecord,
  type StorageLike,
  TABS_KEY,
  TABS_VERSION,
  aiMigrations,
  capDirtyBuffers,
  loadVersioned,
  migrateAiBlob,
  removeDirty,
  saveVersioned,
  serializeTabs,
  upsertDirty,
  validatePersistedDirty,
  validatePersistedTabs,
} from "./session-restore.js";
import type { TabsState } from "./tabs-reducer.js";

/** A Map-backed localStorage stand-in (no DOM). */
function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const TABS: TabsState = {
  docs: [
    {
      uri: "file:///a.ts",
      name: "a.ts",
      languageId: "typescript",
      dirty: false,
      preview: true,
      group: 0,
      large: false,
    },
    {
      uri: "file:///b.py",
      name: "b.py",
      languageId: "python",
      dirty: true,
      preview: false,
      group: 1,
      large: false,
    },
  ],
  activeByGroup: { 0: "file:///a.ts", 1: "file:///b.py" },
  focusedGroup: 1,
};

test("tabs round-trip: persist → reload restores docs, active, focused group (APP-067)", () => {
  const st = fakeStorage();
  assert.equal(saveVersioned(st, TABS_KEY, serializeTabs(TABS, "/repo")), true);
  const r = loadVersioned(st, TABS_KEY, TABS_VERSION, [], validatePersistedTabs);
  assert.ok(r.state);
  assert.deepEqual(
    r.state?.tabs.docs.map((d) => d.uri),
    ["file:///a.ts", "file:///b.py"],
  );
  assert.equal(r.state?.tabs.focusedGroup, 1);
  assert.equal(r.state?.tabs.activeByGroup[1], "file:///b.py");
  assert.equal(r.state?.workspaceRoot, "/repo");
  // restored tabs are PINNED (never preview) so a restore doesn't get replaced on first nav.
  assert.equal(
    r.state?.tabs.docs.every((d) => d.preview === false),
    true,
  );
});

test("tabs validate: drops junk docs + repoints a dangling active tab", () => {
  const blob = {
    version: 1,
    tabs: {
      docs: [
        { uri: "file:///ok.ts", name: "ok.ts", languageId: "typescript", group: 0 },
        { name: "no-uri" }, // junk — dropped
        { uri: 42 }, // junk — dropped
      ],
      activeByGroup: { 0: "file:///gone.ts" }, // dangling → repointed to ok.ts
      focusedGroup: 9, // no such group → clamped
    },
    workspaceRoot: "/w",
  };
  const v = validatePersistedTabs(blob);
  assert.ok(v);
  assert.equal(v?.tabs.docs.length, 1);
  assert.equal(v?.tabs.activeByGroup[0], "file:///ok.ts");
  assert.equal(v?.tabs.focusedGroup, 0);
});

test("loadVersioned is fail-soft: corrupt JSON → null state, ok:false (last-good kept)", () => {
  const st = fakeStorage();
  st.map.set(TABS_KEY, "{not json");
  const r = loadVersioned(st, TABS_KEY, TABS_VERSION, [], validatePersistedTabs);
  assert.equal(r.state, null);
  assert.equal(r.ok, false);
  // absent key → clean null, ok:true (a fresh install, not a corruption).
  const empty = loadVersioned(fakeStorage(), TABS_KEY, TABS_VERSION, [], validatePersistedTabs);
  assert.equal(empty.state, null);
  assert.equal(empty.ok, true);
});

test("saveVersioned swallows a throwing setItem (quota / private mode)", () => {
  const throwing: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  };
  assert.equal(saveVersioned(throwing, TABS_KEY, { version: 1 }), false); // never throws
  assert.equal(saveVersioned(null, TABS_KEY, { version: 1 }), false); // no storage → false
});

test("migration idempotency + fail-soft via loadVersioned (APP-067)", () => {
  const st = fakeStorage();
  // a v0 blob + a step to v1 that APPENDS to an array (would double-apply if re-run).
  st.map.set("k", JSON.stringify({ version: 0, items: ["a"] }));
  const bump: Migration = {
    toVersion: 1,
    migrate: (s) => ({ ...s, items: [...(s.items as string[]), "migrated"] }),
  };
  const validate = (s: { version?: number; items?: unknown }) =>
    Array.isArray(s.items)
      ? ({ version: 1, items: s.items } as { version: number; items: string[] })
      : null;
  const first = loadVersioned(st, "k", 1, [bump], validate);
  assert.deepEqual(first.state?.items, ["a", "migrated"]);
  assert.deepEqual(first.migrated, [1]);
  // persist the migrated state, reload → the step does NOT re-run (version already 1).
  saveVersioned(st, "k", first.state as { version: number; items: string[] });
  const second = loadVersioned(st, "k", 1, [bump], validate);
  assert.deepEqual(second.state?.items, ["a", "migrated"], "no double-append");
  assert.deepEqual(second.migrated, [], "second run applies nothing (idempotent)");

  // a THROWING step → last-good kept, ok:false.
  st.map.set("k2", JSON.stringify({ version: 0, items: ["x"] }));
  const boom: Migration = {
    toVersion: 1,
    migrate: () => {
      throw new Error("bad step");
    },
  };
  const failed = loadVersioned(st, "k2", 1, [boom], validate);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.state?.items, ["x"], "last-good state, not a partial");
});

test("dirty buffers: upsert is newest-wins; cap evicts the OLDEST over budget", () => {
  let bufs: DirtyRecord[] = [];
  bufs = upsertDirty(bufs, "file:///a", "aaa", 1);
  bufs = upsertDirty(bufs, "file:///b", "bbb", 2);
  bufs = upsertDirty(bufs, "file:///a", "AAA-new", 3); // updates a, bumps recency
  assert.equal(bufs.find((b) => b.uri === "file:///a")?.text, "AAA-new");
  assert.equal(bufs.length, 2);
  // cap to a tiny budget → only the newest survives (a, savedAt 3).
  const capped = capDirtyBuffers(bufs, 10);
  assert.equal(capped.length, 1);
  assert.equal(capped[0]?.uri, "file:///a");
});

test("dirty buffers: remove clears a saved file's recovery copy; validate is fail-soft", () => {
  let bufs: DirtyRecord[] = [];
  bufs = upsertDirty(bufs, "file:///a", "x", 1);
  bufs = upsertDirty(bufs, "file:///b", "y", 2);
  bufs = removeDirty(bufs, "file:///a"); // saved → drop
  assert.deepEqual(
    bufs.map((b) => b.uri),
    ["file:///b"],
  );
  const v = validatePersistedDirty({
    version: 1,
    buffers: [{ uri: "ok", text: "t", savedAt: 5 }, { bad: 1 }, 7],
  });
  assert.equal(v?.buffers.length, 1);
  assert.equal(v?.buffers[0]?.uri, "ok");
  assert.equal(validatePersistedDirty({ version: 1 }), null); // no buffers array → null
});

test("ai fold: legacy single-session blob → multi; already-multi is idempotent (APP-067)", () => {
  // legacy {turns} (no order/sessions) → {sessions,order,activeId}, version stamped 1.
  const legacy = migrateAiBlob({ turns: [{ role: "user", content: "hi" }] } as never);
  assert.equal(legacy.version, 1);
  assert.ok(Array.isArray(legacy.order) && (legacy.order as string[]).length === 1);
  const sid = (legacy.order as string[])[0]!;
  assert.deepEqual((legacy.sessions as Record<string, { turns: unknown[] }>)[sid]?.turns, [
    { role: "user", content: "hi" },
  ]);
  // an already-multi (v0-unstamped) blob folds WITHOUT clobbering its sessions.
  const multi = migrateAiBlob({
    order: ["x"],
    sessions: { x: { id: "x", title: "T", turns: [] } },
  } as never);
  assert.deepEqual(multi.order, ["x"]);
  // re-running on the migrated (v1) blob applies nothing.
  const again = migrateAiBlob(legacy);
  assert.deepEqual(again.order, legacy.order);
});

test("aiMigrations chain is a single contiguous v1 step", () => {
  assert.equal(aiMigrations.length, 1);
  assert.equal(aiMigrations[0]?.toVersion, 1);
});
