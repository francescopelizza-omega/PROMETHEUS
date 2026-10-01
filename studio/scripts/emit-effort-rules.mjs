// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * scripts/emit-effort-rules.mjs — publish the builtin effort table for NON-TypeScript readers.
 *
 * `prometheus.py` has to resolve the same `/think` tier against the same capability table the
 * TypeScript hosts use, and it cannot import `ai/effort/rules.ts`. The plan's rule is that
 * `effort-capabilities.json` is the single source of truth and Python reads it — but the
 * builtins deliberately live in CODE (the Electron renderer imports that module across the C5
 * boundary and may not read files; and two hand-maintained copies of one table is exactly the
 * drift this subsystem keeps being bitten by).
 *
 * So the source stays TypeScript and this GENERATES the JSON. One table, one author, no second
 * copy to forget. A test asserts the artifact matches `builtinRules()`, so a rule added in TS
 * without re-running this fails the build rather than silently leaving Python on a stale table.
 *
 * Run: node scripts/emit-effort-rules.mjs   (writes config/effort-capabilities.builtin.json)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { builtinRules } from "../packages/core/dist/ai/effort/rules.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const ARTIFACT = join(ROOT, "config", "effort-capabilities.builtin.json");

/** The artifact's payload — kept as a function so the sync test can compare without file IO. */
export function buildArtifact() {
  return {
    $comment: [
      "GENERATED — do not edit. Source: studio/packages/core/src/ai/effort/rules.ts",
      "Regenerate with: node studio/scripts/emit-effort-rules.mjs",
      "",
      "This is the BUILTIN table, published so prometheus.py can resolve the same /think tier",
      "as the TypeScript hosts. User and workspace overrides are a different file —",
      "effort-capabilities.json — and are layered AFTER these (later wins a specificity tie).",
      "",
      "Each rule carries a `provenance`: measured (sent at a live server and the accepted set",
      "read back out of its error), published (the provider's current documented contract), or",
      "inferred (release notes / model cards / prior knowledge, NOT verified end to end).",
    ],
    version: 1,
    rules: builtinRules(),
  };
}

/** Stable, human-diffable JSON — the artifact is committed, so churn must be meaningful. */
export function serializeArtifact() {
  return `${JSON.stringify(buildArtifact(), null, 2)}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  writeFileSync(ARTIFACT, serializeArtifact());
  const { rules } = buildArtifact();
  const by = rules.reduce((acc, r) => {
    acc[r.provenance ?? "MISSING"] = (acc[r.provenance ?? "MISSING"] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`emit-effort-rules: ${rules.length} rules -> ${ARTIFACT}`);
  console.log(`  provenance: ${JSON.stringify(by)}`);
}
