#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * release-preflight.mjs — prove the documented install routes could actually work.
 *
 * Both published install routes were broken, and neither failed in a way anybody would notice
 * from inside the repo:
 *
 *  - `curl … /-/raw/main/install.sh | bash` 403s because **install.sh is not on `main`**. It
 *    exists on a feature branch, and every local check passes because the file is right there
 *    on disk. Nothing in the repo compared "what the README tells a stranger to fetch" against
 *    "what the branch they will fetch it from actually contains".
 *  - `npx -y @prometheus-plugin/installer` 404s because the package was never published. The
 *    manifest is correct, `prepublishOnly` is correct, `publishConfig.access` is correct — the
 *    publish simply never happened.
 *
 * So this script checks the two things a build cannot: that the ARTIFACT runs, and that the
 * DOCUMENTED ROUTES are self-consistent. It publishes nothing and pushes nothing — releasing is
 * a human decision with human credentials.
 *
 * Exit 0 = every route is coherent. Exit 1 = at least one would fail for a new user, and the
 * message says which one and why.
 *
 * Usage:  node scripts/release-preflight.mjs [--skip-bundle] [--no-network]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(STUDIO, "..");
const TMP = join(STUDIO, "node_modules", ".preflight");

const problems = [];
const notes = [];
const fail = (what, why, fix) => problems.push({ what, why, fix });
const ok = (what) => notes.push(`  ✓ ${what}`);

/** Run a command, returning {code, stdout, stderr} — never throws. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/* ── 1. the artifact builds and RUNS ───────────────────────────────────────*/

const cliDir = join(STUDIO, "apps", "cli");
const cliPkg = readJson(join(cliDir, "package.json"));

if (!cliPkg) {
  fail("@prometheus/cli", "apps/cli/package.json is unreadable", "check the file");
} else if (!process.argv.includes("--skip-bundle")) {
  // `prepack` is what npm runs when publishing. If it fails, the tarball is broken no matter
  // what the registry says.
  const built = run("pnpm", ["--filter", "@prometheus/cli", "run", "prepack"], { cwd: STUDIO });
  if (built.code !== 0) {
    fail(
      "@prometheus/cli",
      `prepack failed:\n${built.stderr.trim().slice(0, 800)}`,
      "fix the build before publishing — the tarball would be unusable",
    );
  } else {
    ok("prepack builds dist/bin.js");
  }
}

const binJs = join(cliDir, "dist", "bin.js");
if (!existsSync(binJs)) {
  fail(
    "@prometheus/cli",
    "dist/bin.js does not exist after prepack",
    "run `pnpm --filter @prometheus/cli run prepack`",
  );
} else {
  /**
   * Run it the way an INSTALLED copy is laid out — `package.json` beside `dist/` — not from
   * inside the workspace.
   *
   * This matters more than it looks: the version is resolved by walking UP from the module
   * looking for a package.json named `@prometheus/cli`. Inside the repo that walk finds the
   * real one and reports the right number; from a wrong layout it silently falls back to
   * "0.0.0". Testing in place would prove nothing about the published artifact.
   */
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "dist"), { recursive: true });
  writeFileSync(join(TMP, "dist", "bin.js"), readFileSync(binJs));
  writeFileSync(join(TMP, "package.json"), JSON.stringify(cliPkg, null, 2));

  const ver = run(process.execPath, [join(TMP, "dist", "bin.js"), "--version"], { cwd: TMP });
  if (ver.code !== 0) {
    fail(
      "@prometheus/cli",
      `the published layout does not run: ${ver.stderr.trim().slice(0, 400)}`,
      "the bundle is missing something `files` does not ship",
    );
  } else if (!ver.stdout.includes(cliPkg.version)) {
    fail(
      "@prometheus/cli",
      `\`--version\` printed "${ver.stdout.trim()}" but package.json says ${cliPkg.version}`,
      "the version walk-up failed in the installed layout (it falls back to 0.0.0)",
    );
  } else {
    ok(`the installed layout runs and reports ${cliPkg.version}`);
  }

  const help = run(process.execPath, [join(TMP, "dist", "bin.js"), "--help"], { cwd: TMP });
  if (help.code !== 0)
    fail("@prometheus/cli", "`--help` exits non-zero in the installed layout", "");
  else ok("`--help` works with no workspace present");
  rmSync(TMP, { recursive: true, force: true });
}

/* ── 2. the tarball ships what it claims, and nothing else ─────────────────*/

/**
 * Read the `files` whitelist directly rather than shelling out to `npm pack --dry-run`.
 *
 * `npm pack` chokes inside a pnpm workspace (the `workspace:*` devDependencies are not
 * resolvable by npm), so it exited non-zero and this whole section silently did nothing —
 * a check that quietly no-ops is worse than no check, because the green output implies it ran.
 */
if (cliPkg) {
  const files = Array.isArray(cliPkg.files) ? cliPkg.files : [];
  if (files.length === 0) {
    fail(
      "@prometheus/cli",
      "package.json has no `files` whitelist — npm would publish the whole working directory",
      "add a `files` array",
    );
  } else {
    const risky = files.filter((f) => /(^|\/)(src|e2e)(\/|$)/.test(f) || f === "." || f === "*");
    if (risky.length > 0) {
      fail(
        "@prometheus/cli",
        `the \`files\` whitelist would ship sources: ${risky.join(", ")}`,
        "",
      );
    } else {
      ok(`the \`files\` whitelist is ${files.length} entr(y|ies), no sources`);
    }
    // A published package with no licence file is one nobody at a company may legally use.
    if (!files.some((f) => /^LICENSE/i.test(f))) {
      fail(
        "@prometheus/cli",
        "the tarball would carry no LICENSE file",
        "add a LICENSE to apps/cli and list it in `files`",
      );
    } else if (!existsSync(join(cliDir, files.find((f) => /^LICENSE/i.test(f)) ?? "LICENSE"))) {
      fail("@prometheus/cli", "`files` lists a LICENSE that does not exist in apps/cli", "");
    } else {
      ok("the tarball carries its LICENSE");
    }
    // A package whose declared licence disagrees with the repository's is a licensing question
    // nobody can resolve from the outside — surface it, never guess which one is right.
    const rootLicense = existsSync(join(REPO, "LICENSE"))
      ? readFileSync(join(REPO, "LICENSE"), "utf8").slice(0, 200)
      : "";
    const rootIsApache = /Apache License/i.test(rootLicense);
    if (rootIsApache && cliPkg.license && cliPkg.license !== "Apache-2.0") {
      /**
       * The repository is Apache-2.0 THROUGHOUT as of 2026-10-01, and this check now enforces
       * that rather than tolerating a documented exception.
       *
       * It previously accepted a divergence when the package shipped matching licence text,
       * because the client packages were deliberately MIT so they could be embedded with fewer
       * conditions. That trade was reversed before the first public release: MIT requires only
       * that the copyright line travel with copies, while Apache-2.0 §4(d) requires every
       * derivative work to reproduce the NOTICE file's attribution. The packages most likely to
       * be vendored into someone else's product were the ones with the weakest attribution.
       *
       * A package declaring something else now fails. If a future package genuinely needs a
       * different licence, that is a deliberate decision which should edit this check and say
       * why — not slip past it.
       */
      fail(
        "@prometheus/cli",
        `declares "license": "${cliPkg.license}" while this repository is Apache-2.0 throughout`,
        "set it to Apache-2.0, or change this check deliberately and record the reason",
      );
    } else if (cliPkg.license === "Apache-2.0") {
      const localText = existsSync(join(cliDir, "LICENSE"))
        ? readFileSync(join(cliDir, "LICENSE"), "utf8")
        : "";
      if (/Apache License/i.test(localText)) {
        ok('declares "Apache-2.0" and ships the matching LICENSE');
      } else {
        fail(
          "@prometheus/cli",
          "declares Apache-2.0 but ships no Apache licence text of its own",
          "cp LICENSE studio/apps/cli/LICENSE — a redistributed package must carry the licence it claims",
        );
      }
    }
  }
}

/* ── 3. the DOCUMENTED routes are self-consistent ──────────────────────────*/
/**
 * This is the section that would have caught the live breakage.
 *
 * The README tells a stranger to `curl …/-/raw/<ref>/install.sh`. Whether that works depends on
 * the REMOTE branch, which no local check ever looked at — the file is present on disk, so
 * everything in-repo agreed it was fine.
 */

const readme = existsSync(join(REPO, "README.md"))
  ? readFileSync(join(REPO, "README.md"), "utf8")
  : "";

// Every `-/raw/<ref>/<path>` the docs tell someone to fetch.
const rawRefs = [...readme.matchAll(/-\/raw\/([\w.\-/]+)\/([\w.\-/]+)/g)].map((m) => ({
  ref: m[1],
  path: m[2],
}));
const seenRaw = new Set();
for (const { ref, path } of rawRefs) {
  const key = `${ref}:${path}`;
  if (seenRaw.has(key)) continue;
  seenRaw.add(key);
  // `git cat-file` against the REMOTE-TRACKING ref: no network, and it answers the only
  // question that matters — will the file be there when a stranger asks for it?
  const probe = run("git", ["cat-file", "-e", `origin/${ref}:${path}`], { cwd: REPO });
  if (probe.code !== 0) {
    fail(
      `README → ${path}`,
      `the docs tell users to fetch "${path}" from "${ref}", but it is not on origin/${ref}`,
      `merge/push the branch that carries ${path} to ${ref} (this is the install.sh 403)`,
    );
  } else {
    ok(`origin/${ref} really serves ${path}`);
  }
}
if (rawRefs.length === 0) notes.push("  · no raw-fetch install route documented");

// Every `npx -y <pkg>` the docs (and the shipped adapter manifests) tell someone to run.
const npxTargets = new Set(
  [...readme.matchAll(/npx\s+(?:-y|--yes)\s+(@[\w.-]+\/[\w.-]+)/g)].map((m) => m[1]),
);
const adapters = join(REPO, "prometheus_plugin", "adapters");
if (existsSync(adapters)) {
  const found = run("grep", ["-rho", "@prometheus-plugin/[a-z-]*", adapters]);
  for (const name of found.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)) {
    npxTargets.add(name);
  }
}

/** Map a package NAME to the directory that declares it, if this repo declares it at all. */
const declared = new Map();
for (const rel of [
  "prometheus_plugin/installer",
  "prometheus_plugin/mcp-server",
  "prometheus_plugin/tui",
  "studio/apps/cli",
]) {
  const pkg = readJson(join(REPO, rel, "package.json"));
  if (pkg?.name) declared.set(pkg.name, { dir: rel, pkg });
}

for (const name of npxTargets) {
  const entry = declared.get(name);
  if (!entry) {
    fail(
      `docs → ${name}`,
      "the docs tell users to `npx` a package this repo does not declare",
      "fix the name in the docs, or add the package",
    );
    continue;
  }
  const { dir, pkg } = entry;
  if (pkg.private === true) {
    fail(`${name}`, `is documented as \`npx\`-able but is marked private in ${dir}`, "");
  } else if (pkg.publishConfig?.access !== "public") {
    fail(
      `${name}`,
      `is documented as \`npx\`-able but has no publishConfig.access:"public" (${dir})`,
      "a scoped package without it publishes restricted, and `npx` 404s for everyone else",
    );
  } else {
    ok(`${name} is declared and configured to publish publicly`);
  }
}

/* ── 4. the placeholder check ──────────────────────────────────────────────*/
/**
 * A shipped config carrying a literal placeholder path is worse than a missing one: the tool
 * connects, reports healthy, and every call fails.
 *
 * `.snippet` files are EXCLUDED, and the distinction is the whole point of this check. A
 * snippet is documentation — a block the user is told to copy and edit — so `/ABS/PATH/TO/…`
 * there is correct and replacing it with a real path would be the bug. A `.json` manifest that
 * an agent host reads directly is a different thing entirely.
 */
if (existsSync(adapters)) {
  const ph = run("grep", ["-rln", "--include=*.json", "/ABS/PATH", adapters]);
  const hits = ph.stdout.split("\n").filter(Boolean);
  if (hits.length > 0) {
    fail(
      "adapter manifests",
      `${hits.length} shipped manifest(s) an agent host reads DIRECTLY contain the literal placeholder "/ABS/PATH": ${hits
        .map((h) => h.replace(`${REPO}/`, ""))
        .join(", ")}`,
      "these connect and then fail every call — resolve the path at install time instead",
    );
  } else {
    ok("no shipped manifest carries a placeholder engine path");
  }
}

/* ── 4. the raw URL is reachable BY A STRANGER ─────────────────────────────*/
/**
 * The check above proves the file is on the branch. It cannot prove anyone can FETCH it.
 *
 * `git cat-file -e origin/main:install.sh` answers using the local remote-tracking ref, which
 * exists because THIS clone is authenticated. A private project answers the same branch, the same
 * file, and `403` to the whole internet — so every in-repo signal agrees the install route works
 * while `curl -fsSL … | bash` delivers zero bytes to every user who tries it.
 *
 * Measured on this project, unauthenticated:
 *   GET  /-/raw/main/install.sh                     → 302 (redirect to sign-in)
 *   curl -fsSL (which follows, and -f rejects)      → exit 22, 0 bytes
 *   GET  /api/v4/projects/<ns>%2F<name>             → 404 {"message":"404 Project Not Found"}
 * GitLab returns 404 rather than 403 for a private project so an anonymous caller cannot even
 * confirm it exists. Both are definitive answers about VISIBILITY, not transport failures.
 *
 * NETWORK-OPTIONAL BY DESIGN. Being offline is not a release defect, and a gate that fails on a
 * train is a gate people stop running. Only a definitive HTTP answer counts; anything else is a
 * note. Skip entirely with --no-network.
 */
if (!process.argv.includes("--no-network")) {
  const remote = run("git", ["remote", "get-url", "origin"], { cwd: REPO }).stdout.trim();
  const m = /gitlab\.com[:/](.+?)(?:\.git)?$/.exec(remote);
  if (!m) {
    notes.push(
      `  · origin is not a gitlab.com remote (${remote || "none"}) — raw-URL check skipped`,
    );
  } else {
    const project = m[1];
    const url = `https://gitlab.com/${project}/-/raw/main/install.sh`;
    // `-o /dev/null -w %{http_code}` with NO -L: a redirect is the answer, not something to follow.
    const probe = run("curl", ["-sS", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", url], {
      cwd: REPO,
    });
    const status = probe.stdout.trim();
    if (probe.code !== 0 || !/^[1-5]\d\d$/.test(status)) {
      notes.push(
        "  · could not reach gitlab.com to check the raw URL (offline?) — not treated as a failure",
      );
    } else if (status === "200") {
      ok("the raw install URL is publicly fetchable (HTTP 200)");
    } else {
      fail(
        "curl | bash install route",
        `${url} answers HTTP ${status} to an ANONYMOUS request, so \`curl -fsSL … | bash\` delivers nothing to a new user`,
        status === "302" || status === "401" || status === "403" || status === "404"
          ? "the project is private — make it public (GitLab → Settings → General → Visibility), then re-run. Until then this command in the README does not work for anybody."
          : `investigate the ${status} before publishing the README command`,
      );
    }
  }
}

/* ── 5. the GitHub mirror's README is still the same README ────────────────*/
/**
 * `.github/README.md` exists because GitHub renders it IN PREFERENCE to the root `README.md`
 * (precedence: `.github/README.md` > `README.md` > `docs/README.md`), while GitLab has no such
 * rule and renders the root one, ignoring `.github/` entirely. One repository, two forges, one
 * landing page each — and they are supposed to be the SAME page.
 *
 * The failure mode is silent and slow: someone edits the root README, the GitLab page updates,
 * and the GitHub mirror keeps serving a copy that is a month stale — including, eventually, an
 * install command that no longer matches the script. Nothing surfaces it, because both files are
 * valid Markdown and neither is broken.
 *
 * So the invariant is BYTE EQUALITY, checked here rather than trusted to memory.
 */
{
  const rootReadme = join(REPO, "README.md");
  const ghReadme = join(REPO, ".github", "README.md");
  if (!existsSync(ghReadme)) {
    notes.push("  · no .github/README.md — GitHub would render the root README (fine, but see §5)");
  } else if (!existsSync(rootReadme)) {
    fail("README", "root README.md is missing", "restore it");
  } else if (readFileSync(rootReadme, "utf8") !== readFileSync(ghReadme, "utf8")) {
    fail(
      ".github/README.md",
      "the GitHub mirror's README has drifted from the root README.md, so the two forges would show different pages",
      "cp README.md .github/README.md",
    );
  } else {
    ok(".github/README.md is byte-identical to README.md");
  }
}

/* ── report ────────────────────────────────────────────────────────────────*/

console.log("release preflight\n");
for (const n of notes) console.log(n);
if (problems.length === 0) {
  console.log("\n✓ every documented install route is coherent.");
  process.exit(0);
}
console.log(`\n✗ ${problems.length} problem(s) a new user would hit:\n`);
for (const p of problems) {
  console.log(`  ${p.what}`);
  console.log(`    ${p.why}`);
  if (p.fix) console.log(`    → ${p.fix}`);
  console.log("");
}
process.exit(1);
