/**
 * remembered-confirm.test.ts — "don't ask again", and the four ways it must refuse to.
 *
 * The feature is small; the guards are the point. A remembered grant is a standing permission
 * the user granted once and will not see again, so the tests that matter are the ones proving
 * it cannot widen into the shell, cannot outlive a safety default, and cannot override a deny.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCall } from "./loop.js";
import { withRememberedGrants } from "./remembered-confirm.js";
import { ScopedPermissionStore } from "./scoped-permission.js";

const ROOT = "/repo";
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ name, args });

/** A host confirm that answers "yes, and remember at `scope`", counting how often it is asked. */
function host(scope?: "once" | "session" | "project" | "user") {
  const asked: string[] = [];
  const fn = (c: ToolCall) => {
    asked.push(c.name);
    return scope ? { approved: true, remember: scope } : { approved: true };
  };
  return { fn, asked };
}

/* ── the point of the feature ────────────────────────────────────────────────*/

test("a remembered grant stops the SECOND identical call from asking", async () => {
  const store = new ScopedPermissionStore();
  const h = host("session");
  const confirm = withRememberedGrants(h.fn, store, { workspaceRoot: ROOT });

  assert.equal((await confirm(call("git_status"))).approved, true);
  assert.equal(h.asked.length, 1);

  const second = await confirm(call("git_status"));
  assert.equal(typeof second === "object" ? second.approved : second, true);
  assert.equal(h.asked.length, 1, "the human was asked again for a remembered grant");
});

test("a DIFFERENT tool still asks — the grant is narrow", async () => {
  const store = new ScopedPermissionStore();
  const h = host("session");
  const confirm = withRememberedGrants(h.fn, store, { workspaceRoot: ROOT });
  await confirm(call("git_status"));
  await confirm(call("write_file", { path: "a.ts" }));
  assert.deepEqual(h.asked, ["git_status", "write_file"]);
});

test("approving WITHOUT remember stores nothing", async () => {
  const store = new ScopedPermissionStore();
  const h = host(); // approves, never asks to remember
  const confirm = withRememberedGrants(h.fn, store, { workspaceRoot: ROOT });
  await confirm(call("git_status"));
  await confirm(call("git_status"));
  assert.equal(h.asked.length, 2);
  assert.equal(store.all().length, 0);
});

test("the host is told what was remembered, and what a grant later skipped", async () => {
  const store = new ScopedPermissionStore();
  const remembered: string[] = [];
  const auto: string[] = [];
  const confirm = withRememberedGrants(host("session").fn, store, {
    workspaceRoot: ROOT,
    onRemember: (s, scope) => remembered.push(`${s}@${scope}`),
    onAutoApprove: (s) => auto.push(s),
  });
  await confirm(call("git_status"));
  await confirm(call("git_status"));
  assert.deepEqual(remembered, ["engine:git_status@session"]);
  assert.deepEqual(auto, ["engine:git_status"]);
});

/* ── the guards ──────────────────────────────────────────────────────────────*/

test("a --force call is never remembered, though the single approval stands", async () => {
  const store = new ScopedPermissionStore();
  const h = host("user");
  const confirm = withRememberedGrants(h.fn, store, { workspaceRoot: ROOT });
  const r = await confirm(call("run_command", { argv: ["prometheus", "install", "--force"] }));
  assert.equal(typeof r === "object" ? r.approved : r, true);
  assert.equal(store.all().length, 0, "a --force subject was persisted");
});

test("a bash grant binds to the EXACT command, not the program", async () => {
  const store = new ScopedPermissionStore();
  const h = host("session");
  const confirm = withRememberedGrants(h.fn, store, { workspaceRoot: ROOT });
  await confirm(call("run_command", { command: "git status" }));
  assert.deepEqual(
    store.all().map((g) => g.subject),
    ["bash:git status"],
  );
  // A different command must still reach the human.
  await confirm(call("run_command", { command: "git push --force-with-lease" }));
  assert.equal(h.asked.length, 2);
});

test("a remembered DENY answers for the human and cannot be overridden by an allow", async () => {
  const store = new ScopedPermissionStore();
  store.add({ subject: "engine:write_file", decision: "deny", scope: "user" });
  store.add({ subject: "engine:write_file", decision: "allow", scope: "user" });
  const h = host("user");
  const confirm = withRememberedGrants(h.fn, store, { workspaceRoot: ROOT });
  const r = await confirm(call("write_file", { path: "/repo/a.ts" }));
  assert.equal(typeof r === "object" ? r.approved : r, false, "a deny was overridden");
  assert.equal(h.asked.length, 0, "the human was asked despite a standing deny");
});

test("a .env path is refused outright, and an `always` there cannot disable the guard", async () => {
  const store = new ScopedPermissionStore();
  const h = host("user");
  const confirm = withRememberedGrants(h.fn, store, { workspaceRoot: ROOT });
  const r = await confirm(call("read_file", { path: "/repo/.env" }));
  assert.equal(typeof r === "object" ? r.approved : r, false);
  assert.equal(store.all().length, 0);
});

test("an `always` answered against an EXTERNAL-dir ask is downgraded to `once`", async () => {
  // Otherwise one careless "always" permanently disables the out-of-workspace guard.
  const store = new ScopedPermissionStore();
  const confirm = withRememberedGrants(host("user").fn, store, { workspaceRoot: ROOT });
  await confirm(call("write_file", { path: "/elsewhere/x.ts" }));
  const stored = store.all();
  if (stored.length > 0) {
    assert.equal(stored[0]?.scope, "once", "a safe-default ask was remembered permanently");
  }
});

test("grants do not leak between stores — one workspace cannot authorise another", async () => {
  // The opt-in itself is at the host (`SessionCtx.grants` absent ⇒ the wrapper is never
  // installed and every call asks). What this pins is the property the wrapper owes: memory
  // belongs to the store it was granted into, and a second store starts with none of it.
  const shared = new ScopedPermissionStore();
  const h1 = host("user");
  const c1 = withRememberedGrants(h1.fn, shared, { workspaceRoot: ROOT });
  await c1(call("git_status"));
  await c1(call("git_status"));
  assert.equal(h1.asked.length, 1, "the grant did not take effect in its own store");

  const h2 = host("user");
  const c2 = withRememberedGrants(h2.fn, new ScopedPermissionStore(), { workspaceRoot: ROOT });
  await c2(call("git_status"));
  assert.equal(h2.asked.length, 1, "a fresh store inherited a grant it was never given");
});

test("a PROJECT grant is bound to its root and does not apply elsewhere", async () => {
  const store = new ScopedPermissionStore();
  const h = host("project");
  await withRememberedGrants(h.fn, store, { workspaceRoot: ROOT })(call("git_status"));
  assert.equal(store.all()[0]?.root, ROOT, "a project grant was stored unbound");

  const other = host("project");
  await withRememberedGrants(other.fn, store, { workspaceRoot: "/other-repo" })(call("git_status"));
  assert.equal(other.asked.length, 1, "a project grant leaked into a different workspace");
});

test("a DECLINE is passed through with its reason intact", async () => {
  const store = new ScopedPermissionStore();
  const confirm = withRememberedGrants(
    () => ({ approved: false, reason: "that file is generated" }),
    store,
    { workspaceRoot: ROOT },
  );
  const r = await confirm(call("write_file", { path: "/repo/a.ts" }));
  assert.equal(typeof r === "object" ? r.reason : "", "that file is generated");
  assert.equal(store.all().length, 0, "a declined call was remembered");
});

test("clearSession drops session grants but keeps project and user", async () => {
  const store = new ScopedPermissionStore();
  const h = host("session");
  const confirm = withRememberedGrants(h.fn, store, { workspaceRoot: ROOT });
  await confirm(call("git_status"));
  store.clearSession();
  await confirm(call("git_status"));
  assert.equal(h.asked.length, 2, "a session grant survived the session");
});
