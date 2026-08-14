/**
 * grants.test.ts — "don't ask again", on the surface that never offered it.
 *
 * `ScopedPermissionStore` has had `project` and `user` scopes since it was written, the grants
 * file has persisted them, and `withRememberedGrants` has consulted them on every single call.
 * No host on ANY surface ever returned `remember`, so the whole mechanism was reachable only by
 * hand-editing `grants.json`. The store, the file and the wrapper all worked; the one thing
 * missing was a way for a human to say the word.
 *
 * These tests pin the two halves of fixing that: a grant SKIPS the prompt on the next call, and
 * the answer that creates one is the same answer that approves the call — so approval and
 * memory can never end up disagreeing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { ToolCall } from "@prometheus/core/agent-loop";
import { ScopedPermissionStore, withRememberedGrants } from "@prometheus/core/agent-permissions";

const call = (name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ name, args }) as ToolCall;

test("a remembered grant skips the prompt entirely on the next call", async () => {
  const store = new ScopedPermissionStore();
  let asked = 0;
  const approvals: string[] = [];
  const confirm = withRememberedGrants(
    async () => {
      asked += 1;
      return { approved: true, remember: "project" as const };
    },
    store,
    {
      workspaceRoot: "/w",
      onAutoApprove: (subject) => approvals.push(subject),
    },
  );

  // The wrapper passes the host's answer through verbatim, `remember` and all — the loop
  // ignores that field and `withRememberedGrants` is what acts on it.
  assert.deepEqual(await confirm(call("prometheus_list")), {
    approved: true,
    remember: "project",
  });
  assert.equal(asked, 1, "the first call must reach the human");
  // Second time: the store answers, and the host is never consulted.
  const again = await confirm(call("prometheus_list"));
  assert.equal(again === true || (typeof again === "object" && again.approved), true);
  assert.equal(asked, 1, "the human was asked again despite a remembered grant");
  assert.deepEqual(approvals, ["engine:prometheus_list"]);
});

test("a grant is scoped to the tool that earned it, not to everything", async () => {
  // The failure that would make this feature dangerous: one "always" answering for every
  // later tool. The subject is derived per call, so it cannot generalise.
  const store = new ScopedPermissionStore();
  let asked = 0;
  const confirm = withRememberedGrants(
    async () => {
      asked += 1;
      return { approved: true, remember: "project" as const };
    },
    store,
    { workspaceRoot: "/w" },
  );
  await confirm(call("prometheus_list"));
  await confirm(call("prometheus_install", { name: "claude" }));
  assert.equal(asked, 2, "a grant for one tool answered for another");
});

test("remembering is refused for a subject too broad to be a decision", async () => {
  // The store's own door: `*`, `engine:*` and anything carrying `--force` are refused, so a
  // hostile or careless answer cannot become a blanket allow.
  const store = new ScopedPermissionStore();
  assert.equal(store.add({ subject: "*", decision: "allow", scope: "user" }).ok, false);
  assert.equal(store.add({ subject: "engine:*", decision: "allow", scope: "user" }).ok, false);
  assert.equal(
    store.add({ subject: "bash:rm -rf / --force", decision: "allow", scope: "user" }).ok,
    false,
  );
  assert.equal(
    store.add({ subject: "engine:prometheus_list", decision: "allow", scope: "user" }).ok,
    true,
  );
});

test("a DENY grant still wins over an allow — memory cannot widen permission", async () => {
  const store = new ScopedPermissionStore();
  store.add({ subject: "engine:prometheus_install", decision: "deny", scope: "user" });
  let asked = 0;
  const confirm = withRememberedGrants(
    async () => {
      asked += 1;
      return true;
    },
    store,
    { workspaceRoot: "/w" },
  );
  const res = await confirm(call("prometheus_install", { name: "x" }));
  assert.equal(typeof res === "object" && res.approved, false);
  assert.equal(asked, 0, "a denied call still reached the human");
});

/* ── the affordance itself ─────────────────────────────────────────────────*/

test("the task card offers an ALWAYS answer, and it rides the same result", () => {
  // Approval and memory are one decision: "always" runs the command AND records the grant
  // through the card's own result. A separate channel could approve without remembering (or
  // the reverse), and the user would have no way to tell which happened.
  const pane = readFileSync(new URL("./AgentPane.tsx", import.meta.url), "utf8");
  assert.match(pane, /▶ always/, "the card has no always-allow affordance");
  assert.match(pane, /remember\?: "project" \| "user"/, "runCard cannot carry a remember scope");
  const ctl = readFileSync(new URL("./run-controller.ts", import.meta.url), "utf8");
  assert.match(ctl, /withRememberedGrants\(/, "the pane's confirm is not grant-aware");
  assert.match(ctl, /resolve\(\{ approved: true, remember: r\.remember \}\)/);
});

test("the CLI offers it too, and only for the scopes that outlive a session", () => {
  // `once` and `session` have already expired by the time anything could read them back, so
  // offering them as "always" answers would be a promise the file cannot keep.
  const host = readFileSync(
    new URL("../../../../../../apps/cli/src/session/host.ts", import.meta.url),
    "utf8",
  );
  assert.match(host, /always here/, "the CLI prompt does not offer a remember answer");
  assert.match(host, /remember: "project"/);
  assert.match(host, /remember: "user"/);
});
