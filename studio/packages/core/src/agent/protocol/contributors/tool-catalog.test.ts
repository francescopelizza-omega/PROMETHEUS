/**
 * tool-catalog.test.ts — the existing tool catalog, wrapped as a contributor.
 *
 * Uses the REAL tool catalog (mirroring `preamble.test.ts`'s own reasoning): a synthetic
 * three-tool fixture would prove nothing about whether the degrade ladder actually engages.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PROMETHEUS_TOOLS } from "../../../mcp/server/tools.js";
import { PROPOSE_EDIT_TOOL, WRITE_FILE_TOOL } from "../../edit.js";
import { SYSTEM_TOOLS } from "../../system/tools.js";
import type { ToolDef } from "../../tools.js";
import { WEB_FETCH_TOOL } from "../../web.js";
import type { PreambleCtx } from "../preamble-dispatch.js";
import { preambleBudget } from "../preamble.js";
import { toolCatalogContributor } from "./tool-catalog.js";

const FULL: readonly ToolDef[] = [
  ...PROMETHEUS_TOOLS,
  ...SYSTEM_TOOLS,
  PROPOSE_EDIT_TOOL,
  WRITE_FILE_TOOL,
  WEB_FETCH_TOOL,
];

const ctx = (over: Partial<PreambleCtx>): PreambleCtx => ({
  surface: "cli",
  isSubAgent: false,
  readOnly: false,
  locality: "local",
  tools: FULL,
  ...over,
});

test("applies: false with no tools, false with no/none transport, true otherwise", () => {
  assert.equal(toolCatalogContributor.applies(ctx({ tools: [], transport: "native" })), false);
  assert.equal(toolCatalogContributor.applies(ctx({ transport: undefined })), false);
  assert.equal(toolCatalogContributor.applies(ctx({ transport: "none" })), false);
  assert.equal(toolCatalogContributor.applies(ctx({ transport: "native" })), true);
  assert.equal(toolCatalogContributor.applies(ctx({ transport: "text" })), true);
});

test("a tiny shared budget forces the degrade ladder — result is non-null, degraded, with omissions", () => {
  const unit = toolCatalogContributor.render(ctx({ transport: "native" }), 50);
  assert.ok(unit);
  assert.ok(unit?.degraded);
  assert.ok((unit?.degraded?.omitted?.length ?? 0) > 0);
});

test("the outer pool never balloons the catalog past its own historically-tuned ceiling", () => {
  // Generous OUTER budget (5000) but a SMALL context window (8192) — the inner
  // `preambleBudget(8192)` ceiling must still be the binding constraint.
  const smallWindowCtx = ctx({ transport: "native", contextWindow: 8192 });
  const withGenerousOuter = toolCatalogContributor.render(smallWindowCtx, 5000);
  const innerCeiling = preambleBudget(8192);
  assert.ok(withGenerousOuter);
  // Approximate token count of the rendered text must not exceed the inner ceiling by more than
  // a rounding margin — proves `min(outer, inner)` is what actually gates the ladder.
  const approxTokens = Math.ceil((withGenerousOuter?.text.length ?? 0) / 4);
  assert.ok(
    approxTokens <= innerCeiling + 50,
    `rendered ${approxTokens} tokens exceeds the inner ceiling of ${innerCeiling}`,
  );
});
