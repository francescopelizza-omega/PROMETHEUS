/**
 * models-host.test.ts — the IO behind `/models`, with every seam injected.
 *
 * No keychain, no network, no Ollama: the secrets store, the fetch and the three Ollama calls
 * are fakes. What matters most: a key is VERIFIED before it is stored, a keyless provider sends
 * no credential, and a remembered pick is only restored when it can answer right now.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type AiEndpoint, type FetchLike, ai } from "@prometheus/core";

import { createModelsHost, modelChoicePath, readModelChoice } from "./models-host.js";
import type { Backends } from "./onboarding.js";

function backends(runners: Backends["liveRunners"] = []): Backends {
  return {
    liveRunners: runners,
    paidClis: [],
    startedRunners: new Set(),
    unavailableRunners: [],
  } as unknown as Backends;
}

function make(
  opts: {
    fetch?: FetchLike;
    env?: Record<string, string>;
    runners?: Backends["liveRunners"];
    modelhub?: (args: string[]) => Promise<Record<string, unknown>>;
  } = {},
) {
  const sidecarCalls: string[][] = [];
  const stored = new Map<string, string>();
  const adopted: { ep: AiEndpoint; model: { provider: string; modelId: string } }[] = [];
  const cloudEndpoints: ai.CloudEndpointInfo[] = [];
  const keychain = new Set<string>();
  const home = mkdtempSync(join(tmpdir(), "models-host-"));
  const be = backends(opts.runners);
  const host = createModelsHost({
    home,
    env: opts.env ?? { PATH: "" },
    backends: be,
    cloudEndpoints,
    keychainProviders: keychain,
    adoptEndpoint: async (ep, model) => {
      adopted.push({ ep, model });
    },
    activeId: () => undefined,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    secretsStore: {
      set: async (_s, a, v) => {
        stored.set(a, v);
      },
      get: async (_s, a) => stored.get(a),
      delete: async (_s, a) => {
        stored.delete(a);
      },
    },
    machine: () => ({ ramGb: 36, vramGb: 0, unified: true }),
    ollamaTags: async () => [],
    ensureOllama: async () => ({ started: true }),
    pullTag: async () => ({ ok: true }),
    // never the real engine: a test must not scan (or remove) anything in a real Ollama store
    modelhub: async (args) => {
      sidecarCalls.push(args);
      return opts.modelhub ? opts.modelhub(args) : { ok: true, verdict: "allow" };
    },
    onPath: () => false,
  });
  return { host, stored, adopted, cloudEndpoints, keychain, home, be, sidecarCalls };
}

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  body: null,
  text: async () => JSON.stringify(body),
});

test("connectKey: a refused key is NOT stored (verify before write)", async () => {
  const { host, stored, keychain } = make({ fetch: async () => res(401, { error: "bad" }) });
  const r = await host.connectKey("groq", "gsk_wrong");
  assert.equal(r.ok, false);
  assert.equal(stored.size, 0);
  assert.equal(keychain.has("groq"), false);
});

test("connectKey: a good key is stored, discovery refreshed in place, live list returned", async () => {
  const seen: string[] = [];
  const { host, stored, cloudEndpoints, keychain } = make({
    fetch: async (url, init) => {
      seen.push(`${url} ${init.headers.authorization ?? ""}`);
      return res(200, { data: [{ id: "llama-3.3-70b-versatile" }] });
    },
  });
  const r = await host.connectKey("groq", "  gsk_ok  ");
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.live, ["llama-3.3-70b-versatile"]);
  assert.equal(stored.get("provider:groq"), "gsk_ok", "trimmed");
  assert.ok(keychain.has("groq"));
  assert.ok(
    cloudEndpoints.some((e) => e.providerId === "groq"),
    "the /model list sees it at once",
  );
  assert.equal(seen[0], "https://api.groq.com/openai/v1/models Bearer gsk_ok");
});

test("adopt: a keyless free tier gets an endpoint with NO apiKeyRef", async () => {
  const { host, adopted } = make();
  const r = await host.adopt({ section: "free", providerId: "ovhcloud", model: "gpt-oss-120b" });
  assert.equal(r.ok, true);
  assert.equal(adopted[0]?.ep.apiKeyRef, undefined);
  assert.equal(adopted[0]?.ep.locality, "cloud");
});

test("adopt: an env key is referenced by name, never copied", async () => {
  const { host, adopted } = make({ env: { PATH: "", NVIDIA_API_KEY: "nvapi-secret" } });
  await host.adopt({
    section: "free",
    providerId: "nvidia",
    model: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  });
  assert.equal(adopted[0]?.ep.apiKeyRef, "env:NVIDIA_API_KEY");
  assert.ok(!JSON.stringify(adopted[0]?.ep).includes("nvapi-secret"));
  assert.deepEqual(adopted[0]?.model, {
    provider: "nvidia",
    modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  });
});

test("adopt: a provider with no key is refused, not adopted", async () => {
  const { host, adopted } = make();
  const r = await host.adopt({
    section: "paid",
    providerId: "anthropic",
    model: "claude-sonnet-5-5",
  });
  assert.equal(r.ok, false);
  assert.equal(adopted.length, 0);
});

test("adopt: the rotation endpoint carries its members (keyless tier at least)", async () => {
  const { host, adopted } = make();
  const r = await host.adopt({ section: "rotation" });
  assert.equal(r.ok, true);
  assert.equal(adopted[0]?.ep.id, ai.ROTATION_ENDPOINT_ID);
  assert.ok((adopted[0]?.ep.rotation ?? []).length > 0);
});

test("restore: a local pick only when served NOW; a free pick only with a key", () => {
  const off = make();
  assert.equal(off.host.restore("local:qwen3-8b"), undefined, "nothing serving");
  const on = make({
    runners: [{ name: "ollama", baseUrl: "http://localhost:11434/v1", models: ["qwen3:8b"] }],
  });
  assert.equal(on.host.restore("local:qwen3-8b")?.endpoint.model, "qwen3:8b");
  assert.equal(on.host.restore("free:groq:llama-3.3-70b-versatile"), undefined, "no key");
  assert.equal(
    make({ env: { PATH: "", GROQ_API_KEY: "x" } }).host.restore("free:groq:llama-3.3-70b-versatile")
      ?.endpoint.model,
    "llama-3.3-70b-versatile",
  );
  assert.equal(on.host.restore(undefined), undefined);
  assert.equal(on.host.restore("garbage"), undefined);
});

test("restore: PAID and SPINNER picks never come back on their own — a hint says how", () => {
  const { host } = make({ env: { PATH: "", ANTHROPIC_API_KEY: "x" } });
  assert.equal(
    host.restore("paid:anthropic:claude-sonnet-5-5"),
    undefined,
    "metered: needs a fresh yes",
  );
  assert.equal(host.restore("rotation"), undefined, "several providers: needs a fresh yes");
  assert.match(
    host.restoreHint("paid:anthropic:claude-sonnet-5-5") ?? "",
    /\/models use paid:anthropic:claude-sonnet-5-5/,
  );
  assert.match(host.restoreHint("rotation") ?? "", /several providers/);
  assert.equal(host.restoreHint("local:qwen3-8b"), undefined);
});

test("saveChoice writes a private file readModelChoice reads back", () => {
  const { host, home } = make();
  host.saveChoice("free:groq:llama-3.3-70b-versatile");
  assert.equal(readModelChoice(home), "free:groq:llama-3.3-70b-versatile");
  const json = JSON.parse(readFileSync(modelChoicePath(home), "utf8"));
  assert.equal(json.ref, "free:groq:llama-3.3-70b-versatile");
  if (process.platform !== "win32") assert.equal(statSync(modelChoicePath(home)).mode & 0o077, 0);
});

test("pull: records the tag on the ollama runner so /model lists it without a restart", async () => {
  const { host, be } = make({
    runners: [{ name: "ollama", baseUrl: "http://localhost:11434/v1", models: [] }],
  });
  const r = await host.pull("qwen3:8b", () => {});
  assert.equal(r.ok, true);
  assert.deepEqual(be.liveRunners[0]?.models, ["qwen3:8b"]);
});

test("pull: the downloaded model is scanned by nemesis before it counts as installed", async () => {
  const { host, be, sidecarCalls } = make({
    runners: [{ name: "ollama", baseUrl: "http://localhost:11434/v1", models: [] }],
    modelhub: async () => ({ ok: false, verdict: "block", error: "nemesis BLOCKED x:1 — removed" }),
  });
  const r = await host.pull("x:1", () => {});
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /BLOCKED/);
  assert.deepEqual(sidecarCalls, [["ollama-gate", "--tag=x:1"]]);
  assert.deepEqual(be.liveRunners[0]?.models, []); // a blocked model is never listed
});

test("installOllama goes through the native installer, never the Docker app", async () => {
  const { host, sidecarCalls } = make();
  const r = await host.installOllama();
  assert.equal(r.ok, true);
  assert.deepEqual(sidecarCalls, [["install-runner", "--runner", "ollama"]]);
});

test("fetchGguf/importToOllama: only an ADMITTED download is imported", async () => {
  const { host, sidecarCalls } = make({
    modelhub: async (args) =>
      args[0] === "stage-hf"
        ? { ok: true, admitted: true, weights: ["/lib/m.gguf"] }
        : { ok: true, tag: "prometheus/m:latest" },
  });
  const f = await host.fetchGguf?.("m", "org/m-GGUF", "m.gguf", () => {});
  assert.deepEqual(f, { ok: true, path: "/lib/m.gguf" });
  const i = await host.importToOllama?.("m", "/lib/m.gguf");
  assert.deepEqual(i, { ok: true, tag: "prometheus/m:latest" });
  // `--opt=value`: a value can never be a separate token that doubles as a flag; `--place`:
  // the admitted file ends up in a runtime's own folder (default the Hugging Face cache)
  assert.deepEqual(sidecarCalls[0], [
    "stage-hf",
    "--id=m",
    "--repo=org/m-GGUF",
    "--file=m.gguf",
    "--place=hf",
  ]);
  await host.fetchGguf?.("m", "org/m-GGUF", "m.gguf", () => {}, { place: "lmstudio" });
  assert.ok(sidecarCalls.at(-1)?.includes("--place=lmstudio"));
  const { host: h2 } = make({
    modelhub: async () => ({ ok: false, admitted: false, error: "sha256 mismatch" }),
  });
  const bad = await h2.fetchGguf?.("m", "org/m-GGUF", "m.gguf", () => {});
  assert.deepEqual(bad, { ok: false, reason: "sha256 mismatch" });
});

test("context: Ollama counts as installed only with evidence (runner, tags, or binary)", async () => {
  const { host } = make();
  const ctx = await host.context();
  assert.equal(ctx.ollamaInstalled, false);
  assert.equal(ctx.ollamaServing, false);
  assert.equal(ctx.machine.ramGb, 36);
});

test("serveGguf starts llama-server offline on the admitted file and waits for it to list the model", async () => {
  const started: (readonly string[])[] = [];
  const hub: string[][] = [];
  let polls = 0;
  const home = mkdtempSync(join(tmpdir(), "models-host-"));
  const be = backends();
  const mk = (admitted: boolean) =>
    createModelsHost({
      home,
      env: { PATH: "" },
      backends: be,
      cloudEndpoints: [],
      keychainProviders: new Set(),
      adoptEndpoint: async () => {},
      activeId: () => undefined,
      machine: () => ({ ramGb: 36, vramGb: 0, unified: true }),
      ollamaTags: async () => [],
      onPath: () => false,
      pollMs: 1,
      // the sidecar seam: only `verify-admitted` is expected, and it answers as told
      modelhub: async (args) => {
        hub.push(args);
        return admitted ? { ok: true } : { ok: false, error: "no valid admission record" };
      },
      startServer: (argv) => {
        started.push(argv);
        return { ok: true, pid: 4242 };
      },
      // nothing answers until llama-server was started, then it lists the model
      listLocalModels: async () => (started.length > 0 && ++polls >= 2 ? ["m1"] : null),
    });
  // a file the gate does not vouch for (replaced since it was admitted) is never served
  const refused = await mk(false).serveGguf?.("m1", "/lib/m1.gguf", 8192);
  assert.equal(refused?.ok, false);
  assert.equal(started.length, 0, "nothing started for an unverified file");
  const r = await mk(true).serveGguf?.("m1", "/lib/m1.gguf", 8192);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(hub.at(-1), ["verify-admitted", "--path=/lib/m1.gguf"]);
  const argv = started[0] ?? [];
  assert.equal(argv[0], "llama-server");
  assert.ok(argv.includes("--offline"));
  assert.ok(!argv.includes("-hf"));
  assert.ok(
    !argv.includes("--mmap") && !argv.includes("--mlock"),
    "removed llama.cpp flags never passed",
  );
  assert.equal(argv[argv.indexOf("-m") + 1], "/lib/m1.gguf");
  assert.ok(be.liveRunners.some((x) => x.name === "llamacpp" && x.models.includes("m1")));
});

test("serveGguf in streaming mode keeps the weights pageable: no GPU layers (dense), experts on CPU (MoE)", async () => {
  const started: (readonly string[])[] = [];
  const be = backends();
  let listed = false;
  const host = createModelsHost({
    home: mkdtempSync(join(tmpdir(), "models-host-")),
    env: { PATH: "" },
    backends: be,
    cloudEndpoints: [],
    keychainProviders: new Set(),
    adoptEndpoint: async () => {},
    activeId: () => undefined,
    machine: () => ({ ramGb: 36, vramGb: 0, unified: true }),
    ollamaTags: async () => [],
    onPath: () => false,
    pollMs: 1,
    modelhub: async () => ({ ok: true }),
    startServer: (argv) => {
      started.push(argv);
      listed = true;
      return { ok: true, pid: 1 };
    },
    listLocalModels: async () => (listed ? ["big"] : null),
  });
  await host.serveGguf?.("big", "/lib/big.gguf", 8192, { stream: true });
  assert.deepEqual(started[0]?.slice(started[0].indexOf("-ngl"), started[0].indexOf("-ngl") + 2), [
    "-ngl",
    "0",
  ]);
  listed = false;
  be.liveRunners.splice(0);
  await host.serveGguf?.("big", "/lib/big.gguf", 8192, { stream: true, moe: true });
  assert.ok(started[1]?.includes("--cpu-moe"));
});

test("AirLLM and colibri servers start from the sidecar's argv, with colibri's per-session key", async () => {
  const started: { argv: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
  const hub: string[][] = [];
  const be = backends();
  let up = false;
  const seenKeys: (string | undefined)[] = [];
  const host = createModelsHost({
    home: mkdtempSync(join(tmpdir(), "models-host-")),
    env: { PATH: "" },
    backends: be,
    cloudEndpoints: [],
    keychainProviders: new Set(),
    adoptEndpoint: async () => {},
    activeId: () => undefined,
    machine: () => ({ ramGb: 16, vramGb: 0, unified: true }),
    ollamaTags: async () => [],
    onPath: () => false,
    pollMs: 1,
    modelhub: async (args) => {
      hub.push(args);
      if (args[0] === "colibri-import")
        return { ok: true, model_dir: "/tools/colibri-models/m.colibri" };
      if (args[0] === "runtime-argv")
        return { ok: true, argv: ["/venv/python", "-I", "shim.py"], env: { HF_HUB_OFFLINE: "1" } };
      return { ok: true };
    },
    startServer: (argv, opts) => {
      started.push({ argv, ...(opts?.env ? { env: opts.env } : {}) });
      up = true;
      return { ok: true, pid: 7 };
    },
    listLocalModels: async (_base, key) => {
      seenKeys.push(key);
      return up ? ["m"] : null;
    },
  });
  const air = await host.serveStream?.("m", "/lib/huggingface/m");
  assert.deepEqual(air, { ok: true });
  assert.deepEqual(hub[0], [
    "runtime-argv",
    "--runtime=airllm",
    "--model=/lib/huggingface/m",
    "--id=m",
  ]);
  assert.equal(started[0]?.env?.HF_HUB_OFFLINE, "1");
  up = false;
  const col = await host.serveColibri?.("m", "/lib/huggingface/m/m.gguf", 8192);
  assert.deepEqual(col, { ok: true });
  const key = started[1]?.env?.COLI_API_KEY ?? "";
  assert.ok(key.length >= 32, "colibri always gets a session key");
  assert.ok(!started[1]?.argv.includes(key), "the key is never on argv");
  assert.ok(seenKeys.includes(key), "its model list is read with the key");
  const { COLIBRI_KEY_ENV } = await import("./models-host.js");
  const { isSecretEnvKey } = await import("@prometheus/engine-bridge");
  assert.ok(isSecretEnvKey(COLIBRI_KEY_ENV), "agent-run commands never inherit the colibri key");
  assert.ok(
    be.liveRunners.some((r) => r.name === "airllm") &&
      be.liveRunners.some((r) => r.name === "colibri"),
  );
});

test("lmStudioKeyFor matches exact keys only (no substring claims)", async () => {
  const { lmStudioKeyFor } = await import("./models-host.js");
  assert.equal(
    lmStudioKeyFor(["qwen3-8b-instruct", "prometheus/qwen3-8b"], "qwen3-8b"),
    "prometheus/qwen3-8b",
  );
  assert.equal(lmStudioKeyFor(["qwen3-8b-instruct"], "qwen3-8b"), undefined);
});

test("restore brings back an imported GGUF pick and a llama.cpp pick that are serving", async () => {
  const m = ai.LOCAL_MODELS.find((x) => !x.ollama && x.gguf);
  assert.ok(m);
  const tag = ai.localOllamaTag(m);
  const { host } = make({
    runners: [
      { name: "ollama", baseUrl: "http://localhost:11434/v1", models: [tag] },
      { name: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1", models: [m.id] },
    ],
  });
  assert.equal(host.restore(`local:${m.id}`)?.model.modelId, tag);
  const ll = host.restore(`local:${m.id}@llamacpp`);
  assert.equal(ll?.model.provider, "llamacpp");
  assert.equal(ll?.model.modelId, m.id);
  assert.equal(host.restore(`local:${m.id}@lmstudio`), undefined); // not serving → not restored
});

test("a server that never comes up is stopped; one that exits fails fast; a stranger is never adopted", async () => {
  const home = mkdtempSync(join(tmpdir(), "models-host-"));
  const stopped: number[] = [];
  const mk = (o: {
    list: () => Promise<string[] | null>;
    alive?: (pid: number) => boolean;
    args?: string;
  }) =>
    createModelsHost({
      home,
      env: { PATH: "" },
      backends: backends(),
      cloudEndpoints: [],
      keychainProviders: new Set(),
      adoptEndpoint: async () => {},
      activeId: () => undefined,
      machine: () => ({ ramGb: 36, vramGb: 0, unified: true }),
      ollamaTags: async () => [],
      onPath: () => false,
      pollMs: 1,
      modelhub: async () => ({ ok: true }),
      startServer: () => ({ ok: true, pid: 4242 }),
      listLocalModels: o.list,
      ...(o.alive ? { processAlive: o.alive } : {}),
      stopServer: (pid) => stopped.push(pid),
      listenerArgs: async () => o.args,
    });
  // exited while loading: reported at once (not after 3 minutes) and cleaned up
  const died = await mk({ list: async () => null, alive: () => false }).serveGguf?.(
    "m1",
    "/lib/m1.gguf",
    8192,
  );
  assert.equal(died?.ok, false);
  assert.match(died && !died.ok ? died.reason : "", /exited/);
  assert.deepEqual(stopped, [4242]);
  // something already answers as "m1" on :8080 but runs another file: refused, not adopted
  const stranger = await mk({
    list: async () => ["m1"],
    args: "llama-server -m /tmp/other.gguf",
  }).serveGguf?.("m1", "/lib/m1.gguf", 8192);
  assert.equal(stranger?.ok, false);
  const ours = await mk({
    list: async () => ["m1"],
    args: "llama-server -m /lib/m1.gguf --alias m1",
  }).serveGguf?.("m1", "/lib/m1.gguf", 8192);
  assert.deepEqual(ours, { ok: true });
});
