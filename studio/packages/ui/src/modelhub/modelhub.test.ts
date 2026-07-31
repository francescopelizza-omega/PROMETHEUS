/**
 * modelhub.test.ts — node:test for the PURE Model-Hub UI helpers (file 05 §4/§5/
 * §7/§8/§10). NO React rendering (no DOM here) — this exercises only the
 * dependency-free logic the Model-Hub components lean on:
 *
 *   - inert                  sanitises untrusted engine strings (ANSI + control),
 *   - fitRole/Glyph/Label    the §4.2 verdict → {role,glyph,label} projection,
 *   - fitChipText            the §7 chip text (ratio when runnable, reason when not),
 *   - download* / serve*     the §5 + §2.4 lifecycle → {role,glyph,label} mappings,
 *   - formatGb/Bytes/Count   the §7 table size/popularity formatters,
 *   - qualityBar             the closeness-to-F16 quality block bar,
 *   - modalityLabel/MODALITIES  the §10 first-class facet sidebar,
 *   - isFreeOpenLicense      the §6 free/open-weight classification (NOT security),
 *   - recommendedExplainer   the §4.4 explainer formats the sidecar's choice/reasons,
 *   - isPickleFile           the §5.3 pickle (.bin/.pt/.ckpt) display hint,
 *   - gateToVerdict          the §5 VerdictSheet adapter is fail-closed (block/
 *                            error ⇒ safe_to all false; never invents an allow).
 *
 * GOLDEN RULE pin (C5): a block/error tier NEVER maps to an "ok" role and NEVER
 * yields a safe_to:true; an OVERFLOW/non-runnable quant NEVER yields a "fits"
 * chip — these helpers render the engine/sidecar verdict, they never decide.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test modelhub.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MODALITIES,
  downloadGlyph,
  downloadLabel,
  downloadRole,
  fitChipText,
  fitGlyph,
  fitLabel,
  fitRole,
  formatBytes,
  formatCount,
  formatGb,
  gateRefuses,
  gateRole,
  gateToVerdict,
  inert,
  isDownloadBlocked,
  isDownloadTerminal,
  isFreeOpenLicense,
  isPickleFile,
  modalityLabel,
  qualityBar,
  recommendedExplainer,
  roleVar,
  serveActions,
  serveGlyph,
  serveLabel,
  serveRole,
} from "./util.js";

test("inert strips ANSI escapes and control bytes, trims, rejects non-strings", () => {
  assert.equal(inert("[31mqwen3[0m"), "qwen3");
  assert.equal(inert("a b\tc"), "a b c");
  assert.equal(inert("  spaced  "), "spaced");
  assert.equal(inert(undefined), "");
  assert.equal(inert(42 as unknown), "");
});

/* ── §4.2 fit verdict projection ───────────────────────────────────────────── */

test("fitRole maps verdicts: FITS=ok, TIGHT=warn, PARTIAL=accent, OVERFLOW=danger", () => {
  assert.equal(fitRole("FITS"), "ok");
  assert.equal(fitRole("TIGHT"), "warn");
  assert.equal(fitRole("PARTIAL"), "accent");
  assert.equal(fitRole("OVERFLOW"), "danger");
});

test("fitGlyph/fitLabel are stable per verdict", () => {
  assert.equal(fitGlyph("FITS"), "●");
  assert.equal(fitGlyph("OVERFLOW"), "✕");
  assert.equal(fitLabel("TIGHT"), "TIGHT");
  assert.equal(fitLabel("PARTIAL"), "PARTIAL");
});

test("fitChipText shows glyph+verdict+ratio when runnable", () => {
  assert.equal(
    fitChipText({ verdict: "FITS", ratio: 0.18, runnable: true, blockedReason: null }),
    "● FITS 0.18",
  );
  assert.equal(
    fitChipText({ verdict: "TIGHT", ratio: 0.95, runnable: true, blockedReason: null }),
    "◐ TIGHT 0.95",
  );
  // missing ratio → no ratio suffix
  assert.equal(
    fitChipText({ verdict: "FITS", ratio: null, runnable: true, blockedReason: null }),
    "● FITS",
  );
});

test("fitChipText shows the caps reason (NOT a fits chip) when NOT runnable (§4.3)", () => {
  const txt = fitChipText({
    verdict: "FITS",
    ratio: 0.2,
    runnable: false,
    blockedReason: "needs cc≥8.9 (RTX40/H100)",
  });
  assert.equal(txt, "✕ needs cc≥8.9 (RTX40/H100)");
  // a non-runnable row never renders a green FITS label.
  assert.ok(!txt.includes("FITS"));
  // and inerts the reason
  const dirty = fitChipText({
    verdict: "FITS",
    ratio: null,
    runnable: false,
    blockedReason: "[31mvLLM only[0m",
  });
  assert.equal(dirty, "✕ vLLM only");
});

/* ── §5 download-state projection ──────────────────────────────────────────── */

test("downloadRole maps the §5 flow: admitted=ok, confirm=warn, blocked/quarantined=danger", () => {
  assert.equal(downloadRole("admitted"), "ok");
  assert.equal(downloadRole("confirm"), "warn");
  assert.equal(downloadRole("blocked"), "danger");
  assert.equal(downloadRole("quarantined"), "danger");
  assert.equal(downloadRole("staging"), "accent");
  assert.equal(downloadRole("scanning"), "accent");
  assert.equal(downloadRole("queued"), "muted");
});

test("downloadGlyph/Label cover every state and scanning reads 'nemesis: scanning…'", () => {
  assert.equal(downloadGlyph("admitted"), "✓");
  assert.equal(downloadGlyph("blocked"), "⛔");
  assert.equal(downloadLabel("scanning"), "nemesis: scanning…");
  assert.equal(downloadLabel("blocked"), "BLOCKED");
});

test("isDownloadTerminal/Blocked classify the §5 sinks", () => {
  assert.equal(isDownloadTerminal("admitted"), true);
  assert.equal(isDownloadTerminal("quarantined"), true);
  assert.equal(isDownloadTerminal("scanning"), false);
  assert.equal(isDownloadBlocked("blocked"), true);
  assert.equal(isDownloadBlocked("quarantined"), true);
  assert.equal(isDownloadBlocked("admitted"), false);
});

/* ── gate-tier projection + refusal ────────────────────────────────────────── */

test("gateRole/gateRefuses: block/error are danger and refuse; allow=ok; warn=warn", () => {
  assert.equal(gateRole("allow"), "ok");
  assert.equal(gateRole("warn"), "warn");
  assert.equal(gateRole("block"), "danger");
  assert.equal(gateRole("error"), "danger");
  assert.equal(gateRole(undefined), "muted");
  assert.equal(gateRefuses("block"), true);
  assert.equal(gateRefuses("error"), true);
  assert.equal(gateRefuses("allow"), false);
  assert.equal(gateRefuses("warn"), false);
});

/* ── §2.4 serve-status projection ──────────────────────────────────────────── */

test("serveRole/Glyph/Label: ready=ok●READY, starting=accent◐, error=danger✗", () => {
  assert.equal(serveRole("ready"), "ok");
  assert.equal(serveGlyph("ready"), "●");
  assert.equal(serveLabel("ready"), "READY");
  assert.equal(serveRole("starting"), "accent");
  assert.equal(serveGlyph("starting"), "◐");
  assert.equal(serveRole("error"), "danger");
  assert.equal(serveGlyph("error"), "✗");
  assert.equal(serveRole("stopped"), "muted");
});

test("serveActions gates Start/Stop/Use per status", () => {
  assert.deepEqual(serveActions("stopped"), ["start", "endpoint"]);
  assert.deepEqual(serveActions("starting"), ["stop"]);
  assert.deepEqual(serveActions("ready"), ["stop", "use", "endpoint"]);
  assert.deepEqual(serveActions("error"), ["retry", "stop"]);
});

/* ── formatting ────────────────────────────────────────────────────────────── */

test("formatGb/Bytes/Count format §7 cells deterministically", () => {
  assert.equal(formatGb(5.6), "5.6GB");
  assert.equal(formatGb(22.917), "22.9GB");
  assert.equal(formatGb(170), "170GB");
  assert.equal(formatGb(null), "—");
  assert.equal(formatGb(-1), "—");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatCount(1_200_000), "1.2M");
  assert.equal(formatCount(410_000), "410k");
  assert.equal(formatCount(42), "42");
  assert.equal(formatCount(undefined), "—");
});

test("qualityBar renders a clamped 5-cell block bar", () => {
  assert.equal(qualityBar(1), "█████");
  assert.equal(qualityBar(0), "░░░░░");
  assert.equal(qualityBar(0.82).length, 5);
  // clamps out-of-range
  assert.equal(qualityBar(2), "█████");
  assert.equal(qualityBar(-1), "░░░░░");
});

/* ── §10 modalities + §6 free license + §5.3 pickle ────────────────────────── */

test("MODALITIES is the first-class facet set and modalityLabel humanises them", () => {
  assert.ok(MODALITIES.includes("text"));
  assert.ok(MODALITIES.includes("embedding"));
  assert.ok(MODALITIES.includes("asr"));
  assert.equal(modalityLabel("text"), "Text (LLM)");
  assert.equal(modalityLabel("asr"), "ASR (speech→text)");
  assert.equal(modalityLabel("diffusion"), "Diffusion (image)");
});

test("isFreeOpenLicense classifies permissive licenses (§6, NOT a security call)", () => {
  assert.equal(isFreeOpenLicense("Apache-2.0"), true);
  assert.equal(isFreeOpenLicense("apache 2.0"), true);
  assert.equal(isFreeOpenLicense("MIT"), true);
  assert.equal(isFreeOpenLicense("BSD-3-Clause"), true);
  assert.equal(isFreeOpenLicense("gemma"), true);
  assert.equal(isFreeOpenLicense("CC-BY-NC-4.0"), false);
  assert.equal(isFreeOpenLicense("Llama Community"), false);
  assert.equal(isFreeOpenLicense(""), false);
});

test("isPickleFile flags §5.3 high-risk pickle formats vs safetensors/gguf", () => {
  assert.equal(isPickleFile("model.bin"), true);
  assert.equal(isPickleFile("weights.pt"), true);
  assert.equal(isPickleFile("ckpt.ckpt"), true);
  assert.equal(isPickleFile("model.safetensors"), false);
  assert.equal(isPickleFile("Qwen3-8B-Q4_K_M.gguf"), false);
});

/* ── §4.4 recommended explainer ────────────────────────────────────────────── */

test("recommendedExplainer formats the sidecar's choice + reasons (never re-derives)", () => {
  const line = recommendedExplainer({ label: "Q4_K_M" }, [
    "5.6GB est fits your 36GB at 0.18 ratio",
    "GGUF = broadest runner support",
  ]);
  assert.ok(line.startsWith("Recommended: Q4_K_M"));
  assert.ok(line.includes("0.18 ratio"));
  assert.ok(line.includes("broadest runner support"));
});

test("recommendedExplainer handles the OVERFLOW (no recommendation) case", () => {
  const line = recommendedExplainer(null, ["all quants overflow your 8GB GPU"]);
  assert.ok(line.startsWith("No quant fits"));
  assert.ok(line.includes("overflow your 8GB GPU"));
  // and a bare null with no reasons still gives the AirLLM escape-hatch hint.
  const bare = recommendedExplainer(null, []);
  assert.ok(bare.toLowerCase().includes("airllm") || bare.toLowerCase().includes("overflow"));
});

test("recommendedExplainer inerts crafted reason strings", () => {
  const line = recommendedExplainer({ label: "Q8_0" }, ["[31mevil[0m reason"]);
  assert.ok(line.includes("evil reason"));
  assert.ok(!line.includes(""));
});

/* ── §5 gateToVerdict adapter (fail-closed) ────────────────────────────────── */

test("gateToVerdict carries an ALLOW through as safe_to:true, score 0", () => {
  const v = gateToVerdict({ verdict: "allow", score: 0, reasons: [] }, "Qwen/Qwen3-8B-GGUF");
  assert.equal(v.verdict, "allow");
  assert.equal(v.safe_to.install, true);
  assert.equal(v.safe_to.run_plug_and_play, true);
  assert.equal(v.safe_to.use_as_ai_cli_agent, true);
  assert.equal(v.risk_score, 0);
  assert.equal(v.target, "Qwen/Qwen3-8B-GGUF");
  assert.equal(v.target_kind, "model");
});

test("gateToVerdict FAILS CLOSED on block/error: safe_to all false, score 100 (C5)", () => {
  for (const tier of ["block", "error"] as const) {
    const v = gateToVerdict({ verdict: tier, reasons: ["pickle file *.bin"] }, "evil/model");
    assert.equal(v.verdict, tier);
    assert.equal(v.safe_to.install, false);
    assert.equal(v.safe_to.run_plug_and_play, false);
    assert.equal(v.safe_to.use_as_ai_cli_agent, false);
    assert.equal(v.risk_score, 100);
    assert.deepEqual(v.blocking_reasons, ["pickle file *.bin"]);
  }
});

test("gateToVerdict NEVER fabricates findings + inerts reasons", () => {
  const v = gateToVerdict(
    { verdict: "warn", score: 40, reasons: ["[33msuspicious[0m url"] },
    "x/y",
  );
  assert.deepEqual(v.top_findings, []);
  assert.deepEqual(v.severity_counts, { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 });
  assert.deepEqual(v.blocking_reasons, ["suspicious url"]);
  // a warn is not "safe" — only allow is.
  assert.equal(v.safe_to.install, false);
});

test("roleVar resolves semantic roles to ui CSS vars (no raw hex)", () => {
  assert.equal(roleVar("ok"), "var(--ok)");
  assert.equal(roleVar("danger"), "var(--danger)");
  assert.equal(roleVar("muted"), "var(--text-secondary)");
});
