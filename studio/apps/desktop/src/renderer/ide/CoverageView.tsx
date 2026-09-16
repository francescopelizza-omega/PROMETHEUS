/**
 * ide/CoverageView.tsx — the Coverage tool window (APP-086).
 *
 * Runs the suite under coverage (coverage.py sidecar in MAIN), or imports an external
 * coverage.py JSON, and shows a per-file table (path · % · missed) + the total, worst
 * coverage first. Setting a report publishes it to the coverage store so EditorPane
 * paints its gutter stripes. Token colors only (C5: no raw hex, no engine-bridge here).
 */

import { Button } from "@prometheus/ui";
import { type ReactElement, useState } from "react";

import type { IdeCoverageReport } from "../../shared/ipc-contract.js";
import { useCoverageStore } from "./state/coverage-store.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Per-file rows sorted WORST coverage first (covered / (covered + missed)). */
function rows(report: IdeCoverageReport): { file: string; pct: number; missed: number }[] {
  return Object.entries(report.perFile)
    .map(([file, e]) => {
      const total = e.lines.length + e.missed.length;
      const pct = total === 0 ? 100 : Math.round((e.lines.length / total) * 1000) / 10;
      return { file, pct, missed: e.missed.length };
    })
    .sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file));
}

export function CoverageView({ root }: { root: string }): ReactElement {
  const report = useCoverageStore((s) => s.report);
  const setReport = useCoverageStore((s) => s.setReport);
  const [framework, setFramework] = useState<"pytest" | "unittest">("pytest");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [importPath, setImportPath] = useState("");

  const run = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    const r = await ide()
      ?.coverageRun(root, framework)
      .catch(() => undefined);
    setBusy(false);
    if (!r || r.ok === false || !r.report) {
      setErr(r?.error ?? "coverage run failed");
      return;
    }
    setReport(r.report);
  };

  const doImport = async (): Promise<void> => {
    const p = importPath.trim();
    if (!p) return;
    setBusy(true);
    setErr(null);
    const r = await ide()
      ?.coverageImport(p)
      .catch(() => undefined);
    setBusy(false);
    if (!r || r.ok === false || !r.report) {
      setErr(r?.error ?? "import failed");
      return;
    }
    setReport(r.report);
    setImportPath("");
  };

  const controlStyle = {
    background: "var(--bg-surface-2)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: 4,
    padding: "2px 4px",
    fontSize: "0.74rem",
  } as const;

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="coverage"
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}
      >
        <select
          value={framework}
          aria-label="coverage framework"
          onChange={(e) => setFramework(e.target.value as "pytest" | "unittest")}
          style={controlStyle}
        >
          <option value="pytest">pytest</option>
          <option value="unittest">unittest</option>
        </select>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void run()}>
          {busy ? "…" : "Run coverage"}
        </Button>
        {report && (
          <span style={{ marginLeft: "auto", color: "var(--text-primary)", fontWeight: 600 }}>
            total {report.totalPct}%
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        <input
          value={importPath}
          onChange={(e) => setImportPath(e.target.value)}
          placeholder="path to a coverage.json to import…"
          aria-label="coverage import path"
          style={{ ...controlStyle, flex: 1 }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !importPath.trim()}
          onClick={() => void doImport()}
        >
          Import
        </Button>
      </div>

      {err && (
        <p role="alert" style={{ margin: "0 0 6px", color: "var(--danger)", fontSize: "0.72rem" }}>
          {err}
        </p>
      )}

      {!report ? (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          Run coverage or import a report to see per-file coverage.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.72rem" }}>
          <thead>
            <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
              <th style={{ padding: "2px 4px" }}>file</th>
              <th style={{ padding: "2px 4px", textAlign: "right" }}>%</th>
              <th style={{ padding: "2px 4px", textAlign: "right" }}>missed</th>
            </tr>
          </thead>
          <tbody>
            {rows(report).map((r) => (
              <tr key={r.file} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                <td
                  style={{
                    padding: "2px 4px",
                    fontFamily: "var(--font-mono, monospace)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                    whiteSpace: "nowrap",
                    maxWidth: 220,
                  }}
                  title={r.file}
                >
                  {r.file.split("/").pop()}
                </td>
                <td
                  style={{
                    padding: "2px 4px",
                    textAlign: "right",
                    color:
                      r.pct >= 80 ? "var(--ok)" : r.pct >= 50 ? "var(--warn)" : "var(--danger)",
                  }}
                >
                  {r.pct}
                </td>
                <td
                  style={{ padding: "2px 4px", textAlign: "right", color: "var(--text-secondary)" }}
                >
                  {r.missed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default CoverageView;
