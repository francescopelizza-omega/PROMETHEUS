// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * home.ts — the canonical `~/.prometheus/` HOME tree + the settings / per-category
 * download-path store + disk-usage helpers.
 *
 * Everything Prometheus persists for a user lives under ONE root: config, third-party
 * downloads (videos/audio/files), caches, logs, records, and runtime state. The root is
 * `~/.prometheus` (override: $PROMETHEUS_HOME).
 *
 * MODEL WEIGHTS ARE NOT HERE. Each model lives in the store of the software that serves it
 * (Ollama's, LM Studio's, the Hugging Face cache — `ai.modelStores`), so nothing is kept twice.
 * An `open_models/` folder used to be created and exported as $PROMETHEUS_MODELS_DIR; it only
 * ever collected duplicates, and it is gone.
 *
 *   ~/.prometheus/
 *     config/        settings.json · paths.json (per-category overrides)
 *     downloads/     videos/ · audio/ · files/   (yt-dlp + third-party heavy files)
 *     cache/         staging/
 *     logs/          engine/ · sessions/ · security/
 *     records/       installs/ · audits/ · quarantine/
 *     state/         sessions/   (+ first-run marker in settings.json)
 *     tmp/
 *
 * Pure node built-ins (fs/os/path — allowed in apps/cli; only child_process is gated).
 * Every fn takes an optional `home` so tests point it at a temp dir. Fail-soft: a read
 * error yields `{}`, a mkdir error is swallowed (never crash the session over a dir).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The resolver moved to core (Phase 6): the exec audit is written by the CLI *and* by
// Studio's main process, so both must agree on where the home root is. Re-exported here
// because every CLI call site already imports it from this module.
import { ai } from "@prometheus/core";
import { prometheusHome } from "@prometheus/core/agent-system-host";

export { prometheusHome };

/** The full subdir tree created under the home root (idempotent ensure). */
export const HOME_TREE: readonly string[] = [
  "config",
  "downloads/videos",
  "downloads/audio",
  "downloads/files",
  "cache/staging",
  "logs/engine",
  "logs/sessions",
  "logs/security",
  "records/installs",
  "records/audits",
  "records/quarantine",
  "state/sessions",
  // one file per live instance — the fleet bar's presence store (fleet/heartbeat.ts).
  "run",
  "tmp",
];

/** Join segments under the home root. */
export function homePath(home: string, ...segs: string[]): string {
  return join(home, ...segs);
}

/** Create the whole home tree (recursive, idempotent). Returns which subdirs were new. */
export function ensureHomeTree(home: string = prometheusHome()): {
  home: string;
  created: string[];
} {
  const created: string[] = [];
  for (const sub of HOME_TREE) {
    const dir = join(home, sub);
    if (existsSync(dir)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      created.push(sub);
    } catch {
      /* never crash the session over a dir we couldn't create. */
    }
  }
  return { home, created };
}

/* ----------------------------- disk usage --------------------------------- */

export interface DiskInfo {
  freeBytes: number;
  totalBytes: number;
}

/**
 * Free/total bytes on the volume holding `path`. `path` need not exist yet — we walk
 * up to the nearest existing ancestor. Returns null if statfs is unavailable.
 */
export function diskInfo(path: string): DiskInfo | null {
  try {
    let p = resolve(path);
    while (p && p !== dirname(p) && !existsSync(p)) p = dirname(p);
    const s = statfsSync(p || "/");
    const bsize = Number(s.bsize);
    return { freeBytes: Number(s.bavail) * bsize, totalBytes: Number(s.blocks) * bsize };
  } catch {
    return null;
  }
}

/* --------------------- per-category download paths ------------------------ */

/** Heavy-download categories the user can repoint to a different disk/folder. */
export type PathCategory = "videos" | "audio" | "files";

/** Default location (relative to home) per category. */
const CATEGORY_DEFAULT: Record<PathCategory, string> = {
  videos: "downloads/videos",
  audio: "downloads/audio",
  files: "downloads/files",
};

/** Human label per category (for the /paths UI). */
export const CATEGORY_LABEL: Record<PathCategory, string> = {
  videos: "Videos (yt-dlp)",
  audio: "Audio",
  files: "Files (third-party downloads)",
};

export const PATH_CATEGORIES: readonly PathCategory[] = ["videos", "audio", "files"];

/* --------------------- where models live (not here) ----------------------- */

/** Each serving runtime's own model store on this machine (`ai.modelStores`, read live). */
export function modelStoresHere(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): ai.ModelStore[] {
  // one reader for every surface: pointer, legacy home AND LM Studio's own folder setting
  return ai.modelStoresOnThisMachine(env, home, process.platform);
}

/** Free bytes per runtime store — a pick is checked against the store it writes to. */
export function freeDiskByStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): Partial<Record<ai.ModelStoreId, number>> {
  return ai.freeBytesByStore(modelStoresHere(env, home));
}

/**
 * Free disk where a model download will land: the LEAST free among the runtimes' stores (they
 * are usually one volume; when one sits on a smaller disk, that is the one a pick can fill).
 */
export function freeDiskForModels(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): DiskInfo | null {
  let best: DiskInfo | null = null;
  for (const s of modelStoresHere(env, home)) {
    const d = diskInfo(s.dir);
    if (d && (!best || d.freeBytes < best.freeBytes)) best = d;
  }
  return best;
}

function pathsFile(home: string): string {
  return join(home, "config", "paths.json");
}

/** Load the per-category overrides (fail-soft → {}). */
export function loadPaths(home: string = prometheusHome()): Partial<Record<PathCategory, string>> {
  try {
    const o = JSON.parse(readFileSync(pathsFile(home), "utf8")) as unknown;
    return o && typeof o === "object" ? (o as Partial<Record<PathCategory, string>>) : {};
  } catch {
    return {};
  }
}

/** Persist the per-category overrides (ensures the tree first). */
export function savePaths(
  paths: Partial<Record<PathCategory, string>>,
  home: string = prometheusHome(),
): void {
  ensureHomeTree(home);
  writeFileSync(pathsFile(home), `${JSON.stringify(paths, null, 2)}\n`);
}

/** The effective absolute path for a category: an override, else the default under home. */
export function resolveCategory(cat: PathCategory, home: string = prometheusHome()): string {
  // fail-soft: a corrupt paths.json may hold a non-string value for a category — `.trim()` on it
  // would throw and break the fallback, so type-guard before using it.
  const raw = loadPaths(home)[cat];
  const override = typeof raw === "string" ? raw.trim() : undefined;
  return override ? resolve(override) : join(home, CATEGORY_DEFAULT[cat]);
}

/** Repoint a category to `dir` (absolute), persisting the override + creating the dir. */
export function setCategory(
  cat: PathCategory,
  dir: string,
  home: string = prometheusHome(),
): string {
  const abs = resolve(dir.trim());
  const all = loadPaths(home);
  all[cat] = abs;
  savePaths(all, home);
  try {
    mkdirSync(abs, { recursive: true });
  } catch {
    /* the dir may be created later by the downloader; don't fail the setting. */
  }
  return abs;
}

/* ------------------------------ settings ---------------------------------- */

function settingsFile(home: string): string {
  return join(home, "config", "settings.json");
}

/** Load the global settings blob (fail-soft → {}). */
export function loadSettings(home: string = prometheusHome()): Record<string, unknown> {
  try {
    const o = JSON.parse(readFileSync(settingsFile(home), "utf8")) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Merge-and-persist a settings patch (shallow). */
/** Returns false when nothing was written (so a caller never reports a save that did not happen). */
export function saveSettings(
  patch: Record<string, unknown>,
  home: string = prometheusHome(),
): boolean {
  ensureHomeTree(home);
  const file = settingsFile(home);
  // `loadSettings` answers {} for a file it cannot parse, so a hand-edit with a trailing comma
  // made the NEXT save rewrite settings.json as defaults plus one key — the user's hooks, remote
  // host allowlist and onboarding state, gone. The unreadable original is kept beside it first.
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    /* absent — nothing to preserve */
  }
  if (raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const kept = `${file}.corrupt-${Date.now()}`;
      try {
        copyFileSync(file, kept);
        process.stderr.write(
          `warning: ${file} could not be read as JSON — kept as ${kept}; starting a fresh one\n`,
        );
      } catch {
        return false; // could not preserve it: do not overwrite what we cannot restore
      }
    }
  }
  const merged = { ...loadSettings(home), ...patch };
  // temp + rename: a crash mid-write must not leave a truncated settings file
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Has first-run onboarding been completed? (persisted in settings.json) */
export function firstRunDone(home: string = prometheusHome()): boolean {
  return loadSettings(home).onboardingCompleted === true;
}

/** Mark first-run onboarding complete (records the chosen backend for context). */
export function markFirstRunDone(backend: string, home: string = prometheusHome()): void {
  saveSettings({ onboardingCompleted: true, preferredBackend: backend }, home);
}
