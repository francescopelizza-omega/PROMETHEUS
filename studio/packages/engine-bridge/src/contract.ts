// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * contract.ts — the CANONICAL wire-type import site (file 01 §11.2).
 *
 * Every consumer that wants to TYPE the bytes crossing the JS<->engine seam imports
 * them from HERE, so there is a single source of truth for the contract shapes:
 *   - the C2 JSON envelope every `prometheus.py --json <cmd>` returns,
 *   - the C3 verdict axes (VerdictTier decision / Severity),
 *   - the forced-danger override block (`--force` past a nemesis BLOCK),
 *   - the per-(plugin,agent) InstallEvent rows in the install/uninstall envelope.
 *
 * This module ONLY re-exports / consolidates types already defined in run.ts and
 * security/verdict.ts (no logic, no second definition) plus the InstallEvent /
 * InstallResultEnvelope shapes ground-truthed against prometheus.py's
 * `_install_events_json` (the real `--json install` output). Importing the wire
 * model through one door keeps every renderer in sync with the engine.
 *
 * GROUND TRUTH (prometheus.py @ SCRIPT_VERSION 0.15.0):
 *   - `_install_events_json` (prometheus.py:8707) emits
 *       {command, ok, request:{plugin,dry_run,target_agents[]},
 *        results:{ install_events:[{plugin,agent,scope,method,result}], summary },
 *        _exit, forced_danger?}
 *   - InstallEvent dataclass (prometheus.py:8501):
 *       plugin:str  agent:str  scope:"claude-only"|"universal"
 *       result: installed|already|blocked|failed|skipped   method:str
 */

// --- C2: the JSON envelope every subcommand shares -------------------------- //
// EngineEnvelope<T> below extends this so payload fields stay strongly typed.
export type { EngineEnvelope as EngineEnvelopeBase } from "./run.js";

// --- C3: the verdict model (single source of truth, security/verdict.ts) ---- //
export type {
  VerdictTier,
  Severity,
  Finding,
  SecurityVerdict,
  NemesisVerdictRef,
  GateBadge,
  ForcedDanger,
} from "./security/verdict.js";

import type { EngineEnvelope as _EngineEnvelopeBase } from "./run.js";
import type { ForcedDanger as _ForcedDanger } from "./security/verdict.js";

/**
 * EngineEnvelope<T> — the canonical, GENERIC view of the C2 wire object.
 *
 * The base `EngineEnvelope` in run.ts carries `{command, ok, error?, _exit?,
 * forced_danger?, [k]:unknown}`. file 01 §11.2 asks for a parameterised
 * `EngineEnvelope<T>` so a caller can narrow the subcommand-specific payload
 * (e.g. `EngineEnvelope<InstallResults>`) while keeping the shared fields.
 *
 * `T` defaults to the loose record so a bare `EngineEnvelope` behaves exactly
 * like the run.ts base type (back-compatible). The contract keys are spelled
 * out explicitly here so they survive the `& T` intersection.
 */
export type EngineEnvelope<T = Record<string, unknown>> = {
  /** subcommand name echoed by the engine (e.g. "install", "scan"). */
  command: string;
  /** false on any failure OR on a forced-dangerous install (never "clean"). */
  ok: boolean;
  /** human-readable error string when ok:false. */
  error?: string;
  /** process exit code, stamped by the run layer. */
  _exit?: number;
  /** present when a nemesis BLOCK/error was overridden via --force. */
  forced_danger?: _ForcedDanger[];
} & T;

/** The exact base envelope run.ts produces (loose index signature preserved). */
export type AnyEngineEnvelope = _EngineEnvelopeBase;

// --- install/uninstall envelope (real `--json install` output) -------------- //

/** Per-(plugin,agent) outcome row. `clean` is NOT a result here — see VerdictTier. */
export type InstallResult = "installed" | "already" | "blocked" | "failed" | "skipped";

/** Plugin install scope (Plugin.claude_exclusive -> "claude-only" else "universal"). */
export type InstallScope = "claude-only" | "universal";

/**
 * InstallEvent — one row of the install/uninstall envelope's
 * results.install_events[]. Mirrors the InstallEvent dataclass
 * (prometheus.py:8501) field-for-field.
 */
export interface InstallEvent {
  plugin: string;
  /** agent name, or "(all detected via skills CLI)" for universal fan-out. */
  agent: string;
  scope: InstallScope;
  /** install method (registry adapter), may be "" for skip rows. */
  method: string;
  result: InstallResult;
}

/** results.summary: a tally of how many events fell into each result bucket. */
export type InstallSummary = Partial<Record<InstallResult, number>>;

/** The `results` block of the install/uninstall envelope. */
export interface InstallResults {
  install_events: InstallEvent[];
  summary: InstallSummary;
}

/** The `request` echo block of the install/uninstall envelope. */
export interface InstallRequest {
  plugin: string;
  dry_run: boolean;
  target_agents: string[];
}

/**
 * The full install/uninstall envelope, typed end-to-end:
 * `EngineEnvelope<{request, results}>` plus the optional forced_danger from the
 * base. Use this to narrow `client.install(...)`'s return value.
 */
export type InstallEnvelope = EngineEnvelope<{
  request: InstallRequest;
  results: InstallResults;
}>;
