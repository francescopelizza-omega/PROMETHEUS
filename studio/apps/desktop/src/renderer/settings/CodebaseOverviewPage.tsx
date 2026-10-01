// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * CodebaseOverviewPage.tsx — Settings ▸ Meet Your Codebase (roadmap point 6).
 *
 * A friendly, on-demand first-look read of the open workspace: what stack it looks like, where
 * the code actually lives, what it's mostly written in, a taste of what it defines, and where to
 * start reading. Generated ONLY on the "Generate overview" click — never automatically on
 * workspace-open or app-start (see `useCodebaseOverview.ts`'s own header for why: a repo-map
 * walk of a large repo is a real, potentially-slow scan, and an unannounced one would stall the
 * app the moment a folder opens, before the user asked for anything).
 *
 * This is the SAME reading `prometheus meet` gives on the CLI — both go through
 * `@prometheus/core`'s `token-economy/codebase-overview.ts`'s `summarizeCodebase`, so the two
 * surfaces can never disagree about what a repo looks like.
 *
 * Matches ModelHealthPage.tsx's conventions: `Panel` from "@prometheus/ui" as the outer
 * container, plain inline `CSSProperties` objects, `var(--...)` tokens, explicit loading/error/
 * empty states.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the local `useCodebaseOverview` hook
 * (window.prometheus.codebaseOverview) only.
 */
import { EmptyState, Panel, StatusPill } from "@prometheus/ui";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { useCodebaseOverview } from "../shared/codebase-overview/useCodebaseOverview.js";

export function CodebaseOverviewPage(): ReactElement {
  const { overview, loading, error, generate } = useCodebaseOverview();

  return (
    <Panel
      title="Meet Your Codebase"
      elevation="e1"
      actions={
        <button
          type="button"
          style={generateBtn}
          onClick={() => void generate()}
          disabled={loading}
        >
          {loading ? "Reading…" : overview ? "Regenerate" : "Generate overview"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
        <p style={hintStyle}>
          A quick, friendly first look at the folder you have open — what it's built with, where the
          code lives, and where to start reading. A one-time read on request, not a background scan:
          nothing runs until you click Generate.
        </p>

        {error && (
          <div style={{ color: "var(--danger)", padding: "var(--space-2, 4px) 0" }}>{error}</div>
        )}

        {!error && !loading && !overview && (
          <EmptyState
            title="No overview yet"
            hint='Click "Generate overview" to read the currently open workspace.'
          />
        )}

        {overview && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2, 4px)" }}>
              <StatusPill status="ok" label={`${overview.fileCount.toLocaleString()} files`} />
              {overview.truncated && (
                <StatusPill
                  status="degraded"
                  label="sampled"
                  title="This repo is larger than the scan cap — showing a representative sample, not every file."
                />
              )}
              {overview.detectedStacks.map((s) => (
                <StatusPill key={s} status="unknown" label={s} />
              ))}
            </div>

            {overview.topDirs.length > 0 && (
              <Section title="Where the code lives">
                {overview.topDirs.map((d) => (
                  <Row
                    key={d.key}
                    label={`${d.key}/`}
                    value={`${d.count.toLocaleString()} files`}
                  />
                ))}
              </Section>
            )}

            {overview.topExtensions.length > 0 && (
              <Section title="Mostly written in">
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2, 4px)" }}>
                  {overview.topExtensions.map((e) => (
                    <span key={e.key} style={extChip}>
                      .{e.key} ({e.count})
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {overview.sampleSymbols.length > 0 && (
              <Section title="A few things it defines">
                <div style={{ color: "var(--text-secondary)", fontSize: "0.8125rem" }}>
                  {overview.sampleSymbols.join(", ")}
                </div>
              </Section>
            )}

            {overview.readmePath && (
              <Section title="Start here">
                <code style={{ fontFamily: "var(--font-mono)" }}>{overview.readmePath}</code>
              </Section>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8125rem" }}>
      <span>{label}</span>
      <span style={{ color: "var(--text-secondary)" }}>{value}</span>
    </div>
  );
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8125rem",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const sectionTitle: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  color: "var(--text-secondary)",
};

const extChip: CSSProperties = {
  background: "var(--bg-surface-2)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-1, 2px) var(--space-3, 6px)",
  fontSize: "0.75rem",
  fontFamily: "var(--font-mono)",
};

const generateBtn: CSSProperties = {
  background: "transparent",
  color: "var(--accent)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "0.75rem",
};

export default CodebaseOverviewPage;
