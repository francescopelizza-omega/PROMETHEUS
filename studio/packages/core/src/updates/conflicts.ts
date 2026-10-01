// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/conflicts.ts — cross-check what a package manager OFFERS against what actually runs.
 *
 * This is the file the user's bug report is about. Everything else in `updates/` answers a
 * question in isolation; this compares two answers that are each individually correct and
 * together describe a trap.
 *
 * ── THE TRAP, FROM THIS MACHINE, 2026-09-29 ─────────────────────────────────────────────────
 *
 * `brew outdated --greedy` says, truthfully:
 *
 *     claude-code (cask)  2.1.274 -> 2.1.277
 *
 * `install-owner.ts` says, truthfully:
 *
 *     claude RUNS 2.1.284, from ~/.local/share/claude/versions/2.1.284 (vendor installer)
 *            ALSO 2.1.274, from /opt/homebrew/Caskroom/claude-code    (Homebrew cask)
 *
 * Put together they say something neither says alone: **the upgrade Homebrew is offering would
 * install 2.1.277 — a version OLDER than the 2.1.284 you are running — into a path your PATH
 * never reaches.** Run it and brew reports success, `claude --version` is unchanged, and
 * `brew outdated` will offer it again tomorrow. In the user's words: "brew installs another
 * newer version alongside and never lets me use it."
 *
 * The same shape, twice more on the same machine:
 *   • `npm install -g @openai/codex@latest` (0.142.5 -> 0.158.0) targets a copy in a bin
 *     directory that is not on PATH at all, so it is a no-op with an exit code of 0.
 *   • `ollama` runs a 0.34.4 Homebrew CLI against the 0.34.1 server inside Ollama.app, which
 *     owns :11434. No version comparison of the CLI can see that.
 *
 * PURE: resolutions and package rows in, findings out. No IO.
 */

import {
  type InstallOwner,
  type ToolCopy,
  type ToolResolution,
  ownerLabel,
  viaForOwner,
} from "./install-owner.js";
import type { OutdatedPackage } from "./package-managers.js";
import { compareVersions, withoutRevision } from "./semver.js";

/** What kind of trouble this is. Ordered roughly by how badly it misleads. */
export type ConflictKind =
  /**
   * A manager offers an upgrade for a copy that is NOT the one on PATH, and the version it would
   * install is OLDER than the one running. The most misleading case: the command succeeds.
   */
  | "downgrade-offer"
  /** A manager offers an upgrade for a copy that is not on PATH. Succeeds, changes nothing. */
  | "shadowed-upgrade"
  /** Two managers own the same command name. */
  | "duplicate-install"
  /** A newer copy exists but PATH resolves to an older one. */
  | "shadowed-newer"
  /** A manager's bin directory is not on PATH, so installing through it produces nothing usable. */
  | "unreachable-bin-dir"
  /** A client and the server it drives are different versions. */
  | "client-server-skew";

export interface Conflict {
  kind: ConflictKind;
  /** the tool or package name the user would recognise. */
  subject: string;
  /** one line, stating the fact. */
  summary: string;
  /** what would happen if the obvious command were run. */
  consequence: string;
  /** the command to run INSTEAD, when there is one. */
  remedy?: string;
  /**
   * A command that looks right and is not. Named explicitly, because the user will otherwise
   * find it themselves — in `brew outdated`, in a changelog, in a forum answer — and run it.
   */
  avoid?: string;
  severity: "high" | "medium" | "low";
}

/** Does this package row plausibly describe this copy? */
function ownsCopy(pkg: OutdatedPackage, copy: ToolCopy): boolean {
  const via = viaForOwner(copy.owner);
  if (pkg.manager === "brew") {
    if (copy.owner !== "brew-formula" && copy.owner !== "brew-cask") return false;
    // The formula/cask kinds must agree, or `ollama` would be matched to `ollama-app`.
    if (pkg.kind === "formula" && copy.owner !== "brew-formula") return false;
    if (pkg.kind === "cask" && copy.owner !== "brew-cask") return false;
    return pkg.name === copy.name;
  }
  if (pkg.manager === "npm-global") return via === "npm" && pkg.name === copy.name;
  if (pkg.manager === "pipx") return via === "pipx" && pkg.name === copy.name;
  return false;
}

/**
 * Compare an offered version against a running one, tolerating the shapes package managers use.
 *
 * Revisions are stripped: `brew outdated` reporting `3.6.4 -> 3.6.4_1` is a rebuild, and calling
 * that a downgrade — or an upgrade worth alarming about — would be wrong in both directions.
 */
function offeredVs(running: string | undefined, offered: string | undefined): -1 | 0 | 1 | null {
  if (!running || !offered) return null;
  return compareVersions(withoutRevision(offered), withoutRevision(running));
}

export interface ConflictInput {
  /** one per tool PROMETHEUS knows, from `resolveTool`. */
  resolutions: readonly ToolResolution[];
  /** everything the package managers reported as upgradable. */
  outdated: readonly OutdatedPackage[];
  /** manager bin directories that are NOT reachable from PATH, keyed by manager label. */
  unreachableBinDirs?: readonly { manager: string; dir: string; installCommand: string }[];
  /** a running server's version, when a tool is a client/server pair. */
  serverVersions?: Readonly<Record<string, string>>;
}

/**
 * Everything that would mislead a user who trusted one source on its own.
 *
 * Deliberately returns findings rather than filtering the update list: the user is entitled to
 * know that `brew outdated` names `claude-code`, AND that acting on it will not do what it looks
 * like it does. Hiding the row would leave them to rediscover it in `brew outdated` with no
 * warning attached.
 */
export function findConflicts(input: ConflictInput): Conflict[] {
  const out: Conflict[] = [];

  for (const res of input.resolutions) {
    if (!res.winner) continue;
    const winner = res.winner;

    /* --- a manager offering to upgrade a copy that is not the one on PATH --- */
    for (const pkg of input.outdated) {
      const target = res.copies.find((c) => ownsCopy(pkg, c));
      if (!target || target === winner) continue;
      const cmp = offeredVs(winner.version, pkg.available);
      const line =
        pkg.manager === "brew" && pkg.kind === "cask"
          ? `brew upgrade --cask ${pkg.name}`
          : pkg.manager === "brew"
            ? `brew upgrade ${pkg.name}`
            : pkg.manager === "npm-global"
              ? `npm install -g ${pkg.name}@latest`
              : `${pkg.manager} upgrade ${pkg.name}`;

      if (cmp !== null && cmp < 0) {
        out.push({
          kind: "downgrade-offer",
          subject: res.tool,
          summary: `${pkg.manager} offers ${res.tool} ${pkg.installed ?? "?"} → ${pkg.available}, but you run ${winner.version} from the ${ownerLabel(winner.owner)} install.`,
          consequence: `${pkg.available} is OLDER than the ${winner.version} on your PATH. The command would succeed, report success, and change nothing you run — and the same offer would come back next time.`,
          avoid: line,
          severity: "high",
        });
      } else {
        out.push({
          kind: "shadowed-upgrade",
          subject: res.tool,
          summary: `${pkg.manager} offers an upgrade for the ${ownerLabel(target.owner)} copy of ${res.tool} at ${target.realPath}.`,
          consequence: `Your PATH resolves ${res.tool} to the ${ownerLabel(winner.owner)} copy at ${winner.pathEntry}, so this upgrades a copy you never run.`,
          avoid: line,
          severity: "medium",
        });
      }
    }

    /* --- a newer copy sitting behind the one PATH picked --- */
    if (res.state === "shadowed" && res.newerShadow) {
      const s = res.newerShadow;
      out.push({
        kind: "shadowed-newer",
        subject: res.tool,
        summary: `${res.tool} ${s.version} is installed (${ownerLabel(s.owner)}) but PATH resolves to ${winner.version} (${ownerLabel(winner.owner)}).`,
        consequence: `Updating will not help — the newer version is already on disk at ${s.realPath}; it is simply never reached.`,
        remedy: `Put ${s.pathEntry.replace(/\/[^/]+$/, "")} ahead of ${winner.pathEntry.replace(/\/[^/]+$/, "")} on PATH, or remove the ${ownerLabel(winner.owner)} copy.`,
        severity: "high",
      });
    } else if (res.state === "duplicate" || res.state === "ambiguous") {
      /**
       * Two copies at the SAME version are not a conflict.
       *
       * "Each owner will keep offering its own updates, and only the one on PATH has any effect"
       * is true of them and has no consequence: there is no divergence to act on, nothing to
       * remove, and no command that behaves differently. Measured on LM Studio, whose app bundle
       * (1.0.3+3) installs its own `lms` CLI — the two ARE one install, seen twice, and reporting
       * it demands attention for a situation with no available action.
       *
       * Deliberately requires every copy to carry a KNOWN version. An unknown one may differ, and
       * silence about a difference we could not measure is the failure mode this module exists to
       * prevent.
       */
      const versions = res.copies.map((c) => c.version);
      const identical = versions.every((v) => v && v === versions[0]);
      const others = res.shadowed.map(
        (c) => `${ownerLabel(c.owner)}${c.version ? ` ${c.version}` : ""}`,
      );
      if (!identical)
        out.push({
          kind: "duplicate-install",
          subject: res.tool,
          summary: `${res.tool} is installed ${res.copies.length} times: ${ownerLabel(winner.owner)}${winner.version ? ` ${winner.version}` : ""} (on PATH), ${others.join(", ")}.`,
          consequence:
            "Each owner will keep offering its own updates, and only the one on PATH has any effect. Update notices for the others will never clear.",
          severity: "low",
        });
    }

    /* --- a client driving a server of a different version --- */
    const server = input.serverVersions?.[res.tool];
    if (server && winner.version && offeredVs(winner.version, server) !== 0) {
      const serverCopy = res.copies.find((c) => c.version === server && c !== winner);
      out.push({
        kind: "client-server-skew",
        subject: res.tool,
        summary: `The ${res.tool} on your PATH is ${winner.version}, but the server answering requests is ${server}${serverCopy ? ` (${ownerLabel(serverCopy.owner)})` : ""}.`,
        consequence: `Upgrading the ${ownerLabel(winner.owner)} copy moves the client only. Every request still runs on ${server}, and a feature that needs a newer server will fail even though the version you see has changed.`,
        ...(serverCopy?.owner === "app-bundle"
          ? {
              remedy: `Update the app itself — it owns the server. The ${ownerLabel(winner.owner)} CLI is redundant here.`,
            }
          : {}),
        severity: "high",
      });
    }
  }

  /* --- installing into a directory nothing will ever search --- */
  for (const d of input.unreachableBinDirs ?? []) {
    out.push({
      kind: "unreachable-bin-dir",
      subject: d.manager,
      summary: `${d.manager} installs executables into ${d.dir}, which is not on your PATH.`,
      consequence: `\`${d.installCommand}\` will report success and place a launcher there that no shell will ever find — so the tool stays at its old version, or appears not to be installed at all.`,
      remedy: `Add ${d.dir} to PATH, or install that tool through a manager whose bin directory is already on it.`,
      severity: "high",
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Package rows the user should still see, having been told about the conflicts.
 *
 * A row that is ONLY reachable through a conflict is not hidden — it is annotated. This returns
 * the set that is plain and actionable, so a renderer can list those first and the awkward ones
 * under their explanation.
 */
export function plainUpgrades(
  outdated: readonly OutdatedPackage[],
  conflicts: readonly Conflict[],
): OutdatedPackage[] {
  const flagged = new Set(conflicts.flatMap((c) => (c.avoid ? [c.avoid] : [])));
  return outdated.filter((p) => {
    const line =
      p.manager === "brew" && p.kind === "cask"
        ? `brew upgrade --cask ${p.name}`
        : p.manager === "brew"
          ? `brew upgrade ${p.name}`
          : p.manager === "npm-global"
            ? `npm install -g ${p.name}@latest`
            : `${p.manager} upgrade ${p.name}`;
    return !flagged.has(line);
  });
}

/** Owners a conflict report treats as "a package manager owns this". */
export const MANAGED_OWNERS: readonly InstallOwner[] = Object.freeze([
  "brew-formula",
  "brew-cask",
  "npm-global",
  "pnpm-global",
  "pipx",
]);
