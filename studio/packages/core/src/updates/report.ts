/**
 * updates/report.ts — the assembled update report + its renderers (pure).
 *
 * The CLI layer gathers the raw facts (installed CLI versions vs latest, local-model digest
 * diffs + suggestions, the self-update plan) into an UpdateReport; these functions turn it
 * into the human notices and the single startup one-liner. No IO, no color — the caller
 * applies its own palette. "Propose, never auto-apply" is enforced upstream (we only render).
 */
import type { CatalogModel, ModelDigestDiff } from "./models.js";
import type { SelfUpdatePlan } from "./self-update.js";

/** One vendor CLI's version status. */
export interface CliUpdateStatus {
  service: string;
  installed: boolean;
  /** current installed version (null if not installed / unparseable). */
  current: string | null;
  /** latest available version (null if unknown / offline / selfcheck-only). */
  latest: string | null;
  /** true when latest > current. */
  updateAvailable: boolean;
  /** the copyable update command. */
  command: string;
  /** a note (e.g. selfcheck-only, offline). */
  note?: string;
}

/** The local-model section. */
export interface ModelUpdateStatus {
  /** digest diff vs the previous snapshot (empty when first run / no change). */
  diff: ModelDigestDiff;
  /** suggested NEW free models the user lacks. */
  suggestions: CatalogModel[];
}

/** The Prometheus self-update section. */
export interface SelfUpdateStatus {
  /** current prom CLI version. */
  prom: string;
  /** current python engine version, if known. */
  engine?: string;
  /** latest version if discoverable. */
  latest?: string;
  /** true when a newer version is known to exist. */
  updateAvailable: boolean;
  plan: SelfUpdatePlan;
}

export interface UpdateReport {
  clis: CliUpdateStatus[];
  models: ModelUpdateStatus;
  self: SelfUpdateStatus;
  /** ISO time the check ran (injected). */
  checkedAt: string;
}

/**
 * The `--json` component severity — a CLOSED union derived from what `formatUpdateReport`
 * actually renders (CLI-047): "update" when a newer version/layer is available, "none" when up
 * to date, "non-commercial" for a suggested model flagged non-commercial-license. No invented
 * patch/minor/major levels — the report carries a boolean updateAvailable, not a semver diff.
 */
export type UpdateSeverity = "none" | "update" | "non-commercial";

export interface UpdateComponentJson {
  name: string;
  /** current version/digest verbatim (null for unknown / a suggested-but-unowned model). */
  current: string | null;
  latest: string | null;
  severity: UpdateSeverity;
  /** the copyable command that would apply it. */
  action: string;
}

export interface UpdatesJson {
  ok: true;
  components: UpdateComponentJson[];
}

/**
 * Flatten an UpdateReport into the machine `--json` envelope (CLI-047) — one entry per vendor CLI
 * (installed only, mirroring the "Agent CLIs" section), each local model with newer layers, each
 * suggested model, and Prometheus self. Up-to-date components stay in `components[]` as
 * `severity:"none"` so `[]` unambiguously means "no components", not "all current". Values are
 * passed through VERBATIM from the same report that produced the human lines (digests never
 * semver-parsed), so JSON and text can never disagree.
 */
export function toUpdatesJson(r: UpdateReport): UpdatesJson {
  const components: UpdateComponentJson[] = [
    {
      name: "prometheus",
      current: r.self.prom,
      latest: r.self.latest ?? null,
      severity: r.self.updateAvailable ? "update" : "none",
      action: r.self.plan.command,
    },
  ];
  for (const cli of r.clis) {
    if (!cli.installed) continue; // mirror the human report (installed CLIs only)
    components.push({
      name: cli.service,
      current: cli.current,
      latest: cli.latest,
      severity: cli.updateAvailable ? "update" : "none",
      action: cli.command,
    });
  }
  for (const tag of r.models.diff.changed) {
    components.push({
      name: `ollama:${tag}`,
      current: null,
      latest: null,
      severity: "update",
      action: `ollama pull ${tag}`,
    });
  }
  for (const m of r.models.suggestions) {
    components.push({
      name: `ollama:${m.tag}`,
      current: null,
      latest: null,
      severity: m.licenseClass === "non-commercial" ? "non-commercial" : "update",
      action: `ollama pull ${m.tag}`,
    });
  }
  return { ok: true, components };
}

/** Did anything actionable turn up? */
export function hasUpdates(r: UpdateReport): boolean {
  return (
    r.self.updateAvailable ||
    r.clis.some((c) => c.updateAvailable) ||
    r.models.diff.changed.length > 0 ||
    r.models.suggestions.length > 0
  );
}

/** Count actionable items (for the startup one-liner). */
export function countUpdates(r: UpdateReport): {
  clis: number;
  models: number;
  suggestions: number;
  self: number;
} {
  return {
    clis: r.clis.filter((c) => c.updateAvailable).length,
    models: r.models.diff.changed.length,
    suggestions: r.models.suggestions.length,
    self: r.self.updateAvailable ? 1 : 0,
  };
}

/** A single throttled startup line, or "" when nothing is actionable. */
export function summarizeForStartup(r: UpdateReport): string {
  const n = countUpdates(r);
  const bits: string[] = [];
  if (n.self) bits.push("Prometheus");
  if (n.clis) bits.push(`${n.clis} CLI${n.clis > 1 ? "s" : ""}`);
  if (n.models) bits.push(`${n.models} local model${n.models > 1 ? "s" : ""}`);
  if (n.suggestions && !n.models && !n.clis && !n.self)
    bits.push(`${n.suggestions} new model${n.suggestions > 1 ? "s" : ""} available`);
  if (bits.length === 0) return "";
  return `↑ Updates available: ${bits.join(", ")}. Run /updates to review.`;
}

/** Render the full `/updates` report (plain text; caller colors it). */
export function formatUpdateReport(r: UpdateReport): string {
  const lines: string[] = ["Updates"];

  // --- Prometheus self ---
  lines.push("");
  lines.push("Prometheus");
  const selfVer = `prom ${r.self.prom}${r.self.engine ? ` · engine ${r.self.engine}` : ""}`;
  if (r.self.updateAvailable) {
    lines.push(`  ${selfVer}  →  ${r.self.latest ?? "newer"} available`);
    for (const s of r.self.plan.steps) lines.push(`    ${s}`);
  } else {
    lines.push(`  ${selfVer}  (up to date${r.self.latest ? "" : " — latest unknown"})`);
    lines.push(`    To update anyway:  ${r.self.plan.command}`);
  }

  // --- vendor CLIs ---
  lines.push("");
  lines.push("Agent CLIs");
  const known = r.clis.filter((c) => c.installed);
  if (known.length === 0) {
    lines.push("  (none installed)");
  } else {
    for (const c of known) {
      if (c.updateAvailable) {
        lines.push(`  • ${c.service}  ${c.current ?? "?"} → ${c.latest}   update:  ${c.command}`);
      } else {
        const tail = c.latest
          ? "up to date"
          : (c.note ?? "latest unknown — run its own update to self-check");
        lines.push(`  • ${c.service}  ${c.current ?? "?"}   (${tail})`);
      }
    }
  }

  // --- local models ---
  lines.push("");
  lines.push("Local models (Ollama)");
  if (r.models.diff.changed.length > 0) {
    lines.push("  ↑ newer layers available — pull to update:");
    for (const tag of r.models.diff.changed) lines.push(`      ollama pull ${tag}`);
  } else {
    lines.push("  installed models up to date");
  }
  if (r.models.suggestions.length > 0) {
    lines.push("  Suggested free coding models you don't have:");
    for (const m of r.models.suggestions) {
      const flag = m.licenseClass === "non-commercial" ? "  ⚠ non-commercial license" : "";
      lines.push(`      ollama pull ${m.tag}   (${m.gb}GB · ${m.note}${flag})`);
    }
  }

  return lines.join("\n");
}
