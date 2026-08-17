#!/usr/bin/env node
import { pathToFileURL } from "node:url";
/**
 * server.ts — Prometheus Studio MCP server (stdio) over the REAL @prometheus/core
 * studio agent tool catalog.
 *
 * BACKGROUND (why this file exists): `packages/core/src/mcp/server/{index,runner,tools}.ts`
 * is a tool catalog + pure arg validator the agent's own in-process broker reads — it never
 * imports `@modelcontextprotocol/sdk` and opens no transport, so nothing outside the process
 * could ever reach it over MCP. The one PREVIOUSLY working MCP transport,
 * `prometheus_plugin/mcp-server/src/server.ts`, bridges only to legacy prometheus.py verbs and
 * does not import `@prometheus/core` — so it can never expose the studio agent's own tool
 * catalog (`propose_edit` / `write_file` / the 5 studio action tools). This file closes that
 * gap: a real `StdioServerTransport` in front of `@prometheus/core`'s catalog, ADDED alongside
 * (not replacing) the legacy engine bridge server, which keeps independent value for hosts that
 * only want the plugin scanner/installer.
 *
 * WHAT THIS SERVER EXPOSES
 * ------------------------
 * `EXPOSED_TOOLS` = the READ-ONLY subset of `mcpServer.TOOLS` (the 14 ported prometheus.py
 * verbs + the 5 studio action tools @prometheus/core declares). Concretely: prometheus_scan,
 * _superscan, _list, _info, _where, _status, _audit, _matrix, _skills_list, _vault_status,
 * _localai, _mcp_discover. Every tool this server does NOT list here — prometheus_install,
 * _uninstall, _enable, _disable, _models, _apps, _worldsim, and the host-local write_file /
 * propose_edit / web_fetch tools the interactive agent loop also exposes — is DELIBERATELY
 * absent from the catalog. Nothing is silently downgraded to read-only; the tool is simply
 * never registered with the MCP server, so an external client cannot even discover it exists
 * here (`tools/list` never returns it).
 *
 * SAFETY GUARANTEE (the hard invariant this file exists to satisfy)
 * -------------------------------------------------------------------
 * A local interactive agent call (apps/cli/src/session/host.ts:966-971,
 * apps/cli/src/tui/session-bridge.ts:859) runs EVERY tool call through
 * `agent.authDecision(level, name, annotations)` (packages/core/src/agent/authorization.ts)
 * and, whenever that returns "ask", blocks on a real human answering a yes/no `confirm`
 * prompt over the TUI's readline seam. Over a headless stdio JSON-RPC transport there is no
 * human to answer that prompt — stdin/stdout carry protocol frames only. Silently
 * auto-approving "ask" for a remote MCP caller would hand it a LOWER-friction path into
 * write_file/run_command/install than a human at the terminal gets, which is exactly the
 * invariant this server must never violate. So rather than fabricate a confirm, this server
 * EXCLUDES every tool whose authorization category is not "read" from its catalog, full stop.
 *
 * `isReadOnly()` re-derives each candidate tool's category via the SAME `agent.classifyAuth`
 * the interactive broker uses (not a second, hand-rolled read/write list) and the module-load
 * assertion below refuses to start if anything non-"read" ever reaches `EXPOSED_TOOLS` — so a
 * future edit to `tools.ts`/`tools.studio.ts` that adds a mutating tool, or flips an existing
 * tool's `readOnlyHint`, fails this file's own startup invariant (and `server.test.ts`) instead
 * of silently widening what an external caller can reach.
 *
 * `dispatchTool()` also fails closed at call time: it looks up the requested name ONLY inside
 * `EXPOSED_TOOLS`, never the full `mcpServer.TOOLS` catalog, so even a client that somehow
 * guesses a non-exposed tool name (e.g. "prometheus_install") gets a structured error and the
 * engine is never invoked for it (`server.test.ts` asserts the injected runner is never called).
 *
 * Dispatch of an exposed tool reuses `mcpServer.runMcpTool` — the exact validate → build-argv →
 * engine-bridge runner the in-process broker and the legacy prometheus_plugin/mcp-server both
 * already use — and `mcpServer.computeIsError` for the identical high/critical-audit /
 * failed-state-change error policy. No security logic is reimplemented here.
 *
 * stdout is the JSON-RPC channel — nothing but protocol may be written there; diagnostics go
 * to stderr (mirrors prometheus_plugin/mcp-server/src/server.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agent, mcpServer } from "@prometheus/core";
import { z } from "zod";

const VERSION = "0.1.0";

function log(...a: unknown[]): void {
  // stderr only — stdout is reserved for JSON-RPC.
  process.stderr.write(`[prometheus-studio-mcp] ${a.join(" ")}\n`);
}

/** Re-derive a tool's authorization category via the SAME classifier the interactive
 * broker (agent/authorization.ts) uses — never a second, hand-maintained allowlist. */
function isReadOnly(tool: mcpServer.ToolDef): boolean {
  return agent.classifyAuth(tool.name, tool.annotations) === "read";
}

/**
 * The catalog this server exposes: read-only tools ONLY (see file header). A tool must be
 * BOTH annotated `readOnlyHint:true` AND classify as "read" via `agent.classifyAuth` — belt
 * and braces, fail-closed on either signal.
 */
export const EXPOSED_TOOLS: mcpServer.ToolDef[] = mcpServer.TOOLS.filter(
  (t) => t.annotations.readOnlyHint === true && isReadOnly(t),
);

// Startup invariant (also asserted by server.test.ts): nothing mutating ever reaches the
// exposed catalog. This throws at import time — the server refuses to boot rather than widen
// its own surface silently.
for (const t of EXPOSED_TOOLS) {
  if (!isReadOnly(t)) {
    throw new Error(
      `INVARIANT VIOLATION: "${t.name}" is not read-only (agent.classifyAuth) but reached EXPOSED_TOOLS`,
    );
  }
}

/** Whether `name` is one this server will actually dispatch (the ONLY names `tools/list` and
 * `tools/call` can ever resolve). */
export function isExposedToolName(name: string): boolean {
  return EXPOSED_TOOLS.some((t) => t.name === name);
}

/** Map a dependency-free FieldSpec (core has zero zod on its resolution path, file 09 §1.1) to
 * a zod type, so the real SDK gets a shape it understands. `runMcpTool`'s `validateArgs` is the
 * authoritative validator either way — this is only what the SDK needs to advertise the schema. */
function fieldToZod(spec: mcpServer.FieldSpec): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (spec.type) {
    case "boolean":
      base = z.boolean();
      break;
    case "number":
      base = z.number();
      break;
    case "enum":
      base =
        spec.enum && spec.enum.length > 0 ? z.enum(spec.enum as [string, ...string[]]) : z.string();
      break;
    case "array":
      base = z.union([z.array(z.any()), z.string()]);
      break;
    default:
      base = z.string();
  }
  if (spec.description) base = base.describe(spec.description);
  if (!spec.required) base = base.optional();
  return base;
}

function toZodShape(schema: mcpServer.ToolSchema): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(schema)) shape[key] = fieldToZod(spec);
  return shape;
}

/** An MCP tool-call result, matching what registerTool's handler must return. */
export interface ToolCallResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

/**
 * Dispatch ONE tool call, fail-closed: only a name present in `EXPOSED_TOOLS` is ever run.
 * Anything else (an unknown name, or a real catalog tool this server deliberately excludes,
 * e.g. "prometheus_install") returns a structured error WITHOUT calling the engine runner.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  opts: mcpServer.RunMcpToolOptions = {},
): Promise<ToolCallResult> {
  const tool = EXPOSED_TOOLS.find((t) => t.name === name);
  if (!tool) {
    const payload = {
      ok: false,
      command: name,
      error: `tool "${name}" is not exposed by prometheus-studio-mcp (not read-only, or unknown)`,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }
  try {
    // EngineEnvelope is FLAT (command/ok/error + an index signature for the subcommand's own
    // payload fields, packages/engine-bridge/src/run.ts) — there is no `.data` wrapper to unwrap.
    const envelope = (await mcpServer.runMcpTool(tool, args ?? {}, opts)) as Record<
      string,
      unknown
    >;
    const isError = mcpServer.computeIsError(tool.name, envelope);
    return {
      content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
      structuredContent: envelope,
      isError,
    };
  } catch (e) {
    const err = e as Error;
    const payload = { ok: false, command: tool.name, error: err.message };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }
}

async function main(): Promise<void> {
  const server = new McpServer({ name: "prometheus-studio", version: VERSION });

  for (const tool of EXPOSED_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toZodShape(tool.schema),
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => dispatchTool(tool.name, args ?? {}),
    );
  }

  // --selftest (mirrors prometheus_plugin/mcp-server): the catalog + tool table constructed OK
  // above — print ok and exit WITHOUT opening a transport. Used as a fast boot smoke in CI.
  if (process.argv.includes("--selftest")) {
    process.stdout.write(
      `prometheus-studio-mcp selftest ok — ${EXPOSED_TOOLS.length} read-only tools, v${VERSION}\n`,
    );
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready — ${EXPOSED_TOOLS.length} read-only tools registered (write/install tools excluded)`);
}

// Only start the real transport when this file is the process entry point (`node dist/server.js`
// / the "prometheus-studio-mcp" bin). `server.test.ts` imports EXPOSED_TOOLS/dispatchTool from
// this SAME module for unit coverage — without this guard, that import would try to open a
// StdioServerTransport and block the test runner on stdin.
const isMainModule =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((e) => {
    log(`fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
