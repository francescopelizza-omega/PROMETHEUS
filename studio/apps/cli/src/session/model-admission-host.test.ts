/**
 * model-admission-host.test.ts — the gate in front of the warm-up.
 *
 * The behaviours that matter are the edges, not the happy path: a cloud endpoint must be
 * untouched, an unmeasurable host must not be mistaken for a full one, and a remote endpoint
 * must be judged by the remote host's memory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AiEndpoint } from "@prometheus/core";

import {
  LOCAL_INVENTORY_TIMEOUT_MS,
  LOCAL_PROBE_TIMEOUT_MS,
  REMOTE_INVENTORY_TIMEOUT_MS,
  REMOTE_PROBE_TIMEOUT_MS,
  admitEndpoint,
  runnerIdFor,
  servingHost,
} from "./model-admission-host.js";

const GIB = 1024 ** 3;

const endpoint = (over: Partial<AiEndpoint> = {}): AiEndpoint =>
  ({
    id: "local:qwen",
    model: "qwen3.6:latest",
    baseUrl: "http://127.0.0.1:11434/v1",
    locality: "local",
    contextWindow: 262144,
    ...over,
  }) as AiEndpoint;

const mem = (availGiB: number, host?: string) => async () => ({
  totalBytes: 64 * GIB,
  availableBytes: availGiB * GIB,
  headroomBytes: 6 * GIB,
  pressureLevel: 1,
  source: "kernel" as const,
  ...(host ? { host } : {}),
});

const candidates = [
  {
    id: "qwen3.6:latest",
    weightsBytes: 23.94e9,
    contextTokens: 262144,
    geometry: null,
    runner: "ollama",
  },
  {
    id: "gemma4:12b",
    weightsBytes: 7.56e9,
    contextTokens: 262144,
    geometry: null,
    runner: "ollama",
  },
];

test("a CLOUD endpoint is never weighed against local RAM", async () => {
  let probed = false;
  const out = await admitEndpoint(
    endpoint({ locality: "cloud", baseUrl: "https://api.x.com" }),
    200_000,
    {
      memory: async () => {
        probed = true;
        return mem(1)();
      },
    },
  );
  assert.equal(out.allow, true);
  assert.deepEqual(out.lines, []);
  assert.equal(probed, false, "a cloud endpoint must not even ask about memory");
});

test("a model that fits passes SILENTLY — no noise on the common path", async () => {
  const out = await admitEndpoint(endpoint(), 262144, {
    memory: mem(55),
    census: async () => [],
    inventory: async () => candidates,
  });
  assert.equal(out.allow, true);
  assert.deepEqual(out.lines, []);
});

test("a model that does not fit is REFUSED, with the shortfall and what does fit", async () => {
  // 24 GiB free less 6 GiB headroom ⇒ gemma fits, qwen does not.
  const out = await admitEndpoint(endpoint(), 262144, {
    memory: mem(24),
    census: async () => [],
    inventory: async () => candidates,
  });
  assert.equal(out.allow, false);
  const text = out.lines.join("\n");
  assert.match(text, /qwen3\.6:latest needs about/);
  assert.match(text, /more than is free/);
  assert.match(text, /gemma4:12b/, "the affordable alternative is named");
});

test("a second runner is refused even when the model itself fits", async () => {
  const out = await admitEndpoint(
    endpoint({ baseUrl: "http://127.0.0.1:1234/v1", model: "gemma4:12b" }),
    262144,
    {
      memory: mem(55),
      census: async () => [
        {
          runner: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          up: true,
          models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }],
        },
      ],
      inventory: async () => [{ ...candidates[1]!, runner: "lmstudio" }],
    },
  );
  assert.equal(out.allow, false);
  assert.match(out.lines.join("\n"), /already serving a model/);
});

test("a switch that evicts says so rather than leaving the user to infer it from a pause", async () => {
  const out = await admitEndpoint(endpoint({ model: "gemma4:12b" }), 262144, {
    memory: mem(20),
    census: async () => [
      {
        runner: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        up: true,
        models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }],
      },
    ],
    inventory: async () => candidates,
  });
  assert.equal(out.allow, true);
  assert.match(out.lines.join("\n"), /unloading qwen3\.6:latest to make room/);
});

test("a probe that FAILS allows the load — an unmeasurable host is not a full one", async () => {
  const out = await admitEndpoint(endpoint(), 262144, {
    memory: async () => {
      throw new Error("sysctl unavailable");
    },
  });
  assert.equal(out.allow, true, "failing to measure must never look like out-of-memory");
  assert.deepEqual(out.lines, []);
});

test("a model that is not installed here is not refused — there is nothing to weigh", async () => {
  const out = await admitEndpoint(endpoint({ model: "not-installed" }), 262144, {
    memory: mem(2),
    census: async () => [],
    inventory: async () => candidates,
  });
  assert.equal(out.allow, true);
});

test("REMOTE: the refusal names the remote host, and uses ITS memory", async () => {
  let askedHost: string | undefined = "never-set";
  const out = await admitEndpoint(
    endpoint({ baseUrl: "http://gpu-box.lan:11434/v1", id: "remote:qwen" }),
    262144,
    {
      memory: async (h) => {
        askedHost = h;
        // the remote box is small; the LOCAL machine has plenty
        return {
          totalBytes: 16 * GIB,
          availableBytes: 14 * GIB,
          headroomBytes: 4 * GIB,
          source: "kernel" as const,
        };
      },
      census: async () => [],
      inventory: async () => candidates,
    },
  );
  assert.equal(askedHost, "gpu-box.lan", "the memory question is asked of the SERVING host");
  assert.equal(out.allow, false);
  assert.match(out.lines.join("\n"), /on gpu-box\.lan/);
});

test("loopback spellings all mean 'this machine'; anything else is a named host", () => {
  for (const u of ["http://127.0.0.1:11434", "http://localhost:11434/v1", "http://[::1]:11434"]) {
    assert.equal(servingHost(u), undefined, u);
  }
  assert.equal(servingHost("http://gpu-box.lan:11434"), "gpu-box.lan");
  assert.equal(servingHost("http://192.168.1.50:11434"), "192.168.1.50");
  assert.equal(servingHost("not a url"), undefined);
});

test("the runner is identified from the port", () => {
  assert.equal(runnerIdFor("http://127.0.0.1:1234/v1"), "lmstudio");
  assert.equal(runnerIdFor("http://127.0.0.1:11434/v1"), "ollama");
  assert.equal(runnerIdFor("http://gpu-box.lan:11434"), "ollama");
});

test("a remote probe gets a far larger budget than a loopback one", () => {
  /*
   * Every probe budget in this repo was calibrated against loopback, where a round trip is
   * sub-millisecond — 900 ms in `ollama-autostart`, 1500 in `model-server`, 2000 in
   * `runner-census`. Those are fine for a socket on this machine and wrong for one across a
   * LAN, and badly wrong through an ssh tunnel.
   *
   * The reason this needs a test rather than a comment: a timed-out census does NOT fail
   * loudly. `runnerCensus` is fail-soft by design, so a probe that ran out of time reports
   * "nothing is loaded there" — a confident, wrong answer that then feeds the admission
   * decision and the one-server rule. Silent wrongness is the failure mode to guard.
   */
  assert.ok(
    REMOTE_PROBE_TIMEOUT_MS >= 4 * LOCAL_PROBE_TIMEOUT_MS,
    `remote census budget ${REMOTE_PROBE_TIMEOUT_MS}ms is not meaningfully above local ${LOCAL_PROBE_TIMEOUT_MS}ms`,
  );
  assert.ok(
    REMOTE_INVENTORY_TIMEOUT_MS >= 4 * 1000,
    "an inventory over a tunnel fetches /api/show per model and needs room for it",
  );
  assert.ok(REMOTE_INVENTORY_TIMEOUT_MS > LOCAL_INVENTORY_TIMEOUT_MS);
});
