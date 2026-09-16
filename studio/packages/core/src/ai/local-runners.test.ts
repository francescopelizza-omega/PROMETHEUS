/**
 * local-runners.test.ts — the shared local-runner registry (LOCAL_RUNNERS + its lookups).
 *
 * PURE DATA — no fetch, no spawn, so every case here is a plain assertion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_RUNNERS,
  isLocalUrl,
  portOf,
  runnerById,
  runnerForBaseUrl,
} from "./local-runners.js";

/* ── LOCAL_RUNNERS itself ────────────────────────────────────────────────── */

test("LOCAL_RUNNERS has exactly ollama and lmstudio, each with a distinct port", () => {
  const ids = LOCAL_RUNNERS.map((r) => r.id).sort();
  assert.deepEqual(ids, ["lmstudio", "ollama"]);
  const ports = new Set(LOCAL_RUNNERS.map((r) => r.port));
  assert.equal(ports.size, LOCAL_RUNNERS.length, "every runner must own a distinct port");
});

test("both ollama and lmstudio have a start command — each can be autostarted headlessly", () => {
  const ollama = LOCAL_RUNNERS.find((r) => r.id === "ollama");
  const lmstudio = LOCAL_RUNNERS.find((r) => r.id === "lmstudio");
  assert.deepEqual(ollama?.start, ["ollama", "serve"]);
  assert.deepEqual(lmstudio?.start, ["lms", "server", "start", "--port", "1234"]);
});

test("only lmstudio has a dedicated stop command — its server runs INSIDE the app process, so a raw signal would quit the whole app, not just the server", () => {
  const ollama = LOCAL_RUNNERS.find((r) => r.id === "ollama");
  const lmstudio = LOCAL_RUNNERS.find((r) => r.id === "lmstudio");
  assert.equal(ollama?.stop, undefined, "ollama serve has no stop subcommand — signalling the daemon directly IS correct for it");
  assert.deepEqual(lmstudio?.stop, ["lms", "server", "stop"]);
});

/* ── runnerById ──────────────────────────────────────────────────────────── */

test("runnerById finds a known id", () => {
  assert.equal(runnerById("ollama")?.name, "Ollama");
});

test("runnerById returns undefined for an unknown id", () => {
  assert.equal(runnerById("vllm"), undefined);
});

/* ── portOf ──────────────────────────────────────────────────────────────── */

test("portOf reads an explicit port", () => {
  assert.equal(portOf("http://localhost:11434/v1"), 11434);
});

test("portOf defaults by scheme when none is given", () => {
  assert.equal(portOf("http://example.com/v1"), 80);
  assert.equal(portOf("https://example.com/v1"), 443);
});

test("portOf returns undefined for an unparsable URL rather than guessing", () => {
  assert.equal(portOf("not a url"), undefined);
});

/* ── runnerForBaseUrl ────────────────────────────────────────────────────── */

test("runnerForBaseUrl matches by port, ignoring path", () => {
  assert.equal(runnerForBaseUrl("http://localhost:11434/v1")?.id, "ollama");
  assert.equal(runnerForBaseUrl("http://localhost:1234/v1")?.id, "lmstudio");
});

test("runnerForBaseUrl refuses a REMOTE host on a runner's port — never spawn a local server for it", () => {
  // The whole point: `ensureLocalRunnerRunning` probes and spawns against localhost, so matching
  // on the port alone started `ollama serve` on this laptop for a request bound for another host.
  assert.equal(runnerForBaseUrl("http://gpu-box.lan:11434/v1"), undefined);
  assert.equal(runnerForBaseUrl("http://192.168.1.5:11434/v1"), undefined);
  // `*.local` mDNS names matter specifically: the desktop's own localityOfUrl calls them "local".
  assert.equal(runnerForBaseUrl("http://gpu-box.local:1234/v1"), undefined);
  // loopback in every spelling still matches.
  assert.equal(runnerForBaseUrl("http://127.0.0.1:11434/v1")?.id, "ollama");
  assert.equal(runnerForBaseUrl("http://[::1]:1234/v1")?.id, "lmstudio");
});

test("runnerForBaseUrl returns undefined for a port no runner owns", () => {
  assert.equal(runnerForBaseUrl("http://localhost:9999/v1"), undefined);
});

/* ── isLocalUrl ──────────────────────────────────────────────────────────── */

test("isLocalUrl accepts localhost, 127.0.0.1, ::1 and 0.0.0.0", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]) {
    assert.equal(isLocalUrl(`http://${host}:11434/v1`), true, host);
  }
});

test("isLocalUrl rejects a remote host", () => {
  assert.equal(isLocalUrl("https://api.anthropic.com/v1"), false);
});

test("isLocalUrl returns false for an unparsable URL rather than throwing", () => {
  assert.equal(isLocalUrl("not a url"), false);
});
