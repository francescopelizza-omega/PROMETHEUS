import assert from "node:assert/strict";
import test from "node:test";

import type { CompleterFs } from "../session/path-completer.js";
import {
  EMPTY_PATH_AC,
  acceptPathAc,
  detectPathTrigger,
  isPathOpen,
  movePathAc,
  resolvePathDir,
  syncPathAutocomplete,
} from "./path-mentions.js";

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

/* ── detectPathTrigger ────────────────────────────────────────────────────────── */

test("detectPathTrigger: a bare @ at the caret is an active trigger", () => {
  const t = detectPathTrigger("@", 1);
  assert.deepEqual(t, { start: 0, dirPart: "", frag: "" });
});

test("detectPathTrigger: splits dirPart/frag on the last slash", () => {
  const t = detectPathTrigger("@src/tui/re", 11);
  assert.deepEqual(t, { start: 0, dirPart: "src/tui", frag: "re" });
});

test("detectPathTrigger: a single-level absolute path keeps the leading slash as dirPart", () => {
  const t = detectPathTrigger("@/etc", 5);
  assert.deepEqual(t, { start: 0, dirPart: "/", frag: "etc" });
});

test("detectPathTrigger: a bare trailing slash after the root is also dirPart '/'", () => {
  const t = detectPathTrigger("@/", 2);
  assert.deepEqual(t, { start: 0, dirPart: "/", frag: "" });
});

test("detectPathTrigger: works mid-sentence, anchored at the caret", () => {
  const input = "please check @src/foo and reply";
  const caret = "please check @src/foo".length;
  const t = detectPathTrigger(input, caret);
  assert.deepEqual(t, { start: 13, dirPart: "src", frag: "foo" });
});

test("detectPathTrigger: an email-like a@b is not a mention", () => {
  assert.equal(detectPathTrigger("foo@bar", 7), null);
});

test("detectPathTrigger: a space before the caret (no @ in the current token) closes it", () => {
  assert.equal(detectPathTrigger("@src/foo bar", 12), null);
});

test("detectPathTrigger: an earlier @ mention doesn't hijack the caret elsewhere", () => {
  const input = "@old/path then more text|";
  const caret = input.length - 1; // caret right before the trailing "|", far from "@old"
  assert.equal(detectPathTrigger(input, caret), null);
});

/* ── resolvePathDir ───────────────────────────────────────────────────────────── */

test("resolvePathDir: empty dirPart resolves to baseDir", () => {
  assert.equal(resolvePathDir("", "/proj"), "/proj");
});

test("resolvePathDir: an absolute dirPart is used as-is", () => {
  assert.equal(resolvePathDir("/etc", "/proj"), "/etc");
});

test("resolvePathDir: a relative dirPart resolves against baseDir", () => {
  assert.equal(resolvePathDir("src/tui", "/proj"), "/proj/src/tui");
});

/* ── syncPathAutocomplete ─────────────────────────────────────────────────────── */

test("syncPathAutocomplete: closed entirely when ctx is undefined", () => {
  const state = syncPathAutocomplete("@src/", 5, undefined);
  assert.equal(isPathOpen(state), false);
});

test("syncPathAutocomplete: closed when there's no active trigger", () => {
  const fs = fakeFs({ "/proj": ["src"] }, ["/proj", "/proj/src"]);
  const state = syncPathAutocomplete("no mention here", 5, { baseDir: "/proj", fs });
  assert.equal(isPathOpen(state), false);
});

test("syncPathAutocomplete: blank fragment lists the whole directory, dirs before files", () => {
  const fs = fakeFs({ "/proj": ["zebra.ts", "src", "alpha.ts"] }, ["/proj", "/proj/src"]);
  const state = syncPathAutocomplete("@", 1, { baseDir: "/proj", fs });
  assert.deepEqual(
    state.items.map((i) => i.name),
    ["src/", "alpha.ts", "zebra.ts"],
  );
});

test("syncPathAutocomplete: a fragment fuzzy/fragment-matches, not rigid prefix", () => {
  const fs = fakeFs({ "/proj/src": ["reducer.ts", "autocomplete.ts", "index.ts"] }, ["/proj/src"]);
  const state = syncPathAutocomplete("@src/rdcr", 9, { baseDir: "/proj", fs });
  assert.ok(
    state.items.some((i) => i.name === "reducer.ts"),
    "a fragmented, non-prefix query should still find reducer.ts",
  );
  assert.ok(!state.items.some((i) => i.name === "index.ts"));
});

test("syncPathAutocomplete: dotfiles are hidden unless explicitly typed", () => {
  const fs = fakeFs({ "/proj": [".env", "src"] }, ["/proj", "/proj/src"]);
  const hidden = syncPathAutocomplete("@", 1, { baseDir: "/proj", fs });
  assert.ok(!hidden.items.some((i) => i.name.startsWith(".")));
  const shown = syncPathAutocomplete("@.", 2, { baseDir: "/proj", fs });
  assert.ok(shown.items.some((i) => i.name === ".env"));
});

test("syncPathAutocomplete: directories carry a trailing slash, files do not", () => {
  const fs = fakeFs({ "/proj": ["src", "README.md"] }, ["/proj", "/proj/src"]);
  const state = syncPathAutocomplete("@", 1, { baseDir: "/proj", fs });
  const src = state.items.find((i) => i.isDir);
  const readme = state.items.find((i) => !i.isDir);
  assert.equal(src?.name, "src/");
  assert.equal(readme?.name, "README.md");
});

test("syncPathAutocomplete: a frecency favorite is boosted to the top on a blank fragment", () => {
  const fs = fakeFs({ "/proj": ["aaa.ts", "favorite.ts"] }, ["/proj"]);
  const state = syncPathAutocomplete("@", 1, {
    baseDir: "/proj",
    fs,
    frecencyForDir: () => new Map([["favorite.ts", 100]]),
  });
  assert.equal(state.items[0]?.name, "favorite.ts");
});

test("syncPathAutocomplete: an unreadable directory yields an empty (not throwing) list", () => {
  const fs = fakeFs({}, []);
  const state = syncPathAutocomplete("@nowhere/", 9, { baseDir: "/proj", fs });
  assert.deepEqual(state.items, []);
});

test("syncPathAutocomplete: reuses the cached listing when the directory hasn't changed", () => {
  let reads = 0;
  const real = fakeFs({ "/proj": ["reducer.ts", "autocomplete.ts"] }, ["/proj"]);
  const counting: CompleterFs = {
    readdirSync: (p) => {
      reads += 1;
      return real.readdirSync(p);
    },
    isDir: real.isDir,
  };
  const ctx = { baseDir: "/proj", fs: counting };
  const first = syncPathAutocomplete("@r", 2, ctx);
  assert.equal(reads, 1);
  const second = syncPathAutocomplete("@re", 3, ctx, first);
  assert.equal(reads, 1, "typing another char in the SAME directory must not re-read the disk");
  assert.ok(second.items.some((i) => i.name === "reducer.ts"));
});

test("syncPathAutocomplete: moving to a DIFFERENT directory re-reads the disk", () => {
  let reads = 0;
  const real = fakeFs({ "/proj": ["src"], "/proj/src": ["reducer.ts"] }, ["/proj", "/proj/src"]);
  const counting: CompleterFs = {
    readdirSync: (p) => {
      reads += 1;
      return real.readdirSync(p);
    },
    isDir: real.isDir,
  };
  const ctx = { baseDir: "/proj", fs: counting };
  const first = syncPathAutocomplete("@", 1, ctx);
  assert.equal(reads, 1);
  const second = syncPathAutocomplete("@src/", 5, ctx, first);
  assert.equal(reads, 2);
  assert.ok(second.items.some((i) => i.name === "reducer.ts"));
});

/* ── movePathAc ───────────────────────────────────────────────────────────────── */

test("movePathAc: wraps in both directions", () => {
  const fs = fakeFs({ "/proj": ["a", "b", "c"] }, []);
  const state = syncPathAutocomplete("@", 1, { baseDir: "/proj", fs });
  assert.equal(state.items.length, 3);
  const up = movePathAc(state, -1);
  assert.equal(up.index, 2);
  const wrapped = movePathAc(up, 1);
  assert.equal(wrapped.index, 0);
});

test("movePathAc: a no-op on an empty (closed) state", () => {
  assert.equal(movePathAc(EMPTY_PATH_AC, 1), EMPTY_PATH_AC);
});

/* ── acceptPathAc ─────────────────────────────────────────────────────────────── */

test("acceptPathAc: a directory keeps the mention open one level deeper (trailing slash, no space)", () => {
  const fs = fakeFs({ "/proj": ["src"] }, ["/proj", "/proj/src"]);
  const state = syncPathAutocomplete("@src", 4, { baseDir: "/proj", fs });
  const accepted = acceptPathAc("@src", state);
  assert.ok(accepted);
  assert.equal(accepted!.input, "@src/");
  assert.equal(accepted!.cursor, 5);
  assert.equal(accepted!.acceptedPath, undefined, "no frecency hit on an intermediate directory");
});

test("acceptPathAc: a file closes the mention (trailing space) and reports its resolved path", () => {
  const fs = fakeFs({ "/proj/src": ["reducer.ts"] }, ["/proj/src"]);
  const state = syncPathAutocomplete("@src/red", 8, { baseDir: "/proj", fs });
  const accepted = acceptPathAc("@src/red", state);
  assert.ok(accepted);
  assert.equal(accepted!.input, "@src/reducer.ts ");
  assert.equal(accepted!.acceptedPath, "/proj/src/reducer.ts");
});

test("acceptPathAc: splices correctly mid-sentence, preserving the tail", () => {
  const fs = fakeFs({ "/proj": ["reducer.ts"] }, ["/proj"]);
  const input = "please check @red for bugs";
  const caret = "please check @red".length;
  const state = syncPathAutocomplete(input, caret, { baseDir: "/proj", fs });
  const accepted = acceptPathAc(input, state);
  assert.ok(accepted);
  assert.equal(accepted!.input, "please check @reducer.ts for bugs");
});

test("acceptPathAc: a single-level absolute path (@/e) lists the filesystem ROOT, not baseDir, and splices cleanly", () => {
  const fs = fakeFs({ "/": ["etc", "usr"] }, ["/", "/etc", "/usr"]);
  const state = syncPathAutocomplete("@/e", 3, { baseDir: "/proj", fs });
  assert.equal(state.dirPath, "/", "must resolve against the filesystem root, not baseDir");
  assert.ok(state.items.some((i) => i.name === "etc/"));
  const accepted = acceptPathAc("@/e", state);
  assert.ok(accepted);
  assert.equal(
    accepted!.input,
    "@/etc/",
    "the leading '/' must survive the splice, not be dropped",
  );
});

test("acceptPathAc: null when nothing is highlighted / no active trigger", () => {
  assert.equal(acceptPathAc("no mention", EMPTY_PATH_AC), null);
});
