/**
 * commands/budget-cmd.test.ts — `prometheus budget …` over REAL temp `home`/`cwd` dirs, never
 * the real `~/.prometheus` or the real machine's active profile.
 *
 * `handleStatus` takes an INJECTED `resolveProfile` in every test here — the real
 * `loadEffectiveStartupProfileWithNotes` has no `home` parameter of its own (it always reads the
 * real OS home for the user-profile layer), so a test that called it unmocked would depend on
 * whatever profile happens to be active on the machine running the suite. `handleSetField`'s own
 * personal-profile writes are similarly home-injectable via the SEPARATE `osHome` param (they go
 * through `cliProfiles.profilePath(name, opts.osHome)`) — deliberately NOT named `home`, since
 * conflating it with `prometheusHome()` (the accounting store's root) was a real bug caught by a
 * live smoke test: `set-session` reported success while writing under the wrong tree entirely,
 * so a follow-up `status` never saw the cap it had just "set". Tests here inject a real temp dir
 * as `osHome` so they never touch the real machine's real `~/.config/prometheus-studio/`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cliProfiles } from "@prometheus/core";

import type { loadEffectiveStartupProfileWithNotes } from "../profile-store.js";
import { appendAccounting } from "../session/history-store.js";
import { handleSetField, handleStatus, runBudgetCommand } from "./budget-cmd.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `prom-budget-cmd-${prefix}-`));
}

function capture(): { write: (line: string) => void; lines: string[]; text: () => string } {
  const lines: string[] = [];
  return { write: (l) => lines.push(l), lines, text: () => lines.join("\n") };
}

const NO_BUDGET_PROFILE = (): ReturnType<typeof loadEffectiveStartupProfileWithNotes> => ({
  profile: {
    agent: { model: "anthropic:claude" },
    engine: {},
  },
  rejected: [],
});

function withBudget(
  budget: NonNullable<cliProfiles.CliProfile["budget"]>,
  rejected: cliProfiles.ProjectLayerRejection[] = [],
): () => ReturnType<typeof loadEffectiveStartupProfileWithNotes> {
  return () => ({
    profile: { agent: { model: "anthropic:claude" }, engine: {}, budget },
    rejected,
  });
}

/* ── status: no cap configured ───────────────────────────────────────────── */

test("status: no budget cap configured says so plainly, never a bare/empty report", () => {
  const home = tempDir("status-no-cap");
  try {
    const res = handleStatus(
      "/nonexistent-cwd",
      home,
      "2026-08-19T18:00:00.000Z",
      NO_BUDGET_PROFILE,
    );
    assert.equal(res.exitCode, 0);
    assert.equal(res.json.capped, false);
    assert.ok(res.lines.some((l) => l.includes("unlimited")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── status: a real configured cap, real accounting records ─────────────── */

test("status: reports real session + daily spend against the configured caps", () => {
  const home = tempDir("status-with-cap");
  try {
    appendAccounting(home, "sess-1", {
      model: "anthropic:claude-opus",
      endpointId: "ep-1",
      promptTokens: 1_000_000,
      completionTokens: 0,
      estimated: false,
      atIso: "2026-08-19T12:00:00.000Z",
    });
    const resolve = withBudget({ sessionUsd: 100, dailyUsd: 50, warnAtPercent: 80 });
    const res = handleStatus("/nonexistent-cwd", home, "2026-08-19T18:00:00.000Z", resolve);
    assert.equal(res.exitCode, 0);
    assert.equal(res.json.capped, true);
    const session = res.json.session as { spentUsd: number; sessionId: string | null };
    const today = res.json.today as { spentUsd: number };
    // pricing is read from the real bundled providers.config.json — assert the SHAPE (a real
    // priced number, or correctly reported as unpriced) rather than a hard-coded dollar figure
    // that would break if the shipped price table changes.
    assert.equal(typeof session.spentUsd, "number");
    assert.equal(typeof today.spentUsd, "number");
    assert.ok(res.lines.some((l) => l.includes("session:")));
    assert.ok(res.lines.some((l) => l.includes("today:")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status: a model with no price entry is surfaced as unpriced, excluded from the totals", () => {
  const home = tempDir("status-unpriced");
  try {
    appendAccounting(home, "sess-1", {
      model: "totally-made-up-model-id",
      endpointId: "ep-1",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      estimated: false,
      atIso: "2026-08-19T12:00:00.000Z",
    });
    const resolve = withBudget({ sessionUsd: 10 });
    const res = handleStatus("/nonexistent-cwd", home, "2026-08-19T18:00:00.000Z", resolve);
    assert.deepEqual(res.json.unpriced, ["totally-made-up-model-id"]);
    assert.ok(res.lines.some((l) => l.includes("no price known for")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("status: surfaces a project-layer rejection (a repo tried to loosen a cap and was refused)", () => {
  const home = tempDir("status-rejected");
  try {
    const resolve = withBudget({ sessionUsd: 5 }, [
      { key: "budget.sessionUsd", reason: "a project persona cannot raise the session cap" },
    ]);
    const res = handleStatus("/nonexistent-cwd", home, "2026-08-19T18:00:00.000Z", resolve);
    assert.ok(res.lines.some((l) => l.includes("refused")));
    assert.ok(res.lines.some((l) => l.includes("session cap")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── set-session / set-daily / set-warn / set-unpriced (personal, no --project) ──────────── */

test("set-session: writes the user's active profile, creating it fresh if none exists yet", () => {
  const home = tempDir("set-session");
  try {
    const res = handleSetField("sessionUsd", ["25"], { project: false, cwd: "/x", osHome: home });
    assert.equal(res.exitCode, 0);
    assert.equal(res.json.scope, "user");
    const path = cliProfiles.profilePath("default", home);
    const written = cliProfiles.parseProfile(readFileSync(path, "utf8"), "default");
    assert.equal(written?.budget?.sessionUsd, 25);
    assert.ok(written?.agent.model, "the freshly-created profile still has a valid agent.model");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("set-daily: a second call preserves the first call's field (session cap survives a daily-cap write)", () => {
  const home = tempDir("set-daily-preserve");
  try {
    handleSetField("sessionUsd", ["25"], { project: false, cwd: "/x", osHome: home });
    handleSetField("dailyUsd", ["10"], { project: false, cwd: "/x", osHome: home });
    const path = cliProfiles.profilePath("default", home);
    const written = cliProfiles.parseProfile(readFileSync(path, "utf8"), "default");
    assert.equal(written?.budget?.sessionUsd, 25);
    assert.equal(written?.budget?.dailyUsd, 10);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("set-warn: rejects an out-of-range percent without writing anything", () => {
  const home = tempDir("set-warn-invalid");
  try {
    const res = handleSetField("warnAtPercent", ["150"], {
      project: false,
      cwd: "/x",
      osHome: home,
    });
    assert.equal(res.exitCode, 2);
    const path = cliProfiles.profilePath("default", home);
    assert.throws(() => readFileSync(path, "utf8"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("set-unpriced: rejects anything other than block/warn", () => {
  const home = tempDir("set-unpriced-invalid");
  try {
    const res = handleSetField("unpricedPolicy", ["sometimes"], {
      project: false,
      cwd: "/x",
      osHome: home,
    });
    assert.equal(res.exitCode, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("set-session: rejects a non-numeric / non-positive value without writing anything", () => {
  const home = tempDir("set-session-invalid");
  try {
    const res1 = handleSetField("sessionUsd", ["not-a-number"], {
      project: false,
      cwd: "/x",
      osHome: home,
    });
    assert.equal(res1.exitCode, 2);
    const res2 = handleSetField("sessionUsd", ["-5"], { project: false, cwd: "/x", osHome: home });
    assert.equal(res2.exitCode, 2);
    const path = cliProfiles.profilePath("default", home);
    assert.throws(() => readFileSync(path, "utf8"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── set-* --project ──────────────────────────────────────────────────────── */

test("set-session --project: refuses when no usable project config exists, writes nothing", () => {
  const cwd = tempDir("project-missing");
  try {
    const res = handleSetField("sessionUsd", ["25"], {
      project: true,
      cwd,
      osHome: tempDir("unused"),
    });
    assert.equal(res.exitCode, 2);
    assert.match(res.json.error as string, /no usable/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("set-session --project: writes into an EXISTING valid .prometheus.toml, preserving agent/engine", () => {
  const cwd = tempDir("project-existing");
  const home = tempDir("project-existing-home");
  try {
    writeFileSync(
      join(cwd, ".prometheus.toml"),
      '[agent]\nmodel = "anthropic:claude"\n\n[engine]\ngateMode = "enforce"\n',
    );
    const res = handleSetField("sessionUsd", ["3"], { project: true, cwd, osHome: home });
    assert.equal(res.exitCode, 0);
    assert.equal(res.json.scope, "project");
    const written = cliProfiles.parseProfile(readFileSync(join(cwd, ".prometheus.toml"), "utf8"));
    assert.equal(written?.budget?.sessionUsd, 3);
    assert.equal(written?.agent.model, "anthropic:claude", "the model must survive the rewrite");
    assert.equal(written?.engine.gateMode, "enforce", "the engine table must survive the rewrite");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── the ctx-facing dispatcher ────────────────────────────────────────────── */

test("runBudgetCommand: an unknown/missing subcommand prints usage and exits 2", async () => {
  const out = capture();
  const home = tempDir("dispatch-usage");
  try {
    const res = await runBudgetCommand([], {
      cwd: "/x",
      home,
      nowIso: "2026-08-19T18:00:00.000Z",
      json: false,
      write: out.write,
    });
    assert.equal(res.exitCode, 2);
    assert.ok(out.text().includes("usage:"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
