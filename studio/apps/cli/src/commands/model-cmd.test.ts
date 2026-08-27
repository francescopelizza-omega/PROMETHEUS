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

test("prometheus model <typo>: reports unknown model verb, never silently defaults to list", async () => {
  // regression: command[1] is undefined for a TWO_WORD mismatch (parse.ts sets `unmatchedSub`
  // instead), so a typo used to silently fall through to the "list" branch, discarding both
  // the typo and any extra args.
  const { deps } = fake();
  const out = await runModelCommand(ctxFor(["model", "pl", "llama3", "--json"]), deps);
  assert.equal(out.exitCode, 1);
  assert.equal((out.json as { error: string }).error, "unknown-verb");
});

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
  const out = await runModelCommand(ctxFor(["model", "pull", "--", "--rm-rf"]), deps);
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

/**
 * Regression: a plain `/pull <id>` (no --yes), with ollama absent, used to unconditionally ask
 * "install ollama now?" — a DIFFERENT, narrower question than "run this pull" — and a bare "yes"
 * to it alone was enough for offerRunnerInstall's own `wantsExecute(ctx) || confirm()` check to
 * then run the REAL pull too, with no separate consent to the actual mutating action ever given.
 * A preview call must now never reach the install offer at all — it just previews, like any other
 * missing-runner-agnostic preview in this file.
 */
test("model pull (no --yes): previews cleanly, never asks to install ollama, never runs anything", async () => {
  const { deps, calls } = fake();
  deps.probeRunner = async () => false;
  let confirmCalls = 0;
  deps.confirmRunnerInstall = async () => {
    confirmCalls++;
    return true; // even if it WOULD consent, it must never be asked during a plain preview
  };
  const out = await runModelCommand(ctxFor(["model", "pull", "llama3:8b"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status?: string }).status, "preview");
  assert.equal(confirmCalls, 0, "the install-consent prompt must never fire during a preview");
  // the feasibility pre-flight's own search call is pre-existing, unrelated behavior (it runs
  // during every preview to warn if the model won't fit) — what matters is no install/pull call.
  assert.ok(!calls.some((c) => c.argv[0] === "install-runner"), "never installs during a preview");
  assert.ok(
    !calls.some((c) => c.argv[0] === "pull"),
    "never runs the pull itself during a preview",
  );
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

/**
 * Regression: a plain `/model serve <id> --runner ollama` (no --yes) used to reach a LIVE
 * "install ollama now?" prompt when the runner was missing, even though the file's own comment
 * says a bare call must "PREVIEW by default (build only, spawn nothing)". The install offer must
 * now only be reachable once actually executing (--yes), matching case "hug"'s ordering.
 */
test("model serve --runner ollama (no --yes): previews cleanly, never asks to install ollama", async () => {
  const { deps, calls } = fake();
  deps.probeRunner = async () => false;
  let confirmCalls = 0;
  deps.confirmRunnerInstall = async () => {
    confirmCalls++;
    return true;
  };
  const out = await runModelCommand(
    ctxFor(["model", "serve", "qwen3-8b", "--runner", "ollama"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.equal(calls[0]?.argv[0], "serve", "the profile is still built (pure, side-effect-free)");
  assert.equal(confirmCalls, 0, "the install-consent prompt must never fire during a preview");
  assert.ok(!calls.some((c) => c.argv[0] === "install-runner"), "never installs during a preview");
});

test("model serve --runner ollama --yes: missing runner offers install (no auto-retry)", async () => {
  let installed = false;
  const { deps, calls } = fake();
  deps.probeRunner = async () => installed; // absent before install, present after (verify passes)
  const realRunSidecar = deps.runSidecar;
  deps.runSidecar = (async (script, argv) => {
    if (argv[0] === "install-runner") installed = true;
    return realRunSidecar(script, argv);
  }) as unknown as SidecarDeps["runSidecar"];
  // `serve --runner ollama` IS a request to run ollama, so --yes is consent to install it and
  // the y/N is not asked. That is true only for this verb — see the pull/hug tests below.
  deps.confirmRunnerInstall = async () => false;
  const out = await runModelCommand(
    ctxFor(["model", "serve", "qwen3-8b", "--runner", "ollama", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /ollama/i);
  assert.ok(
    calls.some((c) => c.argv[0] === "install-runner"),
    "--yes alone is consent to install",
  );
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
  const out = await runModelCommand(ctxFor(["model", "serve", "--", "--evil"]), deps);
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
  assert.equal(noId.exitCode, 1);
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
  const out = await runModelCommand(ctxFor(["model", "rm", "--", "--wipe"]), deps);
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

test("model card <id> --json: returns the {ok,id,url} shape, NOT the raw multi-row search envelope", async () => {
  // regression: runRead used to always emit the RAW sidecar envelope under --json, before
  // ever calling render() — so `model card --json` returned every fuzzy-matched catalog row
  // instead of the one card renderCard() actually computed.
  const { deps } = fake({
    ok: true,
    results: [
      { id: "gpt-oss-20b", repo: "openai/gpt-oss-20b" },
      { id: "gpt-oss-120b", repo: "openai/gpt-oss-120b" },
      { id: "unrelated-model", repo: "someone/unrelated-model" },
    ],
  });
  const out = await runModelCommand(ctxFor(["model", "card", "gpt-oss-20b", "--json"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.json, {
    ok: true,
    id: "gpt-oss-20b",
    url: "https://huggingface.co/openai/gpt-oss-20b",
  });
});

test("model browse --limit --json: the limit applies to --json too, not just text", async () => {
  // regression: runRead's --json branch bypassed render(), so renderSearch's --limit/--free
  // filtering was a text-only illusion — `--json` always returned the full unfiltered catalog.
  const { deps } = fake({
    ok: true,
    results: [
      { id: "a", license: "mit" },
      { id: "b", license: "mit" },
      { id: "c", license: "mit" },
    ],
  });
  const out = await runModelCommand(ctxFor(["model", "browse", "--limit", "2", "--json"]), deps);
  assert.equal(out.exitCode, 0);
  const j = out.json as { ok: boolean; count: number; results: Array<{ id: string }> };
  assert.equal(j.ok, true);
  assert.equal(j.count, 2);
  assert.deepEqual(
    j.results.map((r) => r.id),
    ["a", "b"],
  );
});

test("model repoint requires --base-url (usage error, exit 1)", async () => {
  const { deps } = fake();
  const out = await runModelCommand(ctxFor(["model", "repoint", "ollama"]), deps);
  assert.equal(out.exitCode, 1);
  assert.equal((out.json as { error: string }).error, "missing-argument");
});

// ── model hug: fetch (if needed) → convert → install, ONE copy shared everywhere ──

test("model hug: usage error with no source (exit 1)", async () => {
  const { deps } = fake();
  const out = await runModelCommand(ctxFor(["model", "hug"]), deps);
  assert.equal(out.exitCode, 1);
});

test("model hug: refuses an option-shaped source (argv-injection guard)", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(ctxFor(["model", "hug", "--", "--rm-rf"]), deps);
  assert.equal(out.exitCode, 2);
  assert.deepEqual(calls, []);
});

test("model hug: rejects an unknown --target", async () => {
  const { deps } = fake();
  const out = await runModelCommand(
    ctxFor(["model", "hug", "acme/tiny", "--target", "bogus"]),
    deps,
  );
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /--target must be one of/);
});

test("model hug: PREVIEW by default — no sidecar calls, no execution", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(ctxFor(["model", "hug", "acme/tiny"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, []);
  assert.match(out.text ?? "", /preview/);
  assert.match(out.text ?? "", /hf\.co\/acme\/tiny/);
});

test("model hug: preview for a local source + llamacpp describes fetch/convert/install", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(
    ctxFor(["model", "hug", "~/models/tiny", "--target", "llamacpp"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(out.text ?? "", /fetch/); // local source — no fetch step described
  assert.match(out.text ?? "", /convert/);
  assert.match(out.text ?? "", /install into llamacpp/);
});

test("model hug: preview for --target vllm never mentions convert (vLLM doesn't need it)", async () => {
  const { deps, calls } = fake();
  const out = await runModelCommand(
    ctxFor(["model", "hug", "~/models/tiny", "--target", "vllm"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(out.text ?? "", /convert/);
  assert.match(out.text ?? "", /install into vllm/);
});

test("model hug: preview for --quant f32/fp16/auto never claims a quantize step (matches the full no-requant set)", async () => {
  for (const quant of ["f32", "fp16", "auto"]) {
    const { deps } = fake();
    const out = await runModelCommand(
      ctxFor(["model", "hug", "~/models/tiny", "--target", "llamacpp", "--quant", quant]),
      deps,
    );
    assert.equal(out.exitCode, 0);
    assert.doesNotMatch(
      out.text ?? "",
      /quantize/,
      `--quant ${quant} should not claim a quantize step`,
    );
  }
});

test("model hug --json: --yes success returns the raw install-target envelope", async () => {
  const runSidecar = (async (_s: string, argv: string[]) => {
    if (argv[0] === "convert") {
      return {
        ok: true,
        path: "/tmp/models/acme-tiny-q4_k_m.gguf",
        canonical_path: "/tmp/models/acme-tiny-q4_k_m.gguf",
      };
    }
    if (argv[0] === "install-target") {
      return {
        ok: true,
        command: "install-target",
        target: "llamacpp",
        path: "/tmp/models/acme-tiny-q4_k_m.gguf",
      };
    }
    return { ok: false, error: "unexpected call" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }) };
  const out = await runModelCommand(
    ctxFor([
      "model",
      "hug",
      "/home/me/models/acme-tiny",
      "--target",
      "llamacpp",
      "--json",
      "--yes",
    ]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { ok: boolean; target: string }).target, "llamacpp");
});

test("model hug: ollama + HF source --yes → the zero-download hf.co passthrough", async () => {
  const { deps, calls } = fake({
    ok: true,
    command: "pull",
    installed: true,
    endpoint: "http://localhost:11434/v1",
  });
  const out = await runModelCommand(ctxFor(["model", "hug", "acme/tiny", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.argv, ["pull", "--id", "acme/tiny", "--tag", "hf.co/acme/tiny"]);
});

test("model hug: ollama + HF source, missing runner → install → verify → retry", async () => {
  let installed = false;
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "install-runner") {
      installed = true;
      return { ok: true, installed: true, os: "macos" };
    }
    return { ok: true, command: "pull", installed: true, endpoint: "http://localhost:11434/v1" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = {
    runSidecar,
    launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }),
    probeRunner: async () => installed,
    confirmRunnerInstall: async () => true,
  };
  const out = await runModelCommand(ctxFor(["model", "hug", "acme/tiny", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.ok(calls.some((a) => a[0] === "install-runner"));
  assert.ok(calls.some((a) => a[0] === "pull"));
});

test("model hug: HF source + llamacpp --yes runs fetch-hf → convert → install-target in order", async () => {
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "fetch-hf")
      return { ok: true, repo: "acme/tiny", path: "/tmp/hf-src/acme__tiny" };
    if (argv[0] === "convert") {
      return {
        ok: true,
        id: "acme/tiny",
        path: "/tmp/models/acme__tiny-q4_k_m.gguf",
        canonical_path: "/tmp/models/acme__tiny-q4_k_m.gguf",
        quant: "q4_k_m",
      };
    }
    if (argv[0] === "install-target")
      return { ok: true, target: "llamacpp", path: "/tmp/models/acme__tiny-q4_k_m.gguf" };
    return { ok: false, error: "unexpected call" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }) };
  const out = await runModelCommand(
    ctxFor(["model", "hug", "acme/tiny", "--target", "llamacpp", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(
    calls.map((a) => a[0]),
    ["fetch-hf", "convert", "install-target"],
  );
  assert.deepEqual(calls[0], ["fetch-hf", "--repo", "acme/tiny"]);
  assert.deepEqual(calls[1], [
    "convert",
    "--src",
    "/tmp/hf-src/acme__tiny",
    "--quant",
    "q4_k_m",
    "--id",
    "acme/tiny",
  ]);
  assert.deepEqual(calls[2], [
    "install-target",
    "--target",
    "llamacpp",
    "--id",
    "acme/tiny",
    "--gguf",
    "/tmp/models/acme__tiny-q4_k_m.gguf",
  ]);
  assert.match(out.text ?? "", /hugged/);
  assert.match(out.text ?? "", /acme\/tiny/);
  assert.match(out.text ?? "", /llamacpp/);
});

test("model hug: local source + vllm --yes skips BOTH fetch-hf and convert, installs by --src", async () => {
  // Regression test: vLLM reads the raw HF/local directory directly and never needs
  // the GGUF conversion at all — a prior bug ran `convert` unconditionally here,
  // wasting work (and potentially failing on missing llama.cpp tooling) for a target
  // that never touches its output. Any unexpected call (including "convert") falls
  // through to the `unexpected call` branch below and fails the assertion on exitCode.
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "install-target")
      return { ok: true, target: "vllm", path: "/home/me/models/tiny" };
    return { ok: false, error: "unexpected call" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }) };
  const out = await runModelCommand(
    ctxFor(["model", "hug", "/home/me/models/tiny", "--target", "vllm", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.ok(!calls.some((a) => a[0] === "fetch-hf"));
  assert.ok(!calls.some((a) => a[0] === "convert"));
  assert.deepEqual(calls, [
    ["install-target", "--target", "vllm", "--id", "tiny", "--src", "/home/me/models/tiny"],
  ]);
});

test("model hug: HF source + vllm --yes fetches but still skips convert entirely", async () => {
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "fetch-hf") return { ok: true, path: "/tmp/hf-src/acme__tiny" };
    if (argv[0] === "install-target")
      return { ok: true, target: "vllm", path: "/tmp/hf-src/acme__tiny" };
    return { ok: false, error: "unexpected call" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }) };
  const out = await runModelCommand(
    ctxFor(["model", "hug", "acme/tiny", "--target", "vllm", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(
    calls.map((a) => a[0]),
    ["fetch-hf", "install-target"],
  );
  assert.deepEqual(calls[1], [
    "install-target",
    "--target",
    "vllm",
    "--id",
    "acme/tiny",
    "--src",
    "/tmp/hf-src/acme__tiny",
  ]);
});

test("model hug: local source + ollama --yes does NOT re-pass --quant to install-target (convert already quantized it)", async () => {
  // Regression test: install-target's ollama branch appends `--quantize` to `ollama
  // create` whenever it's handed a --quant not in the no-requant set — but convert()
  // already fully quantizes, so re-passing the same --quant to install-target would
  // ask Ollama to re-quantize an already-quantized GGUF (which ollama create rejects).
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "convert") {
      return {
        ok: true,
        path: "/tmp/models/my-local-model-q4_k_m.gguf",
        canonical_path: "/tmp/models/my-local-model-q4_k_m.gguf",
      };
    }
    if (argv[0] === "install-target")
      return { ok: true, target: "ollama", endpoint: "http://localhost:11434/v1" };
    return { ok: false, error: "unexpected call" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }) };
  const out = await runModelCommand(
    ctxFor(["model", "hug", "/home/me/models/my-local-model", "--target", "ollama", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  const install = calls.find((a) => a[0] === "install-target");
  assert.deepEqual(install, [
    "install-target",
    "--target",
    "ollama",
    "--id",
    "my-local-model",
    "--gguf",
    "/tmp/models/my-local-model-q4_k_m.gguf",
  ]);
  assert.ok(!install?.includes("--quant"));
});

test("model hug: missing converter walks install-converter → retry convert", async () => {
  let converterReady = false;
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "fetch-hf") return { ok: true, path: "/tmp/hf-src/x" };
    if (argv[0] === "install-converter") {
      converterReady = true;
      return { ok: true, installed: true };
    }
    if (argv[0] === "convert") {
      return converterReady
        ? {
            ok: true,
            path: "/tmp/models/x-q4_k_m.gguf",
            canonical_path: "/tmp/models/x-q4_k_m.gguf",
          }
        : {
            ok: false,
            installable: true,
            error: "llama.cpp's convert_hf_to_gguf.py is not available",
          };
    }
    if (argv[0] === "install-target")
      return { ok: true, target: "llamacpp", path: "/tmp/models/x-q4_k_m.gguf" };
    return { ok: false, error: "unexpected call" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }) };
  const out = await runModelCommand(
    ctxFor(["model", "hug", "acme/x", "--target", "llamacpp", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(
    calls.map((a) => a[0]),
    ["fetch-hf", "convert", "install-converter", "convert", "install-target"],
  );
});

test("model hug: missing hf CLI walks install-hf-cli → retry fetch-hf", async () => {
  let cliReady = false;
  const calls: string[][] = [];
  const runSidecar = (async (_s: string, argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "fetch-hf") {
      return cliReady
        ? { ok: true, path: "/tmp/hf-src/x" }
        : { ok: false, installable: true, error: "no HF downloader is on PATH" };
    }
    if (argv[0] === "install-hf-cli") {
      cliReady = true;
      return { ok: true, installed: true };
    }
    if (argv[0] === "convert") {
      return {
        ok: true,
        path: "/tmp/models/x-q4_k_m.gguf",
        canonical_path: "/tmp/models/x-q4_k_m.gguf",
      };
    }
    if (argv[0] === "install-target")
      return { ok: true, target: "llamacpp", path: "/tmp/models/x-q4_k_m.gguf" };
    return { ok: false, error: "unexpected call" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }) };
  const out = await runModelCommand(
    ctxFor(["model", "hug", "acme/x", "--target", "llamacpp", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(
    calls.map((a) => a[0]),
    ["fetch-hf", "install-hf-cli", "fetch-hf", "convert", "install-target"],
  );
});

test("model hug: a low-disk refusal from convert surfaces as an actionable exit 2", async () => {
  const runSidecar = (async (_s: string, argv: string[]) => {
    if (argv[0] === "convert") {
      return {
        ok: false,
        low_disk: true,
        error: "converting here would leave only 3.1% free (floor 7%)",
        hint: "free up space, remove another model, or retry with --out <a different disk>",
      };
    }
    return { ok: false, error: "unexpected call" };
  }) as unknown as SidecarDeps["runSidecar"];
  const deps: SidecarDeps = { runSidecar, launchGuard: async () => ({ cpuPct: 5, ramPct: 10 }) };
  const out = await runModelCommand(
    ctxFor(["model", "hug", "/home/me/models/tiny", "--target", "llamacpp", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /leave only 3\.1% free/);
  assert.match(out.text ?? "", /retry with --out/);
});

test("model pull --yes does NOT authorise a package install of ollama", async () => {
  /**
   * `--yes` on `model pull` answers a preview that promises a MODEL DOWNLOAD and never mentions
   * ollama. offerRunnerInstall's `proceed = wantsExecute(ctx) || confirm()` turned that into
   * consent for a brew / `curl … | sh` package install — and since all three call sites are
   * already behind `wantsExecute(ctx)`, the left side was unconditionally true, so the
   * documented TTY y/N (`confirmRunnerInstall`, wired in defaultSidecarDeps) and the whole
   * decline branch were dead code that only the tests ever reached.
   */
  const { deps, calls } = fake();
  deps.probeRunner = async () => false; // ollama absent
  let asked = 0;
  deps.confirmRunnerInstall = async () => {
    asked++;
    return false; // what a non-TTY, an EOF, or a plain "no" all produce
  };
  const out = await runModelCommand(
    ctxFor(["model", "pull", "llama3:8b", "--runner", "ollama", "--yes"]),
    deps,
  );
  assert.equal(asked, 1, "the documented consent prompt was not reached");
  assert.ok(
    !calls.some((c) => c.argv[0] === "install-runner"),
    "a declined package install ran anyway",
  );
  assert.ok(!calls.some((c) => c.argv[0] === "pull"), "the pull ran without its runner");
  assert.equal(out.exitCode, 0, "declining is a choice, not a failure");
  assert.match(out.text ?? "", /brew install ollama/);

  // self-validating: saying yes to the SAME command does install and then retries the pull
  const second = fake();
  let present = false;
  second.deps.probeRunner = async () => present;
  const realRun = second.deps.runSidecar;
  second.deps.runSidecar = (async (script: string, argv: string[]) => {
    if (argv[0] === "install-runner") present = true;
    return realRun(script, argv);
  }) as unknown as SidecarDeps["runSidecar"];
  second.deps.confirmRunnerInstall = async () => true;
  await runModelCommand(
    ctxFor(["model", "pull", "llama3:8b", "--runner", "ollama", "--yes"]),
    second.deps,
  );
  assert.ok(
    second.calls.some((c) => c.argv[0] === "install-runner"),
    "consent was not honoured",
  );
});

test("model hug --yes does NOT authorise a package install of ollama either", async () => {
  const { deps, calls } = fake();
  deps.probeRunner = async () => false;
  let asked = 0;
  deps.confirmRunnerInstall = async () => {
    asked++;
    return false;
  };
  const out = await runModelCommand(
    ctxFor(["model", "hug", "TheBloke/Llama-2-7B-GGUF", "--runner", "ollama", "--yes"]),
    deps,
  );
  assert.equal(asked, 1);
  assert.ok(!calls.some((c) => c.argv[0] === "install-runner"));
  assert.equal(out.exitCode, 0);
});

test("model rm --confirm <id> --dry-run: previews, never calls remove", async () => {
  // regression: the gate was `wantsExecute(ctx) || flagStr(ctx,"confirm") === id`. `--dry-run`
  // only reached the LEFT arm, so a typed confirm ORed straight past the preview and the model
  // was really deleted. The right arm needed the same guard — hence the shared `isPreviewRun`.
  const { deps, calls } = fake({ ok: true, removed_count: 1 });
  const out = await runModelCommand(
    ctxFor(["model", "rm", "acme/demo", "--confirm", "acme/demo", "--dry-run"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status?: string }).status, "preview");
  assert.deepEqual(calls, [], "the sidecar must never be called under --dry-run");
});

test("model rm --yes --dry-run: dry-run outranks --yes here too", async () => {
  const { deps, calls } = fake({ ok: true, removed_count: 1 });
  const out = await runModelCommand(
    ctxFor(["model", "rm", "acme/demo", "--yes", "--dry-run"]),
    deps,
  );
  assert.equal((out.json as { status?: string }).status, "preview");
  assert.deepEqual(calls, []);
});

test("model card <unknown-id>: exit 1 with an error field — never ok:false at exit 0", async () => {
  // regression: it returned `{ok:false, id, url:null}` with exitCode 0 and no `error` — three
  // contradictions at once. A script reading `$?` saw success; one reading `.error` found
  // nothing; `ok` said it had failed. Measured against the built binary.
  const { deps } = fake({ ok: true, results: [] });
  const out = await runModelCommand(ctxFor(["model", "card", "zzz-not-a-model", "--json"]), deps);
  assert.equal(out.exitCode, 1, "bad-args/not-found is class 1 (CLI-084); 2 is a security block");
  const json = out.json as { ok: boolean; error?: string; hint?: string };
  assert.equal(json.ok, false);
  assert.equal(json.error, "unknown-model");
  assert.equal(json.hint, "model search");
});

test("model card: a catalogued id with no repo is a DIFFERENT error from an unknown id", async () => {
  // the two were collapsed into one message; telling a user to `model search` for an id that IS
  // in the catalog would send them after something they already have.
  const { deps } = fake({ ok: true, results: [{ id: "known-model", name: "Known" }] });
  const out = await runModelCommand(ctxFor(["model", "card", "known-model", "--json"]), deps);
  assert.equal(out.exitCode, 1);
  assert.equal((out.json as { error?: string }).error, "no-model-card");
});
