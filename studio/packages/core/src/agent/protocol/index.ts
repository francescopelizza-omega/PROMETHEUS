// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/protocol/index.ts — how a model is told about tools, and how its calls are read back.
 *
 * One place, because there are two surfaces (the CLI session runtime and the desktop agent
 * pane) and every mapping that has ever been maintained separately for both has drifted:
 * the tool schema converter existed twice with different bugs, and the system prompt existed
 * twice with different content. This directory is the shared half.
 *
 * The pieces:
 *   - `schema`    — `FieldSpec` → JSON Schema, for the native `tools:[…]` array.
 *   - `preamble`  — the tool catalog → prompt text, budgeted, for models with no native channel.
 *   - `parse`     — tool calls read back out of plain model text, streaming-safe.
 *   - `negotiate` — which of the two transports to use, and how to learn from being wrong.
 *
 * Every module here is PURE (no node, no IO), so the C5-sandboxed renderer imports them
 * directly rather than reaching them over IPC.
 */

export type {
  JsonSchemaObject,
  JsonSchemaProperty,
  OpenAiFunctionTool,
} from "./schema.js";
export {
  fieldToJsonSchema,
  isModelVisibleArg,
  toJsonSchema,
  toOpenAiTool,
  toOpenAiTools,
} from "./schema.js";

export type { PreambleMode, PreambleOptions, RenderedPreamble } from "./preamble.js";
export {
  ACT_DONT_DESCRIBE,
  TEXT_CALL_PROTOCOL,
  renderField,
  renderSignature,
  PREAMBLE_MAX_TOKENS,
  PREAMBLE_MIN_TOKENS,
  PREAMBLE_WINDOW_SHARE,
  preambleBudget,
  renderToolPreamble,
  shortDescription,
  withToolPreamble,
} from "./preamble.js";

// External MCP servers → agent tools (the inverse of schema.ts).
export {
  MCP_TOOL_PREFIX,
  allMcpToolDefs,
  isMcpToolName,
  jsonSchemaToFieldSpec,
  mcpInputSchemaToToolSchema,
  mcpToolDefs,
  mcpToolName,
  parseMcpToolName,
} from "./mcp-tools.js";

export type { ProtocolFeedbackArgs } from "./feedback.js";
export { PROTOCOL_FEEDBACK_TOOL, protocolFeedbackMessage } from "./feedback.js";

export type { CallDialect, MalformedToolCall, ScanEvent, TextToolCall } from "./parse.js";
export {
  ToolCallScanner,
  hasTextToolCall,
  parseToolCalls,
  scanJsonValue,
  scanToolCalls,
} from "./parse.js";

export type {
  NegotiationInput,
  ToolCapabilityState,
  ToolTransport,
  TurnObservation,
} from "./negotiate.js";
export {
  TEXT_FALLBACK_THRESHOLD,
  initialCapability,
  looksLikeToolsRejection,
  negotiateTransport,
  observeTurn,
  preambleModeFor,
} from "./negotiate.js";

// Result conversion, shared by the CLI session and the desktop main process.
export { MAX_MCP_RESULT_CHARS, mcpOutcome, renderMcpContent } from "./mcp-tools.js";

// The preamble DISPATCH PIPELINE — the single assembly point every host uses (CLI, Desktop,
// VS Code, spawn_agent children). See `preamble-dispatch.ts`'s module doc comment.
export type {
  PreambleAssembly,
  PreambleContributor,
  PreambleCtx,
  PreambleMergeTarget,
  PreambleSurface,
  PreambleUnit,
  RenderedContribution,
} from "./preamble-dispatch.js";
export {
  INSTRUCTION_BUDGET_MAX,
  INSTRUCTION_BUDGET_MIN,
  INSTRUCTION_BUDGET_SHARE,
  assemblePreamble,
  instructionBudget,
} from "./preamble-dispatch.js";
export {
  CORE_ROUND_CONTRIBUTORS,
  CORE_TURN_CONTRIBUTORS,
  FLIGHT_CHECK_LOCAL_SUFFIX,
  FLIGHT_CHECK_TEXT,
  READ_ONLY_TOOL_DISCIPLINE,
  effortText,
  effortTextContributor,
  flightCheckText,
  preWriteRecheckContributor,
  toolCatalogContributor,
  toolDisciplineContributor,
  toolDisciplineText,
} from "./contributors/index.js";
