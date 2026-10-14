// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrivilegedPromptView } from "../../shared/ipc-contract.js";
import { canApprove, countdownLabel, reduceQueue } from "./privileged-dialog-view.js";

const view = (id: string, phrase?: string): PrivilegedPromptView => ({
  id,
  commandLine: "sudo id",
  execArgv: ["/usr/bin/sudo", "--", "id"],
  cwd: "/",
  surface: "studio",
  requester: "agent",
  why: "check",
  timeoutMs: 120_000,
  passwordVia: "askpass",
  lines: ["PRIVILEGED COMMAND", "  sudo id"],
  ...(phrase ? { phrase } : {}),
});

test("requests queue in arrival order; the dialog shows the head", () => {
  let q = reduceQueue([], { type: "request", view: view("a") });
  q = reduceQueue(q, { type: "request", view: view("b") });
  assert.deepEqual(
    q.map((v) => v.id),
    ["a", "b"],
  );
});

test("a duplicate id is not queued twice", () => {
  let q = reduceQueue([], { type: "request", view: view("a") });
  q = reduceQueue(q, { type: "request", view: view("a") });
  assert.equal(q.length, 1);
});

test("close (main gave up) and answered both remove exactly that request", () => {
  let q = reduceQueue([], { type: "request", view: view("a") });
  q = reduceQueue(q, { type: "request", view: view("b") });
  assert.deepEqual(
    reduceQueue(q, { type: "close", id: "a" }).map((v) => v.id),
    ["b"],
  );
  assert.deepEqual(
    reduceQueue(q, { type: "answered", id: "b" }).map((v) => v.id),
    ["a"],
  );
});

test("approve is enabled only when no phrase is required or the phrase matches exactly", () => {
  assert.equal(canApprove(view("a"), ""), true);
  assert.equal(canApprove(view("a", "/dev/disk4"), ""), false);
  assert.equal(canApprove(view("a", "/dev/disk4"), "disk4"), false);
  assert.equal(canApprove(view("a", "/dev/disk4"), " /dev/disk4 "), true);
});

test("countdown reads m:ss and never goes negative", () => {
  assert.equal(countdownLabel(120_000), "auto-deny in 2:00");
  assert.equal(countdownLabel(61_500), "auto-deny in 1:02"); // rounds UP: never 0:00 while live
  assert.equal(countdownLabel(-5), "auto-deny in 0:00");
});
