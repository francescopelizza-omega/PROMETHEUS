/**
 * ide/RunToolbar.tsx — run/debug/stop one click away (APP-034).
 *
 * A slim toolbar the editor route mounts above the editor: config selector,
 * ▸ Run (the SHARED run-session store → the gated APP-032 engine), 🐞 Debug
 * (dispatches `ide:debug-start` — DebugPanel runs its IDENTICAL gate→dapLaunch
 * flow), ■ Stop (kills the live run AND terminates a live DAP session).
 * Disabled states come from the pure `runToolbarState` truth table; a debug
 * session is tracked separately from a plain run.
 *
 * Renderer-SANDBOXED (C5): react + the stores; all spawning lives behind the
 * gated IPC the store/panel already use.
 */

import { Button } from "@prometheus/ui";
import type { ReactElement } from "react";

import { type RunConfig, runToolbarState } from "./state/run-config.js";
import { useRunSessionStore } from "./state/run-session-store.js";

export interface RunToolbarProps {
  configs: RunConfig[];
  selectedIdx: number;
  onSelect(idx: number): void;
  workspaceRoot: string | null;
  /** open the Run&Debug activity (so a toolbar Debug is visible in the panel). */
  onShowDebugPanel(): void;
}

export function RunToolbar({
  configs,
  selectedIdx,
  onSelect,
  workspaceRoot,
  onShowDebugPanel,
}: RunToolbarProps): ReactElement {
  const runId = useRunSessionStore((s) => s.runId);
  const runLabel = useRunSessionStore((s) => s.runLabel);
  const exit = useRunSessionStore((s) => s.exit);
  const dapSessionId = useRunSessionStore((s) => s.dapSessionId);
  const cfg = configs[selectedIdx];
  const st = runToolbarState({
    hasConfig: cfg !== undefined && workspaceRoot !== null,
    runId,
    dapSessionId,
  });

  const run = (): void => {
    if (!cfg || !workspaceRoot) return;
    // startByName resolves compounds, runs each member's before-launch tasks, and
    // honors the compound parallel flag (APP-035) — one gated path for every surface.
    onShowDebugPanel();
    void useRunSessionStore.getState().startByName(cfg.name, configs, workspaceRoot);
  };

  const debug = (): void => {
    if (!cfg || !workspaceRoot) return;
    onShowDebugPanel();
    // DebugPanel mounts with the activity switch; give its listener a beat.
    setTimeout(() => window.dispatchEvent(new CustomEvent("ide:debug-start")), 120);
  };

  const stopAll = (): void => {
    if (runId) void useRunSessionStore.getState().kill();
    if (dapSessionId) window.dispatchEvent(new CustomEvent("ide:debug-stop"));
  };

  return (
    <div
      role="toolbar"
      aria-label="run toolbar"
      style={{
        display: "flex",
        // Wrap rather than clip. The row neither wrapped nor scrolled, so on a narrow
        // editor column the Stop button — the one control you need while something is
        // running — was cut off the right edge. Not `overflowX: auto`: that coerces
        // overflow-y to clip, which TerminalPanel documents as a dropdown hazard.
        flexWrap: "wrap",
        rowGap: 4,
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-surface-2)",
      }}
    >
      <select
        value={selectedIdx}
        onChange={(e) => onSelect(Number(e.target.value))}
        aria-label="toolbar run configuration"
        title="Run/Debug configuration (launch.json)"
        style={{
          background: "var(--bg-inset)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 4,
          padding: "2px 4px",
          fontSize: "0.74rem",
          maxWidth: 200,
          // the config picker gives up width before the buttons do.
          minWidth: 0,
        }}
      >
        {configs.length === 0 && <option value={0}>no run configuration</option>}
        {configs.map((c, i) => (
          <option key={c.name} value={i}>
            {c.type === "compound" ? `${c.name} (compound)` : c.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        disabled={st.runDisabled}
        onClick={run}
        title="Run the selected configuration (gated + resource-guarded)"
      >
        ▸ Run
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={st.debugDisabled}
        onClick={debug}
        title="Debug the selected configuration (gate-first DAP launch)"
      >
        🐞 Debug
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={st.stopDisabled}
        onClick={stopAll}
        title="Stop the running program / debug session"
      >
        ■ Stop
      </Button>
      <span
        style={{
          fontSize: "0.7rem",
          color: "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
          whiteSpace: "nowrap",
        }}
      >
        {runId
          ? `running ${runLabel ?? ""}…`
          : dapSessionId
            ? "debugging…"
            : exit
              ? exit.killed
                ? `${runLabel ?? "run"} stopped`
                : `${runLabel ?? "run"} exited ${exit.exitCode}`
              : ""}
      </span>
    </div>
  );
}

export default RunToolbar;
