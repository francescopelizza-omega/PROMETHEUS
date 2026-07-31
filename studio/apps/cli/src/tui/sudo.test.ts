/**
 * sudo.test.ts — elevation detection, the exact ack prompt, and the decision matrix.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SUDO_ACK_PROMPT,
  detectElevation,
  interpretSudoAnswer,
  isElevated,
  resolveSudoDecision,
  sudoWarningLines,
} from "./sudo.js";

test("detectElevation: sudo wins via SUDO_USER even when uid is 0", () => {
  assert.equal(detectElevation({ env: { SUDO_USER: "fp" }, getuid: () => 0 }), "sudo");
  assert.equal(detectElevation({ env: { SUDO_UID: "501" }, getuid: () => 1000 }), "sudo");
});

test("detectElevation: root via uid 0, none otherwise", () => {
  assert.equal(detectElevation({ env: {}, getuid: () => 0 }), "root");
  assert.equal(detectElevation({ env: {}, getuid: () => 501 }), null);
  // no getuid (Windows) + no sudo env → not elevated
  assert.equal(detectElevation({ env: {} }), null);
});

test("isElevated mirrors detectElevation", () => {
  assert.equal(isElevated({ env: {}, getuid: () => 0 }), true);
  assert.equal(isElevated({ env: {}, getuid: () => 501 }), false);
});

test("the ack prompt is the mandated verbatim CAPS string", () => {
  assert.equal(
    SUDO_ACK_PROMPT,
    "YOU ARE CONSIDERED AS A HUMAN BEING THAT CAN UNDERSTAND THE HARM AND CAN THEN AUTHORISE PROMETHEUS TO START UP WITH SUCH PRIVILEDGES: [Y/n]",
  );
  // the warning body ends with that exact prompt
  assert.equal(sudoWarningLines("root").at(-1), SUDO_ACK_PROMPT);
});

test("interpretSudoAnswer: only n/N/No/NO decline; default+others authorize", () => {
  for (const no of ["n", "N", "no", "No", "NO", " no "]) {
    assert.equal(interpretSudoAnswer(no), "decline", no);
  }
  for (const yes of ["", "y", "Y", "yes", "YES", "sure", "ok"]) {
    assert.equal(interpretSudoAnswer(yes), "authorize", JSON.stringify(yes));
  }
});

test("resolveSudoDecision: not elevated → pass-through, bypass available", () => {
  const d = resolveSudoDecision(null, null);
  assert.equal(d.proceed, true);
  assert.equal(d.bypassLocked, false);
  assert.equal(d.startMode, "default");
});

test("resolveSudoDecision: decline → force default + lock bypass (still proceeds)", () => {
  const d = resolveSudoDecision("sudo", "n");
  assert.equal(d.proceed, true);
  assert.equal(d.startMode, "default");
  assert.equal(d.bypassLocked, true);
  assert.match(d.note, /ask-before-everything/);
});

test("resolveSudoDecision: authorize → bypass reachable", () => {
  const d = resolveSudoDecision("root", "");
  assert.equal(d.bypassLocked, false);
  assert.match(d.note, /acknowledged/);
});

test("resolveSudoDecision: a null answer when elevated is treated as decline (fail-safe)", () => {
  const d = resolveSudoDecision("root", null);
  assert.equal(d.bypassLocked, true);
});
