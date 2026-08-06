/**
 * ModelHub.tsx — the §7 Model-Hub shell: a [Discover | Library | Serving] tab
 * shell + an HW summary bar + a modality sidebar + the search box + a free /
 * open-weight toggle + the model result list. The FitScorePanel / DownloadQueue /
 * ServingPanel are slotted in as children (the route composes them) so this shell
 * owns ONLY layout + the discover controls.
 *
 * SANDBOXED + C5: imports only react + this package. It NEVER fetches, scores, or
 * decides "safe" — every datum (hardware, models, fit) is a PROP the route
 * obtained across the contextBridge, and every action (onSearch / onSelectModel /
 * onTabChange / …) is a callback prop. Engine strings run through `inert()`.
 */

import { type ReactElement, type ReactNode, useState } from "react";

import type { HardwareProfileData, ModelData } from "./types.js";
import {
  MODALITIES,
  type ModalityFacet,
  formatCount,
  formatGb,
  inert,
  isFreeOpenLicense,
  modalityLabel,
} from "./util.js";

/** The four top-level Hub tabs (08 §5.4: My Models · Discover · Serving · Compare). */
export type HubTab = "discover" | "library" | "serving" | "compare";

/** Tab display labels — `library` reads "My Models" per §5.4 (not "Library"). */
const TAB_LABEL: Record<HubTab, string> = {
  library: "My Models",
  discover: "Discover",
  serving: "Serving",
  compare: "Compare",
};

export interface ModelHubProps {
  /** the live HW profile (the §7 summary bar); null while scanning. */
  hardware: HardwareProfileData | null;
  /** the discover/library result rows (already sorted open-weight-first by the route). */
  models: ModelData[];
  /** the active tab. */
  tab: HubTab;
  onTabChange: (tab: HubTab) => void;
  /** the active modality facet (§10 sidebar). */
  modality: ModalityFacet;
  onModalityChange: (m: ModalityFacet) => void;
  /** the search query (controlled). */
  query: string;
  onQueryChange: (q: string) => void;
  onSearch: () => void;
  /** the source filter. */
  source: "hf" | "ollama";
  onSourceChange: (s: "hf" | "ollama") => void;
  /** the §6 free / open-weight toggle. */
  freeOnly: boolean;
  onFreeOnlyChange: (v: boolean) => void;
  /** the selected model id (drives the fit panel). */
  selectedId: string | null;
  onSelectModel: (id: string) => void;
  /** re-scan hardware. */
  onRescan?: () => void;
  /** loading flag for the result list. */
  loading?: boolean;
  /**
   * slotted panels: the FitScorePanel (discover), DownloadQueue (discover sidebar),
   * and ServingPanel (serving tab). The route composes these so the shell stays
   * presentation-only.
   */
  fitPanel?: ReactNode;
  queuePanel?: ReactNode;
  servingPanel?: ReactNode;
  libraryList?: ReactNode;
  /** the §5.4 Compare tab body (Odysseus blind multi-model test). */
  comparePanel?: ReactNode;
}

/** The §7 HW summary bar (e.g. "Apple M3 Max · 36GB unified · Metal"). */
function HwSummary({
  hardware,
  onRescan,
}: {
  hardware: HardwareProfileData | null;
  onRescan?: () => void;
}): ReactElement {
  let text = "scanning hardware…";
  if (hardware) {
    // Defensive: the hardware payload is an opaque IPC cast — a partial probe (no
    // GPU / no caps / no cpu) must degrade to a label, never crash the Model Hub.
    const gpu = hardware.gpus?.[0];
    const accel = inert(hardware.accel);
    const mem = hardware.unified
      ? `${formatGb(hardware.usableWeightGb)} unified`
      : `${formatGb(hardware.caps?.totalVramGb)} VRAM`;
    const name = gpu ? inert(gpu.name) : inert(hardware.cpu?.brand) || "CPU";
    text = `${name} · ${mem} · ${accel}`;
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3, 6px)",
        color: "var(--text-secondary)",
        fontSize: "0.8rem",
      }}
    >
      <span aria-hidden="true">HW:</span>
      <span style={{ color: "var(--text-primary)" }}>{text}</span>
      {onRescan && (
        <button
          type="button"
          onClick={onRescan}
          style={{
            border: "1px solid var(--border-subtle)",
            background: "transparent",
            color: "var(--text-secondary)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "1px 7px",
            fontSize: "0.74rem",
            cursor: "pointer",
          }}
        >
          ↻ rescan
        </button>
      )}
    </div>
  );
}

/** One model result row. */
function ModelRow({
  m,
  selected,
  onSelect,
}: {
  m: ModelData;
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const free = m.openWeight && isFreeOpenLicense(m.license);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(m.id)}
        aria-current={selected ? "true" : undefined}
        style={{
          width: "100%",
          textAlign: "left",
          display: "flex",
          flexDirection: "column",
          gap: "2px",
          padding: "8px 10px",
          borderRadius: "var(--radius-md, 6px)",
          border: `1px solid ${selected ? "var(--accent)" : "var(--border-subtle)"}`,
          background: selected ? "var(--bg-surface-2)" : "transparent",
          color: "var(--text-primary)",
          cursor: "pointer",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-3, 6px)" }}>
          <span style={{ fontWeight: 600, fontSize: "0.86rem" }}>{inert(m.id)}</span>
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: "var(--space-3, 6px)",
              alignItems: "center",
            }}
          >
            <span style={{ color: "var(--text-secondary)", fontSize: "0.74rem" }}>
              {inert(m.license) || "—"}
            </span>
            {typeof m.downloads === "number" && (
              <span style={{ color: "var(--text-secondary)", fontSize: "0.74rem" }}>
                ⭳ {formatCount(m.downloads)}
              </span>
            )}
            {typeof m.likes === "number" && (
              <span style={{ color: "var(--text-secondary)", fontSize: "0.74rem" }}>
                ★ {formatCount(m.likes)}
              </span>
            )}
          </span>
        </span>
        <span
          style={{
            display: "flex",
            gap: "var(--space-3, 6px)",
            color: "var(--text-secondary)",
            fontSize: "0.76rem",
          }}
        >
          {m.params && <span>{inert(m.params)}</span>}
          <span>· {inert(m.modality)}</span>
          {typeof m.contextLen === "number" && <span>· ctx {m.contextLen}</span>}
          {free && <span style={{ color: "var(--ok)" }}>· open-weight</span>}
          {m.installed && <span style={{ color: "var(--ok)" }}>· installed</span>}
          {m.gated && <span style={{ color: "var(--warn)" }}>· gated</span>}
        </span>
        {m.description && (
          <span
            style={{
              color: "var(--text-secondary)",
              fontSize: "0.78rem",
              lineHeight: 1.35,
              marginTop: "2px",
            }}
          >
            {inert(m.description)}
          </span>
        )}
        {m.resource?.label && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2, 4px)",
              fontSize: "0.74rem",
              marginTop: "2px",
              color: resourceColor(m.resource),
            }}
            title={resourceTitle(m.resource)}
          >
            <span aria-hidden="true">{m.resource.needsOffload ? "▲" : "●"}</span>
            <span style={{ color: "var(--text-secondary)" }}>{inert(m.resource.label)}</span>
          </span>
        )}
      </button>
    </li>
  );
}

/** Tier-tinted dot for the compute-demand badge: small=ok, heavy=warn, server/offload=danger. */
function resourceColor(res: NonNullable<ModelData["resource"]>): string {
  if (res.needsOffload || res.tier === "server") return "var(--danger)";
  if (res.tier === "heavy" || res.tier === "workstation") return "var(--warn)";
  return "var(--ok)";
}

/** A descriptive tooltip for the badge (min/rec RAM, GPU, offload). */
function resourceTitle(res: NonNullable<ModelData["resource"]>): string {
  const parts: string[] = [];
  if (typeof res.minRamGb === "number") parts.push(`min ${res.minRamGb}GB RAM (short ctx)`);
  if (typeof res.recRamGb === "number") parts.push(`rec ${res.recRamGb}GB (full ctx)`);
  if (typeof res.gpuMinVramGb === "number") parts.push(`GPU ${res.gpuMinVramGb}GB`);
  parts.push(res.cpuOk ? "CPU-only usable" : "GPU advised");
  if (res.needsOffload) parts.push("needs AirLLM / expert-offload / served API");
  return parts.join(" · ");
}

// "compare" dropped — the route never passes a comparePanel, so it was a dead tab that
// switched to a static placeholder with no models/controls. Re-add once wired.
const TABS: HubTab[] = ["library", "discover", "serving"];

export function ModelHub({
  hardware,
  models,
  tab,
  onTabChange,
  modality,
  onModalityChange,
  query,
  onQueryChange,
  onSearch,
  source,
  onSourceChange,
  freeOnly,
  onFreeOnlyChange,
  selectedId,
  onSelectModel,
  onRescan,
  loading = false,
  fitPanel,
  queuePanel,
  servingPanel,
  libraryList,
  comparePanel,
}: ModelHubProps): ReactElement {
  const [, force] = useState(0);
  void force; // reserved for local-only UI affordances; keeps the shell a component.

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8, 16px)" }}>
      {/* tab strip + HW summary */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          flexWrap: "wrap",
        }}
      >
        <nav style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onTabChange(t)}
              aria-current={tab === t ? "page" : undefined}
              style={{
                background: tab === t ? "var(--bg-surface-2)" : "transparent",
                border: `1px solid ${tab === t ? "var(--accent)" : "var(--border-subtle)"}`,
                color: tab === t ? "var(--text-primary)" : "var(--text-secondary)",
                borderRadius: "var(--radius-md, 6px)",
                padding: "4px 12px",
                fontSize: "0.84rem",
                cursor: "pointer",
                fontWeight:
                  tab === t
                    ? "var(--font-weight-semibold, 600)"
                    : "var(--font-weight-regular, 400)",
              }}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: "auto" }}>
          <HwSummary hardware={hardware} onRescan={onRescan} />
        </div>
      </div>

      {tab === "serving" ? (
        servingPanel
      ) : tab === "compare" ? (
        (comparePanel ?? (
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
            Select models to compare (blind multi-model test).
          </p>
        ))
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "180px minmax(0, 1fr)",
            gap: "var(--space-8, 16px)",
            alignItems: "start",
          }}
        >
          {/* ── modality sidebar (§10) ─────────────────────────────────────── */}
          <aside style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.72rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  marginBottom: "2px",
                }}
              >
                Modality
              </span>
              {MODALITIES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onModalityChange(m as ModalityFacet)}
                  aria-current={modality === m ? "true" : undefined}
                  style={{
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: modality === m ? "var(--text-primary)" : "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.82rem",
                    padding: "3px 4px",
                    fontWeight:
                      modality === m
                        ? "var(--font-weight-semibold, 600)"
                        : "var(--font-weight-regular, 400)",
                  }}
                >
                  {modality === m ? "● " : "○ "}
                  {modalityLabel(m)}
                </button>
              ))}
            </div>

            {/* the download queue lives in the discover sidebar (§7 wireframe) */}
            {tab === "discover" && queuePanel && (
              <div style={{ marginTop: "var(--space-4, 8px)" }}>
                <span
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.72rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  Download queue
                </span>
                <div style={{ marginTop: "4px" }}>{queuePanel}</div>
              </div>
            )}
          </aside>

          {/* ── main column: search + result list + fit panel ─────────────── */}
          <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
            {tab === "discover" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onSearch();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3, 6px)",
                  flexWrap: "wrap",
                }}
              >
                <input
                  value={query}
                  onChange={(e) => onQueryChange(e.target.value)}
                  placeholder="Search models (e.g. qwen3)"
                  aria-label="Search models"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  style={{
                    flex: 1,
                    minWidth: "180px",
                    padding: "7px 10px",
                    borderRadius: "var(--radius-md, 6px)",
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    fontSize: "0.85rem",
                  }}
                />
                <select
                  value={source}
                  onChange={(e) => onSourceChange(e.target.value === "ollama" ? "ollama" : "hf")}
                  aria-label="Source"
                  style={{
                    padding: "7px 8px",
                    borderRadius: "var(--radius-md, 6px)",
                    border: "1px solid var(--border-subtle)",
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    fontSize: "0.82rem",
                  }}
                >
                  <option value="hf">HuggingFace</option>
                  <option value="ollama">Ollama</option>
                </select>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    color: "var(--text-secondary)",
                    fontSize: "0.8rem",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={freeOnly}
                    onChange={(e) => onFreeOnlyChange(e.target.checked)}
                  />
                  free / open-weight
                </label>
              </form>
            )}

            {/* the result list / library list */}
            {tab === "library" ? (
              // don't leak DISCOVER search results into "My Models" when no library is wired —
              // render an explicit empty state instead.
              (libraryList ?? (
                <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
                  No models installed yet. Download one from Discover to see it here.
                </p>
              ))
            ) : loading ? (
              <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
                Searching…
              </p>
            ) : models.length === 0 ? (
              <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
                No models. Try a different query or modality.
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
                {models.map((m) => (
                  <ModelRow
                    key={m.id}
                    m={m}
                    selected={m.id === selectedId}
                    onSelect={onSelectModel}
                  />
                ))}
              </ul>
            )}

            {/* the fit panel for the selected model (discover only) */}
            {tab === "discover" && selectedId && fitPanel && (
              <div
                style={{
                  marginTop: "var(--space-3, 6px)",
                  paddingTop: "var(--space-4, 8px)",
                  borderTop: "1px solid var(--border-subtle)",
                }}
              >
                <span
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.78rem",
                    display: "block",
                    marginBottom: "var(--space-3, 6px)",
                  }}
                >
                  {inert(selectedId)} — fit on YOUR hardware
                </span>
                {fitPanel}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default ModelHub;
