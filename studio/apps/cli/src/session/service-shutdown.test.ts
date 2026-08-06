import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectLoadedAiModels,
  humanBytes,
  maybeStopServicesOnExit,
  unloadAiModels,
} from "./service-shutdown.js";

/** Build a fetch stub: `/api/ps` returns `psBody`; `/api/generate` records unload calls. */
function fakeFetch(psBody: unknown, opts: { psOk?: boolean; genOk?: boolean } = {}) {
  const unloads: unknown[] = [];
  const fn = (async (url: string, init?: { body?: string }) => {
    if (url.includes("/api/ps")) {
      return {
        ok: opts.psOk ?? true,
        json: async () => psBody,
      } as unknown as Response;
    }
    if (url.includes("/api/generate")) {
      unloads.push(JSON.parse(init?.body ?? "{}"));
      return { ok: opts.genOk ?? true } as unknown as Response;
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fn, unloads };
}

test("humanBytes: GB / MB / empty", () => {
  assert.equal(humanBytes(2_400_000_000), "2.4 GB");
  assert.equal(humanBytes(480_000_000), "480 MB");
  assert.equal(humanBytes(0), "");
  assert.equal(humanBytes(-5), "");
});

test("detectLoadedAiModels: maps /api/ps rows (name + size)", async () => {
  const { fn } = fakeFetch({ models: [{ name: "qwen3.6:latest", size: 5_000_000_000 }] });
  const loaded = await detectLoadedAiModels(fn);
  assert.deepEqual(loaded, [{ name: "qwen3.6:latest", sizeBytes: 5_000_000_000 }]);
});

test("detectLoadedAiModels: unreachable / not-ok ⇒ [] (never throws)", async () => {
  const bad = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(await detectLoadedAiModels(bad), []);
  const { fn } = fakeFetch({}, { psOk: false });
  assert.deepEqual(await detectLoadedAiModels(fn), []);
});

test("unloadAiModels: posts keep_alive:0 per model, counts successes", async () => {
  const { fn, unloads } = fakeFetch({});
  const freed = await unloadAiModels(
    [
      { name: "a", sizeBytes: 1 },
      { name: "b", sizeBytes: 2 },
    ],
    fn,
  );
  assert.equal(freed, 2);
  assert.deepEqual(unloads, [
    { model: "a", keep_alive: 0 },
    { model: "b", keep_alive: 0 },
  ]);
});

test("maybeStopServicesOnExit: nothing loaded ⇒ no prompt", async () => {
  const { fn } = fakeFetch({ models: [] });
  let asked = false;
  await maybeStopServicesOnExit({
    fetchFn: fn,
    confirm: async () => {
      asked = true;
      return true;
    },
    write: () => {},
  });
  assert.equal(asked, false);
});

test("maybeStopServicesOnExit: loaded + YES ⇒ unloads + reports", async () => {
  const { fn, unloads } = fakeFetch({ models: [{ name: "qwen3.6:latest", size: 5_000_000_000 }] });
  let promptText = "";
  let note = "";
  await maybeStopServicesOnExit({
    fetchFn: fn,
    confirm: async (p) => {
      promptText = p;
      return true;
    },
    write: (t) => {
      note = t;
    },
  });
  assert.match(promptText, /Free memory on exit/);
  assert.match(promptText, /qwen3\.6:latest/);
  assert.match(promptText, /5\.0 GB/);
  assert.deepEqual(unloads, [{ model: "qwen3.6:latest", keep_alive: 0 }]);
  assert.match(note, /freed 1 model/);
});

test("maybeStopServicesOnExit: loaded + NO ⇒ leaves it loaded", async () => {
  const { fn, unloads } = fakeFetch({ models: [{ name: "m", size: 1 }] });
  await maybeStopServicesOnExit({ fetchFn: fn, confirm: async () => false, write: () => {} });
  assert.equal(unloads.length, 0);
});
