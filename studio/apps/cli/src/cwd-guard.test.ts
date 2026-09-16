/**
 * cwd-guard.test.ts — Prometheus can never operate with a cwd inside its OWN source repo.
 *
 * Exercises the REAL discovery mechanism end-to-end (not a fake fs) — this test file itself
 * runs from inside the real prometheus-studio checkout, so `ownRepoRoot()` genuinely finds it,
 * exactly as it would for a real user running the CLI from a clone of this repo. The pure
 * matching logic itself (findOwnWorkspaceRoot/isInsideRepo/guardCwd) already has its own
 * fake-fs unit tests in core's own-repo-guard.test.ts; this file is the integration proof that
 * this app's real wiring finds the real repo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  guardOwnRepo,
  ownRepoRoot,
  resetCwdNoticeCache,
  resetOwnRepoRootCache,
  resolveCwd,
  resolveCwdMove,
} from "./cwd-guard.js";

test("ownRepoRoot(): resolves to the real prometheus-studio checkout when running from inside it", () => {
  const root = ownRepoRoot();
  assert.ok(root, "expected to find the real repo root while running inside it");
});

test("guardOwnRepo(): a path inside this real repo IS redirected to the real home directory", () => {
  const root = ownRepoRoot();
  assert.ok(root);
  const target = join(root as string, "apps", "cli", "src");
  const result = guardOwnRepo(target);
  assert.equal(result.redirected, true);
  assert.equal(result.cwd, homedir());
  assert.equal(result.requestedCwd, target);
});

test("guardOwnRepo(): the repo root itself is redirected too, not just a nested subdirectory", () => {
  const root = ownRepoRoot();
  assert.ok(root);
  assert.equal(guardOwnRepo(root as string).redirected, true);
});

test("guardOwnRepo(): an unrelated path is never redirected", () => {
  const result = guardOwnRepo("/tmp/some-other-project");
  assert.equal(result.redirected, false);
  assert.equal(result.cwd, "/tmp/some-other-project");
});

test("resolveCwd(): defaults to process.cwd() when no explicit request is given, going through the SAME guard", () => {
  // The test runner invokes from the repo root, so process.cwd() is genuinely inside it — this
  // proves the fallback path is guarded exactly like an explicit request, not a separate one
  // that forgot to be.
  const notes: string[] = [];
  const cwd = resolveCwd(undefined, (l) => notes.push(l));
  assert.equal(cwd, homedir());
  assert.ok(
    notes.some((n) => n.includes("redirected")),
    `expected a redirect notice, got: ${JSON.stringify(notes)}`,
  );
});

test("resolveCwd(): an explicit request outside the repo passes through untouched, no notice printed", () => {
  const notes: string[] = [];
  const cwd = resolveCwd("/tmp/some-other-project", (l) => notes.push(l));
  assert.equal(cwd, "/tmp/some-other-project");
  assert.deepEqual(notes, []);
});

test("resolveCwd(): still redirects correctly with no `write` callback at all", () => {
  const root = ownRepoRoot();
  assert.ok(root);
  const cwd = resolveCwd(root as string); // no write() passed — must not throw, must still redirect
  assert.equal(cwd, homedir());
});

test("the redirect notice is printed ONCE per process, not once per resolveCwd call", () => {
  /**
   * A single `prometheus` run resolves the cwd twice whenever the modern TUI cannot start: the
   * TUI bridge resolves it (session-bridge.ts:430), throws afterwards, and the readline host
   * resolves it again (host.ts:593). The user saw the same "refuses to operate inside its own
   * repository" warning twice, in consecutive lines — reported verbatim from a real session.
   *
   * The REDIRECT is not deduplicated: both callers must still get the safe path back.
   */
  resetCwdNoticeCache();
  resetOwnRepoRootCache("/repo");
  const lines: string[] = [];
  const w = (l: string): void => void lines.push(l);

  const first = resolveCwd("/repo/apps/cli", w);
  const second = resolveCwd("/repo/apps/cli", w);
  assert.equal(lines.length, 1, `warned ${lines.length} times:\n${lines.join("\n")}`);
  assert.match(lines[0] ?? "", /refuses to operate inside its own repository/);
  assert.equal(second, first, "the second caller must still be redirected");
  assert.notEqual(second, "/repo/apps/cli");

  // a DIFFERENT redirect is its own notice — this dedupes repeats, it does not silence news
  resolveCwd("/repo/packages/core", w);
  assert.equal(lines.length, 2);

  // …and a fresh process starts over
  resetCwdNoticeCache();
  resolveCwd("/repo/apps/cli", w);
  assert.equal(lines.length, 3);

  resetOwnRepoRootCache();
  resetCwdNoticeCache();
});

/* -- resolveCwdMove: the ONE resolver /cwd, /cd and /worktree switch share -- */

/** A stat double: `dirs` exist as directories, `files` exist as files, anything else ENOENT. */
function fakeStat(dirs, files = []) {
  return {
    statSync(p) {
      if (dirs.includes(p)) return { isDirectory: () => true };
      if (files.includes(p)) return { isDirectory: () => false };
      const e = new Error(`ENOENT: ${p}`);
      e.code = "ENOENT";
      throw e;
    },
  };
}

test("resolveCwdMove REFUSES a directory that does not exist", () => {
  // This is the whole defect: /cd validated with statSync and /cwd did not, so
  // `/cwd /definitely/not/here` printed a confident `cwd -> /definitely/not/here` and pointed
  // the session, its agent files, its permission rules and its repo map at nothing.
  const r = resolveCwdMove("/definitely/not/here", "/tmp", fakeStat([]));
  assert.equal(r.ok, false);
  assert.match(r.error, /no such directory: \/definitely\/not\/here/);
});

test("resolveCwdMove refuses a FILE, not just a missing path", () => {
  const r = resolveCwdMove("/tmp/notes.md", "/tmp", fakeStat([], ["/tmp/notes.md"]));
  assert.equal(r.ok, false);
  assert.match(r.error, /not a directory/);
});

test("a RELATIVE path resolves against the session cwd, never process.cwd()", () => {
  // the CLI never chdir's, so `process.cwd()` is the launch directory forever
  const r = resolveCwdMove("alpha/beta", "/work/proj", fakeStat(["/work/proj/alpha/beta"]));
  assert.equal(r.ok, true);
  assert.equal(r.cwd, "/work/proj/alpha/beta");
});

test("`..` walks up from the session cwd", () => {
  const r = resolveCwdMove("../..", "/a/b/c", fakeStat(["/a"]));
  assert.equal(r.ok, true);
  assert.equal(r.cwd, "/a");
});

test("a tilde path expands to HOME, not to a literal ./~", () => {
  // isAbsolute("~/x") is false, so without the expansion this resolves against the CURRENT
  // directory and silently creates a nonsense target.
  const home = homedir();
  const r = resolveCwdMove("~/projects", "/somewhere/else", fakeStat([join(home, "projects")]));
  assert.equal(r.ok, true);
  assert.equal(r.cwd, join(home, "projects"));
});

test("an empty argument is refused rather than resolving to the cwd", () => {
  assert.equal(resolveCwdMove("   ", "/tmp", fakeStat(["/tmp"])).ok, false);
});

test("the own-repo guard still applies, and reports what it redirected FROM", () => {
  const inside = join(ownRepoRoot() ?? "/nonexistent-repo", "apps");
  const r = resolveCwdMove(inside, "/tmp", fakeStat([homedir(), inside]));
  if (ownRepoRoot()) {
    assert.equal(r.ok, true);
    assert.equal(r.cwd, homedir(), "a move into Prometheus's own repo lands at home");
    assert.equal(r.redirectedFrom, inside);
  }
});

/* -- DRIFT GUARDS: both hosts share the resolver, and every move refreshes the frame -- */

const HOSTS = [
  ["apps/cli/src/tui/session-bridge.ts", "the raw-mode TUI"],
  ["apps/cli/src/session/host.ts", "the readline host"],
];

function hostSrc(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "..", "..", rel), "utf8");
}

test("DRIFT GUARD: both hosts resolve /cwd through the shared resolver", () => {
  // Each host carried its own expand -> resolve -> guard sequence, and only /cd's copy had
  // ever grown the existence check. A twin is how one of them silently stops validating.
  for (const [rel, name] of HOSTS) {
    const s = hostSrc(rel);
    // setCwd resolves through the shared helper (which itself calls resolveCwdMove), and
    // RETURNS the result so the command layer can offer to create a missing directory.
    assert.match(
      s,
      /const move = resolveMoveMaybeCreating\(dir, opts\?\.create === true\)/,
      `${name}: setCwd`,
    );
    assert.match(s, /if \(!move\.ok\) return move;/, `${name}: swallows the failure again`);
    // …and /cd goes through the SAME helper — it used to hand-roll expand→resolve→guard→stat.
    assert.match(
      s,
      /const move = resolveMoveMaybeCreating\(dir, opts\?\.create === true\);\n\s*if \(!move\.ok\) \{\n\s*return \{/,
      `${name}: changeProjectDirectory hand-rolls its own resolution`,
    );
    assert.doesNotMatch(s, /stat = statSync\(target\)/, `${name}: the hand-rolled stat is back`);
    assert.doesNotMatch(
      s,
      /setCwd: \(dir\) => \{[\s\S]{0,400}?const guard = guardOwnRepo\(requested\)/,
      `${name}: the hand-rolled sequence is back in setCwd`,
    );
  }
});

test("DRIFT GUARD: every project move re-prints the frame, in both hosts", () => {
  // /cwd, /cd and /worktree switch all funnel through moveProjectRoot, so the announce lives
  // THERE - putting it in setCwd alone would leave /cd showing a stale header.
  for (const [rel, name] of HOSTS) {
    const s = hostSrc(rel);
    assert.match(s, /const announceCwd = /, `${name}: no announce`);
    const move = /const moveProjectRoot = \(target: string\): void => \{[\s\S]*?\n {2}\};/.exec(s);
    assert.ok(move, `${name}: moveProjectRoot not found`);
    assert.match(move[0], /announceCwd\(target\)/, `${name}: a move does not refresh the frame`);
  }
});

test("DRIFT GUARD: the status chip re-reads the cwd every frame", () => {
  // The bottom-right chip is correct only because render() calls statusModel() fresh; hoisting
  // that call out of render would freeze the chip at the launch directory.
  const app = hostSrc("apps/cli/src/tui/app.ts");
  assert.match(app, /function render\(\): void \{[\s\S]{0,300}?status: session\.statusModel\(\)/);
});

test("DRIFT GUARD: /cwd only claims a move when one happened", () => {
  const reg = hostSrc("apps/cli/src/session/slash-registry.ts");
  // the success line is reachable only after `move.ok`, and the failure path says where you
  // still are rather than printing a confident `cwd → <the place you failed to reach>`.
  assert.match(reg, /if \(!move\.ok\) \{[\s\S]{0,200}?still in \$\{ctx\.cwd\(\)\}/);
  assert.match(reg, /ctx\.write\(c\.dim\(`cwd → \$\{move\.cwd\}`\)\)/);
});

test("DRIFT GUARD: BOTH commands offer to create a missing directory", () => {
  const reg = hostSrc("apps/cli/src/session/slash-registry.ts");
  assert.match(reg, /async function offerToCreate\(/);
  // default NO — a typo'd `/cd BUMBLBEE` must not scatter a misspelled folder
  assert.match(reg, /Create it\? \[y\/N\]/);
  // /cwd
  assert.match(
    reg,
    /move = \(await offerToCreate\(ctx, move\.path\)\) \? ctx\.setCwd\(dir, \{ create: true \}\) : move/,
  );
  // /cd — the rotating path AND the degraded fallback
  assert.match(reg, /ctx\.changeProjectDirectory\(dir, \{ create: true \}\)/);
  assert.match(
    reg,
    /m = \(await offerToCreate\(ctx, m\.path\)\) \? ctx\.setCwd\(dir, \{ create: true \}\) : m/,
  );
});

test("DRIFT GUARD: mkdir runs only for a MISSING target, and re-resolves after", () => {
  for (const [rel, name] of HOSTS) {
    const s = hostSrc(rel);
    assert.match(
      s,
      /if \(first\.ok \|\| !create \|\| !first\.missing \|\| !first\.path\) return first;/,
      `${name}: mkdir is no longer gated on the missing case`,
    );
    assert.match(s, /mkdirSync\(first\.path, \{ recursive: true \}\)/, `${name}: no mkdir -p`);
    assert.match(
      s,
      /return resolveCwdMove\(dir, state\.cwd\);\n\s*\};/,
      `${name}: trusts the mkdir instead of re-resolving`,
    );
  }
});

/* -- resolveCwdMove classifies WHY it failed, so only a gap is offerable as "create it?" -- */

test("a missing target is flagged `missing` with the resolved path to create", () => {
  const r = resolveCwdMove("new/project", "/work", fakeStat([]));
  assert.equal(r.ok, false);
  assert.equal(r.missing, true);
  assert.equal(r.path, "/work/new/project", "the path to mkdir is the RESOLVED one");
});

test("a FILE in the way is not offerable — mkdir -p would fail anyway", () => {
  const r = resolveCwdMove("/tmp/notes.md", "/tmp", fakeStat([], ["/tmp/notes.md"]));
  assert.equal(r.ok, false);
  assert.notEqual(r.missing, true, "a file is an answer, not a gap");
  assert.equal(r.path, "/tmp/notes.md");
});

test("an unreadable target is not offerable either", () => {
  const eacces = {
    statSync() {
      const e = new Error("EACCES");
      e.code = "EACCES";
      throw e;
    },
  };
  const r = resolveCwdMove("/root/private", "/tmp", eacces);
  assert.equal(r.ok, false);
  assert.notEqual(r.missing, true);
  assert.match(r.error, /cannot access/);
});

test("the offered path has the own-repo guard and tilde expansion ALREADY applied", () => {
  // whatever we mkdir must be exactly the directory we would then move to - resolving twice
  // with different rules is how you create one folder and move to another.
  const home = homedir();
  const r = resolveCwdMove("~/brand/new", "/elsewhere", fakeStat([]));
  assert.equal(r.missing, true);
  assert.equal(r.path, join(home, "brand", "new"));
});
