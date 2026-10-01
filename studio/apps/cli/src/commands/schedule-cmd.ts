// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/schedule-cmd.ts — `prometheus tasks <add|list|remove|enable|disable|run-due|
 * install-cron>`: the CLI surface over scheduled/autonomous agent runs.
 *
 * NAMED "tasks" ON THE CLI, NOT "schedule": `prometheus schedule` already exists — a REAL,
 * confirm-gated engine verb (`prometheus.py cmd_schedule`) that scaffolds a scheduled headless
 * `claude --bare -p` watcher via a real cron/launchd entry, plus the self-healing `--auto`/
 * `--auto-off` maintenance schedule (see commands/generic.ts's `engineSubcommand`). This feature
 * is a different, complementary thing — a multi-task STORE with list/enable/disable/bounded-
 * autonomy/a desktop panel, and an `install-cron` that only PRINTS the line rather than writing
 * it — so it is exposed under a distinct verb to avoid silently shadowing the existing one.
 *
 * The DECISIONS (cron parsing, the day-of-month/day-of-week OR rule, the readonly/edits/
 * commands autonomy ladder) all live in `@prometheus/core`'s `agent/schedule.ts` — read-only,
 * already tested there. This file is only: parse the subcommand's flags, validate them (a bad
 * cron expression is refused HERE, before anything is persisted — never silently accepted as
 * "never fires" or "always fires"), and render a result — mirroring `commands/agents-cmd.ts`
 * (the closest sibling: another "list/manage background things" surface) for shape, and
 * `session/model-health-command.ts` for the store-backed-command convention.
 *
 * Persistence goes through the sibling `session/schedule-store.ts` (on-disk I/O only); actually
 * EXECUTING due tasks goes through the sibling `session/schedule-runner.ts`, which itself reuses
 * the CLI's existing headless one-shot path (`session/one-shot.ts`) at exactly the autonomy the
 * task declares — this file never runs a model turn itself.
 *
 * Built as small, directly testable functions per subcommand, each returning
 * `{ lines, json, exitCode }` for `runScheduleCommand` to render through a single-line `write`;
 * `runTasksCommand(ctx)` at the bottom is the one-line registration `index.ts`'s dispatcher calls.
 *
 * `install-cron` is a DELIBERATE non-installer: it prints the crontab line for the user to add
 * themselves and touches no file — an unattended job silently rewriting the user's crontab is
 * a worse product than one that asks to be told to.
 */
import { agent } from "@prometheus/core";

import type { CliContext, CommandJsonEnvelope, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import { c, heading, table } from "../render.js";
import { runDueSchedules } from "../session/schedule-runner.js";
import { loadSchedules, removeScheduledTask, upsertTask } from "../session/schedule-store.js";

/** What every subcommand handler produces: human lines (one per `write()` call, no embedded
 *  "\n"), a JSON-able payload for `--json`, and the process exit code. */
export interface HandlerResult {
  lines: string[];
  json: Record<string, unknown>;
  exitCode: number;
}

const USAGE_LINES: string[] = [
  "usage: prometheus tasks <add|list|remove|enable|disable|run-due|install-cron>",
  "",
  '  add --name <str> --cron "<expr>" --task "<prompt>" [--autonomy readonly|edits|commands] [--cwd <path>]',
  "  list",
  "  remove <id>",
  "  enable <id>",
  "  disable <id>",
  "  run-due",
  "  install-cron",
];

function usageResult(): HandlerResult {
  return { lines: USAGE_LINES, json: { ok: false, error: "usage" }, exitCode: 2 };
}

function errorResult(message: string): HandlerResult {
  return { lines: [c.red(`error: ${message}`)], json: { ok: false, error: message }, exitCode: 2 };
}

/** A minimal `--flag value` / `--flag` parser — every schedule flag takes a string value except
 *  the ones nobody sets bare, so a trailing bare `--flag` just records `"true"` rather than
 *  swallowing the next flag as its value. */
function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function isAutonomy(v: string): v is agent.ScheduleAutonomy {
  return v === "readonly" || v === "edits" || v === "commands";
}

function formatNextRun(cronExpr: string, fromMs: number): string {
  const next = agent.nextRunAfter(cronExpr, fromMs);
  return next === null ? "—" : new Date(next).toISOString();
}

/* ── add ──────────────────────────────────────────────────────────────────── */

export function handleAdd(args: string[], home: string): HandlerResult {
  const flags = parseFlags(args);
  const name = flags.name;
  const cronExpr = flags.cron;
  const task = flags.task;
  const autonomyRaw = flags.autonomy ?? "readonly";
  const cwd = flags.cwd;

  if (!name) return errorResult("--name is required");
  if (!cronExpr) return errorResult("--cron is required");
  if (!task) return errorResult("--task is required");

  const cronError = agent.validateCronExpr(cronExpr);
  if (cronError) return errorResult(`invalid --cron: ${cronError}`);

  if (!isAutonomy(autonomyRaw)) {
    return errorResult(
      `invalid --autonomy "${autonomyRaw}" (expected readonly, edits, or commands)`,
    );
  }

  const id = `sched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const newTask: agent.ScheduledTask = {
    id,
    name,
    cronExpr,
    task,
    autonomy: autonomyRaw,
    enabled: true,
    createdIso: new Date().toISOString(),
    ...(cwd ? { cwd } : {}),
  };
  upsertTask(newTask, home);

  const nextRun = formatNextRun(cronExpr, Date.now());
  return {
    lines: [`${c.green("✓")} scheduled "${name}" (${id}) — next run: ${nextRun}`],
    json: { ok: true, task: newTask, nextRun },
    exitCode: 0,
  };
}

/* ── list ─────────────────────────────────────────────────────────────────── */

export function handleList(home: string): HandlerResult {
  const store = loadSchedules(home);
  const tasks = Object.values(store);
  if (tasks.length === 0) {
    return { lines: ["no scheduled tasks yet"], json: { ok: true, tasks: [] }, exitCode: 0 };
  }
  const nowMs = Date.now();
  const rows = tasks.map((t) => [
    t.id,
    t.name,
    t.cronExpr,
    t.autonomy,
    t.enabled ? "yes" : "no",
    t.lastResult ? `${t.lastResult.ok ? "ok" : "fail"}: ${t.lastResult.summary}` : "—",
    formatNextRun(t.cronExpr, nowMs),
  ]);
  const rendered = table(
    [
      { header: "ID" },
      { header: "NAME" },
      { header: "CRON" },
      { header: "AUTONOMY" },
      { header: "ENABLED" },
      { header: "LAST RESULT" },
      { header: "NEXT RUN" },
    ],
    rows,
  );
  const lines = [
    heading(`Scheduled tasks  ${c.dim(`(${tasks.length})`)}`),
    "",
    ...rendered.split("\n"),
  ];
  return { lines, json: { ok: true, tasks }, exitCode: 0 };
}

/* ── remove ───────────────────────────────────────────────────────────────── */

export function handleRemove(args: string[], home: string): HandlerResult {
  const id = args[0];
  if (!id) return errorResult("usage: prometheus tasks remove <id>");
  const store = loadSchedules(home);
  if (!(id in store)) return errorResult(`no such scheduled task: ${id}`);
  removeScheduledTask(id, home);
  return { lines: [`${c.green("✓")} removed ${id}`], json: { ok: true, id }, exitCode: 0 };
}

/* ── enable / disable ────────────────────────────────────────────────────── */

function handleSetEnabled(args: string[], home: string, enabled: boolean): HandlerResult {
  const verb = enabled ? "enable" : "disable";
  const id = args[0];
  if (!id) return errorResult(`usage: prometheus tasks ${verb} <id>`);
  const store = loadSchedules(home);
  const existing = store[id];
  if (!existing) return errorResult(`no such scheduled task: ${id}`);
  const updated: agent.ScheduledTask = { ...existing, enabled };
  upsertTask(updated, home);
  return {
    lines: [`${c.green("✓")} ${verb}d ${id}`],
    json: { ok: true, id, enabled },
    exitCode: 0,
  };
}

export function handleEnable(args: string[], home: string): HandlerResult {
  return handleSetEnabled(args, home, true);
}

export function handleDisable(args: string[], home: string): HandlerResult {
  return handleSetEnabled(args, home, false);
}

/* ── run-due ──────────────────────────────────────────────────────────────── */

/** Injectable seam so a test can exercise the subcommand's wiring/rendering without ever
 *  touching the real `schedule-runner.ts` (which would spawn a real headless agent turn). */
export interface RunDueDeps {
  runDue?: typeof runDueSchedules;
}

export async function handleRunDue(
  home: string,
  write: (line: string) => void,
  deps: RunDueDeps = {},
): Promise<HandlerResult> {
  const runDue = deps.runDue ?? runDueSchedules;
  const { ran, skipped } = await runDue(home, { write });
  const lines = [`${ran.length} ran, ${skipped} skipped`];
  for (const t of ran) {
    const ok = t.lastResult?.ok ?? false;
    const summary = t.lastResult ? ` — ${t.lastResult.summary}` : "";
    lines.push(`  ${ok ? c.green("✓") : c.red("✗")} ${t.name}${summary}`);
  }
  return {
    lines,
    json: { ok: true, ranCount: ran.length, skipped, ran },
    exitCode: 0,
  };
}

/* ── install-cron ─────────────────────────────────────────────────────────── */

/**
 * `tasks install-cron` — PRINT the crontab line (this command never edits a crontab).
 *
 * The line names the node executable EXPLICITLY. It used to be just the script path and relied
 * on the shebang resolving `node` from PATH — but cron runs with a minimal PATH
 * (`/usr/bin:/bin` on macOS), where a Homebrew/nvm/volta node is not present. Measured:
 * `env -i PATH=/usr/bin:/bin <script> tasks run-due` exits **127** with
 * `env: node: No such file or directory`, so every scheduled run failed silently — the one
 * failure mode an unattended scheduler cannot report to anyone.
 *
 * `process.execPath` is the interpreter running THIS process, so the emitted line uses the
 * same node the user just ran the command with. A packaged binary has no separate script to
 * launch — there `argv[1]` is the binary itself and naming an interpreter would be wrong — so
 * that case still emits the single path.
 */
export function handleInstallCron(): HandlerResult {
  const script = process.argv[1];
  const node = process.execPath;
  // A SEA/packaged build reports the binary itself as argv[1]; a normal install runs a .js
  // script under an interpreter. Only the latter needs the interpreter spelled out.
  const packaged = !script || script === node || !/\.[cm]?js$/.test(script);
  const target = packaged ? (script ?? "prometheus") : `${node} ${script}`;
  const cronLine = `*/10 * * * * ${target} tasks run-due`;
  const lines = [
    "add this line to your crontab yourself (prometheus never edits it for you):",
    "",
    `  ${cronLine}`,
    "",
    "(the node path is spelled out because cron's PATH does not include it)",
    "run `crontab -e` to open your crontab, paste the line above, save, and exit.",
  ];
  return { lines, json: { ok: true, cronLine }, exitCode: 0 };
}

/* ── entry point ──────────────────────────────────────────────────────────── */

export async function runScheduleCommand(
  args: string[],
  opts: { home: string; json: boolean; write: (line: string) => void },
): Promise<{ exitCode: number }> {
  const sub = args[0];
  const rest = args.slice(1);

  let result: HandlerResult;
  switch (sub) {
    case "add":
      result = handleAdd(rest, opts.home);
      break;
    case "list":
      result = handleList(opts.home);
      break;
    case "remove":
      result = handleRemove(rest, opts.home);
      break;
    case "enable":
      result = handleEnable(rest, opts.home);
      break;
    case "disable":
      result = handleDisable(rest, opts.home);
      break;
    case "run-due":
      // Under --json, stdout must stay ONE clean object (CLI-084/CLI-085) — a running task's
      // live progress lines (and the turn's own reply/tool-call chatter) must never leak onto
      // the same sink the final JSON line is about to be written to.
      result = await handleRunDue(opts.home, opts.json ? () => {} : opts.write);
      break;
    case "install-cron":
      result = handleInstallCron();
      break;
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
 * The `prometheus tasks …` dispatcher entry point (index.ts's one-line registration, mirroring
 * `agents-cmd.ts`'s `runAgentsCommand(ctx)`). Reconstructs a raw flag/positional argv from the
 * already-parsed `ParsedArgs` — this subcommand set's own grammar (one bare subcommand token,
 * then either pure `--flag value` pairs (`add`) or exactly one further bare positional
 * (`remove`/`enable`/`disable`) — round-trips losslessly through `[...positionals, ...flagPairs]`.
 */
export async function runTasksCommand(ctx: CliContext): Promise<CommandOutcome> {
  const flagArgs = Object.entries(ctx.args.flags).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, value],
  );
  const rawArgs = [...ctx.args.positionals, ...flagArgs];

  const lines: string[] = [];
  let jsonPayload: CommandJsonEnvelope | undefined;
  const { exitCode } = await runScheduleCommand(rawArgs, {
    home: prometheusHome(),
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
