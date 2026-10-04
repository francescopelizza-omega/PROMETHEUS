/**
 * host-wiring.test.ts — GUARD: both terminal hosts pass the seams "update everything" relies on.
 *
 * Every dispatch test injects its own `DispatchDeps`, so a host that stopped passing plan mode,
 * the runtime-node hold or the Ctrl-C signal would leave all of them green while that host
 * upgraded the node it runs on in plan mode. The types make most seams required; these pin the
 * VALUES — a seam wired to `() => undefined` compiles just as well. Same idiom as fleet-bar.test.ts.
 *
 * Each needle is looked for INSIDE the block it belongs to (`dispatch: { … }`, `actions: { … }`):
 * searched file-wide, `getPermMode: () => hostPermMode` also matched the slash context, and the
 * dispatch seam could have been rewired to `() => undefined` with this guard still green.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const src = (rel: string): string => readFileSync(join(import.meta.dirname, rel), "utf8");

/** The `{ … }` that opens at `opener`, searched from `from` (balanced braces, comments included). */
function block(text: string, opener: string, from = 0): string {
  const at = text.indexOf(opener, from);
  assert.ok(at >= 0, `missing: ${opener}`);
  const open = text.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`unbalanced: ${opener}`);
}

/** The `runUpdates` slash handler's dispatch and actions blocks. */
function seams(text: string): { dispatch: string; actions: string } {
  const handler = text.indexOf("runUpdates: async (rest) => {");
  assert.ok(handler >= 0, "no runUpdates handler");
  return {
    dispatch: block(text, "dispatch: {", handler),
    actions: block(text, "actions: {", handler),
  };
}

const SHARED_DISPATCH = [
  "run: stepRunner,",
  "probes: makeDispatchProbes(",
  "activeVenv: process.env.VIRTUAL_ENV",
  "runtimeFormula: () => runtimeBrewFormula()",
  "dryRun: () => state.tuning.dryRun === true",
  "invalidateCache: () => markUpdateCacheStale(home)",
  "audit: (entry) => appendExecAudit(home, entry)",
];

const has = (where: string, needles: readonly string[], label: string): void => {
  for (const n of needles) assert.ok(where.includes(n), `${label} lost: ${n}`);
};

test("GUARD: the readline host wires the cancellable ask, the turn's signal and its posture", () => {
  const host = src("../session/host.ts");
  const { dispatch, actions } = seams(host);
  has(
    dispatch,
    [
      ...SHARED_DISPATCH,
      "getPermMode: () => hostPermMode",
      "ctrlCIsAbort: () => (rl as { terminal?: boolean }).terminal !== false",
      "closed: () => inputClosed",
    ],
    "host.ts dispatch",
  );
  has(
    actions,
    [
      "ask: (prompt) => askCancellable(prompt)",
      "signal: () => turnAbort?.signal",
      "getAuthLevel: () => slashCtx.getAuthLevel()",
    ],
    "host.ts actions",
  );
  has(
    host,
    [
      "inputClosed = true;",
      // the cancellable question itself (session/ask-cancellable.ts), one question at a time
      "askCancellableOn(rl as unknown as QuestionLine",
      "oneQuestion(() =>",
      // Ctrl-C / Ctrl-D wording during a package step, and the early "y"
      "updateStepsRunning += 1;",
      "updateStepsRunning > 0",
      "earlyYesGuard = true;",
      "if (earlyYesGuard &&",
    ],
    "host.ts",
  );
});

test("GUARD: the TUI bridge hands slash commands the submit's signal and wires the same seams", () => {
  const bridge = src("../tui/session-bridge.ts");
  const { dispatch, actions } = seams(bridge);
  has(
    dispatch,
    [
      ...SHARED_DISPATCH,
      "getPermMode: () => permMode",
      "ctrlCIsAbort: () => true",
      "closed: () => disposed || stopRequested",
    ],
    "session-bridge.ts dispatch",
  );
  has(
    actions,
    [
      "ask: (prompt) => slashCtx.ask(prompt)",
      "signal: () => slashSignal",
      "getAuthLevel: () => slashCtx.getAuthLevel()",
    ],
    "session-bridge.ts actions",
  );
  has(
    bridge,
    [
      "slashSignal = opts?.signal;",
      "disposed = true;",
      "stopAfterStep: (): boolean =>",
      "dropsEarlyYes: (text: string): boolean =>",
    ],
    "session-bridge.ts",
  );
});

test("GUARD: the TUI app waits for an update step before exiting, and queues its modals", () => {
  const app = src("../tui/app.ts");
  has(
    app,
    [
      "if (running && session.stopAfterStep?.())",
      "if (exitAfterTurn !== null) finish(exitAfterTurn);",
      "return queueModal(() => openConfirmModal(prompt), false);",
      'return queueModal(() => openAskModal(prompt), "");',
      'return queueModal(() => openAskPathModal(prompt, def), "");',
      "if (running && session.dropsEarlyYes?.(e.text))",
    ],
    "app.ts",
  );
});
