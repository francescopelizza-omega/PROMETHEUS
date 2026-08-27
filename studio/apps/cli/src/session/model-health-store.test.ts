import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";

import type { EndpointHealthRecord } from "@prometheus/core";

import type { ModelHealthFs } from "./model-health-store.js";
import { loadModelHealth, recordEndpointHealth, saveModelHealth } from "./model-health-store.js";

/** An in-memory fake fs: a map of path → file content, and a set of dirs (existsSync). */
function fakeFs(files: Record<string, string> = {}, dirs: Set<string> = new Set()): ModelHealthFs {
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

function record(overrides: Partial<EndpointHealthRecord> = {}): EndpointHealthRecord {
  return {
    endpointId: "local-ollama",
    model: "llama3",
    locality: "local",
    transport: "native",
    demonstrated: true,
    nativeCalls: 3,
    textCallsWhileNative: 0,
    textSyntaxCalls: 0,
    nativeRejected: false,
    breakerState: "closed",
    breakerFailures: 0,
    breakerOpenedAt: null,
    contextWindow: 8192,
    contextWindowSource: "ollama",
    lastUsedIso: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

/* ── load / save / record ─────────────────────────────────────────────────────── */

test("loadModelHealth: a missing store file yields an empty store (fail-soft, no throw)", () => {
  const fs = fakeFs();
  assert.deepEqual(loadModelHealth("/home/.prometheus", fs), {});
});

test("loadModelHealth: a corrupt/malformed JSON file also degrades to an empty store", () => {
  const home = "/home/.prometheus";
  const files: Record<string, string> = {
    [`${home}/state/model-health.json`]: "{ not json at all",
  };
  const fs = fakeFs(files);
  assert.deepEqual(loadModelHealth(home, fs), {});
});

test("loadModelHealth: a JSON file holding a non-object (e.g. an array) also degrades to an empty store", () => {
  const home = "/home/.prometheus";
  const files: Record<string, string> = {
    [`${home}/state/model-health.json`]: "[1,2,3]",
  };
  const fs = fakeFs(files);
  assert.deepEqual(loadModelHealth(home, fs), {});
});

test("saveModelHealth then loadModelHealth round-trips", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const store = { "local-ollama": record() };
  saveModelHealth(store, home, fs);
  assert.deepEqual(loadModelHealth(home, fs), store);
});

test("saveModelHealth creates the state directory", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  saveModelHealth({}, home, fs);
  const file = `${home}/state/model-health.json`;
  assert.ok(fs.existsSync(dirname(file)));
});

test("saveModelHealth never throws even when the fs is broken", () => {
  const brokenFs: ModelHealthFs = {
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
  assert.doesNotThrow(() => saveModelHealth({}, "/home", brokenFs));
});

test("loadModelHealth never throws even when the fs is broken", () => {
  const brokenFs: ModelHealthFs = {
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
  assert.doesNotThrow(() => loadModelHealth("/home", brokenFs));
});

test("recordEndpointHealth persists a round-trippable store", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const r = record();
  const after = recordEndpointHealth(r, home, fs);
  assert.deepEqual(after, { "local-ollama": r });
  assert.deepEqual(loadModelHealth(home, fs), after);
});

test("recordEndpointHealth merges a second call for a DIFFERENT endpoint id without dropping the first", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const first = record({ endpointId: "local-ollama", model: "llama3" });
  const second = record({
    endpointId: "cloud-anthropic",
    model: "claude",
    locality: "cloud",
    contextWindowSource: "declared",
  });
  recordEndpointHealth(first, home, fs);
  const after = recordEndpointHealth(second, home, fs);
  assert.deepEqual(after, {
    "local-ollama": first,
    "cloud-anthropic": second,
  });
  assert.deepEqual(loadModelHealth(home, fs), after);
});

test("recordEndpointHealth overwrites a previous record for the SAME endpoint id", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const first = record({ nativeCalls: 1, lastUsedIso: "2026-08-18T00:00:00.000Z" });
  const updated = record({ nativeCalls: 5, lastUsedIso: "2026-08-18T01:00:00.000Z" });
  recordEndpointHealth(first, home, fs);
  const after = recordEndpointHealth(updated, home, fs);
  assert.deepEqual(after, { "local-ollama": updated });
});
