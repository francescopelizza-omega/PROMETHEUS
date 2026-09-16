/**
 * home-view.test.ts — the Home islands must not print a number the probe never measured.
 *
 * The regression: the CPU/RAM meters read `telemetry?.cpu?.usedPct ?? null` and the bar
 * treated any finite number as a reading. `errorTelemetry` fails soft with
 * `{usedPct: 0, measured: false}`, so a probe that had just thrown rendered a confident
 * "CPU 0%" — the most reassuring possible reading for "we have no idea".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { homeModelRows, homeModelsHeader, meterPct } from "./home-view.js";

const homeSrc = (): string => readFileSync(new URL("./home.tsx", import.meta.url), "utf8");

test("a measured reading passes through unchanged", () => {
  assert.equal(meterPct({ usedPct: 14, measured: true }), 14);
  assert.equal(meterPct({ usedPct: 0, measured: true }), 0, "a genuine 0% is still a reading");
  assert.equal(meterPct({ usedPct: 100, measured: true }), 100);
});

test("the fail-soft envelope reads as NOT MEASURED, never as 0%", () => {
  // exactly what main/telemetry-ipc.ts `errorTelemetry()` puts on the wire
  assert.equal(meterPct({ usedPct: 0, measured: false }), null);
  // and a non-zero stale figure with measured:false is just as inadmissible
  assert.equal(meterPct({ usedPct: 73, measured: false }), null);
});

test("absent readings are null, not a crash", () => {
  assert.equal(meterPct(undefined), null);
  assert.equal(meterPct(null), null);
});

/**
 * DRIFT GUARDS — a pure helper nobody calls is the exact shape of "looks implemented,
 * isn't" this repo keeps rediscovering. These read the route's own source, because the
 * defect being pinned is a CALL SITE, and no unit test of the helper can see it.
 */
test("DRIFT GUARD: the CPU/RAM meters are fed through meterPct, not a raw usedPct", () => {
  const src = homeSrc();
  assert.match(src, /pct=\{meterPct\(telemetry\?\.cpu\)\}/, "CPU meter bypasses meterPct");
  assert.match(src, /pct=\{meterPct\(telemetry\?\.ram\)\}/, "RAM meter bypasses meterPct");
  assert.doesNotMatch(
    src,
    /pct=\{telemetry\?\.\w+\?\.usedPct/,
    "a raw usedPct reached a meter again — the fail-soft 0 would paint as a real reading",
  );
});

test("DRIFT GUARD: EVERY telemetry consumer honours `measured`, not just Home", () => {
  // The first version of this guard scanned home.tsx only, and an adversarial pass found a
  // second call site it could not see: TelemetryStrip's tooltip built
  // `CPU ${t.cpu.usedPct}%` with no check at all. It was saved by an accident of ordering
  // (the fail-soft envelope also trips the launch guard, so the `blocked` branch usually
  // wins first) — a coincidence, not a guarantee.
  const strip = readFileSync(
    new URL("../ide/telemetry/TelemetryStrip.tsx", import.meta.url),
    "utf8",
  );
  assert.match(strip, /meterPct\(t\.cpu\)/);
  assert.match(strip, /meterPct\(t\.ram\)/);
  assert.doesNotMatch(
    strip,
    /CPU \$\{t\.cpu\.usedPct\}%/,
    "a raw usedPct is back in the telemetry tooltip",
  );
});

test("DRIFT GUARD: the Home gate chip asks whether the SCANNER is present", () => {
  const src = homeSrc();
  assert.match(
    src,
    /deriveShield\([\s\S]{0,200}?armed:\s*health\.nemesisPresent/,
    "the gate chip fell back to verdict-only, which paints green with nemesis absent",
  );
});

test("DRIFT GUARD: the verdict age goes through agoLabel", () => {
  const src = homeSrc();
  assert.match(src, /agoLabel\(lastVerdict\?\.scannedAt\)/);
  assert.doesNotMatch(src, /ageLabel\([^)]*\)\}\s*ago/, 'hand-suffixed age is back ("now ago")');
});

/* ── §2.3.5c: "serving/installed rows" — both halves ─────────────────────────────── */

test("a serve profile and a library entry for the same model are ONE row", () => {
  const rows = homeModelRows(
    [{ id: "p1", modelId: "qwen3:8b", status: "ready" }],
    [{ id: "qwen3:8b" }, { id: "gemma3:4b" }],
  );
  assert.deepEqual(rows, [
    { id: "qwen3:8b", serving: true, state: "serving" },
    { id: "gemma3:4b", serving: false, state: "installed" },
  ]);
});

test("an installed model with NO serve profile still appears", () => {
  // the whole defect: the island read `model:serving` alone, so a downloaded model that had
  // never been given a profile was invisible and the empty state said "No model installed
  // yet." to someone with a full library.
  const rows = homeModelRows([], [{ id: "deepseek-r1:7b" }]);
  assert.deepEqual(rows, [{ id: "deepseek-r1:7b", serving: false, state: "installed" }]);
});

test('a STOPPED profile reads "installed", not the supervisor\'s raw word', () => {
  // "stopped" is a fact about the supervisor; the weights are still on disk, and the spec
  // (and the prototype) call that state "installed".
  assert.equal(homeModelRows([{ modelId: "a", status: "stopped" }], [])[0]?.state, "installed");
  // a genuinely transitional state is still worth showing verbatim
  assert.equal(homeModelRows([{ modelId: "b", status: "starting" }], [])[0]?.state, "starting");
  assert.equal(homeModelRows([{ modelId: "c", status: "error" }], [])[0]?.state, "error");
});

test("only a READY profile lights the dot", () => {
  const rows = homeModelRows(
    [
      { modelId: "a", status: "ready" },
      { modelId: "b", status: "starting" },
    ],
    [],
  );
  assert.deepEqual(
    rows.map((r) => r.serving),
    [true, false],
  );
});

test("junk payloads degrade to an empty list, never a throw", () => {
  assert.deepEqual(homeModelRows(null, undefined), []);
  assert.deepEqual(homeModelRows(undefined, null), []);
  assert.deepEqual(homeModelRows([{}, { id: "" }], []), [], "a profile with no id is not a row");
  assert.deepEqual(homeModelRows([{ modelId: "x" }, { modelId: "x" }], [{ id: "x" }]).length, 1);
});

test("the header counts the rows it is standing above", () => {
  // the old header read `servingCount` from the C8 SERVER supervisor — a different payload
  // from the model supervisor below it — so it could say "0 serving" over a serving row.
  const rows = homeModelRows(
    [
      { modelId: "a", status: "ready" },
      { modelId: "b", status: "stopped" },
    ],
    [{ id: "c" }],
  );
  assert.equal(homeModelsHeader(rows), "1 serving · 2 installed");
  assert.equal(homeModelsHeader([]), "0 serving · 0 installed");
});

test("DRIFT GUARD: the island renders the merged rows and the derived header", () => {
  const src = homeSrc();
  assert.match(src, /modelRows\.map\(\(m\) => \(/, "the island went back to raw profiles");
  assert.match(src, /homeModelsHeader\(modelRows\)/);
  assert.doesNotMatch(
    src,
    /\$\{servingCount\} serving · \$\{catalogRows\.length\} in catalog/,
    "the cross-wired header (server supervisor + plugin catalog) is back",
  );
});

test('DRIFT GUARD: "At a glance" reports only what a query actually answered', () => {
  // §2.3: "No empty contextual columns; nothing renders unless it has content." The island
  // had no gate and no §6 states, so with no bridge it painted a permanent
  // "Environments 0 · Catalog items 0" — a confident zero standing in for "we could not ask".
  const src = homeSrc();
  assert.match(src, /\{glanceRowCount > 0 && \(/, "the island renders unconditionally again");
  assert.match(src, /const envKnown = envs\.data\?\.ok === true;/);
  assert.match(src, /const catalogKnown = catalog\.data\?\.ok === true;/);
  assert.match(src, /\{envKnown && \(/);
  assert.match(src, /\{catalogKnown && \(/);
});
