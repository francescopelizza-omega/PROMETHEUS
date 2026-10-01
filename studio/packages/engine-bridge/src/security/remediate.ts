// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * security/remediate.ts — DISINFECT / QUARANTINE / PURGE / ACCEPT (file 03 §9, §5.5).
 *
 * Every verb is an ENGINE operation wrapped in a typed, fail-closed result.
 * Studio NEVER edits files itself — it calls nemesis / prometheus.py and renders
 * what comes back (C5). All spawns go through the existing runners (runNemesis /
 * runPrometheus) — this module adds NO child_process.
 *
 * GROUND TRUTH — probed against `nemesis 1.12.0`:
 *   - DISINFECT  → `nemesis scan <target> --fix --disinfect --out <dir> --gate`
 *       emits ONE nemesis.verdict/1 object on stdout (the re-scan verdict) whose
 *       `disinfection` block carries {applied, neutralized_lines,
 *       quarantined_files, resolved_rules[], unresolved_rules[], errors[],
 *       output}. The cleaned copy lands at <dir>; the original is untouched.
 *   - QUARANTINE LIST → `nemesis restore --quarantine-dir <dir> --list`
 *       (`--quarantine-dir` is REQUIRED; default vault is
 *       <scanned-path>/__nemesis_quarantine__). Output is human text, not JSON.
 *   - RESTORE → `nemesis restore --quarantine-dir <dir> <id>` (id, or "all").
 *   - PURGE   → the engine's ERASE remediation. There is no standalone `erase`
 *       verb on the public CLI; erase is reached via `scan --interactive`
 *       ([e]rase) or is what the quarantine→purge flow deletes from the vault.
 *       For an INSTALLED SOURCE we route `prometheus.py uninstall <name>` first
 *       (clean lifecycle removal) — that is the supported, scriptable path.
 *   - ACCEPT  → `nemesis ignore` has ONLY --list/--remove/--clear; it does NOT
 *       take a <rule_id> <path> add form. The accept entry is created by the
 *       engine's interactive [i]gnore decision. So acceptFinding() cannot add an
 *       entry non-interactively in this build — it returns a typed "unsupported"
 *       result (honest, never a silent no-op) and exposes ignoreList() for the UI.
 */

import type { EngineConfig } from "../config.js";
import { EngineError } from "../errors.js";
import { type EngineEnvelope, runPrometheus } from "../run.js";
import { type NemesisRunResult, type RunOptions, runNemesis } from "./gate.js";
import {
  type NemesisVerdict,
  parseNemesisVerdict,
  syntheticErrorVerdict,
} from "./nemesis-verdict.js";

/** Default in-tree quarantine vault, matching the engine's default. */
function defaultQuarantineDir(target: string): string {
  return `${target.replace(/\/+$/, "")}/__nemesis_quarantine__`;
}

// --------------------------------------------------------------------------
// DISINFECT (§9.1)
// --------------------------------------------------------------------------

export interface DisinfectOptions extends RunOptions {
  /** cleaned-copy output dir (`--out`). Required by the engine for archives. */
  out: string;
}

export interface DisinfectResult {
  ok: boolean;
  /** the re-scan verdict AFTER disinfection (the honest one — §9.1). */
  verdict: NemesisVerdict;
  /** rule-ids the engine resolved (line neutralized / file quarantined). */
  resolved: string[];
  /** rule-ids that could NOT be auto-fixed (hard malware / in-archive). */
  unresolved: string[];
  /** the cleaned-copy directory. */
  output: string;
  errors: string[];
}

/**
 * Disinfect a target: neutralize solvable findings, quarantine hard malware,
 * re-scan to confirm, and return the post-disinfect verdict + per-rule outcome.
 * FAIL-CLOSED: any failure ⇒ a synthetic error verdict (BLOCK) + ok:false.
 */
export async function disinfect(
  target: string,
  opts: DisinfectOptions,
  config: EngineConfig = {},
): Promise<DisinfectResult> {
  if (!target?.trim() || !opts?.out?.trim()) {
    const verdict = syntheticErrorVerdict(target, "disinfect requires target + out dir");
    return {
      ok: false,
      verdict,
      resolved: [],
      unresolved: [],
      output: opts?.out ?? "",
      errors: ["missing target or --out directory"],
    };
  }

  let res: NemesisRunResult;
  try {
    res = await runNemesis(
      ["scan", target, "--fix", "--disinfect", "--out", opts.out, "--gate", "--no-cache"],
      opts,
      config,
    );
  } catch (e) {
    const verdict = syntheticErrorVerdict(target, e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      verdict,
      resolved: [],
      unresolved: [],
      output: opts.out,
      errors: [verdict.recommendation],
    };
  }

  const verdict = parseNemesisVerdict(res.json, target);
  const dis = verdict.disinfection;
  return {
    // ok only when the engine applied a fix AND the re-scan did not re-block.
    ok: !!dis?.applied && verdict.verdict !== "error" && (dis?.errors?.length ?? 0) === 0,
    verdict,
    resolved: dis?.resolved_rules ?? [],
    unresolved: dis?.unresolved_rules ?? [],
    output: dis?.output ?? opts.out,
    errors: dis?.errors ?? [],
  };
}

// --------------------------------------------------------------------------
// QUARANTINE vault (§9.2)
// --------------------------------------------------------------------------

export interface QuarantineListResult {
  ok: boolean;
  /** the raw vault listing (human text — the engine does not emit JSON here). */
  listing: string;
  /** the vault dir queried. */
  quarantineDir: string;
  error?: string;
}

/**
 * List the quarantine vault. `quarantineDir` defaults to the engine's in-tree
 * vault for `target`. The engine prints a human manifest (or "no quarantine
 * manifest in <dir>" when empty — exit 0). FAIL-SOFT: never throws.
 */
export async function quarantineList(
  opts: { target?: string; quarantineDir?: string } & RunOptions = {},
  config: EngineConfig = {},
): Promise<QuarantineListResult> {
  const dir = opts.quarantineDir ?? (opts.target ? defaultQuarantineDir(opts.target) : "");
  if (!dir) {
    return {
      ok: false,
      listing: "",
      quarantineDir: "",
      error: "no quarantine dir or target given",
    };
  }
  try {
    const res = await runNemesis(["restore", "--quarantine-dir", dir, "--list"], opts, config);
    return {
      ok: res.exitCode === 0,
      listing: res.stdout.trim() || res.stderr.trim(),
      quarantineDir: dir,
    };
  } catch (e) {
    return {
      ok: false,
      listing: "",
      quarantineDir: dir,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface RestoreResult {
  ok: boolean;
  id: string;
  message: string;
  error?: string;
}

/**
 * Restore a quarantined item (puts the file back where it was, original mode).
 * `id` may be a quarantine id or "all". Reversible escape hatch (§9.2).
 * FAIL-CLOSED: a non-zero exit or spawn failure ⇒ ok:false.
 */
export async function restore(
  id: string,
  opts: { quarantineDir: string } & RunOptions,
  config: EngineConfig = {},
): Promise<RestoreResult> {
  if (!id?.trim() || !opts?.quarantineDir?.trim()) {
    return {
      ok: false,
      id: id ?? "",
      message: "",
      error: "restore requires an id and quarantine dir",
    };
  }
  try {
    const res = await runNemesis(
      ["restore", "--quarantine-dir", opts.quarantineDir, id],
      opts,
      config,
    );
    return {
      ok: res.exitCode === 0,
      id,
      message: res.stdout.trim() || res.stderr.trim(),
      error: res.exitCode === 0 ? undefined : `restore exited ${res.exitCode}`,
    };
  } catch (e) {
    return { ok: false, id, message: "", error: e instanceof Error ? e.message : String(e) };
  }
}

// --------------------------------------------------------------------------
// PURGE — irreversible (§9.3)
// --------------------------------------------------------------------------

export interface PurgeOptions extends RunOptions {
  /**
   * What is being purged:
   *   - "source": an installed source ⇒ `prometheus.py uninstall <target>` first
   *     (clean lifecycle removal across every agent), then the caller erases
   *     residual cache/clone.
   *   - "file" | "quarantine": a single file / a quarantined vault item. The
   *     engine has no scriptable standalone erase verb (erase is interactive),
   *     so Studio's main process performs the unlink after this confirms intent.
   */
  kind: "source" | "file" | "quarantine";
}

export interface PurgeResult {
  ok: boolean;
  kind: PurgeOptions["kind"];
  target: string;
  /** the uninstall envelope when kind==="source"; null otherwise. */
  uninstall?: EngineEnvelope | null;
  /**
   * true when the engine did the removal; false ⇒ the caller (desktop main) must
   * perform the filesystem unlink itself (file/quarantine kinds — see §9.3).
   */
  engineRemoved: boolean;
  error?: string;
}

/**
 * Purge a target. For an installed SOURCE we route `prometheus.py uninstall`
 * first (the supported clean removal); the caller then erases residual files.
 * For a file / quarantined item, the engine offers no scriptable erase, so this
 * returns engineRemoved:false and the caller (desktop main) does the unlink.
 * FAIL-CLOSED: a transport failure on uninstall ⇒ ok:false (nothing partial).
 */
export async function purge(
  target: string,
  opts: PurgeOptions,
  config: EngineConfig = {},
): Promise<PurgeResult> {
  if (!target?.trim()) {
    return {
      ok: false,
      kind: opts.kind,
      target: target ?? "",
      engineRemoved: false,
      error: "empty target",
    };
  }
  if (opts.kind === "source") {
    try {
      const env = await runPrometheus<EngineEnvelope>(["uninstall", target], opts, config);
      return {
        ok: env.ok !== false,
        kind: "source",
        target,
        uninstall: env,
        engineRemoved: env.ok !== false,
        error: env.ok === false ? (env.error ?? "uninstall reported failure") : undefined,
      };
    } catch (e) {
      const err = e instanceof EngineError ? e.message : String(e);
      return {
        ok: false,
        kind: "source",
        target,
        uninstall: null,
        engineRemoved: false,
        error: err,
      };
    }
  }
  // file / quarantine: no scriptable engine erase — caller performs the unlink.
  return { ok: true, kind: opts.kind, target, engineRemoved: false };
}

// --------------------------------------------------------------------------
// ACCEPT a finding (§5.5) — nemesis ignore
// --------------------------------------------------------------------------

export interface IgnoreListResult {
  ok: boolean;
  listing: string;
  error?: string;
}

/** List the per-finding ignore (accept) entries the gate honours. FAIL-SOFT. */
export async function ignoreList(
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<IgnoreListResult> {
  try {
    const res = await runNemesis(["ignore", "--list"], opts, config);
    return { ok: res.exitCode === 0, listing: res.stdout.trim() || res.stderr.trim() };
  } catch (e) {
    return { ok: false, listing: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export interface AcceptFindingResult {
  ok: boolean;
  ruleId: string;
  path: string;
  /** false in this build: nemesis ignore has no non-interactive add form. */
  supported: boolean;
  reason: string;
}

/**
 * Accept (ignore) a specific finding (§5.5). HONEST LIMIT: `nemesis ignore` in
 * 1.12.0 has only --list/--remove/--clear; the accept entry is created by the
 * engine's interactive [i]gnore decision during a scan, not by a scriptable add.
 * So this returns supported:false (never a silent no-op) — the UI must drive the
 * accept through the interactive scan path. ignoreList() reads existing entries.
 */
export function acceptFinding(target: string, ruleId: string, path: string): AcceptFindingResult {
  return {
    ok: false,
    ruleId,
    path,
    supported: false,
    reason:
      "nemesis 1.12.0 `ignore` has no non-interactive add; create accepts via the " +
      "interactive scan [i]gnore decision, then re-gate (cache-invalidating).",
  };
}
