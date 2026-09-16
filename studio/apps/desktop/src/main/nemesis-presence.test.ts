/**
 * nemesis-presence.test.ts — `HealthResult.nemesisPresent` must measure the SCANNER.
 *
 * An adversarial verification of the "gate armed" work found that the whole chain was fed a
 * field that did not mean what every consumer assumed. `main/ipc.ts` computed:
 *
 *     nemesisPresent = contractOk;   // "conservatively … only when the contract held"
 *
 * where `contractOk` is "did `prometheus.py --json` return a parseable envelope". So a
 * machine with a perfectly healthy engine and NO nemesis binary reported
 * `nemesisPresent: true`. Everything downstream — the health pill, the System-health row,
 * and the shield's new `armed` probe — was therefore consistent and consistently wrong: the
 * chip painted green precisely in the case it had just been written to catch.
 *
 * Two halves are pinned here, because the defect needed both to be true:
 *   1. the PRODUCER no longer derives presence from the contract probe (source guard — the
 *      handler registers real ipcMain channels, so a behavioural test would need Electron);
 *   2. the CONSUMER chain genuinely reacts to `nemesisPresent: false` while the engine is
 *      otherwise healthy. That half is pure, so it is asserted for real.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { deriveShield } from "@prometheus/ui";

import { deriveSystemHealthView } from "../renderer/ide/health/health-panel-view.js";
import { deriveHealthPill } from "../renderer/stores/health-derive.js";
import type { HealthResult } from "../shared/ipc-contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The file's CODE, with comments stripped.
 *
 * The guard below forbids a string that this very repo's explanatory comments legitimately
 * quote ("this used to be `nemesisPresent = contractOk`"). A guard that a correct comment
 * can trip is a guard people delete, so it reads the code only.
 */
function codeOf(file: string): string {
  return readFileSync(join(HERE, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The exact machine state the old code could not represent: engine fine, scanner gone. */
const ENGINE_OK_SCANNER_GONE: HealthResult = {
  ok: true,
  contractOk: true,
  nemesisPresent: false,
  problems: ["nemesis binary not found — installs and gates fail closed"],
  version: "3.14.6",
};

const ALL_GOOD: HealthResult = {
  ok: true,
  contractOk: true,
  nemesisPresent: true,
  problems: [],
  version: "3.14.6",
};

test("PRODUCER: nemesisPresent is not derived from the contract probe", () => {
  const src = codeOf("ipc.ts");
  assert.doesNotMatch(
    src,
    /nemesisPresent\s*=\s*contractOk/,
    "presence is being inferred from the engine's JSON envelope again",
  );
  assert.match(
    src,
    /nemesisPresent\s*=\s*existsSync\(resolveEngine\([^)]*\)\.nemesisBin\)/,
    "the real probe (a stat of the resolved nemesis binary) is gone",
  );
});

test("PRODUCER: a failed probe reports ABSENT, never assumes present", () => {
  const src = codeOf("ipc.ts");
  // `let nemesisPresent = false` before the try, and no assignment in the catch, is what
  // makes "we could not tell" and "it is missing" render identically.
  assert.match(src, /let nemesisPresent = false;\s*\n\s*try \{/);
});

test("CONSUMER: a healthy engine with no scanner is DEGRADED, not ready", () => {
  assert.equal(deriveHealthPill(ALL_GOOD), "ready");
  assert.equal(
    deriveHealthPill(ENGINE_OK_SCANNER_GONE),
    "degraded",
    "the pill must not read ready while nothing can scan",
  );
});

test("CONSUMER: the System-health island marks the nemesis row degraded", () => {
  const view = deriveSystemHealthView(ENGINE_OK_SCANNER_GONE, "degraded");
  const nemesis = view.components.find((c) => c.id === "nemesis");
  assert.ok(nemesis, "the nemesis row disappeared");
  assert.equal(nemesis.status, "degraded");
  assert.match(nemesis.remediation ?? "", /install|locate/i);
  // and the engine row must NOT be dragged down with it — they are separate facts
  assert.equal(view.components.find((c) => c.id === "engine")?.status, "ok");
});

test("CONSUMER: the shield reads UNARMED, and never green, in this exact state", () => {
  const armed = ENGINE_OK_SCANNER_GONE.nemesisPresent === true;
  const s = deriveShield(null, { armed });
  assert.equal(s.state, "unarmed");
  assert.equal(s.role, "danger");
  // the case that made the original bug invisible: nothing has ever been scanned, so there
  // is no verdict to fall back on — which is why the placeholder used to win.
  assert.notEqual(s.role, "ok");
});

test("CONSUMER: with the scanner present and nothing scanned, the shield says ARMED", () => {
  const s = deriveShield(null, { armed: ALL_GOOD.nemesisPresent === true });
  assert.equal(s.state, "armed");
  assert.equal(s.role, "ok");
});
