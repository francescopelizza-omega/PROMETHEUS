#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * server.ts — Prometheus MCP server (stdio).
 *
 * Bridges the prometheus.py `--json` surface to any MCP-capable agent (Claude
 * Code, Codex, Cursor, Gemini, Windsurf, Zed, Continue, …). Each tool shells out
 * to the Python engine and returns its JSON object as MCP structured content.
 *
 * stdout is the JSON-RPC channel — NOTHING but protocol may be written there.
 * All diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runPrometheus, resolvePrometheus, BridgeError } from "./bridge.js";
import { TOOLS } from "./tools.js";

const VERSION = "1.0.0";

function log(...a: unknown[]): void {
  // stderr only — stdout is reserved for JSON-RPC.
  process.stderr.write(`[prometheus-mcp] ${a.join(" ")}\n`);
}

/** Decide whether a tool result is an MCP error (vs. informational data). */
function computeIsError(toolName: string, data: Record<string, any>): boolean {
  if (data.error) return true; // engine error envelope
  if (toolName === "prometheus_audit") {
    // only block-worthy verdicts are errors; medium/low/clean are informational
    return ["high", "critical"].includes(String(data.worst_verdict ?? ""));
  }
  // install/uninstall/bundle: ok:false means something failed or was blocked
  return data.ok === false;
}

async function main(): Promise<void> {
  const server = new McpServer({ name: "prometheus", version: VERSION });

  // Fail fast with a helpful message if the engine cannot be found, but DON'T
  // crash — surface it per-call so the host still lists the tools.
  let enginePath = "";
  try {
    enginePath = resolvePrometheus();
    log(`engine: ${enginePath}`);
  } catch (e) {
    log(`WARNING: ${(e as Error).message}. Set PROMETHEUS_PY.`);
  }

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: tool.annotations,
      },
      async (args: Record<string, any>) => {
        try {
          const argv = tool.toArgv(args ?? {});
          const result = await runPrometheus(argv);
          // isError marks a genuine problem the agent must notice, while still
          // returning the JSON. A medium/low audit verdict is informational, NOT
          // an error — over-signalling there would make every slightly-noisy
          // plugin look broken. So: error only on an engine error envelope, a
          // failed/blocked state-change, or a high/critical audit verdict.
          const isError = computeIsError(tool.name, result.data);
          const text = JSON.stringify(result.data, null, 2);
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: result.data,
            isError,
          };
        } catch (e) {
          const err = e as BridgeError;
          const payload = {
            ok: false,
            command: tool.name,
            error: err.message,
            detail: err.detail ?? null,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
            structuredContent: payload,
            isError: true,
          };
        }
      },
    );
  }

  // --selftest (CLI-056): the server + tool table constructed OK above — print ok and exit
  // WITHOUT opening a transport or touching the engine. `prometheus-install verify` uses this
  // as a fast boot smoke in CI where a full stdio initialize roundtrip is unavailable.
  if (process.argv.includes("--selftest")) {
    process.stdout.write(`prometheus-mcp selftest ok — ${TOOLS.length} tools, v${VERSION}\n`);
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready — ${TOOLS.length} tools registered`);
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
