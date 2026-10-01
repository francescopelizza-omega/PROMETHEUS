// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/resolve.ts — find every installed copy of a tool, and attribute each one.
 *
 * The IO half of `packages/core/src/updates/install-owner.ts`: this file does the `realpath`, the
 * `Info.plist` read and the version probe; core makes every decision. The split exists so the
 * decisions stay testable without a filesystem, and because the decisions are the part that was
 * wrong.
 *
 * ── THE ONE SECURITY RULE ───────────────────────────────────────────────────────────────────
 *
 * **Only the PATH winner is ever executed.** A shadowed copy is by definition one the user did
 * not choose to run; spawning it to ask its version would mean running an unexpected binary
 * chosen by whatever happens to sit on PATH — which is the mechanism of a PATH-hijack, performed
 * by the tool that is supposed to be auditing for exactly this. Every other copy is versioned
 * from its own path (`Cellar/<f>/<v>`, `Caskroom/<t>/<v>`, `versions/<v>`), which costs nothing,
 * or is honestly reported as unknown.
 *
 * The winner is different: the user runs it on every command anyway, so `--version` adds no new
 * trust. Even there the ABSOLUTE resolved path is spawned rather than the bare name, so the probe
 * cannot pick a different copy than the one being described.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { lookPathAll } from "../agent/system/host/host-tool-probe.js";
import * as u from "../updates/index.js";

import { cliVersion } from "./probe.js";

const nodeRequire = createRequire(import.meta.url);

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * The USER's home (`$HOME`), for the `~/.local/share/<tool>/versions/<v>`, cargo and go layouts.
   *
   * ── WHY THIS IS NOT CALLED `home` ─────────────────────────────────────────────────────────
   *
   * It was, and the name collided with a DIFFERENT `home` meaning something else entirely.
   * `CheckDeps.home` is the PROMETHEUS STATE DIRECTORY (`~/.prometheus`, consumed by `statePath`),
   * and `CheckDeps extends ToolSweepDeps extends ResolveDeps` — so two fields with the same name
   * and the same `string` type merged into one. `checkUpdates` passes its whole deps object down
   * to `sweepTools`, which hands it to `resolveToolCheck`, and this file then read the state
   * directory as if it were the user's home.
   *
   * `tsc` reports nothing. Both are `string`, so the shadowing is invisible to the type checker
   * and the code stays perfectly type-correct while being wrong everywhere it matters.
   *
   * The damage is silent MISATTRIBUTION. `classifyPath`'s `underHome()` compares a real binary
   * path against this value, so with `~/.prometheus` every $HOME-based layout fails to match and
   * the install falls through to `unknown`. Measured: `opencode`, a native-installer layout under
   * `~/.opencode`, came back "unattributed" — every `UpdateCommand` row was then withheld by
   * `partitionCommands`, and the report printed "no update command applies to how this copy was
   * installed" for a tool that has a perfectly good `opencode upgrade`.
   *
   * Renamed rather than patched at the call site, because a call-site fix leaves the trap armed
   * for the next field either interface adds.
   */
  userHome?: string;
  /** test seams. */
  lookAll?: (bin: string, env: NodeJS.ProcessEnv) => string[];
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
  readAppVersion?: (bundle: string) => string | null;
  probeVersion?: (absPath: string, args: readonly string[]) => string | null;
}

/**
 * A macOS app's real version, from its `Info.plist`.
 *
 * `CFBundleShortVersionString` is the marketing version (`0.34.1`) and the one every other
 * source means; `CFBundleVersion` is a build number. The plist is usually binary, so `defaults`
 * is the reliable reader — parsing XML would work for some apps and silently fail for the rest.
 *
 * This is the only mechanism that can see the version of an app bundle at all, and the ollama row
 * in `tool-registry.ts` has declared `appBundle` since it was written with nothing reading it.
 */
export function readAppBundleVersion(bundle: string): string | null {
  const plist = join(bundle, "Contents", "Info.plist");
  if (!existsSync(plist)) return null;
  try {
    const cp = nodeRequire("node:child_process") as {
      spawnSync?: (
        c: string,
        a: readonly string[],
        o: Record<string, unknown>,
      ) => { stdout?: string };
    };
    if (typeof cp.spawnSync !== "function") return null;
    const r = cp.spawnSync("defaults", ["read", plist, "CFBundleShortVersionString"], {
      timeout: 3000,
      encoding: "utf8",
      shell: false,
    });
    const v = (r.stdout ?? "").trim();
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

/**
 * Walk up from a binary looking for the marker that tells a pipx venv from a hand-made one.
 *
 * A pipx venv contains `pyvenv.cfg` exactly like any other venv — measured — so the cfg cannot
 * discriminate, and the location cannot either: `PIPX_HOME` overrides it, macOS puts venvs under
 * `~/Library/Application Support/pipx`, Linux under `~/.local/share/pipx`. The sibling
 * `pipx_metadata.json` is the one artifact only pipx writes.
 *
 * Bounded to four levels: a venv binary is `<venv>/bin/<name>`, so two is the normal answer and
 * four is generous. An unbounded walk would eventually find a `pyvenv.cfg` belonging to something
 * else entirely.
 */
function pythonHints(realPath: string, exists: (p: string) => boolean): u.OwnerHints {
  let dir = dirname(realPath);
  for (let i = 0; i < 4 && dir !== dirname(dir); i++) {
    if (exists(join(dir, "pipx_metadata.json"))) return { pipxVenv: true, pyvenvCfg: true };
    if (exists(join(dir, "pyvenv.cfg"))) return { pyvenvCfg: true };
    dir = dirname(dir);
  }
  return {};
}

/**
 * The `version` from the `package.json` that owns an npm-installed binary.
 *
 * Walks up from the launcher to the package root — `…/node_modules/@openai/codex/bin/codex.js`
 * has its manifest three levels up, an unscoped package two. Bounded to six levels, because an
 * unbounded walk eventually finds the manifest of something else entirely (the workspace root,
 * or `/`), and a confidently wrong version is worse than none.
 */
function npmPackageVersion(realPath: string, exists: (p: string) => boolean): string | null {
  let dir = dirname(realPath);
  for (let i = 0; i < 6 && dir !== dirname(dir); i++) {
    const manifest = join(dir, "package.json");
    if (exists(manifest)) {
      const j = readJsonFile<{ version?: unknown; name?: unknown }>(manifest);
      const v = j?.version;
      return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Resolve every copy of `bin` on PATH, attribute each, and version them.
 *
 * `probeWinner` defaults to true. It is the caller's to turn off — a background startup sweep may
 * legitimately decide that even one spawn per tool is more than it wants to pay, and every copy
 * still gets its path version.
 */
export function resolveCopies(
  bin: string,
  opts: {
    versionArgs?: readonly string[];
    appBundle?: string | readonly string[];
    probeWinner?: boolean;
  } = {},
  deps: ResolveDeps = {},
): u.ToolCopy[] {
  const env = deps.env ?? process.env;
  const home = deps.userHome ?? homedir();
  const platform = deps.platform ?? process.platform;
  const look = deps.lookAll ?? ((b, e) => lookPathAll(b, e));
  const rp = deps.realpath ?? ((p) => realpathSync.native(p));
  const exists = deps.exists ?? existsSync;
  const readApp = deps.readAppVersion ?? readAppBundleVersion;
  const probe = deps.probeVersion ?? ((p, a) => cliVersion(p, a));

  const out: u.ToolCopy[] = [];
  /**
   * Deduped by REALPATH, not by PATH entry.
   *
   * Two PATH entries resolving to the same file is a duplicated PATH, not a second install, and
   * reporting it as a shadow would cry wolf on a very common shell-rc mistake. Two entries
   * resolving to DIFFERENT files is the finding.
   */
  const seen = new Set<string>();

  for (const pathEntry of look(bin, env)) {
    let realPath = pathEntry;
    try {
      realPath = rp(pathEntry);
    } catch {
      /* a dangling symlink on PATH: keep the literal path, classify what we can */
    }
    if (seen.has(realPath)) continue;
    seen.add(realPath);

    const info = u.classifyPath(realPath, { home, ...pythonHints(realPath, exists) });
    const copy: u.ToolCopy = {
      pathEntry,
      realPath,
      owner: info.owner,
      ...(info.name ? { name: info.name } : {}),
      ...(info.version ? { version: info.version, versionSource: "path" as const } : {}),
    };
    /**
     * An npm layout puts the version in `package.json`, not in the path — so without this read a
     * shadowed npm copy has NO version, which turns a decidable comparison into `ambiguous`.
     * Measured: codex is installed as a brew cask (0.157.1) and as an npm global, and the npm
     * copy's number is only in its manifest.
     *
     * A file read, never an execution: the rule that a shadowed binary is not run still holds.
     */
    if (!copy.version && (info.owner === "npm-global" || info.owner === "pnpm-global")) {
      const v = npmPackageVersion(realPath, exists);
      if (v) {
        copy.version = v;
        copy.versionSource = "path";
      }
    }
    out.push(copy);
  }

  /* --- the app bundle, which may not be on PATH at all --- */
  /**
   * The first candidate bundle that actually exists. A list, because the single hardcoded path
   * for LM Studio pointed at a bundle this machine does not have — see `ToolCheck.appBundle`.
   */
  const bundle =
    platform === "darwin" && opts.appBundle
      ? (typeof opts.appBundle === "string" ? [opts.appBundle] : opts.appBundle).find((b) =>
          exists(b),
        )
      : undefined;
  if (bundle) {
    const v = readApp(bundle);
    const already = out.find((c) => c.realPath.startsWith(`${bundle}/`));
    if (already) {
      // The bundle IS on PATH via a symlink. Its Info.plist is the only version it has, so fill
      // it in rather than leaving the comparison unknown.
      if (v && !already.version) {
        already.version = v;
        already.versionSource = "bundle";
      }
    } else {
      /**
       * An installed app with no PATH entry still owns the port, the model store and the
       * update channel. Omitting it is how "ollama is at 0.34.4" gets reported for a machine
       * whose server is 0.34.1 — so it is appended as a copy that simply never wins PATH.
       */
      out.push({
        pathEntry: bundle,
        realPath: bundle,
        owner: "app-bundle",
        name:
          bundle
            .split("/")
            .pop()
            ?.replace(/\.app$/, "") ?? bin,
        ...(v ? { version: v, versionSource: "bundle" as const } : {}),
      });
      /**
       * The app's version IS the tool's version when its CLI has none of its own.
       *
       * Measured on LM Studio: `lms` lives at `~/.lmstudio/bin/lms`, is installed by the app, and
       * `lms --version` prints `CLI commit: 71bd99c` — a git commit, which `parseCliVersion`
       * correctly refuses to read as a version. So the PATH winner carried no version, `current`
       * stayed null, and the report said "installed version unreadable" for a product whose
       * version was sitting in an Info.plist we had just read.
       *
       * Deliberately gated on the winner having NO version, which is what keeps it honest for the
       * other app-backed tool here: ollama's PATH copy is a Homebrew formula with its own real
       * version (0.34.4) that genuinely differs from the app's (0.34.1). That difference is a
       * FINDING — `client-server-skew` — and overwriting it would erase the finding. This branch
       * cannot fire there, because the winner already has a version.
       */
      const top = out[0];
      if (v && top && !top.version) {
        top.version = v;
        top.versionSource = "bundle";
      }
    }
  }

  /* --- and only now, the one binary we are allowed to run --- */
  const winner = out[0];
  if (winner && opts.probeWinner !== false && !winner.version) {
    const v = probe(winner.realPath, opts.versionArgs ?? ["--version"]);
    if (v) {
      winner.version = v;
      winner.versionSource = "probe";
    }
  }
  return out;
}

/** Resolve a whole `ToolCheck` row: every copy, attributed, folded into a verdict. */
export function resolveToolCheck(tool: u.ToolCheck, deps: ResolveDeps = {}): u.ToolResolution {
  if (!tool.probe && !tool.appBundle) return u.resolveTool(tool.id, []);
  const copies = tool.probe
    ? resolveCopies(
        tool.probe.bin,
        {
          versionArgs: tool.probe.args,
          ...(tool.appBundle ? { appBundle: tool.appBundle } : {}),
        },
        deps,
      )
    : resolveCopies(tool.id, { ...(tool.appBundle ? { appBundle: tool.appBundle } : {}) }, deps);
  return u.resolveTool(tool.id, copies);
}

/**
 * npm's global bin directory — where `npm install -g` actually puts a launcher.
 *
 * Measured on this machine: a `codex update` run rewrote `~/.npmrc` to point npm's global prefix
 * at `~/.local/share/npm`, whose `bin` NOTHING adds to PATH. `npm install -g` then reports
 * success and links a binary no shell will ever find — which reads, from the outside, exactly
 * like "the update did nothing".
 *
 * `npm bin -g` was REMOVED in npm 9, so the prefix is asked for instead. Windows puts global bins
 * in the prefix itself rather than in `<prefix>/bin`.
 */
export function npmGlobalBinDir(
  deps: {
    platform?: NodeJS.Platform;
    run?: (cmd: string, args: readonly string[]) => string | null;
  } = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const run =
    deps.run ??
    ((cmd: string, args: readonly string[]): string | null => {
      try {
        const cp = nodeRequire("node:child_process") as {
          spawnSync?: (
            c: string,
            a: readonly string[],
            o: Record<string, unknown>,
          ) => { stdout?: string; status?: number | null };
        };
        if (typeof cp.spawnSync !== "function") return null;
        const r = cp.spawnSync(cmd, args, { timeout: 8000, encoding: "utf8", shell: false });
        if (r.status !== 0) return null;
        const s = (r.stdout ?? "").trim();
        return s === "" ? null : s;
      } catch {
        return null;
      }
    });
  const prefix = run("npm", ["prefix", "-g"]);
  if (!prefix) return null;
  return platform === "win32" ? prefix : join(prefix, "bin");
}

/**
 * Is `dir` reachable from this PATH?
 *
 * Compared by REALPATH. `~/.local/bin` and `/Users/x/.local/bin` are the same directory spelled
 * two ways, and a string comparison would call a working npm prefix broken.
 */
export function onSearchPath(
  dir: string,
  deps: { env?: NodeJS.ProcessEnv; realpath?: (p: string) => string } = {},
): boolean {
  const env = deps.env ?? process.env;
  const rp = deps.realpath ?? ((p) => realpathSync.native(p));
  const norm = (p: string): string => {
    try {
      return rp(p);
    } catch {
      return p.replace(/\/+$/, "");
    }
  };
  const target = norm(dir);
  return (env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((d) => norm(d) === target);
}

/**
 * Read a JSON file, fail-soft.
 *
 * Used for Homebrew's own on-disk receipts, which answer questions `brew` would otherwise have
 * to be spawned for — and answer them offline.
 */
export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
