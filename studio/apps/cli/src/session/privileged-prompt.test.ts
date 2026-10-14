// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalView } from "@prometheus/core/agent-system-host";
import { makeTerminalApprover } from "./privileged-prompt.js";

const VIEW: ApprovalView = {
  id: "v1",
  commandLine: "sudo systemctl restart nginx",
  execArgv: ["/usr/bin/sudo", "--", "systemctl", "restart", "nginx"],
  elevator: "sudo",
  argv: ["systemctl", "restart", "nginx"],
  cwd: "/repo",
  surface: "tui",
  requester: "agent",
  why: "the unit is root-owned",
  timeoutMs: 120_000,
  passwordVia: "tty",
};

function io(answers: { confirm?: boolean; ask?: string }) {
  const out: string[] = [];
  const prompts: string[] = [];
  return {
    out,
    prompts,
    write: (l: string) => out.push(l),
    confirm: async (p: string) => {
      prompts.push(p);
      return answers.confirm ?? false;
    },
    ask: async (p: string) => {
      prompts.push(p);
      return answers.ask ?? "";
    },
  };
}

test("the whole view is printed BEFORE the question, command first", async () => {
  const t = io({ confirm: true });
  const a = await makeTerminalApprover(t)(VIEW, new AbortController().signal);
  assert.deepEqual(a, { decision: "approve" });
  assert.match(t.out[0] ?? "", /PRIVILEGED COMMAND/);
  assert.match(t.out[1] ?? "", /sudo systemctl restart nginx/);
  assert.equal(t.prompts.length, 1);
  assert.match(t.prompts[0] ?? "", /approve once/);
  assert.match(t.prompts[0] ?? "", /anything else denies/);
});

test("anything but yes denies", async () => {
  const t = io({ confirm: false });
  assert.deepEqual(await makeTerminalApprover(t)(VIEW, new AbortController().signal), {
    decision: "deny",
  });
});

test("a catastrophic command asks for the typed target, and an empty answer denies", async () => {
  const v = { ...VIEW, phrase: "/dev/disk4" };
  const typed = io({ ask: " /dev/disk4 " });
  assert.deepEqual(await makeTerminalApprover(typed)(v, new AbortController().signal), {
    decision: "approve",
    phrase: "/dev/disk4",
  });
  assert.match(typed.prompts[0] ?? "", /type \/dev\/disk4/);
  const empty = io({ ask: "" });
  assert.deepEqual(await makeTerminalApprover(empty)(v, new AbortController().signal), {
    decision: "deny",
  });
});

test("an answer that arrives after the gate timed out is reported as such — nothing ran", async () => {
  const t = io({ confirm: true });
  const ac = new AbortController();
  ac.abort();
  const a = await makeTerminalApprover(t)(VIEW, ac.signal);
  assert.deepEqual(a, { decision: "deny" });
  assert.match(t.out.at(-1) ?? "", /timed out — nothing ran/);
});
