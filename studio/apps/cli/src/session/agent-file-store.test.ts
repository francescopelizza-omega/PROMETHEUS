/**
 * agent-file-store.test.ts — the CLI's persona discovery (mirrors the desktop twin,
 * agent-files-host.test.ts). `@prometheus/core/agent-files`'s `loadAgentFile` is the pure
 * clamp (already covered by agent-files.test.ts in core) — this suite only pins the DISCOVERY
 * rules: user scope wins every collision, the project dir is found by walking up from a nested
 * cwd, the new imported/ subdirectory loads as IMPORTED scope without ever being mistaken for a
 * user-scope *.md file, and a missing directory yields no personas rather than throwing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  discoverProjectAgentsDir,
  loadAgentFiles,
  loadImportedAgentFiles,
} from "./agent-file-store.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "prom-agent-file-store-"));
}

test("loadAgentFiles: a missing directory yields no personas (fail-soft)", () => {
  const home = tmp();
  const root = tmp();
  try {
    assert.deepEqual(loadAgentFiles(root, home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAgentFiles: loads a user persona + a project persona, no name collision", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(
      join(home, "agents", "reviewer.md"),
      "---\nmode: build\ndescription: reviews code\n---\nYou review code carefully.",
    );
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".prometheus", "agents", "docs.md"),
      "---\ndescription: writes docs\n---\nYou write documentation.",
    );
    const personas = loadAgentFiles(root, home);
    const names = personas.map((p) => p.name).sort();
    assert.deepEqual(names, ["docs", "reviewer"]);
    const reviewer = personas.find((p) => p.name === "reviewer");
    assert.equal(reviewer?.scope, "user");
    assert.equal(reviewer?.base, "build"); // user scope: mode honoured as asked
    const docs = personas.find((p) => p.name === "docs");
    assert.equal(docs?.scope, "project");
    assert.equal(docs?.base, "explore"); // project scope: no mode asked ⇒ floor
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadImportedAgentFiles: loads ~/.prometheus/agents/imported/*.md as IMPORTED scope, clamped", () => {
  const home = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    writeFileSync(
      join(home, "agents", "imported", "shared.md"),
      "---\nmode: build\nmodel: ollama:evil\n---\nA persona someone else shared with me.",
    );
    const personas = loadImportedAgentFiles(home);
    assert.equal(personas.length, 1);
    assert.equal(personas[0]?.scope, "imported");
    assert.equal(personas[0]?.base, "explore");
    assert.equal(personas[0]?.model, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadAgentFiles: the imported/ subdirectory is never mistaken for a user-scope *.md file", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents", "imported"), { recursive: true });
    writeFileSync(join(home, "agents", "imported", "shared.md"), "A shared persona.");
    const personas = loadAgentFiles(root, home);
    assert.equal(personas.length, 1);
    assert.equal(personas[0]?.name, "shared");
    assert.equal(personas[0]?.scope, "imported");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAgentFiles: USER wins over PROJECT wins over IMPORTED on a 3-way name collision", () => {
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
    const personas = loadAgentFiles(root, home);
    assert.equal(personas.length, 1);
    assert.equal(personas[0]?.scope, "user");
    assert.equal(personas[0]?.description, "user version");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjectAgentsDir: finds the dir walking UP from a nested cwd", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    assert.equal(discoverProjectAgentsDir(nested, home), join(root, ".prometheus", "agents"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjectAgentsDir: stops at home, never treats $HOME itself as a project dir", () => {
  const home = tmp();
  try {
    mkdirSync(join(home, ".prometheus", "agents"), { recursive: true });
    assert.equal(discoverProjectAgentsDir(home, home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
