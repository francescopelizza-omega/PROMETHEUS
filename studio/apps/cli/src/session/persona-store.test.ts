/**
 * persona-store.test.ts — export/import of persona files ("persona sharing"), point 3 of the
 * roadmap. `agent.loadAgentFile`'s clamp is already covered by core's `agent-files.test.ts`; this
 * suite pins the FS-level rules this module owns: listing priority across the three scopes,
 * export returning verbatim raw markdown from whichever scope has it, and — the safety-critical
 * half — import being structurally confined to `<home>/agents/imported/` no matter what a
 * malicious `suggestedName` or an oversized payload tries.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agent } from "@prometheus/core";

import {
  exportPersonaMarkdown,
  importPersonaMarkdown,
  listPersonaFiles,
  removeImportedPersona,
} from "./persona-store.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "prom-persona-store-"));
}

/* ── listPersonaFiles ────────────────────────────────────────────────────────────────────── */

test("listPersonaFiles: lists across all three scopes with USER > PROJECT > IMPORTED priority", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    writeFileSync(
      join(home, "agents", "reviewer.md"),
      "---\ndescription: my own reviewer\n---\nYou review code carefully.",
    );
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".prometheus", "agents", "docs.md"),
      "---\ndescription: writes docs\n---\nYou write documentation.",
    );
    writeFileSync(
      join(home, "agents", "imported", "shared.md"),
      "---\ndescription: a shared persona\n---\nSomeone else's persona.",
    );

    const personas = listPersonaFiles(root, home);
    const byName = new Map(personas.map((p) => [p.name, p]));
    assert.deepEqual([...byName.keys()].sort(), ["docs", "reviewer", "shared"]);
    assert.equal(byName.get("reviewer")?.scope, "user");
    assert.equal(byName.get("reviewer")?.description, "my own reviewer");
    assert.equal(byName.get("docs")?.scope, "project");
    assert.equal(byName.get("shared")?.scope, "imported");
    // paths point at the real files on disk
    assert.equal(byName.get("reviewer")?.path, join(home, "agents", "reviewer.md"));
    assert.equal(byName.get("shared")?.path, join(home, "agents", "imported", "shared.md"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("listPersonaFiles: a 3-way name collision is won by USER, then PROJECT, never IMPORTED", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "same.md"), "---\ndescription: user version\n---\nUser.");
    writeFileSync(
      join(root, ".prometheus", "agents", "same.md"),
      "---\ndescription: project version\n---\nProject.",
    );
    writeFileSync(
      join(home, "agents", "imported", "same.md"),
      "---\ndescription: imported version\n---\nImported.",
    );

    const personas = listPersonaFiles(root, home);
    assert.equal(personas.length, 1);
    assert.equal(personas[0]?.scope, "user");
    assert.equal(personas[0]?.description, "user version");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("listPersonaFiles: a missing directory yields no personas (fail-soft)", () => {
  const home = tmp();
  const root = tmp();
  try {
    assert.deepEqual(listPersonaFiles(root, home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── exportPersonaMarkdown ───────────────────────────────────────────────────────────────── */

test("exportPersonaMarkdown: finds a USER-scope persona and returns verbatim raw markdown", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    const raw = "---\nmode: build\ndescription: my own reviewer\n---\nYou review code carefully.";
    writeFileSync(join(home, "agents", "reviewer.md"), raw);

    const result = exportPersonaMarkdown("reviewer", root, home);
    assert.ok(result);
    assert.equal(result?.scope, "user");
    assert.equal(result?.path, join(home, "agents", "reviewer.md"));
    // verbatim: frontmatter included, unclamped ("mode: build" preserved as literal text)
    assert.equal(result?.markdown, raw);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportPersonaMarkdown: finds a PROJECT-scope persona (walking up from a nested cwd)", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
    const raw = "---\ndescription: writes docs\n---\nYou write documentation.";
    writeFileSync(join(root, ".prometheus", "agents", "docs.md"), raw);
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });

    const result = exportPersonaMarkdown("docs", nested, home);
    assert.ok(result);
    assert.equal(result?.scope, "project");
    assert.equal(result?.markdown, raw);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportPersonaMarkdown: finds an IMPORTED-scope persona", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    const raw = "---\ndescription: a shared persona\n---\nSomeone else's persona.";
    writeFileSync(join(home, "agents", "imported", "shared.md"), raw);

    const result = exportPersonaMarkdown("shared", root, home);
    assert.ok(result);
    assert.equal(result?.scope, "imported");
    assert.equal(result?.markdown, raw);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportPersonaMarkdown: returns undefined for a name that exists nowhere", () => {
  const home = tmp();
  const root = tmp();
  try {
    assert.equal(exportPersonaMarkdown("ghost", root, home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── importPersonaMarkdown ───────────────────────────────────────────────────────────────── */

test("importPersonaMarkdown: writes into <home>/agents/imported/ and is loadable, clamped", () => {
  const home = tmp();
  try {
    const raw =
      "---\nmode: build\ndescription: a friend's build persona\n---\nYou fix bugs aggressively.";
    const result = importPersonaMarkdown("friend-persona", raw, home);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.name, "friend-persona");
    assert.equal(result.path, join(home, "agents", "imported", "friend-persona.md"));
    assert.equal(result.replaced, false);
    assert.ok(existsSync(result.path));
    assert.equal(readFileSync(result.path, "utf8"), raw);

    // Never written into user scope directly.
    assert.equal(existsSync(join(home, "agents", "friend-persona.md")), false);

    // Loadable afterward, and the clamp actually applies: "mode: build" is refused for an
    // imported file, floored to "explore".
    const loaded = agent.loadAgentFile("friend-persona", raw, "imported");
    assert.ok(loaded);
    assert.equal(loaded?.base, "explore");
    assert.equal(loaded?.scope, "imported");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: re-importing the same name reports replaced: true", () => {
  const home = tmp();
  try {
    const first = importPersonaMarkdown("dup", "---\ndescription: v1\n---\nFirst.", home);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.replaced, false);

    const second = importPersonaMarkdown("dup", "---\ndescription: v2\n---\nSecond.", home);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.replaced, true);
    assert.equal(readFileSync(second.path, "utf8"), "---\ndescription: v2\n---\nSecond.");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('importPersonaMarkdown: a malicious suggestedName like "-rf" is refused, nothing written', () => {
  const home = tmp();
  try {
    const result = importPersonaMarkdown("-rf", "---\ndescription: evil\n---\nBody text.", home);
    assert.equal(result.ok, false);
    // nothing should exist anywhere under home as a result
    assert.equal(existsSync(join(home, "agents")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: a path-traversal suggestedName is refused, nothing escapes the imported dir", () => {
  const home = tmp();
  try {
    const result = importPersonaMarkdown(
      "../../etc/passwd",
      "---\ndescription: evil\n---\nBody text.",
      home,
    );
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(home, "agents")), false);
    // definitely did not escape upward
    assert.equal(existsSync(join(home, "..", "..", "etc", "passwd")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: an empty suggestedName is refused", () => {
  const home = tmp();
  try {
    const result = importPersonaMarkdown("", "---\ndescription: evil\n---\nBody text.", home);
    assert.equal(result.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: an oversized import (>65536 chars) is refused BEFORE any file is written", () => {
  const home = tmp();
  try {
    const huge = `---\ndescription: huge\n---\n${"x".repeat(70_000)}`;
    const result = importPersonaMarkdown("huge-one", huge, home);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(home, "agents", "imported", "huge-one.md")), false);
    assert.equal(existsSync(join(home, "agents")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: empty body text is refused", () => {
  const home = tmp();
  try {
    const result = importPersonaMarkdown("blank", "---\ndescription: nothing here\n---\n", home);
    assert.equal(result.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── removeImportedPersona ───────────────────────────────────────────────────────────────── */

test("removeImportedPersona: removes the right file from agents/imported/ only", () => {
  const home = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    const importedPath = join(home, "agents", "imported", "shared.md");
    writeFileSync(importedPath, "---\ndescription: shared\n---\nBody.");

    // decoy: a user-scope persona with the SAME name, must survive the call below untouched.
    mkdirSync(join(home, "agents"), { recursive: true });
    const decoyPath = join(home, "agents", "shared.md");
    writeFileSync(decoyPath, "---\ndescription: decoy user persona\n---\nDo not delete me.");

    const result = removeImportedPersona("shared", home);
    assert.equal(result.ok, true);
    assert.equal(existsSync(importedPath), false);
    // the decoy under plain agents/ must survive
    assert.equal(existsSync(decoyPath), true);
    assert.equal(
      readFileSync(decoyPath, "utf8"),
      "---\ndescription: decoy user persona\n---\nDo not delete me.",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeImportedPersona: a missing name is a no-op, not an error", () => {
  const home = tmp();
  try {
    const result = removeImportedPersona("ghost", home);
    assert.equal(result.ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeImportedPersona: a malicious name is refused, never derives a path outside imported/", () => {
  const home = tmp();
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    const decoyPath = join(home, "agents", "important.md");
    writeFileSync(decoyPath, "---\ndescription: my own real persona\n---\nDo not delete me.");

    const result = removeImportedPersona("../important", home);
    assert.equal(result.ok, false);
    assert.equal(existsSync(decoyPath), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
