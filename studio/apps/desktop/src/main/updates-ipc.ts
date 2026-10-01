// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/updates-ipc.ts — `updates:check`: the whole third-party update report, for Studio.
 *
 * RELAY + PROJECTION (mirrors effort-ipc.ts / auth-level-ipc.ts): run the shared checker from
 * `@prometheus/core/updates-live`, flatten its result into the renderer-safe shapes declared in
 * `ipc-contract.ts`, and return them. No decisions are made here — every one of them lives in
 * core, so Studio and the terminal can never reach different conclusions about the same machine.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * Studio's only updater was `main/updater.ts`, which updates ELECTRON. A Studio-only user could
 * not learn that their `claude`, `codex`, `ollama` or local models were behind, and — more to the
 * point — could not be warned about the install conflicts that make an obvious `brew upgrade`
 * succeed while changing nothing they run.
 *
 * ── THE SANDBOX BOUNDARY ────────────────────────────────────────────────────────────────────
 *
 * This module spawns package managers and walks PATH. It is main-process only, which is exactly
 * why `updates-live` is a separate core subpath from the pure `updates` barrel the renderer may
 * import. Nothing from the renderer reaches a command here: the request carries ONE boolean, and
 * every argv is built in core from its own frozen tables.
 *
 * ── AND NOTHING IS EVER RUN ─────────────────────────────────────────────────────────────────
 *
 * The report carries copyable commands. Studio does not execute them, exactly as the CLI does
 * not (AUTO_INSTALL=false). An update is a change to the user's machine outside this app's
 * control, and the whole point of the conflict detection is that the obvious command is
 * sometimes the wrong one.
 */
import { updates as u } from "@prometheus/core";
import { DEFAULT_CONTEXT_WINDOW } from "@prometheus/core";
import {
  checkUpdates,
  fetchOllamaTags,
  fetchOllamaVersion,
  searchHuggingFace,
  upgradeLineFor,
} from "@prometheus/core/updates-live";
import { describeEngineFailure, localMemorySnapshot } from "@prometheus/engine-bridge";
import { ipcMain } from "electron";

import {
  type CatalogRowView,
  type CatalogSearchResult,
  IPC,
  type UpdateConflictView,
  type UpdatePackageView,
  type UpdateRemedyView,
  type UpdateToolView,
  type UpdatesReportResult,
} from "../shared/ipc-contract.js";

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/** The ollama daemon's version, for client/server skew. Fail-soft — a miss just omits the check. */
async function serverVersions(): Promise<Record<string, string>> {
  const v = await fetchOllamaVersion().catch(() => undefined);
  return v ? { ollama: v } : {};
}

function projectTools(report: u.UpdateReport): UpdateToolView[] {
  return (report.tools ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    role: t.role,
    installed: t.installed,
    state: t.state,
    current: t.current,
    latest: t.latest,
    updateAvailable: t.updateAvailable,
    ...(t.source ? { source: t.source } : {}),
    offer: t.offer.map((c) => ({ command: c.command, ...(c.note ? { note: c.note } : {}) })),
    withheld: t.withheld.map((w) => ({ command: w.command, reason: w.reason })),
    copies: t.copies.map((c) => ({
      path: c.pathEntry,
      realPath: c.realPath,
      owner: c.owner,
      ...(c.version ? { version: c.version } : {}),
    })),
    ...(t.note ? { note: t.note } : {}),
  }));
}

function projectPackages(report: u.UpdateReport): UpdatePackageView[] {
  const out: UpdatePackageView[] = [];
  for (const m of report.managers ?? []) {
    for (const p of m.packages) {
      out.push({
        manager: m.manager,
        managerLabel: m.label,
        name: p.name,
        ...(p.installed ? { installed: p.installed } : {}),
        ...(p.available ? { available: p.available } : {}),
        ...(p.pinned ? { pinned: true } : {}),
        // Built in core from the manager's own spec, including Homebrew's `--cask` flag — the
        // renderer never assembles a command.
        command: upgradeLineFor(p),
      });
    }
  }
  return out;
}

/**
 * The executable repair plans — the terminal's `/updates fix`, projected for the bridge.
 *
 * `core` builds these on every sweep (`updates-live/check.ts:385`, attached at `:420`) and this
 * file used to drop them on the floor, so Studio paid for the computation and showed none of it.
 *
 * Two deliberate choices, both copied from the terminal renderer (`apps/cli/src/updates/
 * updates-cmd.ts:191 renderFix`) rather than invented here:
 *
 *  1. ONE repair per SUBJECT. The same duplicate install surfaces as several conflicts sharing a
 *     single fix; emitting it per-conflict invites running it three times. `u.runnable` already
 *     dedupes by subject, so this uses it instead of re-deriving the rule.
 *  2. `argv` is rendered to a STRING for display only, via `u.displayCommand`. The array is not
 *     sent: nothing in the renderer may execute these, and shipping argv across the bridge would
 *     invite a future "run it for me" button that bypasses the authorisation ladder. Prometheus
 *     proposes; it never auto-updates.
 */
function projectRemedies(report: u.UpdateReport): UpdateRemedyView[] {
  return u.runnable(report.remedies ?? []).map((m) => ({
    kind: m.kind,
    subject: m.subject,
    title: m.title,
    rationale: m.rationale,
    steps: m.steps.map((step) => ({
      command: u.displayCommand(step.argv),
      purpose: step.purpose,
      risk: step.risk,
      ...(step.undo ? { undo: u.displayCommand(step.undo) } : {}),
      ...(step.displayAs ? { displayAs: [...step.displayAs] } : {}),
    })),
    ...(m.verify ? { verify: u.displayCommand(m.verify) } : {}),
    ...(m.keeps ? { keeps: m.keeps } : {}),
    minAuthLevel: m.minAuthLevel,
    ...(m.blocked ? { blocked: m.blocked } : {}),
    permanent: m.permanent,
  }));
}

/** `NEVER_RUN`, verbatim from core — shipped WITH the repairs, never instead of them. */
function projectNeverRun(): { command: string; because: string }[] {
  return u.NEVER_RUN.map((n) => ({ command: u.displayCommand(n.argv), because: n.because }));
}

function projectConflicts(report: u.UpdateReport): UpdateConflictView[] {
  return (report.conflicts ?? []).map((c) => ({
    kind: c.kind,
    subject: c.subject,
    summary: c.summary,
    consequence: c.consequence,
    ...(c.remedy ? { remedy: c.remedy } : {}),
    ...(c.avoid ? { avoid: c.avoid } : {}),
    severity: c.severity,
  }));
}

/**
 * Managers that could NOT answer, kept separate from the package list.
 *
 * An empty list from a manager nobody successfully asked is indistinguishable from "everything
 * is current", and that conflation is the failure this whole feature was built to stop.
 */
function projectUnavailable(report: u.UpdateReport) {
  return (report.managers ?? [])
    .filter((m) => !m.checkable || !m.ok)
    .map((m) => ({
      manager: m.manager,
      label: m.label,
      reason: m.checkable ? (m.note ?? "the check failed") : (m.note ?? "cannot be checked"),
    }));
}

function projectModels(report: u.UpdateReport) {
  return (report.models.upstream ?? [])
    .filter((c) => c.ok && c.update.changed)
    .map((c) => {
      const up = c.ok ? c.update : null;
      if (!up) return null;
      return {
        name: up.model,
        changed: up.changed,
        // "changed" and "newer" are different claims: an ollama manifest has no timestamp, so
        // without the push-time header the registry can only prove the tag moved, not that it
        // moved forward. A smaller rebuild is a real, measured case.
        newer: up.newer === true,
        command: `ollama pull ${up.model}`,
        ...(up.requiresOllama && !up.satisfiable
          ? { blockedBy: `needs ollama ${up.requiresOllama} — upgrade ollama first` }
          : {}),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
}

/**
 * Register `updates:check`. Returns a disposer, like every other IPC module here.
 *
 * `home` and `promVersion` are injected so tests never touch the real Prometheus home.
 */
export function registerUpdatesIpcHandlers(opts: {
  home?: string;
  promVersion?: string;
  /** test seam — the checker (default the real throttled one). */
  check?: typeof checkUpdates;
}): () => void {
  ipcMain.handle(IPC.updatesCheck, async (_e, arg: unknown): Promise<UpdatesReportResult> => {
    const empty = {
      conflicts: [],
      tools: [],
      packages: [],
      unavailableManagers: [],
      models: [],
      summary: "",
      remedies: [],
      // Still populated on the FAILURE path, deliberately: `NEVER_RUN` is static knowledge that
      // does not depend on the sweep succeeding, and a user whose check just failed is exactly
      // the one about to go looking for a command on the internet.
      neverRun: projectNeverRun(),
    };
    try {
      const a = (arg ?? {}) as Record<string, unknown>;
      /**
       * The ONLY thing the renderer may say. `force` skips the 6-hour throttle, which is what a
       * "Check now" button means; everything else — which managers to run, which URLs to fetch,
       * which argv to build — is decided in core from its own frozen tables.
       */
      const force = a.force === true;
      const run = opts.check ?? checkUpdates;
      const { report, fromCache } = await run({
        home: opts.home ?? process.env.PROMETHEUS_HOME ?? "",
        promVersion: opts.promVersion ?? "0.0.0",
        force,
        serverVersions: await serverVersions(),
      });
      return {
        ok: true,
        checkedAt: report.checkedAt,
        fromCache,
        conflicts: projectConflicts(report),
        tools: projectTools(report),
        packages: projectPackages(report),
        unavailableManagers: projectUnavailable(report),
        models: projectModels(report),
        self: {
          version: report.self.prometheus,
          ...(report.self.engine ? { engine: report.self.engine } : {}),
          ...(report.self.latest ? { latest: report.self.latest } : {}),
          updateAvailable: report.self.updateAvailable,
          command: report.self.plan.command,
          steps: report.self.plan.steps,
        },
        summary: u.summarizeForStartup(report),
        remedies: projectRemedies(report),
        neverRun: projectNeverRun(),
      };
    } catch (e) {
      // A failed check must never take the window with it — and must not render as "up to date".
      return {
        ok: false,
        error: errString(e),
        ...empty,
        self: { version: "", updateAvailable: null, command: "", steps: [] },
      };
    }
  });

  return () => {
    ipcMain.removeHandler(IPC.updatesCheck);
  };
}

/* ─────────────────────────── the model catalogue ─────────────────────────── */

/**
 * What the browser may promise this machine, read the same way the admission gate reads it.
 *
 * `os.totalmem()` would be the easy answer and the wrong one: it ignores what is already
 * resident and the reserve that keeps the compositor alive, and would offer models that cannot
 * load. A failed probe yields a ZERO budget, which makes every verdict "too-big" — conservative
 * and visible, rather than a silent promise.
 */
async function catalogBudget(): Promise<u.FitBudget> {
  try {
    const snap = await localMemorySnapshot();
    return {
      usableBytes: Math.max(0, snap.availableBytes - snap.headroomBytes),
      contextTokens: DEFAULT_CONTEXT_WINDOW,
    };
  } catch {
    return { usableBytes: 0, contextTokens: DEFAULT_CONTEXT_WINDOW };
  }
}

/**
 * Register `model-catalog:search`. Returns a disposer, like every other IPC module here.
 *
 * `registerModelCatalogIpcHandlers`, not `registerCatalogIpcHandlers`: that name already belongs
 * to `catalog-ipc.ts`, which serves the /invoke TOOL catalogue. Two unrelated catalogues under
 * one name is the third time this area has nearly made that mistake — see `toolUpdates` and
 * `modelCatalog` in the contract for the other two.
 */
export function registerModelCatalogIpcHandlers(
  opts: {
    /** test seam — the search (default the real HuggingFace one). */
    search?: typeof searchHuggingFace;
    budget?: () => Promise<u.FitBudget>;
    installed?: () => Promise<string[]>;
  } = {},
): () => void {
  ipcMain.handle(IPC.catalogSearch, async (_e, arg: unknown): Promise<CatalogSearchResult> => {
    const empty = { rows: [], usableBytes: 0 };
    try {
      const a = (arg ?? {}) as Record<string, unknown>;
      /**
       * The ONLY thing the renderer supplies, and it is clamped before use. A query becomes a
       * URL query parameter; length-capping it here means a sandboxed view cannot push a
       * multi-megabyte string into an outbound request.
       */
      const query = typeof a.query === "string" ? a.query.slice(0, 200) : "";
      const search = opts.search ?? searchHuggingFace;
      const res = await search({ query, limit: 40 });
      if (res.error) {
        // An error is never an empty catalogue: "nothing matched" and "HuggingFace was
        // unreachable" are different answers and only one is the query's fault.
        return { ok: false, error: res.error, ...empty };
      }
      const budget = await (opts.budget ?? catalogBudget)();
      const installed = await (
        opts.installed ?? (async () => (await fetchOllamaTags()).map((m) => m.name))
      )();
      const rows = u.sortCatalog(res.entries, "relevance", budget).map((entry): CatalogRowView => {
        const fit = u.fitOf(entry, budget);
        const here = entry.installed === true || installed.includes(entry.name);
        return {
          id: entry.id,
          name: entry.name,
          source: entry.source,
          summary: entry.summary,
          // null, never 0 — a 0 would render as "free" and rank first by size.
          sizeBytes: entry.sizeBytes ?? null,
          ...(entry.parameters ? { parameters: entry.parameters } : {}),
          ...(entry.contextTokens ? { contextTokens: entry.contextTokens } : {}),
          ...(entry.license ? { license: entry.license } : {}),
          ...(entry.downloads !== undefined ? { downloads: entry.downloads } : {}),
          installed: here,
          fit: fit.verdict,
          ...(fit.verdict === "too-big"
            ? {
                blocked: `needs ${(fit.needBytes / 1e9).toFixed(1)} GB; this machine can offer ${((fit.needBytes - fit.shortBytes) / 1e9).toFixed(1)} GB`,
              }
            : {}),
          command: u.installCommand(entry),
          tag: catalogTag(entry),
          body: [],
        };
      });
      return {
        ok: true,
        error: "",
        rows,
        usableBytes: budget.usableBytes,
        ...(res.limit ? { rateRemaining: res.limit.remaining } : {}),
      };
    } catch (e) {
      return { ok: false, error: errString(e), ...empty };
    }
  });

  return () => {
    ipcMain.removeHandler(IPC.catalogSearch);
  };
}

/** `hf.co/<repo>` — ollama's own supported form, so no conversion and no scraping is involved. */
function catalogTag(entry: u.CatalogEntry): string {
  if (entry.route.kind === "ollama-tag") return entry.route.tag;
  if (entry.route.kind === "ollama-hf") {
    return `hf.co/${entry.route.repo}${entry.route.quant ? `:${entry.route.quant}` : ""}`;
  }
  return entry.name;
}
