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

import { type CheckDeps, type CheckResult, checkUpdates } from "@prometheus/core/updates-live";
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
  deps.write(c.dim("Checking for updates (CLIs · local models · Prometheus)…"));
  let result: CheckResult;
  try {
    result = await check({ ...baseCheckDeps(deps), force: true });
  } catch (err) {
    deps.write(c.red(`update check failed: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
  deps.write(colorize(result.report));
  if (!u.hasUpdates(result.report)) deps.write(c.green("✓ everything is up to date."));
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
