// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates-panel.ts — the rules behind Settings ▸ Updates & Conflicts.
 *
 * Pure, and separate from the `.tsx`, for the reason `memory-block.ts` states and this repo has
 * been bitten by twice: `.tsx` cannot be loaded by `node:test`, so logic that lives in a
 * component is logic nothing tests.
 *
 * ## What this page exists for
 *
 * `updates:check` has been registered in main and exposed in preload for a long time, and
 * `stores/tool-updates.ts` + `tool-updates-derive.ts` are complete and tested — with ZERO
 * importers. The whole third-party update and install-conflict feature was reachable from the
 * terminal (`/updates`, `/updates fix`) and from nothing in Studio.
 *
 * ## The one rule that is load-bearing
 *
 * PROMETHEUS PROPOSES; IT NEVER AUTO-UPDATES. The IPC deliberately sends display STRINGS, not
 * argv, and this page offers copy-to-clipboard — never a Run button. An update is a change to
 * the user's machine outside this app's control, and the whole point of the conflict detection
 * is that the obvious command is sometimes the wrong one.
 *
 * The terminal's renderer (`apps/cli/src/updates/updates-cmd.ts:191 renderFix`) carries two
 * choices that are not cosmetic, and both are reproduced here:
 *
 *   1. ONE repair per SUBJECT. The same duplicate install surfaces as several conflicts sharing
 *      a single fix; listing it per-conflict invites running it three times. (Main already
 *      dedupes via `u.runnable`, so this is a guard against a future regression upstream.)
 *   2. `NEVER_RUN` is shown WITH the repairs, not instead of them. A user who is not told why
 *      `--zap` is dangerous will find it in a forum answer and reach for it precisely because
 *      it sounds thorough — on this machine that one deletes the vendor Claude install, all
 *      five builds, plus `~/.claude.json*`.
 */
import type {
  UpdateRemedyView,
  UpdateToolView,
  UpdatesReportResult,
} from "../../shared/ipc-contract.js";

/** A remedy as the page renders it: its steps already flattened to copyable lines. */
export interface RemedyCard {
  subject: string;
  title: string;
  rationale: string;
  /** every step's display command, in order — what the Copy button puts on the clipboard. */
  commands: string[];
  /** per-step prose, index-aligned with `commands`. */
  purposes: string[];
  /** undo lines, index-aligned; "" where a step cannot be undone. */
  undos: string[];
  verify?: string;
  keeps?: string;
  /** set ⇒ the steps must NOT be offered; the text says why and is shown instead of them. */
  blocked?: string;
  permanent: boolean;
  minAuthLevel: number;
}

/**
 * Project the IPC remedies into cards, one per subject.
 *
 * A `blocked` remedy still produces a card with NO commands. That is deliberate and is the
 * terminal's behaviour: a blocked repair is how the user learns the obvious command is a trap,
 * which is worth more than silence.
 */
export function remedyCards(remedies: readonly UpdateRemedyView[]): RemedyCard[] {
  const seen = new Set<string>();
  const out: RemedyCard[] = [];
  for (const m of remedies) {
    if (seen.has(m.subject)) continue;
    seen.add(m.subject);
    const steps = m.blocked ? [] : m.steps;
    out.push({
      subject: m.subject,
      title: m.title,
      rationale: m.rationale,
      commands: steps.map((s) => s.command),
      purposes: steps.map((s) => s.purpose),
      undos: steps.map((s) => s.undo ?? ""),
      ...(m.verify ? { verify: m.verify } : {}),
      ...(m.keeps ? { keeps: m.keeps } : {}),
      ...(m.blocked ? { blocked: m.blocked } : {}),
      permanent: m.permanent,
      minAuthLevel: m.minAuthLevel,
    });
  }
  return out;
}

/**
 * The whole repair, as one clipboard payload.
 *
 * Commands only — no prose, no `$` prompts — because what lands on the clipboard is pasted into
 * a shell. A blocked remedy yields "" and the UI hides the button rather than offering an empty
 * copy that reads as "nothing to do".
 */
export function remedyClipboard(card: RemedyCard): string {
  return card.commands.join("\n");
}

/** A tool row the page shows, with its state already decided. */
export interface ToolRow {
  id: string;
  current: string;
  latest: string;
  /** `null` from the report means the lookup FAILED — never render that as "up to date". */
  state: "update" | "current" | "unknown" | "absent";
  /** `duplicate` / `shadowed` / `ambiguous` — the install problem, when there is one. */
  install?: string;
  note?: string;
}

/**
 * Project a tool into a row.
 *
 * `updateAvailable` is THREE-valued on purpose and the third value is the whole point: `null`
 * means the version lookup could not be made. Collapsing it to `false` would tell the user a
 * tool is up to date when nothing checked — the failure mode the report's own field exists to
 * prevent.
 */
export function toolRow(t: UpdateToolView): ToolRow {
  const state: ToolRow["state"] = !t.installed
    ? "absent"
    : t.updateAvailable === null
      ? "unknown"
      : t.updateAvailable
        ? "update"
        : "current";
  return {
    id: t.id,
    current: t.current ?? "",
    latest: t.latest ?? "",
    state,
    ...(t.state && t.state !== "single" && t.state !== "absent" ? { install: t.state } : {}),
    ...(t.note ? { note: t.note } : {}),
  };
}

/** A one-line summary for the nav badge. Empty when there is nothing to say. */
export function headline(r: UpdatesReportResult | null): string {
  if (!r) return "";
  if (!r.ok) return r.error ? `check failed — ${r.error}` : "check failed";
  return r.summary;
}

/**
 * Should the panel shout?
 *
 * A conflict outranks an available update, because a conflict means an update may not even
 * apply — the same precedence `deriveBadge` uses, restated here for the page's own styling so
 * the two cannot disagree about which colour to use.
 */
export function severityOf(r: UpdatesReportResult | null): "none" | "info" | "warn" {
  if (!r?.ok) return r ? "warn" : "none";
  if (r.conflicts.length > 0) return "warn";
  if (r.tools.some((t) => t.updateAvailable === true)) return "info";
  if (r.packages.length > 0) return "info";
  return "none";
}
