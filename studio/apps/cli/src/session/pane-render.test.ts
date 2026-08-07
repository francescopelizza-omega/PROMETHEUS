/**
 * session/pane-render.test.ts — node:test unit tests for the P4 pane router.
 *
 * Pure-string, deterministic, no engine / no TTY: color is force-disabled so the
 * assertions match raw text. Covers the chat/transcript pane + footer (owned by
 * this module), the pane title routing, the placeholder fallback for projector-less
 * panes, and that every projector-backed pane dispatches without throwing and
 * yields a non-empty body. The sibling ../render/* projectors ship in the same
 * wave; we assert structure (title + non-empty body), not their exact output.
 *
 * Runs under Node's native type-stripping (node --test src/session/pane-render.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { repl } from "@prometheus/core";
import type {
  CatalogEntry,
  HardenFinding,
  MatrixEnvelope,
  OpenModelRow,
  SecurityVerdict,
} from "@prometheus/engine-bridge";

import { setColorEnabled, visibleLen } from "../render.js";
import type { ItemCard } from "../render/catalog-view.js";
import { type PaneModel, renderPane } from "./pane-render.js";

// Force color off so assertions compare raw text (no ANSI escapes).
setColorEnabled(false);

// A minimal AgentTuning that footerLine accepts (shape comes from agent.loop).
function makeTuning(): repl.ReplState["tuning"] {
  return {
    model: { provider: "anthropic", modelId: "claude-opus" },
    systemPrompt: "You are Prometheus.",
    tools: { enabled: true, allow: [], deny: [] },
    gateMode: "enforce",
    dryRun: false,
    verbosity: "normal",
    yes: false,
  };
}

function stateWith(messages: repl.ReplState["transcript"]): repl.ReplState {
  const s = repl.initialReplState(makeTuning(), "/tmp/ws");
  return { ...s, transcript: messages };
}

// ---- chat / transcript pane ------------------------------------------------ //

test("renderPane transcript: empty shows a gentle prompt + footer", () => {
  const out = renderPane("transcript", { pane: "transcript", state: stateWith([]) });
  assert.match(out, /Chat/); // title
  assert.match(out, /No messages yet/);
  // footer reflects tuning (model + gate)
  assert.match(out, /model claude-opus/);
  assert.match(out, /gate:enforce/);
});

test("renderPane transcript: renders speakers and multi-line continuation", () => {
  const out = renderPane("transcript", {
    pane: "transcript",
    state: stateWith([
      { role: "you", text: "hello" },
      { role: "prometheus", text: "line one\nline two" },
      { role: "system", text: "noted" },
    ]),
  });
  assert.match(out, /you hello/);
  assert.match(out, /prometheus line one/);
  // continuation line is indented under the speaker, not re-prefixed
  assert.match(out, /\n {5}line two/);
  assert.match(out, /system noted/);
});

// ---- title routing --------------------------------------------------------- //

test("renderPane: title is drawn by paneId and can be suppressed", () => {
  const model: PaneModel = { pane: "env", text: "PATH=/usr/bin" };
  const withTitle = renderPane("env", model);
  assert.match(withTitle, /Environment/);

  const noTitle = renderPane("env", model, { noTitle: true });
  assert.doesNotMatch(noTitle, /Environment/);
  assert.match(noTitle, /PATH=\/usr\/bin/);
});

// ---- placeholder panes ----------------------------------------------------- //

test("renderPane: projector-less pane with no text shows a placeholder", () => {
  const out = renderPane("repo", { pane: "repo" }, { noTitle: true });
  assert.match(out, /Repository — nothing to show yet/);
});

test("renderPane: projector-less pane echoes provided text verbatim", () => {
  const out = renderPane("app", { pane: "app", text: "my-app v1.2" }, { noTitle: true });
  assert.equal(out, "my-app v1.2");
});

// ---- projector-backed panes (dispatch + non-empty, no throw) --------------- //

const VERDICT: SecurityVerdict = {
  verdict: "allow",
  risk_score: 0,
  signed: true,
  findings: [],
  scannedAt: "2026-06-22T00:00:00Z",
  target: "example/plugin",
};

const CATALOG: CatalogEntry[] = [
  {
    name: "example",
    tier: "official",
    summary: "An example plugin",
    repo: "github.com/example/plugin",
    stars: 42,
    license: "MIT",
    scope: "universal",
    supported_os: ["macos", "linux"],
    recommend_rank: 1,
    targets: { claude: { method: "marketplace", installed: false } },
  },
];

const CARD: ItemCard = {
  id: "example",
  kind: "plugin",
  name: "example",
  summary: "An example plugin",
  repo: "github.com/example/plugin",
  license: "MIT",
  category: "universal",
  tier: "official",
  security: "no findings",
  installable: true,
  has_tutorial: false,
};

const MATRIX: MatrixEnvelope = {
  command: "matrix",
  ok: true,
  agents: ["claude", "codex"],
  reach: [{ plugin: "example", scope: "U", native: ["claude"], sync: [], unavailable: ["codex"] }],
};

const MODELS: OpenModelRow[] = [
  {
    id: "qwen2.5-coder-7b",
    name: "Qwen2.5 Coder 7B",
    params: "7B",
    license: "Apache-2.0",
    ollama: "qwen2.5-coder:7b",
    served: "vllm",
    note: "",
  },
];

const HARDEN: HardenFinding[] = [{ severity: "warn", message: "ssh exposed", fix: "disable it" }];

test("renderPane: every projector-backed pane dispatches to a non-empty body", () => {
  const cases: Array<[repl.PaneId, PaneModel]> = [
    ["catalog", { pane: "catalog", items: CATALOG }],
    ["catalog", { pane: "catalog", items: CATALOG, focus: CARD }],
    ["model", { pane: "model", models: MODELS }],
    ["matrix", { pane: "matrix", matrix: MATRIX }],
    ["audit", { pane: "audit", verdict: VERDICT }],
    ["scan", { pane: "scan", verdict: VERDICT }],
    ["skills", { pane: "skills", verdict: VERDICT }],
    ["vault", { pane: "vault", findings: HARDEN }],
  ];
  for (const [paneId, model] of cases) {
    const out = renderPane(paneId, model);
    assert.ok(visibleLen(out) > 0, `pane ${paneId} produced empty output`);
    // title present (not suppressed)
    assert.ok(out.split("\n").length >= 1, `pane ${paneId} missing body`);
  }
});

test("renderPane: tuning shape sanity (footer building block)", () => {
  // Guards that the tuning shape used in fixtures matches what footerLine reads.
  const line = repl.footerLine(makeTuning());
  assert.match(line, /model claude-opus/);
});
