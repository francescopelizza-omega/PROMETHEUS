/**
 * ssh.test.ts — the parts of the SSH driver that can be checked without a second machine.
 *
 * The stderr fixtures are REAL: captured by running the generated argv against this machine's
 * own sshd on 2026-09-25. That is how the first bug in `explainSshFailure` was found — an
 * unknown host and a changed host key both end in "Host key verification failed", and matching
 * that line first told the user their machine might have been replaced by an impostor when they
 * had simply never connected to it before.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";

import { controlPathFor, explainSshFailure, freeLocalPort, waitForPort } from "./ssh.js";

/* ── explaining what ssh means by 255 ───────────────────────────────────────────────────────*/

test("an UNKNOWN host is not reported as a changed key", () => {
  // Verbatim from `ssh -o StrictHostKeyChecking=yes -- 127.0.0.1 true` on a machine that had
  // never connected to itself.
  const real =
    "No ED25519 host key is known for 127.0.0.1 and you have requested strict checking.\r\nHost key verification failed.\r\n";
  const msg = explainSshFailure(255, real);
  assert.match(msg, /not in your known_hosts yet/);
  assert.doesNotMatch(
    msg,
    /changed/i,
    "a first connection is not an attack, and must not read as one",
  );
  assert.doesNotMatch(msg, /reinstalled/i);
});

test("a CHANGED host key IS reported loudly — this is the case the check exists for", () => {
  const real =
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n";
  const msg = explainSshFailure(255, real);
  assert.match(msg, /CHANGED/);
  assert.match(msg, /Nothing was sent/);
});

test("BatchMode's silent refusal is explained as what it is", () => {
  const msg = explainSshFailure(255, "phoenix@gpu-box.lan: Permission denied (publickey).\n");
  // Without this the user sees "permission denied" and reaches for a password, which BatchMode
  // will never prompt for — so the message has to name the actual remedy.
  assert.match(msg, /BatchMode/);
  assert.match(msg, /agent|--identity/);
});

test("the ordinary network failures each get their own sentence", () => {
  assert.match(
    explainSshFailure(255, "ssh: connect to host x port 22: Connection timed out"),
    /off, asleep, or behind a firewall/,
  );
  assert.match(
    explainSshFailure(255, "ssh: connect to host x port 22: Connection refused"),
    /nothing is listening/i,
  );
  assert.match(
    explainSshFailure(255, "ssh: Could not resolve hostname zzz: nodename nor servname provided"),
    /does not resolve/,
  );
  assert.match(
    explainSshFailure(255, "bind [127.0.0.1]:45000: Address already in use"),
    /local port .* already taken/,
  );
});

test("a missing ssh binary is named as an environment problem, not a host problem", () => {
  assert.match(explainSshFailure(127, "spawn failed"), /openssh/i);
});

test("an unrecognised failure surfaces ssh's own first line rather than inventing one", () => {
  const msg = explainSshFailure(255, "some future openssh error\nand a second line\n");
  assert.equal(msg, "some future openssh error");
});

test("an empty stderr still yields something actionable", () => {
  assert.match(explainSshFailure(3, ""), /exited 3/);
});

/* ── the multiplexing socket ────────────────────────────────────────────────────────────────*/

test("the control path is short, because a unix socket path has a hard length limit", () => {
  const p = controlPathFor({
    host: "a-very-long-hostname-in-some-department.corp.example.com",
    user: "a-long-user-name",
    port: 2222,
  });
  // The limit is ~104 bytes on macOS, and the failure mode is an opaque "unix_listener: path
  // too long" — so the host name is hashed rather than embedded.
  assert.ok(p.length < 100, `control path too long: ${p.length}`);
  assert.ok(!p.includes("a-very-long-hostname"), "the name must not be embedded");
});

test("different targets get different sockets, the same target the same one", () => {
  const a = controlPathFor({ host: "box.lan", user: "me", port: 22 });
  const b = controlPathFor({ host: "box.lan", user: "me", port: 22 });
  const c = controlPathFor({ host: "box.lan", user: "other", port: 22 });
  const d = controlPathFor({ host: "box.lan", user: "me", port: 2222 });
  assert.equal(a, b, "the same target must reuse one connection");
  assert.notEqual(a, c, "a different user is a different connection");
  assert.notEqual(a, d, "so is a different port");
});

/* ── port handling ──────────────────────────────────────────────────────────────────────────*/

test("freeLocalPort returns a port the kernel says is free", async () => {
  const p = await freeLocalPort();
  assert.ok(Number.isInteger(p) && p > 1024 && p < 65536, `implausible port ${p}`);
  const q = await freeLocalPort();
  assert.notEqual(p, q, "two asks should not hand out the same port back to back");
});

test("waitForPort resolves true once something listens", async () => {
  const port = await freeLocalPort();
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  try {
    assert.equal(await waitForPort(port, 3000, () => false), true);
  } finally {
    srv.close();
  }
});

test("waitForPort gives up immediately when ssh has already died", async () => {
  const port = await freeLocalPort();
  const started = Date.now();
  // The `died` callback is what stops a refused connection costing the whole timeout — a
  // tunnel whose ssh exited is never going to bind, and waiting 8 s to say so is a stall.
  assert.equal(await waitForPort(port, 8000, () => true), false);
  assert.ok(Date.now() - started < 1000, "must not wait out the deadline");
});

test("waitForPort times out on a port nobody will ever open", async () => {
  const port = await freeLocalPort();
  assert.equal(await waitForPort(port, 400, () => false), false);
});
