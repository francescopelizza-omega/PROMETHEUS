// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * mcp/server/index.ts — the embedded MCP server surface barrel (file 09 §1/§3).
 *
 * Exposes the unified tool catalog (the 14 ported PROMETHEUS_TOOLS + the 5
 * STUDIO_TOOLS = 19), the pure arg validator + engine-dispatch runner, and the
 * computeIsError policy. `@prometheus/core` re-exports these so the agent runtime
 * (§4) reads the SAME annotations the external SDK-facing server uses, and the
 * marketplace (§6) reads the SAME error/verdict policy.
 */
export type { ToolAnnotations, FieldSpec, ToolSchema, ToolDef } from "./tools.js";
export { PROMETHEUS_TOOLS, argHelpers } from "./tools.js";
export { STUDIO_TOOLS } from "./tools.studio.js";
export type { WorstVerdict } from "./isError.js";
export { computeIsError } from "./isError.js";
export type { ValidationResult, EngineRunner, RunMcpToolOptions } from "./runner.js";
export { validateArgs, runMcpTool } from "./runner.js";

import { PROMETHEUS_TOOLS, type ToolDef } from "./tools.js";
import { STUDIO_TOOLS } from "./tools.studio.js";

/** The full tool catalog the embedded server exposes (14 ported + 5 studio = 19). */
export const TOOLS: ToolDef[] = [...PROMETHEUS_TOOLS, ...STUDIO_TOOLS];

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

/** Look up a tool by name (undefined for an unknown name). */
export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** Every tool name in the catalog. */
export function toolNames(): string[] {
  return TOOLS.map((t) => t.name);
}
