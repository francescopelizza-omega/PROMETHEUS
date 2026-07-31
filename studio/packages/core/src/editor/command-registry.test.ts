/**
 * command-registry.test.ts — the EDITOR command registry (file 07 §8).
 *
 * Asserts: the always-present ids/categories, the `when` context-key evaluator
 * (bare keys, &&/||/!, parens, == / !=, fail-safe on garbage), the registry API
 * (register/get/list/byCategory/visible), and the load-bearing §8/§10 invariant:
 * the `prometheus.*` commands DELEGATE to the engine parity router (commands.ts)
 * rather than duplicating it — driven with a FAKE EngineClient (no real spawn).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { EngineClient, EngineEnvelope, RunOptions } from "@prometheus/engine-bridge";

import type { RouterContext } from "../commands.js";
import {
  EDITOR_COMMANDS,
  type EditorCommandCtx,
  EditorCommandRegistry,
  editorCommandsByCategory,
  evaluateWhen,
  getEditorCommand,
  listEditorCommands,
} from "./command-registry.js";

/* --- the `when` evaluator ------------------------------------------------ */

test("evaluateWhen: empty / undefined expression is always true", () => {
  assert.equal(evaluateWhen(undefined, {}), true);
  assert.equal(evaluateWhen("", {}), true);
  assert.equal(evaluateWhen("   ", {}), true);
});

test("evaluateWhen: a bare key reads its truthiness", () => {
  assert.equal(evaluateWhen("editorFocus", { editorFocus: true }), true);
  assert.equal(evaluateWhen("editorFocus", { editorFocus: false }), false);
  assert.equal(evaluateWhen("editorFocus", {}), false); // missing key = false
});

test("evaluateWhen: && / || / ! and parentheses", () => {
  const keys = { editorFocus: true, pythonFile: true, gitRepo: false };
  assert.equal(evaluateWhen("editorFocus && pythonFile", keys), true);
  assert.equal(evaluateWhen("editorFocus && gitRepo", keys), false);
  assert.equal(evaluateWhen("gitRepo || pythonFile", keys), true);
  assert.equal(evaluateWhen("!gitRepo", keys), true);
  assert.equal(evaluateWhen("!(editorFocus && gitRepo)", keys), true);
  assert.equal(evaluateWhen("(gitRepo || pythonFile) && editorFocus", keys), true);
});

test("evaluateWhen: == / != equality against a key's string value", () => {
  const keys = { resourceLangId: "python" };
  assert.equal(evaluateWhen("resourceLangId == python", keys), true);
  assert.equal(evaluateWhen("resourceLangId == 'python'", keys), true);
  assert.equal(evaluateWhen("resourceLangId != typescript", keys), true);
  assert.equal(evaluateWhen("resourceLangId == typescript", keys), false);
});

test("evaluateWhen: unparseable expression is fail-safe false", () => {
  assert.equal(evaluateWhen("&& ||", {}), false);
  assert.equal(evaluateWhen("editorFocus &&", {}), false);
  assert.equal(evaluateWhen("(unbalanced", {}), false);
});

/* --- registry shape ------------------------------------------------------ */

test("the always-present command ids are registered (file 07 §8)", () => {
  const ids = new Set(EDITOR_COMMANDS.map((c) => c.id));
  for (const id of [
    "ai.inlineEdit",
    "ai.openAgent",
    "gate.runWorkspaceScan",
    "gate.showLog",
    "python.selectInterpreter",
    "models.selectEndpoint",
    "git.commit",
    "debug.start",
    "search.findInFiles",
    "editor.action.formatDocument",
    "prometheus.scan",
    "prometheus.audit",
  ]) {
    assert.ok(ids.has(id), `missing command id: ${id}`);
  }
});

test("ai.inlineEdit binds Cmd-K with an AI category and editorFocus gate", () => {
  const cmd = getEditorCommand("ai.inlineEdit")!;
  assert.equal(cmd.default, "cmd+k");
  assert.equal(cmd.category, "AI");
  assert.equal(cmd.when, "editorFocus");
});

test("byCategory groups commands; every command has a known category", () => {
  const ai = editorCommandsByCategory("AI").map((c) => c.id);
  assert.ok(ai.includes("ai.inlineEdit"));
  assert.ok(ai.includes("ai.openAgent"));
  assert.ok(ai.includes("models.selectEndpoint"));
  const security = editorCommandsByCategory("Security").map((c) => c.id);
  assert.ok(security.includes("gate.runWorkspaceScan"));
  assert.ok(security.includes("prometheus.scan"));
});

test("listEditorCommands returns the frozen built-in surface", () => {
  assert.equal(listEditorCommands(), EDITOR_COMMANDS);
});

/* --- the registry API + `visible` filter --------------------------------- */

test("EditorCommandRegistry: register / get / list / byCategory / visible", () => {
  const reg = new EditorCommandRegistry();
  assert.ok(reg.get("ai.inlineEdit"));
  assert.equal(reg.get("nope"), undefined);
  assert.equal(reg.list().length, EDITOR_COMMANDS.length);

  // a custom command can be registered and shows up by category.
  reg.register({
    id: "custom.hello",
    title: "Hello",
    category: "View",
    when: "panelOpen",
    run: () => ({ id: "custom.hello", ok: true, summary: "hi" }),
  });
  assert.ok(reg.byCategory("View").some((c) => c.id === "custom.hello"));

  // visible() applies the `when` filter.
  const visibleNoPanel = reg.visible({ editorFocus: true });
  assert.ok(!visibleNoPanel.some((c) => c.id === "custom.hello")); // panelOpen falsey
  assert.ok(visibleNoPanel.some((c) => c.id === "ai.inlineEdit")); // editorFocus true
  const visibleWithPanel = reg.visible({ editorFocus: true, panelOpen: true });
  assert.ok(visibleWithPanel.some((c) => c.id === "custom.hello"));
});

test("EditorCommandRegistry.run throws on an unknown id", async () => {
  const reg = new EditorCommandRegistry();
  await assert.rejects(
    () => reg.run("does.not.exist", { contextKeys: {} }),
    /unknown editor command/,
  );
});

/* --- prometheus.* delegation to the engine router (§8/§10) --------------- */

interface Calls {
  scan: number;
  runPrometheus: string[][];
}

function makeFakeClient(): { client: EngineClient; calls: Calls } {
  const calls: Calls = { scan: 0, runPrometheus: [] };
  const env = (command: string, extra: Record<string, unknown> = {}): EngineEnvelope => ({
    command,
    ok: true,
    ...extra,
  });
  const notImpl = (name: string) => () => {
    throw new Error(`fake client: ${name} not implemented`);
  };
  const client: EngineClient = {
    scan: async (_opts?: RunOptions) => {
      calls.scan += 1;
      return env("scan", { agents: [{ name: "claude", present: true }] });
    },
    runPrometheus: (async (argv: string[], _opts?: RunOptions) => {
      calls.runPrometheus.push(argv);
      return env(argv.join(" "));
    }) as EngineClient["runPrometheus"],
    gate: notImpl("gate") as EngineClient["gate"],
    list: notImpl("list") as EngineClient["list"],
    info: notImpl("info") as EngineClient["info"],
    status: notImpl("status") as EngineClient["status"],
    matrix: notImpl("matrix") as EngineClient["matrix"],
    superscan: notImpl("superscan") as EngineClient["superscan"],
    where: notImpl("where") as EngineClient["where"],
    install: notImpl("install") as EngineClient["install"],
    uninstall: notImpl("uninstall") as EngineClient["uninstall"],
    enable: notImpl("enable") as EngineClient["enable"],
    disable: notImpl("disable") as EngineClient["disable"],
    vaultStatus: notImpl("vaultStatus") as EngineClient["vaultStatus"],
    runNemesis: notImpl("runNemesis") as EngineClient["runNemesis"],
    version: notImpl("version") as EngineClient["version"],
    capabilities: notImpl("capabilities") as EngineClient["capabilities"],
  };
  return { client, calls };
}

test("prometheus.scan delegates to the engine router (client.scan), not a duplicate", async () => {
  const { client, calls } = makeFakeClient();
  const reg = new EditorCommandRegistry();
  const engine: RouterContext = { client };
  const ctx: EditorCommandCtx = { contextKeys: {}, engine };
  const res = await reg.run("prometheus.scan", ctx);
  assert.equal(res.ok, true);
  assert.equal(calls.scan, 1); // routed THROUGH the engine spec's client.scan()
  assert.ok(res.engineResult, "engineResult should be threaded back");
  assert.equal(res.engineResult!.id, "scan");
});

test("prometheus.audit forwards its NAME positional to the engine router", async () => {
  const { client, calls } = makeFakeClient();
  const reg = new EditorCommandRegistry();
  const engine: RouterContext = { client };
  const ctx: EditorCommandCtx = { contextKeys: {}, engine, args: { name: "some-plugin" } };
  const res = await reg.run("prometheus.audit", ctx);
  assert.equal(res.ok, true);
  // audit is an engine prometheus.py subcommand -> runPrometheus(['audit','some-plugin']).
  assert.deepEqual(calls.runPrometheus.at(-1), ["audit", "some-plugin"]);
});

test("gate.runWorkspaceScan reports no-engine-context gracefully when unbound", async () => {
  const reg = new EditorCommandRegistry();
  const res = await reg.run("gate.runWorkspaceScan", { contextKeys: {} });
  assert.equal(res.ok, false);
  assert.match(res.summary, /no engine context bound/);
});

test("a UI command (ai.inlineEdit) runs without an engine and reports ok", async () => {
  const reg = new EditorCommandRegistry();
  const res = await reg.run("ai.inlineEdit", { contextKeys: { editorFocus: true } });
  assert.equal(res.ok, true);
  assert.match(res.summary, /inline-edit/);
});
