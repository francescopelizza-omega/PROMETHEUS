// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * client.ts — createEngineClient: the assembled EngineClient (the SHARED_API).
 *
 * This is the public gateway core/cli/desktop import. It wraps run.ts (the only
 * python3 spawner) and security/gate.ts (the only nemesis runner). Every method
 * threads the EngineConfig captured at construction so callers can point at a
 * non-default engine once and forget it.
 *
 * GOLDEN RULE (C5): nothing here decides "safe". install() does NOT pre-judge —
 * it forwards to the engine, which runs nemesis itself and returns a forced_danger
 * / ok:false envelope when blocked. gate() is the explicit arbitrary-target path.
 */
import { Commands } from "./commands.js";
import type { EngineConfig } from "./config.js";
import { type EngineEnvelope, type RunOptions, runPrometheus } from "./run.js";
import { type NemesisRunResult, gate, runNemesis } from "./security/gate.js";
import type { SecurityVerdict } from "./security/verdict.js";
import {
  type EngineCapabilities,
  type EngineVersion,
  detectEngineVersion,
  negotiateCapabilities,
} from "./version.js";

export interface EngineClient {
  runPrometheus<T extends EngineEnvelope = EngineEnvelope>(
    argv: string[],
    opts?: RunOptions,
  ): Promise<T>;
  runNemesis(
    argv: string[],
    opts?: RunOptions,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; json?: unknown }>;
  gate(target: string, opts?: RunOptions): Promise<SecurityVerdict>;
  scan(opts?: RunOptions): Promise<EngineEnvelope>;
  list(opts?: RunOptions): Promise<EngineEnvelope>;
  info(name: string, opts?: RunOptions): Promise<EngineEnvelope>;
  status(name: string, opts?: RunOptions): Promise<EngineEnvelope>;
  matrix(opts?: RunOptions): Promise<EngineEnvelope>;
  superscan(opts?: RunOptions): Promise<EngineEnvelope>;
  where(name: string, opts?: RunOptions): Promise<EngineEnvelope>;
  install(
    name: string,
    opts?: RunOptions & { dryRun?: boolean; forced?: boolean },
  ): Promise<EngineEnvelope>;
  uninstall(name: string, opts?: RunOptions): Promise<EngineEnvelope>;
  enable(name: string, opts?: RunOptions): Promise<EngineEnvelope>;
  disable(name: string, opts?: RunOptions): Promise<EngineEnvelope>;
  vaultStatus(opts?: RunOptions): Promise<EngineEnvelope>;
  /** Probe the engine's SCRIPT_VERSION (version-skew negotiation, file 01 §Open-Q7). */
  version(opts?: { timeoutMs?: number }): Promise<EngineVersion>;
  /** Feature-flag map negotiated from the engine version vs the bundle MIN_ENGINE. */
  capabilities(opts?: { timeoutMs?: number }): Promise<EngineCapabilities>;
}

export function createEngineClient(config: EngineConfig = {}): EngineClient {
  const run = <T extends EngineEnvelope = EngineEnvelope>(argv: string[], opts?: RunOptions) =>
    runPrometheus<T>(argv, opts ?? {}, config);

  return {
    runPrometheus: run,

    runNemesis: (argv: string[], opts?: RunOptions): Promise<NemesisRunResult> =>
      runNemesis(argv, opts ?? {}, config),

    gate: (target: string, opts?: RunOptions) => gate(target, opts ?? {}, config),

    scan: (opts?) => run(Commands.scan(), opts),
    list: (opts?) => run(Commands.list(), opts),
    matrix: (opts?) => run(Commands.matrix(), opts),
    superscan: (opts?) => run(Commands.superscan(), opts),
    info: (name, opts?) => run(Commands.info(name), opts),
    where: (name, opts?) => run(Commands.where(name), opts),
    status: (name, opts?) => run(Commands.status(name), opts),
    vaultStatus: (opts?) => run(Commands.vaultStatus(), opts),

    install: (name, opts?) =>
      run(
        Commands.install(name, {
          dryRun: opts?.dryRun ?? false,
          forced: opts?.forced ?? false,
        }),
        opts,
      ),

    uninstall: (name, opts?) => run(Commands.uninstall(name), opts),
    enable: (name, opts?) => run(Commands.enable(name), opts),
    disable: (name, opts?) => run(Commands.disable(name), opts),

    // Version-skew negotiation (file 01 §Open-Q7). Both thread the captured
    // config so callers probe the SAME engine every other method talks to.
    version: (opts?) => detectEngineVersion(config, opts),
    capabilities: async (opts?) => negotiateCapabilities(await detectEngineVersion(config, opts)),
  };
}
