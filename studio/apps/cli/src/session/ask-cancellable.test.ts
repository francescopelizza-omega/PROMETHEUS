/**
 * ask-cancellable.test.ts — every way of walking away from the "update everything" y/N reads as no.
 *
 * The fake follows node:readline's own rules (Node 26 `Interface`): ONE pending question callback;
 * a question's abort signal withdraws whichever callback is pending; Return hands the whole line
 * buffer — typed-ahead keys included — to that callback; `close()` emits "close" without calling
 * it. Each test fails if the matching safeguard in askCancellableOn is removed.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { type QuestionLine, askCancellableOn } from "./ask-cancellable.js";

class FakeReadline extends EventEmitter implements QuestionLine {
  line = "";
  cursor = 0;
  pending: ((answer: string) => void) | null = null;
  queries: string[] = [];
  question(query: string, a: unknown, b?: unknown): void {
    const cb = (typeof a === "function" ? a : b) as (answer: string) => void;
    const signal =
      typeof a === "object" && a !== null ? (a as { signal?: AbortSignal }).signal : undefined;
    if (signal?.aborted) return;
    signal?.addEventListener("abort", () => {
      this.pending = null; // readline's kQuestionCancel: withdraws the CURRENT question
    });
    this.queries.push(query);
    if (this.pending) return; // readline only re-prompts; the new callback is dropped
    this.pending = cb;
  }
  /** keys without Return */
  type(keys: string): void {
    this.line += keys;
    this.cursor = this.line.length;
  }
  /** Return: the whole buffer is the answer */
  enter(): void {
    const l = this.line;
    this.line = "";
    this.cursor = 0;
    const cb = this.pending;
    this.pending = null;
    if (cb) cb(l);
    else this.emit("line", l);
  }
  close(): void {
    this.emit("close");
  }
}

const opts = (o: { signal?: AbortSignal; closed?: boolean } = {}) => {
  const notes: string[] = [];
  return {
    notes,
    o: {
      ...(o.signal ? { signal: o.signal } : {}),
      closed: () => o.closed === true,
      note: (t: string) => notes.push(t),
    },
  };
};

test("a 'y' typed before the question, then Return, is NOT a yes", async () => {
  const rl = new FakeReadline();
  rl.type("y");
  const { notes, o } = opts();
  const answer = askCancellableOn(rl, "? ", o);
  rl.enter(); // the Return the user meant as "no / default"
  assert.equal(await answer, "");
  assert.deepEqual(notes, ["(discarded keys typed before the question)"]);
});

test("a buffer that cannot be emptied: the question is never asked", async () => {
  const rl = new FakeReadline();
  rl.type("y");
  Object.defineProperty(rl, "line", { value: "y", writable: false });
  const { notes, o } = opts();
  assert.equal(await askCancellableOn(rl, "? ", o), "");
  assert.deepEqual(rl.queries, []);
  assert.match(notes[0] ?? "", /still pending — nothing was run/);
});

test("Ctrl-C answers no AND withdraws the question, so the next line is not its answer", async () => {
  const rl = new FakeReadline();
  const ac = new AbortController();
  const { o } = opts({ signal: ac.signal });
  const answer = askCancellableOn(rl, "? ", o);
  ac.abort();
  assert.equal(await answer, "");
  assert.equal(rl.pending, null, "no callback left to swallow the next command");
  const next: string[] = [];
  rl.on("line", (l) => next.push(l));
  rl.type("/help");
  rl.enter();
  assert.deepEqual(next, ["/help"]);
});

test("Ctrl-D (close) answers no instead of leaving the caller waiting forever", async () => {
  const rl = new FakeReadline();
  const { o } = opts();
  const answer = askCancellableOn(rl, "? ", o);
  rl.close();
  assert.equal(await answer, "");
});

test("already cancelled or closed: answered no without asking", async () => {
  const ac = new AbortController();
  ac.abort();
  for (const o of [opts({ signal: ac.signal }).o, opts({ closed: true }).o]) {
    const rl = new FakeReadline();
    assert.equal(await askCancellableOn(rl, "? ", o), "");
    assert.deepEqual(rl.queries, []);
  }
});

test("a real answer comes through", async () => {
  const rl = new FakeReadline();
  const { o } = opts({ signal: new AbortController().signal });
  const answer = askCancellableOn(rl, "? ", o);
  rl.type("yes");
  rl.enter();
  assert.equal(await answer, "yes");
});
