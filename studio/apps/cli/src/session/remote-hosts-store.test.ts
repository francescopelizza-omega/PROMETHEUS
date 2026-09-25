/**
 * remote-hosts-store.test.ts — parsing what the user typed, and surviving what they hand-edited.
 *
 * The allowlist is a security control, so the failure mode matters: a corrupt value must yield
 * an EMPTY list (costing access) rather than a partially-trusted one (costing safety).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseRemoteArgs,
  parseRemoteHosts,
  removeRemoteHost,
  upsertRemoteHost,
} from "./remote-hosts-store.js";

const GIB = 1024 ** 3;

test("a bare hostname becomes the ollama default URL — the user should not have to spell it", () => {
  const r = parseRemoteArgs("gpu-box.lan");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.host, "gpu-box.lan");
  assert.equal(r.entry.baseUrl, "http://gpu-box.lan:11434/v1");
  assert.equal(r.entry.totalMemoryBytes, undefined);
});

test("an explicit URL is kept verbatim, and --ram/--label are read", () => {
  const r = parseRemoteArgs("https://gpu.example.com:8443/v1 --ram 128 --label workshop");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.baseUrl, "https://gpu.example.com:8443/v1");
  assert.equal(r.entry.host, "gpu.example.com");
  assert.equal(r.entry.totalMemoryBytes, 128 * GIB);
  assert.equal(r.entry.label, "workshop");
});

test("bad arguments are refused with a usable message", () => {
  for (const [args, re] of [
    ["", /usage: \/remote add/],
    ["host --ram", /--ram needs a size/],
    ["host --ram -4", /--ram needs a size/],
    ["host --label", /--label needs a value/],
    ["host --wat", /unknown option --wat/],
    ["a.lan b.lan", /one URL at a time/],
  ] as const) {
    const r = parseRemoteArgs(args);
    assert.equal(r.ok, false, args);
    assert.match(r.ok === false ? r.error : "", re, args);
  }
});

test("a corrupt stored value yields an EMPTY list, never a partial one", () => {
  // Losing the allowlist costs access. Keeping half of a corrupt one could cost safety.
  assert.deepEqual(parseRemoteHosts("not json"), []);
  assert.deepEqual(parseRemoteHosts('{"host":"x"}'), [], "an object is not a list");
  assert.deepEqual(parseRemoteHosts(""), []);
  assert.deepEqual(parseRemoteHosts(undefined), []);
  assert.deepEqual(parseRemoteHosts(42), []);
});

test("rows missing host or baseUrl are dropped, not defaulted", () => {
  const rows = parseRemoteHosts(
    JSON.stringify([
      { host: "a.lan", baseUrl: "http://a.lan:11434" },
      { host: "b.lan" },
      { baseUrl: "http://c.lan" },
      { host: "  ", baseUrl: "http://d.lan" },
      { host: "E.LAN.", baseUrl: "http://e.lan:11434", totalMemoryBytes: 64 * 1024 ** 3 },
    ]),
  );
  assert.deepEqual(
    rows.map((r) => r.host),
    ["a.lan", "e.lan"],
    "and the name is normalised",
  );
  assert.equal(rows[1]?.totalMemoryBytes, 64 * 1024 ** 3);
});

test("a non-positive memory size is ignored rather than trusted", () => {
  const [row] = parseRemoteHosts(
    JSON.stringify([{ host: "a.lan", baseUrl: "http://a.lan", totalMemoryBytes: 0 }]),
  );
  assert.equal(row?.totalMemoryBytes, undefined, "0 bytes would refuse every model");
});

test("upsert replaces by normalised host, never duplicates", () => {
  const first = upsertRemoteHost({ host: "GPU-Box.LAN", baseUrl: "http://a" }, []);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.host, "gpu-box.lan");
  const second = upsertRemoteHost({ host: "gpu-box.lan", baseUrl: "http://b" }, first);
  assert.equal(second.length, 1, "same host ⇒ replaced");
  assert.equal(second[0]?.baseUrl, "http://b");
});

test("remove reports whether anything was actually removed", () => {
  const list = [{ host: "a.lan", baseUrl: "http://a" }];
  const hit = removeRemoteHost("A.LAN", list);
  assert.equal(hit.removed, true);
  assert.deepEqual(hit.hosts, []);
  const miss = removeRemoteHost("z.lan", list);
  assert.equal(miss.removed, false);
  assert.equal(miss.hosts.length, 1);
});
