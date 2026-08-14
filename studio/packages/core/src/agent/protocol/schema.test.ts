/**
 * schema.test.ts — the `FieldSpec` → JSON Schema mapping.
 *
 * The first test is the one that matters: it is the bug that shipped. `prometheus_enable`
 * and `prometheus_disable` are the only two catalog tools with a constrained argument, and
 * the CLI's converter turned that constraint into an invalid type with no values.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PROMETHEUS_TOOLS } from "../../mcp/server/tools.js";
import { PROPOSE_EDIT_TOOL } from "../edit.js";
import { SYSTEM_TOOLS } from "../system/tools.js";
import type { ToolDef } from "../tools.js";
import {
  fieldToJsonSchema,
  isModelVisibleArg,
  toJsonSchema,
  toOpenAiTool,
  toOpenAiTools,
} from "./schema.js";

/* ── the enum bug ────────────────────────────────────────────────────────────*/

test("an enum field becomes a STRING carrying the values — never `type: enum`", () => {
  const leaf = fieldToJsonSchema({ type: "enum", enum: ["hooks", "mcp"], description: "which" });
  assert.deepEqual(leaf, { type: "string", enum: ["hooks", "mcp"], description: "which" });
});

test("the real catalog's only enum tools now carry their values", () => {
  // Named rather than synthesised: if these tools change shape the test should notice.
  for (const name of ["prometheus_enable", "prometheus_disable"]) {
    const tool = PROMETHEUS_TOOLS.find((t) => t.name === name);
    assert.ok(tool, `${name} is no longer in the catalog`);
    const component = toJsonSchema(tool.schema).properties.component;
    assert.equal(component?.type, "string", `${name}.component is not a JSON Schema type`);
    assert.deepEqual(component?.enum, ["hooks", "mcp"], `${name}.component lost its values`);
  }
});

test("the enum array is COPIED, so a caller cannot mutate the catalog through it", () => {
  const source = ["hooks", "mcp"] as const;
  const leaf = fieldToJsonSchema({ type: "enum", enum: source });
  leaf.enum?.push("evil");
  assert.deepEqual(source, ["hooks", "mcp"]);
});

/* ── required ────────────────────────────────────────────────────────────────*/

test("`required` is OMITTED, not empty, when nothing is required", () => {
  // `{"required":[]}` is what some local runners' grammar compilers reject, and a third of
  // the catalog takes no arguments at all.
  const schema = toJsonSchema({ path: { type: "string" } });
  assert.equal("required" in schema, false);
  assert.deepEqual(toJsonSchema({}), { type: "object", properties: {} });
});

test("required fields are listed in declaration order", () => {
  const schema = toJsonSchema({
    a: { type: "string", required: true },
    b: { type: "string" },
    c: { type: "number", required: true },
  });
  assert.deepEqual(schema.required, ["a", "c"]);
});

/* ── the other field kinds ───────────────────────────────────────────────────*/

test("string, boolean and number pass through unchanged", () => {
  assert.deepEqual(fieldToJsonSchema({ type: "string" }), { type: "string" });
  assert.deepEqual(fieldToJsonSchema({ type: "boolean" }), { type: "boolean" });
  assert.deepEqual(fieldToJsonSchema({ type: "number" }), { type: "number" });
});

test("a default reaches the model — it is what makes an optional field optional in practice", () => {
  assert.deepEqual(fieldToJsonSchema({ type: "boolean", default: false }), {
    type: "boolean",
    default: false,
  });
  // `false` and `0` are real defaults, not absences — the check must not be truthiness.
  assert.equal(fieldToJsonSchema({ type: "number", default: 0 }).default, 0);
  assert.equal("default" in fieldToJsonSchema({ type: "string" }), false);
});

/* ── whole tools ─────────────────────────────────────────────────────────────*/

test("a ToolDef becomes the OpenAI function shape", () => {
  const tool: ToolDef = {
    name: "read_file",
    title: "Read a file",
    description: "Read a file from the workspace.",
    schema: { path: { type: "string", required: true, description: "the path" } },
    annotations: { readOnlyHint: true },
    toArgv: () => [],
  };
  assert.deepEqual(toOpenAiTool(tool), {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "the path" } },
        required: ["path"],
      },
    },
  });
});

test("every tool in the REAL catalog produces a valid JSON Schema type", () => {
  // The blanket assertion the two hand-maintained converters never had: no tool anywhere in
  // the catalog may emit a type an endpoint would reject.
  const VALID = new Set(["string", "boolean", "number", "array"]);
  for (const t of toOpenAiTools([...PROMETHEUS_TOOLS, ...SYSTEM_TOOLS])) {
    for (const [field, leaf] of Object.entries(t.function.parameters.properties)) {
      assert.ok(
        VALID.has(leaf.type),
        `${t.function.name}.${field} emitted "${leaf.type}", which is not a JSON Schema type`,
      );
      if (leaf.enum) {
        assert.equal(leaf.type, "string", `${t.function.name}.${field} has enum on a non-string`);
        assert.ok(leaf.enum.length > 0, `${t.function.name}.${field} has an EMPTY enum`);
      }
      // An array with no `items` is the shape that makes a strict endpoint 400 the request.
      if (leaf.type === "array") {
        assert.ok(leaf.items, `${t.function.name}.${field} is an array with no items type`);
      }
    }
  }
});

/* ── the arguments the model may never see ───────────────────────────────────*/

test("`force` is filtered out of every schema — the loop hard-blocks it", () => {
  // `prometheus_install` and `prometheus_uninstall` declare it. Showing a model an argument
  // that is auto-blocked buys one wasted round and one confusing failure.
  for (const t of toOpenAiTools(PROMETHEUS_TOOLS)) {
    assert.equal(
      "force" in t.function.parameters.properties,
      false,
      `${t.function.name} advertises --force to the model`,
    );
  }
  assert.equal(isModelVisibleArg("force"), false);
  assert.equal(isModelVisibleArg("path"), true);
});

test("an array field carries its element type", () => {
  const proposeEdit = toOpenAiTool(PROPOSE_EDIT_TOOL);
  const hunks = proposeEdit.function.parameters.properties.hunks;
  assert.equal(hunks?.type, "array", "propose_edit.hunks is still declared a string");
  assert.deepEqual(hunks?.items, { type: "object" });
});
