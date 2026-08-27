/**
 * cli-profiles/seeds.ts — the four shipped profiles (file 11 §6).
 *
 *   default    — cloud enabled (claude-opus), gate=warn.
 *   local-safe — local ollama, gate=enforce, dry-run, NEVER installs (deny install).
 *   ci         — non-interactive, gate=enforce, no --force ever (enforced at the CLI).
 *   airgapped  — local-only (no cloud), gate=enforce.
 * These are data; users copy + customize under ~/.config/prometheus-studio/profiles/.
 */
import type { CliProfile } from "./profile.js";

export const DEFAULT_PROFILE_NAME = "default";

export const BUILTIN_CLI_PROFILES: Readonly<Record<string, CliProfile>> = Object.freeze({
  default: {
    name: "default",
    agent: { model: "claude-opus", tools: { enabled: true } },
    engine: { gateMode: "warn", dryRun: false, yes: false },
  },
  "local-safe": {
    name: "local-safe",
    agent: {
      model: "ollama:qwen3:8b",
      systemPrompt: "You are Prometheus. Always scan before installing. Prefer free/local.",
      tools: { enabled: true, deny: ["prometheus_install"] },
    },
    engine: { gateMode: "enforce", dryRun: true, yes: false },
  },
  ci: {
    name: "ci",
    agent: { model: "claude-opus", tools: { enabled: true } },
    engine: { gateMode: "enforce", dryRun: false, yes: false },
  },
  airgapped: {
    name: "airgapped",
    agent: {
      model: "ollama:qwen3:8b",
      systemPrompt: "Local-only. No cloud. Scan everything; install nothing without confirmation.",
      tools: { enabled: true },
    },
    engine: { gateMode: "enforce", dryRun: false, yes: false },
  },
});

/** A built-in profile by name (undefined for unknown). */
export function getCliProfile(name: string): CliProfile | undefined {
  return BUILTIN_CLI_PROFILES[name];
}

/** `ci` forbids --force entirely (§6 / Open Q6 — require PROM_ALLOW_FORCE otherwise). */
export function profileForbidsForce(name: string | undefined): boolean {
  return name === "ci";
}

/**
 * Is the `--force` escape hatch OPEN for this run?
 *
 * The override value must be EXACTLY "1" — the only value every message documents ("Set
 * PROM_ALLOW_FORCE=1 to override"). A bare presence check (`!process.env.PROM_ALLOW_FORCE`)
 * fails OPEN on `0`, `false`, `no` and `off`: a CI job that sets `PROM_ALLOW_FORCE=0` believing
 * it is DISABLING the escape hatch actually enables it, and a forced install then runs
 * unattended straight over a nemesis BLOCK.
 *
 * One predicate, three call sites. `sidecar-cmd.ts` had already been hardened with a comment
 * naming this exact failure, while `generic.ts` (the whole §2 verb tree — plugin/skill/app/
 * worldsim/localai/pentest install|uninstall|enable|disable|sync, `secure purge`, `pentest
 * destroy|build|run|shell`) and `command-exec.ts` (the REPL/session gate) both still used the
 * bare check. A guard copied per call site is a guard that will drift again.
 */
export function forceOverrideAllowed(env: { PROM_ALLOW_FORCE?: string } = process.env): boolean {
  return env.PROM_ALLOW_FORCE === "1";
}

/** The S005 config key under which the active profile name persists (CLI-044). */
export const PROFILE_ACTIVE_KEY = "profile.active";

export interface ProfileEntry {
  name: string;
  source: "builtin" | "user";
}

/**
 * Merge the builtin profiles with the caller-scanned user-profile file names into one sorted
 * listing (CLI-044). A user file whose name matches a builtin SHADOWS it (source flips to "user").
 * PURE — the CLI performs the `profilesDir()` scan and passes the names in (core does no fs).
 */
export function listProfiles(userProfileNames: readonly string[] = []): ProfileEntry[] {
  const seen = new Map<string, ProfileEntry>();
  for (const name of Object.keys(BUILTIN_CLI_PROFILES)) seen.set(name, { name, source: "builtin" });
  for (const name of userProfileNames) {
    if (name) seen.set(name, { name, source: "user" }); // user file shadows a same-named builtin
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
