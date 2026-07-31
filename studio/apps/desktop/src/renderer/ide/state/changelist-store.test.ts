/**
 * changelist-store.test.ts — per-workspace changelist persistence (APP-038).
 *
 * Proves membership survives a "reload" (save → fresh load round-trip through
 * localStorage), is keyed per workspace root, is fail-soft on malformed data, and
 * that the store actions apply the pure reducers AND persist. A minimal in-memory
 * localStorage stands in for the DOM (node:test has none) and is installed BEFORE
 * the store module loads (its byRoot is read from localStorage at creation).
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const mem = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string): string | null => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      mem.set(k, v);
    },
    removeItem: (k: string): void => {
      mem.delete(k);
    },
    clear: (): void => mem.clear(),
    key: (): string | null => null,
    length: 0,
  },
};

const { loadChangelists, saveChangelists, useChangelistStore } = await import(
  "./changelist-store.js"
);

beforeEach(() => mem.clear());

test("saveChangelists → loadChangelists round-trips membership, keyed per root", () => {
  const lists = [
    { id: "default", name: "Changes", isDefault: true, files: ["a.ts"] },
    { id: "x", name: "Feature", isDefault: false, files: ["b.ts", "c.ts"] },
  ];
  saveChangelists("/repo", lists);
  assert.deepEqual(loadChangelists("/repo"), lists);
  assert.deepEqual(loadChangelists("/other"), []); // a different root is untouched
});

test("membership survives a reload (a fresh load re-reads localStorage)", () => {
  saveChangelists("/repo", [{ id: "y", name: "WIP", isDefault: false, files: ["d.ts"] }]);
  const reloaded = loadChangelists("/repo");
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.name, "WIP");
  assert.deepEqual(reloaded[0]?.files, ["d.ts"]);
});

test("malformed persisted entries are dropped (fail-soft)", () => {
  mem.set(
    "prometheus.changelists",
    JSON.stringify({ "/repo": [{ id: "ok", name: "OK", files: [] }, { junk: true }, null] }),
  );
  const lists = loadChangelists("/repo");
  assert.equal(lists.length, 1);
  assert.equal(lists[0]?.id, "ok");
});

test("store actions apply the reducers AND persist", () => {
  const s = useChangelistStore.getState();
  s.syncFiles("/repo", ["a.ts", "b.ts"]); // both sink to Default
  assert.deepEqual(
    useChangelistStore
      .getState()
      .listsFor("/repo")
      .find((l) => l.isDefault)
      ?.files.sort(),
    ["a.ts", "b.ts"],
  );
  s.addList("/repo", "Feature");
  const featureId = useChangelistStore
    .getState()
    .listsFor("/repo")
    .find((l) => l.name === "Feature")?.id;
  assert.ok(featureId);
  s.move("/repo", featureId, ["a.ts"]);
  const lists = useChangelistStore.getState().listsFor("/repo");
  assert.deepEqual(lists.find((l) => l.id === featureId)?.files, ["a.ts"]);
  assert.deepEqual(lists.find((l) => l.isDefault)?.files, ["b.ts"]); // a.ts left Default
  // the move PERSISTED — a fresh load sees it.
  assert.deepEqual(loadChangelists("/repo").find((l) => l.id === featureId)?.files, ["a.ts"]);
});
