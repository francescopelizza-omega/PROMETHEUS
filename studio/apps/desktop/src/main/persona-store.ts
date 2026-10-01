// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/persona-store.ts — Persona Sharing (roadmap point 3): export/import of user-defined
 * sub-agent persona files, desktop half.
 *
 * CRITICAL DIFFERENCE FROM model-health-store.ts / schedule-store.ts: those each persist to an
 * Electron-app-PRIVATE file under `app.getPath("userData")`. Personas are the OPPOSITE — a
 * SHARED catalog `spawn_agent` reads identically whether the CLI or the desktop app is running,
 * living under the plain OS-wide `~/.prometheus` tree that `main/ide/agent-files-host.ts`
 * (desktop's persona *discovery*) and the CLI's `session/persona-store.ts` twin both already
 * read via the SAME `prometheusHome()` (`@prometheus/core/agent-system-host`). Siloing imports
 * into an Electron-only location would make an import invisible to the CLI's `spawn_agent` and
 * vice versa, defeating the whole point of a shared catalog — so this module takes a bare,
 * default-parameterized `home = prometheusHome()` exactly like `agent-files-host.ts`'s own
 * `loadAgentFiles`/`loadImportedAgentFiles`, never an Electron `userData` path.
 *
 * SAFETY MODEL (enforced here, not just at load time): `@prometheus/core/agent`'s
 * `loadAgentFile` clamps a "project" or "imported" persona identically HARD at *load* time
 * (model refused, read-only floor, tools only narrow, body capped+fenced) — see its own header
 * for why. That clamp depends entirely on `scope`, which is not a field in the file, it is
 * WHICH DIRECTORY the file physically sits in. So the one thing this module must never get
 * wrong is WHERE an imported file is written:
 *
 *   - `importPersonaMarkdown` writes ONLY into `<home>/agents/imported/` — never into
 *     `<home>/agents/` directly (that would silently promote an untrusted file to fully-trusted
 *     "user" scope) and never anywhere a crafted name could make it escape to.
 *   - the destination stem is never trusted input: it goes through core's own
 *     `agent.agentNameFromFile` (rejects `-rf`, `../evil`, empty, oversized — the same sanitiser
 *     `agent-files-host.ts` relies on for `SAFE_NAME`), and the resolved path is re-checked with
 *     `resolve()` to land exactly inside `resolve(importedDir)` as belt-and-suspenders on top of
 *     the sanitiser.
 *   - the raw import text is size-capped BEFORE any write, independent of core's own
 *     `MAX_PERSONA_CHARS` (which only clamps what's shown to the model, not what's allowed onto
 *     disk) — this is a disk-fill guard, not a prompt-safety one.
 *   - `removeImportedPersona` can only ever delete `<home>/agents/imported/<sanitised-name>.md`
 *     — there is no generic "delete by path", so it is structurally incapable of touching the
 *     user's own `<home>/agents/*.md` or a project's `.prometheus/agents/*.md`.
 *   - import/export both only ever touch a LOCAL path or text the caller already has; neither
 *     fetches from a URL (the arbitrary-URL-fetch-of-untrusted-config shape already fixed twice
 *     elsewhere in this codebase).
 *
 * `exportPersonaMarkdown` carries none of that risk — it is a local file read of a persona the
 * user already has on disk — but still searches USER → PROJECT → IMPORTED, the same priority
 * `loadAgentFiles` uses, via `discoverProjectAgentsDir` re-exported from this runtime's own
 * `agent-files-host.ts` sibling rather than re-deriving project-dir discovery here.
 *
 * Ported 1:1 (signatures + behaviour) from the CLI's `session/persona-store.ts`, adapted only in
 * that `home`/`root` are plain optional parameters (no CLI-specific `cwd` naming, no Electron
 * import at all) — importable and testable under plain `node:test` with zero mocking, exactly
 * like `agent-files-host.ts` itself.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { agent } from "@prometheus/core";
import { prometheusHome } from "@prometheus/core/agent-system-host";

import { discoverProjectAgentsDir } from "./ide/agent-files-host.js";

/** One persona as catalog UI needs it: enough to list and to key an export/remove by. */
export interface PersonaFileInfo {
  name: string;
  scope: agent.AgentFileScope;
  description: string;
  path: string;
}

/** Disk-fill guard on the RAW import text, independent of core's `MAX_PERSONA_CHARS` (which only
 *  clamps what's shown to the model). Checked before anything is written. */
const MAX_IMPORT_BYTES = 65536;

/** Read every `*.md` in a directory as a persona at `scope`, keeping each file's own path
 *  alongside core's clamped view of it. Missing dir ⇒ none; one unreadable file is skipped, the
 *  rest still list — same fail-soft posture as `agent-files-host.ts`'s `loadDir`. */
function scanDir(
  dir: string,
  scope: agent.AgentFileScope,
): Array<{ loaded: agent.LoadedAgent; path: string }> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ loaded: agent.LoadedAgent; path: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const text = readFileSync(path, "utf8");
      const loaded = agent.loadAgentFile(basename(entry, ".md"), text, scope);
      if (loaded) out.push({ loaded, path });
    } catch {
      /* one unreadable persona is skipped; the rest still list */
    }
  }
  return out;
}

/**
 * Find the persona file in `dir` whose SANITIZED stem matches `safe` — scanning, exactly like
 * `scanDir`/`listPersonaFiles` do, rather than reconstructing `${safe}.md` and checking
 * `existsSync`. The reconstruct-and-check shape diverges from what was just listed on a
 * case-sensitive filesystem: a file `DocWriter.md` lists (via `agentNameFromFile`, which
 * lowercases the stem) as persona "docwriter", but `existsSync(join(dir, "docwriter.md"))` is
 * false for that real, differently-cased file — so an export/remove for the exact name the
 * catalog just showed would silently miss it (or worse, fall through to a lower-priority scope
 * that happens to have an exact-case match, returning a DIFFERENT persona's content under the
 * name Settings just labeled as this one). Returns the real on-disk path, or undefined.
 */
function findPersonaPath(dir: string, safe: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (agent.agentNameFromFile(basename(entry, ".md")) === safe) {
      return join(dir, entry);
    }
  }
  return undefined;
}

/**
 * Every persona available for `root`, USER scope first, then PROJECT, then IMPORTED — the exact
 * collision priority `agent-files-host.ts`'s `loadAgentFiles` uses (a user file wins every name
 * collision; project and imported each add personas but never replace one an earlier layer
 * already claimed).
 */
export function listPersonaFiles(root: string, home: string = prometheusHome()): PersonaFileInfo[] {
  const user = scanDir(join(home, "agents"), "user");
  const projectDir = discoverProjectAgentsDir(root, home);
  const project = projectDir ? scanDir(projectDir, "project") : [];
  const imported = scanDir(join(home, "agents", "imported"), "imported");

  const taken = new Set(user.map((e) => e.loaded.name));
  const keptProject = project.filter((e) => !taken.has(e.loaded.name));
  for (const e of keptProject) taken.add(e.loaded.name);
  const keptImported = imported.filter((e) => !taken.has(e.loaded.name));

  return [...user, ...keptProject, ...keptImported].map((e) => ({
    name: e.loaded.name,
    scope: e.loaded.scope,
    description: e.loaded.description,
    path: e.path,
  }));
}

/**
 * Read one persona's raw markdown back out VERBATIM, for the user to copy/paste or hand to
 * someone else. Just a local file read of something the user already has access to — searches
 * USER → PROJECT → IMPORTED, the same priority the loaders use, so a name collision resolves to
 * the same file `spawn_agent` would actually use.
 */
export function exportPersonaMarkdown(
  name: string,
  root: string,
  home: string = prometheusHome(),
): { path: string; scope: agent.AgentFileScope; markdown: string } | undefined {
  const safe = agent.agentNameFromFile(name);
  if (!safe) return undefined;

  const projectDir = discoverProjectAgentsDir(root, home);
  const candidates: Array<{ dir: string; scope: agent.AgentFileScope }> = [
    { dir: join(home, "agents"), scope: "user" },
    ...(projectDir ? [{ dir: projectDir, scope: "project" as const }] : []),
    { dir: join(home, "agents", "imported"), scope: "imported" },
  ];

  for (const { dir, scope } of candidates) {
    const path = findPersonaPath(dir, safe);
    if (!path) continue;
    try {
      return { path, scope, markdown: readFileSync(path, "utf8") };
    } catch {
      // an unreadable file at this scope just isn't a hit; the loop continues on its own
    }
  }
  return undefined;
}

/**
 * Import someone else's persona markdown, writing it ONLY into `<home>/agents/imported/` so it
 * loads as IMPORTED scope — clamped identically to PROJECT by core's `loadAgentFile` — never as
 * fully-trusted USER scope. `markdown` must be text the caller already has (a local file the
 * user picked, or text they pasted); this never fetches from a URL.
 */
export function importPersonaMarkdown(
  suggestedName: string,
  markdown: string,
  home: string = prometheusHome(),
): { ok: true; name: string; path: string; replaced: boolean } | { ok: false; error: string } {
  const safe = agent.agentNameFromFile(suggestedName);
  if (!safe) {
    return { ok: false, error: `"${suggestedName}" is not a valid persona name` };
  }

  // Size cap BEFORE any write — a DoS/disk-fill guard, independent of core's MAX_PERSONA_CHARS.
  if (Buffer.byteLength(markdown, "utf8") > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error: `persona is too large to import (max ${MAX_IMPORT_BYTES} bytes)`,
    };
  }

  // A body-less file would write successfully but never actually load as a persona (core's
  // `loadAgentFile` returns null for an empty body) — reject it now rather than leave a dead
  // file behind that silently never appears anywhere.
  const { body } = agent.parseAgentFile(markdown);
  if (!body.trim()) {
    return { ok: false, error: "persona has no body text to import" };
  }

  const importedDir = join(home, "agents", "imported");
  const path = join(importedDir, `${safe}.md`);
  // Belt-and-suspenders on top of `agentNameFromFile`'s sanitising: the write must land exactly
  // inside the imported directory, never anywhere a crafted name could make it escape to.
  if (dirname(resolve(path)) !== resolve(importedDir)) {
    return { ok: false, error: "refusing to import outside the imported personas directory" };
  }

  const replaced = existsSync(path);
  mkdirSync(importedDir, { recursive: true });
  writeFileSync(path, markdown, "utf8");
  return { ok: true, name: safe, path, replaced };
}

/**
 * Remove one imported persona. Structurally incapable of touching anything outside
 * `<home>/agents/imported/` — there is no generic "delete by path" here, only "delete by
 * sanitised name, joined against the imported dir only", so this can never reach the user's own
 * `<home>/agents/*.md` or a project's `.prometheus/agents/*.md`. A no-op (not an error) when the
 * name is already gone — mirrors core's `removeTask` no-op contract.
 */
export function removeImportedPersona(
  name: string,
  home: string = prometheusHome(),
): { ok: true } | { ok: false; error: string } {
  const safe = agent.agentNameFromFile(name);
  if (!safe) {
    return { ok: false, error: `"${name}" is not a valid persona name` };
  }

  const importedDir = join(home, "agents", "imported");
  const path = findPersonaPath(importedDir, safe);
  if (!path) {
    return { ok: true }; // already gone (or never existed) — mirrors core's removeTask no-op.
  }
  // Belt-and-suspenders: `findPersonaPath` only ever joins a bare directory-entry NAME (never a
  // caller-supplied path) against `importedDir`, so this can never actually fail — kept anyway,
  // matching this module's own "structurally incapable of touching anything outside imported/"
  // guarantee stated in the header above.
  if (dirname(resolve(path)) !== resolve(importedDir)) {
    return { ok: false, error: "refusing to remove a persona outside the imported directory" };
  }
  try {
    unlinkSync(path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `could not remove "${safe}": ${(err as Error).message}` };
  }
}
