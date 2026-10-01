// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * e2e/model-probe.spec.ts — Task #18 regression: the Model Hub's local-runner probe survives
 * the REAL production CSP.
 *
 * THE BUG (found live during e2e testing on Task #14, fixed here): `endpoint-hook.ts`'s
 * `probeServedModels` used to call the global `fetch` directly FROM THE RENDERER against
 * `http://127.0.0.1:<port>/models` to discover a local runner's served models. Production ships
 * `connect-src 'self'` (`main/index.ts`) — that `fetch` throws `TypeError: Failed to fetch` in
 * the packaged app, `probeServedModels` swallows it and returns `[]` (its normal "runner is
 * down" fail-soft path), and `expandServedModels` reads the empty list as "nothing served" and
 * DROPS the endpoint. Ollama, llama.cpp, every local runner — silently gone from the Model Hub
 * picker, in the actual app a user installs, while working fine under the looser dev CSP.
 *
 * THE FIX moved the probe into MAIN (`main/ai-ipc.ts`'s `probeServedModels`, wired up as the
 * `ai:probeModels` IPC channel — the SAME MAIN-process detour `ai:stream` already takes for
 * chat completions, for the identical CSP reason). `connect-src` itself is UNCHANGED; the
 * renderer still never touches the network directly (C5).
 *
 * This spec proves the fix two ways, both against the REAL BUILT app (`electron-app.ts`'s
 * `launchApp` boots `out/main/index.js`, not the vite dev server — see its module doc for why
 * that distinction matters here):
 *
 *   1. A renderer-side `fetch` to the stub runner is STILL refused by the CSP — confirming this
 *      spec is actually exercising the strict production policy, not a looser one.
 *   2. The Model Hub picker STILL lists the stub's served model — proving the probe that feeds
 *      it no longer depends on the renderer `fetch` that policy blocks.
 *
 * The runner itself is a REAL `node:http` server on a REAL loopback socket
 * (`fake-model-server.ts`, extended for this task to answer `GET {baseUrl}/models` — the exact
 * request `probeServedModels` makes, shaped like the OpenAI-compatible `/v1/models` response
 * Ollama's compatibility layer and llama.cpp both serve). Only "which endpoint exists" is
 * scripted; the discovery request that follows is genuinely dispatched over a real socket, by
 * the real main-process handler, and genuinely parsed.
 */
import { expect, test } from "@playwright/test";

import { type LaunchedApp, launchApp, overrideModelEndpoints } from "./electron-app.js";
import { type FakeModelServer, startFakeModelServer } from "./fake-model-server.js";

const MODEL_ID = "e2e-model-probe-fixture";

let launched: LaunchedApp;
let runner: FakeModelServer;

test.beforeAll(async () => {
  // No chat turn is driven anywhere in this spec — discovery is the only thing under test —
  // so the scripted chat-completion turn is never invoked; the argument is required by the
  // stub's shape only.
  runner = await startFakeModelServer(() => ({ text: "" }), { servedModels: [MODEL_ID] });

  launched = await launchApp();
  await overrideModelEndpoints(launched, {
    ok: true,
    local: [{ name: "e2e-runner", baseUrl: runner.baseUrl }],
    openApi: [],
  });
});

test.afterAll(async () => {
  await launched?.close();
  await runner?.close();
});

test("a renderer-side fetch to the loopback runner is refused by the real production CSP", async () => {
  const { page } = launched;
  const outcome = await page.evaluate(async (url) => {
    try {
      await fetch(url);
      return "NO ERROR — fetch unexpectedly succeeded";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, `${runner.baseUrl}/models`);
  // Chromium's CSP-refused fetch surfaces as exactly this TypeError — if this stops matching,
  // either the CSP relaxed (a regression this spec exists to catch the OPPOSITE of) or Chromium
  // changed its wording, either of which is worth knowing about explicitly rather than silently.
  expect(outcome).toMatch(/Failed to fetch/i);
});

test("the Model Hub picker lists the stub's served model — the probe survives the CSP", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "AI assistant", exact: true }).click({ force: true });

  const picker = page.getByLabel("model endpoint");
  // `expandServedModels` names a local served-model entry `${endpointId} · ${model}` — the
  // model id is the fixture's fingerprint proving THIS runner answered THIS probe.
  const option = picker.locator("option", { hasText: MODEL_ID });
  await expect(option).toHaveCount(1, { timeout: 15_000 });

  // Not just present as text — genuinely selectable, i.e. it is a real picker entry the rest
  // of the agent pane can drive a turn against.
  const value = await option.getAttribute("value");
  expect(value).toBeTruthy();
  await picker.selectOption(value ?? "");
  await expect(picker).toHaveValue(value ?? "");
});
