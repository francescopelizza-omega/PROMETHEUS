// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * models-download.test.ts — a re-run's state comes from the ENGINE's new verdict, never from the
 * click that asked for it (2026-11-03 audit).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { useModelsStore } from "./models.js";

const ROW = { id: "qwen3:8b:q4", modelId: "qwen3:8b", quant: "q4" };

function runTo(verdict: "allow" | "warn" | "block"): void {
  const s = useModelsStore.getState();
  const row = s.downloads[ROW.id];
  if (row) s.requeueDownload(ROW.id);
  s.enqueueDownload(ROW);
  s.advanceDownload(ROW.id, "start");
  s.advanceDownload(ROW.id, "staged");
  s.applyDownloadVerdict(ROW.id, { verdict } as never);
}

test("a confirmed warn whose re-run BLOCKS shows blocked, not admitted", () => {
  useModelsStore.getState().removeDownload(ROW.id);
  runTo("warn");
  assert.equal(useModelsStore.getState().downloads[ROW.id]?.state, "confirm");
  runTo("block");
  assert.equal(useModelsStore.getState().downloads[ROW.id]?.state, "blocked");
});

test("a forced block that the engine admits shows admitted", () => {
  useModelsStore.getState().removeDownload(ROW.id);
  runTo("block");
  runTo("allow");
  assert.equal(useModelsStore.getState().downloads[ROW.id]?.state, "admitted");
});

test("requeue clears the previous gate", () => {
  useModelsStore.getState().removeDownload(ROW.id);
  runTo("block");
  useModelsStore.getState().requeueDownload(ROW.id);
  const row = useModelsStore.getState().downloads[ROW.id];
  assert.equal(row?.state, "queued");
  assert.equal(row?.gate, undefined);
});
