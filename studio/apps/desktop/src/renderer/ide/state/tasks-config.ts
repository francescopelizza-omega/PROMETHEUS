/**
 * ide/state/tasks-config.ts — the PURE tasks.json model (plan file 13/22 · VS Code Tasks
 * · JetBrains "npm/External Tool" parity).
 *
 * Parses `.vscode/tasks.json` (JSONC, via the shared run-config parser) into a typed
 * `TaskConfig[]`, builds the shell command line for a task (arg-quoted), and resolves a
 * group's default task (Run Build Task ⌘⇧B / Run Test Task). Pure (no react/engine) →
 * node:test-ed. EXECUTION is deliberately NOT here: a task runs through the gated
 * terminal launcher (nemesis-checked spawn), which the panel wires separately.
 */

import {
  type RunConfig,
  type SubstitutionContext,
  parseJsonc,
  resolveRunOrder,
  substituteVars,
} from "./run-config.js";

export type TaskGroup = "build" | "test" | "none";

export interface TaskConfig {
  label: string;
  type: "shell" | "process";
  /** "" for a composite task (dependsOn only, nothing of its own to spawn). */
  command: string;
  args: string[];
  group: TaskGroup;
  /** the default task within its group (⌘⇧B runs the default build task). */
  isDefault: boolean;
  cwd?: string;
  /** task labels this task depends on (VS Code dependsOn — a SECOND ordering
   *  graph distinct from compound run configs; cycle-guarded in expandTask). */
  dependsOn?: string[];
  /** a watch/background task never exits — the chain must not await it. */
  isBackground?: boolean;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Normalize the `group` field (string form OR { kind, isDefault } object). */
function readGroup(g: unknown): { group: TaskGroup; isDefault: boolean } {
  const kindOf = (k: unknown): TaskGroup => (k === "build" || k === "test" ? k : "none");
  if (typeof g === "string") return { group: kindOf(g), isDefault: false };
  if (g && typeof g === "object") {
    const o = g as Record<string, unknown>;
    return { group: kindOf(o.kind), isDefault: o.isDefault === true };
  }
  return { group: "none", isDefault: false };
}

/** tasks.json args may be `{value, quoting}` objects, not just strings —
 *  coerce the object form or the argv would carry "[object Object]". */
function coerceArg(a: unknown): string | null {
  if (typeof a === "string") return a;
  if (a && typeof a === "object" && typeof (a as Record<string, unknown>).value === "string") {
    return (a as Record<string, unknown>).value as string;
  }
  return null;
}

function coerceTask(o: Record<string, unknown>): TaskConfig | null {
  const label = asStr(o.label) ?? asStr(o.taskName);
  const command = asStr(o.command);
  const dependsOn =
    typeof o.dependsOn === "string"
      ? [o.dependsOn]
      : Array.isArray(o.dependsOn)
        ? o.dependsOn.filter((d): d is string => typeof d === "string")
        : undefined;
  // a composite task (dependsOn, no command of its own) is legal in VS Code
  if (!label || (!command && (!dependsOn || dependsOn.length === 0))) return null;
  const { group, isDefault } = readGroup(o.group);
  const task: TaskConfig = {
    label,
    type: o.type === "process" ? "process" : "shell",
    command: command ?? "",
    args: Array.isArray(o.args) ? o.args.map(coerceArg).filter((a): a is string => a !== null) : [],
    group,
    isDefault,
  };
  const cwd =
    o.options && typeof o.options === "object"
      ? asStr((o.options as Record<string, unknown>).cwd)
      : undefined;
  if (cwd) task.cwd = cwd;
  if (dependsOn && dependsOn.length > 0) task.dependsOn = dependsOn;
  if (o.isBackground === true) task.isBackground = true;
  return task;
}

/** Parse a tasks.json blob → TaskConfig[] (malformed entries dropped; [] on garbage). */
export function parseTasksJson(text: string): TaskConfig[] {
  const doc = parseJsonc(text);
  const raw = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object" && Array.isArray((doc as Record<string, unknown>).tasks)
      ? ((doc as Record<string, unknown>).tasks as unknown[])
      : [];
  const out: TaskConfig[] = [];
  for (const t of raw) {
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const task = coerceTask(t as Record<string, unknown>);
      if (task) out.push(task);
    }
  }
  return out;
}

/** Shell-quote one argument (wrap + escape only when it contains shell-significant chars). */
function quoteArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"'$`\\|&;<>()*?!#~]/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Build the command line a task runs (command + quoted args). */
export function taskCommandLine(task: TaskConfig): string {
  const parts = [task.command, ...task.args.map(quoteArg)];
  return parts.join(" ");
}

/** The default task for a group: the `isDefault` one, else the first task in that group. */
export function defaultTaskFor(
  tasks: readonly TaskConfig[],
  group: TaskGroup,
): TaskConfig | undefined {
  const inGroup = tasks.filter((t) => t.group === group);
  return inGroup.find((t) => t.isDefault) ?? inGroup[0];
}

/* ── execution invocation + before-launch/compound planning (APP-035) ────────── */

/** What the gated S032 engine spawns for a task — argv ARRAY, never a joined
 *  string (taskCommandLine's quoting is DISPLAY-only). `shell:true` flags the
 *  unavoidable `sh -c`/`cmd /c` dispatch of a `type:"shell"` task. */
export interface TaskInvocation {
  cmd: string;
  args: string[];
  cwd: string;
  shell: boolean;
}

/**
 * TaskConfig → the spawnable invocation (APP-035 deliverable 1). `type:"process"`
 * is direct argv (safe); `type:"shell"` is VS Code's join-into-one-shell-string
 * semantics — dispatched via an EXPLICIT platform shell only because the task
 * type demands it, and flagged so callers can surface that. `${...}` variables
 * substitute with the same bounded set as run configs. A composite task
 * (no command) returns null — only its dependencies run.
 */
export function taskInvocation(
  task: TaskConfig,
  workspaceRoot: string,
  opts: {
    platform?: "posix" | "win32";
    file?: string;
    env?: Readonly<Record<string, string>>;
  } = {},
): TaskInvocation | null {
  if (task.command === "") return null;
  const ctx: SubstitutionContext = {
    workspaceRoot,
    ...(opts.file !== undefined ? { file: opts.file } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
  const sub = (s: string): string => substituteVars(s, ctx);
  const cwd = task.cwd !== undefined ? sub(task.cwd) : workspaceRoot;
  if (task.type === "process") {
    return { cmd: sub(task.command), args: task.args.map(sub), cwd, shell: false };
  }
  const line = taskCommandLine({ ...task, command: sub(task.command), args: task.args.map(sub) });
  return opts.platform === "win32"
    ? { cmd: "cmd", args: ["/c", line], cwd, shell: true }
    : { cmd: "sh", args: ["-c", line], cwd, shell: true };
}

/**
 * Expand a task label into its ordered dependency chain (dependsOn first, the
 * task itself last) — cycle-guarded exactly like resolveRunOrder guards
 * compounds. `${defaultBuildTask}` resolves via defaultTaskFor. Returns an
 * error STRING for a missing label or a cycle.
 */
export function expandTask(
  tasks: readonly TaskConfig[],
  label: string,
  seen: Set<string> = new Set(),
): TaskConfig[] | string {
  const task =
    label === "${defaultBuildTask}"
      ? defaultTaskFor(tasks, "build")
      : tasks.find((t) => t.label === label);
  if (!task) return `task "${label}" not found in tasks.json`;
  if (seen.has(task.label)) return `task dependency cycle at "${task.label}"`;
  seen.add(task.label);
  const out: TaskConfig[] = [];
  for (const dep of task.dependsOn ?? []) {
    const sub = expandTask(tasks, dep, seen);
    if (typeof sub === "string") return sub;
    out.push(...sub);
  }
  if (task.command !== "") out.push(task);
  return out;
}

/** A config's before-launch chain: its preLaunchTask expanded (dependsOn +
 *  `${defaultBuildTask}`), [] when it has none. Error string aborts the launch. */
export function planPreTasks(
  tasks: readonly TaskConfig[],
  cfg: Pick<RunConfig, "preLaunchTask">,
): TaskConfig[] | string {
  if (cfg.preLaunchTask === undefined) return [];
  return expandTask(tasks, cfg.preLaunchTask);
}

/** One resolved member of a run plan: its pre-tasks, then the config launch. */
export interface MemberPlan {
  preTasks: TaskConfig[];
  config: RunConfig;
}

/**
 * The ordered pre-task→launch plan for a named config (APP-035 deliverable 4).
 * Compounds expand via resolveRunOrder (cycle-guarded); each member carries its
 * own before-launch chain; `parallel` comes from the compound's explicit
 * `raw.parallel === true` flag (read fail-soft — anything else = serial).
 * A missing config/task or a dependency cycle returns an error STRING and
 * nothing runs.
 */
export function planTaskRun(
  tasks: readonly TaskConfig[],
  configs: readonly RunConfig[],
  name: string,
): { members: MemberPlan[]; parallel: boolean } | string {
  const compound = configs.find((c) => c.name === name && c.type === "compound");
  const members = resolveRunOrder(configs, name);
  if (members.length === 0) return `no runnable configuration named "${name}"`;
  const plans: MemberPlan[] = [];
  for (const m of members) {
    const pre = planPreTasks(tasks, m);
    if (typeof pre === "string") return pre;
    plans.push({ preTasks: pre, config: m });
  }
  return { members: plans, parallel: compound?.raw.parallel === true };
}
