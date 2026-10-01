// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/permission-modes.ts — Claude-Code-parity permission MODES on top of the
 * §3.4 permission-engine (file 14). A mode is a NAMED autonomy posture the user
 * cycles (Shift-Tab) or sets explicitly; it decides, per tool CLASS, whether a call
 * is auto-allowed, asks the human, or is denied — and supplies the status-bar
 * indicator the TUI paints.
 *
 *   default            ask before each mutating tool; reads run free      (the safe default)
 *   acceptEdits        auto-run local/config mutations; ask for remote     "⏵⏵ accept edits on"
 *   plan               read-only — propose, never mutate                   "⏸ plan mode on"
 *   bypassPermissions  auto-run EVERYTHING the engine allows               "⏵⏵ bypass permissions on"
 *   yolo               bypass + RUN TO DONE (auto-/continue, no pauses)    "☢ YOLO — no prompts, runs to done"
 *
 * LOAD-BEARING INVARIANT (C5): this is an AUTONOMY layer, NOT a safety verdict.
 * `bypassPermissions` (and `yolo`) only skip the HUMAN confirm — they NEVER pass --force, so
 * the nemesis gate still BLOCKs a dangerous fetch/exec (loop.ts gate-first). "Do anything
 * unless it's very dangerous" = bypass here + the engine BLOCK tier there. `yolo` == bypass
 * PLUS the run-to-done posture (auto-answers the per-turn `capped`/`/continue` so a long task
 * finishes uninterrupted) — see `isRunToDoneMode`. It is the most autonomous mode and is the
 * ONE that also auto-continues; the nemesis BLOCK still hard-stops it (autonomy ≠ safety).
 *
 * PURE: no IO. The TUI/host owns the `confirm` prompt + the indicator paint; this
 * module only classifies + decides + labels.
 */
import type { PermissionDecision, PermissionRule } from "./permission-engine.js";

/** The permission modes (the first four match Claude Code's `permissionMode`; `yolo` is ours). */
import { utf8Bytes, utf8Decode, utf8Length } from "./bytes.js";

export type PermissionModeId = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "yolo";

/** A tool's effect class, derived from its MCP annotations (the single source). */
export type ToolClass = "read" | "edit" | "exec";

/** The annotation slice we classify on (a subset of the MCP ToolAnnotations). */
export interface ToolEffect {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  /** touches the network / fetches or runs remote code (install, repo add, …). */
  openWorldHint?: boolean;
}

/** Static metadata for one mode (label + indicator + whether Shift-Tab reaches it). */
export interface PermissionModeMeta {
  id: PermissionModeId;
  /** the short status-bar label. */
  label: string;
  /** the indicator line under the composer ("" = nothing shown, e.g. default). */
  indicator: string;
  /** the role the TUI tints the indicator by (maps to a palette role). */
  tone: "muted" | "accent" | "warn" | "danger";
  /** one-line description for /permissions + help. */
  description: string;
  /** is this mode part of the Shift-Tab cycle? (bypass is entered explicitly only). */
  inCycle: boolean;
}

/** The mode registry (ordered: the Shift-Tab cycle is the `inCycle` subset, in order). */
export const PERMISSION_MODES: readonly PermissionModeMeta[] = Object.freeze([
  {
    id: "default",
    label: "default",
    indicator: "",
    tone: "muted",
    description: "Ask before each mutating action; reads run freely. The safe default.",
    inCycle: true,
  },
  {
    id: "acceptEdits",
    label: "accept edits",
    indicator: "⏵⏵ accept edits on",
    tone: "accent",
    description:
      "Auto-run local/config changes (enable/disable/edit); still ask for remote fetch/install.",
    inCycle: true,
  },
  {
    id: "plan",
    label: "plan mode",
    indicator: "⏸ plan mode on",
    tone: "accent",
    description: "Read-only — explore and propose a plan; never mutates or installs.",
    inCycle: true,
  },
  {
    id: "bypassPermissions",
    label: "bypass permissions",
    indicator: "⏵⏵ bypass permissions on",
    tone: "danger",
    description:
      "Auto-run everything the engine allows. The nemesis gate still BLOCKs dangerous actions.",
    inCycle: false,
  },
  {
    id: "yolo",
    label: "YOLO",
    indicator: "☢ YOLO — no prompts, runs to done",
    tone: "danger",
    description:
      "You Only Live Once: auto-run everything AND auto-continue to the end of the task — no prompts, no pauses. The nemesis gate still BLOCKs dangerous actions and hard-stops the run.",
    inCycle: false,
  },
]);

/**
 * Modes that AUTO-CONTINUE past the per-turn `capped`/`/continue` pause so a long task finishes
 * uninterrupted (the run-to-done posture). Only `yolo` today. This is ORTHOGONAL to the confirm
 * skip: it removes the per-TURN pause, not any safety gate — a nemesis BLOCK still hard-stops.
 */
export function isRunToDoneMode(id: PermissionModeId): boolean {
  return id === "yolo";
}

/** The Shift-Tab cycle order (the `inCycle` modes, in registry order). */
export const PERMISSION_MODE_CYCLE: readonly PermissionModeId[] = Object.freeze(
  PERMISSION_MODES.filter((m) => m.inCycle).map((m) => m.id),
);

export const DEFAULT_PERMISSION_MODE: PermissionModeId = "default";

/** Look up a mode's metadata (falls back to `default` for an unknown id). */
export function permissionModeMeta(id: PermissionModeId): PermissionModeMeta {
  return PERMISSION_MODES.find((m) => m.id === id) ?? (PERMISSION_MODES[0] as PermissionModeMeta);
}

/** The indicator line for a mode ("" when nothing should be shown). */
export function permissionModeIndicator(id: PermissionModeId): string {
  return permissionModeMeta(id).indicator;
}

/**
 * The next mode for a Shift-Tab cycle. By default cycles the three SAFE modes
 * (default → acceptEdits → plan → default). When `allowBypass` is true (not locked by
 * a declined-sudo gate) bypassPermissions THEN yolo are appended so the user can dial all
 * the way up to full autonomy — the red border + the "⏵⏵ bypass permissions on" / "☢ YOLO"
 * lines are the in-your-face warning, and the nemesis gate still BLOCKs dangerous actions.
 */
export function cyclePermissionMode(
  current: PermissionModeId,
  opts: { allowBypass?: boolean } = {},
): PermissionModeId {
  const cycle: PermissionModeId[] = opts.allowBypass
    ? [...PERMISSION_MODE_CYCLE, "bypassPermissions", "yolo"]
    : [...PERMISSION_MODE_CYCLE];
  const idx = cycle.indexOf(current);
  if (idx === -1) return cycle[0] as PermissionModeId; // from an out-of-cycle mode → default
  return cycle[(idx + 1) % cycle.length] as PermissionModeId;
}

/* ── tool classification + per-mode decision ──────────────────────────────── */

/**
 * Classify a tool by its annotations:
 *   - openWorldHint           → "exec"  (reaches the network / runs remote code)
 *   - readOnlyHint            → "read"  (lists/scans/info — never mutates, never leaves the box)
 *   - else                    → "edit"  (local/config mutation: enable/disable/uninstall)
 * A tool with no hints is treated as "edit" (a mutation we should confirm), never "read".
 *
 * openWorldHint is tested FIRST because the hints are orthogonal and a tool may carry both.
 * `web_search` does not mutate anything (readOnly is honest) yet still sends the query off the
 * machine (openWorld is honest too). Testing readOnly first classified it "read", which plan
 * mode ALLOWS — so a mode whose whole contract is "look, decide, change nothing" performed
 * network egress. Egress is exactly what plan mode denies via "exec"; local immutability does
 * not make it safe.
 */
export function classifyTool(ann: ToolEffect | undefined): ToolClass {
  if (ann?.openWorldHint) return "exec";
  if (ann?.readOnlyHint) return "read";
  return "edit";
}

/** The decision matrix: mode × tool-class → allow / ask / deny. */
const MATRIX: Record<PermissionModeId, Record<ToolClass, PermissionDecision>> = {
  default: { read: "allow", edit: "ask", exec: "ask" },
  acceptEdits: { read: "allow", edit: "allow", exec: "ask" },
  plan: { read: "allow", edit: "deny", exec: "deny" },
  bypassPermissions: { read: "allow", edit: "allow", exec: "allow" },
  // yolo shares bypass's decision matrix (auto-run all); it ADDS the run-to-done posture
  // (isRunToDoneMode) on top — the confirm skip is identical, the difference is auto-/continue.
  yolo: { read: "allow", edit: "allow", exec: "allow" },
};

/**
 * Decide one tool call under a mode: allow (run, no prompt), ask (prompt the human),
 * or deny (refuse — read-only mode hit a mutation). The TUI maps `ask` to a confirm
 * prompt and `allow`/`deny` to true/false WITHOUT prompting.
 */
export function decideToolForMode(
  mode: PermissionModeId,
  ann: ToolEffect | undefined,
): PermissionDecision {
  const cls = classifyTool(ann);
  return (MATRIX[mode] ?? MATRIX.default)[cls];
}

/* ── plan-mode structured refusal + bypass audit line (CLI-033) ────────────── */

/** The read-only refusal hint the model re-plans from (rides CLI-032's tool-message channel). */
export const PLAN_REFUSAL_HINT = "read-only mode — propose a plan instead";

/** The JSON-serializable plan-mode refusal object fed back to the model as a tool result. */
export interface PlanRefusal {
  denied: true;
  tool: string;
  mode: "plan";
  hint: string;
}

/** Build the structured plan-mode refusal for a denied mutation (CLI-033 deliverable 3). */
export function planModeRefusal(tool: string): PlanRefusal {
  return { denied: true, tool, mode: "plan", hint: PLAN_REFUSAL_HINT };
}

/** Max bytes of one audit line — kept under the POSIX PIPE_BUF floor (512) so appends never interleave. */
export const AUDIT_LINE_MAX_BYTES = 512;

/**
 * Format ONE bypass-mode audit line: `<iso> | <tool> | <argv-summary> | <outcome>` (CLI-033).
 * The argv-summary is TRUNCATED (never wrapped) so the whole line stays < 512 bytes and the
 * `fs.appendFileSync` O_APPEND write is atomic even across concurrent detached runs.
 */
export function formatAuditLine(
  iso: string,
  tool: string,
  argvSummary: string,
  outcome: string,
): string {
  // the empty-argv line == the whole line minus the argv bytes, so its length is the
  // fixed overhead; the argv field gets whatever budget remains.
  const fixed = `${iso} | ${tool} |  | ${outcome}\n`;
  const budget = AUDIT_LINE_MAX_BYTES - utf8Length(fixed);
  let argv = argvSummary.replace(/\s+/g, " ").trim();
  if (utf8Length(argv) > Math.max(0, budget)) {
    // byte-truncate (multibyte-safe) leaving room for the 3-byte "…" marker.
    const buf = utf8Bytes(argv).subarray(0, Math.max(0, budget - 3));
    argv = `${utf8Decode(buf)}…`;
  }
  return `${iso} | ${tool} | ${argv} | ${outcome}\n`;
}

/* ── bridge to the generic permission-engine (GUI/toolBroker reuse) ─────────── */

/**
 * Express a mode as a `{ baseDefault, rules }` policy for the §3.4 `evaluatePermission`
 * engine, so the SAME posture drives the ToolBroker pre-filter (GUI) and the TUI
 * confirm path with no drift. Read-class refs (`*:read`/`*:list`/`*:scan`) always
 * allow; the base default carries the mode's edit/exec posture (ask in default,
 * allow in accept/bypass, deny in plan). `allow` here never bypasses the gate (C5).
 */
export function permissionModePolicy(mode: PermissionModeId): {
  baseDefault: PermissionDecision;
  rules: PermissionRule[];
} {
  const m = MATRIX[mode] ?? MATRIX.default;
  const readRules: PermissionRule[] = [
    { match: "*:read", decision: m.read },
    { match: "*:list", decision: m.read },
    { match: "*:scan", decision: m.read },
    { match: "*:info", decision: m.read },
  ];
  // the base default carries the heavier (exec) posture; edits get an explicit rule.
  return {
    baseDefault: m.exec,
    rules: [
      ...readRules,
      { match: "*:edit", decision: m.edit },
      { match: "*:write", decision: m.edit },
    ],
  };
}
