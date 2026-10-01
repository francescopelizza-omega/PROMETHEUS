/**
 * local-runners.test.ts — the shared local-runner registry (LOCAL_RUNNERS + its lookups).
 *
 * PURE DATA — no fetch, no spawn, so every case here is a plain assertion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_RUNNERS,
  applyHostEnv,
  isLocalUrl,
  localRunners,
  portOf,
  runnerById,
  runnerForBaseUrl,
} from "./local-runners.js";

/* ── LOCAL_RUNNERS itself ────────────────────────────────────────────────── */

test("LOCAL_RUNNERS covers the four local OpenAI-compatible servers, each on a distinct port", () => {
  // Was two (ollama, lmstudio) until 2026-10-01. llama.cpp and vLLM were invisible to EVERY
  // surface — the desktop showed a static five-row table that never matched the machine, and
  // the CLI probed only the two listed here, so a user serving llama.cpp had it detected
  // nowhere. Keep this pinned: a runner added to the registry and to nothing else is the drift
  // this list exists to make loud.
  const ids = LOCAL_RUNNERS.map((r) => r.id).sort();
  assert.deepEqual(ids, ["llamacpp", "lmstudio", "ollama", "vllm"]);
  const ports = new Set(LOCAL_RUNNERS.map((r) => r.port));
  assert.equal(ports.size, LOCAL_RUNNERS.length, "every runner must own a distinct port");
});

test("only the runners that can be started without being told WHICH weights have a start argv", () => {
  // `llama-server` and `vllm` both REQUIRE a model argument. There is no defensible guess —
  // picking a file out of a 90 GB Hugging Face cache would load gigabytes nobody asked for —
  // so they carry no `start`, and `ensureLocalRunnerRunning` reports `not-installed` rather
  // than offering a button that cannot work.
  const withStart = LOCAL_RUNNERS.filter((r) => r.start)
    .map((r) => r.id)
    .sort();
  assert.deepEqual(withStart, ["lmstudio", "ollama"]);
});

test("vLLM carries no unattended install — its wheel depends on the host CUDA/ROCm stack", () => {
  assert.equal(LOCAL_RUNNERS.find((r) => r.id === "vllm")?.install, undefined);
  for (const id of ["ollama", "lmstudio", "llamacpp"]) {
    assert.ok(LOCAL_RUNNERS.find((r) => r.id === id)?.install, `${id} should be installable`);
  }
});

/* ── applyHostEnv / localRunners ─────────────────────────────────────────── */

test("OLLAMA_HOST is honoured in every form the ollama CLI itself accepts", () => {
  const ollama = LOCAL_RUNNERS.find((r) => r.id === "ollama");
  assert.ok(ollama);
  const cases: Array<[string, string, number]> = [
    ["11435", "localhost", 11435],
    [":11435", "localhost", 11435],
    ["gpu-box", "gpu-box", 11434],
    ["gpu-box:11435", "gpu-box", 11435],
    ["http://gpu-box:11435", "gpu-box", 11435],
  ];
  for (const [raw, host, port] of cases) {
    const r = applyHostEnv(ollama, { OLLAMA_HOST: raw });
    assert.equal(r.host, host, raw);
    assert.equal(r.port, port, raw);
    assert.equal(r.baseUrl, `http://${host}:${port}/v1`, raw);
    assert.equal(r.nativeUrl, `http://${host}:${port}`, raw);
  }
});

test("a junk OLLAMA_HOST leaves the spec alone rather than making the runner undiscoverable", () => {
  const ollama = LOCAL_RUNNERS.find((r) => r.id === "ollama");
  assert.ok(ollama);
  for (const raw of ["", "   ", ":", "host:0", "host:99999", "host:notaport!"]) {
    const r = applyHostEnv(ollama, { OLLAMA_HOST: raw });
    assert.equal(r.baseUrl, ollama.baseUrl, `"${raw}" must not move the runner`);
  }
});

test("PROMETHEUS_RUNNER_<ID>_URL overrides any runner, including ones with no vendor env", () => {
  const vllm = localRunners({ PROMETHEUS_RUNNER_VLLM_URL: "http://localhost:8001/v1" }).find(
    (r) => r.id === "vllm",
  );
  assert.equal(vllm?.port, 8001);
  assert.equal(vllm?.baseUrl, "http://localhost:8001/v1");
  // vLLM has no nativeUrl, so none is invented for it.
  assert.equal(vllm?.nativeUrl, undefined);
});

test("the generic override wins over the vendor one — it is the more specific instruction", () => {
  const r = localRunners({
    OLLAMA_HOST: "gpu-box:11434",
    PROMETHEUS_RUNNER_OLLAMA_URL: "http://localhost:11500/v1",
  }).find((x) => x.id === "ollama");
  assert.equal(r?.port, 11500);
  assert.equal(r?.host, "localhost");
});

test("an IPv6 OLLAMA_HOST keeps its brackets in the URL but not in the host field", () => {
  const ollama = LOCAL_RUNNERS.find((r) => r.id === "ollama");
  assert.ok(ollama);
  const r = applyHostEnv(ollama, { OLLAMA_HOST: "http://[::1]:11435" });
  assert.equal(r.host, "::1");
  assert.equal(r.baseUrl, "http://[::1]:11435/v1");
  assert.ok(isLocalUrl(r.baseUrl), "a loopback IPv6 override must still read as local");
});

test("LOCAL_RUNNERS is the DEFAULTS and an override never mutates it", () => {
  const before = LOCAL_RUNNERS.find((r) => r.id === "ollama")?.baseUrl;
  localRunners({ OLLAMA_HOST: "gpu-box:11435" });
  assert.equal(LOCAL_RUNNERS.find((r) => r.id === "ollama")?.baseUrl, before);
});

test("both ollama and lmstudio have a start command — each can be autostarted headlessly", () => {
  const ollama = LOCAL_RUNNERS.find((r) => r.id === "ollama");
  const lmstudio = LOCAL_RUNNERS.find((r) => r.id === "lmstudio");
  assert.deepEqual(ollama?.start, ["ollama", "serve"]);
  assert.deepEqual(lmstudio?.start, ["lms", "server", "start", "--port", "1234"]);
});

test("only lmstudio has a dedicated stop command — its server runs INSIDE the app process, so a raw signal would quit the whole app, not just the server", () => {
  const ollama = LOCAL_RUNNERS.find((r) => r.id === "ollama");
  const lmstudio = LOCAL_RUNNERS.find((r) => r.id === "lmstudio");
  assert.equal(
    ollama?.stop,
    undefined,
    "ollama serve has no stop subcommand — signalling the daemon directly IS correct for it",
  );
  assert.deepEqual(lmstudio?.stop, ["lms", "server", "stop"]);
});

/* ── runnerById ──────────────────────────────────────────────────────────── */

test("runnerById finds a known id", () => {
  assert.equal(runnerById("ollama", {})?.name, "Ollama");
});

test("runnerById returns undefined for an unknown id", () => {
  assert.equal(runnerById("not-a-runner", {}), undefined);
});

test("runnerById applies the host override, because callers probe the URL it returns", () => {
  assert.equal(
    runnerById("ollama", { OLLAMA_HOST: "gpu-box:11435" })?.baseUrl,
    "http://gpu-box:11435/v1",
  );
});

test("runnerForBaseUrl refuses a port whose RESOLVED runner is on another host", () => {
  // The spawn guard, arriving by the other door: with the daemon moved to gpu-box, nothing on
  // this machine listens on 11434, and `ollama serve` here would bind to gpu-box's address
  // anyway. Returning the spec would autostart a server for a request that was always going
  // somewhere else — the same mistake the loopback check already prevents for remote URLs.
  assert.equal(
    runnerForBaseUrl("http://localhost:11434/v1", { OLLAMA_HOST: "gpu-box:11434" }),
    undefined,
  );
  // Moved to another LOCAL port: the old port matches nothing, the new one matches.
  assert.equal(runnerForBaseUrl("http://localhost:11434/v1", { OLLAMA_HOST: ":11435" }), undefined);
  assert.equal(
    runnerForBaseUrl("http://localhost:11435/v1", { OLLAMA_HOST: ":11435" })?.id,
    "ollama",
  );
});

/* ── portOf ──────────────────────────────────────────────────────────────── */

test("portOf reads an explicit port", () => {
  assert.equal(portOf("http://localhost:11434/v1"), 11434);
});

test("portOf defaults by scheme when none is given", () => {
  assert.equal(portOf("http://example.com/v1"), 80);
  assert.equal(portOf("https://example.com/v1"), 443);
});

test("portOf returns undefined for an unparsable URL rather than guessing", () => {
  assert.equal(portOf("not a url"), undefined);
});

/* ── runnerForBaseUrl ────────────────────────────────────────────────────── */

test("runnerForBaseUrl matches by port, ignoring path", () => {
  assert.equal(runnerForBaseUrl("http://localhost:11434/v1", {})?.id, "ollama");
  assert.equal(runnerForBaseUrl("http://localhost:1234/v1", {})?.id, "lmstudio");
});

test("runnerForBaseUrl refuses a REMOTE host on a runner's port — never spawn a local server for it", () => {
  // The whole point: `ensureLocalRunnerRunning` probes and spawns against localhost, so matching
  // on the port alone started `ollama serve` on this laptop for a request bound for another host.
  assert.equal(runnerForBaseUrl("http://gpu-box.lan:11434/v1", {}), undefined);
  assert.equal(runnerForBaseUrl("http://192.168.1.5:11434/v1", {}), undefined);
  // `*.local` mDNS names matter specifically: the desktop's own localityOfUrl calls them "local".
  assert.equal(runnerForBaseUrl("http://gpu-box.local:1234/v1", {}), undefined);
  // loopback in every spelling still matches.
  assert.equal(runnerForBaseUrl("http://127.0.0.1:11434/v1", {})?.id, "ollama");
  assert.equal(runnerForBaseUrl("http://[::1]:1234/v1", {})?.id, "lmstudio");
});

test("runnerForBaseUrl returns undefined for a port no runner owns", () => {
  assert.equal(runnerForBaseUrl("http://localhost:9999/v1", {}), undefined);
});

/* ── isLocalUrl ──────────────────────────────────────────────────────────── */

test("isLocalUrl accepts localhost, 127.0.0.1, ::1 and 0.0.0.0", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]) {
    assert.equal(isLocalUrl(`http://${host}:11434/v1`), true, host);
  }
});

test("isLocalUrl rejects a remote host", () => {
  assert.equal(isLocalUrl("https://api.anthropic.com/v1"), false);
});

test("isLocalUrl returns false for an unparsable URL rather than throwing", () => {
  assert.equal(isLocalUrl("not a url"), false);
});
