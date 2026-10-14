// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * DiskSpacePanel — where the disk went: a treemap / pie / levels / largest files / filesystems,
 * the folder list behind them, and copy · reveal · Trash · delete on a selected item.
 *
 * Renderer-only: `window.prometheus.diskSpace` + tokens (no node, no core, no raw hex). Every
 * number comes from the disk_map sidecar in main, which never runs as root.
 *
 *  - **Delete is plan-first.** Trash or Delete opens the plan (risk, size, anything refused and
 *    why); only the dialog's explicit button deletes, and a high-risk plan also needs "yes"
 *    typed. The sidecar re-checks every protection at that moment.
 *  - **Rescan as root** goes through the privileged gate: the approval dialog shows the exact
 *    root command, and the password goes to a native dialog, straight to sudo.
 *  - **Charts** follow the validated chart tokens: the pie's slices are `--chart-1..7` in fixed
 *    order plus "Other"; the treemap is one hue by size. The table always carries the same
 *    numbers in text, so no value depends on colour.
 */
import { Button, Panel, Spinner, Z, useFocusTrap } from "@prometheus/ui";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DiskDeleteModeView,
  DiskDeletePlanView,
  DiskFilesView,
  DiskLevelsView,
  DiskMapView,
  DiskMountsView,
} from "../../shared/ipc-contract.js";
import {
  type Row,
  childRows,
  findNode,
  formatBytes,
  parentPath,
  seqFill,
  sliceVar,
  topSlices,
} from "./disk-space/disk-space-view.js";
import { pieSlices } from "./disk-space/pie.js";
import { squarify } from "./disk-space/treemap.js";

type View = "treemap" | "pie" | "levels" | "files" | "mounts";
const VIEWS: readonly { id: View; label: string }[] = [
  { id: "treemap", label: "Treemap" },
  { id: "pie", label: "Pie" },
  { id: "levels", label: "Levels" },
  { id: "files", label: "Largest files" },
  { id: "mounts", label: "Filesystems" },
];

const small: CSSProperties = { fontSize: "var(--text-small-size, 0.8125rem)" };
const muted: CSSProperties = { ...small, color: "var(--text-secondary)" };
const mono: CSSProperties = { fontFamily: "var(--font-mono)", ...small };

function Bar({ share }: { share: number }): ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 80,
        height: 6,
        borderRadius: 3,
        background: "var(--bg-inset)",
        overflow: "hidden",
        verticalAlign: "middle",
      }}
    >
      <span
        style={{
          display: "block",
          width: `${Math.max(0, Math.min(100, share * 100))}%`,
          height: "100%",
          background: "var(--chart-1)",
          borderRadius: 3,
        }}
      />
    </span>
  );
}

const api = () => window.prometheus.diskSpace;

export function DiskSpacePanel(): ReactElement {
  const [path, setPath] = useState("~");
  const [view, setView] = useState<View>("treemap");
  const [map, setMap] = useState<DiskMapView | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [levels, setLevels] = useState<DiskLevelsView | null>(null);
  const [files, setFiles] = useState<DiskFilesView | null>(null);
  const [mounts, setMounts] = useState<DiskMountsView | null>(null);
  const [plan, setPlan] = useState<{ view: DiskDeletePlanView; paths: string[] } | null>(null);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    setErr(null);
    try {
      return await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const scan = useCallback(
    async (asRoot = false) => {
      const r = await run(asRoot ? "Waiting for your approval…" : "Scanning…", () =>
        asRoot ? api().rescanAsRoot({ path }) : api().map({ path }),
      );
      if (!r) return;
      if (!r.ok || !r.tree) {
        setErr(r.error ?? "the scan failed");
        return;
      }
      setMap(r);
      setFocus(r.tree.path);
      setSelected(null);
      setLevels(null);
      setFiles(null);
      setNote(r.asRoot ? "measured as root" : null);
    },
    [path, run],
  );

  const show = useCallback(
    async (v: View) => {
      setView(v);
      if (v === "levels" && !levels) {
        const r = await run("Measuring levels…", () => api().levels({ path: focus ?? path }));
        if (r) r.ok ? setLevels(r) : setErr(r.error ?? "failed");
      } else if (v === "files" && !files) {
        const r = await run("Finding the largest files…", () =>
          api().files({ path: focus ?? path }),
        );
        if (r) r.ok ? setFiles(r) : setErr(r.error ?? "failed");
      } else if (v === "mounts" && !mounts) {
        const r = await run("Reading filesystems…", () => api().mounts());
        if (r) r.ok ? setMounts(r) : setErr(r.error ?? "failed");
      }
    },
    [focus, path, levels, files, mounts, run],
  );

  const focusNode = useMemo(
    () => (map?.tree ? ((focus ? findNode(map.tree, focus) : undefined) ?? map.tree) : undefined),
    [map, focus],
  );
  const rows = useMemo(() => (focusNode ? childRows(focusNode) : []), [focusNode]);
  const up = map?.tree && focus ? parentPath(map.tree, focus) : undefined;

  const drill = (r: Row): void => {
    if (r.dir) {
      setFocus(r.path);
      setSelected(null);
      setLevels(null);
      setFiles(null);
    }
  };

  const startDelete = async (mode: DiskDeleteModeView): Promise<void> => {
    if (!selected) return;
    const paths = [selected.rawPath ?? selected.path];
    const r = await run("Planning…", () => api().deletePlan({ paths, mode }));
    if (!r) return;
    if (!r.ok) {
      setErr(r.error ?? "could not plan the delete");
      return;
    }
    setTyped("");
    setPlan({ view: r, paths });
  };

  const closePlan = useCallback(() => setPlan(null), []);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, plan !== null, closePlan, { deferTabToTextFields: true });

  const confirmDelete = async (): Promise<void> => {
    if (!plan || !plan.view.mode) return;
    const ack = plan.view.requiresPhrase === true;
    if (ack && typed.trim() !== "yes") return;
    const { paths } = plan;
    const mode = plan.view.mode;
    setPlan(null);
    const r = await run(mode === "trash" ? "Moving to the Trash…" : "Deleting…", () =>
      api().delete({ paths, mode, confirm: true, ackHighRisk: ack }),
    );
    if (!r) return;
    const failed = (r.results ?? []).filter((x) => !x.ok);
    setNote(
      r.ok
        ? mode === "trash"
          ? "moved to the Trash"
          : "deleted"
        : failed.map((x) => `${x.path}: ${x.msg}`).join(" · ") || r.error || "nothing was deleted",
    );
    if (r.ok) await scan(false);
  };

  const runnable = (plan?.view.items ?? []).filter((i) => !i.protected);
  const canConfirm =
    plan !== null && runnable.length > 0 && (!plan.view.requiresPhrase || typed.trim() === "yes");

  return (
    <Panel title="Disk space" elevation="e0">
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--space-4, 8px)",
          alignItems: "center",
        }}
      >
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void scan(false);
          }}
          aria-label="folder to measure"
          spellCheck={false}
          style={{ ...mono, flex: "1 1 220px", minWidth: 0 }}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={busy !== null}
          onClick={() => void scan(false)}
        >
          Scan
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          title="measure folders your user cannot read — you approve the exact root command first"
          onClick={() => void scan(true)}
        >
          Rescan as root…
        </Button>
        {busy ? (
          <span style={muted}>
            <Spinner size={14} /> {busy}
          </span>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="disk space views"
        style={{ display: "flex", gap: 4, margin: "var(--space-4, 8px) 0" }}
      >
        {VIEWS.map((v) => (
          <Button
            key={v.id}
            size="sm"
            variant={view === v.id ? "primary" : "ghost"}
            role="tab"
            aria-selected={view === v.id}
            onClick={() => void show(v.id)}
          >
            {v.label}
          </Button>
        ))}
      </div>

      {err ? <p style={{ ...small, color: "var(--danger)" }}>{err}</p> : null}
      {note ? <p style={muted}>{note}</p> : null}

      {focusNode && (view === "treemap" || view === "pie") ? (
        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--space-4, 8px)", ...small }}
        >
          {up ? (
            <Button size="sm" variant="ghost" onClick={() => setFocus(up)}>
              ↑ Up
            </Button>
          ) : null}
          <span
            style={{
              ...mono,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {focusNode.path}
          </span>
          <span style={muted}>{formatBytes(focusNode.size)}</span>
          {map?.summary?.unreadable ? (
            <span style={muted}>
              · {map.summary.unreadable} unreadable — Rescan as root measures them
            </span>
          ) : null}
        </div>
      ) : null}

      {view === "treemap" && focusNode ? (
        <Treemap
          rows={rows}
          total={focusNode.size}
          hover={hover}
          onHover={setHover}
          onPick={setSelected}
          onDrill={drill}
        />
      ) : null}
      {view === "pie" && focusNode ? (
        <Pie node={focusNode.children ?? []} hover={hover} onHover={setHover} />
      ) : null}
      {view === "levels" && levels?.levels ? <Levels levels={levels.levels} /> : null}
      {view === "files" && files?.files ? <Files files={files.files} /> : null}
      {view === "mounts" && mounts?.mounts ? <Mounts mounts={mounts.mounts} /> : null}

      {(view === "treemap" || view === "pie") && rows.length > 0 ? (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: "var(--space-4, 8px)",
            ...small,
          }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th>name</th>
              <th style={{ textAlign: "right" }}>size</th>
              <th style={{ textAlign: "right" }}>%</th>
              <th />
              <th style={{ textAlign: "right" }}>items</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.path}
                tabIndex={0}
                onClick={() => setSelected(r)}
                onDoubleClick={() => drill(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") drill(r);
                  else if (e.key === " ") {
                    e.preventDefault();
                    setSelected(r);
                  }
                }}
                onMouseEnter={() => setHover(r.path)}
                onMouseLeave={() => setHover(null)}
                aria-selected={selected?.path === r.path}
                style={{
                  cursor: "pointer",
                  background:
                    selected?.path === r.path
                      ? "var(--selection)"
                      : hover === r.path
                        ? "var(--bg-active)"
                        : "transparent",
                }}
              >
                <td style={{ ...mono, minWidth: 0 }}>
                  {r.name}
                  {r.dir ? "/" : ""}
                  {r.note ? <span style={muted}> ({r.note})</span> : null}
                </td>
                <td style={{ textAlign: "right" }}>{formatBytes(r.size)}</td>
                <td style={{ textAlign: "right" }}>{r.pct.toFixed(1)}%</td>
                <td>
                  <Bar share={r.pct / 100} />
                </td>
                <td style={{ textAlign: "right" }}>{r.items ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {selected ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginTop: "var(--space-4, 8px)",
            alignItems: "center",
          }}
        >
          <span
            style={{
              ...mono,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: "1 1 200px",
            }}
          >
            {selected.path}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigator.clipboard?.writeText(selected.path)}
          >
            ⧉ Copy path
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void window.prometheus.revealPath(selected.path)}
          >
            Reveal
          </Button>
          {selected.dir ? (
            <Button size="sm" variant="ghost" onClick={() => drill(selected)}>
              Open
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void startDelete("trash")}>
            Move to Trash…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void startDelete("permanent")}>
            Delete permanently…
          </Button>
        </div>
      ) : null}

      {plan ? (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is owned by useFocusTrap (document capture) */}
          <div
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) closePlan();
            }}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: Z.modal,
            }}
          >
            <section
              ref={dialogRef}
              role="alertdialog"
              aria-modal="true"
              aria-label="Confirm delete"
              style={{
                width: 560,
                maxWidth: "92vw",
                maxHeight: "90vh",
                overflow: "auto",
                background: "var(--bg-surface-2)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius-xl, 14px)",
                padding: "var(--space-8, 16px)",
                color: "var(--text-primary)",
              }}
            >
              <h2
                style={{ margin: 0, fontSize: "var(--text-h2-size, 1rem)", color: "var(--danger)" }}
              >
                {plan.view.mode === "permanent" ? "Delete permanently?" : "Move to the Trash?"}
              </h2>
              <ul style={{ ...small, paddingLeft: "var(--space-8, 16px)" }}>
                {(plan.view.items ?? []).map((i) => (
                  <li key={i.path} style={{ overflowWrap: "break-word" }}>
                    {i.protected ? (
                      <span style={{ color: "var(--danger)" }}>
                        REFUSED — {i.path}: {i.protected}
                      </span>
                    ) : (
                      <span>
                        <strong>{i.risk}</strong> · {i.sizeAtLeast ? "≥" : ""}
                        {formatBytes(i.size)} · <span style={mono}>{i.path}</span>
                        <span style={muted}> — {i.reason}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {plan.view.mode === "permanent" ? (
                <p style={{ ...small, color: "var(--danger)" }}>This cannot be undone.</p>
              ) : null}
              {plan.view.requiresPhrase ? (
                <label style={{ display: "block", ...small }}>
                  This is high-risk or very large. Type <code>yes</code> to go ahead:
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    aria-label="type yes to confirm"
                    style={{ display: "block", marginTop: 4, ...mono }}
                  />
                </label>
              ) : null}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "flex-end",
                  marginTop: "var(--space-8, 16px)",
                }}
              >
                <Button size="sm" variant="primary" onClick={closePlan}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canConfirm}
                  onClick={() => void confirmDelete()}
                >
                  {plan.view.mode === "permanent" ? "Delete" : "Move to Trash"}
                </Button>
              </div>
            </section>
          </div>
        </>
      ) : null}
    </Panel>
  );
}

function Treemap(props: {
  rows: readonly Row[];
  total: number;
  hover: string | null;
  onHover: (p: string | null) => void;
  onPick: (r: Row) => void;
  onDrill: (r: Row) => void;
}): ReactElement {
  const W = 600;
  const H = 300;
  const tiles = squarify(
    props.rows.map((r) => ({ key: r.path, value: r.size })),
    { x: 0, y: 0, w: W, h: H },
  );
  const byPath = new Map(props.rows.map((r) => [r.path, r]));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="treemap of the folders below"
      style={{ display: "block", maxHeight: 340 }}
    >
      {tiles.map((t) => {
        const r = byPath.get(t.key) as Row;
        const share = props.total > 0 ? r.size / props.total : 0;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the table below is the keyboard path to the same items
          <g
            key={t.key}
            onClick={() => props.onPick(r)}
            onDoubleClick={() => props.onDrill(r)}
            onMouseEnter={() => props.onHover(r.path)}
            onMouseLeave={() => props.onHover(null)}
            style={{ cursor: "pointer" }}
          >
            <title>{`${r.name} — ${formatBytes(r.size)} (${r.pct.toFixed(1)}%)`}</title>
            <rect
              x={t.x + 1}
              y={t.y + 1}
              width={Math.max(0, t.w - 2)}
              height={Math.max(0, t.h - 2)}
              rx={4}
              fill={seqFill(share)}
              stroke={props.hover === r.path ? "var(--focus-ring)" : "none"}
              strokeWidth={2}
            />
            {t.w > 70 && t.h > 22 ? (
              <text
                x={t.x + 6}
                y={t.y + 16}
                fontSize={11}
                fill="var(--text-strong)"
                style={{ pointerEvents: "none" }}
              >
                {r.name.length > Math.floor(t.w / 7)
                  ? `${r.name.slice(0, Math.floor(t.w / 7) - 1)}…`
                  : r.name}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function Pie(props: {
  node: readonly { name: string; path: string; size: number }[];
  hover: string | null;
  onHover: (p: string | null) => void;
}): ReactElement {
  const slices = topSlices(props.node as never);
  const total = slices.reduce((a, b) => a + b.size, 0);
  const geo = pieSlices(
    slices.map((s) => ({ key: s.key, value: s.size })),
    110,
    110,
    100,
  );
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "var(--space-8, 16px)",
        alignItems: "center",
      }}
    >
      <svg viewBox="0 0 220 220" width={220} role="img" aria-label="share of each folder">
        {geo.map((g) => {
          const s = slices.find((x) => x.key === g.key);
          if (!s) return null;
          return (
            <path
              key={g.key}
              d={g.d}
              fill={sliceVar(s.slot)}
              stroke="var(--bg-surface)"
              strokeWidth={2}
              opacity={props.hover && props.hover !== s.path ? 0.55 : 1}
              onMouseEnter={() => props.onHover(s.path || null)}
              onMouseLeave={() => props.onHover(null)}
            >
              <title>{`${s.name} — ${formatBytes(s.size)} (${((100 * s.size) / Math.max(1, total)).toFixed(1)}%)`}</title>
            </path>
          );
        })}
      </svg>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, ...small }}>
        {slices.map((s) => (
          <li key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              aria-hidden="true"
              style={{ width: 10, height: 10, borderRadius: 2, background: sliceVar(s.slot) }}
            />
            <span style={{ ...mono }}>{s.name}</span>
            <span style={muted}>
              {formatBytes(s.size)} · {((100 * s.size) / Math.max(1, total)).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Levels(props: {
  levels: readonly { depth: number; rows: readonly { path: string; size: number }[] }[];
}): ReactElement {
  return (
    <div style={small}>
      {props.levels.map((lv) => {
        const max = Math.max(1, ...lv.rows.map((r) => r.size));
        return (
          <section key={lv.depth} style={{ marginBottom: "var(--space-6, 12px)" }}>
            <h3 style={{ margin: "4px 0", fontSize: "var(--text-small-size, 0.8125rem)" }}>
              depth {lv.depth} <span style={muted}>du --max-depth={lv.depth} | sort -rh</span>
            </h3>
            {lv.rows.map((r) => (
              <div key={r.path} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ width: 70, textAlign: "right" }}>{formatBytes(r.size)}</span>
                <Bar share={r.size / max} />
                <span
                  style={{
                    ...mono,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.path}
                </span>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Files(props: { files: readonly { path: string; size: number }[] }): ReactElement {
  const max = Math.max(1, ...props.files.map((f) => f.size));
  return (
    <div style={small}>
      {props.files.map((f) => (
        <div key={f.path} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ width: 70, textAlign: "right" }}>{formatBytes(f.size)}</span>
          <Bar share={f.size / max} />
          <span
            style={{
              ...mono,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {f.path}
          </span>
        </div>
      ))}
    </div>
  );
}

function Mounts(props: {
  mounts: readonly {
    target: string;
    fstype: string;
    total: number;
    used: number;
    free: number;
    usePct: number;
  }[];
}): ReactElement {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", ...small }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
          <th>mounted on</th>
          <th>type</th>
          <th style={{ textAlign: "right" }}>size</th>
          <th style={{ textAlign: "right" }}>free</th>
          <th style={{ textAlign: "right" }}>use</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.mounts.map((m) => (
          <tr key={m.target}>
            <td style={mono}>{m.target}</td>
            <td>{m.fstype}</td>
            <td style={{ textAlign: "right" }}>{formatBytes(m.total)}</td>
            <td style={{ textAlign: "right" }}>{formatBytes(m.free)}</td>
            <td style={{ textAlign: "right" }}>
              {Math.round(m.usePct)}%
              {m.usePct >= 90 ? <span style={{ color: "var(--warn)" }}> ⚠ almost full</span> : null}
            </td>
            <td>
              <Bar share={m.usePct / 100} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
