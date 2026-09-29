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

import { type CheckDeps, checkUpdates } from "@prometheus/core/updates-live";
import { runUpdates, updatesStartupNotice } from "./updates-cmd.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "prom-updates-"));
}

/**
 * A fully-faked check setup: claude installed + outdated, ollama has one model, git checkout.
 *
 * EVERY seam is named here, including the ones the tool and package sweeps use. When those
 * sweeps were added this object silently stopped covering them and these tests began making
 * real HTTPS requests and spawning `brew` — each one took over a second and would have failed
 * on an offline machine. `CheckDeps extends ToolSweepDeps` is what makes the set complete by
 * construction; this is the set.
 */
function fakeDeps(home: string, over: Partial<CheckDeps> = {}): CheckDeps {
  return {
    home,
    promVersion: "0.0.0",
    ramGb: 32,
    platform: "darwin",
    scriptPath: "/x/y/z.js",
    now: () => new Date("2026-06-25T00:00:00Z"),
    which: (bin) => bin === "claude" || bin === "cursor-agent",
    cliVersion: (bin) => (bin === "claude" ? "2.1.190" : "2026.02.13"),
    fetchNpmLatest: async (pkg) => (pkg.includes("claude") ? "2.1.191" : null),
    fetchGithubLatest: async () => null,
    fetchSelfLatest: async () => null, // GitLab lookup: "could not check", not "up to date"
    ollamaTags: async () => [{ name: "qwen2.5-coder:7b", digest: "sha:aaa" }],
    engineVersionFn: async () => "0.15.0",
    detectMethod: () => ({ method: "git", repoDir: "/repo" }),
    // --- the sweeps ---
    checkUpstream: false, // no registry probe per model
    skipPackages: true, // no spawning of brew/apt/npm
    npmBinDir: null, // no `npm prefix -g`
    /**
     * `which` no longer decides what is installed — `clis` is DERIVED from this resolution, so
     * one report cannot contain two disagreeing answers about the same tool. The fake therefore
     * has to say where each copy lives, not merely that it exists.
     */
    resolve: (t) =>
      t.id === "claude"
        ? u.resolveTool("claude", [
            {
              pathEntry: "/opt/homebrew/bin/claude",
              realPath: "/opt/homebrew/Caskroom/claude-code/2.1.190/claude",
              owner: "brew-cask",
              name: "claude-code",
              version: "2.1.190",
              versionSource: "path",
            },
          ])
        : t.id === "cursor"
          ? u.resolveTool("cursor", [
              {
                pathEntry: "/usr/local/bin/cursor-agent",
                realPath: "/usr/local/bin/cursor-agent",
                owner: "unknown",
                version: "2026.02.13",
                versionSource: "probe",
              },
            ])
          : u.resolveTool(t.id, []),
    fetchImpl: (async (url: string) => {
      const npm = /registry\.npmjs\.org\/(.+)\/latest/.exec(String(url));
      const cask = /api\/cask\/(.+)\.json/.exec(String(url));
      const body = npm?.[1]?.includes("claude")
        ? JSON.stringify({ version: "2.1.191" })
        : cask?.[1] === "claude-code"
          ? JSON.stringify({ version: "2.1.191" })
          : "";
      return {
        status: body ? 200 : 404,
        ok: Boolean(body),
        text: async () => body,
        json: async () => JSON.parse(body || "null"),
      } as unknown as Response;
    }) as unknown as typeof fetch,
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
    // cursor has no published version endpoint → installed, no latest, and NOT flagged.
    const cursor = report.clis.find((c) => c.service === "cursor");
    assert.equal(cursor?.installed, true);
    assert.equal(cursor?.updateAvailable, false);
    /**
     * …and in the section that can express it, "no endpoint" reads as UNKNOWN rather than as
     * up-to-date. The legacy `clis` row is a boolean and cannot carry that, which is exactly why
     * `tools` exists alongside it.
     */
    const cursorTool = report.tools?.find((t) => t.id === "cursor");
    assert.equal(cursorTool?.updateAvailable, null);
    assert.match(cursorTool?.source ?? "", /no public version endpoint|none/);
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
          resolve: (t) => u.resolveTool(t.id, []), // …and none resolve on PATH either
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

test("REGRESSION: the blocking package sweep runs AFTER every async check", () => {
  /**
   * `sweepPackages` is built on `spawnSync`, which holds the event loop for as long as the child
   * runs — and `brew outdated` takes about two seconds. Run inside the same `Promise.all` as the
   * network checks, it stalled their AbortController timers past the 4-second per-request
   * deadline, and the registry probe for every installed model silently produced NOTHING. Not an
   * error: an empty result, rendered as "not checked against the registry this run".
   *
   * Measured: identical inputs found `qwen3.6:latest` had moved to a newer build when the sweep
   * ran afterwards, and found nothing at all when it ran alongside.
   */
  return (async () => {
    const home = tmpHome();
    try {
      const order: string[] = [];
      await checkUpdates(
        fakeDeps(home, {
          skipPackages: false,
          ollamaTags: async () => {
            // A real async boundary, so a blocking sweep scheduled concurrently would interleave.
            await new Promise((r) => setTimeout(r, 5));
            order.push("async");
            return [];
          },
          sweepPackagesFn: () => {
            order.push("sweep");
            return [];
          },
        }),
      );
      assert.deepEqual(
        order,
        ["async", "sweep"],
        "the sweep must not run while async work is in flight",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  })();
});

test("a tool whose copy no command fits says so, instead of printing nothing", () => {
  /**
   * `opencode` is installed by its own script into ~/.opencode/bin; the table's only command was
   * an npm one, correctly withheld — leaving the row with a version gap and no way to close it,
   * silently. A blank is indistinguishable from "nothing to do".
   */
  const line = u.formatUpdateReport({
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    self: {
      prometheus: "0.0.0",
      updateAvailable: false,
      plan: u.buildSelfUpdatePlan({ method: "unknown" }),
    },
    checkedAt: "2026-09-29T00:00:00.000Z",
    tools: [
      {
        id: "x",
        label: "X",
        role: "agent",
        installed: true,
        state: "single",
        copies: [],
        current: "1.0.0",
        latest: "2.0.0",
        updateAvailable: true,
        offer: [],
        withheld: [
          { command: "npm install -g x", reason: "no npm install of this tool was found" },
        ],
      },
    ],
  });
  assert.match(line, /no update command applies to how this copy was installed/);
});

test("an empty withheld command renders as the vendor's own updater, not as a blank", () => {
  // ollama's `{ via: "app", command: "" }` row printed as `not:  ` with nothing after it, which
  // reads as a rendering fault rather than as information.
  const line = u.formatUpdateReport({
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    self: {
      prometheus: "0.0.0",
      updateAvailable: false,
      plan: u.buildSelfUpdatePlan({ method: "unknown" }),
    },
    checkedAt: "2026-09-29T00:00:00.000Z",
    tools: [
      {
        id: "ollama",
        label: "Ollama",
        role: "engine",
        installed: true,
        state: "single",
        copies: [],
        current: "0.34.4",
        latest: "0.34.4",
        updateAvailable: false,
        offer: [],
        withheld: [{ command: "", reason: "updates the app bundle copy, which is not on PATH" }],
      },
    ],
  });
  assert.match(line, /not:\s+\(its own built-in updater\)/);
  assert.doesNotMatch(line, /not:\s*$/m);
});

test("a readable latest with an unreadable installed version says WHICH is unknown", () => {
  /**
   * Measured on LM Studio: `lms --version` prints "CLI commit: 71bd99c" — no version — while the
   * cask channel answers fine. A flat "could not check" implies the lookup failed, when in fact
   * the opposite is true.
   */
  const line = u.formatUpdateReport({
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    self: {
      prometheus: "0.0.0",
      updateAvailable: false,
      plan: u.buildSelfUpdatePlan({ method: "unknown" }),
    },
    checkedAt: "2026-09-29T00:00:00.000Z",
    tools: [
      {
        id: "lmstudio",
        label: "LM Studio",
        role: "engine",
        installed: true,
        state: "single",
        copies: [],
        current: null,
        latest: "0.4.25",
        updateAvailable: null,
        offer: [],
        withheld: [],
      },
    ],
  });
  assert.match(line, /installed version unreadable — latest is 0\.4\.25/);
});
