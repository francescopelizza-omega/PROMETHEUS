/**
 * commands/budget-cmd.ts — `prometheus budget <status|set-session|set-daily|set-warn|
 * set-unpriced>`: visibility and friendly configuration for the REAL, already-enforced spend
 * cap (CLI-030), reframed honestly for what Prometheus actually is — a single-user local tool,
 * not a multi-tenant server. There is no new enforcement here: `session/agent-runtime.ts`'s
 * `checkBudgetGate` (built on `@prometheus/core`'s `ai.decideBudget`/`ai.evaluateBudgets`) has
 * been the real, fail-closed, hard-stop gate all along. What was missing was a way to SEE the
 * number it's enforcing against, and a way to SET a cap without hand-writing TOML.
 *
 * "TEAM" governance, honestly: a repo's `.prometheus.toml` (or the legacy `.prom.toml`)
 * `[budget]` table is TIGHTEN-ONLY over the user's own cap (`cliProfiles.sanitizeProjectLayer` —
 * the identical one-way-narrowing pattern already used for `gateMode`/tools). Commit one to a
 * repo and it clamps every teammate who runs `prometheus` inside it, with no server, no
 * accounts, no new persistence format — this already IS the team-scale mechanism; `--project` on
 * the `set-*` subcommands targets it explicitly. Without `--project`, the write targets the
 * user's own active profile (a personal cap that follows them across every project).
 *
 * `status` reads the SAME accounting store (session/history-store.ts's CLI-029 `*.acct.jsonl`
 * files) and prices with the SAME `ai.priceForModel`/`isLocalModelId` logic
 * `session/host.ts`'s `makeBudgetGuard` uses for real enforcement, via the new
 * `ai.summarizeSpend` (a pure, additive core export) — so a status display can never silently
 * disagree with what the gate would actually decide. There is no "current session" for a
 * standalone `budget status` invocation (no turn is running), so it reports the MOST RECENTLY
 * recorded session's spend, not a live one, and says so.
 */
import { existsSync } from "node:fs";

import { ai, cliProfiles, loadPricing } from "@prometheus/core";

import type { CliContext, CommandJsonEnvelope, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import {
  discoverProjectConfigPath,
  loadEffectiveStartupProfileWithNotes,
  loadProjectProfile,
  readConfigRaw,
  resolveActiveProfileName,
  writeTextAtomic,
} from "../profile-store.js";
import { c, heading } from "../render.js";
import {
  latestAccountingSession,
  readAccounting,
  readAccountingSince,
} from "../session/history-store.js";
import { isLocalModelId } from "../session/host.js";

/** What every subcommand handler produces: human lines (one per `write()` call, no embedded
 *  "\n"), a JSON-able payload for `--json`, and the process exit code. */
export interface HandlerResult {
  lines: string[];
  json: Record<string, unknown>;
  exitCode: number;
}

const USAGE_LINES: string[] = [
  "usage: prometheus budget <status|set-session|set-daily|set-warn|set-unpriced>",
  "",
  "  status",
  "  set-session <usd>       [--project]",
  "  set-daily <usd>         [--project]",
  "  set-warn <percent>      [--project]",
  "  set-unpriced <block|warn> [--project]",
  "",
  "  Without --project: your OWN cap, follows you across every project.",
  "  With --project: writes the nearest .prometheus.toml's [budget] table — a repo config can only",
  "  TIGHTEN a cap for whoever runs prometheus inside it, never loosen it.",
];

function usageResult(): HandlerResult {
  return { lines: USAGE_LINES, json: { ok: false, error: "usage" }, exitCode: 2 };
}

function errorResult(message: string): HandlerResult {
  return { lines: [c.red(`error: ${message}`)], json: { ok: false, error: message }, exitCode: 2 };
}

/** The SAME price resolution `session/host.ts`'s `makeBudgetGuard` uses for real enforcement —
 *  a status number must never be computed by a different rule than the gate that enforces it. */
function makePriceFor(pricing: ai.Pricing): ai.PriceFor {
  return (model: string) => {
    const p = ai.priceForModel(pricing, model);
    if (p) return { pricePerMTokIn: p.inputUsdPerMTok, pricePerMTokOut: p.outputUsdPerMTok };
    if (isLocalModelId(model)) return { pricePerMTokIn: null, pricePerMTokOut: null };
    return undefined;
  };
}

function pct(spent: number, cap: number): string {
  if (cap <= 0) return "—";
  return `${Math.round((spent / cap) * 100)}%`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/* ── status ───────────────────────────────────────────────────────────────── */

export function handleStatus(
  cwd: string,
  home: string,
  nowIso: string,
  // Injectable seam so a test controls the resolved budget config deterministically —
  // `loadEffectiveStartupProfileWithNotes` has no `home` parameter of its own (it always reads
  // the REAL OS home for the user-profile layer), so this is the only way to test `handleStatus`
  // without depending on whatever profile happens to be active on the machine running the test.
  resolveProfile: (p: {
    cwd?: string;
  }) => ReturnType<
    typeof loadEffectiveStartupProfileWithNotes
  > = loadEffectiveStartupProfileWithNotes,
): HandlerResult {
  const { profile, rejected } = resolveProfile({ cwd });
  const budget = profile.budget;
  const pricing = loadPricing();
  const priceFor = makePriceFor(pricing);

  const latestSessionId = latestAccountingSession(home);
  const sessionRecords = latestSessionId ? readAccounting(home, latestSessionId) : [];
  const dayRecords = readAccountingSince(home, ai.startOfLocalDayMs(nowIso));

  const sessionSummary = ai.summarizeSpend(sessionRecords, nowIso, priceFor);
  const daySummary = ai.summarizeSpend(dayRecords, nowIso, priceFor);
  const unpriced = [...new Set([...sessionSummary.unpriced, ...daySummary.unpriced])].sort();

  const lines: string[] = [heading("Budget"), ""];

  if (!ai.hasBudgetCap(budget)) {
    lines.push(
      "no budget cap configured — spend is unlimited.",
      "set one with: prometheus budget set-daily <usd>  (or set-session <usd>)",
    );
  } else {
    if (budget?.sessionUsd !== undefined) {
      lines.push(
        `session: ${fmtUsd(sessionSummary.sessionSpentUsd)} of ${fmtUsd(budget.sessionUsd)} cap ` +
          `(${pct(sessionSummary.sessionSpentUsd, budget.sessionUsd)})${
            latestSessionId
              ? " — most recently recorded session, not necessarily live"
              : " — no session recorded yet"
          }`,
      );
    }
    if (budget?.dailyUsd !== undefined) {
      lines.push(
        `today:   ${fmtUsd(daySummary.dailySpentUsd)} of ${fmtUsd(budget.dailyUsd)} cap ` +
          `(${pct(daySummary.dailySpentUsd, budget.dailyUsd)})`,
      );
    }
    lines.push(`warn at: ${budget?.warnAtPercent ?? 80}%`);
    lines.push(
      `unpriced models: ${budget?.unpricedPolicy === "warn" ? "allowed uncapped (warn)" : "blocked (fail-closed, default)"}`,
    );
  }

  if (unpriced.length > 0) {
    lines.push(
      "",
      `${c.yellow("⚠")} no price known for: ${unpriced.join(", ")} — excluded from the totals above${
        budget?.unpricedPolicy === "warn" ? "" : "; a configured cap BLOCKS a turn on one of these"
      }`,
    );
  }

  if (rejected.length > 0) {
    lines.push(
      "",
      `${c.dim("this project's config asked for something refused:")}`,
      ...rejected.map((r) => c.dim(`  ${r.key}: ${r.reason}`)),
    );
  }

  return {
    lines,
    json: {
      ok: true,
      capped: ai.hasBudgetCap(budget),
      config: budget ?? {},
      session: { spentUsd: sessionSummary.sessionSpentUsd, sessionId: latestSessionId },
      today: { spentUsd: daySummary.dailySpentUsd },
      unpriced,
      rejected,
    },
    exitCode: 0,
  };
}

/* ── set-* ────────────────────────────────────────────────────────────────── */

type BudgetField = "sessionUsd" | "dailyUsd" | "warnAtPercent" | "unpricedPolicy";

function parseFieldValue(field: BudgetField, raw: string): number | "block" | "warn" | undefined {
  if (field === "unpricedPolicy") {
    return raw === "block" || raw === "warn" ? raw : undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (field === "warnAtPercent") return n > 0 && n <= 100 ? n : undefined;
  return n > 0 ? n : undefined; // sessionUsd / dailyUsd
}

/** Mutate one field on a profile's `.budget` table, creating the table if absent. */
function withBudgetField(
  profile: cliProfiles.CliProfile,
  field: BudgetField,
  value: number | "block" | "warn",
): cliProfiles.CliProfile {
  return { ...profile, budget: { ...profile.budget, [field]: value } };
}

export function handleSetField(
  field: BudgetField,
  args: string[],
  opts: {
    project: boolean;
    cwd: string;
    /**
     * TEST-ONLY seam. Profiles live under `~/.config/prometheus-studio/` (`cliProfiles`'s own
     * `home` param, defaulting to `os.homedir()`) — a COMPLETELY DIFFERENT tree from
     * `prometheusHome()`'s `~/.prometheus` (accounting/state/sessions). Passing `prometheusHome()`
     * here would write the cap somewhere `handleStatus`'s real
     * `loadEffectiveStartupProfileWithNotes` (which always reads the REAL `os.homedir()` — it has
     * no override of its own) would never look, so `status` would report "no cap" right after
     * `set-session` reported success. Production code must NEVER pass this — omit it entirely so
     * every call falls through to the real `os.homedir()`, the same default `handleStatus`'s read
     * path uses. Only a test may inject a fake one, to avoid touching the real machine's real
     * profile directory.
     */
    osHome?: string;
  },
): HandlerResult {
  const raw = args[0];
  if (!raw) return errorResult(`usage: prometheus budget set-${field} <value> [--project]`);
  const value = parseFieldValue(field, raw);
  if (value === undefined) {
    return errorResult(
      field === "unpricedPolicy"
        ? `invalid value "${raw}" (expected "block" or "warn")`
        : field === "warnAtPercent"
          ? `invalid value "${raw}" (expected a number between 1 and 100)`
          : `invalid value "${raw}" (expected a positive number of dollars)`,
    );
  }

  if (opts.project) {
    const found = loadProjectProfile(opts.cwd);
    if (!found) {
      return errorResult(
        "no usable .prometheus.toml (or legacy .prom.toml) found in this project (it must already set agent.model) — " +
          'create one first (it needs at least an [agent] model = "..." table before a ' +
          "[budget] policy can take effect), then re-run with --project",
      );
    }
    const updated = withBudgetField(found.profile, field, value);
    writeTextAtomic(found.path, cliProfiles.serializeProfile(updated));
    return {
      lines: [
        `${c.green("✓")} set ${field} = ${value} in ${found.path} (applies to this project's team)`,
      ],
      json: { ok: true, field, value, path: found.path, scope: "project" },
      exitCode: 0,
    };
  }

  const name = resolveActiveProfileName(undefined, opts.osHome);
  const path = cliProfiles.profilePath(name, opts.osHome);
  const existingRaw = existsSync(path) ? readConfigRaw(path) : "";
  const base =
    (existingRaw ? cliProfiles.parseProfile(existingRaw, name) : undefined) ??
    cliProfiles.getCliProfile(name) ??
    (cliProfiles.getCliProfile(cliProfiles.DEFAULT_PROFILE_NAME) as cliProfiles.CliProfile);
  const updated = withBudgetField(base, field, value);
  writeTextAtomic(path, cliProfiles.serializeProfile(updated));
  return {
    lines: [`${c.green("✓")} set ${field} = ${value} for your "${name}" profile`],
    json: { ok: true, field, value, path, scope: "user" },
    exitCode: 0,
  };
}

/* ── entry point ──────────────────────────────────────────────────────────── */

function parseProjectFlag(args: string[]): { rest: string[]; project: boolean } {
  const project = args.includes("--project");
  return { rest: args.filter((a) => a !== "--project"), project };
}

export async function runBudgetCommand(
  args: string[],
  opts: {
    cwd: string;
    /** the `~/.prometheus` root — used ONLY for reading the accounting store (`status`). */
    home: string;
    nowIso: string;
    json: boolean;
    write: (line: string) => void;
    /** TEST-ONLY: see `handleSetField`'s own doc — production must never pass this. */
    osHome?: string;
  },
): Promise<{ exitCode: number }> {
  const sub = args[0];
  const rest = args.slice(1);

  let result: HandlerResult;
  switch (sub) {
    case "status":
      result = handleStatus(opts.cwd, opts.home, opts.nowIso);
      break;
    case "set-session": {
      const { rest: r, project } = parseProjectFlag(rest);
      result = handleSetField("sessionUsd", r, { project, cwd: opts.cwd, osHome: opts.osHome });
      break;
    }
    case "set-daily": {
      const { rest: r, project } = parseProjectFlag(rest);
      result = handleSetField("dailyUsd", r, { project, cwd: opts.cwd, osHome: opts.osHome });
      break;
    }
    case "set-warn": {
      const { rest: r, project } = parseProjectFlag(rest);
      result = handleSetField("warnAtPercent", r, { project, cwd: opts.cwd, osHome: opts.osHome });
      break;
    }
    case "set-unpriced": {
      const { rest: r, project } = parseProjectFlag(rest);
      result = handleSetField("unpricedPolicy", r, { project, cwd: opts.cwd, osHome: opts.osHome });
      break;
    }
    default:
      result = usageResult();
      break;
  }

  if (opts.json) {
    opts.write(JSON.stringify(result.json));
  } else {
    for (const line of result.lines) opts.write(line);
  }
  return { exitCode: result.exitCode };
}

/**
 * The `prometheus budget …` dispatcher entry point (index.ts's one-line registration, mirroring
 * `schedule-cmd.ts`'s `runTasksCommand(ctx)` / `persona-cmd.ts`'s `runPersonaCommandFromCtx`).
 */
export async function runBudgetCommandFromCtx(ctx: CliContext): Promise<CommandOutcome> {
  const flagArgs = Object.entries(ctx.args.flags).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, value],
  );
  const rawArgs = [...ctx.args.positionals, ...flagArgs];

  const lines: string[] = [];
  let jsonPayload: CommandJsonEnvelope | undefined;
  const { exitCode } = await runBudgetCommand(rawArgs, {
    cwd: ctx.args.cwd ?? process.cwd(),
    home: prometheusHome(),
    nowIso: new Date().toISOString(),
    json: ctx.json,
    write: (line) => {
      if (ctx.json) {
        try {
          jsonPayload = JSON.parse(line) as CommandJsonEnvelope;
        } catch {
          /* a progress line slipped through outside --json's single-object contract; drop it */
        }
      } else {
        lines.push(line);
      }
    },
  });

  return {
    text: lines.join("\n"),
    json: jsonPayload ?? { ok: exitCode === 0 },
    exitCode,
  };
}
