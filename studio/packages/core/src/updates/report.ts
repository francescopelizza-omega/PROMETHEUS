// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
import { type Remedy, displayCommand } from "./remedies.js";
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
  /**
   * The shadowed copy that is NEWER than the one PATH picked, when there is one.
   *
   * Carried on this row rather than recomputed downstream because it is the one fact a
   * `ToolResolution` has that `copies` alone cannot express: the ordering is by PATH, not by
   * version, so "copies[1] is newer than copies[0]" requires a version comparison that has
   * already been done once in `resolveTool`.
   *
   * It was dropped here, and the loss was silent: `check.ts` rebuilds a `ToolResolution` from
   * this row to feed `findConflicts`, so the `shadowed-newer` conflict — severity HIGH, the one
   * that says "updating will not help, the newer version is already on disk and simply never
   * reached" — could never fire in any surface. The branch existed, was tested, and was dead.
   */
  newerShadow?: ToolCopy;
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
  /**
   * WHY the lookup produced no version, when it produced none.
   *
   * "could not check" is the honest answer to a failure and the WRONG answer to a definitive
   * one. Measured: `GET /api/v4/projects/red-beard-phoenix%2FPROMETHEUS/releases/permalink/latest`
   * answers HTTP 404 with `{"message":"404 Project Not Found"}` — and the URL encoding is
   * correct. GitLab deliberately returns 404 rather than 403 for a PRIVATE project seen by an
   * unauthenticated caller, so the 404 means "there is no public release feed here", not "the
   * request failed". Rendering that as "could not check for updates" invites the user to debug a
   * network problem that does not exist.
   */
  note?: string;
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
  /**
   * The repair for each conflict, where one is known.
   *
   * Separate from `conflicts` rather than a field on it, because the diagnosis is PURE and the
   * repair needs facts from the filesystem — which shell init file exists, whether it is a
   * symlink, where npm's prefix points. Keeping them apart is what lets `conflicts.ts` stay
   * testable without a disk, and lets a surface that cannot gather those facts still render the
   * finding.
   *
   * A conflict with no remedy is normal and is never suppressed: some are facts about the
   * machine that no command resolves, and a missing repair must not hide a real finding.
   */
  remedies?: readonly Remedy[];
  /**
   * What this report did NOT look at, when it did not look at everything.
   *
   * The startup notice runs with `skipPackages: true` so the prompt is not held for the ~2s
   * `brew outdated` costs. That is the right trade — but two of the six conflict kinds
   * (`downgrade-offer` and `shadowed-upgrade`) are produced only from the package-manager rows,
   * so a skipped sweep makes them impossible to find.
   *
   * The user saw the consequence exactly: a header reading "4 install conflicts" above a body
   * listing SIX. Neither number was wrong — they were two different reports, and only one of
   * them said so. A partial count presented as a total is the same defect this whole feature
   * exists to remove, one level up.
   */
  partial?: {
    /** the package-manager sweep did not run, so manager-derived findings are missing. */
    packages: boolean;
  };
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
  /**
   * Declare the blind spot. This line is computed from a report that skipped the package sweep,
   * so its conflict count is a FLOOR, not a total — see `UpdateReport.partial`.
   */
  const partial = r.partial?.packages ? " — package managers not checked yet" : "";
  return `↑ Updates available: ${bits.join(", ")}${tail}${partial}. Run /updates to review.`;
}

/**
 * One remedy's lines, indented under the conflict it repairs.
 *
 * Shows the COMMANDS and the reason, in that order of prominence but not of reading: the
 * rationale comes first because a repair the user does not understand is one they should not
 * run. A BLOCKED remedy prints its refusal and no commands at all — that is the entire point of
 * the field, and printing the steps "for reference" would put a command we have just called
 * dangerous on the user's screen in copyable form.
 */
function formatRemedy(m: Remedy): string[] {
  const out: string[] = [];
  out.push(`      FIX — ${m.title}`);
  for (const para of m.rationale.split("\n")) out.push(`        ${para}`);
  if (m.blocked) {
    out.push(`        NOT AUTOMATED: ${m.blocked}`);
  } else {
    for (const step of m.steps) {
      if (step.displayAs) {
        // A block write. The argv is correct and unreadable — see `RemedyStep.displayAs`.
        for (const l of step.displayAs) out.push(`        ${l}`);
      } else {
        out.push(`        $ ${displayCommand(step.argv)}`);
      }
      out.push(`            ${step.purpose}`);
      if (step.undo) out.push(`            undo:  ${displayCommand(step.undo)}`);
    }
    if (m.keeps) out.push(`        keeps: ${m.keeps}`);
    /**
     * `permanent` is the fact the user actually wants. Every one of these conflicts re-appears on
     * every run until the duplicate is gone, and a repair that merely quiets one check would be
     * the same broken promise in a new place.
     */
    if (m.permanent)
      out.push("        this clears the notice for good — the conflict stops being true.");
  }
  /**
   * The verification is printed even for a blocked remedy, because the first correct step is
   * always to measure, and for the blocked ones measuring is the only step we are willing to
   * recommend.
   */
  if (m.verify) out.push(`        verify:  ${displayCommand(m.verify)}`);
  return out;
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
    /** Subjects whose repair has already been printed — see the dedupe note below. */
    const shownFor = new Set<string>();
    for (const c of r.conflicts) {
      lines.push(`  • ${c.summary}`);
      lines.push(`      ${c.consequence}`);
      if (c.avoid) lines.push(`      DO NOT RUN:  ${c.avoid}`);
      if (c.remedy) lines.push(`      Instead:  ${c.remedy}`);
      /**
       * THE REPAIR, under the finding that needs it.
       *
       * Printed here rather than in a section of its own, because a repair separated from its
       * reason is a command the user has to match back up by hand — and the whole failure this
       * feature addresses is a user acting on a true statement without its context.
       */
      /**
       * ONE fix per subject, under the first finding that mentions it.
       *
       * The same duplicate install surfaces as several conflicts — `downgrade-offer` from the
       * manager's row and `duplicate-install` from the resolution — and they share a single
       * repair. Printing it under each turns one actionable command into three identical walls
       * of text, and invites the user to run it three times.
       */
      const fix = (r.remedies ?? []).find((m) => m.kind === c.kind && m.subject === c.subject);
      if (fix && !shownFor.has(fix.subject)) {
        shownFor.add(fix.subject);
        lines.push(...formatRemedy(fix));
      }
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
    /**
     * NOT "up to date". The check did not yield a version, and saying otherwise is the
     * reassurance this whole tri-state exists to prevent.
     *
     * But "could not check" is not the whole truth either, and for this repo it is misleading:
     * the release feed answers a definitive 404 because the project is PRIVATE, which is an
     * answer about visibility, not a failed request. `self.note` carries the distinction so the
     * user is not sent debugging a network problem that does not exist.
     */
    lines.push(`  ${selfVer}  (${r.self.note ?? "could not check for updates"})`);
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
    /**
     * THREE unknowns, not two, and the third is not a failure at all.
     *
     * A `none` channel means we looked and there is deliberately nothing to compare against —
     * the tool has no published feed, or none whose numbering means anything for this install.
     * Rendering that as "could not check" implies something went wrong and invites the user to
     * go looking for a fault that does not exist; `source` already carries the reason, so the
     * `none:` prefix is dropped and the reason stands on its own.
     */
    const noFeed = t.source?.startsWith("none:") ? t.source.slice("none:".length).trim() : "";
    const why = t.latest
      ? `installed version unreadable — latest is ${t.latest}`
      : noFeed
        ? `no version to compare against — ${noFeed}`
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
