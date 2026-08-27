/**
 * envelope-view.test.ts — the last-resort envelope projector.
 *
 * The bug this pins: `routeViaRegistry` used the registry's one-line SUMMARY as the text
 * surface, so `superscan` / `matrix` / `inventory` / `vault` / `where` printed "<id>: ok"
 * while the envelope carried the whole answer — and `audit` printed "engine returned
 * ok:false" over a live nemesis verdict. Color is forced OFF (the sibling projector suites'
 * convention) so the assertions match plain text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { EngineEnvelope } from "@prometheus/engine-bridge";

import { setColorEnabled } from "../render.js";
import { renderEnvelope } from "./envelope-view.js";

setColorEnabled(false);

const env = (o: Record<string, unknown>): EngineEnvelope =>
  ({ command: "x", ok: true, ...o }) as EngineEnvelope;

test("an engine-formatted `lines[]` payload is printed verbatim", () => {
  const out = renderEnvelope("inventory", env({ command: "inventory", lines: ["a", "b"] }));
  assert.equal(out, "a\nb");
});

test("an array of records becomes a table with the identifying column first", () => {
  const out =
    renderEnvelope(
      "vault",
      env({
        action: "status",
        repos: [
          { source: "plugin", name: "alpha", state: "absent", stored_versions: [] },
          { source: "plugin", name: "beta", state: "stored", stored_versions: ["1", "2"] },
        ],
      }),
    ) ?? "";
  assert.match(out, /action: status/);
  assert.match(out, /repos \(2\)/);
  // `name` is an ID key → hoisted ahead of `source`, which appeared first in the data.
  assert.ok(out.indexOf("NAME") < out.indexOf("SOURCE"), "identifying column comes first");
  assert.match(out, /alpha/);
  assert.match(out, /1, 2/); // a scalar array is joined into its cell
});

test("a nested object recurses; scalars render as a kv block", () => {
  const out = renderEnvelope("where", env({ plugin: { name: "sp", scope: "universal" } })) ?? "";
  assert.match(out, /plugin/);
  assert.match(out, /name: sp/);
  assert.match(out, /scope: universal/);
});

test("an envelope with NO renderable payload returns null (caller falls back to the summary)", () => {
  assert.equal(renderEnvelope("methods", env({ command: "methods" })), null);
});

test("an ok:false envelope leads with the error and still renders its payload", () => {
  const out =
    renderEnvelope(
      "schedule",
      env({ command: "schedule", ok: false, error: "needs a TASK", tasks: [{ name: "t1" }] }),
    ) ?? "";
  assert.match(out.split("\n")[0] ?? "", /schedule: needs a TASK/);
  assert.match(out, /t1/);
});

test("the `audit` tree renders its findings + nemesis verdict, not a one-line stub", () => {
  const out =
    renderEnvelope(
      "audit",
      env({
        command: "audit",
        ok: false,
        request: { plugin: "skills" },
        worst_verdict: "high",
        audits: [
          {
            agent: "claude",
            method: "claude_plugin",
            scan_report: {
              verdict: "low",
              scanned_files: 600,
              active_findings: [
                {
                  rule_id: "R1.rmrf",
                  severity: "low",
                  desc: "recursive force delete",
                  rel_path: "scripts/bundle.sh",
                  line: 36,
                },
              ],
            },
            nemesis_verdicts: [{ source: "anthropics/skills", verdict: "warn", risk_score: 100 }],
          },
        ],
      }),
    ) ?? "";
  assert.match(out, /AUDIT WARN/); // "high" is a SEVERITY word, not a block tier
  assert.match(out, /target: skills/);
  assert.match(out, /R1\.rmrf/);
  assert.match(out, /scripts\/bundle\.sh:36/);
  assert.match(out, /600 files scanned/);
  assert.match(out, /nemesis anthropics\/skills/);
});

test("audit: a nemesis BLOCK escalates the banner; clean/low stays clean", () => {
  const mk = (worst: string): string =>
    renderEnvelope(
      "audit",
      env({ command: "audit", worst_verdict: worst, audits: [{ agent: "claude" }] }),
    ) ?? "";
  assert.match(mk("critical"), /AUDIT BLOCKED/);
  assert.match(mk("low"), /AUDIT CLEAN/);
  assert.match(mk("clean"), /AUDIT CLEAN/);
  assert.match(mk("medium"), /AUDIT WARN/);
  // an unknown word must never be downgraded to clean
  assert.match(mk("weird-new-tier"), /AUDIT WARN/);
});

test("a long cell is CLIPPED so one wide field cannot take the whole row with it", () => {
  /**
   * `table()` sizes each column to its widest cell, so the catalog's ~250-character `summary`
   * turned `plugin list` into a wall that wrapped several times per row. The clip is a DISPLAY
   * decision only — `--json` still carries the untouched value.
   */
  const long = "x".repeat(400);
  const out = renderEnvelope("plugin list", env({ catalog: [{ name: "a", summary: long }] })) ?? "";
  assert.ok(out.includes("…"), "a clipped cell must say so");
  for (const line of out.split("\n")) {
    assert.ok(line.length < 200, `a row must stay readable, got ${line.length} columns`);
  }
  assert.ok(!out.includes(long), "the untruncated value must not reach the terminal");
});

test("an array-of-records payload renders as a TABLE, not as a bare summary line", () => {
  // `plugin list` / `skill list` printed `"<cmd>: ok"` and threw this away — see generic.ts.
  const out =
    renderEnvelope(
      "skill list",
      env({ skills_dir: "/s", skills: [{ name: "x", state: "disabled" }] }),
    ) ?? "";
  assert.match(out, /skills \(1\)/);
  assert.match(out, /NAME\s+STATE/);
  assert.match(out, /x\s+disabled/);
});
