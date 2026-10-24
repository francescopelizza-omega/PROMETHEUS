// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * onboarding/system-packages.ts — the system packages Prometheus uses at full potential, for
 * THIS operating system, and the exact command that adds the missing ones.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * `install.sh` scans the machine before it installs anything and offers one package-manager
 * command for what is missing. A user who installed some other way — a checkout run through
 * `bin/prometheus`, `pnpm dev:cli`, a second machine that already had Node — never saw that
 * scan, and the first sign that tmux, git or bubblewrap was missing was a feature quietly
 * running in its degraded mode. `prometheus requirements` and `prometheus doctor` ask the same
 * question here, with the same answer.
 *
 * ONE RULE, TWO IMPLEMENTATIONS. install.sh has to run before any Node exists, so it carries
 * its own POSIX-sh copy of this table (`pkg_name` / `pkg_cmd` / `distro_family` there). The two
 * MUST agree: a package name that differs between them would mean two different commands for
 * the same machine. system-packages.test.ts pins the same per-distro command lines that
 * tests/test_install_requirements.py pins for install.sh.
 *
 * WHAT IS NOT HERE: Node.js, Python and ripgrep. install.sh provisions those privately (pinned,
 * checksum-verified, no root), and a distro's Node is usually too old (Debian 12 / Ubuntu ≤25.10
 * ship < 22.6), so offering `apt-get install nodejs` would install the wrong thing.
 *
 * PURE: os-release text, a `which`, and the platform come in; a report comes out. The caller
 * probes and runs — through the privileged gate, the only place an elevated process may start.
 */
import { parseOsRelease } from "../updates/package-managers.js";

/** The package managers the requirements step can drive, in install.sh's naming. */
export type SysManager =
  | "brew"
  | "apt-get"
  | "dnf"
  | "yum"
  | "zypper"
  | "pacman"
  | "apk"
  | "xbps-install"
  | "rpm-ostree";

export type DistroFamily =
  | "macos"
  | "debian"
  | "fedora"
  | "rhel"
  | "arch"
  | "suse"
  | "alpine"
  | "other";

export interface Distro {
  /** os-release ID, lowercased ("ubuntu", "nobara"); "macos" on a Mac. */
  id: string;
  /** os-release ID_LIKE, split and lowercased. */
  like: readonly string[];
  /** what to call it on screen: PRETTY_NAME, or the platform. */
  name: string;
  family: DistroFamily;
}

/**
 * The family decides labels only, never package names — but the ID is consulted FIRST, because
 * Rocky and Alma list "fedora" in ID_LIKE and the Fedora-based Nobara may list "rhel".
 */
export function distroFamily(id: string, like: readonly string[]): DistroFamily {
  const ids: Record<string, DistroFamily> = {
    macos: "macos",
    debian: "debian",
    ubuntu: "debian",
    linuxmint: "debian",
    pop: "debian",
    elementary: "debian",
    zorin: "debian",
    kali: "debian",
    raspbian: "debian",
    neon: "debian",
    devuan: "debian",
    mx: "debian",
    deepin: "debian",
    fedora: "fedora",
    nobara: "fedora",
    ultramarine: "fedora",
    rhel: "rhel",
    centos: "rhel",
    rocky: "rhel",
    almalinux: "rhel",
    ol: "rhel",
    amzn: "rhel",
    scientific: "rhel",
    eurolinux: "rhel",
    cloudlinux: "rhel",
    virtuozzo: "rhel",
    arch: "arch",
    manjaro: "arch",
    endeavouros: "arch",
    garuda: "arch",
    cachyos: "arch",
    artix: "arch",
    sles: "suse",
    sled: "suse",
    alpine: "alpine",
  };
  const direct = ids[id] ?? (id.startsWith("opensuse") ? "suse" : undefined);
  if (direct) return direct;
  if (like.includes("debian") || like.includes("ubuntu")) return "debian";
  if (like.includes("rhel") || like.includes("centos")) return "rhel";
  if (like.includes("fedora")) return "fedora";
  if (like.includes("arch")) return "arch";
  if (like.includes("suse") || like.includes("opensuse")) return "suse";
  return "other";
}

/** The distro from /etc/os-release (null when it could not be read), or macOS. */
export function readDistro(platform: NodeJS.Platform, osRelease: string | null): Distro {
  if (platform === "darwin") return { id: "macos", like: [], name: "macOS", family: "macos" };
  const kv = osRelease ? parseOsRelease(osRelease) : {};
  const id = (kv.ID ?? "").toLowerCase();
  const like = (kv.ID_LIKE ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return {
    id,
    like,
    name: kv.PRETTY_NAME || kv.NAME || (platform === "linux" ? "Linux" : platform),
    family: distroFamily(id, like),
  };
}

export type SysPackageId = "git" | "tmux" | "bubblewrap" | "secret-tool";

export interface SysPackage {
  id: SysPackageId;
  /** the binary whose presence means it is installed */
  bin: string;
  tier: "recommended" | "optional";
  /** only meaningful on Linux (bubblewrap is the Linux sandbox; macOS has Seatbelt) */
  linuxOnly?: boolean;
  /** only worth installing where a desktop session — and so a Secret Service — exists */
  desktopOnly?: boolean;
  /** what Prometheus does with it, and what happens without it */
  why: string;
  /** package name(s) per manager; absent = this manager has no package for it */
  names: Partial<Record<SysManager, readonly string[]>>;
}

const ALL_RPM: readonly SysManager[] = ["dnf", "yum", "rpm-ostree"];
const same = (pkg: string, managers: readonly SysManager[]) =>
  Object.fromEntries(managers.map((m) => [m, [pkg]])) as Partial<
    Record<SysManager, readonly string[]>
  >;

/** In install order: git first, so a checkout fetched after it can be a real clone. */
export const SYSTEM_PACKAGES: readonly SysPackage[] = Object.freeze([
  {
    id: "git",
    bin: "git",
    tier: "recommended",
    why: "plugin installs (`prometheus install <name>`) clone through it",
    names: {
      ...same("git", ["brew", ...ALL_RPM, "zypper", "pacman", "apk", "xbps-install"]),
      // --no-install-recommends drops ca-certificates, and git cannot clone over https without it
      "apt-get": ["git", "ca-certificates"],
    },
  },
  {
    id: "tmux",
    bin: "tmux",
    tier: "optional",
    why: "extra windows (--tmux, chat --tmux, the windowed /demos); without it Prometheus runs in compatibility mode, in one terminal",
    names: same("tmux", ["brew", "apt-get", ...ALL_RPM, "zypper", "pacman", "apk", "xbps-install"]),
  },
  {
    id: "bubblewrap",
    bin: "bwrap",
    tier: "recommended",
    linuxOnly: true,
    why: "confines the agent's run_command on Linux; without it commands run unconfined, and say so",
    names: same("bubblewrap", ["apt-get", ...ALL_RPM, "zypper", "pacman", "apk", "xbps-install"]),
  },
  {
    id: "secret-tool",
    bin: "secret-tool",
    tier: "optional",
    linuxOnly: true,
    desktopOnly: true,
    why: "keeps provider API keys in the desktop keyring; without it, use environment variables",
    names: {
      "apt-get": ["libsecret-tools"],
      zypper: ["libsecret-tools"],
      ...same("libsecret", [...ALL_RPM, "pacman", "xbps-install"]),
    },
  },
]);

/**
 * The manager to install with. On Linux the distro's own comes first — Linuxbrew is someone's
 * choice for their own tools, and has no bubblewrap — and an image-based Fedora (Silverblue,
 * Kinoite, Bazzite) layers packages with rpm-ostree even though dnf is in the image.
 */
export function pickManager(
  platform: NodeJS.Platform,
  which: (bin: string) => string | null,
  ostree = false,
): SysManager | null {
  if (platform === "darwin") return which("brew") ? "brew" : null;
  if (platform !== "linux") return null;
  if (ostree && which("rpm-ostree")) return "rpm-ostree";
  const order: readonly SysManager[] = [
    "apt-get",
    "dnf",
    "yum",
    "zypper",
    "pacman",
    "apk",
    "xbps-install",
    "brew",
  ];
  return order.find((m) => which(m) !== null) ?? null;
}

/**
 * The commands that install `names`, as argv WITHOUT any elevator — the privileged gate adds
 * its own (`sudo -- …`), and refuses an `env VAR=…` prefix, so apt runs without
 * DEBIAN_FRONTEND here (none of these packages asks a debconf question).
 */
export function installSteps(manager: SysManager, names: readonly string[]): string[][] {
  const n = [...names];
  switch (manager) {
    case "brew":
      return [["brew", "install", ...n]];
    case "apt-get":
      return [
        ["apt-get", "update"],
        ["apt-get", "install", "-y", "--no-install-recommends", ...n],
      ];
    case "dnf":
    case "yum":
      return [[manager, "install", "-y", ...n]];
    case "rpm-ostree":
      return [["rpm-ostree", "install", "--idempotent", ...n]];
    case "zypper":
      return [["zypper", "--non-interactive", "install", ...n]];
    case "pacman":
      return [["pacman", "-S", "--needed", "--noconfirm", ...n]];
    case "apk":
      return [["apk", "add", "--no-cache", ...n]];
    case "xbps-install":
      return [["xbps-install", "-Sy", ...n]];
  }
}

/** Does this manager need root? Homebrew refuses it. */
export function needsRoot(manager: SysManager): boolean {
  return manager !== "brew";
}

/** What a person would type: each step, elevated when it needs to be, joined with `&&`. */
export function commandLine(steps: readonly string[][], elevator: string | null): string {
  return steps.map((s) => (elevator ? `${elevator} ${s.join(" ")}` : s.join(" "))).join(" && ");
}

export interface SysRow {
  pkg: SysPackage;
  /** where its binary resolves, or null when it is missing */
  found: string | null;
}

export interface SysReport {
  distro: Distro;
  manager: SysManager | null;
  /** every package that applies to this machine, found or not */
  rows: readonly SysRow[];
  /** the ones still missing, in install order */
  missing: readonly SysPackage[];
  /** argv steps that install the missing ones here; null when there is nothing to do or no way */
  steps: string[][] | null;
  /** macOS with something missing and no Homebrew to install it with */
  needsHomebrew: boolean;
}

export interface SysFacts {
  platform: NodeJS.Platform;
  osRelease: string | null;
  which: (bin: string) => string | null;
  /** a desktop session is running (a Secret Service can exist) */
  desktop?: boolean;
  /** /run/ostree-booted exists */
  ostree?: boolean;
}

export function scanSystemPackages(facts: SysFacts): SysReport {
  const distro = readDistro(facts.platform, facts.osRelease);
  const manager = pickManager(facts.platform, facts.which, facts.ostree === true);
  const applies = SYSTEM_PACKAGES.filter(
    (p) =>
      (!p.linuxOnly || facts.platform === "linux") && (!p.desktopOnly || facts.desktop === true),
  );
  const rows = applies.map((pkg) => ({ pkg, found: facts.which(pkg.bin) }));
  const missing = rows.filter((r) => r.found === null).map((r) => r.pkg);
  const names = manager ? missing.flatMap((p) => p.names[manager] ?? []) : [];
  return {
    distro,
    manager,
    rows,
    missing,
    steps: manager && names.length > 0 ? installSteps(manager, names) : null,
    needsHomebrew: facts.platform === "darwin" && manager === null && missing.length > 0,
  };
}
