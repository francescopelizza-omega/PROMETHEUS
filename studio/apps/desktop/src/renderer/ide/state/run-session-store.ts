/**
 * ide/state/run-session-store.ts — the SHARED run-session state (APP-034).
 *
 * One store drives every Run surface (the DebugPanel Run-output section, the
 * editor-route Run toolbar, the ⌘⇧R picker): the live runId, the streamed
 * output tail, the exit/refusal state, and the live DAP session id (a debug
 * session is NOT a plain run — Stop must know both). All spawning goes through
 * the ONE gated `ide:run.start` path (APP-032: gate → guard → spawn in MAIN);
 * this store never decides "safe" (C5). Compound configs run their resolved
 * members SEQUENTIALLY — a kill cancels the rest of the queue.
 *
 * Renderer-SANDBOXED (C5): zustand + window.prometheus + the pure run-config
 * helpers. The event subscription is module-level and lazy (first use).
 */

import { create } from "zustand";

import type { IdeGateResult, IdeRunStartResult } from "../../../shared/ipc-contract.js";
import { type RunConfig, buildRunInvocation } from "./run-config.js";
import { type TaskConfig, parseTasksJson, planTaskRun, taskInvocation } from "./tasks-config.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

export interface RunSessionState {
  runId: string | null;
  /** what is running, for the toolbar/panel label ("cfg name" or the argv line). */
  runLabel: string | null;
  output: string;
  exit: { exitCode: number; killed: boolean } | null;
  error: string | null;
  /** the gate verdict when a start was refused by the gate (rendered by panels). */
  gate: IdeGateResult | null;
  /** the live DAP session (set by DebugPanel on launch/terminate). */
  dapSessionId: string | null;
  /** the workspace tasks.json (set by the loaders; consumed by run plans). */
  tasks: TaskConfig[];
  /** run a freeform argv (Run Anything) — same gated engine path. */
  startArgv(argv: string[], workspaceRoot: string): Promise<void>;
  /** run a NAMED config/compound with before-launch tasks (APP-035): the
   *  planTaskRun plan executes serially (parallel behind the compound's
   *  explicit flag); a failing pre-task ABORTS — the config never spawns. */
  startByName(name: string, configs: readonly RunConfig[], workspaceRoot: string): Promise<void>;
  /** run ONE tasks.json task through the gated engine (streams like a run). */
  runTask(task: TaskConfig, workspaceRoot: string): Promise<boolean>;
  /** run a serial task chain; false on the first nonzero exit (chain aborts). */
  runTaskChain(tasks: readonly TaskConfig[], workspaceRoot: string): Promise<boolean>;
  kill(): Promise<void>;
  setDapSession(sessionId: string | null): void;
  setTasks(tasks: TaskConfig[]): void;
  /** read `.vscode/tasks.json` from disk into the store (the before-launch source). */
  loadTasks(workspaceRoot: string): Promise<void>;
}

let eventsWired = false;
let queueSeq = 0; // bumping cancels a live compound queue
/** every live runId — parallel compound members stream into ONE tail. */
const liveRuns = new Set<string>();
/** per-run exit waiters (chaining awaits an exit EVENT, never a timer). */
const exitWaiters = new Map<string, (e: { exitCode: number; killed: boolean }) => void>();

function ensureRunEvents(): void {
  if (eventsWired) return;
  const api = ide();
  if (!api) return;
  eventsWired = true;
  api.onEvent((ev) => {
    if (ev.channel === "run.data" && liveRuns.has(ev.runId)) {
      // a tail view, not a log store — cap the buffer.
      const st = useRunSessionStore.getState();
      useRunSessionStore.setState({ output: (st.output + ev.data).slice(-16384) });
    } else if (ev.channel === "run.exit" && liveRuns.has(ev.runId)) {
      liveRuns.delete(ev.runId);
      exitWaiters.get(ev.runId)?.({ exitCode: ev.exitCode, killed: ev.killed });
      exitWaiters.delete(ev.runId);
      useRunSessionStore.setState({
        runId: liveRuns.values().next().value ?? null,
        ...(liveRuns.size === 0 ? { exit: { exitCode: ev.exitCode, killed: ev.killed } } : {}),
      });
    }
  });
}

/** Start ONE invocation; `await exit` resolves on its exit EVENT (chaining). */
async function startOne(
  label: string,
  req: { cmd: string; args: string[]; cwd: string; env: Record<string, string> },
  workspaceRoot: string,
  opts: { await?: boolean } = {},
): Promise<boolean> {
  const api = ide();
  if (!api) return false;
  ensureRunEvents();
  useRunSessionStore.setState({ runLabel: label, error: null, gate: null });
  const res: IdeRunStartResult = await api
    .runStart({ ...req, workspaceRoot })
    .catch((e: unknown) => ({
      ok: false,
      error: e instanceof Error ? e.message : "run ipc failed",
    }));
  if (!res.ok || !res.runId) {
    const stage =
      res.refusedBy === "gate"
        ? "run gate refused"
        : res.refusedBy === "guard"
          ? "resource guard refused"
          : "run failed";
    useRunSessionStore.setState({
      error: `${stage}: ${res.error ?? "unknown"}`,
      gate: res.gate ?? null,
    });
    return false;
  }
  const runId = res.runId;
  liveRuns.add(runId);
  useRunSessionStore.setState({ runId, exit: null });
  if (opts.await === false) return true; // background/watch task — never exits 0
  const exit = await new Promise<{ exitCode: number; killed: boolean }>((resolve) => {
    exitWaiters.set(runId, resolve);
  });
  return exit.exitCode === 0 && !exit.killed;
}

/** One compound member: its before-launch chain, then the config — a failing
 *  pre-task ABORTS the member (the config is NEVER spawned). */
async function runMember(
  member: { preTasks: TaskConfig[]; config: RunConfig },
  workspaceRoot: string,
  seq: number,
): Promise<boolean> {
  for (const task of member.preTasks) {
    if (queueSeq !== seq) return false;
    const ok = await useRunSessionStore.getState().runTask(task, workspaceRoot);
    if (!ok) {
      useRunSessionStore.setState({
        error: `pre-launch task "${task.label}" failed — "${member.config.name}" not launched`,
      });
      return false;
    }
  }
  if (queueSeq !== seq) return false;
  const inv = buildRunInvocation(member.config, workspaceRoot);
  if (typeof inv === "string") {
    useRunSessionStore.setState({ error: `${member.config.name}: ${inv}` });
    return false;
  }
  return startOne(
    member.config.name,
    { cmd: inv.cmd, args: inv.args, cwd: inv.cwd, env: inv.env },
    workspaceRoot,
  );
}

export const useRunSessionStore = create<RunSessionState>()((set, get) => ({
  runId: null,
  runLabel: null,
  output: "",
  exit: null,
  error: null,
  gate: null,
  dapSessionId: null,

  tasks: [],

  startByName: async (name, configs, workspaceRoot): Promise<void> => {
    if (get().runId !== null) return;
    const plan = planTaskRun(get().tasks, configs, name);
    if (typeof plan === "string") {
      set({ error: plan, output: "", exit: null, gate: null });
      return;
    }
    const seq = ++queueSeq;
    set({ output: "", exit: null, error: null, gate: null });
    if (plan.parallel) {
      // parallel: every member chain launches concurrently; one refusal does
      // NOT retroactively kill already-running siblings (kill() still does).
      await Promise.all(plan.members.map((m) => runMember(m, workspaceRoot, seq)));
      return;
    }
    for (const m of plan.members) {
      if (queueSeq !== seq) return;
      const ok = await runMember(m, workspaceRoot, seq);
      // serial: one member's refusal/failure stops the remainder.
      if (!ok || queueSeq !== seq) return;
    }
  },

  runTask: async (task, workspaceRoot): Promise<boolean> => {
    const inv = taskInvocation(task, workspaceRoot);
    if (inv === null) return true; // composite task — only its dependsOn ran
    return startOne(
      `task: ${task.label}`,
      { cmd: inv.cmd, args: inv.args, cwd: inv.cwd, env: {} },
      workspaceRoot,
      // a background/watch task never exits — start it, don't await (APP-035)
      { await: task.isBackground !== true },
    );
  },

  runTaskChain: async (tasks, workspaceRoot): Promise<boolean> => {
    for (const t of tasks) {
      const ok = await get().runTask(t, workspaceRoot);
      if (!ok) return false;
    }
    return true;
  },

  startArgv: async (argv, workspaceRoot): Promise<void> => {
    if (get().runId !== null || argv.length === 0 || argv[0] === undefined) return;
    queueSeq += 1;
    set({ output: "", exit: null, error: null, gate: null });
    await startOne(
      argv.join(" "),
      { cmd: argv[0], args: argv.slice(1), cwd: workspaceRoot, env: {} },
      workspaceRoot,
    );
  },

  kill: async (): Promise<void> => {
    queueSeq += 1; // cancel any compound queue
    const api = ide();
    for (const id of [...liveRuns]) await api?.runKill(id);
  },

  setDapSession: (sessionId): void => set({ dapSessionId: sessionId }),
  setTasks: (tasks): void => set({ tasks }),

  loadTasks: async (workspaceRoot): Promise<void> => {
    const api = ide();
    if (!api) return;
    const r = await api.fsRead(`file://${workspaceRoot}/.vscode/tasks.json`).catch(() => undefined);
    set({ tasks: r?.ok && typeof r.text === "string" ? parseTasksJson(r.text) : [] });
  },
}));
