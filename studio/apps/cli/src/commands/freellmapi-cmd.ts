// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/freellmapi-cmd.ts — `prometheus freellmapi …`: the guided FreeLLMAPI procedure.
 *
 * FreeLLMAPI (github.com/tashfeenahmed/freellmapi) pools the free tiers of the providers whose
 * keys you give it behind one OpenAI-compatible /v1 on 127.0.0.1:3001. The ENGINE owns every
 * step that touches the machine (`prometheus.py freellmapi`): the strict nemesis gate — any
 * CRITICAL advisory refuses, with no --force and nothing remembered — the build with lifecycle
 * scripts off, the loopback-only start, and the RAM + advisory watch that stops and quarantines
 * it. This file adds the two things only the CLI can do:
 *
 *   - run those steps ON THIS TERMINAL from a one-shot `prometheus freellmapi setup`, so the
 *     gate's reasons and the build's progress print live (inside a session there is no terminal
 *     to hand over, so the engine's JSON result is rendered instead);
 *   - `connect`: read the gateway's own key from its local database (engine, machine channel)
 *     and store it under the `freellmapi` provider through the SAME verify-then-store path as
 *     `prometheus provider connect` — so the key is checked against /v1/models before the
 *     keychain is touched, and it is never printed.
 */
import {
  type EngineEnvelope,
  engineChildEnv,
  resolveEngine,
  runPrometheus,
} from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import { runOnThisTerminal } from "../pty/backend.js";
import { c } from "../render.js";
import { globalArgv } from "../toEngineArgv.js";
import { defaultProviderIo, runProviderConnect } from "./provider.js";

/** The engine's own action set (`p_fl.add_argument("action", choices=…)`) plus the CLI's connect. */
export const FREELLMAPI_ACTIONS: readonly string[] = Object.freeze([
  "status",
  "check",
  "setup",
  "install",
  "start",
  "stop",
  "connect",
  "uninstall",
  "help",
]);

// built per call: colour is decided after argv is parsed (--no-color, a pipe), not at import
const help = (): string =>
  [
    `${c.bold("prometheus freellmapi")} — the FreeLLMAPI free-tier gateway, on 127.0.0.1:3001`,
    "",
    `  ${c.bold("setup")}       guided: check → install (strict nemesis gate) → start → next steps`,
    `  ${c.bold("status")}      installed release, running/RAM vs cap, keys, quarantine`,
    `  ${c.bold("check")}       prerequisites: Node 20.18–24.x, git, disk, port 3001`,
    `  ${c.bold("install")}     fetch a release, gate it, build it (--ref TAG for another release)`,
    `  ${c.bold("start")} / ${c.bold("stop")}  run it under the RAM + advisory watch / stop it`,
    `  ${c.bold("connect")}     store the gateway's key for Prometheus (verified first)`,
    `  ${c.bold("uninstall")}   remove it (--keep-data keeps its database and provider keys)`,
    "",
    c.dim(
      "Any CRITICAL advisory in a release refuses the install, every time it is attempted; there",
    ),
    c.dim(
      "is nothing to override. Prompts sent through it leave this machine: Prometheus treats it",
    ),
    c.dim("as a cloud endpoint, so a never-send-to-cloud policy blocks it."),
  ].join("\n");

export interface FreellmapiDeps {
  /** `prometheus.py --json <argv>` → its one JSON envelope (the bridge adds `--json`). */
  engineJson: (argv: string[]) => Promise<EngineEnvelope>;
  /** `prometheus.py <argv>` with this terminal as its stdio → exit code. */
  engineOnTerminal: (argv: string[]) => Promise<number>;
  /** a one-shot run with a human at a real terminal (never inside a session) */
  interactive: boolean;
  /** store a verified gateway key under the `freellmapi` provider */
  connect: (ctx: CliContext, key: string) => Promise<CommandOutcome>;
}

export function defaultFreellmapiDeps(oneShot: boolean): FreellmapiDeps {
  return {
    engineJson: async (argv) =>
      (await runPrometheus(argv, { timeoutMs: 1_800_000 })) as EngineEnvelope,
    engineOnTerminal: async (argv) => {
      const eng = resolveEngine();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(engineChildEnv())) if (v !== undefined) env[k] = v;
      const res = await runOnThisTerminal({
        shell: eng.pythonBin,
        args: [eng.prometheusPy, ...argv],
        cwd: process.cwd(),
        env,
      });
      return res.exitCode;
    },
    interactive: oneShot && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    connect: (ctx, key) =>
      runProviderConnect(
        { ...ctx, args: { ...ctx.args, positionals: ["freellmapi"] } },
        { ...defaultProviderIo(), readKey: async () => key },
      ),
  };
}

function actionOf(ctx: CliContext): string {
  return ctx.args.command[1] ?? ctx.args.positionals[0] ?? "status";
}

function forwardedFlags(ctx: CliContext): string[] {
  const out: string[] = [];
  const ref = ctx.args.flags.ref;
  if (typeof ref === "string" && ref) out.push("--ref", ref);
  if (ctx.args.flags["keep-data"] !== undefined) out.push("--keep-data");
  return out;
}

/** Render the engine's freellmapi envelope for a session (no live terminal to hand over). */
export function renderFreellmapiEnvelope(env: EngineEnvelope): string {
  const e = env as Record<string, unknown>;
  const lines: string[] = [];
  const gate = (e.gate ?? (e as { start?: { gate?: unknown } }).start?.gate) as
    | { verdict?: string; why?: string; critical?: string[]; high?: string[] }
    | undefined;
  if (gate?.verdict)
    lines.push(`nemesis ${String(gate.verdict).toUpperCase()} — ${gate.why ?? ""}`);
  for (const crit of gate?.critical ?? []) lines.push(`  ${c.red("CRITICAL")} ${crit}`);
  for (const high of (gate?.high ?? []).slice(0, 5)) lines.push(`  ${c.yellow("HIGH")} ${high}`);
  const st = e.status as Record<string, unknown> | undefined;
  if (st) {
    lines.push(
      st.installed
        ? `installed ${String(st.ref ?? "?")} · ${st.running ? `running, ${String(st.rss_mb)} MB of a ${String(st.ram_cap_mb)} MB cap` : "stopped"}`
        : "not installed — /freellmapi setup",
    );
    const q = st.quarantined as { reason?: string; at?: string } | null | undefined;
    if (q) lines.push(c.red(`QUARANTINED since ${q.at ?? "?"}: ${q.reason ?? ""}`));
    const keys = st.keys as { anonymous?: string[]; several_keys?: string[] } | undefined;
    if (keys?.anonymous?.length)
      lines.push(
        c.yellow(
          `anonymous rows on (${keys.anonymous.join(", ")}) — prompts route with no account`,
        ),
      );
    if (keys?.several_keys?.length)
      lines.push(
        c.yellow(`several keys for ${keys.several_keys.join(", ")} — one account per provider`),
      );
  }
  if (typeof e.error === "string" && e.error) lines.push(c.red(e.error));
  const start = e.start as { error?: string; url?: string; ok?: boolean } | undefined;
  if (start?.ok && start.url)
    lines.push(c.green(`running on ${start.url} (loopback only, RAM-watched)`));
  if (start && start.ok === false && start.error) lines.push(c.red(`not started — ${start.error}`));
  for (const n of (e.next as string[] | undefined) ?? []) lines.push(`  ${n}`);
  if (lines.length === 0)
    lines.push(`freellmapi ${String(e.action ?? "")}: ${e.ok === false ? "failed" : "ok"}`);
  return lines.join("\n");
}

export async function runFreellmapiCommand(
  ctx: CliContext,
  deps: FreellmapiDeps = defaultFreellmapiDeps(true),
): Promise<CommandOutcome> {
  const action = actionOf(ctx);
  if (action === "help") return { text: help(), json: { ok: true }, exitCode: 0 };
  if (!FREELLMAPI_ACTIONS.includes(action)) {
    return {
      text: c.red(
        `prometheus freellmapi ${action}: unknown verb — try: prometheus freellmapi help`,
      ),
      json: { ok: false, error: "unknown-verb", action },
      exitCode: 1,
    };
  }

  if (action === "connect") {
    const env = (await deps.engineJson(["freellmapi", "key"])) as EngineEnvelope & {
      key?: unknown;
    };
    const key = typeof env.key === "string" ? env.key : "";
    if (!key) {
      const why = typeof env.error === "string" ? env.error : "no gateway key found";
      return {
        text: c.red(`${why} — run \`prometheus freellmapi setup\` first`),
        json: { ok: false, error: "no-gateway-key" },
        exitCode: 2,
      };
    }
    const out = await deps.connect(ctx, key);
    if (out.exitCode !== 0) return out;
    return {
      ...out,
      text: `${out.text ?? ""}\n  ${c.dim("pick it: /models → FreeLLMAPI → auto — it routes each request to a healthy free model")}`,
    };
  }

  const argv = [...globalArgv(ctx.args), "freellmapi", action, ...forwardedFlags(ctx)];
  if (deps.interactive && !ctx.json) {
    const code = await deps.engineOnTerminal(argv);
    return { text: "", json: { ok: code === 0, action }, exitCode: code === 0 ? 0 : 2 };
  }
  // the gateway key travels only on `connect`'s own channel above — never out of this one
  const { key: _never, ...env } = (await deps.engineJson(argv)) as EngineEnvelope & {
    key?: unknown;
  };
  return {
    text: renderFreellmapiEnvelope(env),
    json: env,
    exitCode: env.ok === false ? 2 : 0,
  };
}
