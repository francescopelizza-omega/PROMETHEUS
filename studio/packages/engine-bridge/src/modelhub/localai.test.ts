import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * localai.test.ts — the LIVE `localai` engine passthrough (file 05 §6). These run the
 * REAL `prometheus.py --json localai <sub>` (the engine owns the open-model catalog +
 * repoint recipes). They skip gracefully when the engine is absent, and FAIL-CLOSED:
 * a bad sub still returns a structured {ok:false} result (never a throw).
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LOCALAI_CLIENT_VERSION,
  audit,
  endpoints,
  localai,
  models,
  projectLocalaiEnvelope,
  show,
} from "./localai.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// the sibling PROMETHEUS root holds prometheus.py (…/engine-bridge/src/modelhub -> up 5).
const ENGINE = join(HERE, "..", "..", "..", "..", "..", "prometheus.py");

test("localai.models() LIVE returns the open-model catalog envelope (REAL prometheus.py)", async (t) => {
  if (!existsSync(ENGINE)) {
    t.skip(`prometheus.py not present at ${ENGINE}`);
    return;
  }
  const res = await models({ timeoutMs: 90_000 });
  assert.equal(res.ok, true, `localai models ran: ${res.error ?? ""}`);
  assert.equal(res.sub, "models");
  assert.equal(res.version, 1, "the engine ships the v1 envelope (CLI-026)");
  assert.ok(typeof res.engine === "string" && res.engine.length > 0, "the engine path is reported");
  // the open-source-free catalog mentions the well-known open families (in the payload).
  const blob = JSON.stringify(res.payload).toLowerCase();
  assert.ok(/qwen3|gpt-oss|llama3|mistral|gemma3|deepseek/.test(blob), "open families are listed");
  // it surfaces served open-weight API endpoints too (OpenAI-compatible URLs).
  assert.ok(
    res.endpoints.some((e) => /^https?:\/\//.test(e.baseUrl)),
    "served open-weight API endpoints are projected",
  );
});

test("localai.endpoints() LIVE classifies local vs open-weight endpoints", async (t) => {
  if (!existsSync(ENGINE)) {
    t.skip(`prometheus.py not present at ${ENGINE}`);
    return;
  }
  const res = await endpoints({ timeoutMs: 90_000 });
  assert.equal(res.ok, true, `localai endpoints ran: ${res.error ?? ""}`);
  assert.equal(res.version, 1);
  assert.ok(res.endpoints.length >= 1, "endpoints are projected from the envelope");
  const local = res.endpoints.filter((e) => e.scope === "local");
  const open = res.endpoints.filter((e) => e.scope === "open-api");
  assert.ok(local.length >= 1, "at least one local server endpoint (ollama/llamacpp/vllm)");
  assert.ok(open.length >= 1, "at least one open-weight API endpoint");
  for (const e of local) {
    assert.match(e.baseUrl, /localhost|127\.0\.0\.1|host\.docker\.internal/);
  }
});

test("localai.show(ollama) LIVE returns the tool's billing envelope", async (t) => {
  if (!existsSync(ENGINE)) {
    t.skip(`prometheus.py not present at ${ENGINE}`);
    return;
  }
  const res = await show("ollama", { timeoutMs: 90_000 });
  assert.equal(res.ok, true, `localai show ollama ran: ${res.error ?? ""}`);
  assert.equal(res.version, 1);
  assert.equal((res.payload?.tool as { tool?: string } | undefined)?.tool, "ollama");
});

test("localai.audit() LIVE lists AI-using repos in the envelope", async (t) => {
  if (!existsSync(ENGINE)) {
    t.skip(`prometheus.py not present at ${ENGINE}`);
    return;
  }
  const res = await audit({ timeoutMs: 90_000 });
  assert.equal(res.ok, true, `localai audit ran: ${res.error ?? ""}`);
  assert.equal(res.version, 1);
  assert.ok(Array.isArray(res.payload?.tools) && (res.payload.tools as unknown[]).length >= 1);
});

// ── golden envelope projection (CLI-026) — pure, no spawn ─────────────────────

test("projectLocalaiEnvelope: endpoints v1 envelope → scoped endpoint list", () => {
  const env = {
    command: "localai",
    version: 1,
    action: "endpoints",
    ok: true,
    local: { ollama: "http://127.0.0.1:11434/v1", llamacpp: "http://localhost:8080/v1" },
    open: { groq: "https://api.groq.com/openai/v1", deepseek: "https://api.deepseek.com/v1" },
  };
  const r = projectLocalaiEnvelope("endpoints", env, ["human line"], "/eng/prometheus.py", "raw");
  assert.equal(r.ok, true);
  assert.equal(r.version, 1);
  assert.deepEqual(r.lines, ["human line"]); // lines come from the human channel now
  const local = r.endpoints.filter((e) => e.scope === "local").map((e) => e.name);
  const open = r.endpoints.filter((e) => e.scope === "open-api").map((e) => e.name);
  assert.deepEqual(local.sort(), ["llamacpp", "ollama"]);
  assert.deepEqual(open.sort(), ["deepseek", "groq"]);
  assert.equal(r.payload?.action, "endpoints");
});

test("projectLocalaiEnvelope: audit/models maps project to the right scopes", () => {
  const audit = projectLocalaiEnvelope(
    "audit",
    {
      command: "localai",
      version: 1,
      action: "audit",
      ok: true,
      local_endpoints: { ollama: "http://127.0.0.1:11434/v1" },
    },
    [],
    "/e",
    "",
  );
  assert.deepEqual(audit.endpoints, [
    { name: "ollama", baseUrl: "http://127.0.0.1:11434/v1", scope: "local" },
  ]);
  const models = projectLocalaiEnvelope(
    "models",
    {
      command: "localai",
      version: 1,
      action: "models",
      ok: true,
      open_endpoints: { groq: "https://api.groq.com/openai/v1" },
    },
    [],
    "/e",
    "",
  );
  assert.equal(models.endpoints[0]?.scope, "open-api");
});

test("projectLocalaiEnvelope: a newer envelope version yields a note, not a scrape", () => {
  const r = projectLocalaiEnvelope(
    "endpoints",
    {
      command: "localai",
      version: 2,
      action: "endpoints",
      ok: true,
      local: { ollama: "http://127.0.0.1:11434/v1" },
    },
    [],
    "/e",
    "",
  );
  assert.ok(r.note?.includes("newer than this client"));
  assert.equal(r.version, 2);
  assert.ok(r.endpoints.length >= 1, "still best-effort projects the known fields");
  assert.equal(LOCALAI_CLIENT_VERSION, 1);
});

test("projectLocalaiEnvelope: ok:false envelope carries the error through", () => {
  const r = projectLocalaiEnvelope(
    "show",
    { command: "localai", version: 1, action: "show", ok: false, error: "unknown AI tool: nope" },
    [],
    "/e",
    "",
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /unknown AI tool/);
});

test("localai() FAIL-CLOSED when the engine is missing (no throw)", async () => {
  // point at a non-existent engine → a structured {ok:false} result, NOT a throw.
  const res = await localai("models", [], {
    config: { prometheusPy: "/nonexistent/prometheus.py" },
    timeoutMs: 5_000,
  });
  assert.equal(res.ok, false, "a missing engine is ok:false");
  assert.ok(res.error?.includes("not found"), "the failure reason is surfaced");
  assert.deepEqual(res.lines, [], "no lines on failure");
});
