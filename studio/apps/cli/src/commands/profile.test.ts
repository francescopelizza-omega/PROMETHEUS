/**
 * profile.test.ts — `prometheus config get/set` real TOML-backed reads/writes (CLI-005).
 * Hermetic: points os.homedir() at a temp dir via $HOME, then restores it.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cliProfiles } from "@prometheus/core";

import type { CliContext } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { getActiveProfileName, loadEffectiveStartupProfile } from "../profile-store.js";
import { type ProfileCmdDeps, runConfig, runProfile } from "./profile.js";

/** A minimal CliContext — runConfig only reads args.positionals. */
function ctx(positionals: string[]): CliContext {
  return {
    client: undefined as unknown as CliContext["client"],
    json: false,
    args: { positionals } as unknown as ParsedArgs,
  };
}

test("config get/set: round-trip, exit codes, json envelopes, atomic write (CLI-005)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-cfg-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // unknown key on a missing file → exit 2 + failure envelope (NOT a crash, NOT exit 0)
    const miss = runConfig(["config", "get"], ctx(["a.b"]));
    assert.equal(miss.exitCode, 2);
    assert.deepEqual(miss.json, { ok: false, key: "a.b", error: "unknown-key" });

    // set a.b 1 → exit 0, coerced to a number, success envelope
    const set = runConfig(["config", "set"], ctx(["a.b", "1"]));
    assert.equal(set.exitCode, 0);
    // CLI-045: an unknown key now also carries a forward-compat "unknown-key" warning (still writes).
    assert.deepEqual(set.json, { ok: true, key: "a.b", value: 1, warning: "unknown-key" });

    // get a.b → round-trips the value
    const get = runConfig(["config", "get"], ctx(["a.b"]));
    assert.equal(get.exitCode, 0);
    assert.deepEqual(get.json, { ok: true, key: "a.b", value: 1 });
    assert.equal(get.text, "1");

    // more sets: nested path + a bool + overwrite; file stays parseToml-valid
    assert.equal(runConfig(["config", "set"], ctx(["a.b.c", "hello"])).exitCode, 0);
    assert.equal(runConfig(["config", "set"], ctx(["flags.verbose", "true"])).exitCode, 0);
    assert.equal(runConfig(["config", "set"], ctx(["a.z", "2"])).exitCode, 0);
    const raw = readdirSync(cliProfiles.configDir());
    const file = cliProfiles.configPath();
    const table = cliProfiles.parseToml(readFileSync(file, "utf8"));
    assert.equal(cliProfiles.getPath(table, "a.b.c"), "hello");
    assert.equal(cliProfiles.getPath(table, "flags.verbose"), true);
    assert.equal(cliProfiles.getPath(table, "a.z"), 2);

    // atomic write leaves NO temp litter
    assert.ok(!raw.some((f) => f.endsWith(".tmp")), "no leftover temp files");

    // bad usage → exit 2
    assert.equal(runConfig(["config", "set"], ctx(["onlykey"])).exitCode, 2);
    assert.equal(runConfig(["config", "get"], ctx([])).exitCode, 2);
  } finally {
    if (prevHome === undefined) {
      // biome-ignore lint/performance/noDelete: restore the env to truly-unset
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  }
});

// ── CLI-044: profile use/new/edit/list persistence ─────────────────────────────
function pctx(
  positionals: string[],
  flags: Record<string, string | true> = {},
  json = false,
): CliContext {
  return {
    client: undefined as unknown as CliContext["client"],
    json,
    args: { positionals, flags } as unknown as ParsedArgs,
  };
}

test("profile use persists across a fresh read; list marks it; unknown → exit 2 (CLI-044)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-prof-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(runProfile(["profile", "use"], pctx(["nope"])).exitCode, 2);
    const use = runProfile(["profile", "use"], pctx(["ci"]));
    assert.equal(use.exitCode, 0);
    assert.equal(getActiveProfileName(), "ci"); // a fresh read sees the persisted choice
    const list = runProfile(["profile", "list"], pctx([], {}, true));
    const env = list.json as { active: string; profiles: { name: string; active: boolean }[] };
    assert.equal(env.active, "ci");
    assert.ok(env.profiles.some((p) => p.name === "ci" && p.active));
  } finally {
    if (prev !== undefined) process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile new scaffolds a parseable TOML shown under user; refuses overwrite (CLI-044)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-prof-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const nu = runProfile(["profile", "new"], pctx(["mine"], { seed: "local-safe" }));
    assert.equal(nu.exitCode, 0);
    const file = cliProfiles.profilePath("mine");
    assert.ok(existsSync(file));
    assert.ok(cliProfiles.parseProfile(readFileSync(file, "utf8"), "mine"), "scaffold parses");
    const list = runProfile(["profile", "list"], pctx([], {}, true));
    const env = list.json as { profiles: { name: string; source: string }[] };
    assert.ok(env.profiles.some((p) => p.name === "mine" && p.source === "user"));
    // second `new mine` refuses to overwrite
    assert.equal(runProfile(["profile", "new"], pctx(["mine"])).exitCode, 2);
    // unknown seed → exit 2
    assert.equal(runProfile(["profile", "new"], pctx(["other"], { seed: "nope" })).exitCode, 2);
  } finally {
    if (prev !== undefined) process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile edit on a builtin copies to the user dir before opening the editor (CLI-044)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-prof-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    let openedWith = "";
    const deps: ProfileCmdDeps = {
      openEditor: (f) => {
        openedWith = f;
        return 0;
      },
      isTTY: true,
    };
    const file = cliProfiles.profilePath("default");
    assert.ok(!existsSync(file)); // no user copy yet
    const ed = runProfile(["profile", "edit"], pctx(["default"]), deps);
    assert.equal(ed.exitCode, 0);
    assert.ok(existsSync(file)); // builtin was copied to the user dir (copy-on-write)
    assert.equal(openedWith, file);
    assert.ok(cliProfiles.parseProfile(readFileSync(file, "utf8"), "default"));
    // the frozen builtin seed was never mutated
    assert.equal(cliProfiles.BUILTIN_CLI_PROFILES.default?.engine.gateMode, "warn");
  } finally {
    if (prev !== undefined) process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile edit non-TTY prints the path + exit 0, never spawns the editor (CLI-044)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-prof-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    let spawned = false;
    const deps: ProfileCmdDeps = {
      openEditor: () => {
        spawned = true;
        return 0;
      },
      isTTY: false,
    };
    const ed = runProfile(["profile", "edit"], pctx(["ci"]), deps);
    assert.equal(ed.exitCode, 0);
    assert.equal(spawned, false);
  } finally {
    if (prev !== undefined) process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("config set: misspelled known key warns+suggests (still writes); type refusal on known key (CLI-045)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-cfg2-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    // misspelled → unknown key → warn + "did you mean" + STILL writes (exit 0, forward-compat)
    const warn = runConfig(["config", "set"], pctx(["profile.activ", "ci"]));
    assert.equal(warn.exitCode, 0);
    assert.match(warn.text ?? "", /did you mean "profile.active"/);
    assert.equal((warn.json as { warning?: string }).warning, "unknown-key");
    // type refusal: profile.active is a string key; "true" coerces to boolean → refused exit 2
    const bad = runConfig(["config", "set"], pctx(["profile.active", "true"]));
    assert.equal(bad.exitCode, 2);
    assert.equal((bad.json as { error: string }).error, "type-mismatch");
    assert.equal((bad.json as { expected: string }).expected, "string");
    // a valid string value is accepted
    assert.equal(runConfig(["config", "set"], pctx(["profile.active", "ci"])).exitCode, 0);
  } finally {
    if (prev !== undefined) process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("config list: schema keys with default/user provenance + warnings; --json shape (CLI-045)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-cfg3-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    runConfig(["config", "set"], pctx(["profile.active", "ci"]));
    runConfig(["config", "set"], pctx(["extra.k", "1"])); // unknown → warns but writes
    const list = runConfig(["config", "list"], pctx([], {}, true));
    const env = list.json as {
      config: { key: string; value: unknown; source: string }[];
      warnings: string[];
    };
    assert.equal(env.config.find((c) => c.key === "profile.active")?.source, "user");
    assert.ok(env.config.some((c) => c.key === "extra.k" && c.source === "user"));
    assert.ok(env.warnings.some((w) => w.includes("extra.k")));
    // text mode has the aligned SOURCE column
    const txt = runConfig(["config", "list"], pctx([]));
    assert.match(txt.text ?? "", /SOURCE/);
    assert.match(txt.text ?? "", /profile\.active/);
  } finally {
    if (prev !== undefined) process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("project .prom.toml pins model over the user profile; PROM_NO_PROJECT_CONFIG opts out (CLI-046)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-proj-"));
  const prevHome = process.env.HOME;
  const prevOpt = process.env.PROM_NO_PROJECT_CONFIG;
  process.env.HOME = home;
  // biome-ignore lint/performance/noDelete: ensure the opt-out is truly unset for the first assertion
  delete process.env.PROM_NO_PROJECT_CONFIG;
  try {
    const repo = join(home, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: /elsewhere\n"); // a .git FILE (worktree form)
    writeFileSync(join(repo, ".prom.toml"), '[agent]\nmodel = "project-pinned-model"\n');
    const parsed = { cwd: join(repo, "src") } as unknown as ParsedArgs;
    // project layer wins over user/builtin
    assert.equal(loadEffectiveStartupProfile(parsed).agent.model, "project-pinned-model");
    // opt-out → discovery skipped → NOT the project model (the builtin default instead)
    process.env.PROM_NO_PROJECT_CONFIG = "1";
    assert.notEqual(loadEffectiveStartupProfile(parsed).agent.model, "project-pinned-model");
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    if (prevOpt !== undefined) process.env.PROM_NO_PROJECT_CONFIG = prevOpt;
    else {
      // biome-ignore lint/performance/noDelete: restore truly-unset
      delete process.env.PROM_NO_PROJECT_CONFIG;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
