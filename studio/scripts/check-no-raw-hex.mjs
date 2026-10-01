// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * scripts/check-no-raw-hex.mjs — the §6 "no raw hex" guard (file 08 §6 / file 10).
 *
 * file 08 §6: "No raw hex anywhere — a lint rule fails CI on a literal color
 * outside tokens/." biome has no such rule, so this is the custom token-only check.
 * It scans the design-system + renderer source (`packages/ui/src`, the desktop
 * `renderer`/`routes`) for BARE hex color literals and fails (exit 1) on any.
 *
 * What is ALLOWED (not a violation):
 *   - anything under a `tokens/` directory (the single source of truth, §2),
 *   - a hex used as a CSS `var()` FALLBACK — `var(--brand, #a855f7)` — the token
 *     is still the primary; the fallback only paints before tokens.css loads,
 *   - hex inside an rgb()/rgba()/hsl()/hsla() or color-mix() expression (scrims,
 *     elevation shadows — §2.4),
 *   - test files + type-declaration files,
 *   - a `// no-hex-allow` line marker (escape hatch with an explicit reason).
 *
 * Run: node scripts/check-no-raw-hex.mjs   (wired into `pnpm test`, file 10).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Source roots that must be token-only (no raw hex). */
const SCAN = ["packages/ui/src", "apps/desktop/src/renderer", "apps/desktop/src/routes"];

const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release", ".git", "coverage", "tokens"]);
// `tokens.ts` is the single source of truth alongside the `tokens/` dir (§2) — the
// primitive ramps + the 20 built-in color schemes are the ONE place raw hex lives.
const SKIP_FILE = /\.(test|spec)\.(ts|tsx)$|\.d\.ts$|(^|\/)tokens\.ts$/;
const SOURCE = /\.(ts|tsx)$/;

/** A 3/4/6/8-digit hex color literal. */
const HEX = /#[0-9a-fA-F]{3,4}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b/g;

function collect(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collect(join(dir, e.name), acc);
    } else if (SOURCE.test(e.name) && !SKIP_FILE.test(e.name)) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

/**
 * STRICT scope (APP-070): the SWEPT IDE-chrome files must be token-PURE — a
 * `var(--x, #hex)` FALLBACK is a VIOLATION here (a phantom/typo'd token then paints only via
 * its hex fallback and never re-themes — the root cause of the "app couldn't re-theme" bugs).
 * rgb()/color-mix() with a hex arg stays legal (translucent tints).
 *
 * HANDOFF_2 §9 ("extend STRICT_FALLBACK repo-wide, not 3 files"): this now covers EVERY
 * scanned root. The staged allowance existed only because ~139 stale fallbacks were still
 * in the tree; they have all been stripped, so the ratchet is closed. A `var(--x, #hex)`
 * anywhere in app code is now a build failure — which is the point: those fallbacks were
 * silently painting the OLD grey palette on any token typo, and a typo'd token that still
 * renders something plausible is the hardest kind of theming bug to see.
 */
const STRICT_FALLBACK = /.*/;

/** Is this hex match an allowed one (var() fallback / color-fn / marked line)? In a `strict`
 *  file a `var()` fallback is NOT allowed (but rgb()/color-mix() still are). */
function isAllowed(line, index, strict = false) {
  if (line.includes("// no-hex-allow")) return true;
  const before = line.slice(0, index);
  // A var() fallback: the nearest unclosed "(" before the hex belongs to var(/rgb(/…).
  const open = before.lastIndexOf("(");
  if (open !== -1) {
    const fn = before.slice(0, open).match(/([a-zA-Z-]+)\s*$/);
    const name = fn?.[1]?.toLowerCase();
    if (name && ["var", "rgb", "rgba", "hsl", "hsla", "color-mix"].includes(name)) {
      // strict IDE chrome: a var() fallback hex is banned (must be a pure token).
      if (strict && name === "var") return false;
      // ensure the "(" is still open at the hex (a fallback / color arg).
      const between = before.slice(open);
      const opens = (between.match(/\(/g) ?? []).length;
      const closes = (between.match(/\)/g) ?? []).length;
      if (opens > closes) return true;
    }
  }
  return false;
}

/** Guard self-test (APP-070): assert the strict rule trips on a seeded var() fallback. */
function selfTest() {
  const cases = [
    // [line, index-of-#, strict, expectedAllowed]
    ["color: var(--x, #fff)", "color: var(--x, ".length, true, false], // 3-digit → violation
    ["color: var(--x, #ffffffff)", "color: var(--x, ".length, true, false], // 8-digit alpha → violation
    ["color: var(--x, #6d5ef0)", "color: var(--x, ".length, false, true], // non-strict → allowed
    [
      "bg: color-mix(in srgb, red 50%, #0000)",
      "bg: color-mix(in srgb, red 50%, ".length,
      true,
      true,
    ], // color-mix hex arg → allowed even in strict
  ];
  let failed = 0;
  for (const [line, idx, strict, expected] of cases) {
    const got = isAllowed(line, idx, strict);
    if (got !== expected) {
      failed += 1;
      console.error(
        `  selftest FAIL: isAllowed(${JSON.stringify(line)}, strict=${strict}) = ${got}, want ${expected}`,
      );
    }
  }
  if (failed > 0) {
    console.error(`✗ no-raw-hex selftest: ${failed} case(s) failed.`);
    process.exit(1);
  }
  console.log(
    "✓ no-raw-hex selftest: strict var()-fallback rule trips on #fff and #ffffffff; rgb/color-mix + non-strict stay allowed.",
  );
  process.exit(0);
}
if (process.argv.includes("--selftest")) selfTest();

const files = [];
for (const s of SCAN) collect(join(ROOT, s), files);

const violations = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const strict = STRICT_FALLBACK.test(relative(ROOT, file)); // APP-070 token-pure IDE chrome
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // skip comment-only lines (doc examples like "#0b0d10" in a comment are fine).
    const trimmed = line.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    HEX.lastIndex = 0;
    let m = HEX.exec(line);
    while (m !== null) {
      if (!isAllowed(line, m.index, strict)) {
        violations.push(
          `${relative(ROOT, file)}:${i + 1}  ${m[0]}  →  ${line.trim().slice(0, 80)}`,
        );
      }
      m = HEX.exec(line);
    }
  }
}

if (violations.length > 0) {
  console.error(`✗ no-raw-hex: ${violations.length} bare color literal(s) outside tokens/ (§6):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nUse a BARE semantic token: var(--<token>). A `var(--x, #hex)` fallback is NOT" +
      " accepted (HANDOFF_2 §9) — it silently paints a stale palette when the token name is" +
      " wrong. rgb()/rgba()/hsl()/color-mix() hex ARGS are still fine (translucent tints)." +
      " Token source: packages/ui/src/tokens.ts.",
  );
  process.exit(1);
}

console.log(`✓ no-raw-hex: ${files.length} files scanned, no bare hex outside tokens/ (§6).`);
