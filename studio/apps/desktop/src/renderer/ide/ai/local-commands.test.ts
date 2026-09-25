/**
 * local-commands.test.ts — the AgentPane's local `/ls`: parsing, target resolution, and the
 * transcript text it posts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IdeTreeNode } from "../../../shared/ipc-contract.js";
import {
  BUILTIN_SLASH_ROWS,
  CAT_MAX_LINES,
  extractInDirective,
  formatCatTurn,
  formatInTurn,
  formatLsTurn,
  lsTarget,
  matchCatCommand,
  matchInCommand,
  matchLsCommand,
  outputDirNote,
} from "./local-commands.js";
import { filterSlashCommands } from "./slash.js";

const node = (dir: string, name: string, kind: "file" | "dir"): IdeTreeNode => ({
  path: `${dir}/${name}`,
  name,
  kind,
});

test("matchLsCommand: /ls, a path, -a; anything else is not /ls", () => {
  assert.deepEqual(matchLsCommand("/ls"), { path: "", all: false });
  assert.deepEqual(matchLsCommand("  /ls src  "), { path: "src", all: false });
  assert.deepEqual(matchLsCommand("/ls -a"), { path: "", all: true });
  assert.deepEqual(matchLsCommand("/ls --all docs"), { path: "docs", all: true });
  assert.match((matchLsCommand("/ls -x") as { error: string }).error, /unknown option -x/);
  assert.match((matchLsCommand("/ls a b") as { error: string }).error, /one folder at a time/);
  assert.equal(matchLsCommand("/lsof"), null);
  assert.equal(matchLsCommand("list the files please"), null);
  assert.equal(matchLsCommand("/list"), null);
});

test("lsTarget: the folder itself, a sub-path of it, or an absolute path", () => {
  assert.equal(lsTarget("/repo", ""), "/repo");
  assert.equal(lsTarget("/repo/", "."), "/repo/");
  assert.equal(lsTarget("/repo", "src/"), "/repo/src");
  assert.equal(lsTarget("/repo/", "./docs"), "/repo/docs");
  assert.equal(lsTarget("/repo", "/etc"), "/etc");
});

test("formatLsTurn names the folder, counts, and lists folders first in a fence", () => {
  const nodes = [
    node("/repo", "docs", "dir"),
    node("/repo", "src", "dir"),
    node("/repo", ".env", "file"),
    node("/repo", "README.md", "file"),
  ];
  const text = formatLsTurn({ dir: "/repo", nodes, all: false, folderOpen: true });
  assert.match(text, /\*\*\/ls\*\* — `\/repo` · 2 folders, 1 file, 1 hidden/);
  assert.match(text, /```\ndocs\/\nsrc\/\nREADME\.md\n```/);
  assert.doesNotMatch(text, /\.env/);
  assert.match(formatLsTurn({ dir: "/repo", nodes, all: true, folderOpen: true }), /\.env/);
});

test("formatLsTurn: no folder open is said plainly, and `.` is shown as the real folder", () => {
  const nodes = [node("/Applications/Prometheus.app/x", "a.txt", "file")];
  const text = formatLsTurn({ dir: ".", nodes, all: false, folderOpen: false });
  assert.match(text, /No folder is open/);
  assert.match(text, /`\/Applications\/Prometheus\.app\/x`/);
});

test("formatLsTurn: an empty or unreadable folder, and a name that holds backticks", () => {
  assert.match(
    formatLsTurn({ dir: "/repo", nodes: [], all: false, folderOpen: true }),
    /\(empty, or not readable\)/,
  );
  const odd = formatLsTurn({
    dir: "/repo",
    nodes: [node("/repo", "a```b.txt", "file")],
    all: false,
    folderOpen: true,
  });
  assert.match(odd, /````\na```b\.txt\n````/, "the fence outgrows any backtick run in a name");
});

test("/ls ranks FIRST in the popup, ahead of the LSP palette rows that also match 'ls'", () => {
  const rows = [
    { id: "editor.vision.toggleFolding", title: "Toggle Folding Regions (LSP)" },
    { id: "lsp.restart", title: "LSP: Restart language server" },
    ...BUILTIN_SLASH_ROWS,
  ];
  assert.equal(filterSlashCommands(rows, "ls")[0]?.id, "builtin:ls");
});

/* ══ /cat ════════════════════════════════════════════════════════════════════*/

test("/cat parses a filename, rejects a flag typo, and needs exactly one file", () => {
  assert.deepEqual(matchCatCommand("/cat src/a.ts"), { path: "src/a.ts", all: false });
  assert.deepEqual(matchCatCommand("/cat a.ts -a"), { path: "a.ts", all: true });
  assert.deepEqual(matchCatCommand("/cat"), { error: "usage: /cat <file> [-a]" });
  assert.match((matchCatCommand("/cat -x a.ts") as { error: string }).error, /unknown option -x/);
  assert.match((matchCatCommand("/cat a b") as { error: string }).error, /one file at a time/);
  // not a /cat line at all → null, so it goes to the model
  assert.equal(matchCatCommand("what does /cat do?"), null);
  assert.equal(matchCatCommand("/catalog"), null);
});

test("/cat renders the file verbatim behind a line gutter", () => {
  const out = formatCatTurn({
    path: "/p/a.ts",
    read: { ok: true, text: "one\ntwo\n" },
    all: false,
  });
  assert.match(out, /^\/p\/a\.ts · 2 lines\n/);
  assert.match(out, /^1 │ one$/m);
  assert.match(out, /^2 │ two$/m);
});

test("/cat of a file containing a markdown fence is NOT mangled", () => {
  // This is the whole reason the turn is `pre` and not a fenced block: markdown-parse closes a
  // block on a line that is exactly ```, so a fence in the file would end it early.
  const text = "intro\n```\ncode\n```\nafter\n";
  const out = formatCatTurn({ path: "/p/README.md", read: { ok: true, text }, all: false });
  for (const [i, line] of ["intro", "```", "code", "```", "after"].entries()) {
    assert.ok(out.includes(`${i + 1} │ ${line}`), `line ${i + 1} (${line}) survived`);
  }
});

test("/cat refuses a binary file and reports a read error", () => {
  const bin = formatCatTurn({
    path: "/p/x.png",
    read: { ok: true, text: "PNG\u0000\u0001" },
    all: false,
  });
  assert.match(bin, /binary file — not shown/);
  const bad = formatCatTurn({ path: "/p/x", read: { ok: false, error: "EACCES" }, all: false });
  assert.match(bad, /^\/cat — EACCES/);
});

test("/cat caps long files and says what it cut", () => {
  const text = `${Array.from({ length: CAT_MAX_LINES + 10 }, (_, i) => `l${i}`).join("\n")}\n`;
  const out = formatCatTurn({ path: "/p/big.txt", read: { ok: true, text }, all: false });
  assert.match(out, new RegExp(`first ${CAT_MAX_LINES} of ${CAT_MAX_LINES + 10} lines`));
  const all = formatCatTurn({ path: "/p/big.txt", read: { ok: true, text }, all: true });
  assert.ok(!all.includes("first "), "-a lifts the cap");
});

test("/cat neutralises control bytes, matching the terminal", () => {
  const out = formatCatTurn({
    path: "/p/e",
    read: { ok: true, text: "a\u001b[2Jb\n" },
    all: false,
  });
  assert.ok(!out.includes("\u001b"));
  assert.match(out, /\^\[/);
});

test("/cat of an empty file says so", () => {
  assert.match(
    formatCatTurn({ path: "/p/e", read: { ok: true, text: "" }, all: false }),
    /\(empty file\)/,
  );
});

/* ══ /in ═════════════════════════════════════════════════════════════════════*/

test("/in parses show, clear and set, and rejects a flag typo", () => {
  assert.deepEqual(matchInCommand("/in"), { action: "show" });
  assert.deepEqual(matchInCommand("/in --clear"), { action: "clear" });
  assert.deepEqual(matchInCommand("/in ~/Downloads"), { action: "set", path: "~/Downloads" });
  assert.deepEqual(matchInCommand('/in "/tmp/my folder"'), {
    action: "set",
    path: "/tmp/my folder",
  });
  assert.match((matchInCommand("/in -z") as { error: string }).error, /unknown option -z/);
  assert.equal(matchInCommand("what does /in mean"), null);
  assert.equal(matchInCommand("/install"), null);
});

test("/in inline: the directive is pulled out and the sentence still reads", () => {
  const r = extractInDirective("download this video at URL and save it /in /Users/me/Downloads");
  assert.equal(r.dir, "/Users/me/Downloads");
  assert.equal(r.prompt, "download this video at URL and save it");
});

test("/in inline: /info and /install are not the directive; the last one wins", () => {
  assert.equal(extractInDirective("read /info first").dir, null);
  assert.equal(extractInDirective("run /install ffmpeg").dir, null);
  const r = extractInDirective("put it /in /tmp/a actually /in /tmp/b");
  assert.equal(r.dir, "/tmp/b");
  assert.ok(!r.prompt.includes("/in"));
});

test("the two surfaces tell the model the SAME thing", () => {
  // Wording drift between the CLI and the pane is how one surface quietly stops working; the
  // terminal's copy lives in apps/cli/src/session/in.ts.
  const note = outputDirNote("/tmp/out");
  assert.match(note, /^Output directory for produced files: \/tmp\/out\n/);
  assert.match(note, /pass it explicitly to the command/);
});

test("/in status names the folder, or says produced files go to the workspace", () => {
  assert.match(formatInTurn(null, "/proj"), /_not set_/);
  assert.match(formatInTurn(null, "/proj"), /\/proj/);
  assert.match(formatInTurn("/tmp/out", "/proj"), /\/tmp\/out/);
  assert.match(formatInTurn("/tmp/out", "/proj"), /--clear/);
});
