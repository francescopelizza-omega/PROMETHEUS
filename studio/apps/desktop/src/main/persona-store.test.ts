/**
 * persona-store.test.ts — Persona Sharing's desktop export/import catalog. Real mkdtemp'd
 * home/root dirs throughout — NEVER the default `prometheusHome()`/real cwd (a store whose
 * `home` parameter defaults to the real `~/.prometheus` and is called unconditionally from a
 * test suite would silently write fixture data into the user's actual home directory).
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

/* ── listPersonaFiles ────────────────────────────────────────────────────── */

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

test("listPersonaFiles: lists user, project, and imported personas together", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    writeFileSync(
      join(home, "agents", "reviewer.md"),
      "---\ndescription: user reviewer\n---\nUser body.",
    );
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".prometheus", "agents", "docs.md"),
      "---\ndescription: writes docs\n---\nProject body.",
    );
    writeFileSync(
      join(home, "agents", "imported", "helper.md"),
      "---\ndescription: a shared helper\n---\nImported body.",
    );

    const personas = listPersonaFiles(root, home);
    const byName = Object.fromEntries(personas.map((p) => [p.name, p]));

    assert.equal(personas.length, 3);
    assert.equal(byName.reviewer?.scope, "user");
    assert.equal(byName.reviewer?.description, "user reviewer");
    assert.equal(byName.reviewer?.path, join(home, "agents", "reviewer.md"));
    assert.equal(byName.docs?.scope, "project");
    assert.equal(byName.helper?.scope, "imported");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("listPersonaFiles: USER wins a name collision over PROJECT and IMPORTED", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    writeFileSync(join(home, "agents", "same.md"), "---\ndescription: user version\n---\nUser.");
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
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

test("listPersonaFiles: PROJECT wins over IMPORTED when the user has no persona of that name", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
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
    assert.equal(personas[0]?.scope, "project");
    assert.equal(personas[0]?.description, "project version");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── exportPersonaMarkdown ───────────────────────────────────────────────── */

test("exportPersonaMarkdown: exports verbatim from user scope", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    const raw = "---\ndescription: user reviewer\nmode: build\n---\nYou review code carefully.";
    writeFileSync(join(home, "agents", "reviewer.md"), raw);

    const result = exportPersonaMarkdown("reviewer", root, home);
    assert.ok(result);
    assert.equal(result?.scope, "user");
    assert.equal(result?.markdown, raw);
    assert.equal(result?.path, join(home, "agents", "reviewer.md"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportPersonaMarkdown: exports verbatim from project scope", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
    const raw = "---\ndescription: writes docs\n---\nYou write documentation.";
    writeFileSync(join(root, ".prometheus", "agents", "docs.md"), raw);

    const result = exportPersonaMarkdown("docs", root, home);
    assert.ok(result);
    assert.equal(result?.scope, "project");
    assert.equal(result?.markdown, raw);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportPersonaMarkdown: exports verbatim from imported scope", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    const raw = "---\ndescription: a shared helper\n---\nImported body.";
    writeFileSync(join(home, "agents", "imported", "helper.md"), raw);

    const result = exportPersonaMarkdown("helper", root, home);
    assert.ok(result);
    assert.equal(result?.scope, "imported");
    assert.equal(result?.markdown, raw);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportPersonaMarkdown: finds a MIXED-CASE filename by its sanitized (lowercased) name, exactly like listPersonaFiles does", () => {
  // The bug: exportPersonaMarkdown used to reconstruct `${safe}.md` and check `existsSync`,
  // which — on a case-sensitive filesystem — misses a real file like `DocWriter.md` even
  // though `listPersonaFiles` (which scans + matches via `agentNameFromFile`) lists it as
  // "docwriter". Scanning by sanitized name (this test) must find it regardless of platform.
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    const raw = "---\ndescription: writes docs\n---\nYou write documentation carefully.";
    writeFileSync(join(home, "agents", "DocWriter.md"), raw);

    const listed = listPersonaFiles(root, home);
    assert.deepEqual(
      listed.map((p) => p.name),
      ["docwriter"],
    );

    const result = exportPersonaMarkdown("docwriter", root, home);
    assert.ok(result, "export must find the same persona listPersonaFiles just listed");
    assert.equal(result?.scope, "user");
    assert.equal(result?.markdown, raw);
    assert.equal(result?.path, join(home, "agents", "DocWriter.md"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportPersonaMarkdown: an unknown name yields undefined", () => {
  const home = tmp();
  const root = tmp();
  try {
    assert.equal(exportPersonaMarkdown("nope", root, home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── importPersonaMarkdown ───────────────────────────────────────────────── */

test('importPersonaMarkdown: writes into agents/imported/, loadable+clamped as "imported" scope', () => {
  const home = tmp();
  try {
    const raw =
      "---\nmode: build\nmodel: ollama:evil\ndescription: a shared persona\n---\nBe helpful.";
    const result = importPersonaMarkdown("shared-helper", raw, home);

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.name, "shared-helper");
    assert.equal(result.replaced, false);
    assert.equal(result.path, join(home, "agents", "imported", "shared-helper.md"));
    assert.equal(readFileSync(result.path, "utf8"), raw);

    // Loadable, and clamped IDENTICALLY to project scope by core's own loader — the whole
    // point: writing to disk here does not itself decide privilege, `scope` at load time does.
    const loaded = agent.loadAgentFile("shared-helper", raw, "imported");
    assert.ok(loaded);
    assert.equal(loaded?.base, "explore"); // writable "build" role refused
    assert.equal(loaded?.model, undefined); // model refused
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: re-importing the same name replaces it, reporting replaced: true", () => {
  const home = tmp();
  try {
    const first = importPersonaMarkdown("helper", "---\ndescription: v1\n---\nFirst.", home);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.replaced, false);

    const second = importPersonaMarkdown("helper", "---\ndescription: v2\n---\nSecond.", home);
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.replaced, true);
    assert.equal(
      readFileSync(join(home, "agents", "imported", "helper.md"), "utf8"),
      "---\ndescription: v2\n---\nSecond.",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: a path-traversal suggested name is refused, nothing written", () => {
  const home = tmp();
  try {
    const result = importPersonaMarkdown("../../evil", "Some body.", home);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /not a valid persona name/);
    assert.ok(!existsSync(join(home, "agents")), "no directory should have been created at all");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('importPersonaMarkdown: "-rf" and blank names are refused', () => {
  const home = tmp();
  try {
    assert.equal(importPersonaMarkdown("-rf", "Body.", home).ok, false);
    assert.equal(importPersonaMarkdown("", "Body.", home).ok, false);
    assert.equal(importPersonaMarkdown("   ", "Body.", home).ok, false);
    assert.ok(!existsSync(join(home, "agents", "imported")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: an oversized import is refused before any write", () => {
  const home = tmp();
  try {
    const huge = "x".repeat(65537);
    const result = importPersonaMarkdown("too-big", huge, home);

    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /too large/);
    assert.ok(!existsSync(join(home, "agents", "imported")), "size cap must run before any write");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: a body-less file is rejected (would never load as a persona anyway)", () => {
  const home = tmp();
  try {
    const result = importPersonaMarkdown("empty", "---\ndescription: nothing here\n---\n   ", home);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /no body text/);
    assert.ok(!existsSync(join(home, "agents", "imported", "empty.md")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("importPersonaMarkdown: exactly the 65536-byte limit is accepted (boundary)", () => {
  const home = tmp();
  try {
    const atLimit = "x".repeat(65536);
    const result = importPersonaMarkdown("at-limit", atLimit, home);
    assert.equal(result.ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── removeImportedPersona ───────────────────────────────────────────────── */

test("removeImportedPersona: removes a persona from agents/imported/", () => {
  const home = tmp();
  try {
    importPersonaMarkdown("helper", "---\ndescription: v1\n---\nBody.", home);
    const path = join(home, "agents", "imported", "helper.md");
    assert.ok(existsSync(path));

    const result = removeImportedPersona("helper", home);
    assert.equal(result.ok, true);
    assert.ok(!existsSync(path));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeImportedPersona: removes a MIXED-CASE filename by its sanitized (lowercased) name", () => {
  // The bug: removeImportedPersona used to reconstruct `${safe}.md` and check `existsSync`,
  // which — on a case-sensitive filesystem — never matches a real file like `Reviewer.md`, so
  // it returned a false `{ok:true}` (indistinguishable from "already removed") while the
  // untrusted imported persona silently remained on disk and spawnable.
  const home = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    const path = join(home, "agents", "imported", "Reviewer.md");
    writeFileSync(path, "---\ndescription: shared reviewer\n---\nBody.");

    const result = removeImportedPersona("reviewer", home);
    assert.equal(result.ok, true);
    assert.ok(!existsSync(path), "the real, differently-cased file must actually be gone");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeImportedPersona: touches only agents/imported/, never a same-named decoy under plain agents/", () => {
  const home = tmp();
  try {
    // A decoy: the user's OWN persona, same name, sitting in plain (USER-scope) agents/ — not
    // agents/imported/. removeImportedPersona must be structurally incapable of reaching it.
    mkdirSync(join(home, "agents"), { recursive: true });
    const decoyPath = join(home, "agents", "same.md");
    writeFileSync(
      decoyPath,
      "---\ndescription: the user's own real persona\n---\nDo not delete me.",
    );

    // No imported/same.md exists yet, so this is a no-op success — the crux of the test is that
    // it is NOT the decoy that gets removed to make it look successful.
    const result = removeImportedPersona("same", home);
    assert.equal(result.ok, true);
    assert.ok(existsSync(decoyPath), "the user's own persona must survive untouched");

    // Now add a real imported/same.md alongside the decoy and remove again: only the imported
    // copy should disappear.
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    const importedPath = join(home, "agents", "imported", "same.md");
    writeFileSync(importedPath, "---\ndescription: an imported persona\n---\nImported.");

    const second = removeImportedPersona("same", home);
    assert.equal(second.ok, true);
    assert.ok(!existsSync(importedPath), "the imported copy must be gone");
    assert.ok(existsSync(decoyPath), "the user's own persona must still survive untouched");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeImportedPersona: removing a name that is already gone is a no-op success", () => {
  const home = tmp();
  try {
    const result = removeImportedPersona("does-not-exist", home);
    assert.equal(result.ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("removeImportedPersona: a path-traversal name is refused", () => {
  const home = tmp();
  try {
    const result = removeImportedPersona("../../evil", home);
    assert.equal(result.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
