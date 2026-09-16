/**
 * security-validate.test.ts — node:test for the security IPC zod seam (§5,§7).
 *
 * security-ipc.ts is RELAY-ONLY and imports electron (so it is not unit-tested at
 * the seam, exactly like ipc.ts). The testable invariant is the validation seam:
 * every `security:*` channel arg flows through these zod validators BEFORE routing
 * (a renderer is the least-trusted surface, C5). This file pins:
 *
 *   1. valid args parse to the coerced typed value,
 *   2. invalid args reject with a SERIALIZABLE {kind:"invalid-args",message,…},
 *   3. an UNKNOWN sub-op on a discriminated channel is REJECTED (fail-closed —
 *      never dispatched), and a missing op is rejected too.
 *
 * security-validate.ts imports the REAL `zod`; the decoupled runner maps it to
 * the same faithful double validate.test.ts uses (via zod-resolver.mjs registered
 * BEFORE the dynamic import). Production resolves the real zod via electron-vite.
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test security-validate.test.ts
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Map `zod` to the local double BEFORE importing security-validate.ts (hoisted
// static imports would otherwise fail to resolve `zod` in the decoupled runner).
register(new URL("./__test-doubles__/zod-resolver.mjs", import.meta.url));

const {
  validateGate,
  validateSecurityAudit,
  validateSecurityInstall,
  validateRemediate,
  validateThreatDb,
  validateTrust,
} = await import("./security-validate.js");

/** The shared discriminated outcome the validators return. */
type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: string; message: string; detail?: string } };

/** Assert a result rejected with a serializable invalid-args error. */
function assertInvalidArgs(r: GuardResult<unknown>): void {
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "invalid-args");
    assert.equal(typeof r.error.message, "string");
    assert.ok(r.error.message.length > 0);
    // must structured-clone (plain data, no Error prototype crossing IPC).
    assert.deepEqual(JSON.parse(JSON.stringify(r.error)), r.error);
  }
}

/* ── validateGate ───────────────────────────────────────────────────────────*/

test("validateGate accepts a bare target and defaults fresh/sign to false", () => {
  assert.deepEqual(validateGate({ target: "owner/repo" }), {
    ok: true,
    value: { target: "owner/repo", fresh: false, sign: false },
  });
});

test("validateGate threads fresh/sign/tier/policyFile", () => {
  const r = validateGate({
    target: "https://github.com/a/b",
    fresh: true,
    sign: true,
    tier: "pentest",
    policyFile: "/etc/nemesis/policy.json",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value, {
      target: "https://github.com/a/b",
      fresh: true,
      sign: true,
      tier: "pentest",
      policyFile: "/etc/nemesis/policy.json",
    });
  }
});

test("validateGate rejects empty/missing target, control chars, bad tier", () => {
  assertInvalidArgs(validateGate({ target: "" }));
  assertInvalidArgs(validateGate({}));
  assertInvalidArgs(validateGate({ target: "a\tb" }));
  assertInvalidArgs(validateGate({ target: "owner/repo", tier: "nuclear" }));
  assertInvalidArgs(validateGate(null));
  assertInvalidArgs(validateGate("owner/repo")); // a bare string is not the {target} shape
});

/* ── validateSecurityAudit ──────────────────────────────────────────────────*/

test("validateSecurityAudit validates a plugin name", () => {
  assert.deepEqual(validateSecurityAudit({ name: "caveman" }), {
    ok: true,
    value: { name: "caveman" },
  });
  assertInvalidArgs(validateSecurityAudit({ name: "" }));
  assertInvalidArgs(validateSecurityAudit({ name: "a;b" }));
});

/* ── validateSecurityInstall ────────────────────────────────────────────────*/

test("validateSecurityInstall defaults dryRun TRUE (preview-first) + forced/confirmForce false", () => {
  assert.deepEqual(validateSecurityInstall({ name: "caveman" }), {
    ok: true,
    value: { name: "caveman", dryRun: true, forced: false, confirmForce: false },
  });
});

test("validateSecurityInstall threads explicit flags + runId + confirmForce", () => {
  assert.deepEqual(
    validateSecurityInstall({
      name: "caveman",
      dryRun: false,
      forced: true,
      confirmForce: true,
      runId: "r1",
    }),
    {
      ok: true,
      value: { name: "caveman", dryRun: false, forced: true, confirmForce: true, runId: "r1" },
    },
  );
});

test("validateSecurityInstall rejects a bad name / bad bool / bad runId / leading-dash name", () => {
  assertInvalidArgs(validateSecurityInstall({ name: "" }));
  assertInvalidArgs(validateSecurityInstall({ name: "caveman", forced: "yes" }));
  assertInvalidArgs(validateSecurityInstall({ name: "caveman", runId: "bad id" }));
  // option-injection defense: a plugin id may not start with a dash (F4).
  assertInvalidArgs(validateSecurityInstall({ name: "-rf" }));
});

/* ── validateRemediate (discriminated; unknown op REJECTED) ──────────────────*/

test("validateRemediate: disinfect needs target + out", () => {
  assert.deepEqual(
    validateRemediate({ op: "disinfect", target: "owner/repo", out: "/tmp/clean" }),
    { ok: true, value: { op: "disinfect", target: "owner/repo", out: "/tmp/clean" } },
  );
  assertInvalidArgs(validateRemediate({ op: "disinfect", target: "owner/repo" })); // missing out
});

test("validateRemediate: disinfect threads the progress runId (APP-010 feed)", () => {
  assert.deepEqual(
    validateRemediate({ op: "disinfect", target: "owner/repo", out: "/tmp/clean", runId: "run-7" }),
    {
      ok: true,
      value: { op: "disinfect", target: "owner/repo", out: "/tmp/clean", runId: "run-7" },
    },
  );
  // a malformed runId is fail-closed rejected at the seam (never dispatched).
  assertInvalidArgs(
    validateRemediate({
      op: "disinfect",
      target: "owner/repo",
      out: "/tmp/clean",
      runId: "bad id",
    }),
  );
});

test("validateRemediate: quarantineList accepts optional target/dir", () => {
  assert.deepEqual(validateRemediate({ op: "quarantineList" }), {
    ok: true,
    value: { op: "quarantineList" },
  });
  assert.deepEqual(validateRemediate({ op: "quarantineList", quarantineDir: "/v/quarantine" }), {
    ok: true,
    value: { op: "quarantineList", quarantineDir: "/v/quarantine" },
  });
});

test("validateRemediate: restore needs id + quarantineDir", () => {
  assert.deepEqual(
    validateRemediate({ op: "restore", id: "q-42", quarantineDir: "/v/quarantine" }),
    { ok: true, value: { op: "restore", id: "q-42", quarantineDir: "/v/quarantine" } },
  );
  assertInvalidArgs(validateRemediate({ op: "restore", id: "q-42" })); // missing dir
});

test("validateRemediate: purge needs target + valid kind", () => {
  assert.deepEqual(validateRemediate({ op: "purge", target: "caveman", kind: "source" }), {
    ok: true,
    value: { op: "purge", target: "caveman", kind: "source" },
  });
  assertInvalidArgs(validateRemediate({ op: "purge", target: "caveman", kind: "bogus" }));
});

test("validateRemediate: purge threads typedName + runId VERBATIM (§9.3 typed-confirm chain)", () => {
  // The typed basename must reach the handler UNTOUCHED so its byte-exact compare
  // against purgeBasename(target) is honest — no trim/case-fold/normalize at the seam.
  assert.deepEqual(
    validateRemediate({
      op: "purge",
      target: "vault/résumé.pdf",
      kind: "quarantine",
      typedName: "résumé.pdf",
      runId: "run-42",
    }),
    {
      ok: true,
      value: {
        op: "purge",
        target: "vault/résumé.pdf",
        kind: "quarantine",
        typedName: "résumé.pdf",
        runId: "run-42",
      },
    },
  );
});

test("validateRemediate: acceptFinding needs target + ruleId + path", () => {
  assert.deepEqual(
    validateRemediate({
      op: "acceptFinding",
      target: "caveman",
      ruleId: "RSHELL-001",
      path: "a.py",
    }),
    {
      ok: true,
      value: { op: "acceptFinding", target: "caveman", ruleId: "RSHELL-001", path: "a.py" },
    },
  );
  assertInvalidArgs(
    validateRemediate({ op: "acceptFinding", target: "caveman", ruleId: "RSHELL-001" }),
  );
});

test("validateRemediate REJECTS an unknown sub-op (fail-closed, never dispatched)", () => {
  assertInvalidArgs(validateRemediate({ op: "nukeEverything", target: "x" }));
  assertInvalidArgs(validateRemediate({ op: "", target: "x" }));
  assertInvalidArgs(validateRemediate({ target: "x" })); // missing op
  assertInvalidArgs(validateRemediate(null));
});

/* ── validateThreatDb (discriminated; unknown op REJECTED) ───────────────────*/

test("validateThreatDb: status / update / authKey / cache", () => {
  assert.deepEqual(validateThreatDb({ op: "status" }), { ok: true, value: { op: "status" } });
  assert.deepEqual(validateThreatDb({ op: "update", force: true, all: false }), {
    ok: true,
    value: { op: "update", force: true, all: false },
  });
  assert.deepEqual(validateThreatDb({ op: "authKey", key: "abuse-ch-secret" }), {
    ok: true,
    value: { op: "authKey", key: "abuse-ch-secret" },
  });
  assert.deepEqual(validateThreatDb({ op: "cache", action: "clear" }), {
    ok: true,
    value: { op: "cache", action: "clear" },
  });
});

test("validateThreatDb: update defaults force/all false + threads feeds", () => {
  assert.deepEqual(validateThreatDb({ op: "update", feeds: ["osv", "clamav-daily"] }), {
    ok: true,
    value: { op: "update", force: false, all: false, feeds: ["osv", "clamav-daily"] },
  });
});

test("validateThreatDb rejects an empty authKey and a bad cache action", () => {
  assertInvalidArgs(validateThreatDb({ op: "authKey", key: "" }));
  assertInvalidArgs(validateThreatDb({ op: "cache", action: "wipe" }));
});

test("validateThreatDb REJECTS an unknown sub-op + missing op", () => {
  assertInvalidArgs(validateThreatDb({ op: "drop" }));
  assertInvalidArgs(validateThreatDb({}));
  assertInvalidArgs(validateThreatDb(undefined));
});

/* ── validateTrust (discriminated; unknown op REJECTED) ──────────────────────*/

test("validateTrust: list / revoke / auditLog / verify", () => {
  assert.deepEqual(validateTrust({ op: "list" }), { ok: true, value: { op: "list" } });
  assert.deepEqual(validateTrust({ op: "revoke", name: "caveman" }), {
    ok: true,
    value: { op: "revoke", name: "caveman" },
  });
  assert.deepEqual(validateTrust({ op: "auditLog", forcedDanger: true, last24h: true }), {
    ok: true,
    value: { op: "auditLog", forcedDanger: true, last24h: true },
  });
  assert.deepEqual(validateTrust({ op: "verify", file: "/v/audit/verdict.json" }), {
    ok: true,
    value: { op: "verify", file: "/v/audit/verdict.json" },
  });
});

test("validateTrust rejects a bad revoke name + an empty verify file", () => {
  assertInvalidArgs(validateTrust({ op: "revoke", name: "" }));
  assertInvalidArgs(validateTrust({ op: "revoke", name: "a|b" }));
  assertInvalidArgs(validateTrust({ op: "verify", file: "" }));
});

test("validateTrust REJECTS an unknown sub-op + missing op", () => {
  assertInvalidArgs(validateTrust({ op: "trustEverything" }));
  assertInvalidArgs(validateTrust({}));
  assertInvalidArgs(validateTrust(42));
});

/* ── auditLog payload projection (the 38 MB-per-mount read) ─────────────────────── */

test("trust auditLog accepts includeVerdictFull, and defaults to omitting it", () => {
  const off = validateTrust({ op: "auditLog" });
  assert.equal(off.ok, true);
  assert.equal(
    (off as { value: Record<string, unknown> }).value.includeVerdictFull,
    undefined,
    "absent means OFF — the blob is opt-in, not opt-out",
  );
  const on = validateTrust({ op: "auditLog", includeVerdictFull: true });
  assert.equal(on.ok, true);
  assert.equal((on as { value: Record<string, unknown> }).value.includeVerdictFull, true);
});

test("trust auditLog rejects a non-boolean includeVerdictFull", () => {
  assert.equal(validateTrust({ op: "auditLog", includeVerdictFull: "yes" }).ok, false);
});

/* -- section 4: restore's typed confirm is a CONTRACT field, not renderer-only -- */

test("restore forwards typedName and path through the field-by-field allowlist", () => {
  // The allowlist rebuilds its value key by key, so a field present in the zod schema but
  // absent from that list is dropped SILENTLY. That trap has now bitten twice in this file
  // (includeVerdictFull, then this) - hence a test per field, not per schema.
  const r = validateRemediate({
    op: "restore",
    id: "abc123",
    quarantineDir: "/v/quarantine",
    typedName: "setup.sh",
    path: "/tmp/pkg/setup.sh",
  });
  assert.equal(r.ok, true);
  const v = (r as { value: Record<string, unknown> }).value;
  assert.equal(v.typedName, "setup.sh");
  assert.equal(v.path, "/tmp/pkg/setup.sh");
});

test("restore still validates without the confirm fields (main refuses, not the parser)", () => {
  // The parser's job is shape; the REFUSAL belongs in security-ipc.ts so the error message
  // can say why. A schema-level `required` here would report "invalid arguments" instead.
  const r = validateRemediate({ op: "restore", id: "abc", quarantineDir: "/v/q" });
  assert.equal(r.ok, true);
  assert.equal((r as { value: Record<string, unknown> }).value.typedName, undefined);
});

test("restore rejects a control-char path and a non-string typedName", () => {
  assert.equal(
    validateRemediate({ op: "restore", id: "a", quarantineDir: "/v/q", path: "bad\u0001path" }).ok,
    false,
  );
  assert.equal(
    validateRemediate({ op: "restore", id: "a", quarantineDir: "/v/q", typedName: 7 }).ok,
    false,
  );
});
