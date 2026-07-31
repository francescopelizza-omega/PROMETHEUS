/**
 * validate.test.ts — node:test for the ZOD validation seam (file 02 §6).
 *
 * arg-guards.test.ts already covers the pure, zod-free mirror. THIS file covers
 * the actual production wire: the zod schemas in main/validate.ts that every
 * renderer-supplied argument flows through BEFORE routing (a renderer is the
 * least-trusted surface, C5). It asserts two things:
 *
 *   1. each zod validator accepts valid args and rejects invalid ones with a
 *      SERIALIZABLE {kind:"invalid-args", message, detail} — never a throw;
 *   2. the zod schemas AGREE with the pure guards (validate.ts's header "bounds
 *      match 1:1" claim) across a table of valid + adversarial inputs, so the
 *      tested invariant (arg-guards) and the production wire (zod) can't drift.
 *
 * validate.ts imports the REAL `zod` (a runtime dep used only in the privileged
 * main process). The decoupled node:test runner has no installed app-level
 * node_modules, so before importing validate.ts we register a resolver hook
 * (./__test-doubles__/zod-resolver.mjs) that maps `zod` to a faithful minimal
 * double — validate.ts's REAL schema code then executes against it. Production
 * resolves the real zod via electron-vite; the double is a TEST artefact only.
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test validate.test.ts
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Map the bare `zod` specifier to the local test-double BEFORE importing
// validate.ts (whose `import { z } from "zod"` would otherwise be unresolvable
// in the decoupled runner). Static imports are hoisted, so validate.ts must be
// pulled in via a dynamic import AFTER this register() call.
register(new URL("./__test-doubles__/zod-resolver.mjs", import.meta.url));

const {
  validateName,
  validateTarget,
  validateInstall,
  validateUninstall,
  validateToggle,
  validateCancel,
  runSchema,
  installSchema,
  nameSchema,
} = await import("./validate.js");

// The pure guards are zod-free, so they import statically and serve as the
// reference the zod schemas must agree with.
const { guardName, guardTarget, guardInstall, guardUninstall, guardToggle, guardRequiredRunId } =
  await import("./arg-guards.js");

/** The discriminated outcome both validate.* and guard* return. */
type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: string; message: string; detail?: string } };

/* ── validateName ───────────────────────────────────────────────────────────*/

test("validateName accepts a clean trimmed name", () => {
  assert.deepEqual(validateName("  caveman  "), { ok: true, value: "caveman" });
});

test("validateName rejects non-strings with a serializable invalid-args error", () => {
  const r = validateName(42);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "invalid-args");
    assert.equal(typeof r.error.message, "string");
    assert.ok(r.error.message.length > 0);
  }
});

test("validateName rejects empty / whitespace-only", () => {
  assert.equal(validateName("   ").ok, false);
  assert.equal(validateName("").ok, false);
});

test("validateName rejects shell-metacharacter injection attempts", () => {
  for (const bad of ["caveman; rm -rf /", "a|b", "`whoami`", "$(id)", "a&b", "x>y", "a\\b"]) {
    const r = validateName(bad);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(bad)}`);
    if (!r.ok) assert.equal(r.error.kind, "invalid-args");
  }
});

test("validateName rejects control characters", () => {
  // newline + NUL are control chars (\x00-\x1f); a plain SPACE is NOT (the engine
  // does the authoritative name check — the seam only blocks control + shell meta).
  assert.equal(validateName("cave\nman").ok, false);
  assert.equal(validateName("cave\x00man").ok, false);
  assert.equal(validateName("cave man").ok, true, "a plain space is allowed at the seam");
});

test("validateName rejects over-long names", () => {
  assert.equal(validateName("a".repeat(201)).ok, false);
});

/* ── validateTarget ─────────────────────────────────────────────────────────*/

test("validateTarget accepts paths, urls, owner/repo", () => {
  for (const ok of [
    "owner/repo",
    "https://github.com/a/b",
    "/path/to/dir",
    "~/x",
    "git@github.com:a/b.git",
  ]) {
    assert.equal(validateTarget(ok).ok, true, `expected accept for ${ok}`);
  }
});

test("validateTarget rejects empty + non-string + control chars", () => {
  assert.equal(validateTarget("").ok, false);
  assert.equal(validateTarget(null).ok, false);
  assert.equal(validateTarget("a\tb").ok, false);
});

test("validateTarget rejects over-long targets", () => {
  assert.equal(validateTarget("a".repeat(2049)).ok, false);
});

/* ── validateInstall ────────────────────────────────────────────────────────*/

test("validateInstall coerces opts to booleans + threads runId", () => {
  assert.deepEqual(validateInstall("caveman", { dryRun: true, forced: false, runId: "r1" }), {
    ok: true,
    value: { name: "caveman", dryRun: true, forced: false, runId: "r1" },
  });
});

test("validateInstall defaults missing flags to false and drops absent runId", () => {
  assert.deepEqual(validateInstall("caveman", undefined), {
    ok: true,
    value: { name: "caveman", dryRun: false, forced: false },
  });
});

test("validateInstall rejects a bad bool field and a bad name", () => {
  assert.equal(validateInstall("caveman", { dryRun: "yes" }).ok, false);
  assert.equal(validateInstall(123, {}).ok, false);
});

test("validateInstall rejects a malformed runId", () => {
  assert.equal(validateInstall("caveman", { runId: "bad id with spaces" }).ok, false);
  assert.equal(validateInstall("caveman", { runId: "a/b" }).ok, false);
});

test("validateInstall ignores a non-object opts (coerced to {})", () => {
  // asObject() coerces a non-record opts to {}, so a bare name still validates.
  assert.deepEqual(validateInstall("caveman", 7), {
    ok: true,
    value: { name: "caveman", dryRun: false, forced: false },
  });
});

/* ── validateUninstall ──────────────────────────────────────────────────────*/

test("validateUninstall validates name + dryRun + runId", () => {
  assert.deepEqual(validateUninstall("caveman", { dryRun: true }), {
    ok: true,
    value: { name: "caveman", dryRun: true },
  });
  assert.equal(validateUninstall("", {}).ok, false);
});

test("validateUninstall does NOT carry a forced flag", () => {
  const r = validateUninstall("caveman", { dryRun: false, forced: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal("forced" in r.value, false);
});

/* ── validateToggle ─────────────────────────────────────────────────────────*/

test("validateToggle validates name + optional component", () => {
  assert.deepEqual(validateToggle("caveman", "hooks"), {
    ok: true,
    value: { name: "caveman", component: "hooks" },
  });
  assert.deepEqual(validateToggle("caveman", undefined), {
    ok: true,
    value: { name: "caveman" },
  });
  assert.equal(validateToggle("caveman", "bogus").ok, false);
});

/* ── validateCancel ─────────────────────────────────────────────────────────*/

test("validateCancel requires a valid runId", () => {
  assert.deepEqual(validateCancel("ok-1"), { ok: true, value: "ok-1" });
  assert.equal(validateCancel(undefined).ok, false);
  assert.equal(validateCancel("").ok, false);
  assert.equal(validateCancel("bad id").ok, false);
});

/* ── runSchema returns the shared GuardResult discriminated shape ───────────*/

test("runSchema yields { ok:true, value } on success", () => {
  const r = runSchema(nameSchema, { name: "caveman" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { name: "caveman" });
});

test("runSchema yields a serializable invalid-args error on failure", () => {
  const r = runSchema(installSchema, { name: "" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "invalid-args");
    assert.equal(typeof r.error.message, "string");
    // the rejection must structured-clone (plain data, no Error prototype).
    assert.deepEqual(JSON.parse(JSON.stringify(r.error)), r.error);
  }
});

/* ── the 1:1 agreement claim: zod schemas mirror the pure guards ─────────────
 * For each input we assert zod and the pure guard agree on accept/reject (and on
 * the coerced value when both accept). This pins validate.ts's header claim that
 * "each zod schema's bounds match a guard's bounds 1:1" so they can't drift.
 */

/** Compare only the accept/reject decision of two GuardResults. */
function sameDecision<A, B>(a: GuardResult<A>, b: GuardResult<B>): boolean {
  return a.ok === b.ok;
}

test("zod validateName agrees with pure guardName across a table", () => {
  const inputs: unknown[] = [
    "caveman",
    "  trim-me  ",
    "",
    "   ",
    42,
    null,
    "a|b",
    "x;y",
    "cave man",
    "a".repeat(201),
    "ok_name.v2",
  ];
  for (const input of inputs) {
    assert.equal(
      sameDecision(validateName(input), guardName(input)),
      true,
      `decision mismatch for ${JSON.stringify(input)}`,
    );
    const z = validateName(input);
    const g = guardName(input);
    if (z.ok && g.ok) assert.equal(z.value, g.value, `value mismatch for ${JSON.stringify(input)}`);
  }
});

test("zod validateTarget agrees with pure guardTarget across a table", () => {
  const inputs: unknown[] = [
    "owner/repo",
    "https://x.y/z",
    "/abs/path",
    "",
    null,
    "a\tb",
    "a".repeat(2049),
    "~/x",
  ];
  for (const input of inputs) {
    assert.equal(
      sameDecision(validateTarget(input), guardTarget(input)),
      true,
      `decision mismatch for ${JSON.stringify(input)}`,
    );
  }
});

test("zod validateInstall agrees with pure guardInstall (decision + value)", () => {
  const cases: [unknown, unknown][] = [
    ["caveman", { dryRun: true, forced: false, runId: "r1" }],
    ["caveman", undefined],
    ["caveman", { dryRun: "yes" }],
    [123, {}],
    ["caveman", { runId: "a/b" }],
    ["bad name", {}],
  ];
  for (const [name, opts] of cases) {
    const z = validateInstall(name, opts);
    const g = guardInstall(name, opts);
    assert.equal(sameDecision(z, g), true, `decision mismatch for ${JSON.stringify([name, opts])}`);
    if (z.ok && g.ok) {
      assert.deepEqual(z.value, g.value, `value mismatch for ${JSON.stringify([name, opts])}`);
    }
  }
});

test("zod validateUninstall agrees with pure guardUninstall (decision + value)", () => {
  const cases: [unknown, unknown][] = [
    ["caveman", { dryRun: true }],
    ["", {}],
    ["caveman", { dryRun: 1 }],
    ["caveman", { runId: "ok-1" }],
  ];
  for (const [name, opts] of cases) {
    const z = validateUninstall(name, opts);
    const g = guardUninstall(name, opts);
    assert.equal(sameDecision(z, g), true, `decision mismatch for ${JSON.stringify([name, opts])}`);
    if (z.ok && g.ok) assert.deepEqual(z.value, g.value);
  }
});

test("zod validateToggle agrees with pure guardToggle (decision + value)", () => {
  const cases: [unknown, unknown][] = [
    ["caveman", "hooks"],
    ["caveman", "mcp"],
    ["caveman", undefined],
    ["caveman", "bogus"],
    ["", "hooks"],
  ];
  for (const [name, comp] of cases) {
    const z = validateToggle(name, comp);
    const g = guardToggle(name, comp);
    assert.equal(sameDecision(z, g), true, `decision mismatch for ${JSON.stringify([name, comp])}`);
    if (z.ok && g.ok) assert.deepEqual(z.value, g.value);
  }
});

test("zod validateCancel agrees with pure guardRequiredRunId", () => {
  for (const input of ["ok-1", "", undefined, "bad id", "a/b", "run_2.v:3"]) {
    assert.equal(
      sameDecision(validateCancel(input), guardRequiredRunId(input)),
      true,
      `decision mismatch for ${JSON.stringify(input)}`,
    );
  }
});
