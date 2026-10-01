// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/home-view.ts — PURE derivations for the Home mission-control route (handoff §2.3).
 *
 * Same split as `home-servers-view.ts`: anything that decides WHAT a Home island says
 * lives here, so it can be asserted by node:test without a DOM, while `home.tsx` keeps
 * only the JSX that renders the answer.
 */

/**
 * A resource reading is a number only when the probe SAID it measured one.
 *
 * `errorTelemetry` (main/telemetry-ipc.ts) fails soft with `{usedPct: 0, measured: false}`
 * so a throwing probe never white-screens the strip. A consumer that keys off
 * `Number.isFinite(usedPct)` alone therefore paints a confident "0%" over a reading whose
 * own envelope said it knew nothing — the contract's comment on that field reads
 * "`measured:false` ⇒ the figure is n/a (draw a dashed bar)". This is that honoured.
 */
export function meterPct(
  r: { usedPct: number; measured: boolean } | null | undefined,
): number | null {
  return r?.measured === true ? r.usedPct : null;
}

/* ── §2.3.5c: the Models island shows SERVING **and** INSTALLED ─────────────────── */

/** One row of the Home Models island. */
export interface HomeModelRow {
  /** the model id, as the mono cell prints it. */
  id: string;
  /** "serving" (a ready serve profile) · "installed" (present, not served) · the raw
   *  supervisor status for a profile that is neither (starting / error / stopped). */
  state: string;
  /** true only for a READY serve profile — the row's green dot. */
  serving: boolean;
}

/** The shape a serve profile contributes. Narrow on purpose — this is all the island uses. */
export interface ServeProfileLike {
  id?: string;
  modelId?: string;
  status?: string;
}

/**
 * Merge serve profiles with the installed library into the island's rows.
 *
 * §2.3 asks this island for "serving/installed rows". It was fed `model:serving` ALONE,
 * which returns SERVE PROFILES — so a model that is downloaded but has never been given a
 * profile did not appear at all, and the island's empty state said "No model installed
 * yet." to a user with a full library. It also printed the raw supervisor status, so a
 * profile sitting at `stopped` read as "stopped" where the spec (and the prototype) say
 * "installed".
 *
 * Profiles come first because a serving model is the more urgent fact, and a model that has
 * both a profile and a library entry is ONE row — deduped by id, profile wins.
 */
export function homeModelRows(
  profiles: readonly ServeProfileLike[] | null | undefined,
  library: readonly { id: string }[] | null | undefined,
): HomeModelRow[] {
  const rows: HomeModelRow[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(profiles) ? profiles : []) {
    const id = p?.modelId ?? p?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ready = p.status === "ready";
    // a profile that is not ready is still an INSTALLED model — "stopped" is a fact about
    // the supervisor, not about whether the weights are on disk.
    rows.push({
      id,
      serving: ready,
      state: ready ? "serving" : p.status && p.status !== "stopped" ? p.status : "installed",
    });
  }
  for (const m of Array.isArray(library) ? library : []) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    rows.push({ id: m.id, serving: false, state: "installed" });
  }
  return rows;
}

/** The island's header count — counted from the ROWS it is standing above. */
export function homeModelsHeader(rows: readonly HomeModelRow[]): string {
  const serving = rows.filter((r) => r.serving).length;
  return `${serving} serving · ${rows.length - serving} installed`;
}
