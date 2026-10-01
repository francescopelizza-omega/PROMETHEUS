/**
 * package-managers.test.ts — the "what is upgradable" table.
 *
 * Two classes of test here, and the first matters more than the second.
 *
 * SAFETY: a command in this table gets run on a user's machine. If a "listing" carries a flag
 * that escalates to root, writes a cache, or contacts the network, PROMETHEUS has done
 * something the user did not ask for while telling them it was only looking. Those are asserted
 * structurally, against a list of known-mutating flags, so a future entry cannot reintroduce
 * one quietly.
 *
 * CORRECTNESS: the exit-code polarities genuinely disagree between managers — 100 means
 * "updates" on dnf, 1 means "updates" on npm, 1 means "none" on pacman, and apt has no signal
 * at all. Every one of those is a chance to write `code !== 0` and be wrong on three platforms.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MANAGERS,
  MUTATING_FLAGS,
  type ManagerSpec,
  exitIsFailure,
  exitSaysUpdates,
  manager,
  managersForPlatform,
  parseApkVersion,
  parseAptList,
  parseBrewOutdated,
  parseCheckupdates,
  parseDnf5Json,
  parseDnfCheckUpdate,
  parseListing,
  parseNpmOutdated,
  parseOsRelease,
  parsePipxOutdated,
  parseZypperListUpdates,
  rankByDistro,
  upgradeCommand,
} from "./package-managers.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

/* ── SAFETY: a listing must only look ───────────────────────────────────────────────────────*/

test("no command marked read-only carries a flag that writes, escalates, or refreshes", () => {
  // The hazards this encodes, all verified upstream:
  //   `checkupdates -d`  → runasroot pacman -Sw: escalates AND writes /var/cache/pacman/pkg
  //   `checkupdates -c`  → writes $XDG_STATE_HOME and prints NOTHING when unchanged
  //   `pacman -Sy`       → the documented route to a broken partial upgrade
  //   dnf without `-C`   → auto-syncs expired metadata: network + cache write
  for (const m of MANAGERS) {
    if (!m.list.readOnly) continue;
    for (const arg of m.list.argv) {
      assert.ok(
        !MUTATING_FLAGS.includes(arg),
        `${m.id} claims read-only but its listing passes ${arg}`,
      );
    }
  }
});

test("no listing command runs sudo, and none claims to need root", () => {
  // A check that prompts for a password is not a background check.
  for (const m of MANAGERS) {
    assert.equal(m.list.needsRoot, false, `${m.id} listing wants root`);
    assert.ok(!m.list.argv.includes("sudo"), `${m.id} listing invokes sudo`);
  }
});

test("dnf listings pass -C, because without it they hit the network", () => {
  for (const id of ["dnf4", "dnf5"] as const) {
    const m = manager(id) as ManagerSpec;
    assert.ok(m.list.argv.includes("-C"), `${id} would auto-sync expired metadata without -C`);
  }
});

test("pacman's listing is the BARE checkupdates, and never pacman -Sy", () => {
  const m = manager("pacman") as ManagerSpec;
  assert.deepEqual(m.list.argv, ["checkupdates", "--nocolor"]);
  assert.deepEqual(m.list.requires, ["fakeroot"], "checkupdates hard-requires fakeroot");
  assert.ok(m.list.note?.includes("ignored"), "and it under-reports; say so");
});

test("every upgrade command that needs root says so AND carries sudo", () => {
  // The two must agree, or the UI shows a command that fails, or asks for a password it does
  // not need.
  for (const m of MANAGERS) {
    const usesSudo = m.upgradeOne.includes("sudo") || m.upgradeAll.includes("sudo");
    assert.equal(
      usesSudo,
      m.upgradeNeedsRoot,
      `${m.id}: upgradeNeedsRoot=${m.upgradeNeedsRoot} but sudo=${usesSudo}`,
    );
  }
});

test("every manager declares at least one platform, and brew is on both unixes", () => {
  for (const m of MANAGERS) assert.ok(m.platforms.length > 0, `${m.id} has no platform`);
  assert.deepEqual(manager("brew")?.platforms, ["darwin", "linux"]);
  assert.equal(
    managersForPlatform("darwin").some((m) => m.id === "apt"),
    false,
    "apt must not be offered on macOS",
  );
});

/* ── the exit-code minefield ────────────────────────────────────────────────────────────────*/

test("dnf's 100 means updates; npm's 1 means updates; pacman's 1 means NONE", () => {
  // Three managers, three incompatible readings of a non-zero code.
  const dnf = (manager("dnf5") as ManagerSpec).list.exit;
  assert.equal(exitSaysUpdates(dnf, 100), true);
  assert.equal(exitSaysUpdates(dnf, 0), false);
  assert.equal(exitIsFailure(dnf, 1), true);

  const npm = (manager("npm-global") as ManagerSpec).list.exit;
  assert.equal(exitSaysUpdates(npm, 1), true, "npm exits 1 BECAUSE it found something");
  assert.equal(exitIsFailure(npm, 1), false, "which is not a failure");

  const pac = (manager("pacman") as ManagerSpec).list.exit;
  assert.equal(exitSaysUpdates(pac, 2), false, "checkupdates exits 2 when there is nothing");
  assert.equal(exitSaysUpdates(pac, 0), true);
  assert.equal(exitIsFailure(pac, 1), true, "1 is a genuine failure here");
});

test("apt's exit code says NOTHING — null, never false", () => {
  // Collapsing "no signal" to "no updates" is how a Debian machine reports itself up to date
  // forever. apt(8): "returns zero on normal operation, decimal 100 on error."
  const apt = (manager("apt") as ManagerSpec).list.exit;
  assert.equal(exitSaysUpdates(apt, 0), null);
  assert.equal(exitIsFailure(apt, 0), false);
  assert.equal(exitIsFailure(apt, 100), true);
});

test("pipx exit 1 is a broken venv, not a finding", () => {
  const pipx = (manager("pipx") as ManagerSpec).list.exit;
  assert.equal(exitSaysUpdates(pipx, 1), null);
  assert.equal(exitIsFailure(pipx, 1), true, "1 must read as an error, unlike npm");
});

/* ── distro detection ───────────────────────────────────────────────────────────────────────*/

test("parseOsRelease strips quotes and expands nothing", () => {
  // The spec is explicit that no shell features are supported. Expanding anything would be
  // both wrong and a way to run a vendor's file.
  const p = parseOsRelease(
    [
      "ID=ubuntu",
      "ID_LIKE=debian",
      'PRETTY_NAME="Ubuntu 24.04 LTS"',
      "VERSION_ID='24.04'",
      "# a comment",
      "",
      "junk-line",
      "lower=nope",
    ].join("\n"),
  );
  assert.equal(p.ID, "ubuntu");
  assert.equal(p.ID_LIKE, "debian");
  assert.equal(p.PRETTY_NAME, "Ubuntu 24.04 LTS");
  assert.equal(p.VERSION_ID, "24.04");
  assert.equal(p.lower, undefined, "keys are upper-case by the spec");
  assert.equal(Object.hasOwn(p, "$HOME"), false);
});

test("a distro hint ranks the right manager first, and ID_LIKE is the fallback", () => {
  assert.equal(rankByDistro({ ID: "ubuntu" })[0]?.id, "apt");
  assert.equal(rankByDistro({ ID: "fedora" })[0]?.id, "dnf5");
  assert.equal(rankByDistro({ ID: "rocky" })[0]?.id, "dnf4");
  assert.equal(rankByDistro({ ID: "arch" })[0]?.id, "pacman");
  assert.equal(rankByDistro({ ID: "alpine" })[0]?.id, "apk");
  // an unknown distro that declares a family still lands somewhere sensible
  assert.equal(rankByDistro({ ID: "mydistro", ID_LIKE: "debian" })[0]?.id, "apt");
  // and a completely unknown one still returns every candidate rather than nothing
  assert.equal(rankByDistro({}).length, managersForPlatform("linux").length);
});

/* ── parsers, against real output ───────────────────────────────────────────────────────────*/

test("brew: the REAL `brew outdated --json` from this machine parses, casks included", () => {
  const rows = parseBrewOutdated(readFileSync(join(FIX, "brew-outdated.json"), "utf8"));
  assert.equal(rows.length, 8, "6 formulae + 2 casks");
  const claude = rows.find((r) => r.name === "claude-code");
  assert.deepEqual(claude, {
    manager: "brew",
    name: "claude-code",
    kind: "cask",
    installed: "2.1.274",
    available: "2.1.277",
  });
  // a formula and a cask must both be present — reading only `formulae` loses the agent CLIs
  assert.equal(rows.find((r) => r.name === "imagemagick")?.kind, "formula");
  assert.equal(rows.find((r) => r.name === "codex")?.kind, "cask");
});

test("brew: --greedy reveals casks the default listing hides, and its noise is dropped", () => {
  /**
   * Captured from this machine on 2026-09-29, `brew outdated --json=v2 --greedy`.
   *
   * The default listing skips every cask with `auto_updates true` — the entire class of
   * self-updating apps. Measured side by side: without --greedy brew reported 2 outdated casks,
   * with it 4. `codex` 0.157.1 -> 0.158.0 is in the second set and not the first, so the sweep
   * was structurally unable to report the user's own agent CLI as stale.
   *
   * The cost of --greedy is `version :latest` casks, which report installed === available
   * forever. `font-barlow-condensed` is the live example; a row that can never be satisfied
   * teaches the user to ignore the report, so it is dropped rather than shown.
   */
  const rows = parseBrewOutdated(readFileSync(join(FIX, "brew-outdated-greedy.json"), "utf8"));
  const names = rows.map((r) => r.name);
  assert.ok(names.includes("codex"), "--greedy is what surfaces codex at all");
  assert.ok(names.includes("flutter"));
  assert.ok(
    !names.includes("font-barlow-condensed"),
    "a `version :latest` cask is not outdated — it has no version to compare",
  );
  assert.equal(rows.filter((r) => r.kind === "cask").length, 3);
});

test("brew: the v1 BARE-ARRAY shape parses too, instead of silently returning nothing", () => {
  // Older brews emit `--json=v1`, a bare array of formulae. The v2-only parser returned [] for
  // them — which the caller could not distinguish from "nothing to update".
  const rows = parseBrewOutdated(
    JSON.stringify([
      { name: "openssl@3", installed_versions: ["3.0.1"], current_version: "3.0.2" },
    ]),
  );
  assert.deepEqual(rows, [
    { manager: "brew", name: "openssl@3", kind: "formula", installed: "3.0.1", available: "3.0.2" },
  ]);
});

test("a cask is upgraded with --cask; a formula without it", () => {
  /**
   * `brew upgrade ollama` and `brew upgrade --cask ollama-app` name two DIFFERENT artifacts.
   * Emitting the formula form for a cask row is how a second CLI gets installed beside an app
   * that is already serving :11434.
   */
  const brew = manager("brew") as ManagerSpec;
  assert.deepEqual(upgradeCommand(brew, "claude-code", "cask"), [
    "brew",
    "upgrade",
    "--cask",
    "claude-code",
  ]);
  assert.deepEqual(upgradeCommand(brew, "imagemagick", "formula"), [
    "brew",
    "upgrade",
    "imagemagick",
  ]);
  // …and an unknown kind stays conservative: the formula form, which is what brew defaults to.
  assert.deepEqual(upgradeCommand(brew, "imagemagick"), ["brew", "upgrade", "imagemagick"]);
});

test("brew: a pinned package is flagged, because upgrading it needs an unpin first", () => {
  const rows = parseBrewOutdated(
    JSON.stringify({
      formulae: [
        { name: "held", installed_versions: ["1.0"], current_version: "2.0", pinned: true },
        { name: "free", installed_versions: ["1.0"], current_version: "2.0", pinned: false },
      ],
      casks: [],
    }),
  );
  assert.equal(rows.find((r) => r.name === "held")?.pinned, true);
  assert.equal(rows.find((r) => r.name === "free")?.pinned, undefined);
});

test("apt: the documented line shape, with the header and notices skipped", () => {
  const out = [
    "Listing...",
    "NOTE: This is only a simulation!",
    "curl/noble-updates 8.5.0-2ubuntu10.6 amd64 [upgradable from: 8.5.0-2ubuntu10.5]",
    "vim/noble-security 2:9.1.0016-1ubuntu7.8 amd64 [upgradable from: 2:9.1.0016-1ubuntu7.7]",
    "libfoo/noble 1.2.3 all",
    "",
  ].join("\n");
  const rows = parseAptList(out);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    manager: "apt",
    name: "curl",
    installed: "8.5.0-2ubuntu10.5",
    available: "8.5.0-2ubuntu10.6",
  });
  assert.equal(rows[2]?.installed, undefined, "no 'upgradable from' means no installed version");
});

test("dnf: columnar output, stopping before the Obsoleting section", () => {
  const out = [
    "Last metadata expiration check: 0:10:00 ago on Sun 28 Sep 2026.",
    "",
    "kernel.x86_64          6.11.4-201.fc41     updates",
    "vim-enhanced.x86_64    2:9.1.866-1.fc41    updates",
    "",
    "Obsoleting Packages",
    "old-thing.noarch       1.0-1.fc41          updates",
  ].join("\n");
  const rows = parseDnfCheckUpdate(out);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["kernel", "vim-enhanced"],
    "an obsoleted package is not an upgrade",
  );
  assert.equal(rows[0]?.available, "6.11.4-201.fc41");
});

test("pacman: `name old -> new`", () => {
  const rows = parseCheckupdates(
    "linux 6.11.3.arch1-1 -> 6.11.4.arch1-1\nvim 9.1.0-1 -> 9.1.1-1\n",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    manager: "pacman",
    name: "linux",
    installed: "6.11.3.arch1-1",
    available: "6.11.4.arch1-1",
  });
});

test("npm: the json map, keyed by package", () => {
  const rows = parseNpmOutdated(
    JSON.stringify({
      "@openai/codex": { current: "0.157.1", wanted: "0.158.0", latest: "0.158.0" },
      pnpm: { current: "12.5.0", wanted: "12.6.0", latest: "12.6.0" },
    }),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    manager: "npm-global",
    name: "@openai/codex",
    installed: "0.157.1",
    available: "0.158.0",
  });
});

test("apk: `name-ver < newver`, header skipped", () => {
  const rows = parseApkVersion(
    "Installed:                Available:\nbusybox-1.36.1-r29 < 1.36.1-r30\nssl_client-1.36.1-r29 < 1.36.1-r30\n",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.name, "busybox");
  assert.equal(rows[0]?.installed, "1.36.1-r29");
});

test("every parser returns [] on junk rather than throwing", () => {
  // These run against whatever a stranger's system printed, including an error page, a
  // locale-translated header, or nothing at all.
  for (const junk of ["", "   ", "not json", "<html>500</html>", "\n\n\n", "null", "[]"]) {
    for (const id of ["brew", "apt", "dnf4", "pacman", "npm-global", "apk"] as const) {
      assert.deepEqual(parseListing(id, junk), [], `${id} choked on ${JSON.stringify(junk)}`);
    }
  }
});

/* ── the upgrade command ────────────────────────────────────────────────────────────────────*/

test("a package name is substituted, not interpolated — anything odd is refused", () => {
  // This argv gets executed. Every manager's names are conservative, so a name that is not is
  // refused rather than escaped.
  const brew = manager("brew") as ManagerSpec;
  assert.deepEqual(upgradeCommand(brew, "imagemagick"), ["brew", "upgrade", "imagemagick"]);
  assert.deepEqual(upgradeCommand(manager("npm-global") as ManagerSpec, "@openai/codex"), [
    "npm",
    "install",
    "-g",
    "@openai/codex@latest",
  ]);
  for (const bad of [
    "; rm -rf /",
    "foo bar",
    "$(whoami)",
    "`id`",
    "--force",
    "-rf",
    "",
    "a".repeat(201),
    "foo\nbar",
  ]) {
    assert.equal(upgradeCommand(brew, bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("arch says so rather than pretending a single-package upgrade is safe", () => {
  // Partial upgrades are unsupported on Arch; `-Syu` is the only supported path. Offering a
  // per-package upgrade there as if it were routine is how a system ends up half-updated.
  const m = manager("pacman") as ManagerSpec;
  assert.ok(m.note?.includes("partial"), "the pacman row must carry the partial-upgrade warning");
  assert.deepEqual(m.upgradeAll, ["sudo", "pacman", "-Syu", "--noconfirm"]);
});

/* ------------- the parsers that did not exist, and reported zero ------------- */

test("dnf5 emits JSON, and the dnf4 columnar parser read ZERO updates from it", () => {
  /**
   * The worst shape of failure in this whole module: `dnf5 -C check-upgrade --json` exits 100
   * ("updates available") while the old dispatch ran the dnf4 COLUMNAR parser over its JSON and
   * returned []. The caller saw "updates exist, here are none of them" — or, counting rows,
   * "Fedora is up to date". No test covered it because the junk-input test iterated an id list
   * that omitted dnf5.
   */
  const json = JSON.stringify([
    { name: "kernel", evr: "6.11.3-200.fc41", arch: "x86_64", repo_id: "updates" },
    { name: "vim-common", evr: "2:9.1.866-1.fc41", arch: "x86_64", repo_id: "updates" },
  ]);
  assert.deepEqual(parseListing("dnf5", json), [
    { manager: "dnf5", name: "kernel", available: "6.11.3-200.fc41" },
    { manager: "dnf5", name: "vim-common", available: "2:9.1.866-1.fc41" },
  ]);
});

test("dnf5 accepts a wrapped array and composes a version when `evr` is absent", () => {
  // The key names have moved between dnf5 releases, so the parser reads what is there rather
  // than failing closed on one assumed schema.
  const wrapped = JSON.stringify({
    packages: [{ name: "bash", version: "5.2.32", release: "1.fc41" }],
  });
  assert.deepEqual(parseListing("dnf5", wrapped), [
    { manager: "dnf5", name: "bash", available: "5.2.32-1.fc41" },
  ]);
});

test("dnf5 without --json support falls back to the columnar parser, not to zero", () => {
  const columnar = "kernel.x86_64    6.11.3-200.fc41    updates\n";
  assert.deepEqual(parseListing("dnf5", columnar), [
    { manager: "dnf5", name: "kernel", available: "6.11.3-200.fc41" },
  ]);
});

test("zypper had no parser at all — every openSUSE machine read as up to date", () => {
  /**
   * `zypper list-updates` runs, exits 0, prints a real table, and `parseListing("zypper", …)`
   * hit the `default: return []` arm. Column positions are derived from the header because
   * zypper's column set differs between subcommands and releases.
   */
  const out = [
    "Loading repository data...",
    "S | Repository | Name        | Current Version | Available Version | Arch",
    "--+------------+-------------+-----------------+-------------------+-------",
    "v | Main Repo  | curl        | 8.0.1-1.1       | 8.6.0-1.1         | x86_64",
    "v | Main Repo  | glibc       | 2.38-1.1        | 2.39-2.1          | x86_64",
  ].join("\n");
  assert.deepEqual(parseListing("zypper", out), [
    { manager: "zypper", name: "curl", installed: "8.0.1-1.1", available: "8.6.0-1.1" },
    { manager: "zypper", name: "glibc", installed: "2.38-1.1", available: "2.39-2.1" },
  ]);
});

test("zypper column order is read from the header, not hardcoded", () => {
  const swapped = [
    "S | Name  | Available Version | Current Version | Arch",
    "--+-------+-------------------+-----------------+------",
    "v | curl  | 8.6.0-1.1         | 8.0.1-1.1       | x86_64",
  ].join("\n");
  assert.deepEqual(parseListing("zypper", swapped), [
    { manager: "zypper", name: "curl", installed: "8.0.1-1.1", available: "8.6.0-1.1" },
  ]);
});

test("`unsupported` now describes NOTHING, because pipx can in fact be asked", () => {
  /**
   * This test used to assert the opposite, and the thing it asserted was false.
   *
   * The old claim — "pipx has no outdated command" — was baked into the row as
   * `unsupported: true`, and `sweepManager` returns early on that flag WITHOUT SPAWNING THE
   * MANAGER. So the claim could never be re-tested against whatever pipx is installed, and the
   * user was told "pipx has no 'what is outdated' command — PROMETHEUS cannot check it" by a
   * check that had never run. Measured on pipx 1.17.6: `pipx list --help` documents
   * `--outdated  List packages with an available upgrade.`
   *
   * The flag itself is kept, deliberately. It is the right answer for a manager that genuinely
   * cannot answer, and an empty list from one that was never asked really is indistinguishable
   * from "everything current". It simply describes nothing today — which this asserts, so that
   * the next row to claim it has to justify the claim.
   */
  assert.notEqual(manager("pipx")?.unsupported, true);
  assert.deepEqual(
    MANAGERS.filter((m) => m.unsupported).map((m) => m.id),
    [],
  );
  // A listing that carries no packages array is still an empty list, never a fabricated row.
  assert.deepEqual(parseListing("pipx", '{"venvs":{"black":{}}}'), []);
});

test("an apt multiarch name loses its :arch, so an upgrade command can be built for it", () => {
  /**
   * `libfoo:amd64/noble 2.0 amd64 [upgradable from: 1.0]`. The colon is not part of the package
   * name apt installs, and `upgradeCommand`'s name check REJECTED it — so the row was found,
   * reported, and then silently had no command attached to it.
   */
  const rows = parseListing(
    "apt",
    "Listing...\nlibfoo:amd64/noble 2.0 amd64 [upgradable from: 1.0]\n",
  );
  assert.deepEqual(rows, [{ manager: "apt", name: "libfoo", installed: "1.0", available: "2.0" }]);
  assert.ok(upgradeCommand(manager("apt") as ManagerSpec, rows[0]?.name as string));
});

test("EVERY manager either parses its own output or says it cannot", () => {
  /**
   * The invariant that zypper and pipx both violated. It is enforced at compile time too —
   * `parseListing`'s default arm assigns `id` to `never` — but this states it as a property, so
   * the reason survives even if the switch is refactored.
   */
  for (const m of MANAGERS) {
    if (m.unsupported) continue;
    const rows = parseListing(m.id, "");
    assert.ok(Array.isArray(rows), `${m.id} has no parser`);
  }
  // A manager with real output must return real rows for at least one of them — the check above
  // cannot tell "parsed nothing" from "no parser", which is exactly how this was missed.
  assert.ok(
    parseListing(
      "zypper",
      "S | Name | Current Version | Available Version\n--+--+--+--\nv | a | 1 | 2",
    ).length > 0,
  );
});

/**
 * pipx CAN be asked what is outdated, and this repo used to insist that it could not.
 *
 * The row carried `unsupported: true`, so `sweepManager` returned early WITHOUT EVER SPAWNING
 * PIPX — which meant the claim could never be re-tested against the installed version. The user
 * was told "pipx has no 'what is outdated' command", which is false on pipx 1.17.6:
 * `pipx list --help` documents `--outdated  List packages with an available upgrade.`
 *
 * The payload shape below is read out of pipx's own `commands/outdated.py`, not guessed.
 */
test("pipx --outdated JSON parses into rows, carrying `pinned`", () => {
  const stdout = JSON.stringify({
    command: ["list"],
    exit_code: 0,
    status: "success",
    data: {
      packages_checked: 2,
      packages: [
        {
          environment: "httpie",
          package: "httpie",
          version: "3.2.2",
          latest_version: "3.2.4",
          injected: false,
          pinned: false,
        },
        {
          environment: "black",
          package: "black",
          version: "24.1.0",
          latest_version: "25.1.0",
          injected: false,
          pinned: true,
        },
      ],
      skipped: [],
    },
  });
  const rows = parsePipxOutdated(stdout);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    manager: "pipx",
    name: "httpie",
    installed: "3.2.2",
    available: "3.2.4",
  });
  // `pinned` is what stops us proposing an upgrade that will simply refuse.
  assert.equal(rows[1]?.pinned, true);
});

test("a pipx SKIP is not an upgrade — an editable local checkout has no index to compare to", () => {
  /**
   * Measured on this machine: the only pipx venv is `--editable` from a local path
   * (`/Users/<name>/ALPHA/remnutrition[gui,http2,pdf]`), so pipx correctly reports zero packages
   * and one skip. Turning that skip into a row would mean querying PyPI for a private project
   * name and either 404ing or — far worse — matching an UNRELATED public package and offering to
   * "upgrade" the user's own code to it.
   */
  const stdout = JSON.stringify({
    data: {
      packages_checked: 0,
      packages: [],
      skipped: [{ environment: "remnutrition", package: "remnutrition", reason: "editable" }],
    },
  });
  assert.deepEqual(parsePipxOutdated(stdout), []);
});

test("pipx is no longer flagged unsupported, and asks the right question", () => {
  const pipx = manager("pipx");
  assert.ok(pipx);
  assert.notEqual(pipx.unsupported, true, "the sweep must actually spawn pipx and find out");
  assert.deepEqual(pipx.list.argv, ["pipx", "list", "--outdated", "--output", "json"]);
  // Exit 1 is a BROKEN VENV, never "updates found" — the opposite of npm's convention.
  assert.deepEqual(pipx.list.exit, { kind: "stdout-only", okCodes: [0] });
});

test("garbage in, empty out — never a fabricated row", () => {
  assert.deepEqual(parsePipxOutdated("not json"), []);
  assert.deepEqual(parsePipxOutdated("{}"), []);
  assert.deepEqual(parsePipxOutdated(JSON.stringify({ data: { packages: "nope" } })), []);
});
