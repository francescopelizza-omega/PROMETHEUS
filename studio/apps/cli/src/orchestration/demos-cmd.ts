// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/demos-cmd.ts — the `/demos` command: setup ↔ run ↔ status.
 *
 * Ties the pure engine (core `orchestration`) to the live backends + the TUI. Loads/saves
 * the swarm topology under ~/.prometheus/orchestration/, runs the wizard on first use,
 * then drives a Coordinator over the real BackendInvoker — streaming events to the view
 * and persisting the full message bus (JSONL) for transparency + replay. The only IO is
 * fs + the injected SlashCtx seams; the orchestration logic stays in the tested core.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { type AiEndpoint, orchestration as orch } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import { createCliSecretsStore } from "../secrets-backend.js";
import type { ColorCaps } from "../tui/palette.js";
import { type GateFn, makeInvoker, probeLaunch } from "./backends.js";
import { LiveBoard, initBoard } from "./demos-status-board.js";
import { runDemosTmux } from "./demos-tmux.js";
import {
  renderBoard,
  renderEvent,
  renderMessage,
  renderRunHeader,
  renderRunSummary,
} from "./demos-view.js";
import {
  type CliStatus,
  classifyReadiness,
  detectClis,
  readinessLine,
  runDemosWizard,
} from "./demos-wizard.js";
import { CLI_RECIPES, RECIPE_SERVICES, requirementsFor } from "./recipes.js";

type OrchestrationTopology = orch.OrchestrationTopology;
type Message = orch.Message;
const { Coordinator, MessageBus, parseBusJsonl, validateTopology } = orch;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The seams the host (SlashCtx) injects. */
export interface DemosDeps {
  client: EngineClient;
  endpoint?: AiEndpoint;
  home: string;
  cwd?: string;
  caps: ColorCaps;
  write: (line: string) => void;
  ask: (prompt: string) => Promise<string>;
  confirm: (prompt: string) => Promise<boolean>;
  /** detected local model ids (the host knows them from backend detection). */
  localModels?: () => Promise<string[]>;
  /** ISO timestamp source (injected for deterministic tests). */
  now?: () => Date;
  /** CLI-detection seam (CLI-071 preflight/probe) — injected in tests to avoid real spawns; default
   *  = the real `detectClis` (probes every vendor CLI on PATH). */
  detect?: () => Promise<CliStatus[]>;
  /** live-watch seams (CLI-074) — injected in tests to drive the board deterministically without a
   *  live subprocess. `poll` returns the current liveness (null ⇒ no run in progress → static view);
   *  `maxTicks` bounds the loop (live mode loops until Ctrl+C); `intervalMs` paces the poll. */
  watch?: {
    poll?: () => Promise<{ live: string[]; roster: string[] } | null>;
    maxTicks?: number;
    intervalMs?: number;
  };
}

const TOPOLOGY_FILE = "topology.json";

/** Every binary a recipe may launch — the gate allowlist (defense in depth). */
const RECIPE_BINS = new Set<string>(
  Object.values(CLI_RECIPES).flatMap((r) => [r.bin, ...(r.binFallbacks ?? [])]),
);

/** The nemesis gate for CLI launches: only known agent-CLI bins, never --force. */
const recipeGate: GateFn = async (bin, args) => {
  if (!RECIPE_BINS.has(bin)) return { ok: false, reason: `"${bin}" is not a known agent CLI` };
  if (args.some((a) => a === "--force" || a === "--force-unsafe"))
    return { ok: false, reason: "--force is human-only" };
  return { ok: true };
};

function orchDir(home: string): string {
  return join(home, "orchestration");
}

/** Load the saved topology, or null if none / unreadable. */
export function loadTopology(home: string): OrchestrationTopology | null {
  try {
    const raw = readFileSync(join(orchDir(home), TOPOLOGY_FILE), "utf8");
    return orch.normalizeTopology(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persist the topology (creates the dir). */
export function saveTopology(home: string, t: OrchestrationTopology): void {
  const dir = orchDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TOPOLOGY_FILE), `${JSON.stringify(t, null, 2)}\n`);
}

/** Run the setup wizard + persist; returns the saved topology or null. */
async function setup(deps: DemosDeps): Promise<OrchestrationTopology | null> {
  const topo = await runDemosWizard({
    write: deps.write,
    ask: deps.ask,
    confirm: deps.confirm,
    detect: () => detectClis(),
    localModels: deps.localModels ?? (async () => []),
  });
  if (!topo) {
    deps.write("Setup cancelled — no swarm saved.");
    return null;
  }
  saveTopology(deps.home, topo);
  deps.write("✓ swarm saved to ~/.prometheus/orchestration/topology.json");
  return topo;
}

/** Drive the swarm over the real backends; stream events + persist the bus. */
async function runSwarm(topo: OrchestrationTopology, goal: string, deps: DemosDeps): Promise<void> {
  const v = validateTopology(topo);
  if (!v.ok) {
    deps.write(
      `Swarm topology is invalid:\n  ${v.errors.join("\n  ")}\nRun /demos setup to fix it.`,
    );
    return;
  }
  const invoke = makeInvoker({
    client: deps.client,
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
    gate: recipeGate,
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    // keychain-first API-key resolution (CLI-028): env still wins; keychain is the fallback.
    secretsGet: (service, account) => createCliSecretsStore().get(service, account),
  });
  const bus = new MessageBus();
  // CLI-074: the FIRST real caller of MessageBus.subscribe() — a live participant board folds every
  // posted message into per-agent state as the swarm works; disposed after the run (no leak).
  const board = new LiveBoard(
    topo.agents.map((a) => a.name),
    deps.now ? () => (deps.now as () => Date)().getTime() : undefined,
  );
  const disposeBoard = board.attach(bus);
  const coordinator = new Coordinator({
    topology: topo,
    invoke,
    bus,
    onEvent: (e) => {
      const line = renderEvent(e, deps.caps);
      if (line) deps.write(line);
    },
  });

  deps.write(renderRunHeader(topo, goal, deps.caps));
  let result: orch.RunResult;
  try {
    result = await coordinator.run(goal);
  } catch (err) {
    disposeBoard();
    deps.write(`swarm error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  disposeBoard();
  // persist the full bus for transparency + replay.
  try {
    const runsDir = join(orchDir(deps.home), "runs");
    mkdirSync(runsDir, { recursive: true });
    const stamp = (deps.now ? deps.now() : new Date()).toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(runsDir, `run-${stamp}.jsonl`), bus.serialize());
  } catch {
    /* persistence is best-effort */
  }
  // the last-known participant board (CLI-074) — who did what, final state.
  deps.write("Participants:");
  deps.write(renderBoard(board.snapshot(), board.order(), deps.caps));
  deps.write(renderRunSummary(result, deps.caps));
}

/**
 * Live participant watch (CLI-074). Polls the current liveness (bus/tmux — injected via `deps.watch`
 * or, in production, no live run is attachable from a separate command, so it falls back to a static
 * board + note). Each tick folds the snapshot into the board and redraws it; Ctrl+C stops cleanly
 * and prints the last-known board as a final summary — never a half-drawn frame.
 */
async function watchStatus(topo: OrchestrationTopology, deps: DemosDeps): Promise<void> {
  const ids = topo.agents.map((a) => a.name);
  // production has no background run to attach to (a run blocks the REPL) → poll defaults to "no run".
  const poll = deps.watch?.poll ?? (async () => null);
  const first = await poll();
  if (!first) {
    deps.write(
      "No run in progress — showing configured participants (live state streams during a run):",
    );
    deps.write(renderBoard(initBoard(ids), ids, deps.caps));
    return;
  }
  const board = new LiveBoard(
    ids,
    deps.now ? () => (deps.now as () => Date)().getTime() : undefined,
  );
  const maxTicks = deps.watch?.maxTicks ?? Number.POSITIVE_INFINITY;
  const intervalMs = deps.watch?.intervalMs ?? 400;
  let stopped = false;
  const onSig = (): void => {
    stopped = true;
  };
  process.once("SIGINT", onSig);
  deps.write("Live swarm participants (Ctrl+C to stop):");
  try {
    let snap: { live: string[]; roster: string[] } | null = first;
    let t = 0;
    while (snap && !stopped && t < maxTicks) {
      board.applyLiveness(snap.live, snap.roster);
      deps.write(renderBoard(board.snapshot(), board.order(), deps.caps));
      t++;
      if (stopped || t >= maxTicks) break;
      if (intervalMs > 0) await sleep(intervalMs);
      snap = await poll();
    }
  } finally {
    process.removeListener("SIGINT", onSig);
    // clean exit: the last-known board as a static final summary (never a partial frame).
    deps.write("── final participant board ──");
    deps.write(renderBoard(board.snapshot(), board.order(), deps.caps));
  }
}

/** Show the saved swarm + the detected backend readiness (static), or the live board with --watch. */
async function showStatus(deps: DemosDeps, watch = false): Promise<void> {
  const topo = loadTopology(deps.home);
  if (!topo) {
    deps.write("No swarm configured. Run /demos setup.");
    return;
  }
  if (watch) {
    await watchStatus(topo, deps);
    return;
  }
  deps.write(`Swarm (orchestrator: ${topo.orchestrator}, ${topo.agents.length} agents):`);
  for (const a of topo.agents) {
    const tag =
      a.backend.kind === "cli"
        ? a.backend.service
        : a.backend.kind === "api"
          ? `api:${a.backend.service ?? "?"}`
          : `${a.backend.kind}:${a.backend.model ?? "?"}`;
    deps.write(
      `  ${a.name === topo.orchestrator ? "★" : "•"} ${a.name} [${tag}] — ${a.role}${a.children?.length ? ` → ${a.children.join(", ")}` : ""}`,
    );
  }
  const statuses: CliStatus[] = await detectClis();
  const ready = statuses.filter((s) => s.installed && s.authed).map((s) => s.service);
  deps.write(`\nReady CLIs: ${ready.length ? ready.join(", ") : "none (using local/fake)"}`);
}

/**
 * `/demos probe` — show the EXACT standalone command each agent's CLI will run + its
 * readiness, so the user can confirm Prometheus invokes claude/codex/gemini precisely
 * as they would themselves (no patching of the vendor CLI's own mechanics).
 */
async function showProbe(deps: DemosDeps): Promise<void> {
  const topo = loadTopology(deps.home);
  if (!topo) {
    deps.write("No swarm configured. Run /demos setup.");
    return;
  }
  deps.write(
    "Each agent runs its CLI EXACTLY as standalone — Prometheus never patches the vendor software:\n",
  );
  const byService = new Map((await (deps.detect ?? detectClis)()).map((s) => [s.service, s]));
  for (const a of topo.agents) {
    const p = probeLaunch(a);
    deps.write(`  ${a.name === topo.orchestrator ? "★" : "•"} ${a.name} [${p.kind}]`);
    deps.write(`      $ ${p.command}`);
    // CLI-071: a precise cause + remedy per backend (a bad key and a missing binary no longer read
    // the same). Only for cli backends we have a status for.
    if (a.backend.kind === "cli" && a.backend.service) {
      const s = byService.get(a.backend.service);
      if (s) {
        const r = classifyReadiness(s, requirementsFor(a.backend.service));
        deps.write(`      ${readinessLine(a.backend.service, r)}`);
      }
    }
  }
  deps.write(
    "\nThe prompt + the inter-agent context are passed as the CLI's own prompt argument; stdout is captured. Auth/billing stay with each vendor CLI.",
  );
}

/**
 * `/demos providers` — list the paid OpenAI-compatible API providers a subagent can bind to
 * (kind:"api", own-key automation), marking which already have a key in the environment. These
 * are added to a swarm via the spec editor, e.g. `coder = together : write code` or
 * `fast = groq:llama-3.3-70b-versatile : quick tasks`.
 */
function showApiProviders(deps: DemosDeps): void {
  const env = process.env;
  deps.write(
    "API providers (own-key, OpenAI-compatible) — add to a swarm as `name = <id> : role` in /demos setup:\n",
  );
  for (const p of orch.API_PROVIDERS) {
    const keyName = p.apiKeyEnv.find((n) => (env[n] ?? "") !== "");
    const ready = keyName ? "✓ key set" : `○ set ${p.apiKeyEnv[0]}`;
    const flag = p.automation === "verify-at-setup" ? " · verify ToS at setup" : "";
    const region = p.dataRegion && p.dataRegion !== "US" ? ` · data:${p.dataRegion}` : "";
    deps.write(`  • ${p.id}  [${ready}]  ${p.label}${flag}${region}`);
    deps.write(`      ${p.baseUrl}  · model ${p.defaultModel}  · ${p.tosUrl}`);
  }
  deps.write(
    "\nThese run via the in-process orchestrator (Coordinator) — drive them with `/demos --headless <goal>`.\nOwn-key commercial APIs: automation is within terms; never share/resell a key.",
  );
}

/** One machine-readable recipe row for `/demos recipes --json` (stable shape). */
interface RecipeRow {
  name: string;
  bin: string;
  authMode: string;
  envVar: string | null;
  guards: readonly string[];
  install: string | null;
}

/** `/demos recipes [--json]` (CLI-071) — every recipe + its OFFLINE requirements. `--json` is
 *  stdout-only, zero ANSI, one JSON array + trailing newline (jq-friendly); never probes. */
function showRecipes(deps: DemosDeps, json: boolean): void {
  const rows: RecipeRow[] = RECIPE_SERVICES.map((service) => {
    const req = requirementsFor(service);
    return {
      name: service,
      bin: req?.bin ?? CLI_RECIPES[service]?.bin ?? service,
      authMode: req?.authMode ?? "none",
      envVar: req?.envVar ?? null,
      guards: req?.guards ?? [],
      install: req?.install ?? null,
    };
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`); // raw sink → no colorizer, no chatter
    return;
  }
  deps.write("Recipes (backend requirements):");
  for (const r of rows) {
    const auth =
      r.authMode === "env-key"
        ? `env $${r.envVar ?? "?"}`
        : r.authMode === "cli-login"
          ? "cli login"
          : "none";
    const guards = r.guards.length > 0 ? ` · guards: ${r.guards.join(" ")}` : "";
    deps.write(`  • ${r.name.padEnd(10)} bin:${r.bin.padEnd(14)} auth:${auth}${guards}`);
  }
}

/**
 * Preflight (CLI-071): classify each cli node's backend readiness (OFFLINE); return blocker lines
 * for any not-ready node. Empty ⇒ everything ready (the caller stays silent → happy path unchanged).
 */
async function preflight(topo: OrchestrationTopology, deps: DemosDeps): Promise<string[]> {
  void deps;
  const byService = new Map((await (deps.detect ?? detectClis)()).map((s) => [s.service, s]));
  const blockers: string[] = [];
  for (const a of topo.agents) {
    if (a.backend.kind === "cli" && a.backend.service) {
      const s = byService.get(a.backend.service);
      if (!s) continue; // no recipe for this service → falls back to local/fake, not a blocker
      const r = classifyReadiness(s, requirementsFor(a.backend.service));
      if (!r.ready) blockers.push(`${a.name}: ${readinessLine(a.backend.service, r)}`);
    }
  }
  return blockers;
}

/**
 * Resolve a `/demos replay` target to a JSONL file (CLI-073). A bare run-id probes BOTH persisted
 * layouts — headless `runs/run-<id>.jsonl` and tmux `run-<id>/bus.jsonl` — under the orchestration
 * dir; an explicit path (a separator / absolute / *.jsonl) is used as-is. A bare id is guarded
 * against path traversal so it can never escape the runs dir.
 */
function resolveRunFile(home: string, token: string): { path: string } | { error: string } {
  const looksLikePath =
    token.includes("/") || token.includes("\\") || isAbsolute(token) || token.endsWith(".jsonl");
  if (looksLikePath) {
    return existsSync(token) ? { path: token } : { error: `run log not found: ${token}` };
  }
  if (token.includes("..") || token.length === 0) return { error: `invalid run id: "${token}"` };
  const o = orchDir(home);
  const candidates = [
    join(o, "runs", `run-${token}.jsonl`),
    join(o, "runs", `${token}.jsonl`),
    join(o, `run-${token}`, "bus.jsonl"),
    join(o, token, "bus.jsonl"),
  ];
  const found = candidates.find((p) => existsSync(p));
  return found
    ? { path: found }
    : { error: `no run log for id "${token}" — tried:\n  ${candidates.join("\n  ")}` };
}

/**
 * `/demos replay <run-id|path> [--json] [--speed <n> | --instant]` (CLI-073) — re-render a saved
 * swarm run from its persisted bus JSONL through the SAME demos-view projector a live run uses.
 * READ-ONLY: it never re-invokes a backend, re-spawns tmux, or re-triggers a gate. Fails CLOSED on
 * a corrupt/truncated log (naming the bad line) — never a silent partial replay. `--json` emits the
 * full deserialized message array (stdout, zero ANSI); paced mode (`--speed n`) honors the original
 * inter-event timing (each gap clamped ≤2s), instant is the default.
 */
async function replayRun(rest: string, deps: DemosDeps): Promise<void> {
  const args = rest.trim().split(/\s+/).filter(Boolean).slice(1); // drop the "replay" subcommand token
  const json = args.includes("--json");
  const instant = args.includes("--instant");
  const speedIdx = args.indexOf("--speed");
  const speed = speedIdx >= 0 ? Number(args[speedIdx + 1]) : Number.NaN;
  const paced = !instant && !json && Number.isFinite(speed) && speed > 0;
  // the target = first non-flag token that isn't the --speed value.
  const skip = speedIdx >= 0 ? new Set([speedIdx, speedIdx + 1]) : new Set<number>();
  const target = args.find((a, i) => !a.startsWith("--") && !skip.has(i));
  if (!target) {
    deps.write("Usage: /demos replay <run-id|path> [--json] [--speed <n> | --instant]");
    return;
  }
  const res = resolveRunFile(deps.home, target);
  if ("error" in res) {
    deps.write(res.error);
    return;
  }
  let messages: Message[];
  try {
    messages = parseBusJsonl(readFileSync(res.path, "utf8"));
  } catch (err) {
    // fail closed: a truncated/garbled run is NEVER rendered as a complete replay.
    deps.write(`Replay aborted — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(messages)}\n`); // raw sink → zero ANSI, jq-friendly
    return;
  }
  deps.write(
    `▣ replaying ${target} — ${messages.length} message${messages.length === 1 ? "" : "s"}`,
  );
  let prevTs: number | undefined;
  for (const m of messages) {
    if (paced && prevTs !== undefined) {
      const gap = Math.min(2000, Math.max(0, m.ts - prevTs)) / speed; // clamp skew/idle to ≤2s
      if (gap > 0) await sleep(gap);
    }
    prevTs = m.ts;
    deps.write(renderMessage(m, deps.caps));
  }
}

/**
 * The `/demos` entrypoint. `rest` is the goal, or a subcommand:
 *   /demos                 → run setup if unconfigured, else show usage
 *   /demos setup           → (re)configure the swarm
 *   /demos status          → show the swarm + backend readiness
 *   /demos providers       → list the own-key API providers a subagent can use
 *   /demos replay <id>     → re-render a saved run's persisted bus log (read-only)
 *   /demos reset           → delete the saved swarm
 *   /demos <goal…>         → run the swarm on the goal
 */
export async function runDemos(rest: string, deps: DemosDeps): Promise<void> {
  const arg = rest.trim();
  const head = arg.split(/\s+/)[0]?.toLowerCase();

  if (head === "setup" || head === "config") {
    await setup(deps);
    return;
  }
  if (head === "status" || head === "show") {
    await showStatus(deps, /(^|\s)--watch(\s|$)/.test(arg));
    return;
  }
  if (head === "probe" || head === "verify") {
    await showProbe(deps);
    return;
  }
  if (head === "providers" || head === "apis" || head === "api") {
    showApiProviders(deps);
    return;
  }
  if (head === "recipes" || head === "recipe") {
    showRecipes(deps, /(^|\s)--json(\s|$)/.test(arg));
    return;
  }
  if (head === "replay") {
    await replayRun(arg, deps);
    return;
  }
  if (head === "reset") {
    try {
      rmSync(join(orchDir(deps.home), TOPOLOGY_FILE));
      deps.write("Swarm reset — run /demos setup to configure a new one.");
    } catch {
      deps.write("No swarm to reset.");
    }
    return;
  }

  let topo = loadTopology(deps.home);
  if (!topo) {
    // distinguish "never configured" from "configured but the file is corrupt".
    const exists = existsSync(join(orchDir(deps.home), TOPOLOGY_FILE));
    deps.write(
      exists
        ? "⚠ the saved swarm is unreadable (corrupt topology.json) — let's reconfigure.\n"
        : "No swarm configured yet — let's set one up.\n",
    );
    topo = await setup(deps);
    if (!topo) return;
    if (!arg) {
      deps.write("\nSwarm ready. Run `/demos <goal>` to put it to work.");
      return;
    }
  }
  if (!arg) {
    deps.write(
      "Usage: /demos <goal>   (or: /demos setup · status · probe · providers · recipes · replay · reset)",
    );
    return;
  }
  // Preflight (CLI-071): a node whose backend is missing/unauthed BLOCKS the spawn with a remedy
  // rather than launching into a cryptic failure. Silent when everything is ready (happy path
  // unchanged) — only prints when there is ≥1 blocker.
  const blockers = await preflight(topo, deps);
  if (blockers.length > 0) {
    deps.write(
      "Preflight — these backends aren't ready (fix, or edit the swarm with /demos setup):",
    );
    for (const b of blockers) deps.write(`  ${b}`);
    return;
  }
  // DEFAULT = tmux mode: each agent in its own window, talking via the external RAM relay
  // (ToS-honest). `--headless` opts into the in-process Coordinator (API-key / CI automation).
  if (/^--headless\b/.test(arg)) {
    await runSwarm(topo, arg.replace(/^--headless\b\s*/, ""), deps);
    return;
  }
  await runDemosTmux({
    topology: topo,
    goal: arg,
    home: deps.home,
    client: deps.client,
    ...(deps.endpoint ? { endpoint: deps.endpoint } : {}),
    write: deps.write,
    confirm: deps.confirm,
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
  });
}
