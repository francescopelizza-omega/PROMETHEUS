/**
 * agent/protocol/mcp-tools.ts — external MCP tools become agent tools.
 *
 * `mcp/host/` is a complete MCP *client*: `McpHostManager.connect(id)` spawns a transport,
 * calls `tools/list` and caches the descriptors on `capabilities.tools`; `callTool` runs the
 * §4.3 policy gate before dispatching. All of it worked, and NOTHING connected it to the
 * agent's tool catalog — so a user could configure a filesystem or GitHub MCP server, watch
 * it connect, and find the agent could not call a single one of its tools.
 *
 * This is the missing conversion. It is the exact INVERSE of `protocol/schema.ts`: that turns
 * a `FieldSpec` map into JSON Schema for the wire; this turns the JSON Schema a server
 * published back into a `FieldSpec` map so the tool can live in the same catalog, be rendered
 * into the same preamble, and pass the same broker.
 *
 * THREE RULES CARRY THE SAFETY HERE, and all three are about the fact that a discovered tool
 * list, and everything a connected server returns afterward, is UNTRUSTED INPUT — written and
 * served by whoever wrote and runs the server:
 *
 *  1. **Namespacing is not cosmetic.** Every name becomes `mcp__<server>__<tool>`. A server
 *     that publishes a tool called `write_file` or `run_command` must not be able to shadow
 *     the built-in the model already trusts, and the prefix is also what lets the runner
 *     route on the name alone.
 *  2. **Absent annotations mean CONFIRM, never auto.** `autoApprovable` already fails safe on
 *     unknown annotations; this must not undo that by inventing a `readOnlyHint` for a server
 *     that declared none.
 *  3. **A CALL RESULT is untrusted content, not a trusted tool's output.** Rules 1–2 protect the
 *     tool-selection decision; they say nothing about the TEXT a server returns once called,
 *     which — unlike its description (rule 1) — is not size-capped-and-attributed here, it is
 *     the model's entire view of what the tool "said." `mcpOutcome` wraps it the same way
 *     `web_fetch` already wraps a fetched page (an explicit `<<untrusted-mcp-data...>>` frame)
 *     and runs the same lightweight pattern scan `web_fetch` runs — a connected server that
 *     passed an add-time gate is not thereby trusted to say anything it likes on every call
 *     forever after.
 *
 * PURE: no node, no IO, no transport.
 */

import type { McpServerConfig, McpToolDescriptor } from "../../mcp/host/types.js";
import type { FieldSpec, ToolDef, ToolSchema } from "../tools.js";
import { defangFrameMarkers } from "./frame-body.js";
import { scanForInjectionSignals } from "./injection-scan.js";

/** The separator that makes a discovered name unmistakable and un-shadowable. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Build the agent-facing name for a server's tool. */
export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${tool}`;
}

/** Split an agent-facing name back into its server and tool halves; null when not ours. */
export function parseMcpToolName(name: string): { serverId: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const at = rest.indexOf("__");
  if (at <= 0 || at + 2 >= rest.length) return null;
  return { serverId: rest.slice(0, at), tool: rest.slice(at + 2) };
}

/** Whether a call belongs to an MCP server rather than the built-in catalog. */
export function isMcpToolName(name: string): boolean {
  return parseMcpToolName(name) !== null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Map one JSON Schema property to a `FieldSpec`.
 *
 * `FieldSpec` is deliberately small (string/boolean/number/enum/array) and JSON Schema is
 * not, so anything richer — a nested object, a union, a `$ref` — DEGRADES to a described
 * string rather than being dropped. Dropping an argument silently would leave the model
 * calling a tool with a required field it was never told about; describing it at least lets
 * the model send the right JSON, which is what the server will parse anyway.
 */
export function jsonSchemaToFieldSpec(prop: unknown, required: boolean, name: string): FieldSpec {
  const p = isRecord(prop) ? prop : {};
  const description = typeof p.description === "string" ? p.description : undefined;
  const rawType = Array.isArray(p.type)
    ? // a union like ["string","null"] — take the first non-null member.
      (p.type.find((t) => t !== "null") as string | undefined)
    : typeof p.type === "string"
      ? p.type
      : undefined;

  const enumValues = Array.isArray(p.enum)
    ? p.enum.filter((v): v is string => typeof v === "string")
    : undefined;
  if (enumValues && enumValues.length > 0) {
    return {
      type: "enum",
      enum: enumValues,
      ...(required ? { required: true } : {}),
      ...(description ? { description } : {}),
    };
  }

  const base = (): FieldSpec => {
    switch (rawType) {
      case "boolean":
        return { type: "boolean" };
      case "number":
      case "integer":
        return { type: "number" };
      case "array": {
        const items = isRecord(p.items) ? p.items : {};
        const itemType =
          items.type === "boolean" || items.type === "number" || items.type === "integer"
            ? items.type === "integer"
              ? "number"
              : items.type
            : items.type === "object"
              ? "object"
              : "string";
        return { type: "array", items: { type: itemType as "string" } };
      }
      case "object":
        // No object type in FieldSpec. A described string is honest: the model sends JSON,
        // the server parses JSON, and the description says so.
        return { type: "string" };
      default:
        return { type: "string" };
    }
  };

  const needsShapeNote = rawType === "object" || rawType === undefined;
  const note =
    rawType === "object"
      ? `${description ? `${description} — ` : ""}a JSON object, sent as a JSON string`
      : description;

  return {
    ...base(),
    ...(required ? { required: true } : {}),
    ...(note ? { description: note } : needsShapeNote ? { description: `the ${name}` } : {}),
  };
}

/** Map a whole published `inputSchema` to a `ToolSchema`. */
export function mcpInputSchemaToToolSchema(inputSchema: unknown): ToolSchema {
  const schema: ToolSchema = {};
  if (!isRecord(inputSchema)) return schema;
  const props = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  for (const [name, prop] of Object.entries(props)) {
    schema[name] = jsonSchemaToFieldSpec(prop, required.has(name), name);
  }
  return schema;
}

/** Trim a server-authored description so one chatty server cannot eat the whole preamble. */
function describe(d: McpToolDescriptor, serverLabel: string): string {
  const raw = (d.description ?? d.title ?? d.name).replace(/\s+/g, " ").trim();
  const capped = raw.length > 300 ? `${raw.slice(0, 299)}…` : raw;
  return `[${serverLabel}] ${capped}`;
}

/**
 * Convert one connected server's cached tool descriptors into agent `ToolDef`s.
 *
 * Returns `[]` for a server that is not ready, is disabled, or was blocked by nemesis — a
 * blocked server must not reach the model through this path any more than through any other.
 */
export function mcpToolDefs(cfg: McpServerConfig): ToolDef[] {
  if (!cfg.enabled || cfg.health !== "ready") return [];
  if (cfg.gate && (cfg.gate.verdict === "block" || cfg.gate.verdict === "error")) return [];
  const tools = cfg.capabilities?.tools ?? [];
  return tools.map((d) => ({
    name: mcpToolName(cfg.id, d.name),
    title: d.title ?? d.name,
    description: describe(d, cfg.label),
    schema: mcpInputSchemaToToolSchema(d.inputSchema),
    // Carried through UNCHANGED. `autoApprovable` fails safe on unknown annotations, and
    // inventing a `readOnlyHint` for a server that declared none would quietly undo that.
    annotations: d.annotations ?? {},
    toArgv: () => {
      throw new Error(`${d.name} is served by an MCP server, not by prometheus.py`);
    },
  }));
}

/** Every ready server's tools, flattened — what a host passes as `tools.extra`. */
export function allMcpToolDefs(configs: readonly McpServerConfig[]): ToolDef[] {
  return configs.flatMap((c) => mcpToolDefs(c));
}

/* ── what a call gives back ────────────────────────────────────────────────*/

/** Cap a tool result so one chatty server cannot eat the whole context window. */
export const MAX_MCP_RESULT_CHARS = 20_000;

/**
 * Flatten MCP content into the text the model reads.
 *
 * The spec's content array is `{type:"text"|"image"|"resource", …}`. Text parts are joined;
 * anything else is NAMED rather than dropped, because "[image — not readable as text]" tells
 * the model something came back that it cannot read, whereas silence reads as an empty result.
 */
export function renderMcpContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? "" : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.text === "string") {
      parts.push(rec.text);
      continue;
    }
    const kind = typeof rec.type === "string" ? rec.type : "content";
    parts.push(`[${kind} — not readable as text]`);
  }
  return parts.join("\n");
}

/**
 * Turn an MCP call result into the shape a tool runner returns.
 *
 * Shared by the CLI session and the desktop's main process, because the judgements here are the
 * ones a second copy would get subtly different: an `isError` result is a FAILURE (not text that
 * happens to describe one), an EMPTY success is reported as an empty success (the tool ran and
 * returned nothing — which must not read the same as "the tool did not run"), over-long output
 * is truncated with a marker rather than silently, and any non-empty body — success or error
 * alike, an attacker's payload does not care which — is wrapped in an explicit untrusted-data
 * frame and pattern-scanned before it ever becomes a tool result, exactly like `web_fetch`.
 */
export function mcpOutcome(
  serverId: string,
  tool: string,
  res: { content?: unknown; isError?: boolean },
): { ok: boolean; summary: string; data?: unknown } {
  const text = renderMcpContent(res.content);
  const body =
    text.length > MAX_MCP_RESULT_CHARS
      ? `${text.slice(0, MAX_MCP_RESULT_CHARS)}\n… [truncated at ${MAX_MCP_RESULT_CHARS} chars]`
      : text;
  if (!body) {
    return res.isError === true
      ? { ok: false, summary: `${tool} on ${serverId} reported an error` }
      : { ok: true, summary: `${tool} returned no content`, data: res.content };
  }
  // The server id/tool name are untrusted too (a server author picks its own tool name) — scan
  // them alongside the body so a hidden-character trick hiding in a NAME, not just the content,
  // is not the one thing this scan misses, then strip whatever could break out of the frame's
  // own attribute quoting.
  const scan = scanForInjectionSignals(`${body}\n${serverId}\n${tool}`);
  const warn = scan.flagged
    ? `\n[warning: possible injected instructions detected — ${scan.signals.join(", ")}]`
    : "";
  const safeServer = serverId.replace(/[<>"\r\n]/g, "");
  const safeTool = tool.replace(/[<>"\r\n]/g, "");
  const wrapped = `<<untrusted-mcp-data server="${safeServer}" tool="${safeTool}">>\n${defangFrameMarkers(body)}\n<<end untrusted-mcp-data>>${warn}`;
  return res.isError === true
    ? { ok: false, summary: wrapped }
    : { ok: true, summary: wrapped, data: res.content };
}
