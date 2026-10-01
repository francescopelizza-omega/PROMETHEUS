/**
 * remedies.test.ts — the repair half of a conflict.
 *
 * Every scenario is reproduced from one machine on 2026-09-30, and each asserts the thing that
 * makes the repair CORRECT rather than merely plausible: which copy it removes, which flag it
 * refuses, and whether running it makes the finding stop being true.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Conflict } from "./conflicts.js";
import { findConflicts } from "./conflicts.js";
import { type ToolCopy, resolveTool } from "./install-owner.js";
import type { OutdatedPackage } from "./package-managers.js";
import {
  CASK_ZAP_PATHS,
  NEVER_REMOVE,
  NEVER_RUN,
  displayCommand,
  isNeverRun,
  remediesFor,
  remedyFor,
  runnable,
} from "./remedies.js";

const HOME = "/Users/someone";
const copy = (
  p: Partial<ToolCopy> & Pick<ToolCopy, "pathEntry" | "realPath" | "owner">,
): ToolCopy => p as ToolCopy;

/** claude: the vendor installer wins PATH and is NEWER; the Homebrew cask trails behind it. */
function claudeSplit() {
  return resolveTool("claude", [
    copy({
      pathEntry: `${HOME}/.local/bin/claude`,
      realPath: `${HOME}/.local/share/claude/versions/2.1.284/claude`,
      owner: "native-installer",
      name: "claude",
      version: "2.1.284",
    }),
    copy({
      pathEntry: "/opt/homebrew/bin/claude",
      realPath: "/opt/homebrew/Caskroom/claude-code/2.1.274/claude",
      owner: "brew-cask",
      name: "claude-code",
      version: "2.1.274",
    }),
  ]);
}

/* ------------------------- the repair, and which copy it takes ------------------------- */

test("the repair removes the copy that is NOT on PATH, never the one that runs", () => {
  const res = claudeSplit();
  const outdated: OutdatedPackage[] = [
    {
      manager: "brew",
      name: "claude-code",
      kind: "cask",
      installed: "2.1.274",
      available: "2.1.280",
    },
  ];
  const conflicts = findConflicts({ resolutions: [res], outdated });
  const remedies = remediesFor({ conflicts, resolutions: [res], userHome: HOME });

  const fix = remedies.find((m) => m.subject === "claude");
  assert.ok(fix, "a duplicate install must produce a repair");
  assert.deepEqual(fix.steps[0]?.argv, ["brew", "uninstall", "--cask", "claude-code"]);

  /**
   * The load-bearing assertion. Removing the PATH winner would delete the 2.1.284 the user
   * actually runs — the same class of mistake as the conflict being repaired, with a worse
   * outcome, since the tool then disappears rather than merely failing to update.
   */
  assert.ok(
    !JSON.stringify(fix.steps).includes("2.1.284"),
    "the repair must never target the copy on PATH",
  );
  assert.equal(fix.permanent, true, "removing the duplicate makes the conflict stop being true");
  assert.deepEqual(fix.steps[0]?.undo, ["brew", "install", "--cask", "claude-code"]);
});

test("--zap is never emitted, and the refusal says which of YOUR files it would delete", () => {
  const res = claudeSplit();
  const conflicts = findConflicts({ resolutions: [res], outdated: [] });
  const [fix] = remediesFor({ conflicts, resolutions: [res], userHome: HOME });
  assert.ok(fix);

  for (const step of fix.steps) {
    assert.ok(!step.argv.includes("--zap"), "no step may carry --zap");
    assert.ok(!isNeverRun(step.argv), "no step may be on the NEVER_RUN list");
  }

  /**
   * The zap stanza was read verbatim out of Homebrew's cask JSON, and four of its seven entries
   * belong to the VENDOR install: `~/.local/bin/claude` (the PATH-winning symlink),
   * `~/.local/share/claude` (1.2 GB of builds including the one that runs) and `~/.claude.json`
   * (the user's config). So the thorough-sounding command destroys the copy being kept.
   */
  assert.match(fix.rationale, /Do NOT add `--zap`/);
  assert.match(fix.rationale, /\.local\/share\/claude/);
  assert.ok(
    (CASK_ZAP_PATHS["claude-code"] ?? []).includes("~/.local/bin/claude"),
    "the zap table must record the PATH symlink, which is the entry that makes --zap fatal here",
  );
  assert.ok(isNeverRun(["brew", "uninstall", "--zap", "--cask", "claude-code"]));
});

test("the npm global copy is removed with npm, not with brew", () => {
  const res = resolveTool("codex", [
    copy({
      pathEntry: "/opt/homebrew/bin/codex",
      realPath: "/opt/homebrew/Caskroom/codex/0.157.1/bin/codex",
      owner: "brew-cask",
      name: "codex",
      version: "0.157.1",
    }),
    copy({
      pathEntry: `${HOME}/.local/share/npm/bin/codex`,
      realPath: `${HOME}/.local/share/npm/lib/node_modules/@openai/codex/bin/codex.js`,
      owner: "npm-global",
      name: "@openai/codex",
      version: "0.142.5",
    }),
  ]);
  const conflicts = findConflicts({ resolutions: [res], outdated: [] });
  const [fix] = remediesFor({ conflicts, resolutions: [res], userHome: HOME });
  assert.ok(fix);
  assert.deepEqual(fix.steps[0]?.argv, ["npm", "uninstall", "-g", "@openai/codex"]);
});

/* --------------------------------- the refusals --------------------------------- */

test("ollama is never repaired automatically — CLAUDE.md §2.8", () => {
  const res = resolveTool("ollama", [
    copy({
      pathEntry: "/opt/homebrew/bin/ollama",
      realPath: "/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama",
      owner: "brew-formula",
      name: "ollama",
      version: "0.34.4",
    }),
    copy({
      pathEntry: "/Applications/Ollama.app",
      realPath: "/Applications/Ollama.app",
      owner: "app-bundle",
      name: "Ollama",
      version: "0.34.1",
    }),
  ]);
  const conflicts = findConflicts({
    resolutions: [res],
    outdated: [],
    serverVersions: { ollama: "0.34.1" },
  });

  const remedies = remediesFor({ conflicts, resolutions: [res], userHome: HOME });
  assert.ok(remedies.length > 0, "the conflicts must still be reported");
  for (const m of remedies) {
    assert.ok(m.blocked, `every ollama remedy must refuse: ${m.title}`);
    assert.equal(m.steps.length, 0, "a refused remedy must carry no runnable step");
  }
  assert.equal(runnable(remedies).length, 0, "nothing about ollama may be runnable");
  assert.ok(NEVER_REMOVE.includes("ollama"));

  const skew = remedies.find((m) => m.kind === "client-server-skew");
  assert.ok(skew);
  assert.match(skew.blocked ?? "", /36,135/, "the refusal must cite the measured crash loop");
  // A measurement is still offered: the first correct step is always to find the real listener.
  assert.match(displayCommand(skew.verify ?? []), /lsof/);
});

test("a prerequisite on the never-remove list is reported but never repaired", () => {
  const res = resolveTool("rg", [
    copy({
      pathEntry: "/opt/homebrew/bin/rg",
      realPath: "/opt/homebrew/Cellar/ripgrep/15.2.0/bin/rg",
      owner: "brew-formula",
      name: "ripgrep",
      version: "15.2.0",
    }),
    copy({
      pathEntry: "/usr/local/bin/rg",
      realPath: `${HOME}/.cargo/bin/rg`,
      owner: "cargo",
      name: "ripgrep",
      version: "14.0.0",
    }),
  ]);
  const conflicts = findConflicts({ resolutions: [res], outdated: [] });
  const [fix] = remediesFor({ conflicts, resolutions: [res], userHome: HOME });
  assert.ok(fix);
  assert.ok(fix.blocked, "ripgrep is a hard prerequisite — CLAUDE.md §3");
  assert.equal(fix.steps.length, 0);
});

test("a copy with no scripted uninstall says WHY instead of inventing one", () => {
  const res = resolveTool("thing", [
    copy({
      pathEntry: "/usr/local/bin/thing",
      realPath: "/usr/local/bin/thing",
      owner: "unknown",
      version: "2.0.0",
    }),
    copy({
      pathEntry: "/opt/thing/bin/thing",
      realPath: "/opt/thing/bin/thing",
      owner: "unknown",
      version: "1.0.0",
    }),
  ]);
  const conflicts = findConflicts({ resolutions: [res], outdated: [] });
  const [fix] = remediesFor({ conflicts, resolutions: [res], userHome: HOME });
  assert.ok(fix);
  assert.ok(fix.blocked, "an unattributable copy must not be deleted by a script");
  assert.match(fix.blocked, /could not be attributed/);
  assert.equal(fix.permanent, false);
});

/* ------------------------------- the PATH repair ------------------------------- */

test("the PATH repair APPENDS — prepending would silently downgrade a tool", () => {
  const conflict: Conflict = {
    kind: "unreachable-bin-dir",
    subject: "npm (global)",
    summary: "npm (global) installs executables into /d, which is not on your PATH.",
    consequence: "…",
    severity: "high",
  };
  const line = 'case ":$PATH:" in\n  *":/d:"*) ;;\n  *) export PATH="$PATH:/d" ;;\nesac';
  const fix = remedyFor(conflict, {
    binDir: "/d",
    shellInit: { path: `${HOME}/.zshenv`, line, alreadyPresent: false },
  });
  assert.ok(fix);

  /**
   * The measured hazard. `~/.zshrc` on this machine uses the PREPEND idiom, so copying the
   * surrounding style is the natural mistake — and it would put the npm `codex` 0.142.5 ahead of
   * the Homebrew cask's 0.157.1, downgrading a tool by fifteen minor versions from a command
   * that reports success.
   */
  const written = fix.steps.map((s) => s.argv.join(" ")).join("\n");
  assert.ok(written.includes('PATH="$PATH:/d"'), "must append");
  assert.ok(!written.includes('PATH="/d:$PATH"'), "must never prepend");

  /** The backup is a STEP, not a promise in a comment — otherwise nobody can audit it. */
  assert.equal(fix.steps[0]?.argv[0], "cp", "the file must be copied aside first");
  assert.equal(fix.steps.length, 2);
  assert.equal(fix.steps[1]?.risk, "edits-shell-init");
  assert.ok(fix.steps[1]?.displayAs, "a block write must render as the block, not as escaped argv");
  assert.ok(fix.steps[1]?.undo, "the edit must be undoable");
});

test("an already-present PATH entry is a no-op with an explanation, not a second append", () => {
  const conflict: Conflict = {
    kind: "unreachable-bin-dir",
    subject: "npm (global)",
    summary: "…",
    consequence: "…",
    severity: "high",
  };
  const fix = remedyFor(conflict, {
    binDir: "/d",
    shellInit: { path: `${HOME}/.zshenv`, line: "x", alreadyPresent: true },
  });
  assert.ok(fix);
  assert.equal(fix.steps.length, 0, "appending twice would extend PATH twice on every shell");
  assert.match(fix.rationale, /exec \$SHELL -l|new terminal/);
});

/* ------------------------------ the shared invariants ------------------------------ */

test("no remedy anywhere may emit a command from NEVER_RUN", () => {
  const res = claudeSplit();
  const conflicts = findConflicts({
    resolutions: [res],
    outdated: [
      {
        manager: "brew",
        name: "claude-code",
        kind: "cask",
        installed: "2.1.274",
        available: "2.1.280",
      },
    ],
  });
  for (const m of remediesFor({ conflicts, resolutions: [res], userHome: HOME })) {
    for (const step of m.steps) assert.ok(!isNeverRun(step.argv), displayCommand(step.argv));
  }
  // And the list itself must stay non-empty, or the guard above asserts nothing.
  assert.ok(NEVER_RUN.length >= 5);
});

test("runnable() returns ONE repair per subject", () => {
  const res = claudeSplit();
  const conflicts = findConflicts({
    resolutions: [res],
    outdated: [
      {
        manager: "brew",
        name: "claude-code",
        kind: "cask",
        installed: "2.1.274",
        available: "2.1.280",
      },
    ],
  });
  const remedies = remediesFor({ conflicts, resolutions: [res], userHome: HOME });
  assert.ok(remedies.length > 1, "the same install surfaces as several conflicts");
  const runs = runnable(remedies);
  assert.equal(
    runs.length,
    1,
    "…which share ONE repair; running it twice would fail the second time",
  );
  assert.equal(runs[0]?.subject, "claude");
});
