// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * persona-view.ts — pure Settings ▸ Personas helpers.
 *
 * Split out of PersonasPage.tsx for the same reason model-health-view.ts / hooks-panel.ts are
 * split from their pages: the run-tests.mjs node:test runner executes suites straight from TS
 * source via Node's native type-stripping loader, which can't transform JSX — a `.tsx` file
 * can't be `import`ed by a test at all. So the pure mapping/formatting logic this page needs
 * tested lives here, in a plain `.ts` sibling.
 *
 * SAFETY-COMMUNICATION NOTE (read packages/core/src/agent/agent-files.ts's header first): a
 * persona's `scope` is the entire security model — "project" and "imported" are clamped
 * IDENTICALLY and HARD (no model, forced read-only, tools only ever narrowed). `scopeLabel`'s
 * job for "imported" specifically is to make that clamp legible to a non-technical user reading
 * a settings table, not just to name the scope — "read-only" is the plain-English promise a
 * user needs to see before they trust something a stranger handed them.
 *
 * `suggestedImportName` mirrors (does NOT call) core's `agentNameFromFile`/`SAFE_NAME`: this is
 * a live UI preview only ("would this name be accepted?"), never the enforcement boundary — the
 * REAL sanitizer runs server-side, in the IPC handler in MAIN, before anything ever touches
 * disk. Keeping a second copy of the regex here is deliberate: a renderer-side helper must not
 * reach into MAIN's persistence code, and the whole point of this function is UX-only feedback,
 * so importing the authoritative one would overstate what this preview can promise anyway.
 *
 * PURE — no DOM, no IPC, no React.
 */
import type { HealthViewStatus } from "@prometheus/ui";

/** Where a persona file came from — mirrors core's `AgentFileScope` (agent-files.ts). */
export type PersonaScope = "user" | "project" | "imported";

/** One row `usePersonas`/`PersonasPage` render — mirrors `persona.list()`'s entry shape. */
export interface PersonaFileView {
  name: string;
  scope: PersonaScope;
  description: string;
}

/**
 * A short, human label for a persona's scope. For "imported" this MUST make the read-only /
 * no-model clamp obvious on sight — a real safety-communication requirement, not just copy.
 */
export function scopeLabel(scope: PersonaScope): string {
  switch (scope) {
    case "user":
      return "Your persona";
    case "project":
      return "From this project";
    case "imported":
      return "Shared (imported, read-only)";
    default:
      return scope;
  }
}

/**
 * The scope `StatusPill`'s status. "project" is neutral ("unknown") — it's informational, not a
 * safety concern. "imported" is a mild, honest "degraded" signal: its privilege was narrowed,
 * which is the intended, WORKING state for an imported persona, not a failure — so it must never
 * read as a full "down" alarm.
 */
export function scopePillStatus(scope: PersonaScope): HealthViewStatus {
  switch (scope) {
    case "user":
      return "ok";
    case "project":
      return "unknown";
    case "imported":
      return "degraded";
    default:
      return "unknown";
  }
}

/**
 * Mirrors core's `SAFE_NAME` regex (agent-files.ts) — NOT imported, see module header. A
 * name must be safe to type after a slash and safe to compare: lowercase letters/digits/`_`/`-`,
 * starting with a letter or digit, at most 32 characters.
 */
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Preview what an import name derived from `basenameOrTypedName` would become: strip a
 * trailing ".md", trim, lowercase — then validate against the mirrored `SAFE_NAME` shape.
 * Returns `null` when nothing safe can be made of it (empty, path separators, spaces,
 * oversized, a leading `-` or `.`, etc.), exactly like core's `agentNameFromFile` would refuse
 * it — so the caller can show "this name will be rejected" BEFORE the user hits Import, without
 * this preview ever being trusted as the actual safety boundary.
 */
export function suggestedImportName(basenameOrTypedName: string): string | null {
  const stem = basenameOrTypedName.trim().replace(/\.md$/i, "").trim().toLowerCase();
  return SAFE_NAME.test(stem) ? stem : null;
}
