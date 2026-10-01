// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
    /**
     * The "or: brew upgrade ollama" that used to be here was wrong, and wrong in a way this
     * repo has already paid for.
     *
     * `ollama` (the brew FORMULA) and `ollama-app` (the brew CASK) are different installs. On a
     * machine running Ollama.app — which is what owns `:11434`, per CLAUDE.md §2.8 — that
     * command installs a SECOND ollama CLI beside it. The last time two ollamas contended for
     * that port the brew service crash-looped 36,135 times.
     *
     * `install.sh` is the one instruction that is right regardless of platform, and on macOS
     * the app updates itself anyway. `tool-registry.ts` carries the per-install-method commands
     * and is the place to look them up; `updates.test.ts` asserts these two rows agree.
     */
    selfUpdate: "curl -fsSL https://ollama.com/install.sh | sh",
    note: "On macOS, Ollama.app updates itself — see tool-registry.ts for the per-install-method command.",
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
  if (!p) return null;
  // Rebuilt from the parsed parts rather than returned verbatim, so a `--version` line with
  // surrounding text yields a bare version — but every component must survive the round trip.
  // Dropping `.build` here would re-introduce the bug where 1.2.3.4 and 1.2.3.5 are the same.
  const epoch = p.epoch ? `${p.epoch}:` : "";
  const build = p.build !== null ? `.${p.build}` : "";
  const pre = p.prerelease ? `-${p.prerelease}` : "";
  const rev = p.revision ? `_${p.revision}` : "";
  return `${epoch}${p.major}.${p.minor}.${p.patch}${build}${pre}${rev}`;
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
