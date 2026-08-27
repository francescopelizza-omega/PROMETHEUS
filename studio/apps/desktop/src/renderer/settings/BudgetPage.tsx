/**
 * BudgetPage.tsx — Settings ▸ Budget & Spend (roadmap point 4).
 *
 * Prometheus has always had a REAL, fail-closed, hard-stop spend cap (`DesktopBudgetGate`,
 * `ai.decideBudget`) — but nothing ever showed a user the number it was enforcing against, and
 * a repo's `.prometheus.toml`/the CLI's `prometheus budget` are the only other places this cap
 * is even visible. This page is the desktop's home for it: a live (4s-polled, via
 * `useBudgetStatus`) snapshot of today's/this session's real spend against the configured caps,
 * plus a small form to set them.
 *
 * SETTING a cap is NOT a bespoke write path — it reuses the EXISTING generic settings tree
 * (`window.prometheus.settings.set("budget.sessionUsd", …, "global")`), already validated in
 * `packages/core/src/settings/schema.ts`. This page is a friendlier front end over that, not a
 * second mechanism.
 *
 * Matches ModelHealthPage.tsx's conventions: `Panel` from "@prometheus/ui" as the outer
 * container, plain inline `CSSProperties` objects, `var(--...)` tokens, explicit loading/error/
 * empty states.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the local `useBudgetStatus` hook
 * (window.prometheus.budget / window.prometheus.settings) only.
 */
import { Panel, StatusPill } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from "react";

import { useBudgetStatus } from "../shared/budget/useBudgetStatus.js";

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pct(spent: number, cap: number | undefined): string | undefined {
  if (cap === undefined || cap <= 0) return undefined;
  return `${Math.round((spent / cap) * 100)}%`;
}

export function BudgetPage(): ReactElement {
  const { status, loading, error, refresh, setBudgetField } = useBudgetStatus();
  const [draft, setDraft] = useState({
    sessionUsd: status.config.sessionUsd?.toString() ?? "",
    dailyUsd: status.config.dailyUsd?.toString() ?? "",
    warnAtPercent: (status.config.warnAtPercent ?? 80).toString(),
    unpricedPolicy: status.config.unpricedPolicy ?? "block",
  });
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  /**
   * `useState`'s initializer only ever runs on the component's FIRST render, when
   * `useBudgetStatus()`'s `status` is still the hard-coded `EMPTY_STATUS` (the real value only
   * arrives later, asynchronously, via IPC) — so without this, `draft` stayed at its blank/
   * default(80) seed for the entire lifetime of the mount, even after the real config loaded and
   * was correctly shown a few lines below in the read-only `SpendRow`s. Re-seed exactly ONCE,
   * the moment the first real load resolves (`loading` goes true→false) — not on every
   * subsequent 4s poll tick, which would otherwise clobber whatever the user is actively typing.
   */
  const syncedOnce = useRef(false);
  useEffect(() => {
    if (loading || syncedOnce.current) return;
    syncedOnce.current = true;
    setDraft({
      sessionUsd: status.config.sessionUsd?.toString() ?? "",
      dailyUsd: status.config.dailyUsd?.toString() ?? "",
      warnAtPercent: (status.config.warnAtPercent ?? 80).toString(),
      unpricedPolicy: status.config.unpricedPolicy ?? "block",
    });
  }, [loading, status]);

  async function saveField(
    key: "budget.sessionUsd" | "budget.dailyUsd" | "budget.warnAtPercent",
    raw: string,
  ): Promise<void> {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setSaveError(`"${raw}" is not a positive number`);
      return;
    }
    setSaving(true);
    const res = await setBudgetField(key, n);
    setSaving(false);
    setSaveError(res.ok ? undefined : (res.error ?? "failed to save"));
  }

  async function saveUnpricedPolicy(value: "block" | "warn"): Promise<void> {
    setSaving(true);
    const res = await setBudgetField("budget.unpricedPolicy", value);
    setSaving(false);
    setSaveError(res.ok ? undefined : (res.error ?? "failed to save"));
    if (res.ok) setDraft((d) => ({ ...d, unpricedPolicy: value }));
  }

  return (
    <Panel
      title="Budget & Spend"
      elevation="e1"
      actions={
        <button type="button" style={refreshBtn} onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
        <p style={hintStyle}>
          A configured cap is a REAL, fail-closed hard-stop — a turn over budget is refused before
          it runs, not just flagged after the fact. A team can commit the same cap into a repo's{" "}
          <code>.prometheus.toml</code> to clamp everyone who works in it (it can only tighten a
          cap, never loosen one).
        </p>

        {error && (
          <div style={{ color: "var(--danger)", padding: "var(--space-2, 4px) 0" }}>{error}</div>
        )}

        {!error && !status.capped && (
          <div style={{ color: "var(--text-secondary)", padding: "var(--space-2, 4px) 0" }}>
            no budget cap configured — spend is unlimited.
          </div>
        )}

        {!error && status.capped && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}>
            {status.config.sessionUsd !== undefined && (
              <SpendRow
                label="This session"
                spent={status.sessionSpentUsd}
                cap={status.config.sessionUsd}
              />
            )}
            {status.config.dailyUsd !== undefined && (
              <SpendRow label="Today" spent={status.dailySpentUsd} cap={status.config.dailyUsd} />
            )}
          </div>
        )}

        {status.unpriced.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2, 4px)" }}>
            <StatusPill status="degraded" label="unpriced models" />
            <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
              {status.unpriced.join(", ")} — excluded from the totals above
              {status.config.unpricedPolicy !== "warn" &&
                "; a configured cap BLOCKS a turn on one of these"}
            </span>
          </div>
        )}

        <div style={formGridStyle}>
          <FieldRow
            label="Session cap (USD)"
            value={draft.sessionUsd}
            placeholder="unlimited"
            onChange={(v) => setDraft((d) => ({ ...d, sessionUsd: v }))}
            onSave={() => saveField("budget.sessionUsd", draft.sessionUsd)}
            disabled={saving}
          />
          <FieldRow
            label="Daily cap (USD)"
            value={draft.dailyUsd}
            placeholder="unlimited"
            onChange={(v) => setDraft((d) => ({ ...d, dailyUsd: v }))}
            onSave={() => saveField("budget.dailyUsd", draft.dailyUsd)}
            disabled={saving}
          />
          <FieldRow
            label="Warn at (%)"
            value={draft.warnAtPercent}
            placeholder="80"
            onChange={(v) => setDraft((d) => ({ ...d, warnAtPercent: v }))}
            onSave={() => saveField("budget.warnAtPercent", draft.warnAtPercent)}
            disabled={saving}
          />
          <div style={fieldRowStyle}>
            <label style={labelStyle} htmlFor="unpriced-policy">
              Unpriced models
            </label>
            <select
              id="unpriced-policy"
              style={selectStyle}
              value={draft.unpricedPolicy}
              disabled={saving}
              onChange={(e) => void saveUnpricedPolicy(e.target.value as "block" | "warn")}
            >
              <option value="block">Block (fail-closed, default)</option>
              <option value="warn">Warn (allow uncapped spend)</option>
            </select>
          </div>
        </div>

        {saveError && <div style={{ color: "var(--danger)", fontSize: "0.8rem" }}>{saveError}</div>}
      </div>
    </Panel>
  );
}

function SpendRow({
  label,
  spent,
  cap,
}: {
  label: string;
  spent: number;
  cap: number;
}): ReactElement {
  const percent = pct(spent, cap);
  const status =
    spent >= cap ? "down" : percent && Number(percent.replace("%", "")) >= 80 ? "degraded" : "ok";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3, 6px)" }}>
      <span style={{ minWidth: "6rem", color: "var(--text-secondary)", fontSize: "0.8rem" }}>
        {label}
      </span>
      <StatusPill
        status={status}
        label={`${fmtUsd(spent)} of ${fmtUsd(cap)}${percent ? ` (${percent})` : ""}`}
      />
    </div>
  );
}

function FieldRow({
  label,
  value,
  placeholder,
  onChange,
  onSave,
  disabled,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onSave: () => void;
  disabled: boolean;
}): ReactElement {
  return (
    <div style={fieldRowStyle}>
      <label style={labelStyle} htmlFor={label}>
        {label}
      </label>
      <input
        id={label}
        style={inputStyle}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave();
        }}
      />
      <button type="button" style={saveBtn} onClick={onSave} disabled={disabled}>
        Save
      </button>
    </div>
  );
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8125rem",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const formGridStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2, 4px)",
  marginTop: "var(--space-2, 4px)",
  paddingTop: "var(--space-3, 6px)",
  borderTop: "1px solid var(--border-subtle, var(--border-strong))",
};

const fieldRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3, 6px)",
};

const labelStyle: CSSProperties = {
  minWidth: "9rem",
  color: "var(--text-secondary)",
  fontSize: "0.8125rem",
};

const inputStyle: CSSProperties = {
  background: "var(--surface-1, transparent)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  fontFamily: "var(--font-ui)",
  fontSize: "0.8125rem",
  width: "8rem",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  width: "auto",
};

const saveBtn: CSSProperties = {
  background: "transparent",
  color: "var(--accent)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "0.75rem",
};

const refreshBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "0.75rem",
};

export default BudgetPage;
