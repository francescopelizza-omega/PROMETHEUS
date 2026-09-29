/**
 * renderer/stores/tool-updates-derive.ts — the PURE shaping of the update report for Studio.
 *
 * Zero dependencies (no zustand, no react, no DOM), so the decisions that matter can be pinned
 * under node:test directly — the same split `health-derive.ts` uses.
 *
 * The decisions that matter are all one decision, restated: **a thing we could not check must
 * never be presented as a thing that is fine.** Every count, badge and empty-state here keeps
 * "up to date", "out of date" and "unknown" as three values, because collapsing the third into
 * the first is what made the previous update checker reassuring precisely when it had failed.
 */

import type {
  UpdateConflictView,
  UpdatePackageView,
  UpdateToolView,
  UpdatesReportResult,
} from "../../shared/ipc-contract.js";

/** The headline badge for the whole report. */
export type UpdatesBadge =
  /** something is misleading: a command that looks right would not do what it says. */
  | "conflict"
  /** updates are available and nothing is misleading. */
  | "available"
  /** everything we could check is current, and some things could not be checked. */
  | "partial"
  /** everything checked, nothing to do. */
  | "current"
  /** the check itself failed. */
  | "failed"
  /** nothing has been checked yet. */
  | "idle";

export interface UpdatesCounts {
  conflicts: number;
  tools: number;
  packages: number;
  models: number;
  self: number;
  /** tools + managers we could not get an answer for. Never added to the others. */
  unknown: number;
}

export function countReport(r: UpdatesReportResult | null): UpdatesCounts {
  const zero: UpdatesCounts = {
    conflicts: 0,
    tools: 0,
    packages: 0,
    models: 0,
    self: 0,
    unknown: 0,
  };
  if (!r || !r.ok) return zero;
  return {
    conflicts: r.conflicts.length,
    tools: r.tools.filter((t) => t.updateAvailable === true).length,
    packages: r.packages.length,
    models: r.models.length,
    self: r.self.updateAvailable === true ? 1 : 0,
    /**
     * `updateAvailable === null` on an INSTALLED tool, plus every manager that could not answer.
     * An uninstalled tool is not an unknown — we know perfectly well that it is absent.
     */
    unknown:
      r.tools.filter((t) => t.installed && t.updateAvailable === null).length +
      r.unavailableManagers.length +
      (r.self.updateAvailable === null ? 1 : 0),
  };
}

/**
 * The single badge for the whole report.
 *
 * `conflict` outranks `available` deliberately. A conflict is not an update — nothing may even
 * be out of date — but it means a command the user is about to find in `brew outdated` will
 * succeed and change nothing, which is more urgent than a version number moving.
 */
export function deriveBadge(r: UpdatesReportResult | null): UpdatesBadge {
  if (!r) return "idle";
  if (!r.ok) return "failed";
  const n = countReport(r);
  if (n.conflicts > 0) return "conflict";
  if (n.tools + n.packages + n.models + n.self > 0) return "available";
  // Nothing actionable — but say so honestly when part of the machine could not be asked.
  return n.unknown > 0 ? "partial" : "current";
}

/** Severity order for rendering. High first: the misleading ones must not be below the fold. */
const SEVERITY_RANK: Readonly<Record<UpdateConflictView["severity"], number>> = Object.freeze({
  high: 0,
  medium: 1,
  low: 2,
});

export function sortConflicts(conflicts: readonly UpdateConflictView[]): UpdateConflictView[] {
  return [...conflicts].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export interface ToolGroup {
  role: string;
  heading: string;
  tools: UpdateToolView[];
}

const ROLE_HEADINGS: Readonly<Record<string, string>> = Object.freeze({
  engine: "Model engines",
  agent: "Agent CLIs",
  toolchain: "Toolchain",
  optional: "Optional tools",
});

/**
 * Installed tools, grouped by role in the order that matters.
 *
 * Uninstalled rows are dropped: an optional tool the user never wanted is not a finding, and a
 * list padded with them buries the four rows that are.
 */
export function groupTools(tools: readonly UpdateToolView[]): ToolGroup[] {
  const order = ["engine", "agent", "toolchain", "optional"];
  return order
    .map((role) => ({
      role,
      heading: ROLE_HEADINGS[role] ?? role,
      tools: tools.filter((t) => t.role === role && t.installed),
    }))
    .filter((g) => g.tools.length > 0);
}

/** A tool worth the user's attention right now, most consequential first. */
export function needsAttention(tools: readonly UpdateToolView[]): UpdateToolView[] {
  const weight = (t: UpdateToolView): number => {
    // A copy that is installed twice ranks ABOVE a plain version gap: the version gap has an
    // obvious remedy, and the duplicate is the reason the obvious remedy may not work.
    if (t.state === "shadowed") return 0;
    if (t.updateAvailable === true) return 1;
    if (t.state === "duplicate" || t.state === "ambiguous") return 2;
    return 3;
  };
  return tools.filter((t) => t.installed && weight(t) < 3).sort((a, b) => weight(a) - weight(b));
}

/**
 * Packages grouped by the manager that owns them, in a stable order.
 *
 * Grouped rather than flat because the upgrade command differs per manager, and a flat list
 * invites "select all" on a set that has no single command.
 */
export function groupPackages(
  packages: readonly UpdatePackageView[],
): { manager: string; label: string; packages: UpdatePackageView[] }[] {
  const byManager = new Map<
    string,
    { manager: string; label: string; packages: UpdatePackageView[] }
  >();
  for (const p of packages) {
    const g = byManager.get(p.manager) ?? {
      manager: p.manager,
      label: p.managerLabel,
      packages: [],
    };
    g.packages.push(p);
    byManager.set(p.manager, g);
  }
  return [...byManager.values()];
}

/**
 * Every copyable command in the report, deduplicated, in the order they should be run.
 *
 * Commands flagged `avoid` by a conflict are EXCLUDED — that is the whole point. They still
 * appear in the conflict section, where they are shown with the reason not to run them.
 */
export function copyableCommands(r: UpdatesReportResult | null): string[] {
  if (!r || !r.ok) return [];
  const avoid = new Set(r.conflicts.flatMap((c) => (c.avoid ? [c.avoid] : [])));
  const out: string[] = [];
  const add = (cmd: string | null | undefined): void => {
    if (!cmd || avoid.has(cmd) || out.includes(cmd)) return;
    out.push(cmd);
  };
  for (const t of r.tools) for (const c of t.offer) add(c.command);
  for (const p of r.packages) add(p.command);
  for (const m of r.models) if (!m.blockedBy) add(m.command);
  return out;
}

/** A short human line for the badge, for a tooltip or a collapsed header. */
export function badgeLabel(badge: UpdatesBadge, n: UpdatesCounts): string {
  switch (badge) {
    case "conflict":
      return `${n.conflicts} install conflict${n.conflicts === 1 ? "" : "s"}`;
    case "available": {
      const total = n.tools + n.packages + n.models + n.self;
      return `${total} update${total === 1 ? "" : "s"} available`;
    }
    case "partial":
      return `up to date (${n.unknown} not checked)`;
    case "current":
      return "up to date";
    case "failed":
      return "the update check failed";
    default:
      return "not checked yet";
  }
}
