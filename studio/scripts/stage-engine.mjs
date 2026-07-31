/**
 * scripts/stage-engine.mjs — stage the Python engine for packaging (file 10 §1/§11).
 *
 * Copies the repo's stdlib-only engine VERBATIM into `studio/staging/engine/` so
 * electron-builder can ship it as `extraResources` (real files on disk, NOT in asar —
 * a child python3 must be able to exec them, §1):
 *   - prometheus.py   (copied verbatim)
 *   - nemesis         (copied verbatim, chmod 0755 on posix)
 *   - VERSION.json    { engine, studioBuilt, builtAt }
 *
 * The engine is the SINGLE source of truth at the repo root; we never fork it.
 * `engine` is read from prometheus.py's SCRIPT_VERSION; `studioBuilt` is the git
 * sha (env GITHUB_SHA / git rev-parse, else "dev"); `builtAt` is the build time.
 *
 * Run: node scripts/stage-engine.mjs   (idempotent; overwrites staging/engine).
 */
import { execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const studio = resolve(here, "..");
const repoRoot = resolve(studio, ".."); // PROMETHEUS/ — prometheus.py + nemesis live here
const out = join(studio, "staging", "engine");

const SRC = {
  prometheus: join(repoRoot, "prometheus.py"),
  nemesis: join(repoRoot, "nemesis"),
};

for (const [name, p] of Object.entries(SRC)) {
  if (!existsSync(p)) {
    console.error(`stage-engine: ${name} not found at ${p}`);
    process.exit(1);
  }
}

/** Read SCRIPT_VERSION = "x.y.z" from prometheus.py (the engine version). */
function engineVersion() {
  const text = readFileSync(SRC.prometheus, "utf8");
  const m = /SCRIPT_VERSION\s*=\s*["']([^"']+)["']/.exec(text);
  return m ? m[1] : "unknown";
}

/** The Studio build sha — CI env first, then git, then "dev". */
function studioBuilt() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

copyFileSync(SRC.prometheus, join(out, "prometheus.py"));
copyFileSync(SRC.nemesis, join(out, "nemesis"));
if (process.platform !== "win32") {
  chmodSync(join(out, "prometheus.py"), 0o755);
  chmodSync(join(out, "nemesis"), 0o755);
}

const version = {
  engine: engineVersion(),
  studioBuilt: studioBuilt(),
  builtAt: new Date().toISOString(),
};
writeFileSync(join(out, "VERSION.json"), `${JSON.stringify(version, null, 2)}\n`);

console.log(`staged engine → ${out}`);
console.log(
  `  prometheus.py + nemesis + VERSION.json (engine ${version.engine}, build ${version.studioBuilt})`,
);
