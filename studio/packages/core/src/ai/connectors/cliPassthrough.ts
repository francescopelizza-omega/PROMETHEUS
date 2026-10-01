// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/connectors/cliPassthrough.ts — Tier-B vendor-CLI connector (file 12 §1.2).
 *
 * Spawn the vendor's own CLI (claude / cursor / copilot); IT owns auth + billing, so
 * Studio holds no secret. Two load-bearing safety rules:
 *  1. NEMESIS GATE BEFORE FIRST SPAWN — the launch spec must clear an injected gate;
 *     a `block` (or `error`) verdict aborts the spawn. (Mirrors file-11's agent loop.)
 *  2. NEVER --force — the agent must NEVER auto-supply `--force` / `--force-unsafe`;
 *     those are human-typed only. Any such token in the args is REFUSED at build time.
 *
 * `buildCliLaunchSpec` is pure (and runs the force check); `launchCliPassthrough`
 * gates then spawns via injected seams (no node:child_process in core).
 */
import type { ConnectorConfig, Provider } from "../providers/types.js";
import {
  type CliLaunchSpec,
  ConnectorError,
  type GateFn,
  type GateVerdict,
  type SpawnLike,
} from "./types.js";

/** Tokens the agent must NEVER auto-supply (human-typed only). */
export const FORBIDDEN_CLI_FLAGS: readonly string[] = ["--force", "--force-unsafe"];

function findForbidden(args: readonly string[]): string[] {
  return args.filter((a) => FORBIDDEN_CLI_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
}

export interface CliLaunchOpts {
  /** extra args to pass after the bin (validated for forbidden flags). */
  args?: string[];
  /** extra env for the child (cli-passthrough providers usually need none). */
  env?: Record<string, string>;
  /** extra stderr-redaction keys beyond the built-in secret set. */
  redactKeys?: string[];
}

/**
 * Build a cli-passthrough launch spec. Pure + total: throws ConnectorError if the
 * connector is the wrong kind, the provider declares no `cliBin`, or the args contain
 * a forbidden flag. Does NOT spawn — call `launchCliPassthrough` for that.
 */
export function buildCliLaunchSpec(
  connector: ConnectorConfig,
  provider: Provider,
  opts: CliLaunchOpts = {},
): CliLaunchSpec {
  if (connector.kind !== "cli-passthrough") {
    throw new ConnectorError(
      `${provider.label}: buildCliLaunchSpec needs a cli-passthrough connector`,
      [`got kind "${connector.kind}"`],
    );
  }
  if (!provider.cliBin) {
    throw new ConnectorError(`${provider.label}: provider declares no cliBin in the matrix`);
  }
  const args = opts.args ?? [];
  const forbidden = findForbidden(args);
  if (forbidden.length > 0) {
    throw new ConnectorError(
      `${provider.label}: refusing to launch with agent-supplied force flags (human-typed only)`,
      forbidden,
    );
  }
  return {
    providerId: provider.id,
    bin: provider.cliBin,
    args,
    env: opts.env ?? {},
    redactKeys: opts.redactKeys ?? [],
  };
}

/** The result of a gated launch attempt. */
export interface CliLaunchResult {
  spec: CliLaunchSpec;
  verdict: GateVerdict;
  /** the spawned child handle, present ONLY when the gate allowed/warned and spawn ran. */
  child?: { pid?: number };
}

export interface CliLaunchDeps {
  gate: GateFn;
  spawn: SpawnLike;
}

/**
 * Gate → spawn a cli-passthrough connector. The gate runs FIRST: a `block`/`error`
 * verdict throws ConnectorError and NOTHING is spawned. `warn`/`allow` proceed (warn is
 * surfaced to the caller via the returned verdict). The force check is re-run as a
 * second line of defense even though the spec was already built clean.
 */
export async function launchCliPassthrough(
  spec: CliLaunchSpec,
  deps: CliLaunchDeps,
): Promise<CliLaunchResult> {
  const forbidden = findForbidden(spec.args);
  if (forbidden.length > 0) {
    throw new ConnectorError("refusing to launch with force flags (human-typed only)", forbidden);
  }
  const verdict = await deps.gate(spec);
  if (verdict.decision === "block" || verdict.decision === "error") {
    throw new ConnectorError(
      `nemesis ${verdict.decision} for "${spec.bin}"`,
      verdict.reason ? [verdict.reason] : [],
    );
  }
  const child = deps.spawn(spec.bin, spec.args, { env: spec.env });
  return { spec, verdict, child };
}
