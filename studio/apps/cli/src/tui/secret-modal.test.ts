/**
 * secret-modal.test.ts — an API key pasted into the TUI never reaches the screen.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type ModalView, applyModalKey, modalCursorCol, renderModal } from "./frame.js";

test("a secret ask modal paints bullets, keeps the real text in the buffer", () => {
  let m: ModalView = { kind: "ask", prompt: "key:", buffer: "", caret: 0, secret: true };
  for (const ch of "sk-live-123") m = applyModalKey(m, { name: "char", ch });
  assert.equal(m.buffer, "sk-live-123");
  const painted = renderModal(m, 80, "none").join("\n");
  assert.ok(!painted.includes("sk-live"), "the key must not be painted");
  assert.ok(painted.includes("•".repeat(11)));
});

test("the caret column matches the bullets, not the hidden text", () => {
  const plain: ModalView = { kind: "ask", prompt: "key:", buffer: "abc", caret: 3 };
  const secret: ModalView = { ...plain, secret: true };
  assert.equal(modalCursorCol(secret), modalCursorCol(plain), "ASCII: one bullet per char");
  const wide: ModalView = { kind: "ask", prompt: "k", buffer: "漢字", caret: 2, secret: true };
  assert.equal(modalCursorCol(wide), modalCursorCol({ ...wide, buffer: "••", secret: false }));
});

test("an ordinary ask modal is unchanged", () => {
  const m: ModalView = { kind: "ask", prompt: "name:", buffer: "bob", caret: 3 };
  assert.ok(renderModal(m, 80, "none").join("").includes("bob"));
});
