/**
 * orchestration/vendor-policy.ts — per-vendor stance on THIRD-PARTY automated driving.
 *
 * The premise "only Anthropic forbids being scripted" is wrong: it is PER-VENDOR, and what
 * matters is the AUTH TYPE. Under a consumer SUBSCRIPTION / OAuth login:
 *   • Anthropic (Claude)  — FORBIDDEN. Consumer Terms §3(7): no automated access "through a
 *     bot, script, or otherwise" except via an Anthropic API key.
 *   • Google (Gemini)     — FORBIDDEN. gemini-cli docs/resources/tos-privacy.md names driving
 *     the Code-Assist path with third-party software a violation; Google suspends accounts.
 *   • OpenAI (Codex)      — DISCOURAGED, not banned. OpenAI ships a Codex SDK + recommends an
 *     API key for programmatic/CI use.
 *   • Cursor (cursor-agent)— ALLOWED. Docs bless "print mode" for scripts/CI/automation.
 *   • Ollama / local      — ALLOWED + FAVORED (local, no remote ToS).
 * With an API KEY, every cloud vendor permits automation (commercial terms). BYO-key CLIs
 * (aider/opencode/cline/kilocode/hermes) inherit the stance of whatever provider key drives
 * them. PURE: service + auth mode → stance. Verified 2026-06-25 (see _UPDATES_PROGRESS.md).
 */
import type { AuthMode } from "./auth-gate.js";

/** A vendor's stance on automated/scripted driving under a consumer subscription. */
export type AutomationStance = "allowed" | "discouraged" | "forbidden" | "byo-key";

export interface VendorPolicy {
  service: string;
  /** stance when driven under a consumer SUBSCRIPTION / OAuth login (no API key). */
  subscription: AutomationStance;
  /** the governing source. */
  cite: string;
  /** one-line human reason. */
  reason: string;
}

/** Per-vendor automation policy (subscription-auth path). API-key + local are always allowed. */
export const VENDOR_POLICY: Readonly<Record<string, VendorPolicy>> = Object.freeze({
  claude: {
    service: "claude",
    subscription: "forbidden",
    cite: "anthropic.com/legal/consumer-terms §3(7)",
    reason:
      "Anthropic Consumer Terms forbid automated/scripted access except via an Anthropic API key.",
  },
  gemini: {
    service: "gemini",
    subscription: "forbidden",
    cite: "github.com/google-gemini/gemini-cli docs/resources/tos-privacy.md",
    reason:
      "Google forbids third-party tools driving the Gemini Code-Assist/OAuth path and suspends accounts for it.",
  },
  codex: {
    service: "codex",
    subscription: "discouraged",
    cite: "developers.openai.com/codex/auth",
    reason:
      "OpenAI permits agentic use but recommends an API key for programmatic/CI Codex workflows.",
  },
  cursor: {
    service: "cursor",
    subscription: "allowed",
    cite: "cursor.com/docs/cli",
    reason: "Cursor blesses non-interactive print mode for scripts, CI, and automation.",
  },
  // BYO-key open CLIs: their stance follows the provider key you give them.
  aider: byoKey("aider"),
  opencode: byoKey("opencode"),
  cline: byoKey("cline"),
  kilocode: byoKey("kilocode"),
  hermes: byoKey("hermes"),
});

function byoKey(service: string): VendorPolicy {
  return {
    service,
    subscription: "byo-key",
    cite: "the underlying provider's terms (whatever API key drives this CLI)",
    reason:
      "This CLI is driven by a provider API key you supply — its automation terms are that provider's.",
  };
}

/** Look up a vendor policy (case-insensitive). */
export function vendorPolicyFor(service: string): VendorPolicy | undefined {
  return VENDOR_POLICY[service.toLowerCase()];
}

export interface StanceVerdict {
  stance: AutomationStance;
  severity: "ok" | "warn" | "block";
  /** is automated (script-driven) use clearly within terms? */
  automationOk: boolean;
  note: string;
}

const SEVERITY_OF: Record<AutomationStance, "ok" | "warn" | "block"> = {
  allowed: "ok",
  discouraged: "warn",
  "byo-key": "warn",
  forbidden: "block",
};

/**
 * The automation verdict for a service at a given auth mode. local/api-key are always OK;
 * subscription/unknown consult the per-vendor policy (default: discouraged/warn for an
 * unknown vendor — we never silently allow scripting an unrecognized consumer login).
 */
export function automationVerdict(service: string, mode: AuthMode): StanceVerdict {
  if (mode === "local") {
    return {
      stance: "allowed",
      severity: "ok",
      automationOk: true,
      note: `${service}: local model — no vendor ToS restriction; favored.`,
    };
  }
  if (mode === "api-key") {
    return {
      stance: "allowed",
      severity: "ok",
      automationOk: true,
      note: `${service}: API key present — commercial terms, automation allowed.`,
    };
  }
  const policy = vendorPolicyFor(service);
  // mode === "subscription" or "unknown"
  const stance: AutomationStance = policy
    ? policy.subscription
    : mode === "unknown"
      ? "discouraged"
      : "discouraged";
  const severity = SEVERITY_OF[stance];
  const automationOk = stance === "allowed";
  let note: string;
  if (stance === "allowed") {
    note = `${service}: ${policy?.reason ?? "vendor permits automated driving."} (${policy?.cite ?? ""})`;
  } else if (stance === "forbidden") {
    note = `${service}: FORBIDDEN on a subscription login — ${policy?.reason} Use an API key, a local model, or drive it by hand. (${policy?.cite})`;
  } else if (stance === "byo-key") {
    note = `${service}: ${policy?.reason} Set that provider's API key to make automation clearly OK.`;
  } else {
    note = `${service}: ${policy?.reason ?? "auth mode unknown — verify it permits automated use, or use an API key."}${policy ? ` (${policy.cite})` : ""}`;
  }
  return { stance, severity, automationOk, note };
}
