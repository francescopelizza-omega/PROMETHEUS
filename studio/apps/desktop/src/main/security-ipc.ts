// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/security-ipc.ts — the typed `security:*` ipcMain handlers (file 03 §5,§7).
 *
 * The trusted side of the contextBridge seam for the FULL nemesis.verdict/1
 * surface. It is RELAY-ONLY (the brief's "NO logic, just relay"): every handler
 *   1. zod-validates the renderer's arg at the seam (security-validate.ts),
 *   2. delegates to an engine-bridge security function (the ONLY nemesis/python3
 *      spawner — C5), which already fails closed,
 *   3. maps the result down to a renderer-safe plain-data shape from the shared
 *      contract, and NEVER lets a live handle cross back.
 *
 * GOLDEN RULE (C5): JavaScript never decides "safe". gateFull() returns whatever
 * NemesisVerdict engine-bridge produced (missing/timeout/unparseable ⇒ verdict
 * "error" ⇒ fail-closed BLOCK); this file never upgrades a verdict toward allow.
 * It performs NO scoring, NO allowlist, NO heuristic.
 *
 * Node/Electron only at runtime (privileged main process). It imports
 * @prometheus/engine-bridge — which the renderer is forbidden from doing. The
 * pure, testable arg-validation lives in security-validate.ts (zod-double-tested,
 * no electron), exactly as ipc.ts splits its logic into validate.ts/verdict-map.ts.
 */

import { ipcMain } from "electron";

import { purgeBasename } from "@prometheus/core";
import {
  type EngineConfig,
  auditScan,
  authKey,
  acceptFinding as bridgeAcceptFinding,
  auditLog as bridgeAuditLog,
  cacheStatus,
  clearCache,
  createEngineClient,
  describeEngineFailure,
  disinfect,
  gateFull,
  listTrusted,
  purge,
  quarantineList,
  restore,
  revoke,
  syntheticErrorVerdict,
  threatDbStatus,
  updateFeeds,
  urlQuarantineList,
  urlQuarantineRestore,
  urlSourceAudit,
  verify,
} from "@prometheus/engine-bridge";

import {
  type EnvelopeResult,
  IPC,
  IPC_EVENTS,
  type ProgressFeedEvent,
  type SecurityGateResult,
  type SecurityRemediateResult,
  type SecurityThreatDbResult,
  type SecurityTrustResult,
  type SecurityUrlAuditRequest,
  type SecurityUrlAuditResult,
} from "../shared/ipc-contract.js";
import type { IpcErrorShape } from "./arg-guards.js";
import {
  type GateArgs,
  type RemediateArgs,
  type SecurityInstallArgs,
  type ThreatDbArgs,
  type TrustArgs,
  validateGate,
  validateRemediate,
  validateSecurityAudit,
  validateSecurityInstall,
  validateThreatDb,
  validateTrust,
} from "./security-validate.js";

/** Coerce an unknown caught value to a short error string. */
/**
 * The gate mode the NEXT engine spawn will inherit.
 *
 * `safeChildEnv()` forwards main's env verbatim to prometheus.py, so main's own
 * `$PROMETHEUS_GATE` IS the mode — a live fact, not an inference from the audit history. The
 * console had only that history, and a stale `enforce` row vouched for a session now running
 * `off`, which is a green "armed, fail-closed" banner over an unguarded engine.
 *
 * Unset means `enforce`: that is the engine's own fail-closed default, so absence is not
 * uncertainty. Anything unrecognised IS uncertainty and reports as `unknown` rather than being
 * quietly rounded to a mode nobody asked for.
 */
function configuredGateMode(): "enforce" | "warn" | "off" | "unknown" {
  const raw = process.env.PROMETHEUS_GATE?.trim().toLowerCase();
  if (!raw) return "enforce";
  return raw === "enforce" || raw === "warn" || raw === "off" ? raw : "unknown";
}

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/**
 * The minimal `{ send }` surface used to push security progress events back to
 * the initiating window. Extracted WITHOUT importing the electron event type.
 */
function senderOf(
  evt: unknown,
):
  | { send(channel: string, payload: ProgressFeedEvent): void; isDestroyed?(): boolean }
  | undefined {
  if (!evt || typeof evt !== "object") return undefined;
  const sender = (evt as { sender?: unknown }).sender;
  if (sender && typeof (sender as { send?: unknown }).send === "function") {
    return sender as { send(channel: string, payload: ProgressFeedEvent): void };
  }
  return undefined;
}

/** Construction-time wiring (engine config + the run registry for cancellation). */
export interface SecurityIpcWiring {
  /** optional engine config (else env / sibling defaults resolve, C2). */
  engineConfig?: EngineConfig;
  /**
   * the shared runId→AbortController registry the main ipc owns. When present, a
   * security op carrying a runId is abortable via the existing `cancel(runId)`.
   */
  runs?: Map<string, AbortController>;
}

export function registerSecurityIpcHandlers(wiring: SecurityIpcWiring = {}): () => void {
  const config = wiring.engineConfig ?? {};
  const client = createEngineClient(config);
  const runs = wiring.runs;

  /** Forward a security progress line to the initiating window (cosmetic, C5). */
  function emitSecurityProgress(
    sender:
      | { send(channel: string, payload: ProgressFeedEvent): void; isDestroyed?(): boolean }
      | undefined,
    runId: string | undefined,
    line: string,
  ): void {
    // A progress feed OUTLIVES its window: an op started, the user closed that window,
    // and every later line threw "Object has been destroyed" out of a fire-and-forget
    // emit — which surfaced as the op appearing to die mid-run.
    if (!sender || sender.isDestroyed?.()) return;
    const event: ProgressFeedEvent = { message: line, phase: "info", raw: line };
    if (runId !== undefined) event.runId = runId;
    sender.send(IPC_EVENTS.securityProgress, event);
  }

  /** Register/clean an AbortController under a runId (no-op without a registry). */
  function trackRun(runId: string | undefined): AbortController | undefined {
    if (!runId || !runs) return undefined;
    const ac = new AbortController();
    runs.set(runId, ac);
    return ac;
  }
  function untrackRun(runId: string | undefined): void {
    if (runId && runs) runs.delete(runId);
  }

  /** A rejection carrying the serializable invalid-args shape (for symmetry only). */
  function invalidGate(target: string, err: IpcErrorShape): SecurityGateResult {
    // Fail-closed: a bad arg is rendered as an error verdict, never assumed safe.
    return {
      ok: false,
      verdict: syntheticErrorVerdict(target, err.message),
      error: err.message,
    };
  }

  // ── security:gate / security:gateFull — the RICH verdict (§4) ─────────────
  const handleGate = async (_evt: unknown, arg: unknown): Promise<SecurityGateResult> => {
    const v = validateGate(arg);
    if (!v.ok) {
      const target =
        arg && typeof arg === "object" && typeof (arg as { target?: unknown }).target === "string"
          ? (arg as { target: string }).target
          : "";
      return invalidGate(target, v.error);
    }
    const a: GateArgs = v.value;
    try {
      const verdict = await gateFull(
        a.target,
        {
          fresh: a.fresh,
          sign: a.sign,
          ...(a.tier ? { tier: a.tier } : {}),
          ...(a.policyFile ? { policyFile: a.policyFile } : {}),
        },
        config,
      );
      const blocked = verdict.verdict === "block" || verdict.verdict === "error";
      return { ok: !blocked, verdict };
    } catch (e) {
      // gateFull never throws a "safe"; a hard crash still fails closed.
      return {
        ok: false,
        verdict: syntheticErrorVerdict(a.target, errString(e)),
        error: errString(e),
      };
    }
  };
  ipcMain.handle(IPC.securityGate, handleGate);
  ipcMain.handle(IPC.securityGateFull, handleGate);

  // ── security:audit — read-only deep audit (§4) ────────────────────────────
  ipcMain.handle(IPC.securityAudit, async (_evt, arg: unknown): Promise<EnvelopeResult> => {
    const v = validateSecurityAudit(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const env = await auditScan(v.value.name, {}, config);
      return { ok: env.ok !== false, data: env as Record<string, unknown> };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── security:install — the gated install (§5); engine runs nemesis itself ──
  ipcMain.handle(
    IPC.securityInstall,
    async (evt: unknown, arg: unknown): Promise<EnvelopeResult> => {
      const v = validateSecurityInstall(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const a: SecurityInstallArgs = v.value;
      const sender = senderOf(evt);
      const ac = trackRun(a.runId);
      // §8/C5: `forced` is honored ONLY with the paired typed-confirm. Without it,
      // DROP to a non-forced install (fail-safe) — JS never silently force-overrides
      // a nemesis BLOCK. Mirrors the catalog/repo seams.
      const forced = a.forced === true && a.confirmForce === true;
      try {
        const env = await client.install(a.name, {
          dryRun: a.dryRun,
          forced,
          ...(ac ? { signal: ac.signal } : {}),
          onStderr: (line: string) => emitSecurityProgress(sender, a.runId, line),
        });
        return { ok: env.ok !== false, data: env as Record<string, unknown> };
      } catch (e) {
        return { ok: false, error: errString(e) };
      } finally {
        untrackRun(a.runId);
      }
    },
  );

  // ── security:remediate — disinfect|quarantineList|restore|purge|acceptFinding (§9,§5.5) ─
  ipcMain.handle(
    IPC.securityRemediate,
    async (evt: unknown, arg: unknown): Promise<SecurityRemediateResult> => {
      const v = validateRemediate(arg);
      if (!v.ok) {
        const op =
          arg && typeof arg === "object" && typeof (arg as { op?: unknown }).op === "string"
            ? ((arg as { op: string }).op as RemediateArgs["op"])
            : ("disinfect" as RemediateArgs["op"]);
        return { ok: false, op, error: v.error.message };
      }
      const a: RemediateArgs = v.value;
      const sender = senderOf(evt);
      try {
        switch (a.op) {
          case "disinfect": {
            const ac = trackRun(a.runId);
            try {
              const res = await disinfect(
                a.target,
                {
                  out: a.out,
                  ...(ac ? { signal: ac.signal } : {}),
                  onStderr: (line: string) => emitSecurityProgress(sender, a.runId, line),
                },
                config,
              );
              return {
                ok: res.ok,
                op: "disinfect",
                data: res as unknown as Record<string, unknown>,
              };
            } finally {
              untrackRun(a.runId);
            }
          }
          case "quarantineList": {
            const res = await quarantineList(
              {
                ...(a.target ? { target: a.target } : {}),
                ...(a.quarantineDir ? { quarantineDir: a.quarantineDir } : {}),
              },
              config,
            );
            return {
              ok: res.ok,
              op: "quarantineList",
              data: res as unknown as Record<string, unknown>,
            };
          }
          case "restore": {
            /**
             * §4's typed confirm, re-checked HERE and not only in the renderer.
             *
             * Restore puts an artifact the gate refused back where nemesis found it, and it
             * is executable the moment it lands. Purge — the irreversible one — has had a
             * main-process re-check since it shipped; restore had a dialog and nothing else,
             * so any renderer bug that armed a target and called through reinstated the
             * artifact with no independent verification.
             *
             * Same limits as purge, stated plainly: the renderer mediates the human's input
             * and a fully compromised renderer could forge it. This catches a buggy or
             * wrong-item caller, which is the realistic failure. Fail-closed.
             */
            if (a.typedName !== purgeBasename(a.path ?? a.id)) {
              return {
                ok: false,
                op: "restore",
                error: "restore refused: typed confirmation does not match the item",
              };
            }
            const res = await restore(a.id, { quarantineDir: a.quarantineDir }, config);
            return { ok: res.ok, op: "restore", data: res as unknown as Record<string, unknown> };
          }
          case "purge": {
            // §9.3 destructive typed-confirm. The renderer forwards the EXACT string
            // the human typed in PurgeDialog (the file's basename); we refuse unless
            // it equals purgeBasename(target). This verifies the human's confirmation
            // (and catches a wrong-item/buggy caller) rather than a renderer echo of
            // the target. It is NOT a barrier against a fully compromised renderer —
            // the renderer mediates the human's input and could forge it, which is
            // unavoidable in Electron. Fail-closed: missing/mismatched ⇒ refused.
            if (a.typedName !== purgeBasename(a.target)) {
              return {
                ok: false,
                op: "purge",
                error: "purge refused: typed confirmation does not match the filename",
              };
            }
            const res = await purge(a.target, { kind: a.kind }, config);
            return { ok: res.ok, op: "purge", data: res as unknown as Record<string, unknown> };
          }
          default: {
            // acceptFinding — pure/synchronous in this engine build (honest limit).
            const res = bridgeAcceptFinding(a.target, a.ruleId, a.path);
            return {
              ok: res.ok,
              op: "acceptFinding",
              data: res as unknown as Record<string, unknown>,
            };
          }
        }
      } catch (e) {
        return { ok: false, op: a.op, error: errString(e) };
      }
    },
  );

  // ── security:threatdb — status|update(streamed)|authKey|cache (§6) ────────
  ipcMain.handle(
    IPC.securityThreatdb,
    async (evt: unknown, arg: unknown): Promise<SecurityThreatDbResult> => {
      const v = validateThreatDb(arg);
      if (!v.ok) {
        const op =
          arg && typeof arg === "object" && typeof (arg as { op?: unknown }).op === "string"
            ? ((arg as { op: string }).op as ThreatDbArgs["op"])
            : ("status" as ThreatDbArgs["op"]);
        return { ok: false, op, error: v.error.message };
      }
      const a: ThreatDbArgs = v.value;
      const sender = senderOf(evt);
      try {
        switch (a.op) {
          case "status": {
            const status = await threatDbStatus({}, config);
            return { ok: status.ok, op: "status", status };
          }
          case "update": {
            const ac = trackRun(a.runId);
            try {
              const res = await updateFeeds(
                {
                  force: a.force,
                  all: a.all,
                  ...(a.feeds ? { feeds: a.feeds } : {}),
                  ...(ac ? { signal: ac.signal } : {}),
                  onStderr: (line: string) => emitSecurityProgress(sender, a.runId, line),
                },
                config,
              );
              return {
                ok: res.ok,
                op: "update",
                message: res.summary,
                ...(res.error ? { error: res.error } : {}),
              };
            } finally {
              untrackRun(a.runId);
            }
          }
          case "authKey": {
            // authKey() deliberately drops any stderr sink so the key cannot leak.
            const res = await authKey(a.key, {}, config);
            return { ok: res.ok, op: "authKey", ...(res.error ? { error: res.error } : {}) };
          }
          default: {
            // cache: status | clear
            if (a.action === "clear") {
              const res = await clearCache({}, config);
              return {
                ok: res.ok,
                op: "cache",
                message: res.message,
                ...(res.error ? { error: res.error } : {}),
              };
            }
            const res = await cacheStatus({}, config);
            return {
              ok: res.ok,
              op: "cache",
              message: res.status,
              ...(res.error ? { error: res.error } : {}),
            };
          }
        }
      } catch (e) {
        return { ok: false, op: a.op, error: errString(e) };
      }
    },
  );

  // ── security:trust — list|revoke|auditLog|verify (§8) ─────────────────────
  ipcMain.handle(IPC.securityTrust, async (_evt, arg: unknown): Promise<SecurityTrustResult> => {
    const v = validateTrust(arg);
    if (!v.ok) {
      const op =
        arg && typeof arg === "object" && typeof (arg as { op?: unknown }).op === "string"
          ? ((arg as { op: string }).op as TrustArgs["op"])
          : ("list" as TrustArgs["op"]);
      return { ok: false, op, error: v.error.message };
    }
    const a: TrustArgs = v.value;
    try {
      switch (a.op) {
        case "list": {
          // listTrusted reads ~/.config/prometheus/trust.json (node:fs, fail-soft).
          return { ok: true, op: "list", trusted: listTrusted() };
        }
        case "revoke": {
          const res = await revoke(a.name, {}, config);
          return { ok: res.ok, op: "revoke", ...(res.error ? { error: res.error } : {}) };
        }
        case "auditLog": {
          const rows = bridgeAuditLog({
            ...(a.forcedDanger !== undefined ? { forcedDanger: a.forcedDanger } : {}),
            ...(a.blocks !== undefined ? { blocks: a.blocks } : {}),
            ...(a.last24h !== undefined ? { last24h: a.last24h } : {}),
          });
          // Project away `verdict_full` unless the caller asked for it. It is the signed
          // canonical verdict object and it dwarfs everything else in the row — the live
          // log here is 38 MB across 1257 rows, and the one renderer that reads this op
          // uses twelve summaries and never touches the blob. Filtering already happened
          // above (AuditLogFilter.rule searches verdict_full inside engine-bridge), so
          // this drops bytes, never matches.
          const auditLog = a.includeVerdictFull
            ? rows
            : rows.map(({ verdict_full: _omitted, ...rest }) => rest);
          return { ok: true, op: "auditLog", auditLog, configuredGateMode: configuredGateMode() };
        }
        default: {
          const res = await verify(a.file, {}, config);
          return { ok: res.valid, op: "verify", valid: res.valid, message: res.message };
        }
      }
    } catch (e) {
      return { ok: false, op: a.op, error: errString(e) };
    }
  });

  // ── security:urlAudit — URL-injection L5 source re-scan / vault / restore ──
  ipcMain.handle(
    IPC.securityUrlAudit,
    async (_evt, arg: unknown): Promise<SecurityUrlAuditResult> => {
      if (!arg || typeof arg !== "object") {
        return { ok: false, op: "audit", error: "invalid request" };
      }
      const req = arg as SecurityUrlAuditRequest;
      const op = req.op;
      if (op !== "audit" && op !== "list" && op !== "restore") {
        return { ok: false, op: "audit", error: "invalid op (expected audit|list|restore)" };
      }
      try {
        if (op === "list") {
          const r = await urlQuarantineList({}, config);
          return { ok: r.ok, op, quarantine: r.quarantine ?? [] };
        }
        if (op === "restore") {
          if (typeof req.vault !== "string" || !req.vault) {
            return { ok: false, op, error: "restore requires a vault dir" };
          }
          const r = await urlQuarantineRestore(req.vault, {}, config);
          return { ok: r.ok, op, ...(r.error ? { error: r.error } : {}) };
        }
        // op === "audit" — a UI refresh is read-only unless quarantine explicitly set
        const r = await urlSourceAudit({ ...(req.quarantine ? { quarantine: true } : {}) }, config);
        // `summary` and `skills` are what the engine actually emits; `result` is derived from
        // them by `urlSourceAudit`. Forwarding all three means the panel renders and a future
        // consumer can read the raw rows instead of the grouping.
        return {
          ok: r.ok,
          op,
          result: r.result,
          ...(r.summary ? { summary: r.summary } : {}),
          ...(r.skills ? { skills: r.skills } : {}),
          ...(r.error ? { error: r.error } : {}),
        };
      } catch (e) {
        return { ok: false, op, error: errString(e) };
      }
    },
  );

  // ── disposer ─────────────────────────────────────────────────────────────
  return () => {
    for (const channel of [
      IPC.securityUrlAudit,
      IPC.securityGate,
      IPC.securityGateFull,
      IPC.securityAudit,
      IPC.securityInstall,
      IPC.securityRemediate,
      IPC.securityThreatdb,
      IPC.securityTrust,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
