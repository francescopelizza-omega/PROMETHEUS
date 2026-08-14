/**
 * CudaPanel.tsx — the GPU/CUDA panel (file 04 §5.2).
 *
 * Renders the `GpuInfo` the engine's `cuda.info` probe produced: NVIDIA presence,
 * per-GPU VRAM, driver vs. runtime vs. toolkit (nvcc) — distinct on purpose — and
 * the recommended torch wheel index. Offers the two real actions ("Install CUDA
 * toolkit" and "Install matched torch into <env>") as CALLBACK PROPS. On macOS
 * (no NVIDIA CUDA) the install buttons are DISABLED with the MPS/Metal note — the
 * honest cross-platform stance from §5.2/§10. PURELY presentational: NO IPC, NO
 * decision; every engine string is inert text (C5). Imports only react + this
 * package.
 */

import type { ReactElement } from "react";
import type { GpuInfoData } from "./types.js";
import { inert, roleVar } from "./util.js";

export interface CudaPanelProps {
  gpu: GpuInfoData;
  /** the env the "install matched torch" button targets (display name). */
  targetEnvName?: string;
  /** true when running on macOS — disables NVIDIA install buttons, shows MPS note. */
  isMac?: boolean;
  /** install the CUDA toolkit (gated installer; the host collects confirm). */
  onInstallToolkit?(): void;
  /** install the CUDA/CPU-matched torch wheel into the target env (the #1 need). */
  onInstallTorch?(): void;
  className?: string;
}

function Row({
  label,
  children,
}: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div style={{ display: "flex", gap: "var(--space-4, 8px)", alignItems: "baseline" }}>
      <span
        style={{
          color: "var(--text-secondary)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          minWidth: "9rem",
        }}
      >
        {label}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>{children}</span>
    </div>
  );
}

export function CudaPanel({
  gpu,
  targetEnvName,
  isMac = false,
  onInstallToolkit,
  onInstallTorch,
  className,
}: CudaPanelProps): ReactElement {
  const installDisabled = isMac || !gpu.hasNvidia;

  return (
    <section
      className={className}
      aria-label="CUDA / GPU"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg, 10px)",
        padding: "var(--space-6, 12px)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3, 6px)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      <strong style={{ fontSize: "0.95rem" }}>CUDA / GPU</strong>

      <Row label="NVIDIA GPU">
        <span style={{ color: gpu.hasNvidia ? roleVar("ok") : roleVar("muted") }}>
          {gpu.hasNvidia ? "✓ detected" : "✗ none"}
        </span>
      </Row>

      {(gpu.gpus ?? []).map((g, i) => (
        <Row key={`${inert(g.name)}-${i}`} label={`GPU ${i}`}>
          {`${inert(g.name)} · ${g.vramTotalMB} MB (${g.vramFreeMB} free)${
            g.computeCap ? ` · compute ${inert(g.computeCap)}` : ""
          }`}
        </Row>
      ))}

      <Row label="Driver">{inert(gpu.driverVersion) || "—"}</Row>
      <Row label="CUDA runtime (max)">{inert(gpu.cudaRuntime) || "—"}</Row>
      <Row label="Toolkit (nvcc)">
        <span style={{ color: gpu.toolkitInstalled ? roleVar("ok") : roleVar("warn") }}>
          {gpu.toolkitInstalled
            ? inert(gpu.nvccVersion) || "✓ on PATH"
            : "✗ not on PATH — source/Hopper builds of flash-attn will fail"}
        </span>
      </Row>
      <Row label="Recommended">
        {gpu.recommendedTorchIndex
          ? `torch wheels: ${inert(gpu.recommendedTorchIndex)}`
          : "CPU/MPS"}
      </Row>

      <div
        style={{
          display: "flex",
          gap: "var(--space-3, 6px)",
          flexWrap: "wrap",
          marginTop: "var(--space-3, 6px)",
        }}
      >
        <CudaButton
          label="Install CUDA toolkit"
          onClick={onInstallToolkit}
          disabled={installDisabled || !onInstallToolkit}
        />
        <CudaButton
          label={`Install matched torch${targetEnvName ? ` into ${inert(targetEnvName)}` : ""}`}
          onClick={onInstallTorch}
          disabled={!onInstallTorch}
        />
      </div>

      {isMac && (
        <p
          role="note"
          style={{
            margin: 0,
            marginTop: "var(--space-3, 6px)",
            padding: "var(--space-3, 6px)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md, 6px)",
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          macOS note: no NVIDIA CUDA — the MPS/Metal path is used; AirLLM / FlashAttention show as
          CPU/MPS-only.
        </p>
      )}
    </section>
  );
}

function CudaButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      style={{
        background: "transparent",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md, 6px)",
        color: "var(--text-primary)",
        cursor: disabled || !onClick ? "default" : "pointer",
        opacity: disabled || !onClick ? 0.45 : 1,
        padding: "var(--space-3, 6px) var(--space-6, 10px)",
        fontSize: "0.85rem",
        fontFamily: "var(--font-ui)",
      }}
    >
      {label}
    </button>
  );
}

export default CudaPanel;
