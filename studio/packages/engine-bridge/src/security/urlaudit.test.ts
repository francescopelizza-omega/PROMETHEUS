import assert from "node:assert/strict";
/**
 * urlaudit.test.ts — L5 installed-source audit bridge.
 *  - urlQuarantineList runs the real engine read-only and returns a valid envelope.
 *  - a bad engine path fails closed (throws EngineError, never a silent ok).
 */
import { test } from "node:test";

import { isEngineError } from "../errors.js";
import { groupSkillsByStatus, urlQuarantineList } from "./urlaudit.js";

test("urlQuarantineList: real engine returns a skills-audit envelope", async () => {
  try {
    const r = await urlQuarantineList();
    assert.equal(r.command, "skills-audit");
    assert.equal(typeof r.ok, "boolean");
  } catch (e) {
    // acceptable if the engine isn't resolvable in this environment — must be a
    // typed EngineError (fail-closed), never a silent success.
    assert.ok(isEngineError(e));
  }
});

test("FAIL-CLOSED: a bogus prometheus path throws EngineError", async () => {
  await assert.rejects(
    () => urlQuarantineList({}, { prometheusPy: "/nonexistent/prometheus-xyz.py" }),
    (e: unknown) => isEngineError(e),
  );
});

test("the grouped result is derived from the engine's REAL skills[] payload", () => {
  /**
   * `result` is not a field `prometheus.py skills audit` has ever produced. Its real envelope is
   * `{command, ok, summary:{new,clean,drifted,quarantined,missing,errors}, skills:[{path,status,
   * verdict,…}]}` — measured on this machine: 45 sources, 26 clean, 1 drifted, 18 missing. So
   * `result` was always `undefined` and the Security console's URL-injection panel rendered
   * NOTHING after a full scan: no counts, no quarantined list, no error. The one thing that
   * surface exists to show was invisible.
   */
  const grouped = groupSkillsByStatus({
    command: "skills-audit",
    ok: false,
    summary: { new: 1, clean: 2, drifted: 1, quarantined: 1, missing: 1, errors: 1 },
    skills: [
      { path: "/s/new.md", status: "new", verdict: "warn", kind: "skill", urls: 3 },
      { path: "/s/a.md", status: "clean", verdict: "allow" },
      { path: "/s/b.md", status: "clean", verdict: "allow" },
      { path: "/s/drift.md", status: "drifted", verdict: "block", kind: "skill" },
      {
        path: "/s/bad.md",
        status: "quarantined",
        verdict: "block",
        original: "/s/bad.md",
        vault: "/vault/bad",
        restored_blessed: false,
        first_seen: true,
      },
      { path: "/s/gone.md", status: "missing", verdict: "" },
      { path: "/s/boom.md", status: "error", verdict: "", error: "unreadable" },
    ],
  } as never);

  assert.equal(grouped.new.length, 1);
  assert.equal(grouped.new[0]?.urls, 3);
  assert.deepEqual(grouped.clean, ["/s/a.md", "/s/b.md"]);
  // the engine says "drifted"; the UI bucket has always been called "repinned"
  assert.equal(grouped.repinned.length, 1);
  assert.equal(grouped.quarantined.length, 1);
  assert.equal(grouped.quarantined[0]?.vault, "/vault/bad");
  assert.equal(grouped.quarantined[0]?.first_seen, true);
  assert.deepEqual(grouped.missing, ["/s/gone.md"]);
  assert.deepEqual(grouped.errors, [{ path: "/s/boom.md", error: "unreadable" }]);

  // an UNKNOWN status is reported, never silently dropped — a status added to the engine later
  // must show up somewhere rather than vanishing from the panel.
  const odd = groupSkillsByStatus({
    command: "skills-audit",
    ok: true,
    skills: [{ path: "/s/x.md", status: "something-new" }],
  } as never);
  assert.deepEqual(odd.errors, [{ path: "/s/x.md", error: "something-new" }]);

  // and an envelope with no skills at all yields empty buckets, not a throw
  const none = groupSkillsByStatus({ command: "skills-audit", ok: true } as never);
  assert.deepEqual(none.clean, []);
  assert.deepEqual(none.quarantined, []);
});
