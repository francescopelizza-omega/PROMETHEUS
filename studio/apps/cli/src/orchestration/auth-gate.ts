/**
 * orchestration/auth-gate.ts — the ToS-compliance gate for automated /demos.
 *
 * What matters is the AUTH TYPE of each agent's CLI, not the comms mechanism (headless OR
 * tmux-relay). This module classifies every CLI agent as api-key (commercial terms →
 * automation OK), local/free (no vendor ToS issue), or subscription/OAuth login — and for
 * the subscription case defers to the PER-VENDOR policy (vendor-policy.ts), because the
 * stance differs by vendor: Anthropic + Google FORBID subscription automation (block),
 * OpenAI DISCOURAGES it (warn), Cursor ALLOWS it (ok). It produces the warning the /demos
 * launch surfaces so the user gives informed consent. PURE: env in, classification out.
 */
import { orchestration } from "@prometheus/core";

import { automationVerdict } from "./vendor-policy.js";

const { apiProviderFor } = orchestration;

type BackendRef = orchestration.BackendRef;
type OrchestrationTopology = orchestration.OrchestrationTopology;

export type AuthMode = "api-key" | "subscription" | "local" | "unknown";

/** The API-key env var(s) that, when present, mean a service is in commercial (automation-OK) mode. */
const API_KEY_ENV: Record<string, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  aider: [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
  ],
  opencode: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
  cline: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"],
  kilocode: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"],
  hermes: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
};

/** Services that have a subscription/OAuth login path (so "no key env" ⇒ login, not unconfigured). */
const HAS_LOGIN = new Set([
  "claude",
  "codex",
  "gemini",
  "cursor",
  "opencode",
  "kilocode",
  "hermes",
]);

/** Detect a CLI service's auth mode from the environment. */
export function detectAuthMode(service: string, env: NodeJS.ProcessEnv = process.env): AuthMode {
  const svc = service.toLowerCase();
  const keys = API_KEY_ENV[svc];
  if (keys?.some((k) => (env[k] ?? "") !== "")) return "api-key";
  return HAS_LOGIN.has(svc) ? "subscription" : "unknown";
}

export interface AgentAuth {
  agent: string;
  service?: string;
  mode: AuthMode;
  /** is automated (script-driven) use clearly within terms? */
  automationOk: boolean;
  severity: "ok" | "warn" | "block";
  note: string;
}

/** Classify one agent's backend for the ToS gate. */
export function assessAgentAuth(
  agentName: string,
  backend: BackendRef,
  env: NodeJS.ProcessEnv = process.env,
): AgentAuth {
  // kind:"api" = a paid OpenAI-compatible provider driven by the USER'S OWN key. Own-key
  // commercial-API automation is the clean lane (no CLI/subscription driving), so it's ok —
  // but a "verify-at-setup" provider warns, and a missing key warns (it just won't run).
  if (backend.kind === "api") {
    const provider = backend.service ? apiProviderFor(backend.service) : undefined;
    const keyName = backend.apiKeyEnv ?? provider?.apiKeyEnv[0];
    const hasKey = (() => {
      if (backend.env && keyName && (backend.env[keyName] ?? "") !== "") return true;
      for (const n of provider?.apiKeyEnv ?? (keyName ? [keyName] : [])) {
        if ((env[n] ?? "") !== "") return true;
      }
      return false;
    })();
    const svc = backend.service ?? "api";
    if (!hasKey) {
      return {
        agent: agentName,
        service: svc,
        mode: "api-key",
        automationOk: false,
        severity: "warn",
        note: `${svc}: API provider, but no key set (${keyName ?? "API_KEY"}) — it won't run until you provide your own key.`,
      };
    }
    const verify = !provider || provider.automation === "verify-at-setup";
    return {
      agent: agentName,
      service: svc,
      mode: "api-key",
      automationOk: !verify,
      severity: verify ? "warn" : "ok",
      note: verify
        ? `${svc}: own-key API — confirm its terms permit programmatic use at setup (${provider?.tosUrl ?? "vendor ToS"}).`
        : `${svc}: own-key OpenAI-compatible API — commercial terms, automation allowed (don't share/resell the key).`,
    };
  }
  if (backend.kind !== "cli") {
    return {
      agent: agentName,
      mode: "local",
      automationOk: true,
      severity: "ok",
      note:
        backend.kind === "fake"
          ? "dry-run backend"
          : "local / engine model — no vendor ToS restriction",
    };
  }
  const service = backend.service ?? "cli";
  const mode = detectAuthMode(service, env);
  // The per-vendor policy decides whether subscription/unknown automation is ok/warn/block.
  const v = automationVerdict(service, mode);
  return {
    agent: agentName,
    service,
    mode,
    automationOk: v.automationOk,
    severity: v.severity,
    note: v.note,
  };
}

/** Assess every agent in a topology. */
export function assessTopologyAuth(
  topology: OrchestrationTopology,
  env: NodeJS.ProcessEnv = process.env,
): AgentAuth[] {
  return topology.agents.map((a) => assessAgentAuth(a.name, a.backend, env));
}

export interface AuthGateVerdict {
  /** the highest severity across agents. */
  severity: "ok" | "warn" | "block";
  /** agents that aren't clearly automation-OK. */
  flagged: AgentAuth[];
  /** the user-facing warning to print (empty when all clear). */
  message: string;
  /** whether the launch needs an explicit typed confirmation. */
  needsConfirm: boolean;
}

/**
 * The gate verdict for a whole topology: ok (all api-key/local), or warn/block with a
 * message + a confirm requirement. Never a hard refusal — informed consent (the account +
 * risk are the user's) — but a `block`-severity (Anthropic subscription) gets the
 * strongest wording and still requires the typed confirmation to proceed.
 */
export function authGateVerdict(
  topology: OrchestrationTopology,
  env: NodeJS.ProcessEnv = process.env,
): AuthGateVerdict {
  const all = assessTopologyAuth(topology, env);
  const flagged = all.filter((a) => a.severity !== "ok");
  if (flagged.length === 0) {
    return { severity: "ok", flagged: [], message: "", needsConfirm: false };
  }
  const severity = flagged.some((a) => a.severity === "block") ? "block" : "warn";
  const lines = [
    severity === "block"
      ? "⚠ ToS WARNING — an agent whose vendor FORBIDS subscription automation would be scripted."
      : "⚠ ToS notice — some agents use a login whose automated use is restricted or discouraged.",
    "",
    "Automation policy is PER-VENDOR. Under a consumer subscription: Anthropic (Claude) and",
    "Google (Gemini) FORBID third-party/scripted driving (block); OpenAI (Codex) discourages",
    "it (use an API key); Cursor allows it. With an API KEY every cloud vendor permits it, and",
    "local models are always fine. Running a swarm IS automated access — headless or tmux alike.",
    "",
    ...flagged.map((a) => `  • ${a.agent} — ${a.note}`),
    "",
    "To run clearly within terms: give the flagged agents an API key, swap them to a local",
    "model, OR keep them human-driven. Proceeding uses your own account at your own risk.",
  ];
  return { severity, flagged, message: lines.join("\n"), needsConfirm: true };
}
