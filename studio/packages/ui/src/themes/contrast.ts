/**
 * themes/contrast.ts — the §3.4 WCAG contrast checker + save-gate.
 *
 * Computes the load-bearing pairs for a resolved scheme and gates the save:
 *  - body text (text-primary/secondary on surfaces) must be ≥ 4.5:1 (AA);
 *  - role/UI tokens ≥ 3:1;
 *  - VERDICT tokens (ok/warn/danger/info) on their 14% tint — the HARD gate: a scheme
 *    that makes a verdict illegible CANNOT be saved (fail-closed; security legibility
 *    never yields to aesthetics, mirroring 08 §7's CI token-contrast test).
 *
 * Pure: reuses 08's `contrastRatio`/`meetsAA`/`blend` (tokens/contrast.ts) — never
 * reinvents the math. `autoFix` nudges an offending token toward legibility so the
 * user is never stuck (§3.4).
 */
import type { ColorScheme, SemanticColors } from "../tokens.js";
import { resolveScheme } from "../tokens.js";
import { blend, contrastRatio, meetsAA } from "../tokens/contrast.js";
import type { ContrastBadge, ContrastPair, ContrastReport } from "./types.js";

const AA_TEXT = 4.5;
const AA_UI = 3;
const AAA_TEXT = 7;

const VERDICT_ROLES: readonly (keyof SemanticColors)[] = ["ok", "warn", "danger", "info"];
const ROLE_TOKENS: readonly (keyof SemanticColors)[] = ["brand", "accent"];

function pair(
  label: string,
  fg: string,
  bg: string,
  required: number,
  kind: ContrastPair["kind"],
  role?: keyof SemanticColors,
): ContrastPair {
  const ratio = contrastRatio(fg, bg);
  return {
    label,
    fg,
    bg,
    ratio,
    required,
    pass: ratio >= required,
    kind,
    ...(role ? { role } : {}),
  };
}

/**
 * Measure every load-bearing pair for a scheme (§3.4). Verdict tokens are checked on
 * their 14% tint (the VerdictBadge/FindingRow render path — see 08 tokens.test).
 */
export function measurePairs(scheme: ColorScheme): ContrastPair[] {
  const s = resolveScheme(scheme);
  const pairs: ContrastPair[] = [];

  // body text (AA 4.5)
  pairs.push(
    pair("text-primary on bg-app", s["text-primary"], s["bg-app"], AA_TEXT, "body", "text-primary"),
  );
  pairs.push(
    pair(
      "text-primary on bg-surface",
      s["text-primary"],
      s["bg-surface"],
      AA_TEXT,
      "body",
      "text-primary",
    ),
  );
  pairs.push(
    pair(
      "text-secondary on bg-surface",
      s["text-secondary"],
      s["bg-surface"],
      AA_TEXT,
      "body",
      "text-secondary",
    ),
  );

  // role/UI tokens (UI 3:1)
  for (const role of ROLE_TOKENS) {
    pairs.push(pair(`${role} on bg-surface`, s[role], s["bg-surface"], AA_UI, "role", role));
  }

  // verdict tokens on their 14% tint — the HARD gate
  for (const role of VERDICT_ROLES) {
    const tinted = blend(s[role], s["bg-surface"], 0.14);
    pairs.push(pair(`${role} on its 14% tint`, s[role], tinted, AA_UI, "verdict", role));
  }
  return pairs;
}

/** Roll the measured pairs into the §3.4 report (badge + verdict failures). */
export function checkContrast(scheme: ColorScheme): ContrastReport {
  const pairs = measurePairs(scheme);
  const failures = pairs.filter((p) => !p.pass);
  const verdictFailures = failures.filter((p) => p.kind === "verdict");
  const passCount = pairs.length - failures.length;
  // AAA only when every body/verdict pair clears the AAA bar; AA when all pass; else fail.
  let badge: ContrastBadge;
  if (failures.length > 0) badge = "fail";
  else if (
    pairs.every((p) =>
      p.kind === "role" ? p.pass : p.ratio >= (p.kind === "body" ? AAA_TEXT : AA_UI + 1.5),
    )
  )
    badge = "AAA";
  else badge = "AA";
  return { badge, pairs, verdictFailures, failures, passCount, total: pairs.length };
}

/**
 * The pairs that BLOCK a save (APP-094): every VERDICT-token failure (the existing
 * fail-closed §3.4 gate) PLUS any PRIMARY-TEXT-on-background failure (`text-primary` body
 * pairs). A theme whose primary text is illegible against its own surface is as unusable as
 * one with illegible verdicts, so the gate covers both. Secondary-text / role failures remain
 * warnings only — the one place aesthetics may yield is never legibility of these two.
 */
export function saveBlockers(report: ContrastReport): ContrastPair[] {
  return report.failures.filter(
    (p) => p.kind === "verdict" || (p.kind === "body" && p.role === "text-primary"),
  );
}

/**
 * The save-gate (§3.4, extended APP-094): a scheme may be saved UNLESS a verdict token OR a
 * primary-text/background pair fails its contrast (fail-closed). Derives from `saveBlockers`
 * so the Save-button disabled state + this predicate never drift.
 */
export function canSave(report: ContrastReport): boolean {
  return saveBlockers(report).length === 0;
}

/** A short human reason when a save is blocked (lists the offending pairs). */
export function blockReason(report: ContrastReport): string {
  const blockers = saveBlockers(report);
  if (blockers.length === 0) return "";
  const list = blockers
    .map((p) => `${p.label} = ${p.ratio.toFixed(2)}:1 (needs ≥${p.required})`)
    .join("; ");
  return `illegible — cannot save: ${list}`;
}

/* ── per-token contrast verdict (APP-094) ────────────────────────────────────── */

/** A per-token WCAG verdict for the editor's live badge. `na` = a non-hex value we don't rate. */
export interface TokenVerdict {
  level: "AAA" | "AA" | "FAIL" | "na";
  ratio: number;
  /** the AA minimum this token must meet (per its role). */
  required: number;
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The live WCAG verdict for ONE editable token against its EFFECTIVE background (APP-094).
 * Effective bg by role: verdict tokens → their own 14% tint (the VerdictBadge render path);
 * `text-primary` → `bg-app` (the page); a `bg-*` token → measured as `text-primary` ON it
 * (a background is rated by the primary text that sits on it); everything else → `bg-surface`
 * (the panel a chip/role token sits on, NOT the page — the effective-bg layering). Only rates
 * concrete hex values (rgb/hsl/alpha tokens the color-picker never emits return `na`).
 */
export function contrastVerdictFor(tokenKey: string, scheme: ColorScheme): TokenVerdict {
  const s = resolveScheme(scheme);
  const get = (k: string): string | undefined => (s as unknown as Record<string, string>)[k];
  let fg: string | undefined;
  let bg: string | undefined;
  let required: number;
  let aaa: number;
  if ((VERDICT_ROLES as readonly string[]).includes(tokenKey)) {
    fg = get(tokenKey);
    bg = fg && get("bg-surface") ? blend(fg, get("bg-surface")!, 0.14) : undefined;
    required = AA_UI;
    aaa = AA_UI + 1.5;
  } else if (tokenKey === "text-primary") {
    fg = get("text-primary");
    bg = get("bg-app");
    required = AA_TEXT;
    aaa = AAA_TEXT;
  } else if (tokenKey === "text-secondary") {
    fg = get("text-secondary");
    bg = get("bg-surface");
    required = AA_TEXT;
    aaa = AAA_TEXT;
  } else if (tokenKey.startsWith("bg-")) {
    // a background token is rated by the primary text that sits on it.
    fg = get("text-primary");
    bg = get(tokenKey);
    required = AA_TEXT;
    aaa = AAA_TEXT;
  } else {
    fg = get(tokenKey);
    bg = get("bg-surface");
    required = AA_UI;
    aaa = AA_UI + 1.5;
  }
  if (!fg || !bg || !HEX_RE.test(fg) || !HEX_RE.test(bg))
    return { level: "na", ratio: 0, required };
  const ratio = contrastRatio(fg, bg);
  const level = ratio < required ? "FAIL" : ratio >= aaa ? "AAA" : "AA";
  return { level, ratio, required };
}

/* ── auto-fix (§3.4) — nudge an offending token until it passes ─────────────── */

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => clampByte(c).toString(16).padStart(2, "0")).join("")}`;
}
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.slice(0, 6);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Nudge `fg` toward white or black (away from `bg`) in small steps until it meets the
 * required ratio, so the user is never stuck (§3.4). Returns the original on success-by-
 * default; gives up after 24 steps (returning the best attempt) rather than loop forever.
 */
export function autoFix(fg: string, bg: string, kind: "text" | "ui" = "ui"): string {
  if (meetsAA(fg, bg, kind)) return fg;
  const bgLum = parseHex(bg).reduce((a, c) => a + c, 0) / 3;
  const toward: [number, number, number] = bgLum < 128 ? [255, 255, 255] : [0, 0, 0]; // light bg → darken fg, dark bg → lighten
  let cur = parseHex(fg);
  for (let i = 0; i < 24; i++) {
    cur = [
      cur[0] + (toward[0] - cur[0]) * 0.12,
      cur[1] + (toward[1] - cur[1]) * 0.12,
      cur[2] + (toward[2] - cur[2]) * 0.12,
    ];
    const candidate = toHex(cur);
    if (meetsAA(candidate, bg, kind)) return candidate;
  }
  return toHex(cur);
}
