/**
 * settings-sync.test.ts — the settings bundle round-trips through a REAL local git repo (APP-095).
 *
 * Proves AC3: a bundle written + staged + committed + pushed via GitHost's argv-guarded runner
 * lands in a bare remote, and a second clone pulls it back to an IDENTICAL, validated bundle.
 * Uses git directly for setup (init/clone — GitHost has no init) and GitHost for the SAME
 * push/pull path settings-sync-ipc uses. Skips cleanly if `git` is unavailable.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { GitHost } from "./ide/git-host.js";
import { buildSettingsBundle, serializeBundle, validateSettingsBundle } from "./settings-bundle.js";

function gitOk(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

test(
  "settings bundle push→pull round-trips through a local bare git repo (AC3)",
  { skip: !gitOk() },
  async () => {
    const base = mkdtempSync(join(tmpdir(), "prom-sync-"));
    roots.push(base);
    const bare = join(base, "remote.git");
    const work = join(base, "work");
    const clone = join(base, "clone");

    // a bare "remote" + a working clone of it (setup uses git directly — GitHost has no init).
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    execFileSync("git", ["clone", bare, work], { stdio: "ignore" });
    git(work, "config", "user.email", "t@t.t");
    git(work, "config", "user.name", "t");
    writeFileSync(join(work, "README"), "seed\n");
    git(work, "add", "-A");
    git(work, "commit", "-m", "seed");
    git(work, "push", "origin", "HEAD");

    const bundle = buildSettingsBundle({
      keymap: {
        base: "macos",
        overrides: [{ command: "view.commandPalette", keys: "mod+k", source: "user" }],
      },
      themes: [{ id: "mine", name: "Mine", base: "dark", tokens: { "bg-app": "#000000" } }],
      connectors: [],
    });

    // PUSH via the SAME GitHost path settings-sync-ipc uses.
    const gh = new GitHost();
    assert.equal(await gh.isRepo(work), true);
    const file = join(work, "prometheus-settings.json");
    writeFileSync(file, serializeBundle(bundle));
    assert.equal((await gh.stage(work, [file])).ok, true);
    assert.equal((await gh.commit(work, "chore: sync settings")).ok, true);
    assert.equal((await gh.push(work)).ok, true);

    // PULL into a fresh clone → the bundle round-trips identically.
    execFileSync("git", ["clone", bare, clone], { stdio: "ignore" });
    const pulledText = readFileSync(join(clone, "prometheus-settings.json"), "utf8");
    const pulled = validateSettingsBundle(pulledText);
    assert.ok(!("error" in pulled));
    assert.equal(
      serializeBundle(pulled as ReturnType<typeof buildSettingsBundle>),
      serializeBundle(bundle),
    );
    assert.equal((pulled as { keymap: { base: string } }).keymap.base, "macos");
  },
);
