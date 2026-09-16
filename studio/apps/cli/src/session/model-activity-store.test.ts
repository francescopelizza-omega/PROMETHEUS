import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";

import type { ModelActivityFs } from "./model-activity-store.js";
import { modelActivityPath, readModelActivity, touchModelActivity } from "./model-activity-store.js";

/** An in-memory fake fs: a map of path → file content, and a set of dirs (existsSync). */
function fakeFs(files: Record<string, string> = {}, dirs: Set<string> = new Set()): ModelActivityFs {
  return {
    existsSync: (p) => dirs.has(p) || p in files,
    readFileSync: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p, data) => {
      files[p] = data;
    },
    mkdirSync: (p) => {
      dirs.add(p);
    },
  };
}

test("modelActivityPath: lives at <home>/state/model-activity.json — the exact path every surface shares", () => {
  assert.equal(
    modelActivityPath("/home/.prometheus"),
    "/home/.prometheus/state/model-activity.json",
  );
});

test("readModelActivity: a missing store file yields lastActiveAt:0 (fail-soft, no throw)", () => {
  const fs = fakeFs();
  assert.deepEqual(readModelActivity("/home/.prometheus", fs), { lastActiveAt: 0 });
});

test("readModelActivity: a corrupt/malformed JSON file also degrades to lastActiveAt:0", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs({ [`${home}/state/model-activity.json`]: "{ not json at all" });
  assert.deepEqual(readModelActivity(home, fs), { lastActiveAt: 0 });
});

test("readModelActivity: a non-numeric lastActiveAt also degrades to 0 rather than NaN/undefined leaking out", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs({ [`${home}/state/model-activity.json`]: JSON.stringify({ lastActiveAt: "soon" }) });
  assert.deepEqual(readModelActivity(home, fs), { lastActiveAt: 0 });
});

test("touchModelActivity then readModelActivity round-trips the timestamp", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  touchModelActivity(home, fs, () => 1_700_000_000_000);
  assert.deepEqual(readModelActivity(home, fs), { lastActiveAt: 1_700_000_000_000 });
});

test("touchModelActivity creates the state directory", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  touchModelActivity(home, fs, () => 1);
  assert.ok(fs.existsSync(dirname(modelActivityPath(home))));
});

test("touchModelActivity overwrites a prior timestamp with the newer one", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  touchModelActivity(home, fs, () => 1);
  touchModelActivity(home, fs, () => 2);
  assert.deepEqual(readModelActivity(home, fs), { lastActiveAt: 2 });
});

test("touchModelActivity never throws even when the fs is broken (a missed tick is the safe failure)", () => {
  const brokenFs: ModelActivityFs = {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error("nope");
    },
    writeFileSync: () => {
      throw new Error("disk full");
    },
    mkdirSync: () => {
      throw new Error("EACCES");
    },
  };
  assert.doesNotThrow(() => touchModelActivity("/home", brokenFs));
});

test("readModelActivity never throws even when the fs is broken", () => {
  const brokenFs: ModelActivityFs = {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error("nope");
    },
    writeFileSync: () => {
      throw new Error("disk full");
    },
    mkdirSync: () => {
      throw new Error("EACCES");
    },
  };
  assert.doesNotThrow(() => readModelActivity("/home", brokenFs));
});
