// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/workspace.tsx — Repos + Environments + Docs, ONE island (handoff_3 §1/§5).
 *
 * Three rail nouns became three segments. The merge is a NAVIGATION change, not a rewrite of
 * what each surface does: every gated flow (the staged+gated clone, the env install verdict
 * sheet, the typed force confirm) belongs to the segment it came with and is mounted here
 * unchanged. A merge that quietly dropped a security gate would be a far worse regression
 * than nine rail icons.
 *
 * §5 asks for ONE island with a shared header, so the header lives here — the segmented
 * control and the "Clone repo…" action — and each segment paints only its rows. The action is
 * a navigation event rather than a second clone form: the real one is staged, scanned and
 * force-confirmed in routes/repos.tsx, and a second entry point would be a second place for
 * that gate to be got wrong.
 *
 * The segment is latched, not local state, so a persisted `"repos"` activity from before the
 * merge lands on Workspace/Repos rather than on whatever Workspace's default happens to be
 * (see routes/route-tabs.ts).
 */

import { Panel } from "@prometheus/ui";
import { type ReactElement, useEffect, useMemo, useState } from "react";

import { EngineGate } from "../renderer/shell/EngineGate.js";
import { Segmented } from "../renderer/shell/Segmented.js";
import DocsRoute from "./docs.js";
import EnvironmentsRoute from "./environments.js";
import ReposRoute from "./repos.js";
import { type WorkspaceTab, onRouteTab, takeRouteTab } from "./route-tabs.js";
import { requestClone } from "./workspace-view.js";

const OPTIONS: readonly { id: WorkspaceTab; label: string }[] = [
  { id: "repos", label: "Repos" },
  { id: "environments", label: "Environments" },
  { id: "docs", label: "Docs" },
];

export function WorkspaceRoute(): ReactElement {
  // The latch is read ONCE, in the initial state, then cleared — a redirect is a one-shot
  // handoff, so coming back to Workspace later must not re-select the segment it asked for.
  const [tab, setTab] = useState<WorkspaceTab>(() => {
    const latched = takeRouteTab("workspace");
    return (latched as WorkspaceTab) ?? "repos";
  });
  // …and subscribed to for the rest of the mount, for a request that arrives while the route
  // is already up (a Home quick action, a palette command).
  useEffect(() => onRouteTab("workspace", (t) => setTab(t as WorkspaceTab)), []);

  /**
   * §6's degraded wrapper is applied PER SEGMENT, not to the route.
   *
   * `DegradedState` renders the last-known content under `pointerEvents:"none"` — correct for
   * stale data, wrong for navigation. Gating the whole route also froze this segmented
   * control, so with the engine down the user could not reach Docs, which is local markdown
   * and has nothing to do with the engine. Before the §1 merge Docs was its own rail route and
   * stayed usable; the merge quietly took that away.
   */
  const body = useMemo(() => {
    switch (tab) {
      case "environments":
        return (
          <EngineGate>
            <EnvironmentsRoute />
          </EngineGate>
        );
      case "docs":
        return <DocsRoute />;
      default:
        return (
          <EngineGate>
            <ReposRoute />
          </EngineGate>
        );
    }
  }, [tab]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 8px)",
        height: "100%",
        minHeight: 0,
      }}
    >
      <Panel
        elevation="e1"
        title={
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-4, 8px)",
              flexWrap: "wrap", // §7
              minWidth: 0,
            }}
          >
            <span style={{ whiteSpace: "nowrap" }}>Workspace</span>
            <Segmented
              label="Workspace sections"
              options={OPTIONS}
              value={tab}
              onChange={(t: WorkspaceTab) => setTab(t)}
            />
          </span>
        }
        actions={
          <button
            type="button"
            onClick={() => {
              // switch first, then ask: the form lives in the Repos segment, and dispatching
              // before the switch would fire at a component that is not mounted.
              setTab("repos");
              requestClone();
            }}
            style={{
              background: "var(--bg-active)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-md, 6px)",
              color: "var(--text-title)",
              cursor: "pointer",
              fontSize: "0.76rem",
              fontWeight: 600,
              padding: "3px 10px",
              whiteSpace: "nowrap", // §7
            }}
          >
            Clone repo…
          </button>
        }
      >
        {/* minHeight:0 so the segment's own scroll container owns the overflow, not this column */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {body}
        </div>
      </Panel>
    </div>
  );
}

export default WorkspaceRoute;
