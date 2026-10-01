// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/dap-adapter-install.ts — detect + stage→gate→install for debug adapters
 * (file 07 §5, APP-029).
 *
 * DETECTION is a plain read-only probe (no gating needed — it runs nothing that
 * doesn't already exist): `<python> -c "import debugpy"` via engine-bridge's
 * `probeSystemCommand` (the same safe execFile wrapper the telemetry probes use).
 *
 * INSTALL cannot gate the bare package name — verified empirically against this
 * repo's own `nemesis` binary: `nemesis gate debugpy` returns verdict "error"
 * ("path not found"), because nemesis scans CONTENT at a real path, not a package
 * name. So install STAGES the package first (`pip download`, same shape as
 * envmgr.py's pkg-install pipeline: stage → nemesis on the staged files → gated
 * install), then installs FROM the already-scanned local files — never fetching
 * different bytes than what was gated.
 *
 * Both entry points take injected `probe`/`runCmd`/`gateTarget` fns so this stays
 * unit-testable without a real pip/nemesis spawn; `wireRealDapAdapterInstall`
 * (main/index.ts) supplies the real implementations.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  type EngineConfig,
  type SecurityVerdict,
  gate as engineGate,
  probeSystemCommand,
  safeChildEnv,
} from "@prometheus/engine-bridge";

import type { DapAdapterAvailability, DapAdapterInstallResult } from "./dap-host.js";

const execFileP = promisify(execFile);

/* ── injected seams ─────────────────────────────────────────────────────────*/

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, capturing output (never throws — a spawn/exit
 *  failure comes back as a non-zero `code` + populated `stderr`). */
export type CmdRunner = (
  cmd: string,
  args: readonly string[],
  opts?: { timeoutMs?: number },
) => Promise<CmdResult>;

/** Read-only probe: stdout on success, null on any failure (mirrors probeSystemCommand). */
export type ProbeFn = (cmd: string, args: string[]) => Promise<string | null>;

/** Gate a REAL filesystem path (never a bare package name — see module doc). */
export type GateTargetFn = (target: string) => Promise<SecurityVerdict>;

/* ── real implementations (wired in main/index.ts) ──────────────────────────*/

/** The real command runner: safe-env execFile, never a shell, bounded buffer/timeout. */
export const realCmdRunner: CmdRunner = async (cmd, args, opts = {}) => {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      timeout: opts.timeoutMs ?? 120_000,
      env: safeChildEnv(),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr || err.message || String(e),
    };
  }
};

export const realProbe: ProbeFn = probeSystemCommand;

/** Build the real gate fn bound to one engine config (main/index.ts's ideIpc config). */
export function makeRealGateTarget(engineConfig: EngineConfig = {}): GateTargetFn {
  return (target) => engineGate(target, {}, engineConfig);
}

/* ── detection ───────────────────────────────────────────────────────────────*/

/** Detect whether `type`'s adapter actually runs, given the injected probe. */
export async function detectDapAdapter(
  type: string,
  pythonPath: string | undefined,
  probe: ProbeFn,
): Promise<DapAdapterAvailability> {
  if (type === "python") {
    const py = pythonPath || "python3";
    const out = await probe(py, ["-c", "import debugpy"]);
    return {
      type,
      available: out !== null,
      detail: out !== null ? `debugpy import ok (${py})` : `debugpy not importable via ${py}`,
    };
  }
  // node/rust: no chosen distribution yet (§5.3) — a best-effort presence probe only,
  // honestly labelled (found-on-PATH is not the same as "verified DAP-capable").
  const out = await probe(type === "node" ? "js-debug" : "codelldb", ["--version"]);
  return {
    type,
    available: out !== null,
    detail:
      out !== null
        ? "found on PATH (presence only — not verified DAP-capable)"
        : `"${type === "node" ? "js-debug" : "codelldb"}" not found on PATH`,
  };
}

/* ── install (python/debugpy only — see module doc) ─────────────────────────*/

/** Stage `pip download`, gate the STAGED files, install from them only on a clean
 *  (or confirmed-warn) verdict. Never installs on block/error; never re-fetches
 *  different bytes than what nemesis actually scanned. */
export async function installDapAdapter(
  type: string,
  opts: { pythonPath?: string; confirm?: boolean },
  runCmd: CmdRunner,
  gateTarget: GateTargetFn,
): Promise<DapAdapterInstallResult> {
  if (type !== "python") {
    return {
      ok: false,
      output: "",
      error: `install not supported for debug type "${type}" yet — install its adapter manually`,
    };
  }
  const py = opts.pythonPath || "python3";
  const dir = await mkdtemp(join(tmpdir(), "prom-dap-stage-"));
  try {
    const dl = await runCmd(py, [
      "-m",
      "pip",
      "download",
      "--no-deps",
      "--dest",
      dir,
      "--disable-pip-version-check",
      "debugpy",
    ]);
    if (dl.code !== 0) {
      return {
        ok: false,
        output: dl.stdout + dl.stderr,
        error: `download failed: ${(dl.stderr || dl.stdout).trim() || `exit ${dl.code}`}`,
      };
    }
    const verdict = await gateTarget(dir);
    if (verdict.verdict === "block" || verdict.verdict === "error") {
      return {
        ok: false,
        blocked: true,
        output: dl.stdout,
        error: `blocked by nemesis (${verdict.verdict}) — refusing to install`,
      };
    }
    if (verdict.verdict === "warn" && !opts.confirm) {
      return {
        ok: false,
        needsConfirm: true,
        output: dl.stdout,
        error: "nemesis found warnings in the staged download — confirm to proceed",
      };
    }
    const inst = await runCmd(py, [
      "-m",
      "pip",
      "install",
      "--no-index",
      "--find-links",
      dir,
      "debugpy",
    ]);
    if (inst.code !== 0) {
      return {
        ok: false,
        output: `${dl.stdout}${inst.stdout}${inst.stderr}`,
        error: `install failed: ${(inst.stderr || inst.stdout).trim() || `exit ${inst.code}`}`,
      };
    }
    return { ok: true, output: `${dl.stdout}${inst.stdout}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
