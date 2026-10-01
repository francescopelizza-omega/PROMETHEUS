// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/package-managers.ts — ask the system what is upgradable, instead of asking the internet.
 *
 * The per-tool HTTP checks in `tool-registry.ts` answer "is there a newer X". This answers the
 * better question — "what on this machine is out of date" — in ONE command, from the authority
 * that actually installed the software. It needs no API key, has no rate limit, and it knows
 * things no registry can: which of two installs is the live one, whether a package is pinned,
 * and what the upgrade would actually do.
 *
 * ── WHY THIS IS A TABLE AND NOT A FUNCTION ──────────────────────────────────────────────────
 *
 * Every instinct to unify these managers behind one abstraction is wrong, and the exit codes
 * prove it. Verified against the upstream man pages and source:
 *
 *     dnf check-upgrade     100 = updates available,  0 = none,   1 = error
 *     pacman -Qu              0 = updates available,  1 = none
 *     checkupdates            0 = updates available,  2 = none,   1 = failure
 *     npm outdated            1 = updates available,  0 = none
 *     apt / apt-get           0 always — there is NO "updates available" code at all
 *     pipx list               0 always;  1 means a BROKEN VENV, not a finding
 *
 * Four different polarities and two managers with no signal. A shared `code !== 0` check would
 * report "nothing to update" on Arch, "everything is broken" on npm, and silently nothing on
 * Debian. So the semantics travel WITH the command, as data, and the caller is forced to read
 * them.
 *
 * ── THE OTHER HAZARD: A "LISTING" THAT IS NOT ONE ───────────────────────────────────────────
 *
 * Some of the obvious listing commands mutate the system:
 *
 *   - `checkupdates -d` calls `runasroot pacman -Sw`, which ESCALATES TO ROOT and writes
 *     `/var/cache/pacman/pkg`. Only the bare form is safe.
 *   - `checkupdates -c` writes state under `$XDG_STATE_HOME` and prints NOTHING when the list
 *     is unchanged since the last run — so it would report "nothing upgradable" when there is.
 *   - `pacman -Sy` refreshes the sync database and is the documented route to a broken partial
 *     upgrade. Never emitted.
 *   - dnf's listing verbs AUTO-SYNC expired metadata unless `-C` is passed: network traffic and
 *     a cache write, from something presented to the user as a read-only check.
 *
 * Every entry therefore declares `readOnly` and `needsRoot` explicitly, and a test asserts that
 * nothing marked `readOnly` carries a flag from the known-mutating set.
 *
 * PURE: the argv, the environment, the exit semantics and the parsers. The caller spawns.
 */

/** A package manager PROMETHEUS knows how to interrogate. */
export type ManagerId =
  | "brew"
  | "apt"
  | "dnf5"
  | "dnf4"
  | "zypper"
  | "pacman"
  | "apk"
  | "npm-global"
  | "pipx";

/**
 * How to read the exit code of a listing command.
 *
 * Deliberately a discriminated union rather than a pair of numbers: `apt` has no signal at all,
 * and a shape that forced it to name one would invite a caller to invent it.
 */
export type ExitSemantics =
  /** The code says nothing useful; the answer is entirely in stdout. */
  | { kind: "stdout-only"; okCodes: readonly number[] }
  /** A specific code means "updates exist" (dnf: 100; npm: 1). */
  | { kind: "code-means-updates"; updates: number; none: number }
  /** A specific code means "nothing to do" (pacman: 1; checkupdates: 2). */
  | { kind: "code-means-none"; none: number; updates: number };

/** One read-only "what is upgradable" command. */
export interface ListCommand {
  argv: readonly string[];
  /**
   * Environment the output depends on.
   *
   * `LC_ALL=C` is not optional on apt and zypper: their column headers and status words are
   * gettext-translated, so a parser written against English output silently returns nothing on
   * a French or German system.
   */
  env?: Readonly<Record<string, string>>;
  /** true only when the command neither writes nor reaches the network. */
  readOnly: boolean;
  needsRoot: boolean;
  exit: ExitSemantics;
  /** another binary that must exist first (checkupdates needs fakeroot). */
  requires?: readonly string[];
  note?: string;
}

export interface ManagerSpec {
  id: ManagerId;
  /**
   * True when this manager CANNOT answer "what is out of date".
   *
   * pipx is the case: `pipx list --json` enumerates installed venvs and pipx has no outdated
   * command at all. Without this flag its empty result is indistinguishable from "nothing to
   * update", and the report would reassure a user about a manager it never actually asked.
   */
  unsupported?: boolean;
  label: string;
  /** the binary whose presence proves the manager is available. */
  bin: string;
  platforms: readonly NodeJS.Platform[];
  /** `/etc/os-release` ID / ID_LIKE values that suggest this manager. A HINT, not the test. */
  distroIds?: readonly string[];
  list: ListCommand;
  /** upgrade one named package, non-interactively. `{}` is replaced with the name. */
  upgradeOne: readonly string[];
  upgradeAll: readonly string[];
  /** true when the upgrade (not the listing) needs sudo. */
  upgradeNeedsRoot: boolean;
  note?: string;
}

/** A package the manager says is out of date. */
export interface OutdatedPackage {
  manager: ManagerId;
  name: string;
  installed?: string;
  available?: string;
  /** held back by the user; upgrading it needs an explicit unpin first. */
  pinned?: boolean;
  /**
   * Homebrew only: which of its two package kinds this row came from.
   *
   * `brew outdated --json` returns `{ formulae: [...], casks: [...] }` and the old parser threw
   * that away, flattening both into one list — after which `upgradeCommand` emitted
   * `brew upgrade <name>` for everything. For a cask that is the wrong command, and for
   * `ollama` vs `ollama-app` it is the difference between updating the app and installing a
   * second CLI that fights it for :11434.
   */
  kind?: "formula" | "cask";
}

/**
 * Flags that make a "listing" command write, escalate, or lie. Nothing marked `readOnly` may
 * contain one, and a test enforces that — this list is the machine-checkable form of the
 * hazards in the header.
 */
export const MUTATING_FLAGS: readonly string[] = Object.freeze([
  "-Sy", // pacman: refreshes the sync db → partial-upgrade territory
  "-Syu",
  "-Sw", // downloads packages
  "-d", // checkupdates: runasroot pacman -Sw
  "--download",
  "-c", // checkupdates: writes state and prints nothing when unchanged
  "--change",
  "upgrade",
  "install",
  "refresh",
  "makecache",
]);

export const MANAGERS: readonly ManagerSpec[] = Object.freeze([
  {
    id: "brew",
    label: "Homebrew",
    bin: "brew",
    platforms: ["darwin", "linux"],
    list: {
      /**
       * `--json=v2` returns `{ formulae: [...], casks: [...] }` with installed_versions /
       * current_version / pinned — everything needed, already structured. The version is PINNED
       * rather than left to default: brew 7 hard-errors on `--json=v1`, so a bare `--json` is a
       * default that has already moved once.
       *
       * `--greedy` is not optional. Without it brew SKIPS every cask marked `auto_updates true`
       * or `version :latest` — which is the entire class of self-updating apps, including the
       * ollama and LM Studio casks. A sweep that omits them reports "everything is up to date"
       * about precisely the tools most likely not to be. The `version :latest` casks it drags in
       * (fonts, mostly) report installed === available and are dropped by the parser rather than
       * shown as permanently-outdated noise.
       */
      argv: ["brew", "outdated", "--json=v2", "--greedy"],
      readOnly: true,
      needsRoot: false,
      exit: { kind: "stdout-only", okCodes: [0] },
      note: "May print a one-off 'Downloading Homebrew API data' banner to stderr on a cold cache; stdout stays clean JSON.",
    },
    upgradeOne: ["brew", "upgrade", "{}"],
    upgradeAll: ["brew", "upgrade"],
    upgradeNeedsRoot: false,
  },
  {
    id: "apt",
    label: "apt (Debian/Ubuntu)",
    bin: "apt",
    platforms: ["linux"],
    distroIds: ["debian", "ubuntu", "linuxmint", "pop", "raspbian"],
    list: {
      argv: ["apt", "list", "--upgradable"],
      env: { LC_ALL: "C" },
      readOnly: true,
      needsRoot: false,
      /**
       * apt(8) Diagnostics, verbatim: "apt returns zero on normal operation, decimal 100 on
       * error." There is NO "updates available" code — the answer is only ever in stdout.
       */
      exit: { kind: "stdout-only", okCodes: [0] },
      note: "Reads the local lists only. Results are as stale as the last `sudo apt update`, which apt will NOT run for you — say so rather than implying freshness.",
    },
    upgradeOne: ["sudo", "apt", "install", "--only-upgrade", "-y", "{}"],
    upgradeAll: ["sudo", "apt", "upgrade", "-y"],
    upgradeNeedsRoot: true,
    note: "`--upgradable` and `--upgradeable` are both accepted; the man page uses the latter and apt's own hint prints the former.",
  },
  {
    id: "dnf5",
    label: "dnf5 (Fedora 41+)",
    bin: "dnf5",
    platforms: ["linux"],
    distroIds: ["fedora"],
    list: {
      // `-C` is load-bearing: without it dnf syncs expired metadata, which means network traffic
      // and a cache write from a command the user was told was a read-only check.
      argv: ["dnf5", "-C", "check-upgrade", "--json"],
      env: { LC_ALL: "C" },
      readOnly: true,
      needsRoot: false,
      exit: { kind: "code-means-updates", updates: 100, none: 0 },
      note: "dnf5 documents: exit 100 if updates are available, 0 if none. `--json` is supported on check-upgrade.",
    },
    upgradeOne: ["sudo", "dnf5", "upgrade", "-y", "{}"],
    upgradeAll: ["sudo", "dnf5", "upgrade", "-y"],
    upgradeNeedsRoot: true,
  },
  {
    id: "dnf4",
    label: "dnf (RHEL/CentOS/older Fedora)",
    bin: "dnf",
    platforms: ["linux"],
    distroIds: ["rhel", "centos", "rocky", "almalinux", "amzn", "ol"],
    list: {
      argv: ["dnf", "-C", "check-update"],
      env: { LC_ALL: "C" },
      readOnly: true,
      needsRoot: false,
      exit: { kind: "code-means-updates", updates: 100, none: 0 },
      note: "dnf4 has no --json on check-update; the output is columnar and must be parsed. `yum` is a symlink to dnf on RHEL 8+, so probe `--version` rather than trusting the name.",
    },
    upgradeOne: ["sudo", "dnf", "upgrade", "-y", "{}"],
    upgradeAll: ["sudo", "dnf", "upgrade", "-y"],
    upgradeNeedsRoot: true,
  },
  {
    id: "zypper",
    label: "zypper (openSUSE/SLES)",
    bin: "zypper",
    platforms: ["linux"],
    distroIds: ["opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles", "sled"],
    list: {
      argv: ["zypper", "--non-interactive", "--quiet", "list-updates"],
      env: { LC_ALL: "C" },
      readOnly: true,
      needsRoot: false,
      exit: { kind: "stdout-only", okCodes: [0] },
      note: "zypper has a large documented exit table (0-8, 100-107); 100/101 belong to `patch-check`, NOT to `list-updates`. Do not reuse them here.",
    },
    upgradeOne: ["sudo", "zypper", "--non-interactive", "update", "{}"],
    upgradeAll: ["sudo", "zypper", "--non-interactive", "update"],
    upgradeNeedsRoot: true,
  },
  {
    id: "pacman",
    label: "pacman (Arch)",
    bin: "pacman",
    platforms: ["linux"],
    distroIds: ["arch", "manjaro", "endeavouros", "garuda"],
    list: {
      /**
       * `checkupdates` from pacman-contrib, BARE. It copies the sync db to a private location
       * and queries that, so it sees fresh data without touching the system database.
       *
       * Emphatically not `checkupdates -d` (escalates to root, writes the package cache), not
       * `-c` (writes state and prints nothing when unchanged — it would report "up to date"
       * when there are updates), and never `pacman -Sy` (the documented route to a broken
       * partial upgrade). `--nocolor` because the output is otherwise ANSI-coloured.
       */
      argv: ["checkupdates", "--nocolor"],
      env: { LC_ALL: "C" },
      readOnly: true,
      needsRoot: false,
      exit: { kind: "code-means-none", none: 2, updates: 0 },
      requires: ["fakeroot"],
      note: "From pacman-contrib, and it hard-requires fakeroot. Exit 2 means no updates, 1 means it failed — the opposite polarity from most managers. It also filters [ignored] packages, so it under-reports relative to `pacman -Qu`.",
    },
    upgradeOne: ["sudo", "pacman", "-S", "--noconfirm", "{}"],
    upgradeAll: ["sudo", "pacman", "-Syu", "--noconfirm"],
    upgradeNeedsRoot: true,
    note: "Arch does not support partial upgrades: upgrading ONE package is discouraged and `-Syu` is the supported path. PROMETHEUS should say so rather than offering per-package upgrades as if they were safe here.",
  },
  {
    id: "apk",
    label: "apk (Alpine)",
    bin: "apk",
    platforms: ["linux"],
    distroIds: ["alpine"],
    list: {
      // `apk version -l '<'` is the portable form across apk-tools versions; `apk list
      // --upgradable` is newer and not present everywhere.
      argv: ["apk", "version", "-l", "<"],
      env: { LC_ALL: "C" },
      readOnly: true,
      needsRoot: false,
      exit: { kind: "stdout-only", okCodes: [0] },
    },
    upgradeOne: ["sudo", "apk", "upgrade", "{}"],
    upgradeAll: ["sudo", "apk", "upgrade"],
    upgradeNeedsRoot: true,
  },
  {
    id: "npm-global",
    label: "npm (global)",
    bin: "npm",
    platforms: ["darwin", "linux", "win32"],
    list: {
      argv: ["npm", "-g", "outdated", "--json"],
      readOnly: true,
      needsRoot: false,
      // npm's polarity is inverted relative to dnf: it exits 1 precisely BECAUSE it found
      // something. Treating that as failure hides every npm update there is.
      exit: { kind: "code-means-updates", updates: 1, none: 0 },
    },
    upgradeOne: ["npm", "install", "-g", "{}@latest"],
    upgradeAll: ["npm", "update", "-g"],
    upgradeNeedsRoot: false,
  },
  {
    id: "pipx",
    label: "pipx",
    bin: "pipx",
    platforms: ["darwin", "linux", "win32"],
    /**
     * pipx CAN be asked what is out of date, and this row used to insist that it could not.
     *
     * The old comment here read "there is no `pipx outdated`", `unsupported: true` was set beside
     * it, and `sweepManager` therefore returned early WITHOUT EVER SPAWNING PIPX — so the claim
     * could never be re-tested against whatever version is actually installed. The user saw
     * "pipx: cannot be checked — pipx has no \"what is outdated\" command", which was simply
     * false on their machine.
     *
     * Measured on pipx 1.17.6: `pipx list --help` documents `--outdated  List packages with an
     * available upgrade.` and `--output {human,json}`. The command exits 0 and returns a
     * structured envelope. Read out of pipx's own `commands/outdated.py`, the payload is
     * `data.packages[] = {environment, package, version, latest_version, injected, pinned}`,
     * plus `data.packages_checked` and `data.skipped[] = {environment, package, reason}`.
     *
     * `pinned` maps straight onto `OutdatedPackage.pinned`, which is the field that stops us
     * proposing an upgrade that needs an explicit unpin first.
     *
     * If a pipx too old for `--outdated` is installed, it exits non-zero with a usage error —
     * `okCodes: [0]` turns that into an honest "check failed" with the note below, rather than
     * into an empty list that would read as "everything current".
     */
    list: {
      argv: ["pipx", "list", "--outdated", "--output", "json"],
      readOnly: true,
      needsRoot: false,
      /**
       * pipx's `list` exits 1 when it found an environment it could not READ — a broken venv,
       * never "updates found". That is the exact opposite of npm's convention, and treating it
       * as a finding would report a corrupt venv as an available upgrade.
       */
      exit: { kind: "stdout-only", okCodes: [0] },
      note: "Needs a pipx with `list --outdated`; an older one exits non-zero and is reported as a failed check, not as 'up to date'. Exit 1 means a broken venv, never 'updates found'. Packages installed from a local or editable path are SKIPPED by pipx — an empty list means 'no index packages needed checking', not 'everything is current'.",
    },
    upgradeOne: ["pipx", "upgrade", "{}"],
    upgradeAll: ["pipx", "upgrade-all"],
    upgradeNeedsRoot: false,
  },
]);

/** Look a manager up by id. */
export function manager(id: string): ManagerSpec | undefined {
  return MANAGERS.find((m) => m.id === id.trim().toLowerCase());
}

/** The managers that could exist on a platform (before probing for the binary). */
export function managersForPlatform(platform: NodeJS.Platform): ManagerSpec[] {
  return MANAGERS.filter((m) => m.platforms.includes(platform));
}

/**
 * Rank managers for a Linux distro, best guess first.
 *
 * A HINT, never the test: `/etc/os-release` is vendor-set metadata and `yum` is a symlink to
 * dnf on RHEL 8+, so the binary's presence is ground truth and this only decides what to probe
 * for first. `ID_LIKE` is optional and is checked after `ID`.
 */
export function rankByDistro(osRelease: { ID?: string; ID_LIKE?: string }): ManagerSpec[] {
  const id = (osRelease.ID ?? "").trim().toLowerCase();
  const like = (osRelease.ID_LIKE ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((s) => s !== "");
  const score = (m: ManagerSpec): number => {
    if (!m.distroIds) return 0;
    if (id !== "" && m.distroIds.includes(id)) return 2;
    if (like.some((l) => m.distroIds?.includes(l))) return 1;
    return 0;
  };
  return managersForPlatform("linux")
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

/**
 * Parse `/etc/os-release`.
 *
 * The format is "environment-like shell-compatible variable assignments", but the spec is
 * explicit that no shell features are supported — so this strips quotes and does nothing else.
 * Expanding anything would be both wrong and a way to execute a vendor's file.
 */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Did the listing find anything, given its exit code?
 *
 * `null` means "the code does not say" — which is the honest answer for apt, apk, zypper and
 * pipx, and the caller must then look at what was parsed. Collapsing that to `false` is how a
 * Debian machine reports "everything up to date" forever.
 */
export function exitSaysUpdates(exit: ExitSemantics, code: number): boolean | null {
  switch (exit.kind) {
    case "code-means-updates":
      if (code === exit.updates) return true;
      if (code === exit.none) return false;
      return null;
    case "code-means-none":
      if (code === exit.none) return false;
      if (code === exit.updates) return true;
      return null;
    default:
      return exit.okCodes.includes(code) ? null : null;
  }
}

/** Did the command itself fail, as opposed to finding nothing? */
export function exitIsFailure(exit: ExitSemantics, code: number): boolean {
  switch (exit.kind) {
    case "code-means-updates":
      return code !== exit.updates && code !== exit.none;
    case "code-means-none":
      return code !== exit.none && code !== exit.updates;
    default:
      return !exit.okCodes.includes(code);
  }
}

/**
 * The concrete argv to upgrade one package.
 *
 * `{}` is replaced WITHIN an argument, not only when it is the whole argument — npm's template
 * is `{}@latest`, and an equality check left that as a literal `{}@latest`, producing a command
 * that installs a package called `{}`. The test caught it; the shape had looked obviously
 * correct.
 *
 * The name is validated first and refused rather than escaped: every manager here uses
 * conservative package names, so anything outside that set is a sign something is wrong, not
 * something to quote around. Nothing reaches a shell — this is an argv — but a name beginning
 * with `-` would still be read as a flag by the manager itself.
 */
export function upgradeCommand(
  spec: ManagerSpec,
  name: string,
  kind?: "formula" | "cask",
): string[] | null {
  if (!/^[A-Za-z0-9@][A-Za-z0-9._+@/-]*$/.test(name) || name.length > 200) return null;
  const argv = spec.upgradeOne.map((a) => a.split("{}").join(name));
  /**
   * A cask needs `--cask`, and the consequence of omitting it is not a failure — it is a
   * DIFFERENT PACKAGE. `brew upgrade ollama` and `brew upgrade --cask ollama-app` name two real,
   * distinct artifacts, and running the first for the second installs a CLI that fights the app
   * for :11434 (CLAUDE.md §2.8: 36,135 crash-loops). Homebrew will also refuse outright whenever
   * a formula and a cask share a token, so the flag is required for correctness either way.
   */
  if (spec.id === "brew" && kind === "cask") {
    const at = argv.indexOf("upgrade");
    if (at >= 0) argv.splice(at + 1, 0, "--cask");
  }
  return argv;
}

/* ── parsers ────────────────────────────────────────────────────────────────────────────────*/

/** `brew outdated --json` → both formulae and casks, with the pin flag carried through. */
export function parseBrewOutdated(stdout: string): OutdatedPackage[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof doc !== "object" || doc === null) return [];
  /**
   * v2 is `{ formulae: [], casks: [] }`; v1 is a BARE ARRAY of formulae. Accepting both is not
   * future-proofing — `--json=v1` is what older brews emit, and the v2-only parser returned []
   * for them, silently, which reads as "nothing to update".
   */
  const d = doc as { formulae?: unknown; casks?: unknown };
  const groups: [unknown, "formula" | "cask"][] = Array.isArray(doc)
    ? [[doc, "formula"]]
    : [
        [d.formulae, "formula"],
        [d.casks, "cask"],
      ];
  const rows: OutdatedPackage[] = [];
  for (const [group, kind] of groups) {
    if (!Array.isArray(group)) continue;
    for (const raw of group) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== "string" || r.name === "") continue;
      const installed = Array.isArray(r.installed_versions)
        ? r.installed_versions.filter((v): v is string => typeof v === "string").at(-1)
        : typeof r.installed_versions === "string"
          ? r.installed_versions
          : undefined;
      const available = typeof r.current_version === "string" ? r.current_version : undefined;
      /**
       * `--greedy` drags in `version :latest` casks, which report `installed_versions: ["latest"]`
       * and `current_version: "latest"`. They are not outdated; they have no version at all. A
       * font that can never be satisfied would sit in the report forever, teaching the user to
       * ignore it — the exact "shows outdated forever" behaviour --greedy was added to fix.
       */
      if (installed !== undefined && available !== undefined && installed === available) continue;
      rows.push({
        manager: "brew",
        name: r.name,
        kind,
        ...(installed !== undefined ? { installed } : {}),
        ...(available !== undefined ? { available } : {}),
        ...(r.pinned === true ? { pinned: true } : {}),
      });
    }
  }
  return rows;
}

/**
 * `apt list --upgradable` → rows.
 *
 * The line shape is `name/origin version arch [upgradable from: old]`. The first line is the
 * header `Listing...` and is skipped; with `LC_ALL=C` that word is stable.
 */
export function parseAptList(stdout: string): OutdatedPackage[] {
  const rows: OutdatedPackage[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("Listing") || t.startsWith("WARNING") || t.startsWith("NOTE"))
      continue;
    const m = /^([^/\s]+)\/\S+\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/.exec(t);
    if (!m) continue;
    /**
     * A multiarch package is listed as `libfoo:amd64/noble …`. The colon is not part of the
     * package name apt installs, and `upgradeCommand`'s name check REJECTS it — so the row was
     * parsed, reported, and then had no command, silently. The arch is kept out of `name` and
     * the plain name is what apt is asked to upgrade.
     */
    const rawName = m[1] as string;
    const colon = rawName.indexOf(":");
    rows.push({
      manager: "apt",
      name: colon > 0 ? rawName.slice(0, colon) : rawName,
      ...(m[3] ? { installed: m[3].trim() } : {}),
      ...(m[2] ? { available: m[2] } : {}),
    });
  }
  return rows;
}

/**
 * `dnf check-update` (dnf4) → rows.
 *
 * Columnar: `name.arch  version-release  repo`. Blank-line-separated sections and the
 * "Obsoleting Packages" tail must not be read as upgrades, so parsing stops at the first
 * section header after the list.
 */
export function parseDnfCheckUpdate(stdout: string): OutdatedPackage[] {
  const rows: OutdatedPackage[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trimEnd();
    if (t.trim() === "") continue;
    // A section header (e.g. "Obsoleting Packages") has no leading whitespace and no columns.
    if (/^[A-Z][A-Za-z ]+:?$/.test(t.trim())) break;
    if (/^(Last metadata|Dependencies resolved|Security:)/.test(t.trim())) continue;
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(t);
    if (!m) continue;
    const nameArch = m[1] as string;
    const dot = nameArch.lastIndexOf(".");
    rows.push({
      manager: "dnf4",
      name: dot > 0 ? nameArch.slice(0, dot) : nameArch,
      available: m[2] as string,
    });
  }
  return rows;
}

/** `checkupdates` → `name oldver -> newver`, one per line. */
export function parseCheckupdates(stdout: string): OutdatedPackage[] {
  const rows: OutdatedPackage[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+->\s+(\S+)\s*$/.exec(line.trim());
    if (!m) continue;
    rows.push({
      manager: "pacman",
      name: m[1] as string,
      installed: m[2] as string,
      available: m[3] as string,
    });
  }
  return rows;
}

/**
 * `pipx list --outdated --output json` → the packages with an available upgrade.
 *
 * The envelope and the row shape are read out of pipx's own `commands/outdated.py`, not guessed:
 *
 *     { "command": ["list"], "exit_code": 0, "status": "success",
 *       "data": { "packages_checked": 0,
 *                 "packages": [{ "environment", "package", "version", "latest_version",
 *                                "injected", "pinned" }],
 *                 "skipped":  [{ "environment", "package", "reason" }] } }
 *
 * Two fields are load-bearing and easy to miss:
 *
 *   • `pinned` — a package the user held back. `OutdatedPackage.pinned` exists so the renderer
 *     can say "[PINNED — unpin first]" instead of proposing an upgrade that will refuse.
 *   • `skipped` — pipx does not check a package installed from a local or editable path, because
 *     there is no index to compare against. Measured on this machine, the only pipx venv is
 *     exactly that (`--editable` from a local checkout), so the correct output is an EMPTY list
 *     with one skip — and a naive PyPI lookup of that name would either 404 or, far worse, match
 *     an unrelated public package and offer to "upgrade" a private project to it.
 *
 * Skips are not returned as rows: a skipped package is not an upgrade, and inventing one would
 * be the same mistake in a different direction. The manager row's `note` states the caveat once.
 */
export function parsePipxOutdated(stdout: string): OutdatedPackage[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return [];
  }
  const data = (doc as { data?: unknown })?.data;
  const list = (data as { packages?: unknown })?.packages;
  if (!Array.isArray(list)) return [];
  const rows: OutdatedPackage[] = [];
  for (const raw of list) {
    const p = raw as Record<string, unknown>;
    const name = typeof p.package === "string" ? p.package : "";
    if (name === "") continue;
    rows.push({
      manager: "pipx",
      name,
      ...(typeof p.version === "string" ? { installed: p.version } : {}),
      ...(typeof p.latest_version === "string" ? { available: p.latest_version } : {}),
      ...(p.pinned === true ? { pinned: true } : {}),
    });
  }
  return rows;
}

/** `npm -g outdated --json` → `{ pkg: { current, wanted, latest } }`. */
export function parseNpmOutdated(stdout: string): OutdatedPackage[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [];
  const rows: OutdatedPackage[] = [];
  for (const [name, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    rows.push({
      manager: "npm-global",
      name,
      ...(typeof r.current === "string" ? { installed: r.current } : {}),
      ...(typeof r.latest === "string" ? { available: r.latest } : {}),
    });
  }
  return rows;
}

/** `apk version -l '<'` → `name-ver < name-newver`, after a one-line header. */
export function parseApkVersion(stdout: string): OutdatedPackage[] {
  const rows: OutdatedPackage[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("Installed:")) continue;
    const m = /^(\S+?)-([0-9][^\s-]*(?:-r\d+)?)\s*<\s*(\S+)\s*$/.exec(t);
    if (!m) continue;
    rows.push({
      manager: "apk",
      name: m[1] as string,
      installed: m[2] as string,
      available: m[3] as string,
    });
  }
  return rows;
}

/**
 * `dnf5 -C check-upgrade --json` → rows.
 *
 * dnf5 emits JSON, and dispatching it to the dnf4 COLUMNAR parser returned [] on every Fedora
 * 41+ machine — while the exit code said 100, "updates available". The caller therefore saw
 * "updates exist, here are none of them", or, if it counted rows, reported the machine as
 * current. That is the failure mode this module's header calls the worst one.
 *
 * Parsed defensively rather than against one assumed schema: dnf5's key names have moved between
 * releases, so a top-level array and a wrapped one are both accepted, and the version is read
 * from `evr` if present, else composed from epoch/version/release, else `version`.
 */
export function parseDnf5Json(stdout: string): OutdatedPackage[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    // dnf5 without --json support (or an error page) — fall back rather than report zero.
    return parseDnfCheckUpdate(stdout).map((r) => ({ ...r, manager: "dnf5" as const }));
  }
  const list = Array.isArray(doc)
    ? doc
    : typeof doc === "object" && doc !== null
      ? ((doc as Record<string, unknown>).packages ?? (doc as Record<string, unknown>).upgrades)
      : null;
  if (!Array.isArray(list)) return [];
  const rows: OutdatedPackage[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    let name = typeof r.name === "string" ? r.name : "";
    if (name === "" && typeof r.nevra === "string") {
      // nevra is `name-epoch:version-release.arch`; the name is everything before the last two
      // dashes, which is fragile — so it is only used when `name` is genuinely absent.
      const m = /^(.+?)-\d+:/.exec(r.nevra) ?? /^(.+)-[^-]+-[^-]+$/.exec(r.nevra);
      name = m?.[1] ?? "";
    }
    if (name === "") continue;
    const evr =
      typeof r.evr === "string"
        ? r.evr
        : typeof r.version === "string"
          ? `${r.version}${typeof r.release === "string" ? `-${r.release}` : ""}`
          : undefined;
    rows.push({
      manager: "dnf5",
      name,
      ...(evr ? { available: evr } : {}),
    });
  }
  return rows;
}

/**
 * `zypper list-updates` → rows.
 *
 * A pipe table: `S | Repository | Name | Current Version | Available Version | Arch`. The column
 * POSITIONS are derived from the header rather than hardcoded, because zypper's column set
 * differs between `list-updates` and `list-patches` and between releases — and a hardcoded index
 * silently reads the wrong column rather than failing.
 */
export function parseZypperListUpdates(stdout: string): OutdatedPackage[] {
  const rows: OutdatedPackage[] = [];
  let nameAt = -1;
  let curAt = -1;
  let availAt = -1;
  for (const line of stdout.split("\n")) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (nameAt < 0) {
      const i = cells.indexOf("Name");
      if (i >= 0) {
        nameAt = i;
        curAt = cells.indexOf("Current Version");
        availAt = cells.indexOf("Available Version");
      }
      continue;
    }
    // The `---+---+---` rule under the header.
    if (cells.every((c) => c === "" || /^-+$/.test(c))) continue;
    const name = cells[nameAt];
    if (!name || name === "") continue;
    rows.push({
      manager: "zypper",
      name,
      ...(curAt >= 0 && cells[curAt] ? { installed: cells[curAt] as string } : {}),
      ...(availAt >= 0 && cells[availAt] ? { available: cells[availAt] as string } : {}),
    });
  }
  return rows;
}

/** Dispatch to the right parser for a manager's listing output. */
export function parseListing(id: ManagerId, stdout: string): OutdatedPackage[] {
  switch (id) {
    case "brew":
      return parseBrewOutdated(stdout);
    case "apt":
      return parseAptList(stdout);
    case "dnf4":
      return parseDnfCheckUpdate(stdout);
    case "dnf5":
      return parseDnf5Json(stdout);
    case "zypper":
      return parseZypperListUpdates(stdout);
    case "pacman":
      return parseCheckupdates(stdout);
    case "npm-global":
      return parseNpmOutdated(stdout);
    case "apk":
      return parseApkVersion(stdout);
    case "pipx":
      return parsePipxOutdated(stdout);
    default: {
      /**
       * Exhaustiveness as a TYPE error, not a runtime one. A new ManagerId with no parser is now
       * a failed build — which is how zypper and pipx should have been caught, instead of by a
       * hand-maintained list in a test that happened to omit both of them.
       */
      const never: never = id;
      void never;
      return [];
    }
  }
}
