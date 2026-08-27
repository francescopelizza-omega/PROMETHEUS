/**
 * agent/todo.ts — the structured task list the agent works to.
 *
 * `modes.ts` has declared `todowrite` / `todoread` descriptors since it was written, with
 * ZERO production references — descriptors only, no schema, no state, no dispatch. So the
 * agent had no way to lay out a multi-step plan, and no way to show the user which step it
 * was on. On a long task that is the difference between "it is working through six things,
 * currently the third" and a wall of tool calls the user has to reverse-engineer.
 *
 * The list is AGENT MEMORY, not a file. It never touches the filesystem: it exists for the
 * span of a session, it is rewritten wholesale by the model, and it is rendered for the human.
 * Making it a file would invite the model to litter the user's repo with planning artefacts.
 *
 * WHOLESALE REWRITE, deliberately. `todowrite` replaces the entire list rather than patching
 * one item, because a model that must send a diff sends a wrong diff: it loses items, or
 * duplicates them, or renumbers. Sending the whole list every time is a few more tokens and
 * removes an entire class of desync.
 *
 * PURE: no node, no IO.
 */

import type { ToolDef } from "./tools.js";

/** Where one task stands. Exactly three states — more invites the model to invent its own. */
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** The glyph each state renders as, so a status line reads at a glance. */
export const TODO_GLYPH: Readonly<Record<TodoStatus, string>> = Object.freeze({
  pending: "○",
  in_progress: "◐",
  completed: "●",
});

/** Cap the list so a runaway model cannot turn the status line into a screenful. */
export const MAX_TODOS = 40;

/**
 * Coerce whatever the model sent into a clean list.
 *
 * Tolerant on purpose: an unknown status becomes `pending` rather than rejecting the whole
 * write, because losing the plan over one typo'd enum is a worse failure than a slightly
 * wrong status. An item with no text is dropped — it has nothing to show a human.
 */
export function parseTodos(raw: unknown): TodoItem[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  const out: TodoItem[] = [];
  for (const item of arr) {
    if (out.length >= MAX_TODOS) break;
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ text, status: "pending" });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (!text) continue;
    const status =
      typeof rec.status === "string" && STATUSES.has(rec.status)
        ? (rec.status as TodoStatus)
        : "pending";
    out.push({ text, status });
  }
  return out;
}

/** A session's task list. Replace-only; the host holds one per session. */
export class TodoStore {
  private items: TodoItem[] = [];

  /** Replace the list wholesale. Returns the stored result. */
  write(raw: unknown): TodoItem[] {
    this.items = parseTodos(raw);
    return this.items;
  }

  list(): readonly TodoItem[] {
    return this.items;
  }

  clear(): void {
    this.items = [];
  }
}

/** One-line-per-task rendering, for the model AND for the human status line. */
export function renderTodos(items: readonly TodoItem[]): string {
  if (items.length === 0) return "(no tasks yet)";
  return items.map((t) => `${TODO_GLYPH[t.status]} ${t.text}`).join("\n");
}

/** `n done · n doing · n to go` — the compact form for a one-line status. */
export function todoSummary(items: readonly TodoItem[]): string {
  if (items.length === 0) return "no tasks";
  const done = items.filter((t) => t.status === "completed").length;
  const doing = items.filter((t) => t.status === "in_progress").length;
  return `${done}/${items.length} done${doing > 0 ? ` · ${doing} in progress` : ""}`;
}

/* ── the tools ───────────────────────────────────────────────────────────────*/

function hostOnly(name: string): () => string[] {
  return () => {
    throw new Error(`${name} is served by the host runtime, not by prometheus.py`);
  };
}

/**
 * `todowrite` — replace the task list.
 *
 * `readOnlyHint` is TRUE, which deserves justifying: it mutates agent memory, never the
 * machine. Requiring a human click to let the model write down its own plan would make the
 * feature unusable, and there is nothing to approve — no file changes, no process runs. The
 * annotation is what `classifyAuth` reads to auto-approve at A1, and that is the correct
 * outcome here.
 */
export const TODO_WRITE_TOOL: ToolDef = {
  name: "todowrite",
  title: "Write the task list",
  description:
    "Replace the task list for this run. Send the WHOLE list every time — it is not a patch. " +
    "Each item is {text, status} where status is pending, in_progress or completed. Keep " +
    "exactly one item in_progress. Use this for any task with more than about three steps, " +
    "and update it as you go so the user can see where you are.",
  schema: {
    todos: {
      type: "array",
      required: true,
      description: "the complete list, each {text, status}",
      items: { type: "object", shape: "{text,status}" },
    },
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  toArgv: hostOnly("todowrite"),
};

/** `todoread` — read the current list back (for a model that lost track of it). */
export const TODO_READ_TOOL: ToolDef = {
  name: "todoread",
  title: "Read the task list",
  description: "Read the current task list for this run.",
  schema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  toArgv: hostOnly("todoread"),
};

export const TODO_TOOLS: readonly ToolDef[] = Object.freeze([TODO_WRITE_TOOL, TODO_READ_TOOL]);

/** Dispatch a todo call against a store. Returns the text the model reads back. */
export function runTodoTool(
  name: string,
  args: Record<string, unknown>,
  store: TodoStore,
): { ok: boolean; summary: string } | null {
  if (name === "todowrite") {
    /**
     * REFUSE rather than wipe.
     *
     * `store.write` runs everything through `parseTodos`, which is deliberately forgiving — it
     * would rather keep a task with a typo'd status than lose the plan. But a payload that is
     * not a list at all (the field omitted, a bare string, an object) parsed to the EMPTY list,
     * so the store was cleared and the model was told "task list updated" with `ok: true`. It
     * had just lost its own plan, mid-task, and had no way to know. Reproduced: a two-item list,
     * then `todowrite {}` → 0 items, `ok: true`.
     *
     * An explicitly EMPTY array is a legitimate "clear the list" and still goes through.
     */
    const raw = args.todos;
    // A JSON string holding an array is accepted (some models send one); anything else that is
    // not an array is a mistake, not an instruction to clear the list.
    let list: unknown[] | null = Array.isArray(raw) ? raw : null;
    if (list === null && typeof raw === "string") {
      try {
        const decoded: unknown = JSON.parse(raw);
        list = Array.isArray(decoded) ? decoded : null;
      } catch {
        list = null;
      }
    }
    if (list === null) {
      const existing = store.list();
      const got =
        raw === undefined ? "nothing" : typeof raw === "string" ? "a plain string" : typeof raw;
      return {
        ok: false,
        summary: `todowrite: 'todos' must be an array of {text, status} — got ${got}. The existing task list is UNCHANGED (${todoSummary(existing)}).\n${renderTodos(existing)}`,
      };
    }
    const parsed = parseTodos(list);
    const supplied = list.length;
    if (supplied > 0 && parsed.length === 0) {
      const existing = store.list();
      return {
        ok: false,
        summary: `todowrite: none of the ${supplied} entries had usable text, so nothing was written. Each entry needs a non-empty 'text'. The existing task list is UNCHANGED (${todoSummary(existing)}).\n${renderTodos(existing)}`,
      };
    }
    const items = store.write(list);
    return {
      ok: true,
      summary: `task list updated (${todoSummary(items)})\n${renderTodos(items)}`,
    };
  }
  if (name === "todoread") {
    return { ok: true, summary: renderTodos(store.list()) };
  }
  return null;
}
