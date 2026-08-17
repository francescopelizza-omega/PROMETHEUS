/**
 * home.ts — the canonical `~/.prometheus/` HOME tree + the settings / per-category
 * download-path store + disk-usage helpers.
 *
 * EVERYTHING Prometheus persists for a user lives under ONE root (mandate): config,
 * open-model weights, third-party downloads (videos/audio/files), caches, logs,
 * records, and runtime state. The root is `~/.prometheus` (override: $PROMETHEUS_HOME).
 *
 *   ~/.prometheus/
 *     config/        settings.json · paths.json (per-category overrides)
 *     open_models/   default LLM weights (→ engine models_root + $PROMETHEUS_MODELS_DIR)
 *     downloads/     videos/ · audio/ · files/   (yt-dlp + third-party heavy files)
 *     cache/         hf/ · staging/
 *     logs/          engine/ · sessions/ · security/
 *     records/       installs/ · audits/ · quarantine/
 *     state/         sessions/   (+ first-run marker in settings.json)
 *     tmp/
 *
 * Pure node built-ins (fs/os/path — allowed in apps/cli; only child_process is gated).
 * Every fn takes an optional `home` so tests point it at a temp dir. Fail-soft: a read
 * error yields `{}`, a mkdir error is swallowed (never crash the session over a dir).
 */
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The resolver moved to core (Phase 6): the exec audit is written by the CLI *and* by
// Studio's main process, so both must agree on where the home root is. Re-exported here
// because every CLI call site already imports it from this module.
import { prometheusHome } from "@prometheus/core/agent-system-host";

export { prometheusHome };

/** The full subdir tree created under the home root (idempotent ensure). */
export const HOME_TREE: readonly string[] = [
  "config",
  "open_models",
  "downloads/videos",
  "downloads/audio",
  "downloads/files",
  "cache/hf",
  "cache/staging",
  "logs/engine",
  "logs/sessions",
  "logs/security",
  "records/installs",
  "records/audits",
  "records/quarantine",
  "state/sessions",
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
export type PathCategory = "open_models" | "videos" | "audio" | "files";

/** Default location (relative to home) per category. */
const CATEGORY_DEFAULT: Record<PathCategory, string> = {
  open_models: "open_models",
  videos: "downloads/videos",
  audio: "downloads/audio",
  files: "downloads/files",
};

/** Human label per category (for the /paths UI). */
export const CATEGORY_LABEL: Record<PathCategory, string> = {
  open_models: "Open LLM models",
  videos: "Videos (yt-dlp)",
  audio: "Audio",
  files: "Files (third-party downloads)",
};

export const PATH_CATEGORIES: readonly PathCategory[] = ["open_models", "videos", "audio", "files"];

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
export function saveSettings(
  patch: Record<string, unknown>,
  home: string = prometheusHome(),
): void {
  ensureHomeTree(home);
  const merged = { ...loadSettings(home), ...patch };
  writeFileSync(settingsFile(home), `${JSON.stringify(merged, null, 2)}\n`);
}

/** Has first-run onboarding been completed? (persisted in settings.json) */
export function firstRunDone(home: string = prometheusHome()): boolean {
  return loadSettings(home).onboardingCompleted === true;
}

/** Mark first-run onboarding complete (records the chosen backend for context). */
export function markFirstRunDone(backend: string, home: string = prometheusHome()): void {
  saveSettings({ onboardingCompleted: true, preferredBackend: backend }, home);
}
