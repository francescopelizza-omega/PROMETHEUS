/**
 * model-cmd.test.ts — the `prometheus model …` modelhub surface: discovery reads, the
 * gated `pull` (confirm:false — modelhub has no --confirm toggle), and the honest
 * supervisor-owned boundary for serve/stop/ps. FAKE runSidecar; no python spawn.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { stretch } from "@prometheus/core";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { rankModels, runModelCommand, scoreModelRow } from "./model-cmd.js";
import type { SidecarDeps } from "./sidecar-cmd.js";

function fake(
  reply: Record<string, unknown> = { ok: true, command: "x" },
  guard: { cpuPct: number; ramPct: number } = { cpuPct: 5, ramPct: 20 },
): {
  deps: SidecarDeps;
  calls: { script: string; argv: string[] }[];
} {
  const calls: { script: string; argv: string[] }[] = [];
  const runSidecar = (async (script: string, argv: string[]) => {
    calls.push({ script, argv });
    return { ok: true, command: "x", ...reply };
  }) as unknown as SidecarDeps["runSidecar"];
  // inject a deterministic launch-guard sample + a no-op serve-host so --yes tests
  // never touch the real machine, real FS, or a real pid.
  const serveHost: SidecarDeps["serveHost"] = {
    start: async () => ({ ok: false, error: "no fake start" }),
    stop: async () => ({ ok: true, found: false }),
    status: async () => [],
    stateFile: "",
  };
  return {
    deps: {
      runSidecar,
      launchGuard: async () => guard,
      serveHost,
      // ollama present by default so pulls take the normal path; install tests override.
      probeRunner: async () => true,
      confirmRunnerInstall: async () => false,
    },
    calls,
  };
}

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));

test("model search: READ runs model.search + renders results", async () => {
  const { deps, calls } = fake({ ok: true, results: [{ id: "llama3", license: "llama" }] });
  const out = await runModelCommand(ctxFor(["model", "search", "llama"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["model.search", "llama"]);
  assert.match(out.text ?? "", /llama3/);
});

test("scoreModelRow: exact > id-prefix > family > name > tags > description", () => {
  assert.equal(scoreModelRow("qwen3-8b", { id: "qwen3-8b" }), 100);
  assert.equal(scoreModelRow("qwen", { id: "qwen3-8b" }), 80); // id token prefix
  assert.equal(scoreModelRow("qwen", { id: "x", family: "qwen" }), 60);
  assert.equal(scoreModelRow("turbo", { id: "x", name: "Turbo Model" }), 40);
  assert.equal(scoreModelRow("agentic", { id: "x", tags: ["agentic"] }), 30);
  assert.equal(scoreModelRow("coding", { id: "x", description: "great at coding" }), 20);
  assert.equal(scoreModelRow("zzz", { id: "x" }), 0);
});

test("rankModels: qwen family ranks first, deterministic id tiebreak", () => {
  const rows = [
    { id: "llama3-8b", family: "llama" },
    { id: "qwen3-8b", family: "qwen" },
    { id: "qwen3-4b", family: "qwen" },
  ];
  const ranked = rankModels("qwen", rows).map((r) => r.row.id);
  assert.deepEqual(ranked, ["qwen3-4b", "qwen3-8b"]); // score 80 each, id asc; llama dropped
});

test("model search: ranked table, qwen rows first (end-to-end fake)", async () => {
  const { deps } = fake({
    ok: true,
    results: [
      { id: "llama3-8b", family: "llama", params_b: 8, context: 8192, license: "llama" },
      { id: "qwen3-8b", family: "qwen", params_b: 8, context: 32768, license: "apache-2.0" },
    ],
  });
  const out = await runModelCommand(ctxFor(["model", "search", "qwen"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /qwen3-8b/);
  assert.doesNotMatch(out.text ?? "", /llama3-8b/); // llama scored 0 → dropped
});

test("model search --fits: drops infeasible rows, keeps a fitting one, scans hw once", async () => {
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "hw.scan") return { ok: true, ram_gb: 8, gpus: [], unified_memory: false };
    return {
      ok: true,
      results: [
        { id: "small", family: "f", params_b: 3, resource: { q4_gb: 2, min_ram_gb: 4 } },
        { id: "huge", family: "f", params_b: 70, resource: { q4_gb: 40, min_ram_gb: 48 } },
      ],
    };
  }) as unknown as SidecarDeps["runSidecar"];
  const out = await runModelCommand(ctxFor(["model", "search", "f", "--fits", "--json"]), {
    runSidecar,
  });
  const res = (out.json as { results: { id: string }[] }).results;
  assert.ok(res.some((r) => r.id === "small"));
  assert.ok(!res.some((r) => r.id === "huge"), "infeasible row excluded by --fits");
  assert.equal(calls.filter((a) => a[0] === "hw.scan").length, 1, "hw.scan fetched exactly once");
});

test("model search --license: forwards the filter to the sidecar", async () => {
  const { deps, calls } = fake({ ok: true, results: [] });
  await runModelCommand(ctxFor(["model", "search", "coder", "--license", "apache"]), deps);
  assert.deepEqual(calls[0]?.argv, ["model.search", "coder", "--license", "apache"]);
});

test("model search: empty result states explicitly, exit 0 (text + json)", async () => {
  const { deps } = fake({ ok: true, results: [] });
  const out = await runModelCommand(ctxFor(["model", "search", "zzz"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /no matches/);
  const { deps: jdeps } = fake({ ok: true, results: [] });
  const j = await runModelCommand(ctxFor(["model", "search", "zzz", "--json"]), jdeps);
  assert.equal(j.exitCode, 0);
  assert.equal((j.json as { ok: boolean; count: number }).count, 0);
});

test("model pull: PREVIEW by default — NO download executed (preflight reads only)", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(ctxFor(["model", "pull", "meta/llama"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "preview");
  assert.deepEqual((out.json as { argv: string[] }).argv, ["download", "--id", "meta/llama"]);
  assert.ok(!(out.json as { argv: string[] }).argv.includes("--confirm"));
  // the pre-flight feasibility may READ (model.search/hw.scan) but the preview NEVER downloads.
  assert.ok(!calls.some((c) => c.argv[0] === "download"), "preview must not execute the download");
});

test("model pull --yes: EXECUTES download (no --confirm appended)", async () => {
  const { deps, calls } = fake({ ok: true });
  await runModelCommand(ctxFor(["model", "pull", "meta/llama", "--quant", "Q4", "--yes"]), deps);
  const dl = calls.find((c) => c.argv[0] === "download");
  assert.deepEqual(dl?.argv, ["download", "--id", "meta/llama", "--quant", "Q4"]);
  assert.ok(!dl?.argv.includes("--confirm"));
});

test("model pull <family:tag> --yes: routes to the ollama `pull` verb (no /)", async () => {
  const { deps, calls } = fake({ ok: true });
  await runModelCommand(ctxFor(["model", "pull", "llama3:8b", "--yes"]), deps);
  const call = calls.find((c) => c.argv[0] === "pull");
  assert.deepEqual(call?.argv, ["pull", "--id", "llama3:8b"]);
  assert.ok(!calls.some((c) => c.argv[0] === "download"), "bare tag must not use download");
});

test("model pull --source ollama forces the pull verb even for an org/repo id", async () => {
  const { deps, calls } = fake({ ok: true });
  await runModelCommand(ctxFor(["model", "pull", "org/repo", "--source", "ollama", "--yes"]), deps);
  assert.ok(calls.some((c) => c.argv[0] === "pull"));
  assert.ok(!calls.some((c) => c.argv[0] === "download"));
});

test("model pull: launch guard REFUSES (exit 2) when CPU ≥ 90% — no spawn", async () => {
  const { deps, calls } = fake({ ok: true }, { cpuPct: 96, ramPct: 30 });
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b", "--yes"]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "launch-guard");
  assert.match(out.text ?? "", /CPU at 96%/);
  assert.ok(
    !calls.some((c) => c.argv[0] === "pull" || c.argv[0] === "download"),
    "a refused pull must never spawn the download/pull mutation",
  );
});

test("model pull: preview does NOT sample the launch guard (guard only gates execute)", async () => {
  let sampled = false;
  const base = fake({ ok: true });
  const deps: SidecarDeps = {
    runSidecar: base.deps.runSidecar,
    launchGuard: async () => {
      sampled = true;
      return { cpuPct: 99, ramPct: 99 };
    },
  };
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b"]), deps);
  assert.equal(out.exitCode, 0); // preview, unaffected by the saturated guard
  assert.equal(sampled, false, "preview must not sample (and thus not be blocked by) the guard");
});

test("model pull: refuses an option-shaped id (argv-injection guard)", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(ctxFor(["model", "pull", "--rm-rf"]), deps);
  assert.equal(out.exitCode, 2);
  assert.deepEqual(calls, []);
});

test("model pull: daemon-absent failure appends honest recovery hint", async () => {
  const { deps } = fake({ ok: false, error: "ollama daemon not running" });
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b", "--yes"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /prometheus doctor · prometheus model install-runner/);
});

test("model pull --json --yes: folds the feasibility verdict into the envelope", async () => {
  const calls: { script: string; argv: string[] }[] = [];
  const runSidecar = (async (script: string, argv: string[]) => {
    calls.push({ script, argv });
    if (argv[0] === "model.search") {
      return { ok: true, results: [{ id: "big:70b", resource: { min_ram_gb: 64, q4_gb: 40 } }] };
    }
    if (argv[0] === "hw.scan") return { ok: true, ram_gb: 16, gpus: [] };
    return { ok: true, command: "pull", installed: true };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 20 }) };
  const out = await runModelCommand(ctxFor(["model", "pull", "big:70b", "--json", "--yes"]), deps);
  const env = out.json as { feasibility?: { tier: string; ramGb: number } };
  assert.ok(env.feasibility, "envelope carries a feasibility block in --json mode");
  assert.equal(env.feasibility?.ramGb, 16);
  assert.notEqual(env.feasibility?.tier, "fits");
});

// ── CLI-027: OS-aware ollama auto-install offer ───────────────────────────────

test("model pull: missing ollama + --yes walks install → verify → retry", async () => {
  let installed = false;
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "install-runner") {
      installed = true;
      return { ok: true, installed: true, os: "macos" };
    }
    return { ok: true, command: "pull", installed: true };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = {
    runSidecar,
    launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }),
    probeRunner: async () => installed, // absent before install, present after
    confirmRunnerInstall: async () => true,
  };
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.ok(
    calls.some((a) => a[0] === "install-runner"),
    "the install seam ran",
  );
  assert.ok(
    calls.some((a) => a[0] === "pull"),
    "the pull was retried after install",
  );
  assert.match(out.text ?? "", /installed/);
});

test("model pull: missing ollama, declined → exit 0 + manual instructions, no install", async () => {
  const { deps, calls } = fake();
  deps.probeRunner = async () => false;
  deps.confirmRunnerInstall = async () => false; // TTY prompt would default N
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /brew install ollama|ollama\.com\/download/);
  assert.ok(!calls.some((c) => c.argv[0] === "install-runner"), "never installs without consent");
});

test("model pull: non-TTY without --yes never installs (fail-closed decline)", async () => {
  const { deps, calls } = fake();
  deps.probeRunner = async () => false;
  deps.confirmRunnerInstall = async () => false; // models a non-TTY / EOF decline
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { declined: boolean }).declined, true);
  assert.deepEqual(calls, [], "no sidecar call at all on a fail-closed decline");
});

test("model pull: post-install probe failure is reported as failure (no false success)", async () => {
  const runSidecar = (async (_s: string, argv: string[]) => {
    if (argv[0] === "install-runner") return { ok: true, installed: true };
    return { ok: true };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = {
    runSidecar,
    launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }),
    probeRunner: async () => false, // never appears → verify must fail
    confirmRunnerInstall: async () => true,
  };
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b", "--yes"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /still not on PATH/);
});

test("model pull: unautomatable install (manual:true) prints instructions, exit 0", async () => {
  const runSidecar = (async (_s: string, argv: string[]) => {
    if (argv[0] === "install-runner") {
      return {
        ok: false,
        manual: true,
        install: "download from https://ollama.com/download",
        error: "no Homebrew",
      };
    }
    return { ok: true };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = {
    runSidecar,
    launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }),
    probeRunner: async () => false,
    confirmRunnerInstall: async () => true,
  };
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /ollama\.com\/download/);
});

test("model pull: launch guard also gates the install spawn (exit 2, no install)", async () => {
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    return { ok: true };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = {
    runSidecar,
    launchGuard: async () => ({ cpuPct: 95, ramPct: 10 }),
    probeRunner: async () => false,
    confirmRunnerInstall: async () => true,
  };
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b", "--yes"]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "launch-guard");
  assert.ok(!calls.some((a) => a[0] === "install-runner"));
});

test("model serve --runner ollama: missing runner offers install (no auto-retry)", async () => {
  const { deps, calls } = fake();
  deps.probeRunner = async () => false;
  deps.confirmRunnerInstall = async () => false;
  const out = await runModelCommand(
    ctxFor(["model", "serve", "qwen3-8b", "--runner", "ollama"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /ollama/i);
  assert.ok(!calls.some((c) => c.argv[0] === "serve"), "did not build the profile with no runner");
});

test("model serve: PREVIEW by default builds the profile, spawns nothing", async () => {
  let started = 0;
  const { deps, calls } = fake({
    ok: true,
    command: "serve",
    profile: {
      id: "qwen3-8b-q4-llamacpp",
      model_id: "qwen3-8b",
      runner: "llamacpp",
      endpoint: { host: "127.0.0.1", port: 8080, base_url: "http://127.0.0.1:8080/v1" },
      argv: ["llama-server", "-m", "/models/qwen3.gguf", "--port", "8080"],
      status: "stopped",
    },
  });
  if (deps.serveHost)
    deps.serveHost.start = async () => {
      started++;
      return { ok: false, error: "x" };
    };
  const out = await runModelCommand(ctxFor(["model", "serve", "qwen3-8b"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal(started, 0, "preview must not start the runner");
  assert.equal(calls[0]?.argv[0], "serve"); // profile still built
});

test("model serve --yes: starts the runner via serve-host + reports pid/port", async () => {
  const { deps } = fake({
    ok: true,
    command: "serve",
    profile: {
      id: "qwen3-8b-q4-llamacpp",
      model_id: "qwen3-8b",
      runner: "llamacpp",
      endpoint: { host: "127.0.0.1", port: 8080, base_url: "http://127.0.0.1:8080/v1" },
      argv: ["llama-server", "-m", "/models/qwen3.gguf", "--port", "8080"],
      status: "stopped",
    },
  });
  let spec: unknown;
  if (deps.serveHost)
    deps.serveHost.start = async (s) => {
      spec = s;
      return {
        ok: true,
        record: {
          profileId: "qwen3-8b-q4-llamacpp",
          model: "qwen3-8b",
          runner: "llamacpp",
          port: 8080,
          pid: 4242,
          startedAt: "2026-07-17T00:00:00.000Z",
          baseUrl: "http://127.0.0.1:8080/v1",
        },
      };
    };
  const out = await runModelCommand(ctxFor(["model", "serve", "qwen3-8b", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "serving");
  assert.deepEqual((spec as { argv: string[] }).argv, [
    "llama-server",
    "-m",
    "/models/qwen3.gguf",
    "--port",
    "8080",
  ]);
});

test("model serve --yes: occupied port fails fast (exit 2), no serving status", async () => {
  const { deps } = fake({
    ok: true,
    command: "serve",
    profile: {
      id: "p1",
      model_id: "m",
      runner: "llamacpp",
      endpoint: { port: 8080, base_url: "http://127.0.0.1:8080/v1" },
      argv: ["llama-server", "--port", "8080"],
    },
  });
  if (deps.serveHost)
    deps.serveHost.start = async () => ({
      ok: false,
      error: "port 8080 in use (pid 999) — try --port or prometheus model stop",
    });
  const out = await runModelCommand(ctxFor(["model", "serve", "m", "--yes"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /port 8080 in use/);
});

test("model serve: refuses an option-shaped id", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(ctxFor(["model", "serve", "--evil"]), deps);
  assert.equal(out.exitCode, 2);
  assert.deepEqual(calls, []);
});

test("model status --json: stable {ok, servers[]} envelope from the serve-host", async () => {
  const { deps } = fake();
  if (deps.serveHost)
    deps.serveHost.status = async () => [
      {
        profileId: "p1",
        model: "qwen3-8b",
        runner: "llamacpp",
        port: 8080,
        pid: 4242,
        startedAt: "2026-07-17T00:00:00.000Z",
        uptimeSec: 12,
      },
    ];
  const out = await runModelCommand(ctxFor(["model", "status", "--json"]), deps);
  assert.equal(out.exitCode, 0);
  const env = out.json as { ok: boolean; servers: { profileId: string; uptimeSec: number }[] };
  assert.equal(env.ok, true);
  assert.equal(env.servers[0]?.profileId, "p1");
  assert.equal(env.servers[0]?.uptimeSec, 12);
});

test("model ps: alias of status; empty when nothing served", async () => {
  const { deps } = fake();
  const out = await runModelCommand(ctxFor(["model", "ps"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /no CLI-served models running/);
});

test("model stop <id>: PREVIEW by default (unserve plan, no spawn), needs profileId", async () => {
  const { deps, calls } = fake();
  // missing profileId → usage error
  const noId = await runModelCommand(ctxFor(["model", "stop"]), deps);
  assert.equal(noId.exitCode, 2);
  // preview by default — no --yes → no sidecar call
  const preview = await runModelCommand(ctxFor(["model", "stop", "prof-1"]), deps);
  assert.equal(preview.exitCode, 0);
  assert.equal((preview.json as { status: string }).status, "preview");
  assert.deepEqual(calls, []);
});

test("model stop <id> --yes: EXECUTES unserve via the sidecar", async () => {
  const { deps, calls } = fake({ ok: true, command: "unserve" });
  const out = await runModelCommand(ctxFor(["model", "stop", "prof-1", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal(calls[0]?.argv[0], "unserve");
  assert.deepEqual(calls[0]?.argv, ["unserve", "--profile", "prof-1"]);
});

test("model rm: without --confirm/--yes refuses (exit 2), never calls remove", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(ctxFor(["model", "rm", "acme/demo"]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "confirm-required");
  assert.ok(!calls.some((c) => c.argv[0] === "remove"), "no deletion without the typed confirm");
});

test("model rm: wrong --confirm value refuses, no remove", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(
    ctxFor(["model", "rm", "acme/demo", "--confirm", "nope"]),
    deps,
  );
  assert.equal(out.exitCode, 2);
  assert.ok(!calls.some((c) => c.argv[0] === "remove"));
});

test("model rm --confirm <id>: executes and surfaces freed_bytes", async () => {
  const { deps, calls } = fake({ ok: true, removed_count: 2, freed_bytes: 3_400_000_000 });
  const out = await runModelCommand(
    ctxFor(["model", "rm", "acme/demo", "--confirm", "acme/demo"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["remove", "--id", "acme/demo"]);
  assert.match(out.text ?? "", /freed 3\.\d+ GB/);
});

test("model rm --yes: bypasses the typed confirm", async () => {
  const { deps, calls } = fake({ ok: true, removed_count: 1, freed_bytes: 1024 });
  const out = await runModelCommand(ctxFor(["model", "rm", "acme/demo", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["remove", "--id", "acme/demo"]);
});

test("model rm: unknown model (sidecar not_found) exits 2 honestly", async () => {
  const { deps } = fake({
    ok: false,
    not_found: true,
    error: "model 'x' not found in the library",
  });
  const out = await runModelCommand(ctxFor(["model", "rm", "x", "--yes"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /not found/);
});

test("model rm: refuses an option-shaped id", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(ctxFor(["model", "rm", "--wipe"]), deps);
  assert.equal(out.exitCode, 2);
  assert.deepEqual(calls, []);
});

test("model prune --dry-run: READ lists candidates, never mutates", async () => {
  const { deps, calls } = fake({
    ok: true,
    dry_run: true,
    removed_count: 2,
    freed_bytes: 500,
    removed: [],
  });
  const out = await runModelCommand(ctxFor(["model", "prune", "--dry-run"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["prune", "--dry-run"]);
  assert.match(out.text ?? "", /would free.*2 blobs/s);
});

test("model prune: PREVIEW by default (no --yes → no sidecar call)", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(ctxFor(["model", "prune"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "preview");
  assert.deepEqual(calls, []);
});

test("model prune --yes: executes and reports freed bytes", async () => {
  const { deps, calls } = fake({
    ok: true,
    dry_run: false,
    removed_count: 4,
    freed_bytes: 3_400_000_000,
  });
  const out = await runModelCommand(ctxFor(["model", "prune", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["prune"]);
  assert.match(out.text ?? "", /freed 3\.\d+ GB.*4 blobs/s);
});

/** A fake whose model.search + hw.scan return distinct envelopes (for info feasibility). */
function fakeInfo(row: Record<string, unknown> | null, hw: Record<string, unknown>): SidecarDeps {
  const runSidecar = (async (_script: string, argv: string[]) => {
    if (argv[0] === "model.search") return { ok: true, results: row ? [row] : [] };
    if (argv[0] === "hw.scan") return hw;
    return { ok: true };
  }) as unknown as SidecarDeps["runSidecar"];
  return { runSidecar };
}

test("model info <id>: renders descriptor + machine feasibility verdict", async () => {
  const deps = fakeInfo(
    {
      id: "qwen3-8b",
      name: "Qwen3 8B",
      license: "apache-2.0",
      repo: "Qwen/Qwen3-8B",
      context: 32768,
      resource: { q4_gb: 5, min_ram_gb: 8, needs_offload: false },
    },
    { ok: true, ram_gb: 32, gpus: [], unified_memory: false },
  );
  const out = await runModelCommand(ctxFor(["model", "info", "qwen3-8b"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /Qwen3 8B/);
  assert.match(out.text ?? "", /Feasibility \(this machine\)/);
  assert.match(out.text ?? "", /verdict/);
});

test("model info: card feasibility tier matches a direct assessFeasibility call", async () => {
  const resource = { q4_gb: 40, min_ram_gb: 48, needs_offload: false };
  const deps = fakeInfo(
    { id: "big-70b", name: "Big 70B", context: 8192, resource },
    { ok: true, ram_gb: 16, gpus: [], unified_memory: false },
  );
  const out = await runModelCommand(ctxFor(["model", "info", "big-70b", "--json"]), deps);
  const card = out.json as { feasibility: { tier: string } };
  const expected = stretch.assessFeasibility(
    { q4Gb: 40, minRamGb: 48, isMoe: false, needsOffload: false },
    { ramGb: 16, vramGb: 0, unified: false },
  );
  assert.equal(card.feasibility.tier, expected.tier);
});

test("model info: infeasible machine shows ≥1 offload/AirLLM suggestion", async () => {
  const deps = fakeInfo(
    { id: "big-70b", name: "Big 70B", context: 8192, resource: { q4_gb: 40, min_ram_gb: 48 } },
    { ok: true, ram_gb: 8, gpus: [], unified_memory: false },
  );
  const out = await runModelCommand(ctxFor(["model", "info", "big-70b"]), deps);
  assert.equal(out.exitCode, 0);
  // at least one suggestion line (technique — rationale) beneath the verdict.
  assert.match(out.text ?? "", / — /);
});

test("model info: unknown id exits 2 and suggests search", async () => {
  const deps = fakeInfo(null, { ok: true, ram_gb: 32 });
  const out = await runModelCommand(ctxFor(["model", "info", "nope"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /model search/);
  const jdeps = fakeInfo(null, { ok: true, ram_gb: 32 });
  const j = await runModelCommand(ctxFor(["model", "info", "nope", "--json"]), jdeps);
  assert.equal(j.exitCode, 2);
  assert.equal((j.json as { ok: boolean; refused: boolean }).refused, true);
});

test("model info: hw.scan failure degrades honestly (feasibility null, exit 0)", async () => {
  const deps = fakeInfo(
    { id: "qwen3-8b", name: "Qwen3 8B", resource: { q4_gb: 5, min_ram_gb: 8 } },
    { ok: false, error: "hw probe failed" },
  );
  const out = await runModelCommand(ctxFor(["model", "info", "qwen3-8b"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /machine probe unavailable/);
  const jdeps = fakeInfo(
    { id: "qwen3-8b", name: "Qwen3 8B", resource: { q4_gb: 5, min_ram_gb: 8 } },
    { ok: false, error: "hw probe failed" },
  );
  const j = await runModelCommand(ctxFor(["model", "info", "qwen3-8b", "--json"]), jdeps);
  assert.equal(j.exitCode, 0);
  assert.equal((j.json as { feasibility: unknown }).feasibility, null);
});

test("model info --json: structured card with model + feasibility", async () => {
  const deps = fakeInfo(
    {
      id: "qwen3-8b",
      family: "qwen3",
      params_b: 8,
      context: 32768,
      license: "apache-2.0",
      quants: ["Q4_K_M"],
      repo: "Qwen/Qwen3-8B",
      resource: { q4_gb: 5, min_ram_gb: 8 },
    },
    { ok: true, ram_gb: 32, gpus: [], unified_memory: false },
  );
  const out = await runModelCommand(ctxFor(["model", "info", "qwen3-8b", "--json"]), deps);
  const card = out.json as {
    ok: boolean;
    model: { id: string; params_b: number };
    feasibility: { tier: string; machine: { ram_gb: number } };
  };
  assert.equal(card.ok, true);
  assert.equal(card.model.id, "qwen3-8b");
  assert.equal(card.model.params_b, 8);
  assert.equal(card.feasibility.machine.ram_gb, 32);
});

test("model card <id>: prints the HuggingFace card URL from the repo", async () => {
  const { deps } = fake({ ok: true, results: [{ id: "gpt-oss-20b", repo: "openai/gpt-oss-20b" }] });
  const out = await runModelCommand(ctxFor(["model", "card", "gpt-oss-20b"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { url: string }).url, "https://huggingface.co/openai/gpt-oss-20b");
});

test("model repoint requires --base-url (usage error, exit 2)", async () => {
  const { deps } = fake();
  const out = await runModelCommand(ctxFor(["model", "repoint", "ollama"]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "missing-argument");
});
