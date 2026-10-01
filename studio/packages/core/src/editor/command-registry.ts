// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * editor/command-registry.ts — the EDITOR command registry (file 07 §8).
 *
 * `CommandPalette.tsx` is fed by THIS registry — the single source of editor
 * command ids shared with `prometheus` (file 11) and the menu/keybind system. It is the
 * NEW, complementary editor-surface registry: distinct from the engine parity
 * router (`commands.ts`, which maps the full prometheus.py/nemesis surface) and
 * from the M1 `commands/registry.ts` (the hand-tuned provider/scan summaries).
 *
 * The `prometheus.*` commands here do NOT duplicate the engine router — they
 * COMPOSE it: `prometheus.scan` / `prometheus.audit` delegate to the existing
 * `commands.ts` `invoke(id, …)` so there is exactly one engine-routing table.
 *
 * GOLDEN RULE (C5): nothing here decides "safe". `gate.runWorkspaceScan` routes
 * the workspace through the engine nemesis gate (the run-gate, §5.2); the editor
 * never reimplements the verdict. Framework-free: NO monaco/react/electron — a
 * command's `run` is handed a CommandCtx the host fills with the real bindings.
 *
 * Node built-ins only.
 */
import { type RouterContext, type RouterResult, invoke } from "../commands.js";

/* ------------------------------------------------------------------------- *
 * Categories & the command shape (file 07 §8)
 * ------------------------------------------------------------------------- */

/** The palette/menu categories (file 07 §8). */
export type EditorCommandCategory =
  | "File"
  | "Edit"
  | "Go"
  | "Run"
  | "Git"
  | "AI"
  | "Security"
  | "View"
  | "Terminal";

/**
 * The runtime context handed to an editor command's `run`. The host (renderer
 * shell / `prometheus`) fills the bindings; core never reaches past them. `engine` is
 * the parity-router context used to delegate `prometheus.*` ids (§8/§10).
 */
export interface EditorCommandCtx {
  /** the live context keys (`editorFocus`, `pythonFile`, …) for `when`. */
  contextKeys: Readonly<Record<string, boolean | string | number>>;
  /** the parity-router context, present when a command delegates to the engine. */
  engine?: RouterContext;
  /** arbitrary host-supplied args (workspace root, selection, file uri, …). */
  args?: Readonly<Record<string, unknown>>;
}

/** The normalised result an editor command resolves to. */
export interface EditorCommandResult {
  id: string;
  ok: boolean;
  /** a short summary line for the palette toast / `prometheus` stdout. */
  summary: string;
  /** the engine RouterResult, when the command delegated to the engine. */
  engineResult?: RouterResult;
}

/** A registered editor command (file 07 §8). */
export interface EditorCommand {
  /** stable id, e.g. 'ai.inlineEdit' | 'gate.runWorkspaceScan' | 'prometheus.scan'. */
  id: string;
  title: string;
  category: EditorCommandCategory;
  /** context-key expression, e.g. 'editorFocus && pythonFile' (evaluated by `when`). */
  when?: string;
  /** default keybind, e.g. 'cmd+k'. */
  default?: string;
  run(ctx: EditorCommandCtx): EditorCommandResult | Promise<EditorCommandResult>;
}

/* ------------------------------------------------------------------------- *
 * The `when` context-key evaluator (a tiny, dependency-free boolean expr parser)
 * ------------------------------------------------------------------------- */

/**
 * Evaluate a VS-Code-style `when` expression against a context-key bag. Supports
 * the common subset: `&&`, `||`, `!`, parentheses, bare keys (truthy), and
 * `key == value` / `key != value` equality. An empty/undefined expression is
 * always true (the command is unconditional). Pure & total: an unparseable
 * expression evaluates to `false` (fail-safe — the command just won't show).
 */
export function evaluateWhen(
  expr: string | undefined,
  keys: Readonly<Record<string, boolean | string | number>>,
): boolean {
  if (!expr || expr.trim() === "") return true;
  try {
    const tokens = tokenizeWhen(expr);
    const parser = new WhenParser(tokens, keys);
    const value = parser.parseOr();
    parser.expectEnd();
    return value;
  } catch {
    return false;
  }
}

type WhenToken =
  | { t: "id"; v: string }
  | { t: "str"; v: string }
  | { t: "op"; v: "&&" | "||" | "!" | "(" | ")" | "==" | "!=" };

function tokenizeWhen(expr: string): WhenToken[] {
  const out: WhenToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "&" && expr[i + 1] === "&") {
      out.push({ t: "op", v: "&&" });
      i += 2;
      continue;
    }
    if (c === "|" && expr[i + 1] === "|") {
      out.push({ t: "op", v: "||" });
      i += 2;
      continue;
    }
    if (c === "=" && expr[i + 1] === "=") {
      out.push({ t: "op", v: "==" });
      i += 2;
      continue;
    }
    if (c === "!" && expr[i + 1] === "=") {
      out.push({ t: "op", v: "!=" });
      i += 2;
      continue;
    }
    if (c === "!") {
      out.push({ t: "op", v: "!" });
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < expr.length && expr[j] !== c) {
        s += expr[j];
        j++;
      }
      if (j >= expr.length) throw new Error("unterminated string");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    // bare identifier / literal (key name, true/false, numbers, dotted keys)
    const m = /^[A-Za-z0-9_.:-]+/.exec(expr.slice(i));
    if (!m) throw new Error(`unexpected char "${c}"`);
    out.push({ t: "id", v: m[0] });
    i += m[0].length;
  }
  return out;
}

class WhenParser {
  private pos = 0;
  private readonly tokens: WhenToken[];
  private readonly keys: Readonly<Record<string, boolean | string | number>>;
  constructor(tokens: WhenToken[], keys: Readonly<Record<string, boolean | string | number>>) {
    this.tokens = tokens;
    this.keys = keys;
  }

  private peek(): WhenToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): WhenToken | undefined {
    return this.tokens[this.pos++];
  }

  expectEnd(): void {
    if (this.pos !== this.tokens.length) throw new Error("trailing tokens");
  }

  parseOr(): boolean {
    let left = this.parseAnd();
    while (this.peek()?.t === "op" && (this.peek() as { v: string }).v === "||") {
      this.next();
      const right = this.parseAnd();
      left = left || right;
    }
    return left;
  }

  parseAnd(): boolean {
    let left = this.parseUnary();
    while (this.peek()?.t === "op" && (this.peek() as { v: string }).v === "&&") {
      this.next();
      const right = this.parseUnary();
      left = left && right;
    }
    return left;
  }

  parseUnary(): boolean {
    const tok = this.peek();
    if (tok?.t === "op" && tok.v === "!") {
      this.next();
      return !this.parseUnary();
    }
    return this.parseComparison();
  }

  parseComparison(): boolean {
    // primary, optionally followed by ==/!= and a primary literal.
    const startId = this.peek();
    const left = this.parsePrimary();
    const op = this.peek();
    if (op?.t === "op" && (op.v === "==" || op.v === "!=")) {
      this.next();
      const rhsTok = this.next();
      if (!rhsTok || (rhsTok.t !== "id" && rhsTok.t !== "str")) {
        throw new Error("expected literal after comparison");
      }
      // The LHS of an equality is a KEY name (its string value), not its truthiness.
      const lhsKey = startId && startId.t === "id" ? startId.v : "";
      const lhsValue = String(this.keys[lhsKey] ?? "");
      const rhsValue = rhsTok.v;
      return op.v === "==" ? lhsValue === rhsValue : lhsValue !== rhsValue;
    }
    return left;
  }

  parsePrimary(): boolean {
    const tok = this.next();
    if (!tok) throw new Error("unexpected end");
    if (tok.t === "op" && tok.v === "(") {
      const inner = this.parseOr();
      const close = this.next();
      if (!close || close.t !== "op" || close.v !== ")") throw new Error("expected )");
      return inner;
    }
    if (tok.t === "id") {
      if (tok.v === "true") return true;
      if (tok.v === "false") return false;
      return truthy(this.keys[tok.v]);
    }
    if (tok.t === "str") {
      return tok.v.length > 0;
    }
    throw new Error("unexpected token");
  }
}

function truthy(v: boolean | string | number | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v !== "" && v !== "false";
}

/* ------------------------------------------------------------------------- *
 * Engine delegation helper — `prometheus.*` ids COMPOSE commands.ts (§8/§10)
 * ------------------------------------------------------------------------- */

/**
 * Build an editor command that DELEGATES to the engine parity router (commands.ts)
 * by spec id — this is how `prometheus.scan` / `prometheus.audit` reach the engine
 * WITHOUT duplicating the routing table (§8). The host must supply `ctx.engine`.
 */
function engineDelegate(
  init: Omit<EditorCommand, "run">,
  specId: string,
  positionalsFrom?: (args: Readonly<Record<string, unknown>>) => string[],
): EditorCommand {
  return {
    ...init,
    run: async (ctx): Promise<EditorCommandResult> => {
      if (!ctx.engine) {
        return { id: init.id, ok: false, summary: `${init.id}: no engine context bound` };
      }
      const positionals = positionalsFrom ? positionalsFrom(ctx.args ?? {}) : [];
      const result = await invoke(specId, ctx.engine, { positionals, flags: {} });
      return {
        id: init.id,
        ok: result.ok,
        summary: result.summary,
        engineResult: result,
      };
    },
  };
}

/** A no-op editor command that records intent (UI-driven commands wire the body). */
function uiCommand(init: Omit<EditorCommand, "run">, summary: string): EditorCommand {
  return {
    ...init,
    run: (): EditorCommandResult => ({ id: init.id, ok: true, summary }),
  };
}

/* ------------------------------------------------------------------------- *
 * THE EDITOR COMMAND REGISTRY (file 07 §8 — the always-present surface)
 * ------------------------------------------------------------------------- */

export const EDITOR_COMMANDS: readonly EditorCommand[] = Object.freeze([
  // --- AI surfaces (file 07 §7) ----------------------------------------- //
  uiCommand(
    {
      id: "ai.inlineEdit",
      title: "AI: Inline Edit (Cmd-K)",
      category: "AI",
      when: "editorFocus",
      default: "cmd+k",
    },
    "ai.inlineEdit: open inline-edit overlay",
  ),
  uiCommand(
    {
      id: "ai.openAgent",
      title: "AI: Open Agent Pane",
      category: "AI",
      default: "cmd+shift+a",
    },
    "ai.openAgent: reveal agent/chat pane",
  ),
  // --- security / the run-gate (file 07 §5.2/§9, C5) -------------------- //
  engineDelegate(
    {
      id: "gate.runWorkspaceScan",
      title: "Security: Gate Workspace",
      category: "Security",
      default: "cmd+shift+g",
    },
    "gate",
    (args) => [typeof args.workspaceRoot === "string" ? (args.workspaceRoot as string) : ""],
  ),
  uiCommand(
    {
      id: "gate.showLog",
      title: "Security: Show Gate Log",
      category: "Security",
    },
    "gate.showLog: open the Gate Log panel",
  ),
  // --- env / models (delegated to files 04/05 UIs) --------------------- //
  uiCommand(
    {
      id: "python.selectInterpreter",
      title: "Python: Select Interpreter",
      category: "Run",
      when: "pythonFile || workspaceHasPython",
    },
    "python.selectInterpreter: open interpreter picker (file 04)",
  ),
  uiCommand(
    {
      id: "models.selectEndpoint",
      title: "AI: Select Model Endpoint",
      category: "AI",
    },
    "models.selectEndpoint: open Model Hub endpoint picker (file 05)",
  ),
  // --- git / debug / search / format ----------------------------------- //
  uiCommand(
    {
      id: "git.commit",
      title: "Git: Commit",
      category: "Git",
      when: "gitRepo",
      default: "cmd+enter",
    },
    "git.commit: commit staged changes",
  ),
  uiCommand(
    {
      id: "debug.start",
      title: "Run: Start Debugging",
      category: "Run",
      default: "f5",
    },
    "debug.start: start a debug session (gates first run, §5.2)",
  ),
  uiCommand(
    {
      id: "search.findInFiles",
      title: "Search: Find in Files",
      category: "Edit",
      default: "cmd+shift+f",
    },
    "search.findInFiles: open project-wide search",
  ),
  uiCommand(
    {
      id: "editor.action.formatDocument",
      title: "Format Document",
      category: "Edit",
      when: "editorFocus",
      default: "shift+alt+f",
    },
    "editor.action.formatDocument: format via LSP",
  ),
  // --- prometheus.* — COMPOSE the engine parity router (§8/§10) --------- //
  engineDelegate(
    {
      id: "prometheus.scan",
      title: "Prometheus: Scan Agents",
      category: "Security",
    },
    "scan",
  ),
  engineDelegate(
    {
      id: "prometheus.audit",
      title: "Prometheus: Audit Plugin",
      category: "Security",
    },
    "audit",
    (args) => [typeof args.name === "string" ? (args.name as string) : ""],
  ),
]);

/* ------------------------------------------------------------------------- *
 * The registry API (register / get / list / byCategory) — file 07 §8
 * ------------------------------------------------------------------------- */

/** A mutable editor command registry (the host seeds it with EDITOR_COMMANDS). */
export class EditorCommandRegistry {
  private readonly byId = new Map<string, EditorCommand>();

  constructor(seed: readonly EditorCommand[] = EDITOR_COMMANDS) {
    for (const c of seed) this.register(c);
  }

  /** Register (or replace) a command. Returns this for chaining. */
  register(cmd: EditorCommand): this {
    this.byId.set(cmd.id, cmd);
    return this;
  }

  /** O(1) lookup by id. */
  get(id: string): EditorCommand | undefined {
    return this.byId.get(id);
  }

  /** Every command in registration order. */
  list(): EditorCommand[] {
    return [...this.byId.values()];
  }

  /** Commands in one category. */
  byCategory(category: EditorCommandCategory): EditorCommand[] {
    return this.list().filter((c) => c.category === category);
  }

  /**
   * The commands VISIBLE under the current context keys (the palette filter) —
   * a command shows when its `when` evaluates true (or is absent).
   */
  visible(keys: Readonly<Record<string, boolean | string | number>>): EditorCommand[] {
    return this.list().filter((c) => evaluateWhen(c.when, keys));
  }

  /** Run a command by id, throwing a clear error for an unknown id. */
  async run(id: string, ctx: EditorCommandCtx): Promise<EditorCommandResult> {
    const cmd = this.byId.get(id);
    if (!cmd) throw new Error(`unknown editor command: ${id}`);
    return cmd.run(ctx);
  }
}

/** A frozen lookup over the built-in EDITOR_COMMANDS (for read-only callers). */
const BY_ID = new Map<string, EditorCommand>(EDITOR_COMMANDS.map((c) => [c.id, c]));

/** O(1) lookup of a built-in editor command by id. */
export function getEditorCommand(id: string): EditorCommand | undefined {
  return BY_ID.get(id);
}

/** Every built-in editor command (registration order). */
export function listEditorCommands(): readonly EditorCommand[] {
  return EDITOR_COMMANDS;
}

/** Built-in editor commands in one category. */
export function editorCommandsByCategory(category: EditorCommandCategory): EditorCommand[] {
  return EDITOR_COMMANDS.filter((c) => c.category === category);
}
