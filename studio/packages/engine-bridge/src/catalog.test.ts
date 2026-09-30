import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * catalog.test.ts — the catalog READ client (file 06 §4.2):
 *
 *   1) LIVE JSON reads (REAL prometheus.py): list/matrix/where/info/skillsList/vaultStatus
 *      really emit one JSON envelope and parse into the typed shapes the GUI projects
 *      (catalog rows, reach matrix, where targets, plugin detail, skills, vault). These
 *      are the engine catalog GROUND TRUTH, verified live (file 06 ENV-LIMIT note).
 *   2) LIVE human-table reads (REAL prometheus.py): appsList/worldsimList/modelsList/
 *      inventory/localaiAudit print TABLES (no JSON envelope today), so rawEngine returns
 *      ok:true + stdout lines — proving the passthrough genuinely runs the engine.
 *   3) ARGV CONTRACT (echo fixture): audit()'s --strict/--gate-fresh are GLOBAL flags and
 *      precede the "audit" subcommand (C2). No state changes anywhere here (reads only).
 *
 * Skips gracefully when the engine is absent.
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { type CatalogClient, createCatalogClient } from "./catalog.js";
import type { EngineConfig } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO = join(HERE, "__fixtures__", "echo-argv-engine.mjs");
// the REAL engine at the sibling PROMETHEUS root (…/studio/packages/engine-bridge/src -> up 4).
const REAL_ENGINE = join(HERE, "..", "..", "..", "..", "prometheus.py");

function engineExists(): string | undefined {
  return existsSync(REAL_ENGINE) ? REAL_ENGINE : undefined;
}

function liveClient(): CatalogClient {
  return createCatalogClient({ timeoutMs: 120_000 });
}

function echoClient(): CatalogClient {
  const config: EngineConfig = { pythonBin: process.execPath, prometheusPy: ECHO };
  return createCatalogClient({ config });
}

function argvOf(env: { argvEcho?: unknown }): string[] {
  assert.ok(Array.isArray(env.argvEcho), "the echo fixture must return argvEcho[]");
  return (env.argvEcho as unknown[]).map(String);
}

test("list() LIVE returns the six-registry catalog + detected agents", async (t) => {
  if (!engineExists()) {
    t.skip("prometheus.py not present");
    return;
  }
  const env = await liveClient().list();
  assert.equal(env.command, "list");
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.catalog), "catalog[] rides back");
  assert.ok((env.catalog as unknown[]).length >= 1, "the registry is non-empty");
  assert.ok(Array.isArray(env.detected_agents), "detected_agents[] rides back");
  // every catalog row carries the Plugin-projection fields the card renders.
  const first = (env.catalog as Record<string, unknown>[])[0];
  assert.equal(typeof first?.name, "string");
  assert.equal(typeof first?.tier, "string");
});

test("matrix() LIVE returns per-agent reach rows", async (t) => {
  if (!engineExists()) {
    t.skip("prometheus.py not present");
    return;
  }
  const env = await liveClient().matrix();
  assert.equal(env.command, "matrix");
  assert.ok(Array.isArray(env.agents), "agents[] (the columns)");
  assert.ok(Array.isArray(env.reach), "reach[] (the rows)");
  const row = (env.reach as Record<string, unknown>[])[0];
  if (row) {
    assert.equal(typeof row.plugin, "string");
    assert.equal(typeof row.scope, "string");
    assert.ok(Array.isArray(row.native), "native[] reach");
    assert.ok(Array.isArray(row.sync), "sync[] reach");
  }
});

test("info()/where() LIVE return plugin detail + per-target destinations", async (t) => {
  const engine = engineExists();
  if (!engine) {
    t.skip("prometheus.py not present");
    return;
  }
  const client = liveClient();
  // pick a real plugin name from the live catalog so the test is self-grounding.
  const listEnv = await client.list();
  const rows = (listEnv.catalog as Record<string, unknown>[]) ?? [];
  const name = String(rows[0]?.name ?? "");
  assert.ok(name, "a plugin name from the live catalog");

  const info = await client.info(name);
  assert.equal(info.command, "info");
  assert.ok(info.plugin && typeof info.plugin === "object", "plugin detail rides back");

  const where = await client.where(name);
  assert.equal(where.command, "where");
  const plugin = where.plugin as Record<string, unknown> | undefined;
  assert.ok(plugin && Array.isArray(plugin.targets), "where targets[] rides back");
});

test("skillsList()/vaultStatus() LIVE return JSON envelopes", async (t) => {
  if (!engineExists()) {
    t.skip("prometheus.py not present");
    return;
  }
  const client = liveClient();
  const skills = await client.skillsList();
  assert.equal(skills.command, "skills");
  assert.equal(skills.action, "list");
  assert.ok(Array.isArray(skills.skills), "skills[] rides back (may be empty)");

  const vault = await client.vaultStatus();
  assert.equal(vault.command, "vault");
  assert.ok("repos" in vault, "vault status carries repos[]");
});

test("appsList()/worldsimList()/modelsList()/inventory() LIVE return DISPLAY lines, never a JSON blob", async (t) => {
  if (!engineExists()) {
    t.skip("prometheus.py not present");
    return;
  }
  /**
   * `Array.isArray(res.lines)` — all this used to assert — is satisfied by the single-element
   * array holding an entire serialized JSON envelope, which is precisely what these reads
   * started returning once the engine grew `{command, action, lines:[…]}` envelopes for
   * `models list` / `apps list` / `inventory`. Studio rendered that blob verbatim in its
   * catalog panes and the suite stayed green. The assertions below are the ones that would
   * have caught it: real row COUNT, and no row that is itself an envelope.
   */
  const client = liveClient();
  for (const res of [
    await client.appsList(),
    await client.worldsimList(),
    await client.modelsList(),
    await client.inventory(),
  ]) {
    assert.equal(res.ok, true, `the engine ran (${res.command}): ${res.error ?? ""}`);
    assert.ok(res.engine, "the engine path that ran is reported");
    assert.ok(
      res.lines.length > 1,
      `${res.command}: a catalog read must produce many display rows, got ${res.lines.length} — one row means the JSON envelope was rendered as a single line`,
    );
    for (const line of res.lines) {
      assert.ok(
        !line.trimStart().startsWith('{"'),
        `${res.command}: a display row must not be a JSON envelope — got ${line.slice(0, 80)}`,
      );
    }
  }
});

test("localaiAudit() LIVE runs the billing audit passthrough", async (t) => {
  if (!engineExists()) {
    t.skip("prometheus.py not present");
    return;
  }
  const res = await liveClient().localaiAudit();
  // the engine ran; the audit prints a table (no JSON), so lines come back.
  assert.equal(res.command, "localai");
  assert.equal(res.action, "audit");
  assert.equal(res.ok, true, res.error ?? "");
});

test("audit() puts --strict / --gate-fresh BEFORE the subcommand (global flags, C2)", async () => {
  const plain = argvOf(await echoClient().audit("caveman"));
  assert.deepEqual(plain, ["audit", "caveman"]);

  const strict = argvOf(await echoClient().audit("caveman", { strict: true, gateFresh: true }));
  assert.deepEqual(strict, ["--strict", "--gate-fresh", "audit", "caveman"]);
});

test("status('all') and superscan() build the read argv", async () => {
  const c = echoClient();
  assert.deepEqual(argvOf(await c.status("all")), ["status", "all"]);
  assert.deepEqual(argvOf(await c.status("caveman")), ["status", "caveman"]);
  assert.deepEqual(argvOf(await c.superscan()), ["superscan"]);
});

test("rawEngine fail-closes to ok:false when the engine binary is absent", async () => {
  // a bogus engine path can never run → the human-table passthrough returns ok:false
  // with an error (never a silent success). No security decision is made here (C5).
  const client = createCatalogClient({
    config: { prometheusPy: "/tmp/__no_such_prometheus_xyz__.py" },
    timeoutMs: 10_000,
  });
  const res = await client.appsList();
  assert.equal(res.ok, false);
  assert.ok(res.error?.includes("not found"), "the missing-engine error is surfaced");
  assert.deepEqual(res.lines, []);
});
