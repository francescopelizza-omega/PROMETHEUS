/**
 * working-set.test.ts — the §3 applier scope guard.
 *
 * This is the half of the permission story that is NOT a UI. The renderer's permission
 * card can be skipped, bypassed, or simply not rendered; MAIN's guard is what actually
 * stops a write outside the working set. So it gets tests, and the UI does not.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  approveOutsideWorkingSet,
  assertInsideWorkingSet,
  assertNotSensitivePath,
  clearDeclaredRoots,
  clearGrantedRoots,
  clearOutsideApprovals,
  getGrantedRoots,
  getWorkingSetRoots,
  grantWorkingSetRoot,
  initGrantedRoots,
  isGrantedRoot,
  isInsideWorkingSet,
  setWorkingSetRoots,
} from "./path-guard.js";

/** realpath: macOS /var → /private/var, and the guard canonicalises both sides. */
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "prom-ws-")));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), "prom-out-")));

/**
 * Declare a workspace the way the app does: the human picks the folder in MAIN's native
 * dialog (which is what `grantWorkingSetRoot` records), and the renderer then names it as the
 * current workspace. A renderer declaration on its own is refused now — see the narrowing
 * tests at the bottom — so every test that wants a live working set has to grant first.
 */
function openWorkspace(...roots: string[]): void {
  clearGrantedRoots();
  for (const r of roots) grantWorkingSetRoot(r);
  setWorkingSetRoots(roots);
}

test("no roots declared ⇒ the scope check is OFF (a loose file can still be saved)", () => {
  clearGrantedRoots();
  setWorkingSetRoots([]);
  assert.equal(getWorkingSetRoots().length, 0);
  assert.equal(isInsideWorkingSet(join(OUTSIDE, "a.txt")), true);
  assert.doesNotThrow(() => assertInsideWorkingSet(join(OUTSIDE, "a.txt")));
});

test("a path inside the working set is allowed", () => {
  openWorkspace(ROOT);
  assert.equal(isInsideWorkingSet(join(ROOT, "src", "a.ts")), true);
  assert.equal(assertInsideWorkingSet(join(ROOT, "src", "a.ts")), join(ROOT, "src", "a.ts"));
});

test("a path OUTSIDE the working set is REFUSED (fail-closed)", () => {
  openWorkspace(ROOT);
  assert.equal(isInsideWorkingSet(join(OUTSIDE, "evil.sh")), false);
  assert.throws(() => assertInsideWorkingSet(join(OUTSIDE, "evil.sh")), /outside the working set/);
});

test("a sibling directory sharing the root's PREFIX is not inside it", () => {
  // `/tmp/ws` must not admit `/tmp/ws-evil` — a naive startsWith() would.
  openWorkspace(ROOT);
  assert.equal(isInsideWorkingSet(`${ROOT}-evil/x.ts`), false);
  assert.throws(() => assertInsideWorkingSet(`${ROOT}-evil/x.ts`), /outside the working set/);
});

test("`..` cannot escape the root (the path is canonicalised first)", () => {
  openWorkspace(ROOT);
  assert.throws(
    () => assertInsideWorkingSet(join(ROOT, "..", "elsewhere", "x.ts")),
    /outside the working set/,
  );
});

test("an explicit per-path approval admits exactly that path and nothing else", () => {
  openWorkspace(ROOT);
  const approved = join(OUTSIDE, "approved.txt");
  const other = join(OUTSIDE, "other.txt");
  approveOutsideWorkingSet(approved);
  assert.equal(assertInsideWorkingSet(approved), approved);
  // the approval is NOT a wildcard for its directory.
  assert.throws(() => assertInsideWorkingSet(other), /outside the working set/);
});

test("changing the roots INVALIDATES prior approvals (they were granted against the old scope)", () => {
  openWorkspace(ROOT);
  const approved = join(OUTSIDE, "approved.txt");
  approveOutsideWorkingSet(approved);
  assert.doesNotThrow(() => assertInsideWorkingSet(approved));
  openWorkspace(ROOT); // a re-declare is still a scope change
  assert.throws(() => assertInsideWorkingSet(approved), /outside the working set/);
});

test("clearOutsideApprovals forgets every grant", () => {
  openWorkspace(ROOT);
  const approved = join(OUTSIDE, "approved.txt");
  approveOutsideWorkingSet(approved);
  clearOutsideApprovals();
  assert.throws(() => assertInsideWorkingSet(approved), /outside the working set/);
});

test("a file:// uri is accepted and canonicalised like a bare path", () => {
  openWorkspace(ROOT);
  assert.doesNotThrow(() => assertInsideWorkingSet(`file://${join(ROOT, "a.ts")}`));
  assert.throws(
    () => assertInsideWorkingSet(`file://${join(OUTSIDE, "a.ts")}`),
    /outside the working set/,
  );
});

test("multiple roots: inside ANY of them is enough", () => {
  openWorkspace(ROOT, OUTSIDE);
  assert.doesNotThrow(() => assertInsideWorkingSet(join(ROOT, "a.ts")));
  assert.doesNotThrow(() => assertInsideWorkingSet(join(OUTSIDE, "a.ts")));
});

/* ── the renderer may NARROW, never WIDEN ─────────────────────────────────────
 * `setWorkingSetRoots` is an IPC handler, so its argument is whatever the renderer sent —
 * and a renderer is precisely the process this guard exists to survive. It used to accept
 * that list verbatim, which made the guard a one-call bypass in two different ways.
 * ──────────────────────────────────────────────────────────────────────────── */

test("a root the human never opened is REFUSED — the renderer cannot widen its own scope", () => {
  clearGrantedRoots();
  grantWorkingSetRoot(ROOT);
  const res = setWorkingSetRoots([OUTSIDE]);
  assert.deepEqual(res.refused, [OUTSIDE]);
  assert.equal(res.accepted, 0);
  // …and the scope falls back to what the human DID open, never to "no guard".
  assert.deepEqual([...getWorkingSetRoots()], [ROOT]);
  assert.throws(() => assertInsideWorkingSet(join(OUTSIDE, "a.txt")), /outside the working set/);
});

test("declaring `/` does not put the whole filesystem in scope", () => {
  clearGrantedRoots();
  grantWorkingSetRoot(ROOT);
  setWorkingSetRoots(["/"]);
  assert.throws(() => assertInsideWorkingSet(join(OUTSIDE, "a.txt")), /outside the working set/);
});

test("a SUBFOLDER of a granted root is accepted — narrowing is the point", () => {
  clearGrantedRoots();
  grantWorkingSetRoot(ROOT);
  const sub = join(ROOT, "packages", "core");
  const res = setWorkingSetRoots([sub]);
  assert.deepEqual(res.refused, []);
  assert.equal(res.accepted, 1);
  assert.doesNotThrow(() => assertInsideWorkingSet(join(sub, "a.ts")));
  // narrowed: a sibling inside the GRANT but outside the declared workspace is now out
  assert.throws(() => assertInsideWorkingSet(join(ROOT, "elsewhere.ts")), /outside/);
});

test("an EMPTY declaration no longer turns the guard off when the human has opened a folder", () => {
  // `setWorkingSetRoots([])` used to clear the roots, and empty roots meant "allow
  // everything" — a one-call bypass of the whole guard from the renderer.
  clearGrantedRoots();
  grantWorkingSetRoot(ROOT);
  setWorkingSetRoots([ROOT]);
  setWorkingSetRoots([]);
  assert.deepEqual([...getWorkingSetRoots()], [ROOT]);
  assert.throws(() => assertInsideWorkingSet(join(OUTSIDE, "a.txt")), /outside the working set/);
});

test("opening a SECOND folder widens scope — because a human chose it", () => {
  clearGrantedRoots();
  grantWorkingSetRoot(ROOT);
  setWorkingSetRoots([ROOT]);
  assert.throws(() => assertInsideWorkingSet(join(OUTSIDE, "a.txt")), /outside/);
  grantWorkingSetRoot(OUTSIDE); // the native picker returned this path
  setWorkingSetRoots([ROOT, OUTSIDE]);
  assert.doesNotThrow(() => assertInsideWorkingSet(join(OUTSIDE, "a.txt")));
});

test("grants SURVIVE a restart — reopening a recent project is still guarded", () => {
  // The recents list lives in the RENDERER's localStorage, so clicking "recent project" never
  // reaches main's folder dialog. Without persistence the roots would arrive ungranted, be
  // refused, and the no-grants fallback would leave every agent write unchecked — on the path
  // almost every user takes.
  const userData = realpathSync(mkdtempSync(join(tmpdir(), "prom-ud-")));
  clearGrantedRoots();
  initGrantedRoots(userData);
  grantWorkingSetRoot(ROOT);

  // …the app restarts: a brand-new process, nothing in memory.
  clearGrantedRoots();
  initGrantedRoots(userData);
  assert.deepEqual([...getGrantedRoots()], [ROOT]);

  // the renderer reopens the recent project; the declaration is accepted, and OUTSIDE is not
  const res = setWorkingSetRoots([ROOT]);
  assert.equal(res.accepted, 1);
  assert.throws(() => assertInsideWorkingSet(join(OUTSIDE, "a.txt")), /outside the working set/);
});

test("a corrupt or absent grants file yields NO grants — and NO grants must FAIL CLOSED", () => {
  /**
   * The title of this test used to end "— the safe direction", and that premise was WRONG.
   *
   * No grants really does mean no accepted roots, but `workingSetRoots` then fell back to the
   * empty grant set, and an empty working set meant "allow everything" — so the state this test
   * called safe was the fully-OPEN one. Measured: on a fresh (or corrupt) profile,
   * `ide:workingSet.set` refused the declaration and the very next `ide:fs.write` created a file
   * at an arbitrary absolute path. The assertion below is the half that was missing.
   */
  const userData = realpathSync(mkdtempSync(join(tmpdir(), "prom-ud2-")));
  writeFileSync(join(userData, "workspace-grants.json"), "{ not json", "utf8");
  clearGrantedRoots();
  initGrantedRoots(userData);
  assert.deepEqual([...getGrantedRoots()], []);

  // A declaration that is entirely refused must leave the guard CLOSED, not open.
  assert.equal(setWorkingSetRoots([ROOT]).accepted, 0);
  assert.throws(
    () => assertInsideWorkingSet(join(ROOT, "a.txt")),
    /never approved/,
    "a refused declaration left the guard open",
  );
  assert.throws(
    () => assertInsideWorkingSet(join(tmpdir(), "somewhere-else", "evil.txt")),
    /never approved/,
    "an arbitrary absolute path was writable after a refused declaration",
  );
  assert.equal(isInsideWorkingSet(join(ROOT, "a.txt")), false);

  // the human re-picks the folder once and it works again — the latch must not outlive the grant
  grantWorkingSetRoot(ROOT);
  assert.equal(setWorkingSetRoots([ROOT]).accepted, 1);
  assert.doesNotThrow(() => assertInsideWorkingSet(join(ROOT, "a.txt")));
});

test("NOTHING declared yet still allows — the fail-closed latch is only for a REFUSED declaration", () => {
  // the control that keeps the fix from being a blanket ban: before any workspace is declared
  // there is nothing to scope, and denying there would break the app at startup.
  const userData = realpathSync(mkdtempSync(join(tmpdir(), "prom-ud3-")));
  clearGrantedRoots();
  initGrantedRoots(userData);
  clearDeclaredRoots();
  setWorkingSetRoots([]);
  assert.equal(isInsideWorkingSet(join(ROOT, "a.txt")), true);
});

test("the sensitive-path list is canonicalised the same way the probed path is", () => {
  /**
   * regression: the checked path went through `canonical()` (which realpaths its existing
   * ancestor) while `sensitiveDirs()`/`sensitiveFiles()` used plain `resolve()`. Any home that is
   * not already canonical therefore never matched — on macOS `/tmp` → `/private/tmp` is enough to
   * show it. Measured with a symlinked home: `~/.aws/notes.txt`, a file only the DIRECTORY rule
   * can catch, was ALLOWED under both spellings. The hand-written `/private/etc` entry in the
   * list was this same bug, patched once for `/etc` and never generalised.
   */
  const realHome = realpathSync(mkdtempSync(join(tmpdir(), "prom-home-")));
  mkdirSync(join(realHome, ".aws"), { recursive: true });
  writeFileSync(join(realHome, ".aws", "notes.txt"), "aws stuff", "utf8");
  const linkHome = join(dirname(realHome), `${basename(realHome)}-link`);
  symlinkSync(realHome, linkHome);

  const prevHome = process.env.HOME;
  process.env.HOME = linkHome;
  try {
    // notes.txt is caught ONLY by the sensitive-directory rule, never by a basename rule.
    for (const spelling of [
      join(linkHome, ".aws", "notes.txt"),
      join(realHome, ".aws", "notes.txt"),
    ]) {
      assert.throws(
        () => assertNotSensitivePath(spelling),
        /sensitive/i,
        `a credential directory was readable via ${spelling}`,
      );
    }
    // control: an ordinary file under the same home is still fine.
    writeFileSync(join(realHome, "ok.txt"), "hello", "utf8");
    assert.doesNotThrow(() => assertNotSensitivePath(join(linkHome, "ok.txt")));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("isGrantedRoot answers for the grant a DERIVED open may inherit — and nothing wider", () => {
  /**
   * `grantWorkingSetRoot` had exactly one call site (the native Open-Folder dialog), so a repo
   * cloned by the built-in Repo Manager, a worktree cut from a granted repo, and a project opened
   * from Home ▸ recents all had no grant behind them: main refused the declaration and every save
   * in the project on screen was refused. `isGrantedRoot` is what lets main record a grant for a
   * path IT produced from one that was already granted — never for a path the renderer supplied.
   */
  clearGrantedRoots();
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "prom-repo-")));
  const unrelated = realpathSync(mkdtempSync(join(tmpdir(), "prom-other-")));
  assert.equal(isGrantedRoot(repo), false, "nothing is granted before the human acts");

  grantWorkingSetRoot(repo);
  assert.equal(isGrantedRoot(repo), true);
  assert.equal(isGrantedRoot(join(repo, "packages", "core")), true, "inside a grant is granted");
  assert.equal(isGrantedRoot(unrelated), false, "an unrelated tree must NOT inherit");
  assert.equal(isGrantedRoot(""), false);
});

test("a worktree derived from a GRANTED repo becomes writable; one from an ungranted repo does not", () => {
  // the inheritance rule the worktree handler applies, exercised through the guard itself:
  // grant is recorded for the new path only when the SOURCE repo is already granted.
  clearGrantedRoots();
  clearDeclaredRoots();
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "prom-wtrepo-")));
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "prom-wt-")));

  // ungranted parent → the handler would NOT grant, so declaring the worktree is refused
  assert.equal(isGrantedRoot(repo), false);
  assert.equal(setWorkingSetRoots([worktree]).accepted, 0);
  assert.throws(() => assertInsideWorkingSet(join(worktree, "a.txt")), /never approved/);

  // granted parent → the handler grants the derived path, and it becomes writable
  grantWorkingSetRoot(repo);
  assert.equal(isGrantedRoot(repo), true, "precondition: the parent is granted");
  grantWorkingSetRoot(worktree); // what ideWorktreeCreate does when isGrantedRoot(root)
  assert.equal(setWorkingSetRoots([worktree]).accepted, 1);
  assert.doesNotThrow(() => assertInsideWorkingSet(join(worktree, "a.txt")));
});
