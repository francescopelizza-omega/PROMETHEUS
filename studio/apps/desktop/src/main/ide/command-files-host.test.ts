/**
 * command-files-host.test.ts — desktop's custom slash-command discovery (Task #5, desktop
 * parity with apps/cli/src/session/command-files.ts).
 *
 * `commandLoader`/`commandGate` are core's pure parse + trust policy, already covered by their
 * own suites and by the CLI's `command-files.test.ts` (which tests `expandCommand`). This suite
 * pins the DISCOVERY rules this module adds on top: user scope wins a name collision, the
 * project dir is found by walking up from a nested root, and a missing directory yields no
 * commands rather than throwing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverProjectCommandDir, loadCommandFiles } from "./command-files-host.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "prom-command-files-"));
}

test("loadCommandFiles: a missing directory yields no commands (fail-soft)", () => {
  const home = tmp();
  const root = tmp();
  try {
    assert.deepEqual(loadCommandFiles(root, home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCommandFiles: loads a user command + a project command, no name collision", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "command"), { recursive: true });
    writeFileSync(join(home, "command", "review.md"), "Review this: $ARGUMENTS");
    mkdirSync(join(root, ".prometheus", "command"), { recursive: true });
    writeFileSync(join(root, ".prometheus", "command", "status.md"), "Show status: !`git status`");
    const cmds = loadCommandFiles(root, home);
    const names = cmds.map((c) => c.file.name).sort();
    assert.deepEqual(names, ["review", "status"]);
    const review = cmds.find((c) => c.file.name === "review");
    assert.equal(review?.scope, "user");
    const status = cmds.find((c) => c.file.name === "status");
    assert.equal(status?.scope, "project");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCommandFiles: a USER command wins a name collision over a PROJECT one", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "command"), { recursive: true });
    writeFileSync(join(home, "command", "same.md"), "user template");
    mkdirSync(join(root, ".prometheus", "command"), { recursive: true });
    writeFileSync(join(root, ".prometheus", "command", "same.md"), "project template");
    const cmds = loadCommandFiles(root, home);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]?.scope, "user");
    assert.equal(cmds[0]?.file.template, "user template");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCommandFiles: a non-.md file and an unparseable name are skipped", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "command"), { recursive: true });
    writeFileSync(join(home, "command", "notes.txt"), "not a command");
    writeFileSync(join(home, "command", "-rf.md"), "unsafe name");
    writeFileSync(join(home, "command", "ok.md"), "fine template");
    const cmds = loadCommandFiles(root, home);
    assert.deepEqual(
      cmds.map((c) => c.file.name),
      ["ok"],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjectCommandDir: finds the dir walking UP from a nested root", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(root, ".prometheus", "command"), { recursive: true });
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    assert.equal(discoverProjectCommandDir(nested, home), join(root, ".prometheus", "command"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
