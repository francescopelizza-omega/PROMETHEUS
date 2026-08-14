/**
 * routes/catalog-browse-view.ts — PURE view model for the handoff_3 §2 Catalog.
 *
 * §2 turns the catalog into two islands: a BROWSE island (rows with a verdict chip) and an
 * INSTALL island (a five-step stepper over a streaming log). Both need decisions — which
 * chip, which step is active — that are pure functions of state, so they live here where
 * node:test can pin them instead of inside JSX where only a screenshot can.
 *
 * ## The verdict chip is honest about not knowing
 *
 * `CatalogItem` (packages/core/src/catalog/types.ts) carries no scan verdict, and there is
 * no engine read that returns one for an item the user has never touched. So the chip's
 * DEFAULT is `QUEUED` — "nemesis has not spoken about this yet" — and a real tier appears
 * only once an `audit` or an install dry-run actually produced one. That is the fail-closed
 * reading and it is also the true one; painting `ALLOW` on an unscanned row would be a lie
 * the footer strip directly contradicts.
 */

import type { RoleToken, VerdictTier } from "@prometheus/ui";

/* ── verdict chips (§2) ──────────────────────────────────────────────────────*/

/** A row's gate state: a real tier, or `queued` when nothing has scanned it yet. */
export type CatalogVerdict = VerdictTier | "queued";

/** How one verdict chip paints. `role` resolves to a CSS var — never a raw hex (08 §6). */
export interface VerdictChipView {
  glyph: string;
  label: string;
  role: RoleToken;
}

/**
 * The four chips §2 names, plus `error`.
 *
 * §2 lists ALLOW / WARN / BLOCK / QUEUED, but `VerdictTier` has a fifth member: `error`,
 * which is "the scanner could not speak". Folding it into BLOCK would tell the user a
 * finding exists when the truth is that nothing ran — a different problem with a different
 * fix — so it gets its own label at the same (danger) role.
 */
export const CATALOG_VERDICT_CHIP: Readonly<Record<CatalogVerdict, VerdictChipView>> =
  Object.freeze({
    allow: { glyph: "●", label: "ALLOW", role: "ok" },
    warn: { glyph: "◑", label: "WARN", role: "warn" },
    block: { glyph: "✕", label: "BLOCK", role: "danger" },
    error: { glyph: "✕", label: "SCAN FAILED", role: "danger" },
    queued: { glyph: "◌", label: "QUEUED", role: "text-secondary" },
  });

/** Coerce an engine verdict string to a chip key; anything unknown reads as `queued`. */
export function catalogVerdictOf(raw: string | null | undefined): CatalogVerdict {
  switch (raw) {
    case "allow":
    case "warn":
    case "block":
    case "error":
      return raw;
    default:
      return "queued";
  }
}

/* ── the install stepper (§2) ────────────────────────────────────────────────*/

/** The five steps §2 names, in order. */
export const INSTALL_STEPS = ["Fetch", "Dry-run", "Verdict", "Confirm", "Install"] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];

/** A step's dot state: green done · amber pulsing active · muted pending. */
export type StepState = "done" | "active" | "pending";

/** Where an install run currently is. */
export type InstallPhase = "idle" | "fetch" | "dryRun" | "verdict" | "confirm" | "install" | "done";

/** The real signals the route already tracks, named so the mapping below is checkable. */
export interface InstallRunState {
  /** a run is armed (a runId was minted and the mutation is in flight). */
  running: boolean;
  /** which leg is running: the dry-run preview, or the committing install. */
  leg: "dry" | "commit" | null;
  /** the engine has emitted at least one line for this run. */
  hasOutput: boolean;
  /** a verdict is on screen waiting for the human to confirm or abort. */
  awaitingVerdict: boolean;
  /** the commit leg finished. */
  completed: boolean;
}

/**
 * Derive the phase from state.
 *
 * `fetch` vs `dryRun` is split on `hasOutput` rather than on a timer: the dry leg fetches to
 * staging and only then starts printing, so the first streamed line IS the transition. This
 * matters because the stepper is the only progress signal the user gets during a long clone,
 * and a stepper that jumps straight to "Dry-run" while nothing has happened is decoration.
 */
export function installPhase(s: InstallRunState): InstallPhase {
  if (s.completed) return "done";
  if (s.awaitingVerdict) return "verdict";
  if (s.running && s.leg === "commit") return "install";
  if (s.running && s.leg === "dry") return s.hasOutput ? "dryRun" : "fetch";
  return "idle";
}

/** Phase → the index of the step that is ACTIVE (-1 = none: idle, or everything done). */
const PHASE_INDEX: Readonly<Record<InstallPhase, number>> = Object.freeze({
  idle: -1,
  fetch: 0,
  dryRun: 1,
  verdict: 2,
  confirm: 3,
  install: 4,
  done: -1,
});

/**
 * The dot state of every step for a phase.
 *
 * `done` marks every step BEFORE the active one, so the stepper reads as a progress bar with
 * labels rather than five independent lights. In the `done` phase every step is `done`; in
 * `idle` every step is `pending`.
 */
export function stepStates(phase: InstallPhase): StepState[] {
  if (phase === "done") return INSTALL_STEPS.map((): StepState => "done");
  const active = PHASE_INDEX[phase];
  return INSTALL_STEPS.map(
    (_, i): StepState =>
      active < 0 ? "pending" : i < active ? "done" : i === active ? "active" : "pending",
  );
}

/* ── the browse island's kind filter ─────────────────────────────────────────*/

/**
 * §1 folded Plugins + Extensions + Skills into one route, but the catalog itself carries
 * more kinds than "plugin" — apps, model tools, world-sims, and documented-only entries all
 * arrive in the same `browse()` payload. §2's segmented control has three segments, so these
 * live as a SECONDARY filter inside the Plugins segment rather than being dropped: a merge
 * that silently made four registries unreachable would be a worse regression than a filter row.
 */
export const CATALOG_KINDS = [
  { id: "all", label: "All", glyph: "⬚" },
  { id: "plugin", label: "Plugins", glyph: "⬚" },
  { id: "app", label: "Apps", glyph: "▣" },
  { id: "model-tool", label: "Model tools", glyph: "◴" },
  { id: "worldsim", label: "World-Sim", glyph: "◈" },
  { id: "documented", label: "Documented", glyph: "▤" },
] as const;
export type CatalogKindFilter = (typeof CATALOG_KINDS)[number]["id"];

/** The row glyph for an item kind (the 30px tinted chip, §2). */
export function kindGlyph(kind: string, tier: string): string {
  if (tier === "documented") return "▤";
  const hit = CATALOG_KINDS.find((k) => k.id === kind);
  return hit ? hit.glyph : "⬚";
}

/** The minimal item shape the filters read — structural, so the contract type satisfies it. */
export interface FilterableItem {
  kind: string;
  tier: string;
  title: string;
  summary: string;
}

/**
 * Apply the kind filter.
 *
 * `documented` is a TIER, not a kind, and it is excluded from every other bucket — a
 * documented-only entry is not installable, so listing it beside installable plugins would
 * put an Install button next to something core refuses to install (and the button is absent
 * upstream, which then reads as a bug rather than as the policy it is).
 */
export function filterByKind<T extends FilterableItem>(
  items: readonly T[],
  kind: CatalogKindFilter,
): T[] {
  if (kind === "documented") return items.filter((i) => i.tier === "documented");
  const live = items.filter((i) => i.tier !== "documented");
  return kind === "all" ? live : live.filter((i) => i.kind === kind);
}

/** Apply the header search box across title + summary. An empty query matches everything. */
export function filterBySearch<T extends FilterableItem>(items: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter(
    (i) =>
      i.title.toLowerCase().includes(needle) || (i.summary ?? "").toLowerCase().includes(needle),
  );
}

/** The §2 footer strip. One sentence, kept here so the copy has a single home. */
export const CATALOG_FOOTER_NOTE =
  "Every item is fetched to staging and scanned by nemesis before anything executes — fail-closed.";
