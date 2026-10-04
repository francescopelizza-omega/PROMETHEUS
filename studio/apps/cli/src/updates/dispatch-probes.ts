// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/dispatch-probes.ts — the machine facts "update everything" needs before it may plan.
 *
 * Every probe is READ-ONLY and every one fails CLOSED: a probe that cannot answer returns `null`
 * (or a fact that refuses), and the planner turns everything that depended on the answer into a
 * line for the user to run. Each exists because the report alone was measured to be insufficient:
 *
 *   • casks — `brew outdated --json` names a cask by its bare token. What actually runs on upgrade
 *     is decided by the INSTALLED cask: its install receipt (`Caskroom/<token>/.metadata/
 *     INSTALL_RECEIPT.json`) records the tap it came from and the uninstall artifacts the upgrade
 *     will execute first — `brew info` would resolve the bare token to today's official cask.
 *     `brew info --json=v2` adds the checksum, `auto_updates`, `disabled`, and the new artifacts
 *     with every target resolved to an absolute path.
 *   • formulae — `brew upgrade X` moves X's dependencies and dependents too (dispatch.ts header).
 *     The Cellar's install receipts record each keg's runtime closure and its tap, on disk; `brew
 *     deps` adds what each outdated formula's CURRENT definition needs, which a new bottle can add.
 *   • brew.env — brew exports its env files OVER the environment a step starts with (bin/brew), so
 *     a line there can undo what the dispatch sets.
 *   • npm's global root — a global that is a symlink is an `npm link`ed checkout; a root or bin
 *     directory this user cannot write to fails every install with EACCES.
 *   • a venv — a `uv tool` environment has no pip; a PROJECT's environment, or one where other
 *     packages require the one being upgraded, is not the tool's to change.
 *   • the model store — the free-space figure is only meaningful for the store the daemon writes.
 */
import { constants, accessSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { updates as u } from "@prometheus/core";
import { ollamaModelsDir, readLocalManifest } from "@prometheus/core/updates-live";

import type { StepRunner } from "./run-step.js";

export interface DispatchProbes {
  /** facts per outdated cask token; null when brew could not answer. */
  casks(
    tokens: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, u.CaskFacts> | null>;
  /**
   * installed formula → closure + tap, each of `outdated` joined with its current definition's
   * closure; null when the Cellar, a receipt or `brew deps` could not be read.
   */
  formulae(
    outdated: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, u.FormulaFacts> | null>;
  /** what the user's brew.env files set that a step's environment relies on; null on failure. */
  brewEnv(signal?: AbortSignal): Promise<readonly string[] | null>;
  /** npm's global root, its writability, and which of `names` are `npm link`ed; null on failure. */
  npmGlobal(names: readonly string[], signal?: AbortSignal): Promise<u.NpmGlobalFacts | null>;
  venv(root: string, pkg: string): u.VenvFacts;
  /** the measured ollama store holds this tag. */
  modelStoreHas(tag: string): boolean;
  /** the store whose free space is measured — printed so a wrong guess is visible. */
  modelStorePath(): string;
}

/**
 * Uninstall directives whose brew implementation always runs `sudo` (cask/artifact/abstract_uninstall.rb).
 * An upgrade runs the OLD cask's uninstall before the new install — with HOMEBREW_NO_SUDO it then
 * stops half-way, after agents and login items are already gone, and brew does not roll that back.
 * Refused up front instead.
 */
const ROOT_UNINSTALL_KEYS = ["delete", "pkgutil", "kext"] as const;

/**
 * Ruby flight blocks that run inside the OLD cask's uninstall. JSON records only that they exist
 * (`{ "uninstall_postflight": null }`), never what they run, so they are assumed to need root.
 * (`preflight`/`postflight` belong to the new install, which brew does roll back.)
 */
const UNINSTALL_FLIGHT_BLOCKS: readonly string[] = ["uninstall_preflight", "uninstall_postflight"];

/**
 * A step brew counts as privileged (`sudo_required?`, cask/artifact/install_steps.rb) — or may
 * escalate. `set_ownership` alone is not: brew runs its chown without sudo under HOMEBREW_NO_SUDO.
 */
function privilegedStep(step: unknown): boolean {
  if (typeof step !== "object" || step === null) return false;
  const s = step as { sudo?: unknown; type?: unknown };
  return s.sudo === true || s.sudo === "if_needed" || s.type === "delete_keychain_certificate";
}

/** Every target an artifact names: brew info's resolved `target`, and any explicit `target:`. */
function targetsOf(art: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  if (typeof art.target === "string") out.push(art.target);
  for (const v of Object.values(art)) {
    if (!Array.isArray(v)) continue;
    for (const x of v) {
      const t =
        typeof x === "object" && x !== null ? (x as { target?: unknown }).target : undefined;
      if (typeof t === "string") out.push(t);
    }
  }
  return out;
}

/**
 * May this user put `target` in place, or take it away, without root?
 *
 * Moving an artifact in or out takes write access to the directory that holds it — the nearest one
 * that exists, where brew would create the rest (with sudo, as root, into /Library). A relative
 * target lives under one of brew's default directories, all of them in the home folder or brew's
 * prefix; keyboard layouts, the one exception, are refused by their key.
 */
export function targetWritable(target: string, home: string = homedir()): boolean {
  if (!isAbsolute(target) && !target.startsWith("~")) return true;
  let dir = dirname(target.startsWith("~") ? join(home, target.slice(1)) : target);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does this cask artifact list need root to install, or to remove what it installed?
 *
 * Mirrors what brew actually escalates for, measured against Homebrew 7's cask artifacts: a `.pkg`
 * or `installer`, a keyboard layout (/Library/Keyboard Layouts), a privileged `*_steps` step, an
 * uninstall flight block, an uninstall directive that always runs sudo, and any target in a folder
 * this user cannot write to (e.g. an `artifact` under /Library/Application Support).
 */
export function caskNeedsRoot(
  artifacts: unknown,
  canWrite: (target: string) => boolean = (t) => targetWritable(t),
): boolean {
  if (!Array.isArray(artifacts)) return true; // unreadable ⇒ assume the worst
  for (const a of artifacts) {
    if (typeof a !== "object" || a === null) continue;
    const art = a as Record<string, unknown>;
    // A .pkg (or a cask `installer`) runs its scripts as root.
    if ("pkg" in art || "installer" in art || "keyboard_layout" in art) return true;
    for (const [key, value] of Object.entries(art)) {
      if (key.split(", ").some((k) => UNINSTALL_FLIGHT_BLOCKS.includes(k))) return true;
      if (!key.endsWith("_steps") || !Array.isArray(value)) continue;
      for (const group of value) {
        const steps =
          typeof group === "object" && group !== null
            ? (group as { steps?: unknown }).steps
            : undefined;
        if (Array.isArray(steps) && steps.some(privilegedStep)) return true;
      }
    }
    if (targetsOf(art).some((t) => !canWrite(t))) return true;
    const uninstall = art.uninstall;
    if (!Array.isArray(uninstall)) continue;
    for (const d of uninstall) {
      if (typeof d !== "object" || d === null) continue;
      const dir = d as Record<string, unknown>;
      if (ROOT_UNINSTALL_KEYS.some((k) => k in dir)) return true;
      for (const k of ["script", "early_script"]) {
        const s = dir[k];
        if (typeof s === "object" && s !== null && (s as { sudo?: unknown }).sudo === true) {
          return true;
        }
      }
    }
  }
  return false;
}

/** What the installed copy of a cask says about itself (its install receipt). */
export interface CaskReceipt {
  /** "" when the receipt records no tap: a cask installed from a file or a URL. */
  tap: string;
  uninstallArtifacts?: unknown;
  /** the installed cask has Ruby uninstall flight blocks (`uninstall_flight_blocks`). */
  flightBlocks: boolean;
}

/**
 * `brew info --json=v2 --cask` output + each token's install receipt → facts per token.
 *
 * The receipt WINS for the tap and the uninstall: they describe what is installed, which is what
 * the upgrade replaces. A token with no receipt is reported as such (`receipt: false`) — brew's
 * view of today's cask says nothing about where the installed copy came from.
 */
export function parseCaskInfo(
  stdout: string,
  receipts: ReadonlyMap<string, CaskReceipt>,
  canWrite: (target: string) => boolean = (t) => targetWritable(t),
): ReadonlyMap<string, u.CaskFacts> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  const casks = (doc as { casks?: unknown })?.casks;
  if (!Array.isArray(casks)) return null;
  const out = new Map<string, u.CaskFacts>();
  for (const raw of casks) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.token !== "string") continue;
    const receipt = receipts.get(c.token);
    const currentTap = typeof c.tap === "string" ? c.tap : "";
    out.set(c.token, {
      tap: receipt?.tap ?? "",
      receipt: receipt !== undefined,
      ...(currentTap ? { currentTap } : {}),
      checksum: typeof c.sha256 === "string" && c.sha256 !== "" && c.sha256 !== "no_check",
      autoUpdates: c.auto_updates === true,
      disabled: c.disabled === true,
      needsRoot:
        caskNeedsRoot(c.artifacts, canWrite) ||
        (receipt !== undefined &&
          (receipt.flightBlocks ||
            (receipt.uninstallArtifacts !== undefined &&
              caskNeedsRoot(receipt.uninstallArtifacts, canWrite)))),
    });
  }
  return out;
}

/** One cask's install receipt, or undefined when there is none to read. */
export function readCaskReceipt(caskroom: string, token: string): CaskReceipt | undefined {
  try {
    const r = JSON.parse(
      readFileSync(join(caskroom, token, ".metadata", "INSTALL_RECEIPT.json"), "utf8"),
    ) as {
      source?: { tap?: unknown };
      uninstall_artifacts?: unknown;
      uninstall_flight_blocks?: unknown;
    } | null;
    if (typeof r !== "object" || r === null) return undefined;
    return {
      // A null tap is an answer, not a gap: the cask came from a file or a URL.
      tap: typeof r.source?.tap === "string" ? r.source.tap : "",
      ...(r.uninstall_artifacts !== undefined ? { uninstallArtifacts: r.uninstall_artifacts } : {}),
      flightBlocks: r.uninstall_flight_blocks === true,
    };
  } catch {
    return undefined;
  }
}

const OFFICIAL_FORMULA_TAP = "homebrew/core";

/** One formula install receipt → its runtime-dependency names and tap, or null when unusable. */
function readReceipt(path: string): { deps: string[]; tap: string } | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as {
      runtime_dependencies?: unknown;
      source?: { tap?: unknown };
    } | null;
    // A receipt without the list is not "no dependencies" — it is no answer at all.
    if (typeof r !== "object" || r === null || !Array.isArray(r.runtime_dependencies)) return null;
    const deps = r.runtime_dependencies
      .map((d) => (d as { full_name?: unknown })?.full_name)
      .filter((n): n is string => typeof n === "string" && n !== "");
    return { deps, tap: typeof r.source?.tap === "string" ? r.source.tap : "" };
  } catch {
    return null;
  }
}

/**
 * Every keg in a Cellar → the union of its versions' runtime closures, and its tap — or null when
 * any keg's receipt cannot be read.
 *
 * The union, not the linked version's alone: with HOMEBREW_NO_INSTALL_CLEANUP old kegs stay, and
 * a dependency recorded by ANY of them is one that could matter; likewise a keg from any tap but
 * the official one makes the formula unofficial. Over-approximating only ever hands the user one
 * more line to run. A keg with no readable receipt is the opposite case — it could depend on
 * anything — so it fails the whole answer rather than reading as "depends on nothing".
 */
export function readFormulae(cellar: string): ReadonlyMap<string, u.FormulaFacts> | null {
  const out = new Map<string, u.FormulaFacts>();
  const dirs = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  for (const formula of dirs(cellar)) {
    const versions = dirs(join(cellar, formula));
    if (versions.length === 0) continue; // an empty directory: nothing is installed
    const deps = new Set<string>();
    let tap: string | undefined;
    for (const v of versions) {
      const r = readReceipt(join(cellar, formula, v, "INSTALL_RECEIPT.json"));
      if (!r) return null;
      for (const d of r.deps) deps.add(d);
      if (tap === undefined || tap === OFFICIAL_FORMULA_TAP) tap = r.tap;
    }
    out.set(formula, { deps: [...deps], tap: tap ?? "" });
  }
  return out;
}

/** `brew deps --for-each` output (`name: dep dep…`) → name → its closure. */
export function parseDepsForEach(stdout: string): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const line of stdout.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    // Formula names are lowercase (Homebrew's naming rules); "Warning:" and friends are not one.
    if (!/^[a-z0-9][a-z0-9@+._/-]*$/.test(name)) continue;
    out.set(
      name,
      line
        .slice(i + 1)
        .split(/\s+/)
        .filter((d) => d !== ""),
    );
  }
  return out;
}

/**
 * The variables a brew step's environment depends on, and when a brew.env line undoes them. brew
 * reads every `boolean: :set` variable as ON whenever it is non-empty (env_config.rb):
 *   • forced ON by the dispatch — an EMPTY assignment turns it back off;
 *   • removed by the dispatch — any non-empty assignment turns it back on.
 */
const FORCED_ON: readonly string[] = [
  "HOMEBREW_NO_AUTO_UPDATE",
  "HOMEBREW_NO_SUDO",
  "HOMEBREW_NO_INSTALL_CLEANUP",
];
const REMOVED: readonly string[] = [
  "HOMEBREW_FORCE_API_AUTO_UPDATE",
  "HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK",
  "HOMEBREW_UPGRADE_GREEDY",
  "HOMEBREW_UPGRADE_GREEDY_CASKS",
  "SUDO_ASKPASS",
];

/** The brew.env files bin/brew loads, in its order: system, prefix, user. */
export function brewEnvFiles(prefix: string, env: NodeJS.ProcessEnv): string[] {
  const userConfig = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "homebrew")
    : env.HOMEBREW_XDG_CONFIG_HOME
      ? join(env.HOMEBREW_XDG_CONFIG_HOME, "homebrew")
      : join(env.HOME || homedir(), ".homebrew");
  return [
    "/etc/homebrew/brew.env",
    join(prefix, "etc", "homebrew", "brew.env"),
    join(userConfig, "brew.env"),
  ];
}

/**
 * "file: VARIABLE" for every line in these files that would undo a brew step's environment.
 * Parsed the way bin/brew reads them (`read -r` trims the line; `export "$line"` takes the rest of
 * it verbatim). A file that exists but cannot be read is no answer: null.
 */
export function brewEnvOverrides(files: readonly string[]): string[] | null {
  const hits: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const name = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if ((FORCED_ON.includes(name) && value === "") || (REMOVED.includes(name) && value !== "")) {
        hits.push(`${file}: ${name}`);
      }
    }
  }
  return hits;
}

/** PEP 503 normalisation, for comparing distribution names. */
function pyNorm(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Files whose presence next to a venv makes it a project's, not a tool's. */
const PROJECT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt"];

/**
 * What a venv holds, for one package.
 *
 * `requiredBy` reads every installed distribution's METADATA for a `Requires-Dist:` naming the
 * package: a tool's dedicated venv has none, while an ML project's venv where `transformers` pins
 * `huggingface-hub` does — and pip, told to upgrade past that pin, warns and still exits 0.
 */
export function inspectVenv(
  root: string,
  pkg: string,
  where: { cwd?: string; activeVenv?: string; home?: string } = {},
): u.VenvFacts {
  const want = pyNorm(pkg);
  const requiredBy = new Set<string>();
  let libs: string[] = [];
  try {
    libs = readdirSync(join(root, "lib")).filter((d) => d.startsWith("python"));
  } catch {
    /* no lib/ — nothing to read */
  }
  for (const lib of libs) {
    const site = join(root, "lib", lib, "site-packages");
    let entries: string[] = [];
    try {
      entries = readdirSync(site).filter((e) => e.endsWith(".dist-info"));
    } catch {
      continue;
    }
    for (const e of entries) {
      let meta = "";
      try {
        meta = readFileSync(join(site, e, "METADATA"), "utf8");
      } catch {
        continue;
      }
      const self = /^Name:\s*(.+)$/m.exec(meta)?.[1]?.trim() ?? e;
      if (pyNorm(self) === want) continue;
      for (const m of meta.matchAll(/^Requires-Dist:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) {
        if (pyNorm(m[1] ?? "") === want) {
          requiredBy.add(self);
          break;
        }
      }
    }
  }
  const abs = resolve(root);
  const active = where.activeVenv !== undefined && resolve(where.activeVenv) === abs;
  const parent = dirname(abs);
  const besideProject = PROJECT_MARKERS.some((f) => existsSync(join(parent, f)));
  return {
    pip: existsSync(join(root, "bin", "pip")) || existsSync(join(root, "bin", "pip3")),
    uvTool: existsSync(join(root, "uv-receipt.toml")),
    project: underProjectDir(abs, where.cwd, where.home ?? homedir()) || active || besideProject,
    requiredBy: [...requiredBy],
  };
}

/** `child` sits strictly inside `parent`. */
function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The session runs from a project directory and this venv is inside it.
 *
 * The CLI never chdirs, so `cwd` is where the session was launched — and a fresh terminal opens in
 * the home folder, which holds every tool's dedicated venv (`~/.hf-cli/venv`…). The home folder,
 * anything above it and `/` are therefore never a project root: launched from there, every venv
 * would read as a project's and no tool venv could ever be upgraded.
 */
function underProjectDir(venv: string, cwd: string | undefined, home: string): boolean {
  if (cwd === undefined) return false;
  const dir = resolve(cwd);
  const h = resolve(home);
  if (dir === h || inside(h, dir) || dir === dirname(dir)) return false;
  return inside(venv, dir);
}

function dirWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real probes. `env` builds a step's environment the way the dispatch does, so a probe sees
 * the same brew configuration as the upgrade it is vetting; `where` says which venv is the
 * session's own (its cwd, the shell's $VIRTUAL_ENV).
 */
export function makeDispatchProbes(
  run: StepRunner,
  env: (tool: "brew" | "npm") => NodeJS.ProcessEnv,
  where: () => { cwd?: string; activeVenv?: string; home?: string } = () => ({}),
  canWrite: (target: string) => boolean = (t) => targetWritable(t),
): DispatchProbes {
  const firstLine = (s: string): string => (s.split("\n")[0] ?? "").trim();
  const ask = async (argv: string[], tool: "brew" | "npm", signal?: AbortSignal) =>
    run(argv, {
      env: env(tool),
      timeoutMs: 120_000,
      label: `updates:${argv.slice(0, 2).join("-")}`,
      ...(signal ? { signal } : {}),
    });
  return {
    async casks(tokens, signal) {
      if (tokens.length === 0) return new Map();
      const info = await ask(["brew", "info", "--json=v2", "--cask", ...tokens], "brew", signal);
      if (info.code !== 0) return null;
      const room = await ask(["brew", "--caskroom"], "brew", signal);
      const caskroom = firstLine(room.stdout);
      // Without the Caskroom no receipt can be read, and every cask would be judged by today's
      // definition instead of what is installed.
      if (room.code !== 0 || !caskroom.startsWith("/")) return null;
      const receipts = new Map<string, CaskReceipt>();
      for (const t of tokens) {
        const r = readCaskReceipt(caskroom, t);
        if (r) receipts.set(t, r);
      }
      return parseCaskInfo(info.stdout, receipts, canWrite);
    },
    async formulae(outdated, signal) {
      const res = await ask(["brew", "--cellar"], "brew", signal);
      const cellar = firstLine(res.stdout);
      if (res.code !== 0 || !cellar.startsWith("/")) return null;
      let facts: ReadonlyMap<string, u.FormulaFacts> | null;
      try {
        facts = readFormulae(cellar);
      } catch {
        return null;
      }
      // A tap's formula is never run, so its current definition is never expanded by a "y".
      const names = outdated.filter((n) => !n.includes("/"));
      if (!facts || names.length === 0) return facts;
      const current = await ask(
        ["brew", "deps", "--for-each", "--full-name", ...names],
        "brew",
        signal,
      );
      if (current.code !== 0) return null;
      const closures = parseDepsForEach(current.stdout);
      const merged = new Map(facts);
      for (const name of names) {
        const now = closures.get(name);
        if (!now) return null; // brew said nothing about a formula it calls outdated
        const known = merged.get(name);
        merged.set(name, {
          deps: [...new Set([...(known?.deps ?? []), ...now])],
          tap: known?.tap ?? OFFICIAL_FORMULA_TAP,
        });
      }
      return merged;
    },
    async brewEnv(signal) {
      const res = await ask(["brew", "--prefix"], "brew", signal);
      const prefix = firstLine(res.stdout);
      if (res.code !== 0 || !prefix.startsWith("/")) return null;
      return brewEnvOverrides(brewEnvFiles(prefix, env("brew")));
    },
    async npmGlobal(names, signal) {
      const res = await ask(["npm", "root", "-g"], "npm", signal);
      const root = firstLine(res.stdout);
      if (res.code !== 0 || !root.startsWith("/")) return null;
      /**
       * npm writes the package under the root AND its bin links under `<prefix>/bin` — a prefix
       * whose node_modules was chowned to the user but whose bin was not (a common EACCES
       * workaround) fails at the link step. A layout other than `<prefix>/lib/node_modules` is
       * not guessed at.
       */
      const standard = basename(root) === "node_modules" && basename(dirname(root)) === "lib";
      const bin = join(dirname(dirname(root)), "bin");
      const writable =
        standard && dirWritable(root) && (existsSync(bin) ? dirWritable(bin) : targetWritable(bin));
      const linked = new Set<string>();
      for (const name of names) {
        try {
          if (lstatSync(join(root, name)).isSymbolicLink()) linked.add(name);
        } catch {
          /* not there — npm will say so itself */
        }
      }
      return { root, writable, linked };
    },
    venv(root, pkg) {
      return inspectVenv(root, pkg, where());
    },
    modelStoreHas(tag) {
      return readLocalManifest(tag) !== null;
    },
    modelStorePath() {
      return ollamaModelsDir();
    },
  };
}
