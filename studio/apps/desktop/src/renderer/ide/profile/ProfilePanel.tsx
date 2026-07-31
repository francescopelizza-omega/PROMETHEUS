/**
 * ProfilePanel.tsx — the Profiler bottom-tab container (APP-047, extended APP-089).
 *
 * Owns ALL profiler state + the ide.profile IPC (mirrors the SqlConsole/DatabasePanel
 * split): a "Profile current file" run over the active editor's .py doc in one of three
 * MODES (cpu | memory | async), the fold tree, zoom/search, a top-down⇄bottom-up view
 * toggle, snapshot save, and a saved-snapshot COMPARE that renders a signed delta tree.
 * FlameView stays presentational — this passes it the (possibly zoomed / inverted / delta)
 * root + unit + a signed flag.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the tabs store + window.prometheus.
 * Profiling EXECUTES the target, so the run is gated in MAIN (APP-046) — the renderer only
 * renders the result. Snapshots persist under the MAIN-owned app-data dir (never a renderer
 * path). Degrades to a notice when the profiler IPC is absent (never a synthetic tree).
 */
import { Button } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import type {
  IdeProfileMode,
  IdeProfileSample,
  IdeProfileSnapshotMeta,
} from "../../../shared/ipc-contract.js";
import { useTabsStore } from "../state/stores.js";
import { activeDoc } from "../state/tabs-reducer.js";
import { FlameView } from "./FlameView.js";
import {
  type FlameNode,
  flameSamplesToTree,
  formatProfileValue,
  invertBottomUp,
  matchesFlame,
  zoomTo,
} from "./profile-view.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** `file:///a/b/x.py` → `/a/b/x.py`; passthrough for a bare path. */
function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

const MODES: { id: IdeProfileMode; label: string }[] = [
  { id: "cpu", label: "CPU" },
  { id: "memory", label: "Memory" },
  { id: "async", label: "Async" },
];

interface DeltaState {
  root: FlameNode;
  unit: string;
  summary?: {
    regressions: { name: string; delta: number }[];
    improvements: { name: string; delta: number }[];
  };
}

export function ProfilePanel(): ReactElement {
  const tabs = useTabsStore((s) => s.tabs);
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const active = activeDoc(tabs, tabs.focusedGroup);

  const [mode, setMode] = useState<IdeProfileMode>("cpu");
  const [root, setRoot] = useState<FlameNode | undefined>(undefined);
  const [unit, setUnit] = useState<string>("us");
  const [lastSamples, setLastSamples] = useState<IdeProfileSample[]>([]);
  const [lastTotal, setLastTotal] = useState<number>(0);
  const [bottomUp, setBottomUp] = useState(false);
  const [zoomPath, setZoomPath] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [snapshots, setSnapshots] = useState<IdeProfileSnapshotMeta[]>([]);
  const [baseId, setBaseId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [delta, setDelta] = useState<DeltaState | null>(null);

  const isPy = !!active && active.uri.endsWith(".py");
  const hasProfiler = !!ide()?.profile;

  const refreshSnapshots = useCallback(async (): Promise<void> => {
    const api = ide();
    if (!api?.profile) return;
    const res = await api.profile.snapshotList().catch(() => undefined);
    if (res?.ok) setSnapshots(res.snapshots ?? []);
  }, []);

  useEffect(() => {
    void refreshSnapshots();
  }, [refreshSnapshots]);

  // the displayed tree: a delta (compare) wins; else the zoomed OR bottom-up-inverted run.
  const displayRoot = useMemo(() => {
    if (delta) return delta.root;
    if (!root) return undefined;
    return bottomUp ? invertBottomUp(root) : zoomTo(root, zoomPath);
  }, [delta, root, bottomUp, zoomPath]);
  const highlight = useMemo(
    () => (displayRoot && !delta ? matchesFlame(displayRoot, query) : new Set<string>()),
    [displayRoot, query, delta],
  );

  const run = async (): Promise<void> => {
    const api = ide();
    if (!api?.profile || !active || !workspaceRoot) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    setDelta(null);
    try {
      const res = await api.profile
        .start({ path: uriToPath(active.uri), workspaceRoot, mode })
        .catch((e) => ({ ok: false as const, error: String(e) }));
      if (!res.ok) {
        setError(res.error ?? "profile failed");
        return;
      }
      const samples = res.samples ?? [];
      setLastSamples(samples);
      setLastTotal(res.totalUs ?? 0);
      setUnit(res.unit ?? "us");
      setRoot(flameSamplesToTree(samples));
      setZoomPath([]);
      setSelected(undefined);
      if (res.note) setInfo(res.note);
      else if (res.timedOut) setInfo("partial profile (wall-clock cap hit)");
    } finally {
      setBusy(false);
    }
  };

  const stop = (): void => {
    void ide()?.profile?.stop();
    setBusy(false);
  };

  const saveSnapshot = async (): Promise<void> => {
    const api = ide();
    if (!api?.profile || lastSamples.length === 0) return;
    const name = `${mode}-${active?.name ?? "profile"}`;
    const res = await api.profile
      .snapshotSave({ name, mode, unit, samples: lastSamples, totalValue: lastTotal })
      .catch(() => undefined);
    if (res?.ok) {
      setInfo(`saved snapshot ${res.id ?? ""}`.trim());
      await refreshSnapshots();
    } else {
      setError(res?.error ?? "snapshot save failed");
    }
  };

  const runCompare = async (): Promise<void> => {
    const api = ide();
    if (!api?.profile || !baseId || !targetId) return;
    setError(null);
    const res = await api.profile.compare({ aId: baseId, bId: targetId }).catch(() => undefined);
    if (!res?.ok) {
      setError(res?.error ?? "compare failed");
      return;
    }
    setDelta({
      root: flameSamplesToTree(res.samples ?? [], "Δ"),
      unit: res.unit ?? "us",
      ...(res.summary ? { summary: res.summary } : {}),
    });
    setSelected(undefined);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "var(--space-2, 4px)",
          padding: "var(--space-2, 4px) var(--space-3, 6px)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        {/* mode selector */}
        <div style={{ display: "flex", gap: "var(--space-1, 2px)" }}>
          {MODES.map((m) => (
            <Button
              key={m.id}
              variant={mode === m.id ? "primary" : "ghost"}
              aria-pressed={mode === m.id}
              onClick={() => setMode(m.id)}
              disabled={busy}
            >
              {m.label}
            </Button>
          ))}
        </div>
        {busy ? (
          <Button variant="secondary" onClick={stop}>
            ⏹ Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void run()} disabled={!hasProfiler || !isPy}>
            ▶ Profile
          </Button>
        )}
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            fontFamily: "var(--font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 180,
          }}
        >
          {active ? (isPy ? active.name : "select a .py file") : "no file open"}
        </span>
        <span style={{ flex: 1 }} />
        {/* view direction + save */}
        <Button
          variant={bottomUp ? "primary" : "ghost"}
          aria-pressed={bottomUp}
          disabled={!root || !!delta}
          title="toggle top-down ⇄ bottom-up (callee-rooted) call tree"
          onClick={() => setBottomUp((v) => !v)}
        >
          {bottomUp ? "▽ Bottom-up" : "△ Top-down"}
        </Button>
        <Button
          variant="ghost"
          disabled={lastSamples.length === 0}
          onClick={() => void saveSnapshot()}
        >
          ⭳ Save snapshot
        </Button>
        {zoomPath.length > 0 && !delta && (
          <Button variant="secondary" onClick={() => setZoomPath([])}>
            ⤢ Reset zoom
          </Button>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="search functions"
          aria-label="search functions"
          disabled={!!delta}
          style={{
            background: "var(--bg-app)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "2px 6px",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        />
      </div>

      {/* compare row: pick two saved snapshots → a signed delta tree */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "var(--space-2, 4px)",
          padding: "var(--space-1, 2px) var(--space-3, 6px)",
          borderBottom: "1px solid var(--border-subtle)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          color: "var(--text-secondary)",
        }}
      >
        <span>Compare</span>
        <SnapshotSelect
          label="base (A)"
          value={baseId}
          snapshots={snapshots}
          onChange={setBaseId}
        />
        <span>→</span>
        <SnapshotSelect
          label="target (B)"
          value={targetId}
          snapshots={snapshots}
          onChange={setTargetId}
        />
        <Button variant="ghost" disabled={!baseId || !targetId} onClick={() => void runCompare()}>
          ⇄ Compare
        </Button>
        {delta && (
          <Button variant="secondary" onClick={() => setDelta(null)}>
            ✕ Back to live
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => void refreshSnapshots()}
          title="refresh snapshot list"
        >
          ↻
        </Button>
      </div>

      {(error || info || !hasProfiler || (zoomPath.length > 0 && !delta) || !!delta) && (
        <div
          style={{
            padding: "var(--space-1, 2px) var(--space-3, 6px)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            color: error ? "var(--danger)" : "var(--text-secondary)",
          }}
        >
          {!hasProfiler
            ? "profiler backend unavailable"
            : error
              ? error
              : delta
                ? `delta (B − A), unit ${delta.unit} · ${delta.summary?.regressions.length ?? 0} regressions · ${delta.summary?.improvements.length ?? 0} improvements`
                : zoomPath.length > 0
                  ? `zoomed: all › ${zoomPath.join(" › ")}`
                  : info}
        </div>
      )}

      {/* compare summary: top regressions (danger) + improvements (ok) */}
      {delta?.summary && (
        <div
          style={{
            display: "flex",
            gap: "var(--space-4, 12px)",
            flexWrap: "wrap",
            padding: "var(--space-1, 2px) var(--space-3, 6px)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <DeltaList
            title="regressions"
            tone="danger"
            entries={delta.summary.regressions}
            unit={delta.unit}
          />
          <DeltaList
            title="improvements"
            tone="ok"
            entries={delta.summary.improvements}
            unit={delta.unit}
          />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--space-2, 4px)" }}>
        <FlameView
          root={displayRoot}
          selectedName={selected}
          onSelect={setSelected}
          onZoom={(path) =>
            !delta && !bottomUp && path.length > 0 && setZoomPath([...zoomPath, ...path])
          }
          highlightNames={highlight}
          unit={delta ? delta.unit : unit}
          signed={!!delta}
        />
      </div>
    </div>
  );
}

function SnapshotSelect({
  label,
  value,
  snapshots,
  onChange,
}: {
  label: string;
  value: string;
  snapshots: readonly IdeProfileSnapshotMeta[];
  onChange: (id: string) => void;
}): ReactElement {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.currentTarget.value)}
      style={{
        background: "var(--bg-app)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm, 4px)",
        padding: "2px 6px",
        fontSize: "var(--text-small-size, 0.8125rem)",
        maxWidth: 200,
      }}
    >
      <option value="">{label}…</option>
      {snapshots.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} ({s.mode})
        </option>
      ))}
    </select>
  );
}

function DeltaList({
  title,
  tone,
  entries,
  unit,
}: {
  title: string;
  tone: "danger" | "ok";
  entries: { name: string; delta: number }[];
  unit: string;
}): ReactElement {
  return (
    <div>
      <div style={{ color: `var(--${tone})` }}>{title}</div>
      {entries.length === 0 ? (
        <div style={{ color: "var(--text-disabled)" }}>none</div>
      ) : (
        entries.slice(0, 5).map((e) => (
          <div key={e.name} style={{ color: "var(--text-secondary)" }}>
            {e.name}{" "}
            <span style={{ color: `var(--${tone})` }}>{formatProfileValue(e.delta, unit)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export default ProfilePanel;
