/**
 * sessions-cmd.test.ts — `prometheus sessions list/search/fork/delete` routing, exit
 * codes, --json envelopes, and the delete typed-confirm gate (CLI-014).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CliContext } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import { appendTurnEvents, listSessions, recordSession } from "../session/history-store.js";
import { runSessions } from "./sessions-cmd.js";

setColorEnabled(false);

function ctxFor(
  command: string[],
  positionals: string[] = [],
  flags: Record<string, string | true> = {},
  json = false,
): CliContext {
  return {
    client: undefined as unknown as CliContext["client"],
    json,
    args: { command, positionals, flags, json } as unknown as ParsedArgs,
  };
}

function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "prom-sess-"));
  recordSession(home, {
    id: "aaa11111",
    ts: "2026-06-26T10:00:00Z",
    descriptor: "build a parser",
    cwd: "/a",
  });
  appendTurnEvents(home, "aaa11111", [{ role: "user", text: "make it fast with rustc" }]);
  recordSession(home, {
    id: "bbb22222",
    ts: "2026-06-26T11:00:00Z",
    descriptor: "fix a bug",
    cwd: "/b",
  });
  return home;
}

test("sessions list: table + --json array", () => {
  const home = seedHome();
  try {
    const text = runSessions(ctxFor(["sessions", "list"]), { home });
    assert.equal(text.exitCode, 0);
    assert.match(text.text ?? "", /build a parser/);
    const j = runSessions(ctxFor(["sessions", "list"], [], {}, true), { home });
    assert.equal((j.json as { ok: boolean }).ok, true);
    assert.equal((j.json as { sessions: unknown[] }).sessions.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sessions search matches TRANSCRIPT text (not just descriptor)", () => {
  const home = seedHome();
  try {
    // "rustc" appears only in aaa's transcript, not in any descriptor
    const out = runSessions(ctxFor(["sessions", "search"], ["rustc"], {}, true), { home });
    const sessions = (out.json as { sessions: { id: string }[] }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, "aaa11111");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sessions fork: creates an independent copy", () => {
  const home = seedHome();
  try {
    const out = runSessions(ctxFor(["sessions", "fork"], ["aaa11111"], {}, true), { home });
    const newId = (out.json as { newId: string }).newId;
    assert.ok(newId && newId !== "aaa11111");
    assert.equal(listSessions(home).length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sessions delete: refuses without the typed short-id confirm, deletes with it", () => {
  const home = seedHome();
  try {
    // no --confirm → refused, nothing removed (exit 2)
    const refused = runSessions(ctxFor(["sessions", "delete"], ["aaa11111"]), { home });
    assert.equal(refused.exitCode, 2);
    assert.equal(listSessions(home).length, 2);
    // wrong confirm → still refused
    const wrong = runSessions(ctxFor(["sessions", "delete"], ["aaa11111"], { confirm: "nope" }), {
      home,
    });
    assert.equal(wrong.exitCode, 2);
    // correct short id → deleted
    const ok = runSessions(ctxFor(["sessions", "delete"], ["aaa11111"], { confirm: "aaa11111" }), {
      home,
    });
    assert.equal(ok.exitCode, 0);
    const ids = listSessions(home).map((r) => r.id);
    assert.deepEqual(ids, ["bbb22222"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sessions --json delete without a confirm exits 2 (fail-closed envelope)", () => {
  const home = seedHome();
  try {
    const out = runSessions(ctxFor(["sessions", "delete"], ["bbb22222"], {}, true), { home });
    assert.equal(out.exitCode, 2);
    assert.equal((out.json as { error: string }).error, "confirm-required");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sessions: unknown verb → exit 2 listing valid verbs", () => {
  const out = runSessions(ctxFor(["sessions", "bogus"]), { home: "/tmp/nope" });
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /list, search, fork, delete/);
});
