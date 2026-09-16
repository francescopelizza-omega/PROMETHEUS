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

import { c } from "../render.js";
import { type CheckDeps, type CheckResult, checkUpdates } from "./check.js";
import { loadSettings } from "../home.js";

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
 */
export async function updatesStartupNotice(deps: UpdatesDeps): Promise<string> {
  const check = deps.check ?? checkUpdates;
  try {
    const { report } = await check({ ...baseCheckDeps(deps), force: false });
    const line = u.summarizeForStartup(report);
    return line ? c.yellow(line) : "";
  } catch {
    return ""; // never let an update check break startup
  }
}
