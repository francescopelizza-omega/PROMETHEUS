/**
 * updates.test.ts — the pure update-checking engine (semver, sources, models, self, report).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { updates as u } from "../index.js";

/* --------------------------------- semver --------------------------------- */

const V = (major: number, minor: number, patch: number, extra: Partial<u.SemverParts> = {}) => ({
  epoch: 0,
  major,
  minor,
  patch,
  build: null,
  revision: 0,
  prerelease: "",
  ...extra,
});

test("parseVersion tolerates v-prefix, surrounding text, prerelease", () => {
  assert.deepEqual(u.parseVersion("v1.2.3"), V(1, 2, 3));
  assert.deepEqual(u.parseVersion("prometheus 0.0.0"), V(0, 0, 0));
  assert.equal(u.parseVersion("2.0.0-rc.1+build")?.prerelease, "rc.1");
  assert.equal(u.parseVersion("not a version"), null);
});

test("REGRESSION: four-component versions no longer compare EQUAL", () => {
  /**
   * `1.2.3.4` and `1.2.3.5` both parsed as `1.2.3`, so a four-component version could never be
   * reported as out of date — only ever as current, which is the failure mode that reassures.
   */
  assert.deepEqual(u.parseVersion("1.2.3.4"), V(1, 2, 3, { build: 4 }));
  assert.equal(u.compareVersions("1.2.3.5", "1.2.3.4"), 1);
  assert.equal(u.compareVersions("1.2.3.4", "1.2.3.4"), 0);
  // An absent fourth component sorts below a present one, as `1.2` would below `1.2.1`.
  assert.equal(u.compareVersions("1.2.3", "1.2.3.1"), -1);
});

test("REGRESSION: an epoch is read, and it outranks the version number", () => {
  /**
   * `2:9.1.866-1.fc41`. The epoch exists precisely to force an ordering the version contradicts,
   * so dropping it inverts the comparison for the packages a maintainer deliberately marked.
   */
  assert.equal(u.parseVersion("2:9.1.866-1.fc41")?.epoch, 2);
  assert.equal(u.parseVersion("2:9.1.866-1.fc41")?.major, 9);
  assert.equal(u.compareVersions("1:1.0.0", "2:1.0.0"), -1);
  // …and a lower version with a higher epoch still wins, which is the whole point.
  assert.equal(u.compareVersions("2:1.0.0", "1:9.9.9"), 1);
});

test("a Homebrew rebuild ranks above the release, and `withoutRevision` removes it", () => {
  /**
   * `26.10.0_1` is a repackaging of `26.10.0`. `brew outdated` reporting that transition IS an
   * update worth applying, so compareVersions ranks it — but shadow detection must not read it
   * as a newer PROGRAM, so `install-owner.ts` strips it first. One field, two correct readings.
   *
   * The old regex could not even match this string: it ended in `\b`, and `_` is a word
   * character, so there was no boundary to find after the digits.
   */
  assert.equal(u.parseVersion("26.10.0_1")?.revision, 1);
  assert.equal(u.compareVersions("26.10.0_1", "26.10.0"), 1);
  assert.equal(u.withoutRevision("26.10.0_1"), "26.10.0");
  // A cask's comma revision is the same idea with different punctuation.
  assert.equal(u.parseVersion("0.4.25,1")?.revision, 1);
  assert.equal(u.withoutRevision("0.4.25,1"), "0.4.25");
});

test("a date-based version parses as ordinary numbers and orders correctly", () => {
  // cursor-agent and several vendors ship these; they must not be special-cased, only not broken.
  assert.equal(u.compareVersions("2026.09.29", "2026.09.01"), 1);
  assert.equal(u.compareVersions("2026.10.01", "2026.09.30"), 1);
});

test("a version embedded in a longer token is NOT matched", () => {
  // The lookarounds replace the old \b anchors; they must still refuse a substring of an
  // identifier, or a build hash could be read as a version.
  assert.equal(u.parseVersion("abc1.2.3"), null);
  assert.equal(u.parseVersion("1.2.3abc"), null);
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
      prometheus: "0.0.0",
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
  assert.match(line, /1 tool/);
  /**
   * NOT "1 local model". `models.diff.changed` compares this run's LOCAL digests against the
   * local digests recorded at the previous check, so a tag lands there once the user has ALREADY
   * pulled it — and the startup line then told them to pull the thing they had just pulled.
   * Only `models.upstream`, which asks the registry, can justify that wording.
   */
  assert.doesNotMatch(line, /local model/);
  assert.match(line, /\/updates/);
});

test("`could not check` is counted separately and never read as up to date", () => {
  /**
   * The failure this tri-state exists for. A GitHub 403, an offline laptop and a genuinely
   * current tool all produced `updateAvailable: false`, which rendered as "up to date" — an
   * update checker that reassures you precisely when it has failed.
   */
  const r = sampleReport({
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    self: {
      prometheus: "0.0.0",
      updateAvailable: null,
      plan: u.buildSelfUpdatePlan({ method: "git", repoDir: "/p" }),
    },
    tools: [
      {
        id: "codex",
        label: "Codex CLI",
        role: "agent",
        installed: true,
        state: "single",
        copies: [],
        current: "0.157.1",
        latest: null,
        updateAvailable: null,
        source: "rate-limited",
        offer: [],
        withheld: [],
      },
    ],
  });
  const n = u.countUpdates(r);
  assert.equal(n.tools, 0, "an unknown is not an update");
  assert.equal(n.unknown, 2, "…but it IS counted, self + the tool");
  // Nothing actionable, so no nag — yet the report must not claim everything is current.
  assert.equal(u.hasUpdates(r), false);
  assert.match(u.formatUpdateReport(r), /could not check/);
  assert.doesNotMatch(u.formatUpdateReport(r), /prometheus 0\.0\.0.*up to date/);
});

test("a conflict alone is enough to be worth reporting, and leads the line", () => {
  /**
   * A conflict is not an update — nothing is out of date. It is the more urgent message, because
   * it means a command the user is about to find in `brew outdated` will not do what it says.
   */
  const r = sampleReport({
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    conflicts: [
      {
        kind: "downgrade-offer",
        subject: "claude",
        summary: "brew offers an older version than the one you run",
        consequence: "the command succeeds and changes nothing",
        avoid: "brew upgrade --cask claude-code",
        severity: "high",
      },
    ],
  });
  assert.equal(u.hasUpdates(r), true);
  assert.match(u.summarizeForStartup(r), /^↑ Updates available: 1 install conflict/);
  const out = u.formatUpdateReport(r);
  // It must come BEFORE the sections it invalidates, not after them.
  assert.ok(out.indexOf("Install conflicts") < out.indexOf("Prometheus"));
  assert.match(out, /DO NOT RUN:\s+brew upgrade --cask claude-code/);
});

test("a withheld command is PRINTED with its reason, never silently dropped", () => {
  /**
   * The user will otherwise find the same command in `brew outdated` and run it, having been
   * given no reason not to. Withholding it from the offer list without saying so converts a
   * warning into a silence.
   */
  const r = sampleReport({
    tools: [
      {
        id: "claude",
        label: "Claude Code",
        role: "agent",
        installed: true,
        state: "duplicate",
        copies: [
          {
            pathEntry: "/a/claude",
            realPath: "/a/claude",
            owner: "native-installer",
            version: "2.1.284",
          },
          {
            pathEntry: "/opt/homebrew/bin/claude",
            realPath: "/opt/homebrew/Caskroom/claude-code/2.1.274/c",
            owner: "brew-cask",
            version: "2.1.274",
          },
        ],
        current: "2.1.284",
        latest: "2.1.284",
        updateAvailable: false,
        offer: [{ via: "self", command: "claude update" }],
        withheld: [
          {
            command: "brew upgrade --cask claude-code",
            reason: "updates a copy that is not on PATH",
          },
        ],
      },
    ],
  });
  const out = u.formatUpdateReport(r);
  assert.match(out, /not:\s+brew upgrade --cask claude-code/);
  assert.match(out, /updates a copy that is not on PATH/);
  // …and the second copy is named, so "2.1.284" is not read as the whole truth.
  assert.match(out, /also installed: 2\.1\.274 at \/opt\/homebrew\/bin\/claude/);
});

test("a manager that could not be checked says so, distinctly from `up to date`", () => {
  const r = sampleReport({
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    managers: [
      {
        manager: "pipx",
        label: "pipx",
        checkable: false,
        ok: false,
        packages: [],
        note: "no outdated command",
      },
      { manager: "brew", label: "Homebrew", checkable: true, ok: true, packages: [] },
      {
        manager: "apt",
        label: "apt",
        checkable: true,
        ok: false,
        packages: [],
        note: "exited 100",
      },
    ],
  });
  const out = u.formatUpdateReport(r);
  assert.match(out, /pipx: cannot be checked/);
  assert.match(out, /Homebrew: up to date/);
  assert.match(out, /apt: check failed/);
  // pipx (cannot be asked) + apt (asked, failed). Both are "we do not know", and neither may be
  // folded into the count of things that ARE up to date.
  assert.equal(u.countUpdates(r).unknown, 2);
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
  // the digest diff is reported as the LOCAL CHANGE it is, not as an available update
  assert.match(out, /changed locally since the last check/);
  assert.match(out, /qwen2\.5-coder:7b/);
  assert.doesNotMatch(out, /newer layers available/);
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
        // severity "none", not "update": the digest diff is a record of a LOCAL change (the
        // user already pulled it), not evidence that a newer version exists upstream. The
        // envelope SHAPE is frozen; the value has to tell the truth.
        severity: "none",
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

test("a model the user just PULLED is not reported as an available update", () => {
  /**
   * `fetchOllamaTags` reads the LOCAL daemon, so `diffDigests` compares this run's local digests
   * against the ones recorded at the previous check. A tag therefore lands in `changed` exactly
   * when the user has already pulled it — and Prometheus greeted them at startup with
   * "↑ Updates available: 1 local model", telling them to pull what they had just pulled.
   *
   * The inverse was worse: a genuinely stale model, untouched since the last check, has an
   * unchanged digest and was reported as "installed models up to date". Nothing here queries a
   * registry, so neither claim was ever knowable.
   */
  const justPulled = sampleReport({
    self: { prometheus: "0.0.0", engine: null, updateAvailable: false, method: "git", plan: [] },
    clis: [],
    models: {
      diff: { changed: ["qwen2.5-coder:7b"], added: [], removed: [] },
      suggestions: [],
    },
  } as never);

  assert.equal(
    u.hasUpdates(justPulled),
    false,
    "a local digest change is not an actionable update",
  );
  assert.equal(u.summarizeForStartup(justPulled), "", "and it must not raise a startup nudge");

  const n = u.countUpdates(justPulled);
  assert.equal(n.models, 0, "no local model can be KNOWN out of date without a registry check");
  assert.equal(n.modelsChanged, 1, "the local change is still reported, under its own name");

  const out = u.formatUpdateReport(justPulled);
  assert.doesNotMatch(out, /newer layers available/);
  assert.match(out, /changed locally since the last check/);
  assert.match(out, /not checked against the registry/);
});
