/**
 * mcp-tools.test.ts — external MCP tools entering the agent's catalog.
 *
 * A discovered tool list is UNTRUSTED INPUT: names, descriptions and schemas are all written
 * by whoever wrote the server. So the tests that matter are not the happy-path conversion —
 * they are the ones proving a hostile or sloppy server cannot shadow a built-in, cannot
 * smuggle itself past the confirm gate, and cannot eat the whole prompt budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpServerConfig, McpToolDescriptor } from "../../mcp/host/types.js";
import {
  MCP_TOOL_PREFIX,
  allMcpToolDefs,
  isMcpToolName,
  jsonSchemaToFieldSpec,
  mcpInputSchemaToToolSchema,
  mcpToolDefs,
  mcpToolName,
  parseMcpToolName,
} from "./mcp-tools.js";

function server(
  over: Partial<McpServerConfig> = {},
  tools: McpToolDescriptor[] = [],
): McpServerConfig {
  return {
    id: "github",
    label: "GitHub",
    transport: { kind: "stdio", command: "npx", args: [] },
    enabled: true,
    scope: "workspace",
    autoApprove: [],
    source: "manual",
    health: "ready",
    capabilities: { tools, resources: false, prompts: false },
    ...over,
  };
}

const READ_ISSUE: McpToolDescriptor = {
  name: "get_issue",
  description: "Fetch one issue by number.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "integer", description: "the issue number" },
    },
    required: ["repo", "number"],
  },
  annotations: { readOnlyHint: true },
};

/* ── namespacing: the anti-shadowing rule ───────────────────────────────────*/

test("a server that publishes `write_file` CANNOT shadow the built-in", () => {
  // The whole reason names are namespaced. A model that has learned to trust `write_file`
  // must never reach a stranger's implementation of it.
  const defs = mcpToolDefs(server({}, [{ name: "write_file", inputSchema: {} }]));
  assert.equal(defs[0]?.name, "mcp__github__write_file");
  assert.notEqual(defs[0]?.name, "write_file");
});

test("a namespaced name round-trips, and a built-in name is not mistaken for one", () => {
  assert.equal(mcpToolName("github", "get_issue"), "mcp__github__get_issue");
  assert.deepEqual(parseMcpToolName("mcp__github__get_issue"), {
    serverId: "github",
    tool: "get_issue",
  });
  // A tool name containing the separator still splits at the FIRST one.
  assert.deepEqual(parseMcpToolName("mcp__fs__read__file"), {
    serverId: "fs",
    tool: "read__file",
  });
  for (const notOurs of [
    "write_file",
    "read_file",
    MCP_TOOL_PREFIX,
    "mcp__",
    "mcp__x",
    "mcp____",
  ]) {
    assert.equal(isMcpToolName(notOurs), false, `${notOurs} was treated as an MCP tool`);
  }
});

/* ── the confirm gate must not be widened ───────────────────────────────────*/

test("a server that declares NO annotations gets none — it does not become auto-approvable", () => {
  // `autoApprovable` fails safe on unknown annotations; inventing a readOnlyHint here would
  // quietly undo that and let a stranger's tool run with no human in the loop.
  const defs = mcpToolDefs(server({}, [{ name: "anything", inputSchema: {} }]));
  assert.deepEqual(defs[0]?.annotations, {});
  assert.notEqual(defs[0]?.annotations.readOnlyHint, true);
});

test("declared annotations are carried through verbatim", () => {
  const defs = mcpToolDefs(
    server({}, [
      READ_ISSUE,
      { name: "delete_repo", inputSchema: {}, annotations: { destructiveHint: true } },
    ]),
  );
  assert.equal(defs[0]?.annotations.readOnlyHint, true);
  assert.equal(defs[1]?.annotations.destructiveHint, true);
});

/* ── a blocked or unready server reaches nothing ────────────────────────────*/

test("a server nemesis BLOCKED contributes no tools", () => {
  const blocked = server(
    {
      gate: { verdict: "block", target: "npx github-mcp" },
      health: "ready",
    },
    [READ_ISSUE],
  );
  assert.deepEqual(mcpToolDefs(blocked), []);
});

test("a disabled or not-ready server contributes no tools", () => {
  assert.deepEqual(mcpToolDefs(server({ enabled: false }, [READ_ISSUE])), []);
  for (const health of ["unknown", "starting", "error", "blocked"] as const) {
    assert.deepEqual(mcpToolDefs(server({ health }, [READ_ISSUE])), [], `health=${health}`);
  }
  assert.equal(mcpToolDefs(server({ health: "ready" }, [READ_ISSUE])).length, 1);
});

/* ── the schema inversion ───────────────────────────────────────────────────*/

test("a published JSON Schema becomes a FieldSpec map, required intact", () => {
  const schema = mcpInputSchemaToToolSchema(READ_ISSUE.inputSchema);
  assert.deepEqual(schema.repo, { type: "string", required: true, description: "owner/name" });
  // `integer` has no FieldSpec equivalent and must land on `number`, not `string`.
  assert.deepEqual(schema.number, {
    type: "number",
    required: true,
    description: "the issue number",
  });
});

test("an enum survives the round trip", () => {
  const f = jsonSchemaToFieldSpec({ type: "string", enum: ["open", "closed"] }, true, "state");
  assert.equal(f.type, "enum");
  assert.deepEqual(f.enum, ["open", "closed"]);
  assert.equal(f.required, true);
});

test("a nullable union takes the non-null member", () => {
  assert.equal(jsonSchemaToFieldSpec({ type: ["string", "null"] }, false, "x").type, "string");
  assert.equal(jsonSchemaToFieldSpec({ type: ["integer", "null"] }, false, "x").type, "number");
});

test("an array carries its element type", () => {
  const f = jsonSchemaToFieldSpec({ type: "array", items: { type: "integer" } }, false, "ids");
  assert.equal(f.type, "array");
  assert.deepEqual(f.items, { type: "number" });
});

test("a NESTED OBJECT degrades to a described string rather than vanishing", () => {
  // Dropping it would leave the model calling a tool with a required argument it was never
  // told about. A described string is honest: it sends JSON, the server parses JSON.
  const f = jsonSchemaToFieldSpec({ type: "object", description: "the filter" }, true, "filter");
  assert.equal(f.type, "string");
  assert.equal(f.required, true);
  assert.match(f.description ?? "", /JSON/);
});

test("a schema with no properties yields an empty map, not a crash", () => {
  for (const bad of [undefined, null, 42, "nope", {}, { type: "object" }]) {
    assert.deepEqual(mcpInputSchemaToToolSchema(bad), {}, `threw or invented on ${String(bad)}`);
  }
});

/* ── budget ─────────────────────────────────────────────────────────────────*/

test("a chatty server's description is capped", () => {
  // One server with a 4KB description would otherwise consume the whole preamble budget and
  // push the real tools out of the prompt.
  const defs = mcpToolDefs(
    server({}, [{ name: "verbose", description: "x".repeat(4000), inputSchema: {} }]),
  );
  assert.ok((defs[0]?.description.length ?? 0) < 340, "an unbounded description got through");
  assert.match(defs[0]?.description ?? "", /^\[GitHub\]/, "the source server is not attributed");
});

test("tools from several servers flatten, and an unready one contributes nothing", () => {
  const defs = allMcpToolDefs([
    server({ id: "a", label: "A" }, [READ_ISSUE]),
    server({ id: "b", label: "B", health: "error" }, [READ_ISSUE]),
    server({ id: "c", label: "C" }, [READ_ISSUE]),
  ]);
  assert.deepEqual(
    defs.map((d) => d.name),
    ["mcp__a__get_issue", "mcp__c__get_issue"],
  );
});

test("toArgv throws — an MCP tool is never an engine verb", () => {
  const [def] = mcpToolDefs(server({}, [READ_ISSUE]));
  assert.throws(() => def?.toArgv({}), /MCP server/);
});
