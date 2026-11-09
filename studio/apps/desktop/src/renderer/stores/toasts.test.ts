// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TOASTS, enqueueToast, errorText, notify, useToastStore } from "./toasts.js";

test("the same message replaces its earlier copy instead of stacking", () => {
  let q = enqueueToast([], { title: "Download failed", tone: "danger" }, "a");
  q = enqueueToast(q, { title: "Download failed", tone: "danger" }, "b");
  assert.deepEqual(
    q.map((t) => t.id),
    ["b"],
  );
  q = enqueueToast(q, { title: "x", key: "dl:qwen" }, "c");
  q = enqueueToast(q, { title: "y", key: "dl:qwen" }, "d");
  assert.deepEqual(
    q.map((t) => [t.id, t.title]),
    [
      ["b", "Download failed"],
      ["d", "y"],
    ],
  );
});

test("at most MAX_TOASTS are shown, oldest dropped first", () => {
  let q = enqueueToast([], { title: "t0" }, "0");
  for (let i = 1; i <= MAX_TOASTS + 2; i++) q = enqueueToast(q, { title: `t${i}` }, String(i));
  assert.equal(q.length, MAX_TOASTS);
  assert.equal(q[0]?.title, `t${MAX_TOASTS + 2 - MAX_TOASTS + 1}`);
  assert.equal(q.at(-1)?.title, `t${MAX_TOASTS + 2}`);
});

test("danger lingers longer; the rest fade; 0 is opt-in sticky", () => {
  assert.equal(enqueueToast([], { title: "a", tone: "danger" }, "1")[0]?.duration, 15_000);
  assert.equal(enqueueToast([], { title: "a", tone: "ok" }, "1")[0]?.duration, 6000);
  assert.equal(enqueueToast([], { title: "a", tone: "ok", duration: 0 }, "1")[0]?.duration, 0);
});

test("notify pushes into the store and dismiss removes", () => {
  useToastStore.getState().clear();
  const id = notify({ title: "Model ready", tone: "ok" });
  assert.equal(useToastStore.getState().toasts.length, 1);
  useToastStore.getState().dismiss(id);
  assert.equal(useToastStore.getState().toasts.length, 0);
});

test("errorText reads Error, string and {error} envelopes", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("plain"), "plain");
  assert.equal(errorText({ ok: false, error: "refused" }), "refused");
  assert.equal(errorText(42), "unknown error");
});
