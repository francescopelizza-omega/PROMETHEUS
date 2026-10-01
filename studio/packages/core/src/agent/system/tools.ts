// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/tools.ts — Tier R: the agent's read-only view of the machine (Phase 1).
 *
 * The bug these exist for: `/diff` — a command whose whole job is to read `git diff` — ended
 * with the model correctly enumerating its 17 tools, finding no way to read the repo, and
 * asking the human to paste the diff. The agent could install a plugin but not list a
 * directory.
 *
 * THREE properties make this set safe enough to auto-approve, and all three are load-bearing:
 *
 *  1. **Every tool is `readOnlyHint: true`.** That is not decoration — `classifyAuth`
 *     (agent/authorization.ts) reads it FIRST and returns the `read` category, which A1
 *     ("read freely", the default level) auto-approves. Add a mutating tool to this file and
 *     it silently inherits that auto-approval. Mutating tools go in a later tier, in their
 *     own file, with their own annotations.
 *  2. **No tool takes a command.** Each one names exactly what it does. There is no argv here
 *     for a model to smuggle a shell into: the HOST builds the argv from typed fields, so
 *     `git_diff` can never become `git diff; rm -rf ~`. The general `run_command` is Phase 2,
 *     behind the parser.
 *  3. **`toArgv` throws.** These are host-dispatched, never engine verbs. Making that a throw
 *     rather than a convention means a future refactor cannot quietly route them through
 *     `runPrometheus` with an argv that means something else entirely. Same discipline as
 *     `web_fetch` and `propose_edit`.
 *
 * PURE: definitions only, no IO, no node. The host implements the dispatch (see the CLI's
 * `session/system-tools.ts`), applies the working-set path guard, and runs every result
 * through `redactSecrets` before it reaches the model.
 */

import type { ToolDef, ToolSchema } from "../tools.js";

/* ── schema helpers (mirroring mcp/server/tools.ts's house style) ────────────*/

const RO = { readOnlyHint: true } as const;

const req = (description: string): ToolSchema[string] => ({
  type: "string",
  required: true,
  description,
});
const optStr = (description: string): ToolSchema[string] => ({ type: "string", description });
const optNum = (description: string): ToolSchema[string] => ({ type: "number", description });
const flag = (description: string): ToolSchema[string] => ({
  type: "boolean",
  default: false,
  description,
});

/** Host-dispatched: never an engine verb. See the file header for why this throws. */
function hostOnly(name: string): () => string[] {
  return () => {
    throw new Error(`${name} is served by the host runtime, not by prometheus.py`);
  };
}

/** Build a Tier-R def; the annotations are fixed so a new tool cannot forget them. */
function readTool(name: string, title: string, description: string, schema: ToolSchema): ToolDef {
  return { name, title, description, schema, annotations: RO, toArgv: hostOnly(name) };
}

/* ── files ───────────────────────────────────────────────────────────────────*/

export const READ_FILE_TOOL = readTool(
  "read_file",
  "Read a file",
  "Read a UTF-8 text file inside the working set. Returns the content with line numbers. " +
    "The `N  ` gutter is NOT part of the file — strip it before quoting text back in an edit, " +
    "and keep blank lines, they are real lines. " +
    "Large files are truncated; use offset/limit to page. Credential files (.env, ~/.ssh/*, " +
    "*.pem, ~/.aws/credentials) are refused — ask the human for a specific value instead.",
  {
    path: req("file path, absolute or relative to the working directory"),
    offset: optNum("first line to return (1-based); omit to start at the top"),
    limit: optNum("how many lines to return (default 2000)"),
  },
);

export const LIST_DIR_TOOL = readTool(
  "list_dir",
  "List a directory",
  "List the entries of a directory inside the working set, marking files and directories.",
  {
    path: req("directory path"),
    depth: optNum("how many levels to descend (default 1, max 4)"),
  },
);

export const GLOB_TOOL = readTool(
  "glob",
  "Find files by name",
  "Find files in the working set whose path matches a glob (e.g. `src/**/*.ts`). " +
    "Use this to locate files by NAME; use `grep` to search their contents.",
  { pattern: req("glob pattern, relative to the working directory") },
);

export const GREP_TOOL = readTool(
  "grep",
  "Search file contents",
  "Search the working set for a regular expression and return matching lines with their " +
    "file and line number. Use this to locate code by CONTENT.",
  {
    pattern: req("regular expression to search for"),
    path: optStr("limit the search to this file or directory"),
    glob: optStr("limit the search to files matching this glob (e.g. `*.ts`)"),
    ignoreCase: flag("case-insensitive match"),
    maxMatches: optNum("stop after this many matches (default 200)"),
  },
);

export const SEMANTIC_SEARCH_TOOL = readTool(
  "semantic_search",
  "Search code by meaning",
  "Find code related to a natural-language description, ranked by MEANING rather than exact " +
    "text — use this when you know what you want conceptually but not the words for it " +
    "(`grep` needs the literal string). Indexes a bounded slice of the working set (source " +
    "files only, size- and count-capped) using a local embedding model when one answers " +
    "(Ollama), and otherwise falls back to a lexical ranker — the result always states which " +
    "mode produced it, so treat a `lexical-fallback` result as keyword ranking, not meaning.",
  {
    query: req("what you are looking for, in plain language"),
    limit: optNum("how many results to return (default 8, max 50)"),
  },
);

export const STAT_PATH_TOOL = readTool(
  "stat_path",
  "Inspect a path",
  "Report whether a path exists and what it is: file or directory, size, and last-modified " +
    "time. Cheaper than reading a file when you only need to know it is there.",
  { path: req("path to inspect") },
);

/* ── git ─────────────────────────────────────────────────────────────────────*/

export const GIT_STATUS_TOOL = readTool(
  "git_status",
  "Git status",
  "The repository's current state: branch, how many commits ahead/behind its upstream, and " +
    "the staged / unstaged / untracked file lists. Start here for any question about what " +
    "has changed.",
  { cwd: optStr("repository directory (defaults to the working directory)") },
);

export const GIT_DIFF_TOOL = readTool(
  "git_diff",
  "Git diff",
  "The actual changes, as a unified diff. `staged:true` shows what is staged for commit " +
    "(`git diff --staged`); the default shows unstaged working-tree changes. Summarising a " +
    "change usually needs BOTH.",
  {
    cwd: optStr("repository directory (defaults to the working directory)"),
    staged: flag("show staged changes instead of unstaged ones"),
    path: optStr("limit the diff to this file or directory"),
    contextLines: optNum("lines of context around each hunk (default 3)"),
  },
);

export const GIT_LOG_TOOL = readTool(
  "git_log",
  "Git log",
  "Recent commits — hash, author, relative date and subject, newest first.",
  {
    cwd: optStr("repository directory (defaults to the working directory)"),
    limit: optNum("how many commits to return (default 20, max 200)"),
    path: optStr("only commits touching this file or directory"),
  },
);

export const GIT_SHOW_TOOL = readTool(
  "git_show",
  "Show a commit",
  "One commit in full: its metadata and its diff.",
  {
    cwd: optStr("repository directory (defaults to the working directory)"),
    ref: req("commit-ish to show (hash, tag, HEAD~1, …)"),
    path: optStr("limit the shown diff to this file or directory"),
  },
);

/* ── the machine ─────────────────────────────────────────────────────────────*/

export const SYSTEM_INFO_TOOL = readTool(
  "system_info",
  "System information",
  "What machine this is: OS and version, kernel, architecture, CPU model and core count, " +
    "total and available RAM, free disk space, and uptime.",
  {},
);

export const GPU_INFO_TOOL = readTool(
  "gpu_info",
  "GPU information",
  "The GPUs present, with VRAM and driver version where the platform reports them. Use this " +
    "before recommending a model size — it is the difference between advice and a guess.",
  {},
);

export const PROCESS_LIST_TOOL = readTool(
  "process_list",
  "List processes",
  "A one-shot snapshot of running processes with their CPU and memory share. Not a live " +
    "monitor — it returns immediately.",
  {
    filter: optStr("only processes whose command matches this substring"),
    limit: optNum("how many to return (default 30)"),
  },
);

export const WHICH_TOOL = readTool(
  "which",
  "Locate a program",
  "Whether a program is installed and where, with its version when it reports one. Check " +
    "this before suggesting a command that may not exist on this machine.",
  { name: req("program name, e.g. `python3`, `rg`, `docker`") },
);

export const PACKAGE_LIST_TOOL = readTool(
  "package_list",
  "List installed packages",
  "The packages installed by a package manager (homebrew, pip, npm-global).",
  {
    manager: {
      type: "string",
      required: true,
      description: "one of: brew, pip, npm",
    },
    filter: optStr("only packages whose name contains this substring"),
  },
);

export const ENV_GET_TOOL = readTool(
  "env_get",
  "Read an environment variable",
  "Read ONE non-sensitive environment variable by name (PATH, HOME, SHELL, LANG, " +
    "VIRTUAL_ENV, …). There is deliberately no way to dump the whole environment: it holds " +
    "API keys, and tool output is folded into this conversation.",
  { name: req("variable name") },
);

/* ── Tier C: the general command runner (Phase 2) ────────────────────────────*/

/**
 * `run_command` — compose a real command line, run it with NO shell.
 *
 * The name is load-bearing. `classifyAuth` (authorization.ts) special-cases the literal
 * string `run_command` and returns the `command` category — but that is only a floor: the
 * HOST re-classifies the PARSED command per invocation, so `ls` and `rm -rf` are governed by
 * their own tiers rather than sharing this tool's name.
 *
 * NO `readOnlyHint` — the broker therefore routes every call to `confirm`, even under
 * `tuning.yes`, and the authorization ladder decides whether that confirm is a prompt or a
 * silent approval. `destructiveHint` is deliberately ABSENT too: with it, `classifyAuth`
 * would still say `command` (the run_command test comes first), but the annotation would be
 * a lie about the many invocations that are plain reads.
 */
export const RUN_COMMAND_TOOL: ToolDef = {
  name: "run_command",
  title: "Run a command",
  description:
    "Run a shell-style command line — pipes (`|`), `&&`, `||`, `;` and redirects all work — " +
    "but NO shell is involved: the line is parsed and each program is executed directly. " +
    "Command substitution (`$(…)`, backticks), `eval`, background `&` and shells " +
    "(`sh`/`bash`) are refused; run the inner command as its own call instead. " +
    "Prefer the purpose-built tools (`git_status`, `read_file`, `grep`) when they fit — they " +
    "are cheaper and never need approval.",
  schema: {
    command: req("the command line to run, e.g. `ps aux | grep node | wc -l`"),
    cwd: optStr("working directory (defaults to the session's)"),
    timeoutSeconds: optNum("wall-clock limit (default 30, max 600)"),
    mode: optStr(
      "`collect` (default) waits and returns the output · `stream` also shows it live · " +
        "`background` returns a job handle immediately for long installs and builds — poll it " +
        "with `job_status` and read it with `job_output`",
    ),
  },
  annotations: {},
  toArgv: hostOnly("run_command"),
};

/* ── job control (Phase 4) ───────────────────────────────────────────────────*/

/**
 * The three job tools.
 *
 * `job_status` and `job_output` are plain reads of state this session already holds — no
 * subprocess, nothing observable outside the CLI — so they carry `readOnlyHint` and A1
 * auto-approves them. Polling a job you started should not cost a prompt, or the agent will
 * avoid backgrounding and go back to blocking the turn for four minutes.
 *
 * `job_kill` carries no annotation, so it classifies as `config` and needs A3. Terminating a
 * process is a real effect — but it is a process THIS agent started, in this session, and
 * the alternative to killing a runaway build is leaving it running.
 */
export const JOB_STATUS_TOOL = readTool(
  "job_status",
  "Check a background job",
  "The state of a background command: running / done / failed / killed / timeout, its exit " +
    "code and how long it has been going. Omit `id` to list every job this session started.",
  { id: optStr("the job handle from `run_command` with mode:background; omit to list all") },
);

export const JOB_OUTPUT_TOOL = readTool(
  "job_output",
  "Read a background job's output",
  "The output a background command has produced so far. Safe to call while it is still " +
    "running — you get everything captured up to now.",
  { id: req("the job handle") },
);

export const JOB_KILL_TOOL: ToolDef = {
  name: "job_kill",
  title: "Stop a background job",
  description:
    "Terminate a background command this session started (SIGTERM, then SIGKILL). Use it " +
    "when a job is stuck or is no longer needed.",
  schema: { id: req("the job handle") },
  annotations: {},
  toArgv: hostOnly("job_kill"),
};

/* ── elevated proposals (Phase 5 / §7) ───────────────────────────────────────*/

/**
 * The ONLY sanctioned answer to "this needs root".
 *
 * Note the shape of the schema: `argv` is an ARRAY, not a command string. That is not a
 * stylistic choice — a string would have to be parsed, and a parser is exactly the thing an
 * attacker probes. An array has no operators, no quoting, no substitution and no pipeline;
 * one proposal is one program with its arguments, and there is nothing to misparse.
 *
 * `sudo` is not written by the agent and must not appear in `argv` — the prefix is added at
 * render time. The description says so plainly because the model reads it, and a model that
 * writes `["sudo", …]` gets a refusal explaining the rule rather than a silent rewrite.
 *
 * No `destructiveHint`: the annotation ladder tops out at A6/A7 auto-approving `destructive`,
 * and this tool must prompt at every level. `NEVER_AUTO_TOOLS` in `authorization.ts` carries
 * that instead, where it cannot be lost by re-annotating.
 */
export const PROPOSE_ELEVATED_TOOL: ToolDef = {
  name: "propose_elevated",
  title: "Propose a command for the human to run with sudo",
  description:
    "Ask the HUMAN to run a command with elevated privileges. You cannot run sudo yourself " +
    "and must never put `sudo` in a command — this tool is how you ask. It does not execute " +
    "anything: it prints the command for the human to copy into their own terminal, where " +
    "they answer their own sudo prompt. Use it when a task genuinely needs root (a system " +
    "service, a root-owned config, a system package manager) and say clearly why.",
  schema: {
    // Declared as an ARRAY, which is what the description has always demanded. It was typed
    // `string` only because FieldSpec had no array type, so the schema said one thing and the
    // prose said the opposite — and the schema is the half a model follows.
    argv: {
      type: "array",
      required: true,
      description:
        'the command as an array of strings WITHOUT `sudo`, e.g. ["systemctl","restart","nginx"]',
      items: { type: "string" },
    },
    why: req("one sentence: why this needs root, and what it will change"),
    cwd: optStr("the directory it should be run in, if it matters"),
  },
  annotations: {},
  toArgv: hostOnly("propose_elevated"),
};

/* ── the set ─────────────────────────────────────────────────────────────────*/

/**
 * Tier R, in the order the model sees them: files, then git, then the machine.
 *
 * Order is not cosmetic — a model scanning a tool list reaches for the first plausible
 * match, and `read_file`/`git_status` are the right first reaches.
 */
export const SYSTEM_READ_TOOLS: readonly ToolDef[] = Object.freeze([
  READ_FILE_TOOL,
  LIST_DIR_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  SEMANTIC_SEARCH_TOOL,
  STAT_PATH_TOOL,
  GIT_STATUS_TOOL,
  GIT_DIFF_TOOL,
  GIT_LOG_TOOL,
  GIT_SHOW_TOOL,
  SYSTEM_INFO_TOOL,
  GPU_INFO_TOOL,
  PROCESS_LIST_TOOL,
  WHICH_TOOL,
  PACKAGE_LIST_TOOL,
  ENV_GET_TOOL,
]);

/**
 * Tier R plus `run_command` — the full Phase-2 tool set a host exposes.
 *
 * Kept as a SEPARATE constant from `SYSTEM_READ_TOOLS` so a host can ship the read-only half
 * alone. `run_command` is not `readOnlyHint`, so putting it in the Tier-R array would have
 * quietly broken that array's one invariant: everything in it auto-approves at A1.
 */
export const SYSTEM_TOOLS: readonly ToolDef[] = Object.freeze([
  ...SYSTEM_READ_TOOLS,
  RUN_COMMAND_TOOL,
  JOB_STATUS_TOOL,
  JOB_OUTPUT_TOOL,
  JOB_KILL_TOOL,
  PROPOSE_ELEVATED_TOOL,
]);

/** Names only — for the host's dispatch table and for tests. */
export const SYSTEM_READ_TOOL_NAMES: readonly string[] = Object.freeze(
  SYSTEM_READ_TOOLS.map((t) => t.name),
);

/** Whether `name` is one of the Tier-R tools (the host dispatches these locally). */
export function isSystemReadTool(name: string): boolean {
  return SYSTEM_READ_TOOL_NAMES.includes(name);
}

/**
 * The environment variables `env_get` will return.
 *
 * An ALLOWLIST, not a denylist, and the asymmetry is the point: a denylist has to predict
 * every name a secret might use (`FOO_CORP_INTERNAL_SIGNING_SEED`), while an allowlist only
 * has to know the handful that are useful and boring. Everything else is refused by default.
 */
export const ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "PWD",
  "EDITOR",
  "VISUAL",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "PYENV_VERSION",
  "NVM_BIN",
  "JAVA_HOME",
  "GOPATH",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "PROMETHEUS_HOME",
]);

const ENV_ALLOWED: ReadonlySet<string> = new Set(ENV_ALLOWLIST);

/** Whether `env_get` may return this variable. */
export function isEnvReadable(name: string): boolean {
  return ENV_ALLOWED.has((name ?? "").trim());
}
