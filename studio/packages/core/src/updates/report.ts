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
  /** current prometheus CLI version. */
  prometheus: string;
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
      current: r.self.prometheus,
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
      // NOT "update": this diff compares the LOCAL digest against the local digest recorded at
      // the previous check, so a tag lands here after the user PULLED it. It is a record of a
      // local change, not evidence that a newer version exists upstream — see `hasUpdates`.
      severity: "none",
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
  /**
   * `models.diff.changed` is NOT an available update.
   *
   * `fetchOllamaTags` reads the LOCAL daemon, so `diffDigests` compares this run's local digests
   * against the ones recorded at the previous check. A tag therefore lands in `changed` exactly
   * when the user has ALREADY pulled it — and Prometheus then greeted them at startup with
   * "↑ Updates available: 1 local model" and told them to `ollama pull` the thing they had just
   * pulled. The inverse was worse: a genuinely stale model, untouched since the last check, has
   * an unchanged digest and was reported as "installed models up to date".
   *
   * Answering "is a newer version available" needs the registry, which nothing here queries.
   * Until something does, this must not drive an update nudge.
   */
  return (
    r.self.updateAvailable ||
    r.clis.some((c) => c.updateAvailable) ||
    r.models.suggestions.length > 0
  );
}

/** Count actionable items (for the startup one-liner). */
export function countUpdates(r: UpdateReport): {
  clis: number;
  /** models KNOWN to be out of date. Always 0 until something queries the registry. */
  models: number;
  /** models whose local digest moved since the last check (i.e. the user pulled them). */
  modelsChanged: number;
  suggestions: number;
  self: number;
} {
  return {
    clis: r.clis.filter((c) => c.updateAvailable).length,
    // 0, deliberately: nothing here checks a registry, so no local model can be KNOWN to be out
    // of date. The digest diff is reported separately as the local change it actually is.
    models: 0,
    modelsChanged: r.models.diff.changed.length,
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
  const selfVer = `prometheus ${r.self.prometheus}${r.self.engine ? ` · engine ${r.self.engine}` : ""}`;
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
    // Say what this IS. It was labelled "newer layers available — pull to update", which is the
    // opposite of the truth: these are the tags whose LOCAL digest moved since the last check.
    lines.push("  changed locally since the last check (already pulled):");
    for (const tag of r.models.diff.changed) lines.push(`      ${tag}`);
  }
  // No "up to date" claim either way: nothing here asks the registry what the current digest is,
  // so Prometheus does not know. `ollama pull <tag>` is a cheap no-op when you are current.
  lines.push(
    "  (local models are not checked against the registry — `ollama pull <tag>` to refresh one)",
  );
  if (r.models.suggestions.length > 0) {
    lines.push("  Suggested free coding models you don't have:");
    for (const m of r.models.suggestions) {
      const flag = m.licenseClass === "non-commercial" ? "  ⚠ non-commercial license" : "";
      lines.push(`      ollama pull ${m.tag}   (${m.gb}GB · ${m.note}${flag})`);
    }
  }

  return lines.join("\n");
}
