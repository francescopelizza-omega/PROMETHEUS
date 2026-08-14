/**
 * tool-runner.ts — the `ToolRunner` seam core's `runAgentTurn` asks for, implemented for VS Code.
 *
 * This is the direct analogue of the desktop pane's `createRendererToolRunner`
 * (apps/desktop/src/renderer/ide/ai/core-agent.ts): core does ALL the gating — the `--force`
 * ban, the §4.3 annotation broker, the confirm-default-deny, the byte cap — and by the time a
 * call reaches this function it has already been approved. Do NOT re-decide anything here, or
 * there are two policies and the one that matters is whichever ran last.
 *
 * PURE with respect to VS Code: this module imports `@prometheus/core` and nothing else. Every
 * filesystem effect goes through the injected `WorkspaceIo`, which is what lets the dispatch be
 * exercised against an in-memory double while the shipped path is `vscode.workspace.fs` /
 * `vscode.workspace.applyEdit`. See workspace-io.ts's header for why raw `node:fs` is banned.
 */

import type { ToolOutcome } from "@prometheus/core/agent-loop";
import { APPLY_PATCH_TOOL } from "@prometheus/core/agent-patch";
import {
  DELETE_FILE_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  LIST_DIR_TOOL,
  MKDIR_TOOL,
  MOVE_FILE_TOOL,
  READ_FILE_TOOL,
  isSecretPath,
  redactSecrets,
  secretPathReason,
  secretRefusal,
} from "@prometheus/core/agent-system";
import { TODO_TOOLS, TodoStore, runTodoTool } from "@prometheus/core/agent-todo";
import type { ToolDef } from "@prometheus/core/agent-tools";

import { type FileMutation, type WorkspaceIo, normalizeWorkspaceRelPath } from "./workspace-io.js";

/* ── the exposed set ─────────────────────────────────────────────────────────*/

/**
 * The tools this host can ACTUALLY execute, passed to the tuning as `tools.extra`.
 *
 * The selection rule is the one core's own headers state: never advertise a tool the host
 * cannot dispatch, because a model that is offered one learns to keep proposing it and the
 * user reads the resulting refusals as the agent being broken. So `run_command`, the git
 * tools, `web_fetch`, the browser set, the `prometheus_*` engine verbs and MCP are all absent —
 * every one of them needs a process, a network proxy or an engine this MVP does not wire. See
 * README.md "Scoped out".
 *
 * `propose_edit` and `write_file` are NOT here: they live in core's base catalog (`AGENT_TOOLS`),
 * so allow-listing their names is enough and re-declaring them would shadow the canonical defs.
 */
export const VSCODE_EXTRA_TOOLS: readonly ToolDef[] = [
  READ_FILE_TOOL,
  LIST_DIR_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  APPLY_PATCH_TOOL,
  DELETE_FILE_TOOL,
  MOVE_FILE_TOOL,
  MKDIR_TOOL,
  ...TODO_TOOLS,
];

/** The allow-list (a WHITELIST — a tool absent from here is never shown to the model). */
export const VSCODE_TOOL_ALLOW: readonly string[] = [
  ...VSCODE_EXTRA_TOOLS.map((t) => t.name),
  // From core's base catalog.
  "propose_edit",
  "write_file",
];

/* ── the runner ──────────────────────────────────────────────────────────────*/

export interface VsCodeToolDeps {
  io: WorkspaceIo;
  /** A visible tool-activity note for the chat transcript. */
  onToolNote(note: string): void;
  /** Per-session task list. Injected so it outlives a single turn. */
  todos?: TodoStore;
}

const MAX_READ_LINES = 2000;
const MAX_GREP_MATCHES = 200;
const MAX_GLOB_RESULTS = 500;

export function createVsCodeToolRunner(
  deps: VsCodeToolDeps,
): (tool: ToolDef, args: Record<string, unknown>) => Promise<ToolOutcome> {
  const todos = deps.todos ?? new TodoStore();

  return async (tool, args) => {
    deps.onToolNote(toolNote(tool.name, args));
    try {
      return await dispatch(tool.name, args, deps.io, todos);
    } catch (e) {
      // A thrown FileSystemError (ENOENT, EISDIR, permission) is an ordinary tool FAILURE, not
      // a crashed turn: it comes back as `ok:false` so the model can re-plan, which is the
      // whole reason the loop folds tool results back into the thread.
      return { ok: false, summary: errText(e) };
    }
  };
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  io: WorkspaceIo,
  todos: TodoStore,
): Promise<ToolOutcome> {
  switch (name) {
    case "read_file":
      return readFile(args, io);
    case "list_dir":
      return listDir(args, io);
    case "glob":
      return globFiles(args, io);
    case "grep":
      return grep(args, io);

    case "propose_edit":
      return proposeEdit(args, io);
    case "write_file":
      return writeFile(args, io);
    case "apply_patch":
      return applyPatch(args, io);

    case "delete_file":
      return mutate(io, args.path, (p) => ({
        kind: "delete",
        path: p,
        recursive: args.recursive === true,
      }));
    case "move_file": {
      const from = rel(args.from);
      const to = rel(args.to);
      if (!from || !to) return bad("`from` and `to` must be workspace-relative paths");
      const r = await io.applyMutations([
        { kind: "rename", from, to, overwrite: args.overwrite === true },
      ]);
      return r.ok ? { ok: true, summary: `moved ${from} → ${to}` } : bad(r.error ?? "move failed");
    }
    case "mkdir":
      return mutate(io, args.path, (p) => ({ kind: "mkdir", path: p }));

    case "todowrite":
    case "todoread": {
      const out = runTodoTool(name, args, todos);
      return out ?? bad(`${name} is unavailable`);
    }

    default:
      // Unreachable via the allow-list, but a host that silently succeeds on an unknown tool
      // is how a typo becomes a phantom capability.
      return bad(`tool "${name}" is not available in the VS Code extension`);
  }
}

/* ── reads ───────────────────────────────────────────────────────────────────*/

async function readFile(args: Record<string, unknown>, io: WorkspaceIo): Promise<ToolOutcome> {
  const path = rel(args.path);
  if (!path) return bad(pathError(args.path));
  // The credential-file refusal core documents for this tool. Tool output is folded into the
  // model's context and may travel to a cloud endpoint, so .env / *.pem / ~/.ssh never read.
  if (isSecretPath(path)) {
    return bad(secretRefusal(path, secretPathReason(path) ?? "credential file"));
  }
  const text = await io.readFile(path);
  const all = text.split("\n");
  const offset = Math.max(1, num(args.offset) ?? 1);
  const limit = Math.max(1, num(args.limit) ?? MAX_READ_LINES);
  const slice = all.slice(offset - 1, offset - 1 + limit);
  // The `N  ` gutter core's tool description promises. Line numbers are what let a model cite
  // a location back, and the description explicitly tells it to strip them before quoting.
  const width = String(offset + slice.length - 1).length;
  const body = slice.map((l, i) => `${String(offset + i).padStart(width)}  ${l}`).join("\n");
  const more = all.length > offset - 1 + slice.length;
  return {
    ok: true,
    // Every read is scrubbed — a token pasted into a source file must not reach the model.
    summary: redactSecrets(more ? `${body}\n…[${all.length} lines total]` : body).text,
  };
}

async function listDir(args: Record<string, unknown>, io: WorkspaceIo): Promise<ToolOutcome> {
  const path = rel(args.path) ?? "";
  const depth = Math.min(4, Math.max(1, num(args.depth) ?? 1));
  const lines: string[] = [];
  await walk(io, path, depth, lines);
  return { ok: true, summary: lines.length > 0 ? lines.join("\n") : "(empty)" };
}

async function walk(io: WorkspaceIo, dir: string, depth: number, out: string[]): Promise<void> {
  const entries = await io.readDirectory(dir);
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = dir ? `${dir}/${e.name}` : e.name;
    out.push(e.kind === "directory" ? `${p}/` : p);
    if (e.kind === "directory" && depth > 1 && e.name !== "node_modules" && e.name !== ".git") {
      await walk(io, p, depth - 1, out);
    }
  }
}

async function globFiles(args: Record<string, unknown>, io: WorkspaceIo): Promise<ToolOutcome> {
  const pattern = str(args.pattern);
  if (!pattern) return bad("`pattern` is required");
  const hits = await io.findFiles(pattern, MAX_GLOB_RESULTS);
  return { ok: true, summary: hits.length > 0 ? hits.join("\n") : `no files match ${pattern}` };
}

/**
 * Content search, implemented by reading candidate files through `WorkspaceIo`.
 *
 * VS Code's own text search (`workspace.findTextInFiles`) is still PROPOSED API — it cannot be
 * called from a published extension, only from one launched with `--enable-proposed-api`. So
 * this reads the candidate set via `workspace.fs`, which is slower than ripgrep but is still
 * VS Code's filesystem layer and therefore still correct on Remote-SSH and virtual workspaces.
 * A ripgrep subprocess would be faster and would read the wrong machine.
 */
async function grep(args: Record<string, unknown>, io: WorkspaceIo): Promise<ToolOutcome> {
  const pattern = str(args.pattern) ?? str(args.query);
  if (!pattern) return bad("`pattern` is required");
  let re: RegExp;
  try {
    re = new RegExp(pattern, args.ignoreCase === true ? "i" : "");
  } catch (e) {
    return bad(`invalid regular expression: ${errText(e)}`);
  }
  const cap = Math.max(1, num(args.maxMatches) ?? MAX_GREP_MATCHES);
  const glob = str(args.glob) ?? "**/*";
  const scope = rel(args.path);
  const candidates = await io.findFiles(scope ? `${scope}/${glob}` : glob, MAX_GLOB_RESULTS);

  const hits: string[] = [];
  for (const file of candidates) {
    if (hits.length >= cap) break;
    let text: string;
    try {
      text = await io.readFile(file);
    } catch {
      continue; // unreadable/binary — skip rather than fail the whole search
    }
    // A NUL byte is the cheap binary sniff: matching a regex line-by-line against a decoded
    // binary produces megabytes of mojibake "hits" that poison the model's context.
    if (text.includes("\u0000")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < cap; i++) {
      const line = lines[i] ?? "";
      if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
    }
  }
  return {
    ok: true,
    summary: hits.length > 0 ? redactSecrets(hits.join("\n")).text : `no matches for ${pattern}`,
  };
}

/* ── mutations (all through ONE WorkspaceEdit) ───────────────────────────────*/

async function proposeEdit(args: Record<string, unknown>, io: WorkspaceIo): Promise<ToolOutcome> {
  const parsed = parseEdit(args);
  if (!parsed.ok) return bad(parsed.error);
  const r = await io.applyMutations([{ kind: "replace", path: parsed.path, spans: parsed.spans }]);
  return r.ok
    ? { ok: true, summary: `applied ${parsed.spans.length} hunk(s) to ${parsed.path}` }
    : bad(r.error ?? "the edit could not be applied");
}

async function writeFile(args: Record<string, unknown>, io: WorkspaceIo): Promise<ToolOutcome> {
  const path = rel(args.path);
  if (!path) return bad(pathError(args.path));
  const content = str(args.content);
  if (content === undefined) return bad("`content` is required");
  const r = await io.applyMutations([{ kind: "create", path, content, overwrite: true }]);
  return r.ok ? { ok: true, summary: `wrote ${path}` } : bad(r.error ?? "the write failed");
}

/**
 * A multi-file patch, applied as ONE `WorkspaceEdit` — therefore ONE undo entry.
 *
 * This is the concrete payoff of `applyMutations` taking an array. Looping `propose_edit` N
 * times would produce N separate undo steps, so a user rejecting a bad refactor would have to
 * press Ctrl+Z once per file and would have no way to know when they had gone far enough.
 */
async function applyPatch(args: Record<string, unknown>, io: WorkspaceIo): Promise<ToolOutcome> {
  const raw = args.edits;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? (() => {
          // Models send a JSON string where an array was asked for constantly; losing the whole
          // patch to that is a far worse outcome than a lenient parse.
          try {
            const p: unknown = JSON.parse(raw);
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
      : [];
  if (list.length === 0) return bad("edits must be a non-empty array of {path, hunks:[{old,new}]}");

  const muts: FileMutation[] = [];
  const paths: string[] = [];
  for (const item of list) {
    const parsed = parseEdit((item ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return bad(parsed.error);
    muts.push({ kind: "replace", path: parsed.path, spans: parsed.spans });
    paths.push(parsed.path);
  }
  const r = await io.applyMutations(muts);
  return r.ok
    ? { ok: true, summary: `applied a patch across ${paths.length} file(s): ${paths.join(", ")}` }
    : bad(r.error ?? "the patch could not be applied");
}

type ParsedEdit =
  | { ok: true; path: string; spans: { oldText: string; newText: string }[] }
  | { ok: false; error: string };

/** Validate `{path, hunks:[{old,new}]}` — the shape both `propose_edit` and `apply_patch` use. */
function parseEdit(args: Record<string, unknown>): ParsedEdit {
  const path = rel(args.path);
  if (!path) return { ok: false, error: pathError(args.path) };
  const raw = args.hunks;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? (() => {
          try {
            const p: unknown = JSON.parse(raw);
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
      : [];
  const spans: { oldText: string; newText: string }[] = [];
  for (const h of list) {
    const o = h as Record<string, unknown>;
    const oldText = str(o.old) ?? str(o.oldText);
    const newText = str(o.new) ?? str(o.newText);
    if (oldText === undefined || newText === undefined) {
      return { ok: false, error: "each hunk must be {old, new} with both as strings" };
    }
    if (oldText === "") {
      return { ok: false, error: "a hunk's `old` must be a non-empty pre-image" };
    }
    spans.push({ oldText, newText });
  }
  if (spans.length === 0) return { ok: false, error: "`hunks` must be a non-empty array" };
  return { ok: true, path, spans };
}

async function mutate(
  io: WorkspaceIo,
  rawPath: unknown,
  build: (p: string) => FileMutation,
): Promise<ToolOutcome> {
  const path = rel(rawPath);
  if (!path) return bad(pathError(rawPath));
  const r = await io.applyMutations([build(path)]);
  return r.ok ? { ok: true, summary: `ok: ${path}` } : bad(r.error ?? "the change failed");
}

/* ── helpers ─────────────────────────────────────────────────────────────────*/

function rel(v: unknown): string | null {
  return typeof v === "string" ? normalizeWorkspaceRelPath(v) : null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bad(summary: string): ToolOutcome {
  return { ok: false, summary };
}
function pathError(v: unknown): string {
  return `"${String(v)}" is not a workspace-relative path — absolute paths and paths escaping the workspace root are refused`;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A short human note for the transcript — what the panel shows while a tool runs. */
export function toolNote(name: string, args: Record<string, unknown>): string {
  const a = (k: string): string => (args[k] === undefined ? "" : ` ${String(args[k])}`);
  switch (name) {
    case "read_file":
      return `read${a("path")}`;
    case "list_dir":
      return `list${a("path")}`;
    case "glob":
      return `glob ${String(args.pattern ?? "")}`;
    case "grep":
      return `grep "${String(args.pattern ?? args.query ?? "")}"`;
    case "propose_edit":
      return `edit${a("path")}`;
    case "write_file":
      return `write${a("path")}`;
    case "apply_patch":
      return "apply a multi-file patch";
    case "delete_file":
      return `delete${a("path")}`;
    case "move_file":
      return `move ${String(args.from ?? "")} → ${String(args.to ?? "")}`;
    case "mkdir":
      return `mkdir${a("path")}`;
    default:
      return name;
  }
}
