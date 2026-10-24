/**
 * system-packages.test.ts — the per-OS requirements answer the CLI gives, pinned to the SAME
 * package lists tests/test_install_requirements.py pins for install.sh. If one side changes a
 * package name, its own test fails here or there, and the two commands never silently diverge.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SYSTEM_PACKAGES,
  commandLine,
  distroFamily,
  installSteps,
  pickManager,
  readDistro,
  scanSystemPackages,
} from "./system-packages.js";

const OS_RELEASE = {
  ubuntu: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
  debian: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n',
  fedora: 'ID=fedora\nPRETTY_NAME="Fedora Linux 41 (Workstation Edition)"\n',
  nobara: 'ID=nobara\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Nobara Linux 41 (KDE Plasma)"\n',
  rhel: 'ID="rhel"\nID_LIKE="fedora"\nPRETTY_NAME="Red Hat Enterprise Linux 9.4 (Plow)"\n',
  rocky: 'ID="rocky"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"\n',
  centos7: 'ID="centos"\nID_LIKE="rhel fedora"\nPRETTY_NAME="CentOS Linux 7 (Core)"\n',
};

const has =
  (...bins: string[]) =>
  (b: string): string | null =>
    bins.includes(b) ? `/usr/bin/${b}` : null;

test("families: the ID decides first — Nobara is Fedora, Rocky is RHEL despite ID_LIKE", () => {
  assert.equal(readDistro("linux", OS_RELEASE.ubuntu).family, "debian");
  assert.equal(readDistro("linux", OS_RELEASE.nobara).family, "fedora");
  assert.equal(readDistro("linux", OS_RELEASE.rocky).family, "rhel");
  assert.equal(readDistro("linux", OS_RELEASE.centos7).family, "rhel");
  assert.equal(readDistro("linux", OS_RELEASE.rhel).family, "rhel");
  assert.equal(distroFamily("linuxmint", ["ubuntu", "debian"]), "debian");
  assert.equal(distroFamily("opensuse-tumbleweed", []), "suse");
  assert.equal(distroFamily("something", []), "other");
  assert.equal(readDistro("linux", null).name, "Linux");
  assert.equal(readDistro("darwin", null).family, "macos");
});

test("blank Ubuntu: one apt-get update + install, the same packages install.sh offers", () => {
  const r = scanSystemPackages({
    platform: "linux",
    osRelease: OS_RELEASE.ubuntu,
    which: has("apt-get"),
  });
  assert.equal(r.distro.name, "Ubuntu 24.04.1 LTS");
  assert.equal(r.manager, "apt-get");
  assert.deepEqual(
    r.missing.map((p) => p.id),
    ["git", "tmux", "bubblewrap"],
  );
  assert.deepEqual(r.steps, [
    ["apt-get", "update"],
    [
      "apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      "git",
      "ca-certificates",
      "tmux",
      "bubblewrap",
    ],
  ]);
  assert.equal(
    commandLine(r.steps ?? [], "sudo"),
    "sudo apt-get update && sudo apt-get install -y --no-install-recommends git ca-certificates tmux bubblewrap",
  );
});

test("Fedora, Nobara, RHEL, Rocky: dnf; CentOS 7: yum — same package names", () => {
  for (const d of ["fedora", "nobara", "rhel", "rocky"] as const) {
    const r = scanSystemPackages({
      platform: "linux",
      osRelease: OS_RELEASE[d],
      which: has("dnf", "yum"),
    });
    assert.deepEqual(r.steps, [["dnf", "install", "-y", "git", "tmux", "bubblewrap"]], d);
  }
  const c7 = scanSystemPackages({
    platform: "linux",
    osRelease: OS_RELEASE.centos7,
    which: has("yum"),
  });
  assert.deepEqual(c7.steps, [["yum", "install", "-y", "git", "tmux", "bubblewrap"]]);
});

test("only what is missing is asked for; a complete machine has no steps", () => {
  const some = scanSystemPackages({
    platform: "linux",
    osRelease: OS_RELEASE.ubuntu,
    which: has("apt-get", "git", "bwrap"),
  });
  assert.deepEqual(some.steps?.[1]?.slice(4), ["tmux"]);
  const all = scanSystemPackages({
    platform: "linux",
    osRelease: OS_RELEASE.ubuntu,
    which: has("apt-get", "git", "bwrap", "tmux"),
  });
  assert.equal(all.steps, null);
  assert.deepEqual(all.missing, []);
});

test("Linuxbrew never outranks the distro manager; rpm-ostree wins on an image-based Fedora", () => {
  assert.equal(pickManager("linux", has("brew", "apt-get")), "apt-get");
  assert.equal(pickManager("linux", has("dnf", "rpm-ostree"), true), "rpm-ostree");
  assert.equal(pickManager("linux", has("dnf", "rpm-ostree"), false), "dnf");
});

test("a Linux desktop also gets the keyring tool; a server does not", () => {
  const desk = scanSystemPackages({
    platform: "linux",
    osRelease: OS_RELEASE.fedora,
    which: has("dnf", "git", "tmux", "bwrap"),
    desktop: true,
  });
  assert.deepEqual(desk.steps, [["dnf", "install", "-y", "libsecret"]]);
  const srv = scanSystemPackages({
    platform: "linux",
    osRelease: OS_RELEASE.ubuntu,
    which: has("apt-get", "git", "tmux", "bwrap"),
  });
  assert.equal(srv.steps, null);
});

test("macOS: brew when it is there, Homebrew itself when it is not — never bubblewrap", () => {
  const brew = scanSystemPackages({
    platform: "darwin",
    osRelease: null,
    which: has("brew", "git"),
  });
  assert.deepEqual(brew.steps, [["brew", "install", "tmux"]]);
  assert.equal(brew.needsHomebrew, false);
  const blank = scanSystemPackages({ platform: "darwin", osRelease: null, which: has() });
  assert.equal(blank.steps, null);
  assert.equal(blank.needsHomebrew, true);
  assert.deepEqual(
    blank.missing.map((p) => p.id),
    ["git", "tmux"],
  );
});

test("every step is a plain argv the privileged gate accepts: no env prefix, no shell", () => {
  for (const m of ["apt-get", "dnf", "yum", "zypper", "pacman", "apk", "xbps-install"] as const) {
    for (const step of installSteps(m, ["tmux"])) {
      assert.ok(!step.some((w) => /[=;&|$`<>]/.test(w) || w === "sh"), `${m}: ${step.join(" ")}`);
      assert.notEqual(step[0], "sudo");
    }
  }
});

test("every package says why, and has a package on apt and dnf where it applies", () => {
  for (const p of SYSTEM_PACKAGES) {
    assert.ok(p.why.length > 10, p.id);
    assert.ok(p.names["apt-get"]?.length, `${p.id}: no apt package`);
    assert.ok(p.names.dnf?.length, `${p.id}: no dnf package`);
  }
});
