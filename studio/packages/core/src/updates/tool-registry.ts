// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/tool-registry.ts — what PROMETHEUS depends on, how to read its version, how to update it.
 *
 * `sources.ts` already does this for five agent CLIs. This is the wider table, and it exists
 * because the five-row version encodes an assumption that does not survive contact with a real
 * machine: that a tool has ONE version and ONE place to read it from.
 *
 * ── WHAT THE MEASUREMENTS CHANGED ───────────────────────────────────────────────────────────
 *
 * **1. A tool can be installed twice, at different versions, and only one of them matters.**
 * On this machine, right now:
 *
 *     /Applications/Ollama.app          CFBundleShortVersionString  0.34.1   ← serves :11434
 *     /opt/homebrew/bin/ollama -> Cellar/ollama/0.34.4            INSTALLED  ← first on PATH
 *     /usr/local/bin/ollama    -> Ollama.app/Contents/Resources   INSTALLED  ← shadowed
 *     brew cask "ollama-app"                                      0.34.4     ← NOT installed
 *
 * Re-measured 2026-09-29, and the first version of this header had it backwards: the FORMULA is
 * installed and wins PATH, the cask is not installed at all. So the live state is already the bad
 * one — a 0.34.4 client driving the app's 0.34.1 server — and `brew upgrade --cask ollama-app`,
 * the command this table used to offer, would have tried to install a cask over a pre-existing
 * /Applications bundle.
 *
 * The formula and the cask are different artifacts, and CLAUDE.md §2.8 records what happened the
 * last time two ollamas fought over `:11434`: the brew service crash-looped 36,135 times. So a
 * row carries the channels in PREFERENCE order, the update command is tied to how the thing was
 * actually installed, and `install-owner.ts` decides which of those rows a given machine is
 * allowed to be shown.
 *
 * **2. Several vendors answer the question better than GitHub does.** Ollama runs
 * `GET https://ollama.com/api/update?os=&arch=&version=` — the endpoint its own app uses —
 * which answers `200` with a download URL when something newer exists and `204` when it does
 * not. That is authoritative, needs no version parsing, and is not rate-limited.
 *
 * **3. GitHub's unauthenticated API is 60 requests/hour.** Measured: exhausted inside one
 * working session. A sweep of a dozen tools against `api.github.com` will spend the budget and
 * then fail soft to "unknown" — silently, which is the worst outcome, because "no update found"
 * and "could not look" are indistinguishable to the user. GitHub is therefore a LAST-choice
 * channel, after the vendor endpoint and after Homebrew (which is unauthenticated, uncapped,
 * and reports the version `brew upgrade` would actually install).
 *
 * PURE: a table plus the URL builders and parsers. Every fetch and every spawn is the caller's.
 */

import type { InstallOwner } from "./install-owner.js";
import { parseVersion } from "./semver.js";

/** Why PROMETHEUS cares about a tool — drives ordering and whether a gap is worth reporting. */
export type ToolRole =
  /** without it, no model runs at all. */
  | "engine"
  /** a coding agent PROMETHEUS can drive or interoperate with. */
  | "agent"
  /** PROMETHEUS itself needs it to function. */
  | "toolchain"
  /** unlocks a specific feature; absence is fine. */
  | "optional";

/**
 * Where a tool's newest version is published.
 *
 * Ordered preference lives on the row, not here — see `ToolCheck.latest`.
 */
type LatestChannelKind =
  /** npm registry `/<pkg>/latest` → `.version`. */
  | { kind: "npm"; pkg: string }
  /** `formulae.brew.sh/api/formula/<name>.json` → `.versions.stable`. */
  | { kind: "brew-formula"; name: string }
  /** `formulae.brew.sh/api/cask/<token>.json` → `.version`. */
  | { kind: "brew-cask"; token: string }
  /** PyPI `/pypi/<pkg>/json` → `.info.version`. */
  | { kind: "pypi"; pkg: string }
  /** GitHub `releases/latest` → `.tag_name`. Excludes prereleases; LAST resort (60/h). */
  | { kind: "github"; repo: string }
  /**
   * A vendor endpoint that answers "is there something newer" directly, given the installed
   * version. Returns a DOWNLOAD URL rather than a version string.
   */
  | { kind: "vendor-delta"; url: string; note: string }
  /** No machine-readable source exists. `why` is shown to the user instead of a version. */
  | { kind: "none"; why: string };

/**
 * A channel, plus the installs it is actually a valid comparison FOR.
 *
 * `onlyOwners` mirrors `UpdateCommand.onlyOwners` and exists for the same reason: a source can be
 * authoritative for one install of a tool and meaningless for another. `askLatest` only ever
 * REORDERED channels by owner, never excluded one, so a feed that tracks a different artifact
 * still answered and was still compared.
 *
 * Measured on LM Studio: the app installed here is `/Applications/Bionic.app` at 1.0.3+3, while
 * the Homebrew cask `lm-studio` publishes 0.4.25 — two different numbering schemes for two
 * different artifacts. Comparing them does not yield a wrong update, it yields a meaningless
 * one: 1.0.3 "beats" 0.4.25, so an app install would be reported as ahead of the latest release.
 * Omitted means "valid for any install", which is right for npm and PyPI feeds.
 */
export type LatestChannel = LatestChannelKind & {
  onlyOwners?: readonly InstallOwner[];
};

/**
 * One way to update, tied to how the tool was installed.
 *
 * `brew-formula` and `brew-cask` are separate because a single `brew` value was measured to be
 * exactly as wrong as no detection at all: on the machine this was written for, `ollama` is
 * installed as a FORMULA, and a `via: "brew"` row carrying `brew upgrade --cask ollama-app`
 * matched it — offering to install a cask the user does not have, to fix a formula it would not
 * touch. Homebrew's two package kinds have different upgrade flags, different prefixes and
 * different listing semantics; nothing is gained by pretending they are one channel.
 */
export interface UpdateCommand {
  /** the install method this command is correct for. */
  via:
    | "brew-formula"
    | "brew-cask"
    | "npm"
    | "pipx"
    | "venv"
    | "script"
    | "self"
    | "git"
    | "app"
    | "manual";
  /** restrict to a platform when the command differs; omitted means all. */
  platform?: NodeJS.Platform;
  /**
   * Restrict a `self` / `script` command to the installs it is actually correct for.
   *
   * `via` alone cannot express this. `codex update` and `claude update` are `via: "self"`, which
   * matches whatever is running by definition — but on this machine `codex` came from a Homebrew
   * cask, and `codex update` does not update the cask: it runs the vendor's installer, which
   * writes `~/.local/bin/codex` and permanently shadows the cask at PATH position 2. Offering it
   * MANUFACTURES the double-install this whole feature exists to detect.
   *
   * Omitted means "correct for any install", which is right for `pnpm self-update` and wrong for
   * every vendor installer that has a package-manager alternative.
   */
  onlyOwners?: readonly InstallOwner[];
  /** the EXACT command, copyable. Empty when the tool updates itself. */
  command: string;
  note?: string;
}

export interface ToolCheck {
  id: string;
  label: string;
  role: ToolRole;
  /** argv that prints the installed version. Omitted when it cannot be read from a binary. */
  probe?: { bin: string; args: readonly string[] };
  /**
   * A macOS app bundle whose `Info.plist` carries the authoritative installed version.
   * Checked BEFORE `probe` on darwin, because the app and the CLI can differ.
   */
  /**
   * Where a macOS `.app` for this tool lives, in preference order.
   *
   * A LIST because the single hardcoded path was measured to be wrong, and wrong silently. The
   * lmstudio row said `/Applications/LM Studio.app`; on this machine LM Studio ships as
   * `/Applications/Bionic.app` (CFBundleIdentifier `ai.elementlabs.bionic`), so `exists()` failed,
   * no version was read, and the report said "installed version unreadable" about an app whose
   * version sits in its Info.plist exactly where it always has.
   *
   * One string is still accepted — the common case has one answer.
   */
  appBundle?: string | readonly string[];
  /** channels in preference order — the first that answers wins. */
  latest: readonly LatestChannel[];
  update: readonly UpdateCommand[];
  /** shown alongside the row; the place to record a trap rather than bury it in code. */
  note?: string;
}

/**
 * The table. Every URL and command here was fetched or run on 2026-09-28; the ones that are
 * traps carry a note saying so rather than being silently omitted.
 */
export const TOOL_CHECKS: readonly ToolCheck[] = Object.freeze([
  {
    id: "ollama",
    label: "Ollama",
    role: "engine",
    probe: { bin: "ollama", args: ["--version"] },
    appBundle: "/Applications/Ollama.app",
    latest: [
      {
        kind: "vendor-delta",
        url: "https://ollama.com/api/update",
        note: "200 + a download URL when newer, 204 when current. darwin and windows only; linux always 204 and ships via install.sh.",
      },
      { kind: "brew-cask", token: "ollama-app" },
      { kind: "brew-formula", name: "ollama" },
      { kind: "github", repo: "ollama/ollama" },
    ],
    update: [
      {
        via: "app",
        platform: "darwin",
        command: "",
        note: "Ollama.app updates itself (the cask is auto_updates: true). Quit and reopen it, or use its own prompt.",
      },
      { via: "brew-cask", platform: "darwin", command: "brew upgrade --cask ollama-app" },
      {
        /**
         * The formula, for the machine that actually has it — which is this one.
         *
         * It is NOT interchangeable with the rows above. `brew upgrade ollama` moves the
         * command-line client and cannot move the server inside Ollama.app, and on a machine
         * where the app owns `:11434` that produces the split this repo has already measured: a
         * 0.34.4 client driving a 0.34.1 server. The command is still correct for the artifact it
         * names, so it is offered — with the consequence attached rather than omitted.
         */
        via: "brew-formula",
        command: "brew upgrade ollama",
        note: "Updates the CLI only. If Ollama.app is running it still owns :11434 and its own version is unchanged — check both.",
      },
      {
        via: "script",
        platform: "linux",
        command: "curl -fsSL https://ollama.com/install.sh | sh",
      },
    ],
    note: "The app and the brew FORMULA are different installs. Never offer a cask command to someone whose ollama came from the formula, or the reverse — two ollamas fighting for :11434 crash-looped 36,135 times (CLAUDE.md §2.8).",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    role: "engine",
    /**
     * `lms --version` is NOT a version source, measured: it prints `CLI commit: 71bd99c`, a git
     * commit of the CLI. `lms version` is worse — there is no such subcommand, so it prints the
     * ASCII banner and exits 0, which looks like success. The probe stays for PATH attribution;
     * the version comes from the bundle.
     */
    probe: { bin: "lms", args: ["--version"] },
    appBundle: [
      "/Applications/LM Studio.app",
      /**
       * Measured 2026-09-30: LM Studio ships on this machine as `/Applications/Bionic.app`
       * (CFBundleIdentifier `ai.elementlabs.bionic`, "Element Labs Inc."). Nothing named
       * "LM Studio.app" exists here, and `~/.lmstudio/.internal/app-install-location.json`
       * points at the Bionic bundle. A single hardcoded path made the version unreadable.
       */
      "/Applications/Bionic.app",
    ],
    latest: [
      {
        kind: "brew-cask",
        token: "lm-studio",
        /**
         * Only meaningful for a copy Homebrew actually installed. The cask publishes 0.4.25
         * while the app bundle here is 1.0.3+3 — different artifacts, different numbering. Left
         * ungated, `askLatest` answered with the cask version for an app install and the
         * comparison said the app was ahead of the latest release.
         */
        onlyOwners: ["brew-cask"],
      },
      /**
       * The fallback for the app install, and it is deliberately a refusal to compare.
       *
       * With the cask feed gated to cask installs, an app install has NO channel left — and an
       * empty channel list renders as the meaningless "could not check — no channel", which
       * reads like a failure. It is not one: there is genuinely no feed publishing this app's
       * version scheme, and saying so is the honest answer. LM Studio updates itself from
       * inside the app, so nothing is lost by not comparing.
       */
      {
        kind: "none",
        why: "LM Studio updates itself; no feed publishes the app's own version scheme (the Homebrew cask tracks a different one)",
      },
    ],
    update: [
      { via: "app", command: "", note: "LM Studio updates itself from inside the app." },
      { via: "brew-cask", platform: "darwin", command: "brew upgrade --cask lm-studio" },
    ],
    note: "Installed as /Applications/Bionic.app here (Element Labs), not 'LM Studio.app'. The app and the Homebrew cask use different version schemes (1.0.3+3 vs 0.4.25), so the cask feed is only compared against a cask install; `lms --version` prints a CLI commit, never the app version.",
  },
  {
    id: "llama.cpp",
    label: "llama.cpp",
    role: "optional",
    probe: { bin: "llama-cli", args: ["--version"] },
    latest: [{ kind: "brew-formula", name: "llama.cpp" }],
    update: [{ via: "brew-formula", command: "brew upgrade llama.cpp" }],
    note: "Supplies llama-quantize and the GGUF conversion toolchain — the only route for a model nobody has published a GGUF of.",
  },
  {
    id: "claude",
    label: "Claude Code",
    role: "agent",
    probe: { bin: "claude", args: ["--version"] },
    latest: [{ kind: "npm", pkg: "@anthropic-ai/claude-code" }],
    update: [
      {
        via: "self",
        onlyOwners: ["native-installer", "npm-global", "pnpm-global"],
        command: "claude update",
        note: "Correct for the native (curl | bash) and npm installs, which is what `claude` resolves to here. It does NOT move a Homebrew cask.",
      },
      {
        /**
         * Present because the cask IS installed on this machine — at 2.1.274, behind the 2.1.284
         * the user actually runs from ~/.local/bin. Without this row the cask copy is invisible;
         * with it, `install-owner.ts` can WITHHOLD it by name and explain that upgrading it moves
         * a copy PATH never reaches.
         */
        via: "brew-cask",
        platform: "darwin",
        command: "brew upgrade --cask claude-code",
        note: "Only if `claude` resolves into Caskroom/. The cask trails the native channel by several patch releases.",
      },
    ],
    note: "Two installers own the name `claude`. `brew uninstall --zap --cask claude-code` is NOT the cleanup command — its zap stanza deletes ~/.local/share/claude and ~/.claude.json, i.e. the OTHER install and the user's config.",
  },
  {
    id: "codex",
    label: "Codex CLI",
    role: "agent",
    probe: { bin: "codex", args: ["--version"] },
    latest: [{ kind: "npm", pkg: "@openai/codex" }],
    update: [
      { via: "brew-cask", platform: "darwin", command: "brew upgrade --cask codex" },
      {
        via: "self",
        onlyOwners: ["native-installer", "npm-global", "pnpm-global"],
        command: "codex update",
        note: "Measured: this rewrites ~/.npmrc to a new global prefix. If that prefix's bin is not on PATH, every later `npm install -g` installs something you cannot run.",
      },
      { via: "npm", command: "npm install -g @openai/codex@latest" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    role: "agent",
    probe: { bin: "gemini", args: ["--version"] },
    /**
     * Both channels, in this order, and the order is the point.
     *
     * Homebrew packages gemini-cli as a FORMULA and its version trails npm badly — 0.46.0 here
     * against 0.61.0 on npm. Comparing a brew install against the npm number produces a real but
     * unactionable gap: `npm install -g` would land a second launcher that brew's own symlink
     * shadows. `check.ts` picks the channel that matches the DETECTED owner, so a brew install is
     * judged against brew and an npm install against npm.
     */
    latest: [
      { kind: "brew-formula", name: "gemini-cli" },
      { kind: "npm", pkg: "@google/gemini-cli" },
    ],
    update: [
      { via: "brew-formula", command: "brew upgrade gemini-cli" },
      { via: "npm", command: "npm install -g @google/gemini-cli@latest" },
    ],
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    role: "agent",
    probe: { bin: "cursor-agent", args: ["--version"] },
    latest: [{ kind: "none", why: "no public version endpoint — cursor-agent checks on `update`" }],
    update: [{ via: "self", command: "cursor-agent update" }],
  },
  {
    id: "opencode",
    label: "opencode",
    role: "agent",
    probe: { bin: "opencode", args: ["--version"] },
    // The npm package is `opencode-ai`. Plain `opencode` on npm is a 404 — a plausible-looking
    // name that does not exist, and would have read as "never any update".
    latest: [{ kind: "npm", pkg: "opencode-ai" }],
    update: [
      {
        /**
         * Its own installer, which is how it is actually installed on the machine this was
         * measured on: `~/.opencode/bin/opencode`, nothing npm knows about. Without this row the
         * npm command was the only one, it was correctly WITHHELD as targeting an install that
         * does not exist — and the tool was then left with no update command at all.
         */
        via: "script",
        onlyOwners: ["native-installer"],
        command: "opencode upgrade",
      },
      { via: "npm", command: "npm install -g opencode-ai@latest" },
    ],
    note: "Repo moved to anomalyco/opencode; its default branch is `dev`, not `main`. Its model catalogue is models.dev.",
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    role: "agent",
    latest: [
      {
        kind: "none",
        why: "installed by git clone + fast-forward, so no release feed describes what you have",
      },
    ],
    update: [
      {
        via: "self",
        command: "hermes update",
        note: "The installer fast-forwards origin/main. There is no release to compare against.",
      },
    ],
    /**
     * Four sources gave four different numbers for this one. PyPI is not even the install
     * channel — `install.sh` git-clones the repo and `merge --ff-only`s `origin/main`. Checking
     * it against PyPI or GitHub releases produces a confident, wrong answer, which is worse than
     * the honest "cannot tell" this row gives instead.
     */
    note: "Version detection is unreliable by construction — four sources disagree. PROMETHEUS reports the update command, never a version comparison.",
  },
  {
    id: "node",
    label: "Node.js",
    role: "toolchain",
    probe: { bin: "node", args: ["--version"] },
    latest: [{ kind: "brew-formula", name: "node" }],
    update: [{ via: "brew-formula", command: "brew upgrade node" }],
    /**
     * The one row where "newer" is not automatically "better", so it says so.
     *
     * `engines.node` is a FLOOR (>= 22.6) but `.nvmrc` PINS 22, and Homebrew's `node` formula
     * always tracks the newest major — 26.10.0 as measured. Both are satisfiable at once and
     * the machine this was written on runs 26.10.0 against an `.nvmrc` of 22, which is fine
     * until a native addon disagrees. `node@22` exists as a separate formula (22.23.3) for
     * anyone who needs the pin honoured exactly.
     *
     * So a version gap here is reported as INFORMATION, never as a recommendation: pushing
     * someone across a major boundary to satisfy a floor they already meet is a change with
     * real downside and no upside.
     */
    note: "engines requires >= 22.6; .nvmrc pins 22; brew's `node` tracks the newest major. A gap here is worth knowing, not worth acting on by default — use the node@22 formula if the pin matters.",
  },
  {
    id: "pnpm",
    label: "pnpm",
    role: "toolchain",
    probe: { bin: "pnpm", args: ["--version"] },
    latest: [{ kind: "npm", pkg: "pnpm" }],
    update: [{ via: "self", command: "pnpm self-update" }],
  },
  {
    id: "git",
    label: "git",
    role: "toolchain",
    probe: { bin: "git", args: ["--version"] },
    latest: [{ kind: "brew-formula", name: "git" }],
    update: [{ via: "brew-formula", command: "brew upgrade git" }],
    /**
     * macOS ships git in /usr/bin via the Xcode command-line tools, and that is what `git`
     * resolves to on a machine with no brew git — measured here: 2.54.0 against Homebrew's
     * 2.55.0. The gap is real and the remedy is NOT an upgrade: `brew install git` adds a SECOND
     * git ahead of Apple's on PATH, which is the install-alongside pattern this whole feature
     * exists to warn about. So the row reports the difference and says what acting on it means.
     */
    note: "A system git (/usr/bin/git, from the Xcode tools) is updated by macOS, not by brew. `brew install git` adds a second one ahead of it on PATH rather than upgrading it.",
  },
  {
    id: "ripgrep",
    label: "ripgrep",
    role: "toolchain",
    probe: { bin: "rg", args: ["--version"] },
    latest: [{ kind: "brew-formula", name: "ripgrep" }],
    update: [{ via: "brew-formula", command: "brew upgrade ripgrep" }],
    note: "A hard prerequisite — the glob host tool shells out to it.",
  },
  {
    id: "uv",
    label: "uv",
    role: "optional",
    probe: { bin: "uv", args: ["--version"] },
    latest: [
      { kind: "pypi", pkg: "uv" },
      { kind: "brew-formula", name: "uv" },
    ],
    update: [
      {
        via: "script",
        onlyOwners: ["native-installer"],
        command: "uv self update",
        note: "Standalone-installer only — uv REFUSES this on a Homebrew or pip install and tells you to use that manager instead.",
      },
      { via: "brew-formula", command: "brew upgrade uv" },
      { via: "pipx", command: "pipx upgrade uv" },
    ],
  },
  {
    id: "huggingface-cli",
    label: "HuggingFace CLI",
    role: "optional",
    probe: { bin: "hf", args: ["version"] },
    latest: [{ kind: "pypi", pkg: "huggingface-hub" }],
    update: [{ via: "pipx", command: "pipx upgrade huggingface-hub" }],
    note: "`huggingface-cli` is the legacy name for the same install; both come from the huggingface-hub package.",
  },
  {
    id: "mlx-lm",
    label: "mlx-lm",
    role: "optional",
    latest: [{ kind: "pypi", pkg: "mlx-lm" }],
    update: [{ via: "pipx", command: "pipx upgrade mlx-lm" }],
    note: "Apple Silicon only. Needed for the MLX side of ollama's safetensors import path.",
  },
]);

/** Look a tool up by id (case-insensitive). */
export function toolCheck(id: string): ToolCheck | undefined {
  const key = id.trim().toLowerCase();
  return TOOL_CHECKS.find((t) => t.id === key);
}

/**
 * The identifier a given channel kind knows this tool by — the npm package, the PyPI
 * distribution, the formula or the cask token.
 *
 * Needed because a SYNTHESISED command (`install-owner.ts`'s `fallbackCommandFor`) has the
 * install's path but not its package name: a virtualenv directory is called `venv`, not
 * `huggingface-hub`. The table already carries the right name for every channel; this reads it
 * back out rather than making the caller pattern-match the union.
 */
export function packageIdFor(tool: ToolCheck, kind: LatestChannel["kind"]): string | undefined {
  for (const c of tool.latest) {
    if (c.kind !== kind) continue;
    if (c.kind === "npm") return c.pkg;
    if (c.kind === "pypi") return c.pkg;
    if (c.kind === "brew-formula") return c.name;
    if (c.kind === "brew-cask") return c.token;
    if (c.kind === "github") return c.repo;
  }
  return undefined;
}

/** Every tool in a role, in table order. */
export function toolsInRole(role: ToolRole): ToolCheck[] {
  return TOOL_CHECKS.filter((t) => t.role === role);
}

/**
 * The URL to fetch for a channel, or null when the channel needs no fetch (`none`) or needs
 * parameters the caller must supply (`vendor-delta` — see `vendorDeltaUrl`).
 */
export function latestUrl(channel: LatestChannel): string | null {
  switch (channel.kind) {
    case "npm":
      return `https://registry.npmjs.org/${channel.pkg}/latest`;
    case "brew-formula":
      return `https://formulae.brew.sh/api/formula/${channel.name}.json`;
    case "brew-cask":
      return `https://formulae.brew.sh/api/cask/${channel.token}.json`;
    case "pypi":
      return `https://pypi.org/pypi/${channel.pkg}/json`;
    case "github":
      return `https://api.github.com/repos/${channel.repo}/releases/latest`;
    default:
      return null;
  }
}

/**
 * The vendor-delta URL, which needs the CURRENT version to answer at all.
 *
 * This is the shape ollama uses: you tell it what you have and it tells you whether to move.
 * Returns null without a version, because asking without one is meaningless rather than a
 * request for "the latest".
 */
export function vendorDeltaUrl(
  channel: Extract<LatestChannel, { kind: "vendor-delta" }>,
  opts: { os: string; arch: string; version: string },
): string | null {
  if (!/^[a-z0-9]+$/i.test(opts.os) || !/^[a-z0-9_]+$/i.test(opts.arch)) return null;
  if (parseVersion(opts.version) === null) return null;
  const q = new URLSearchParams({ os: opts.os, arch: opts.arch, version: opts.version });
  return `${channel.url}?${q.toString()}`;
}

/**
 * Pull the version out of a channel's response document. Fail-soft → null.
 *
 * Every branch is deliberately narrow: a shape that does not match returns null rather than
 * coercing, because a garbled version compares as "different" and produces a phantom update.
 */
export function parseLatest(channel: LatestChannel, json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const ok = (v: unknown): string | null =>
    typeof v === "string" && parseVersion(v) !== null ? v : null;

  switch (channel.kind) {
    case "npm":
      return ok(o.version);
    case "brew-formula": {
      const versions = o.versions as Record<string, unknown> | undefined;
      return ok(versions?.stable);
    }
    case "brew-cask":
      /**
       * A cask version may carry a revision after a comma — `lm-studio` reports `0.4.25,1`.
       * `parseVersion` would reject the whole string, so the revision is dropped: it identifies
       * a repackaging of the same upstream release and is not part of the version being
       * compared.
       */
      return ok(typeof o.version === "string" ? o.version.split(",")[0] : undefined);
    case "pypi": {
      const info = o.info as Record<string, unknown> | undefined;
      return ok(info?.version);
    }
    case "github":
      // `/releases/latest` excludes prereleases, which is why it is used rather than the
      // releases LIST or the atom feed — ollama's feed currently titles an entry `v0.40.0`
      // while linking the tag `v0.40.0-rc0`, and a reader of `name` would announce a GA that
      // does not exist.
      return ok(o.tag_name);
    default:
      return null;
  }
}

/**
 * Did a `vendor-delta` endpoint say an update exists?
 *
 * 200 with a body ⇒ yes, and the body names the artifact. 204 ⇒ no. Anything else ⇒ unknown,
 * which is NOT "no" — the caller must be able to tell those apart.
 */
export function parseVendorDelta(status: number, body: string): { url: string } | "current" | null {
  if (status === 204) return "current";
  if (status !== 200) return null;
  try {
    const u = (JSON.parse(body) as { url?: unknown }).url;
    return typeof u === "string" && u.startsWith("https://") ? { url: u } : null;
  } catch {
    return null;
  }
}

/**
 * The update commands that apply, given the platform and (when known) how it was installed.
 *
 * `installedVia` narrows to the one correct command. Without it every candidate for the
 * platform is returned — which is the honest answer when we cannot tell, and far better than
 * guessing brew and sending someone to install a second copy of their engine.
 */
export function updateCommandsFor(
  tool: ToolCheck,
  platform: NodeJS.Platform,
  installedVia?: UpdateCommand["via"],
): UpdateCommand[] {
  return tool.update.filter(
    (c) =>
      (c.platform === undefined || c.platform === platform) &&
      (installedVia === undefined || c.via === installedVia),
  );
}
