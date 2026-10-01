// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * render/harden-view.ts — P3 projector for the `harden` envelope (the defensive,
 * read-only self-audit of THIS machine: firewall, listening ports, sshd config,
 * disk encryption, secret-file permissions).
 *
 * This is PURE PRESENTATION over a result the engine already produced (C5). The
 * CLI never re-scores or re-classifies a finding here — it only renders the
 * severity the engine assigned, severity-colored, with the suggested fix.
 *
 * Engine ground truth (`python3 prometheus.py --json harden`):
 *   {"command":"harden","ok":true,
 *    "findings":[{"severity":"warn","message":"...","fix":"..."}, ...],
 *    "warnings":3}
 *
 * `HardenFinding.severity` is typed `string` in engine-bridge (the engine emits
 * one of ok | warn | info | err), so we color the four known tiers and degrade
 * gracefully to a neutral label for anything unexpected — never crashing, never
 * inventing a verdict.
 *
 * Color flows ONLY through ./render.ts helpers (c.* / sym / table), which source
 * their 16-color ANSI codes from @prometheus/ui/tokens (§8.1 — no raw hex).
 */
import type { HardenFinding } from "@prometheus/engine-bridge";

import { c, sym, table } from "../render.js";

/** Options for {@link renderHardenFindings}. */
export interface HardenViewOptions {
  /**
   * Show the suggested fix line under each actionable finding. Default true.
   * When false, only the severity-tagged messages are listed (compact mode,
   * e.g. for a narrow pane or a quick glance).
   */
  showFixes?: boolean;
  /**
   * Hide `ok` findings (clean checks) and show only the items that need
   * attention (warn / err / info). Default false — a full posture report
   * lists every check so the user sees what WAS verified, not just failures.
   */
  warningsOnly?: boolean;
}

/** Severity tiers the engine emits, in worst→best display priority. */
type Severity = "err" | "warn" | "info" | "ok";

/** Normalize an arbitrary engine severity string to a known tier (fallback: info). */
function normalizeSeverity(sev: string): Severity {
  switch (sev) {
    case "err":
    case "warn":
    case "info":
    case "ok":
      return sev;
    default:
      // Unknown/future severities render as the neutral "info" tier — we never
      // guess a finding is safe or dangerous beyond what the engine told us.
      return "info";
  }
}

/** A colored single-char badge for a finding's severity (reuses the shared sym set). */
function severityBadge(sev: Severity): string {
  switch (sev) {
    case "ok":
      return sym.ok();
    case "warn":
      return sym.warn();
    case "err":
      return sym.bad();
    case "info":
      return sym.bullet();
  }
}

/** A colored, uppercased label for a finding's severity. */
function severityLabel(sev: Severity): string {
  switch (sev) {
    case "ok":
      return c.green("OK");
    case "warn":
      return c.yellow("WARN");
    case "err":
      return c.red("ERR");
    case "info":
      return c.dim("INFO");
  }
}

/**
 * Render the list of harden findings to a multi-line string.
 *
 * Layout (per finding):
 *   ● OK    no services bound to all interfaces (or none listening)
 *   ▲ WARN  macOS application firewall appears OFF
 *           fix: System Settings → Network → Firewall → On
 *
 * Followed by a one-line summary ("N item(s) to harden" or "solid posture").
 * Returns the full block with no trailing newline; returns a friendly empty
 * note when there are no findings at all (defensive — the engine always emits
 * at least one, but a malformed/empty payload must not produce a blank screen).
 */
export function renderHardenFindings(
  findings: readonly HardenFinding[],
  opts: HardenViewOptions = {},
): string {
  const showFixes = opts.showFixes ?? true;
  const warningsOnly = opts.warningsOnly ?? false;

  const out: string[] = [];
  out.push(c.bold("Harden — local security posture (read-only · THIS machine)"));
  out.push("");

  // Count warnings up front (the engine's `warnings` field counts only `warn`).
  const warnCount = findings.filter((f) => normalizeSeverity(f.severity) === "warn").length;
  const errCount = findings.filter((f) => normalizeSeverity(f.severity) === "err").length;

  const visible = warningsOnly
    ? findings.filter((f) => normalizeSeverity(f.severity) !== "ok")
    : findings;

  if (visible.length === 0) {
    // Either truly no findings, or warningsOnly filtered everything clean away.
    if (findings.length === 0) {
      out.push(c.dim("No findings — the audit returned nothing to show."));
    } else {
      out.push(`${sym.ok()} ${c.green("Solid posture — nothing to harden.")}`);
    }
    return out.join("\n");
  }

  for (const f of visible) {
    const sev = normalizeSeverity(f.severity);
    out.push(`${severityBadge(sev)} ${severityLabel(sev)}  ${f.message}`);
    if (showFixes && f.fix.trim().length > 0) {
      // Indent the fix under its finding (visible width of "● WARN  " ≈ 8).
      out.push(`        ${c.dim("fix:")} ${f.fix}`);
    }
  }

  out.push("");
  if (warnCount === 0 && errCount === 0) {
    out.push(`${sym.ok()} ${c.green("No obvious local weaknesses found — solid posture.")}`);
  } else {
    const parts: string[] = [];
    if (warnCount > 0) parts.push(c.yellow(`${warnCount} warning${warnCount === 1 ? "" : "s"}`));
    if (errCount > 0) parts.push(c.red(`${errCount} error${errCount === 1 ? "" : "s"}`));
    out.push(`${sym.warn()} ${parts.join(", ")} to harden (see above).`);
  }

  return out.join("\n");
}

/**
 * Compact tabular variant: a two-column SEVERITY / FINDING table (no fix lines).
 * Handy for a dense pane where vertical space is tight. Same data, no opts —
 * exposed as a small convenience; `renderHardenFindings` remains the primary,
 * contract-required entry point.
 */
export function renderHardenTable(findings: readonly HardenFinding[]): string {
  if (findings.length === 0) return c.dim("No findings.");
  const rows = findings.map((f) => {
    const sev = normalizeSeverity(f.severity);
    return [`${severityBadge(sev)} ${severityLabel(sev)}`, f.message];
  });
  return table([{ header: "SEVERITY" }, { header: "FINDING" }], rows);
}
