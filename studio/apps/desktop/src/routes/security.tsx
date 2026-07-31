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
  Panel,
  PurgeDialog,
  QuarantineVault,
  type SecAuditLogEntry,
  type SecFinding,
  type SecQuarantineItem,
  type SecThreatDbStatus,
  type SecTrustedSource,
  type SecVerdict,
  ThreatDbPanel,
  TrustedSourcesView,
  VerdictBadge,
} from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { useScan } from "../renderer/query/hooks.js";
import { useSecurityStore } from "../renderer/stores/features.js";
import type {
  GateResult,
  ProviderRow,
  SecurityGateResult,
  SecurityUrlAuditResult,
} from "../shared/ipc-contract.js";
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
  const [disinfectError, setDisinfectError] = useState<string | null>(null);
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
      }
    },
    [scanningThreat],
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
  const loadTrustDb = useCallback(async () => {
    try {
      const s = await window.prometheus.security.threatdb({ op: "status" });
      if (s.ok && s.status) setThreatDb(s.status as unknown as SecThreatDbStatus);
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
    } catch {
      /* non-fatal */
    }
  }, []);
  useEffect(() => {
    void loadTrustDb();
  }, [loadTrustDb]);
  const updateThreatDb = useCallback(async () => {
    if (dbBusy) return;
    setDbBusy(true);
    try {
      await window.prometheus.security.threatdb({ op: "update" });
      await loadTrustDb();
    } catch {
      /* surfaced via the panel's own status next load */
    } finally {
      setDbBusy(false);
    }
  }, [dbBusy, loadTrustDb]);
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

  // ── Remediation & quarantine (§9): disinfect → cleaned copy; vault list /
  // restore (reversible) / purge (irreversible). All work is the ENGINE's; the
  // route only renders what `security.remediate` returns (C5).
  const [quarantineTarget, setQuarantineTarget] = useState("");
  const [quarantineDir, setQuarantineDir] = useState("");
  const [quarantineItems, setQuarantineItems] = useState<SecQuarantineItem[]>([]);
  const [quarantineRaw, setQuarantineRaw] = useState("");
  const [qBusy, setQBusy] = useState(false);
  const [qNote, setQNote] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<SecQuarantineItem | null>(null);

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
  useEffect(() => {
    const off = window.prometheus.security.onProgress((e) =>
      setRemediationFeed((s) => reduceRemediationFeed(s, e, activeRemediationRunRef.current)),
    );
    return off;
  }, []);
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
    async (id: string): Promise<{ ok: boolean; msg: string }> => {
      try {
        const r = await window.prometheus.security.remediate({ op: "restore", id, quarantineDir });
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
    async (id: string) => {
      if (!quarantineDir) {
        setQNote("load a vault first.");
        return;
      }
      const { msg } = await restoreOne(id);
      setQNote(msg);
      await loadQuarantine(vaultTarget);
    },
    [quarantineDir, restoreOne, vaultTarget, loadQuarantine],
  );

  // Batch restore: run each restore sequentially, then reload the vault ONCE (#7).
  const restoreSelected = useCallback(
    async (ids: string[]) => {
      if (!quarantineDir || ids.length === 0) return;
      let ok = 0;
      for (const id of ids) {
        if ((await restoreOne(id)).ok) ok += 1;
      }
      setQNote(`restored ${ok}/${ids.length} item${ids.length === 1 ? "" : "s"}.`);
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
    setDisinfectError(null);
    try {
      const r = await window.prometheus.security.remediate({
        op: "disinfect",
        target: t,
        out,
        runId,
      });
      const data = (r.data ?? {}) as { verdict?: SecVerdict; error?: string };
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
    }
  }, [target, gating, setVerdict]);

  const tierACount = providers.filter((p) => p.tier === "A").length;
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
          <div
            style={{
              marginTop: "var(--space-4, 8px)",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-4, 8px)",
              flexWrap: "wrap",
            }}
          >
            <VerdictBadge verdict={gate.verdict} risk_score={gate.riskScore} />
            <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
              {gate.findingsCount} finding{gate.findingsCount === 1 ? "" : "s"}
              {gate.severity !== "clean" ? ` · ${gate.severity}` : ""}
              {gate.signed ? " · signed" : ""}
            </span>
            {gate.error && (
              <span style={{ color: "var(--danger)", fontSize: "0.8rem" }}>{gate.error}</span>
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
                      onClick={() => void restoreQuarantined(q.vault)}
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
      <Panel title="Remediation & quarantine" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          Act on what a scan found. <strong>Disinfect</strong> writes a CLEANED COPY to a folder you
          pick — the original is never modified (in-tree single files keep a{" "}
          <code>.nemesis.bak</code>). The <strong>vault</strong> holds files nemesis sidelined:{" "}
          <strong>Restore</strong> is reversible; <strong>Purge</strong> is forever and has no
          backup. The residual verdict is the honest one — a quarantined item does not make a source
          safe.
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
                color: "var(--text-secondary)",
                fontSize: "0.72rem",
                marginBottom: "var(--space-2, 4px)",
              }}
            >
              Remediation progress{disinfecting ? " — running…" : ""}
            </div>
            <pre
              aria-label="Remediation progress log"
              style={{
                margin: 0,
                maxHeight: "160px",
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                padding: "var(--space-3, 6px)",
                borderRadius: "var(--radius-md, 6px)",
                border: "1px solid var(--border-subtle)",
                background: "var(--bg-surface-2)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                color: "var(--text-secondary)",
              }}
            >
              {remediationFeed.lines.length > 0
                ? remediationFeed.lines.join("\n")
                : "waiting for engine output…"}
            </pre>
          </div>
        )}

        <form
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
            onRestore={(id) => void restoreFromVault(id)}
            onRestoreSelected={(ids) => void restoreSelected(ids)}
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

      {/* Gate-audit log (newest-first) — prebuilt view, previously unmounted. */}
      {auditLog.length > 0 && (
        <Panel title="Gate audit log" elevation="e1">
          <AuditLogView rows={auditLog} />
        </Panel>
      )}

      {/* §9.3 irreversible-purge typed-confirm (fixed overlay — placement in the
          grid is irrelevant). The dialog gates the CTA on the file's basename. */}
      {purgeTarget && (
        <PurgeDialog
          filename={purgeTarget.path}
          onCancel={() => setPurgeTarget(null)}
          onConfirm={(typed) => void purgeFromVault(purgeTarget, typed)}
        />
      )}
    </div>
  );
}

export default SecurityRoute;
