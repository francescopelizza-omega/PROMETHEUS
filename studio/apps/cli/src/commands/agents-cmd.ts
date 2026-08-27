import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, table } from "../render.js";
/**
 * commands/agents-cmd.ts — `prometheus agents [list|attach|kill]` over the background-run table
 * (CLI-034). A run started detached keeps executing after the pane is left; this surface
 * lists running/finished runs, re-streams a run's buffered + live output on `attach`
 * (Ctrl-C detaches, never kills), and aborts one on `kill`. In-process only — a second
 * `prometheus` process sees only what it started; that is stated honestly, never faked live.
 */
import { type RunRecord, type RunRegistry, runRegistry } from "../session/orchestrator.js";

/** Injectable seams so the whole surface is tested without a real TUI or clock. */
export interface AgentsDeps {
  registry: RunRegistry;
  /** wall clock (ms) for the elapsed column. */
  now: () => number;
  /** the run's write sink for `attach` replay/live (default = stdout). */
  write: (text: string) => void;
}

const defaultAgentsDeps = (): AgentsDeps => ({
  registry: runRegistry,
  now: () => Date.now(),
  write: (t) => process.stdout.write(`${t}\n`),
});

function elapsed(rec: RunRecord, nowMs: number): string {
  const end = rec.settledAt ? Date.parse(rec.settledAt) : nowMs;
  const sec = Math.max(0, Math.round((end - Date.parse(rec.startedAt)) / 1000));
  return `${sec}s`;
}

function stateCell(state: RunRecord["state"]): string {
  switch (state) {
    case "running":
      return c.cyan(state);
    case "waiting-approval":
      return c.yellow(state);
    case "done":
      return c.green(state);
    case "failed":
      return c.red(state);
    case "killed":
      return c.red(state);
  }
}

export async function runAgentsCommand(
  ctx: CliContext,
  deps: AgentsDeps = defaultAgentsDeps(),
): Promise<CommandOutcome> {
  // `unmatchedSub` (parse.ts) distinguishes "a second word WAS typed but didn't match
  // list/attach/kill" from "nothing was typed" — without it, `agents kli <id>` (typo of
  // `kill`) silently fell through to the "list" branch below (command[1] was undefined for
  // a TWO_WORD mismatch), discarding both the typo and the id with no indication anything
  // was wrong.
  const sub = ctx.args.unmatchedSub ?? ctx.args.command[1] ?? "list";

  if (sub !== "list" && sub !== "kill" && sub !== "attach") {
    return {
      text: c.red(
        `prometheus agents ${sub}: unknown agents verb.\n  ${c.dim("try:")} list · attach · kill`,
      ),
      json: { ok: false, error: "unknown-verb", command: `agents ${sub}` },
      exitCode: 1,
    };
  }

  if (sub === "kill") {
    const id = ctx.args.positionals[0];
    if (!id)
      return {
        text: c.red("usage: prometheus agents kill <id>"),
        json: { ok: false, error: "missing-id" },
        exitCode: 2,
      };
    const ok = deps.registry.kill(id);
    if (!ok)
      return {
        text: c.red(`no such run: ${id}`),
        json: { ok: false, error: "not-found", id },
        exitCode: 2,
      };
    return {
      text: `${c.green("✓")} killed ${id}`,
      json: { ok: true, id, state: "killed" },
      exitCode: 0,
    };
  }

  if (sub === "attach") {
    const id = ctx.args.positionals[0];
    if (!id)
      return {
        text: c.red("usage: prometheus agents attach <id>"),
        json: { ok: false, error: "missing-id" },
        exitCode: 2,
      };
    const handle = deps.registry.attach(id, (ev) => deps.write(ev.text));
    if (!handle)
      return {
        text: c.red(`no such run: ${id}`),
        json: { ok: false, error: "not-found", id },
        exitCode: 2,
      };
    // replay the buffered output IN ORDER (the seam: replay ends at lastSeq, live starts next).
    for (const ev of handle.replay) deps.write(ev.text);
    const rec = deps.registry.get(id);
    if (rec && (rec.state === "done" || rec.state === "failed" || rec.state === "killed")) {
      handle.unsubscribe(); // a finished run: replay + final state, no live wait
      return {
        text: c.dim(`— run ${id} ${rec.state}${rec.exitSummary ? `: ${rec.exitSummary}` : ""}`),
        exitCode: 0,
      };
    }
    // a live run: stream until it settles; Ctrl-C (0x03) detaches WITHOUT killing.
    await streamUntilSettle(id, handle.unsubscribe, deps);
    const final = deps.registry.get(id);
    return { text: c.dim(`— detached from ${id} (${final?.state ?? "?"})`), exitCode: 0 };
  }

  // default: list
  const runs = deps.registry.list();
  const nowMs = deps.now();
  if (ctx.json) return { json: { ok: true, runs }, exitCode: 0 };
  if (runs.length === 0)
    return { text: c.dim("no background agent runs in this process"), exitCode: 0 };
  const rows = runs.map((r) => [
    r.id,
    stateCell(r.state),
    r.model,
    elapsed(r, nowMs),
    r.exitSummary ??
      (r.droppedBytes > 0 ? c.dim(`(${Math.round(r.droppedBytes / 1024)} KiB dropped)`) : ""),
  ]);
  const lines = [heading(`Agent runs  ${c.dim(`(${runs.length})`)}`), ""];
  lines.push(
    table(
      [
        { header: "ID" },
        { header: "STATE" },
        { header: "MODEL" },
        { header: "ELAPSED" },
        { header: "SUMMARY" },
      ],
      rows,
    ),
  );
  return { text: lines.join("\n"), exitCode: 0 };
}

/**
 * Stream a live run to the pane until it settles, or until the user presses Ctrl-C (the raw
 * `0x03` byte) to DETACH — detaching unsubscribes but leaves the run executing. Non-TTY just
 * waits for settle (no stdin). The subscriber was already wired by `attach`.
 */
function streamUntilSettle(id: string, unsubscribe: () => void, deps: AgentsDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    const stdin = process.stdin;
    const isTty = stdin.isTTY === true && typeof stdin.setRawMode === "function";
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      unsubscribe();
      offSettle();
      if (isTty) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* best effort */
        }
        stdin.off("data", onData);
        stdin.pause();
      }
      resolve();
    };
    const offSettle = deps.registry.onSettle(id, () => finish());
    const onData = (b: Buffer): void => {
      if (b.includes(0x03)) finish(); // Ctrl-C → DETACH (run keeps going)
    };
    if (isTty) {
      try {
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
      } catch {
        /* raw mode unavailable → just wait for settle */
      }
    }
    // guard: if it already settled between attach and here, finish now.
    const rec = deps.registry.get(id);
    if (rec && (rec.state === "done" || rec.state === "failed" || rec.state === "killed")) finish();
  });
}
