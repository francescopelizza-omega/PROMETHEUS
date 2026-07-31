/**
 * ide/Problems.tsx — the LSP diagnostics aggregate (file 07 §3.3/§11).
 *
 * Aggregates `publishDiagnostics` across every open file (the per-uri map in the
 * diagnostics store, fed by the `ide:event` "lsp.diagnostics" channel) and renders
 * the flat, location-sorted Problems list — virtualization-friendly + debounced at
 * the store level (§11). Clicking a row opens the file at the diagnostic (preview
 * tab). All projection math is the PURE diagnostics module (node:test-ed).
 *
 * The active INSPECTION PROFILE (plan 03) filters + re-ranks the rows: a row whose
 * inspection is set to "off" is hidden, and a raised/lowered severity re-colours it. The
 * ⊘ button suppresses that inspection (source:code); the header offers a reset.
 *
 * Renderer-SANDBOXED (C5): react + the pure diagnostics/inspection projection + the
 * stores + window.prometheus only.
 */

import { type ChangeEvent, type ReactElement, useCallback, useMemo, useRef } from "react";

import { pathToFileUri } from "./state/breakpoint-store.js";
import { countDiagnostics, toProblemRows } from "./state/diagnostics.js";
import { useInspectionProfileStore } from "./state/inspection-profile-store.js";
import {
  type Severity,
  effectiveSeverity,
  inspectionId,
  severityToLsp,
} from "./state/inspection-profile.js";
import { detectLanguage } from "./state/lang-detect.js";
import { mergeProblemRows, useLintStore } from "./state/lint-store.js";
import { useDiagnosticsStore, useTabsStore } from "./state/stores.js";
import { absTestPath, useTestRunStore } from "./test/test-run-store.js";

const headerBtnStyle = {
  background: "transparent",
  border: "none",
  color: "var(--accent, #22d3ee)",
  cursor: "pointer",
  fontSize: "0.72rem",
  padding: "0 2px",
} as const;

const SEV_GLYPH: Record<number, string> = { 1: "✖", 2: "⚠", 3: "ℹ", 4: "·" };
const SEV_COLOR: Record<number, string> = {
  1: "var(--danger, #ef5a5a)",
  2: "var(--warn, #d9a441)",
  3: "var(--text-secondary, #9a9aa3)",
  4: "var(--text-secondary, #9a9aa3)",
};

export function Problems(): ReactElement {
  const byUri = useDiagnosticsStore((s) => s.byUri);
  const open = useTabsStore((s) => s.open);
  const tabs = useTabsStore((s) => s.tabs);
  const profile = useInspectionProfileStore((s) => s.profile);
  const suppress = useInspectionProfileStore((s) => s.suppress);
  const setSeverity = useInspectionProfileStore((s) => s.setSeverity);
  const reset = useInspectionProfileStore((s) => s.reset);
  const exportJson = useInspectionProfileStore((s) => s.exportJson);
  const importJson = useInspectionProfileStore((s) => s.importJson);
  // APP-062: merge the LSP rows with the last linter fan-in run (de-duped by path+line+rule).
  const lintRows = useLintStore((s) => s.rows);
  const lintSkipped = useLintStore((s) => s.skipped);
  const setLint = useLintStore((s) => s.setResults);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const allRows = useMemo(
    () => mergeProblemRows(toProblemRows(byUri), lintRows),
    [byUri, lintRows],
  );
  const counts = useMemo(() => countDiagnostics(byUri), [byUri]);

  // Run the available linters over the OPEN python files (paths path-guarded main-side).
  const runLinters = useCallback(async (): Promise<void> => {
    const api = window.prometheus?.ide?.lint;
    if (!api) return;
    const paths = (tabs.docs ?? [])
      .filter((d) => d.languageId === "python" || d.uri.endsWith(".py"))
      .map((d) => d.uri);
    if (paths.length === 0) return;
    const r = await api.run({ paths });
    if (r.ok) setLint(r.diagnostics ?? [], r.ran ?? [], r.skipped ?? []);
  }, [tabs.docs, setLint]);

  // Raise a row's inspection to the next-more-severe level (▲); ⊘ still turns it off.
  const raise = useCallback(
    (id: string, current: Severity): void => {
      const order: Severity[] = ["hint", "info", "warning", "error"];
      const idx = order.indexOf(current);
      setSeverity(id, order[Math.min(order.length - 1, idx + 1)] ?? "error");
    },
    [setSeverity],
  );

  const doExport = useCallback((): void => {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inspection-profile.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [exportJson]);

  const onImportFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-importing the same file
      if (file) importJson(await file.text());
    },
    [importJson],
  );

  // APP-040: failed tests (with a located traceback frame) surface as Problems rows.
  const testRoot = useTestRunStore((s) => s.root);
  const testStates = useTestRunStore((s) => s.states);
  const testSites = useTestRunStore((s) => s.sites);
  const testMessages = useTestRunStore((s) => s.messages);
  const testFailures = useMemo(() => {
    if (!testRoot) return [];
    const out: { id: string; uri: string; line: number; label: string; name: string }[] = [];
    for (const [id, st] of Object.entries(testStates)) {
      if (st !== "fail" && st !== "error") continue;
      const site = testSites[id];
      if (!site) continue;
      const abs = absTestPath(testRoot, site.file);
      out.push({
        id,
        uri: pathToFileUri(abs),
        line: site.line,
        label: testMessages[id] || id,
        name: abs.split(/[/\\]/).pop() ?? abs,
      });
    }
    return out;
  }, [testRoot, testStates, testSites, testMessages]);

  // apply the inspection profile: hide suppressed rows, and use the OVERRIDDEN severity
  // for the glyph/colour so a raised inspection reads as an error, etc.
  const { rows, hidden } = useMemo(() => {
    const out: { row: (typeof allRows)[number]; sev: number }[] = [];
    let suppressed = 0;
    for (const r of allRows) {
      const eff = effectiveSeverity(r, profile);
      if (eff === "off") {
        suppressed++;
        continue;
      }
      out.push({ row: r, sev: severityToLsp(eff) ?? r.severity });
    }
    return { rows: out, hidden: suppressed };
  }, [allRows, profile]);
  const overrideCount = Object.keys(profile.overrides).length;

  return (
    <div style={{ height: "100%", overflow: "auto", fontSize: "0.78rem" }} aria-label="problems">
      <div
        style={{
          position: "sticky",
          top: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "var(--bg-surface-2, #16161b)",
          borderBottom: "1px solid var(--border-subtle, #232329)",
          color: "var(--text-secondary, #9a9aa3)",
        }}
      >
        <span>
          PROBLEMS · {counts.errors} ✖ · {counts.warnings} ⚠
          {hidden > 0 ? ` · ${hidden} hidden` : ""}
          {lintSkipped.length > 0 ? ` · ${lintSkipped.length} linter(s) skipped` : ""}
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => void runLinters()}
            title="Run ruff/flake8/mypy/pylint on open Python files"
            style={headerBtnStyle}
          >
            run linters
          </button>
          <button
            type="button"
            onClick={doExport}
            title="Export the inspection profile to JSON"
            style={headerBtnStyle}
          >
            export
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            title="Import an inspection profile from JSON"
            style={headerBtnStyle}
          >
            import
          </button>
          {overrideCount > 0 && (
            <button
              type="button"
              onClick={() => reset()}
              title="Clear all inspection overrides"
              style={headerBtnStyle}
            >
              reset ({overrideCount})
            </button>
          )}
        </span>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          onChange={(e) => void onImportFile(e)}
          aria-label="import inspection profile"
          style={{ display: "none" }}
          tabIndex={-1}
        />
      </div>
      {rows.length === 0 ? (
        <p style={{ padding: 8, color: "var(--text-secondary, #9a9aa3)" }}>
          {allRows.length === 0
            ? "No problems detected."
            : "All problems suppressed by the profile."}
        </p>
      ) : (
        <div>
          {rows.map(({ row: r, sev }) => (
            <div
              key={`${r.uri}:${r.line}:${r.character}:${r.message}`}
              style={{ display: "flex", alignItems: "baseline", gap: 2, padding: "0 4px 0 0" }}
            >
              <button
                type="button"
                onClick={() =>
                  open(r.uri, { name: r.name, languageId: detectLanguage(r.uri), preview: true })
                }
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  padding: "3px 8px",
                  cursor: "pointer",
                  color: "var(--text-primary, #e7e7ea)",
                  background: "transparent",
                  border: "none",
                  font: "inherit",
                  textAlign: "left",
                  overflow: "hidden",
                }}
              >
                <span aria-hidden="true" style={{ color: SEV_COLOR[sev] }}>
                  {SEV_GLYPH[sev]}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    color: "var(--text-secondary, #9a9aa3)",
                  }}
                >
                  {r.name}:{r.line + 1}
                </span>
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {r.message}
                </span>
                {r.source && (
                  <span style={{ color: "var(--text-secondary, #9a9aa3)" }}>({r.source})</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => raise(inspectionId(r), effectiveSeverity(r, profile))}
                title={`Raise this inspection's severity (${inspectionId(r)})`}
                aria-label="raise inspection severity"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary, #9a9aa3)",
                  cursor: "pointer",
                  fontSize: "0.75rem",
                  padding: "0 4px",
                }}
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => suppress(inspectionId(r))}
                title={`Suppress this inspection (${inspectionId(r)})`}
                aria-label="suppress inspection"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary, #9a9aa3)",
                  cursor: "pointer",
                  fontSize: "0.75rem",
                  padding: "0 4px",
                }}
              >
                ⊘
              </button>
            </div>
          ))}
        </div>
      )}
      {testFailures.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border-subtle, #232329)" }}>
          <div style={{ padding: "4px 8px", color: "var(--text-secondary, #9a9aa3)" }}>
            TEST FAILURES · {testFailures.length}
          </div>
          {testFailures.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                open(t.uri, { name: t.name, languageId: detectLanguage(t.uri), preview: true });
                setTimeout(
                  () =>
                    window.dispatchEvent(
                      new CustomEvent("ide:reveal-position", {
                        detail: { line: t.line, column: 1 },
                      }),
                    ),
                  160,
                );
              }}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                width: "100%",
                padding: "3px 8px",
                cursor: "pointer",
                color: "var(--text-primary, #e7e7ea)",
                background: "transparent",
                border: "none",
                font: "inherit",
                textAlign: "left",
                overflow: "hidden",
              }}
            >
              <span aria-hidden="true" style={{ color: "var(--danger, #ef5a5a)" }}>
                ✖
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  color: "var(--text-secondary, #9a9aa3)",
                }}
              >
                {t.name}:{t.line}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default Problems;
