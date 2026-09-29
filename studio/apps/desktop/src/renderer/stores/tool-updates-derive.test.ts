/**
 * tool-updates-derive.test.ts — the renderer's shaping of the update report.
 *
 * One rule is under test from six directions: **a thing we could not check is never presented
 * as a thing that is fine.** Collapsing "unknown" into "current" is what made the previous
 * checker reassuring exactly when it had failed, and every count and badge here keeps the three
 * states apart.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { UpdatesReportResult } from "../../shared/ipc-contract.js";
import {
  badgeLabel,
  copyableCommands,
  countReport,
  deriveBadge,
  groupPackages,
  groupTools,
  needsAttention,
  sortConflicts,
} from "./tool-updates-derive.js";

function report(over: Partial<UpdatesReportResult> = {}): UpdatesReportResult {
  return {
    ok: true,
    checkedAt: "2026-09-29T00:00:00.000Z",
    conflicts: [],
    tools: [],
    packages: [],
    unavailableManagers: [],
    models: [],
    self: { version: "0.1.0", updateAvailable: false, command: "git pull", steps: [] },
    summary: "",
    ...over,
  };
}

const tool = (over: Partial<UpdatesReportResult["tools"][number]>) => ({
  id: "x",
  label: "X",
  role: "agent",
  installed: true,
  state: "single",
  current: "1.0.0",
  latest: "1.0.0",
  updateAvailable: false as boolean | null,
  offer: [],
  withheld: [],
  copies: [],
  ...over,
});

/* --------------------------------- badge --------------------------------- */

test("nothing checked yet is `idle`, never `current`", () => {
  assert.equal(deriveBadge(null), "idle");
});

test("a failed check is `failed`, never `current`", () => {
  assert.equal(deriveBadge(report({ ok: false, error: "offline" })), "failed");
});

test("REGRESSION: an unchecked tool makes the badge `partial`, not `current`", () => {
  /**
   * The failure this whole tri-state exists for. A rate-limited GitHub, an offline laptop and a
   * genuinely current tool all used to produce the same "up to date" — reassurance the check had
   * not earned.
   */
  const r = report({ tools: [tool({ installed: true, updateAvailable: null })] });
  assert.equal(deriveBadge(r), "partial");
  assert.equal(countReport(r).unknown, 1);
  assert.equal(countReport(r).tools, 0, "an unknown is not an update");
  assert.match(badgeLabel("partial", countReport(r)), /not checked/);
});

test("an UNINSTALLED tool is not an unknown — absence is a fact, not a gap", () => {
  const r = report({ tools: [tool({ installed: false, updateAvailable: null })] });
  assert.equal(countReport(r).unknown, 0);
  assert.equal(deriveBadge(r), "current");
});

test("a manager that could not be asked also counts as unknown", () => {
  const r = report({
    unavailableManagers: [{ manager: "pipx", label: "pipx", reason: "no outdated command" }],
  });
  assert.equal(countReport(r).unknown, 1);
  assert.equal(deriveBadge(r), "partial");
});

test("a conflict OUTRANKS an available update", () => {
  /**
   * A conflict may involve nothing being out of date at all. It is still the more urgent
   * message: a command the user is about to find in `brew outdated` will succeed and change
   * nothing they run.
   */
  const r = report({
    tools: [tool({ updateAvailable: true, latest: "2.0.0" })],
    conflicts: [
      {
        kind: "downgrade-offer",
        subject: "claude",
        summary: "s",
        consequence: "c",
        severity: "high",
      },
    ],
  });
  assert.equal(deriveBadge(r), "conflict");
  assert.match(badgeLabel("conflict", countReport(r)), /1 install conflict/);
});

test("everything checked and nothing to do is `current`", () => {
  const r = report({ tools: [tool({ updateAvailable: false })] });
  assert.equal(deriveBadge(r), "current");
  assert.equal(badgeLabel("current", countReport(r)), "up to date");
});

/* -------------------------------- ordering -------------------------------- */

test("conflicts sort most-misleading first", () => {
  const mk = (severity: "high" | "medium" | "low") => ({
    kind: "k",
    subject: severity,
    summary: "",
    consequence: "",
    severity,
  });
  assert.deepEqual(
    sortConflicts([mk("low"), mk("high"), mk("medium")]).map((c) => c.severity),
    ["high", "medium", "low"],
  );
});

test("a SHADOWED install ranks above a plain version gap", () => {
  /**
   * The version gap has an obvious remedy. The shadow is the reason the obvious remedy may not
   * work, so it has to be read first.
   */
  const out = needsAttention([
    tool({ id: "gap", updateAvailable: true }),
    tool({ id: "shadow", state: "shadowed" }),
    tool({ id: "dupe", state: "duplicate" }),
    tool({ id: "fine" }),
  ]);
  assert.deepEqual(
    out.map((t) => t.id),
    ["shadow", "gap", "dupe"],
  );
  assert.ok(!out.some((t) => t.id === "fine"), "a healthy tool is not an attention item");
});

test("tools group by role in a fixed order, and empty groups vanish", () => {
  const groups = groupTools([
    tool({ id: "rg", role: "toolchain" }),
    tool({ id: "claude", role: "agent" }),
    tool({ id: "ollama", role: "engine" }),
    tool({ id: "gone", role: "optional", installed: false }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.role),
    ["engine", "agent", "toolchain"],
  );
  assert.equal(groups[0]?.heading, "Model engines");
});

test("packages group by their owning manager, because the command differs per manager", () => {
  const groups = groupPackages([
    { manager: "brew", managerLabel: "Homebrew", name: "a", command: "brew upgrade a" },
    { manager: "npm-global", managerLabel: "npm", name: "b", command: "npm i -g b@latest" },
    { manager: "brew", managerLabel: "Homebrew", name: "c", command: "brew upgrade c" },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.manager, g.packages.length]),
    [
      ["brew", 2],
      ["npm-global", 1],
    ],
  );
});

/* ----------------------------- copyable commands ----------------------------- */

test("a command a conflict says to AVOID is excluded from the copyable list", () => {
  /**
   * The point of the whole feature. `brew upgrade --cask claude-code` is a real command for a
   * real install — and running it moves a copy PATH never reaches. It still appears in the
   * conflict section, WITH the reason; it must not appear in a "run these" list.
   */
  const r = report({
    tools: [tool({ id: "claude", offer: [{ command: "claude update" }] })],
    packages: [
      {
        manager: "brew",
        managerLabel: "Homebrew",
        name: "claude-code",
        command: "brew upgrade --cask claude-code",
      },
      { manager: "brew", managerLabel: "Homebrew", name: "pcre2", command: "brew upgrade pcre2" },
    ],
    conflicts: [
      {
        kind: "downgrade-offer",
        subject: "claude",
        summary: "",
        consequence: "",
        avoid: "brew upgrade --cask claude-code",
        severity: "high",
      },
    ],
  });
  const cmds = copyableCommands(r);
  assert.ok(!cmds.includes("brew upgrade --cask claude-code"));
  assert.deepEqual(cmds, ["claude update", "brew upgrade pcre2"]);
});

test("a model whose update needs a newer ollama is not offered as copyable", () => {
  // Pulling first and failing to load second would replace a model that worked.
  const r = report({
    models: [
      { name: "a", changed: true, newer: true, command: "ollama pull a" },
      {
        name: "b",
        changed: true,
        newer: true,
        command: "ollama pull b",
        blockedBy: "needs ollama 0.40.0",
      },
    ],
  });
  assert.deepEqual(copyableCommands(r), ["ollama pull a"]);
});

test("duplicate commands appear once, and an empty one is never emitted", () => {
  const r = report({
    tools: [
      tool({ id: "a", offer: [{ command: "brew upgrade x" }] }),
      tool({ id: "b", offer: [{ command: "brew upgrade x" }, { command: "" }] }),
    ],
  });
  assert.deepEqual(copyableCommands(r), ["brew upgrade x"]);
});

test("a failed report yields no commands at all", () => {
  assert.deepEqual(copyableCommands(report({ ok: false })), []);
  assert.deepEqual(copyableCommands(null), []);
});
