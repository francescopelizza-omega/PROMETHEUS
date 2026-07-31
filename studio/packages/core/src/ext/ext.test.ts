/**
 * ext.test.ts — manifest validation + semver + permissions + install plan + context.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { type ExtensionBackends, createExtensionContext } from "./context.js";
import { activationEvents } from "./host.js";
import { isPlanError, permissionSummary, planInstall } from "./loader.js";
import { isCompatible, parseManifest, semverSatisfies, validateManifest } from "./manifest.js";
import { buildCapabilities, networkHostAllowed } from "./permissions.js";
import type { ExtensionManifest } from "./types.js";

const GOOD = {
  schema: "extension@1",
  id: "acme.csv-lens",
  label: "CSV Lens",
  version: "0.3.1",
  publisher: "acme",
  engines: { studio: ">=1.0.0" },
  main: "./dist/extension.js",
  ui: {
    panels: [
      { id: "csvLens", title: "CSV Lens", location: "secondary-sidebar", entry: "./dist/panel.js" },
    ],
  },
  contributes: {
    commands: [{ id: "csvLens.open", title: "Open CSV Lens", category: "Data" }],
    themes: [{ id: "acme-noir", label: "Acme Noir", base: "dark", path: "./themes/noir.json" }],
    agents: [{ path: "./agents/cleaner.agent.json" }],
  },
  permissions: {
    fs: { read: ["${workspace}/**"], write: [] },
    network: "none",
    engine: ["list", "info"],
    secrets: ["acme.apiKey"],
    shell: false,
  },
  repo: "acme/csv-lens",
  license: "MIT",
};

test("validateManifest: accepts a §5.1 manifest; rejects malformed (fail-soft null)", () => {
  const m = validateManifest(GOOD);
  assert.ok(m);
  assert.equal(m?.id, "acme.csv-lens");
  assert.equal(m?.ui?.panels?.[0]?.location, "secondary-sidebar");
  assert.equal(m?.contributes?.agents?.[0]?.path, "./agents/cleaner.agent.json");
  assert.equal(m?.permissions?.engine?.length, 2);

  assert.equal(validateManifest({ ...GOOD, schema: "nope" }), null);
  assert.equal(validateManifest({ ...GOOD, id: "Bad Id!" }), null);
  assert.equal(validateManifest({ ...GOOD, version: "1.0" }), null);
  assert.equal(validateManifest({ ...GOOD, label: "" }), null);
  assert.equal(parseManifest("{not json"), null);
  assert.ok(parseManifest(JSON.stringify(GOOD)));
});

test("semver subset + engines.studio compat", () => {
  assert.equal(semverSatisfies("1.2.3", ">=1.0.0"), true);
  assert.equal(semverSatisfies("0.9.0", ">=1.0.0"), false);
  assert.equal(semverSatisfies("1.5.0", "^1.0.0"), true);
  assert.equal(semverSatisfies("2.0.0", "^1.0.0"), false);
  assert.equal(semverSatisfies("1.0.0", "1.0.0"), true);
  assert.equal(semverSatisfies("1.0.1", ">1.0.0"), true);
  const m = validateManifest(GOOD) as ExtensionManifest;
  assert.equal(isCompatible(m, "1.4.0"), true);
  assert.equal(isCompatible(m, "0.5.0"), false);
});

test("buildCapabilities: default-deny; granted allows", () => {
  const m = validateManifest(GOOD) as ExtensionManifest;
  const caps = buildCapabilities(m.permissions);
  assert.equal(caps.engineAllowed("list"), true);
  assert.equal(caps.engineAllowed("install"), false); // not granted
  assert.equal(caps.secretAllowed("acme.apiKey"), true);
  assert.equal(caps.secretAllowed("other"), false);
  assert.equal(caps.fsReadAllowed("/w/data.csv", ["${workspace}/**"].length ? "/w" : "/w"), true);
  assert.equal(caps.fsWriteAllowed("/w/out.csv", "/w"), false); // write allowlist empty
  assert.equal(caps.network, "none");
  // default-deny when no permissions at all
  const none = buildCapabilities(undefined);
  assert.equal(none.engineAllowed("list"), false);
  assert.equal(none.fsReadAllowed("/w/a", "/w"), false);
  assert.equal(networkHostAllowed(["api.acme.com"], "api.acme.com"), true);
  assert.equal(networkHostAllowed("mcp-only", "api.acme.com"), false);
});

test("permissionSummary + planInstall (path, gate target, compat error)", () => {
  const m = validateManifest(GOOD) as ExtensionManifest;
  const summary = permissionSummary(m.permissions);
  assert.ok(summary.some((l) => l.includes("Read files")));
  assert.ok(summary.some((l) => l.includes("Network: none")));
  assert.deepEqual(permissionSummary(undefined), ["No special permissions requested."]);

  const plan = planInstall(m, {
    extensionsDir: "/home/.prometheus-studio/extensions",
    stagingDir: "/tmp/stage",
    studioVersion: "1.2.0",
  });
  assert.equal(isPlanError(plan), false);
  if (!isPlanError(plan)) {
    assert.equal(plan.installPath, "/home/.prometheus-studio/extensions/acme.csv-lens");
    assert.equal(plan.gateTarget, "acme/csv-lens"); // repo wins
  }
  // no repo → gate the staging dir
  const noRepo = { ...m, repo: undefined };
  const plan2 = planInstall(noRepo, { extensionsDir: "/e", stagingDir: "/tmp/stage" });
  assert.equal(isPlanError(plan2) ? "" : plan2.gateTarget, "/tmp/stage");
  // incompatible studio version → error
  const bad = planInstall(m, { extensionsDir: "/e", stagingDir: "/s", studioVersion: "0.5.0" });
  assert.equal(isPlanError(bad), true);
});

test("createExtensionContext enforces the permission boundary", async () => {
  const m = validateManifest(GOOD) as ExtensionManifest;
  const caps = buildCapabilities(m.permissions);
  const engineCalls: string[][] = [];
  const backends: ExtensionBackends = {
    commands: { register: () => ({ dispose() {} }), execute: async () => undefined },
    ui: { showPanel: () => {}, notify: () => {} },
    workspace: { rootUri: "/w", readFile: async () => new Uint8Array() },
    engine: {
      run: async (argv) => {
        engineCalls.push(argv);
        return { ok: true };
      },
    },
    mcp: { listServers: () => [], callTool: async () => undefined },
    secrets: { get: async () => "secret-value", store: async () => undefined },
  };
  const ctx = createExtensionContext(backends, caps);

  // allowed engine subcommand passes through
  await ctx.engine.run(["list"]);
  assert.deepEqual(engineCalls[0], ["list"]);
  // disallowed engine subcommand rejects before the backend
  await assert.rejects(() => ctx.engine.run(["install", "x"]), /denied/);
  assert.equal(engineCalls.length, 1);
  // allowed secret passes; disallowed rejects
  assert.equal(await ctx.secrets.get("acme.apiKey"), "secret-value");
  await assert.rejects(() => ctx.secrets.get("other.key"), /denied/);
  // fs read inside allowlist passes; outside rejects
  await ctx.workspace.readFile("/w/data.csv");
  await assert.rejects(() => ctx.workspace.readFile("/etc/passwd"), /denied/);
});

test("activationEvents from contributions", () => {
  const m = validateManifest(GOOD) as ExtensionManifest;
  const events = activationEvents(m);
  assert.ok(events.some((e) => e.kind === "onCommand" && e.command === "csvLens.open"));
  assert.ok(events.some((e) => e.kind === "onView" && e.viewId === "csvLens"));
  assert.ok(events.some((e) => e.kind === "onAgentRun"));
});
