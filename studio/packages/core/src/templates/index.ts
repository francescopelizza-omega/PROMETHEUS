// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * templates/index.ts — load the 6 shipped init-package templates (file 04 §7).
 *
 * The templates are authored as JSON (one file per template) so they are equally
 * editable by the wizard's "save as template" path and reviewable in a diff.
 * They are imported with `resolveJsonModule` (tsc) + JSON import attributes
 * (Node ESM runtime). Each is cast to the file-04 `Template` shape and the set
 * is validated once at module load so a malformed shipped template fails loud at
 * dev time rather than rendering a broken wizard row.
 *
 * These are the §7 table verbatim:
 *   ml-starter · llm-serving · data-science · airllm · notebook-min · deep-research
 */

import type { Template } from "../env-store.js";

import airllm from "./airllm.json" with { type: "json" };
import dataScience from "./data-science.json" with { type: "json" };
import deepResearch from "./deep-research.json" with { type: "json" };
import llmServing from "./llm-serving.json" with { type: "json" };
import mlStarter from "./ml-starter.json" with { type: "json" };
import notebookMin from "./notebook-min.json" with { type: "json" };

// JSON modules widen string literals (e.g. source:"pypi" → string), so we assert
// each to the precise file-04 Template shape. runtime validation below guards
// against an actually-malformed file; the cast only narrows the static type.
const RAW: readonly Template[] = [
  mlStarter,
  llmServing,
  dataScience,
  airllm,
  notebookMin,
  deepResearch,
] as unknown as readonly Template[];

/** The required keys every shipped template JSON must carry (file 04 §7). */
const REQUIRED_KEYS = ["id", "title", "description", "packages", "editable", "builtin"] as const;

/** Validate one template at load — throws on a malformed shipped JSON. */
function assertValid(t: Template, where: string): void {
  for (const k of REQUIRED_KEYS) {
    if (!(k in (t as object))) {
      throw new Error(`template ${where}: missing required key "${k}"`);
    }
  }
  if (typeof t.id !== "string" || t.id.length === 0) {
    throw new Error(`template ${where}: id must be a non-empty string`);
  }
  if (!Array.isArray(t.packages) || t.packages.length === 0) {
    throw new Error(`template ${t.id}: packages must be a non-empty array`);
  }
  for (const p of t.packages) {
    if (typeof p.name !== "string" || p.name.length === 0) {
      throw new Error(`template ${t.id}: a package row is missing a name`);
    }
  }
  if (t.editable !== true) {
    throw new Error(`template ${t.id}: editable must be true (all templates are editable)`);
  }
  if (typeof t.builtin !== "boolean") {
    throw new Error(`template ${t.id}: builtin must be a boolean`);
  }
}

/** The 6 shipped, validated, frozen built-in templates (file 04 §7), in order. */
export const BUILTIN_TEMPLATES: readonly Template[] = (() => {
  const seen = new Set<string>();
  for (const t of RAW) {
    assertValid(t, t.id ?? "<unknown>");
    if (seen.has(t.id)) throw new Error(`duplicate template id: ${t.id}`);
    seen.add(t.id);
  }
  return Object.freeze(RAW.map((t) => Object.freeze({ ...t })));
})();

/** The shipped template ids, in their canonical §7 order. */
export const BUILTIN_TEMPLATE_IDS: readonly string[] = Object.freeze(
  BUILTIN_TEMPLATES.map((t) => t.id),
);

/** Look up a built-in template by id (undefined if not a shipped id). */
export function getBuiltinTemplate(id: string): Template | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

// --- live/postfix/surround template engine (APP-020) ----------------------- //
// A SEPARATE domain from the project-scaffold rows above (distinct names — no collision
// with BUILTIN_TEMPLATES). Re-exported here for the node/CLI barrel; the renderer imports
// these from the `@prometheus/core/templates` subpath (→ ./live.js) to stay C5-pure.
export type { LiveTemplateDef, LiveTemplateKind, MacroContext, MacroName } from "./live.js";
export {
  LIVE_TEMPLATE_KINDS,
  MACRO_NAMES,
  expandMacros,
  isValidLiveTemplate,
  isoDate,
  previewExpand,
  receiverExpression,
  sanitizeUserTemplates,
  stripMonacoPlaceholders,
  toMonacoSnippet,
  validateLiveTemplate,
} from "./live.js";
