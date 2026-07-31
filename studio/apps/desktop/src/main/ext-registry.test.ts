/**
 * ext-registry.test.ts — the extension enable/verdict registry (APP-060). Real tmpdir fs.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type ExtRegistry,
  enabledIds,
  isEnabled,
  readRegistry,
  setEnabled,
  setVerdict,
  writeRegistry,
} from "./ext-registry.js";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-extreg-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("setEnabled / setVerdict are pure and preserve the sibling field", () => {
  let reg: ExtRegistry = {};
  reg = setEnabled(reg, "pub.a", true);
  assert.equal(reg["pub.a"]?.enabled, true);
  // storing a verdict preserves the enabled flag
  reg = setVerdict(reg, "pub.a", { tier: "warn", riskScore: 40, findingsCount: 2, scannedAt: "t" });
  assert.equal(reg["pub.a"]?.enabled, true);
  assert.equal(reg["pub.a"]?.verdict?.tier, "warn");
  // toggling enabled preserves the verdict
  reg = setEnabled(reg, "pub.a", false);
  assert.equal(reg["pub.a"]?.enabled, false);
  assert.equal(reg["pub.a"]?.verdict?.tier, "warn");
});

test("isEnabled / enabledIds default-deny for absent + disabled ids", () => {
  const reg: ExtRegistry = {
    "pub.on": { enabled: true },
    "pub.off": { enabled: false },
  };
  assert.equal(isEnabled(reg, "pub.on"), true);
  assert.equal(isEnabled(reg, "pub.off"), false);
  assert.equal(isEnabled(reg, "pub.absent"), false); // never fake-enabled
  assert.deepEqual(enabledIds(reg), ["pub.on"]);
});

test("read/write round-trips; a missing/corrupt file is empty (fail-soft)", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "sub", "ext-registry.json");
    assert.deepEqual(await readRegistry(path), {}); // missing → {}
    let reg = setEnabled({}, "pub.a", true);
    reg = setVerdict(reg, "pub.a", {
      tier: "allow",
      riskScore: 0,
      findingsCount: 0,
      scannedAt: "t",
    });
    await writeRegistry(path, reg);
    assert.deepEqual(await readRegistry(path), reg);
    // a malformed entry (no boolean enabled) is dropped on read.
    await writeRegistry(path, { bad: { verdict: {} } } as unknown as ExtRegistry);
    assert.deepEqual(await readRegistry(path), {});
  });
});
