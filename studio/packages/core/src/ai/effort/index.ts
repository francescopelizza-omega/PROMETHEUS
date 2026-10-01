// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/effort — one user-facing reasoning-effort ladder across radically different models.
 *
 * `off < low < medium < high < max` in, a per-backend dialect out: `reasoning_effort` for
 * OpenAI-compatible endpoints, `think` for Ollama's native API, a token budget for the
 * budget-shaped providers, a chat-template kwarg for llama.cpp/vLLM, a literal
 * `Reasoning: high` line for gpt-oss — and, for the models that simply cannot, an explicit
 * "not available" rather than a silently dropped parameter.
 */
export * from "./types.js";
export * from "./rules.js";
export * from "./apply.js";
export * from "./emulation.js";
export * from "./traits.js";
export * from "./rule-store.js";
export * from "./reasoning-tag.js";
