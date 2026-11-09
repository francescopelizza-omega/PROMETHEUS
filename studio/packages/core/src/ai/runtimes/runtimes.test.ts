// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENTS,
  RUNTIMES,
  acquireFor,
  agentContextWarning,
  agentWiring,
  chooseRuntime,
  installArgv,
  installChoices,
  platformOf,
  runtimeById,
} from "./index.js";

const QWEN = {
  id: "qwen3-8b",
  repo: "Qwen/Qwen3-8B",
  ollama: "qwen3:8b",
  gguf: { repo: "Qwen/Qwen3-8B-GGUF", file: "Qwen3-8B-Q4_K_M.gguf", bytes: 5_027_783_488 },
  mlx: "mlx-community/Qwen3-8B-4bit",
  q4Gb: 4.7,
};
const GGUF_ONLY = {
  id: "x",
  repo: "org/x",
  gguf: { repo: "org/x-GGUF", file: "x-Q4_K_M.gguf" },
  q4Gb: 3,
};

test("registry: ids unique; every manage runtime has a platform, a port and a fingerprint", () => {
  const ids = RUNTIMES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of RUNTIMES) {
    assert.ok(r.platforms.length > 0, r.id);
    assert.ok(r.serve.port > 0 && r.detect.fingerprintPath.startsWith("/"), r.id);
  }
  assert.equal(new Set(AGENTS.map((a) => a.id)).size, AGENTS.length);
});

test("install policy: vendor curl|sh scripts are only ever MANUAL, never an automatic method", () => {
  for (const r of RUNTIMES) {
    for (const methods of Object.values(r.install)) {
      for (const m of methods ?? []) {
        if (m.kind !== "manual") continue;
        assert.ok(m.url.startsWith("https://"), `${r.id}: manual steps cite their source`);
      }
      for (const m of methods ?? []) {
        const argv = installArgv(m);
        if (argv)
          assert.ok(!argv.join(" ").includes("| sh") && !argv.join(" ").includes("| bash"), r.id);
      }
    }
  }
  const ll = installChoices(runtimeById("llamacpp")!, "darwin-arm64");
  assert.deepEqual(installArgv(ll.auto[0]!), ["brew", "install", "--formula", "llama.cpp"]);
  const linuxOllama = installChoices(runtimeById("ollama")!, "linux-arm64");
  assert.equal(linuxOllama.auto.length, 0);
  assert.match(linuxOllama.manual[0]?.steps[0] ?? "", /install\.sh/);
});

test("platformOf maps node's os/arch", () => {
  assert.equal(platformOf("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformOf("linux", "x64"), "linux-x64");
  assert.equal(platformOf("win32", "arm64"), undefined);
});

test("acquire: every path is a gated one, and hf.co tags never reach ollama", () => {
  assert.deepEqual(acquireFor(QWEN, "ollama"), {
    method: "ollama-pull",
    tag: "qwen3:8b",
    sizeGb: 4.7,
  });
  const viaOllama = acquireFor(GGUF_ONLY, "ollama");
  assert.equal(viaOllama?.method, "hf-gguf");
  assert.equal(viaOllama && "importToOllama" in viaOllama && viaOllama.importToOllama, true);
  assert.equal(acquireFor(QWEN, "llamacpp")?.method, "hf-gguf");
  assert.equal(acquireFor(QWEN, "mlx")?.method, "hf-mlx");
  assert.equal(acquireFor(GGUF_ONLY, "mlx"), undefined);
  assert.equal(acquireFor({ ...QWEN, remoteCode: true }, "vllm"), undefined);
});

test("chooseRuntime: preference → serving → installed → platform default", () => {
  const none = [] as const;
  assert.equal(chooseRuntime(QWEN, none, "darwin-arm64")?.runtime, "ollama");
  assert.equal(chooseRuntime(QWEN, none, "darwin-arm64", "mlx")?.runtime, "mlx");
  const lm = [{ id: "lmstudio" as const, installed: true, serving: true }];
  assert.equal(chooseRuntime(QWEN, lm, "darwin-arm64")?.runtime, "lmstudio");
  // an adopt-only runtime is used only while it is running
  const kob = [{ id: "koboldcpp" as const, installed: true, serving: false }];
  assert.notEqual(chooseRuntime(QWEN, kob, "linux-x64")?.runtime, "koboldcpp");
  // a model with only an MLX build cannot be served on Linux
  assert.equal(
    chooseRuntime({ id: "m", mlx: "mlx-community/m", q4Gb: 2 }, none, "linux-x64"),
    undefined,
  );
});

test("agent wiring is env/argv only and respects runtime limits", () => {
  const oc = agentWiring("opencode", "http://127.0.0.1:11434/v1", "qwen3:8b", "ollama");
  assert.ok(!("unsupported" in oc));
  if (!("unsupported" in oc)) {
    const cfg = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    assert.equal(cfg.provider["prometheus-local"].options.baseURL, "http://127.0.0.1:11434/v1");
  }
  const cc = agentWiring("claude-code", "http://127.0.0.1:1234/v1", "m", "lmstudio");
  assert.ok("unsupported" in cc);
  const goose = agentWiring("goose", "http://127.0.0.1:8080/v1", "m", "llamacpp");
  assert.ok(!("unsupported" in goose) && goose.env.OPENAI_HOST === "http://127.0.0.1:8080");
  assert.match(agentContextWarning("hermes", 32_768) ?? "", /64K/);
  assert.equal(agentContextWarning("hermes", 131_072), undefined);
});

test("the sidecar's install table matches this registry (no silent drift between TS and Python)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const py = readFileSync(join(here, "../../../../../python/sidecar/model_acquire.py"), "utf8");
  const rows = [...py.matchAll(/"([a-z-]+)": \{[^}]*?"macos": \("([a-z-]+)", "([^"]+)"\)/gs)];
  assert.ok(rows.length >= 8, "parsed the RUNTIME_INSTALL table");
  for (const [, id, kind, name] of rows) {
    const rt = runtimeById(id as string);
    const ag = AGENTS.find((a) => a.id === id);
    const methods = (rt?.install["darwin-arm64"] ?? ag?.install["darwin-arm64"] ?? []) as readonly {
      kind: string;
      name?: string;
      token?: string;
      pkg?: string;
    }[];
    assert.ok(rt || ag, `${id} is in the sidecar but not in the registry`);
    assert.ok(
      methods.some((m) => m.kind === kind && (m.name ?? m.token ?? m.pkg) === name),
      `${id}: sidecar installs ${kind} ${name}, the registry does not list it`,
    );
  }
});

test("argv hygiene: no shell syntax in an argv, and the prompt can never become a flag", () => {
  assert.equal(
    installArgv({ kind: "pip-venv", pkg: "vllm" } as Parameters<typeof installArgv>[0]),
    undefined,
  );
  for (const agent of ["claude-code", "codex"] as const) {
    const w = agentWiring(agent, "http://127.0.0.1:11434/v1", "qwen3:8b", "ollama");
    assert.ok("argv" in w, agent);
    if ("argv" in w) assert.equal(w.argv.at(-1), "--", agent);
  }
});
