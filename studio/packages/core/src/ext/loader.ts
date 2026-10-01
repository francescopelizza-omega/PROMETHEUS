// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ext/loader.ts — the PURE .promext install decision (file 09 §5.3).
 *
 *   .promext ─▶ (host) unzip to staging ─▶ planInstall(manifest) ─▶ gate target
 *                                              │
 *                  nemesis gate(repo | staging-dir) ─▶ verdict ─▶ allow/warn:
 *                  show declared permissions ─▶ user approves ─▶ install to
 *                  ~/.prometheus-studio/extensions/<id>/
 *
 * This module owns the pure half: validate compatibility, compute the install path,
 * pick the nemesis gate target (repo wins over the staging dir), and render the
 * declared-permission summary the install gate shows. The unzip + fs + the actual
 * nemesis gate are the host's (injected) job.
 */
import { join } from "node:path";
import { isCompatible } from "./manifest.js";
import type { ExtPermissions, ExtensionManifest } from "./types.js";

/** A human-readable, exhaustive summary of what the extension may do (shown at install). */
export function permissionSummary(perms: ExtPermissions | undefined): string[] {
  const p = perms;
  if (!p || Object.keys(p).length === 0) return ["No special permissions requested."];
  const lines: string[] = [];
  if (p.fs?.read?.length) lines.push(`Read files: ${p.fs.read.join(", ")}`);
  if (p.fs?.write?.length) lines.push(`Write files: ${p.fs.write.join(", ")}`);
  else lines.push("Write files: (none)");
  if (p.network === "none" || p.network === undefined) lines.push("Network: none");
  else if (p.network === "mcp-only") lines.push("Network: declared MCP servers only");
  else lines.push(`Network: ${p.network.join(", ")}`);
  if (p.engine?.length) lines.push(`Engine commands: ${p.engine.join(", ")}`);
  if (p.secrets?.length) lines.push(`Secrets: ${p.secrets.join(", ")}`);
  if (p.shell) lines.push("Shell access: YES");
  return lines;
}

/** The nemesis gate target for a manifest: its source repo, else the staging dir. */
export function gateTargetFor(manifest: ExtensionManifest, stagingDir: string): string {
  return manifest.repo ?? stagingDir;
}

export interface InstallPlan {
  id: string;
  installPath: string;
  gateTarget: string;
  permissions: string[];
  compatible: boolean;
}

export interface InstallPlanError {
  error: string;
}

export type InstallPlanResult = InstallPlan | InstallPlanError;

/** True if the plan errored (a type guard for callers). */
export function isPlanError(r: InstallPlanResult): r is InstallPlanError {
  return (r as InstallPlanError).error !== undefined;
}

export interface PlanInstallOptions {
  /** the extensions root, e.g. ~/.prometheus-studio/extensions. */
  extensionsDir: string;
  /** the unzipped staging dir (the host unzipped the .promext here). */
  stagingDir: string;
  /** the running Studio version, for the engines.studio compat gate. */
  studioVersion?: string;
}

/**
 * Compute the install plan for a validated manifest. Errors (not throws) on a
 * studio-version incompatibility — the gate + permission summary still render so the
 * UI can explain why install is unavailable.
 */
export function planInstall(
  manifest: ExtensionManifest,
  opts: PlanInstallOptions,
): InstallPlanResult {
  const compatible = opts.studioVersion ? isCompatible(manifest, opts.studioVersion) : true;
  if (!compatible) {
    return {
      error: `extension "${manifest.id}" requires Studio ${manifest.engines?.studio ?? "?"}`,
    };
  }
  return {
    id: manifest.id,
    installPath: join(opts.extensionsDir, manifest.id),
    gateTarget: gateTargetFor(manifest, opts.stagingDir),
    permissions: permissionSummary(manifest.permissions),
    compatible,
  };
}
