/**
 * e2e/notebook-edit-card.spec.ts — the `notebook_edit` tool's task-card click path actually
 * updating a real OPEN notebook tab, from inside a live chat turn in the real built app
 * (Task #14).
 *
 * Real all the way down: a real `.ipynb` fixture on disk, a real workspace/tab restored via
 * the SAME persisted-tabs blob (`prometheus.workbench.tabs`) a relaunch reads
 * (`apps/desktop/src/renderer/ide/state/session-restore.ts`), a real chat turn through the
 * live AgentPane, core's real broker routing `notebook_edit` (`destructiveHint: true`) to a
 * human task card, and a real click on that card's "▶ Run (gated)" button — which dispatches
 * `apps/desktop/src/renderer/ide/notebook/notebook-tool.ts`'s `runNotebookTool` against the
 * SAME notebook store instance backing the open `NotebookContainer` tab
 * (`run-controller.ts`'s `claimCardResult` replay discipline is what stops the loop from
 * re-running the edit a second time once the turn resumes). Only the model's answer is
 * scripted — see `electron-app.ts` for why.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { type LaunchedApp, launchApp, overrideModelEndpoints } from "./electron-app.js";
import { type FakeModelServer, startFakeModelServer } from "./fake-model-server.js";

const MODEL_ID = "e2e-notebook-fixture";
const ORIGINAL_SOURCE = "print('original')";
const NEW_SOURCE = "print('hello e2e')";

const FIXTURE_NOTEBOOK = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      id: "cell-0",
      cell_type: "code",
      source: [`${ORIGINAL_SOURCE}\n`],
      metadata: {},
      outputs: [],
      execution_count: null,
    },
  ],
};

let launched: LaunchedApp;
let model: FakeModelServer;
let workspaceDir: string;
let notebookPath: string;
let notebookUri: string;

test.beforeAll(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "prom-e2e-nb-workspace-"));
  notebookPath = join(workspaceDir, "analysis.ipynb");
  notebookUri = `file://${notebookPath}`;
  writeFileSync(notebookPath, `${JSON.stringify(FIXTURE_NOTEBOOK, null, 1)}\n`);

  // Round 0: the model calls notebook_edit on cell 0 of the fixture. The broker routes it to
  // a human (destructiveHint) and the turn SUSPENDS — core's `confirm` is an ordinary await, so
  // no second HTTP request happens until the task card below is actually clicked.
  model = await startFakeModelServer(
    (i) =>
      i === 0
        ? {
            toolCall: {
              name: "notebook_edit",
              args: { path: notebookUri, cellIndex: 0, newSource: NEW_SOURCE },
            },
          }
        : { text: "Done — I updated the first cell." },
    { servedModels: [MODEL_ID] },
  );

  launched = await launchApp();

  await overrideModelEndpoints(launched, {
    ok: true,
    local: [{ name: "e2e-fake", baseUrl: model.baseUrl }],
    openApi: [],
  });

  // Restore a workspace + an already-open notebook tab THE SAME WAY a relaunch would —
  // seeding `session-restore.ts`'s persisted-tabs blob then reloading, exactly the pattern
  // `electron-app.ts` already uses for the theme/onboarding flags above.
  const { page } = launched;
  const tabsBlob = {
    version: 1,
    tabs: {
      docs: [
        {
          uri: notebookUri,
          name: "analysis.ipynb",
          languageId: "plaintext",
          dirty: false,
          preview: false,
          group: 0,
          large: false,
        },
      ],
      activeByGroup: { 0: notebookUri },
      focusedGroup: 0,
    },
    workspaceRoot: workspaceDir,
  };
  await page.evaluate(([key, blob]) => window.localStorage.setItem(key, blob), [
    "prometheus.workbench.tabs",
    JSON.stringify(tabsBlob),
  ] as const);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("navigation", { name: "Activity bar" })
    .waitFor({ state: "visible", timeout: 20_000 });
  // The `ipcMain` override lives in MAIN and survives a renderer reload untouched — re-applying
  // it is just cheap idempotent insurance against reordering this block later. The probe itself
  // (`ai:probeModels`) is a real MAIN→loopback GET against `fake-model-server.ts`, unaffected by
  // the renderer reload, so nothing page-scoped needs redoing here anymore (Task #18).
  await overrideModelEndpoints(launched, {
    ok: true,
    local: [{ name: "e2e-fake", baseUrl: model.baseUrl }],
    openApi: [],
  });
});

test.afterAll(async () => {
  await launched?.close();
  await model?.close();
  rmSync(workspaceDir, { recursive: true, force: true });
});

test("clicking the notebook_edit task card updates the real open notebook tab", async () => {
  const { page } = launched;

  await page.getByRole("button", { name: "Editor", exact: true }).click({ force: true });
  const originalCell = page.getByLabel("code cell").first();
  await expect(originalCell).toHaveValue(new RegExp(ORIGINAL_SOURCE.replace(/[()]/g, "\\$&")), {
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "AI assistant", exact: true }).click({ force: true });
  const composer = page.getByLabel("agent message");
  await expect(composer).toBeEnabled({ timeout: 15_000 });
  await composer.fill(`update the first cell of ${notebookPath} to print a greeting`);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // The confirm-gated task card (§7.3): `notebook_edit` is `destructiveHint`, so the broker
  // suspends the turn on a human card rather than auto-running it.
  const runButton = page.getByRole("button", { name: "▶ Run (gated)" });
  await expect(runButton).toBeVisible({ timeout: 20_000 });
  // proves the model's call actually reached the card (not a generic placeholder) — the
  // Panel's own title, `${card.tool} · ${card.status}` (AgentPane.tsx).
  await expect(page.getByText("notebook_edit · pending")).toBeVisible();

  // The cell must NOT have changed yet — the card is pending, nothing has run.
  await expect(originalCell).toHaveValue(new RegExp(ORIGINAL_SOURCE.replace(/[()]/g, "\\$&")));

  await runButton.click();

  // The SAME open tab's cell — no reload, no re-navigation — reflects the edit once the card
  // resolves. This is the live-wiring assertion the task exists to make: the task card's
  // click reaches the SAME notebook store instance backing the mounted NotebookContainer.
  const updatedCell = page.getByLabel("code cell").first();
  await expect(updatedCell).toHaveValue(new RegExp(NEW_SOURCE.replace(/[()']/g, "\\$&")), {
    timeout: 20_000,
  });

  // The turn actually continued afterwards (round 2 of the loop, off the resolved card).
  await expect(page.getByText("Done — I updated the first cell.")).toBeVisible({
    timeout: 20_000,
  });

  // Belt and braces: the tool's own `store.save` (real fsWrite) landed on disk too.
  const onDisk = readFileSync(notebookPath, "utf8");
  expect(onDisk).toContain(NEW_SOURCE);
  expect(onDisk).not.toContain(ORIGINAL_SOURCE);
});
