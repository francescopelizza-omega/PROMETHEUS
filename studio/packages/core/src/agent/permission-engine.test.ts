/**
 * permission-engine.test.ts — allow/ask/deny + parsed-bash + safe defaults (file 14 §3.4).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PermissionContext,
  type PermissionRule,
  doomLoopRunLength,
  evaluatePermission,
  isExternalPath,
  isProtectedEnvFile,
  matchBashPattern,
  matchRef,
  permissionEngine,
  shellWords,
} from "./permission-engine.js";

const CTX: PermissionContext = { workspaceRoot: "/home/u/proj", callHistory: [] };

// ---- primitives ------------------------------------------------------------ //

test("shellWords honors quotes + whitespace", () => {
  assert.deepEqual(shellWords('git commit -m "a b c"'), ["git", "commit", "-m", "a b c"]);
  assert.deepEqual(shellWords("  rm   -rf  /tmp/x "), ["rm", "-rf", "/tmp/x"]);
});

test("matchBashPattern: exact tokens, single-* and trailing-*", () => {
  assert.equal(matchBashPattern("git push *", ["git", "push", "origin", "main"]), true);
  assert.equal(matchBashPattern("rm *", ["rm", "-rf", "/"]), true);
  assert.equal(
    matchBashPattern("git push", ["git", "push", "origin"]),
    false,
    "no trailing * → exact length",
  );
  assert.equal(matchBashPattern("git * origin", ["git", "push", "origin"]), true);
  assert.equal(matchBashPattern("npm install", ["npm", "install"]), true);
});

test("matchRef globs tool refs", () => {
  assert.equal(matchRef("engine:*", "engine:install"), true);
  assert.equal(matchRef("*:read", "fsx:read"), true);
  assert.equal(matchRef("ext:acme:*", "ext:acme:deploy"), true);
  assert.equal(matchRef("engine:*", "fs:read"), false);
});

test("isProtectedEnvFile: .env denied, *.env.example allowed", () => {
  assert.equal(isProtectedEnvFile("/p/.env"), true);
  assert.equal(isProtectedEnvFile("/p/.env.local"), true);
  assert.equal(isProtectedEnvFile("app.env"), true);
  assert.equal(isProtectedEnvFile("/p/.env.example"), false);
  assert.equal(isProtectedEnvFile("/p/config.env.sample"), false);
  assert.equal(isProtectedEnvFile("/p/src/app.ts"), false);
});

test("isExternalPath detects escapes from the workspace", () => {
  assert.equal(isExternalPath("/home/u/proj/src/a.ts", "/home/u/proj"), false);
  assert.equal(isExternalPath("/etc/passwd", "/home/u/proj"), true);
  assert.equal(isExternalPath("../../../etc/x", "/home/u/proj"), true);
  assert.equal(isExternalPath("src/a.ts", "/home/u/proj"), false);
});

test("doomLoopRunLength counts the trailing identical run", () => {
  assert.equal(doomLoopRunLength(["a", "b", "b"], "b"), 2);
  assert.equal(doomLoopRunLength(["b", "b", "a"], "b"), 0);
  assert.equal(doomLoopRunLength([], "b"), 0);
});

// ---- evaluatePermission ---------------------------------------------------- //

test(".env access is denied (hard safe-default), even with an allow rule", () => {
  const rules: PermissionRule[] = [{ match: "*", decision: "allow" }];
  const r = evaluatePermission({ ref: "fs:write", paths: ["/home/u/proj/.env"] }, rules, CTX);
  assert.equal(r.decision, "deny");
  assert.match(r.rule ?? "", /\.env/);
});

test("external-directory access asks", () => {
  const r = evaluatePermission({ ref: "fs:read", paths: ["/etc/hosts"] }, [], CTX);
  assert.equal(r.decision, "ask");
  assert.equal(r.rule, "safe-default:external-dir");
});

test("last-matching rule wins; explicit deny beats an earlier allow", () => {
  const rules: PermissionRule[] = [
    { match: "*", decision: "allow" },
    { match: "bash:rm *", decision: "deny" },
  ];
  const rm = evaluatePermission({ ref: "engine:bash", argv: ["rm", "-rf", "/"] }, rules, CTX);
  assert.equal(rm.decision, "deny");
  const ls = evaluatePermission({ ref: "engine:bash", argv: ["ls"] }, rules, CTX);
  assert.equal(ls.decision, "allow");
});

test("doom-loop escalates an allowed call to ask after 3 identical", () => {
  const rules: PermissionRule[] = [{ match: "*", decision: "allow" }];
  const ctx: PermissionContext = { workspaceRoot: "/home/u/proj", callHistory: ["t", "t"] };
  const r = evaluatePermission({ ref: "t" }, rules, ctx);
  assert.equal(r.decision, "ask");
  assert.equal(r.rule, "safe-default:doom-loop");
  // a deny rule is NOT escalated (it already stops)
  const denied = evaluatePermission({ ref: "t" }, [{ match: "t", decision: "deny" }], ctx);
  assert.equal(denied.decision, "deny");
});

test("base default applies when no rule matches; permissionEngine binds rules", () => {
  const engine = permissionEngine([{ match: "engine:*", decision: "deny" }], "allow");
  assert.equal(engine({ ref: "fs:read" }, CTX).decision, "allow");
  assert.equal(engine({ ref: "engine:install" }, CTX).decision, "deny");
});

test("malformed rule glob is skipped, never silently allowed", () => {
  // a pattern that would throw if naively used as a regex still resolves safely
  const r = evaluatePermission(
    { ref: "fs:read" },
    [{ match: "(", decision: "allow" }],
    CTX,
    "deny",
  );
  assert.equal(r.decision, "deny", "base default deny stands when the glob can't match");
});
