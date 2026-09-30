/**
 * ai/local-commands.ts — PURE built-in slash commands the AgentPane answers LOCALLY, without a
 * model call. Today: `/ls`, the same command the terminal TUI has — a quick check that the agent
 * is pointed at the folder the user thinks it is.
 *
 * Their output is posted as a LOCAL transcript turn: shown in the pane, never sent to the model
 * as history, never archived (see `AiTurn.local`). No react/IPC import, so it is node:test-able;
 * the pane does the one IPC read (`ide:fs.tree`, one directory level) and hands the nodes here.
 */
import type { IdeTreeNode } from "../../../shared/ipc-contract.js";
import type { SlashCommand } from "./slash.js";

/**
 * The rows the `/` popup shows for local built-ins, PREPENDED to the palette rows. The title
 * starts with the command word, so `/ls` ranks as an exact prefix — without this row the popup's
 * substring match picked "Toggle Folding Regions (LSP)" and Enter ran that instead.
 */
export const BUILTIN_SLASH_ROWS: readonly SlashCommand[] = [
  { id: "builtin:ls", title: "ls — list the files in the workspace folder", category: "Built-in" },
  { id: "builtin:cat", title: "cat — print a file in the pane", category: "Built-in" },
  { id: "builtin:in", title: "in — set where produced files are saved", category: "Built-in" },
];

export interface LsInvocation {
  /** a sub-path relative to the workspace folder, or an absolute path; "" = the folder itself */
  path: string;
  /** include dotfiles */
  all: boolean;
}

/**
 * Parse a composer line as `/ls [path] [-a]`. `null` when the line is not `/ls` at all (so it is
 * sent to the model as usual); `{ error }` for `/ls` with bad arguments.
 */
export function matchLsCommand(text: string): LsInvocation | { error: string } | null {
  const m = /^\/ls(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  let all = false;
  const paths: string[] = [];
  for (const tok of (m[1] ?? "").split(/\s+/).filter(Boolean)) {
    if (tok === "-a" || tok === "--all") all = true;
    else if (tok.startsWith("-")) return { error: `unknown option ${tok} — try /ls [path] [-a]` };
    else paths.push(tok);
  }
  if (paths.length > 1) return { error: "one folder at a time — /ls [path] [-a]" };
  return { path: paths[0] ?? "", all };
}

/** The folder to list: the workspace folder, a sub-path of it, or an absolute path as given. */
export function lsTarget(root: string, sub: string): string {
  if (!sub || sub === ".") return root;
  if (sub.startsWith("/")) return sub;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${base}/${sub.replace(/^\.\//, "").replace(/\/+$/, "")}`;
}

/** The directory a listing came from: its own path, or — for a relative `.` — the parent of any
 *  entry (main resolves `.` against its own cwd and returns ABSOLUTE child paths). */
function shownDir(dir: string, nodes: readonly IdeTreeNode[]): string {
  if (dir !== "." || nodes.length === 0) return dir;
  const first = nodes[0]?.path ?? "";
  const cut = first.lastIndexOf("/");
  return cut > 0 ? first.slice(0, cut) : dir;
}

/** More than this and the listing is cut with a count — the pane is not a file manager. */
export const LS_MAX_ENTRIES = 400;

/**
 * The transcript text for a listing: a header naming the folder (the answer to "is this the
 * right folder?"), the counts, and the entries — folders first with a trailing `/` (the order
 * `ide:fs.tree` already returns) — in a fenced block so names render verbatim.
 */
export function formatLsTurn(opts: {
  dir: string;
  nodes: readonly IdeTreeNode[];
  all: boolean;
  folderOpen: boolean;
}): string {
  const where = shownDir(opts.dir, opts.nodes);
  const lines: string[] = [];
  if (!opts.folderOpen) {
    lines.push(
      "⚠ No folder is open, so the agent works in the app's own launch folder. Open a folder to point Prometheus at a project.",
      "",
    );
  }
  const visible = opts.all ? [...opts.nodes] : opts.nodes.filter((n) => !n.name.startsWith("."));
  const hidden = opts.nodes.length - visible.length;
  const dirs = visible.filter((n) => n.kind === "dir").length;
  const files = visible.length - dirs;
  const counts = [
    `${dirs} folder${dirs === 1 ? "" : "s"}`,
    `${files} file${files === 1 ? "" : "s"}`,
    ...(hidden > 0 ? [`${hidden} hidden (\`/ls -a\`)`] : []),
  ].join(", ");
  lines.push(`**/ls** — \`${where}\` · ${counts}`);
  if (visible.length === 0) {
    // ide:fs.tree answers [] for an empty folder AND for a refused or unreadable one.
    lines.push("", "_(empty, or not readable)_");
    return lines.join("\n");
  }
  const shown = visible.slice(0, LS_MAX_ENTRIES);
  const body = shown.map((n) => (n.kind === "dir" ? `${n.name}/` : n.name));
  if (visible.length > shown.length) body.push(`… and ${visible.length - shown.length} more`);
  // A fence the names cannot close: longer than any backtick run inside them.
  const longest = Math.max(
    0,
    ...body.map((b) => Math.max(0, ...(b.match(/`+/g) ?? []).map((r) => r.length))),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  lines.push("", fence, ...body, fence);
  return lines.join("\n");
}

/* ══ /cat ════════════════════════════════════════════════════════════════════
 * The terminal's `/cat`, in the pane. It cannot share `apps/cli/src/session/cat.ts`:
 * pnpm's `nodeLinker: isolated` means the desktop may import only what it declares, and the
 * renderer is sandboxed anyway (no node:fs) — it reads through the `ide:fs.read` IPC and
 * formats here.
 *
 * Output is a VERBATIM turn (`AiTurn.pre`), never a markdown fence. The fence route is not
 * merely risky, it is broken for this job: markdown-parse.ts opens on `^```` and closes ONLY on
 * a line that is exactly ``` — so a file containing a bare fence ends the block early and the
 * rest of the file renders as markdown, while a longer fence never closes at all. `/ls` gets
 * away with a fence because its listing is the last thing in the turn; a file is not.
 */

/** The GUI cap is tighter than the terminal's 500: every turn is persisted to localStorage
 *  against a ~5 MB quota that stores.ts already documents as a known cliff. */
export const CAT_MAX_LINES = 300;

export interface CatInvocation {
  /** a sub-path of the workspace folder, or an absolute path */
  path: string;
  /** lift the line cap */
  all: boolean;
}

/** Parse `/cat <file> [-a]`. `null` when the line is not `/cat` (so it goes to the model). */
export function matchCatCommand(text: string): CatInvocation | { error: string } | null {
  const m = /^\/cat(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  let all = false;
  const paths: string[] = [];
  for (const tok of (m[1] ?? "").split(/\s+/).filter(Boolean)) {
    if (tok === "-a" || tok === "--all") all = true;
    // an unrecognised flag is an error, never a filename — the option-injection guard
    else if (tok.startsWith("-")) return { error: `unknown option ${tok} — try /cat <file> [-a]` };
    else paths.push(tok);
  }
  if (paths.length === 0) return { error: "usage: /cat <file> [-a]" };
  if (paths.length > 1) return { error: "one file at a time — /cat <file> [-a]" };
  return { path: paths[0] as string, all };
}

/**
 * Render control bytes in caret notation (`^[`, `^G`), as `cat -v` does.
 *
 * Less critical than in the TUI — a browser will not act on an ESC — but a file full of raw
 * control bytes still renders as invisible garbage, and keeping both surfaces' output identical
 * is worth more than the few bytes saved.
 */
function caretEscape(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `^${code === 0x7f ? "?" : String.fromCharCode(code + 64)}`;
  });
}

/** The verbatim body of a `/cat` turn: a header line, then the file behind a number gutter. */
export function formatCatTurn(opts: {
  path: string;
  read: { ok: boolean; text?: string; large?: boolean; error?: string };
  all: boolean;
}): string {
  const { path, read } = opts;
  if (!read.ok) return `/cat — ${read.error ?? `cannot read ${path}`}`;
  const text = read.text ?? "";
  // BINARY: `ide:fs.read` has no binary sniff of its own and will happily decode a PNG.
  if (text.includes("\u0000")) return `/cat — ${path} is a binary file — not shown`;

  const raw = text.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const cap = opts.all ? Number.POSITIVE_INFINITY : CAT_MAX_LINES;
  const shown = raw.length > cap ? raw.slice(0, cap) : raw;
  const gutter = String(shown.length).length;

  const head = `${path} · ${shown.length} line${shown.length === 1 ? "" : "s"}${
    read.large ? " · large file" : ""
  }`;
  if (shown.length === 0) return `${head}\n(empty file)`;
  const body = shown.map(
    (l, i) => `${String(i + 1).padStart(gutter)} │ ${caretEscape(l.replace(/\r$/, ""))}`,
  );
  if (raw.length > shown.length) {
    body.push(`… first ${shown.length} of ${raw.length} lines — /cat ${path} -a for everything`);
  }
  return `${head}\n${body.join("\n")}`;
}

/* ══ /in ═════════════════════════════════════════════════════════════════════
 * Where produced files go — the pane's twin of the terminal's `/in`.
 *
 * Duplicated rather than shared for the same reason `/ls` is: the renderer is a sandboxed
 * view (C5) and may not import `@prometheus/core`, so the two surfaces keep parallel PURE
 * implementations and identical wording. Keep them in step.
 *
 * The GRANT is what makes this more than a preference. Writes are gated in MAIN by
 * `assertInsideWorkingSet`, and `ide:workingSet.set` is NARROWING-ONLY — the renderer cannot
 * widen the agent's write scope, by design. The sanctioned widening is
 * `approveOutsideWorkingSet(path, "session")`: one explicit path, never a wildcard, cleared
 * whenever the roots change. A `/in` the HUMAN typed in the composer is exactly the event that
 * approval exists for, which is why `/in` may call it and the model may not.
 */

export type InInvocation =
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; path: string }
  | { error: string };

const IN_USAGE = "/in <folder> | /in | /in --clear";

/** Parse `/in [folder|--clear]`. `null` when the line is not `/in` at all. */
export function matchInCommand(text: string): InInvocation | null {
  const m = /^\/in(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const arg = (m[1] ?? "").trim();
  if (!arg) return { action: "show" };
  if (arg === "--clear" || arg === "-c" || arg === "off" || arg === "reset")
    return { action: "clear" };
  if (arg.startsWith("-")) return { error: `unknown option ${arg} — ${IN_USAGE}` };
  const quoted = /^"([^"]+)"$|^'([^']+)'$/.exec(arg);
  return { action: "set", path: quoted ? ((quoted[1] ?? quoted[2]) as string) : arg };
}

export interface InDirective {
  /** the message with the `/in …` directive removed */
  prompt: string;
  /** the raw folder that followed `/in`, or null when there was no directive */
  dir: string | null;
}

/**
 * Pull an inline `/in <folder>` out of a free-text message — "… and save it /in ~/Downloads".
 *
 * Matched only as a whole token followed by whitespace, so `/info`, `/install` and a bare
 * trailing `/in` are left alone. The LAST directive wins and every occurrence is stripped.
 */
export function extractInDirective(text: string): InDirective {
  const re = /(^|\s)\/in\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let dir: string | null = null;
  const prompt = text
    .replace(re, (_all, lead: string, dq?: string, sq?: string, bare?: string) => {
      dir = dq ?? sq ?? bare ?? null;
      return lead;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { prompt, dir };
}

/** The sentence the model is told when an output folder is in force. Identical to the CLI's. */
export function outputDirNote(dir: string): string {
  return `Output directory for produced files: ${dir}\nWrite anything this turn produces (downloads, conversions, exports) into that folder — pass it explicitly to the command (for example \`-o\`, \`-P\`, or an absolute output path). It is writable; the session working directory is unchanged and still where you read from.`;
}

/** The `/in` status turn: where writes go now, and how to change it. */
export function formatInTurn(dir: string | null, root: string): string {
  if (!dir) {
    return `**/in** — _not set_\n\nProduced files go to the workspace folder: \`${root}\`\nSet one with \`/in <folder>\`, or inline: “… save it /in ~/Downloads”.`;
  }
  return `**/in** — \`${dir}\`\n\nProduced files go here, and the agent may write here. Reading is unchanged.\n\`/in --clear\` to unset.`;
}
