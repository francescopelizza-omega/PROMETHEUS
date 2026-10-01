// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/protocol/schema.ts — ONE `FieldSpec` → JSON Schema converter.
 *
 * There were two, and they disagreed. The CLI's (`session/agent-runtime.ts` `toOpenAiTools`)
 * emitted the FieldSpec's own type verbatim, so an `enum` field went on the wire as
 * `{"type":"enum"}` — not a JSON Schema type at all — and the `enum` array was dropped
 * entirely. `prometheus_enable` / `prometheus_disable` both take
 * `component: {type:"enum", enum:["hooks","mcp"]}`, so the only two tools with a constrained
 * argument were the two whose constraint never reached the model. The renderer's copy
 * (`ide/ai/core-agent.ts` `toOpenAiTool`) mapped it correctly. Same input, two answers,
 * decided by which surface you happened to be on.
 *
 * Which is the recurring shape of this bug in this repo: a mapping duplicated per surface
 * drifts, and the drift is invisible because each copy looks right in isolation. So the
 * mapping lives here, once, and both transports call it.
 *
 * PURE: data in, data out. No node, no IO — the C5-sandboxed renderer imports this directly.
 */

import type { FieldSpec, ToolDef, ToolSchema } from "../tools.js";

/** A JSON Schema `object` node — what an OpenAI function's `parameters` must be. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  /** OMITTED (not `[]`) when nothing is required — see `toJsonSchema`. */
  required?: string[];
}

/** A JSON Schema leaf for one argument. */
export interface JsonSchemaProperty {
  type: "string" | "boolean" | "number" | "array";
  enum?: string[];
  description?: string;
  default?: string | boolean | number;
  /** present only for `type: "array"`. */
  items?: { type: "string" | "boolean" | "number" | "object" };
}

/**
 * Arguments the agent is FORBIDDEN to send, filtered out of everything the model sees.
 *
 * `--force` is a hard block in the loop (`loop.ts` — "the agent is forbidden from using
 * --force; a human must type the confirmation"). Advertising it in the schema is worse than
 * pointless: the model reads a legitimate-looking boolean, tries it on a call that is failing,
 * and spends a round being blocked. An argument it may never use is an argument it must never
 * be shown.
 */
const FORBIDDEN_ARGS: ReadonlySet<string> = new Set(["force", "forceUnsafe", "force_unsafe"]);

/** Whether a field may be shown to the model at all. */
export function isModelVisibleArg(name: string): boolean {
  return !FORBIDDEN_ARGS.has(name);
}

/** An OpenAI-shaped function tool, as `/v1/chat/completions` wants it in `tools[]`. */
export interface OpenAiFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
  };
}

/**
 * Map one `FieldSpec` to a JSON Schema leaf.
 *
 * `enum` is the whole reason this function is worth extracting: JSON Schema has no `enum`
 * TYPE — it has a `string` type carrying an `enum` constraint. Emitting `{"type":"enum"}`
 * is not a stricter schema, it is an invalid one, and endpoints split on what they do with
 * it (Ollama shrugs; a strict gateway 400s the whole request, which reads to the user as
 * "the model is broken" rather than "one field is mistyped").
 */
export function fieldToJsonSchema(spec: FieldSpec): JsonSchemaProperty {
  let base: JsonSchemaProperty;
  if (spec.type === "enum") {
    base = { type: "string", ...(spec.enum ? { enum: [...spec.enum] } : {}) };
  } else if (spec.type === "array") {
    base = { type: "array", items: { type: spec.items?.type ?? "string" } };
  } else {
    base = { type: spec.type };
  }
  return {
    ...base,
    ...(spec.description ? { description: spec.description } : {}),
    // The default is a FACT about the tool the model should see: `mode` defaulting to
    // `collect` is why it need not pass `mode` at all. Dropping it made models pass every
    // optional field explicitly, which is more tokens and more chances to pass a wrong one.
    ...(spec.default !== undefined ? { default: spec.default } : {}),
  };
}

/**
 * Map a whole `ToolSchema` to the `parameters` object.
 *
 * `required` is OMITTED rather than emitted as `[]` when no field is required. Half the
 * catalog takes no arguments at all (`prometheus_scan`, `git_status`, `system_info`), and
 * `{"required":[]}` is the kind of technically-valid-but-unusual JSON Schema that some
 * local runners' grammar compilers reject outright. An absent key is universally understood.
 */
export function toJsonSchema(schema: ToolSchema): JsonSchemaObject {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    if (!isModelVisibleArg(name)) continue;
    properties[name] = fieldToJsonSchema(spec);
    if (spec.required) required.push(name);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** Map a core `ToolDef` to the OpenAI function tool the native transport puts on the wire. */
export function toOpenAiTool(tool: ToolDef): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.schema),
    },
  };
}

/** Map every exposed `ToolDef` for one turn. */
export function toOpenAiTools(tools: readonly ToolDef[]): OpenAiFunctionTool[] {
  return tools.map(toOpenAiTool);
}
