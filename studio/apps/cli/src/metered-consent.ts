// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * metered-consent.ts — the CLI's per-provider "ENABLE METERED" consent receipt (CLI-031).
 *
 * Tier-C api-key providers can spend money, so the first metered call from the terminal
 * requires the file-12 §4.1 typed-confirm — the user types the EXACT phrase `ENABLE
 * METERED`. The consent is the SAME receipt shape core validates: an ISO-8601 timestamp
 * (`confirmedCostWarningAt`) keyed per provider id, persisted in the CLI settings store so
 * it is asked ONCE, not per call. Corrupt-tolerant read (bad settings ⇒ "no consent",
 * never auto-grant, never throw). Local/subscription (Tier A/B) providers never use this.
 */
import { loadSettings, prometheusHome, saveSettings } from "./home.js";

/** The exact, case-sensitive phrase the user must type (mirrors the GUI §4.1 wording). */
export const ENABLE_METERED_PHRASE = "ENABLE METERED";

/** Settings key holding `{ [providerId]: confirmedCostWarningAt }`. */
const CONSENT_KEY = "meteredConsent";

/** All persisted metered-consent receipts (providerId → ISO timestamp). Fail-soft → {}. */
export function readMeteredConsent(home: string = prometheusHome()): Record<string, string> {
  const raw = loadSettings(home)[CONSENT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === "string" && at.length > 0) out[id] = at;
  }
  return out;
}

/** Has this provider's metered consent been granted (a receipt exists)? */
export function hasMeteredConsent(providerId: string, home: string = prometheusHome()): boolean {
  return typeof readMeteredConsent(home)[providerId] === "string";
}

/** Persist a metered-consent receipt (`confirmedCostWarningAt`) for a provider. */
export function grantMeteredConsent(
  providerId: string,
  iso: string,
  home: string = prometheusHome(),
): void {
  const merged = { ...readMeteredConsent(home), [providerId]: iso };
  saveSettings({ [CONSENT_KEY]: merged }, home);
}

/**
 * Validate a typed line against the exact phrase (CLI-031). readline strips the trailing
 * newline but NOT surrounding spaces; we strip exactly ONE trailing `\r`/`\n`/`\r\n` and
 * compare with strict `===` — a leading/trailing space or a case variant is REJECTED.
 */
export function isEnableMeteredPhrase(line: string): boolean {
  return line.replace(/\r?\n?$/, "") === ENABLE_METERED_PHRASE;
}
