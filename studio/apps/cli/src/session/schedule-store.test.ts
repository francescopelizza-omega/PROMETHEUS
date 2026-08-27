import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";

import type { agent } from "@prometheus/core";

import type { ScheduleFs } from "./schedule-store.js";
import { loadSchedules, removeScheduledTask, saveSchedules, upsertTask } from "./schedule-store.js";

/** An in-memory fake fs: a map of path → file content, and a set of dirs (existsSync). */
function fakeFs(files: Record<string, string> = {}, dirs: Set<string> = new Set()): ScheduleFs {
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

function task(overrides: Partial<agent.ScheduledTask> = {}): agent.ScheduledTask {
  return {
    id: "nightly-summary",
    name: "Nightly commit summary",
    cronExpr: "0 6 * * *",
    task: "summarize today's commits",
    autonomy: "readonly",
    enabled: true,
    createdIso: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

/* ── load / save / upsert / remove ────────────────────────────────────────────── */

test("loadSchedules: a missing store file yields an empty store (fail-soft, no throw)", () => {
  const fs = fakeFs();
  assert.deepEqual(loadSchedules("/home/.prometheus", fs), {});
});

test("loadSchedules: a corrupt/malformed JSON file also degrades to an empty store", () => {
  const home = "/home/.prometheus";
  const files: Record<string, string> = {
    [`${home}/state/schedules.json`]: "{ not json at all",
  };
  const fs = fakeFs(files);
  assert.deepEqual(loadSchedules(home, fs), {});
});

test("loadSchedules: a JSON file holding a non-object (e.g. an array) also degrades to an empty store", () => {
  const home = "/home/.prometheus";
  const files: Record<string, string> = {
    [`${home}/state/schedules.json`]: "[1,2,3]",
  };
  const fs = fakeFs(files);
  assert.deepEqual(loadSchedules(home, fs), {});
});

test("saveSchedules then loadSchedules round-trips", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const store = { "nightly-summary": task() };
  saveSchedules(store, home, fs);
  assert.deepEqual(loadSchedules(home, fs), store);
});

test("saveSchedules creates the state directory", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  saveSchedules({}, home, fs);
  const file = `${home}/state/schedules.json`;
  assert.ok(fs.existsSync(dirname(file)));
});

test("saveSchedules never throws even when the fs is broken", () => {
  const brokenFs: ScheduleFs = {
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
  assert.doesNotThrow(() => saveSchedules({}, "/home", brokenFs));
});

test("loadSchedules never throws even when the fs is broken", () => {
  const brokenFs: ScheduleFs = {
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
  assert.doesNotThrow(() => loadSchedules("/home", brokenFs));
});

test("upsertTask persists a round-trippable store", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const t = task();
  const after = upsertTask(t, home, fs);
  assert.deepEqual(after, { "nightly-summary": t });
  assert.deepEqual(loadSchedules(home, fs), after);
});

test("upsertTask merges a second task with a DIFFERENT id without dropping the first", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const first = task({ id: "nightly-summary", name: "Nightly commit summary" });
  const second = task({
    id: "issue-triage",
    name: "Triage new issues",
    cronExpr: "*/30 * * * *",
    task: "triage new issues",
    autonomy: "edits",
  });
  upsertTask(first, home, fs);
  const after = upsertTask(second, home, fs);
  assert.deepEqual(after, {
    "nightly-summary": first,
    "issue-triage": second,
  });
  assert.deepEqual(loadSchedules(home, fs), after);
});

test("upsertTask overwrites a previous task for the SAME id", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const first = task({ enabled: true, lastRunIso: undefined });
  const updated = task({ enabled: false, lastRunIso: "2026-08-18T06:00:00.000Z" });
  upsertTask(first, home, fs);
  const after = upsertTask(updated, home, fs);
  assert.deepEqual(after, { "nightly-summary": updated });
  assert.deepEqual(loadSchedules(home, fs), after);
});

test("removeScheduledTask removes the right task while leaving others intact", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const first = task({ id: "nightly-summary" });
  const second = task({ id: "issue-triage", name: "Triage new issues" });
  upsertTask(first, home, fs);
  upsertTask(second, home, fs);
  const after = removeScheduledTask("nightly-summary", home, fs);
  assert.deepEqual(after, { "issue-triage": second });
  assert.deepEqual(loadSchedules(home, fs), after);
});

test("removeScheduledTask is a no-op when the id is already absent", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const only = task();
  upsertTask(only, home, fs);
  const after = removeScheduledTask("does-not-exist", home, fs);
  assert.deepEqual(after, { "nightly-summary": only });
});
