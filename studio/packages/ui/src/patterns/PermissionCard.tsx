/**
 * patterns/PermissionCard.tsx — the pre-write authorisation card (handoff §3).
 *
 * "Before ANY disk/network/engine write." This is the SINGLE VISIBLE authorisation
 * surface — and it is exactly that: visible. It does not enforce anything. The
 * applier's scope guard stays on regardless of what the user clicks here, because a
 * UI that is the only thing standing between a model and the filesystem is the
 * 08-07 regression waiting to happen again.
 *
 * The card shows what a person needs to decide with:
 *   - the EXACT absolute path (mono, break-all — never a basename);
 *   - a scope line: "inside working set · new file · 4 lines", or a danger-tinted
 *     "OUTSIDE working set" when the target escapes the roots;
 *   - the authorisation level in force (`A{n}`), so the decision is read in context;
 *   - Allow once (gradient) / This session / Deny.
 *
 * Presentational only — the host owns the decision and the guard (08 §6/C5).
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";

/** What the pending action would do. Drives the header wording only. */
export type PermissionKind = "write file" | "delete file" | "run command" | "network" | "install";

export interface PermissionCardProps {
  kind: PermissionKind;
  /** the EXACT absolute path (or command / URL) the action targets. */
  target: string;
  /** whether the target is inside the workspace roots — a false here is the loud case. */
  insideWorkingSet: boolean;
  /** "new file" / "modify" / "delete" — the second scope clause. */
  change?: string;
  /** e.g. "4 lines" — the third scope clause. */
  magnitude?: string;
  /** the authorisation level in force, rendered as `A{n}` in the header. */
  authLevel?: number;
  /** the token var name that tints `A{n}` (from the renderer's auth ladder). */
  authVar?: string;
  onAllowOnce(): void;
  /** grant for the rest of this session (still re-checked by the applier guard). */
  onAllowSession(): void;
  onDeny(): void;
  /** extra context under the scope line (e.g. a diff summary). */
  children?: ReactNode;
  className?: string;
}

export function PermissionCard({
  kind,
  target,
  insideWorkingSet,
  change,
  magnitude,
  authLevel,
  authVar = "--accent",
  onAllowOnce,
  onAllowSession,
  onDeny,
  children,
  className,
}: PermissionCardProps): ReactElement {
  const scope = [insideWorkingSet ? "inside working set" : "OUTSIDE working set", change, magnitude]
    .filter(Boolean)
    .join(" · ");
  return (
    <section
      className={className}
      aria-label={`Permission required — ${kind}`}
      style={{
        borderRadius: 11,
        border: "1px solid color-mix(in srgb, var(--warn) 40%, transparent)",
        background: "color-mix(in srgb, var(--warn) 6%, transparent)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 11px",
          borderBottom: "1px solid color-mix(in srgb, var(--warn) 20%, transparent)",
        }}
      >
        <span aria-hidden="true" style={{ color: "var(--warn)", fontSize: 12 }}>
          🛡
        </span>
        <span style={{ fontWeight: 600, fontSize: 12, color: "var(--warn)" }}>
          Permission — {kind}
        </span>
        <span style={{ flex: 1 }} />
        {typeof authLevel === "number" && (
          <span
            style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: `var(${authVar})` }}
            title="the authorisation level in force"
          >
            A{authLevel}
          </span>
        )}
      </header>
      <div style={{ padding: "9px 11px", display: "flex", flexDirection: "column", gap: 7 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-primary)",
            wordBreak: "break-all",
          }}
        >
          {target}
        </span>
        <span
          style={{
            fontSize: 11,
            // out-of-scope is the one thing on this card that must never read calm.
            color: insideWorkingSet ? "var(--ok)" : "var(--danger-fg)",
            fontWeight: insideWorkingSet ? 400 : 600,
          }}
        >
          {scope}
        </span>
        {children}
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={onAllowOnce} style={gradientBtn()}>
            Allow once
          </button>
          <button type="button" onClick={onAllowSession} style={neutralBtn()}>
            This session
          </button>
          <button type="button" onClick={onDeny} style={denyBtn()}>
            Deny
          </button>
        </div>
      </div>
    </section>
  );
}

function gradientBtn(): CSSProperties {
  return {
    flex: 1,
    textAlign: "center",
    padding: "5px 0",
    borderRadius: 7,
    border: "none",
    background: "var(--gradient-brand)",
    color: "var(--brand-fg)",
    fontFamily: "var(--font-ui)",
    fontSize: 11.5,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function neutralBtn(): CSSProperties {
  return {
    flex: 1,
    textAlign: "center",
    padding: "5px 0",
    borderRadius: 7,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    color: "var(--text-title)",
    fontFamily: "var(--font-ui)",
    fontSize: 11.5,
    cursor: "pointer",
  };
}

function denyBtn(): CSSProperties {
  return {
    textAlign: "center",
    padding: "5px 10px",
    borderRadius: 7,
    background: "transparent",
    border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
    color: "var(--danger-fg)",
    fontFamily: "var(--font-ui)",
    fontSize: 11.5,
    cursor: "pointer",
  };
}

export default PermissionCard;
