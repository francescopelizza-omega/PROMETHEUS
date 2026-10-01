// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * UpdatesPage.tsx — Settings ▸ Updates & Conflicts.
 *
 * The missing consumer. `updates:check` was registered in main, exposed in preload, and backed
 * by a complete, tested store (`stores/tool-updates.ts` + `tool-updates-derive.ts`) that NOTHING
 * imported — so the whole third-party update and install-conflict feature worked in the terminal
 * (`/updates`, `/updates fix`) and was invisible in Studio.
 *
 * PROMETHEUS PROPOSES; IT NEVER AUTO-UPDATES. Every command here is copyable text, never a Run
 * button. The IPC sends display strings rather than argv precisely so this page cannot execute
 * them, and `updates-panel.ts` carries the reasoning.
 *
 * Also hosts the EXTERNAL TOOL inventory (`hostTools:list`) — the terminal's `/deps`. It belongs
 * beside the update report because it answers the adjacent question: not "is this tool current"
 * but "is this tool here at all", and the agent's own system prompt claims these tools exist.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the pure panel module + window.prometheus.
 */
import { Button, Panel, Spinner } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useCallback, useEffect, useState } from "react";

import type { HostToolRow, HostToolsResult } from "../../shared/ipc-contract.js";
import { useToolUpdates } from "../stores/tool-updates.js";
import {
  type RemedyCard,
  headline,
  remedyCards,
  remedyClipboard,
  toolRow,
} from "./updates-panel.js";

const MONO: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.78rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};
const DIM: CSSProperties = { color: "var(--text-secondary)", fontSize: "0.8rem" };
const MUTED: CSSProperties = { color: "var(--text-muted)", fontSize: "0.75rem" };
const COL: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" };
const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

/** Copy to the clipboard, fail-soft. A refused clipboard must not throw into a render. */
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* a denied clipboard permission is not a reason to break the panel */
  }
}

const STATE_COLOR: Record<string, string> = {
  update: "var(--warn, var(--text-primary))",
  current: "var(--ok)",
  unknown: "var(--text-muted)",
  absent: "var(--text-disabled)",
};

export function UpdatesPage(): ReactElement {
  const report = useToolUpdates((s) => s.report);
  const checking = useToolUpdates((s) => s.checking);
  const error = useToolUpdates((s) => s.error);
  const check = useToolUpdates((s) => s.check);
  const [tools, setTools] = useState<HostToolRow[] | null>(null);

  // One check on open, throttled by main (6h) unless the user asks for a fresh one.
  useEffect(() => {
    void check(false);
  }, [check]);

  useEffect(() => {
    let alive = true;
    const api = (globalThis as { prometheus?: { ai?: { hostTools?(): Promise<HostToolsResult> } } })
      .prometheus?.ai;
    if (typeof api?.hostTools !== "function") return;
    void api
      .hostTools()
      .then((r) => {
        if (alive && r.ok) setTools(r.tools);
      })
      .catch(() => {
        /* an older preload has no channel — the section simply does not render */
      });
    return () => {
      alive = false;
    };
  }, []);

  const onRefresh = useCallback(() => void check(true), [check]);

  const cards = report?.ok ? remedyCards(report.remedies ?? []) : [];
  const rows = (report?.ok ? report.tools : []).map(toolRow);
  const needing = rows.filter((r) => r.state === "update" || r.install);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8, 16px)" }}>
      <Panel title="Updates & install conflicts" elevation="e1">
        <div style={COL}>
          <div style={ROW}>
            <Button variant="secondary" size="sm" onClick={onRefresh} disabled={checking}>
              {checking ? "Checking…" : "Check now"}
            </Button>
            {checking ? <Spinner size={14} /> : null}
            <span style={DIM}>{headline(report)}</span>
          </div>
          {error ? <div style={{ ...MONO, color: "var(--danger)" }}>{error}</div> : null}
          {/* The standing promise, stated where the commands are. */}
          <div style={MUTED}>
            Prometheus never updates anything by itself. Every command below is yours to run — copy
            it, read it, decide.
          </div>
        </div>
      </Panel>

      {cards.length > 0 ? (
        <Panel title={`Repairs (${cards.length})`} elevation="e1">
          <div style={{ ...COL, gap: "var(--space-6, 12px)" }}>
            {cards.map((c) => (
              <RemedyBlock key={c.subject} card={c} />
            ))}
          </div>
        </Panel>
      ) : null}

      {/* Shipped WITH the repairs, never instead of them — see updates-panel.ts. */}
      {report?.ok && (report.neverRun ?? []).length > 0 ? (
        <Panel title="Never run these" elevation="e1">
          <div style={COL}>
            <div style={MUTED}>
              These look like the obvious fix and are not. Listed so the next forum answer does not
              catch you out.
            </div>
            {(report.neverRun ?? []).map((n) => (
              <div key={n.command} style={COL}>
                <code style={{ ...MONO, color: "var(--danger)" }}>✗ {n.command}</code>
                <span style={MUTED}>{n.because}</span>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {needing.length > 0 ? (
        <Panel title={`Tools needing attention (${needing.length})`} elevation="e1">
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {needing.map((t) => (
              <li key={t.id} style={{ ...ROW, padding: "4px 0" }}>
                <span style={{ ...MONO, color: STATE_COLOR[t.state] ?? "var(--text-primary)" }}>
                  {t.id}
                </span>
                <span style={MUTED}>
                  {t.current}
                  {t.latest && t.latest !== t.current ? ` → ${t.latest}` : ""}
                </span>
                {t.install ? (
                  <span style={{ ...MUTED, color: "var(--warn, var(--text-secondary))" }}>
                    {t.install} install
                  </span>
                ) : null}
                {/* `unknown` is NOT "up to date" — the lookup failed and the row says so. */}
                {t.state === "unknown" ? <span style={MUTED}>version unknown</span> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {tools ? (
        <Panel
          title={`External tools (${tools.filter((t) => t.found).length}/${tools.length})`}
          elevation="e1"
        >
          <div style={COL}>
            <div style={MUTED}>
              What Prometheus shells out to. These are named in the agent's own prompt, so a missing
              one is a capability the model believes it has.
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {tools.map((t) => (
                <li key={t.id} style={{ ...ROW, padding: "3px 0" }}>
                  <span style={{ color: t.found ? "var(--ok)" : "var(--text-disabled)" }}>
                    {t.found ? "✓" : "✗"}
                  </span>
                  <span style={MONO}>{t.id}</span>
                  <span style={{ ...MUTED, flex: 1, minWidth: 0 }}>{t.purpose}</span>
                  {!t.found && t.install.brew ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copy(`brew install ${t.install.brew}`)}
                      title={`copy: brew install ${t.install.brew}`}
                    >
                      copy install
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

/** One repair. A BLOCKED one shows its reason instead of commands — never both. */
function RemedyBlock({ card }: { card: RemedyCard }): ReactElement {
  return (
    <div style={COL}>
      <strong style={{ fontSize: "0.9rem" }}>{card.title}</strong>
      <span style={DIM}>{card.rationale}</span>
      {card.blocked ? (
        <div style={{ ...MONO, color: "var(--warn, var(--text-secondary))" }}>
          Not automated: {card.blocked}
        </div>
      ) : (
        <>
          {card.commands.map((cmd, i) => (
            <div key={cmd} style={COL}>
              <code style={MONO}>$ {cmd}</code>
              <span style={MUTED}>{card.purposes[i]}</span>
              {card.undos[i] ? <span style={MUTED}>undo: {card.undos[i]}</span> : null}
            </div>
          ))}
          <div style={ROW}>
            <Button variant="secondary" size="sm" onClick={() => void copy(remedyClipboard(card))}>
              Copy {card.commands.length === 1 ? "command" : `all ${card.commands.length}`}
            </Button>
            {card.permanent ? (
              <span style={{ ...MUTED, color: "var(--ok)" }}>
                clears the notice for good — the conflict stops being true
              </span>
            ) : null}
          </div>
        </>
      )}
      {card.keeps ? <span style={MUTED}>keeps: {card.keeps}</span> : null}
      {card.verify ? <span style={MUTED}>verify: {card.verify}</span> : null}
    </div>
  );
}
