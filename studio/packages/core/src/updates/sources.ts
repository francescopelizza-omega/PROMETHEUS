/**
 * updates/sources.ts — where each vendor CLI's latest version lives, + the pure parsers.
 *
 * The TABLE is data (npm package / GitHub repo / a self-check-only tool), the version
 * `--version` argv, and the exact self-update command a user runs. The PARSERS turn a
 * `--version` stdout line, an npm-registry `/latest` JSON, or a GitHub releases JSON into a
 * version string. No IO here — the CLI layer fetches/spawns and feeds the raw text in, so
 * this stays unit-testable on stdlib. Channels verified live 2026-06-25 (see _UPDATES_PROGRESS.md).
 */
import { parseVersion } from "./semver.js";

/** How a tool's "latest available version" is discovered. */
export type UpdateChannel = "npm" | "github" | "selfcheck";

export interface UpdateSource {
  /** the agent-CLI service id (matches recipes/auth-gate keys). */
  service: string;
  channel: UpdateChannel;
  /** npm package name (channel "npm") or "owner/repo" (channel "github"). */
  id?: string;
  /** argv passed to the bin to print its version (default ["--version"]). */
  versionArgs: readonly string[];
  /** the bin to probe (default = service). */
  bin?: string;
  /** the EXACT command the user runs to update (copyable). */
  selfUpdate: string;
  /** a short note (e.g. why selfcheck-only). */
  note?: string;
}

/** Per-vendor update channels. */
export const CLI_UPDATE_SOURCES: Readonly<Record<string, UpdateSource>> = Object.freeze({
  claude: {
    service: "claude",
    channel: "npm",
    id: "@anthropic-ai/claude-code",
    versionArgs: ["--version"],
    selfUpdate: "claude update",
  },
  codex: {
    service: "codex",
    channel: "npm",
    id: "@openai/codex",
    versionArgs: ["--version"],
    selfUpdate: "codex update",
  },
  gemini: {
    service: "gemini",
    channel: "npm",
    id: "@google/gemini-cli",
    versionArgs: ["--version"],
    selfUpdate: "npm install -g @google/gemini-cli@latest",
  },
  cursor: {
    service: "cursor",
    channel: "selfcheck",
    bin: "cursor-agent",
    versionArgs: ["--version"],
    selfUpdate: "cursor-agent update",
    note: "no public version JSON — cursor-agent self-checks on `update`.",
  },
  ollama: {
    service: "ollama",
    channel: "github",
    id: "ollama/ollama",
    versionArgs: ["--version"],
    selfUpdate: "curl -fsSL https://ollama.com/install.sh | sh   # or: brew upgrade ollama",
  },
});

/** The services we know how to version-check. */
export const UPDATE_SERVICES: readonly string[] = Object.freeze(Object.keys(CLI_UPDATE_SOURCES));

/** Look up a service's update source (case-insensitive). */
export function updateSourceFor(service: string): UpdateSource | undefined {
  return CLI_UPDATE_SOURCES[service.toLowerCase()];
}

/* ------------------------------- pure parsers ------------------------------ */

/** Extract the installed version from a CLI `--version` stdout blob (fail-soft → null). */
export function parseCliVersion(raw: unknown): string | null {
  const p = parseVersion(raw);
  return p ? `${p.major}.${p.minor}.${p.patch}${p.prerelease ? `-${p.prerelease}` : ""}` : null;
}

/** Pull `.version` from an npm registry `/<pkg>/latest` document (fail-soft → null). */
export function latestFromNpm(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const v = (json as { version?: unknown }).version;
  return typeof v === "string" && parseVersion(v) ? v : null;
}

/** Pull `.tag_name` from a GitHub `releases/latest` document (fail-soft → null). */
export function latestFromGithub(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const t = (json as { tag_name?: unknown }).tag_name;
  return typeof t === "string" && parseVersion(t) ? t : null;
}
