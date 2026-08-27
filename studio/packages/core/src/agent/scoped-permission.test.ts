/**
 * scoped-permission.test.ts — remembered grants: narrowest subject, deny-priority, safe-default guard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluatePermission } from "./permission-engine.js";
import { ScopedPermissionStore, deriveSubject, isTooBroad } from "./scoped-permission.js";

const ctx = { workspaceRoot: "/w", callHistory: [] as string[] };

test("deriveSubject: exact bash command and exact ref, refuses --force and broad", () => {
  assert.equal(deriveSubject("engine:install", undefined), "engine:install");
  assert.equal(deriveSubject("bash", ["git", "status"]), "bash:git status");
  assert.equal(deriveSubject("bash", ["rm", "-rf", "--force"]), null);
  assert.equal(deriveSubject("*", undefined), null);
  assert.equal(deriveSubject("engine:*", undefined), null);
  assert.equal(deriveSubject("bash", ["*"]), null);
});

test("isTooBroad flags the shell-handover subjects", () => {
  for (const s of ["*", "engine:*", "*:*", "bash:*", "bash:", "engine:install --force"]) {
    assert.ok(isTooBroad(s), `should be too broad: ${s}`);
  }
  for (const s of ["engine:install", "bash:git status", "bash:git *", "*:write"]) {
    assert.ok(!isTooBroad(s), `should be allowed: ${s}`);
  }
});

test("add refuses an over-broad subject", () => {
  const store = new ScopedPermissionStore();
  assert.equal(store.add({ subject: "bash:*", decision: "allow", scope: "session" }).ok, false);
  assert.equal(
    store.add({ subject: "engine:install", decision: "allow", scope: "session" }).ok,
    true,
  );
});

test("a remembered ALLOW makes the engine allow that ref", () => {
  const store = new ScopedPermissionStore();
  store.add({ subject: "engine:install", decision: "allow", scope: "session" });
  const rules = store.merge([], "/w");
  const r = evaluatePermission({ ref: "engine:install" }, rules, ctx, "ask");
  assert.equal(r.decision, "allow");
});

test("DENY always wins over a narrower ALLOW (deny-priority merge)", () => {
  const store = new ScopedPermissionStore();
  store.add({ subject: "bash:git status", decision: "allow", scope: "session" });
  store.add({ subject: "bash:git *", decision: "deny", scope: "session" });
  const rules = store.merge([], "/w");
  const r = evaluatePermission({ ref: "bash", argv: ["git", "status"] }, rules, ctx, "ask");
  assert.equal(r.decision, "deny");
});

test("a scoped ALLOW cannot override a BASE deny", () => {
  const store = new ScopedPermissionStore();
  store.add({ subject: "engine:install", decision: "allow", scope: "session" });
  const base = [{ match: "engine:install", decision: "deny" as const }];
  const rules = store.merge(base, "/w"); // [allow, base-deny] → last match (deny) wins
  const r = evaluatePermission({ ref: "engine:install" }, rules, ctx, "ask");
  assert.equal(r.decision, "deny");
});

test("safe-default answer forces scope to once (guard never permanently disabled)", () => {
  const store = new ScopedPermissionStore();
  const res = store.add(
    { subject: "engine:install", decision: "allow", scope: "session" },
    { fromSafeDefault: true },
  );
  assert.equal(res.scope, "once");
  store.clearOnce();
  assert.equal(store.all().length, 0);
});

test("project grants bind to their root; user/session grants persist across session clear", () => {
  const store = new ScopedPermissionStore();
  store.add({ subject: "engine:install", decision: "allow", scope: "project", root: "/w" });
  store.add({ subject: "engine:list", decision: "allow", scope: "session" });
  // the project grant is excluded in a different root; the session grant still applies session-wide
  assert.equal(store.merge([], "/other").length, 1);
  assert.equal(store.merge([], "/w").length, 2); // project (matches) + session
  store.clearSession();
  assert.equal(store.all().length, 1); // project survives, session cleared
});

test("path-bound grant applies only when the call touches that path", () => {
  const store = new ScopedPermissionStore();
  store.add({ subject: "*:write", decision: "allow", scope: "session", paths: ["/w/src/a.ts"] });
  assert.equal(store.merge([], "/w", ["/w/src/a.ts"]).length, 1);
  assert.equal(store.merge([], "/w", ["/w/src/b.ts"]).length, 0);
});

test("a shell GLOB is never remembered as a permission wildcard", () => {
  /**
   * `permission-engine.ts` matches a `bash:` pattern positionally and documents it plainly:
   * "a trailing `*` matches any remaining args". A `*` the USER typed is a shell glob meaning
   * "these files, here, now"; the same character in a stored subject means "any arguments,
   * forever". Answering "always allow" once to `rm *` stored `bash:rm *`, which from then on
   * matched `rm -rf /` with no further prompt. `isTooBroad` missed it — it only refuses a body
   * that is EXACTLY `*`.
   */
  assert.equal(deriveSubject("run_command", ["rm", "*"]), null);
  assert.equal(deriveSubject("run_command", ["rm", "-rf", "*"]), null);
  assert.equal(deriveSubject("run_command", ["chmod", "777", "*"]), null);
  assert.equal(deriveSubject("run_command", ["git", "add", "src/*.ts"]), null);
  // a concrete command is still remembered — the fix must not disarm the feature
  assert.equal(deriveSubject("run_command", ["git", "status"]), "bash:git status");
  assert.equal(
    deriveSubject("run_command", ["git", "push", "origin", "main"]),
    "bash:git push origin main",
  );
});
