/**
 * session/persona-store.ts — export/import of user-defined sub-agent personas ("persona
 * sharing"): let a user hand one of their own `agents/*.md` files to another user, and let that
 * other user bring it in.
 *
 * EXPORT is a plain, already-permitted local file read: the user reads back their OWN readable
 * persona (in USER, PROJECT, or IMPORTED scope, in that priority — the same order and the same
 * `discoverProjectAgentsDir` walk `agent-file-store.ts` uses for `loadAgentFiles`) as verbatim,
 * UNCLAMPED markdown, so they can copy/paste or hand the file to someone else. There is no
 * privilege question here: nothing this function returns grants the reader anything they could
 * not already read directly off disk.
 *
 * IMPORT is the dangerous direction, and its entire safety story is: an imported persona is
 * physically confined to `~/.prometheus/agents/imported/`, NEVER `~/.prometheus/agents/`
 * directly — the latter is USER scope (fully trusted, unclamped by `agent.loadAgentFile`), and
 * writing an imported file there would silently defeat the clamp `agent-files.ts` (core) already
 * enforces for IMPORTED scope. This module never chooses that path itself: it sanitises whatever
 * name it's given through core's OWN `agent.agentNameFromFile` (the exact function `loadAgentFile`
 * uses, so a name this module accepts is a name the loader would accept too), caps the raw import
 * text BEFORE any write (a disk-fill guard independent of and in addition to core's
 * `MAX_PERSONA_CHARS`, which only clamps what's shown to the model, not what's allowed on disk),
 * and re-verifies with `resolve()` that the write lands exactly inside the imported directory —
 * belt-and-suspenders on top of a sanitiser that already forbids slashes, so the check should
 * never trip, but a function that can delete or create files earns the extra line regardless.
 * Import NEVER reaches over the network — it only ever takes a local file path or text the user
 * already has in hand, mirroring a supply-chain lesson (arbitrary fetch of untrusted config)
 * already fixed twice elsewhere in this codebase.
 *
 * `removeImportedPersona` mirrors the same confinement in reverse: it can only ever build a path
 * under `<home>/agents/imported/`, so it is structurally incapable of deleting a user's own
 * persona or a project's, however it is called.
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

import { prometheusHome } from "../home.js";
import { discoverProjectAgentsDir } from "./agent-file-store.js";

/** A disk-fill guard on the RAW import text, checked BEFORE anything is written. Independent of
 *  (and much larger than) core's `MAX_PERSONA_CHARS`, which only caps what's shown to the model. */
const MAX_IMPORT_BYTES = 65536;

/** One persona available to this session, for a human-facing list — not a `LoadedAgent`: no
 *  clamping is needed just to name and describe what exists. */
export interface PersonaFileInfo {
  name: string;
  scope: agent.AgentFileScope;
  description: string;
  path: string;
}

/** Read every `*.md` in `dir` as a listing entry at `scope`. Missing dir ⇒ none. Reuses
 *  `agent.loadAgentFile` purely to derive the sanitised name + description consistently with
 *  every other reader of these files — a file it rejects (bad name, empty body) is skipped here
 *  too, since it could never be spawned anyway. */
function listDir(dir: string, scope: agent.AgentFileScope): PersonaFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PersonaFileInfo[] = [];
  for (const fileName of names) {
    if (!fileName.endsWith(".md")) continue;
    const path = join(dir, fileName);
    try {
      const text = readFileSync(path, "utf8");
      const loaded = agent.loadAgentFile(basename(fileName, ".md"), text, scope);
      if (!loaded) continue;
      out.push({ name: loaded.name, scope, description: loaded.description, path });
    } catch {
      /* one unreadable persona is skipped; the rest still list */
    }
  }
  return out;
}

/**
 * Every persona available, USER scope first, then PROJECT, then IMPORTED — the same
 * priority/collision rule `agent-file-store.ts`'s `loadAgentFiles` uses: a name is claimed by
 * exactly one layer, and a later layer never displaces an earlier one.
 */
export function listPersonaFiles(cwd: string, home: string = prometheusHome()): PersonaFileInfo[] {
  const user = listDir(join(home, "agents"), "user");
  const projectDir = discoverProjectAgentsDir(cwd, home);
  const project = projectDir ? listDir(projectDir, "project") : [];
  const imported = listDir(join(home, "agents", "imported"), "imported");

  const taken = new Set(user.map((p) => p.name));
  const keptProject = project.filter((p) => !taken.has(p.name));
  for (const p of keptProject) taken.add(p.name);
  const keptImported = imported.filter((p) => !taken.has(p.name));

  return [...user, ...keptProject, ...keptImported];
}

/** The path, within `dir`, of the `*.md` file whose sanitised stem equals `sanitizedName` —
 *  `sanitizedName` must already be the output of `agent.agentNameFromFile`, so this never matches
 *  (or reads) anything via a raw/unsanitised name. */
function findPersonaPath(dir: string, sanitizedName: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const fileName of names) {
    if (!fileName.endsWith(".md")) continue;
    if (agent.agentNameFromFile(basename(fileName, ".md")) === sanitizedName) {
      return join(dir, fileName);
    }
  }
  return undefined;
}

/**
 * Find one persona's raw, UNCLAMPED markdown source by name (search order: user, project,
 * imported — first match wins, same priority as `listPersonaFiles`). Returns `undefined` when no
 * persona with that name exists anywhere, INCLUDING when `name` cannot be sanitised at all (an
 * unsanitisable name can never match a persona that was itself loaded through the same sanitiser).
 */
export function exportPersonaMarkdown(
  name: string,
  cwd: string,
  home: string = prometheusHome(),
): { path: string; scope: agent.AgentFileScope; markdown: string } | undefined {
  const sanitized = agent.agentNameFromFile(name);
  if (!sanitized) return undefined;

  const scopes: Array<{ dir: string | undefined; scope: agent.AgentFileScope }> = [
    { dir: join(home, "agents"), scope: "user" },
    { dir: discoverProjectAgentsDir(cwd, home), scope: "project" },
    { dir: join(home, "agents", "imported"), scope: "imported" },
  ];

  for (const { dir, scope } of scopes) {
    if (!dir) continue;
    const path = findPersonaPath(dir, sanitized);
    if (!path) continue;
    try {
      return { path, scope, markdown: readFileSync(path, "utf8") };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Import raw markdown text as a NEW persona, ALWAYS into `<home>/agents/imported/`. Never
 * throws — every failure mode is a typed `{ ok: false, error }` result:
 *
 *   1. `suggestedName` is sanitised through `agent.agentNameFromFile` — the SAME sanitiser
 *      `loadAgentFile` itself uses. A name it refuses (`-rf`, `../../etc/passwd`, empty, too
 *      long) is refused here too, never silently coerced into something that writes elsewhere.
 *   2. The raw text is size-capped BEFORE any write — a disk-fill guard independent of core's
 *      own `MAX_PERSONA_CHARS` body cap.
 *   3. The write path is `join(importedDir, sanitizedName + ".md")`, re-verified with
 *      `resolve()` to land exactly inside `importedDir`.
 */
export function importPersonaMarkdown(
  suggestedName: string,
  markdown: string,
  home: string = prometheusHome(),
): { ok: true; name: string; path: string; replaced: boolean } | { ok: false; error: string } {
  const name = agent.agentNameFromFile(suggestedName);
  if (!name) {
    return { ok: false, error: `"${suggestedName}" is not a safe persona name` };
  }

  if (Buffer.byteLength(markdown, "utf8") > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error: `persona is too large to import (max ${MAX_IMPORT_BYTES} bytes)`,
    };
  }

  const { body } = agent.parseAgentFile(markdown);
  if (!body.trim()) {
    return { ok: false, error: "persona has no body text to import" };
  }

  const importedDir = join(home, "agents", "imported");
  const targetPath = join(importedDir, `${name}.md`);

  // Belt-and-suspenders on top of the sanitiser above: the resolved write location must land
  // EXACTLY inside the imported directory. `agentNameFromFile`'s charset already forbids `/`, so
  // this should never trip — but a function that writes files earns the check anyway.
  if (resolve(dirname(targetPath)) !== resolve(importedDir)) {
    return { ok: false, error: "refusing to import: resolved path escapes the imported directory" };
  }

  try {
    mkdirSync(importedDir, { recursive: true });
    const replaced = existsSync(targetPath);
    writeFileSync(targetPath, markdown);
    return { ok: true, name, path: targetPath, replaced };
  } catch (err) {
    return { ok: false, error: `failed to write imported persona: ${(err as Error).message}` };
  }
}

/**
 * Remove one persona from `<home>/agents/imported/` ONLY, by name. A no-op (not an error) when
 * the name is already gone — mirrors core's `removeTask` no-op contract. The only path this
 * function ever builds is `<home>/agents/imported/<sanitized-name>.md`; it is structurally
 * incapable of deleting a user's own `agents/*.md` persona or a project's `.prometheus/agents/`
 * persona under any input.
 */
export function removeImportedPersona(
  name: string,
  home: string = prometheusHome(),
): { ok: true } | { ok: false; error: string } {
  const sanitized = agent.agentNameFromFile(name);
  if (!sanitized) {
    return { ok: false, error: `"${name}" is not a safe persona name` };
  }

  const importedDir = join(home, "agents", "imported");
  const targetPath = join(importedDir, `${sanitized}.md`);

  if (resolve(dirname(targetPath)) !== resolve(importedDir)) {
    return { ok: false, error: "refusing to remove: resolved path escapes the imported directory" };
  }

  if (!existsSync(targetPath)) {
    return { ok: true };
  }

  try {
    unlinkSync(targetPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `failed to remove imported persona: ${(err as Error).message}` };
  }
}
