// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * HardenPanel.tsx — the defensive self-audit surface (bottom "Security" tab).
 *
 * Runs `window.prometheus.spectacular.harden()` (read-only, THIS machine only:
 * firewall / open ports / ssh / disk-encryption / secret-perms) and renders the
 * findings + concrete fixes. Renderer-only (window.prometheus.* / tokens; no
 * node/electron/engine-bridge imports, no raw hex). Deeper AUTHORIZED testing is
 * the Security activity / `prometheus pentest`.
 */
import { Button, Panel, Spinner } from "@prometheus/ui";
import { type ReactElement, useState } from "react";

interface Finding {
  severity: string;
  message: string;
  fix: string;
}

function sevColor(s: string): string {
  if (s === "warn") return "var(--warn)";
  if (s === "ok") return "var(--ok)";
  if (s === "err") return "var(--danger)";
  return "var(--text-secondary)";
}

const SMALL = { fontSize: "var(--text-small-size, 0.8125rem)" } as const;

export function HardenPanel(): ReactElement {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [warnings, setWarnings] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    // clear the prior run's results so a failed re-run never shows a new error sitting
    // ABOVE the stale findings of the previous (successful) run.
    setFindings(null);
    setWarnings(0);
    try {
      const r = await window.prometheus.spectacular.harden();
      if (r.ok) {
        setFindings(r.findings);
        setWarnings(r.warnings);
      } else {
        setErr(r.error ?? "harden failed");
      }
    } catch (e) {
      // a rejected IPC (main-process crash / disposed channel) must not lock the button
      setErr(e instanceof Error ? e.message : "harden could not run (IPC unavailable)");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Harden — defensive self-audit (this machine)" elevation="e0">
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button variant="primary" size="sm" onClick={() => void run()} disabled={busy}>
            {busy ? "Auditing…" : "Run audit"}
          </Button>
          {busy ? <Spinner size={16} /> : null}
          {findings ? (
            <span style={{ ...SMALL, color: warnings ? "var(--warn)" : "var(--ok)" }}>
              {warnings ? `${warnings} item(s) to harden` : "solid posture — no obvious weaknesses"}
            </span>
          ) : null}
        </div>
        {err ? <div style={{ ...SMALL, color: "var(--danger)" }}>{err}</div> : null}
        {findings?.map((f, i) => (
          <div
            // message is NOT unique (two findings can share text) — include index+severity
            // so React doesn't dedupe-drop rows and undercount vs the "N item(s)" header.
            key={`${i}:${f.severity}:${f.message}`}
            style={{ borderLeft: `2px solid ${sevColor(f.severity)}`, paddingLeft: 8 }}
          >
            <div style={{ ...SMALL, color: sevColor(f.severity) }}>
              {f.severity.toUpperCase()} — {f.message}
            </div>
            {f.fix ? (
              <div style={{ ...SMALL, color: "var(--text-secondary)" }}>fix: {f.fix}</div>
            ) : null}
          </div>
        ))}
        <div style={{ ...SMALL, color: "var(--text-secondary)" }}>
          Read-only · this machine only. Deeper AUTHORIZED testing: the Security activity /
          `prometheus pentest` (sandboxed, ROE-gated).
        </div>
      </div>
    </Panel>
  );
}

export default HardenPanel;
