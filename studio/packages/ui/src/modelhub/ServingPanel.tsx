// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ServingPanel.tsx — the §7 Serving panel: a ServeProfile list with status chips
 * + Start/Stop/"Use in IDE" → repoint. Each row shows the reproducible recipe
 * (runner · 127.0.0.1:port/v1 · ctx · ngl) + its live status (the four §2.4
 * states the MAIN-process C8 ServerSupervisor reports). Once a profile is `ready`,
 * "Use in IDE" repoints the IDE agent pane at its base-URL (key: local).
 *
 * SANDBOXED + C5: imports only react + this package. It NEVER spawns — the runner
 * is supervised by the MAIN process; this is a pure projection of the
 * status the supervisor reported. Engine strings run through `inert()`. Actions
 * are PROPS (onStart / onStop / onUseInIde / onEndpoint / onRetry) — no IPC here.
 */

import type { ReactElement } from "react";

import type { ServeProfileData } from "./types.js";
import {
  type ServeRowStatus,
  inert,
  roleVar,
  serveActions,
  serveGlyph,
  serveLabel,
  serveRole,
} from "./util.js";

export interface ServingPanelProps {
  profiles: ServeProfileData[];
  /** start a stopped/errored profile (the MAIN supervisor spawns + polls /v1/models). */
  onStart?: (id: string) => void;
  /** stop a starting/ready profile (SIGTERM the runner via the supervisor). */
  onStop?: (id: string) => void;
  /** force-kill a starting/ready/errored profile (SIGKILL now, no grace wait) —
   *  "if something is not responding properly". */
  onKill?: (id: string) => void;
  /** retry a failed launch. */
  onRetry?: (id: string) => void;
  /** "Use in IDE" → repoint the IDE agent pane at this profile's base-URL (§6). */
  onUseInIde?: (profile: ServeProfileData) => void;
  /** show / copy the endpoint (the open-weight-API "Endpoint" action). */
  onEndpoint?: (profile: ServeProfileData) => void;
  /** surface the runner's live log feed (the §5.4 serving-row [ logs ] action). */
  onLogs?: (id: string) => void;
}

function StatusChip({ status }: { status: ServeRowStatus }): ReactElement {
  const role = serveRole(status);
  return (
    <span
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        color: roleVar(role),
        fontFamily: "var(--font-mono)",
        fontSize: "0.78rem",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{serveGlyph(status)}</span>
      <span>{serveLabel(status)}</span>
    </span>
  );
}

function Row({
  p,
  onStart,
  onStop,
  onKill,
  onRetry,
  onUseInIde,
  onEndpoint,
  onLogs,
}: {
  p: ServeProfileData;
  onStart?: (id: string) => void;
  onStop?: (id: string) => void;
  onKill?: (id: string) => void;
  onRetry?: (id: string) => void;
  onUseInIde?: (profile: ServeProfileData) => void;
  onEndpoint?: (profile: ServeProfileData) => void;
  onLogs?: (id: string) => void;
}): ReactElement {
  const status = p.status as ServeRowStatus;
  const actions = p.external ? ["use", "endpoint"] : serveActions(status);
  // Defensive: a serve row is an opaque IPC cast — a partial/external profile may
  // omit args/endpoint; degrade gracefully instead of crashing the Serving panel.
  const ngl = p.args?.gpuLayers;
  const tp = p.args?.tensorParallel;
  return (
    <li
      data-status={p.status}
      data-external={p.external ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "8px 10px",
        borderRadius: "var(--radius-md, 6px)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3, 6px)",
          flexWrap: "wrap",
        }}
      >
        <StatusChip status={status} />
        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{inert(p.id)}</span>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.78rem" }}>
          {inert(p.runner)}
        </span>
        <span
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.76rem",
          }}
        >
          {inert(p.endpoint?.baseUrl ?? "")}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          gap: "var(--space-3, 6px)",
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          flexWrap: "wrap",
        }}
      >
        {p.external ? (
          <span>external — open-weight API</span>
        ) : (
          <>
            <span>ctx {p.args?.ctxLen}</span>
            {typeof ngl === "number" && <span>· ngl {ngl}</span>}
            {typeof tp === "number" && tp > 1 && <span>· tp {tp}</span>}
            <span>· key {inert(p.apiKey)}</span>
          </>
        )}
      </div>

      {status === "error" && p.lastError && (
        <span style={{ color: "var(--danger)", fontSize: "0.72rem" }}>{inert(p.lastError)}</span>
      )}

      {/* §7 row actions (PROPS only) */}
      <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
        {actions.includes("start") && onStart && (
          <button type="button" onClick={() => onStart(p.id)} style={primaryBtn}>
            Start
          </button>
        )}
        {actions.includes("stop") && onStop && (
          <button type="button" onClick={() => onStop(p.id)} style={ghostBtn}>
            Stop
          </button>
        )}
        {actions.includes("kill") && onKill && (
          <button
            type="button"
            onClick={() => onKill(p.id)}
            style={dangerBtn}
            title="Force-kill: SIGKILL now, skips the graceful-stop wait"
          >
            Kill
          </button>
        )}
        {onLogs && !p.external && (
          <button type="button" onClick={() => onLogs(p.id)} style={ghostBtn}>
            Logs
          </button>
        )}
        {actions.includes("retry") && onRetry && (
          <button type="button" onClick={() => onRetry(p.id)} style={ghostBtn}>
            Retry
          </button>
        )}
        {actions.includes("use") && onUseInIde && (
          <button
            type="button"
            onClick={() => onUseInIde(p)}
            style={status === "ready" || p.external ? primaryBtn : ghostBtn}
            disabled={status !== "ready" && !p.external}
          >
            Use in IDE
          </button>
        )}
        {actions.includes("endpoint") && onEndpoint && (
          <button type="button" onClick={() => onEndpoint(p)} style={ghostBtn}>
            Endpoint
          </button>
        )}
      </div>
    </li>
  );
}

export function ServingPanel({
  profiles,
  onStart,
  onStop,
  onKill,
  onRetry,
  onUseInIde,
  onEndpoint,
  onLogs,
}: ServingPanelProps): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
      {profiles.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
          No serve profiles. Download a model and press “Serve” to create one.
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
          {profiles.map((p) => (
            <Row
              key={p.id}
              p={p}
              onStart={onStart}
              onStop={onStop}
              onKill={onKill}
              onRetry={onRetry}
              onUseInIde={onUseInIde}
              onEndpoint={onEndpoint}
              onLogs={onLogs}
            />
          ))}
        </ul>
      )}
      <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem", margin: 0 }}>
        “Use in IDE” repoints the IDE agent pane at the base-URL (key: local). Paid tools: localai
        audit ▸
      </p>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  // `--on-accent` is the computed label colour for the `--accent` FILL (tokens/contrast.ts `onFill`).
  // The old `--brand-fg` here was WHITE on the dark scheme over a saturated light fill (~2:1),
  // and a plain `--bg-app` would be near-white over the same fill on the LIGHT scheme.
  color: "var(--on-accent)",
  borderRadius: "var(--radius-md, 6px)",
  padding: "4px 10px",
  fontSize: "0.8rem",
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  border: "1px solid var(--border-subtle)",
  background: "transparent",
  color: "var(--text-primary)",
  borderRadius: "var(--radius-md, 6px)",
  padding: "4px 10px",
  fontSize: "0.8rem",
  cursor: "pointer",
};

const dangerBtn: React.CSSProperties = {
  border: "1px solid var(--danger)",
  background: "transparent",
  color: "var(--danger-fg, var(--danger))",
  borderRadius: "var(--radius-md, 6px)",
  padding: "4px 10px",
  fontSize: "0.8rem",
  cursor: "pointer",
};

export default ServingPanel;
