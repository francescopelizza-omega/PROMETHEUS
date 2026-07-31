/**
 * updates.test.ts — the pure update-checking engine (semver, sources, models, self, report).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { updates as u } from "../index.js";

/* --------------------------------- semver --------------------------------- */

test("parseVersion tolerates v-prefix, surrounding text, prerelease", () => {
  assert.deepEqual(u.parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: "" });
  assert.deepEqual(u.parseVersion("prom 0.0.0"), { major: 0, minor: 0, patch: 0, prerelease: "" });
  assert.equal(u.parseVersion("2.0.0-rc.1+build")?.prerelease, "rc.1");
  assert.equal(u.parseVersion("not a version"), null);
});

test("compareVersions orders correctly; stable > prerelease", () => {
  assert.equal(u.compareVersions("1.2.4", "1.2.3"), 1);
  assert.equal(u.compareVersions("1.2.3", "1.10.0"), -1);
  assert.equal(u.compareVersions("2.0.0", "2.0.0"), 0);
  assert.equal(u.compareVersions("1.0.0", "1.0.0-beta.1"), 1); // stable outranks prerelease
  assert.equal(u.compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
  assert.equal(u.compareVersions("x", "1.0.0"), null);
});

test("isNewer is strict", () => {
  assert.equal(u.isNewer("2.1.191", "2.1.190"), true);
  assert.equal(u.isNewer("2.1.191", "2.1.191"), false);
  assert.equal(u.isNewer("2.1.190", "2.1.191"), false);
});

/* --------------------------------- sources -------------------------------- */

test("update sources cover the major CLIs with the right channels", () => {
  assert.equal(u.updateSourceFor("claude")?.id, "@anthropic-ai/claude-code");
  assert.equal(u.updateSourceFor("codex")?.channel, "npm");
  assert.equal(u.updateSourceFor("gemini")?.id, "@google/gemini-cli");
  assert.equal(u.updateSourceFor("cursor")?.channel, "selfcheck"); // no public json
  assert.equal(u.updateSourceFor("ollama")?.channel, "github");
  assert.equal(u.updateSourceFor("CLAUDE")?.service, "claude"); // case-insensitive
});

test("version + registry parsers are fail-soft", () => {
  assert.equal(u.parseCliVersion("claude 2.1.191 (build x)"), "2.1.191");
  assert.equal(u.parseCliVersion("garbage"), null);
  assert.equal(u.latestFromNpm({ version: "0.142.2" }), "0.142.2");
  assert.equal(u.latestFromNpm({ version: 42 }), null);
  assert.equal(u.latestFromNpm(null), null);
  assert.equal(u.latestFromGithub({ tag_name: "v0.30.10" }), "v0.30.10");
  assert.equal(u.latestFromGithub({}), null);
});

/* ---------------------------------- models -------------------------------- */

test("digest diff flags changed/added/removed models", () => {
  const prev = { "qwen2.5-coder:7b": "sha:aaa", "llama3.1:8b": "sha:bbb" };
  const now = [
    { name: "qwen2.5-coder:7b", digest: "sha:ZZZ" }, // changed
    { name: "devstral:24b", digest: "sha:ccc" }, // added
  ];
  const d = u.diffDigests(prev, now);
  assert.deepEqual(d.changed, ["qwen2.5-coder:7b"]);
  assert.deepEqual(d.added, ["devstral:24b"]);
  assert.deepEqual(d.removed, ["llama3.1:8b"]);
});

test("recommendUpgrades excludes owned + non-commercial, respects RAM, smallest-first", () => {
  const recs = u.recommendUpgrades(["qwen2.5-coder:7b"], { ramGb: 16, limit: 3 });
  const tags = recs.map((m) => m.tag);
  assert.ok(!tags.includes("qwen2.5-coder:7b"), "already owned excluded");
  assert.ok(!tags.includes("codestral:22b"), "non-commercial excluded by default");
  assert.ok(!tags.includes("qwen3-coder:30b"), "32GB model excluded on a 16GB box");
  assert.ok(
    recs.length > 0 && recs[0] && recs[0].gb <= (recs[1]?.gb ?? Number.POSITIVE_INFINITY),
    "smallest first",
  );
  // opt in to non-commercial → Codestral can appear on a big box.
  const wide = u.recommendUpgrades([], { allowNonCommercial: true, limit: 99 });
  assert.ok(wide.some((m) => m.tag === "codestral:22b"));
});

/* ------------------------------- self-update ------------------------------ */

test("buildSelfUpdatePlan emits the right command per install method", () => {
  assert.match(u.buildSelfUpdatePlan({ method: "npm-global" }).command, /npm install -g .*@latest/);
  assert.match(u.buildSelfUpdatePlan({ method: "git", repoDir: "/x" }).command, /git -C \/x pull/);
  assert.equal(u.buildSelfUpdatePlan({ method: "unknown" }).ambiguous, true);
  // every plan tells the user to close first + restart after.
  const p = u.buildSelfUpdatePlan({ method: "npm-global" });
  assert.match(p.steps[0] ?? "", /[Cc]lose/);
  assert.match(p.steps[p.steps.length - 1] ?? "", /start.*again/i);
});

/* --------------------------------- report --------------------------------- */

function sampleReport(over: Partial<u.UpdateReport> = {}): u.UpdateReport {
  return {
    clis: [
      {
        service: "claude",
        installed: true,
        current: "2.1.190",
        latest: "2.1.191",
        updateAvailable: true,
        command: "claude update",
      },
      {
        service: "codex",
        installed: true,
        current: "0.142.2",
        latest: "0.142.2",
        updateAvailable: false,
        command: "codex update",
      },
    ],
    models: { diff: { changed: ["qwen2.5-coder:7b"], added: [], removed: [] }, suggestions: [] },
    self: {
      prom: "0.0.0",
      engine: "0.15.0",
      updateAvailable: false,
      plan: u.buildSelfUpdatePlan({ method: "git", repoDir: "/p" }),
    },
    checkedAt: "2026-06-25T00:00:00.000Z",
    ...over,
  };
}

test("hasUpdates + summarizeForStartup reflect actionable items", () => {
  const r = sampleReport();
  assert.equal(u.hasUpdates(r), true);
  const line = u.summarizeForStartup(r);
  assert.match(line, /1 CLI/);
  assert.match(line, /1 local model/);
  assert.match(line, /\/updates/);
});

test("summarizeForStartup is empty when nothing actionable", () => {
  const r = sampleReport({
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
  });
  assert.equal(u.hasUpdates(r), false);
  assert.equal(u.summarizeForStartup(r), "");
});

test("formatUpdateReport shows the copyable commands", () => {
  const out = u.formatUpdateReport(sampleReport());
  assert.match(out, /claude\s+2\.1\.190 → 2\.1\.191/);
  assert.match(out, /ollama pull qwen2\.5-coder:7b/);
  assert.match(out, /git -C \/p pull/); // self up-to-date still shows how to update
});

test("toUpdatesJson: flattens the report into the frozen --json envelope (CLI-047)", () => {
  const r = sampleReport();
  assert.deepEqual(u.toUpdatesJson(r), {
    ok: true,
    components: [
      {
        name: "prometheus",
        current: "0.0.0",
        latest: null,
        severity: "none",
        action: r.self.plan.command,
      },
      {
        name: "claude",
        current: "2.1.190",
        latest: "2.1.191",
        severity: "update",
        action: "claude update",
      },
      {
        name: "codex",
        current: "0.142.2",
        latest: "0.142.2",
        severity: "none",
        action: "codex update",
      },
      {
        name: "ollama:qwen2.5-coder:7b",
        current: null,
        latest: null,
        severity: "update",
        action: "ollama pull qwen2.5-coder:7b",
      },
    ],
  });
});

test("toUpdatesJson: nothing actionable → self-only 'none' entry, never a bare ok (CLI-047)", () => {
  const clean = sampleReport({
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
  });
  const json = u.toUpdatesJson(clean);
  assert.equal(json.ok, true);
  assert.deepEqual(
    json.components.map((c) => c.name),
    ["prometheus"],
  );
  assert.equal(json.components[0]?.severity, "none");
});

test("toUpdatesJson: a non-commercial suggestion carries the non-commercial severity (CLI-047)", () => {
  const r = sampleReport({
    models: {
      diff: { changed: [], added: [], removed: [] },
      suggestions: [
        { tag: "codestral:22b", gb: 13, note: "strong", licenseClass: "non-commercial" },
      ] as unknown as u.ModelUpdateStatus["suggestions"],
    },
  });
  const c = u.toUpdatesJson(r).components.find((x) => x.name === "ollama:codestral:22b");
  assert.equal(c?.severity, "non-commercial");
});
