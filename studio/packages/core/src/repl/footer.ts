/**
 * repl/footer.ts — the §3.1 tuning status footer line (PURE).
 *
 * "model claude-opus · tools:on · gate:enforce · dry-run:off · verbosity:normal"
 * The footer reflects the live tuning at all times.
 */
import type { AgentTuning } from "../agent/loop.js";
import type { ModelRef } from "../agents/types.js";

/** A compact model label: "ollama:qwen3:8b" or just "claude-opus" for cloud. */
export function modelLabel(model: ModelRef): string {
  return model.provider === "anthropic" ? model.modelId : `${model.provider}:${model.modelId}`;
}

/** The §3.1 footer status line. */
export function footerLine(tuning: AgentTuning): string {
  return [
    `model ${modelLabel(tuning.model)}`,
    `tools:${tuning.tools.enabled ? "on" : "off"}`,
    `gate:${tuning.gateMode}`,
    `dry-run:${tuning.dryRun ? "on" : "off"}`,
    `verbosity:${tuning.verbosity}`,
  ].join(" · ");
}
