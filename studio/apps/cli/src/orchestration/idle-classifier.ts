/**
 * orchestration/idle-classifier.ts — is an agent's tmux pane ready for a new input turn?
 *
 * There is no tmux primitive for "waiting for input", so we AND three signals (the relay
 * scheduler adds the 4th — hysteresis across ticks): the pane isn't in copy/scroll mode,
 * the right runtime owns the pane (a bare shell ⇒ the CLI EXITED ⇒ dead, not idle), and
 * the captured screen shows the vendor's prompt marker with no busy spinner. A message is
 * delivered ONLY when the pane is idle — never mid-generation (which would interleave a
 * peer message into a streaming answer). PURE: pane signals in, verdict out.
 */
import { stripAnsi } from "./spawn-capture.js";

export type PaneState = "idle" | "busy" | "dead";

/** The raw tmux signals for one pane (the scheduler gathers these). */
export interface PaneSignals {
  /** `#{pane_in_mode}` — "0" means NOT in copy/scroll mode (send-keys would be swallowed otherwise). */
  inMode: string;
  /** `capture-pane -p` text (colors omitted) — the last several lines. */
  capture: string;
  /** `#{pane_dead}` == "1" — the pane's process EXITED (the authoritative dead signal). */
  dead?: boolean;
  /** `#{pane_current_command}` — informational only (NOT used for dead: tmux wraps the agent
   *  in a shell, so a "sh"/"bash" foreground does NOT mean the CLI exited). */
  currentCommand?: string;
}

/** Per-vendor prompt/busy signatures. */
export interface VendorProfile {
  /** the LAST non-empty captured line at an input prompt. */
  ready: RegExp;
  /** any of these in the capture ⇒ mid-generation. */
  busy?: RegExp;
}

export const VENDOR_PROFILES: Readonly<Record<string, VendorProfile>> = Object.freeze({
  claude: { ready: /(?:^|\s)(?:❯|>)\s*$|Human:\s*$/, busy: /Thinking…|Esc to interrupt|✶|✻|↑↓/ },
  codex: { ready: /▌\s*$|>\s*$/, busy: /Working…|Generating|esc to interrupt/i },
  gemini: { ready: />\s*$/, busy: /Loading|⠋|⠙|⠹|⠸|⠼/ },
});

/** A generic fallback profile (a shell-ish prompt). */
const GENERIC: VendorProfile = { ready: /[%$#>❯]\s*$/ };

const lastNonEmptyLine = (text: string): string => {
  const lines = stripAnsi(text).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] ?? "").replace(/\s+$/, "");
    if (l.trim() !== "") return l;
  }
  return "";
};

/**
 * Single-tick verdict for a pane. The scheduler still requires `settleTicks` consecutive
 * idle verdicts (and a stable capture hash) before delivering — so a brief between-token
 * lull is never mistaken for a ready prompt.
 */
export function classifyPane(service: string, sig: PaneSignals): PaneState {
  // the pane's process exited (tmux #{pane_dead}) — the authoritative dead signal.
  if (sig.dead) return "dead";
  // copy/scroll mode → send-keys is swallowed → treat as busy (don't deliver).
  if (sig.inMode !== "0" && sig.inMode !== "") return "busy";

  const profile = VENDOR_PROFILES[service.toLowerCase()] ?? GENERIC;
  // Bound the regex input to a tail of the (agent-controlled) pane text: terminal state
  // lives in the latest output, and a fixed cap keeps any future non-linear profile
  // pattern from becoming a ReDoS on attacker-influenced model output.
  const text = stripAnsi(sig.capture).slice(-16384);
  if (profile.busy?.test(text)) return "busy";
  // ready ONLY when the prompt marker is the last non-empty line.
  return profile.ready.test(lastNonEmptyLine(text)) ? "idle" : "busy";
}

/** A stable digest of the last `lines` of a capture (for the scheduler's quiescence check). */
export function captureDigest(text: string, lines = 6): string {
  const tail = stripAnsi(text).split("\n").slice(-lines).join("\n").replace(/\s+$/g, "");
  // a tiny non-crypto rolling hash — we only need change-detection, not security.
  let h = 5381;
  for (let i = 0; i < tail.length; i++) h = ((h << 5) + h + tail.charCodeAt(i)) | 0;
  return `${tail.length}:${h}`;
}
