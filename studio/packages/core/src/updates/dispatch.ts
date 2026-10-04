// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/dispatch.ts — what "update everything" may actually RUN, decided from the report (PURE).
 *
 * `/updates` prints a report and then asks "Do you want to update everything right now? y/N".
 * This file answers the question that has to be settled before that prompt is honest: of the
 * things the report names, which ones will a "y" run, which must the user run themselves, and
 * which are deliberately left alone — each with the reason.
 *
 * ── WHY THE REPORT CANNOT SIMPLY BE "RUN" ───────────────────────────────────────────────────
 *
 * The printed `update:` lines are a poor guide, and scraping them would be wrong in every
 * direction at once:
 *   • every installed tool prints an `update:` line, including tools that are up to date or
 *     could not be checked (`report.ts` formatTool);
 *   • package-manager rows print NO command at all;
 *   • conflict sections print commands under "DO NOT RUN" and "not:", which are exactly the ones
 *     that succeed while upgrading a copy PATH never reaches;
 *   • `hasUpdates()` is true for a report whose only content is a suggested model.
 *
 * So the plan is built from the STRUCTURED report: package rows through `upgradeCommand` (argv,
 * never a shell string), tool rows by the owner of the copy that actually runs, models by the
 * registry comparison. Nothing here executes, and nothing here parses a display string into a
 * command to run.
 *
 * ── THE TRUST POLICY (a user decision, 2026-10-02) ──────────────────────────────────────────
 *
 * nemesis cannot gate a package payload today: its default gate BLOCKS every archive that
 * contains an executable (HEUR-EXE — measured on the official `blueutil` bottle), so a
 * stage-and-scan recipe would refuse every bottle, cask and npm CLI there is. The owner chose to
 * trust the OFFICIAL package-manager channels for this dispatch — Homebrew's and npm's checksums,
 * pip's index — exactly as when they type the command themselves. What that does NOT extend to:
 *   • vendor self-updaters (`claude update`, `opencode upgrade`, `uv self update`, `curl … | sh`):
 *     they download and swap their own binary, and are listed for the user to run;
 *   • anything needing root: Prometheus never runs `sudo`;
 *   • third-party Homebrew taps, and casks that publish no checksum: outside the official channel,
 *     or inside it with nothing to verify.
 *
 * ── WHY A FORMULA UPGRADE IS NEVER JUST ONE FORMULA ─────────────────────────────────────────
 *
 * `brew upgrade X` also upgrades the outdated dependencies X's new bottle needs (giving them no
 * dependents pass of their own), and — with its dependents check on — the outdated, unpinned
 * formulae that depend on X itself. So the set of formulae a "y" runs has to be CLOSED: nothing in
 * it may depend on, or be depended on by, an outdated formula that is NOT in it (a held one, a
 * pinned one, a tap's), and no third-party tap's formula may link it at all — after a core-only
 * upgrade brew neither upgrades nor re-checks a tap's formula, which would be left linked against
 * the library that moved. The dependencies come from the kegs' own install receipts, joined with
 * each outdated formula's CURRENT closure (`brew deps`): a new bottle can need a dependency that no
 * receipt records yet.
 *
 * The closed set is then carried out as ONE `brew upgrade` (`brewFormulaArgv`). Run one formula at
 * a time, a library upgraded in passing by an earlier step leaves its other dependents on the old
 * dylib until their own later steps — and a Ctrl-C between two steps would leave them there.
 *
 * The node Prometheus runs on is the sharpest case. Its keg links soname-versioned dylibs through
 * `opt/` (`libabsl_*.<soname>.dylib`, `libsimdjson.33.dylib`…); when one bumps its soname,
 * Homebrew revision-bumps every dependent at once — so node is outdated exactly when its libraries
 * are, and upgrading a library, or a SIBLING that drags it (node@22 shares simdjson with node and
 * neither depends on the other), moves `opt/<lib>` to a keg without the dylib node was linked
 * against: every new node process then dies in dyld. A new bottle can also add a dependency no
 * receipt records. So while that node is outdated, no formula runs at all; once it is current,
 * Homebrew's own rule (bump the dependents of a soname change) means nothing else can break it.
 *
 * PURE: the report and a few machine facts in, a plan out. The CLI gathers the facts.
 */

import { avoidLineFor, ownsCopy, plainUpgrades } from "./conflicts.js";
import { type ToolCopy, fallbackCommandFor } from "./install-owner.js";
import {
  type ManagerSpec,
  type OutdatedPackage,
  manager,
  upgradeCommand,
} from "./package-managers.js";
import { displayCommand, neverRunReason } from "./remedies.js";
import type { ToolUpdateStatus, UpdateReport } from "./report.js";
import { DEFAULT_SELF_UPDATE, type SelfUpdateConfig } from "./self-update.js";
import { compareVersions } from "./semver.js";
import { packageIdFor, toolCheck } from "./tool-registry.js";

/** How one item is carried out. The order of this union is the order items run in. */
export type DispatchKind =
  | "brew-formula"
  | "brew-cask"
  | "npm-global"
  | "pipx"
  | "venv-pip"
  /** pulled in-process through the ollama API, exactly as `/updates pull` does. */
  | "model";

const KIND_ORDER: readonly DispatchKind[] = [
  "brew-formula",
  "brew-cask",
  "npm-global",
  "pipx",
  "venv-pip",
  "model",
];

/** Something a "y" will run. */
export interface DispatchItem {
  /**
   * Artifact identity. One item per artifact, whichever section of the report named it —
   * `brew upgrade --cask codex` must not run twice because both the tool row and the package
   * row describe it.
   */
  key: string;
  kind: DispatchKind;
  /** the formula, cask token, package or model tag, as its manager names it. */
  name: string;
  /** what the user reads: `codex  0.159.3 → 0.160.0`. */
  label: string;
  from?: string;
  to?: string;
  /**
   * EXACTLY what will be spawned, shell-free. The preview prints this array, so the command the
   * user consents to and the command that runs cannot drift apart. Absent for a model. The one
   * exception is a formula: every formula in the run is carried out together, as the single
   * `brewFormulaArgv(names)` the preview prints instead (header: WHY A FORMULA UPGRADE…).
   */
  argv?: readonly string[];
  /** model only: peak disk while both builds are on it, and the bytes the pull adds at most. */
  peakDiskBytes?: number;
  downloadBytes?: number;
}

/** Something the user has to run themselves, with the reason a "y" does not. */
export interface ManualItem {
  label: string;
  /** "" when there is no command to type — an app that updates itself. */
  command: string;
  why: string;
}

/** Something deliberately left alone, and why. */
export interface SkippedItem {
  label: string;
  why: string;
}

export interface DispatchPlan {
  run: DispatchItem[];
  manual: ManualItem[];
  skipped: SkippedItem[];
  /** set when this report cannot support a dispatch at all; `run` is then empty. */
  refusal?: string;
}

/** What brew says about one outdated cask (`brew info --json=v2 --cask` + its install receipt). */
export interface CaskFacts {
  /**
   * The tap the INSTALLED copy came from, per its install receipt; `homebrew/cask` is the official
   * one. "" when the receipt records none — a cask installed from a file or a URL.
   */
  tap: string;
  /**
   * An install receipt was read. Without one, nothing says where the installed copy came from or
   * what its uninstall (which an upgrade runs first) will do.
   */
  receipt: boolean;
  /** the tap `brew info` resolves the token to today — what an upgrade would install. */
  currentTap?: string;
  /** false when the cask publishes no checksum (`sha256 :no_check`). */
  checksum: boolean;
  /** `auto_updates true`: the app updates itself, so brew's recorded version can be stale. */
  autoUpdates: boolean;
  /** disabled upstream: brew refuses to upgrade it. */
  disabled?: boolean;
  /**
   * Its installer or uninstaller needs root — a `.pkg`, pkgutil, a kext, a sudo step or script, a
   * target in a folder this user cannot write to.
   */
  needsRoot: boolean;
}

/** Where npm installs globals, and what is in there. */
export interface NpmGlobalFacts {
  /** `npm root -g`. */
  root: string;
  /** this user can write there; Prometheus never gives npm sudo. */
  writable: boolean;
  /** globals that are symlinks into a checkout (`npm link`) — never registry installs. */
  linked: ReadonlySet<string>;
}

/** One installed formula, from its keg's install receipt. */
export interface FormulaFacts {
  /**
   * Its full runtime-dependency closure: every kept keg's `runtime_dependencies[].full_name`, and
   * for an outdated formula also the closure of its current definition (`brew deps`).
   */
  deps: readonly string[];
  /**
   * The tap it was installed from; `homebrew/core` is the official one. "" when the receipt records
   * none — a formula installed from a file or a URL, which is not official either.
   */
  tap: string;
}

/** What a virtualenv can be upgraded with — and whether it is the tool's own. */
export interface VenvFacts {
  /** the venv has a pip of its own. */
  pip: boolean;
  /** a `uv tool` environment: uv owns it (`uv tool upgrade`), and it has no pip. */
  uvTool: boolean;
  /** a PROJECT's environment (activated, under the session's directory, or next to a pyproject). */
  project: boolean;
  /** other distributions in it that declare `Requires-Dist` on the package. */
  requiredBy: readonly string[];
}

export interface DispatchContext {
  platform: NodeJS.Platform;
  /**
   * Free bytes on the volume holding the ollama store. `undefined` means it could not be
   * measured — and an unmeasured disk is never treated as one that fits.
   */
  freeDiskBytes?: number;
  /**
   * True when the store whose disk was measured holds this tag — the proof that the free-space
   * figure is about the disk the daemon writes to. Ollama.app can keep its models on another
   * volume through a setting this process never sees. Absent ⇒ no model is runnable.
   */
  modelStoreHas?: (tag: string) => boolean;
  /** the Homebrew formula whose keg holds the node running Prometheus (`node`, `node@22`…). */
  runtimeFormula?: string;
  /**
   * Every installed formula (Cellar directory name) → its dependency closure and tap, from the
   * kegs' install receipts. Absent or null ⇒ no formula runs: nothing would prove an upgrade moves
   * only what it names.
   */
  formulae?: ReadonlyMap<string, FormulaFacts> | null;
  /** brew's facts about each outdated cask. Absent or null ⇒ every cask is the user's to run. */
  casks?: ReadonlyMap<string, CaskFacts> | null;
  /**
   * What the user's `brew.env` files set that would undo the environment a brew step runs with
   * (`/etc/homebrew/brew.env`, the prefix's, the user's — brew exports them AFTER the inherited
   * environment), one "file: VARIABLE" each. Empty ⇒ nothing. Absent or null ⇒ they could not be
   * read, and no brew item runs: nothing proves a step would run as previewed.
   */
  brewEnv?: readonly string[] | null;
  /** npm's global root. Absent or null ⇒ every npm global is the user's to run. */
  npmGlobal?: NpmGlobalFacts | null;
  /** what a venv root contains, for one package. Absent ⇒ every venv upgrade is the user's. */
  inspectVenv?: (root: string, pkg: string) => VenvFacts;
  /** Prometheus's own package names; defaults to `DEFAULT_SELF_UPDATE`. */
  selfConfig?: Partial<SelfUpdateConfig>;
}

/**
 * Headroom a model pull must leave on the volume.
 *
 * `offerable()` compares against free space exactly, which is right for one offer and wrong for a
 * batch that also writes brew/npm payloads first: landing at 0 bytes free mid-pull is how a
 * machine stops being usable.
 */
export const MODEL_DISK_FLOOR_BYTES = 5e9;

/** The official cask tap — the one channel whose casks a "y" may run. */
const OFFICIAL_CASK_TAP = "homebrew/cask";

/**
 * Homebrew's own cask taps, emptied into `homebrew/cask` in 2024 (official_taps.rb). A receipt
 * written before the merge still names one; brew then upgrades the token from `homebrew/cask`.
 * Official only when `brew info` agrees that is where the token comes from now.
 */
const DEPRECATED_OFFICIAL_CASK_TAPS: ReadonlySet<string> = new Set([
  "homebrew/cask-fonts",
  "homebrew/cask-versions",
  "homebrew/cask-drivers",
]);

/**
 * Packages a "y" never upgrades, with the reason. Matched on the BREW kind as well as the name:
 * `ollama` the formula and `ollama-app` the cask are different artifacts with the same trap.
 */
const HELD_BREW: Readonly<Record<string, string>> = Object.freeze({
  "formula:ollama":
    "the ollama server must be restarted with no model loaded, and kept at the same version as Ollama.app if you have it — update it yourself",
  "cask:ollama-app":
    "Ollama.app owns the model server — quit it with no model loaded and let it update itself",
  "cask:ollama":
    "Ollama.app owns the model server — quit it with no model loaded and let it update itself",
});

/** npm globals that belong to the node install itself. */
const HELD_NPM: Readonly<Record<string, string>> = Object.freeze({
  npm: "ships with Node — update Node, or run it yourself",
  corepack: "ships with Node — update Node, or run it yourself",
});

/**
 * A version safe to splice into `name@version` / `name==version`.
 *
 * Not a semver parser — `compareVersions` owns comparison. This only refuses values that are not
 * plainly a version (empty, spaced, option-shaped), because they become part of an argv.
 */
const VERSION_RE = /^[0-9][0-9A-Za-z.+_-]{0,63}$/;

/** PEP 503 normalisation, so a pipx row named `Prometheus` still matches the self row. */
function pyNorm(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** `<venv>` from a binary inside `<venv>/bin/`, or null for any other layout. */
function venvRootOf(realPath: string): string | null {
  const i = realPath.lastIndexOf("/bin/");
  return i > 0 ? realPath.slice(0, i) : null;
}

function rowLabel(p: OutdatedPackage): string {
  return `${p.name}${p.kind === "cask" ? " (cask)" : ""}  ${p.installed ?? "?"} → ${p.available ?? "?"}`;
}

function toolLabel(t: ToolUpdateStatus): string {
  return `${t.label}  ${t.current ?? "?"} → ${t.latest ?? "?"}`;
}

/** Why a "y" cannot run this cask, or undefined when it can. */
function caskRefusal(facts: CaskFacts | undefined): string | undefined {
  if (!facts) return "brew could not describe it, so nothing proves it is safe to run";
  if (!facts.receipt) {
    return "it has no readable install receipt, so where it came from and what an upgrade would remove first are unknown";
  }
  if (facts.tap === "") return "installed from a file or a URL, outside any tap";
  const official =
    facts.tap === OFFICIAL_CASK_TAP ||
    (DEPRECATED_OFFICIAL_CASK_TAPS.has(facts.tap) && facts.currentTap === OFFICIAL_CASK_TAP);
  if (!official) return `comes from the third-party tap ${facts.tap}`;
  if (facts.disabled) return "disabled upstream — brew no longer upgrades it";
  if (!facts.checksum) {
    return "publishes no checksum, so even the official channel cannot verify the download";
  }
  if (facts.autoUpdates) {
    return "updates itself, so brew's recorded version may be stale — upgrading could move it backwards";
  }
  if (facts.needsRoot) return "its installer needs your password, and Prometheus never runs sudo";
  return undefined;
}

/**
 * The argv to run for one package row, given its canonical upgrade command.
 *
 * The flags are added AFTER the NEVER_RUN check, which is an exact match against the canonical
 * form — checking the flagged argv would let `brew upgrade --cask ollama-app` through simply
 * because `--yes` had been appended to it.
 *
 *  • `--formula` / `--cask`: brew refuses, or warns and guesses, when a formula and a cask share
 *    a token; an upgrade must not be the thing that guesses.
 *  • `--yes`: with HOMEBREW_ASK set, brew asks — and with no terminal it answers itself.
 *  • `--require-sha`: a backstop to `CaskFacts.checksum` — a cask with no checksum is the one
 *    case where "trust the official channel" would trust nothing at all.
 *  • npm is pinned to the version the report showed — the version the user agreed to.
 *
 * Running apps are left to brew: it quits and reopens an app whose cask asks for that, and it
 * never quits the app hosting the brew process itself (the terminal this session is drawn in).
 */
function execArgv(p: OutdatedPackage, canonical: readonly string[]): string[] {
  if (p.manager === "brew") {
    return p.kind === "cask"
      ? ["brew", "upgrade", "--cask", "--yes", "--require-sha", p.name]
      : brewFormulaArgv([p.name]);
  }
  if (p.manager === "npm-global") return ["npm", "install", "-g", `${p.name}@${p.available}`];
  return [...canonical];
}

/**
 * The ONE command every formula in a run is carried out with (header: WHY A FORMULA UPGRADE…).
 * brew orders the named formulae by their dependencies itself, and every one of them is a primary
 * upgrade, so none is dropped by its dependents filter.
 */
export function brewFormulaArgv(names: readonly string[]): string[] {
  return ["brew", "upgrade", "--formula", "--yes", ...names];
}

/** A formula row that passed every per-row check, awaiting the closure pass. */
interface FormulaCandidate {
  item: DispatchItem;
  command: string;
}

const OFFICIAL_FORMULA_TAP = "homebrew/core";

/**
 * Why a candidate cannot run given the others, or undefined when it can — see the header: the
 * run set must not reach an outdated formula outside it, nor any third-party tap's formula.
 */
function closureRefusal(
  name: string,
  facts: ReadonlyMap<string, FormulaFacts>,
  outdated: ReadonlySet<string>,
  run: ReadonlyMap<string, FormulaCandidate>,
): string | undefined {
  const dep = (facts.get(name)?.deps ?? []).find((d) => outdated.has(d) && !run.has(d));
  if (dep) {
    return `it depends on ${dep}, which is outdated but not run here — brew would upgrade ${dep} with it, or refuse while ${dep} is pinned`;
  }
  for (const [f, ff] of facts) {
    if (f === name || !ff.deps.includes(name)) continue;
    if (outdated.has(f) && !run.has(f)) {
      return `${f} depends on it and is outdated but not run here — upgrading it alone can leave ${f} linked against the new version`;
    }
    if (ff.tap !== OFFICIAL_FORMULA_TAP) {
      return ff.tap === ""
        ? `${f}, installed from a file or a URL, links it — brew neither upgrades nor checks ${f} afterwards`
        : `${f}, from the third-party tap ${ff.tap}, links it — brew neither upgrades nor checks ${f} afterwards`;
    }
  }
  return undefined;
}

/**
 * Turn a fresh report into a dispatch plan.
 *
 * Never throws and never decides authorisation, plan mode or dry-run — those are the caller's,
 * because they are properties of the session, not of the machine.
 */
export function planUpdateDispatch(report: UpdateReport, ctx: DispatchContext): DispatchPlan {
  const plan: DispatchPlan = { run: [], manual: [], skipped: [] };

  /**
   * Two reports the plan cannot be built from.
   *
   * A sweep that skipped the package managers has no rows to act on and no manager-derived
   * conflicts; a report without `tools` has no conflicts at all — so every "this upgrades a copy
   * your PATH never runs" guard below would be silently off, and the claude-code trap
   * (`conflicts.ts` header) would be RUN.
   */
  if (report.partial?.packages) {
    plan.refusal = "this check skipped the package managers — run /updates again for a full one";
    return plan;
  }
  if (!report.tools) {
    plan.refusal = "this report predates the install-conflict check — run /updates again";
    return plan;
  }

  const conflicts = report.conflicts ?? [];
  const self = { ...DEFAULT_SELF_UPDATE, ...ctx.selfConfig };
  const tools = report.tools.filter((t) => t.installed);
  const candidates: DispatchItem[] = [];
  const keys = new Set<string>();
  const add = (item: DispatchItem): void => {
    if (keys.has(item.key)) return;
    keys.add(item.key);
    candidates.push(item);
  };
  /** tools whose on-PATH copy a package row already decided about — run, skipped or manual. */
  const covered = new Set<string>();
  /** a conflict that says acting on this tool's copy cannot help. */
  const blockingConflict = (toolId: string) =>
    conflicts.find(
      (c) =>
        c.subject === toolId && (c.kind === "shadowed-newer" || c.kind === "client-server-skew"),
    );
  /** root-only managers collapse to ONE whole-system line each: N sudo lines help nobody. */
  const rootRows = new Map<ManagerSpec, number>();
  const formulaCandidates: FormulaCandidate[] = [];

  /* ── PACKAGES: the only rows that carry a structured, runnable upgrade ── */
  for (const m of report.managers ?? []) {
    if (!m.checkable || !m.ok) {
      // Said once, so "nothing from Homebrew ran" is never mistaken for "Homebrew had nothing".
      plan.skipped.push({
        label: m.label,
        why: m.checkable ? `check failed${m.note ? ` — ${m.note}` : ""}` : "cannot be checked",
      });
      continue;
    }
    const spec = manager(m.manager);
    if (!spec) continue;
    const plain = new Set(plainUpgrades(m.packages, conflicts));

    for (const p of m.packages) {
      const label = rowLabel(p);
      const owner = tools.find((t) => t.copies[0] !== undefined && ownsCopy(p, t.copies[0]));
      if (owner) covered.add(owner.id);

      if (!plain.has(p)) {
        const c = conflicts.find((x) => x.avoid === avoidLineFor(p));
        plan.skipped.push({
          label,
          why: c
            ? `${c.kind === "downgrade-offer" ? "would install a version OLDER than the one you run" : "upgrades a copy your PATH never runs"} — /updates fix ${c.subject}`
            : "named by an install conflict above",
        });
        continue;
      }
      if (p.pinned) {
        plan.skipped.push({ label, why: "pinned — unpin it first" });
        continue;
      }
      if (spec.upgradeNeedsRoot) {
        rootRows.set(spec, (rootRows.get(spec) ?? 0) + 1);
        continue;
      }
      if (spec.id === "brew" && p.name.includes("/")) {
        // `brew outdated` reports a third-party formula by its tap-qualified full name.
        const argv = upgradeCommand(spec, p.name, p.kind);
        plan.manual.push({
          label,
          command: argv ? displayCommand(argv) : "",
          why: "comes from a third-party tap, outside the official Homebrew channel",
        });
        continue;
      }
      const canonical = upgradeCommand(spec, p.environment ?? p.name, p.kind);
      if (!canonical) {
        plan.skipped.push({ label, why: "its name is not one Prometheus will hand to a manager" });
        continue;
      }
      const never = neverRunReason(canonical);
      if (never) {
        plan.skipped.push({ label, why: `never run — ${never}` });
        continue;
      }
      if (
        (spec.id === "npm-global" && p.name === self.npmPackage) ||
        (spec.id === "pipx" && pyNorm(p.name) === pyNorm(self.engineEntry.replace(/\.py$/, "")))
      ) {
        plan.skipped.push({
          label,
          why: "Prometheus itself — it never replaces itself while running; close it first",
        });
        continue;
      }
      if (spec.id === "brew") {
        const held =
          HELD_BREW[`${p.kind === "cask" ? "cask" : "formula"}:${p.name}`] ??
          (p.kind !== "cask" && p.name === ctx.runtimeFormula
            ? "Prometheus is running on this node — upgrade it after you quit"
            : undefined);
        if (held) {
          plan.manual.push({ label, command: displayCommand(canonical), why: held });
          continue;
        }
        // brew re-exports its env files over the step's environment (bin/brew), so one setting
        // there can turn auto-update back on or the dependents check off inside every step.
        const env = ctx.brewEnv;
        if (!env || env.length > 0) {
          plan.manual.push({
            label,
            command: displayCommand(canonical),
            why: !env
              ? "brew's configuration files could not be checked, so nothing proves the step would run as shown"
              : `${env.join(", ")} would change how brew runs this step — run it yourself`,
          });
          continue;
        }
      }
      if (spec.id === "npm-global") {
        // The prefix check comes first: every other npm line would recommend a command that
        // "succeeds" into a directory no shell searches.
        const unreachable = conflicts.find(
          (c) =>
            c.kind === "unreachable-bin-dir" &&
            (c.manager === "npm-global" || (c.manager === undefined && c.subject === spec.label)),
        );
        if (unreachable) {
          plan.skipped.push({
            label,
            why: `npm installs into a directory no shell searches — /updates fix ${unreachable.subject}`,
          });
          continue;
        }
        const held = HELD_NPM[p.name];
        if (held) {
          plan.manual.push({ label, command: displayCommand(canonical), why: held });
          continue;
        }
        const g = ctx.npmGlobal;
        if (!g || !g.writable) {
          plan.manual.push({
            label,
            command: displayCommand(canonical),
            why: g
              ? "npm's global directory is not writable by you, and Prometheus never runs sudo"
              : "npm's global directory could not be located",
          });
          continue;
        }
        if (g.linked.has(p.name)) {
          plan.skipped.push({
            label,
            why: "linked from a local checkout (npm link), not installed from the registry",
          });
          continue;
        }
        /**
         * Strictly newer, or nothing. npm lists a global whenever `current !== wanted` OR
         * `wanted !== latest`, so a package installed from a `next` tag AHEAD of `latest` comes
         * back as a row — and pinning it to "latest" would be a downgrade.
         */
        if (
          !p.available ||
          !p.installed ||
          !VERSION_RE.test(p.available) ||
          compareVersions(p.available, p.installed) !== 1
        ) {
          plan.skipped.push({ label, why: "not a newer version than the one installed" });
          continue;
        }
        /**
         * Positive evidence, or nothing. `npm -g outdated` compares EVERY global against the
         * registry by bare name — a git, tarball or local install included — and npm keeps no
         * record of where a global came from. Upgrading such a row replaces a fork or a private
         * build with another publisher's package of the same name. Only a known tool's registered
         * npm package, whose copy on PATH is this very install, is proof enough.
         */
        const check = owner ? toolCheck(owner.id) : undefined;
        const proven =
          owner !== undefined &&
          check !== undefined &&
          packageIdFor(check, "npm") === p.name &&
          (owner.copies[0]?.realPath ?? "").startsWith(`${g.root}/`);
        if (!proven) {
          plan.manual.push({
            label,
            command: displayCommand(canonical),
            why: owner
              ? "the copy on PATH is not the one in npm's global directory, or not a package Prometheus knows to come from the npm registry"
              : "nothing proves it was installed from the npm registry (git, tarball and local installs look the same) — run it yourself if it was",
          });
          continue;
        }
      }
      if (spec.id === "pipx") {
        // pip only lists PEP 440-newer releases, and many (`3.32`, `1.2.post1`) are not semver:
        // only a comparison that SUCCEEDS and says "not newer" overrules it.
        const cmp = compareVersions(p.available, p.installed);
        if (cmp === -1 || cmp === 0) {
          plan.skipped.push({ label, why: "not a newer version than the one installed" });
          continue;
        }
      }
      const conflict = owner ? blockingConflict(owner.id) : undefined;
      if (conflict) {
        plan.skipped.push({ label, why: conflict.summary });
        continue;
      }
      if (spec.id === "brew" && p.kind === "cask") {
        const refused = caskRefusal(ctx.casks?.get(p.name));
        if (refused) {
          plan.manual.push({ label, command: displayCommand(canonical), why: refused });
          continue;
        }
      }
      const kind: DispatchKind =
        spec.id === "brew"
          ? p.kind === "cask"
            ? "brew-cask"
            : "brew-formula"
          : spec.id === "npm-global"
            ? "npm-global"
            : "pipx";
      const item: DispatchItem = {
        key: `${kind}:${p.environment ?? p.name}`,
        kind,
        name: p.environment ?? p.name,
        label,
        ...(p.installed ? { from: p.installed } : {}),
        ...(p.available ? { to: p.available } : {}),
        argv: execArgv(p, canonical),
      };
      // A formula's fate depends on every other formula's — decided after the loop.
      if (kind === "brew-formula")
        formulaCandidates.push({ item, command: displayCommand(canonical) });
      else add(item);
    }
  }

  /* ── FORMULAE: the run set must be closed under what brew itself will move (header) ── */
  if (formulaCandidates.length > 0) {
    const brewRows =
      (report.managers ?? []).find((m) => m.manager === "brew" && m.ok)?.packages ?? [];
    const outdated = new Set(brewRows.filter((p) => p.kind !== "cask").map((p) => p.name));
    const run = new Map(formulaCandidates.map((c) => [c.item.name, c]));
    const demote = (c: FormulaCandidate, why: string): void => {
      run.delete(c.item.name);
      plan.manual.push({ label: c.item.label, command: c.command, why });
    };
    if (ctx.runtimeFormula !== undefined && outdated.has(ctx.runtimeFormula)) {
      for (const c of [...run.values()]) {
        demote(
          c,
          `${ctx.runtimeFormula}, which Prometheus is running on, is outdated too — any formula upgrade could move or break it; run the command above after you quit`,
        );
      }
    } else if (!ctx.formulae) {
      for (const c of [...run.values()]) {
        demote(
          c,
          "brew's dependency records could not be read, so nothing proves this upgrade moves only what it names",
        );
      }
    } else {
      const facts = ctx.formulae;
      for (let changed = true; changed; ) {
        changed = false;
        for (const c of [...run.values()]) {
          const why = closureRefusal(c.item.name, facts, outdated, run);
          if (why) {
            demote(c, why);
            changed = true;
          }
        }
      }
    }
    for (const c of run.values()) add(c.item);
  }
  for (const [spec, n] of rootRows) {
    plan.manual.push({
      label: `${spec.label}: ${n} package${n > 1 ? "s" : ""}`,
      command: displayCommand(spec.upgradeAll),
      why:
        spec.id === "pacman"
          ? "needs root, and Arch supports only whole-system upgrades"
          : "needs root, and Prometheus never runs sudo",
    });
  }

  /* ── TOOLS: only for copies no package row already decided about ── */
  for (const t of tools) {
    if (t.updateAvailable !== true || covered.has(t.id)) continue;
    const label = toolLabel(t);
    const winner: ToolCopy | undefined = t.copies[0];
    if (!winner) {
      plan.skipped.push({ label, why: "no copy of it was found on PATH" });
      continue;
    }
    const conflict = blockingConflict(t.id);
    if (conflict) {
      plan.skipped.push({ label, why: conflict.summary });
      continue;
    }
    switch (winner.owner) {
      case "brew-formula":
      case "brew-cask":
      case "npm-global":
      case "pipx": {
        // A managed copy whose manager produced no row for it: brew's index lags npm's, or the
        // manager could not be asked. Either way there is nothing a manager would do right now.
        const id =
          winner.owner === "brew-formula" || winner.owner === "brew-cask" ? "brew" : winner.owner;
        const m = (report.managers ?? []).find((x) => x.manager === id);
        const name = manager(id)?.label ?? id;
        plan.skipped.push({
          label,
          why: !m
            ? `${name} was not checked`
            : !m.ok
              ? `${m.label} check failed${m.note ? ` — ${m.note}` : ""}`
              : `${m.label} offers no upgrade for it yet`,
        });
        break;
      }
      case "python-venv": {
        /**
         * A virtualenv nothing manages but its own pip. Runnable only when every part of the
         * command is KNOWN rather than inferred: the PyPI name from the static table, the latest
         * version from PyPI itself (a multi-channel tool can report a brew version here), the venv
         * from the resolved binary's path — and a pip actually inside it.
         */
        const check = toolCheck(t.id);
        const pkg = check ? packageIdFor(check, "pypi") : undefined;
        const root = venvRootOf(winner.realPath);
        const offered = t.offer.find((o) => o.via === "venv" && o.command !== "");
        if (
          !pkg ||
          !root ||
          !offered ||
          !t.latest ||
          !VERSION_RE.test(t.latest) ||
          t.source !== `pypi:${pkg}`
        ) {
          if (offered)
            plan.manual.push({
              label,
              command: offered.command,
              why: "a virtualenv Prometheus cannot map to one PyPI release",
            });
          else
            plan.skipped.push({
              label,
              why: "no update command applies to how this copy was installed",
            });
          break;
        }
        const venv = ctx.inspectVenv?.(root, pkg);
        const venvRefusal = !venv
          ? "the virtualenv could not be inspected"
          : venv.uvTool
            ? "a uv tool environment — uv manages it, and it has no pip"
            : !venv.pip
              ? "the virtualenv has no pip of its own"
              : venv.project
                ? "a project's virtualenv (activated, or part of a project) — its pins are the project's to change"
                : venv.requiredBy.length > 0
                  ? `other packages in this virtualenv depend on ${pkg} (${venv.requiredBy.slice(0, 3).join(", ")}) — upgrading it there can break them`
                  : undefined;
        if (venvRefusal) {
          plan.manual.push({
            label,
            command: venv?.uvTool ? `uv tool upgrade ${pkg}` : offered.command,
            why: venvRefusal,
          });
          break;
        }
        add({
          key: `venv-pip:${root}:${pkg}`,
          kind: "venv-pip",
          name: pkg,
          label,
          ...(t.current ? { from: t.current } : {}),
          to: t.latest,
          // `-I`: isolated mode. `python -m` would otherwise put the working directory first on
          // sys.path, where any `json.py` or `logging.py` sitting there shadows what pip imports.
          argv: [
            `${root}/bin/python`,
            "-I",
            "-m",
            "pip",
            "install",
            "--upgrade",
            `${pkg}==${t.latest}`,
          ],
        });
        break;
      }
      case "pnpm-global": {
        // `offer` carries npm commands for a pnpm install (viaForOwner maps both to "npm"), and
        // running npm here would create the very duplicate install `/updates` warns about.
        const check = toolCheck(t.id);
        const fb = fallbackCommandFor(winner, check ? packageIdFor(check, "npm") : undefined);
        plan.manual.push({
          label,
          command: fb?.command ?? "",
          why: "a pnpm global install — Prometheus runs npm, brew and pip, not pnpm",
        });
        break;
      }
      default: {
        // The vendor's own installer, an app bundle, the OS, cargo… — a USER decision recorded
        // above: their updaters swap their own binary and are never run from here.
        if (t.offer.length === 0) {
          plan.skipped.push({
            label,
            why: "no update command applies to how this copy was installed",
          });
          break;
        }
        for (const o of t.offer) {
          if (o.command === "") {
            plan.manual.push({ label, command: "", why: o.note ?? "updates itself" });
            continue;
          }
          // Offers are display strings. Only a plain one can be compared to NEVER_RUN's argv; a
          // quoted or piped one is printed as it stands and never parsed into something to run.
          const never = /["'|&;<>]/.test(o.command)
            ? null
            : neverRunReason(o.command.trim().split(/\s+/));
          if (never) {
            plan.skipped.push({ label, why: `never run — ${never}` });
            continue;
          }
          plan.manual.push({
            label,
            command: o.command,
            why:
              o.via === "app"
                ? "the app updates itself"
                : "its own updater replaces the binary, which nemesis cannot inspect first",
          });
        }
      }
    }
  }

  /* ── SELF: only when there is something newer, never from inside the running session ── */
  if (report.self.updateAvailable === true) {
    plan.manual.push({
      label: `Prometheus  ${report.self.prometheus} → ${report.self.latest ?? "newer"}`,
      command: report.self.plan.command,
      why: "it never replaces itself while running — close it first",
    });
  }

  /* ── MODELS: changed upstream, pulled last, budgeted against the disk ── */
  const measured = ctx.freeDiskBytes;
  let freeLeft = measured;
  for (const c of report.models.upstream ?? []) {
    if (!c.ok || !c.update.changed) continue;
    const u = c.update;
    if (u.newer === false) {
      // The registry's build was pushed BEFORE this copy was pulled: following the tag would be
      // a rollback. `/updates pull` still does it for anyone who wants that.
      plan.manual.push({
        label: `${u.model}  older build upstream`,
        command: `/updates pull ${u.model}`,
        why: "the registry's build is older than yours — pull it only if you want it",
      });
      continue;
    }
    const label = `${u.model}  ${u.newer ? "newer build" : "changed upstream"}`;
    if (!u.satisfiable) {
      plan.skipped.push({
        label,
        why: `needs ollama ${u.requiresOllama ?? "newer"} — upgrade ollama first`,
      });
      continue;
    }
    if (ctx.modelStoreHas?.(u.model) !== true) {
      plan.skipped.push({
        label,
        why: "the model store Prometheus can measure does not hold it, so the free space ollama will write into is unknown",
      });
      continue;
    }
    if (
      measured === undefined ||
      freeLeft === undefined ||
      !Number.isFinite(measured) ||
      !Number.isFinite(freeLeft)
    ) {
      plan.skipped.push({ label, why: "free disk space could not be measured" });
      continue;
    }
    /**
     * The build already installed is part of the USED space, so what a pull adds at most is the
     * remote build (less any layers the two share). Comparing the whole peak against FREE space
     * would count the installed build twice and refuse a pull that fits.
     */
    if (u.remoteBytes + MODEL_DISK_FLOOR_BYTES > freeLeft) {
      // What is left after the pulls above is a projection — never print it as what is free now.
      const room =
        measured <= 0
          ? "the disk is full"
          : freeLeft === measured
            ? `${gb(freeLeft)} is free`
            : `${gb(Math.max(0, freeLeft))} would be left after the pulls above (${gb(measured)} is free now)`;
      plan.skipped.push({
        label,
        why: `needs up to ${gb(u.remoteBytes)} free plus ${gb(MODEL_DISK_FLOOR_BYTES)} headroom; ${room}`,
      });
      continue;
    }
    add({
      key: `model:${u.model}`,
      kind: "model",
      name: u.model,
      label,
      peakDiskBytes: u.peakDiskBytes,
      downloadBytes: u.remoteBytes,
    });
    // Afterwards the old layers are released, so the lasting cost is the difference.
    freeLeft -= Math.max(0, u.remoteBytes - (u.localBytes ?? 0));
  }

  /**
   * Windows: npm and pipx are `.cmd` shims there, and launching one needs a shell — which this
   * dispatch never uses. Models are pulled over HTTP and are unaffected.
   */
  for (const item of candidates) {
    if (ctx.platform === "win32" && item.kind !== "model") {
      plan.manual.push({
        label: item.label,
        command: item.argv ? displayCommand(item.argv) : "",
        why: "on Windows these need a shell, which Prometheus never uses",
      });
      continue;
    }
    plan.run.push(item);
  }
  plan.run.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return plan;
}
