/**
 * remote-hosts.test.ts — a GPU box you own is not a cloud provider, but it is not free either.
 *
 * The property that matters most here is DEFAULT DENY: nothing is trusted because of what its
 * IP looks like. "It is on 192.168/16 so it must be mine" is the assumption that makes a
 * coffee-shop network dangerous.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type RemoteHost,
  findRemoteHost,
  hostOf,
  isDeclaredRemoteHost,
  isPrivateAddress,
  localityWithRemotes,
  normalizeHost,
  warnings,
} from "./remote-hosts.js";

const gpuBox: RemoteHost = {
  host: "gpu-box.lan",
  baseUrl: "http://gpu-box.lan:11434/v1",
  totalMemoryBytes: 128 * 1024 ** 3,
};

test("DEFAULT DENY: a private address is NOT trusted just for being private", () => {
  for (const url of [
    "http://192.168.1.50:11434/v1",
    "http://10.0.0.7:11434",
    "http://gpu-box.lan:11434",
  ]) {
    assert.equal(localityWithRemotes(url), "cloud", url);
    assert.equal(isDeclaredRemoteHost(url, []), false, url);
  }
});

test("a DECLARED host resolves to local for the egress decision", () => {
  assert.equal(localityWithRemotes("http://gpu-box.lan:11434/v1", [gpuBox]), "local");
  assert.equal(isDeclaredRemoteHost("http://gpu-box.lan:11434/v1", [gpuBox]), true);
  // a different host on the same network is still not declared
  assert.equal(localityWithRemotes("http://other.lan:11434", [gpuBox]), "cloud");
});

test("the historical behaviour is untouched for everyone who never uses this", () => {
  // loopback in every spelling stays local…
  for (const url of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:11434",
    "http://127.1.2.3:11434",
    "http://[::1]:11434",
    "unix:/var/run/x.sock",
    "http://mac-studio.local:11434",
  ]) {
    assert.equal(localityWithRemotes(url), "local", url);
  }
  // …and a real provider stays cloud, declared hosts or not.
  assert.equal(localityWithRemotes("https://api.anthropic.com", [gpuBox]), "cloud");
  assert.equal(localityWithRemotes("not a url"), "cloud", "an unparseable URL fails closed");
});

test("host matching ignores case, port, brackets and a trailing dot", () => {
  assert.equal(normalizeHost("  GPU-Box.LAN.  "), "gpu-box.lan");
  assert.equal(normalizeHost("[::1]"), "::1");
  assert.equal(normalizeHost("host:11434"), "host");
  assert.equal(hostOf("http://GPU-BOX.lan:11434/v1"), "gpu-box.lan");
  assert.equal(hostOf("nonsense"), null);
  assert.equal(
    isDeclaredRemoteHost("http://GPU-BOX.LAN:9999", [gpuBox]),
    true,
    "port is not identity",
  );
});

test("the declared record is retrievable, so its memory size can be used", () => {
  const found = findRemoteHost("http://gpu-box.lan:11434/v1", [gpuBox]);
  assert.equal(found?.totalMemoryBytes, 128 * 1024 ** 3);
  assert.equal(findRemoteHost("http://nope.lan", [gpuBox]), undefined);
});

test("warnings state facts the user needs BEFORE declaring a host", () => {
  const w = warnings({ host: "gpu-box.lan", baseUrl: "http://gpu-box.lan:11434/v1" });
  assert.ok(
    w.some((x) => /plain text/.test(x)),
    "http is not private",
  );
  assert.ok(
    w.some((x) => /no memory size declared/.test(x)),
    "and we cannot size it",
  );
  // declaring the size removes that one
  const sized = warnings(gpuBox);
  assert.ok(!sized.some((x) => /no memory size declared/.test(x)));
  // a public address over http earns the stronger warning
  const public_ = warnings({ host: "203.0.113.5", baseUrl: "http://203.0.113.5:11434" });
  assert.ok(public_.some((x) => /may leave your network/.test(x)));
  // https to a private box: no transport warning at all
  const tls = warnings({
    host: "gpu-box.lan",
    baseUrl: "https://gpu-box.lan:11434",
    totalMemoryBytes: 1,
  });
  assert.deepEqual(tls, []);
  assert.deepEqual(warnings({ host: "x", baseUrl: "%%%" }), ["%%% is not a valid URL"]);
});

test("isPrivateAddress is for PHRASING a warning, never for granting trust", () => {
  assert.equal(isPrivateAddress("192.168.1.1"), true);
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("172.32.0.1"), false, "172.32 is outside the private range");
  assert.equal(isPrivateAddress("fd00::1"), true);
  assert.equal(isPrivateAddress("box.lan"), true);
  assert.equal(isPrivateAddress("api.openai.com"), false);
  // the load-bearing assertion: being private grants nothing on its own
  assert.equal(localityWithRemotes("http://192.168.1.1:11434"), "cloud");
});
