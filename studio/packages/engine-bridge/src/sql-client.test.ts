/**
 * sql-client.test.ts — the sqlrunner.py marshaller (APP-041). An injected fake runner
 * records the argv the client builds (no python spawned) + the option-injection guard.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SidecarEnvelope } from "./sidecar-runner.js";
import { type SidecarRunner, createSqlClient } from "./sql-client.js";

function recorder(envelope: SidecarEnvelope = { ok: true, command: "x" }): {
  run: SidecarRunner;
  calls: { script: string; argv: string[] }[];
} {
  const calls: { script: string; argv: string[] }[] = [];
  const run = (async (script: "sqlrunner.py", argv: string[]) => {
    calls.push({ script, argv });
    return envelope;
  }) as SidecarRunner;
  return { run, calls };
}

test("connect builds `sql.connect <conn>` and returns the envelope", async () => {
  const { run, calls } = recorder({ ok: true, command: "sql.connect", dialect: "sqlite" });
  const r = await createSqlClient(run).connect("sqlite:///t.db");
  assert.deepEqual(calls[0], { script: "sqlrunner.py", argv: ["sql.connect", "sqlite:///t.db"] });
  assert.equal((r as { dialect?: string }).dialect, "sqlite");
});

test("query threads --sql/--params/--max-rows/--timeout-s in order", async () => {
  const { run, calls } = recorder();
  await createSqlClient(run).query("sqlite:///t.db", "SELECT * FROM t WHERE id = ?", {
    params: [2],
    maxRows: 100,
    timeoutS: 5,
  });
  assert.deepEqual(calls[0]?.argv, [
    "sql.query",
    "sqlite:///t.db",
    "--sql",
    "SELECT * FROM t WHERE id = ?",
    "--params",
    "[2]",
    "--max-rows",
    "100",
    "--timeout-s",
    "5",
  ]);
});

test("schema adds --table only when a table is given", async () => {
  const { run, calls } = recorder();
  const c = createSqlClient(run);
  await c.schema("sqlite:///t.db");
  await c.schema("sqlite:///t.db", "items");
  assert.deepEqual(calls[0]?.argv, ["sql.schema", "sqlite:///t.db"]);
  assert.deepEqual(calls[1]?.argv, ["sql.schema", "sqlite:///t.db", "--table", "items"]);
});

test("a leading-dash connection string is rejected (option-injection guard)", async () => {
  const { run } = recorder();
  const c = createSqlClient(run);
  await assert.rejects(() => c.connect("-rf"), /must not start with/);
  await assert.rejects(() => c.query("--evil", "SELECT 1"), /must not start with/);
  await assert.rejects(() => c.schema("-x"), /must not start with/);
});
