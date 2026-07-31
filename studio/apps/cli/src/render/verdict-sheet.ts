/**
 * render/verdict-sheet.ts — P3 ANSI projector for a C3 SecurityVerdict.
 *
 * This is the full-page "sheet" form of a security verdict, used by the
 * interactive session host (P4) and any verb that wants a boxed, scannable
 * verdict panel rather than the one-line `prom gate` form. It is pure
 * presentation over a verdict the engine-bridge already decided (C5): the CLI
 * NEVER upgrades/downgrades safety here — it only renders the tier, the
 * findings, and (when blocking) the typed-confirm override affordance.
 *
 * It deliberately REUSES the canonical helpers in ../verdict-view.ts
 * (`tierLabel`, `tierHeadline`, `renderVerdict`, `exitCodeForTier`) instead of
 * re-deriving tier colors/exit-codes — there is one source of truth for those.
 * What this file adds on top:
 *   - a framed heading bar tinted by the verdict tier (tokens/ansi roles),
 *   - a gate badge line (the nemesis decision + risk score + signed flag),
 *   - an explicit override affordance for blocking tiers (block/error) that
 *     honors never-force / gate-first: it only TELLS the user the typed-confirm
 *     phrase + flag; it decides nothing and forces nothing,
 *   - an optional forced-danger recap when an override was already applied.
 *
 * Color flows exclusively through ../render.ts (which sources its SGR codes from
 * @prometheus/ui/tokens). No raw hex — check-no-raw-hex.mjs gates that.
 */
import type { ForcedDanger, SecurityVerdict } from "@prometheus/engine-bridge";
import { isBlockingTier } from "@prometheus/engine-bridge";

import { c, sym } from "../render.js";
import { renderVerdict, tierHeadline, tierLabel } from "../verdict-view.js";

/** Options that tune the sheet without changing what the verdict says. */
export interface VerdictSheetOptions {
  /**
   * What the verdict gates ("install", "run", "scan", …). Shapes the override
   * affordance wording ("To install anyway …"). Defaults to "proceed".
   */
  action?: string;
  /**
   * Profile / context forbids --force (profileForbidsForce). When true the
   * override affordance is replaced by a hard "forbidden by profile" line — we
   * never advertise a bypass the active profile has disabled.
   */
  forbidForce?: boolean;
  /**
   * Forced-danger records the engine returned when an override was ALREADY
   * applied (envelope.forced_danger). Rendered as a recap so the user sees what
   * was overridden. Absent in the normal pre-decision case.
   */
  forced?: ForcedDanger[];
  /** Hide the gate badge line (e.g. when the caller renders its own). */
  hideBadge?: boolean;
  /** Total visible width of the framing bars. Defaults to 60, clamped 24..120. */
  width?: number;
}

/** Pick the semantic ANSI role for a tier (drives the heading bar tint). */
function tierRoleTint(tier: SecurityVerdict["verdict"], s: string): string {
  switch (tier) {
    case "allow":
      return c.role(s, "ok");
    case "warn":
      return c.role(s, "warn");
    default:
      // block + error => danger.
      return c.role(s, "danger");
  }
}

/** A leading status glyph for the tier (reuses the shared symbol palette). */
function tierGlyph(tier: SecurityVerdict["verdict"]): string {
  switch (tier) {
    case "allow":
      return sym.ok();
    case "warn":
      return sym.warn();
    default:
      return sym.bad();
  }
}

/** A full-width rule line tinted by the verdict tier. */
function rule(tier: SecurityVerdict["verdict"], width: number): string {
  return tierRoleTint(tier, "─".repeat(width));
}

/**
 * Render the override affordance for a blocking verdict. This NEVER forces
 * anything: gate-first + never-force means the JS only surfaces the typed-confirm
 * phrase and the flag the user must opt into; the engine still re-decides.
 */
function overrideAffordance(
  tier: SecurityVerdict["verdict"],
  action: string,
  forbidForce: boolean,
): string[] {
  if (!isBlockingTier(tier)) return [];
  if (forbidForce) {
    return [
      "",
      c.role(
        `${sym.bad()} Override is forbidden by the active profile (profileForbidsForce).`,
        "danger",
      ),
      c.dim("There is no bypass available in this context."),
    ];
  }
  const phrase = tier === "error" ? "I ACCEPT THE RISK" : "OVERRIDE BLOCK";
  return [
    "",
    c.role(`${sym.warn()} This is a DANGEROUS override.`, "warn"),
    `To ${action} anyway you must pass ${c.bold("--force")} and type the exact phrase`,
    `  ${c.bold(`"${phrase}"`)} ${c.dim("when prompted.")}`,
    c.dim("The engine re-evaluates the verdict; nothing here grants permission."),
  ];
}

/** Render the forced-danger recap (an override that was ALREADY applied). */
function forcedRecap(forced: ForcedDanger[]): string[] {
  if (forced.length === 0) return [];
  const out: string[] = [
    "",
    c.role(`${sym.bad()} OVERRIDE APPLIED — forced past a block:`, "danger"),
  ];
  for (const f of forced) {
    out.push(`  ${c.bold(f.label)} ${c.dim(`(${f.verdict}, risk ${f.risk_score})`)}`);
    for (const reason of f.blocking_reasons) {
      out.push(c.dim(`    ${sym.bullet()} ${reason}`));
    }
  }
  return out;
}

/**
 * Render a SecurityVerdict as a full ANSI "sheet": a tier-tinted heading bar,
 * the canonical verdict body (target / risk / signed / findings table from
 * ../verdict-view.ts), an optional override affordance for blocking tiers, and
 * an optional forced-danger recap. Returns a multi-line string (no trailing
 * newline) so callers can compose it into a pane/transcript.
 */
export function renderVerdictSheet(
  verdict: SecurityVerdict,
  opts: VerdictSheetOptions = {},
): string {
  const action = opts.action ?? "proceed";
  const width = Math.max(24, Math.min(120, opts.width ?? 60));
  const tier = verdict.verdict;

  const out: string[] = [];

  // --- heading bar: glyph + colored label + headline, framed by tier rules. ---
  out.push(rule(tier, width));
  out.push(`${tierGlyph(tier)} ${tierLabel(tier)}  ${c.dim(tierHeadline(tier))}`);
  out.push(rule(tier, width));
  out.push("");

  // --- gate badge: the nemesis decision at a glance (skippable). ---
  if (!opts.hideBadge) {
    const score = c.bold(String(verdict.risk_score));
    const signed = verdict.signed ? c.green("signed") : c.dim("unsigned");
    const findings =
      verdict.findings.length > 0
        ? c.yellow(`${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"}`)
        : c.dim("no findings");
    out.push(
      `${c.dim("gate:")} ${tierLabel(tier)} ${c.dim("·")} risk ${score} ${c.dim("·")} ${signed} ${c.dim("·")} ${findings}`,
    );
    out.push("");
  }

  // --- canonical verdict body (target/risk/signed + findings table). ---
  // Reuse ../verdict-view.ts so the body never drifts from `prom gate`.
  out.push(renderVerdict(verdict));

  // --- override affordance (blocking tiers only) — never-force / gate-first. ---
  out.push(...overrideAffordance(tier, action, opts.forbidForce ?? false));

  // --- forced-danger recap (an override already applied upstream). ---
  if (opts.forced && opts.forced.length > 0) {
    out.push(...forcedRecap(opts.forced));
  }

  return out.join("\n");
}
