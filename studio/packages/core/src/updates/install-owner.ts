// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/install-owner.ts — who installed this binary, and which copy actually runs.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * Every other module in `updates/` answers "is there a newer version". This one answers the
 * question that has to be settled FIRST, and that PROMETHEUS was previously guessing at: *which
 * copy of the tool am I talking about*. Getting that wrong does not produce a missing update, it
 * produces a confidently wrong instruction that appears to work.
 *
 * The measurements that forced it, all from one machine on 2026-09-29:
 *
 *   claude   ~/.local/bin/claude      -> ~/.local/share/claude/versions/2.1.284   (native installer)
 *            /opt/homebrew/bin/claude -> ../Caskroom/claude-code/2.1.274/...      (brew CASK)
 *   codex    /opt/homebrew/bin/codex  -> ../Caskroom/codex/0.157.1/...            (brew CASK)
 *            ~/.local/share/npm/bin/codex -> ../lib/node_modules/@openai/codex/... (npm global)
 *   ollama   /opt/homebrew/bin/ollama -> ../Cellar/ollama/0.34.4/bin/ollama       (brew FORMULA)
 *            /usr/local/bin/ollama    -> /Applications/Ollama.app/.../ollama      (app bundle)
 *
 * In all three the tool is installed twice, at different versions, by different owners. The
 * consequences are not symmetric and not obvious:
 *
 *   • `brew upgrade --cask claude-code` moves the cask from 2.1.274 to 2.1.277 — BEHIND the
 *     2.1.284 the user actually runs. brew reports success. Nothing the user runs changes. This
 *     is exactly "brew installs a newer version alongside and never lets me use it".
 *   • `ollama`'s brew FORMULA won PATH, so a 0.34.4 client drives the 0.34.1 server inside
 *     Ollama.app, which owns :11434. Upgrading the formula can never move the server.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────
 *
 * Attribution is decided by the REALPATH, never by the PATH entry. `/opt/homebrew/bin/claude` is
 * a symlink and says nothing; `../Caskroom/claude-code/2.1.274/…` says everything — the owner AND
 * the version, without executing anything. That last part matters: a shadowed binary is by
 * definition one the user did not choose to run, so PROMETHEUS reads its version out of its path
 * and never spawns it. Running an unexpected binary to find out what it is, is how a supply-chain
 * problem becomes a supply-chain incident.
 *
 * PURE. Paths and hints in, a verdict out. Every `realpath`, `stat` and version probe is the
 * caller's — see `apps/cli/src/updates/resolve.ts`.
 */

import { compareVersions, parseVersion, withoutRevision } from "./semver.js";
import type { UpdateCommand } from "./tool-registry.js";

/**
 * Who installed a binary.
 *
 * `brew-formula` and `brew-cask` are deliberately separate: they have different upgrade flags,
 * different prefixes and different listing semantics, and conflating them is what produced
 * `brew upgrade ollama` for a machine running Ollama.app.
 */
export type InstallOwner =
  | "brew-formula"
  | "brew-cask"
  | "npm-global"
  | "pnpm-global"
  | "pipx"
  | "python-venv"
  | "cargo"
  | "go"
  /** a vendor's own `curl … | sh` installer, which manages its own `versions/<v>` tree. */
  | "native-installer"
  /** a macOS `.app` — the version lives in Info.plist, not in the path. */
  | "app-bundle"
  /** shipped with the OS. Never upgradable on its own terms. */
  | "system"
  /** a real file we cannot attribute. Reported honestly; never guessed at. */
  | "unknown";

/** What a path told us about the install behind it. */
export interface OwnerInfo {
  owner: InstallOwner;
  /** the package/formula/cask/tool name the owner knows it by, when the path carries one. */
  name?: string;
  /**
   * The version read OUT OF THE PATH — free, and safe for a copy we must not execute.
   * Absent when the layout does not encode one (an app bundle, a venv, /usr/bin).
   */
  version?: string;
  /** the install prefix, when the layout has one (a brew prefix, an npm prefix). */
  prefix?: string;
}

/**
 * Filesystem facts the caller looked up, for the discriminations a path alone cannot make.
 *
 * Kept as an explicit input rather than done inline so this file stays pure and testable. Each
 * field exists because a path-only rule was measured to be WRONG:
 *
 *  • `pipxVenv` — a pipx venv contains `pyvenv.cfg` just like a hand-made one, so a bare
 *    `pyvenv.cfg` test calls every pipx install a plain venv. The discriminator is the sibling
 *    `pipx_metadata.json`. And the location is not fixed: `PIPX_HOME` overrides it, macOS uses
 *    `~/Library/Application Support/pipx/venvs`, Linux `~/.local/share/pipx/venvs`.
 *  • `pyvenvCfg` — the same lookup for the plain-venv case.
 *  • `npmPrefixes` — npm's global prefix is configurable (`~/.npmrc`), and on this machine a
 *    `codex update` run silently repointed it at a directory whose `bin` is not on PATH.
 */
export interface OwnerHints {
  /** true when a `pipx_metadata.json` sits at the venv root above this binary. */
  pipxVenv?: boolean;
  /** true when a `pyvenv.cfg` sits at the venv root above this binary. */
  pyvenvCfg?: boolean;
  /** npm/pnpm global prefixes as reported by the tools themselves. */
  npmPrefixes?: readonly string[];
  /** the user's home, for the `~/.local/share/<tool>/versions/<v>` and cargo/go layouts. */
  home?: string;
}

/** Split a POSIX-or-Windows path into segments, dropping empties. */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/**
 * The index of `needle` in `segs`, or -1.
 *
 * Case-sensitive on purpose. macOS's default filesystem is case-INsensitive, so `/cellar/` would
 * also resolve — but `realpath` returns the on-disk spelling, and matching loosely here would let
 * an ordinary directory called `caskroom` be read as a Homebrew cask.
 */
function segIndex(segs: readonly string[], needle: string): number {
  return segs.indexOf(needle);
}

/**
 * Does this look like a version? Used only to decide whether a path segment is the version
 * component of a layout, never to compare — `semver.ts` owns comparison.
 *
 * Deliberately looser than `parseVersion`: Homebrew's Cellar carries revisions (`26.10.0_1`),
 * casks carry a packaging suffix (`0.4.25,1`), and `latest` is a real cask version. A segment
 * that cannot be a version is how we detect that we have mis-read the layout.
 */
function looksLikeVersion(s: string): boolean {
  return s === "latest" || /^v?\d[\w.+~,_-]*$/.test(s);
}

/**
 * Attribute an absolute, symlink-RESOLVED path to whoever installed it.
 *
 * Order matters: the specific layouts are tested before the generic ones, because several of them
 * nest. An npm global install under Homebrew's node lives at
 * `/opt/homebrew/lib/node_modules/…` — which contains the string `homebrew` and, under the old
 * `/Cellar|homebrew|linuxbrew/` regex in `probe.ts`, was classified `brew`. It is not a brew
 * package; brew has no idea it exists, and `brew upgrade` would not touch it.
 */
export function classifyPath(realPath: string, hints: OwnerHints = {}): OwnerInfo {
  const segs = segments(realPath);
  const home = hints.home ? segments(hints.home) : null;
  /** Is this path `$HOME/<rest…>/…`? False whenever no home was supplied — never a guess. */
  const startsUnderHome = (): boolean => home?.every((h, i) => segs[i] === h) ?? false;
  const underHome = (rest: readonly string[]): boolean =>
    home !== null && startsUnderHome() && segs.length > home.length
      ? rest.every((r, i) => segs[home.length + i] === r)
      : false;

  /* --- Homebrew: the two kinds are different packages, never merged --- */
  const cellar = segIndex(segs, "Cellar");
  if (cellar >= 0 && segs.length > cellar + 2 && looksLikeVersion(segs[cellar + 2] as string)) {
    return {
      owner: "brew-formula",
      name: segs[cellar + 1] as string,
      version: segs[cellar + 2] as string,
      prefix: `/${segs.slice(0, cellar).join("/")}`,
    };
  }
  const caskroom = segIndex(segs, "Caskroom");
  if (
    caskroom >= 0 &&
    segs.length > caskroom + 2 &&
    looksLikeVersion(segs[caskroom + 2] as string)
  ) {
    return {
      owner: "brew-cask",
      name: segs[caskroom + 1] as string,
      version: segs[caskroom + 2] as string,
      prefix: `/${segs.slice(0, caskroom).join("/")}`,
    };
  }

  /* --- node package managers, BEFORE any prefix test (they nest inside brew's prefix) --- */
  const nodeModules = segIndex(segs, "node_modules");
  if (nodeModules >= 0 && segs.length > nodeModules + 1) {
    // A scoped package is two segments: @openai/codex.
    const first = segs[nodeModules + 1] as string;
    const name =
      first.startsWith("@") && segs.length > nodeModules + 2
        ? `${first}/${segs[nodeModules + 2]}`
        : first;
    const isPnpm = segs.includes(".pnpm") || segs.includes("pnpm");
    return {
      owner: isPnpm ? "pnpm-global" : "npm-global",
      name,
      prefix: `/${segs.slice(0, Math.max(0, nodeModules - 1)).join("/")}`,
    };
  }

  /* --- python: pipx and a hand-made venv are indistinguishable by path alone --- */
  const venvs = segIndex(segs, "venvs");
  if (hints.pipxVenv || (venvs >= 0 && segs[venvs - 1] === "pipx")) {
    return {
      owner: "pipx",
      ...(venvs >= 0 && segs.length > venvs + 1 ? { name: segs[venvs + 1] as string } : {}),
    };
  }
  if (hints.pyvenvCfg) return { owner: "python-venv" };

  /* --- a vendor's own installer: `~/.local/share/<tool>/versions/<semver>/…` --- */
  const versions = segIndex(segs, "versions");
  if (
    versions > 0 &&
    segs.length > versions + 1 &&
    looksLikeVersion(segs[versions + 1] as string)
  ) {
    return {
      owner: "native-installer",
      name: segs[versions - 1] as string,
      version: segs[versions + 1] as string,
    };
  }

  /* --- a macOS app bundle: the version is in Info.plist, NOT in the path --- */
  const app = segs.findIndex((s) => s.endsWith(".app"));
  if (app >= 0) {
    return { owner: "app-bundle", name: (segs[app] as string).replace(/\.app$/, "") };
  }

  /**
   * The two language toolchains, BEFORE the generic dot-directory rule below — `~/.cargo/bin`
   * matches both shapes, and "cargo" is the more useful answer because it carries an upgrade
   * command the generic one does not.
   */
  if (underHome([".cargo", "bin"])) return { owner: "cargo" };
  if (underHome(["go", "bin"])) return { owner: "go" };

  /**
   * The other vendor-installer shape: a dot-directory in $HOME that the tool owns outright.
   *
   * Measured: `lms` lives in `~/.lmstudio/bin`, `opencode` in `~/.opencode/bin`, and codex's
   * installer uses `~/.codex/bin`. These were previously "unattributed", which meant no update
   * command was offered for them at all — a silent gap rather than a wrong answer, but a gap in
   * exactly the tools the user asked about. There is no version in the path, so the winner still
   * has to be probed; the ATTRIBUTION is what this recovers.
   */
  if (home !== null && startsUnderHome()) {
    const owned = segs[home.length];
    if (
      owned?.startsWith(".") &&
      segs[home.length + 1] === "bin" &&
      segs.length > home.length + 2
    ) {
      return { owner: "native-installer", name: owned.slice(1) };
    }
  }

  /**
   * Only now, the OS.
   *
   * `/usr/local` is NOT in this list. It is the default Homebrew prefix on Intel macOS and the
   * conventional home of hand-installed software on Linux; calling it "system" would tell a user
   * their tool is un-upgradable when it is merely un-attributed.
   */
  const root = `/${segs[0] ?? ""}`;
  if (segs.length > 1 && (root === "/usr" || root === "/bin" || root === "/sbin")) {
    if (segs[1] === "local") return { owner: "unknown" };
    return { owner: "system", name: segs[segs.length - 1] as string };
  }

  return { owner: "unknown" };
}

/**
 * The `UpdateCommand.via` that an owner's update lives under, or null when there is no such
 * command to look up.
 *
 * `null` is a real answer, not a failure: nothing updates a binary attributed to `system` or to
 * `unknown` on its own terms, and inventing a `via` for them is how a guess becomes a command.
 */
export function viaForOwner(owner: InstallOwner): UpdateCommand["via"] | null {
  switch (owner) {
    // NOT collapsed to one "brew". A formula install matching a cask command is the precise
    // shape of the bug this module exists to stop — see the `via` doc comment in tool-registry.
    case "brew-formula":
      return "brew-formula";
    case "brew-cask":
      return "brew-cask";
    case "npm-global":
    case "pnpm-global":
      return "npm";
    case "pipx":
      return "pipx";
    case "python-venv":
      return "venv";
    case "native-installer":
      return "script";
    case "app-bundle":
      return "app";
    default:
      return null;
  }
}

/** One installed copy of a tool, as resolved from one PATH entry. */
export interface ToolCopy {
  /** the PATH entry as found, before symlink resolution (what the shell would pick). */
  pathEntry: string;
  /** the fully resolved target. Equal to `pathEntry` when it is not a symlink. */
  realPath: string;
  owner: InstallOwner;
  /** the owner's name for it (formula, cask token, npm package…). */
  name?: string;
  /**
   * The best version known for this copy, and how it was learned.
   *
   * `path` costs nothing and is safe for every copy. `probe` means the binary was executed, and
   * is only ever done for the copy that WINS — the one the user is already running anyway.
   * `bundle` is an Info.plist read.
   */
  version?: string;
  versionSource?: "path" | "probe" | "bundle";
}

/** Whether more than one owner installed this tool, and whether the newest one is what runs. */
export type InstallState =
  /** one copy. The ordinary, healthy case. */
  | "single"
  /** several copies, and the one PATH picks is the newest. Worth saying, not worth alarm. */
  | "duplicate"
  /**
   * Several copies and PATH picks one that is NOT the newest.
   *
   * This is the user's reported bug. An update aimed at any copy but the winner will appear to
   * succeed and change nothing they run.
   */
  | "shadowed"
  /** several copies whose versions cannot all be read, so precedence cannot be judged. */
  | "ambiguous"
  /** the tool is not installed at all. */
  | "absent";

export interface ToolResolution {
  /** the tool id from `tool-registry.ts`. */
  tool: string;
  /** every copy found, in PATH order. `copies[0]` is what runs. */
  copies: readonly ToolCopy[];
  state: InstallState;
  /** the copy PATH resolves to, i.e. the one whose version the user actually experiences. */
  winner?: ToolCopy;
  /**
   * Copies that exist but are unreachable, newest first.
   *
   * Non-empty is the signal that an update command must be checked against its target before it
   * is offered.
   */
  shadowed: readonly ToolCopy[];
  /** a shadowed copy that is NEWER than the winner — present exactly when state is "shadowed". */
  newerShadow?: ToolCopy;
}

/**
 * Compare two copies' versions. `null` when either is unknown, so the caller can tell
 * "older" from "cannot say" — a distinction this whole module exists to preserve.
 */
function cmpCopies(a: ToolCopy, b: ToolCopy): number | null {
  if (!a.version || !b.version) return null;
  /**
   * A cask's packaging revision (`0.4.25,1`) and a formula's rebuild (`26.10.0_1`) identify a
   * repackaging of the SAME upstream release, so they are dropped before comparing: a rebuild is
   * not a newer program, and treating it as one would manufacture a shadow that is not there.
   *
   * `compareVersions` deliberately ranks them, because `brew outdated` saying
   * `26.10.0 -> 26.10.0_1` IS an update worth applying. The two callers want opposite things from
   * the same field; this is the one that wants it ignored.
   */
  const [pa, pb] = [
    parseVersion(withoutRevision(a.version)),
    parseVersion(withoutRevision(b.version)),
  ];
  if (!pa || !pb) return null;
  return compareVersions(withoutRevision(a.version), withoutRevision(b.version));
}

/**
 * Fold the copies found on PATH into one verdict.
 *
 * `copies` MUST be in PATH resolution order — the first element is what the shell runs, and the
 * whole point of the verdict is the relationship between that one and the rest.
 */
export function resolveTool(tool: string, copies: readonly ToolCopy[]): ToolResolution {
  if (copies.length === 0) return { tool, copies, state: "absent", shadowed: [] };
  const winner = copies[0] as ToolCopy;
  const rest = copies.slice(1);
  if (rest.length === 0) return { tool, copies, state: "single", winner, shadowed: [] };

  let newer: ToolCopy | undefined;
  let unknown = false;
  for (const c of rest) {
    const cmp = cmpCopies(c, winner);
    if (cmp === null) {
      unknown = true;
      continue;
    }
    if (cmp > 0 && (newer === undefined || (cmpCopies(c, newer) ?? 0) > 0)) newer = c;
  }

  // Newest first, so a renderer can name the most consequential shadow without re-sorting.
  const shadowed = [...rest].sort((a, b) => -(cmpCopies(a, b) ?? 0));

  if (newer) return { tool, copies, state: "shadowed", winner, shadowed, newerShadow: newer };
  if (unknown) return { tool, copies, state: "ambiguous", winner, shadowed };
  return { tool, copies, state: "duplicate", winner, shadowed };
}

/**
 * Is this update command aimed at the copy the user actually runs?
 *
 * The guard that turns all of the above into a refusal instead of a footnote. `brew upgrade
 * --cask claude-code` is a perfectly valid command that upgrades a perfectly real install — and
 * offering it to someone whose `claude` comes from the native installer is the precise shape of
 * the bug being fixed, because it succeeds.
 */
export function targetsWinner(res: ToolResolution, command: UpdateCommand): boolean {
  if (!res.winner) return false;
  /**
   * An explicit owner list beats every other rule, in both directions.
   *
   * It is the only thing that can stop `codex update` — a `via: "self"` command, which by the
   * rule below targets whatever is running — from being offered to a Homebrew cask install, where
   * it does not update the cask at all: it runs the vendor installer, writes ~/.local/bin/codex,
   * and shadows the cask from then on. That is this feature CAUSING the bug it was built to find.
   */
  if (command.onlyOwners) return command.onlyOwners.includes(res.winner.owner);
  // `self` and `git` are the tool updating itself in place, so they act on whatever is running —
  // which is the winner by definition. `manual` is an instruction to a human, not a target.
  if (command.via === "self" || command.via === "git" || command.via === "manual") return true;
  return viaForOwner(res.winner.owner) === command.via;
}

/**
 * Which of a tool's update commands may be offered, and why the others were withheld.
 *
 * Never returns an empty `offer` and a silent drop: a command excluded for targeting the wrong
 * copy is MORE interesting than one that applies, because it is the one the user would otherwise
 * have found themselves — in `brew outdated`, in a changelog, in a forum answer.
 */
export function partitionCommands(
  res: ToolResolution,
  commands: readonly UpdateCommand[],
): { offer: UpdateCommand[]; withheld: { command: UpdateCommand; reason: string }[] } {
  const offer: UpdateCommand[] = [];
  const withheld: { command: UpdateCommand; reason: string }[] = [];
  for (const c of commands) {
    if (targetsWinner(res, c)) {
      offer.push(c);
      continue;
    }
    const target = res.copies.find((x) => viaForOwner(x.owner) === c.via);
    const winnerOwner = res.winner ? ownerLabel(res.winner.owner) : "nothing";
    withheld.push({
      command: c,
      reason: target
        ? `updates the ${ownerLabel(target.owner)} copy at ${target.realPath}${
            target.version ? ` (${target.version})` : ""
          }, which is not the one on PATH`
        : c.onlyOwners
          ? // The most consequential withholding, so it says what would have HAPPENED rather
            // than merely that the command did not apply: this is the branch that stops a
            // vendor installer being run over a package-managed install and creating a shadow.
            `would install a separate copy rather than update the ${winnerOwner} one on PATH`
          : `no ${c.via} install of this tool was found`,
    });
  }
  return { offer, withheld };
}

/**
 * The update command implied by an install, when the static table has none that fits.
 *
 * Two cases need this and neither can be tabulated:
 *
 *  • A **virtualenv** upgrade command contains the venv's own path, which is a property of the
 *    machine. On this one, `hf` lives in `~/.hf-cli/venv` — a venv pipx has never heard of, so
 *    the table's `pipx upgrade huggingface-hub` errors out. The right command is that venv's own
 *    pip, and it can only be derived from the resolved binary.
 *  • A **Homebrew** install whose row lists the other kind. `brew upgrade <formula>` and
 *    `brew upgrade --cask <token>` are both mechanical from the keg path, and emitting the exact
 *    one beats emitting nothing.
 *
 * Returns null when there genuinely is no command — a `system` binary, or one we could not
 * attribute. That null is the input to an honest "this one is not managed by anything I can see",
 * which is a better answer than a plausible command that fails.
 */
export function fallbackCommandFor(copy: ToolCopy, pkg?: string): UpdateCommand | null {
  const name = pkg ?? copy.name;
  switch (copy.owner) {
    case "brew-formula":
      return name ? { via: "brew-formula", command: `brew upgrade ${name}` } : null;
    case "brew-cask":
      return name ? { via: "brew-cask", command: `brew upgrade --cask ${name}` } : null;
    case "npm-global":
      return name ? { via: "npm", command: `npm install -g ${name}@latest` } : null;
    case "pnpm-global":
      return name ? { via: "npm", command: `pnpm add -g ${name}@latest` } : null;
    case "pipx":
      return name ? { via: "pipx", command: `pipx upgrade ${name}` } : null;
    case "python-venv": {
      /**
       * `<venv>/bin/pip`, found by walking up from the binary to the directory that holds `bin`.
       * Quoted, because a venv under "Application Support" has a space in it and an unquoted
       * command would be pasted straight into a shell and silently split.
       */
      const i = copy.realPath.lastIndexOf("/bin/");
      if (i < 0 || !name) return null;
      const pip = `${copy.realPath.slice(0, i)}/bin/pip`;
      return {
        via: "venv",
        command: `"${pip}" install -U ${name}`,
        note: "This virtualenv is not managed by pipx — upgrade it with its own pip.",
      };
    }
    case "cargo":
      return name ? { via: "manual", command: `cargo install ${name} --force` } : null;
    case "go":
      return null; // `go install` needs the module path, which the binary's own path never carries.
    default:
      return null;
  }
}

/** A short human name for an owner. Rendering lives in report.ts; this is the shared vocabulary. */
export function ownerLabel(owner: InstallOwner): string {
  switch (owner) {
    case "brew-formula":
      return "Homebrew formula";
    case "brew-cask":
      return "Homebrew cask";
    case "npm-global":
      return "npm global";
    case "pnpm-global":
      return "pnpm global";
    case "pipx":
      return "pipx";
    case "python-venv":
      return "Python venv";
    case "cargo":
      return "cargo";
    case "go":
      return "go install";
    case "native-installer":
      return "vendor installer";
    case "app-bundle":
      return "app bundle";
    case "system":
      return "system";
    default:
      return "unattributed";
  }
}

/**
 * Would removing one copy destroy another?
 *
 * The obvious remediation for a duplicate is "uninstall the one you don't use", and the obvious
 * command for a Homebrew cask is `brew uninstall --zap`. On this machine that command is
 * destructive in a way nothing about it advertises: the `claude-code` cask's zap stanza lists
 * `~/.local/bin/claude`, `~/.local/share/claude`, `~/.claude.json` and `~/.config/claude` — so
 * zapping the STALE cask deletes the NEWER native install (five versions, ~1.1 GB) and the user's
 * configuration with it.
 *
 * Containment, not equality: the zap lists `~/.local/share/claude` while the live binary is at
 * `~/.local/share/claude/versions/2.1.284/…`. Those are not equal strings, and an equality test
 * would have reported this as safe.
 *
 * Paths must be pre-expanded by the caller (`~` resolved, symlinks followed) — this compares.
 */
export function zapHazard(
  zapPaths: readonly string[],
  copies: readonly ToolCopy[],
  removing: ToolCopy,
): ToolCopy[] {
  const contains = (dir: string, p: string): boolean =>
    p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
  return copies.filter(
    (c) =>
      c !== removing &&
      zapPaths.some(
        (z) => contains(z, c.realPath) || contains(z, c.pathEntry) || contains(c.realPath, z),
      ),
  );
}
