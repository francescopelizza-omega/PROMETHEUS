// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/dispatch-cmd.ts — "Do you want to update everything right now? y/N", and then doing it.
 *
 * `/updates` used to stop at the report: "Prometheus proposes; it never auto-updates. Copy a
 * command above + run it yourself." This is the step after it, asked for by the owner: one
 * question, and on `y` + Return the updates run here, one step at a time, with their output
 * streamed. Every Homebrew formula goes in ONE step (`brewFormulaArgv`, see core's dispatch.ts).
 *
 * ── WHAT A "y" RUNS, AND WHAT IT NEVER DOES ─────────────────────────────────────────────────
 *
 * The plan comes from core's `planUpdateDispatch` (pure), which reads the STRUCTURED report — the
 * printed one also names commands under "DO NOT RUN" — plus facts the probes gather first
 * (`dispatch-probes.ts`). It runs:
 *   • official package-manager upgrades — Homebrew formulae and casks, npm and pipx globals, and a
 *     virtualenv's own pip — as exact argv, trusting the manager's checksums (the owner's
 *     decision: nemesis's default gate blocks every binary package, so it cannot vet these);
 *   • Ollama models that changed upstream, through the same in-process pull as `/updates pull`.
 * It never runs: a vendor's self-updater (`claude update`, `opencode upgrade`, `curl … | sh`), a
 * command that needs `sudo`, Prometheus itself or the node it runs on, a NEVER_RUN command, a copy
 * PATH does not reach, or a repair from `/updates fix` — those are listed, each with its reason.
 *
 * ── THE QUESTION ────────────────────────────────────────────────────────────────────────────
 *
 * Asked through `actions.ask`, never `confirm`: both hosts' `confirm` append their own `[y/N]`,
 * and the TUI's resolves on the FIRST key — so "yes⏎" would answer on the `y` and leak "es" into
 * the composer. `ask` is line-based in both hosts and shows the text exactly once. Only `y` or
 * `yes` (any case) runs anything; Return alone, Esc, Ctrl-C or any other answer runs nothing.
 *
 * It is asked only where it can be answered: `runUpdates` calls this only when the host supplied
 * both `actions` and `dispatch`, which the one-shot `prometheus updates [--json]`, the desktop and
 * the startup notice never do. And it is not asked when the session could not act on a "y" anyway
 * — plan mode, dry-run, or below the A5 rung `/updates pull` already requires (the default is A1)
 * — so the answer is never theatre: the plan is still shown, under a heading that says it is not
 * offered and why, followed by what would make it so.
 *
 * ── CTRL-C ──────────────────────────────────────────────────────────────────────────────────
 *
 * Stops the RUN, not the step in flight. Brew's cask upgrade moves the old app into the Caskroom
 * and deletes it from /Applications before the new one lands, and its rollback catches
 * StandardError only — a SIGTERM there leaves no app at all. So a package step always finishes
 * (short of the runner's three-hour backstop for a step that never ends); Ctrl-C means nothing
 * further starts. A model pull is different: it is cancelled at once, and a later pull resumes
 * from its partial file. That holds only where Ctrl-C reaches the run as the turn's signal — so a
 * host where it arrives as a process SIGINT (readline with its output piped) is not offered a run
 * at all (`ctrlCIsAbort`): the reaper would SIGTERM the step it promises to let finish.
 */
import { realpathSync } from "node:fs";

import { updates as u } from "@prometheus/core";
import type { pullModel } from "@prometheus/core/updates-live";
import { safeChildEnv } from "@prometheus/engine-bridge";

import { OWNER_PID_ENV } from "../child-reaper.js";
import { c } from "../render.js";
import { type ExecAuditEntry, execAuditEntry } from "../session/exec-gate.js";
import type { DispatchProbes } from "./dispatch-probes.js";
import { type ModelActionDeps, authRefusal, gb, pullWithProgress } from "./model-actions-cmd.js";
import { STEP_TIMEOUT_MS, type StepResult, type StepRunner, cleanLine } from "./run-step.js";

/** The question, verbatim — the wording the owner asked for. */
export const UPDATE_EVERYTHING_PROMPT = "Do you want to update everything right now? y/N";

/** The audit trail's account of what was trusted, so a later reader does not assume a scan. */
const PACKAGE_REASON =
  "/updates: confirmed with y; official package manager, unsandboxed; payload checked by the manager's checksum, not scanned by nemesis";
const MODEL_REASON =
  "/updates: confirmed with y; model weights pulled through the ollama API, not scanned by nemesis";
const DECLINED_REASON = "/updates: not confirmed at the y/N prompt — nothing ran";

/**
 * Everything "update everything" needs from its host.
 *
 * The safety-relevant seams are REQUIRED, not optional: an optional seam that defaults to "off"
 * is how a host silently stops passing plan mode or the runtime hold and every test still passes
 * (the "looks implemented, isn't" pattern). Leaving one out is a compile error.
 */
export interface DispatchDeps {
  /** runs one step — `makeStepRunner()` in the hosts, a fake in tests. */
  run: StepRunner;
  /** the read-only facts the plan needs — `makeDispatchProbes()` in the hosts. */
  probes: DispatchProbes;
  /** the in-process model pull. Required, so no test can ever reach a real daemon by default. */
  pull: typeof pullModel;
  /** appends one line to `<home>/config/exec-audit.jsonl`. */
  audit: (entry: ExecAuditEntry) => void;
  /** free bytes on the volume holding the ollama store, measured NOW; undefined = unknown. */
  freeDiskBytes: () => number | undefined;
  /** the Homebrew formula whose keg holds the node running Prometheus (`runtimeBrewFormula`). */
  runtimeFormula: () => string | undefined;
  /** the session's permission mode — "plan" runs nothing, and switching to it mid-run stops it. */
  getPermMode: () => string | undefined;
  /**
   * True when Ctrl-C reaches this run as the turn's abort signal. False where it arrives as a
   * process SIGINT instead — readline with no terminal on stdout — because the child reaper then
   * SIGTERMs the package step in flight, which this run promises to let finish.
   */
  ctrlCIsAbort: () => boolean;
  /** the session's `/dry-run` toggle. */
  dryRun: () => boolean;
  /**
   * true once the session is shutting down: start nothing further. (Whether anything may still be
   * WRITTEN is the host's call — the TUI's terminal belongs to the shell after teardown, readline's
   * stdout does not.)
   */
  closed: () => boolean;
  /** marks the shared update cache stale once something ran (`markUpdateCacheStale`). */
  invalidateCache: () => void;
  platform?: NodeJS.Platform;
  /** the inherited environment every step starts from; `safeChildEnv()` by default. */
  baseEnv?: () => NodeJS.ProcessEnv;
  /** lets keys typed during the check land before the question opens (`settleInput`). */
  settle?: () => Promise<void>;
  now?: () => number;
}

export type ItemStatus = "updated" | "failed" | "cancelled" | "not-started";

/**
 * One spawned command, or one model pull — the unit Ctrl-C never splits. Every formula is carried
 * out by the same step; every other item is a step of its own.
 */
export interface DispatchStep {
  kind: u.DispatchKind;
  items: u.DispatchItem[];
  /** exactly what is spawned; absent for a model. */
  argv?: readonly string[];
  key: string;
  label: string;
}

/** The plan's run list as the steps that carry it out, in the same order. */
export function toSteps(run: readonly u.DispatchItem[]): DispatchStep[] {
  const formulae = run.filter((i) => i.kind === "brew-formula");
  const steps: DispatchStep[] = [];
  if (formulae.length > 0) {
    steps.push({
      kind: "brew-formula",
      items: formulae,
      argv: u.brewFormulaArgv(formulae.map((f) => f.name)),
      key: "brew-formula",
      label:
        formulae.length === 1
          ? (formulae[0]?.label ?? "")
          : `Homebrew formulae: ${formulae.map((f) => f.name).join(", ")}`,
    });
  }
  for (const item of run) {
    if (item.kind === "brew-formula") continue;
    steps.push({
      kind: item.kind,
      items: [item],
      ...(item.argv ? { argv: item.argv } : {}),
      key: item.key,
      label: item.label,
    });
  }
  return steps;
}

export interface ItemResult {
  item: u.DispatchItem;
  status: ItemStatus;
  detail?: string;
}

export interface DispatchOutcome {
  plan: u.DispatchPlan | null;
  /** true when the question was put to the user. */
  asked: boolean;
  /** true when they answered y. */
  confirmed: boolean;
  results: ItemResult[];
}

/**
 * Keys typed while the check ran must not answer the question.
 *
 * The package sweep is `spawnSync` and runs LAST, so it holds the event loop for seconds and
 * nothing after it yields to I/O before the prompt is armed: a `y⏎` typed during the sweep would
 * still be sitting in the tty buffer and answer a question the user has not yet seen. One I/O turn
 * plus a short grace period hands those bytes to the composer (TUI) or the line queue (readline)
 * first, where they become ordinary type-ahead.
 */
export async function settleInput(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
}

/**
 * The Homebrew formula whose keg holds the node running Prometheus, e.g. `node` or `node@22`.
 *
 * Upgraded mid-session, a brew node takes the keg this process runs from — and anything else
 * pinned to a versioned Cellar path with it (measured: an MCP server configured with
 * `/opt/homebrew/Cellar/node/26.5.0/bin/node` failed with ENOENT once that keg was cleaned up).
 */
export function runtimeBrewFormula(
  execPath: string = process.execPath,
  realpath: (p: string) => string = realpathSync,
): string | undefined {
  try {
    return /\/Cellar\/([^/]+)\//.exec(realpath(execPath))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The environment one kind of step runs with.
 *
 * Starts from the inherited environment (loader-hijack variables already stripped by
 * `safeChildEnv`) — it is the user's machine, and their npm prefix, PIPX_HOME and HOMEBREW_CASK_OPTS
 * decide where things install. Then:
 *   • SUDO_ASKPASS goes: with it set, brew adds `sudo -A`, which raises a GUI password dialog —
 *     still sudo, and Prometheus never runs sudo. HOMEBREW_NO_SUDO makes brew refuse instead (the
 *     planner already keeps every cask whose installer or uninstaller needs root out of the run).
 *   • HOMEBREW_NO_AUTO_UPDATE: install what the report showed, from the index it was computed
 *     against; HOMEBREW_FORCE_API_AUTO_UPDATE would override it, so it goes too.
 *   • HOMEBREW_NO_INSTALL_CLEANUP: brew deletes old kegs after an upgrade, including one a
 *     running process — this one, or a server it started — is executing from.
 *   • HOMEBREW_UPGRADE_GREEDY(_CASKS) go: they would turn a named cask probe greedy.
 *   • brew's dependents check stays ON: it upgrades the outdated dependents of every formula the
 *     step names (a dependency upgraded in passing gets no such pass — which is why every formula
 *     goes in ONE step). What it must not move — a held keg — the planner keeps out of the run
 *     set, from the kegs' own dependency records.
 *   • TERM=dumb and the no-colour switches: output goes into a TUI, not a terminal.
 *
 * All of this is about the INHERITED environment. brew exports its brew.env files over it
 * (bin/brew), so a line there can undo any of it — which the planner checks (`brewEnv`).
 */
export function updateEnv(kind: u.DispatchKind, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const brew = kind === "brew-formula" || kind === "brew-cask";
  const drop = new Set([
    "SUDO_ASKPASS",
    ...(brew
      ? [
          "HOMEBREW_FORCE_API_AUTO_UPDATE",
          "HOMEBREW_UPGRADE_GREEDY",
          "HOMEBREW_UPGRADE_GREEDY_CASKS",
          "HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK",
        ]
      : []),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!drop.has(k)) env[k] = v;
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  env[OWNER_PID_ENV] = String(process.pid);
  if (brew) {
    env.HOMEBREW_NO_AUTO_UPDATE = "1";
    env.HOMEBREW_NO_SUDO = "1";
    env.HOMEBREW_NO_INSTALL_CLEANUP = "1";
    env.HOMEBREW_NO_ENV_HINTS = "1";
    env.HOMEBREW_NO_COLOR = "1";
  } else if (kind === "pipx" || kind === "venv-pip") {
    env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
    env.PIP_NO_INPUT = "1";
  } else if (kind === "npm-global") {
    env.npm_config_update_notifier = "false";
    env.npm_config_fund = "false";
  }
  return env;
}

/**
 * The environment a read-only probe runs with — the same brew/npm configuration as the upgrade
 * it is vetting, so the answer is about the install that would actually run.
 */
export function probeEnv(
  tool: "brew" | "npm",
  base: NodeJS.ProcessEnv = safeChildEnv(),
): NodeJS.ProcessEnv {
  return updateEnv(tool === "brew" ? "brew-formula" : "npm-global", base);
}

/**
 * npm ends every failure with where its log went; that line is never the reason. Neither is
 * brew's or pip's blank tail.
 */
const NOISE =
  /A complete log of this run can be found in|Log files were not written|^npm error\s*$/i;

/** The most telling line of some output, for a one-line failure reason. */
function telling(text: string): string {
  const lines = text
    .split("\n")
    .map(cleanLine)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !NOISE.test(l));
  const pick =
    lines.find((l) => /npm error code|^Error:|^ERROR:|error:/i.test(l)) ?? lines.at(-1) ?? "";
  return pick.length > 200 ? `${pick.slice(0, 200)}…` : pick;
}

/** Why a step failed, in words the user can act on. */
function failureReason(step: DispatchStep, res: StepResult): string {
  const cmd = u.displayCommand(step.argv ?? []);
  if (res.timedOut) return `stopped after ${Math.round(STEP_TIMEOUT_MS / 60_000)} minutes`;
  if (res.code === 127) {
    return `could not start ${step.argv?.[0] ?? "it"} — ${telling(res.stderr)}`;
  }
  const all = `${res.stderr}\n${res.stdout}`;
  // brew's prefetch check (cask/installer.rb): it refused BEFORE touching anything.
  if (/requires sudo, but HOMEBREW_NO_SUDO is set/i.test(all)) {
    return `needs your password, which Prometheus never asks for — nothing was changed; run it yourself: ${cmd}`;
  }
  // brew's own words when HOMEBREW_NO_SUDO stops a cask midway through replacing the old one.
  if (/HOMEBREW_NO_SUDO|sudo is disabled/i.test(all)) {
    return `needs your password, which Prometheus never asks for — the old version may be partly removed; finish it yourself: ${cmd}`;
  }
  if (/require-sha|does not have a sha256 checksum/i.test(all)) {
    return "publishes no checksum, so it cannot be verified — run it yourself if you trust it";
  }
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(all)) {
    return "permission denied — this install belongs to another user, and Prometheus never runs sudo";
  }
  const why = telling(res.stderr) || telling(res.stdout);
  return `exit ${res.code}${why ? `: ${why}` : ""}`;
}

function renderManual(
  manual: readonly u.ManualItem[],
  heading: string,
  write: (line: string) => void,
): void {
  if (manual.length === 0) return;
  write(`ℹ ${heading}`);
  for (const m of manual) {
    if (m.command) {
      write(`  $ ${m.command}`);
      write(`  ⎿ ${m.label} — ${m.why}`);
    } else {
      write(`  ⎿ ${m.label} — ${m.why}`);
    }
  }
}

function renderSkipped(skipped: readonly u.SkippedItem[], write: (line: string) => void): void {
  if (skipped.length === 0) return;
  write("ℹ Left alone:");
  for (const s of skipped) write(`  ⎿ ${s.label} — ${s.why}`);
}

/**
 * The preview: exactly the commands a "y" will run, in order, with what a model pull costs.
 *
 * Every line starts with a framing glyph and carries colour only after it — in the TUI a line
 * that begins with an escape sequence is fed to the markdown renderer, which would reinterpret
 * the `_` and `*` that package names and versions are full of. A command and its labels sit on
 * separate lines, so a long argv still shows in full where the terminal is narrow.
 *
 * `blocked` names why no question will follow, so the list never reads as an offer.
 */
function renderPreview(
  plan: u.DispatchPlan,
  steps: readonly DispatchStep[],
  storePath: string,
  write: (line: string) => void,
  blocked: string | null,
): void {
  const n = steps.length;
  const these = n === 1 ? "this" : `these ${n} steps`;
  write(
    blocked
      ? `ℹ Update everything — not offered (${blocked}); y would run ${these}:`
      : `ℹ Update everything — y runs ${these}, one at a time:`,
  );
  for (const step of steps) {
    if (step.kind === "model") {
      write(`  ▸ pull ${step.label}`);
      write(
        `  ⎿ up to ${gb(step.items[0]?.downloadBytes ?? 0)} more on the disk holding ${storePath}`,
      );
    } else {
      write(`  $ ${u.displayCommand(step.argv ?? [])}`);
      for (const item of step.items) write(`  ⎿ ${item.label}`);
    }
  }
  renderManual(plan.manual, "Not run by y — run these yourself:", write);
  renderSkipped(plan.skipped, write);
  if (!blocked) {
    write(
      `ℹ ${c.dim("Official package managers only, checked by their own checksums (not a nemesis scan) · never sudo · brew may quit and reopen an app it upgrades · Ctrl-C stops the run: a package step finishes first, a model pull stops at once and resumes later.")}`,
    );
  }
}

/**
 * Offer to update everything the report found, and do it on `y`.
 *
 * Never throws for a failed update — each item's outcome is reported and the run moves on to the
 * next one.
 */
export async function offerAndDispatch(
  report: u.UpdateReport,
  deps: {
    write: (line: string) => void;
    actions: Omit<ModelActionDeps, "write">;
    dispatch: DispatchDeps;
    selfConfig?: Partial<u.SelfUpdateConfig>;
  },
): Promise<DispatchOutcome> {
  const { actions, dispatch, write } = deps;
  const outcome: DispatchOutcome = { plan: null, asked: false, confirmed: false, results: [] };
  const closed = (): boolean => dispatch.closed();
  const getSignal = actions.signal;
  if (!getSignal) {
    // Without the turn's signal Ctrl-C could not stop the run — so it is not started at all.
    write("ℹ Not offering to update: this surface cannot cancel a running update.");
    return outcome;
  }
  if (!dispatch.ctrlCIsAbort()) {
    write(
      "ℹ Not offering to update: Prometheus's output is not a terminal here, so Ctrl-C would stop a package manager mid-install. Run it with its output on the terminal to update from here.",
    );
    return outcome;
  }
  const signal = (): AbortSignal | undefined => getSignal();
  const base = dispatch.baseEnv?.() ?? safeChildEnv();

  /* ── the facts the plan needs, all read-only, asked only when a row needs them ── */
  const managers = report.managers ?? [];
  const brewRows = managers.find((m) => m.manager === "brew" && m.ok)?.packages ?? [];
  const npmRows = managers.find((m) => m.manager === "npm-global" && m.ok)?.packages ?? [];
  const caskTokens = brewRows.filter((p) => p.kind === "cask").map((p) => p.name);
  const formulaNames = brewRows.filter((p) => p.kind !== "cask").map((p) => p.name);
  const cancelled = (): boolean => {
    if (!signal()?.aborted && !closed()) return false;
    // Before any plan exists: a probe cut short would otherwise surface as invented refusals.
    write(c.dim("(cancelled — nothing was run)"));
    return true;
  };
  if (cancelled()) return outcome;
  const sig0 = signal();
  const casks = caskTokens.length > 0 ? await dispatch.probes.casks(caskTokens, sig0) : undefined;
  const formulae =
    formulaNames.length > 0 ? await dispatch.probes.formulae(formulaNames, sig0) : undefined;
  const brewEnv = brewRows.length > 0 ? await dispatch.probes.brewEnv(sig0) : undefined;
  const npmGlobal =
    npmRows.length > 0
      ? await dispatch.probes.npmGlobal(
          npmRows.map((p) => p.name),
          sig0,
        )
      : undefined;
  if (cancelled()) return outcome;
  const free = dispatch.freeDiskBytes();
  const runtime = dispatch.runtimeFormula();
  const plan = u.planUpdateDispatch(report, {
    platform: dispatch.platform ?? process.platform,
    ...(free !== undefined ? { freeDiskBytes: free } : {}),
    modelStoreHas: (tag) => dispatch.probes.modelStoreHas(tag),
    ...(runtime ? { runtimeFormula: runtime } : {}),
    ...(formulae !== undefined ? { formulae } : {}),
    ...(casks !== undefined ? { casks } : {}),
    ...(brewEnv !== undefined ? { brewEnv } : {}),
    ...(npmGlobal !== undefined ? { npmGlobal } : {}),
    inspectVenv: (root, pkg) => dispatch.probes.venv(root, pkg),
    ...(deps.selfConfig ? { selfConfig: deps.selfConfig } : {}),
  });
  outcome.plan = plan;

  if (plan.refusal) {
    write(`ℹ Not offering to update: ${plan.refusal}`);
    return outcome;
  }
  if (plan.run.length === 0) {
    if (plan.manual.length > 0 || plan.skipped.length > 0) {
      write("ℹ Nothing here for Prometheus to run.");
      renderManual(plan.manual, "Run these yourself:", write);
      renderSkipped(plan.skipped, write);
    }
    return outcome;
  }

  // The three states in which a "y" could not be acted on. Asking anyway would make the answer
  // theatre, so the plan is shown — as what y WOULD run — and the way out stated instead.
  const steps = toSteps(plan.run);
  const level = actions.getAuthLevel();
  const planMode = dispatch.getPermMode() === "plan";
  const dryRun = dispatch.dryRun();
  const refusal = authRefusal(level, u.AUTH_INSTALL, "Updating software");
  const blocked = planMode
    ? "plan mode"
    : dryRun
      ? "dry-run is on"
      : refusal
        ? `this session is at A${level}, below A${u.AUTH_INSTALL}`
        : null;
  renderPreview(plan, steps, dispatch.probes.modelStorePath(), write, blocked);
  if (planMode) {
    write("ℹ Plan mode — nothing is run. Leave plan mode and run /updates again.");
    return outcome;
  }
  if (dryRun) {
    write("ℹ Dry-run is on — nothing is run. /dry-run turns it off; then run /updates again.");
    return outcome;
  }
  if (refusal) {
    write(c.red(`${refusal} Then run /updates again.`));
    return outcome;
  }

  await (dispatch.settle ?? settleInput)();
  if (signal()?.aborted || closed()) {
    write(c.dim("(cancelled — nothing was run)"));
    return outcome;
  }
  outcome.asked = true;
  const answer = await actions.ask(UPDATE_EVERYTHING_PROMPT);
  // Ctrl-C while the question was open aborts the turn but, in the readline host, can leave the
  // question waiting for a line — so a "y" typed after it must still read as no.
  const yes = /^y(es)?$/i.test(answer.trim()) && !signal()?.aborted && !closed();
  const audit = (
    step: DispatchStep,
    decision: "approved" | "declined",
    result?: { exitCode: number },
  ): void =>
    dispatch.audit(
      execAuditEntry({
        command: step.argv
          ? u.displayCommand(step.argv)
          : `ollama pull ${step.items[0]?.name ?? step.label}`,
        tier: "install",
        verdict: "-",
        decision,
        authLevel: level,
        ...(step.argv ? { argv: [[...step.argv]] } : {}),
        ...(result ? { exitCode: result.exitCode } : {}),
        reason:
          decision === "declined"
            ? DECLINED_REASON
            : `${step.kind === "model" ? MODEL_REASON : PACKAGE_REASON}${result ? "" : "; started"}`,
      }),
    );
  if (!yes) {
    write(c.dim("(nothing was run)"));
    for (const step of steps) audit(step, "declined");
    return outcome;
  }
  outcome.confirmed = true;

  const record = (step: DispatchStep, status: ItemStatus, detail?: string): void => {
    for (const item of step.items) {
      outcome.results.push({ item, status, ...(detail ? { detail } : {}) });
    }
  };
  const total = steps.length;
  /** why everything after this point is not started, once something has stopped the run. */
  let halt: string | null = null;
  /** models stop on their own when the daemon is gone; packages before them are unaffected. */
  let modelsHalt: string | null = null;
  let ranAny = false;
  for (const [i, step] of steps.entries()) {
    if (!halt && closed()) halt = "the session is closing";
    if (!halt && signal()?.aborted) halt = "cancelled";
    // The posture can move mid-run (Shift-Tab, /authorisation): the y was given under the old one.
    if (!halt && dispatch.getPermMode() === "plan") halt = "plan mode was switched on";
    if (!halt && actions.getAuthLevel() < u.AUTH_INSTALL) {
      halt = `the authorisation level dropped below A${u.AUTH_INSTALL}`;
    }
    const stop = halt ?? (step.kind === "model" ? modelsHalt : null);
    if (stop) {
      record(step, "not-started", stop);
      continue;
    }
    write(`▸ [${i + 1}/${total}] ${step.label}`);
    const sig = signal();

    if (step.kind === "model") {
      const item = step.items[0];
      if (!item) continue;
      // Measured again: the packages before it wrote to the same disk the plan was budgeted on.
      const freeNow = dispatch.freeDiskBytes();
      const need = (item.downloadBytes ?? item.peakDiskBytes ?? 0) + u.MODEL_DISK_FLOOR_BYTES;
      if (freeNow === undefined || freeNow < need) {
        const detail =
          freeNow === undefined
            ? "free disk space could not be measured"
            : `needs ${gb(need)} free, ${gb(freeNow)} is`;
        write(`  ⎿ not started — ${detail}`);
        record(step, "not-started", detail);
        continue;
      }
      // An audit line BEFORE the pull, so a run killed mid-download is still on record.
      audit(step, "approved");
      ranAny = true;
      const res = await pullWithProgress(item.name, {
        pull: dispatch.pull,
        show: (line) => write(`  ⎿ ${line.trim()}`),
        ...(dispatch.now ? { now: dispatch.now } : {}),
        ...(sig ? { signal: sig } : {}),
      });
      audit(step, "approved", { exitCode: res.ok ? 0 : res.aborted ? 130 : 1 });
      if (res.aborted) {
        write("  ⎿ cancelled — a later pull resumes where this one stopped");
        record(step, "cancelled");
        halt = "cancelled";
        continue;
      }
      if (!res.ok) {
        const down = /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(res.error);
        const detail = down
          ? `ollama is not running — start it, then /updates pull ${item.name}`
          : `pull failed: ${res.error}`;
        if (down) modelsHalt = "ollama is not running";
        write(`  ⎿ ${c.red(`✗ ${detail}`)}`);
        record(step, "failed", detail);
        continue;
      }
      write(`  ⎿ ${c.green("✓ pulled")}`);
      record(step, "updated");
      continue;
    }

    /**
     * A package step is NEVER handed the signal (header: an interrupted cask swap is not rolled
     * back). Ctrl-C during it is acknowledged once, and takes effect at the next boundary.
     */
    const argv = step.argv ?? [];
    let acknowledged = false;
    const acknowledge = (): void => {
      if (acknowledged) return;
      acknowledged = true;
      write(
        `  ⎿ ${c.yellow("stopping after this step — interrupting a package manager mid-install can leave it half-installed")}`,
      );
    };
    sig?.addEventListener("abort", acknowledge, { once: true });
    audit(step, "approved");
    ranAny = true;
    let res: StepResult;
    try {
      res = await dispatch.run(argv, {
        env: updateEnv(step.kind, base),
        onLine: (line) => write(`  ⎿ ${line}`),
        label: `updates:${step.key}`,
      });
    } finally {
      sig?.removeEventListener("abort", acknowledge);
    }
    audit(step, "approved", { exitCode: res.code });
    /**
     * pip upgrades past another package's pin, WARNS, and still exits 0 — the environment is then
     * broken while the step "succeeded". Its own words are the only signal there is, and only a
     * venv's own pip shows them here: pipx captures its installer's output and relays it only
     * when the step FAILS (pipx util.py), so a pipx conflict cannot be seen from outside.
     */
    const pipConflict =
      step.kind === "venv-pip" &&
      /dependency resolver does not currently take into account|which is incompatible/i.test(
        `${res.stdout}\n${res.stderr}`,
      );
    if (res.code === 0 && pipConflict) {
      const detail =
        "installed, but it conflicts with other packages in that environment — see pip's message above";
      write(`  ⎿ ${c.red(`✗ ${detail}`)}`);
      record(step, "failed", detail);
    } else if (res.code === 0) {
      write(`  ⎿ ${c.green("✓ done")}`);
      record(step, "updated");
    } else {
      const detail = failureReason(step, res);
      write(`  ⎿ ${c.red(`✗ ${detail}`)}`);
      record(step, "failed", detail);
    }
    if (sig?.aborted) halt = "cancelled";
  }
  if (ranAny) dispatch.invalidateCache();

  /* ── the account ── */
  const count = (s: ItemStatus): number => outcome.results.filter((r) => r.status === s).length;
  const parts = [
    `${count("updated")} updated`,
    ...(count("failed") ? [`${count("failed")} failed`] : []),
    ...(count("cancelled") ? [`${count("cancelled")} cancelled`] : []),
    ...(count("not-started") ? [`${count("not-started")} not started`] : []),
  ];
  write(`ℹ Done: ${parts.join(" · ")}`);
  const mark: Record<ItemStatus, string> = {
    updated: "✓",
    failed: "✗",
    cancelled: "–",
    "not-started": "–",
  };
  for (const r of outcome.results) {
    const detail =
      r.status === "not-started" ? `not started (${r.detail ?? "stopped"})` : (r.detail ?? "");
    write(`  ⎿ ${mark[r.status]} ${r.item.label}${detail ? ` — ${detail}` : ""}`);
  }
  const unfinished = outcome.results
    .filter((r) => r.item.kind === "brew-formula" && r.status !== "updated")
    .map((r) => r.item.name);
  if (unfinished.length > 0) {
    // Named, never a bare `brew upgrade`: that would also move every formula held back above. The
    // command gets a line of its own, so no terminal width can wrap it after `brew upgrade`.
    write("ℹ Not finished — when you are ready, run:");
    write(`  $ ${u.displayCommand(["brew", "upgrade", "--formula", ...unfinished])}`);
  }
  renderManual(plan.manual, "Still yours to run:", write);
  write(
    `ℹ ${c.dim("Run /updates again to confirm — an exit code of 0 is not proof the version moved.")}`,
  );
  return outcome;
}
