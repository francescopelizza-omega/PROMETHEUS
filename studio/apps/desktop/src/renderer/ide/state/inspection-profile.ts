/**
 * ide/state/inspection-profile.ts — the PURE inspection-profile model (plan file 03 ·
 * JetBrains Inspection Profiles · VS Code problem severities parity).
 *
 * An inspection profile is a per-inspection severity override map. Each diagnostic is
 * identified by `source:code` (e.g. "pyright:reportUnusedImport"); the profile can raise
 * it, lower it, or turn it "off" (suppress). The Problems panel applies a profile to
 * filter/re-rank the live diagnostics; suppress-comments + nemesis-findings-as-
 * inspections layer on top of this same map. Pure (no react/monaco) → node:test-ed +
 * shareable with the prometheus `/inspect` CLI.
 */

/** Effective inspection severity (superset of the 4 LSP levels + "off" = suppressed). */
export type Severity = "error" | "warning" | "info" | "hint" | "off";

/** Rank for sorting (most severe first); "off" sinks to the bottom. */
export const SEVERITY_RANK: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
  off: 4,
};

/** LSP DiagnosticSeverity (1..4) → our Severity string (absent ⇒ "warning"). */
export function severityFromLsp(n: number | undefined): Severity {
  switch (n) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "warning";
  }
}

/** Severity string → LSP number; "off" ⇒ undefined (the diagnostic is suppressed). */
export function severityToLsp(s: Severity): number | undefined {
  switch (s) {
    case "error":
      return 1;
    case "warning":
      return 2;
    case "info":
      return 3;
    case "hint":
      return 4;
    default:
      return undefined;
  }
}

/** The fields we need off a diagnostic to identify + rank it (structurally = Diagnostic). */
export interface InspectableDiagnostic {
  severity?: number;
  source?: string;
  code?: string | number;
}

/** Stable inspection id for a diagnostic: `source:code`, or `source`, or "unknown". */
export function inspectionId(d: InspectableDiagnostic): string {
  const source = d.source?.trim();
  const code = d.code === undefined || d.code === null ? "" : String(d.code).trim();
  if (source && code) return `${source}:${code}`;
  if (source) return source;
  if (code) return code;
  return "unknown";
}

export interface InspectionProfile {
  name: string;
  /** inspectionId → severity override (absent ⇒ use the diagnostic's own severity). */
  overrides: Record<string, Severity>;
}

export function defaultProfile(): InspectionProfile {
  return { name: "Default", overrides: {} };
}

/** The severity a diagnostic ends up with under a profile (override wins over its own). */
export function effectiveSeverity(d: InspectableDiagnostic, profile: InspectionProfile): Severity {
  return profile.overrides[inspectionId(d)] ?? severityFromLsp(d.severity);
}

/** Set an override immutably (returns a new profile). */
export function setOverride(
  profile: InspectionProfile,
  id: string,
  severity: Severity,
): InspectionProfile {
  return { ...profile, overrides: { ...profile.overrides, [id]: severity } };
}

/** Remove an override immutably (returns a new profile; no-op if absent). */
export function clearOverride(profile: InspectionProfile, id: string): InspectionProfile {
  if (!(id in profile.overrides)) return profile;
  const next = { ...profile.overrides };
  delete next[id];
  return { ...profile, overrides: next };
}

const VALID_SEVERITIES = new Set<Severity>(["error", "warning", "info", "hint", "off"]);

/** Serialize a profile to JSON (the export-to-file payload). */
export function serializeProfile(profile: InspectionProfile): string {
  return JSON.stringify({ name: profile.name, overrides: profile.overrides }, null, 2);
}

/**
 * Parse an exported profile JSON → InspectionProfile, VALIDATED + fail-soft: a bad blob or a
 * non-object yields the Default profile; unknown/invalid override severities are dropped
 * (never coalesced to a real severity) so an imported file can't smuggle a bogus level.
 */
export function deserializeProfile(raw: string | null | undefined): InspectionProfile {
  if (!raw) return defaultProfile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultProfile();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultProfile();
  const obj = parsed as { name?: unknown; overrides?: unknown };
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name : "Imported";
  const overrides: Record<string, Severity> = {};
  if (obj.overrides && typeof obj.overrides === "object" && !Array.isArray(obj.overrides)) {
    for (const [id, sev] of Object.entries(obj.overrides as Record<string, unknown>)) {
      if (typeof sev === "string" && VALID_SEVERITIES.has(sev as Severity)) {
        overrides[id] = sev as Severity;
      }
    }
  }
  return { name, overrides };
}

/**
 * Apply a profile to a diagnostic list: drop anything the profile turned "off", and sort
 * the survivors by effective severity (most severe first), STABLE within a severity so
 * the caller's location order is preserved. The original objects are returned untouched.
 */
export function applyProfile<T extends InspectableDiagnostic>(
  diags: readonly T[],
  profile: InspectionProfile,
): T[] {
  const kept = diags
    .map((d, i) => ({ d, i, sev: effectiveSeverity(d, profile) }))
    .filter((x) => x.sev !== "off");
  kept.sort((a, b) => SEVERITY_RANK[a.sev] - SEVERITY_RANK[b.sev] || a.i - b.i);
  return kept.map((x) => x.d);
}
