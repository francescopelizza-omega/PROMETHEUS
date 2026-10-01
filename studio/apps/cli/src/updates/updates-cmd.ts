// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/updates-cmd.ts — the `/updates` command + the throttled startup notice.
 *
 * `/updates` forces a fresh check + prints the full report (vendor CLIs, local models,
 * Prometheus self) with the exact COPYABLE commands — and never runs them (propose, the user
 * pastes; AUTO_INSTALL=false ethos). `updatesStartupNotice` runs a THROTTLED check (cheap,
 * fail-soft, cached) and returns a single one-liner pointing at /updates, or "" when nothing
 * is actionable — so the session boot stays fast + quiet when there's nothing to say.
 */
import { updates as u } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import {
  type CheckDeps,
  type CheckResult,
  checkUpdates,
  fetchOllamaVersion,
} from "@prometheus/core/updates-live";
import { loadSettings } from "../home.js";
import { c } from "../render.js";
import {
  type ModelActionDeps,
  parseSubcommand,
  runCatalog,
  runConvert,
  runPull,
  runRemove,
} from "./model-actions-cmd.js";

export interface UpdatesDeps {
  home: string;
  promVersion: string;
  client?: EngineClient;
  write: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  scriptPath?: string;
  cwd?: string;
  now?: () => Date;
  /** test seam — the checker (default the real throttled check). */
  check?: (deps: CheckDeps) => Promise<CheckResult>;
  /**
   * Test seam for the running-daemon versions. Supplied means "do not probe": a test must be
   * able to assert the skew check without a live ollama, and without a 1.5s timeout per run.
   */
  serverVersions?: Record<string, string>;
  /** package/repo overrides; `channel` is resolved from settings and always set. */
  selfConfig?: Partial<u.SelfUpdateConfig>;
  /**
   * The seams the ACTION subcommands need — `/updates pull` and `/updates rm`.
   *
   * Optional, because a surface that cannot ask a question must not be able to run an
   * irreversible one either. When they are absent the subcommands refuse and say so, rather
   * than proceeding with an assumed "yes" or an assumed authorisation level.
   */
  actions?: Omit<ModelActionDeps, "write">;
  /**
   * The catalogue seam — what to search and what this machine can run.
   *
   * Separate from `actions` because browsing is READ-ONLY: a surface that cannot confirm an
   * irreversible action can still be allowed to show a list.
   */
  browse?: {
    search: (q: string) => Promise<{ entries: u.CatalogEntry[]; error: string }>;
    budget: u.FitBudget;
    installed?: readonly string[];
  };
}

/**
 * The dist-tag the user asked for, from the shared global settings layer.
 *
 * `settings.updateChannel` had a schema entry, a default and a validator, and NO reader —
 * every proposed command hardcoded `@latest`, so choosing "beta" was accepted and then
 * ignored. Read here rather than threaded through every caller because this is the one place
 * that builds the update plan, and `home` is already on `UpdatesDeps`. Fail-soft: `loadSettings`
 * returns `{}` on anything unreadable, and an unrecognised value falls back to "latest".
 */
function resolveChannel(home: string): "latest" | "beta" | "alpha" {
  const v = loadSettings(home).updateChannel;
  return v === "beta" || v === "alpha" ? v : "latest";
}

function baseCheckDeps(deps: UpdatesDeps): CheckDeps {
  return {
    home: deps.home,
    promVersion: deps.promVersion,
    selfConfig: { ...deps.selfConfig, channel: resolveChannel(deps.home) },
    ...(deps.client ? { client: deps.client } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.scriptPath ? { scriptPath: deps.scriptPath } : {}),
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
}

/**
 * The running daemon's version, for the client/server skew check.
 *
 * ── WHY THIS IS HERE AND WAS NOT ────────────────────────────────────────────────────────────
 *
 * `findConflicts` has a `client-server-skew` branch, `check.ts` accepts `serverVersions`, and the
 * DESKTOP passes it (`apps/desktop/src/main/updates-ipc.ts:188`). The CLI never did — so the one
 * surface where this machine's owner actually runs `/updates` could not emit the finding, and
 * ollama's split install was reported as a `duplicate-install` at severity LOW: "each owner will
 * keep offering its own updates". That is true and it is not the point. The point, at severity
 * HIGH, is that a 0.34.4 client on PATH is driving the 0.34.1 server inside Ollama.app, so
 * `brew upgrade ollama` moves the number the user sees and changes nothing that answers a
 * request. CLAUDE.md §2.8 is entirely about that trap; the check for it was wired to one surface.
 *
 * `GET /api/version` is metadata: it does not touch a model, unlike `/v1/chat/completions`,
 * `/api/generate` and `/api/embeddings` (CLAUDE.md §2.3). 1.5s timeout, loopback only, and a
 * miss returns `{}` — a daemon that is not running must degrade to "no skew check", never to an
 * error or a stall.
 *
 * Deliberately NOT called from `updatesStartupNotice`: that path already skips the package sweep
 * to keep session boot instant, and a conflict it cannot compute is one it would not have shown.
 *
 * ── WHY `deps.check` SUPPRESSES THE PROBE ───────────────────────────────────────────────────
 *
 * This probe belongs to the live checker, so it is skipped whenever the checker itself is faked.
 * `deps.check` is THE seam for "do not do real IO in this run", and every existing test uses it;
 * making the probe ignore that boundary would add an unstubbed `fetch` to a dozen test paths
 * that are deliberately network-free. This repo's convention is a dependency-injected or stubbed
 * fetch, never an env flag (CLAUDE.md §2.3), and a suite that can reach the daemon is the exact
 * defect that made a TUI test load 23 GB of weights. A test wanting the skew check states it, by
 * passing `serverVersions` — which is honest in both directions: nothing is probed, and the
 * value under test is the one the test wrote.
 */
async function serverVersions(
  deps: UpdatesDeps,
): Promise<{ serverVersions?: Record<string, string> }> {
  if (deps.serverVersions) return { serverVersions: deps.serverVersions };
  if (deps.check) return {};
  const v = await fetchOllamaVersion().catch(() => undefined);
  return v ? { serverVersions: { ollama: v } } : {};
}

/** Colorize the plain report from core (keep the logic in core, the palette here). */
function colorize(report: u.UpdateReport): string {
  const plain = u.formatUpdateReport(report);
  return plain
    .split("\n")
    .map((line) => {
      if (line === "Updates") return c.bold(line);
      if (/^[A-Z][A-Za-z ()]+$/.test(line) && !line.startsWith("  ")) return c.bold(line);
      if (/→/.test(line)) return c.yellow(line); // an update is available on this line
      if (
        /update:|ollama pull|npm install|git -C|claude update|codex update|cursor-agent update/.test(
          line,
        )
      )
        return c.cyan(line);
      if (/⚠/.test(line)) return c.red(line);
      if (/up to date|up-to-date/.test(line)) return c.dim(line);
      return line;
    })
    .join("\n");
}

/**
 * `/updates fix [tool]` — the repair for one install conflict, and nothing else.
 *
 * ── WHY THIS PRINTS AND DOES NOT SPAWN ──────────────────────────────────────────────────────
 *
 * The obvious next step is to run the command. This deliberately does not, and the reason is not
 * timidity — it is that the two candidate executors are both worse than printing:
 *
 *   • `brew` evaluates Ruby from the tap, runs formula post-install scripts, and for a cask
 *     installs a `.pkg` whose pre/post-install scripts run under `sudo`. That is FETCHED CODE
 *     EXECUTING, started by Prometheus. CLAUDE.md §5: "`nemesis` is a fail-closed gate: fetched
 *     code is scanned before it is allowed to execute. Do not add a bypass, a 'dev mode' skip, or
 *     a default-allow branch." A dedicated spawn path inside `/updates fix` is precisely a
 *     default-allow branch, in the repo of a security tool.
 *   • Routing it through the host's own gated runner would be correct, and that runner already
 *     exists — it is what the agent uses for any `run_command`. Which means the user already has
 *     a way to run this under the gate, and `/updates fix` does not need a second one.
 *
 * What was actually missing was never the execution. It was knowing WHICH command, because the
 * plausible ones are wrong in ways that are invisible until after: `brew upgrade --cask
 * claude-code` installs something older into a path PATH never reaches, `--zap` deletes the
 * install you are keeping, prepending to PATH downgrades codex by fifteen minor versions, and
 * `npm config set prefix` strands every global you already have. That is what this answers.
 *
 * The check is re-run rather than read from cache, because the report can be six hours old and
 * these commands NAME A SPECIFIC COPY. PATH changes with a new shell, a direnv, or the very rc
 * edit this feature also proposes — and a removal aimed at a stale resolution deletes the copy
 * the user actually runs.
 */
function renderFix(report: u.UpdateReport, subject: string): string {
  const all = report.remedies ?? [];
  if (all.length === 0) {
    return c.green("✓ no install conflicts — nothing to repair.");
  }

  const want = subject.trim().toLowerCase();
  const picked = want === "" ? all : all.filter((m) => m.subject.toLowerCase() === want);
  if (picked.length === 0) {
    const names = [...new Set(all.map((m) => m.subject))].join(", ");
    return c.red(`no conflict found for "${subject}". Known: ${names}`);
  }

  /**
   * One repair per SUBJECT. The same duplicate install surfaces as several conflicts sharing a
   * single fix, and printing it once per conflict would invite running it three times.
   */
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of picked) {
    if (seen.has(m.subject)) continue;
    seen.add(m.subject);
    out.push(c.bold(m.title));
    for (const line of m.rationale.split("\n")) out.push(line === "" ? "" : `  ${line}`);
    if (m.blocked) {
      out.push(c.yellow(`  NOT AUTOMATED: ${m.blocked}`));
    } else {
      out.push("");
      for (const step of m.steps) {
        if (step.displayAs) for (const l of step.displayAs) out.push(c.cyan(`  ${l}`));
        else out.push(c.cyan(`  $ ${u.displayCommand(step.argv)}`));
        out.push(c.dim(`      ${step.purpose}`));
        if (step.undo) out.push(c.dim(`      undo:  ${u.displayCommand(step.undo)}`));
      }
      if (m.keeps) out.push(c.dim(`  keeps: ${m.keeps}`));
      if (m.permanent)
        out.push(c.green("  This clears the notice for good — the conflict stops being true."));
    }
    if (m.verify) out.push(c.dim(`  verify:  ${u.displayCommand(m.verify)}`));
    out.push("");
  }

  /**
   * The refusals are printed WITH the repair, not instead of it. The user will otherwise find
   * `--zap` in a forum answer and reach for it precisely because it sounds thorough.
   */
  out.push(c.red("Never run these, whatever a changelog or forum says:"));
  for (const n of u.NEVER_RUN) {
    out.push(c.red(`  ✗ ${u.displayCommand(n.argv)}`));
    out.push(c.dim(`      ${n.because}`));
  }
  out.push("");
  out.push(
    c.dim(
      "Prometheus proposes; it never auto-updates. These are checked against THIS machine as of a moment ago — run them yourself.",
    ),
  );
  return out.join("\n");
}

/** `/updates` — force a fresh check + print the full, copyable report. Returns the report so the
 *  CLI can emit a structured `--json` envelope (CLI-047), or `null` on a check FAILURE (distinct
 *  from a successful check with nothing to update, which returns a real report). Human output
 *  via `deps.write` is byte-identical either way. */
export async function runUpdates(rest: string, deps: UpdatesDeps): Promise<u.UpdateReport | null> {
  /**
   * The action subcommands come first, and they never fall through to the report.
   *
   * `/updates pull <tag>` that quietly ran a six-second sweep instead — because the verb was not
   * recognised — would look like it had worked.
   */
  const sub = parseSubcommand(rest);
  if (sub.kind === "usage") {
    deps.write(c.red(sub.message));
    return null;
  }
  if (sub.kind === "catalog") {
    if (!deps.browse) {
      deps.write(c.red("this surface cannot browse the catalogue."));
      return null;
    }
    await runCatalog(sub.query, {
      ...(deps.actions ?? {
        confirm: async () => false,
        ask: async () => "",
        getAuthLevel: () => 0,
      }),
      write: deps.write,
      ...deps.browse,
    });
    return null;
  }
  if (sub.kind === "convert") {
    /**
     * No authorisation gate and no confirmation: this PRINTS a plan and runs nothing. A
     * conversion is an hour of someone's machine and several GB of Python dependencies, and the
     * commands are theirs to run once they have read what they cost.
     */
    await runConvert(sub.rest, {
      ...(deps.actions ?? {
        confirm: async () => false,
        ask: async () => "",
        getAuthLevel: () => 0,
      }),
      write: deps.write,
    });
    return null;
  }
  if (sub.kind === "pull" || sub.kind === "remove") {
    if (!deps.actions) {
      // No confirm seam means no way to ask, and an irreversible action must never be taken on
      // an assumed answer.
      deps.write(c.red("this surface cannot run update actions — use the command it printed."));
      return null;
    }
    const actionDeps: ModelActionDeps = { ...deps.actions, write: deps.write };
    if (sub.kind === "pull") await runPull(sub.tag, actionDeps);
    else await runRemove(sub.tag, actionDeps);
    return null;
  }

  const check = deps.check ?? checkUpdates;
  deps.write(
    sub.kind === "fix"
      ? c.dim("Re-checking this machine before proposing a repair…")
      : c.dim("Checking for updates (CLIs · local models · Prometheus)…"),
  );
  let result: CheckResult;
  try {
    result = await check({ ...baseCheckDeps(deps), force: true, ...(await serverVersions(deps)) });
  } catch (err) {
    deps.write(c.red(`update check failed: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
  if (sub.kind === "fix") {
    deps.write(renderFix(result.report, sub.subject));
    return result.report;
  }

  deps.write(colorize(result.report));
  if (!u.hasUpdates(result.report)) deps.write(c.green("✓ everything is up to date."));
  if ((result.report.remedies ?? []).length > 0) {
    deps.write(
      c.dim("`/updates fix <tool>` shows just one repair, re-measured at the moment you ask."),
    );
  }
  deps.write(
    c.dim("Prometheus proposes; it never auto-updates. Copy a command above + run it yourself."),
  );
  return result.report;
}

/**
 * The throttled startup notice: a cheap, cached, fail-soft check. Returns a one-liner (or "")
 * — the host prints it under the banner so the user is nudged without a blocking network call.
 *
 * `tint` exists because the two hosts paint differently and neither may be hardcoded here. The
 * readline host wants `c.yellow`; the TUI must go through its own `paint(…, caps)` so the line
 * degrades correctly at `--color=none` and on a 16-colour terminal. Passing `(s) => s` returns
 * it plain.
 */
export async function updatesStartupNotice(
  deps: UpdatesDeps & { tint?: (line: string) => string },
): Promise<string> {
  const check = deps.check ?? checkUpdates;
  const tint = deps.tint ?? ((line: string) => c.yellow(line));
  try {
    /**
     * The startup path skips the package-manager sweep.
     *
     * It is `spawnSync`-based and `brew outdated` alone takes ~2s, during which the event loop is
     * held — on a session start that is the difference between a prompt appearing immediately and
     * a visible stall. `/updates` runs the full sweep; the nudge runs the cheap half and says so.
     */
    const { report } = await check({ ...baseCheckDeps(deps), force: false, skipPackages: true });
    const line = u.summarizeForStartup(report);
    return line ? tint(line) : "";
  } catch {
    return ""; // never let an update check break startup
  }
}
