/**
 * main/sidecar.ts — the MAIN-process adapter for the Studio Python helper
 * sidecars (C7/C8).
 *
 * The NEW sidecars (python/sidecar/envmgr.py, modelhub.py) are NOT prometheus.py
 * subcommands — per C7 each is its own Python program emitting EXACTLY ONE JSON
 * object on stdout. Per C8 they are a MAIN-process concern (one-shot verbs only;
 * long-lived runners go through the ServerSupervisor).
 *
 * Per C5 / file 02 §1.1, node:child_process is imported by exactly ONE package
 * (@prometheus/engine-bridge). This adapter delegates the spawn to engine-bridge's
 * canonical `runSidecar` and re-shapes the result into the desktop's historical
 * `SidecarResult` (so main/ipc.ts and tests are unchanged), preserving the old
 * reject-on-runner-failure semantics.
 *
 * MAIN-PROCESS ONLY. Never importable into the sandboxed renderer.
 */
import { runSidecar as runSidecarScript } from "@prometheus/engine-bridge";

/** The known one-shot sidecars and their script filenames. */
const SIDECARS = {
  envmgr: "envmgr.py",
  modelhub: "modelhub.py",
  testmgr: "testmgr.py",
  // file 14 §3.28: the Python profiler backend (cProfile → flame folds, APP-046).
  profile: "profile.py",
  // MDS parity 39: the tree-sitter/stdlib repo-map for @codebase grounding (APP-053).
  repomap: "repomap.py",
  // JetBrains parity 03/28: the ruff/flake8/mypy/pylint fan-in for Problems (APP-062).
  linters: "linters.py",
  // MDS parity 06: structural search-and-replace over Python ASTs (APP-076).
  structsearch: "structsearch.py",
  // MDS parity 15: coverage.py runner → CoverageReport + merge/import (APP-086).
  coverage: "coverage.py",
} as const;

export type SidecarName = keyof typeof SIDECARS;

export interface SidecarResult {
  ok: boolean;
  /** the parsed one-JSON-object envelope the sidecar emitted on stdout. */
  data: Record<string, unknown>;
  exitCode: number;
  /** stderr (diagnostics only). */
  stderr: string;
}

export interface RunSidecarOptions {
  /** ms before SIGKILL (fail-closed). Default 60s — sidecars are quick. */
  timeoutMs?: number;
}

/**
 * Run a one-shot sidecar verb: `python3 <sidecar>.py <verb> [args...]`.
 * Resolves with the parsed envelope; REJECTS (fail-closed) on a missing script,
 * spawn failure, timeout, or unparseable stdout — matching the previous contract.
 */
export async function runSidecar(
  sidecar: SidecarName,
  verb: string,
  args: string[] = [],
  opts: RunSidecarOptions = {},
): Promise<SidecarResult> {
  const env = await runSidecarScript(SIDECARS[sidecar], [verb, ...args], {
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  // engine-bridge's runner FAIL-CLOSES to { ok:false, error } only on a runner
  // failure (missing script / spawn / timeout / unparseable). A sidecar that
  // legitimately emits {ok:false} carries NO `error` field — so we reject only on
  // a true runner failure, preserving the old behavior.
  if (typeof env.error === "string") {
    throw new Error(`sidecar ${sidecar} ${verb}: ${env.error}`);
  }
  const exitCode = typeof env._exit === "number" ? env._exit : 0;
  return { ok: env.ok !== false, data: env as Record<string, unknown>, exitCode, stderr: "" };
}
