/**
 * session-cancel.test.ts — a turn the USER stopped is not an error, and a rebuild is not amnesia.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { LLMClient } from "@prometheus/core/agent-loop";

import { ChatSession, vscodeTuning } from "./session.js";

function sinksRecorder() {
  const events: [string, string?][] = [];
  return {
    events,
    sinks: {
      onText: (t: string) => void events.push(["text", t]),
      onStatus: (t: string) => void events.push(["status", t]),
      onToolNote: (t: string) => void events.push(["tool", t]),
      onError: (t: string) => void events.push(["error", t]),
      onTurnComplete: () => void events.push(["done"]),
    },
  };
}

const session = (llm: LLMClient) =>
  new ChatSession({
    llm,
    runTool: async () => ({ ok: true, summary: "" }),
    confirm: async () => true,
    tuning: vscodeTuning("m"),
  });

test("cancelling a turn is reported as a status, not a red error bubble", async () => {
  /**
   * `cancel()` aborts the controller; the client's fetch rejects with an AbortError and it lands
   * in `runTurn`'s catch, which called `onError`. So pressing "Cancel Current Turn" painted a red
   * error bubble reading "This operation was aborted" — about the thing the user had just
   * deliberately stopped. `media/main.js` renders `error` in red and `status` as ordinary text.
   */
  const rec = sinksRecorder();
  const s = session({
    async *turn() {
      await new Promise((_r, reject) =>
        setTimeout(
          () =>
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
          20,
        ),
      );
      yield { kind: "final" as const };
    },
  } as LLMClient);
  const run = s.send("hello", rec.sinks);
  s.cancel();
  await run;

  assert.ok(
    !rec.events.some(([k]) => k === "error"),
    `a cancel raised an error: ${JSON.stringify(rec.events)}`,
  );
  assert.ok(rec.events.some(([k, v]) => k === "status" && /cancelled/i.test(v ?? "")));
  assert.ok(
    rec.events.some(([k]) => k === "done"),
    "the turn must still close",
  );
});

test("a GENUINE failure is still an error", async () => {
  // self-validating: the cancel branch must not swallow real failures.
  const rec = sinksRecorder();
  const s = session({
    async *turn() {
      await new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("HTTP 500 from the provider")), 10),
      );
      yield { kind: "final" as const };
    },
  } as LLMClient);
  await s.send("hello", rec.sinks);
  assert.ok(
    rec.events.some(([k, v]) => k === "error" && /HTTP 500/.test(v ?? "")),
    JSON.stringify(rec.events),
  );
});

test("a conversation nearing the context window warns ONCE, with a way out", async () => {
  /**
   * This host has no compaction: the thread grows without bound and nothing trims it. Measured
   * against the real `ChatSession`: 3 → 81 messages over 40 turns, ~110 tokens per turn with
   * short replies, linear, forever. Past the configured window the provider rejects every
   * request and the session is WEDGED — each new message re-sends the same oversized thread and
   * fails identically, with no route back except starting over.
   *
   * Compaction proper belongs in core, shared with the CLI's and the desktop's existing
   * implementations rather than written a third time here (that duplication is the source of a
   * large share of the bugs in this repo). Until then the honest half is to say so before it
   * happens, and to name the command that recovers.
   */
  const rec = sinksRecorder();
  const reply = "x".repeat(400);
  const s = new ChatSession({
    llm: {
      async *turn() {
        yield { kind: "text" as const, text: reply };
        yield { kind: "final" as const };
      },
    } as LLMClient,
    runTool: async () => ({ ok: true, summary: "" }),
    confirm: async () => true,
    tuning: vscodeTuning("m"),
    contextWindow: 2000,
  });

  for (let i = 0; i < 40; i++) await s.send("please continue the analysis", rec.sinks);

  const warnings = rec.events.filter(
    ([k, v]) => k === "status" && /context window|of \d/.test(v ?? ""),
  );
  assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
  assert.match(warnings[0]?.[1] ?? "", /no automatic compaction/);
  assert.match(warnings[0]?.[1] ?? "", /New Session/, "the warning must name the way out");

  // self-validating: a SHORT conversation must not be warned about at all.
  const quiet = sinksRecorder();
  const s2 = new ChatSession({
    llm: {
      async *turn() {
        yield { kind: "text" as const, text: "ok" };
        yield { kind: "final" as const };
      },
    } as LLMClient,
    runTool: async () => ({ ok: true, summary: "" }),
    confirm: async () => true,
    tuning: vscodeTuning("m"),
    contextWindow: 100_000,
  });
  await s2.send("hello", quiet.sinks);
  assert.ok(!quiet.events.some(([k, v]) => k === "status" && /compaction/.test(v ?? "")));
});
