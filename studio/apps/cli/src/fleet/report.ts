/**
 * fleet/report.ts — `/fleet`: the per-window table the bar deliberately does not have room for.
 *
 * The bar answers "is anything wrong". This answers "which window, and what is it doing" — and
 * it is where every number the bar had to abbreviate is written out in full. The exact GB live
 * here rather than on the bar because `ram 22/64GB` was the widest chip on the line and the
 * percentage says the same thing in a third of the columns.
 *
 * It is also where the bar's honesty caveats are stated in words instead of implied by a missing
 * bar: what `other` includes, why the GPU has no ownership split, and which accelerators are
 * detectable but not measurable.
 *
 * PURE — takes peers, meters and a clock. No fs, no probing.
 */
import { agent } from "@prometheus/core";

import { shortCwd } from "../path-display.js";
import type { FleetPeer } from "./heartbeat.js";
import type { FleetMeters } from "./meters.js";

const { formatDuration } = agent;

/** How a state reads in the table — the same words the bar uses, spaced for a column. */
const STATE_LABEL: Record<FleetPeer["state"], string> = {
  working: "working",
  idle: "idle",
  "needs-you": "needs you",
  dead: "dead",
};

export interface FleetReportRow {
  n: string;
  pid: string;
  terminal: string;
  model: string;
  state: string;
  for: string;
  cwd: string;
}

/** Project peers into table rows. `now` is injected so the `for` column is testable. */
export function fleetReportRows(peers: readonly FleetPeer[], now: number): FleetReportRow[] {
  return peers.map((p, i) => {
    const started = Date.parse(p.startedAt);
    return {
      n: String(i + 1),
      pid: String(p.pid),
      terminal: p.self ? "(this window)" : p.term || "—",
      model: p.model || "—",
      // A live peer whose heartbeat has gone quiet is still live — say so rather than
      // silently showing a state that stopped being refreshed 20 seconds ago.
      state: p.stale ? `${STATE_LABEL[p.state]} (stale)` : STATE_LABEL[p.state],
      for: p.state === "dead" || !Number.isFinite(started) ? "—" : formatDuration(now - started),
      cwd: p.cwd ? shortCwd(p.cwd) : "—",
    };
  });
}

const COLUMNS: readonly (keyof FleetReportRow)[] = [
  "n",
  "pid",
  "terminal",
  "model",
  "state",
  "for",
  "cwd",
];
const HEADINGS: Record<keyof FleetReportRow, string> = {
  n: "#",
  pid: "pid",
  terminal: "terminal",
  model: "model",
  state: "state",
  for: "for",
  cwd: "cwd",
};

/** Lay the rows out as a fixed-width table (the last column is never padded). */
export function fleetTable(rows: readonly FleetReportRow[]): string[] {
  const widths = COLUMNS.map((col) =>
    Math.max(HEADINGS[col].length, ...rows.map((r) => r[col].length), 0),
  );
  const line = (cells: readonly string[]): string =>
    `  ${cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join("  ")}`.trimEnd();
  return [
    line(COLUMNS.map((c) => HEADINGS[c])),
    ...rows.map((r) => line(COLUMNS.map((c) => r[c]))),
  ];
}

/**
 * A percentage that never rounds a real quantity down to nothing.
 *
 * `Math.round` turned a measured 0.3% share into the string `0% Prometheus`, printed on the
 * same line as `0.2 GB Prometheus` — the report contradicting itself, and doing it with the one
 * number this module exists to avoid. Zero is reserved for actually zero.
 */
function pctText(v: number): string {
  if (v > 0 && v < 0.5) return "<1%";
  return `${Math.round(v)}%`;
}

/** `41% of the machine · 28% Prometheus` — or the honest version when we cannot attribute. */
function meterLine(
  label: string,
  m: { pct: number | null; oursPct?: number },
  extra?: string,
): string {
  if (m.pct === null) return `  ${label.padEnd(6)}present, utilization not exposed by this OS`;
  const total = `${pctText(m.pct)} used`;
  const ours =
    m.oursPct === undefined
      ? "Prometheus share not measurable here"
      : `${pctText(m.oursPct)} Prometheus`;
  return `  ${label.padEnd(6)}${[total, ours, extra].filter(Boolean).join("  ·  ")}`;
}

/** The whole `/fleet` output: the table, the exact meters, and the caveats in words. */
export function fleetReport(
  peers: readonly FleetPeer[],
  meters: FleetMeters | null,
  now: number,
): string[] {
  const out: string[] = [];
  if (peers.length === 0) {
    out.push("  no Prometheus windows are registered (this one included — heartbeat unwritable?)");
  } else {
    out.push(...fleetTable(fleetReportRows(peers, now)));
  }
  if (!meters) return out;
  out.push("");
  out.push(meterLine("cpu", meters.cpu));
  out.push(
    meterLine(
      "ram",
      meters.ram,
      `${meters.ram.usedGb} of ${meters.ram.totalGb} GB${
        meters.ram.oursGb === undefined ? "" : ` · ${meters.ram.oursGb} GB Prometheus`
      }`,
    ),
  );
  if (meters.gpu) out.push(meterLine("gpu", meters.gpu));
  for (const a of meters.accelerators) {
    out.push(`  ${a.padEnd(6)}present, utilization not exposed by this OS`);
  }
  out.push("");
  out.push("  “Prometheus” counts every Prometheus window plus the processes it spawned.");
  out.push("  A shared model server (ollama) is NOT counted as ours — it belongs to no window.");
  if (meters.gpu) {
    out.push("  The GPU has no ownership bar: no tool here reports per-process GPU utilization.");
  }
  return out;
}
