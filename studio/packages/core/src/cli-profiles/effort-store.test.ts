/**
 * effort-store.test.ts — the saved thinking-effort tier: where it lives, and what it stores.
 *
 * The second half is the one that matters. A tier is both a REQUEST and, after a model has had
 * its say, a RESULT — and only the request may be written. Storing the result would ratchet the
 * preference down to whichever model happened to be bound, which is the same defect the
 * authorisation level had (a session-scoped clamp persisting itself as a preference).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveEffort } from "../ai/effort/apply.js";
import { resolveCapability } from "../ai/effort/rules.js";
import { readSavedEffort, saveEffort } from "./effort-store.js";

const NEW = [".prometheus", "config", "effort.json"];
const OLD = [".config", "prometheus-studio", "effort.json"];

function seed(home: string, where: string[], body: string): string {
  const file = join(home, ...where);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
  return file;
}

test("the tier round-trips through the ONE Prometheus config root", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-effortstore-"));
  try {
    assert.equal(readSavedEffort(home), null, "a fresh home has no saved tier");
    saveEffort("xhigh", home);
    assert.equal(readSavedEffort(home), "xhigh");
    assert.equal(existsSync(join(home, ...NEW)), true, "written to ~/.prometheus/config");
    assert.equal(existsSync(join(home, ...OLD)), false, "never to the pre-consolidation root");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an UNMIGRATED install still gets its tier back from the legacy root", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-effortstore-legacy-"));
  try {
    seed(home, OLD, '{"tier":"max"}');
    assert.equal(readSavedEffort(home), "max");
    // the NEW location wins as soon as it exists — a stale copy cannot resurrect an old choice
    seed(home, NEW, '{"tier":"low"}');
    assert.equal(readSavedEffort(home), "low");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt file, or a rung this build does not have, reads as unset", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-effortstore-bad-"));
  try {
    seed(home, NEW, "{ not json");
    assert.equal(readSavedEffort(home), null);
    seed(home, NEW, '{"tier":"medium-ish"}');
    assert.equal(readSavedEffort(home), null);
    seed(home, NEW, '{"tier":7}');
    assert.equal(readSavedEffort(home), null);
    // A tier written by a NEWER build, whose ladder has a rung this one lacks, must fall back to
    // the default rather than being forwarded to a provider as a value this build cannot reason
    // about — the store validates against the real ladder, not against "is it a string".
    seed(home, NEW, '{"tier":"hyper"}');
    assert.equal(readSavedEffort(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unwritable home is a no-op, never a crash mid-session", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-effortstore-ro-"));
  try {
    saveEffort("high", join(home, "definitely", "not", "\0", "writable"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * THE POINT OF THE WHOLE DESIGN: what is stored is what was ASKED FOR.
 *
 * Driven through the real capability table and the real resolver, on two real model ids, so it
 * asserts the actual clamp rather than a hand-made one.
 */
test("the REQUESTED tier is stored; a model's clamp never rewrites the preference", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-effortstore-clamp-"));
  try {
    // The operator asks for xhigh while Claude 4.6 is bound. That generation has `max` but not
    // `xhigh`, so the request genuinely CLAMPS — a real downgrade of the value, not the
    // knobless case where the tier is still honoured by instruction.
    const weak = resolveCapability({ runtime: "anthropic", modelId: "claude-opus-4-6" }).cap;
    const onWeak = resolveEffort("xhigh", weak);
    assert.equal(onWeak.applied, "high", "precondition: 4.6 clamps xhigh down to high");
    assert.ok(onWeak.degraded, "…and says so");
    saveEffort("xhigh", home); // ← the REQUEST, not `onWeak.applied`
    assert.equal(readSavedEffort(home), "xhigh");

    // Now a capable model is bound. Nothing re-reads or re-writes the store: the SAME saved
    // request resolves against the new capability and reaches the wire as `xhigh`.
    const strong = resolveCapability({ runtime: "anthropic", modelId: "claude-opus-5" }).cap;
    const onStrong = resolveEffort(readSavedEffort(home) as never, strong);
    assert.equal(onStrong.applied, "xhigh");
    assert.deepEqual(onStrong.patch, {
      kind: "body",
      path: "output_config.effort",
      value: "xhigh",
    });

    // Had the APPLIED tier been stored while 4.6 was bound, the operator would have been left on
    // `high` for good — on every model, including the ones that have `xhigh` — with nothing to
    // show it had happened.
    assert.equal(
      readFileSync(join(home, ...NEW), "utf8").includes("xhigh"),
      true,
      "the store must still hold the request after a session on a model that cannot honour it",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
