/**
 * e2e/hook-denial.spec.ts — a configured PreToolUse hook actually denying a real tool call,
 * from inside a live chat turn in the real built app (Task #14).
 *
 * Everything upstream of "what the model says" is real: a real `settings.json` written to a
 * real `<userData>` dir BEFORE boot (main's settings-ipc reads it at startup — see
 * `settings-ipc.ts`'s `publish()`), a real Electron boot (`electron-app.ts`'s `launchApp`,
 * the SAME harness `smoke.spec.ts` uses), a real chat turn driven through the live AgentPane,
 * core's real hook chokepoint (`packages/core/src/agent/loop.ts`'s PreToolUse check, ABOVE the
 * broker) and the real desktop hook runner (`apps/desktop/src/main/agent-hooks.ts`, which
 * refuses to run anything that is not byte-identical to a configured command). Only the
 * model's answer is scripted (`fake-model-server.ts`) — see `electron-app.ts` for why. This
 * suite originally found a REAL bug in the Model Hub's local-runner probe along the way (the
 * production CSP silently dropping every local runner); that bug is now fixed (Task #18, see
 * `model-probe.spec.ts`) and `fake-model-server.ts` answers the probe for real.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { type LaunchedApp, launchApp, overrideModelEndpoints } from "./electron-app.js";
import { type FakeModelServer, startFakeModelServer } from "./fake-model-server.js";

const GUARDED_PATH = "guarded-e2e.txt";
const MODEL_ID = "e2e-hook-fixture";

let launched: LaunchedApp;
let model: FakeModelServer;

test.beforeAll(async () => {
  // The model always tries to write GUARDED_PATH first, then (once told no) answers in text —
  // core's loop re-asks the model automatically after a hook denial (`loop.ts`'s round loop),
  // so this needs no click.
  model = await startFakeModelServer(
    (i) =>
      i === 0
        ? { toolCall: { name: "write_file", args: { path: GUARDED_PATH, content: "hello" } } }
        : { text: "Understood — I will not write to that file." },
    { servedModels: [MODEL_ID] },
  );

  launched = await launchApp({
    beforeLaunch: (userDataDir) => {
      // A REAL settings.json, written before the app process ever starts, exactly the file
      // `apps/desktop/src/main/settings-store.ts` reads as the global layer. The hook denies
      // ONE specific path (`grep` against the PreToolUse JSON on stdin — `{tool, args}`, see
      // `packages/core/src/agent/hooks.ts`) — a nonzero exit is the ONLY thing that denies.
      const settings = {
        hooks: [
          {
            event: "PreToolUse",
            matcher: "write_file",
            command: `grep -q '${GUARDED_PATH}' && exit 1 || exit 0`,
          },
        ],
      };
      writeFileSync(join(userDataDir, "settings.json"), JSON.stringify(settings, null, 2));
    },
  });

  await overrideModelEndpoints(launched, {
    ok: true,
    local: [{ name: "e2e-fake", baseUrl: model.baseUrl }],
    openApi: [],
  });
});

test.afterAll(async () => {
  await launched?.close();
  await model?.close();
});

test("a configured PreToolUse hook denies a real write_file call from a live chat turn", async () => {
  const { page } = launched;

  await page.getByRole("button", { name: "AI assistant", exact: true }).click({ force: true });
  const composer = page.getByLabel("agent message");
  await expect(composer).toBeEnabled({ timeout: 15_000 });

  await composer.fill(`please write "hello" to ${GUARDED_PATH}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // The hook-denial contract rides the SAME refusal shape plan mode uses (`hookRefusal`,
  // `core-agent.ts`'s `case "blocked"`) and lands in the transcript as a tool note: see
  // `AgentPane.tsx`'s `onToolNote` (`🔧 ⛔ <tool> blocked — blocked by hook: <command>`).
  const denial = page.getByText(/blocked by hook:/i);
  await expect(denial).toBeVisible({ timeout: 20_000 });
  await expect(denial).toContainText("write_file");

  // The model's post-denial reply proves the turn actually continued (round 2 of the loop)
  // rather than hanging — the loop's `for (round…)` re-asks the model automatically. This
  // also pins a real race this suite found (see `core-agent.ts`'s `createRendererLlmClient`
  // safety net): an instant reply's progress events can lose the race against the
  // `ai:stream` invoke's own resolution, so this line is exactly the assertion that catches
  // a regression of that fix.
  await expect(page.getByText("Understood — I will not write to that file.")).toBeVisible({
    timeout: 20_000,
  });

  // Belt and braces: the hook fired BEFORE the tool ever ran, so the file must not exist
  // anywhere plausible a bare relative path would land (the desktop's default root is cwd).
  expect(existsSync(join(process.cwd(), GUARDED_PATH))).toBe(false);

  // The fake model actually SAW two requests (the tool call, then the post-denial reply) —
  // proof the hook denial round-tripped back into the thread the model reads, not just the UI.
  expect(model.requests.length).toBeGreaterThanOrEqual(2);
  const secondRequestText = JSON.stringify(model.requests[1]);
  expect(secondRequestText).toMatch(/denied/i);
});
