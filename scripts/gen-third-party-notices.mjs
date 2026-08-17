#!/usr/bin/env node
/**
 * scripts/gen-third-party-notices.mjs — regenerate THIRD-PARTY-NOTICES.md.
 *
 *   node scripts/gen-third-party-notices.mjs           # write the file
 *   node scripts/gen-third-party-notices.mjs --check   # fail if it is out of date (CI)
 *
 * Apache-2.0 §4(d) requires us to carry the attribution notices of what we redistribute, and
 * the desktop app redistributes a lot: every runtime npm dependency, plus a relocatable
 * CPython whose PSF license must travel with the binary. Hand-maintaining that list guarantees
 * it goes stale, so it is generated from the two sources of truth — pnpm's resolved dependency
 * graph and pyruntime.lock.json — and CI diffs the result.
 *
 * Anything pnpm reports as `Unknown` is surfaced in its own section rather than quietly
 * bucketed: an unidentified license is a question to answer before shipping, not a footnote.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STUDIO = join(ROOT, "studio");
const OUT = join(ROOT, "THIRD-PARTY-NOTICES.md");
const CHECK = process.argv.includes("--check");

/**
 * pnpm's license report. `--prod` is the set that actually SHIPS; the full graph additionally
 * contains build tooling (biome, esbuild, electron-builder, changesets, playwright…) that no
 * user ever receives. Attribution obligations follow redistribution, so the two are reported
 * separately rather than merged into one alarming 649-line list.
 */
function pnpmLicenses(prodOnly) {
  const args = ["licenses", "list", "--json"];
  if (prodOnly) args.splice(2, 0, "--prod");
  try {
    const raw = execFileSync("pnpm", args, {
      cwd: STUDIO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch (err) {
    console.error(
      `gen-third-party-notices: \`pnpm ${args.join(" ")}\` failed.\n` +
        "Run `pnpm install` in studio/ first — the report is built from the resolved graph.\n" +
        String(err?.message ?? err),
    );
    process.exit(1);
  }
}

/** {license, pkgs[]} buckets, biggest first, package names sorted. */
function toBuckets(report) {
  return Object.entries(report)
    .map(([license, pkgs]) => ({
      license,
      pkgs: [...pkgs].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.pkgs.length - a.pkgs.length || a.license.localeCompare(b.license));
}

/** The pinned CPython that ships inside the desktop app as extraResources. */
function pyruntime() {
  try {
    const lock = JSON.parse(readFileSync(join(STUDIO, "pyruntime.lock.json"), "utf8"));
    return { source: lock.source, release: lock.release, version: lock.python };
  } catch {
    return null;
  }
}

const shipped = toBuckets(pnpmLicenses(true));
const everything = toBuckets(pnpmLicenses(false));
const py = pyruntime();

const count = (bs) => bs.reduce((n, b) => n + b.pkgs.length, 0);
const names = (bs) => new Set(bs.flatMap((b) => b.pkgs.map((p) => p.name)));
const shippedNames = names(shipped);
const buildOnly = everything
  .map((b) => ({ license: b.license, pkgs: b.pkgs.filter((p) => !shippedNames.has(p.name)) }))
  .filter((b) => b.pkgs.length > 0);

const unknownShipped = shipped.find((b) => /^unknown$/i.test(b.license));
const unknownBuild = buildOnly.find((b) => /^unknown$/i.test(b.license));

const out = [];
out.push("# Third-party notices");
out.push("");
out.push(
  "PROMETHEUS itself is Apache-2.0 (see `LICENSE` and `NOTICE`). It redistributes the",
  "components below. This file is GENERATED — run `node scripts/gen-third-party-notices.mjs`",
  "after changing dependencies; do not edit it by hand.",
);
out.push("");
out.push(
  `**${count(shipped)} redistributed packages** (${shipped.length} license identifiers), plus`,
  `${count(buildOnly)} build-time-only packages listed separately at the end. Attribution`,
  "obligations follow redistribution, so the distinction is kept explicit rather than merged.",
);
out.push("");
out.push("| License | Redistributed |");
out.push("|---|---:|");
for (const b of shipped) out.push(`| ${b.license} | ${b.pkgs.length} |`);
out.push("");

for (const [scope, bucket] of [
  ["redistributed", unknownShipped],
  ["build-time-only", unknownBuild],
]) {
  if (!bucket) continue;
  out.push(`## ${scope === "redistributed" ? "⚠" : "ℹ"} Unresolved licenses (${scope})`);
  out.push("");
  out.push(
    scope === "redistributed"
      ? "pnpm could not determine a license for the following, and they SHIP. Resolve each before a public release — check upstream, and replace or vendor the dependency if no license is granted at all."
      : "pnpm could not determine a license for the following. They are build tooling only and are never redistributed, so this does not block a release — but worth resolving.",
  );
  out.push("");
  for (const p of bucket.pkgs) out.push(`- \`${p.name}@${p.versions.join(", ")}\``);
  out.push("");
}

if (py) {
  out.push("## Python runtime (desktop app only)");
  out.push("");
  out.push(
    `The packaged desktop app bundles a relocatable CPython **${py.version}** (release`,
    `\`${py.release}\`) from [python-build-standalone](${py.source}), shipped as \`extraResources\``,
    "under `Resources/pyruntime/`.",
    "",
    "CPython is distributed under the **PSF License Agreement**; the standalone builds carry",
    "the licenses of their own bundled components (OpenSSL, SQLite, libffi, ncurses, zlib and",
    "others). The complete texts ship inside the runtime directory itself — see",
    "`Resources/pyruntime/` in a packaged app, or `studio/staging/pyruntime/<os>-<arch>/` in a",
    "build tree. The CLI does not bundle a runtime; it uses the system `python3`.",
  );
  out.push("");
}

out.push("## Redistributed packages");
out.push("");
for (const b of shipped) {
  if (b === unknownShipped) continue; // already listed above
  out.push(`### ${b.license}`);
  out.push("");
  for (const p of b.pkgs) out.push(`- \`${p.name}@${p.versions.join(", ")}\``);
  out.push("");
}

out.push("## Build-time only (not redistributed)");
out.push("");
out.push(
  "Toolchain used to produce the release — linters, bundlers, test runners, packagers.",
  "Listed for completeness; none of it reaches a user's machine.",
);
out.push("");
for (const b of buildOnly) {
  if (b === unknownBuild) continue;
  out.push(`### ${b.license}`);
  out.push("");
  for (const p of b.pkgs) out.push(`- \`${p.name}@${p.versions.join(", ")}\``);
  out.push("");
}

const text = `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;

if (CHECK) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing counts as out of date */
  }
  if (current !== text) {
    console.error(
      "THIRD-PARTY-NOTICES.md is out of date.\nRun: node scripts/gen-third-party-notices.mjs",
    );
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES.md is up to date (${count(shipped)} redistributed).`);
  process.exit(0);
}

writeFileSync(OUT, text);
console.log(
  `wrote THIRD-PARTY-NOTICES.md — ${count(shipped)} redistributed (${shipped.length} licenses), ` +
    `${count(buildOnly)} build-time only`,
);
// A shipped package with no identifiable license is a release blocker; a build-time one is not.
if (unknownShipped) {
  console.error(
    `error: ${unknownShipped.pkgs.length} REDISTRIBUTED package(s) have no resolved license: ` +
      `${unknownShipped.pkgs.map((p) => p.name).join(", ")}`,
  );
  process.exit(1);
}
if (unknownBuild) {
  console.warn(
    `note: ${unknownBuild.pkgs.length} build-time-only package(s) have no resolved license ` +
      `(${unknownBuild.pkgs.map((p) => p.name).join(", ")}) — not redistributed, not a blocker.`,
  );
}
