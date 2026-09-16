/**
 * AuditLogView.tsx — the tamper-evident gate-audit table (file 03 §8).
 *
 * Renders parsed `gate-audit.jsonl` rows: time / label / target / verdict / risk
 * / decision / tier. Three quick filters (forced-danger only · blocks only · last
 * 24h) narrow the view via the PURE `filterAuditRows` predicate. Each row carries
 * a Verify button: the renderer recomputes the row's HMAC through
 * window.prometheus.* and feeds the `SecVerifyResult` back via `verifyResults`,
 * which paints the row's integrity (valid → green ✓, invalid → red ✗).
 *
 * Presentational: filtering is pure + local; verification is delegated. Engine
 * strings (label, target, decision) are inert text; the verdict pill comes from
 * the shared VerdictBadge (tier only). Decides nothing about "safe" (C5).
 */

import { type ReactElement, useState } from "react";
import { VerdictBadge } from "../components/VerdictBadge.js";
import type { VerdictTier } from "../tokens.js";
import type { SecAuditFilter, SecAuditLogEntry, SecVerifyResult } from "./types.js";
import { filterAuditRows, inertText } from "./util.js";

/** Coerce a row's stored verdict string to a known tier (unknown ⇒ error). */
function toTier(verdict: string): VerdictTier {
  switch (verdict) {
    case "allow":
    case "warn":
    case "block":
    case "error":
      return verdict;
    default:
      return "error";
  }
}

function shortDate(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? inertText(at) : d.toLocaleString();
}

export interface AuditLogViewProps {
  rows: SecAuditLogEntry[];
  /** Verify a row (the renderer recomputes the HMAC); results keyed `at|label|target`. */
  onVerify?: (row: SecAuditLogEntry) => void;
  /** Verification outcomes keyed `at|label|target` (NOT `at` — it is second-granular and
   *  repeats across a batch install), set by the renderer. */
  verifyResults?: Record<string, SecVerifyResult>;
  /** Inject a clock for the last-24h filter (tests / SSR determinism). */
  now?: number;
  className?: string;
}

function FilterChip({
  active,
  label,
  onToggle,
}: {
  active: boolean;
  label: string;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      style={{
        paddingInline: "var(--space-4, 8px)",
        paddingBlock: "var(--space-2, 4px)",
        borderRadius: "var(--radius-full, 9999px)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
        background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        cursor: "pointer",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-small-size, 0.8125rem)",
      }}
    >
      {label}
    </button>
  );
}

export function AuditLogView({
  rows,
  onVerify,
  verifyResults = {},
  now,
  className,
}: AuditLogViewProps): ReactElement {
  const [filter, setFilter] = useState<SecAuditFilter>({});
  const visible = filterAuditRows(rows, filter, now);

  const flip = (key: keyof SecAuditFilter): void => setFilter((f) => ({ ...f, [key]: !f[key] }));

  return (
    <div
      className={className}
      style={{ fontFamily: "var(--font-ui)", color: "var(--text-primary)" }}
    >
      <div
        style={{
          display: "flex",
          gap: "var(--space-3, 6px)",
          marginBottom: "var(--space-6, 12px)",
        }}
      >
        <FilterChip
          active={!!filter.forcedOnly}
          label="Forced danger only"
          onToggle={() => flip("forcedOnly")}
        />
        <FilterChip
          active={!!filter.blocksOnly}
          label="Blocks only"
          onToggle={() => flip("blocksOnly")}
        />
        <FilterChip active={!!filter.last24h} label="Last 24h" onToggle={() => flip("last24h")} />
      </div>

      {visible.length === 0 ? (
        <p
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          No audit rows match the current filter.
        </p>
      ) : (
        // Compact one-line rows (NOT an 8-column table that collapses in a narrow
        // column): time · verdict · label · target read left→right and TRUNCATE with a
        // hover title — never wrap one char per line. Minimal vertical space per entry.
        <div
          role="list"
          style={{
            display: "flex",
            flexDirection: "column",
            maxHeight: "clamp(240px, 42vh, 520px)",
            overflowY: "auto",
          }}
        >
          {visible.map((row) => {
            // `at` alone is NOT unique: the engine stamps it with SECOND granularity and a
            // batch install calls the gate audit once per fetched target, so several rows
            // share a timestamp. React then warned about duplicate keys and — worse —
            // `verifyResults[row.at]` showed one row's signature verdict on all of them.
            const rowId = `${row.at}|${row.label}|${row.target}`;
            const result = verifyResults[rowId];
            return (
              <div
                key={rowId}
                role="listitem"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3, 8px)",
                  flexWrap: "wrap",
                  paddingBlock: "var(--space-2, 5px)",
                  borderBottom: "1px solid var(--border-subtle)",
                  fontSize: "var(--text-small-size, 0.8125rem)",
                  lineHeight: 1.3,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                    fontSize: "0.92em",
                  }}
                >
                  {shortDate(row.at)}
                </span>
                <VerdictBadge
                  verdict={toTier(row.verdict)}
                  risk_score={row.risk_score ?? undefined}
                  compact
                />
                <span
                  title={inertText(row.label)}
                  style={{
                    flex: "1 1 110px",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: 500,
                  }}
                >
                  {inertText(row.label)}
                </span>
                <span
                  title={inertText(row.target)}
                  style={{
                    flex: "2 1 150px",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {inertText(row.target)}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {result ? (
                    <span
                      style={{
                        color: result.valid ? "var(--ok)" : "var(--danger)",
                        fontWeight: 600,
                      }}
                      title={
                        result.valid
                          ? "Signature valid"
                          : inertText(result.reason ?? "Signature invalid")
                      }
                    >
                      {result.valid ? "✓ valid" : "✗ invalid"}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onVerify?.(row)}
                      style={{
                        background: "transparent",
                        border: "1px solid var(--border-strong)",
                        borderRadius: "var(--radius-md, 6px)",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        fontFamily: "var(--font-ui)",
                        fontSize: "var(--text-small-size, 0.8125rem)",
                        paddingInline: "var(--space-3, 6px)",
                        paddingBlock: "var(--space-1, 2px)",
                      }}
                    >
                      Verify
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default AuditLogView;
