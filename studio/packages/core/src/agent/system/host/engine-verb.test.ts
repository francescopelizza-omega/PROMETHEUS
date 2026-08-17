/**
 * engine-verb.test.ts — the `prometheus_*` verbs, shared by both hosts.
 *
 * These were reachable only from the CLI: the desktop pane's allow-list excluded all 14 with a
 * comment saying it had no seam to the engine, so the GUI could not scan a machine, list what
 * was installed, or install anything — the product's own reason for existing.
 *
 * Two tests here are about the LIFT rather than the feature, and they are the ones that matter:
 * the verdict must survive the trip (a gate that stops firing is silent), and args must be
 * validated (the CLI skipped that, and `prometheus_install`'s schema default is a DRY RUN).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runEngineVerb, summarizeEnvelope, verdictFromEnvelope } from "./engine-verb.js";

/** A runner that records the argv it was handed and answers with a scripted envelope. */
function engine(env: Record<string, unknown> = { ok: true }): {
  run: (argv: string[]) => Promise<Record<string, unknown>>;
  argv: string[][];
} {
  const argv: string[][] = [];
  return {
    argv,
    run: async (a) => {
      argv.push(a);
      return env;
    },
  };
}

/* ── the argv comes from the tool, never the caller ────────────────────────*/

test("an install DEFAULTS TO A DRY RUN, because its schema says so", async () => {
  // THE bug this lift fixes. The CLI called `toArgv(args)` directly, so the schema was never
  // applied and `dryRun: true` — a declared default a reader would rely on — did nothing. An
  // agent asking to install something got a real install where the schema promised a rehearsal.
  const e = engine();
  await runEngineVerb("prometheus_install", { name: "claude" }, e.run);
  assert.deepEqual(e.argv[0], ["--dry-run", "install", "claude"]);
});

test("an explicit dryRun:false is honoured — the default is a default, not a lock", async () => {
  const e = engine();
  await runEngineVerb("prometheus_install", { name: "claude", dryRun: false, yes: true }, e.run);
  assert.deepEqual(e.argv[0], ["--yes", "install", "claude"]);
});

test("a missing required arg refuses before the engine is touched", async () => {
  const e = engine();
  const out = await runEngineVerb("prometheus_info", {}, e.run);
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /missing required arg "name"/);
  assert.equal(e.argv.length, 0);
});

test("an unknown name is NOT claimed, so the caller's next arm still gets it", () => {
  assert.equal(runEngineVerb("read_file", {}, engine().run), null);
});

/* ── the verdict must survive the trip ─────────────────────────────────────*/

test("forced_danger becomes a BLOCK verdict — the loop aborts the round on it", () => {
  // `forced_danger` means nemesis said block and the engine was forced through anyway. A host
  // that forgets to lift this does not fail loudly: the gate simply stops firing.
  assert.deepEqual(verdictFromEnvelope({ forced_danger: [{ verdict: "block", risk_score: 91 }] }), {
    verdict: "block",
    riskScore: 91,
  });
  // An unrecognised tier degrades to `block`, never to nothing.
  assert.deepEqual(verdictFromEnvelope({ forced_danger: [{}] }), { verdict: "block" });
});

test("forced_danger WINS over the envelope's own verdict", () => {
  const v = verdictFromEnvelope({
    forced_danger: [{ verdict: "error", risk_score: 70 }],
    verdict: { verdict: "allow", risk_score: 0 },
  });
  assert.deepEqual(v, { verdict: "error", riskScore: 70 });
});

test("a plain verdict envelope carries its tier through, and junk carries nothing", () => {
  assert.deepEqual(verdictFromEnvelope({ verdict: { verdict: "warn", risk_score: 30 } }), {
    verdict: "warn",
    riskScore: 30,
  });
  assert.equal(verdictFromEnvelope({ verdict: { verdict: "nonsense" } }), undefined);
  assert.equal(verdictFromEnvelope({}), undefined);
});

test("a verdict on the envelope reaches the OUTCOME, not just the helper", async () => {
  const out = await runEngineVerb(
    "prometheus_scan",
    {},
    engine({ ok: false, forced_danger: [{ verdict: "block", risk_score: 88 }] }).run,
  );
  assert.equal(out?.ok, false);
  assert.deepEqual(out?.verdict, { verdict: "block", riskScore: 88 });
});

/* ── failure is a refusal, never an invented success ───────────────────────*/

test("a throwing engine is a fail-closed refusal", async () => {
  const out = await runEngineVerb("prometheus_list", {}, async () => {
    throw new Error("prometheus.py not found");
  });
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /prometheus\.py not found/);
});

test("ok:false on the envelope is reported as a failure", async () => {
  const out = await runEngineVerb(
    "prometheus_list",
    {},
    engine({ ok: false, command: "list" }).run,
  );
  assert.equal(out?.ok, false);
  assert.equal(out?.summary, "list: failed");
});

test("the envelope's error text wins the summary when there is one", () => {
  assert.equal(summarizeEnvelope("prometheus_list", { error: "boom" }), "boom");
  assert.equal(summarizeEnvelope("prometheus_list", { ok: true, command: "list" }), "list: ok");
});

/* ── the trust boundary ────────────────────────────────────────────────────*/

test("a caller-supplied ToolDef is used; without one the name is looked up here", async () => {
  // Main holds only a NAME that arrived over IPC from a sandboxed renderer, so it passes no
  // ToolDef and the lookup happens in core. A caller that could supply its own `toArgv` could
  // choose the whole command line.
  const e = engine();
  const fake = {
    name: "prometheus_custom",
    title: "",
    description: "",
    schema: {},
    annotations: {},
    toArgv: () => ["custom", "--anything"],
  };
  await runEngineVerb("prometheus_custom", {}, e.run, { tool: fake });
  assert.deepEqual(e.argv[0], ["custom", "--anything"]);
  // The same name WITHOUT the def is not in the catalogue, so nothing runs.
  assert.equal(runEngineVerb("prometheus_custom", {}, e.run), null);
  assert.equal(e.argv.length, 1);
});
