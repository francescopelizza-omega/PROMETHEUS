/**
 * updates-cmd.test.ts — the throttled check orchestration + the /updates command surface,
 * with every network/spawn seam faked (no real fetch, no spawn, temp home).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { updates as u } from "@prometheus/core";

import { type CheckDeps, checkUpdates } from "./check.js";
import { runUpdates, updatesStartupNotice } from "./updates-cmd.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "prom-updates-"));
}

/** A fully-faked check setup: claude installed + outdated, ollama has one model, git checkout. */
function fakeDeps(home: string, over: Partial<CheckDeps> = {}): CheckDeps {
  return {
    home,
    promVersion: "0.0.0",
    ramGb: 32,
    scriptPath: "/x/y/z.js",
    now: () => new Date("2026-06-25T00:00:00Z"),
    which: (bin) => bin === "claude" || bin === "cursor-agent",
    cliVersion: (bin) => (bin === "claude" ? "2.1.190" : "2026.02.13"),
    fetchNpmLatest: async (pkg) => (pkg.includes("claude") ? "2.1.191" : null),
    fetchGithubLatest: async () => null, // no self/ollama latest in the test
    ollamaTags: async () => [{ name: "qwen2.5-coder:7b", digest: "sha:aaa" }],
    engineVersionFn: async () => "0.15.0",
    detectMethod: () => ({ method: "git", repoDir: "/repo" }),
    ...over,
  };
}

test("checkUpdates assembles all three sections from the seams", async () => {
  const home = tmpHome();
  try {
    const { report, fromCache } = await checkUpdates(fakeDeps(home));
    assert.equal(fromCache, false);
    const claude = report.clis.find((c) => c.service === "claude");
    assert.equal(claude?.updateAvailable, true);
    assert.equal(claude?.current, "2.1.190");
    assert.equal(claude?.latest, "2.1.191");
    // cursor is selfcheck-only → installed, no latest, not flagged.
    const cursor = report.clis.find((c) => c.service === "cursor");
    assert.equal(cursor?.installed, true);
    assert.equal(cursor?.updateAvailable, false);
    // self: git method → git pull command; engine version captured.
    assert.equal(report.self.engine, "0.15.0");
    assert.match(report.self.plan.command, /git -C \/repo pull/);
    // models: a suggestion the user lacks (they only have qwen2.5-coder:7b).
    assert.ok(report.models.suggestions.length > 0);
    assert.ok(!report.models.suggestions.some((m) => m.tag === "qwen2.5-coder:7b"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("checkUpdates throttles within the TTL, re-checks on force", async () => {
  const home = tmpHome();
  try {
    await checkUpdates(fakeDeps(home));
    // a second call 1h later (TTL 6h) → cached.
    const cached = await checkUpdates(
      fakeDeps(home, { now: () => new Date("2026-06-25T01:00:00Z") }),
    );
    assert.equal(cached.fromCache, true);
    // force → fresh.
    const forced = await checkUpdates(
      fakeDeps(home, { now: () => new Date("2026-06-25T01:00:00Z"), force: true }),
    );
    assert.equal(forced.fromCache, false);
    // the state file persisted.
    const state = JSON.parse(readFileSync(join(home, "updates", "state.json"), "utf8"));
    assert.ok(state.digests["qwen2.5-coder:7b"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("digest change between checks is flagged", async () => {
  const home = tmpHome();
  try {
    await checkUpdates(fakeDeps(home));
    const next = await checkUpdates(
      fakeDeps(home, {
        force: true,
        ollamaTags: async () => [{ name: "qwen2.5-coder:7b", digest: "sha:NEW" }],
      }),
    );
    assert.deepEqual(next.report.models.diff.changed, ["qwen2.5-coder:7b"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runUpdates prints the report + the propose-not-apply footer", async () => {
  const home = tmpHome();
  try {
    const lines: string[] = [];
    await runUpdates("", {
      home,
      promVersion: "0.0.0",
      write: (l) => lines.push(l),
      check: (d) => checkUpdates({ ...fakeDeps(home), ...d }),
    });
    const out = lines.join("\n");
    assert.match(out, /claude/);
    assert.match(out, /2\.1\.190.*2\.1\.191/s);
    assert.match(out, /never auto-update/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("updatesStartupNotice returns a one-liner when updates exist, else empty", async () => {
  const home = tmpHome();
  try {
    const notice = await updatesStartupNotice({
      home,
      promVersion: "0.0.0",
      write: () => {},
      check: (d) => checkUpdates({ ...fakeDeps(home), ...d }),
    });
    assert.match(notice, /Updates available/);
    assert.match(notice, /\/updates/);

    // nothing actionable → empty.
    const home2 = tmpHome();
    const quiet = await updatesStartupNotice({
      home: home2,
      promVersion: "9.9.9",
      write: () => {},
      check: (d) =>
        checkUpdates({
          ...fakeDeps(home2),
          ramGb: 1, // nothing in the catalog fits → no "new model" suggestions
          which: () => false, // no CLIs installed
          ollamaTags: async () => [], // no models → no digest changes
          fetchNpmLatest: async () => null,
          ...d,
        }),
    });
    // promVersion 9.9.9 + no latest → no self update; no clis; no models.
    assert.equal(quiet, "");
    rmSync(home2, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runUpdates returns the report for --json; a check failure → null (CLI-047)", async () => {
  const home = tmpHome();
  try {
    const lines: string[] = [];
    const report = await runUpdates("", {
      home,
      promVersion: "0.0.0",
      write: (l) => lines.push(l),
      check: async () => checkUpdates(fakeDeps(home)),
    });
    if (!report) return assert.fail("expected a report on a successful check");
    const json = u.toUpdatesJson(report);
    // the JSON mirrors the human lines: claude update-available + a prometheus self entry.
    assert.ok(json.components.some((cmp) => cmp.name === "claude" && cmp.severity === "update"));
    assert.ok(json.components.some((cmp) => cmp.name === "prometheus"));
    assert.ok(lines.join("\n").includes("claude")); // human output unchanged
    // a check FAILURE returns null (index.ts maps it to { ok:false }), distinct from empty.
    const failed = await runUpdates("", {
      home,
      promVersion: "0.0.0",
      write: () => {},
      check: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(failed, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
