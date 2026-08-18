/**
 * session/system-tools.ts — the CLI's dispatch for Tier R (full_wrapper_compose Phase 1).
 *
 * The definitions live in `@prometheus/core/agent-system` (pure); this is the half that
 * touches the machine. Every rule the plan sets out is enforced here, in one place:
 *
 *   - **No shell.** Every subprocess goes through engine-bridge's `execCapture`, which is
 *     `spawn(cmd, argv, {shell:false, env: safeChildEnv(), timeout})`. The model never
 *     supplies argv — it supplies typed fields, and the argv is built here from a fixed
 *     template. `git_diff` cannot become `git diff; rm -rf ~` because there is no string for
 *     a `;` to live in.
 *   - **Option-injection guard.** Any model-supplied token that starts with `-` is refused
 *     before the spawn (`git log --output=/etc/passwd` is a flag wearing a path's clothes).
 *     Same rule `git-helpers.ts` already applies to `/worktree`.
 *   - **Path scope.** The caller's working-set guard runs first (agent-runtime's
 *     `pathArgsOf`/`isPathAllowed`); this module additionally refuses credential paths
 *     outright.
 *   - **Redaction.** Every byte returned to the model passes `redactSecrets`. Tool output is
 *     folded into the thread, and the thread may go to a cloud endpoint.
 *   - **Bounded.** Output is capped and truncation is stated in the text, so the model knows
 *     it is looking at a prefix rather than silently reasoning about a partial file.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { arch, cpus, freemem, homedir, platform, release, totalmem, uptime } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SecurityVerdict } from "@prometheus/engine-bridge";
import { type ExecCaptureResult, execCapture } from "@prometheus/engine-bridge";
import {
  classifyCommand,
  describeCommand,
  formatCommand,
  parseCommand,
  screenCommand,
} from "../../exec/index.js";
import type { ToolOutcome } from "../../loop.js";
import type { ElevatedProposal } from "../index.js";
import {
  ENV_ALLOWLIST,
  checkElevated,
  elevatedCommandLine,
  isEnvReadable,
  isSecretPath,
  redactSecrets,
  renderElevated,
  secretPathReason,
  secretRefusal,
} from "../index.js";

import { appendExecAudit, execAuditEntry, scanCommand, verdictBlocks } from "./exec-gate.js";
import { describeJob, getJob, killJob, listJobs, startJob } from "./exec-jobs.js";
import { DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS, runParsedCommand } from "./exec-runner.js";
import { type SandboxMode, describeSandbox, planExecSandbox, sandboxHint } from "./exec-sandbox.js";
import { type FsPreImage, runFsMutateTool } from "./fs-mutate-host.js";
import { prometheusHome } from "./home.js";
import { runMemoryTool } from "./memory-store.js";
import { type EmbedFn, semanticSearchTool } from "./semantic-index.js";
import { isPathAllowed } from "./working-set.js";

/* ── budgets ─────────────────────────────────────────────────────────────────*/

/** Output cap for one tool result, in characters. Mirrors the loop's own 16 KB thread cap. */
const MAX_CHARS = 16_000;
/** Default lines returned by `read_file` before the model must page with offset/limit. */
const DEFAULT_READ_LINES = 2000;
/** Wall-clock for a probe. Read-only commands that take longer than this are wedged. */
const PROBE_TIMEOUT_MS = 10_000;

/* ── injectable seams (tests never spawn) ────────────────────────────────────*/

export interface SystemToolDeps {
  /** the working directory a `cwd`-less call defaults to. */
  cwd: string;
  /**
   * The variables `$VAR` may expand to inside a `run_command` line.
   *
   * The host seeds this from the same non-sensitive allowlist `env_get` serves. Anything
   * absent is a PARSE ERROR rather than an empty expansion — see parse.ts for why.
   */
  vars?: Readonly<Record<string, string>>;
  /** injected for tests so no suite spawns a real pipeline. */
  spawnImpl?: Parameters<typeof runParsedCommand>[1]["spawnImpl"];
  /**
   * Cancel a RUNNING command — the turn's abort signal.
   *
   * `RunPipelineOptions.signal` has existed and worked since the background-job runner needed
   * it; the FOREGROUND call site simply never passed one. So Ctrl-C during a `run_command`
   * returned the user to their prompt while the child kept going: a `pip install` that had
   * been cancelled finished installing, a build kept writing into `dist/`, and the process
   * outlived the turn that had asked for it. Nothing in the type system noticed, because the
   * field is optional on the way in.
   */
  signal?: AbortSignal;
  /**
   * Live output sink for `mode:"stream"` — the host's terminal writer.
   *
   * A ToolRunner resolves once, so the agent loop cannot carry mid-flight output; this is the
   * side channel that can.
   */
  onProgress?: (chunk: string) => void;
  /** the nemesis scan seam (Phase 3). Injected in tests so no suite spawns the scanner. */
  gateImpl?: Parameters<typeof scanCommand>[1] extends { gate?: infer G } ? G : never;
  /** the gate posture; `off` skips the scan the way it skips every other gate. */
  gateMode?: "enforce" | "warn" | "off";
  /** PROMETHEUS_HOME — where the exec audit line is appended. Omitted ⇒ no audit. */
  home?: string;
  /** the authorization level in force, recorded in the audit line. */
  authLevel?: number;
  /** absolute paths a confirm seam approved for an out-of-working-set Tier-W mutation. */
  approvedOutside?: ReadonlySet<string>;
  /** fired before a destructive Tier-W change, so a host with checkpoints can undo it. */
  onPreImage?: (rec: FsPreImage) => void;
  /**
   * The working-set roots a redirect target must land inside.
   *
   * The generic tool-arg guard in `working-set.ts` inspects tool ARGUMENTS (`path`, `cwd`),
   * and a redirect target does not live in one — it lives INSIDE the command string, so
   * `echo x > ~/.zshrc` reached `openSync` with nothing having looked at the path. Omitted ⇒
   * no redirect guard (matching the runner's existing "no roots ⇒ no path scope" posture).
   */
  roots?: readonly string[];
  /**
   * The OS-level exec sandbox posture (macOS Seatbelt). Defaults to `enforce`.
   *
   * Deliberately NOT wired to any flag today: the only reason it exists is that a security
   * control with no visible off switch gets disabled by patching it out, and a patched-out
   * control leaves no audit line. `off` is recorded in the exec audit like everything else.
   */
  sandboxMode?: SandboxMode;
  /** shell-free capture. Defaults to engine-bridge's `execCapture`. */
  exec?: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecCaptureResult>;
  /**
   * `semantic_search`'s embedder seam. Injected in tests so no suite calls a real local
   * server; production defaults to `defaultOllamaEmbedder()` (see semantic-index.ts) — a
   * local Ollama `/api/embeddings` call, never a cloud endpoint.
   */
  embedImpl?: EmbedFn;
  /** the embedding model `semantic_search` asks for (default: "nomic-embed-text"). */
  embedModel?: string;
}

type Exec = NonNullable<SystemToolDeps["exec"]>;

const defaultExec: Exec = (cmd, args, opts) =>
  execCapture(cmd, args, { timeoutMs: opts?.timeoutMs ?? PROBE_TIMEOUT_MS });

/* ── helpers ─────────────────────────────────────────────────────────────────*/

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean => v === true;

/** A model-supplied token is argv-safe iff it is non-empty and not a flag. */
function safeToken(token: string): boolean {
  return token.length > 0 && !token.startsWith("-");
}

function refuse(summary: string): ToolOutcome {
  return { ok: false, summary };
}

/**
 * Finish an outcome: redact, then cap.
 *
 * Order matters. Redacting AFTER the cap would let a secret sitting past the cut survive in
 * whatever the cap kept, and — worse — a secret straddling the boundary would be split into
 * two unmatched halves. Redact the whole buffer, then truncate.
 */
function done(ok: boolean, body: string, data?: Record<string, unknown>): ToolOutcome {
  const { text, redactions } = redactSecrets(body);
  let out = text;
  let truncated = false;
  if (out.length > MAX_CHARS) {
    out = `${out.slice(0, MAX_CHARS)}\n…[truncated at ${MAX_CHARS} characters]`;
    truncated = true;
  }
  const note =
    redactions.length > 0
      ? `\n[${redactions.length} secret${redactions.length === 1 ? "" : "s"} redacted before this reached the model]`
      : "";
  return {
    ok,
    summary: out + note,
    ...(data || truncated || redactions.length
      ? { data: { ...(data ?? {}), truncated, redacted: redactions.length } }
      : {}),
  };
}

/**
 * Resolve a model-supplied path against the session cwd.
 *
 * `~` is expanded HERE because no shell is involved anywhere in this module — the tilde is a
 * shell convention, so without this a model writing the entirely reasonable `~/.zshrc` gets
 * `<cwd>/~/.zshrc`, a path that does not exist. Only a leading `~/` (or a bare `~`) expands;
 * `~user` is left alone, since resolving another user's home is not something a read-only
 * tool should be guessing at.
 */
function resolvePath(p: string, cwd: string): string {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Refuse a credential path before any read. Returns the refusal, or null when allowed. */
function guardSecretPath(abs: string): ToolOutcome | null {
  const why = secretPathReason(abs);
  return why ? refuse(secretRefusal(abs, why)) : null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/* ── git ─────────────────────────────────────────────────────────────────────*/

/** Run git shell-free in `cwd`, via `-C` (never a shell cd). */
async function git(exec: Exec, cwd: string, argv: string[]): Promise<ExecCaptureResult> {
  return exec("git", ["-C", cwd, ...argv], { timeoutMs: PROBE_TIMEOUT_MS });
}

/**
 * `git status` as STRUCTURED fields rather than porcelain text.
 *
 * Worth the parsing: `{branch, ahead, behind, staged[], unstaged[], untracked[]}` costs the
 * model far fewer tokens than forty lines of porcelain, cannot be prompt-injected by a
 * cunningly-named file, and gives Studio the ahead/behind numbers that handoff_3 §5 wants
 * and has no other source for.
 */
async function gitStatus(exec: Exec, cwd: string): Promise<ToolOutcome> {
  const res = await git(exec, cwd, [
    "status",
    "--porcelain=v1",
    "--branch",
    "--untracked-files=all",
  ]);
  if (res.code !== 0) {
    return refuse(`git_status failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const lines = res.stdout.split("\n").filter((l) => l.length > 0);
  let branch = "";
  let upstream = "";
  let ahead = 0;
  let behind = 0;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // `## main...origin/main [ahead 2, behind 1]` — or `## HEAD (no branch)`
      const head = line.slice(3);
      const bracket = head.indexOf(" [");
      const names = bracket >= 0 ? head.slice(0, bracket) : head;
      const dots = names.indexOf("...");
      branch = dots >= 0 ? names.slice(0, dots) : names;
      upstream = dots >= 0 ? names.slice(dots + 3) : "";
      if (bracket >= 0) {
        const a = /ahead (\d+)/.exec(head);
        const b = /behind (\d+)/.exec(head);
        ahead = a ? Number(a[1]) : 0;
        behind = b ? Number(b[1]) : 0;
      }
      continue;
    }
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const file = line.slice(3);
    if (x === "?" && y === "?") untracked.push(file);
    else {
      if (x !== " ") staged.push(`${x} ${file}`);
      if (y !== " ") unstaged.push(`${y} ${file}`);
    }
  }

  const body = [
    `branch: ${branch || "(detached)"}${upstream ? ` → ${upstream}` : " (no upstream)"}`,
    `ahead: ${ahead}  behind: ${behind}`,
    `staged: ${staged.length}  unstaged: ${unstaged.length}  untracked: ${untracked.length}`,
    staged.length ? `\nstaged:\n${staged.map((f) => `  ${f}`).join("\n")}` : "",
    unstaged.length ? `\nunstaged:\n${unstaged.map((f) => `  ${f}`).join("\n")}` : "",
    untracked.length ? `\nuntracked:\n${untracked.map((f) => `  ${f}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return done(true, body || "clean working tree", {
    branch,
    upstream,
    ahead,
    behind,
    staged: staged.length,
    unstaged: unstaged.length,
    untracked: untracked.length,
  });
}

async function gitDiff(
  exec: Exec,
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const path = str(args.path);
  if (path && !safeToken(path)) return refuse(`refusing a path that looks like a flag: ${path}`);
  const context = num(args.contextLines);
  const argv = [
    "diff",
    ...(bool(args.staged) ? ["--staged"] : []),
    `--unified=${context !== undefined && context >= 0 && context <= 20 ? Math.trunc(context) : 3}`,
    // stat FIRST so a huge diff still tells the model what changed even when the body is cut
    "--stat=200",
    "--patch",
    // end-of-options: everything after `--` is a path, never a flag
    ...(path ? ["--", path] : []),
  ];
  const res = await git(exec, cwd, argv);
  if (res.code !== 0) return refuse(`git_diff failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  const label = bool(args.staged) ? "staged" : "unstaged";
  if (!res.stdout.trim()) return done(true, `no ${label} changes`);
  return done(true, res.stdout);
}

async function gitLog(
  exec: Exec,
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const path = str(args.path);
  if (path && !safeToken(path)) return refuse(`refusing a path that looks like a flag: ${path}`);
  const limit = Math.min(Math.max(num(args.limit) ?? 20, 1), 200);
  const res = await git(exec, cwd, [
    "log",
    `--max-count=${Math.trunc(limit)}`,
    "--pretty=format:%h  %an  %ar  %s",
    ...(path ? ["--", path] : []),
  ]);
  if (res.code !== 0) return refuse(`git_log failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  return done(true, res.stdout.trim() || "no commits");
}

async function gitShow(
  exec: Exec,
  cwd: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const ref = str(args.ref);
  if (!safeToken(ref)) return refuse(`refusing a ref that looks like a flag: ${ref || "(empty)"}`);
  const path = str(args.path);
  if (path && !safeToken(path)) return refuse(`refusing a path that looks like a flag: ${path}`);
  const res = await git(exec, cwd, [
    "show",
    "--stat=200",
    "--patch",
    ref,
    ...(path ? ["--", path] : []),
  ]);
  if (res.code !== 0) return refuse(`git_show failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  return done(true, res.stdout);
}

/* ── files ───────────────────────────────────────────────────────────────────*/

async function readFileTool(args: Record<string, unknown>, cwd: string): Promise<ToolOutcome> {
  const p = str(args.path);
  if (!p) return refuse("read_file: no path given");
  const abs = resolvePath(p, cwd);
  const secret = guardSecretPath(abs);
  if (secret) return secret;
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (e) {
    return refuse(`read_file failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A NUL in the first block means binary; returning it as "text" wastes the model's context
  // on mojibake and can smuggle control sequences into the transcript.
  if (raw.slice(0, 4096).includes("\u0000")) {
    return refuse(`read_file: ${p} looks like a binary file`);
  }
  const lines = raw.split("\n");
  const offset = Math.max((num(args.offset) ?? 1) - 1, 0);
  const limit = Math.min(Math.max(num(args.limit) ?? DEFAULT_READ_LINES, 1), 10_000);
  const slice = lines.slice(offset, offset + limit);
  const width = String(offset + slice.length).length;
  const body = slice.map((l, i) => `${String(offset + i + 1).padStart(width)}  ${l}`).join("\n");
  const more =
    offset + slice.length < lines.length
      ? `\n…[${lines.length - offset - slice.length} more lines; call again with offset=${offset + slice.length + 1}]`
      : "";
  return done(true, body + more, { path: abs, lines: lines.length });
}

async function listDir(args: Record<string, unknown>, cwd: string): Promise<ToolOutcome> {
  const p = str(args.path) || ".";
  const root = resolvePath(p, cwd);
  const depth = Math.min(Math.max(num(args.depth) ?? 1, 1), 4);
  const out: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      out.push(`  (cannot read ${dir}: ${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name === ".git" || ent.name === "node_modules") {
        out.push(`${"  ".repeat(level)}${ent.name}/  (skipped)`);
        continue;
      }
      const full = join(dir, ent.name);
      out.push(`${"  ".repeat(level)}${ent.name}${ent.isDirectory() ? "/" : ""}`);
      if (ent.isDirectory() && level + 1 < depth) await walk(full, level + 1);
      if (out.length > 4000) return;
    }
  };
  await walk(root, 0);
  return done(true, out.length ? `${root}\n${out.join("\n")}` : `${root}\n  (empty)`);
}

async function statPath(args: Record<string, unknown>, cwd: string): Promise<ToolOutcome> {
  const p = str(args.path);
  if (!p) return refuse("stat_path: no path given");
  const abs = resolvePath(p, cwd);
  try {
    const st = await stat(abs);
    const kind = st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
    return done(
      true,
      `${abs}\n  kind: ${kind}\n  size: ${fmtBytes(st.size)}\n  modified: ${st.mtime.toISOString()}`,
      { exists: true, kind, size: st.size, mtimeMs: st.mtimeMs },
    );
  } catch {
    return done(true, `${abs}\n  does not exist`, { exists: false });
  }
}

/* ── search (ripgrep when present, a bounded walk otherwise) ─────────────────*/

async function grepTool(
  exec: Exec,
  args: Record<string, unknown>,
  cwd: string,
): Promise<ToolOutcome> {
  const pattern = str(args.pattern);
  if (!pattern) return refuse("grep: no pattern given");
  const where = str(args.path);
  if (where && !safeToken(where)) return refuse(`refusing a path that looks like a flag: ${where}`);
  const glob = str(args.glob);
  if (glob && !safeToken(glob)) return refuse(`refusing a glob that looks like a flag: ${glob}`);
  const max = Math.min(Math.max(num(args.maxMatches) ?? 200, 1), 2000);
  const target = where ? resolvePath(where, cwd) : cwd;

  const rg = await exec(
    "rg",
    [
      "--line-number",
      "--no-heading",
      "--color=never",
      `--max-count=${max}`,
      ...(bool(args.ignoreCase) ? ["--ignore-case"] : []),
      ...(glob ? ["--glob", glob] : []),
      // `-e` so a pattern beginning with `-` is data, not a flag
      "-e",
      pattern,
      target,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  // rg exits 1 for "no matches" — a result, not a failure. 127 means it is not installed.
  if (rg.code === 0 || rg.code === 1) {
    const hits = rg.stdout.trim();
    return done(true, hits || `no matches for /${pattern}/ under ${target}`);
  }
  const missing = rg.code === 127 ? " (ripgrep is not installed on this machine)" : "";
  return refuse(`grep failed: ${rg.stderr.trim() || `exit ${rg.code}`}${missing}`);
}

async function globTool(
  exec: Exec,
  args: Record<string, unknown>,
  cwd: string,
): Promise<ToolOutcome> {
  const pattern = str(args.pattern);
  if (!pattern) return refuse("glob: no pattern given");
  if (!safeToken(pattern)) return refuse(`refusing a pattern that looks like a flag: ${pattern}`);
  const rg = await exec("rg", ["--files", "--color=never", "--glob", pattern, cwd], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (rg.code === 0 || rg.code === 1) {
    const files = rg.stdout
      .split("\n")
      .filter(Boolean)
      .map((f) => relative(cwd, f) || f);
    return done(true, files.length ? files.join("\n") : `no files match ${pattern}`, {
      count: files.length,
    });
  }
  const missing = rg.code === 127 ? " (ripgrep is not installed on this machine)" : "";
  return refuse(`glob failed: ${rg.stderr.trim() || `exit ${rg.code}`}${missing}`);
}

/* ── the machine ─────────────────────────────────────────────────────────────*/

async function systemInfo(exec: Exec): Promise<ToolOutcome> {
  const cores = cpus();
  const model = cores[0]?.model?.trim() ?? "unknown";
  const lines = [
    `platform: ${platform()} ${release()} (${arch()})`,
    `cpu: ${model} × ${cores.length}`,
    `memory: ${fmtBytes(totalmem())} total, ${fmtBytes(freemem())} free`,
    `uptime: ${Math.round(uptime() / 3600)}h`,
    `home: ${homedir()}`,
  ];
  if (platform() === "darwin") {
    const sw = await exec("sw_vers", ["-productVersion"], { timeoutMs: 4000 });
    if (sw.code === 0 && sw.stdout.trim()) lines.splice(1, 0, `macOS: ${sw.stdout.trim()}`);
  }
  const df = await exec("df", ["-h", homedir()], { timeoutMs: 4000 });
  if (df.code === 0) {
    // The whole row, not a slice of it: `df`'s column COUNT varies by platform and locale,
    // so counting from either end drops a different field depending on the machine — which
    // is how the size column went missing on macOS.
    const row = df.stdout.split("\n")[1];
    if (row) lines.push(`disk (home): ${row.trim().replace(/\s+/g, "  ")}`);
  }
  return done(true, lines.join("\n"));
}

async function gpuInfo(exec: Exec): Promise<ToolOutcome> {
  const nv = await exec(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used,driver_version", "--format=csv,noheader"],
    { timeoutMs: 8000 },
  );
  if (nv.code === 0 && nv.stdout.trim()) {
    return done(true, `NVIDIA:\n${nv.stdout.trim()}`);
  }
  if (platform() === "darwin") {
    const sp = await exec("system_profiler", ["SPDisplaysDataType"], { timeoutMs: 15_000 });
    if (sp.code === 0 && sp.stdout.trim()) {
      const kept = sp.stdout
        .split("\n")
        .filter((l) => /Chipset Model|VRAM|Vendor|Total Number of Cores|Metal/.test(l))
        .map((l) => l.trim());
      return done(true, kept.length ? kept.join("\n") : sp.stdout.slice(0, 2000));
    }
  }
  return done(true, "no GPU reported (no nvidia-smi, and no platform probe succeeded)");
}

async function processList(exec: Exec, args: Record<string, unknown>): Promise<ToolOutcome> {
  const filter = str(args.filter).toLowerCase();
  const limit = Math.min(Math.max(num(args.limit) ?? 30, 1), 200);
  // `ps` one-shot, never `top` — an agent must not spawn something that renders until killed.
  const ps = await exec("ps", ["axo", "pid,pcpu,pmem,comm"], { timeoutMs: 8000 });
  if (ps.code !== 0) return refuse(`process_list failed: ${ps.stderr.trim() || `exit ${ps.code}`}`);
  const rows = ps.stdout.split("\n").filter(Boolean);
  const header = rows[0] ?? "";
  const body = rows
    .slice(1)
    .filter((r) => !filter || r.toLowerCase().includes(filter))
    .slice(0, limit);
  return done(true, [header, ...body].join("\n"), { shown: body.length });
}

async function whichTool(exec: Exec, args: Record<string, unknown>): Promise<ToolOutcome> {
  const name = str(args.name);
  if (!safeToken(name)) return refuse(`refusing a program name that looks like a flag: ${name}`);
  const w = await exec("which", [name], { timeoutMs: 4000 });
  if (w.code !== 0 || !w.stdout.trim()) return done(true, `${name}: not installed`);
  const path = w.stdout.trim().split("\n")[0] ?? "";
  const v = await exec(path, ["--version"], { timeoutMs: 4000 });
  const version = v.code === 0 ? (v.stdout || v.stderr).trim().split("\n")[0] : "";
  return done(true, `${name}: ${path}${version ? `\n  ${version}` : ""}`, { path });
}

async function packageList(exec: Exec, args: Record<string, unknown>): Promise<ToolOutcome> {
  const manager = str(args.manager).toLowerCase();
  const filter = str(args.filter).toLowerCase();
  const table: Record<string, [string, string[]]> = {
    brew: ["brew", ["list", "--versions"]],
    pip: ["pip3", ["list"]],
    npm: ["npm", ["ls", "--global", "--depth=0"]],
  };
  const spec = table[manager];
  if (!spec) return refuse(`package_list: unknown manager "${manager}" (use brew, pip or npm)`);
  const res = await exec(spec[0], spec[1], { timeoutMs: 30_000 });
  if (res.code !== 0 && !res.stdout.trim()) {
    return refuse(`package_list failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const rows = res.stdout
    .split("\n")
    .filter((r) => r && (!filter || r.toLowerCase().includes(filter)));
  return done(true, rows.join("\n") || "(none)", { count: rows.length });
}

function envGet(args: Record<string, unknown>): ToolOutcome {
  const name = str(args.name);
  if (!name) return refuse("env_get: no variable name given");
  if (!isEnvReadable(name)) {
    return refuse(
      [
        `env_get refused "${name}": only non-sensitive variables may be read`,
        `(${ENV_ALLOWLIST.join(", ")}). The environment holds API keys, and tool output is`,
        "folded into this conversation.",
      ].join(" "),
    );
  }
  const value = process.env[name];
  return done(true, value === undefined ? `${name} is not set` : `${name}=${value}`);
}

/* ── run_command (Phase 2) ───────────────────────────────────────────────────*/

/**
 * Parse → classify → run. The authorization decision is NOT made here.
 *
 * By the time this is called the loop has already routed the call through `confirm` (the
 * tool carries no `readOnlyHint`, so the broker always does), and the CLI's confirm seam has
 * consulted the PARSED tier. What is left is to do exactly what was approved: re-parse the
 * same string, refuse if anything changed its mind, and execute the argv.
 *
 * The refusals here are all fail-closed and all explain themselves, because the model is the
 * one that has to rewrite the command.
 */
async function runCommandTool(
  args: Record<string, unknown>,
  cwd: string,
  deps: SystemToolDeps,
): Promise<ToolOutcome> {
  const line = typeof args.command === "string" ? args.command : "";
  if (!line.trim()) return refuse("run_command: no command given");

  const parsed = parseCommand(line, { vars: deps.vars ?? {} });
  if (!parsed.ok) {
    return refuse(`refused: ${parsed.error}${parsed.hint ? `\n${parsed.hint}` : ""}`);
  }
  const cls = classifyCommand(parsed.command);
  if (!cls.ok) return refuse(cls.error);

  // ── layer 3: the nemesis scan, on the RE-RENDERED command ────────────────
  // The scanner sees exactly what the executor will run, not the model's original string.
  // The verdict is usually already latched by the confirm seam; this call reuses it.
  const rendered = describeCommand(parsed.command, cls);
  const commandText = formatCommand(parsed.command);
  const gateMode = deps.gateMode ?? "enforce";
  const verdict =
    gateMode === "off"
      ? null
      : await scanCommand(commandText, deps.gateImpl ? { gate: deps.gateImpl } : {});

  if (verdict && verdictBlocks(verdict, gateMode)) {
    if (deps.home) {
      appendExecAudit(
        deps.home,
        execAuditEntry({
          command: commandText,
          tier: cls.tier,
          verdict: verdict.verdict,
          decision: "blocked",
          authLevel: deps.authLevel ?? -1,
          argv: parsed.command.parts.flatMap((p) => p.pipeline.stages.map((st) => st.argv)),
          reason: verdict.findings.map((f) => f.where).join("; ") || verdict.verdict,
        }),
      );
    }
    // Returning the verdict on the outcome ALSO aborts the agent loop's round (core's
    // gate-first check), so a BLOCK stops the turn rather than merely this call — and it
    // does so at every authorization level, A7 included.
    return {
      ok: false,
      summary: [
        `refused by the nemesis gate (${verdict.verdict}): ${rendered}`,
        ...verdict.findings.map((f) => `  - ${f.where}`),
      ].join("\n"),
      verdict: { verdict: verdict.verdict as "block" | "error", riskScore: verdict.risk_score },
    };
  }

  // ── argv OPERANDS are paths too, and `cat` is not less powerful than `read_file` ──
  // An adversarial review found the asymmetry: `read_file({path:".env"})` is refused by
  // `guardSecretPath`, while `run_command({command:"cat .env"})` classified `read` and was
  // AUTO-APPROVED at A1. Every credential the redactor exists to protect was one `cat` away.
  //
  // Only the credential check is applied here, NOT the working-set scope. That is deliberate:
  // Tier-R's whole purpose is inspecting the MACHINE (`ls /usr/bin`, `ps aux`, `brew list`),
  // so confining argv to the editor's roots would break the feature. A secret path is refused
  // no matter where it lives; an ordinary path outside the roots is fine to read and remains
  // subject to the tier + ladder + nemesis decision already made above.
  for (const stage of parsed.command.parts.flatMap((pp) => pp.pipeline.stages)) {
    for (const arg of stage.argv.slice(1)) {
      if (arg.startsWith("-")) continue;
      const secret = guardSecretPath(resolvePath(arg, cwd));
      if (secret) return secret;
    }
  }

  // ── redirect targets are PATHS, and they are not tool arguments ──────────
  // `pathArgsOf` guards `path`/`cwd`/`file`; a `>` target is buried in the command string,
  // so without this `echo x > ~/.ssh/authorized_keys` would be classified `command` (which
  // A4 auto-approves) and then written with no path check at all.
  if (deps.roots && deps.roots.length > 0) {
    for (const stage of parsed.command.parts.flatMap((pp) => pp.pipeline.stages)) {
      for (const red of stage.redirects) {
        if (red.kind !== "file" || !red.target) continue;
        const abs = resolvePath(red.target, cwd);
        if (!isPathAllowed(abs, [...deps.roots])) {
          return refuse(`refused: redirect target is outside the working set: ${abs}`);
        }
        // A credential path is refused whether it is read from or written to.
        const secret = guardSecretPath(abs);
        if (secret) return secret;
      }
    }
  }

  // ── layer 6: the catastrophic-pattern denylist, LAST ─────────────────────
  // Studio's only guard, promoted to core so both hosts screen against one list. It runs
  // after everything structural has had its say, and it screens the RE-RENDERED command
  // because that is what will actually run.
  //
  // A denylist over a command string cannot hold on its own — that is why it is sixth and
  // not first. If this is ever the only layer that stopped something, the finding is about
  // layers 1-5, not about adding a pattern here.
  const screen = screenCommand(rendered);
  if (screen.blocked) {
    if (deps.home) {
      appendExecAudit(
        deps.home,
        execAuditEntry({
          command: rendered,
          tier: cls.tier,
          verdict: verdict?.verdict ?? "-",
          decision: "refused",
          authLevel: deps.authLevel ?? -1,
          reason: `screen: ${screen.reason}`,
        }),
      );
    }
    return refuse(`refused by the command screen: ${screen.reason} — ${rendered}`);
  }

  // ── layer 7: the OS sandbox, after every app-layer decision has been made ──
  // Nothing above changes. Hooks, the ladder, the confirm, nemesis and the screen have all
  // already allowed this call; the only question left is what the approved argv is permitted
  // to TOUCH once it is running. The writable set is the SAME allowed-paths array the
  // redirect guard above checks against — cwd plus the `/add-dir` roots — and the network
  // bit is the same A5 `install` bit the ladder already uses. See exec-sandbox.ts for a
  // precise account of what this does and does not restrict.
  const sandbox = planExecSandbox({
    writableRoots: [cwd, ...(deps.roots ?? [])],
    ...(deps.authLevel !== undefined ? { authLevel: deps.authLevel } : {}),
    ...(deps.sandboxMode ? { mode: deps.sandboxMode } : {}),
  });
  if (sandbox.kind === "error") {
    // FAIL-CLOSED. A sandbox that could not be built is a refusal, never a downgrade to the
    // app-layer-only posture — the whole point is that this layer cannot be quietly lost.
    if (deps.home) {
      appendExecAudit(
        deps.home,
        execAuditEntry({
          command: commandText,
          tier: cls.tier,
          verdict: verdict?.verdict ?? "-",
          decision: "refused",
          authLevel: deps.authLevel ?? -1,
          reason: describeSandbox(sandbox),
        }),
      );
    }
    return refuse(
      `refused: the OS sandbox could not be established, so the command was not run — ${sandbox.error}`,
    );
  }

  const seconds = num(args.timeoutSeconds);
  const timeoutMs = Math.min(
    seconds !== undefined && seconds > 0 ? seconds * 1000 : DEFAULT_EXEC_TIMEOUT_MS,
    MAX_EXEC_TIMEOUT_MS,
  );

  const mode = str(args.mode) || "collect";
  const stages = parsed.command.parts.flatMap((pp) => pp.pipeline.stages);

  // ── background: hand back a handle, keep the turn moving ─────────────────
  // The command has already been parsed, classified, scanned and approved above —
  // backgrounding changes WHEN the output arrives, never whether the command was allowed.
  if (mode === "background") {
    const job = startJob({
      command: commandText,
      tier: cls.tier,
      /**
       * A background job takes the JOB's signal, not the turn's — deliberately.
       *
       * Backgrounding exists so a long command OUTLIVES the turn that started it; cancelling
       * the turn must not kill it, or `mode:"background"` would mean nothing. It is killed
       * through `job_kill`, which is the handle the model was given for exactly that.
       */
      run: ({ onOutput, signal }) =>
        runParsedCommand(parsed.command, {
          cwd,
          timeoutMs,
          onOutput,
          signal,
          // A backgrounded command is confined by the SAME plan — backgrounding changes when
          // the output arrives, never what the process may do.
          sandbox,
          ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
        }),
    });
    if (deps.home) {
      appendExecAudit(
        deps.home,
        execAuditEntry({
          command: commandText,
          tier: cls.tier,
          verdict: verdict?.verdict ?? "-",
          decision: "auto",
          authLevel: deps.authLevel ?? -1,
          argv: stages.map((st) => st.argv),
          reason: `backgrounded as ${job.id}; ${describeSandbox(sandbox)}`,
        }),
      );
    }
    return done(
      true,
      [
        `started ${job.id} in the background: ${rendered}`,
        `Poll it with job_status("${job.id}") and read it with job_output("${job.id}").`,
      ].join("\n"),
      { jobId: job.id, tier: cls.tier, background: true },
    );
  }

  const r = await runParsedCommand(parsed.command, {
    cwd,
    timeoutMs,
    sandbox,
    // `stream` also writes live; `collect` only captures.
    ...(mode === "stream" && deps.onProgress ? { onOutput: deps.onProgress } : {}),
    ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
    // The turn's cancel reaches the CHILD. Without this the process survived the turn.
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  // The model needs the exit code even when output is empty — "exit 1, no output" and "exit
  // 0, no output" are different answers, and a summary that omits the code hides which.
  // A silent timeout has exactly two explanations and we cannot tell them apart from here:
  // the command was slow, or it blocked on stdin (which it will do forever — stdin is
  // `ignore`). Offering BOTH is the honest framing; an earlier version asserted "waiting for
  // input", which is simply wrong for `sleep 5` and would send the model hunting for a
  // `--yes` flag that does not exist.
  const silentTimeout = r.timedOut && !r.stdout.trim() && !r.stderr.trim();
  const head = r.timedOut
    ? `timed out after ${Math.round(timeoutMs / 1000)}s (killed)${
        silentTimeout
          ? " — it produced no output at all, so it was either slower than the limit (raise timeoutSeconds, or use mode:background) or waiting for input (stdin is closed; re-run it with a non-interactive flag)."
          : ""
      }`
    : r.aborted
      ? // A CANCEL is not a result. It used to report `exit 0`, because a child killed by
        // SIGTERM closes with `code === null` and the close handler left the code at its
        // initial zero — so a cancelled `npm test` was indistinguishable from a passing one,
        // and a model reading it concluded the tests passed. Say what happened, and say that
        // the work is unfinished, because that is the fact the next decision turns on.
        "CANCELLED by the user before it finished — whatever it was doing is incomplete, and any output above is partial"
      : `exit ${r.exitCode}`;
  // When the SANDBOX is what refused, say so. `EPERM` on its own reads as a file-permission
  // problem, and a model that reads it that way retries with `chmod` or `sudo` rather than
  // asking for `/add-dir` — a loop the repeat guard eventually stops, having wasted the turn.
  const hint = r.exitCode === 0 ? null : sandboxHint(sandbox, r.stderr);
  const body = [
    `$ ${describeCommand(parsed.command, cls)}`,
    head,
    r.stdout.trim() ? `\nstdout:\n${r.stdout.trimEnd()}` : "",
    r.stderr.trim() ? `\nstderr:\n${r.stderr.trimEnd()}` : "",
    hint ? `\n${hint}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (deps.home) {
    appendExecAudit(
      deps.home,
      execAuditEntry({
        command: commandText,
        tier: cls.tier,
        verdict: verdict?.verdict ?? "-",
        // The confirm already happened upstream; by the time a command reaches the runner a
        // human either approved it or the ladder did. `auto` is the honest default label —
        // the confirm seam records the human-answered cases itself.
        decision: "auto",
        authLevel: deps.authLevel ?? -1,
        exitCode: r.exitCode,
        argv: r.argvExecuted,
        // What CONFINED it, recorded next to what ran — an audit that cannot tell a
        // sandboxed run from an unsandboxed one cannot answer the question it exists for.
        reason: describeSandbox(sandbox),
      }),
    );
  }

  // `ok` is FALSE for a cancel. It reported true (exit 0) before, which is the same lie as
  // the summary head and reaches the model through a field it trusts more.
  return done(r.exitCode === 0 && !r.timedOut && !r.aborted, body, {
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    aborted: r.aborted,
    durationMs: r.durationMs,
    tier: cls.tier,
    argvExecuted: r.argvExecuted,
  });
}

/**
 * The variables a `run_command` line may expand — the allowlist, never `process.env`.
 *
 * Exported so the confirm seam and the runner build the identical map: if they diverged, a
 * command could be approved in one expansion and executed in another.
 */
export function execVarsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const v = env[name];
    if (typeof v === "string") out[name] = v;
  }
  return out;
}

/* ── job control ─────────────────────────────────────────────────────────────*/

function jobStatus(args: Record<string, unknown>): ToolOutcome {
  const id = str(args.id);
  if (!id) {
    const all = listJobs();
    return done(
      true,
      all.length ? all.map(describeJob).join("\n") : "no background jobs this session",
      { count: all.length },
    );
  }
  const job = getJob(id);
  if (!job)
    return refuse(`no such job: ${id} (it may have finished long enough ago to be forgotten)`);
  return done(true, describeJob(job), {
    id: job.id,
    state: job.state,
    exitCode: job.exitCode,
    tier: job.tier,
  });
}

function jobOutput(args: Record<string, unknown>): ToolOutcome {
  const id = str(args.id);
  if (!id) return refuse("job_output: no job id given");
  const job = getJob(id);
  if (!job) return refuse(`no such job: ${id}`);
  const head = `${describeJob(job)}${job.truncated ? " (output truncated from the front)" : ""}`;
  return done(
    job.state !== "failed",
    [head, job.output.trimEnd() || "(no output yet)"].join("\n"),
    {
      id: job.id,
      state: job.state,
    },
  );
}

function jobKill(args: Record<string, unknown>): ToolOutcome {
  const id = str(args.id);
  if (!id) return refuse("job_kill: no job id given");
  const job = getJob(id);
  if (!job) return refuse(`no such job: ${id}`);
  if (job.state !== "running") return done(true, `${id} already finished (${job.state})`);
  const killed = killJob(id);
  return done(killed, killed ? `sent SIGTERM to ${id}` : `could not signal ${id}`);
}

/* ── elevated proposals (Phase 5 / §7) ───────────────────────────────────────*/

/**
 * `propose_elevated` — the flow that ends in a human, not a spawn.
 *
 * Read this handler for what it does NOT contain: there is no `spawnImpl`, no `runPipeline`,
 * no exec seam of any kind. It cannot run the command it describes even if every check above
 * it were bypassed, which is the property the whole §7 argument rests on. Everything else
 * here is about making the block the human reads honest.
 *
 * It is still SCANNED. Nemesis has rules for exactly this shape of text, and a proposal the
 * scanner calls malicious should not be printed as a neat copyable line with the product's
 * authority behind it. A BLOCK refuses the proposal — the human can still type whatever they
 * like into their own shell, but they will not do it because Prometheus suggested it.
 */
async function proposeElevatedTool(
  args: Record<string, unknown>,
  cwd: string,
  deps: SystemToolDeps,
): Promise<ToolOutcome> {
  const check = checkElevated(
    (args.argv ?? []) as readonly unknown[],
    args.why,
    args.cwd ?? undefined,
  );
  if (!check.ok) return refuse(check.error);
  const proposal: ElevatedProposal = { ...check.proposal, cwd: str(args.cwd) || cwd };
  const line = elevatedCommandLine(proposal);

  const gateMode = deps.gateMode ?? "enforce";
  let verdict: SecurityVerdict | undefined;
  if (gateMode !== "off") {
    verdict = await scanCommand(line, deps.gateImpl ? { gate: deps.gateImpl } : {});
    if (verdictBlocks(verdict, gateMode)) {
      if (deps.home) {
        appendExecAudit(
          deps.home,
          execAuditEntry({
            command: line,
            tier: "destructive",
            verdict: verdict.verdict,
            decision: "blocked",
            authLevel: deps.authLevel ?? -1,
            argv: [[...proposal.argv]],
            reason: verdict.findings.map((f) => f.where).join("; ") || verdict.verdict,
          }),
        );
      }
      return {
        ok: false,
        summary: [
          `refused by the nemesis gate (${verdict.verdict}): ${line}`,
          ...verdict.findings.map((f) => `  - ${f.where}`),
        ].join("\n"),
        verdict: { verdict: verdict.verdict as "block" | "error", riskScore: verdict.risk_score },
      };
    }
  }

  // The proposal is a real event even though nothing ran — "the agent asked for root, here is
  // the exact command and why" is precisely what an audit should be able to answer later.
  if (deps.home) {
    appendExecAudit(
      deps.home,
      execAuditEntry({
        command: line,
        tier: "destructive",
        verdict: verdict?.verdict ?? "-",
        decision: "proposed",
        authLevel: deps.authLevel ?? -1,
        argv: [[...proposal.argv]],
        reason: proposal.why,
      }),
    );
  }

  return {
    ok: true,
    summary: renderElevated(proposal, verdict ? { verdict: verdict.verdict } : undefined),
    data: { elevated: true, command: line, argv: [...proposal.argv], why: proposal.why },
  };
}

/* ── the dispatcher ──────────────────────────────────────────────────────────*/

/**
 * Run one Tier-R tool. Returns `null` when `name` is not a system tool, so the caller's
 * dispatch chain can fall through to the engine.
 */
export async function runSystemTool(
  name: string,
  args: Record<string, unknown>,
  deps: SystemToolDeps,
): Promise<ToolOutcome | null> {
  const exec = deps.exec ?? defaultExec;
  const base = deps.cwd || process.cwd?.() || ".";
  // `cwd` is model-supplied for the git tools; the working-set guard has already vetted it
  // (PATH_KEYS includes `cwd`), and a flag-shaped value is refused here.
  const argCwd = str(args.cwd);
  if (argCwd && !safeToken(argCwd)) {
    return refuse(`refusing a cwd that looks like a flag: ${argCwd}`);
  }
  const cwd = argCwd ? resolvePath(argCwd, base) : base;

  switch (name) {
    case "read_file":
      return readFileTool(args, base);
    case "list_dir":
      return listDir(args, base);
    case "stat_path":
      return statPath(args, base);
    case "grep":
      return grepTool(exec, args, base);
    case "glob":
      return globTool(exec, args, base);
    case "semantic_search":
      return semanticSearchTool(args, base, {
        ...(deps.embedImpl ? { embed: deps.embedImpl } : {}),
        ...(deps.home ? { home: deps.home } : {}),
        ...(deps.embedModel ? { embedModel: deps.embedModel } : {}),
      });
    case "git_status":
      return gitStatus(exec, cwd);
    case "git_diff":
      return gitDiff(exec, cwd, args);
    case "git_log":
      return gitLog(exec, cwd, args);
    case "git_show":
      return gitShow(exec, cwd, args);
    case "system_info":
      return systemInfo(exec);
    case "gpu_info":
      return gpuInfo(exec);
    case "process_list":
      return processList(exec, args);
    case "which":
      return whichTool(exec, args);
    case "package_list":
      return packageList(exec, args);
    case "env_get":
      return envGet(args);
    case "run_command":
      return runCommandTool(args, cwd, deps);
    case "job_status":
      return jobStatus(args);
    case "job_output":
      return jobOutput(args);
    case "job_kill":
      return jobKill(args);
    case "propose_elevated":
      return proposeElevatedTool(args, cwd, deps);
    case "memory_write":
    case "memory_read":
      // Project-scoped, not cwd-scoped in the model-supplied-`cwd` sense the git tools use:
      // memory keys off the REPO the session is in, so it uses `base` (the session's own
      // working directory), never a per-call override.
      return runMemoryTool(name, args, { cwd: base, home: deps.home ?? prometheusHome() });
    default:
      /**
       * Tier W (delete / move / mkdir) — dispatched here so BOTH hosts get them.
       *
       * They were declared in core and implemented only in the CLI, so the desktop agent could
       * read, edit and write a file but not remove or rename one, and this switch answered
       * "not a system tool" for all three.
       */
      return runFsMutateTool(name, args, {
        cwd,
        ...(deps.roots ? { roots: deps.roots } : {}),
        ...(deps.approvedOutside ? { approvedOutside: deps.approvedOutside } : {}),
        ...(deps.onPreImage ? { onPreImage: deps.onPreImage } : {}),
      });
  }
}

/** Re-exported so the runner can refuse a credential path before it even resolves a tool. */
export { isSecretPath, sep };
