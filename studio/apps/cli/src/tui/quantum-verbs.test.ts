/**
 * quantum-verbs.test.ts — the working-spinner vocabulary + caps-gated formatter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { QUANTUM_VERBS, quantumVerb, spinnerFrame, workingLine } from "./quantum-verbs.js";

test("quantumVerb wraps for any integer (positive/negative)", () => {
  assert.equal(quantumVerb(0), QUANTUM_VERBS[0]);
  assert.equal(quantumVerb(QUANTUM_VERBS.length), QUANTUM_VERBS[0]);
  assert.equal(quantumVerb(-1), QUANTUM_VERBS[QUANTUM_VERBS.length - 1]);
});

test("spinnerFrame cycles the braille frames", () => {
  assert.equal(spinnerFrame(0), spinnerFrame(10));
  assert.notEqual(spinnerFrame(0), spinnerFrame(1));
});

test("workingLine at caps='none' emits ZERO escape bytes and a plain line", () => {
  const line = workingLine(3, 4200, "none", 0);
  assert.ok(!line.includes("\x1b"));
  assert.match(line, /Entangling… \(4s · esc to interrupt\)/); // seed 0, tick 3 < hold ⇒ verb[0], 4s
});

test("workingLine at truecolor paints (has escapes) and still names the verb + elapsed", () => {
  const line = workingLine(0, 1000, "truecolor", 0);
  assert.ok(line.includes("\x1b"));
  assert.match(line, /1s · esc to interrupt/);
});
