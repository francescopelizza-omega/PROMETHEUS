/**
 * tui/sudo.ts — the elevated-privilege (sudo / root) startup gate.
 *
 * When `prometheus` is launched under sudo or as root, a mistaken auto-run can damage the
 * whole machine, not just the workspace. So before the session opens we surface a big
 * RED warning and require an explicit human acknowledgement. Per the product spec the
 * decline path is SAFE: answering no does not abort — it disables bypass and forces
 * the ask-before-everything posture. PURE: detection seams (`getuid`, `env`) are
 * injected; the app owns the actual prompt + the red paint.
 */
import type { agent } from "@prometheus/core";

type PermissionModeId = agent.PermissionModeId;

/** The detection inputs (injected so the gate is unit-testable without real root). */
export interface ElevationProbe {
  /** process.getuid (absent on Windows). */
  getuid?: () => number;
  /** process.env (read for SUDO_USER / SUDO_UID). */
  env?: NodeJS.ProcessEnv;
}

/** How the process is elevated (for the message), or null when it is not. */
export type Elevation = "root" | "sudo" | null;

/** Detect root (uid 0) or a sudo wrapper (SUDO_USER/SUDO_UID present). */
export function detectElevation(probe: ElevationProbe = {}): Elevation {
  const env = probe.env ?? process.env;
  const getuid = probe.getuid ?? (process.getuid?.bind(process) as (() => number) | undefined);
  // sudo sets SUDO_USER even though the effective uid is 0 — report it as `sudo`
  // (the more accurate cause) so the warning names the real launch path.
  if (env.SUDO_USER || env.SUDO_UID) return "sudo";
  if (typeof getuid === "function" && getuid() === 0) return "root";
  return null;
}

/** Is the process elevated at all? */
export function isElevated(probe: ElevationProbe = {}): boolean {
  return detectElevation(probe) !== null;
}

/** The EXACT acknowledgement prompt the human answers (CAPS, mandated verbatim). */
export const SUDO_ACK_PROMPT =
  "YOU ARE CONSIDERED AS A HUMAN BEING THAT CAN UNDERSTAND THE HARM AND CAN THEN " +
  "AUTHORISE PROMETHEUS TO START UP WITH SUCH PRIVILEDGES: [Y/n]";

/** The warning body lines (the app paints these on a red background). `how` names the cause. */
export function sudoWarningLines(how: Elevation): string[] {
  const cause = how === "root" ? "as ROOT (uid 0)" : "under sudo";
  return [
    "⚠  ELEVATED PRIVILEGES DETECTED  ⚠",
    "",
    `Prometheus is starting ${cause}. At this privilege level a single`,
    "auto-approved action can modify or destroy the ENTIRE system — not just",
    "this project. Installs, file edits, and shell commands run as the superuser.",
    "",
    SUDO_ACK_PROMPT,
  ];
}

/**
 * Interpret the human's answer. Per spec the [Y/n] default (empty) AUTHORISES; only
 * an explicit "n"/"N"/"No"/"NO" DECLINES. Anything else is treated as authorise.
 */
export function interpretSudoAnswer(answer: string): "authorize" | "decline" {
  const a = answer.trim().toLowerCase();
  return a === "n" || a === "no" ? "decline" : "authorize";
}

/** The outcome the app applies to the live session. */
export interface SudoDecision {
  /** the session always proceeds — decline is a SAFE downgrade, not an abort. */
  proceed: true;
  /** the permission mode to start in (forced to `default` on decline). */
  startMode: PermissionModeId;
  /** when true, the user may NOT switch into bypassPermissions this session. */
  bypassLocked: boolean;
  /** a one-line note to print after the decision. */
  note: string;
}

/**
 * Resolve the gate. When NOT elevated → a no-op pass-through (bypass stays available
 * via explicit opt-in). When elevated → the answer decides: authorize keeps bypass
 * reachable; decline forces `default` and LOCKS bypass for the session.
 */
export function resolveSudoDecision(elevation: Elevation, answer: string | null): SudoDecision {
  if (elevation === null) {
    return { proceed: true, startMode: "default", bypassLocked: false, note: "" };
  }
  const verdict = answer === null ? "decline" : interpretSudoAnswer(answer);
  if (verdict === "decline") {
    return {
      proceed: true,
      startMode: "default",
      bypassLocked: true,
      note: "Elevated autonomy declined — running in ask-before-everything mode; bypass is locked.",
    };
  }
  return {
    proceed: true,
    startMode: "default",
    bypassLocked: false,
    note: "Elevated privileges acknowledged — you may switch modes (incl. bypass) with Shift-Tab / /permissions.",
  };
}
