// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * errors.ts — the EngineError taxonomy.
 *
 * Every failure crossing the JS<->engine seam is surfaced as a typed EngineError
 * so callers (core/cli/desktop main) can branch on `.code` rather than scraping
 * messages. Per C5 the fail-closed codes (spawn_failed / timeout / bad_json /
 * nemesis_unavailable) all mean "we could NOT obtain a trustworthy verdict" and
 * therefore MUST be rendered as a BLOCK by the consumer.
 */

export type EngineErrorCode =
  | "spawn_failed"
  | "timeout"
  | "bad_json"
  | "engine_error"
  | "blocked"
  | "nemesis_unavailable";

/**
 * EngineErrorKind — file 02 §3.5's taxonomy, the UI-facing classification.
 *
 * This is the SAME failure space as EngineErrorCode, spelled in file 02's words.
 * The two are kept in lock-step (no second source of truth): every EngineError
 * exposes BOTH `.code` (the established axis the existing tests/callers branch on)
 * AND `.kind` (the §3.5 axis) via a deterministic map. New kinds that had no old
 * code — `no-output`, `unparseable`, `gate-blocked`, `forced-danger` — map onto
 * the closest existing code so the constructor stays back-compatible, while a
 * caller can still construct with a `kind` directly.
 */
export type EngineErrorKind =
  | "spawn-failed" // python3 not found / not executable
  | "no-output" // engine crashed before emitting JSON (empty stdout)
  | "unparseable" // stdout had no recoverable envelope
  | "timeout" // SIGKILL fired (fail-closed)
  | "engine-error" // ok:false WITH an `error` string in the envelope
  | "gate-blocked" // verdict block / a `blocked` install_event with NO --force
  | "forced-danger" // a forced_danger override happened (ok:false, different bad)
  | "nemesis-unavailable"; // scanner missing/errored (fail-closed BLOCK)

/** code -> the canonical §3.5 kind. `bad_json` is the no-output/unparseable family. */
const KIND_BY_CODE: Record<EngineErrorCode, EngineErrorKind> = {
  spawn_failed: "spawn-failed",
  timeout: "timeout",
  bad_json: "unparseable",
  engine_error: "engine-error",
  blocked: "gate-blocked",
  nemesis_unavailable: "nemesis-unavailable",
};

/** §3.5 kind -> the established code (for callers constructing by kind). */
const CODE_BY_KIND: Record<EngineErrorKind, EngineErrorCode> = {
  "spawn-failed": "spawn_failed",
  "no-output": "bad_json",
  unparseable: "bad_json",
  timeout: "timeout",
  "engine-error": "engine_error",
  "gate-blocked": "blocked",
  "forced-danger": "engine_error",
  "nemesis-unavailable": "nemesis_unavailable",
};

export interface EngineErrorInit {
  code: EngineErrorCode;
  exitCode?: number;
  stderrTail?: string;
  envelope?: unknown;
  cause?: unknown;
  /**
   * Optional explicit §3.5 kind. When omitted it is DERIVED from `code`. Provide
   * it to distinguish kinds that share a code (no-output vs unparseable; or to
   * tag a forced-danger which also carries code "engine_error").
   */
  kind?: EngineErrorKind;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** the file-02 §3.5 classification (derived from code unless given explicitly). */
  readonly kind: EngineErrorKind;
  readonly exitCode?: number;
  readonly stderrTail?: string;
  readonly envelope?: unknown;

  constructor(message: string, init: EngineErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "EngineError";
    this.code = init.code;
    this.kind = init.kind ?? KIND_BY_CODE[init.code];
    this.exitCode = init.exitCode;
    this.stderrTail = init.stderrTail;
    this.envelope = init.envelope;
    // Restore prototype chain for instanceof under transpiled targets.
    Object.setPrototypeOf(this, EngineError.prototype);
  }

  /**
   * fromKind — construct an EngineError from a §3.5 kind (the code is derived).
   * Lets the typed facade/UI layer throw in file-02 vocabulary without knowing
   * the legacy code mapping.
   */
  static fromKind(
    kind: EngineErrorKind,
    message: string,
    extra: Omit<EngineErrorInit, "code" | "kind"> = {},
  ): EngineError {
    return new EngineError(message, { ...extra, code: CODE_BY_KIND[kind], kind });
  }

  /**
   * A fail-closed error is one where we could not obtain a trustworthy verdict
   * and the consumer MUST treat the situation as a BLOCK (C5 GOLDEN RULE).
   * forced-danger is NOT fail-closed: it is a verdict the user explicitly
   * overrode — a different class of bad the security UI renders loudly.
   */
  get failClosed(): boolean {
    return (
      this.kind === "spawn-failed" ||
      this.kind === "timeout" ||
      this.kind === "no-output" ||
      this.kind === "unparseable" ||
      this.kind === "nemesis-unavailable"
    );
  }
}

/** The set of §3.5 kinds. Handy for exhaustive switches / tests. */
export const ENGINE_ERROR_KINDS: readonly EngineErrorKind[] = [
  "spawn-failed",
  "no-output",
  "unparseable",
  "timeout",
  "engine-error",
  "gate-blocked",
  "forced-danger",
  "nemesis-unavailable",
] as const;

/** Narrowing helper for callers that catch unknown. */
export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}

/**
 * A one-line, USER-FACING description of any failure crossing the engine seam.
 *
 * Twenty copies of a local `errString(e)` existed across `apps/desktop/src/main/*.ts`, in three
 * slightly different spellings, and every one of them returned `e.message` alone. For an
 * `EngineError` that is the wrong half of the information: `run.ts` rejects a crashed engine
 * with the generic `"prometheus.py produced no JSON on stdout (crashed before emitting)"` and
 * puts the engine's REAL complaint in `stderrTail`. The copies dropped it, so a precise
 * diagnosis arrived at the user as a crash report.
 *
 * Measured instance (2026-10-01): Studio's Chat offered a runner the engine's argparse did not
 * accept. The engine said, exactly, `argument --runner: invalid choice: 'llamacpp' (choose from
 * 'ollama', 'lmstudio')`. The banner said `prometheus.py produced no JSON on stdout (crashed
 * before emitting)`. The word `llamacpp` never reached the screen, and nothing pointed at the
 * runner selection. The argparse list has since been fixed, but the reporting defect was
 * independent of it and would have hidden the next one too.
 *
 * `stderrTail` can be long and can contain a traceback, so only the LAST non-empty line is
 * appended — that is where both argparse and a Python traceback put the actual reason.
 */
export function describeEngineFailure(e: unknown): string {
  if (e instanceof EngineError) {
    const tail = lastMeaningfulLine(e.stderrTail);
    // Avoid "X — X" when the engine's own line is already the message.
    return tail && !e.message.includes(tail) ? `${e.message} — ${tail}` : e.message;
  }
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

/** The last non-empty line of a stderr tail — where argparse and tracebacks put the reason. */
function lastMeaningfulLine(stderr: string | undefined): string | undefined {
  if (!stderr) return undefined;
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines[lines.length - 1];
}
