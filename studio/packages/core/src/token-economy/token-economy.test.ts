import assert from "node:assert/strict";
/**
 * token-economy.test.ts — the curated toolkit registry, the paid/free proposer, and
 * the honest Gemini-Nano assessment.
 */
import { test } from "node:test";

import {
  DEFAULT_IGNORE_DIRS,
  GEMINI_NANO,
  type RepoDirent,
  type RepoFs,
  TOKEN_TOOLS,
  estimateTokens,
  extractSymbols,
  getTokenTool,
  isGitIgnored,
  parseGitignore,
  proposeToolkits,
  renderCodebaseOverview,
  renderRepoMap,
  summarizeCodebase,
  walkRepo,
} from "./index.js";

test("registry: every tool has an honest tradeoff note + a saving", () => {
  assert.ok(TOKEN_TOOLS.length >= 10);
  for (const t of TOKEN_TOOLS) {
    assert.ok(t.notes.length > 0, `${t.id} must state its tradeoff`);
    assert.ok(t.tokenSaving.length > 0, `${t.id} must state its saving`);
  }
  assert.ok(getTokenTool("terse-output"));
});

test("propose: paid model leads with prompt caching + terse output (the $ savers)", () => {
  const paid = proposeToolkits({ usingPaidModel: true });
  assert.ok(paid.length >= 3);
  const ids = paid.map((t) => t.id);
  assert.ok(ids.includes("prompt-caching"), "paid users should be offered caching");
  assert.ok(ids.includes("terse-output"));
  // experimental tools are not in the default proposal
  assert.ok(!ids.includes("gemini-nano-chrome"));
});

test("propose: free-local user is NOT pushed paid-only tools by default", () => {
  const free = proposeToolkits({ usingPaidModel: false });
  const ids = free.map((t) => t.id);
  assert.ok(
    !ids.includes("prompt-caching"),
    "caching is paid-closed-only — not for a free-local user",
  );
  assert.ok(ids.includes("local-model-default"), "free-local user gets the local-model nudge");
});

test("propose includeOptIn surfaces the full menu (incl. experimental nano)", () => {
  const all = proposeToolkits({ usingPaidModel: true, includeOptIn: true });
  assert.ok(all.some((t) => t.id === "gemini-nano-chrome"));
  assert.ok(all.some((t) => t.id === "local-code-rag"));
});

test("gemini nano: PARTIAL, account-free, weights NOT redistributable, no weight extraction endorsed", () => {
  assert.equal(GEMINI_NANO.feasible, "partial");
  assert.equal(GEMINI_NANO.accountRequired, false);
  assert.equal(GEMINI_NANO.weightsRedistributable, false);
  // the leaked-weights method must be present but NOT endorsed
  const leaked = GEMINI_NANO.methods.find((m) => m.reliability === "unsupported");
  assert.ok(
    leaked && leaked.endorsed === false,
    "weight extraction must be documented but never endorsed",
  );
  // the legit Chrome path is endorsed + account-free
  const chrome = GEMINI_NANO.methods.find((m) => /Chrome Built-in/.test(m.method));
  assert.ok(chrome?.endorsed && chrome.accountRequired === false);
  assert.ok(GEMINI_NANO.alternatives.length >= 3, "must offer open alternatives");
});

// ── CLI-053: the built-in repo map (file tree + exported symbols) ────────────────
/** Build a PURE fake RepoFs from a flat path→content map (dirs are implied). */
function fakeFs(files: Record<string, string>): RepoFs {
  const has = (p: string): boolean => Object.prototype.hasOwnProperty.call(files, p);
  const childrenOf = (dir: string): RepoDirent[] => {
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map<string, boolean>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  };
  return {
    readdir: (dir) => childrenOf(dir),
    readFile: (p) => {
      if (!has(p)) throw new Error(`ENOENT ${p}`);
      return files[p] as string;
    },
    statSize: (p) => {
      if (!has(p)) throw new Error(`ENOENT ${p}`);
      return (files[p] as string).length;
    },
  };
}

test("estimateTokens is the identical chars/4 ceil heuristic session-bridge uses (CLI-053)", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2); // ceil(5/4)
  assert.equal(estimateTokens(""), 0);
});

test("extractSymbols: TS named/default/re-exports, python top-level, md headings, unknown (CLI-053)", () => {
  const ts = extractSymbols(
    "x.ts",
    [
      "export function foo() {}",
      "export const bar = 1;",
      "export class Baz {}",
      "export interface Qux {}",
      "export type Quux = string;",
      "export default function main() {}",
      "export { a, b as c } from './y';",
      "export * as ns from './z';",
      "  const notExported = 2;", // not exported → absent
    ].join("\n"),
  );
  assert.deepEqual(ts, ["foo", "bar", "Baz", "Qux", "Quux", "main", "ns", "a", "c"]);
  assert.ok(!ts.includes("notExported"));

  const py = extractSymbols(
    "m.py",
    [
      "def top():",
      "    def nested():",
      "        pass",
      "class Thing:",
      "    def method(self):",
    ].join("\n"),
  );
  assert.deepEqual(py, ["top", "Thing"]); // only column-0 def/class

  assert.deepEqual(extractSymbols("README.md", "# Title\n## Section\ntext"), ["Title", "Section"]);
  assert.deepEqual(extractSymbols("data.bin", "anything"), []); // unknown/binary ext → []
});

test("walkRepo: ignores node_modules/.git, sorts deterministically, extracts symbols (CLI-053)", () => {
  const fs = fakeFs({
    "src/justify.ts": "export function justify() {}",
    "src/a.ts": "export const a = 1;",
    ".git/config": "[core]",
    "node_modules/dep/index.js": "export const dep = 1;",
    "dist/bundle.js": "export const x = 1;",
    "README.md": "# Hello",
  });
  const map = walkRepo(fs, "");
  const paths = map.entries.map((e) => e.path);
  assert.deepEqual(paths, ["README.md", "src/a.ts", "src/justify.ts"]); // sorted; ignores excluded
  const justify = map.entries.find((e) => e.path === "src/justify.ts");
  assert.deepEqual(justify?.symbols, ["justify"]);
  assert.equal(map.truncated, false);
});

test("walkRepo: fileCap truncates and sets the flag (CLI-053)", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`f${i}.ts`] = `export const v${i} = ${i};`;
  const map = walkRepo(fakeFs(files), "", { fileCap: 4 });
  assert.equal(map.entries.length, 4);
  assert.equal(map.truncated, true);
});

test("walkRepo: oversized files listed by name only, never parsed (CLI-053)", () => {
  const big = `export const huge = "${"x".repeat(2000)}";`;
  const map = walkRepo(fakeFs({ "big.ts": big, "small.ts": "export const s = 1;" }), "", {
    maxReadBytes: 100,
  });
  assert.deepEqual(map.entries.find((e) => e.path === "big.ts")?.symbols, []); // size-gated: no read
  assert.deepEqual(map.entries.find((e) => e.path === "small.ts")?.symbols, ["s"]);
});

test("gitignore: parse + match honors comments, negation, dir-only, anchoring, *.ext (CLI-053)", () => {
  const rules = parseGitignore(
    ["# comment", "", "secret.txt", "*.log", "/build", "temp/", "!keep.log"].join("\n"),
  );
  assert.ok(isGitIgnored(rules, "secret.txt", "secret.txt", false));
  assert.ok(isGitIgnored(rules, "deep/a.log", "a.log", false)); // *.log basename glob
  assert.ok(!isGitIgnored(rules, "keep.log", "keep.log", false)); // negation re-includes
  assert.ok(isGitIgnored(rules, "build", "build", true)); // anchored dir
  assert.ok(isGitIgnored(rules, "temp", "temp", true)); // dir-only matches a dir
  assert.ok(!isGitIgnored(rules, "temp", "temp", false)); // dir-only does NOT match a file
});

test("gitignore: a pattern with a MIDDLE slash but no LEADING one still anchors (git's real rule, not just 'starts with /')", () => {
  // The bug: a pattern like "apps/vscode-extension/.vscode-test/" (a slash in the middle, none
  // at the front) used to be treated as NOT anchored, falling through to basename-only matching
  // against a bare ".vscode-test" — which can never match a multi-segment relative path, so the
  // directory was never actually ignored despite looking exactly like it should be.
  const rules = parseGitignore("apps/vscode-extension/.vscode-test/\n");
  assert.ok(
    isGitIgnored(rules, "apps/vscode-extension/.vscode-test", ".vscode-test", true),
    "a middle-slash pattern must anchor to the full relative path, exactly like a leading-slash one",
  );
  assert.ok(
    !isGitIgnored(rules, "somewhere-else/.vscode-test", ".vscode-test", true),
    "anchoring means the match is against the FULL path, not just the basename",
  );
  // A same-named directory living directly at the anchor's own path segment, but NOT nested
  // under "apps/vscode-extension", must not be affected.
  assert.ok(!isGitIgnored(rules, ".vscode-test", ".vscode-test", true));
});

test("walkRepo: honors the root .gitignore (CLI-053)", () => {
  const fs = fakeFs({
    ".gitignore": "*.log\nignored/\n",
    "app.ts": "export const app = 1;",
    "debug.log": "noise",
    "ignored/x.ts": "export const x = 1;",
  });
  const paths = walkRepo(fs, "").entries.map((e) => e.path);
  // .gitignore is itself a real tracked file (kept); it excludes the log + the ignored/ dir.
  assert.deepEqual(paths, [".gitignore", "app.ts"]);
});

test("renderRepoMap: answers 'where is justify' — path+symbol in the map (CLI-053)", () => {
  const map = walkRepo(fakeFs({ "src/tui/status.ts": "export function justify() {}" }), "");
  const out = renderRepoMap(map, 2048);
  assert.match(out, /^# repo map \(/); // always-present budget header
  assert.match(out, /src\/tui\/status\.ts: justify/); // file + symbol, no grep needed
  assert.ok(estimateTokens(out) <= 2048);
});

test("renderRepoMap: a repo larger than the budget is trimmed to fit, header shows it (CLI-053)", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 300; i++) files[`pkg/mod${i}/file${i}.ts`] = `export function fn${i}() {}`;
  const map = walkRepo(fakeFs(files), "");
  const budget = 80;
  const out = renderRepoMap(map, budget);
  assert.ok(estimateTokens(out) <= budget, "rendered map must fit the token budget");
  assert.match(out, /detail:trimmed/); // trimming happened (symbols dropped, then deep paths)
  assert.ok(map.fileCount === 300);
});

test("DEFAULT_IGNORE_DIRS covers the usual noise (CLI-053)", () => {
  for (const d of ["node_modules", ".git", "dist", "__pycache__", "venv"]) {
    assert.ok(DEFAULT_IGNORE_DIRS.includes(d));
  }
});

/* ── "meet your codebase" (roadmap point 6) ─────────────────────────────────────────────── */

test("summarizeCodebase: detects a stack from a root-level marker file", () => {
  const map = walkRepo(
    fakeFs({
      "package.json": "{}",
      "src/index.ts": "export function main() {}",
    }),
    "",
  );
  const o = summarizeCodebase(map);
  assert.ok(o.detectedStacks.includes("Node.js / JavaScript"));
  assert.equal(o.fileCount, 2);
});

test("summarizeCodebase: detects MULTIPLE stacks when several markers are present", () => {
  const map = walkRepo(
    fakeFs({
      "package.json": "{}",
      "tsconfig.json": "{}",
      "pyproject.toml": "[tool.poetry]",
      "app.py": "def main():\n    pass",
    }),
    "",
  );
  const o = summarizeCodebase(map);
  assert.ok(o.detectedStacks.includes("Node.js / JavaScript"));
  assert.ok(o.detectedStacks.includes("TypeScript"));
  assert.ok(o.detectedStacks.includes("Python"));
});

test("summarizeCodebase: a SUFFIX marker (.csproj) is detected without an exact-name match", () => {
  const map = walkRepo(fakeFs({ "MyApp.csproj": "<Project></Project>" }), "");
  const o = summarizeCodebase(map);
  assert.ok(o.detectedStacks.includes(".NET / C#"));
});

test("summarizeCodebase: no marker files at all yields an empty (not guessed) stack list", () => {
  const map = walkRepo(fakeFs({ "notes.txt": "just some notes" }), "");
  const o = summarizeCodebase(map);
  assert.deepEqual(o.detectedStacks, []);
});

test("summarizeCodebase: finds a root-level README regardless of extension", () => {
  const map = walkRepo(fakeFs({ "README.md": "# Hi", "src/a.ts": "export const a = 1;" }), "");
  assert.equal(summarizeCodebase(map).readmePath, "README.md");
});

test("summarizeCodebase: a README nested in a subdirectory is NOT picked as the root readme", () => {
  const map = walkRepo(fakeFs({ "docs/README.md": "# Nested" }), "");
  assert.equal(summarizeCodebase(map).readmePath, undefined);
});

test("summarizeCodebase: topDirs buckets by TOP-LEVEL directory, root files under '(root)'", () => {
  const map = walkRepo(
    fakeFs({
      "package.json": "{}",
      "src/a.ts": "export const a = 1;",
      "src/nested/b.ts": "export const b = 1;",
      "test/a.test.ts": "export const t = 1;",
    }),
    "",
  );
  const byDir = Object.fromEntries(summarizeCodebase(map).topDirs.map((d) => [d.key, d.count]));
  assert.equal(byDir["(root)"], 1);
  assert.equal(byDir.src, 2);
  assert.equal(byDir.test, 1);
});

test("summarizeCodebase: topExtensions counts by extension, extensionless files as '(none)'", () => {
  const map = walkRepo(
    fakeFs({
      "a.ts": "export const a=1;",
      "b.ts": "export const b=1;",
      Makefile: "all:\n\techo hi",
    }),
    "",
  );
  const byExt = Object.fromEntries(
    summarizeCodebase(map).topExtensions.map((e) => [e.key, e.count]),
  );
  assert.equal(byExt.ts, 2);
  assert.equal(byExt["(none)"], 1);
});

test("summarizeCodebase: samples symbols from the files with the most of them, capped at 12", () => {
  const map = walkRepo(
    fakeFs({
      "big.ts":
        "export function a(){}\nexport function b(){}\nexport function c(){}\nexport function d(){}",
      "small.ts": "export function onlyOne(){}",
      "empty.txt": "no symbols here",
    }),
    "",
  );
  const o = summarizeCodebase(map);
  assert.ok(o.sampleSymbols.length > 0);
  assert.ok(o.sampleSymbols.length <= 12);
  // the file with more exports is sampled first (its symbols appear before small.ts's lone one).
  assert.ok(o.sampleSymbols.includes("a") || o.sampleSymbols.includes("b"));
});

test("summarizeCodebase: truncation is carried through honestly from the underlying walk", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`f${i}.ts`] = `export const v${i} = ${i};`;
  const map = walkRepo(fakeFs(files), "", { fileCap: 4 });
  assert.equal(summarizeCodebase(map).truncated, true);
});

test("renderCodebaseOverview: a real, human-readable overview mentioning the stack, dirs, and readme", () => {
  const map = walkRepo(
    fakeFs({
      "package.json": "{}",
      "README.md": "# Hi",
      "src/index.ts": "export function main() {}",
    }),
    "",
  );
  const text = renderCodebaseOverview(summarizeCodebase(map));
  assert.match(text, /Node\.js \/ JavaScript/);
  assert.match(text, /src\//);
  assert.match(text, /README\.md/);
  assert.match(text, /\d+ files?/);
});

test("renderCodebaseOverview: an empty repo renders cleanly, no stack/readme lines forced in", () => {
  const map = walkRepo(fakeFs({}), "");
  const text = renderCodebaseOverview(summarizeCodebase(map));
  assert.match(text, /^0 files/);
  assert.doesNotMatch(text, /Looks like:/);
  assert.doesNotMatch(text, /Start here:/);
});
