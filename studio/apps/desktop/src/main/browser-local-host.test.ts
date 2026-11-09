// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { test } from "node:test";

import { isLocalHost } from "./browser-local-host.js";

test("loopback, private, link-local and local names are local", () => {
  for (const h of [
    "localhost",
    "api.localhost",
    "printer.local",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "[::1]",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isLocalHost(h), true, h);
  }
});

test("public hosts are not", () => {
  for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "2001:4860:4860::8888", "ollama.com"]) {
    assert.equal(isLocalHost(h), false, h);
  }
});
