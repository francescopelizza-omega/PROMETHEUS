// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates-panel.test.ts — the rules behind Settings ▸ Updates & Conflicts.
 *
 * The assertions that matter are about NOT MISREPRESENTING the machine: a failed version
 * lookup must never render as "up to date", a blocked repair must never offer its commands,
 * and a repair must appear once however many conflicts share it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { UpdateRemedyView, UpdateToolView } from "../../shared/ipc-contract.js";
import { headline, remedyCards, remedyClipboard, severityOf, toolRow } from "./updates-panel.js";

const remedy = (over: Partial<UpdateRemedyView> = {}): UpdateRemedyView => ({
  kind: "duplicate-install",
  subject: "claude",
  title: "Remove the redundant claude copy",
  rationale: "two installs, one shadows the other",
  steps: [
    {
      command: "brew uninstall --cask claude-code",
      purpose: "remove the redundant copy",
      risk: "low",
    },
  ],
  minAuthLevel: 4,
  permanent: true,
  ...over,
});

const tool = (over: Partial<UpdateToolView> = {}): UpdateToolView =>
  ({ id: "ollama", installed: true, updateAvailable: false, ...over }) as UpdateToolView;

/* ── remedies ─────────────────────────────────────────────────────────────── */

test("one card per SUBJECT — a shared fix is never offered three times", () => {
  // The same duplicate install surfaces as several conflicts sharing a single repair. Listing
  // it per-conflict invites running it repeatedly.
  const cards = remedyCards([
    remedy({ kind: "duplicate-install" }),
    remedy({ kind: "shadowed-upgrade" }),
    remedy({ kind: "shadowed-newer" }),
    remedy({ subject: "codex", title: "Fix codex" }),
  ]);
  assert.deepEqual(
    cards.map((c) => c.subject),
    ["claude", "codex"],
  );
});

test("a BLOCKED repair shows its reason and offers NO commands", () => {
  // The point of emitting a blocked remedy at all is that the user learns the obvious command
  // is a trap. Offering the steps anyway would defeat it.
  const cards = remedyCards([remedy({ blocked: "this would delete the install you are keeping" })]);
  assert.equal(cards[0]?.blocked, "this would delete the install you are keeping");
  assert.deepEqual(cards[0]?.commands, []);
  assert.equal(remedyClipboard(cards[0] as never), "", "nothing to copy for a blocked repair");
});

test("the clipboard payload is COMMANDS only — it is pasted into a shell", () => {
  const cards = remedyCards([
    remedy({
      steps: [
        { command: "brew uninstall --cask claude-code", purpose: "remove it", risk: "low" },
        { command: "hash -r", purpose: "forget the cached path", risk: "low" },
      ],
    }),
  ]);
  assert.equal(remedyClipboard(cards[0] as never), "brew uninstall --cask claude-code\nhash -r");
  assert.doesNotMatch(remedyClipboard(cards[0] as never), /remove it|\$ /);
});

test("undo and verify survive the projection — they are the reason a repair is safe to run", () => {
  const cards = remedyCards([
    remedy({
      steps: [{ command: "a", purpose: "p", risk: "low", undo: "undo-a" }],
      verify: "which -a claude",
      keeps: "the vendor install",
    }),
  ]);
  assert.deepEqual(cards[0]?.undos, ["undo-a"]);
  assert.equal(cards[0]?.verify, "which -a claude");
  assert.equal(cards[0]?.keeps, "the vendor install");
});

/* ── tool rows: the three-valued field ────────────────────────────────────── */

test("a FAILED version lookup is 'unknown', never 'current'", () => {
  // `updateAvailable: null` means nothing checked. Rendering that as up-to-date is the exact
  // misreport the report's three-valued field exists to prevent.
  assert.equal(toolRow(tool({ updateAvailable: null })).state, "unknown");
  assert.equal(toolRow(tool({ updateAvailable: false })).state, "current");
  assert.equal(toolRow(tool({ updateAvailable: true })).state, "update");
  assert.equal(toolRow(tool({ installed: false })).state, "absent");
});

test("a duplicate or shadowed install is surfaced — it is why an update may not apply", () => {
  assert.equal(toolRow(tool({ state: "duplicate" } as never)).install, "duplicate");
  assert.equal(toolRow(tool({ state: "shadowed" } as never)).install, "shadowed");
  assert.equal(toolRow(tool({ state: "single" } as never)).install, undefined);
});

/* ── severity + headline ──────────────────────────────────────────────────── */

test("a conflict outranks an available update", () => {
  const base = {
    ok: true,
    conflicts: [],
    tools: [],
    packages: [],
    unavailableManagers: [],
    models: [],
    remedies: [],
    neverRun: [],
    summary: "",
    self: { version: "1", updateAvailable: false, command: "", steps: [] },
  };
  assert.equal(severityOf({ ...base } as never), "none");
  assert.equal(severityOf({ ...base, tools: [tool({ updateAvailable: true })] } as never), "info");
  assert.equal(
    severityOf({
      ...base,
      tools: [tool({ updateAvailable: true })],
      conflicts: [{ kind: "duplicate-install" }],
    } as never),
    "warn",
    "a conflict means an update may not even apply",
  );
});

test("a failed check reads as a failure, not as silence", () => {
  assert.match(headline({ ok: false, error: "brew timed out" } as never), /brew timed out/);
  assert.equal(severityOf({ ok: false } as never), "warn");
  assert.equal(headline(null), "");
});
