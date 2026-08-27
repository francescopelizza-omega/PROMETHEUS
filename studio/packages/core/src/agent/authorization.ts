/**
 * agent/authorization.ts — the `--authorisation(s)` autonomy SCALE (0–7).
 *
 * A single crescent knob: level 0 asks the human before EVERY action; each higher level
 * auto-approves one more CATEGORY of action, up to level 7 which runs everything with no
 * prompts. It refines the coarser permission-modes.ts posture (which the TUI Shift-Tab
 * cycle still shows) — the level is the fine-grained source of truth for "allow vs ask".
 *
 * Crescent categories (ascending risk): read < write < config < command < install < destructive.
 *   0 paranoid  — auto: (nothing)                          ask even reads
 *   1 readonly  — auto: read                               ask every change      ← default
 *   2 edits     — auto: read, write                        ask commands/installs
 *   3 config    — auto: read, write, config                ask commands/installs
 *   4 commands  — auto: read, write, config, command       ask installs
 *   5 installs  — auto: read, write, config, command, install
 *   6 trusted   — auto: EVERYTHING the engine allows       (nemesis gate still BLOCKs)
 *   7 runall    — trusted + run-to-done, zero prompts/pauses
 *
 * LOAD-BEARING INVARIANT (C5): this is AUTONOMY, never a safety verdict. Even level 7 only
 * skips the HUMAN confirm — it NEVER passes --force, so the nemesis gate still BLOCKs a
 * dangerous fetch/exec. "Run everything" = auto-approve here + the engine BLOCK tier there.
 *
 * PURE: no IO. The host owns the prompt + indicator paint; this module classifies + decides.
 */
import type { PermissionModeId } from "./permission-modes.js";

/** A tool's effect class for the authorization scale (finer than permission-modes' 3). */
export type AuthCategory = "read" | "write" | "config" | "command" | "install" | "destructive";

/** The annotation slice we classify on (subset of the MCP ToolAnnotations). */
export interface AuthToolEffect {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/** Static metadata for one authorization level. */
export interface AuthLevelMeta {
  level: number; // 0..7
  /** the canonical name accepted by `--authorisation <name>`. */
  name: string;
  /** short status label. */
  label: string;
  /**
   * The GUI wording (Prometheus Studio handoff §5). A parallel DISPLAY string — `name`
   * stays the CLI parse token (`--authorisation readonly`, `/auth runall`) and `label`
   * stays the TUI chip, so the GUI can speak plain English without breaking either.
   */
  uiLabel: string;
  description: string;
  /** categories auto-approved WITHOUT asking (everything else prompts the human). */
  auto: readonly AuthCategory[];
  /** run-to-done: auto-continue past the per-turn cap (no pauses). Level 7 only. */
  runToDone: boolean;
}

/** Ascending-risk category order; a level N auto-approves the first N of these (N = level, capped). */
const CATEGORY_ORDER: readonly AuthCategory[] = [
  "read",
  "write",
  "config",
  "command",
  "install",
  "destructive",
];

/** The first `n` categories (the cumulative auto-approve set for a level). */
function cumulative(n: number): AuthCategory[] {
  return CATEGORY_ORDER.slice(0, Math.max(0, Math.min(n, CATEGORY_ORDER.length)));
}

/** The 8 authorization levels (index === level). Crescent: each unlocks one more category. */
export const AUTH_LEVELS: readonly AuthLevelMeta[] = Object.freeze([
  {
    level: 0,
    name: "paranoid",
    label: "paranoid",
    uiLabel: "ask everything",
    description: "Ask before EVERY action — even reading a file. Maximum control.",
    auto: [],
    runToDone: false,
  },
  {
    level: 1,
    name: "readonly",
    label: "read-only",
    uiLabel: "read freely",
    description: "Auto-approve reads/scans; ask before every change. The safe default.",
    auto: cumulative(1),
    runToDone: false,
  },
  {
    level: 2,
    name: "edits",
    label: "edits",
    uiLabel: "accept edits",
    description: "Auto reads + file writes/edits; ask before commands and installs.",
    auto: cumulative(2),
    runToDone: false,
  },
  {
    level: 3,
    name: "config",
    label: "config",
    uiLabel: "edits + safe cmds",
    description: "Auto reads + edits + local config changes; ask before commands and installs.",
    auto: cumulative(3),
    runToDone: false,
  },
  {
    level: 4,
    name: "commands",
    label: "commands",
    uiLabel: "project-wide",
    description: "Auto reads + edits + config + shell commands; ask before installs/fetches.",
    auto: cumulative(4),
    runToDone: false,
  },
  {
    level: 5,
    name: "installs",
    label: "installs",
    uiLabel: "network allowed",
    description: "Auto reads + edits + config + commands + installs; ask only before destructive.",
    auto: cumulative(5),
    runToDone: false,
  },
  {
    level: 6,
    name: "trusted",
    label: "trusted",
    uiLabel: "system-wide",
    description: "Auto-run EVERYTHING the engine allows. The nemesis gate still BLOCKs danger.",
    auto: cumulative(6),
    runToDone: false,
  },
  {
    level: 7,
    name: "runall",
    label: "RUN ALL",
    uiLabel: "run all",
    description:
      "Run everything with NO prompts and no pauses (run-to-done). Nemesis still hard-stops danger.",
    auto: cumulative(6),
    runToDone: true,
  },
]);

/** The default level when no `--authorisation` flag is given (matches the classic ask-for-changes posture). */
export const DEFAULT_AUTH_LEVEL = 1;

/** Clamp any number to a valid level and return its metadata. */
export function authLevelMeta(level: number): AuthLevelMeta {
  const i = Math.max(0, Math.min(Math.trunc(level), AUTH_LEVELS.length - 1));
  return AUTH_LEVELS[i] as AuthLevelMeta;
}

/** The level's canonical name (e.g. 7 → "runall"). */
export function authLevelName(level: number): string {
  return authLevelMeta(level).name;
}

/**
 * Classify a tool into an authorization category from its ref + annotations.
 * Order matters: network reach wins first, then read-only, then the CLI-local file writers,
 * then network installs, then shell commands, then irreversible destructive, else a plain
 * local config mutation.
 *
 * `openWorldHint` is checked BEFORE `readOnlyHint` because the two annotations are orthogonal
 * and a tool can carry both: `web_search` modifies nothing locally (readOnly is honest) while
 * still sending the query off the machine (openWorld is also honest). Testing readOnly first
 * collapsed that to "read", so web_search auto-ran with no prompt at the default level —
 * directly contradicting the comment on its own annotations, which says it must always be
 * confirmed "exactly like web_fetch" because "the human should see what is about to be sent
 * off the machine". Reaching the network is the risk here; not mutating local state does not
 * cancel it.
 */
export function classifyAuth(ref: string, ann: AuthToolEffect | undefined): AuthCategory {
  if (ann?.openWorldHint) return "install"; // network / remote code — outranks readOnly
  if (ann?.readOnlyHint) return "read";
  const base = ref.includes(":") ? (ref.split(":").pop() ?? ref) : ref;
  if (ref === "write_file" || ref === "propose_edit" || base === "write" || base === "edit") {
    return "write";
  }
  if (ann?.openWorldHint) return "install"; // install / fetch / repo add (network or remote code)
  if (ref === "run_command" || base === "exec" || base === "run" || base === "command") {
    return "command";
  }
  if (ann?.destructiveHint) return "destructive"; // uninstall / delete / overwrite
  return "config"; // other local mutation (enable / disable / set)
}

/**
 * Decide ONE tool call under an authorization level: "allow" (run, no prompt) or "ask"
 * (prompt the human). There is no "deny" — the scale is purely about prompt frequency
 * (plan-mode's read-only DENY lives in permission-modes, orthogonal to this).
 */
/**
 * Tools that ALWAYS prompt — including at A7 ("run everything with NO prompts").
 *
 * A7 is a statement about the agent's own actions: run them unattended, nemesis still
 * hard-stops danger. `propose_elevated` is not one of the agent's actions. It renders an
 * authoritative "run this as root" block addressed to the human, and its entire safety
 * argument is that a person read it and chose to paste it. An agent that could emit those
 * silently — under prompt injection, at volume — would be manufacturing exactly the
 * mis-click §7 exists to prevent. So the one tool that cannot execute anything is also the
 * one tool no authorization level auto-approves.
 */
export const NEVER_AUTO_TOOLS: ReadonlySet<string> = new Set(["propose_elevated"]);

export function authDecision(
  level: number,
  ref: string,
  ann: AuthToolEffect | undefined,
): "allow" | "ask" {
  const base = ref.includes(":") ? (ref.split(":").pop() ?? ref) : ref;
  if (NEVER_AUTO_TOOLS.has(ref) || NEVER_AUTO_TOOLS.has(base)) return "ask";
  const meta = authLevelMeta(level);
  return meta.auto.includes(classifyAuth(ref, ann)) ? "allow" : "ask";
}

/** Whether the level runs to done (auto-continues past the per-turn cap). Level 7 only. */
export function authRunToDone(level: number): boolean {
  return authLevelMeta(level).runToDone;
}

/** The lowest level whose opt-in is global ("trusted" and up): auto-approve is no longer scoped
 *  to the working set, because the human asked for EVERYTHING to run unprompted. */
export const UNSCOPED_AUTO_LEVEL = 6;

/**
 * Decide ONE file-write call, SCOPED to the working set (cwd + every `/add-dir`).
 *
 * The plain `authDecision` scale says "level ≥ 2 auto-approves writes" — but "edits" means the
 * files the human is working on, not an arbitrary-write primitive over `~/.ssh/authorized_keys`
 * or `~/.zshrc`. So a write whose target lands OUTSIDE the working set falls back to "ask" even
 * at an auto level: the human sees the absolute path and answers. Levels 6–7 (trusted / runall)
 * are an explicit global opt-in, so they keep auto-approving everywhere.
 *
 * PURE: the caller resolves the path and computes `insideWorkingSet` (fail-closed — an
 * unresolvable target counts as OUTSIDE, so it prompts).
 */
export function scopedWriteDecision(
  level: number,
  ref: string,
  ann: AuthToolEffect | undefined,
  insideWorkingSet: boolean,
): "allow" | "ask" {
  const base = authDecision(level, ref, ann);
  if (base !== "allow" || insideWorkingSet) return base;
  // scope applies to the WRITE category only — a read auto-approved by the level stays auto
  // (reads are separately path-guarded by the runner's fail-closed working-set check).
  if (classifyAuth(ref, ann) !== "write") return base;
  return authLevelMeta(level).level < UNSCOPED_AUTO_LEVEL ? "ask" : "allow";
}

/**
 * Parse a `--authorisation(s)` value: a digit "0".."7" OR a level name (case-insensitive).
 * Returns the level 0–7, or null when unrecognized (the caller reports the valid set).
 */
export function parseAuthLevel(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (/^[0-7]$/.test(s)) return Number(s);
  const byName = AUTH_LEVELS.find((l) => l.name === s);
  return byName ? byName.level : null;
}

/** A one-line `0 paranoid · 1 readonly · … · 7 runall` legend for help / error text. */
export function authLevelLegend(): string {
  return AUTH_LEVELS.map((l) => `${l.level} ${l.name}`).join(" · ");
}

/* ── bridge to the coarse permission-modes (Shift-Tab cycle + indicator) ─────── */

/** Map a level onto the nearest permission MODE so the TUI indicator + Shift-Tab start sensibly. */
export function authLevelToMode(level: number): PermissionModeId {
  const l = authLevelMeta(level).level;
  if (l >= 7) return "yolo";
  if (l >= 6) return "bypassPermissions";
  if (l >= 2) return "acceptEdits"; // auto-approves at least file edits
  return "default"; // 0–1: ask for changes (0 also asks reads, handled by the fine decision)
}

/** Map a permission MODE back onto a level (keeps the two in sync when Shift-Tab changes the mode). */
export function modeToAuthLevel(mode: PermissionModeId): number {
  switch (mode) {
    case "yolo":
      return 7;
    case "bypassPermissions":
      return 6;
    case "acceptEdits":
      return 2;
    case "plan":
      return 0; // plan is read-only DENY; the fine scale can't express deny, so pin low
    default:
      return DEFAULT_AUTH_LEVEL;
  }
}
