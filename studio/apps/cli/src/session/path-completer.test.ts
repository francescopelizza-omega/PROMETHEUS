/**
 * path-completer.test.ts — the readline filesystem completer. A FAKE fs (no disk)
 * drives the directory listing so the [hits, line] contract + dir trailing-slash +
 * prefix filtering + ~ handling are deterministic.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type CompleterFs,
  completePath,
  createPathCycler,
  longestCommonPrefix,
} from "./path-completer.js";

/** A fake fs: a map of dir → entries, and a set of dirs (everything else is a file). */
function fakeFs(tree: Record<string, string[]>, dirs: string[]): CompleterFs {
  const dirSet = new Set(dirs);
  return {
    readdirSync: (p) => {
      const key = p.replace(/\/$/, "") || "/";
      const v = tree[key] ?? tree[p];
      if (!v) throw new Error("ENOENT");
      return v;
    },
    isDir: (p) => dirSet.has(p),
  };
}

test("completePath: lists a dir's entries, dirs get a trailing slash, files do not", () => {
  const fs = fakeFs({ "/proj": ["src", "README.md", "package.json"] }, ["/proj", "/proj/src"]);
  const [hits, line] = completePath("/proj/", fs);
  assert.equal(line, "/proj/");
  assert.ok(hits.includes("/proj/src/")); // dir → trailing slash
  assert.ok(hits.includes("/proj/README.md")); // file → no slash
});

test("completePath: filters by the typed fragment (prefix)", () => {
  const fs = fakeFs({ "/proj": ["src", "scripts", "README.md"] }, [
    "/proj",
    "/proj/src",
    "/proj/scripts",
  ]);
  const [hits] = completePath("/proj/sc", fs);
  assert.deepEqual(hits.sort(), ["/proj/scripts/"]); // only "sc*" — and it's a dir
});

test("completePath: every hit startsWith(line) (readline contract)", () => {
  const fs = fakeFs({ "/x": ["alpha", "beta"] }, ["/x", "/x/alpha", "/x/beta"]);
  const [hits, line] = completePath("/x/a", fs);
  assert.ok(hits.every((h) => h.startsWith(line)));
  assert.deepEqual(hits, ["/x/alpha/"]);
});

test("completePath: ~ is expanded to list $HOME but preserved in the hit", () => {
  const home = homedir();
  const fs = fakeFs({ [home]: ["Documents", "Downloads"] }, [
    home,
    join(home, "Documents"),
    join(home, "Downloads"),
  ]);
  const [hits] = completePath("~/Do", fs);
  assert.ok(hits.includes("~/Documents/"));
  assert.ok(hits.includes("~/Downloads/"));
  assert.ok(hits.every((h) => h.startsWith("~/Do")));
});

test("completePath: '~/' lists $HOME (preserves the trailing slash, not the parent)", () => {
  const home = homedir();
  const fs = fakeFs({ [home]: ["Documents", "Desktop"] }, [
    home,
    join(home, "Documents"),
    join(home, "Desktop"),
  ]);
  const [hits] = completePath("~/", fs);
  assert.ok(hits.includes("~/Documents/"));
  assert.ok(hits.includes("~/Desktop/"));
});

test("completePath: an EXPLICIT dotfile fragment is not filtered out", () => {
  const home = homedir();
  const fs = fakeFs({ [home]: [".ssh", ".config", "visible"] }, [
    home,
    join(home, ".ssh"),
    join(home, ".config"),
  ]);
  const [hits] = completePath("~/.ss", fs);
  assert.deepEqual(hits, ["~/.ssh/"]);
});

test("completePath: an unreadable dir yields no hits (never throws)", () => {
  const fs = fakeFs({}, []);
  assert.deepEqual(completePath("/nope/x", fs), [[], "/nope/x"]);
});

test("completePath: hidden dotfiles are skipped", () => {
  const fs = fakeFs({ "/h": [".git", "visible"] }, ["/h", "/h/.git", "/h/visible"]);
  const [hits] = completePath("/h/", fs);
  assert.deepEqual(hits, ["/h/visible/"]);
});

// ── CLI-066: dirsOnly + LCP + the Tab cycler ─────────────────────────────────────
test("completePath dirsOnly excludes plain files; default keeps all (CLI-066)", () => {
  const fs = fakeFs({ "/p": ["src", "docs", "README.md", "setup.py"] }, [
    "/p",
    "/p/src",
    "/p/docs",
  ]);
  const [all] = completePath("/p/", fs);
  assert.deepEqual(all.sort(), ["/p/README.md", "/p/docs/", "/p/setup.py", "/p/src/"]);
  const [dirs] = completePath("/p/", fs, { dirsOnly: true });
  assert.deepEqual(dirs.sort(), ["/p/docs/", "/p/src/"]); // files gone, dirs keep the slash
});

test("longestCommonPrefix is byte-wise (CLI-066)", () => {
  assert.equal(longestCommonPrefix(["/p/src/", "/p/setup/"]), "/p/s");
  assert.equal(longestCommonPrefix(["/p/src/"]), "/p/src/");
  assert.equal(longestCommonPrefix([]), "");
  assert.equal(longestCommonPrefix(["abc", "xyz"]), "");
});

test("cycler: common-prefix expansion FIRST, then Tab cycles + wraps (CLI-066)", () => {
  // /p/ has srcA, srcB, srcC dirs — LCP "/p/src" then cycle the three.
  const fs = fakeFs({ "/p": ["srcA", "srcB", "srcC", "other"] }, [
    "/p",
    "/p/srcA",
    "/p/srcB",
    "/p/srcC",
    "/p/other",
  ]);
  const cy = createPathCycler(fs, true);
  // first Tab on "/p/sr" → expands to the common prefix "/p/src" (does NOT cycle yet).
  const e = cy.tab("/p/sr");
  assert.equal(e.buffer, "/p/src");
  assert.equal(e.candidates.length, 3);
  // next Tab (buffer === LCP) begins cycling → first candidate.
  const c1 = cy.tab("/p/src");
  assert.equal(c1.buffer, "/p/srcA/");
  const c2 = cy.tab("/p/srcA/");
  assert.equal(c2.buffer, "/p/srcB/");
  const c3 = cy.tab("/p/srcB/");
  assert.equal(c3.buffer, "/p/srcC/");
  const c4 = cy.tab("/p/srcC/");
  assert.equal(c4.buffer, "/p/srcA/"); // wraps back to the first
});

test("cycler: zero candidates leaves the buffer unchanged, no cycle (CLI-066)", () => {
  const fs = fakeFs({ "/p": ["src"] }, ["/p", "/p/src"]);
  const cy = createPathCycler(fs, true);
  const r = cy.tab("/p/zzz");
  assert.equal(r.buffer, "/p/zzz"); // unchanged
  assert.deepEqual(r.candidates, []);
});

test("cycler: a single candidate completes fully (CLI-066)", () => {
  const fs = fakeFs({ "/p": ["only", "other"] }, ["/p", "/p/only", "/p/other"]);
  const cy = createPathCycler(fs, true);
  assert.equal(cy.tab("/p/on").buffer, "/p/only/"); // unique → full completion + slash
});

test("cycler: reset() makes the next Tab fresh (CLI-066)", () => {
  const fs = fakeFs({ "/p": ["srcA", "srcB"] }, ["/p", "/p/srcA", "/p/srcB"]);
  const cy = createPathCycler(fs, true);
  cy.tab("/p/src"); // begins cycling → srcA
  cy.reset(); // user edited → reset
  const again = cy.tab("/p/src"); // fresh cycle from the top
  assert.equal(again.buffer, "/p/srcA/");
});

test("cycler preserves ~ notation while filtering dirs (CLI-066)", () => {
  const home = homedir();
  const fs = fakeFs({ [home]: ["ALPHA", "AL2", "file.txt"] }, [
    home,
    join(home, "ALPHA"),
    join(home, "AL2"),
  ]);
  const cy = createPathCycler(fs, true);
  // "~/AL" already IS the common prefix of ~/ALPHA/ + ~/AL2/, so the first Tab cycles immediately.
  const c1 = cy.tab("~/AL");
  assert.match(c1.buffer, /^~\/(AL2|ALPHA)\/$/); // ~ preserved + dir slash
  assert.ok(!c1.candidates.some((c) => c.includes("file.txt"))); // file excluded
});
