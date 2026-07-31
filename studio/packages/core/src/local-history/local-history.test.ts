/**
 * local-history.test.ts — the capped ring buffer + file-snapshot history + capture
 * policy + line-delta + serialize (file 13 §2.6).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLocalHistory,
  createRingBuffer,
  deserializeHistory,
  entries,
  latestFor,
  lineDelta,
  push,
  recordSnapshot,
  revertContent,
  serializeHistory,
  shouldCapture,
  snapshotsFor,
} from "./index.js";

// ---- ring buffer ----------------------------------------------------------- //

test("ring buffer is a bounded FIFO — drops the oldest past capacity", () => {
  let buf = createRingBuffer<number>(3);
  for (const n of [1, 2, 3, 4, 5]) buf = push(buf, n);
  assert.deepEqual(entries(buf), [3, 4, 5]);
  assert.equal(buf.capacity, 3);
});

// ---- capture policy (§2.6 #4) --------------------------------------------- //

test("shouldCapture refuses secrets/large binaries, allows normal source", () => {
  assert.equal(shouldCapture("src/app.ts", "const x = 1", {}), true);
  assert.equal(shouldCapture(".env", "SECRET=abc", {}), false);
  assert.equal(shouldCapture("keys/id_rsa", "-----BEGIN", {}), false);
  assert.equal(shouldCapture("node_modules/x/index.js", "x", {}), false);
  assert.equal(shouldCapture("big.bin", "x".repeat(20), { maxBytes: 10 }), false);
  assert.equal(shouldCapture("secret.custom", "x", { neverCapture: ["**/*.custom"] }), false);
});

// ---- snapshot history + revert -------------------------------------------- //

test("recordSnapshot stores allowed files and skips never-capture ones", () => {
  let h = createLocalHistory(10);
  h = recordSnapshot(h, { path: "a.ts", content: "v1", ts: 1 });
  h = recordSnapshot(h, { path: "a.ts", content: "v2", ts: 2 });
  h = recordSnapshot(h, { path: ".env", content: "S=1", ts: 3 }); // skipped
  assert.equal(snapshotsFor(h, "a.ts").length, 2);
  assert.equal(latestFor(h, "a.ts")?.content, "v2", "newest first");
  assert.equal(revertContent(h, "a.ts", 1), "v1");
  assert.equal(snapshotsFor(h, ".env").length, 0);
});

// ---- line delta ------------------------------------------------------------ //

test("lineDelta counts added/removed lines", () => {
  assert.deepEqual(lineDelta("a\nb", "a\nb"), { added: 0, removed: 0, changed: false });
  const d = lineDelta("a\nb\nc", "a\nc\nd\ne");
  assert.equal(d.changed, true);
  assert.equal(d.added, 2); // d, e
  assert.equal(d.removed, 1); // b
});

// ---- serialize round-trip -------------------------------------------------- //

test("serialize/deserialize round-trips and is fail-soft", () => {
  let h = createLocalHistory(5);
  h = recordSnapshot(h, { path: "x.ts", content: "hi", ts: 7 });
  const json = serializeHistory(h);
  const back = deserializeHistory(json);
  assert.equal(snapshotsFor(back, "x.ts")[0]?.content, "hi");
  assert.equal(
    entries(deserializeHistory("garbage")).length,
    0,
    "bad JSON → empty history, no throw",
  );
});
