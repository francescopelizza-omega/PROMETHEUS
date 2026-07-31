/**
 * inline-values.test.ts — the pure inline-value decoration builder (APP-031).
 *
 * Run: node --import ../../../../../../apps/cli/dev-register.mjs --test inline-values.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INLINE_VALUE_CLASS,
  MAX_INLINE_PAIRS,
  MAX_INLINE_VALUE_LEN,
  buildInlineValueDecorations,
  formatInlinePairs,
} from "./inline-values.js";

test("formatInlinePairs: joined pairs, caps, truncation, newline flattening", () => {
  assert.equal(
    formatInlinePairs([
      { name: "x", value: "1" },
      { name: "s", value: "'hi'" },
    ]),
    "  x = 1, s = 'hi'",
  );
  assert.equal(formatInlinePairs([]), "");
  // per-value truncation with an ellipsis
  const long = "a".repeat(MAX_INLINE_VALUE_LEN + 10);
  const out = formatInlinePairs([{ name: "v", value: long }]);
  assert.ok(out.endsWith("…"));
  assert.ok(out.length < long.length);
  // multiline values flatten to one line
  assert.equal(formatInlinePairs([{ name: "m", value: "line1\n  line2" }]), "  m = line1 line2");
  // pair cap with a "+N more" tail
  const many = Array.from({ length: MAX_INLINE_PAIRS + 3 }, (_, i) => ({
    name: `v${i}`,
    value: String(i),
  }));
  const capped = formatInlinePairs(many);
  assert.ok(capped.includes("+3 more"));
  assert.ok(!capped.includes(`v${MAX_INLINE_PAIRS}`), "pairs beyond the cap are not rendered");
});

test("buildInlineValueDecorations: one zero-width after-content decoration at line end", () => {
  const d = buildInlineValueDecorations(12, 34, [{ name: "x", value: "1" }]);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0]?.range, {
    startLineNumber: 12,
    startColumn: 34,
    endLineNumber: 12,
    endColumn: 34,
  });
  assert.equal(d[0]?.options.after.content, "  x = 1");
  assert.equal(d[0]?.options.after.inlineClassName, INLINE_VALUE_CLASS);
});

test("buildInlineValueDecorations: empty pairs / invalid line clear to []", () => {
  assert.deepEqual(buildInlineValueDecorations(12, 34, []), []);
  assert.deepEqual(buildInlineValueDecorations(0, 34, [{ name: "x", value: "1" }]), []);
  assert.deepEqual(buildInlineValueDecorations(3, 0, [{ name: "x", value: "1" }]), []);
});
