/**
 * commands/tokens-report.ts — the PURE aggregation behind `prometheus tokens report` (CLI-090).
 *
 * Turns one SESSION's accounting records (CLI-029, extended with prompt-cache counters) plus the
 * enable/disable toggles (CLI-088) into a measured-effectiveness report: how many cache-read tokens
 * the prompt-caching technique actually earned this session and the ESTIMATED $ saved vs. paying the
 * full input rate. Techniques with no runtime signal are labeled "advisory only" — never a
 * fabricated or all-zero number dressed up as a measurement.
 *
 * NO fs, NO clock, NO engine — records/toggles/pricing are injected so the whole thing is unit-
 * testable. The $ estimate reuses the SAME pricing table CLI-058/CLI-089 use (`priceForModel`);
 * there is deliberately no second pricing source.
 */
import { type Pricing, priceForModel, tokenEconomy } from "@prometheus/core";

import type { AccountingRecord } from "../session/history-store.js";

/** One technique's line in the report. */
export interface TechniqueMeasure {
  id: string;
  name: string;
  wiring: "wired" | "advisory";
  enabled: boolean;
  /** true only when real runtime data drives this line (today: prompt-caching w/ a cache field). */
  measured: boolean;
  turns?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /** ESTIMATED USD saved vs. full input price; `null` ⇒ tokens measured but the model is unpriced. */
  estSavedUsd?: number | null;
  /** human note for the un-measured/advisory/unsupported case. */
  note?: string;
}

/** Per-model raw cache counters (exposed under `--json` for scripting/telemetry). */
export interface CacheModelRaw {
  turns: number;
  cacheRead: number;
  cacheCreate: number;
  /** true when at least one of this model's records carried a cache field (measured, not assumed). */
  hasCacheField: boolean;
}

/** The whole report — human render + `--json` raw counters both derive from this. */
export interface CacheEconomyReport {
  sessionId: string | null;
  turns: number;
  /** true when ANY record this session carried a cache-read field (⇒ caching is measurable here). */
  measurable: boolean;
  raw: {
    turns: number;
    promptTokens: number;
    completionTokens: number;
    cacheRead: number;
    cacheCreate: number;
    byModel: Record<string, CacheModelRaw>;
  };
  techniques: TechniqueMeasure[];
}

/**
 * Provider-specific cache-read savings coefficient = (1 − cache-read price multiplier). Anthropic
 * bills cache-read at ~0.1× input ⇒ 0.9 saved; OpenAI cached at 0.5× ⇒ 0.5 saved; Gemini ~0.25× ⇒
 * 0.75 saved. Inferred from the model id (the record carries no provider tag). Unknown ⇒ the
 * conservative-common Anthropic-style 0.9 (still clearly labeled an estimate at the render layer).
 */
export function cacheSavingsCoeff(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.includes("claude")) return 0.9;
  if (id.includes("gemini")) return 0.75;
  if (id.includes("gpt") || /(^|[^a-z])o[134]([^a-z]|$)/.test(id)) return 0.5;
  return 0.9;
}

/**
 * Build the session cache-economy report (CLI-090). Pure over the injected records/toggles/pricing.
 * `measurable` distinguishes "no cache field in any usage payload → not available for this provider"
 * from "cache field present but 0 hits → measured, caching didn't help yet".
 */
export function buildCacheReport(
  records: readonly AccountingRecord[],
  toggles: Record<string, boolean>,
  pricing: Pricing,
  sessionId: string | null,
): CacheEconomyReport {
  const byModel: Record<string, CacheModelRaw> = {};
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let measurable = false;
  let savedUsd = 0;
  let anyPriced = false;

  for (const r of records) {
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    const bucket = byModel[r.model] ?? {
      turns: 0,
      cacheRead: 0,
      cacheCreate: 0,
      hasCacheField: false,
    };
    byModel[r.model] = bucket;
    bucket.turns += 1;
    if (r.cacheRead !== undefined) {
      measurable = true;
      bucket.hasCacheField = true;
      bucket.cacheRead += r.cacheRead;
      cacheRead += r.cacheRead;
      // $ saved on THIS record's cache-read tokens, at this model's input rate × its provider coeff.
      const price = priceForModel(pricing, r.model);
      if (price) {
        anyPriced = true;
        savedUsd += (r.cacheRead / 1e6) * price.inputUsdPerMTok * cacheSavingsCoeff(r.model);
      }
    }
    if (r.cacheCreate !== undefined) {
      // a cache-CREATE field is also a measured cache signal — else a create-only session would
      // report "no cache field" while raw.cacheCreate > 0 (self-contradictory).
      measurable = true;
      bucket.hasCacheField = true;
      bucket.cacheCreate += r.cacheCreate;
      cacheCreate += r.cacheCreate;
    }
  }

  const techniques: TechniqueMeasure[] = tokenEconomy.TOKEN_TOOLS.map((tool) => {
    const wiring = tokenEconomy.tokenWiring(tool.id);
    const enabled = toggles[tool.id] === true;
    const base: TechniqueMeasure = {
      id: tool.id,
      name: tool.name,
      wiring,
      enabled,
      measured: false,
    };
    if (tool.id === "prompt-caching") {
      if (measurable) {
        return {
          ...base,
          measured: true,
          turns: records.length,
          cacheReadTokens: cacheRead,
          cacheCreateTokens: cacheCreate,
          // measured tokens but no priced model ⇒ null (n/a), never a fabricated dollar figure.
          estSavedUsd: anyPriced ? savedUsd : null,
        };
      }
      return {
        ...base,
        note: "not available for this provider (no cache field in usage payloads this session)",
      };
    }
    return { ...base, note: "advisory only — no runtime measurement available" };
  });

  return {
    sessionId,
    turns: records.length,
    measurable,
    raw: { turns: records.length, promptTokens, completionTokens, cacheRead, cacheCreate, byModel },
    techniques,
  };
}
