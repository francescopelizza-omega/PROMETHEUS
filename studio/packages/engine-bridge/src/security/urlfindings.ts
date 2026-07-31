/**
 * security/urlfindings.ts — URL-injection verdict FUSION (url_injection_safeguard.md §4).
 *
 * Turns the L4 classifier + L6 proxy + L3 cloaking-probe outputs into the canonical
 * nemesis URL findings (URL-IPI / URL-CLOAK / URL-OPAQUE) and fuses them into a
 * single verdict tier so Studio's Security surface renders them exactly like every
 * other finding. Mirrors §4 signal-fusion:
 *   HARD-BLOCK  — classifier "malicious", confirmed IPI, selective-injection cloak.
 *   ADDITIVE    — "suspicious", content/redirect divergence, opaque blob.
 *   CLEAN adds ZERO "safe" weight (absence of a hit is never safety).
 *
 * JavaScript never upgrades toward allow; a degraded (heuristic-only) classifier
 * caps the contribution at warn and is labelled.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type SidecarEnvelope, type SidecarOptions, runSidecar } from "../sidecar-runner.js";
import type { CloakProbeResult, SafeFetchResult } from "./fetchproxy.js";

export interface ClassifyResult extends SidecarEnvelope {
  command: "classify";
  url: string;
  context: string;
  backend: "heuristic" | "prompt-guard-2";
  degraded: boolean;
  score: number;
  label: "benign" | "suspicious" | "malicious";
  ipi: boolean;
  evidence: Array<{ kind: string; weight: number; evidence: string }>;
}

export type UrlContext = "exec" | "doc" | "comment" | "config";

/** A nemesis-finding-shaped URL finding (URL-IPI / URL-CLOAK / URL-OPAQUE / …). */
export interface UrlFinding {
  rule_id: "URL-IPI" | "URL-CLOAK" | "URL-RUGPULL" | "URL-DRIFT" | "URL-OPAQUE";
  severity: "HIGH" | "MEDIUM";
  klass: "malware";
  category: "ioc" | "obfuscation";
  path: string;
  detail: string;
  evidence?: string;
}

export interface ClassifyOptions {
  url?: string;
  context?: UrlContext;
  sidecar?: SidecarOptions;
  timeoutMs?: number;
}

/**
 * Run the L4 classifier over already-fetched, pinned content (DATA only). The text
 * is handed to the sidecar via a temp file (never the network). Fail-closed: a
 * dead sidecar → a degraded "suspicious" result, never "benign".
 */
export async function classifyContent(
  text: string,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const dir = mkdtempSync(join(tmpdir(), "urlclassify-"));
  const file = join(dir, "content.txt");
  try {
    writeFileSync(file, text, "utf8");
    const argv = ["classify", "--text-file", file, "--datamark"];
    if (opts.url) argv.push("--url", opts.url);
    if (opts.context) argv.push("--context", opts.context);
    const env = await runSidecar<ClassifyResult>("urlclassifier.py", argv, {
      timeoutMs: opts.timeoutMs ?? 60_000,
      ...opts.sidecar,
    });
    if (!env.ok || env.command !== "classify" || typeof env.score !== "number") {
      return {
        ok: false,
        command: "classify",
        url: opts.url ?? "",
        context: opts.context ?? "doc",
        backend: "heuristic",
        degraded: true,
        score: 0.3,
        label: "suspicious",
        ipi: true,
        evidence: [{ kind: "classifier-error", weight: 0.3, evidence: env.error ?? "no envelope" }],
      };
    }
    return env;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FuseInput {
  url: string;
  context?: UrlContext;
  classify?: ClassifyResult | null;
  fetch?: SafeFetchResult | null;
  probe?: CloakProbeResult | null;
  /** undecodable encoded-URL blob count (from nemesis L0). */
  opaque?: number;
}

export interface FusedUrlVerdict {
  tier: "allow" | "warn" | "block";
  findings: UrlFinding[];
  degraded: boolean;
  reasons: string[];
}

/**
 * Fuse all URL-injection signals for one URL into findings + a verdict tier.
 * exec-context multiplies impact; CLEAN contributes nothing.
 */
export function fuseUrlSignals(input: FuseInput): FusedUrlVerdict {
  const findings: UrlFinding[] = [];
  const reasons: string[] = [];
  const path = input.url;
  const exec = input.context === "exec";
  let hardBlock = false;
  // signalAdditive = independent evidence (L6 fetch-IPI, L3 cloak, L0 opaque) that a
  // degraded classifier must NOT veto. classifierAdditive = the L4 classifier's own
  // "suspicious" contribution, which IS discounted when the classifier is degraded.
  let additive = 0;
  let classifierAdditive = 0;
  let degraded = false;

  // --- L4 classifier → URL-IPI ---------------------------------------------
  const c = input.classify;
  if (c) {
    degraded = degraded || c.degraded;
    if (c.label === "malicious") {
      hardBlock = true;
      findings.push({
        rule_id: "URL-IPI",
        severity: "HIGH",
        klass: "malware",
        category: "ioc",
        path,
        detail: `classifier '${c.backend}' scored content malicious (${c.score})`,
        evidence: c.evidence?.[0]?.evidence,
      });
      reasons.push(`classifier malicious @ ${path}`);
    } else if (c.label === "suspicious") {
      classifierAdditive += exec ? 2 : 1;
      findings.push({
        rule_id: "URL-IPI",
        severity: "MEDIUM",
        klass: "malware",
        category: "ioc",
        path,
        detail: `classifier '${c.backend}' scored content suspicious (${c.score})`,
        evidence: c.evidence?.[0]?.evidence,
      });
    }
  }

  // --- L6 fetch IPI signals → URL-IPI --------------------------------------
  const f = input.fetch;
  if (f && !f.blocked && f.ipi_signals?.length) {
    const sev = exec ? "HIGH" : "MEDIUM";
    if (sev === "HIGH") hardBlock = true;
    else additive += 1;
    findings.push({
      rule_id: "URL-IPI",
      severity: sev,
      klass: "malware",
      category: "ioc",
      path,
      detail: `fetched content carries ${f.ipi_signals.length} injection signal(s)`,
      evidence: f.ipi_signals[0]?.evidence,
    });
    reasons.push(`injection in fetched content @ ${path}`);
  }

  // --- L3 cloaking probe → URL-CLOAK ---------------------------------------
  const p = input.probe;
  if (p?.cloaked) {
    const hard = p.signals?.some(
      (s) => s.kind === "selective-injection" || s.kind === "reachability-divergence",
    );
    if (hard) hardBlock = true;
    else additive += exec ? 2 : 1;
    findings.push({
      rule_id: "URL-CLOAK",
      severity: hard ? "HIGH" : "MEDIUM",
      klass: "malware",
      category: "ioc",
      path,
      detail: `cloaking probe diverged (similarity ${p.similarity})`,
      evidence: p.signals?.[0]?.evidence,
    });
    if (hard) reasons.push(`cloaking (selective injection) @ ${path}`);
  }

  // --- L0 opaque blob → URL-OPAQUE -----------------------------------------
  if (input.opaque && input.opaque > 0) {
    additive += 1;
    findings.push({
      rule_id: "URL-OPAQUE",
      severity: "MEDIUM",
      klass: "malware",
      category: "obfuscation",
      path,
      detail: `${input.opaque} opaque encoded-URL blob(s) could not be vetted`,
    });
  }

  // fuse: hard-block dominates; else additive crosses a threshold → block; any
  // finding → warn; nothing → allow. A degraded classifier discounts only ITS OWN
  // contribution — independent fetch/cloak/opaque evidence still escalates to block.
  const effectiveAdditive = additive + (degraded ? 0 : classifierAdditive);
  let tier: "allow" | "warn" | "block";
  if (hardBlock) tier = "block";
  else if (effectiveAdditive >= 3) tier = "block";
  else if (findings.length) tier = "warn";
  else tier = "allow";

  return { tier, findings, degraded, reasons };
}
