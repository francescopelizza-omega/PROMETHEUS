/**
 * commands/persona-cmd.test.ts — `prometheus persona <list|export|import|remove>` over REAL
 * mkdtemp'd temp `home`/`cwd` directories (never the default `prometheusHome()`, per this
 * feature's own safety lesson: a store/persistence function is never exercised here with its
 * default path omitted).
 *
 * `session/persona-store.ts`'s own FS-level contract (listing priority, verbatim export, the
 * sanitiser/size-cap/containment guards on import/remove) is already pinned by
 * `session/persona-store.test.ts`; this suite only pins what THIS file owns: flag parsing,
 * rendering (the "(shared, read-only)" flag on an imported row, the read-only confirmation on
 * import), exit codes, and the two belt-and-suspenders checks this command layer adds on top of
 * the store — refusing a URL-looking import path and an oversized file BEFORE ever reading it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  handleExport,
  handleImport,
  handleList,
  handleRemove,
  runPersonaCommand,
} from "./persona-cmd.js";

/** A temp dir per test, always cleaned up — never the real `prometheusHome()` / real cwd. */
function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `prom-persona-cmd-${prefix}-`));
}

/** Captures every `write()` call, in order, for assertions on the printed text. */
function capture(): { write: (line: string) => void; lines: string[]; text: () => string } {
  const lines: string[] = [];
  return { write: (l) => lines.push(l), lines, text: () => lines.join("\n") };
}

/* ── list ─────────────────────────────────────────────────────────────────── */

test("list: an empty store prints 'no personas found' rather than a bare header", () => {
  const home = tmp("list-empty-home");
  const cwd = tmp("list-empty-cwd");
  try {
    const res = handleList(cwd, home);
    assert.equal(res.exitCode, 0);
    assert.deepEqual(res.json, { ok: true, personas: [] });
    assert.ok(
      res.lines.some((l) => l.includes("no personas found")),
      `expected the empty-store message, got:\n${res.lines.join("\n")}`,
    );
    assert.equal(res.lines.length, 1, "an empty store should not print a header + table");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("list: shows a user persona plainly and flags an imported one as '(shared, read-only)'", () => {
  const home = tmp("list-populated-home");
  const cwd = tmp("list-populated-cwd");
  try {
    const homeAgentsDir = join(home, "agents");
    const importedDir = join(home, "agents", "imported");
    mkdirSync(homeAgentsDir, { recursive: true });
    mkdirSync(importedDir, { recursive: true });
    writeFileSync(
      join(homeAgentsDir, "reviewer.md"),
      "---\ndescription: my own reviewer\n---\nYou review code carefully.",
    );
    writeFileSync(
      join(importedDir, "shared.md"),
      "---\ndescription: a shared persona\n---\nSomeone else's persona.",
    );

    const res = handleList(cwd, home);
    assert.equal(res.exitCode, 0);
    const personas = res.json.personas as Array<{ name: string; scope: string }>;
    const names = personas.map((p) => p.name).sort();
    assert.deepEqual(names, ["reviewer", "shared"]);
    // the raw JSON payload carries the UNFLAGGED scope
    assert.equal(personas.find((p) => p.name === "shared")?.scope, "imported");
    assert.equal(personas.find((p) => p.name === "reviewer")?.scope, "user");

    // the rendered text flags the imported row and leaves the user row plain
    const text = res.lines.join("\n");
    assert.ok(text.includes("shared, read-only") || text.includes("(shared, read-only)"), text);
    const reviewerLine = res.lines.find((l) => l.includes("reviewer"));
    assert.ok(reviewerLine);
    assert.ok(!reviewerLine?.includes("shared, read-only"), reviewerLine);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* ── export ───────────────────────────────────────────────────────────────── */

test("export: a real name prints the raw markdown verbatim to stdout, undecorated", () => {
  const home = tmp("export-found-home");
  const cwd = tmp("export-found-cwd");
  const raw = "---\nmode: build\ndescription: my own reviewer\n---\nYou review code carefully.";
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "reviewer.md"), raw);

    const res = handleExport(["reviewer"], cwd, home);
    assert.equal(res.exitCode, 0);
    // reconstructing the split lines must reproduce the raw markdown EXACTLY — no banner mixed in.
    assert.equal(res.lines.join("\n"), raw);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.scope, "user");
    assert.equal(res.json.markdown, raw);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export: a missing name is refused (exit 2)", () => {
  const home = tmp("export-missing-home");
  const cwd = tmp("export-missing-cwd");
  try {
    const res = handleExport(["ghost"], cwd, home);
    assert.equal(res.exitCode, 2);
    assert.equal(res.json.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("export --out writes the file verbatim and prints a confirmation naming the scope", () => {
  const home = tmp("export-out-home");
  const cwd = tmp("export-out-cwd");
  const raw = "---\ndescription: writes docs\n---\nYou write documentation.";
  const outPath = join(cwd, "exported-docs.md");
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "docs.md"), raw);

    const res = handleExport(["docs", "--out", outPath], cwd, home);
    assert.equal(res.exitCode, 0);
    assert.equal(readFileSync(outPath, "utf8"), raw, "the written file must match verbatim");
    const line = res.lines.join("\n");
    assert.ok(line.includes("docs"));
    assert.ok(line.includes("user"));
    assert.ok(line.includes(outPath));
    assert.equal(res.json.ok, true);
    assert.equal(res.json.out, outPath);
    assert.equal(res.json.scope, "user");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* ── import ───────────────────────────────────────────────────────────────── */

test("import: a real local .md file succeeds, is read-only, and a follow-up list shows it as imported", () => {
  const home = tmp("import-ok-home");
  const cwd = tmp("import-ok-cwd");
  const srcDir = tmp("import-ok-src");
  const srcPath = join(srcDir, "friend-persona.md");
  try {
    writeFileSync(
      srcPath,
      "---\nmode: build\ndescription: a friend's build persona\n---\nYou fix bugs aggressively.",
    );

    const res = handleImport([srcPath], home);
    assert.equal(res.exitCode, 0);
    const line = res.lines.join("\n");
    assert.ok(line.includes("friend-persona"), line);
    assert.ok(line.toLowerCase().includes("read-only"), line);
    assert.ok(line.toLowerCase().includes("cannot choose a model"), line);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.name, "friend-persona");
    assert.equal(res.json.scope, "imported");

    // never written directly into user scope
    assert.equal(existsSync(join(home, "agents", "friend-persona.md")), false);
    assert.equal(existsSync(join(home, "agents", "imported", "friend-persona.md")), true);

    const listRes = handleList(cwd, home);
    const personas = listRes.json.personas as Array<{ name: string; scope: string }>;
    const imported = personas.find((p) => p.name === "friend-persona");
    assert.ok(imported);
    assert.equal(imported?.scope, "imported");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});

test("import: a path that looks like a URL is refused outright, no network attempt, nothing written", () => {
  const home = tmp("import-url-home");
  try {
    const httpRes = handleImport(["http://evil.example.com/persona.md"], home);
    assert.equal(httpRes.exitCode, 2);
    assert.equal(httpRes.json.ok, false);
    assert.ok(String(httpRes.json.error).toLowerCase().includes("url"));

    const httpsRes = handleImport(["https://evil.example.com/persona.md"], home);
    assert.equal(httpsRes.exitCode, 2);
    assert.equal(httpsRes.json.ok, false);

    const protoRelRes = handleImport(["//evil.example.com/persona.md"], home);
    assert.equal(protoRelRes.exitCode, 2);
    assert.equal(protoRelRes.json.ok, false);

    // nothing was ever imported as a result of any of the above
    assert.equal(existsSync(join(home, "agents")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import: a nonexistent local file path is refused with a clear error", () => {
  const home = tmp("import-missing-home");
  try {
    const res = handleImport([join(home, "does-not-exist.md")], home);
    assert.equal(res.exitCode, 2);
    assert.equal(res.json.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import: an oversized file is refused via a stat check BEFORE it is ever read into memory", () => {
  const home = tmp("import-huge-home");
  const srcDir = tmp("import-huge-src");
  const srcPath = join(srcDir, "huge.md");
  try {
    const huge = `---\ndescription: huge\n---\n${"x".repeat(70_000)}`;
    writeFileSync(srcPath, huge);

    const res = handleImport([srcPath], home);
    assert.equal(res.exitCode, 2);
    assert.equal(res.json.ok, false);
    assert.ok(String(res.json.error).toLowerCase().includes("large"));
    // nothing was written under home as a result
    assert.equal(existsSync(join(home, "agents")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});

/* ── remove ───────────────────────────────────────────────────────────────── */

test("remove: a real imported persona is removed, and a follow-up list no longer shows it", () => {
  const home = tmp("remove-real-home");
  const cwd = tmp("remove-real-cwd");
  const srcDir = tmp("remove-real-src");
  const srcPath = join(srcDir, "temp-friend.md");
  try {
    writeFileSync(srcPath, "---\ndescription: a temp persona\n---\nBody text here.");
    const importRes = handleImport([srcPath], home);
    assert.equal(importRes.exitCode, 0);

    const removeRes = handleRemove(["temp-friend"], home);
    assert.equal(removeRes.exitCode, 0);
    assert.equal(removeRes.json.ok, true);
    assert.equal(existsSync(join(home, "agents", "imported", "temp-friend.md")), false);

    const listRes = handleList(cwd, home);
    const personas = listRes.json.personas as Array<{ name: string }>;
    assert.ok(!personas.some((p) => p.name === "temp-friend"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});

test("remove: an unknown name is a no-op success (matches the store's idempotent contract), not a hard error", () => {
  const home = tmp("remove-unknown-home");
  try {
    const res = handleRemove(["never-imported"], home);
    assert.equal(res.exitCode, 0);
    assert.equal(res.json.ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── dispatcher (runPersonaCommand) ──────────────────────────────────────── */

test("an unknown or missing subcommand prints usage and exits 2", async () => {
  const home = tmp("usage-home");
  const cwd = tmp("usage-cwd");
  try {
    const out1 = capture();
    const res1 = await runPersonaCommand([], { cwd, home, json: false, write: out1.write });
    assert.equal(res1.exitCode, 2);
    assert.ok(out1.text().includes("usage:"));

    const out2 = capture();
    const res2 = await runPersonaCommand(["bogus"], { cwd, home, json: false, write: out2.write });
    assert.equal(res2.exitCode, 2);
    assert.ok(out2.text().includes("usage:"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runPersonaCommand (--json): stdout stays ONE clean object for 'list' on an empty store", async () => {
  const home = tmp("json-purity-home");
  const cwd = tmp("json-purity-cwd");
  try {
    const out = capture();
    const res = await runPersonaCommand(["list"], { cwd, home, json: true, write: out.write });
    assert.equal(res.exitCode, 0);
    assert.equal(out.lines.length, 1, `expected exactly one write() call, got:\n${out.text()}`);
    assert.deepEqual(JSON.parse(out.lines[0] as string), { ok: true, personas: [] });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
