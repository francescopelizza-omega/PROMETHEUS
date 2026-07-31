/**
 * slash-exec.test.ts — the P4 in-session slash router (node:test, source import).
 *
 * Deterministic + dependency-free: the engine/verb runner and the pane projector
 * are injected as fakes, so nothing spawns python or touches the network. We assert
 * each routing branch against the REAL core repl registry (tuning / pane / verb /
 * control / unknown) plus the crash-safe + parity invariants.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { repl, agent } from "@prometheus/core";

import { setColorEnabled } from "../render.js";
import { type SessionCtx, type SlashResult, execSlash } from "./slash-exec.js";

// Color off → assertions match on plain text (no ANSI escapes to strip).
setColorEnabled(false);

const MODEL = { provider: "anthropic", modelId: "claude-opus" };

/** Build a SessionCtx with capture buffers + optionally wired execVerb/renderPane. */
function makeCtx(overrides: Partial<SessionCtx> = {}): {
  ctx: SessionCtx;
  verbCalls: string[][];
  paneCalls: string[];
  writes: string[];
} {
  const verbCalls: string[][] = [];
  const paneCalls: string[] = [];
  const writes: string[] = [];
  const state = repl.initialReplState(agent.defaultTuning(MODEL), "/tmp/work");
  const ctx: SessionCtx = {
    state,
    json: false,
    write: (t) => writes.push(t),
    execVerb: async (tokens) => {
      verbCalls.push(tokens);
      return { text: `ran ${tokens.join(" ")}`, json: { ok: true }, exitCode: 0 };
    },
    renderPane: (pane) => {
      paneCalls.push(pane);
      return `[pane:${pane}]`;
    },
    ...overrides,
  };
  return { ctx, verbCalls, paneCalls, writes };
}

test("unknown slash → friendly error, never throws", async () => {
  const { ctx } = makeCtx();
  const r = await execSlash("totally-bogus", "", ctx);
  assert.equal(r.kind, "error");
  assert.match(
    (r as Extract<SlashResult, { kind: "error" }>).text,
    /unknown command: \/totally-bogus/,
  );
  assert.match((r as Extract<SlashResult, { kind: "error" }>).text, /\/help/);
});

test("brief-only aliases (/security /agentic /tmux) are unknown to the real registry", async () => {
  const { ctx } = makeCtx();
  for (const name of ["security", "health", "logs", "agentic", "terminal", "tmux", "metadata"]) {
    const r = await execSlash(name, "", ctx);
    assert.equal(r.kind, "error", `${name} should be unknown`);
  }
});

test("tuning slash /gate enforce → tune result with refreshed footer", async () => {
  const { ctx } = makeCtx();
  const r = await execSlash("gate", "warn", ctx);
  assert.equal(r.kind, "tune");
  const tr = r as Extract<SlashResult, { kind: "tune" }>;
  assert.deepEqual(tr.patch, { gateMode: "warn" });
  // footer is rendered against the NEW tuning (gate:warn), not the old one.
  assert.match(tr.footer, /gate:warn/);
});

test("tuning slash /model <id> sets the model patch", async () => {
  const { ctx } = makeCtx();
  const r = await execSlash("model", "ollama:qwen3:8b", ctx);
  assert.equal(r.kind, "tune");
  const tr = r as Extract<SlashResult, { kind: "tune" }>;
  assert.equal((tr.patch.model as { modelId: string }).modelId, "qwen3:8b");
  assert.match(tr.footer, /ollama:qwen3:8b/);
});

test("/model with no arg falls through to the model PANE", async () => {
  const { ctx, paneCalls } = makeCtx();
  const r = await execSlash("model", "", ctx);
  assert.equal(r.kind, "pane");
  assert.equal((r as Extract<SlashResult, { kind: "pane" }>).pane, "model");
  assert.deepEqual(paneCalls, ["model"]);
});

test("/tools on|off tune, /tools list is a view (verb-style outcome)", async () => {
  const { ctx } = makeCtx();
  const on = await execSlash("tools", "off", ctx);
  assert.equal(on.kind, "tune");
  assert.deepEqual((on as Extract<SlashResult, { kind: "tune" }>).patch, {
    tools: { ...ctx.state.tuning.tools, enabled: false },
  });
  const list = await execSlash("tools", "list", ctx);
  assert.equal(list.kind, "verb");
  assert.equal((list as Extract<SlashResult, { kind: "verb" }>).outcome.exitCode, 0);
});

test("invalid tuning value → usage hint (not a silent no-op)", async () => {
  const { ctx } = makeCtx();
  const r = await execSlash("gate", "banana", ctx);
  assert.equal(r.kind, "error");
  assert.match((r as Extract<SlashResult, { kind: "error" }>).text, /usage: \/gate/);
});

test("pane slashes switch + render via the injected projector", async () => {
  const { ctx, paneCalls } = makeCtx();
  // superscan + doctor map onto known PaneIds (scan); the rest are 1:1.
  const cases: Array<[string, string]> = [
    ["scan", "scan"],
    ["superscan", "scan"],
    ["matrix", "matrix"],
    ["doctor", "scan"],
    ["env", "env"],
    ["repo", "repo"],
    ["app", "app"],
    ["worldsim", "worldsim"],
    ["vault", "vault"],
    ["skills", "skills"],
  ];
  for (const [slash, pane] of cases) {
    const r = await execSlash(slash, "", ctx);
    assert.equal(r.kind, "pane", `${slash} should be a pane`);
    assert.equal((r as Extract<SlashResult, { kind: "pane" }>).pane, pane);
  }
  assert.deepEqual(
    paneCalls,
    cases.map(([, p]) => p),
  );
});

test("verb slashes (/secure /install /uninstall) route to execVerb with argv", async () => {
  const { ctx, verbCalls } = makeCtx();
  const r = await execSlash("install", "rust-analyzer --dry-run", ctx);
  assert.equal(r.kind, "verb");
  assert.equal((r as Extract<SlashResult, { kind: "verb" }>).outcome.exitCode, 0);
  assert.deepEqual(verbCalls, [["install", "rust-analyzer", "--dry-run"]]);

  await execSlash("secure", "./pkg", ctx);
  await execSlash("uninstall", "foo", ctx);
  // /secure maps onto the registry's `gate` verb (slash name != CommandSpec id).
  assert.deepEqual(verbCalls[1], ["gate", "./pkg"]);
  assert.deepEqual(verbCalls[2], ["uninstall", "foo"]);
});

test("control slashes (/clear /quit /save /resume /cwd) surface as controls", async () => {
  const { ctx } = makeCtx();
  for (const [name, rest] of [
    ["clear", ""],
    ["quit", ""],
    ["save", "out.jsonl"],
    ["resume", ""],
    ["cwd", "/tmp/x"],
  ] as Array<[string, string]>) {
    const r = await execSlash(name, rest, ctx);
    assert.equal(r.kind, "control", `${name} should be a control`);
    const cr = r as Extract<SlashResult, { kind: "control" }>;
    assert.equal(cr.control, name);
    assert.equal(cr.rest, rest);
  }
});

test("/profile <name> is a control (whole-profile swap), bare /profile is usage", async () => {
  const { ctx } = makeCtx();
  const ok = await execSlash("profile", "ci", ctx);
  assert.equal(ok.kind, "control");
  const cr = ok as Extract<SlashResult, { kind: "control" }>;
  assert.equal(cr.control, "profile");
  assert.equal(cr.rest, "ci");

  const bare = await execSlash("profile", "", ctx);
  assert.equal(bare.kind, "error");
  assert.match((bare as Extract<SlashResult, { kind: "error" }>).text, /usage: \/profile/);
});

test("/help renders the real slash palette (every SLASH_COMMANDS entry)", async () => {
  const { ctx } = makeCtx();
  const r = await execSlash("help", "", ctx);
  assert.equal(r.kind, "verb");
  const outcome = (r as Extract<SlashResult, { kind: "verb" }>).outcome;
  assert.equal(outcome.exitCode, 0);
  const text = outcome.text ?? "";
  // a representative sample from the registry must appear.
  for (const name of ["help", "scan", "install", "gate", "quit"]) {
    assert.ok(text.includes(`/${name}`), `palette should list /${name}`);
  }
  // machine channel lists ALL commands.
  const json = outcome.json as { slashes: Array<{ name: string }> };
  assert.equal(json.slashes.length, repl.SLASH_COMMANDS.length);
});

test("crash-safe: a throwing execVerb becomes a friendly error, not a stack", async () => {
  const { ctx } = makeCtx({
    execVerb: async () => {
      throw new Error("engine exploded");
    },
  });
  const r = await execSlash("install", "boom", ctx);
  assert.equal(r.kind, "error");
  assert.match((r as Extract<SlashResult, { kind: "error" }>).text, /install: engine exploded/);
});

test("crash-safe: a throwing renderPane downgrades to an inline notice", async () => {
  const { ctx } = makeCtx({
    renderPane: () => {
      throw new Error("pane broke");
    },
  });
  const r = await execSlash("matrix", "", ctx);
  assert.equal(r.kind, "pane");
  assert.match((r as Extract<SlashResult, { kind: "pane" }>).text, /matrix pane unavailable/);
});

test("optional deps: missing execVerb / renderPane degrade gracefully", async () => {
  const state = repl.initialReplState(agent.defaultTuning(MODEL), "/tmp/work");
  const ctx: SessionCtx = { state, json: false, write: () => {} };
  const verb = await execSlash("install", "x", ctx);
  assert.equal(verb.kind, "error");
  assert.match((verb as Extract<SlashResult, { kind: "error" }>).text, /not wired yet/);
  const pane = await execSlash("matrix", "", ctx);
  assert.equal(pane.kind, "pane");
});

test("parity: every verb-slash name is a registry verb id (no invented verbs)", async () => {
  // The slashes we route to execVerb must each be a real CommandSpec id, so the
  // session reaches the SAME run() the GUI/CLI use (structural parity, C5).
  // (Imported lazily to keep the registry assertion close to the routing intent.)
  const { getCommandSpec } = await import("@prometheus/core");
  // slash name → registry verb id (the `/secure` slash maps onto the `gate` verb).
  const nameToId: Record<string, string> = {
    secure: "gate",
    install: "install",
    uninstall: "uninstall",
  };
  for (const [name, id] of Object.entries(nameToId)) {
    assert.ok(repl.knownSlash(name), `/${name} must be a known slash`);
    assert.ok(getCommandSpec(id), `${id} must be a CommandSpec id`);
  }
});
