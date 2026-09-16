/**
 * routes/security.tsx — the Security workbench route (file 08 §4.1 🛡 / §5.2).
 *
 * The ambient-security home: run a fail-closed nemesis gate (C4/C5) over an
 * arbitrary path / git URL / owner-repo, see the verdict painted by a
 * <VerdictBadge>, and review the detected agents + inference providers (Tier-A
 * first, C11). Extracted from the old App tab so the §4 shell can MOUNT it as one
 * workbench route among many — the gate logic is unchanged (the renderer renders
 * a verdict, it never decides "safe").
 *
 * The latest gate tier is pushed into the security store so the shell StatusBar
 * shield tints from it (08 §4.2). Reads go through TanStack Query (scan) +
 * window.prometheus.* one-shots (providers); a thrown bridge error still renders
 * as a BLOCK (defence in depth, C5).
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + Query + the stores + the
 * contextBridge only. No node/electron/engine-bridge.
 */

import {
  AuditLogView,
  Button,
  CostLight,
  DisinfectWizard,
  EmptyState,
  Panel,
  Progress,
  PurgeDialog,
  QuarantineVault,
  type SecAuditLogEntry,
  type SecFinding,
  type SecQuarantineItem,
  type SecThreatDbStatus,
  type SecTrustedSource,
  type SecVerdict,
  type SecVerifyResult,
  StreamLog,
  ThreatDbPanel,
  TrustedSourcesView,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  VerdictBadge,
  VerdictCard,
  type VerdictCardFinding,
  type VerdictTier,
} from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { useScan } from "../renderer/query/hooks.js";
import { DecisionOverlay } from "../renderer/shell/DecisionOverlay.js";
import { ForceGate, useForceGate } from "../renderer/shell/ForceGate.js";
import { useSecurityStore } from "../renderer/stores/features.js";
import type {
  GateResult,
  ProviderRow,
  SecurityGateResult,
  SecurityUrlAuditResult,
} from "../shared/ipc-contract.js";
import {
  classifyRemediationLine,
  gateBanner,
  gateCounts,
  historyRows,
  remediationProgress,
} from "./security-console-view.js";
import {
  EMPTY_REMEDIATION_FEED,
  type RemediationFeedState,
  flushRemediationFeed,
  forwardPurge,
  mintRemediationRunId,
  reduceRemediationFeed,
} from "./security-remediation-view.js";

/** One record parsed out of the human-text quarantine manifest (§9.2). */
interface ParsedQuarantineRecord {
  id: string;
  path: string;
  rule_id: string;
  quarantined_at: string;
  /** "quarantined" (restorable) or "erased" (audit-only — no vault copy). */
  kind: string;
}

/** ANSI SGR escapes the engine colours its stdout with — stripped before parse. */
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * When this renderer started, i.e. the earliest an audit row could describe the engine THIS app
 * will spawn.
 *
 * Module scope on purpose: it must not move when the console re-renders or re-mounts, or a row
 * written moments ago would start failing the recency test. See `gateBanner`.
 */
const APP_START_MS = Date.now();

/**
 * Parse `nemesis restore --quarantine-dir <dir> --list` output into records.
 *
 * The engine prints HUMAN text (not JSON), two lines per record (nemesis
 * `list_quarantine`):
 *   `  <id>  [<kind>]  <original_path>`
 *   `      <when>  rules: <r1>,<r2>`
 * `id`/`when` are space-free tokens; `path` may contain spaces; `rules` is a
 * trailing CSV. We strip ANSI, then pair each item line with its detail line.
 * Anything we fail to pair is dropped here — the RAW listing is shown verbatim
 * beside the table so a grammar drift can never silently hide a vault item.
 */
function parseQuarantineListing(listing: string): ParsedQuarantineRecord[] {
  const out: ParsedQuarantineRecord[] = [];
  const head = /^\s+(\S+)\s+\[([^\]]+)\]\s+(.+?)\s*$/; // id [kind] path
  const detail = /^\s+(\S+)\s+rules:\s*(.*)$/; // when  rules: csv
  let pending: { id: string; kind: string; path: string } | null = null;
  for (const raw of listing.replace(ANSI, "").split(/\r?\n/)) {
    const h = head.exec(raw);
    if (h) {
      // a new item line — flush any prior item that never got its detail line.
      if (pending) out.push({ ...pending, rule_id: "", quarantined_at: "" });
      pending = { id: h[1] ?? "", kind: h[2] ?? "", path: h[3] ?? "" };
      continue;
    }
    const d = pending ? detail.exec(raw) : null;
    if (d && pending) {
      out.push({
        id: pending.id,
        kind: pending.kind,
        path: pending.path,
        quarantined_at: d[1] ?? "",
        rule_id: (d[2] ?? "").trim(),
      });
      pending = null;
    }
  }
  if (pending) out.push({ ...pending, rule_id: "", quarantined_at: "" });
  return out;
}

/**
 * A GateResult's findings in the §4 card's shape. `detail` is optional on the envelope
 * and its `findings` array is guarded before mapping — an envelope shape change must
 * degrade to "no rows", never a render crash.
 */
/** The blocking reasons the typed-confirm dialog lists back to the user before an override. */
function blockingReasonsOf(v: GateResult): string[] {
  const raw = v.detail?.findings;
  if (!Array.isArray(raw)) return v.error ? [v.error] : [];
  return raw
    .filter((f) => f.severity === "critical" || f.severity === "high")
    .map((f) => `${f.rule}: ${f.klass}${f.where ? ` (${f.where})` : ""}`);
}

function verdictCardFindings(v: GateResult): VerdictCardFinding[] {
  const raw = v.detail?.findings;
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => ({
    rule: f.rule,
    description: f.klass,
    where: f.where,
    severity: f.severity,
  }));
}

export function SecurityRoute(): ReactElement {
  const scan = useScan();
  const agents = scan.data?.agents ?? [];
  const scanning = scan.isPending;
  const scanError =
    scan.error instanceof Error
      ? scan.error.message
      : scan.data && !scan.data.ok
        ? (scan.data.error ?? "scan failed")
        : null;

  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [target, setTarget] = useState("");
  const [gate, setGate] = useState<GateResult | null>(null);
  /** §4: the verdict-history row whose card is open, and whether the signed log is shown. */
  const [historyPick, setHistoryPick] = useState<string | null>(null);
  const [signedLogOpen, setSignedLogOpen] = useState(false);
  /** §9: the typed `install-dangerous` confirm that gates the deep-red override here. */
  const force = useForceGate();
  /** the outcome line for a forced install (the feed carries the engine's own output). */
  const [installNote, setInstallNote] = useState<string | null>(null);
  // §4's Quarantine action routes through the EXISTING force/override store seam — the
  // console must not invent a second path to a security decision.
  const [gating, setGating] = useState(false);
  const setVerdict = useSecurityStore((s) => s.setVerdict);

  // URL-injection L5: installed-source audit (re-pin / drift / quarantine vault).
  const [urlAudit, setUrlAudit] = useState<SecurityUrlAuditResult | null>(null);
  const [urlAuditing, setUrlAuditing] = useState(false);
  const runUrlAudit = useCallback(
    async (quarantine: boolean) => {
      if (urlAuditing) return;
      setUrlAuditing(true);
      try {
        const r = await window.prometheus.security.urlAudit({ op: "audit", quarantine });
        setUrlAudit(r);
      } catch (e) {
        setUrlAudit({ ok: false, op: "audit", error: e instanceof Error ? e.message : String(e) });
      } finally {
        setUrlAuditing(false);
      }
    },
    [urlAuditing],
  );
  const restoreQuarantined = useCallback(
    async (vault: string) => {
      // the typed confirm has already been satisfied by the time we get here
      setUrlRestoreTarget(null);
      try {
        await window.prometheus.security.urlAudit({ op: "restore", vault });
        await runUrlAudit(false);
      } catch {
        /* restore failure surfaces on the next audit */
      }
    },
    [runUrlAudit],
  );

  // Scan-anything: point nemesis at any file / folder (or whole drive) for threats.
  const [threat, setThreat] = useState<SecurityGateResult | null>(null);
  const [threatTarget, setThreatTarget] = useState<string>("");
  const [scanningThreat, setScanningThreat] = useState(false);
  // Disinfect state lives here (above scanThreat) so a new scan can clear the
  // prior residual — a stale "clean" must never paint over a newer scan (#3).
  const [disinfecting, setDisinfecting] = useState(false);
  const [disinfectResult, setDisinfectResult] = useState<SecVerdict | undefined>(undefined);
  /**
   * §4's `2 / 3`: the engine's resolved/unresolved split.
   *
   * Kept separately because the route stores only `data.verdict` from the remediate
   * envelope, and the counts live one level up on `DisinfectResult` — they were being
   * thrown away, which is why the island had nothing to count.
   */
  const [disinfectCounts, setDisinfectCounts] = useState<{
    resolved?: unknown;
    unresolved?: unknown;
  } | null>(null);
  const [disinfectError, setDisinfectError] = useState<string | null>(null);
  const loadTrustDb = useCallback(async () => {
    try {
      const s = await window.prometheus.security.threatdb({ op: "status" });
      // §6: SHAPE-guard the cast, not just its truthiness. ThreatDbPanel dereferences
      // `status.db.seeded`; an engine payload without `db` would throw a TypeError and
      // drop the whole Security route into the error boundary. Normalise instead.
      if (s.ok && s.status && typeof s.status === "object") {
        const raw = s.status as unknown as Record<string, unknown>;
        const db = (raw.db ?? {}) as Record<string, unknown>;
        setThreatDb({
          ...raw,
          db: { seeded: Boolean(db.seeded), stale: Boolean(db.stale), ...db },
          feeds: Array.isArray(raw.feeds) ? raw.feeds : [],
        } as unknown as SecThreatDbStatus);
      }
    } catch {
      /* non-fatal */
    }
    try {
      const t = await window.prometheus.security.trust({ op: "list" });
      if (t.ok && Array.isArray(t.trusted)) setTrusted(t.trusted as unknown as SecTrustedSource[]);
    } catch {
      /* non-fatal */
    }
    try {
      const a = await window.prometheus.security.trust({ op: "auditLog" });
      if (a.ok && Array.isArray(a.auditLog))
        setAuditLog(a.auditLog as unknown as SecAuditLogEntry[]);
      // The LIVE mode, read from main's `$PROMETHEUS_GATE` — what the next engine spawn will
      // actually inherit. It outranks anything inferred from the history; see `gateBanner`.
      if (a.ok && typeof a.configuredGateMode === "string") setGateMode(a.configuredGateMode);
    } catch {
      /* non-fatal */
    }
  }, []);

  const scanThreat = useCallback(
    async (path: string) => {
      const t = path.trim();
      if (!t || scanningThreat) return;
      setThreatTarget(t);
      setScanningThreat(true);
      setThreat(null);
      // a new scan invalidates any prior disinfect residual (fail-closed: never
      // show the last target's "clean" re-scan next to this target's findings).
      setDisinfectResult(undefined);
      setDisinfectCounts(null);
      setDisinfectError(null);
      try {
        const r = await window.prometheus.security.gateFull(t);
        setThreat(r);
      } catch (e) {
        setThreat({
          ok: false,
          verdict: {
            verdict: "error",
            risk_score: 100,
            signed: false,
            severity_counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
            class_counts: {},
            findings_by_class: {},
            safe_to: {},
            target: t,
            scannedAt: new Date().toISOString(),
          } as unknown as SecurityGateResult["verdict"],
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setScanningThreat(false);
        void loadTrustDb(); // keep the banner's pills in step with this console's own scans
      }
    },
    [scanningThreat, loadTrustDb],
  );
  const pickAndScan = useCallback(
    async (kind: "file" | "folder") => {
      try {
        const r =
          kind === "file"
            ? await window.prometheus.fileOpen({ title: "Select a file to scan for threats" })
            : await window.prometheus.folderOpen({ title: "Select a folder to scan for threats" });
        if (r.ok && r.path) await scanThreat(r.path);
      } catch {
        /* dialog/IPC failure — nothing to scan; never let it become an unhandled rejection */
      }
    },
    [scanThreat],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const p = await window.prometheus.providers();
        // guard: an ok envelope may omit `providers` → setProviders(undefined) would make
        // the `providers.filter` at render time crash the panel. Coalesce to [].
        if (alive && p.ok) setProviders(Array.isArray(p.providers) ? p.providers : []);
      } catch {
        /* providers panel is non-fatal */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Threat-DB freshness + trusted-sources + gate-audit log — the security.threatdb /
  // security.trust IPC verbs were built but had NO UI; mount the prebuilt @prometheus/ui
  // views and feed them the engine data.
  const [threatDb, setThreatDb] = useState<SecThreatDbStatus | null>(null);
  const [dbBusy, setDbBusy] = useState(false);
  const [trusted, setTrusted] = useState<SecTrustedSource[]>([]);
  const [auditLog, setAuditLog] = useState<SecAuditLogEntry[]>([]);
  /** the gate mode main reports for the next engine spawn — undefined until the load answers. */
  const [gateMode, setGateMode] = useState<string | undefined>(undefined);
  useEffect(() => {
    void loadTrustDb();
  }, [loadTrustDb]);
  // Open a remediation run: mint the correlation id, clear the pane, arm the filter.
  const beginRemediationRun = useCallback((): string => {
    const runId = mintRemediationRunId();
    activeRemediationRunRef.current = runId;
    setRemediationFeed(EMPTY_REMEDIATION_FEED);
    return runId;
  }, []);
  // Close a run: flush the trailing partial line (the summary rarely ends in "\n"),
  // then disarm so any late/foreign line is ignored (op-end unsubscribe semantics).
  const endRemediationRun = useCallback((): void => {
    setRemediationFeed((s) => flushRemediationFeed(s));
    activeRemediationRunRef.current = null;
  }, []);

  /**
   * Run the deep-red override: `security.install` with the force PAIR (§9a).
   *
   * Only reachable from the verdict card's "Install anyway…", which itself only renders
   * for a blocking verdict, and only after `ForceGate` matched the typed token byte-exactly.
   * `confirmForce` is what makes main honour `forced` at all — it drops a bare one.
   *
   * The engine's stderr streams onto the SAME remediation feed the disinfect/threat-db runs
   * use, so an override is as visible as any other destructive op on this console.
   */
  const forceInstall = useCallback(
    async (target: string): Promise<void> => {
      const runId = beginRemediationRun();
      try {
        const r = await window.prometheus.security.install(target, {
          dryRun: false,
          forced: true,
          confirmForce: true,
          runId,
        });
        setInstallNote(
          r.ok ? `forced install completed: ${target}` : r.error || "forced install refused.",
        );
      } catch (e) {
        setInstallNote(e instanceof Error ? e.message : String(e));
      } finally {
        endRemediationRun();
        // a forced install APPENDS an audit row — the one console action that certainly
        // changes the counts the banner is showing.
        void loadTrustDb();
      }
    },
    [beginRemediationRun, endRemediationRun, loadTrustDb],
  );

  const updateThreatDb = useCallback(async () => {
    if (dbBusy) return;
    setDbBusy(true);
    // §9: a threat-DB update is a LONG streaming op — arm a correlation run so its
    // progress lines survive the `onProgress` filter. Without a runId main omits
    // `event.runId` and reduceRemediationFeed discards every line, which is why this
    // op looked silent even though the feed was already subscribed.
    const runId = beginRemediationRun();
    try {
      await window.prometheus.security.threatdb({ op: "update", runId });
      await loadTrustDb();
    } catch {
      /* surfaced via the panel's own status next load */
    } finally {
      endRemediationRun();
      setDbBusy(false);
    }
  }, [dbBusy, loadTrustDb, beginRemediationRun, endRemediationRun]);
  const revokeTrust = useCallback(
    async (key: string) => {
      try {
        await window.prometheus.security.trust({ op: "revoke", name: key });
        await loadTrustDb();
      } catch {
        /* non-fatal */
      }
    },
    [loadTrustDb],
  );

  // Verify a gate-audit row's HMAC (§8) — was a DEAD button (route never passed onVerify).
  const [verifyResults, setVerifyResults] = useState<Record<string, SecVerifyResult>>({});
  const verifyAuditRow = useCallback(async (row: SecAuditLogEntry) => {
    // Must match AuditLogView's row key exactly: `at` is second-granular, so a batch
    // install's rows collide and a verdict would render against the wrong target.
    const rowId = `${row.at}|${row.label}|${row.target}`;
    try {
      const r = await window.prometheus.security.trust({ op: "verify", file: row.target });
      setVerifyResults((m) => ({ ...m, [rowId]: { valid: !!r.valid, reason: r.message } }));
    } catch (e) {
      setVerifyResults((m) => ({
        ...m,
        [rowId]: { valid: false, reason: e instanceof Error ? e.message : String(e) },
      }));
    }
  }, []);

  // ── Remediation & quarantine (§9): disinfect → cleaned copy; vault list /
  // restore (reversible) / purge (irreversible). All work is the ENGINE's; the
  // route only renders what `security.remediate` returns (C5).
  const [quarantineTarget, setQuarantineTarget] = useState("");
  const [quarantineDir, setQuarantineDir] = useState("");
  /** the PARSED records behind `quarantineItems` — they keep `kind`, which the row shape drops. */
  const [quarantineRecords, setQuarantineRecords] = useState<ParsedQuarantineRecord[]>([]);
  const [quarantineItems, setQuarantineItems] = useState<SecQuarantineItem[]>([]);
  const [quarantineRaw, setQuarantineRaw] = useState("");
  const [qBusy, setQBusy] = useState(false);
  const [qNote, setQNote] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<SecQuarantineItem | null>(null);
  /** the vault item awaiting a typed RESTORE confirm (§4). */
  const [restoreTarget, setRestoreTarget] = useState<SecQuarantineItem | null>(null);
  /** the URL-AUDIT vault entry awaiting its own typed RESTORE confirm (§4). */
  const [urlRestoreTarget, setUrlRestoreTarget] = useState<{
    vault: string;
    label: string;
  } | null>(null);

  // Live remediation progress (§9 / deliverables 2-3). The `securityProgress` feed
  // is PER-WINDOW and SHARED by every security op; we mint a runId per remediation
  // op and fold ONLY that run's lines into the pane (strict runId match) so a
  // concurrent gate/threatdb stream never interleaves. ONE persistent subscription
  // — its disposer detaches on unmount, so React 18 StrictMode's mount→unmount→
  // remount never stacks a second listener (the leak-safe removeListener is in
  // preload/api.ts). The renderer only renders log text; it decides nothing (C5).
  const [remediationFeed, setRemediationFeed] =
    useState<RemediationFeedState>(EMPTY_REMEDIATION_FEED);
  const activeRemediationRunRef = useRef<string | null>(null);
  /** the quarantine-vault form, so the verdict card's Quarantine button can reveal it. */
  const vaultRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const off = window.prometheus.security.onProgress((e) =>
      setRemediationFeed((s) => reduceRemediationFeed(s, e, activeRemediationRunRef.current)),
    );
    return off;
  }, []);

  // List a scanned target's in-tree vault (<target>/__nemesis_quarantine__). The
  // engine prints human text — we parse it AND keep the raw as the authority.
  const loadQuarantine = useCallback(async (tgt: string) => {
    const t = tgt.trim();
    if (!t) {
      setQNote("enter the path that was scanned to inspect its quarantine vault.");
      return;
    }
    setQBusy(true);
    setQNote(null);
    try {
      const r = await window.prometheus.security.remediate({ op: "quarantineList", target: t });
      const data = (r.data ?? {}) as { listing?: string; quarantineDir?: string; error?: string };
      setQuarantineDir(data.quarantineDir ?? "");
      setQuarantineRaw(data.listing ?? "");
      const recs = parseQuarantineListing(data.listing ?? "");
      // Kept alongside the UI rows because `SecQuarantineItem` has no `kind` field and the row
      // mapping below folds it into `rule_id` — where it is unrecoverable for any record that
      // has rules. Inspect needs it: an `erased` record has no vault copy at all.
      setQuarantineRecords(recs);
      setQuarantineItems(
        recs.map((x) => ({
          id: x.id,
          path: x.path,
          rule_id: x.rule_id || x.kind,
          quarantined_at: x.quarantined_at,
        })),
      );
      if (!r.ok && data.error) setQNote(data.error);
      else if (recs.length === 0) setQNote("vault is empty — nothing quarantined here.");
    } catch (e) {
      setQuarantineItems([]);
      setQuarantineRecords([]);
      setQNote(e instanceof Error ? e.message : String(e));
    } finally {
      setQBusy(false);
    }
  }, []);

  // The vault target to reload after an action: the box value, else the last
  // scanned path — mirrors the "Load vault" form's `quarantineTarget || threatTarget`
  // fallback so a fallback-loaded vault still refreshes (#5).
  const vaultTarget = quarantineTarget || threatTarget;

  // Restore one vault item via the engine (reversible). Returns the outcome but
  // does NOT reload — callers reload ONCE so a batch restore never N-fetches (#7).
  const restoreOne = useCallback(
    async (id: string, typedName: string, path: string): Promise<{ ok: boolean; msg: string }> => {
      try {
        // `typedName` + `path` are what main re-checks — the renderer's dialog is the
        // VISIBLE half of the confirm, security-ipc.ts's comparison is the enforcing half,
        // exactly as purge has always worked.
        const r = await window.prometheus.security.remediate({
          op: "restore",
          id,
          quarantineDir,
          typedName,
          path,
        });
        const data = (r.data ?? {}) as { message?: string; error?: string };
        return {
          ok: r.ok,
          msg: r.ok ? data.message || `restored ${id}` : r.error || data.error || "restore failed",
        };
      } catch (e) {
        return { ok: false, msg: e instanceof Error ? e.message : String(e) };
      }
    },
    [quarantineDir],
  );

  const restoreFromVault = useCallback(
    async (item: SecQuarantineItem, typedName: string) => {
      // Check the precondition BEFORE clearing the dialog: the old order dismissed the
      // confirm first, so a user typed the whole basename and was only then told that no
      // vault was loaded.
      if (!quarantineDir) {
        setQNote("load a vault first.");
        return;
      }
      setRestoreTarget(null);
      const { msg } = await restoreOne(item.id, typedName, item.path);
      setQNote(msg);
      await loadQuarantine(vaultTarget);
    },
    [quarantineDir, restoreOne, vaultTarget, loadQuarantine],
  );

  // Purge one vault item. `typed` is the EXACT confirmation string the human
  // entered in PurgeDialog (the file's basename). We forward it as `typedName` so
  // the main process verifies the HUMAN'S input against purgeBasename(target),
  // instead of a renderer-supplied echo (#1). The engine offers no scriptable
  // erase for vault items (interactive-only) ⇒ engineRemoved:false; we say so.
  const purgeFromVault = useCallback(
    async (item: SecQuarantineItem, typed: string) => {
      setPurgeTarget(null);
      // Mint + arm a fresh runId so any per-item stream keys to THIS purge — the
      // multi-select flow confirms one item at a time (security.tsx below), so the
      // pane can never paint item N's lines into item N+1's run (§9.3 invariant).
      const runId = beginRemediationRun();
      try {
        // Fail-closed at the route too: forwardPurge builds+sends the request ONLY
        // when `typed` byte-exactly matches the basename (the same core predicate
        // the dialog gates on + main re-checks). A mismatch NEVER calls remediate
        // (§9.3 zero-call contract) — belt-and-suspenders against a buggy caller.
        const outcome = await forwardPurge(
          (req) => window.prometheus.security.remediate(req),
          item,
          typed,
          runId,
        );
        if (!outcome.called) {
          setQNote(outcome.refused);
        } else {
          const r = outcome.result;
          const data = (r.data ?? {}) as { engineRemoved?: boolean; error?: string };
          if (!r.ok) setQNote(r.error || data.error || "purge refused.");
          else if (data.engineRemoved) setQNote(`purged ${item.path}`);
          else
            setQNote(
              "Purge confirmed — but nemesis offers no scriptable erase for vault items in this " +
                "build (erase is interactive-only). The item REMAINS in the vault; restore still " +
                "works. To erase it permanently, run the nemesis CLI interactive scan and pick [e]rase.",
            );
        }
      } catch (e) {
        setQNote(e instanceof Error ? e.message : String(e));
      } finally {
        endRemediationRun();
      }
      await loadQuarantine(vaultTarget);
    },
    [vaultTarget, loadQuarantine, beginRemediationRun, endRemediationRun],
  );

  // Disinfect the "Scan anything" findings: writes a CLEANED COPY to a folder the
  // user picks (original untouched), then shows the honest re-scan residual.
  // Targets the SCANNED target (threat.verdict.target), NOT the editable input box
  // — else an edited path would be disinfected while the on-screen plan is A's (#4).
  const runDisinfect = useCallback(async () => {
    const t = (threat?.verdict?.target || threatTarget).trim();
    if (!t || disinfecting) return;
    let out = "";
    try {
      const picked = await window.prometheus.folderOpen({
        title: "Choose an output folder for the cleaned copy",
      });
      if (!picked.ok || !picked.path) return; // user cancelled the picker
      out = picked.path;
    } catch {
      return;
    }
    // Arm the progress pane for THIS run: the streamed disinfect stderr arrives on
    // the shared securityProgress feed tagged with this runId (deliverable 2).
    const runId = beginRemediationRun();
    setDisinfecting(true);
    setDisinfectResult(undefined);
    setDisinfectCounts(null);
    setDisinfectError(null);
    try {
      const r = await window.prometheus.security.remediate({
        op: "disinfect",
        target: t,
        out,
        runId,
      });
      const data = (r.data ?? {}) as {
        verdict?: SecVerdict;
        error?: string;
        resolved?: unknown;
        unresolved?: unknown;
      };
      setDisinfectCounts({ resolved: data.resolved, unresolved: data.unresolved });
      if (data.verdict) setDisinfectResult(data.verdict);
      // fail-closed: no residual ⇒ never paint "clean". Surface WHY instead of a
      // perpetual "Waiting…" so a failed disinfect is distinguishable from a hang (#6).
      else setDisinfectError(r.error || data.error || "disinfect failed — no residual verdict.");
    } catch (e) {
      setDisinfectError(e instanceof Error ? e.message : String(e));
    } finally {
      setDisinfecting(false);
      endRemediationRun();
    }
    // Refresh the vault after disinfect too (deliverable 5): disinfect sidelines the
    // quarantine-only findings into <target>/__nemesis_quarantine__, so a loaded
    // vault must re-read to show them. Guard on a target so we never trip
    // loadQuarantine's empty-path note.
    if (vaultTarget) await loadQuarantine(vaultTarget);
  }, [
    threat,
    threatTarget,
    disinfecting,
    beginRemediationRun,
    endRemediationRun,
    vaultTarget,
    loadQuarantine,
  ]);

  const runGate = useCallback(async () => {
    const t = target.trim();
    if (!t || gating) return;
    setGating(true);
    setGate(null);
    try {
      const res = await window.prometheus.gate(t);
      setGate(res);
      setVerdict(res);
    } catch (e) {
      const blocked: GateResult = {
        ok: false,
        verdict: "error",
        severity: "clean",
        riskScore: 100,
        signed: false,
        findingsCount: 0,
        target: t,
        scannedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      };
      setGate(blocked);
      setVerdict(blocked);
    } finally {
      setGating(false);
      // §4: the banner's pills and the history are a fold over the gate-audit log, and the
      // log only had three readers — mount, threat-DB update, and revoke. So the console's
      // OWN actions left the pills frozen on the mount-time snapshot: you could run a scan
      // here and watch the counts not move.
      void loadTrustDb();
    }
  }, [target, gating, setVerdict, loadTrustDb]);

  const tierACount = providers.filter((p) => p.tier === "A").length;
  // §4: the banner's pills and the verdict-history rows are both folds over the gate-audit
  // log, computed in a PURE module so "an unknown verdict is not an allow" is a test, not a
  // reading of this file.
  const counts = gateCounts(auditLog);
  // §4's banner is DERIVED, never asserted: `gate_mode` rides on every audit row and had no
  // reader, so `PROMETHEUS_GATE=off` still rendered "armed, fail-closed" in green.
  // Bounded to THIS session: an audit row older than the app cannot vouch for the mode the
  // running engine will use — see `gateBanner`.
  // `configured` is a live reading and wins outright; the session-bounded history is the
  // fallback for a build/preload that does not report one — see `gateBanner`.
  const banner = gateBanner(auditLog, {
    sinceMs: APP_START_MS,
    ...(gateMode !== undefined ? { configured: gateMode } : {}),
  });
  // §4's `2 / 3`. `disinfectResult` is the post-fix verdict; its resolved/unresolved split is
  // the only real step count anywhere in the flow, and it does not exist until the run ends.
  const remediationSteps = remediationProgress(disinfectCounts);
  const history = historyRows(auditLog, { limit: 12 });
  // resolve the picked row back to its FULL audit entry — the history row is a projection
  // (chip / artifact / age) and carries none of the findings the card needs.
  // Matched on the `at:target:` PREFIX, not the whole key: the key's trailing index is the
  // row's position in the SORTED history, which is not its position in `auditLog`. Comparing
  // whole keys would resolve to the wrong entry whenever the engine's order is not already
  // newest-first — i.e. exactly when `historyRows` had work to do.
  const historyPicked =
    historyPick === null
      ? null
      : (auditLog.find((r) => historyPick.startsWith(`${r.at}:${r.target}:`)) ?? null);
  const threatFindings = threat
    ? Object.values(threat.verdict?.findings_by_class ?? {})
        .flat()
        .filter((f): f is NonNullable<typeof f> => f != null)
    : [];

  return (
    <div
      style={{
        display: "grid",
        // responsive: two columns when wide, STACK to one on a narrow window.
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
        gap: "var(--space-8, 16px)",
        alignContent: "start",
      }}
    >
      {/* ── §4 gate banner ────────────────────────────────────────────────────
          Full-width, first, and stating the gate's CONFIGURATION rather than any one
          result: armed, fail-closed, and what it has decided so far. The counts are of
          DECISIONS, not of artifacts — see security-console-view.ts. */}
      <section
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          flexWrap: "wrap", // §7
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          padding: "10px 14px",
          borderRadius: "var(--radius-lg, 8px)",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 30,
            height: 30,
            flex: "none",
            borderRadius: "var(--radius-md, 6px)",
            background: `color-mix(in srgb, var(--${banner.role}) 12%, transparent)`,
            border: `1px solid color-mix(in srgb, var(--${banner.role}) 30%, transparent)`,
            color: `var(--${banner.role})`,
            fontSize: 14,
          }}
        >
          🛡
        </span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div
            style={{
              color: banner.mode === "enforce" ? "var(--text-title)" : `var(--${banner.role})`,
              fontSize: "0.85rem",
              fontWeight: 700,
            }}
          >
            {banner.title}
          </div>
          <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", lineHeight: 1.45 }}>
            {banner.note}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {(
            [
              ["allow", counts.allow, "var(--ok)"],
              ["warn", counts.warn, "var(--warn)"],
              ["block", counts.block, "var(--danger)"],
              // shown ONLY when it happened: a permanent "0 error" pill trains the eye to
              // skip the row, and this is the pill that most needs to be noticed.
              ...(counts.error > 0 ? ([["error", counts.error, "var(--danger-fg)"]] as const) : []),
            ] as const
          ).map(([label, n, color]) => (
            <span
              key={label}
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: 4,
                flex: "none",
                padding: "2px 8px",
                borderRadius: "var(--radius-sm, 4px)",
                background: `color-mix(in srgb, ${color} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
                color,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 700,
                whiteSpace: "nowrap", // §7
              }}
            >
              {n}
              <span style={{ fontWeight: 500, opacity: 0.85 }}>{label}</span>
            </span>
          ))}
        </div>
      </section>

      <Panel title="Nemesis scan" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          FREE threat scan (backdoors / malware / supply-chain / code threats) of any path, git URL,
          or owner/repo — the same fail-closed nemesis verdict the install gate uses, and the same
          scan as the CLI <code>/nemesis</code>. A missing or timed-out scanner blocks (C5).
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runGate();
          }}
          style={{ display: "flex", gap: "var(--space-3, 6px)", alignItems: "center" }}
        >
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="owner/repo · https://… · /path/to/dir"
            aria-label="Target to gate"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: "var(--radius-md, 6px)",
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.85rem",
            }}
          />
          <Button type="submit" variant="primary" disabled={gating || !target.trim()}>
            {gating ? "Scanning…" : "Scan"}
          </Button>
        </form>

        {gate && (
          // handoff §4: the security console renders the SAME verdict card as Home, the
          // catalog install flow and the chat — this is the console, so it also carries
          // the Quarantine action.
          <div style={{ marginTop: "var(--space-4, 8px)" }}>
            <VerdictCard
              verdict={gate.verdict}
              artifact={gate.target}
              sourceKind={gate.signed ? "signed" : "unsigned"}
              riskScore={gate.riskScore}
              findings={verdictCardFindings(gate)}
              // The engine has no "quarantine this artifact" op — `security.remediate`
              // exposes disinfect/quarantineList/restore/purge/acceptFinding, and an
              // artifact is moved to the vault by the gate itself, not by a button here.
              // This used to call `requestForce(gate.target)`, which armed the deep-red
              // BLOCK-override state and rendered NOTHING: a dead wire that also pointed
              // at the opposite of what its label promised. Point it at the surface that
              // actually exists — open the quarantine vault for this artifact, where
              // restore/purge live.
              onQuarantine={() => {
                setQuarantineTarget(gate.target);
                void loadQuarantine(gate.target);
                vaultRef.current?.scrollIntoView({ block: "nearest" });
              }}
              // §9: the deep-red override, gated by the typed confirm. `security.install`
              // existed in the preload and in main — with the `forced && confirmForce`
              // pairing already enforced there — and had ZERO renderer callers, so the
              // console could show a BLOCK and offer no gated way past it.
              //
              // Passed ONLY for a blocking verdict: VerdictCard renders the action whenever
              // the prop is present, and "Install anyway…" under a clean ALLOW would invite
              // a gesture that has no meaning.
              {...(gate.verdict === "block" || gate.verdict === "error"
                ? {
                    onInstallAnyway: (): void => {
                      force.ask({
                        target: gate.target,
                        blockingReasons: blockingReasonsOf(gate),
                        onConfirm: () => void forceInstall(gate.target),
                      });
                    },
                  }
                : {})}
            />
            {installNote && (
              <span
                role="status"
                style={{ color: "var(--text-secondary)", fontSize: "0.8rem", paddingInline: 14 }}
              >
                {installNote}
              </span>
            )}
            {gate.error && (
              <span
                role="alert"
                style={{ color: "var(--danger-fg)", fontSize: "0.8rem", paddingInline: 14 }}
              >
                {gate.error}
              </span>
            )}
          </div>
        )}
      </Panel>

      <Panel title={`Providers (${tierACount} Tier-A)`} elevation="e1">
        {providers.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: 0 }}>
            No providers loaded.
          </p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: "var(--space-3, 6px)",
            }}
          >
            {providers.map((p) => (
              <li
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-4, 8px)",
                  padding: "6px 8px",
                  borderRadius: "var(--radius-md, 6px)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <span
                  style={{
                    fontSize: "0.85rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.label}
                  {p.isEscapeHatch && (
                    <span style={{ color: "var(--text-secondary)" }}> · default</span>
                  )}
                </span>
                <CostLight tier={p.tier} showLabel={false} title={p.notes} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Detected agents" elevation="e1">
        {scanError ? (
          <p style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: 0 }}>
            Scan failed: {scanError}
          </p>
        ) : scanning ? (
          <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>Scanning…</p>
        ) : agents.length === 0 ? (
          // §6: never blank. A bare `.map` over an empty list painted nothing, which reads
          // as "the panel is broken" rather than "no agents are installed here".
          <EmptyState
            icon="◇"
            title="No agents detected"
            hint="Run a scan to look for coding agents installed on this machine."
          />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "4px" }}>
            {agents.map((a) => (
              <li
                key={a.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3, 6px)",
                  fontSize: "0.85rem",
                  opacity: a.present ? 1 : 0.5,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: "0.6em",
                    height: "0.6em",
                    borderRadius: "9999px",
                    background: a.present ? "var(--ok)" : "var(--text-secondary)",
                  }}
                />
                <span style={{ fontWeight: 600 }}>{a.label}</span>
                <span style={{ color: "var(--text-secondary)" }}>· {a.kind}</span>
                {a.where && (
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.where}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Installed-source audit (URL-injection)" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          Re-scan every installed external source (SKILL.md / AGENTS.md / MCP configs) and
          byte-compare against its pinned baseline. Content that drifted into a dangerous verdict is
          QUARANTINED (reversible) and the blessed copy restored — the rug-pull / MCPoison defence
          (TOCTOU lock, fail-closed).
        </p>
        <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
          <Button
            type="button"
            variant="secondary"
            disabled={urlAuditing}
            onClick={() => void runUrlAudit(false)}
          >
            {urlAuditing ? "Scanning…" : "Re-scan sources"}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={urlAuditing}
            onClick={() => void runUrlAudit(true)}
          >
            Quarantine drift
          </Button>
        </div>
        {urlAudit?.error && (
          <p style={{ color: "var(--danger)", fontSize: "0.8rem" }}>{urlAudit.error}</p>
        )}
        {urlAudit?.result && (
          <div style={{ marginTop: "var(--space-4, 8px)", fontSize: "0.82rem" }}>
            <div style={{ color: "var(--text-secondary)" }}>
              new {(urlAudit.result.new ?? []).length} · clean{" "}
              {(urlAudit.result.clean ?? []).length} · re-pinned{" "}
              {(urlAudit.result.repinned ?? []).length} · quarantined{" "}
              <strong
                style={{
                  color: (urlAudit.result.quarantined ?? []).length ? "var(--danger)" : "inherit",
                }}
              >
                {(urlAudit.result.quarantined ?? []).length}
              </strong>{" "}
              · missing {(urlAudit.result.missing ?? []).length}
            </div>
            {(urlAudit.result.quarantined ?? []).length > 0 && (
              <ul
                style={{
                  listStyle: "none",
                  margin: "8px 0 0",
                  padding: 0,
                  display: "grid",
                  gap: "6px",
                }}
              >
                {(urlAudit.result.quarantined ?? []).map((q) => (
                  <li
                    key={q.vault}
                    style={{
                      padding: "6px 8px",
                      borderRadius: "var(--radius-md, 6px)",
                      border: "1px solid var(--danger)",
                    }}
                  >
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                      ☠ {q.original} · [{q.verdict}]{q.first_seen ? " · first-seen" : ""}
                      {q.restored_blessed ? " · blessed restored" : ""}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      // §4: "Restore requires a typed confirm." This is the SECOND quarantine
                      // vault on this route — the URL-audit one — and it used to re-trust a
                      // blocked origin on a single click. Same gate as the nemesis vault.
                      onClick={() => setUrlRestoreTarget({ vault: q.vault, label: q.original })}
                    >
                      Restore (re-trust)
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p
          style={{
            marginTop: "var(--space-4, 8px)",
            color: "var(--text-secondary)",
            fontSize: "0.72rem",
          }}
        >
          Defence-in-depth, not a guarantee: a zero-day rug-pull from a previously-clean,
          properly-signed publisher between two fetches, or perfect residential-IP cloaking, can
          still pass. Value = layered cost + fail-closed + immediate reversible quarantine.
        </p>
      </Panel>

      <Panel title="Scan anything for threats" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          Point nemesis at any file, archive, folder — or a whole drive — and get a fail-closed
          verdict with every finding. The same engine the install gate uses.
        </p>
        <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
          <Button
            type="button"
            variant="secondary"
            disabled={scanningThreat}
            onClick={() => void pickAndScan("file")}
          >
            Scan a file…
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={scanningThreat}
            onClick={() => void pickAndScan("folder")}
          >
            Scan a folder…
          </Button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void scanThreat(threatTarget);
          }}
          style={{ display: "flex", gap: "var(--space-3, 6px)", marginTop: "var(--space-3, 6px)" }}
        >
          <input
            value={threatTarget}
            onChange={(e) => setThreatTarget(e.target.value)}
            placeholder="/path/to/scan · owner/repo · https://…"
            aria-label="Path to scan for threats"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: "var(--radius-md, 6px)",
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.85rem",
            }}
          />
          <Button type="submit" variant="primary" disabled={scanningThreat || !threatTarget.trim()}>
            {scanningThreat ? "Scanning…" : "Scan"}
          </Button>
        </form>
        {scanningThreat && (
          <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
            scanning {threatTarget} — large folders can take a while…
          </p>
        )}
        {threat && (
          <div style={{ marginTop: "var(--space-4, 8px)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-4, 8px)",
                flexWrap: "wrap",
              }}
            >
              <VerdictBadge
                verdict={threat.verdict?.verdict ?? "error"}
                risk_score={threat.verdict?.risk_score ?? 100}
              />
              <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                {(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const)
                  .filter((s) => threat.verdict?.severity_counts?.[s])
                  .map((s) => `${threat.verdict?.severity_counts?.[s]} ${s.toLowerCase()}`)
                  .join("  ") || "no findings"}
              </span>
              {threat.error && (
                <span style={{ color: "var(--danger)", fontSize: "0.8rem" }}>{threat.error}</span>
              )}
            </div>
            <ul
              style={{
                listStyle: "none",
                margin: "8px 0 0",
                padding: 0,
                display: "grid",
                gap: "4px",
              }}
            >
              {threatFindings.slice(0, 30).map((f, i) => (
                <li key={`${f.rule_id}-${f.path}-${i}`} style={{ fontSize: "0.8rem" }}>
                  <span style={{ fontWeight: 600 }}>{f.severity}</span>{" "}
                  <span style={{ fontFamily: "var(--font-mono)" }}>{f.rule_id}</span>
                  {" — "}
                  {f.detail?.slice(0, 80)}
                  <div
                    style={{
                      color: "var(--text-secondary)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                    }}
                  >
                    {f.path}
                    {f.line ? `:${f.line}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {/* Remediation & quarantine (§9) — disinfect / vault restore / purge. */}
      {/* handoff_3 §4 lists Quarantine and Remediation as TWO islands. They shared one
          Panel, so the vault form, the vault table and the streaming remediation feed
          all scrolled together under one header and neither half could be read as a
          thing in its own right. */}
      <Panel title="Remediation" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          Act on what a scan found. <strong>Disinfect</strong> writes a CLEANED COPY to a folder you
          pick — the original is never modified (in-tree single files keep a{" "}
          <code>.nemesis.bak</code>). The residual verdict is the honest one: disinfecting does not
          make a source safe.
        </p>

        {threatFindings.length > 0 ? (
          <>
            <DisinfectWizard
              key={threat?.verdict?.target ?? threatTarget}
              findings={threatFindings}
              busy={disinfecting}
              result={disinfectResult}
              onDisinfect={() => void runDisinfect()}
            />
            {disinfectError && (
              <p style={{ margin: "4px 0 0", color: "var(--danger)", fontSize: "0.78rem" }}>
                disinfect failed: {disinfectError}
              </p>
            )}
          </>
        ) : (
          <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
            Run “Scan anything for threats” above first — its findings populate the disinfect plan.
          </p>
        )}

        {/* Live remediation stream (§9 / deliverable 2) — the active run's engine
            stderr, filtered by runId so a concurrent gate/threatdb scan never bleeds
            in. Shown while a run is in flight or once it has emitted any line. */}
        {(disinfecting || remediationFeed.lines.length > 0) && (
          <div style={{ marginTop: "var(--space-4, 8px)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                color: "var(--text-secondary)",
                fontSize: "0.72rem",
                marginBottom: "var(--space-2, 4px)",
                minWidth: 0,
              }}
            >
              {disinfecting && (
                // §4's amber pulsing "running". The dot is the only motion on this island,
                // which is the point: a long disinfect otherwise looks identical to a hung one.
                <span
                  aria-hidden="true"
                  style={{
                    width: 7,
                    height: 7,
                    flex: "none",
                    borderRadius: "50%",
                    background: "var(--warn)",
                    animation: "prom-pulse 1.4s ease-in-out infinite",
                  }}
                />
              )}
              <span style={{ whiteSpace: "nowrap" }}>
                Remediation progress{disinfecting ? " — running…" : ""}
              </span>
              {remediationSteps && (
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: "var(--font-mono)",
                    whiteSpace: "nowrap",
                    color:
                      remediationSteps.done === remediationSteps.total
                        ? "var(--ok)"
                        : "var(--warn)",
                  }}
                >
                  {remediationSteps.done} / {remediationSteps.total}
                </span>
              )}
            </div>
            {/* Determinate only once the engine's post-fix re-scan produced the
                resolved/unresolved split — until then this is an indeterminate sweep rather
                than a bar climbing on invented steps (see security-console-view.ts). */}
            <Progress
              aria-label="Remediation progress"
              {...(remediationSteps
                ? {
                    value: remediationSteps.done,
                    max: remediationSteps.total,
                    tone:
                      remediationSteps.done === remediationSteps.total
                        ? ("ok" as const)
                        : ("warn" as const),
                  }
                : {})}
            />
            {/* §9: the SAME log component as the catalog install stream. One reader for
                every long-running engine op, so auto-scroll / copy / inert rendering
                behave identically wherever the user meets them. */}
            <StreamLog
              lines={
                remediationFeed.lines.length > 0
                  ? remediationFeed.lines.map((raw, i) => ({
                      id: `remediation:${i}`,
                      ...classifyRemediationLine(raw),
                    }))
                  : [
                      {
                        id: "waiting",
                        text: "waiting for engine output…",
                        level: "debug" as const,
                      },
                    ]
              }
              maxHeight="min(24vh, 280px)"
            />
          </div>
        )}
      </Panel>

      <Panel title="Quarantine" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          The vault holds files nemesis sidelined. They are isolated and never executed.{" "}
          <strong>Restore</strong> is reversible and needs a typed confirm; <strong>Purge</strong>{" "}
          is forever and has no backup. A quarantined item does not make its source safe — the
          residual verdict is the honest one.
        </p>

        <form
          ref={vaultRef}
          onSubmit={(e) => {
            e.preventDefault();
            void loadQuarantine(quarantineTarget || threatTarget);
          }}
          style={{
            display: "flex",
            gap: "var(--space-3, 6px)",
            marginTop: "var(--space-5, 12px)",
          }}
        >
          <input
            value={quarantineTarget}
            onChange={(e) => setQuarantineTarget(e.target.value)}
            placeholder={threatTarget ? `${threatTarget} (last scanned)` : "/path/that/was/scanned"}
            aria-label="Scanned path whose quarantine vault to inspect"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: "var(--radius-md, 6px)",
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.85rem",
            }}
          />
          <Button type="submit" variant="secondary" disabled={qBusy}>
            {qBusy ? "Loading…" : "Load vault"}
          </Button>
        </form>
        {quarantineDir && (
          <p
            style={{
              margin: "4px 0 0",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
              whiteSpace: "nowrap",
            }}
          >
            vault: {quarantineDir}
          </p>
        )}
        {qNote && (
          <p style={{ margin: "4px 0 0", color: "var(--text-secondary)", fontSize: "0.78rem" }}>
            {qNote}
          </p>
        )}
        <div style={{ marginTop: "var(--space-3, 6px)" }}>
          <QuarantineVault
            items={quarantineItems}
            onRestore={(id) => setRestoreTarget(quarantineItems.find((i) => i.id === id) ?? null)}
            /**
             * §4's Inspect. Deliberately REVEALS rather than opens: the whole premise of the
             * vault is that the artifact is never executed, and "open" is exactly the verb
             * that could hand it to a default application. Showing it in the file manager
             * lets the operator look without anything running it.
             */
            onInspect={(id) => {
              /**
               * Reveal the VAULT ARTIFACT, not the original path.
               *
               * `item.path` is nemesis's `original_path`, and `_quarantine` removes the file
               * after copying it — so it is guaranteed NOT to exist. The bytes live at
               * `<quarantineDir>/<id>.gz`. Inspect was pointed at the erased location and then
               * printed "revealed <path>" unconditionally, so the one thing the operator asked
               * for (look at what the gate refused) never happened and nothing said so.
               */
              const item = quarantineItems.find((i) => i.id === id);
              if (!item) return;
              if (!quarantineDir) {
                setQNote("load a vault first — its directory is where the artifact lives.");
                return;
              }
              const rec = quarantineRecords.find((r) => r.id === id);
              if (rec?.kind === "erased") {
                setQNote(`${item.path} was erased, not quarantined — there is no copy to inspect.`);
                return;
              }
              const artifact = `${quarantineDir}/${item.id}.gz`;
              // The result is SURFACED: `revealPath` answers `{ok:false}` for a path that is not
              // there (and `r?.ok` also covers the bridge method being absent), which the old
              // `void` call reported as success.
              void window.prometheus?.revealPath?.(artifact).then((r) => {
                setQNote(
                  r?.ok
                    ? `revealed ${artifact}`
                    : `could not reveal ${artifact}: ${r?.error ?? "unknown error"}`,
                );
              });
            }}
            onRestoreSelected={(ids) => {
              // §4: "Restore requires typed confirm." Same one-at-a-time discipline as
              // purge, and for the same reason — the confirm is keyed to ONE item's
              // basename, so a single confirm can never stand in for a whole selection.
              setRestoreTarget(quarantineItems.find((i) => i.id === ids[0]) ?? null);
              if (ids.length > 1)
                setQNote(
                  `Restore confirms one item at a time — confirm the first; re-select the other ${ids.length - 1} after.`,
                );
            }}
            onPurge={(id) => setPurgeTarget(quarantineItems.find((i) => i.id === id) ?? null)}
            onPurgeSelected={(ids) => {
              // Purge needs a per-item typed confirm (each has its own basename), so
              // open the dialog for the FIRST and tell the user the rest were NOT
              // queued — never silently purge a whole selection on one confirm (#2).
              setPurgeTarget(quarantineItems.find((i) => i.id === ids[0]) ?? null);
              if (ids.length > 1)
                setQNote(
                  `Purge confirms one item at a time — confirm the first; re-select the other ${ids.length - 1} after.`,
                );
            }}
          />
        </div>
        {quarantineRaw && (
          <details style={{ marginTop: "var(--space-3, 6px)" }}>
            <summary
              style={{ cursor: "pointer", color: "var(--text-secondary)", fontSize: "0.78rem" }}
            >
              Raw manifest (authoritative)
            </summary>
            <pre
              style={{
                margin: "4px 0 0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                color: "var(--text-secondary)",
              }}
            >
              {quarantineRaw}
            </pre>
          </details>
        )}
      </Panel>

      {/* Threat database freshness + update (was built IPC with no UI). */}
      {threatDb && (
        <Panel title="Threat database" elevation="e1">
          <ThreatDbPanel status={threatDb} onRefresh={() => void updateThreatDb()} />
          {dbBusy && (
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size)" }}>
              updating feeds…
            </p>
          )}
        </Panel>
      )}

      {/* Trusted sources (list + revoke) — prebuilt view, previously unmounted. */}
      <Panel title="Trusted sources" elevation="e1">
        <TrustedSourcesView sources={trusted} onRevoke={(key) => void revokeTrust(key)} />
      </Panel>

      {/* ── §4 verdict history ────────────────────────────────────────────────
          The compact row list §4 specifies, with the SIGNED log (filters + per-row HMAC
          verification) kept behind a toggle underneath. Both read the same rows; the
          difference is that this one is scannable and that one is provable, and dropping
          either would lose something real. */}
      <Panel
        title="Verdict history"
        elevation="e1"
        actions={
          auditLog.length > 0 ? (
            <button
              type="button"
              aria-pressed={signedLogOpen}
              onClick={() => setSignedLogOpen((v) => !v)}
              style={{
                background: signedLogOpen ? "var(--bg-active)" : "transparent",
                border: `1px solid ${signedLogOpen ? "var(--border-strong)" : "var(--border-subtle)"}`,
                borderRadius: "var(--radius-md, 6px)",
                color: signedLogOpen ? "var(--text-title)" : "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "0.72rem",
                padding: "2px 8px",
                whiteSpace: "nowrap", // §7
              }}
            >
              Signed log
            </button>
          ) : null
        }
      >
        {history.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", margin: 0, fontSize: "0.85rem" }}>
            No gate decisions recorded yet. Every scan, install and download writes one here.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {history.map((row) => {
              const tier: VerdictTier =
                row.verdict === "allow" || row.verdict === "warn" || row.verdict === "block"
                  ? row.verdict
                  : "error";
              const color =
                tier === "allow" ? "var(--ok)" : tier === "warn" ? "var(--warn)" : "var(--danger)";
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={() => setHistoryPick(row.key)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 4px",
                      background: "transparent",
                      border: "none",
                      borderRadius: "var(--radius-md, 6px)",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      textAlign: "left",
                      minWidth: 0, // §7
                    }}
                  >
                    {/* §4: a FIXED 74px chip, so the artifact column starts at the same x on
                        every row and the list reads as a column rather than a ragged edge. */}
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 4,
                        width: 74,
                        flex: "none",
                        padding: "1px 0",
                        borderRadius: "var(--radius-sm, 4px)",
                        background: `color-mix(in srgb, ${color} 12%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${color} 33%, transparent)`,
                        color,
                        fontFamily: "var(--font-mono)",
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: "0.05em",
                        whiteSpace: "nowrap", // §7
                      }}
                    >
                      <span aria-hidden="true">{VERDICT_GLYPH[tier]}</span>
                      {VERDICT_LABEL[tier]}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0, // §7
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.78rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.artifact}
                    </span>
                    <span
                      style={{
                        flex: "none",
                        fontSize: "0.7rem",
                        color: "var(--text-muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.source}
                    </span>
                    <span
                      style={{
                        flex: "none",
                        fontSize: "0.7rem",
                        color: row.findings === "clean" ? "var(--text-muted)" : color,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.findings}
                    </span>
                    <span
                      style={{
                        flex: "none",
                        width: 30,
                        textAlign: "right",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.68rem",
                        color: "var(--text-muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.age}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {signedLogOpen && auditLog.length > 0 && (
          <div style={{ marginTop: "var(--space-4, 8px)" }}>
            <AuditLogView
              rows={auditLog}
              onVerify={(row) => void verifyAuditRow(row)}
              verifyResults={verifyResults}
            />
          </div>
        )}
      </Panel>

      {/* §9.3 irreversible-purge typed-confirm (fixed overlay — placement in the
          grid is irrelevant). The dialog gates the CTA on the file's basename. */}
      {purgeTarget && (
        <PurgeDialog
          filename={purgeTarget.path}
          onCancel={() => setPurgeTarget(null)}
          onConfirm={(typed) => void purgeFromVault(purgeTarget, typed)}
        />
      )}

      {/* §4: "Restore requires a typed confirm." Restoring lifts a file the gate refused
          back into the workspace — reversible in the sense that it can be re-quarantined,
          but the artifact is executable again the moment it lands, which is precisely the
          state the gate was protecting against. It reuses PurgeDialog because that dialog
          was written to be reused ("only the copy changes") and a second hand-rolled modal
          is a second place for the confirm to be got wrong. */}
      {urlRestoreTarget && (
        <PurgeDialog
          filename={urlRestoreTarget.label}
          title="Re-trust this origin"
          description={
            <>
              This lifts <strong>{urlRestoreTarget.label}</strong> out of the URL-audit quarantine,
              so the app may fetch from it again. Re-audit afterwards.
            </>
          }
          onCancel={() => setUrlRestoreTarget(null)}
          onConfirm={() => void restoreQuarantined(urlRestoreTarget.vault)}
        />
      )}

      {restoreTarget && (
        <PurgeDialog
          filename={restoreTarget.path}
          title="Restore from quarantine"
          description={
            <>
              This puts <strong>{restoreTarget.rule_id || "a quarantined artifact"}</strong> back
              where nemesis found it. It becomes executable again. Re-scan it afterwards.
            </>
          }
          onCancel={() => setRestoreTarget(null)}
          onConfirm={(typed) => void restoreFromVault(restoreTarget, typed)}
        />
      )}

      {/* §4: clicking a history row opens the SAME verdict card the scan, the catalog
          install and the chat render — one card, so a verdict never looks different
          depending on where you met it. It is read-only here: the decision it describes
          was made when the row was written, and re-offering the actions would invite
          re-running a months-old install from a log. */}
      {historyPicked && (
        <DecisionOverlay label="Security verdict" onDismiss={() => setHistoryPick(null)}>
          <VerdictCard
            verdict={
              (historyPicked.verdict === "allow" ||
              historyPicked.verdict === "warn" ||
              historyPicked.verdict === "block"
                ? historyPicked.verdict
                : "error") as VerdictTier
            }
            artifact={historyPicked.target}
            sourceKind={historyPicked.label || historyPicked.tier || "gate audit"}
            riskScore={historyPicked.risk_score ?? undefined}
            // audit rows carry blocking REASONS, not scanner findings — see VerdictCard's
            // `reasons` prop for why these may not be dressed up as rule ids + severities.
            reasons={
              Array.isArray(historyPicked.blocking_reasons) ? historyPicked.blocking_reasons : []
            }
            actions={false}
          />
        </DecisionOverlay>
      )}

      {/* §9: the typed confirm that gates the deep-red override on this route. */}
      <ForceGate gate={force} />
    </div>
  );
}

export default SecurityRoute;
