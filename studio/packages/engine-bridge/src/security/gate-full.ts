// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * security/gate-full.ts — the RICH gate (file 03 §4, §5; reconciliation note).
 *
 * gate() (gate.ts) returns the LIGHTWEIGHT C3 `SecurityVerdict` core/cli/tests
 * consume. gateFull() returns the FULL `NemesisVerdict` the security UI renders.
 * Both call the SAME runner (runNemesis, the only nemesis spawner — C5).
 *
 * GROUND TRUTH — probed against `nemesis 1.12.0`:
 *   - `nemesis gate <target>` prints one nemesis.verdict/1 object on stdout and
 *     exits 0 allow / 10 warn / 20 block / 2 error. NO extra flag is needed for
 *     machine output (gate is already machine-mode).
 *   - "fresh / re-scan" maps to `--no-cache` (there is NO `--gate-fresh` flag on
 *     nemesis; `--gate-fresh` is a prometheus.py flag). We add `--no-cache`.
 *   - a custom policy file maps to `--policy <file>`; the pentest tier is a
 *     prometheus.py-written policy file, so `tier:"pentest"` without an explicit
 *     policyFile is surfaced as policy intent but cannot be synthesised here
 *     (Studio writes NO policy — §7). We pass `--policy` only when given a file.
 *   - signing maps to `--sign` (top-level `signature:{alg,value,key_id}`).
 *
 * FAIL-CLOSED (C5): missing binary / spawn failure / timeout / unparseable
 * output ⇒ syntheticErrorVerdict (verdict "error", BLOCK). The exit-code tier
 * and the JSON verdict are reconciled by taking the MORE conservative of the two
 * — we can never under-report risk, even if the engine and its JSON disagree.
 */

import type { EngineConfig } from "../config.js";
import { type EngineEnvelope, runPrometheus } from "../run.js";
import type { AuditEnvelope } from "../types/index.js";
import { type NemesisRunResult, type RunOptions, runNemesis } from "./gate.js";
import {
  type NemesisVerdict,
  type NemesisVerdictLevel,
  parseNemesisVerdict,
  syntheticErrorVerdict,
} from "./nemesis-verdict.js";
import { tierFromExitCode } from "./verdict.js";

export interface GateFullOptions extends RunOptions {
  /**
   * Policy tier. "default" is the engine default; "pentest" signals the higher
   * scrutiny tier but — since Studio writes NO policy (§7) — only takes effect
   * when paired with the engine's pentest policy file via `policyFile`.
   */
  tier?: "default" | "pentest";
  /** Re-scan fresh (bypass the verdict cache) — maps to `nemesis --no-cache`. */
  fresh?: boolean;
  /** HMAC-sign the verdict (`--sign`) so the audit-log Verify feature can check it. */
  sign?: boolean;
  /** A custom `--policy FILE`. The pentest tier cannot be loosened below default (§7). */
  policyFile?: string;
}

/** Rank tiers so we can always take the MORE conservative of exit vs. json. */
const TIER_RANK: Record<NemesisVerdictLevel, number> = {
  allow: 0,
  warn: 1,
  block: 2,
  error: 3,
};

function moreConservative(a: NemesisVerdictLevel, b: NemesisVerdictLevel): NemesisVerdictLevel {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Build the `nemesis gate` argv from the options (verbatim, shell:false-safe).
 *
 * `--` ends the option list, so the target can never be consumed as a nemesis flag. This is the
 * same protection `gate()` carries, and it did not: the two are twins and only one was fixed.
 * Without the separator a target of `-` makes nemesis read the body from STDIN, `runNemesis`
 * writes no stdin for a gate and closes the pipe, so nemesis scans an EMPTY body and answers
 * `verdict:"allow", risk_score:0` — and `gateFull` reconciles allow-vs-allow into a clean
 * verdict. Nothing was scanned, and every surface downstream is told the target is safe.
 */
function buildGateArgv(target: string, opts: GateFullOptions): string[] {
  const argv = ["gate", "--", target];
  if (opts.fresh) argv.push("--no-cache");
  if (opts.sign) argv.push("--sign");
  if (opts.policyFile) argv.push("--policy", opts.policyFile);
  return argv;
}

/**
 * Gate an arbitrary target (path / git URL / owner-repo / a pasted URL) and
 * return the FULL NemesisVerdict for the security UI. FAIL-CLOSED on any failure
 * to obtain a trustworthy verdict.
 */
export async function gateFull(
  target: string,
  opts: GateFullOptions = {},
  config: EngineConfig = {},
): Promise<NemesisVerdict> {
  if (!target || !target.trim()) {
    return syntheticErrorVerdict(target, "empty target");
  }
  /**
   * An option-shaped target is refused OUTRIGHT, not merely separated.
   *
   * `--` already stops a flag being parsed, but a bare `-` still means "read the body from
   * stdin" positionally, and a path that genuinely begins with `-` is far likelier to be a
   * mistake or an injection attempt than a real scan target. `gate()` refuses these fail-closed;
   * this twin accepted them and reported the resulting empty scan as SAFE. The file header
   * promises FAIL-CLOSED and "we can never under-report risk" — this is what makes that true.
   */
  if (target.trimStart().startsWith("-")) {
    return syntheticErrorVerdict(target, `refusing an option-shaped scan target: ${target}`);
  }

  let res: NemesisRunResult;
  try {
    res = await runNemesis(buildGateArgv(target, opts), opts, config);
  } catch (e) {
    // missing binary / spawn / timeout / abort ⇒ fail-closed BLOCK.
    return syntheticErrorVerdict(target, e instanceof Error ? e.message : String(e));
  }

  // No parseable JSON at all ⇒ we cannot trust a non-error exit to mean "safe".
  if (!res.json || typeof res.json !== "object" || Array.isArray(res.json)) {
    // Honour the decision exit code, but with no findings we can't render a real
    // verdict — synthesise an error/block verdict carrying the exit tier.
    const exitTier = tierFromExitCode(res.exitCode);
    if (exitTier === "allow") {
      // Exit 0 but no JSON is a contract violation — fail closed, do NOT pass.
      return syntheticErrorVerdict(target, "nemesis exited 0 with no verdict JSON");
    }
    const synthetic = syntheticErrorVerdict(target, "nemesis produced no verdict JSON");
    synthetic.verdict = exitTier === "error" ? "error" : exitTier;
    synthetic.exit_code = res.exitCode;
    return synthetic;
  }

  const verdict = parseNemesisVerdict(res.json, target);

  // Reconcile: take the MORE conservative of the exit-code tier and the JSON
  // verdict so a mismatch can never under-report. (They agree in practice.)
  const exitTier = tierFromExitCode(res.exitCode);
  const reconciled = moreConservative(verdict.verdict, exitTier);
  if (reconciled !== verdict.verdict) {
    verdict.verdict = reconciled;
    if (reconciled === "block" || reconciled === "error") {
      verdict.safe_to = {
        install: false,
        run_plug_and_play: false,
        use_as_ai_cli_agent: false,
      };
    }
  }
  // Keep the engine's own exit_code field authoritative for display.
  verdict.exit_code = res.exitCode;
  return verdict;
}

/**
 * auditScan(name) — the read-only, NO-side-effects deep audit (§4). Runs
 * `prometheus.py --json audit <name>` and returns the engine's audit envelope
 * verbatim (the per-(plugin,agent) 5C scan report + per-remote nemesis verdict).
 *
 * `name` may be a single plugin or "all". This performs ZERO disk mutations.
 * FAIL-CLOSED: a transport failure throws an EngineError (runPrometheus's
 * contract). An ok:false audit envelope is VALID output and is returned.
 */
export async function auditScan(
  name: string,
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<AuditEnvelope> {
  return runPrometheus<AuditEnvelope & EngineEnvelope>(
    ["audit", name],
    opts,
    config,
  ) as Promise<AuditEnvelope>;
}
