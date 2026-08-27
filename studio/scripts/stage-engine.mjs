/**
 * scripts/stage-engine.mjs — stage the Python engine for packaging (file 10 §1/§11).
 *
 * Copies the repo's stdlib-only engine VERBATIM into `studio/staging/engine/` so
 * electron-builder can ship it as `extraResources` (real files on disk, NOT in asar —
 * a child python3 must be able to exec them, §1):
 *   - prometheus.py   (copied verbatim)
 *   - nemesis         (copied verbatim, chmod 0755 on posix)
 *   - VERSION.json    { engine, studioBuilt, builtAt }
 *   - studio/config/effort-capabilities.builtin.json  (the engine READS this at runtime)
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
  /**
   * The published reasoning-effort table.
   *
   * `prometheus.py` is NOT self-contained on this one point: `_EFFORT_BUILTIN_ARTIFACT`
   * resolves `studio/config/effort-capabilities.builtin.json` RELATIVE TO ITS OWN PATH, and
   * that file is the only table it has — the builtins live in TypeScript and are published
   * here precisely so the engine need not carry a second copy. Staging the script alone put it
   * at `<Resources>/engine/prometheus.py` with no `studio/config/` beside it, so every packaged
   * build resolved an EMPTY table: `--effort` reported "no reasoning control" for every model
   * on earth, while the same command worked from a checkout. The layout below is the repo's,
   * verbatim, so both resolve identically and there is no second path to keep in sync.
   */
  effortTable: join(studio, "config", "effort-capabilities.builtin.json"),
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
const effortOut = join(out, "studio", "config", "effort-capabilities.builtin.json");
mkdirSync(dirname(effortOut), { recursive: true });
copyFileSync(SRC.effortTable, effortOut);
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
const stagedRules = JSON.parse(readFileSync(effortOut, "utf8")).rules?.length ?? 0;
if (stagedRules === 0) {
  // A zero-rule table is indistinguishable at runtime from a MISSING one: every model resolves
  // to "no reasoning control". Failing the build is the only way that stays visible.
  console.error("stage-engine: the effort table staged with 0 rules — run emit-effort-rules.mjs");
  process.exit(1);
}
console.log(
  `  prometheus.py + nemesis + VERSION.json (engine ${version.engine}, build ${version.studioBuilt})`,
);
console.log(`  studio/config/effort-capabilities.builtin.json (${stagedRules} rules)`);
