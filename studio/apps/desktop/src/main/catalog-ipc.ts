// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/catalog-ipc.ts — the typed `catalog:*` ipcMain handlers (file 06 §4,§8).
 *
 * The trusted side of the contextBridge seam for the Catalog manager. RELAY-ONLY
 * (mirrors model-ipc.ts / env-ipc.ts / security-ipc.ts): every handler
 *   1. zod-validates the renderer's arg at the seam (catalog-validate.ts),
 *   2. delegates to the engine-bridge CATALOG (read) + LIFECYCLE (state-changing)
 *      clients — the ONLY python3 spawners (C5), which route every install/clone/
 *      audit through the engine's OWN nemesis gate (prepare_nemesis → enforce_gate
 *      on each git_clone target; it already fails closed),
 *   3. maps the result down to a renderer-safe plain-data shape from the shared
 *      contract, and NEVER lets a live handle cross back.
 *
 * GOLDEN RULE (C5/the SPINE): JavaScript never decides "safe". An install returns
 * whatever the engine produced — `ok:false` + `forced_danger` when nemesis refused
 * and `--force` overrode it. This file performs NO scoring, NO allowlist, NO
 * heuristic, and never upgrades a verdict toward allow.
 *
 * THE FORCE GATE (§8): the seam REFUSES `--force` unless the renderer ALSO passed
 * the typed-confirm flag (`confirmForce:true`) — catalog-validate.ts collapses
 * `force && confirmForce` to the honoured `force`, so a missing confirm silently
 * downgrades to a NORMAL gated install (the engine still blocks). The MAIN process
 * therefore cannot be tricked into a silent force-override (file 03's flow owns the
 * typed-confirm UX).
 *
 * DOCUMENTED-ONLY is enforced upstream (core: `installable:false`); a documented
 * item has no Install action in the DOM. As a defence-in-depth backstop the engine
 * itself rejects installing a non-installable name.
 *
 * Node/Electron only at runtime (privileged main process). It imports
 * @prometheus/engine-bridge — which the renderer is forbidden from doing. The
 * pure, testable arg-validation lives in catalog-validate.ts (zod-double-tested).
 */

import { ipcMain } from "electron";

import {
  type CatalogManagerItem,
  type StatusEnvelopeLike,
  appTableToItems,
  buildPluginCatalog,
  reconcileItems,
} from "@prometheus/core";
import {
  type CatalogClientOptions,
  type EngineEnvelope,
  type LifecycleClientOptions,
  type RawEngineResult,
  createCatalogClient,
  createLifecycleClient,
  describeEngineFailure,
} from "@prometheus/engine-bridge";

import {
  type CatalogBrowseResult,
  type CatalogEnvelopeResult,
  type CatalogInstallResult,
  type CatalogProgressEvent,
  type CatalogRawResult,
  IPC,
  IPC_EVENTS,
} from "../shared/ipc-contract.js";
import {
  validateCatalogAppLifecycle,
  validateCatalogAudit,
  validateCatalogBundle,
  validateCatalogInstall,
  validateCatalogInventory,
  validateCatalogName,
  validateCatalogRaw,
  validateCatalogScaffold,
  validateCatalogStatus,
  validateCatalogSync,
  validateCatalogToggle,
  validateCatalogUninstall,
} from "./catalog-validate.js";

/** Coerce an unknown caught value to a short error string. */
// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/** Extract the renderer's WebContents `sender` WITHOUT importing the electron type. */
function senderOf(
  evt: unknown,
):
  | { send(channel: string, payload: CatalogProgressEvent): void; isDestroyed?(): boolean }
  | undefined {
  if (!evt || typeof evt !== "object") return undefined;
  const sender = (evt as { sender?: unknown }).sender;
  if (sender && typeof (sender as { send?: unknown }).send === "function") {
    return sender as { send(channel: string, payload: CatalogProgressEvent): void };
  }
  return undefined;
}

/** Map a parsed engine envelope → the renderer-safe CatalogEnvelopeResult. */
function toEnvelope(env: EngineEnvelope): CatalogEnvelopeResult {
  const out: CatalogEnvelopeResult = { ok: env.ok !== false, data: env };
  if (typeof env.error === "string") out.error = env.error;
  return out;
}

/** Map a human-table RawEngineResult → the renderer-safe CatalogRawResult. */
function toRaw(r: RawEngineResult): CatalogRawResult {
  const out: CatalogRawResult = { ok: r.ok, command: r.command, lines: r.lines };
  if (r.action !== undefined) out.action = r.action;
  if (r.engine !== undefined) out.engine = r.engine;
  if (r.error !== undefined) out.error = r.error;
  if (r.raw !== undefined) out.raw = r.raw;
  return out;
}

/** Map an install/uninstall/bundle envelope → the renderer-safe CatalogInstallResult. */
function toInstall(env: EngineEnvelope): CatalogInstallResult {
  const out: CatalogInstallResult = { ok: env.ok !== false, data: env };
  if (typeof env.command === "string") out.command = env.command;
  // _install_events_json nests events under `results`; tolerate both shapes.
  const results = env.results as Record<string, unknown> | undefined;
  const events = (results?.install_events ?? env.install_events) as unknown;
  if (Array.isArray(events)) out.installEvents = events as Record<string, unknown>[];
  const summary = (results?.summary ?? env.summary) as unknown;
  if (summary && typeof summary === "object") out.summary = summary as Record<string, unknown>;
  // forced_danger rides verbatim from the engine (set iff --force overrode a BLOCK).
  if (Array.isArray(env.forced_danger)) {
    out.forcedDanger = env.forced_danger.map((f) => {
      const d = f as unknown as Record<string, unknown>;
      const mapped: NonNullable<CatalogInstallResult["forcedDanger"]>[number] = {
        label: String(d.label ?? ""),
        verdict: d.verdict === "error" ? "error" : "block",
        blockingReasons: Array.isArray(d.blocking_reasons) ? d.blocking_reasons.map(String) : [],
      };
      if (typeof d.risk_score === "number") mapped.riskScore = d.risk_score;
      return mapped;
    });
  }
  if (typeof env.message === "string") out.message = env.message;
  if (typeof env.error === "string") out.error = env.error;
  // When the engine reports a per-target failure via STRUCTURED fields (install_events
  // + summary + _exit) but sets NO top-level error/message string, synthesize a real
  // reason here so the renderer never falls back to a bare "install failed". Benefits
  // every caller (install + bundle). The full stderr reason still streams over
  // catalog:progress for the log pane.
  if (out.ok === false && !out.error && !out.message) {
    const events = out.installEvents ?? [];
    const bad = events.filter((e) => {
      const r = (e as { result?: unknown }).result;
      return r === "failed" || r === "blocked" || r === "error";
    });
    if (bad.length > 0) {
      out.message = bad
        .map((e) => {
          const d = e as { plugin?: unknown; agent?: unknown; result?: unknown };
          return `${String(d.plugin ?? "?")}@${String(d.agent ?? "?")}: ${String(d.result)}`;
        })
        .join("; ");
    } else if (out.summary && Object.keys(out.summary).length > 0) {
      out.message = `install did not complete: ${Object.entries(out.summary)
        .map(([k, v]) => `${String(v)} ${k}`)
        .join(", ")}`;
    }
  }
  return out;
}

/** Construction-time wiring (the catalog + lifecycle clients + optional broadcast). */
export interface CatalogIpcWiring {
  /** optional read-client options (timeouts etc.); else defaults resolve (C2). */
  catalogOptions?: CatalogClientOptions;
  /** optional lifecycle-client options. */
  lifecycleOptions?: LifecycleClientOptions;
}

export function registerCatalogIpcHandlers(wiring: CatalogIpcWiring = {}): () => void {
  const catalog = createCatalogClient(wiring.catalogOptions);
  const lifecycle = createLifecycleClient(wiring.lifecycleOptions);

  /** Build an onStderr sink that forwards the engine's progress lines to the renderer. */
  function progressSink(evt: unknown, runId?: string): ((line: string) => void) | undefined {
    const sender = senderOf(evt);
    if (!sender) return undefined;
    return (line: string): void => {
      // Checked per LINE, not once when the sink is built: a catalog install runs for
      // minutes and the window can go away at any point inside it. Fire-and-forget `send`
      // on a destroyed WebContents throws, and it threw out of the engine's stderr pump.
      if (sender.isDestroyed?.()) return;
      const event: CatalogProgressEvent = { phase: "info", message: line, raw: line };
      if (runId !== undefined) event.runId = runId;
      sender.send(IPC_EVENTS.catalogProgress, event);
    };
  }

  // ── browse — the PROJECTED catalog (list + matrix + status, projected in MAIN) ─
  // The PURE @prometheus/core normalize runs HERE (the privileged side, where the
  // Node-only core barrel is allowed) so the sandboxed renderer renders plain data
  // and never bundles core (C5). The engine stays authoritative for installed-state.
  ipcMain.handle(IPC.catalogBrowse, async (): Promise<CatalogBrowseResult> => {
    try {
      const [listEnv, matrixEnv, statusEnv, appsRaw, worldsimRaw, modelsRaw] = await Promise.all([
        catalog.list(),
        catalog.matrix().catch(() => undefined),
        catalog.status("all").catch(() => undefined),
        // the apps / worldsim / model-tool registries are served as HUMAN TABLES (no
        // JSON) by separate verbs — fold them in so the panel shows ALL registries, not
        // just plugins. Fail-soft per registry.
        catalog
          .appsList()
          .then(toRaw)
          .catch(() => undefined),
        catalog
          .worldsimList()
          .then(toRaw)
          .catch(() => undefined),
        catalog
          .modelsList()
          .then(toRaw)
          .catch(() => undefined),
      ]);
      if (listEnv.ok === false) {
        return { ok: false, items: [], error: listEnv.error ?? "catalog list failed" };
      }
      const listRows = Array.isArray(listEnv.catalog)
        ? (listEnv.catalog as Parameters<typeof buildPluginCatalog>[0]["list"])
        : undefined;
      const documented = Array.isArray(listEnv.documented)
        ? (listEnv.documented as Parameters<typeof buildPluginCatalog>[0]["documented"])
        : undefined;
      const reach =
        matrixEnv && Array.isArray(matrixEnv.reach)
          ? (matrixEnv.reach as Parameters<typeof buildPluginCatalog>[0]["reach"])
          : undefined;
      const projected: CatalogManagerItem[] = buildPluginCatalog({
        list: listRows,
        documented,
        reach,
      });
      const plugins = reconcileItems(projected, statusEnv as StatusEnvelopeLike | undefined);
      // parse the human-table registries with the pure appTableToItems (node:test-ed).
      const extra: CatalogManagerItem[] = [];
      if (appsRaw?.ok) extra.push(...appTableToItems(appsRaw.lines, { kind: "app" }));
      if (worldsimRaw?.ok) extra.push(...appTableToItems(worldsimRaw.lines, { kind: "worldsim" }));
      if (modelsRaw?.ok) extra.push(...appTableToItems(modelsRaw.lines, { kind: "model-tool" }));
      const items = [...plugins, ...extra];
      const agents = Array.isArray(matrixEnv?.agents)
        ? (matrixEnv.agents as unknown[]).map(String)
        : Array.isArray(listEnv.detected_agents)
          ? (listEnv.detected_agents as unknown[]).map(String)
          : undefined;
      const out: CatalogBrowseResult = { ok: true, items };
      if (agents !== undefined) out.agents = agents;
      return out;
    } catch (e) {
      return { ok: false, items: [], error: errString(e) };
    }
  });

  // ── JSON-envelope reads (read-only) ───────────────────────────────────────
  ipcMain.handle(IPC.catalogList, async (): Promise<CatalogEnvelopeResult> => {
    try {
      return toEnvelope(await catalog.list());
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.catalogInfo, async (_evt, arg: unknown): Promise<CatalogEnvelopeResult> => {
    const v = validateCatalogName(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toEnvelope(await catalog.info(v.value.name));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.catalogWhere, async (_evt, arg: unknown): Promise<CatalogEnvelopeResult> => {
    const v = validateCatalogName(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toEnvelope(await catalog.where(v.value.name));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.catalogMatrix, async (): Promise<CatalogEnvelopeResult> => {
    try {
      return toEnvelope(await catalog.matrix());
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.catalogStatus, async (_evt, arg: unknown): Promise<CatalogEnvelopeResult> => {
    const v = validateCatalogStatus(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toEnvelope(await catalog.status(v.value.name as string | "all"));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── audit (scan, no install) — the verdict rides through UNCHANGED (C5) ────
  ipcMain.handle(IPC.catalogAudit, async (_evt, arg: unknown): Promise<CatalogEnvelopeResult> => {
    const v = validateCatalogAudit(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toEnvelope(
        await catalog.audit(v.value.name, { strict: v.value.strict, gateFresh: v.value.gateFresh }),
      );
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.catalogSuperscan, async (): Promise<CatalogEnvelopeResult> => {
    try {
      return toEnvelope(await catalog.superscan());
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.catalogSkillsList, async (): Promise<CatalogEnvelopeResult> => {
    try {
      return toEnvelope(await catalog.skillsList());
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.catalogVaultStatus, async (): Promise<CatalogEnvelopeResult> => {
    try {
      return toEnvelope(await catalog.vaultStatus());
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── human-table reads (apps/worldsim/models list, localai *, inventory) ────
  ipcMain.handle(IPC.catalogInventory, async (_evt, arg: unknown): Promise<CatalogRawResult> => {
    const v = validateCatalogInventory(arg);
    if (!v.ok) return { ok: false, command: "inventory", lines: [], error: v.error.message };
    try {
      const opts: { host?: string } = {};
      if (v.value.host !== undefined) opts.host = v.value.host;
      return toRaw(await catalog.inventory(opts));
    } catch (e) {
      return { ok: false, command: "inventory", lines: [], error: errString(e) };
    }
  });

  /** The apps/worldsim/models/localai READ passthrough (no JSON envelope). async so
   *  a REJECTED engine chain (not just a sync throw) is caught + returned fail-closed. */
  async function readRaw(arg: unknown): Promise<CatalogRawResult> {
    const v = validateCatalogRaw(arg);
    if (!v.ok) return { ok: false, command: "catalog", lines: [], error: v.error.message };
    const a = v.value;
    try {
      if (a.surface === "localai") {
        const action = a.localaiAction ?? "audit";
        if (action === "show") {
          if (!a.tool)
            return {
              ok: false,
              command: "localai",
              action,
              lines: [],
              error: "localai show needs a tool",
            };
          return toRaw(await catalog.localaiShow(a.tool));
        }
        if (action === "models") return toRaw(await catalog.localaiModels());
        if (action === "endpoints") return toRaw(await catalog.localaiEndpoints());
        return toRaw(await catalog.localaiAudit());
      }
      const action = a.action ?? "list";
      const opts: { path?: string; version?: string } = {};
      if (a.path !== undefined) opts.path = a.path;
      if (a.version !== undefined) opts.version = a.version;
      if (a.surface === "worldsim") return toRaw(await catalog.worldsim(action, a.tool, opts));
      if (a.surface === "models") return toRaw(await catalog.models(action, a.tool));
      return toRaw(await catalog.apps(action, a.tool, opts));
    } catch (e) {
      return { ok: false, command: a.surface, lines: [], error: errString(e) };
    }
  }
  ipcMain.handle(IPC.catalogApps, (_evt, arg: unknown) => readRaw(arg));
  ipcMain.handle(IPC.catalogWorldsim, (_evt, arg: unknown) => readRaw(arg));
  ipcMain.handle(IPC.catalogModels, (_evt, arg: unknown) => readRaw(arg));
  ipcMain.handle(IPC.catalogLocalai, (_evt, arg: unknown) => readRaw(arg));

  // ── install (GATED by the engine's nemesis; force needs the typed-confirm) ─
  ipcMain.handle(
    IPC.catalogInstall,
    async (evt: unknown, arg: unknown): Promise<CatalogInstallResult> => {
      const v = validateCatalogInstall(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      try {
        const opts: Parameters<typeof lifecycle.install>[1] = {
          arm: a.arm,
          dryRun: a.dryRun,
          yes: a.yes,
          strict: a.strict,
          force: a.force, // already collapsed to (force && confirmForce) at the seam
        };
        if (a.host !== undefined) opts.host = a.host;
        if (a.only !== undefined) opts.only = a.only;
        if (a.skip !== undefined) opts.skip = a.skip;
        const sink = progressSink(evt, a.runId);
        if (sink) opts.onStderr = sink;
        return toInstall(await lifecycle.install(a.name, opts));
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── uninstall (subset removal; dry-run-first) ──────────────────────────────
  ipcMain.handle(
    IPC.catalogUninstall,
    async (evt: unknown, arg: unknown): Promise<CatalogInstallResult> => {
      const v = validateCatalogUninstall(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      try {
        const opts: Parameters<typeof lifecycle.uninstall>[1] = { dryRun: a.dryRun, yes: a.yes };
        if (a.host !== undefined) opts.host = a.host;
        if (a.only !== undefined) opts.only = a.only;
        if (a.skip !== undefined) opts.skip = a.skip;
        const sink = progressSink(evt, a.runId);
        if (sink) opts.onStderr = sink;
        return toInstall(await lifecycle.uninstall(a.name, opts));
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── enable / disable (component-aware) ─────────────────────────────────────
  ipcMain.handle(IPC.catalogEnable, async (_evt, arg: unknown): Promise<CatalogEnvelopeResult> => {
    const v = validateCatalogToggle(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const a = v.value;
    try {
      const opts: Parameters<typeof lifecycle.enable>[1] = {};
      if (a.only !== undefined) opts.only = a.only;
      if (a.component !== undefined) opts.component = a.component;
      if (a.host !== undefined) opts.host = a.host;
      return toEnvelope(await lifecycle.enable(a.name, opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.catalogDisable, async (_evt, arg: unknown): Promise<CatalogEnvelopeResult> => {
    const v = validateCatalogToggle(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const a = v.value;
    try {
      const opts: Parameters<typeof lifecycle.disable>[1] = {};
      if (a.only !== undefined) opts.only = a.only;
      if (a.component !== undefined) opts.component = a.component;
      if (a.host !== undefined) opts.host = a.host;
      return toEnvelope(await lifecycle.disable(a.name, opts));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── bundle (the one-run official set; force needs the typed-confirm) ───────
  ipcMain.handle(
    IPC.catalogBundle,
    async (evt: unknown, arg: unknown): Promise<CatalogInstallResult> => {
      const v = validateCatalogBundle(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      try {
        const opts: Parameters<typeof lifecycle.bundle>[0] = {};
        if (a.host !== undefined) opts.host = a.host;
        // bundle does not take --dry-run/--yes/--force directly in the engine's
        // p_bndl, but we thread force through the run layer for parity + audit.
        if (a.force) (opts as { forced?: boolean }).forced = true;
        const sink = progressSink(evt, a.runId);
        if (sink) opts.onStderr = sink;
        return toInstall(await lifecycle.bundle(opts));
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── sync (replicate a SKILL.md cross-CLI) ──────────────────────────────────
  ipcMain.handle(IPC.catalogSync, async (_evt, arg: unknown): Promise<CatalogEnvelopeResult> => {
    const v = validateCatalogSync(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return toEnvelope(await lifecycle.sync(v.value.skill, { to: v.value.to }));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── scaffold-skill (write an auto-firing SKILL.md) ─────────────────────────
  ipcMain.handle(
    IPC.catalogScaffoldSkill,
    async (_evt, arg: unknown): Promise<CatalogEnvelopeResult> => {
      const v = validateCatalogScaffold(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      try {
        const opts: Parameters<typeof lifecycle.scaffoldSkill>[1] = { autoFire: a.autoFire };
        if (a.trigger !== undefined) opts.trigger = a.trigger;
        if (a.body !== undefined) opts.body = a.body;
        if (a.tools !== undefined) opts.tools = a.tools;
        return toEnvelope(await lifecycle.scaffoldSkill(a.name, opts));
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── apps/worldsim/models LIFECYCLE (4th/8th/3rd fn; engine gates the fetch) ─
  ipcMain.handle(
    IPC.catalogAppLifecycle,
    async (evt: unknown, arg: unknown): Promise<CatalogEnvelopeResult> => {
      const v = validateCatalogAppLifecycle(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a = v.value;
      try {
        const opts: { path?: string; version?: string; onStderr?: (line: string) => void } = {};
        if (a.path !== undefined) opts.path = a.path;
        if (a.version !== undefined) opts.version = a.version;
        const sink = progressSink(evt, a.runId);
        if (sink) opts.onStderr = sink;
        let env: EngineEnvelope;
        if (a.surface === "worldsim") env = await lifecycle.worldsim(a.action, a.tool, opts);
        else if (a.surface === "models") env = await lifecycle.models(a.action, a.tool, opts);
        else env = await lifecycle.apps(a.action, a.tool, opts);
        return toEnvelope(env);
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── disposer ───────────────────────────────────────────────────────────────
  return () => {
    for (const channel of [
      IPC.catalogBrowse,
      IPC.catalogList,
      IPC.catalogInfo,
      IPC.catalogWhere,
      IPC.catalogMatrix,
      IPC.catalogStatus,
      IPC.catalogAudit,
      IPC.catalogSuperscan,
      IPC.catalogSkillsList,
      IPC.catalogVaultStatus,
      IPC.catalogInventory,
      IPC.catalogApps,
      IPC.catalogWorldsim,
      IPC.catalogModels,
      IPC.catalogLocalai,
      IPC.catalogInstall,
      IPC.catalogUninstall,
      IPC.catalogEnable,
      IPC.catalogDisable,
      IPC.catalogBundle,
      IPC.catalogSync,
      IPC.catalogScaffoldSkill,
      IPC.catalogAppLifecycle,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
