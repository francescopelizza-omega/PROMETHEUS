/**
 * endpoint-hook.test.ts — node:test for `ensureLocalServerStarted` (the "auto-start the
 * local model server when the chat has no endpoint" behavior, added for the 07:15
 * complaint: "it must start automatically when prompting on AI chat").
 *
 * Everything external is INJECTED (`svc`, `sleepFn`, `resolveEndpoint`) — this file stays
 * react-free/electron-free/window-free, matching endpoint-hook.ts's own C5 discipline and
 * serve-supervisor.test.ts's one-seam-at-the-boundary style. No real timers, no real IPC.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test endpoint-hook.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type ModelsService, ensureLocalServerStarted } from "./endpoint-hook.js";

/** A stopped, previously-served profile — the ONE shape `ensureLocalServerStarted` may
 *  auto-restart (never a fresh/never-served model). */
const STOPPED_PROFILE = {
  id: "qwen3-8b-q4-k-m-llamacpp",
  modelId: "qwen3-8b",
  quant: "Q4_K_M",
  runner: "llamacpp",
  endpoint: { host: "127.0.0.1", port: 8080, baseUrl: "http://127.0.0.1:8080/v1" },
  apiKey: "local",
  args: { ctxLen: 32768, servedModelName: "qwen3-8b" },
  status: "stopped",
};

/** A fake ModelsService: `serving()` reports whatever `profileStatus` currently is,
 *  `serve()` records the call, `endpoints()` is unused directly (resolveEndpoint is
 *  injected separately in these tests), `library()` defaults to "found nothing" — the
 *  raw-Ollama fallback's own tests override it explicitly. */
function fakeSvc(opts: {
  profiles?: unknown[];
  /** status `serving()` reports AFTER `serve()` has been called once. */
  afterServeStatus?: string;
  /** the `library()` result — defaults to "ok, but nothing ollama-sourced". */
  libraryModels?: { source?: string }[];
  libraryOk?: boolean;
}): { svc: ModelsService; serveCalls: unknown[] } {
  const profiles = opts.profiles ?? [STOPPED_PROFILE];
  const serveCalls: unknown[] = [];
  let served = false;
  const svc = {
    serving: async () => ({
      ok: true,
      profiles: profiles.map((p) => {
        const row = p as { id: string; status: string };
        if (served && row.id === STOPPED_PROFILE.id && opts.afterServeStatus) {
          return { ...row, status: opts.afterServeStatus };
        }
        return row;
      }),
    }),
    serve: async (req: unknown) => {
      serveCalls.push(req);
      served = true;
      return { ok: true, profiles: [] };
    },
    endpoints: async () => ({ ok: true, local: [], openApi: [] }),
    library: async () => ({ ok: opts.libraryOk ?? true, models: opts.libraryModels ?? [] }),
  } as unknown as ModelsService;
  return { svc, serveCalls };
}

const NO_SLEEP = async (): Promise<void> => {};

test("no serving profiles AND no ollama-sourced library models ⇒ false, never calls serve() (genuinely nothing to auto-start)", async () => {
  const { svc, serveCalls } = fakeSvc({ profiles: [], libraryModels: [{ source: "huggingface" }] });
  const picks: (string | null)[] = [];
  const ok = await ensureLocalServerStarted((id) => picks.push(id), {
    svc,
    sleepFn: NO_SLEEP,
  });
  assert.equal(ok, false);
  assert.equal(serveCalls.length, 0);
  assert.deepEqual(picks, []);
});

test("a profile that is already ready/starting ⇒ false, never restarted (only STOPPED is a candidate)", async () => {
  const { svc, serveCalls } = fakeSvc({ profiles: [{ ...STOPPED_PROFILE, status: "ready" }] });
  const ok = await ensureLocalServerStarted(() => {}, { svc, sleepFn: NO_SLEEP });
  assert.equal(
    ok,
    false,
    "an already-ready profile means `active` should already be set — not this function's job",
  );
  assert.equal(serveCalls.length, 0);
});

test("an external (open-weight API) row is never auto-started, even if reported stopped", async () => {
  const { svc, serveCalls } = fakeSvc({
    profiles: [{ ...STOPPED_PROFILE, external: true }],
  });
  const ok = await ensureLocalServerStarted(() => {}, { svc, sleepFn: NO_SLEEP });
  assert.equal(ok, false);
  assert.equal(serveCalls.length, 0);
});

test("happy path: stopped → serve() called with the KNOWN model → polls → ready → resolves → selectEndpoint", async () => {
  const { svc, serveCalls } = fakeSvc({ afterServeStatus: "ready" });
  const picks: (string | null)[] = [];
  const ok = await ensureLocalServerStarted((id) => picks.push(id), {
    svc,
    sleepFn: NO_SLEEP,
    pollIntervalMs: 1,
    resolveEndpoint: async (_svc, baseUrl) => {
      assert.equal(
        baseUrl,
        STOPPED_PROFILE.endpoint.baseUrl,
        "must resolve the SAME baseUrl it started",
      );
      return { id: "ollama · qwen3-8b", baseUrl, locality: "local", model: "qwen3-8b" };
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(serveCalls, [{ id: STOPPED_PROFILE.modelId, quant: STOPPED_PROFILE.quant }]);
  assert.deepEqual(picks, ["ollama · qwen3-8b"]);
});

test("raw-Ollama fallback: no known ServeProfile, but library() finds an ollama-sourced model ⇒ resolves the shared ollama endpoint and selects it", async () => {
  // The exact scenario this whole fallback exists for: gemma/qwen pulled straight via
  // `ollama pull`, never through Prometheus's own Serve button — no ServeProfile, but
  // genuinely installed and (once the sidecar's model.list wakes the daemon) servable.
  const { svc } = fakeSvc({
    profiles: [],
    libraryModels: [{ source: "ollama" }, { source: "ollama" }],
  });
  const picks: (string | null)[] = [];
  const seenBaseUrls: string[] = [];
  const ok = await ensureLocalServerStarted((id) => picks.push(id), {
    svc,
    sleepFn: NO_SLEEP,
    resolveEndpoint: async (_svc, baseUrl) => {
      seenBaseUrls.push(baseUrl);
      return { id: "ollama · gemma4:12b", baseUrl, locality: "local", model: "gemma4:12b" };
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(seenBaseUrls, ["http://localhost:11434/v1"]);
  assert.deepEqual(picks, ["ollama · gemma4:12b"]);
});

test("raw-Ollama fallback: library() call itself throws ⇒ false, never selects", async () => {
  const svc = {
    serving: async () => ({ ok: true, profiles: [] }),
    library: async () => {
      throw new Error("sidecar unreachable");
    },
  } as unknown as ModelsService;
  const picks: (string | null)[] = [];
  const ok = await ensureLocalServerStarted((id) => picks.push(id), { svc, sleepFn: NO_SLEEP });
  assert.equal(ok, false);
  assert.deepEqual(picks, []);
});

test("raw-Ollama fallback: library() reports ok:false ⇒ false, never resolves an endpoint", async () => {
  const { svc } = fakeSvc({
    profiles: [],
    libraryOk: false,
    libraryModels: [{ source: "ollama" }],
  });
  let resolveEndpointCalled = false;
  const ok = await ensureLocalServerStarted(() => {}, {
    svc,
    sleepFn: NO_SLEEP,
    resolveEndpoint: async () => {
      resolveEndpointCalled = true;
      return null;
    },
  });
  assert.equal(ok, false);
  assert.equal(
    resolveEndpointCalled,
    false,
    "an ok:false library result must short-circuit before probing",
  );
});

test("raw-Ollama fallback: models exist but resolveEndpoint can't confirm it's live ⇒ false", async () => {
  const { svc } = fakeSvc({ profiles: [], libraryModels: [{ source: "ollama" }] });
  const ok = await ensureLocalServerStarted(() => {}, {
    svc,
    sleepFn: NO_SLEEP,
    resolveEndpoint: async () => null,
  });
  assert.equal(ok, false);
});

test("a known stopped ServeProfile takes priority over the raw-Ollama fallback (library() never consulted)", async () => {
  let libraryCalled = false;
  const svc = {
    serving: async () => ({ ok: true, profiles: [STOPPED_PROFILE] }),
    serve: async () => ({ ok: true, profiles: [] }),
    endpoints: async () => ({ ok: true, local: [], openApi: [] }),
    library: async () => {
      libraryCalled = true;
      return { ok: true, models: [] };
    },
  } as unknown as ModelsService;
  // serve() succeeds but the poll never sees "ready" (afterServeStatus unset) — this test
  // only cares that the fallback is never reached, not the outcome of the primary path.
  await ensureLocalServerStarted(() => {}, {
    svc,
    sleepFn: NO_SLEEP,
    pollIntervalMs: 1,
    pollDeadlineMs: 1,
  });
  assert.equal(
    libraryCalled,
    false,
    "a known candidate must short-circuit before the fallback runs",
  );
});

test("serve() throwing ⇒ false, never polls or selects", async () => {
  const svc = {
    serving: async () => ({ ok: true, profiles: [STOPPED_PROFILE] }),
    serve: async () => {
      throw new Error("spawn failed");
    },
    endpoints: async () => ({ ok: true, local: [], openApi: [] }),
  } as unknown as ModelsService;
  const picks: (string | null)[] = [];
  const ok = await ensureLocalServerStarted((id) => picks.push(id), { svc, sleepFn: NO_SLEEP });
  assert.equal(ok, false);
  assert.deepEqual(picks, []);
});

test("the runner reporting error mid-poll ⇒ false immediately, no further polling", async () => {
  const { svc } = fakeSvc({ afterServeStatus: "error" });
  const ok = await ensureLocalServerStarted(() => {}, {
    svc,
    sleepFn: NO_SLEEP,
    pollIntervalMs: 1,
  });
  assert.equal(ok, false);
});

test("the runner NEVER reaching ready before the deadline ⇒ false (times out, not an infinite loop)", async () => {
  const { svc } = fakeSvc({ afterServeStatus: "starting" });
  let ticks = 0;
  const ok = await ensureLocalServerStarted(() => {}, {
    svc,
    // a REAL (but tiny) timer per tick — avoids an all-synchronous busy-loop racing
    // Date.now()'s deadline check, which would make the iteration count nondeterministic.
    sleepFn: (ms) =>
      new Promise((resolve) => {
        ticks += 1;
        setTimeout(resolve, ms);
      }),
    pollIntervalMs: 1,
    pollDeadlineMs: 5,
  });
  assert.equal(ok, false);
  assert.ok(ticks >= 1, "must have polled at least once before giving up");
});

test("ready, but resolveEndpoint finds nothing live at that baseUrl ⇒ false (probe disagrees with the status row)", async () => {
  const { svc } = fakeSvc({ afterServeStatus: "ready" });
  const ok = await ensureLocalServerStarted(() => {}, {
    svc,
    sleepFn: NO_SLEEP,
    pollIntervalMs: 1,
    resolveEndpoint: async () => null,
  });
  assert.equal(ok, false);
});
