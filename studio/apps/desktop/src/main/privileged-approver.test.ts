// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * privileged-approver.test.ts — Studio's half of the privileged gate's approval.
 *
 * The approver sends the view to the window and waits for that window's decision. What is
 * pinned: a decision answers exactly one live request, once; a timed-out request closes the
 * dialog and denies; no window means deny; anything malformed is refused, never approved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalView } from "@prometheus/core/agent-system-host";
import { IPC } from "../shared/ipc-contract.js";
import { createStudioApprover } from "./privileged-approver.js";

const VIEW: ApprovalView = {
  id: "abc123",
  commandLine:
    "sudo /usr/bin/python3 /repo/studio/python/tools/disk_space.py --no-sudo --map-json /",
  execArgv: [
    "/usr/bin/sudo",
    "-p",
    "[PROMETHEUS] password for %u: ",
    "-A",
    "--",
    "/usr/bin/python3",
  ],
  elevator: "sudo",
  argv: [
    "/usr/bin/python3",
    "/repo/studio/python/tools/disk_space.py",
    "--no-sudo",
    "--map-json",
    "/",
  ],
  cwd: "/repo",
  surface: "studio",
  requester: "Studio: Rescan as root",
  why: "measure folders unreadable as your user",
  timeoutMs: 120_000,
  passwordVia: "askpass",
};

function harness(windowOpen = true) {
  const sent: { channel: string; payload: unknown }[] = [];
  const a = createStudioApprover((channel, payload) => {
    if (!windowOpen) return false;
    sent.push({ channel, payload });
    return true;
  });
  return { a, sent };
}

test("the view goes to the window with the formatted lines, and an approve answers it", async () => {
  const { a, sent } = harness();
  const p = a.approver(VIEW, new AbortController().signal);
  assert.equal(sent[0]?.channel, IPC.privilegedRequest);
  const payload = sent[0]?.payload as { id: string; lines: string[]; commandLine: string };
  assert.equal(payload.id, "abc123");
  assert.equal(payload.commandLine, VIEW.commandLine);
  assert.match(payload.lines[0] ?? "", /PRIVILEGED COMMAND/);
  assert.deepEqual(a.decide({ id: "abc123", decision: "approve" }), { ok: true });
  assert.deepEqual(await p, { decision: "approve" });
});

test("a decision answers ONE request, once — a replay is refused", async () => {
  const { a } = harness();
  const p = a.approver(VIEW, new AbortController().signal);
  a.decide({ id: "abc123", decision: "approve" });
  await p;
  assert.equal(a.decide({ id: "abc123", decision: "approve" }).ok, false);
});

test("an unknown id, a malformed argument or an odd decision never approves", async () => {
  const { a } = harness();
  const p = a.approver(VIEW, new AbortController().signal);
  assert.equal(a.decide({ id: "nope", decision: "approve" }).ok, false);
  assert.equal(a.decide(null).ok, false);
  assert.equal(a.decide({ id: 7, decision: "approve" }).ok, false);
  assert.equal(a.decide({ id: "abc123", decision: "always" }).ok, true);
  assert.deepEqual(await p, { decision: "deny" });
});

test("the typed phrase travels with an approve", async () => {
  const { a } = harness();
  const p = a.approver({ ...VIEW, phrase: "/dev/disk4" }, new AbortController().signal);
  a.decide({ id: "abc123", decision: "approve", phrase: "/dev/disk4" });
  assert.deepEqual(await p, { decision: "approve", phrase: "/dev/disk4" });
});

test("a timed-out request closes the dialog and denies; a late click is refused", async () => {
  const { a, sent } = harness();
  const ac = new AbortController();
  const p = a.approver(VIEW, ac.signal);
  ac.abort();
  assert.deepEqual(await p, { decision: "deny" });
  assert.equal(sent.at(-1)?.channel, IPC.privilegedClose);
  assert.deepEqual(sent.at(-1)?.payload, { id: "abc123" });
  assert.equal(a.decide({ id: "abc123", decision: "approve" }).ok, false);
});

test("no window to ask means deny", async () => {
  const { a } = harness(false);
  assert.deepEqual(await a.approver(VIEW, new AbortController().signal), { decision: "deny" });
});

test("a privileged subject is never stored as a grant — sudo, pkexec, wrapped or not", async () => {
  const { privilegedGrantRefusal } = await import("./privileged-approver.js");
  for (const subject of [
    "bash:sudo systemctl restart nginx",
    "bash:pkexec id",
    "bash:env X=1 sudo id",
  ]) {
    assert.ok(privilegedGrantRefusal(subject), subject);
  }
  assert.equal(privilegedGrantRefusal("bash:git status"), null);
  assert.equal(privilegedGrantRefusal("engine:prometheus_scan"), null);
});
