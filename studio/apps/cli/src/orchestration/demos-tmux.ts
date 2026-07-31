/**
 * orchestration/demos-tmux.ts — the tmux-MANDATORY /demos run (external RAM relay).
 *
 * Launches each agent's CLI INTERACTIVELY in its own tmux window (NOT headless `-p`),
 * starts the in-RAM bus relay over a unix socket, injects the hidden cooperation preamble
 * (+ the goal into the orchestrator), then runs the relay scheduler — which bridges the
 * windows: agents talk via `prom-msg` (out-of-band, into RAM) and the relay delivers peer
 * messages back with idle-gated send-keys. ToS-honest: the auth-gate warns/blocks driving a
 * subscription-auth agent. The user can `tmux attach` to watch + interact. Every machine
 * seam (tmux run / sleep / the scheduler) is injected, so the wiring is unit-testable; the
 * relay mechanism itself is proven by real-tmux.test.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type AiEndpoint, orchestration as orch } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import { authGateVerdict } from "./auth-gate.js";
import { startBusRelay } from "./bus-relay.js";
import { type RosterEntry, buildPreamble } from "./preamble.js";
import { installPromMsg } from "./prom-msg.js";
import { recipeFor } from "./recipes.js";
import { type TmuxRun, injectLine, makeTmuxRelay, makeTmuxRun } from "./tmux-driver.js";

type OrchestrationTopology = orch.OrchestrationTopology;
type AgentSpec = orch.AgentSpec;
type RelayResult = orch.RelayResult;

/** The INTERACTIVE launch command for an agent (bare CLI — never the headless `-p`). null = unsupported. */
export function interactiveCommand(agent: AgentSpec): string[] | null {
  const b = agent.backend;
  if (b.kind === "cli" && b.service) {
    const r = recipeFor(b.service);
    return [r ? r.bin : b.service]; // bare interactive launch
  }
  if (b.kind === "local" || b.kind === "engine-chat" || b.kind === "in-process") {
    return ["ollama", "run", b.model ?? "llama3"];
  }
  return null; // fake / unsupported in a tmux window
}

export interface DemosTmuxDeps {
  topology: OrchestrationTopology;
  goal: string;
  home: string;
  client?: EngineClient;
  endpoint?: AiEndpoint;
  write: (line: string) => void;
  confirm: (prompt: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** working directory each agent window starts in (tmux -c). Default: tmux's own. */
  cwd?: string;
  /** tmux runner (default: real). */
  run?: TmuxRun;
  sleep?: (ms: number) => Promise<void>;
  /** how long to wait for the CLIs to boot before injecting the preamble. */
  bootMs?: number;
  /** the scheduler (injected for tests; default the real relay loop). */
  runRelayFn?: typeof orch.runRelay;
  /** short run id (for the session/socket names). */
  runId?: string;
}

export interface DemosTmuxOutcome {
  ok: boolean;
  reason?: RelayResult["reason"] | "no-tmux" | "declined" | "unsupported";
  session?: string;
}

const roster = (t: OrchestrationTopology): RosterEntry[] =>
  t.agents.map((a) => ({ name: a.name, role: a.role }));

/** Run a /demos swarm in tmux with the external RAM relay. */
export async function runDemosTmux(deps: DemosTmuxDeps): Promise<DemosTmuxOutcome> {
  const run = deps.run ?? makeTmuxRun();
  const env = deps.env ?? process.env;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runRelayFn = deps.runRelayFn ?? orch.runRelay;

  // 1) tmux is mandatory.
  if (run(["-V"]).status !== 0) {
    deps.write("/demos needs tmux (each agent runs in its own window). Install tmux + retry.");
    return { ok: false, reason: "no-tmux" };
  }

  // 2) ToS auth gate — warn/confirm before driving a subscription-auth agent.
  const verdict = authGateVerdict(deps.topology, env);
  if (verdict.needsConfirm) {
    deps.write(verdict.message);
    const ok = await deps.confirm("Proceed anyway (your account, your risk)?");
    if (!ok) {
      deps.write(
        "Cancelled. Tip: give those agents an API key (e.g. ANTHROPIC_API_KEY) or use local models.",
      );
      return { ok: false, reason: "declined" };
    }
  }

  // 3) agents that can run interactively in a window (skip fake/unsupported).
  const launchable = deps.topology.agents.filter((a) => interactiveCommand(a) !== null);
  if (launchable.length === 0) {
    deps.write(
      "No agents in this swarm can run as an interactive CLI window. Configure cli/local backends.",
    );
    return { ok: false, reason: "unsupported" };
  }

  // 4) run scaffold: a run dir, the prom-msg helper, a SHORT socket path.
  const id = deps.runId ?? Math.random().toString(36).slice(2, 8);
  const runDir = join(deps.home, "orchestration", `run-${id}`);
  const binDir = join(runDir, "bin");
  mkdirSync(runDir, { recursive: true });
  const promMsg = installPromMsg(binDir);
  const sock = join(deps.home, "run", `bus-${id}.sock`); // short path (sun_path ≤ 104)
  const session = `prometheus-swarm-${id}`;

  // 5) the in-RAM bus + the socket relay.
  const bus = new orch.MessageBus({});
  const parentOf = (n: string): string | undefined => orch.parentOf(deps.topology, n);
  const relay = startBusRelay({
    bus,
    sockPath: sock,
    resolve: { orchestrator: deps.topology.orchestrator, parentOf },
    onError: (m) => deps.write(m),
  });

  // CLI-075: the env + command to RE-LAUNCH each agent's pane in place after a crash (respawn-pane).
  const relaunchArgv = new Map<string, string[]>();

  try {
    // 6) launch a window per agent, env-injected, running the bare interactive CLI.
    run(["kill-session", "-t", session]); // clear any stale
    launchable.forEach((a, i) => {
      const cmd = interactiveCommand(a) as string[];
      const e = [
        "-e",
        `PROM_BUS_SOCK=${sock}`,
        "-e",
        `PROM_AGENT=${a.name}`,
        "-e",
        `PROM_MSG_BIN=${promMsg}`,
        "-e",
        // no trailing `:` when PATH is empty — a trailing empty entry means "search the cwd",
        // an unwanted (mildly unsafe) lookup for the spawned agent.
        `PATH=${env.PATH ? `${binDir}:${env.PATH}` : binDir}`,
      ];
      const startDir = deps.cwd ? ["-c", deps.cwd] : [];
      const argv =
        i === 0
          ? ["new-session", "-d", "-s", session, "-n", a.name, ...startDir, ...e, ...cmd]
          : ["new-window", "-t", session, "-n", a.name, ...startDir, ...e, ...cmd];
      run(argv);
      // CLI-075: keep a crashed pane LISTED (with #{pane_dead}=1) so the relay can detect + respawn
      // it; default remain-on-exit=off would destroy the window on exit and hide the crash.
      run(["set-window-option", "-t", `${session}:${a.name}`, "remain-on-exit", "on"]);
      relaunchArgv.set(a.name, [...e, ...cmd]);
    });

    deps.write(
      `▣ swarm launched in tmux session "${session}" — attach to watch:  tmux attach -t ${session}`,
    );

    // 7) let the CLIs boot, then inject the hidden preamble (+ the goal into the orchestrator).
    await sleep(deps.bootMs ?? 4000);
    const team = roster(deps.topology);
    for (const a of launchable) {
      const isOrch = a.name === deps.topology.orchestrator;
      const preamble = buildPreamble({
        self: a.name,
        role: a.role,
        orchestrator: deps.topology.orchestrator,
        isOrchestrator: isOrch,
        roster: team,
        ...(isOrch ? { goal: deps.goal } : {}),
      });
      injectLine(run, session, a.name, preamble);
    }

    // 8) run the relay scheduler until the swarm completes / deadlocks / times out.
    const tmux = makeTmuxRelay({
      session,
      agents: launchable.map((a) => a.name),
      serviceOf: (name) => {
        const a = deps.topology.agents.find((x) => x.name === name);
        return a?.backend.kind === "cli" ? (a.backend.service ?? "generic") : "generic";
      },
      run,
      // CLI-075: re-launch a crashed pane in place with its original env + command.
      relaunch: (name) => relaunchArgv.get(name) ?? null,
    });
    const result = await runRelayFn({
      bus,
      topology: deps.topology,
      tmux,
      clock: { now: () => Date.now(), sleep },
      onEvent: (ev) => {
        if (ev.type === "deliver")
          deps.write(`  ↪ ${ev.from} → ${ev.agent}: ${ev.content.slice(0, 80)}`);
        else if (ev.type === "loop") deps.write(`  ⟲ loop ${ev.from}→${ev.to} (dropped)`);
        // CLI-075: surface crash/respawn/exclude so a degrading swarm is never silent.
        else if (ev.type === "respawn")
          deps.write(
            `  ↻ ${ev.agent} crashed — respawn attempt ${ev.attempt} ${ev.ok ? "✓ back" : "✗ failed"}`,
          );
        else if (ev.type === "excluded")
          deps.write(
            `  ✖ ${ev.agent} excluded after ${ev.attempts} failed respawn(s) — continuing`,
          );
        else if (ev.type === "undelivered")
          deps.write(`  ⚠ undelivered → ${ev.agent} (from ${ev.from}): ${ev.content.slice(0, 60)}`);
        else if (ev.type === "done") deps.write(`▣ swarm ${ev.reason}`);
      },
    });

    // 9) persist the full bus for transparency + replay.
    try {
      writeFileSync(join(runDir, "bus.jsonl"), bus.serialize());
    } catch {
      /* best-effort */
    }
    deps.write(
      `Swarm finished (${result.reason}) · ${result.delivered} messages relayed · log: ${join(runDir, "bus.jsonl")}`,
    );
    return { ok: result.reason === "complete", reason: result.reason, session };
  } finally {
    relay.close();
  }
}
