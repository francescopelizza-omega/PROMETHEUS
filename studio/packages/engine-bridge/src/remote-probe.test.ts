/**
 * remote-probe.test.ts — the probe script and its parser.
 *
 * The script fixture in the first test is the REAL output of running `REMOTE_PROBE_SCRIPT`
 * through `sh` on this machine. It is here because a probe that has only been reasoned about is
 * a probe that has not been tested: the first run of it produced `PROM_LOADAVG=8,727,556,07`,
 * three load figures in a comma-decimal locale glued into one nonsense number by a `tr -d ' '`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REMOTE_PROBE_SCRIPT,
  parseNvidiaRow,
  parseRemoteProbe,
  usableMemoryBytes,
} from "./remote-probe.js";

const GIB = 1024 * 1024 * 1024;

/**
 * Verbatim stdout from running the script under `sh` on this Mac — with ONE substitution:
 * `PROM_HOSTNAME` carries the placeholder below instead of the machine's real hostname.
 *
 * That line is the only field of a probe that identifies a MACHINE rather than describing
 * one, and `scripts/check-personal-data.sh` greps tracked files for exactly this host's name.
 * Pasting a real probe in here therefore armed the pre-push hook against the whole repo: the
 * push was refused, the auto-committer had already committed, and every later run stacked
 * another commit that could not land. A fixture never needed the real name — nothing here
 * asserts on it beyond the fact that it parses — so it does not get one.
 *
 * Keep it synthetic. If you re-capture this block from a live run, scrub this field again.
 */
const PROBE_HOSTNAME = "prom-probe-host";
const REAL_DARWIN = `PROM_OK=1
PROM_UNAME=Darwin
PROM_ARCH=arm64
PROM_KERNEL=27.0.0
PROM_HOSTNAME=${PROBE_HOSTNAME}
PROM_MEM_TOTAL=68719476736
PROM_MEM_FREE_PCT=83
PROM_MEM_PRESSURE=1
PROM_CPU_MODEL=Apple M3 Max
PROM_CPU_CORES=16
PROM_GPU_UNIFIED=1
PROM_LOADAVG=7,77 7,40 6,04
PROM_DISK_FREE=775963033600
PROM_OLLAMA=1
PROM_OLLAMA_VERSION=ollama version is 0.34.1
PROM_END=1`;

test("ANCHOR: the real darwin output parses into the real machine", () => {
  const hw = parseRemoteProbe(REAL_DARWIN);
  assert.equal(hw.os, "Darwin");
  assert.equal(hw.arch, "arm64");
  assert.equal(hw.cpuModel, "Apple M3 Max");
  assert.equal(hw.cpuCores, 16);
  // Pinned so the placeholder stays load-bearing: a later "restore the real capture" would
  // have to break this line rather than quietly re-publish the machine's name.
  assert.equal(hw.hostname, PROBE_HOSTNAME);
  assert.equal(hw.memTotalBytes, 64 * GIB);
  // macOS reports a PERCENTAGE free, from `kern.memorystatus_level` — the same metric the local
  // probe and both watchdogs use, so the two machines are judged by one number.
  assert.equal(hw.memAvailableBytes, Math.round(64 * GIB * 0.83));
  assert.equal(hw.memPressureLevel, 1);
  assert.equal(hw.unifiedMemory, true);
  assert.equal(hw.ollamaInstalled, true);
  assert.match(hw.ollamaVersion ?? "", /0\.34\.1/);
  // The load average survives a comma-decimal locale as three numbers, not one glued one.
  assert.equal(hw.loadAverage, "7,77 7,40 6,04");
  assert.deepEqual(hw.unparsed, []);
});

test("a login shell's banner, MOTD and warnings are ignored", () => {
  // The `PROM_` prefix exists precisely for this: a shared GPU box almost always prints
  // something before the script's own output, and none of it may be read as a value.
  const noisy = `Welcome to gpu-box!
Last login: Tue Sep 23 09:14:02 2026 from 192.168.1.4
bash: warning: setlocale: LC_ALL: cannot change locale
${REAL_DARWIN}
You have new mail.`;
  const hw = parseRemoteProbe(noisy);
  assert.equal(hw.cpuModel, "Apple M3 Max");
  assert.equal(hw.memTotalBytes, 64 * GIB);
  assert.deepEqual(hw.unparsed, []);
});

test("a linux box with an nvidia card reports VRAM, and VRAM is the budget", () => {
  const hw = parseRemoteProbe(`PROM_OK=1
PROM_UNAME=Linux
PROM_ARCH=x86_64
PROM_MEM_TOTAL=137438953472
PROM_MEM_AVAILABLE=128849018880
PROM_CPU_MODEL=AMD Ryzen 9 7950X
PROM_CPU_CORES=32
PROM_NVIDIA=NVIDIA GeForce RTX 4090, 24564, 1024, 23540
PROM_OLLAMA=1
PROM_END=1`);
  assert.equal(hw.gpus.length, 1);
  assert.equal(hw.gpus[0]?.name, "NVIDIA GeForce RTX 4090");
  assert.equal(hw.gpus[0]?.totalBytes, 24564 * 1024 * 1024);
  assert.equal(hw.gpus[0]?.freeBytes, 23540 * 1024 * 1024);

  // 128 GiB of system RAM is irrelevant: a 24 GB card cannot hold a 30 GB model however much
  // DDR sits behind it, and calling that "it fits" would be a lie told in the user's favour.
  const { bytes, basis } = usableMemoryBytes(hw);
  assert.equal(basis, "vram");
  assert.equal(bytes, 23540 * 1024 * 1024);
});

test("two cards are summed", () => {
  const hw = parseRemoteProbe(`PROM_OK=1
PROM_NVIDIA=NVIDIA A100, 81920, 0, 81920
PROM_NVIDIA=NVIDIA A100, 81920, 0, 81920
PROM_END=1`);
  assert.equal(hw.gpus.length, 2);
  assert.equal(usableMemoryBytes(hw).bytes, 2 * 81920 * 1024 * 1024);
});

test("a card with no free figure falls back to its total", () => {
  const hw = parseRemoteProbe("PROM_OK=1\nPROM_NVIDIA=NVIDIA T4, 16384\nPROM_END=1");
  const { bytes, basis } = usableMemoryBytes(hw);
  assert.equal(basis, "vram");
  assert.equal(bytes, 16384 * 1024 * 1024);
});

test("unified memory means system RAM IS the GPU budget", () => {
  const hw = parseRemoteProbe(REAL_DARWIN);
  const { basis, bytes } = usableMemoryBytes(hw);
  assert.equal(basis, "system");
  assert.equal(bytes, hw.memAvailableBytes);
});

test("a machine that reported nothing usable says so rather than guessing zero-is-fine", () => {
  const hw = parseRemoteProbe("PROM_OK=1\nPROM_UNAME=Linux\nPROM_END=1");
  assert.equal(usableMemoryBytes(hw).basis, "unknown");
  assert.equal(usableMemoryBytes(hw).bytes, 0);
});

test("truncated output is flagged, not silently accepted", () => {
  // An ssh connection that died mid-probe would otherwise look like a machine with no memory.
  const hw = parseRemoteProbe("PROM_UNAME=Linux\nPROM_MEM_TOTAL=100");
  assert.ok(hw.unparsed.some((u) => /PROM_OK/.test(u)));
});

test("an unrecognised PROM_ key is kept rather than dropped", () => {
  // A newer probe talking to an older parser should surface what it did not understand, not
  // pretend the machine never said it.
  const hw = parseRemoteProbe("PROM_OK=1\nPROM_MEM_TOTAL=100\nPROM_FUTURE_THING=42\nPROM_END=1");
  assert.deepEqual(hw.unparsed, ["PROM_FUTURE_THING=42"]);
});

test("nvidia rows parse, and junk does not", () => {
  assert.deepEqual(parseNvidiaRow("NVIDIA RTX 4090, 24564, 1024, 23540"), {
    name: "NVIDIA RTX 4090",
    totalBytes: 24564 * 1024 * 1024,
    usedBytes: 1024 * 1024 * 1024,
    freeBytes: 23540 * 1024 * 1024,
  });
  assert.equal(parseNvidiaRow(""), null);
  assert.deepEqual(parseNvidiaRow("Some Card"), { name: "Some Card" });
});

/* ── the script itself ──────────────────────────────────────────────────────────────────────*/

test("the probe script is a CONSTANT with no interpolation seam", () => {
  // It is handed to the remote login SHELL, which will interpret it. Nothing derived from a
  // model's output, a path or a host may ever reach it — so it takes no arguments and reads no
  // input, and this test is what stops that changing quietly.
  // The script is built by joining string LITERALS. A `${` would mean a caller's value can
  // reach a string the remote shell interprets, which is the one thing that must never be true.
  assert.ok(!/\$\{/.test(REMOTE_PROBE_SCRIPT), "no template interpolation");
  // `$@` and `$*` are unambiguous shell positionals. (`$2` is not checked: it appears inside an
  // awk program, where it means a FIELD, and awk is the right tool for /proc/meminfo.)
  assert.ok(!/\$@|\$\*/.test(REMOTE_PROBE_SCRIPT), "no positional arguments");
});

test("the probe script is read-only — nothing it runs can write or install", () => {
  for (const forbidden of [
    /\brm\b/,
    /\bmv\b/,
    /\bmkdir\b/,
    /\bapt\b/,
    /\bbrew\b/,
    /\bcurl\b/,
    /\bwget\b/,
    /\bchmod\b/,
  ]) {
    assert.ok(!forbidden.test(REMOTE_PROBE_SCRIPT), `script must not contain ${forbidden}`);
  }
  // No redirect to a real path. `2>/dev/null` is not a write — it is how every command here is
  // kept from failing the probe over a missing tool — so it is the one form allowed.
  const writes = REMOTE_PROBE_SCRIPT.split("\n").filter((l) =>
    />\s*\/(?!dev\/null)/.test(l.replace(/2>\/dev\/null/g, "")),
  );
  assert.deepEqual(writes, [], "the probe must not write anywhere on the remote machine");
});

test("every probe command is guarded, so a missing tool is not a failed probe", () => {
  // A box without nvidia-smi is the common case, not an error. A probe that exited non-zero
  // over a missing GPU tool would report a healthy machine as unreachable.
  const lines = REMOTE_PROBE_SCRIPT.split("\n").filter((l) => /\$\(/.test(l));
  for (const l of lines) {
    assert.ok(/2>\/dev\/null/.test(l) || /\|\|/.test(l), `unguarded command substitution: ${l}`);
  }
});
