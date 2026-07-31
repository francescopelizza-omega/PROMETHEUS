/**
 * demos-wizard.test.ts — detection, default-topology proposal, custom-spec parsing, roundtrip.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";

import {
  type CliStatus,
  classifyHttpFailure,
  classifyReadiness,
  detectClis,
  parseTopologySpec,
  proposeTopology,
  readinessLine,
  topologyToSpec,
} from "./demos-wizard.js";
import { RECIPE_SERVICES, requirementsFor } from "./recipes.js";
import type { CaptureResult } from "./spawn-capture.js";

const ready = (service: string): CliStatus => ({
  service,
  bin: service,
  installed: true,
  authed: true,
  note: "",
});

test("detectClis probes PATH + auth", async () => {
  const onPath = new Set(["claude", "gemini"]);
  const spawn = async (): Promise<CaptureResult> => ({
    code: 0,
    signal: null,
    stdout: "Logged in",
    stderr: "",
    outcome: "ok",
  });
  const statuses = await detectClis({ which: (b) => onPath.has(b), spawn });
  const claude = statuses.find((s) => s.service === "claude");
  const codex = statuses.find((s) => s.service === "codex");
  assert.equal(claude?.installed, true);
  assert.equal(claude?.authed, true); // probe returned ok
  assert.equal(codex?.installed, false);
});

test("proposeTopology: claude orchestrates, other authed CLIs become specialist children", () => {
  const t = proposeTopology([ready("claude"), ready("codex"), ready("gemini")]);
  assert.equal(t.orchestrator, "claude");
  const lead = t.agents.find((a) => a.name === "claude");
  assert.deepEqual(lead?.children?.sort(), ["codex", "gemini"]);
  assert.equal(t.agents.find((a) => a.name === "codex")?.backend.service, "codex");
  assert.equal(orch.validateTopology(t).ok, true);
});

test("proposeTopology: no CLIs but local models → a local swarm", () => {
  const t = proposeTopology([], ["qwen2.5", "llama3"]);
  assert.equal(t.orchestrator, "local");
  assert.ok(t.agents.length >= 2);
  assert.equal(t.agents[0]?.backend.kind, "local");
});

test("proposeTopology: nothing detected → a fake dry-run orchestrator", () => {
  const t = proposeTopology([], []);
  assert.equal(t.agents.length, 1);
  assert.equal(t.agents[0]?.backend.kind, "fake");
  assert.equal(orch.validateTopology(t).ok, true);
});

test("parseTopologySpec parses the agent-per-line DSL", () => {
  const spec = [
    "lead = claude : orchestrate -> api, ui",
    "api = codex : backend code",
    "ui = local:qwen2.5 : frontend",
    "# a comment is skipped",
  ].join("\n");
  const t = parseTopologySpec(spec);
  assert.equal(t.orchestrator, "lead");
  assert.equal(t.agents.length, 3);
  assert.deepEqual(t.agents.find((a) => a.name === "lead")?.children, ["api", "ui"]);
  assert.deepEqual(t.agents.find((a) => a.name === "ui")?.backend, {
    kind: "local",
    model: "qwen2.5",
  });
  assert.equal(orch.validateTopology(t).ok, true);
});

test("topologyToSpec round-trips through parseTopologySpec", () => {
  const t = proposeTopology([ready("claude"), ready("codex")]);
  const spec = topologyToSpec(t);
  const t2 = parseTopologySpec(spec);
  assert.equal(t2.orchestrator, t.orchestrator);
  assert.deepEqual(t2.agents.map((a) => a.name).sort(), t.agents.map((a) => a.name).sort());
});

// ── CLI-071: readiness classification ────────────────────────────────────────────
const st = (over: Partial<CliStatus>): CliStatus => ({
  service: "x",
  bin: "x",
  installed: true,
  authed: true,
  note: "",
  ...over,
});

test("classifyReadiness: distinct cause+remedy per failure class (CLI-071)", () => {
  // missing binary → install remedy.
  const miss = classifyReadiness(
    st({ service: "claude", bin: "claude", installed: false }),
    requirementsFor("claude"),
  );
  assert.equal(miss.cause, "missing-binary");
  assert.match(miss.remedy ?? "", /claude-code/);
  // env-key backend, not authed → names the env var.
  const noKey = classifyReadiness(
    st({ service: "cursor", bin: "cursor-agent", authed: false }),
    requirementsFor("cursor"),
  );
  assert.equal(noKey.cause, "no-api-key");
  assert.match(noKey.detail ?? "", /CURSOR_API_KEY/);
  assert.match(noKey.remedy ?? "", /CURSOR_API_KEY/);
  // cli-login backend, not authed → login remedy.
  const noLogin = classifyReadiness(
    st({ service: "codex", bin: "codex", authed: false }),
    requirementsFor("codex"),
  );
  assert.equal(noLogin.cause, "not-logged-in");
  assert.match(noLogin.remedy ?? "", /codex login/);
  // ready.
  assert.equal(classifyReadiness(st({}), undefined).ready, true);
});

test("classifyHttpFailure: 401→invalid-key(env), 404→endpoint, ECONNREFUSED→unreachable (CLI-071)", () => {
  assert.equal(classifyHttpFailure(401, undefined, "OPENAI_API_KEY").cause, "invalid-key");
  assert.match(
    classifyHttpFailure(401, undefined, "OPENAI_API_KEY").remedy ?? "",
    /OPENAI_API_KEY/,
  );
  assert.equal(classifyHttpFailure(403, undefined).cause, "invalid-key");
  assert.equal(classifyHttpFailure(404, undefined).cause, "endpoint");
  assert.equal(classifyHttpFailure(undefined, "ECONNREFUSED").cause, "unreachable");
  assert.equal(classifyHttpFailure(200, undefined).ready, true); // success → ready
});

test("readinessLine format: ✓ ready / ✗ cause+remedy (CLI-071)", () => {
  assert.equal(readinessLine("codex", { ready: true }), "✓ codex — ready");
  const bad = readinessLine("cursor", {
    ready: false,
    detail: "no API key ($CURSOR_API_KEY unset)",
    remedy: "set $CURSOR_API_KEY",
  });
  assert.match(bad, /✗ cursor — cause: no API key.*remedy: set \$CURSOR_API_KEY/);
});

test("RECIPE_REQUIREMENTS parallels every recipe; bin matches the recipe (CLI-071)", () => {
  for (const service of RECIPE_SERVICES) {
    const req = requirementsFor(service);
    assert.ok(req, `requirements for ${service}`);
    assert.equal(typeof req?.install, "string");
    assert.ok(["env-key", "cli-login", "none"].includes(req?.authMode ?? ""));
  }
});
