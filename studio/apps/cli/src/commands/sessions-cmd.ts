/**
 * commands/sessions-cmd.ts — `prometheus sessions <list|search|fork|delete>` (CLI-014).
 *
 * A one-shot browser over the persisted session store (history-store.ts): list with
 * descriptors, full-text search over transcripts, fork into an independent copy, and
 * delete behind a typed short-id confirmation. `--json` emits a machine envelope;
 * delete without the typed confirm refuses fail-closed (exit 2).
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import { c } from "../render.js";
import {
  type SessionRecord,
  deleteSession,
  forkSession,
  listSessions,
  resolveSessionId,
  searchSessions,
} from "../session/history-store.js";
import { flagStr } from "./sidecar-cmd.js";

const VERBS = ["list", "search", "fork", "delete"] as const;

export interface SessionsDeps {
  home: string;
}

function renderTable(records: readonly SessionRecord[]): string {
  if (records.length === 0) return c.dim("no sessions recorded yet.");
  const lines = [c.bold(`sessions (${records.length})`)];
  for (const r of records) {
    const when = r.ts.replace("T", " ").slice(0, 16);
    lines.push(
      `  ${c.cyan(r.id.slice(0, 8))}  ${c.dim(when)}  ${c.dim(r.cwd)}\n      ${r.descriptor}`,
    );
  }
  return lines.join("\n");
}

/** `prometheus sessions <list|search|fork|delete>`. */
export function runSessions(
  ctx: CliContext,
  deps: SessionsDeps = { home: prometheusHome() },
): CommandOutcome {
  const { home } = deps;
  const verb = ctx.args.command[1] ?? "list";
  const pos = ctx.args.positionals;

  if (verb === "list") {
    const records = listSessions(home, 200);
    return ctx.json
      ? { json: { ok: true, sessions: records }, exitCode: 0 }
      : { text: renderTable(records), exitCode: 0 };
  }

  if (verb === "search") {
    const query = pos[0];
    if (!query) {
      return {
        text: "prometheus sessions search: needs a query",
        json: { ok: false, error: "missing-query" },
        exitCode: 2,
      };
    }
    const records = searchSessions(home, query);
    return ctx.json
      ? { json: { ok: true, query, sessions: records }, exitCode: 0 }
      : {
          text: records.length ? renderTable(records) : c.dim(`no sessions match "${query}"`),
          exitCode: 0,
        };
  }

  if (verb === "fork") {
    const id = pos[0];
    if (!id) {
      return {
        text: "prometheus sessions fork: needs a session id",
        json: { ok: false, error: "missing-id" },
        exitCode: 2,
      };
    }
    const r = forkSession(home, id);
    if ("error" in r) {
      return { text: c.red(`fork: ${r.error}`), json: { ok: false, error: r.error }, exitCode: 2 };
    }
    return {
      text: `${c.green("✓")} forked → ${c.cyan(r.newId.slice(0, 8))} (independent copy)`,
      json: { ok: true, newId: r.newId },
      exitCode: 0,
    };
  }

  if (verb === "delete") {
    const id = pos[0];
    if (!id) {
      return {
        text: "prometheus sessions delete: needs a session id",
        json: { ok: false, error: "missing-id" },
        exitCode: 2,
      };
    }
    const resolved = resolveSessionId(home, id);
    if ("error" in resolved) {
      return {
        text: c.red(`delete: ${resolved.error}`),
        json: { ok: false, error: resolved.error },
        exitCode: 2,
      };
    }
    const shortId = resolved.id.slice(0, 8);
    // typed confirm: the short id must be echoed back via --confirm (scriptable + explicit).
    if (flagStr(ctx, "confirm") !== shortId) {
      return {
        text: `to delete, re-run with ${c.bold(`--confirm ${shortId}`)} (type the short id back)`,
        json: { ok: false, error: "confirm-required", need: shortId },
        exitCode: 2,
      };
    }
    const ok = deleteSession(home, resolved.id);
    return {
      text: ok ? `${c.green("✓")} deleted ${shortId}` : c.red("delete failed"),
      json: { ok, id: resolved.id },
      exitCode: ok ? 0 : 2,
    };
  }

  return {
    text: `prometheus sessions: unknown verb "${verb}" — valid: ${VERBS.join(", ")}`,
    json: { ok: false, error: "unknown-verb", valid: VERBS },
    exitCode: 2,
  };
}
