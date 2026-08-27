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
import { runSessions, shortSessionId } from "./sessions-cmd.js";

setColorEnabled(false);

function ctxFor(
  command: string[],
  positionals: string[] = [],
  flags: Record<string, string | true> = {},
  json = false,
  unmatchedSub?: string,
): CliContext {
  return {
    client: undefined as unknown as CliContext["client"],
    json,
    args: { command, positionals, flags, json, unmatchedSub } as unknown as ParsedArgs,
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

test("prometheus sessions <typo>: reports unknown verb, never silently defaults to list", () => {
  // regression: command[1] is undefined for a TWO_WORD mismatch (parse.ts sets `unmatchedSub`
  // instead), so a typo used to silently fall through to the "list" branch.
  const home = seedHome();
  try {
    const out = runSessions(ctxFor(["sessions"], [], {}, true, "lst"), { home });
    assert.equal(out.exitCode, 1);
    assert.equal((out.json as { error: string }).error, "unknown-verb");
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

test("sessions: unknown verb → exit 1 listing valid verbs", () => {
  const out = runSessions(ctxFor(["sessions", "bogus"]), { home: "/tmp/nope" });
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /list, search, fork, delete/);
});

test("sessions delete --confirm <id> --dry-run: previews, the session survives", () => {
  // regression: this gate consults ONLY `--confirm`, so the preview guard inside `wantsExecute`
  // never applied. Measured against the built binary: the session list went from 1 to 0 under
  // `--dry-run`.
  const home = seedHome();
  try {
    const ctx = {
      client: undefined as unknown as CliContext["client"],
      json: true,
      args: {
        command: ["sessions", "delete"],
        positionals: ["aaa11111"],
        flags: { confirm: "aaa11111" },
        json: true,
        dryRun: true,
      } as unknown as ParsedArgs,
    } as CliContext;
    const out = runSessions(ctx, { home });
    assert.equal(out.exitCode, 0);
    assert.equal((out.json as { status?: string }).status, "preview");
    assert.equal(listSessions(home).length, 2, "the preview deleted a session");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("shortSessionId distinguishes headless sessions — `id.slice(0,8)` was the constant 'headless'", () => {
  // regression: every headless id starts `headless-`, so the list showed the SAME token on every
  // row — and the delete gate asked the user to type that token back as the confirmation, so the
  // confirm carried no information about which session was about to go.
  const a = shortSessionId("headless-mt8r29xw-3f2a91bc");
  const b = shortSessionId("headless-mt8r29xx-77d0e415");
  assert.notEqual(a, b, "two headless sessions still share a short id");
  assert.notEqual(a, "headless");
  assert.notEqual(b, "headless");
  // an unprefixed id keeps its old behaviour
  assert.equal(shortSessionId("abcdef0123456789"), "abcdef01");
  // a short tail is not a useful discriminator — fall back to the head
  assert.equal(shortSessionId("x-ab"), "x-ab");
});
