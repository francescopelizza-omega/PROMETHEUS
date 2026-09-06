/**
 * model-server.test.ts — the control surface for a local model server.
 *
 * NOTHING here touches a real runner. The user has a live model serving right now and the whole
 * point of these functions is that they can stop it; a test that reached the real port would be
 * the single most destructive thing in this suite. Every probe takes an injected `fetch`, and the
 * signal tests use pids that provably cannot be a model server.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ModelServerStatus,
  modelServerStatus,
  parseLsofFields,
  probeModels,
  signalPid,
} from "./model-server.js";

/* ── lsof parsing ────────────────────────────────────────────────────────────*/

test("parses lsof field output into pid + command", () => {
  const out = "p4242\ncollama\nfcwd\np4242\ncollama\n";
  assert.deepEqual(parseLsofFields(out), [{ pid: 4242, command: "ollama" }]);
});

test("a command containing SPACES survives", () => {
  // This is why the `-F pc` field format is used instead of the default table: the default
  // truncates COMMAND and separates columns by whitespace, so "LM Studio Helper" cannot be
  // recovered from it at all.
  assert.deepEqual(parseLsofFields("p900\ncLM Studio Helper\n"), [
    { pid: 900, command: "LM Studio Helper" },
  ]);
});

test("several distinct listeners are all reported", () => {
  const got = parseLsofFields("p1\nca\np2\ncb\np2\ncb\n");
  assert.deepEqual(got, [
    { pid: 1, command: "a" },
    { pid: 2, command: "b" },
  ]);
});

test("empty / malformed output is an empty list, never a throw", () => {
  assert.deepEqual(parseLsofFields(""), []);
  assert.deepEqual(parseLsofFields("garbage\nc-with-no-pid\n"), []);
  assert.deepEqual(parseLsofFields("pnotanumber\ncx\n"), []);
});

/* ── health probe ────────────────────────────────────────────────────────────*/

const okFetch = (models: string[]): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

test("a 200 with models is healthy", async () => {
  const r = await probeModels("http://127.0.0.1:11434/v1", {
    fetchFn: okFetch(["qwen3.6:latest", "gemma4:12b"]),
  });
  assert.deepEqual(r, { ok: true, models: ["qwen3.6:latest", "gemma4:12b"] });
});

test("a non-200 is NOT healthy", async () => {
  const r = await probeModels("http://127.0.0.1:11434/v1", {
    fetchFn: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
  });
  assert.deepEqual(r, { ok: false, models: [] });
});

test("a refused connection is not healthy and does not throw", async () => {
  const r = await probeModels("http://127.0.0.1:11434/v1", {
    fetchFn: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(r, { ok: false, models: [] });
});

test("a trailing slash on the base URL does not produce //models", async () => {
  const seen: string[] = [];
  await probeModels("http://127.0.0.1:11434/v1/", {
    fetchFn: (async (u: string) => {
      seen.push(String(u));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(seen, ["http://127.0.0.1:11434/v1/models"]);
});

/* ── the two-axis status ─────────────────────────────────────────────────────*/

test("LISTENING and HEALTHY are separate answers", async () => {
  /**
   * The whole reason the force-kill exists. A wedged runner holds the port and answers nothing:
   * collapsing these two booleans into one "running" would render that state as "stopped", and
   * the user would press Start, watch it fail to bind, and have no way to see why.
   *
   * Port 1 cannot have a listener a user process could reach, so `listening` is false here while
   * the injected probe reports healthy — the inverse pairing, which proves the two axes are read
   * independently rather than derived from each other.
   */
  const s: ModelServerStatus = await modelServerStatus(
    { id: "ollama", port: 1, baseUrl: "http://127.0.0.1:11434/v1" },
    { fetchFn: okFetch(["m"]) },
  );
  assert.equal(s.healthy, true);
  assert.equal(s.listening, false);
  assert.deepEqual(s.models, ["m"]);
  assert.equal(s.runnerId, "ollama");
});

test("an unreachable runner reports no models rather than stale ones", async () => {
  const s = await modelServerStatus(
    { id: "ollama", port: 1, baseUrl: "http://127.0.0.1:11434/v1" },
    {
      fetchFn: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(s.healthy, false);
  assert.deepEqual(s.models, []);
});

/* ── signals ─────────────────────────────────────────────────────────────────*/

test("signalling a pid that is already gone is SUCCESS, not an error", () => {
  // The caller's goal is "this process is not running". If it already is not, that goal is met —
  // reporting a failure would make the panel show an error for the outcome the user wanted.
  const r = signalPid(0x7ffffffe, "SIGTERM");
  assert.equal(r.ok, true);
});

test("a permission failure is reported in words a user can act on", () => {
  // pid 1 is launchd/init: alive, and not ours to signal. It is refused by the pid guard before
  // the syscall, so the user still gets a sentence they can act on rather than an EPERM code.
  const r = signalPid(1, "SIGTERM");
  assert.equal(r.ok, false);
  assert.match(
    r.error ?? "",
    /another user|Prometheus cannot signal it|not permitted|not a single process/i,
  );
});

test("signalPid REFUSES the kill(2) broadcast pids instead of delivering them", () => {
  // THIS TEST USED TO CAUSE THE OUTAGE IT NOW GUARDS AGAINST. It called signalPid(-1, "SIGKILL")
  // for real to assert the function "never throws" — and `kill(-1, SIGKILL)` means "every process
  // this user owns", so each run killed the whole logged-in session (64-211 processes, four times
  // over 2026-09-05/06) including the terminal that would have reported it. `0` is the same
  // hazard one iteration later: it is the caller's own process group.
  //
  // The assertion is now that these never reach `process.kill` at all. Keep it that way: an
  // assertion that merely tolerates the outcome cannot tell "refused" from "delivered".
  for (const pid of [-1, 0, 1, -42, Number.NaN, 1.5]) {
    const r = signalPid(pid as number, "SIGKILL");
    assert.equal(r.ok, false, `pid ${pid} must be refused, not signalled`);
    assert.match(r.error ?? "", /not a single process/);
  }
});

test("signalPid never throws on a valid-but-unreachable pid", () => {
  // The original intent of the deleted loop, kept — with pids that are genuinely individual
  // processes, so exercising it cannot take the machine down.
  for (const pid of [2 ** 40, 0x7ffffffe]) {
    const r = signalPid(pid, "SIGKILL");
    assert.equal(typeof r.ok, "boolean");
  }
});
