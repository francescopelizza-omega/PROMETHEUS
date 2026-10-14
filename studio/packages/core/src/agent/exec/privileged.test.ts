// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * privileged.test.ts — what counts as a privileged command, and what the gate may run.
 *
 * The classifier fails CLOSED: anything that could reach an elevator is privileged, and
 * anything privileged but not in the one canonical shape the gate runs carries a refusal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand } from "./classify.js";
import { parseCommand } from "./parse.js";
import { catastrophicTarget, classifyPrivileged } from "./privileged.js";

const PRIV_LINES = [
  // by name and by absolute path
  "sudo apt update",
  "/usr/bin/sudo apt update",
  "doas apk add curl",
  "pkexec visudo",
  "su -c 'id'",
  "run0 systemctl restart nginx",
  "machinectl shell root@",
  "sudoedit /etc/hosts",
  "gosu root id",
  "please id",
  // through wrappers
  "env FOO=1 sudo id",
  "env -i PATH=/usr/bin sudo id",
  "nice -n 5 sudo id",
  "nohup sudo id",
  "timeout 5 sudo id",
  "timeout -s KILL 5 sudo id",
  "xargs sudo rm",
  "xargs -n 1 sudo rm",
  "command sudo id",
  "exec sudo id",
  "time sudo id",
  "stdbuf -oL sudo id",
  "setsid sudo id",
  // inside a shell string
  'sh -c "sudo apt update"',
  "bash -lc 'sudo id'",
  "zsh -c 'cd /tmp && sudo id'",
  // chains and pipelines
  "make && sudo make install",
  "true; sudo id",
  "echo x | sudo tee /etc/motd",
  // scripts launched through an elevator
  "sudo ./script.sh",
  "sudo bash script.sh",
];

for (const line of PRIV_LINES) {
  test(`privileged: ${line}`, () => {
    assert.equal(classifyPrivileged(line).privileged, true);
  });
}

const PLAIN_LINES = [
  "grep sudo /etc/group",
  "echo sudo",
  "pseudo --version",
  "sudoku",
  "ls -la",
  "cat /etc/sudoers.d/README",
  "git commit -m 'please review'",
];

for (const line of PLAIN_LINES) {
  test(`not privileged: ${line}`, () => {
    assert.equal(classifyPrivileged(line).privileged, false);
  });
}

test("an unparsable line that still names an elevator is privileged (fail closed)", () => {
  for (const line of ["$(echo sudo) id", "`which sudo` id", "sudo 'unterminated", "$SUDO id"]) {
    const c = classifyPrivileged(line);
    assert.equal(c.privileged, true, line);
    assert.equal(c.ambiguous, true, line);
    assert.ok(c.refusal, line);
  }
});

test("an unparsable line with no elevator word is NOT privileged (the parser refuses it elsewhere)", () => {
  assert.equal(classifyPrivileged("$(echo c3Vkbw== | base64 -d) id").privileged, false);
});

test("an unknown program carrying an elevator word is privileged — it might launch it", () => {
  const c = classifyPrivileged(["./run-as", "sudo", "id"]);
  assert.equal(c.privileged, true);
  assert.ok(c.refusal);
});

test("canonical `sudo prog args` is runnable by the gate", () => {
  const c = classifyPrivileged("sudo apt-get install -y ripgrep");
  assert.equal(c.privileged, true);
  assert.equal(c.refusal, undefined);
  assert.deepEqual(c.canonical, {
    elevator: "sudo",
    argv: ["apt-get", "install", "-y", "ripgrep"],
  });
});

test("canonical accepts an explicit `--` after the elevator and absolute elevator paths", () => {
  const c = classifyPrivileged(["/usr/bin/sudo", "--", "ls", "/root"]);
  assert.deepEqual(c.canonical, { elevator: "sudo", argv: ["ls", "/root"] });
});

test("doas, pkexec and run0 are canonical too", () => {
  for (const e of ["doas", "pkexec", "run0"] as const) {
    const c = classifyPrivileged([e, "id"]);
    assert.equal(c.refusal, undefined, e);
    assert.deepEqual(c.canonical, { elevator: e, argv: ["id"] });
  }
});

test("a script under an elevator is canonical (the gate hashes it)", () => {
  assert.deepEqual(classifyPrivileged("sudo ./script.sh a b").canonical, {
    elevator: "sudo",
    argv: ["./script.sh", "a", "b"],
  });
  assert.deepEqual(classifyPrivileged("sudo bash script.sh").canonical, {
    elevator: "sudo",
    argv: ["bash", "script.sh"],
  });
});

const REFUSED = [
  "sudo -u bob id", // elevator options change WHO runs it
  "sudo -E id",
  "sudo -s",
  "sudo -i",
  "sudo", // nothing to run
  "su -c 'id'", // a shell string
  "sudo sh -c 'id; rm x'", // an inner shell string
  "sudo bash -c id",
  "sudo sudo id", // nested
  "sudo env FOO=1 id", // a launcher hides the real program
  "echo x | sudo tee /etc/motd", // part of a pipeline
  "make && sudo make install", // part of a chain
  "env FOO=1 sudo id", // wrapped
  "sh -c 'sudo id'",
  "machinectl shell root@",
  "sudoedit /etc/hosts", // interactive editor as root
  "gosu root id", // not an elevator the gate drives
  "please id",
];

for (const line of REFUSED) {
  test(`privileged but refused as written: ${line}`, () => {
    const c = classifyPrivileged(line);
    assert.equal(c.privileged, true);
    assert.ok(c.refusal, "carries a reason");
    assert.equal(c.canonical, undefined);
  });
}

test("the wrappers peeled on the way to an elevator are reported", () => {
  assert.deepEqual(classifyPrivileged("env FOO=1 nice -n 5 sudo id").via, ["env", "nice"]);
});

test("an elevator's basename family is caught (runas.exe, sudo.ws)", () => {
  assert.equal(classifyPrivileged(["runas.exe", "/user:Administrator", "cmd"]).privileged, true);
});

test("argv with a newline or control character is refused even when canonical-shaped", () => {
  assert.ok(classifyPrivileged(["sudo", "echo", "a\nb"]).refusal);
  assert.ok(classifyPrivileged(["sudo", "echo", "\u001b[2J"]).refusal);
});

/* ── catastrophic targets ─────────────────────────────────────────────────── */

const HOME = "/Users/someone";

test("catastrophic: recursive force delete of / ~ or a top-level system dir needs its target typed", () => {
  assert.equal(catastrophicTarget(["rm", "-rf", "/"], HOME), "/");
  assert.equal(catastrophicTarget(["rm", "-fr", "/*"], HOME), "/*");
  assert.equal(catastrophicTarget(["rm", "-r", "-f", HOME], HOME), HOME);
  assert.equal(catastrophicTarget(["rm", "--recursive", "--force", "~"], HOME), "~");
  assert.equal(catastrophicTarget(["rm", "-rf", "/etc"], HOME), "/etc");
  assert.equal(catastrophicTarget(["rm", "-rf", "/usr/"], HOME), "/usr/");
});

test("catastrophic: a deep path is not catastrophic", () => {
  assert.equal(catastrophicTarget(["rm", "-rf", "/var/cache/apt/archives"], HOME), null);
  assert.equal(catastrophicTarget(["rm", "-f", "/"], HOME), null); // not recursive
});

test("catastrophic: raw device writes and formats name the device", () => {
  assert.equal(
    catastrophicTarget(["dd", "if=x.img", "of=/dev/disk4", "bs=1m"], HOME),
    "/dev/disk4",
  );
  assert.equal(catastrophicTarget(["mkfs.ext4", "/dev/sdb1"], HOME), "/dev/sdb1");
  assert.equal(catastrophicTarget(["diskutil", "eraseDisk", "APFS", "X", "disk4"], HOME), "disk4");
  assert.equal(catastrophicTarget(["wipefs", "-a", "/dev/sdb"], HOME), "/dev/sdb");
});

test("catastrophic: anything touching sudoers asks for the word `sudoers`", () => {
  assert.equal(catastrophicTarget(["tee", "/etc/sudoers.d/x"], HOME), "sudoers");
  assert.equal(catastrophicTarget(["cp", "x", "/private/etc/sudoers"], HOME), "sudoers");
  assert.equal(catastrophicTarget(["visudo"], HOME), "sudoers");
});

test("catastrophic: ordinary admin work is not", () => {
  assert.equal(catastrophicTarget(["apt-get", "install", "-y", "ripgrep"], HOME), null);
  assert.equal(catastrophicTarget(["diskutil", "list"], HOME), null);
  // reading sudoers is not writing it
  assert.equal(catastrophicTarget(["cat", "/etc/sudoers"], HOME), null);
});

/* ── run_command never runs a privileged command ──────────────────────────── */

test("classifyCommand refuses every privileged command, naming propose_elevated", () => {
  // pkexec / run0 / gosu used to classify as UNKNOWN programs — tier `destructive`, which
  // A6 and A7 auto-approve. Only the kernel sandbox stood between them and root.
  for (const line of [
    "pkexec id",
    "run0 id",
    "gosu root id",
    "sudo id",
    "nice -n 5 sudo id",
    "./run-as sudo id",
  ]) {
    const p = parseCommand(line);
    assert.ok(p.ok, line);
    const r = classifyCommand(p.command);
    assert.equal(r.ok, false, line);
    assert.ok(!r.ok && r.privileged === true, line);
    assert.match(!r.ok ? r.error : "", /propose_elevated/, line);
  }
});

test("a canonical privileged command's refusal carries the exact propose_elevated argv", () => {
  const p = parseCommand("sudo apt-get install -y ripgrep");
  assert.ok(p.ok);
  const r = classifyCommand(p.command);
  assert.ok(!r.ok);
  assert.ok(!r.ok && r.error.includes('["apt-get","install","-y","ripgrep"]'));
});

test("the layer-6 screen backstop names every distinctive elevator, not only sudo", async () => {
  const { screenCommand } = await import("./screen.js");
  for (const line of ["doas id", "x; pkexec id", "run0 id", "sudo id"]) {
    assert.equal(screenCommand(line).blocked, true, line);
  }
  assert.equal(screenCommand("echo pseudocode").blocked, false);
});

test("an elevator inside ONE quoted argument of an unknown program still counts (fail closed)", () => {
  // `basename("sudo -n id")` is not `sudo`, so these used to classify as plain unknown
  // programs — tier `destructive`, auto-approved at A6/A7 — while sudo's timestamp from a
  // just-approved command could let `sudo -n` succeed without a password.
  for (const line of [
    "tmux new -d 'sudo -n id'",
    "screen -dm sh -c 'sudo id'",
    "vim -c ':!sudo -n id'",
    './runner "sudo apt update"',
    "tmux new -d 'x; pkexec id'",
  ]) {
    assert.equal(classifyPrivileged(line).privileged, true, line);
  }
  // a KNOWN program's arguments stay data
  assert.equal(classifyPrivileged('grep "sudo -n" /var/log/auth.log').privileged, false);
  assert.equal(classifyPrivileged('echo "run sudo later"').privileged, false);
});
