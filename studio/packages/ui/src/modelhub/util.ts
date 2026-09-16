/**
 * modelhub/util.ts — the PURE, dependency-free display helpers the Model-Hub
 * components lean on (file 05 §4/§5/§7/§8). NO react, NO node, NO engine-bridge
 * runtime — only string/number math the components render. This is the testable
 * core of the Model-Hub UI (node:test covers it WITHOUT a DOM).
 *
 * GOLDEN RULE (C5): nothing here decides "safe" and nothing here fit-SCORES. A
 * fit verdict's color/label is a pure projection of the verdict the SIDECAR
 * already produced (fit.py); a gate badge's color/label is a pure projection of
 * the verdict the ENGINE's nemesis produced. These helpers never score, never
 * fit, never upgrade a verdict toward allow, never gate. Every engine string a
 * component renders is first run through `inert()` so a crafted model id /
 * license / reason can only ever be inert text.
 */

import type { SecSeverity, SecVerdict } from "../security/types.js";
import type { ModelGateBadge } from "./types.js";

/* ── inert (the shared ANSI/control sanitiser) ─────────────────────────────── */

/** The ESC byte (0x1b) — lead of every ANSI escape (built, not a literal in source). */
const ESC = String.fromCharCode(0x1b);
/** ANSI CSI escape sequences (ESC [ … final-letter), all occurrences. */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
/** Any bare control byte (0x00–0x1f, 0x7f) — collapsed to a space. */
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}\\x7f]`, "g");

/** Remove ANSI + collapse control chars so an engine string is safe inert text. */
export function inert(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(ANSI, "").replace(CONTROL, " ").trim();
}

/* ── semantic roles (ui tokens, never raw hex) ─────────────────────────────── */

/** A semantic UI role → its CSS var (shared mapping with the env/security barrels). */
export type ModelRole = "ok" | "warn" | "danger" | "muted" | "accent";

/** Resolve a semantic role → the CSS var the component paints with. */
export function roleVar(role: ModelRole): string {
  switch (role) {
    case "ok":
      return "var(--ok)";
    case "warn":
      return "var(--warn)";
    case "danger":
      return "var(--danger)";
    case "accent":
      return "var(--accent)";
    default:
      return "var(--text-secondary)";
  }
}

/* ── §4.2 fit verdict → {role,glyph,label} (PURE projection — never scores) ─── */

/** The four §4.2 Cookbook fit verdicts (mirrors fit.py + engine-bridge FitVerdict). */
export type FitVerdict = "FITS" | "TIGHT" | "PARTIAL" | "OVERFLOW";

/** Map a fit verdict → its semantic role (FITS=ok, TIGHT=warn, PARTIAL=accent, OVERFLOW=danger). */
export function fitRole(verdict: FitVerdict): ModelRole {
  switch (verdict) {
    case "FITS":
      return "ok";
    case "TIGHT":
      return "warn";
    case "PARTIAL":
      return "accent";
    default:
      return "danger";
  }
}

/** A short glyph for a fit verdict (the §7 chip; ● fits · ◐ tight · ◑ partial · ✕ overflow). */
export function fitGlyph(verdict: FitVerdict): string {
  switch (verdict) {
    case "FITS":
      return "●";
    case "TIGHT":
      return "◐";
    case "PARTIAL":
      return "◑";
    default:
      return "✕";
  }
}

/** A short label for a fit verdict (rendered next to the glyph in the §7 chip). */
export function fitLabel(verdict: FitVerdict): string {
  switch (verdict) {
    case "FITS":
      return "FITS";
    case "TIGHT":
      return "TIGHT";
    case "PARTIAL":
      return "PARTIAL";
    default:
      return "OVERFLOW";
  }
}

/**
 * The §7 verdict chip text for one quant row: the glyph+label, plus the ratio
 * when known (e.g. "● FITS 0.18"), or the §4.3 caps reason when the quant is
 * gated out (e.g. "✕ needs cc≥8.9"). PURE: it never decides runnable — it renders
 * the `runnable`/`blockedReason` the sidecar already set. Reason is run inert.
 */
export function fitChipText(row: {
  verdict: FitVerdict;
  ratio: number | null;
  runnable: boolean;
  blockedReason: string | null;
}): string {
  if (!row.runnable) {
    const reason = inert(row.blockedReason ?? "");
    return reason.length > 0 ? `${fitGlyph("OVERFLOW")} ${reason}` : `${fitGlyph("OVERFLOW")} n/a`;
  }
  const r = typeof row.ratio === "number" ? ` ${row.ratio.toFixed(2)}` : "";
  return `${fitGlyph(row.verdict)} ${fitLabel(row.verdict)}${r}`;
}

/* ── §5 download-state → {role,glyph,label} (PURE projection of nemesis flow) ── */

/** The §5 download-queue item lifecycle state (mirror of core DownloadState). */
export type DownloadState =
  | "queued"
  | "staging"
  | "scanning"
  | "confirm"
  | "admitted"
  | "blocked"
  | "quarantined";

/** Map a download state → its semantic role (the §5 admit/confirm/quarantine colors). */
export function downloadRole(state: DownloadState): ModelRole {
  switch (state) {
    case "admitted":
      return "ok";
    case "confirm":
      return "warn";
    case "blocked":
    case "quarantined":
      return "danger";
    case "staging":
    case "scanning":
      return "accent";
    default:
      return "muted";
  }
}

/** A glyph for a download state (◌ queued · ⭳ staging · ◐ scanning · ✓ admitted · ⛔ blocked). */
export function downloadGlyph(state: DownloadState): string {
  switch (state) {
    case "queued":
      return "◌";
    case "staging":
      return "⭳";
    case "scanning":
      return "◐";
    case "confirm":
      return "⚠";
    case "admitted":
      return "✓";
    case "blocked":
      return "⛔";
    case "quarantined":
      return "⚠";
    default:
      return "·";
  }
}

/** A short human label for a download state (rendered in the queue row). */
export function downloadLabel(state: DownloadState): string {
  switch (state) {
    case "queued":
      return "queued";
    case "staging":
      return "downloading…";
    case "scanning":
      return "nemesis: scanning…";
    case "confirm":
      return "confirm";
    case "admitted":
      return "admitted";
    case "blocked":
      return "BLOCKED";
    case "quarantined":
      return "quarantined";
    default:
      return state;
  }
}

/** Is a download state TERMINAL (the row is finished — admitted | quarantined)? */
export function isDownloadTerminal(state: DownloadState): boolean {
  return state === "admitted" || state === "quarantined";
}

/** Is a download state in the deep-red blocked/quarantined zone (the §5 refusal)? */
export function isDownloadBlocked(state: DownloadState): boolean {
  return state === "blocked" || state === "quarantined";
}

/* ── gate tier → {role,glyph,label} (the nemesis badge on a download row) ───── */

/** The four engine verdict tiers (C3) a gate badge can carry. */
export type GateTier = "allow" | "warn" | "block" | "error";

/** Map a gate tier → its semantic role (allow=ok, warn=warn, block/error=danger). */
export function gateRole(tier: GateTier | undefined): ModelRole {
  switch (tier) {
    case "allow":
      return "ok";
    case "warn":
      return "warn";
    case "block":
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

/** A short glyph for a gate tier (the nemesis badge). */
export function gateGlyph(tier: GateTier | undefined): string {
  switch (tier) {
    case "allow":
      return "✓";
    case "warn":
      return "⚠";
    case "block":
      return "⛔";
    case "error":
      return "⚠";
    default:
      return "·";
  }
}

/** A short label for a gate tier ("clean"/"warn"/"BLOCK"/"error"/"ungated"). */
export function gateLabel(tier: GateTier | undefined): string {
  switch (tier) {
    case "allow":
      return "clean";
    case "warn":
      return "warn";
    case "block":
      return "BLOCK";
    case "error":
      return "error";
    default:
      return "scanning…";
  }
}

/** Does a gate tier REFUSE the admit (block/error)? (drives the deep-red row). */
export function gateRefuses(tier: GateTier | undefined): boolean {
  return tier === "block" || tier === "error";
}

/* ── §2.4 serve-status → {role,glyph,label} (the Serving panel chip) ────────── */

/** The four §2.4 serve statuses the Serving panel renders. */
export type ServeRowStatus = "stopped" | "starting" | "ready" | "error";

/** Map a serve status → its semantic role (ready=ok, starting=accent, error=danger). */
export function serveRole(status: ServeRowStatus): ModelRole {
  switch (status) {
    case "ready":
      return "ok";
    case "starting":
      return "accent";
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

/** A glyph for a serve status (● ready · ◐ starting · ○ stopped · ✗ error). */
export function serveGlyph(status: ServeRowStatus): string {
  switch (status) {
    case "ready":
      return "●";
    case "starting":
      return "◐";
    case "error":
      return "✗";
    default:
      return "○";
  }
}

/** A short label for a serve status ("READY"/"starting…"/"stopped"/"error"). */
export function serveLabel(status: ServeRowStatus): string {
  switch (status) {
    case "ready":
      return "READY";
    case "starting":
      return "starting…";
    case "error":
      return "error";
    default:
      return "stopped";
  }
}

/**
 * The verbs legal as serve-row actions in a given status (§7 Start/Stop/Use).
 * "kill" rides alongside "stop" everywhere a child process might still be alive to
 * signal — it's stop's force-escalation (SIGKILL now, no SIGTERM grace wait), not a
 * separate lifecycle state, so it's legal in exactly the same statuses as "stop".
 * "starting" is the status this matters most for: that's what "not responding
 * properly" looks like from the row's point of view.
 */
export function serveActions(status: ServeRowStatus): string[] {
  switch (status) {
    case "ready":
      return ["stop", "kill", "use", "endpoint"];
    case "starting":
      return ["stop", "kill"];
    case "error":
      return ["retry", "stop", "kill"];
    default:
      return ["start", "endpoint"];
  }
}

/* ── number / size formatting (the §7 table cells) ─────────────────────────── */

/** Format a GB float as a short size string (e.g. 5.6 → "5.6GB", 22.917 → "22.9GB"). */
export function formatGb(gb: number | null | undefined): string {
  if (typeof gb !== "number" || !Number.isFinite(gb) || gb < 0) return "—";
  if (gb >= 100) return `${Math.round(gb)}GB`;
  if (gb >= 10) return `${gb.toFixed(1)}GB`;
  return `${gb.toFixed(1)}GB`;
}

/** Format a byte count as a short human size (the download row). Binary units. */
export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Format a download count compactly (1_200_000 → "1.2M", 410_000 → "410k"). */
export function formatCount(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * The §7 quality bar as a fixed-width block string (qualityRank 0..1 → 5 cells).
 * PURE: clamps to [0,1]; renders filled blocks for the closeness-to-F16 quality.
 */
export function qualityBar(rank: number, cells = 5): string {
  const q = Math.max(0, Math.min(1, Number.isFinite(rank) ? rank : 0));
  const filled = Math.round(q * cells);
  return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}

/* ── §10 modality labels (the first-class facet sidebar) ───────────────────── */

/** The first-class modality facets (file 05 §10), in sidebar order. */
export const MODALITIES = [
  "text",
  "embedding",
  "vision",
  "asr",
  "reranker",
  "diffusion",
  "tts",
  "multimodal",
] as const;
export type ModalityFacet = (typeof MODALITIES)[number];

/** A human label for a modality facet (the §7 sidebar). */
export function modalityLabel(m: string): string {
  switch (m) {
    case "text":
      return "Text (LLM)";
    case "embedding":
      return "Embedding";
    case "vision":
      return "Vision / VLM";
    case "asr":
      return "ASR (speech→text)";
    case "reranker":
      return "Reranker";
    case "diffusion":
      return "Diffusion (image)";
    case "tts":
      return "TTS";
    case "multimodal":
      return "Multimodal";
    default:
      return inert(m) || "—";
  }
}

/* ── §6 free / open-weight classification (UI affordance, NOT security) ─────── */

/** Permissive / free open-source license prefixes (mirrors core modelhub-store FREE set). */
const FREE_OPEN_PREFIXES = ["apache", "mit", "bsd", "mpl", "cc0", "openrail"];
/** Permissive exact-match licenses (CC-BY variants are listed exactly so the
 * NON-commercial CC-BY-NC variants are NOT swept in by a bare "cc-by" prefix). */
const FREE_OPEN_EXACT = new Set([
  "gemma",
  "qwen",
  "llama3",
  "llama3.1",
  "cc-by-4.0",
  "cc-by-sa-4.0",
  "cc-by-3.0",
]);

/**
 * Is a license free / open-weight under a permissive license (file 05 §6)? Drives
 * the free/open-weight badge + the §6 sort-to-top. NOTE this is a LICENSE/policy
 * classification, NOT a security decision (C5 untouched). Non-commercial variants
 * (CC-BY-NC, CC-BY-ND) are deliberately NOT free here — they policy-gate elsewhere.
 */
export function isFreeOpenLicense(license: string): boolean {
  const lic = inert(license)
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (lic.includes("-nc") || lic.includes("-nd") || lic.includes("noncommercial")) return false;
  if (FREE_OPEN_EXACT.has(lic)) return true;
  return FREE_OPEN_PREFIXES.some((p) => lic.startsWith(p));
}

/* ── §4.4 recommended-quant explainer (PURE formatting of the sidecar reasons) ── */

/**
 * Render the §4.4 "Recommended: …" explainer line for a fit result. PURE: it uses
 * ONLY the recommended quant label + the sidecar's `reasons[]` (the explain-the-
 * recommendation ethos). It NEVER re-derives the recommendation — it formats what
 * fit.py chose. Reasons are run inert; an empty reasons list yields a bare line.
 */
export function recommendedExplainer(
  rec: { label: string } | null,
  reasons: readonly string[] | null | undefined,
): string {
  // Defensive: `reasons` rides in on an opaque fit-payload cast and may be absent.
  const safe = reasons ?? [];
  if (!rec) {
    const why = safe.map(inert).filter((r) => r.length > 0);
    return why.length > 0
      ? `No quant fits — ${why.join("; ")}`
      : "No quant fits your hardware (OVERFLOW): try a smaller quant, AirLLM, or a served open-weight API.";
  }
  const why = safe.map(inert).filter((r) => r.length > 0);
  const tail = why.length > 0 ? ` — ${why.join("; ")}` : "";
  return `Recommended: ${inert(rec.label)}${tail}`;
}

/* ── GateVerdictSheet adapter (reuse the file-03 <VerdictSheet/> for §5) ─────── */

const EMPTY_SEVERITY: Record<SecSeverity, number> = {
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  INFO: 0,
};

/**
 * Adapt a `ModelGateBadge` (the camelCased gate summary a download result carries)
 * → the structural `SecVerdict` the SHARED file-03 `<VerdictSheet/>` renders. We
 * DO NOT fabricate findings/counts we don't have: the sheet shows the engine's
 * `reasons` as blocking_reasons + the recommendation, and a FAIL-CLOSED `safe_to`
 * triad derived ONLY from the tier (block/error ⇒ not safe). This is presentation
 * re-shaping, never a security decision (C5) — the verdict is the engine's,
 * carried through unchanged. Reasons are run through `inert()`.
 */
export function gateToVerdict(gate: ModelGateBadge, target: string): SecVerdict {
  const tier = gate.verdict;
  const refuse = tier === "block" || tier === "error";
  const safe = tier === "allow";
  const reasons = (gate.reasons ?? []).map((r) => inert(r)).filter((r) => r.length > 0);
  return {
    schema: "nemesis.verdict/1",
    tool: "nemesis",
    tool_version: "",
    target,
    target_kind: "model",
    target_sha256: null,
    scanned_at: gate.scannedAt ?? "",
    duration_s: 0,
    verdict: tier,
    risk_score: typeof gate.score === "number" ? gate.score : refuse ? 100 : 0,
    exit_code: 0,
    severity_counts: { ...EMPTY_SEVERITY },
    class_counts: {},
    findings_by_class: {},
    safe_to: {
      install: safe,
      run_plug_and_play: safe,
      use_as_ai_cli_agent: safe,
    },
    recommendation: gate.recommendation ?? "",
    blocking_reasons: reasons,
    top_findings: [],
    unscannable: false,
    disinfection: null,
    provenance: {
      ruleset_sha: "",
      indicators_loaded: {},
      db: { seeded: true, age_days: 0, stale: false },
      findings_ignored: 0,
      files_scanned: 0,
      sca_unscanned_ecosystems: [],
    },
    policy: "",
    host: "",
    cached: false,
  };
}

/* ── §5.3 pickle vs safetensors/gguf supply-chain hint (display-only) ───────── */

/** High-risk pickle file extensions (§5.3) — surfaced as a loud download warning. */
const PICKLE_EXTS = [".bin", ".pt", ".ckpt", ".pth", ".pkl"];

/**
 * Is a filename a high-risk pickle format (§5.3 — arbitrary-code-on-load)? PURE
 * string check the download row renders as a "⚠ pickle" hint; the REAL risk
 * decision is nemesis' (this is only a display nudge toward safetensors/gguf).
 */
export function isPickleFile(filename: string): boolean {
  const f = inert(filename).toLowerCase();
  return PICKLE_EXTS.some((ext) => f.endsWith(ext));
}
