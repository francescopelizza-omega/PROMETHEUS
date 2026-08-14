/**
 * agent-files-host.test.ts — desktop's persona discovery (Task #5, desktop parity).
 *
 * Mirrors the CLI's (untested-at-the-fs-layer) `agent-file-store.ts` twin: this is the fs half,
 * `@prometheus/core/agent-files`'s `loadAgentFile` is the pure clamp (already covered by
 * `agent-files.test.ts` in core) — so this suite only pins the DISCOVERY rules: user scope
 * wins a name collision, the project dir is found by walking up from a nested cwd, and a
 * missing directory yields no personas rather than throwing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverProjectAgentsDir, loadAgentFiles } from "./agent-files-host.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "prom-agent-files-"));
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

test("loadAgentFiles: a USER persona wins a name collision over a PROJECT one", () => {
  const home = tmp();
  const root = tmp();
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(
      join(home, "agents", "same.md"),
      "---\ndescription: user version\n---\nUser body.",
    );
    mkdirSync(join(root, ".prometheus", "agents"), { recursive: true });
    writeFileSync(
      join(root, ".prometheus", "agents", "same.md"),
      "---\ndescription: project version\n---\nProject body.",
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
