/**
 * probe.test.ts — install-method detection for Prometheus ITSELF.
 *
 * Every case here is a layout the previous classifier got wrong, and the assertion names the
 * wrong answer it used to give. The stakes are not cosmetic: the method selects the one command
 * the user is told to paste, and the old "brew" branch selected `brew upgrade prometheus` — a
 * real Homebrew formula belonging to the CNCF monitoring server, not to this project.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { detectInstallMethod } from "./probe.js";

const HOME = "/Users/someone";

/** A fake filesystem: only the listed paths exist, and symlinks resolve through `links`. */
function fs(paths: readonly string[], links: Record<string, string> = {}) {
  const set = new Set(paths);
  return {
    home: HOME,
    exists: (p: string) => set.has(p),
    realpath: (p: string) => {
      const target = links[p];
      if (target === undefined) {
        if (!set.has(p)) throw new Error(`ENOENT ${p}`);
        return p;
      }
      return target;
    },
  };
}

test("REGRESSION: an npm global under Homebrew's node is npm-global, not brew", () => {
  /**
   * The bug. `/opt/homebrew/bin/prometheus` is a symlink into `lib/node_modules`; the old code
   * matched `/homebrew/` on the UNRESOLVED shim and answered "brew", which produced
   * `brew upgrade prometheus`. Homebrew has no package for this project — but it does have one
   * by that exact name.
   */
  const d = fs(["/opt/homebrew/lib/node_modules/@prometheus/cli/dist/index.js"], {
    "/opt/homebrew/bin/prometheus": "/opt/homebrew/lib/node_modules/@prometheus/cli/dist/index.js",
  });
  assert.deepEqual(detectInstallMethod("/opt/homebrew/bin/prometheus", "/tmp", d), {
    method: "npm-global",
  });
});

test("the symlink is resolved before anything is classified", () => {
  /**
   * Node does NOT resolve `process.argv[1]` — measured. Every install method presents as a
   * symlink, so without this the classifier reads a shim in a `bin` directory and learns nothing.
   */
  const target = `${HOME}/.local/share/npm/lib/node_modules/@prometheus/cli/bin/prom.js`;
  const d = fs([target], { [`${HOME}/.local/bin/prometheus`]: target });
  assert.equal(
    detectInstallMethod(`${HOME}/.local/bin/prometheus`, "/tmp", d).method,
    "npm-global",
  );
});

test("the installer's managed checkout gets its own method, with the directory filled in", () => {
  /**
   * `install.sh` clones to ~/.prometheus and symlinks ~/.local/bin/prometheus at it. That IS a
   * git checkout, but not one the user chose or can name — so it must not be reported as "git"
   * with a `git -C` into a path they have never seen.
   */
  const src = `${HOME}/.prometheus/bin/prometheus`;
  const d = fs([src, `${HOME}/.prometheus/.git`, `${HOME}/.prometheus/prometheus.py`], {
    [`${HOME}/.local/bin/prometheus`]: src,
  });
  assert.deepEqual(detectInstallMethod(`${HOME}/.local/bin/prometheus`, "/tmp", d), {
    method: "installer",
    repoDir: `${HOME}/.prometheus`,
  });
});

test("REGRESSION: a .git ancestor is only claimed when it is THIS project", () => {
  /**
   * The old walk went eight levels up and returned the first `.git` it found. From a global npm
   * prefix under $HOME that reaches a dotfiles-managed home directory — and the user was told to
   * run `git -C /Users/someone pull --ff-only` to update Prometheus.
   */
  const bin = `${HOME}/somewhere/bin/prometheus`;
  const dotfiles = fs([bin, `${HOME}/.git`]); // a .git at $HOME, no project markers
  assert.deepEqual(detectInstallMethod(bin, "/tmp", dotfiles), { method: "unknown" });

  // With the project markers present, the same shape IS the checkout.
  const real = fs([bin, `${HOME}/somewhere/.git`, `${HOME}/somewhere/prometheus.py`]);
  assert.deepEqual(detectInstallMethod(bin, "/tmp", real), {
    method: "git",
    repoDir: `${HOME}/somewhere`,
  });
});

test("the monorepo marker also identifies a checkout", () => {
  const bin = "/w/PROMETHEUS/studio/apps/cli/dist/index.js";
  const d = fs([bin, "/w/PROMETHEUS/.git", join("/w/PROMETHEUS", "studio", "pnpm-workspace.yaml")]);
  assert.deepEqual(detectInstallMethod(bin, "/tmp", d), {
    method: "git",
    repoDir: "/w/PROMETHEUS",
  });
});

test("pipx is recognised, and does not fall through to the git walk", () => {
  const p = `${HOME}/Library/Application Support/pipx/venvs/prometheus/bin/prometheus`;
  assert.equal(detectInstallMethod(p, "/tmp", fs([p, `${HOME}/.git`])).method, "pipx");
});

test("an unresolvable path is classified from its literal form rather than throwing", () => {
  // A dangling symlink on PATH is a real thing (an uninstalled tool's leftover shim). The probe
  // must degrade, not crash a startup check.
  const d = fs([]);
  assert.equal(
    detectInstallMethod("/gone/lib/node_modules/@prometheus/cli/x", "/tmp", d).method,
    "npm-global",
  );
});

test("nothing recognisable is `unknown` — never a guess", () => {
  const d = fs(["/opt/weird/prometheus"]);
  assert.deepEqual(detectInstallMethod("/opt/weird/prometheus", "/tmp", d), { method: "unknown" });
});

test("a Homebrew Cellar path is UNKNOWN, not brew — there is no brew package for this project", () => {
  /**
   * The load-bearing consequence of removing `brew` from `InstallMethod`. A path under a brew
   * prefix means the detection is wrong, and "unknown" offers every real option; "brew" offered
   * one command that cannot work and suppressed the others (`ambiguous: false`).
   */
  const p = "/opt/homebrew/Cellar/prometheus/3.7.0/bin/prometheus";
  assert.deepEqual(detectInstallMethod(p, "/tmp", fs([p])), { method: "unknown" });
});
