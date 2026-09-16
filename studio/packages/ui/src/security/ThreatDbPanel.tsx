/**
 * ThreatDbPanel.tsx — the signature-DB control surface (file 03 §6).
 *
 * Renders a `ThreatDbStatus`: how fresh the threat DB is (fresh / stale / empty /
 * offline), the feeds list, the active ruleset sha, and the verdict-cache count.
 * The load-bearing honesty element is the EMPTY-DB banner: when the DB has no
 * seeded indicators (`blind`), the panel raises a loud "known-malware detection
 * is OFF" warning — a scan that returns `allow` against an empty DB is not a
 * clean bill of health (§6/§11), and the UI must say so.
 *
 * Controls are callbacks: [Refresh now] [Add key] [Clear cache]. A streamed
 * `progress` line (the renderer pipes `nemesis update` output here) renders as
 * inert text in a <pre>. This component decides nothing — it shows engine state.
 */

import type { ReactElement } from "react";
import { Button } from "../components/Button.js";
import { Panel } from "../components/Panel.js";
import type { SecFeedStatus, SecThreatDbStatus } from "./types.js";
import { inertText } from "./util.js";

/** Compute the freshness state for display (engine flags decide; we only label). */
type Freshness = "fresh" | "stale" | "empty" | "offline";

function freshness(status: SecThreatDbStatus): Freshness {
  if (status.error) return "offline";
  if (!status.db.seeded) return "empty";
  if (status.db.stale) return "stale";
  return "fresh";
}

const FRESHNESS_ROLE: Record<Freshness, string> = {
  fresh: "var(--ok)",
  stale: "var(--warn)",
  empty: "var(--danger)",
  offline: "var(--danger)",
};

const FRESHNESS_LABEL: Record<Freshness, string> = {
  fresh: "Fresh",
  stale: "Stale",
  empty: "Empty",
  offline: "Offline",
};

const FEED_GLYPH: Record<SecFeedStatus["state"], string> = {
  active: "●",
  optional: "○",
  "needs-key": "⚠",
  stale: "◐",
  error: "⚠",
};

const FEED_ROLE: Record<SecFeedStatus["state"], string> = {
  active: "var(--ok)",
  optional: "var(--text-secondary)",
  "needs-key": "var(--warn)",
  stale: "var(--warn)",
  error: "var(--danger)",
};

export interface ThreatDbPanelProps {
  status: SecThreatDbStatus;
  /** The parsed feeds list (`nemesis update --list`). */
  feeds?: SecFeedStatus[];
  /** Count of cached verdicts the [Clear cache] button would drop. */
  cachedVerdicts?: number;
  /** Streamed update output to surface in the progress area (inert text). */
  progress?: string;
  onRefresh?: () => void;
  onAddKey?: () => void;
  onClearCache?: () => void;
  className?: string;
}

export function ThreatDbPanel({
  status,
  feeds = [],
  cachedVerdicts,
  progress,
  onRefresh,
  onAddKey,
  onClearCache,
  className,
}: ThreatDbPanelProps): ReactElement {
  const state = freshness(status);
  const stateColor = FRESHNESS_ROLE[state];

  const actions = (
    <>
      <Button size="sm" variant="primary" onClick={onRefresh}>
        Refresh now
      </Button>
      <Button size="sm" variant="secondary" onClick={onAddKey}>
        Add key
      </Button>
      <Button size="sm" variant="ghost" onClick={onClearCache}>
        Clear cache
      </Button>
    </>
  );

  return (
    <Panel className={className} title="Threat database" actions={actions}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6, 12px)" }}>
        {/* freshness pill */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4, 8px)" }}>
          <span
            data-db-state={state}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2, 4px)",
              paddingInline: "var(--space-4, 8px)",
              paddingBlock: "var(--space-1, 2px)",
              borderRadius: "var(--radius-full, 9999px)",
              border: `1px solid ${stateColor}`,
              color: stateColor,
              background: `color-mix(in srgb, ${stateColor} 14%, transparent)`,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              fontWeight: 600,
            }}
          >
            {FRESHNESS_LABEL[state]}
          </span>
          <span
            style={{
              color: "var(--text-secondary)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {status.db.seeded ? `seeded · ${status.db.age_days}d old` : "not seeded"}
          </span>
        </div>

        {/* the loud empty-DB "detection OFF" banner (§6) */}
        {status.blind && (
          <div
            role="alert"
            style={{
              padding: "var(--space-4, 8px)",
              border: "2px solid var(--danger)",
              borderRadius: "var(--radius-md, 6px)",
              background: "color-mix(in srgb, var(--danger) 12%, transparent)",
              color: "var(--danger)",
              fontWeight: 600,
            }}
          >
            <span aria-hidden="true">⛔ </span>
            Signature DB is empty — known-malware detection is OFF. A scan cannot find known threats
            until you refresh the database.
          </div>
        )}

        {status.error && (
          <p
            style={{
              margin: 0,
              color: "var(--danger)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            {inertText(status.error)}
          </p>
        )}

        {/* feeds list */}
        {feeds.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}>
            {feeds.map((feed) => (
              <div
                key={feed.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3, 6px)",
                  fontSize: "var(--text-small-size, 0.8125rem)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <span aria-hidden="true" style={{ color: FEED_ROLE[feed.state] }}>
                  {FEED_GLYPH[feed.state]}
                </span>
                <span style={{ minWidth: "10rem" }}>{inertText(feed.label)}</span>
                {feed.fetched && (
                  <span style={{ color: "var(--text-secondary)" }}>{inertText(feed.fetched)}</span>
                )}
                {feed.count && (
                  <span style={{ color: "var(--text-secondary)", marginLeft: "auto" }}>
                    {inertText(feed.count)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ruleset sha + cache count */}
        <div
          style={{
            display: "flex",
            gap: "var(--space-8, 16px)",
            flexWrap: "wrap",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <span>ruleset {inertText(status.rulesetSha) || "—"}</span>
          {typeof cachedVerdicts === "number" && <span>{cachedVerdicts} cached verdicts</span>}
        </div>

        {/* streamed progress (inert) */}
        {typeof progress === "string" && progress.length > 0 && (
          <pre
            aria-live="polite"
            style={{
              margin: 0,
              maxHeight: "10rem",
              overflow: "auto",
              padding: "var(--space-4, 8px)",
              background: "var(--bg-inset)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md, 6px)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-code-size, 0.78125rem)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {inertText(progress)}
          </pre>
        )}
      </div>
    </Panel>
  );
}

export default ThreatDbPanel;
