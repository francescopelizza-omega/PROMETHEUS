// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/telemetry/TelemetryPanel.tsx — the full "System" bottom-panel surface.
 *
 * The whole-machine dashboard: CPU / RAM / DISK meters (free + occupied), every GPU
 * (VRAM meter when discrete, else a unified-memory note), the NPU, and the LAUNCH
 * GUARD banner — the calculator that forbids new heavy processes once CPU% or RAM%
 * is ≥ 90%. Presentational + controlled: reads the shared telemetry store; the App
 * mounts the single poller. Token colors only (no raw hex).
 */
import { EmptyState } from "@prometheus/ui";
import { type ReactElement, useEffect, useState } from "react";

import { useTelemetryStore } from "../../stores/telemetry.js";
import { Meter } from "./Meter.js";
import { formatBytes, sampledAgo, toneVar, usedOfTotal } from "./telemetry-view.js";

/** The launch-guard banner: green "headroom OK" or red "launches held". */
function GuardBanner({
  guard,
}: {
  guard: import("../../../shared/ipc-contract.js").ResourceGuard;
}): ReactElement {
  const blocked = !guard.allow;
  return (
    <div
      role={blocked ? "alert" : undefined}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-3, 6px)",
        padding: "var(--space-3, 6px) var(--space-4, 8px)",
        borderRadius: "var(--radius-md, 6px)",
        border: `1px solid ${blocked ? "var(--danger)" : "var(--border-subtle)"}`,
        background: blocked
          ? "color-mix(in srgb, var(--danger) 12%, var(--bg-inset))"
          : "var(--bg-inset)",
        fontSize: "var(--text-small-size, 0.8125rem)",
      }}
    >
      <span aria-hidden="true" style={{ color: blocked ? "var(--danger)" : "var(--ok)" }}>
        {blocked ? "⛔" : "✓"}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <strong style={{ color: "var(--text-primary)" }}>
          {blocked
            ? "Launch guard: new heavy processes held"
            : `Launch guard OK — headroom below ${guard.thresholdPct}%`}
        </strong>
        <span style={{ color: "var(--text-secondary)" }}>
          {blocked
            ? guard.reason
            : `CPU ${guard.cpuPct}% · RAM ${guard.ramPct}% (ceiling ${guard.thresholdPct}%). Prometheus won't start a model pull/serve that would saturate the machine.`}
        </span>
      </div>
    </div>
  );
}

export function TelemetryPanel(): ReactElement {
  const telemetry = useTelemetryStore((s) => s.telemetry);
  const error = useTelemetryStore((s) => s.error);
  const refresh = useTelemetryStore((s) => s.refresh);

  // a lightweight ticking "updated Ns ago" without another poll loop.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!telemetry) {
    return (
      <div style={{ padding: "var(--space-4, 8px)", height: "100%", boxSizing: "border-box" }}>
        <EmptyState
          icon="🖥️"
          title={error ? "Telemetry unavailable" : "Reading system telemetry…"}
          hint={error ?? "Probing CPU, RAM, disk, GPU and NPU."}
        />
      </div>
    );
  }

  const t = telemetry;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 8px)",
        padding: "var(--space-4, 8px)",
        height: "100%",
        boxSizing: "border-box",
        overflow: "auto",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      {/* header: host + freshness */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--space-3, 6px)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          color: "var(--text-secondary)",
        }}
      >
        <strong style={{ color: "var(--text-primary)" }}>{t.osLabel}</strong>
        <span>· {t.arch}</span>
        {t.cpu.cores && <span>· {t.cpu.cores} cores</span>}
        <span style={{ flex: 1 }} />
        <span>{t.ok ? `updated ${sampledAgo(t.sampledAt, now)}` : "stale"}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          style={{
            background: "transparent",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm, 4px)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            padding: "var(--space-1, 2px) var(--space-3, 6px)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          ⟲
        </button>
      </div>

      <GuardBanner guard={t.guard} />

      {/* the two-column meter grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
          gap: "var(--space-4, 8px)",
        }}
      >
        <Meter label="CPU" usedPct={t.cpu.usedPct} detail={t.cpu.model} measured={t.cpu.measured} />
        <Meter
          label="RAM"
          usedPct={t.ram.usedPct}
          detail={usedOfTotal(t.ram.usedBytes, t.ram.totalBytes)}
          measured={t.ram.measured}
        />
        <Meter
          label={`Disk${t.disk.mount ? ` · ${t.disk.mount}` : ""}`}
          usedPct={t.disk.usedPct}
          detail={usedOfTotal(t.disk.usedBytes, t.disk.totalBytes)}
          measured={t.disk.measured}
        />
        {t.gpus.length === 0 && (
          <Meter label="GPU" usedPct={0} measured={false} detail="none detected" />
        )}
        {t.gpus.map((g, i) => (
          <Meter
            // biome-ignore lint/suspicious/noArrayIndexKey: GPU list is a stable small enumeration
            key={`gpu-${i}`}
            label={`GPU · ${g.name}`}
            usedPct={g.vram?.usedPct ?? g.utilPct ?? 0}
            measured={g.vram !== undefined || g.utilPct !== undefined}
            detail={
              g.vram
                ? usedOfTotal(g.vram.usedBytes, g.vram.totalBytes)
                : g.utilPct !== undefined
                  ? `${g.utilPct}% util`
                  : "n/a"
            }
            note={g.note}
          />
        ))}
        <Meter
          label={`NPU${t.npu.name ? ` · ${t.npu.name}` : ""}`}
          usedPct={t.npu.utilPct ?? 0}
          measured={t.npu.utilPct !== undefined}
          detail={
            t.npu.present ? (t.npu.utilPct !== undefined ? `${t.npu.utilPct}%` : "present") : "none"
          }
          note={t.npu.note}
        />
      </div>

      {error && (
        <span style={{ color: toneVar("warn"), fontSize: "0.72rem" }}>last refresh: {error}</span>
      )}
    </div>
  );
}

export default TelemetryPanel;
