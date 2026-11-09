// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * runtime-steps.test.ts — the app's llama.cpp / LM Studio steps, with fake servers.
 *
 * Nothing is spawned and nothing listens: `startServer` records argv, `listModels` answers from
 * a script. What is pinned is what makes these steps safe: llama-server only ever gets the
 * admitted file and `--offline`, a port held by another model is never fought over, and a
 * hostile id never becomes argv.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ai } from "@prometheus/core";

import {
  RUNTIME_BASE,
  type RuntimeStepDeps,
  hasBinOn,
  linkIntoLmstudio,
  lmStudioKeyFor,
  runtimeInstalled,
  serveAdmittedGguf,
  startLmstudioFor,
} from "./runtime-steps.js";

function fake(answers: Record<string, (string[] | null)[]>) {
  const started: string[][] = [];
  const linked: [string, string][] = [];
  const queues = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]]));
  const deps: RuntimeStepDeps = {
    startServer: (argv) => {
      started.push([...argv]);
      return { ok: true };
    },
    listModels: async (base) => {
      const q = queues[base] ?? [];
      return q.length > 1 ? (q.shift() ?? null) : (q[0] ?? null);
    },
    linkLmstudio: async (id, path) => {
      linked.push([id, path]);
      return { ok: true };
    },
    hasBin: () => true,
    pollMs: 1,
    readyTimeoutMs: 50,
  };
  return { deps, started, linked };
}

test("llama.cpp: the ADMITTED file, offline, bound to loopback, alias = catalogue id", async () => {
  const f = fake({ [RUNTIME_BASE.llamacpp]: [null, null, ["qwen3-8b"]] });
  const r = await serveAdmittedGguf(f.deps, "qwen3-8b", "/lib/huggingface/org__m/m.gguf", 32768);
  assert.deepEqual(r, { ok: true, baseUrl: RUNTIME_BASE.llamacpp, model: "qwen3-8b" });
  const argv = f.started[0] ?? [];
  assert.equal(argv[0], "llama-server");
  assert.equal(argv[argv.indexOf("-m") + 1], "/lib/huggingface/org__m/m.gguf");
  assert.equal(argv[argv.indexOf("--host") + 1], "127.0.0.1");
  assert.ok(argv.includes("--offline"), "llama-server must never fetch weights itself");
  assert.ok(!argv.includes("-hf") && !argv.includes("--hf-repo"));
  assert.equal(argv[argv.indexOf("--alias") + 1], "qwen3-8b");
});

test("llama.cpp: a port already serving ANOTHER model is not fought over", async () => {
  const f = fake({ [RUNTIME_BASE.llamacpp]: [["someone-else"]] });
  const r = await serveAdmittedGguf(f.deps, "qwen3-8b", "/lib/m.gguf", 8192);
  assert.equal(r.ok, false);
  assert.deepEqual(f.started, []);
});

test("llama.cpp: already serving this model → nothing started", async () => {
  const f = fake({ [RUNTIME_BASE.llamacpp]: [["qwen3-8b"]] });
  const r = await serveAdmittedGguf(f.deps, "qwen3-8b", "/lib/m.gguf", 8192);
  assert.equal(r.ok, true);
  assert.deepEqual(f.started, []);
});

test("llama.cpp: a server that never lists the model is a failure, not a success", async () => {
  const f = fake({ [RUNTIME_BASE.llamacpp]: [null] });
  const r = await serveAdmittedGguf(f.deps, "qwen3-8b", "/lib/m.gguf", 8192);
  assert.equal(r.ok, false);
});

test("a hostile id never becomes argv or a link name", async () => {
  for (const id of ["--offline=false", "-m", "a b", "../x", ""]) {
    const f = fake({ [RUNTIME_BASE.llamacpp]: [null] });
    assert.equal((await serveAdmittedGguf(f.deps, id, "/lib/m.gguf", 8192)).ok, false, id);
    assert.equal((await linkIntoLmstudio(f.deps, id, "/lib/m.gguf")).ok, false, id);
    assert.equal((await startLmstudioFor(f.deps, id)).ok, false, id);
    assert.deepEqual(f.started, [], id);
    assert.deepEqual(f.linked, [], id);
  }
});

test("LM Studio: started only when not answering, and the key resolved exactly", async () => {
  const off = fake({ [RUNTIME_BASE.lmstudio]: [null, [], ["prometheus/qwen3-8b"]] });
  const r = await startLmstudioFor(off.deps, "qwen3-8b");
  assert.deepEqual(r, { ok: true, baseUrl: RUNTIME_BASE.lmstudio, model: "prometheus/qwen3-8b" });
  assert.deepEqual(off.started, [["lms", "server", "start", "--port", "1234"]]);
  const on = fake({ [RUNTIME_BASE.lmstudio]: [["prometheus/qwen3-8b"]] });
  assert.equal((await startLmstudioFor(on.deps, "qwen3-8b")).ok, true);
  assert.deepEqual(on.started, []);
  // a prefix of another model's key is not this model
  assert.equal(lmStudioKeyFor(["prometheus/qwen3-8b-instruct"], "qwen3-8b"), undefined);
  assert.equal(lmStudioKeyFor(["prometheus/qwen3-8b/q4"], "qwen3-8b"), "prometheus/qwen3-8b/q4");
  // the files stage-hf placed under the repo's own folder are found by the key `lms ls`
  // reports for THAT path (LM Studio names a sideloaded model by its file, not its folder)
  const listed = [
    { modelKey: "qwen3-8b", path: "Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf" },
    { modelKey: "qwen3-8b-mine", path: "someone/else/qwen3-8b.gguf" },
  ];
  const placed = ai.lmStudioKeysForRepos(listed, ["Qwen/Qwen3-8B-GGUF"]);
  assert.deepEqual(placed, ["qwen3-8b"]);
  assert.equal(lmStudioKeyFor(["qwen3-8b", "qwen3-8b-mine"], "qwen3-8b", placed), "qwen3-8b");
  assert.equal(
    lmStudioKeyFor(["qwen3-8b-mine"], "qwen3-8b", placed),
    undefined,
    "the user's own copy is never adopted",
  );
});

test("runtimeInstalled and hasBinOn read PATH and vendor dirs only", () => {
  assert.deepEqual(
    runtimeInstalled((b) => b === "lms"),
    { llamacpp: false, lmstudio: true },
  );
  assert.equal(
    hasBinOn("definitely-not-a-binary-xyz", "/nonexistent", () => undefined),
    false,
  );
  assert.equal(
    hasBinOn("lms", "", (b) => (b === "lms" ? "/u/.lmstudio/bin/lms" : undefined)),
    true,
  );
});

test("llama.cpp: a busy port (a server still loading) is never given a second llama-server", async () => {
  const f = fake({ [RUNTIME_BASE.llamacpp]: [null] });
  f.deps.portOpen = async () => true;
  const r = await serveAdmittedGguf(f.deps, "qwen3-8b", "/lib/m.gguf", 8192);
  assert.equal(r.ok, false);
  assert.deepEqual(f.started, []);
});

test("llama.cpp: the admission is re-verified right before serving", async () => {
  const f = fake({ [RUNTIME_BASE.llamacpp]: [null, ["qwen3-8b"]] });
  f.deps.verifyAdmitted = async () => ({ ok: false, error: "no valid admission record" });
  const r = await serveAdmittedGguf(f.deps, "qwen3-8b", "/lib/m.gguf", 8192);
  assert.equal(r.ok, false);
  assert.deepEqual(f.started, [], "a file no record vouches for any more is never served");
});
