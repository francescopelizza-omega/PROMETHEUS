/**
 * updates/report.ts — the assembled update report + its renderers (pure).
 *
 * The CLI layer gathers the raw facts (installed CLI versions vs latest, local-model digest
 * diffs + suggestions, the self-update plan) into an UpdateReport; these functions turn it
 * into the human notices and the single startup one-liner. No IO, no color — the caller
 * applies its own palette. "Propose, never auto-apply" is enforced upstream (we only render).
 */
import type { Conflict } from "./conflicts.js";
import type { InstallState, ToolCopy } from "./install-owner.js";
import type { ModelCheck } from "./model-registry.js";
import type { CatalogModel, ModelDigestDiff } from "./models.js";
import type { ManagerId, OutdatedPackage } from "./package-managers.js";
import type { SelfUpdatePlan } from "./self-update.js";
import type { ToolRole, UpdateCommand } from "./tool-registry.js";

/**
 * One tool from `TOOL_CHECKS`, resolved against this machine.
 *
 * Supersedes `CliUpdateStatus`, which could express neither "installed twice" nor "could not
 * check" — and therefore reported both as "up to date".
 */
export interface ToolUpdateStatus {
  id: string;
  label: string;
  role: ToolRole;
  installed: boolean;
  /** single / duplicate / shadowed / ambiguous / absent. */
  state: InstallState;
  /** every copy found, PATH order. `copies[0]` is what runs. */
  copies: readonly ToolCopy[];
  current: string | null;
  latest: string | null;
  /**
   * `null` means WE COULD NOT LOOK — offline, rate-limited, no published feed.
   *
   * The single most important field in this file. The old `boolean` collapsed "nothing newer"
   * and "could not find out" into `false`, which `formatUpdateReport` printed as "up to date":
   * an update checker that reassures you when it fails is worse than one that is absent.
   */
  updateAvailable: boolean | null;
  /** where `latest` came from ("npm:@openai/codex", "brew cask:codex"), or why it is unknown. */
  source?: string;
  /** commands that target the copy on PATH. */
  offer: readonly UpdateCommand[];
  /** commands that exist but would act on a different copy — shown WITH the reason. */
  withheld: readonly { command: string; reason: string }[];
  note?: string;
}

/** What one package manager said when asked for its upgradable list. */
export interface ManagerReport {
  manager: ManagerId;
  label: string;
  /** false when the manager cannot answer the question at all (pipx). */
  checkable: boolean;
  /** false when we asked and it failed — NOT the same as an empty list. */
  ok: boolean;
  packages: readonly OutdatedPackage[];
  note?: string;
}

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
  /**
   * Each installed model checked against the REGISTRY — the question `diff` cannot answer.
   *
   * `diff` compares this machine against its own previous snapshot, so it notices a pull that
   * already happened. This notices one that has not. Until it was wired, `countUpdates().models`
   * was a hardcoded 0 and the report carried a standing disclaimer saying local models were
   * never checked.
   */
  upstream?: readonly ModelCheck[];
}

/** The Prometheus self-update section. */
export interface SelfUpdateStatus {
  /** current prometheus CLI version. */
  prometheus: string;
  /** current python engine version, if known. */
  engine?: string;
  /** latest version if discoverable. */
  latest?: string;
  /**
   * `null` when the lookup FAILED, as distinct from "nothing newer".
   *
   * This field was a boolean, and the lookup queried a GitHub repo while the remote is GitLab —
   * so it was permanently `false`, and the report permanently printed "up to date". A check that
   * cannot succeed must not render as reassurance.
   */
  updateAvailable: boolean | null;
  plan: SelfUpdatePlan;
}

export interface UpdateReport {
  clis: CliUpdateStatus[];
  models: ModelUpdateStatus;
  self: SelfUpdateStatus;
  /** ISO time the check ran (injected). */
  checkedAt: string;
  /**
   * The wider third-party sweep. Optional so an older persisted state file still parses —
   * `check.ts` writes this cache to disk and a shape change must not break a warm start.
   */
  tools?: readonly ToolUpdateStatus[];
  /** what each package manager on this machine reported. */
  managers?: readonly ManagerReport[];
  /**
   * Where a manager's offer and the machine's reality disagree.
   *
   * Rendered FIRST and above everything else, because a conflict invalidates the obvious reading
   * of the rows below it: `brew outdated` naming `claude-code` is true and acting on it is
   * useless, and only this section can say so.
   */
  conflicts?: readonly Conflict[];
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

/** Models the registry says have a newer build, and that it is safe to offer. */
function upstreamOfferable(r: UpdateReport): number {
  return (r.models.upstream ?? []).filter((c) => c.ok && c.update.changed).length;
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
   * `models.upstream` is the field that answers the real question, by asking the registry. It is
   * included here; the local digest diff still is not.
   */
  return (
    r.self.updateAvailable === true ||
    r.clis.some((c) => c.updateAvailable) ||
    (r.tools ?? []).some((t) => t.updateAvailable === true) ||
    (r.managers ?? []).some((m) => m.packages.length > 0) ||
    (r.conflicts ?? []).length > 0 ||
    upstreamOfferable(r) > 0 ||
    r.models.suggestions.length > 0
  );
}

/** Count actionable items (for the startup one-liner). */
export function countUpdates(r: UpdateReport): {
  clis: number;
  /** models the REGISTRY says have a newer build. */
  models: number;
  /** models whose local digest moved since the last check (i.e. the user pulled them). */
  modelsChanged: number;
  suggestions: number;
  self: number;
  /** third-party tools with a newer version, excluding the legacy `clis` rows. */
  tools: number;
  /** packages any manager reports as upgradable. */
  packages: number;
  /** install conflicts — the ones that make an obvious command misleading. */
  conflicts: number;
  /**
   * Things we could NOT check. Never folded into the counts above: a startup line that says
   * "3 updates" when 8 more were unreachable is a different claim from "3 updates".
   */
  unknown: number;
} {
  const tools = r.tools ?? [];
  return {
    clis: r.clis.filter((c) => c.updateAvailable).length,
    models: upstreamOfferable(r),
    modelsChanged: r.models.diff.changed.length,
    suggestions: r.models.suggestions.length,
    self: r.self.updateAvailable === true ? 1 : 0,
    tools: tools.filter((t) => t.updateAvailable === true).length,
    packages: (r.managers ?? []).reduce((n, m) => n + m.packages.length, 0),
    conflicts: (r.conflicts ?? []).length,
    unknown:
      tools.filter((t) => t.installed && t.updateAvailable === null).length +
      (r.self.updateAvailable === null ? 1 : 0) +
      (r.managers ?? []).filter((m) => !m.ok).length,
  };
}

/** A single throttled startup line, or "" when nothing is actionable. */
export function summarizeForStartup(r: UpdateReport): string {
  const n = countUpdates(r);
  const bits: string[] = [];
  /**
   * Conflicts lead, and they lead alone when they are the only finding.
   *
   * "2 install conflicts" is a different and more urgent message than "12 updates available":
   * it means a command the user is about to find in `brew outdated` will not do what it says.
   */
  if (n.conflicts) bits.push(`${n.conflicts} install conflict${n.conflicts > 1 ? "s" : ""}`);
  if (n.self) bits.push("Prometheus");
  if (n.tools || n.clis) {
    const t = Math.max(n.tools, n.clis);
    bits.push(`${t} tool${t > 1 ? "s" : ""}`);
  }
  if (n.packages) bits.push(`${n.packages} package${n.packages > 1 ? "s" : ""}`);
  if (n.models) bits.push(`${n.models} model${n.models > 1 ? "s" : ""}`);
  /**
   * Suggestions are the weakest signal and the only one for something the user does not have.
   * Shown only when nothing they DO have needs attention — otherwise "Updates available" would
   * nag forever about models they chose not to install.
   */
  if (n.suggestions && bits.length === 0)
    bits.push(`${n.suggestions} new model${n.suggestions > 1 ? "s" : ""} to try`);
  if (bits.length === 0) return "";
  const tail = n.unknown ? ` (${n.unknown} could not be checked)` : "";
  return `↑ Updates available: ${bits.join(", ")}${tail}. Run /updates to review.`;
}

/** Group tools by the role that says why PROMETHEUS cares about them. */
const ROLE_HEADINGS: Readonly<Record<ToolRole, string>> = Object.freeze({
  engine: "Model engines",
  agent: "Agent CLIs",
  toolchain: "Toolchain",
  optional: "Optional tools",
});

/** Render the full `/updates` report (plain text; caller colors it). */
export function formatUpdateReport(r: UpdateReport): string {
  const lines: string[] = ["Updates"];

  /**
   * ── CONFLICTS FIRST ──
   *
   * Not a stylistic choice. A conflict means a command the user will otherwise find on their own
   * — in `brew outdated`, in a release note — succeeds while doing nothing, or does something
   * worse. Printing the update rows above it would put the misleading information first and its
   * correction below the fold.
   */
  if (r.conflicts && r.conflicts.length > 0) {
    lines.push("");
    lines.push("⚠ Install conflicts");
    for (const c of r.conflicts) {
      lines.push(`  • ${c.summary}`);
      lines.push(`      ${c.consequence}`);
      if (c.avoid) lines.push(`      DO NOT RUN:  ${c.avoid}`);
      if (c.remedy) lines.push(`      Instead:  ${c.remedy}`);
    }
  }

  // --- Prometheus self ---
  lines.push("");
  lines.push("Prometheus");
  const selfVer = `prometheus ${r.self.prometheus}${r.self.engine ? ` · engine ${r.self.engine}` : ""}`;
  if (r.self.updateAvailable === true) {
    lines.push(`  ${selfVer}  →  ${r.self.latest ?? "newer"} available`);
    for (const s of r.self.plan.steps) lines.push(`    ${s}`);
  } else if (r.self.updateAvailable === null) {
    // NOT "up to date". The check did not succeed, and saying otherwise is the reassurance this
    // whole tri-state exists to prevent.
    lines.push(`  ${selfVer}  (could not check for updates)`);
    lines.push(`    To update anyway:  ${r.self.plan.command}`);
  } else {
    lines.push(`  ${selfVer}  (up to date)`);
    lines.push(`    To update anyway:  ${r.self.plan.command}`);
  }

  // --- the third-party tools, by role ---
  if (r.tools && r.tools.length > 0) {
    for (const role of ["engine", "agent", "toolchain", "optional"] as const) {
      const group = r.tools.filter((t) => t.role === role && t.installed);
      if (group.length === 0) continue;
      lines.push("");
      lines.push(ROLE_HEADINGS[role]);
      for (const t of group) lines.push(...formatTool(t));
    }
  } else {
    // --- legacy vendor CLIs, for a report produced before the tool sweep existed ---
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
  }

  // --- what the package managers say is upgradable ---
  if (r.managers && r.managers.length > 0) {
    lines.push("");
    lines.push("Packages");
    for (const m of r.managers) {
      if (!m.checkable) {
        // Explicit, because an empty list from a manager nobody asked reads as "all current".
        lines.push(`  ${m.label}: cannot be checked${m.note ? ` — ${m.note}` : ""}`);
        continue;
      }
      if (!m.ok) {
        lines.push(`  ${m.label}: check failed${m.note ? ` — ${m.note}` : ""}`);
        continue;
      }
      if (m.packages.length === 0) {
        lines.push(`  ${m.label}: up to date`);
        continue;
      }
      lines.push(`  ${m.label}: ${m.packages.length} upgradable`);
      for (const p of m.packages) {
        const pin = p.pinned ? "  [PINNED — unpin first]" : "";
        lines.push(`      ${p.name}  ${p.installed ?? "?"} → ${p.available ?? "?"}${pin}`);
      }
    }
  }

  // --- local models ---
  lines.push("");
  lines.push("Local models (Ollama)");
  const upstream = r.models.upstream ?? [];
  if (upstream.length > 0) {
    const moved = upstream.filter((c) => c.ok && c.update.changed);
    const same = upstream.filter((c) => c.ok && !c.update.changed);
    const skipped = upstream.filter((c) => !c.ok);
    for (const c of moved) {
      if (!c.ok) continue;
      const u = c.update;
      /**
       * "newer" and "changed" are different claims and the difference is load-bearing: an ollama
       * manifest carries no timestamp, so without the `ollama-push-time` header the registry can
       * only prove the tag now points somewhere ELSE, not somewhere later. Measured: a qwen3.6
       * update was SMALLER upstream (22.6 GB vs 23.9 GB) — a rebuild, not obviously an upgrade.
       */
      const verb = u.newer ? "newer build" : "changed upstream";
      const delta =
        u.localBytes !== undefined && u.remoteBytes > 0 ? u.remoteBytes - u.localBytes : 0;
      const sizeNote = delta ? `  (${delta > 0 ? "+" : ""}${Math.round(delta / 1e8) / 10} GB)` : "";
      lines.push(`  • ${u.model}  ${verb}${sizeNote}`);
      if (u.requiresOllama && !u.satisfiable) {
        // Pulling first and failing to load second would have replaced a model that worked.
        lines.push(`      needs ollama ${u.requiresOllama} — upgrade ollama first`);
      }
      /**
       * BOTH forms, deliberately. `/updates pull` runs it here with progress and the
       * authorisation gate; `ollama pull` is the same thing in a shell, for a user who would
       * rather not hand the job to us. Showing only the first would make this a black box.
       */
      lines.push(`      /updates pull ${u.model}      (or:  ollama pull ${u.model})`);
    }
    if (same.length > 0)
      lines.push(`  ${same.length} model${same.length > 1 ? "s" : ""} up to date`);
    if (skipped.length > 0) {
      // Named, not omitted: "this model was not checked" is information the user is entitled to.
      lines.push(
        `  ${skipped.length} not checked (${skipped.map((c) => (c.ok ? "" : c.reason)).join(", ")})`,
      );
    }
  } else {
    lines.push("  (not checked against the registry this run)");
  }
  if (r.models.diff.changed.length > 0) {
    // Say what this IS. It was labelled "newer layers available — pull to update", which is the
    // opposite of the truth: these are the tags whose LOCAL digest moved since the last check.
    lines.push("  changed locally since the last check (already pulled):");
    for (const tag of r.models.diff.changed) lines.push(`      ${tag}`);
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

/**
 * One tool's lines.
 *
 * Every branch that cannot state a version says WHY. A row that reads `codex 0.157.1` with
 * nothing after it is indistinguishable from `codex 0.157.1 (up to date)` at a glance, and one
 * of those is a claim we have not earned.
 */
function formatTool(t: ToolUpdateStatus): string[] {
  const lines: string[] = [];
  const head = `  • ${t.label}  ${t.current ?? "?"}`;
  if (t.updateAvailable === true) {
    lines.push(`${head} → ${t.latest}${t.source ? `   [${t.source}]` : ""}`);
  } else if (t.updateAvailable === null) {
    /**
     * Two different unknowns, and saying which one is the whole value of the line.
     *
     * Measured on LM Studio: `lms --version` prints "CLI commit: 71bd99c" — no version at all —
     * while the cask channel answered perfectly well. Printing "could not check" flat implies
     * the lookup failed, when in fact we know the latest and cannot read the installed one.
     */
    const why = t.latest
      ? `installed version unreadable — latest is ${t.latest}`
      : `could not check${t.source ? ` — ${t.source}` : ""}`;
    lines.push(`${head}   (${why})`);
  } else {
    lines.push(`${head}   (up to date)`);
  }

  /**
   * The copies, whenever there is more than one. This is the line that makes the reported version
   * mean something: "codex 0.157.1" is true and incomplete on a machine that also has 0.142.5.
   */
  if (t.copies.length > 1) {
    for (const c of t.copies.slice(1)) {
      lines.push(`      also installed: ${c.version ?? "?"} at ${c.pathEntry}`);
    }
  }

  for (const c of t.offer) {
    if (c.command === "") {
      lines.push(`      ${c.note ?? "updates itself"}`);
    } else {
      lines.push(`      update:  ${c.command}`);
      if (c.note) lines.push(`        ${c.note}`);
    }
  }
  /**
   * Nothing to offer is itself a finding, and a silent blank is how "this tool can never be
   * updated from here" gets mistaken for "nothing to do".
   */
  if (t.offer.length === 0 && t.installed && t.updateAvailable === true) {
    lines.push("      no update command applies to how this copy was installed");
  }
  /**
   * Withheld commands are PRINTED, with their reason.
   *
   * Silently dropping them is the trap: the user finds `brew upgrade --cask claude-code` in
   * `brew outdated` five minutes later and runs it, having been given no reason not to.
   */
  for (const w of t.withheld) {
    /**
     * A row whose command is EMPTY is a "the vendor updates this itself" entry, not a command.
     * Printing `not:  ` with nothing after it — which is what happened for ollama's app row —
     * reads as a rendering bug rather than as information.
     */
    lines.push(`      not:  ${w.command || "(its own built-in updater)"}`);
    lines.push(`        ${w.reason}`);
  }
  if (t.note) lines.push(`      ${t.note}`);
  return lines;
}
