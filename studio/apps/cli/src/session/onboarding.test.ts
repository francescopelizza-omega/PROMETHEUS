/**
 * onboarding.test.ts — backend detection + the /setup wizard. Deterministic: a fake
 * fetch (local-runner probe), a fake EngineClient (scan), a scripted ask, and a fake
 * runChild — no network, no spawn, no engine.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EngineClient } from "@prometheus/engine-bridge";

import { ensureHomeTree, resolveCategory } from "../home.js";
import { setColorEnabled } from "../render.js";
import {
  backendSummary,
  buildLocalEndpoint,
  detectBackends,
  runPathsWizard,
  runSetup,
} from "./onboarding.js";

setColorEnabled(false);

/** A fake EngineClient whose scan reports the given installed agent CLIs. */
function fakeClient(present: string[] = []): EngineClient {
  return {
    runPrometheus: (async (argv: string[]) => {
      if (argv[0] === "scan") {
        return {
          agents: ["claude", "codex", "gemini", "cursor", "opencode", "windsurf"].map((name) => ({
            name,
            present: present.includes(name),
          })),
        };
      }
      return { ok: true };
    }) as EngineClient["runPrometheus"],
  } as unknown as EngineClient;
}

/** A fake fetch: maps a base URL → the served model ids (absent URL → throws/unreachable). */
function fakeFetch(serving: Record<string, string[]>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    for (const [base, models] of Object.entries(serving)) {
      if (u.startsWith(base)) {
        return {
          ok: true,
          json: async () => ({ data: models.map((id) => ({ id })) }),
        } as Response;
      }
    }
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

test("buildLocalEndpoint: maps a runner → an OpenAI-compatible local endpoint", () => {
  const ep = buildLocalEndpoint({
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    models: ["qwen2.5-coder:7b", "llama3.1:8b"],
  });
  assert.equal(ep.locality, "local");
  assert.equal(ep.baseUrl, "http://localhost:11434/v1");
  assert.equal(ep.model, "qwen2.5-coder:7b"); // first served model
  assert.equal(ep.supportsTools, true); // local OpenAI-compatible runners expose native tool_calls
});

test("detectBackends: a live ollama with a model → a ready local endpoint", async () => {
  const b = await detectBackends({
    client: fakeClient(["claude"]),
    fetchFn: fakeFetch({ "http://localhost:11434/v1": ["qwen2.5-coder:7b"] }),
  });
  assert.equal(b.localRunner?.name, "ollama");
  assert.equal(b.localEndpoint?.model, "qwen2.5-coder:7b");
  assert.deepEqual(b.paidClis, ["claude"]);
  assert.match(backendSummary(b), /local · qwen2.5-coder/);
});

test("detectBackends: no runner, paid CLIs present → no endpoint, summary points at /setup", async () => {
  const b = await detectBackends({
    client: fakeClient(["claude", "gemini"]),
    fetchFn: fakeFetch({}), // nothing serving
  });
  assert.equal(b.localEndpoint, undefined);
  assert.deepEqual(b.paidClis, ["claude", "gemini"]);
  assert.match(backendSummary(b), /paid CLI · claude\/gemini/);
});

test("detectBackends: nothing at all → 'no model — type /setup'", async () => {
  const b = await detectBackends({ client: fakeClient([]), fetchFn: fakeFetch({}) });
  assert.equal(b.localEndpoint, undefined);
  assert.deepEqual(b.paidClis, []);
  assert.match(backendSummary(b), /no model — type \/setup/);
});

/** A scripted ask: pops the next canned answer per question. */
function scriptedAsk(answers: string[]): (q: string) => Promise<string> {
  const q = [...answers];
  return async () => q.shift() ?? "";
}

test("runSetup: local branch pulls a model via ollama and adopts the endpoint", async () => {
  const out: string[] = [];
  const pulls: Array<[string, string[]]> = [];
  const r = await runSetup({
    client: fakeClient([]),
    write: (s) => out.push(s),
    // runner up but serving NO model → reaches the picker (not the early "ready" return).
    fetchFn: fakeFetch({ "http://localhost:11434/v1": [] }),
    ask: scriptedAsk(["1", "1", "y"]), // choose local → pick model #1 → confirm pull
    runChild: async (cmd, args) => {
      pulls.push([cmd, args]);
      return 0;
    },
  });
  assert.deepEqual(pulls, [["ollama", ["pull", "qwen2.5-coder:3b"]]]);
  assert.equal(r.endpoint?.model, "qwen2.5-coder:3b");
  assert.match(out.join("\n"), /pulled/);
});

test("runSetup: paid branch lists installed CLIs (no endpoint adopted)", async () => {
  const out: string[] = [];
  const r = await runSetup({
    client: fakeClient(["claude", "codex"]),
    write: (s) => out.push(s),
    fetchFn: fakeFetch({}),
    ask: scriptedAsk(["2"]),
  });
  assert.equal(r.endpoint, undefined);
  assert.match(out.join("\n"), /prom chat --cli claude --open/);
});

test("runSetup: choosing 0 skips cleanly (no endpoint, no spawn)", async () => {
  let spawned = false;
  const r = await runSetup({
    client: fakeClient([]),
    write: () => {},
    fetchFn: fakeFetch({}),
    ask: scriptedAsk(["0"]),
    runChild: async () => {
      spawned = true;
      return 0;
    },
  });
  assert.equal(r.endpoint, undefined);
  assert.equal(spawned, false);
});

test("runSetup: an already-ready local model is adopted without prompting", async () => {
  const r = await runSetup({
    client: fakeClient([]),
    write: () => {},
    fetchFn: fakeFetch({ "http://localhost:11434/v1": ["llama3.1:8b"] }),
    ask: async () => {
      throw new Error("should not ask when a model is already ready");
    },
  });
  assert.equal(r.endpoint?.model, "llama3.1:8b");
});

test("runSetup local: askPath repoints open_models, then pulls + adopts", async () => {
  const home = mkdtempSync(join(tmpdir(), "prom-setup-"));
  const pulls: Array<[string, string[]]> = [];
  const chosen = join(home, "big-disk", "models");
  const r = await runSetup({
    client: fakeClient([]),
    write: () => {},
    fetchFn: fakeFetch({ "http://localhost:11434/v1": [] }), // ollama up, no model → picker
    ask: scriptedAsk(["1", "1", "n", "y"]), // local → model#1 → don't keep folder → confirm pull
    askPath: async () => chosen,
    runChild: async (cmd, args) => {
      pulls.push([cmd, args]);
      return 0;
    },
    home,
  });
  assert.deepEqual(pulls, [["ollama", ["pull", "qwen2.5-coder:3b"]]]);
  assert.equal(r.endpoint?.model, "qwen2.5-coder:3b");
  assert.equal(resolveCategory("open_models", home), chosen); // override persisted
});

test("runPathsWizard: lists categories and repoints one via askPath", async () => {
  const home = mkdtempSync(join(tmpdir(), "prom-paths-"));
  ensureHomeTree(home);
  const out: string[] = [];
  const newDir = join(home, "movies");
  await runPathsWizard({
    client: fakeClient([]),
    write: (s) => out.push(s),
    ask: scriptedAsk(["1"]), // change category #1 (open_models)
    askPath: async () => newDir,
    home,
  });
  assert.equal(resolveCategory("open_models", home), newDir);
  assert.match(out.join("\n"), /Open LLM models/);
});
