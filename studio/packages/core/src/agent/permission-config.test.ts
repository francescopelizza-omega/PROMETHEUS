/**
 * permission-config.test.ts — the producer the rule engine never had.
 *
 * `evaluatePermission` has taken a `rules` list since it was written and `withRememberedGrants`
 * has accepted `baseRules` since it was written. Nothing supplied either: `permissionRules` had
 * two mentions in the whole repository — a declaration and a read — and no assignment. So the
 * list was always empty, and a documented feature (allow/ask/deny rules) could not be reached
 * from anywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { compilePermissionRules } from "./permission-config.js";
import { evaluatePermission } from "./permission-engine.js";

/**
 * Decide exactly as production does.
 *
 * `evaluatePermission`'s own default is `allow`, but its one live caller
 * (`withRememberedGrants`) passes `"ask"` — which is what makes a user `allow` able only to
 * REMOVE a prompt rather than to grant something. A test that took the function's default
 * would be testing a configuration nothing runs.
 */
const decide = (rules: ReturnType<typeof compilePermissionRules>["rules"], ref: string): string =>
  evaluatePermission({ ref, args: {} }, rules, { cwd: "/repo" }, "ask").decision;

test("a user DENY reaches an actual decision", () => {
  const { rules } = compilePermissionRules({ deny: ["engine:prometheus_install"] });
  assert.equal(decide(rules, "engine:prometheus_install"), "deny");
});

test("a user ALLOW removes a prompt", () => {
  const { rules } = compilePermissionRules({ allow: ["engine:git_status"] });
  assert.equal(decide(rules, "engine:git_status"), "allow");
  // …and only for what it named.
  assert.notEqual(decide(rules, "engine:write_file"), "allow");
});

test("DENY beats ALLOW however the human ordered the file", () => {
  // The engine is last-match-wins, so the emitted ORDER is the whole contract.
  const { rules } = compilePermissionRules({
    allow: ["engine:*"],
    deny: ["engine:prometheus_install"],
  });
  assert.equal(decide(rules, "engine:prometheus_install"), "deny");
});

test("ASK beats ALLOW, so a narrowing rule is never lost to a broad one", () => {
  const { rules } = compilePermissionRules({ allow: ["engine:read_file"], ask: ["engine:*"] });
  assert.equal(decide(rules, "engine:read_file"), "ask");
});

/* ── what a config file may NOT do ─────────────────────────────────────────*/

test("an over-broad ALLOW is refused, and SAYS it was refused", () => {
  // `allow = ["*"]` is not a preference, it is turning the ladder off in a file the user may
  // not remember writing. Silently ignoring it would be worse: they would believe it applied.
  const out = compilePermissionRules({ allow: ["*"] });
  assert.deepEqual(out.rules, []);
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0]?.reason ?? "", /whole tool surface/);
});

test("a PROJECT file may tighten but never grant", () => {
  // A `.prometheus.toml` arrives with a clone, from whoever wrote the repository. A project
  // file that could hand out permissions is a supply-chain hole with a config-shaped door.
  const out = compilePermissionRules(
    {},
    { allow: ["engine:run_command"], deny: ["engine:write_file"] },
  );
  assert.equal(decide(out.rules, "engine:write_file"), "deny", "the project deny must apply");
  assert.notEqual(decide(out.rules, "engine:run_command"), "allow");
  assert.match(out.rejected[0]?.reason ?? "", /cannot grant/);
});

test("a broad user ALLOW is dropped but the same pattern as ASK or DENY is kept", () => {
  // The asymmetry is the point: tightening is always safe, loosening is not.
  assert.equal(compilePermissionRules({ ask: ["*"] }).rules.length, 1);
  assert.equal(compilePermissionRules({ deny: ["*"] }).rules.length, 1);
  assert.equal(compilePermissionRules({ allow: ["*"] }).rules.length, 0);
});

/* ── hand-written files are messy ──────────────────────────────────────────*/

test("blanks, duplicates and non-strings are cleaned rather than emitted", () => {
  const out = compilePermissionRules({
    deny: ["  engine:x  ", "engine:x", "", "   ", 42 as unknown as string],
  });
  assert.deepEqual(out.rules, [{ match: "engine:x", decision: "deny" }]);
});

test("an absent table compiles to no rules and no complaints", () => {
  const out = compilePermissionRules(undefined);
  assert.deepEqual(out.rules, []);
  assert.deepEqual(out.rejected, []);
});

/* ── the safe defaults must run even with NO grant store ───────────────────── */

test("a `.env` write is DENIED by the engine with an empty store and no rules", () => {
  // `withRememberedGrants` is the only production caller of `evaluatePermission`, so it is the
  // only thing that runs the engine's safe defaults. Gating it on a grant store meant the
  // headless run — which has none, because nobody is there to remember an answer for — skipped
  // them all. That is not theoretical: `guardSecretPath` is applied on the READ side only and
  // never in `applyWriteFile`, so `-p --allow-writes` would have auto-approved
  // `write_file {path:".env"}` and overwritten the user's credentials.
  const out = evaluatePermission(
    { ref: "engine:write_file", args: {}, paths: [".env"] },
    [],
    { cwd: "/repo" },
    "ask",
  );
  assert.equal(out.decision, "deny");
  assert.match(out.rule ?? "", /\.env/);
});

test("the deny holds for the paths a credential file actually takes", () => {
  for (const p of [".env", ".env.local", "/repo/.env.production"]) {
    assert.equal(
      evaluatePermission(
        { ref: "engine:write_file", args: {}, paths: [p] },
        [],
        { cwd: "/repo" },
        "ask",
      ).decision,
      "deny",
      `${p} was not protected`,
    );
  }
});
