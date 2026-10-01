// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/protocol.ts — the in-band DIRECTIVE grammar.
 *
 * An agent communicates by emitting line-leading directives inside its normal output:
 *   @<peer>: <task>            delegate a subtask to a sibling/child/parent by name
 *   @parent: <text>  |  >> …   report back up to the orchestrator/parent
 *   @all: <text>               broadcast to every agent in the run
 *   @spawn <name>=<backend>: <task>   create a child-subagent bound to <backend>
 * Everything else is the agent's RESULT text. Parsing is LINE-LEADING + code-fence
 * aware so an `@mention` inside prose or a ``` block is never mis-read as a directive.
 * PURE: text in → { result, directives } out. The coordinator routes the directives.
 */
import { apiBackendFor, isApiProvider } from "./api-providers.js";
import type { BackendRef } from "./topology.js";

export type Directive =
  | { kind: "delegate"; to: string; task: string }
  | { kind: "report"; content: string }
  | { kind: "broadcast"; content: string }
  | { kind: "spawn"; name: string; backend: string; task: string };

export interface ParsedOutput {
  /** the agent's own answer (directive lines removed). */
  result: string;
  directives: Directive[];
}

/** Names that mean "report up" rather than delegate to a peer called that. */
const REPORT_TARGETS = new Set(["parent", "orchestrator", "up", "lead", "boss"]);
/** Names that mean "broadcast" rather than a peer. */
const BROADCAST_TARGETS = new Set(["all", "broadcast", "everyone", "team", "swarm"]);

// backend is non-greedy (so an internal colon like "local:qwen2.5" is kept) up to the
// separator — a colon-then-space, OR just whitespace — then the (non-empty) task.
const SPAWN_RE = /^@spawn\s+([A-Za-z][\w-]*)\s*=\s*(\S+?)(?::\s+|\s+)(.+)$/i;
const MENTION_RE = /^@([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const REPORT_RE = /^>>\s*(.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Parse an agent's output into its result text + the directives it emitted. Directive
 * lines are stripped from the result. Lines inside fenced code blocks are never parsed
 * as directives (so example code containing `@x:` is safe).
 */
export function parseDirectives(text: string): ParsedOutput {
  const directives: Directive[] = [];
  const resultLines: string[] = [];
  let inFence = false;

  for (const raw of text.split("\n")) {
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      resultLines.push(raw);
      continue;
    }
    if (inFence) {
      resultLines.push(raw);
      continue;
    }
    const line = raw.trim();

    const spawn = SPAWN_RE.exec(line);
    if (spawn) {
      const [, name, backend, task] = spawn as unknown as [string, string, string, string];
      if (task.trim()) {
        directives.push({ kind: "spawn", name, backend, task: task.trim() });
        continue;
      }
    }

    const report = REPORT_RE.exec(line);
    if (report) {
      const content = (report[1] ?? "").trim();
      if (content) directives.push({ kind: "report", content });
      continue;
    }

    const mention = MENTION_RE.exec(line);
    if (mention && !line.toLowerCase().startsWith("@spawn")) {
      const target = (mention[1] as string).toLowerCase();
      const body = (mention[2] ?? "").trim();
      if (body) {
        if (REPORT_TARGETS.has(target)) directives.push({ kind: "report", content: body });
        else if (BROADCAST_TARGETS.has(target))
          directives.push({ kind: "broadcast", content: body });
        else directives.push({ kind: "delegate", to: mention[1] as string, task: body });
        continue;
      }
    }

    resultLines.push(raw);
  }

  return { result: resultLines.join("\n").trim(), directives };
}

const KNOWN_CLI = new Set([
  "claude",
  "codex",
  "gemini",
  "cursor",
  "cursor-agent",
  "hermes",
  "aider",
  "opencode",
  "cline",
  "kilocode",
  "copilot",
  "openhands",
]);

/**
 * Resolve a backend token (from a @spawn directive or the wizard) into a BackendRef.
 *   "codex" / "claude"          → cli:<service>
 *   "together" / "groq"         → api:<provider>  (own-key OpenAI-compatible endpoint)
 *   "api:together:llama-3.3"    → api:together with model llama-3.3
 *   "local:qwen2.5"             → local model
 *   "engine:llama3"             → engine-chat model
 *   "cli:gemini"                → cli:gemini
 *   "fake"                      → fake (tests)
 *   anything else               → a local model id (safest default)
 */
export function parseBackendRef(token: string): BackendRef {
  const v = token.trim();
  if (v.includes(":")) {
    const idx = v.indexOf(":");
    const k = v.slice(0, idx).toLowerCase();
    const tail = v.slice(idx + 1).trim();
    if (k === "local") return { kind: "local", model: tail };
    if (k === "engine" || k === "engine-chat") return { kind: "engine-chat", model: tail };
    if (k === "cli") return { kind: "cli", service: tail.toLowerCase() };
    if (k === "in-process" || k === "inprocess") return { kind: "in-process", model: tail };
    if (k === "fake") return { kind: "fake" };
    if (k === "api") {
      // api:<provider>[:model] — resolve the provider's endpoint + key env.
      const sub = tail.indexOf(":");
      const pid = (sub >= 0 ? tail.slice(0, sub) : tail).toLowerCase();
      const model = sub >= 0 ? tail.slice(sub + 1).trim() : undefined;
      const ref = apiBackendFor(pid, model);
      if (ref) return ref;
    }
    // "<apiProvider>:<model>" shorthand (e.g. "together:Qwen/Qwen2.5-Coder-32B").
    if (isApiProvider(k)) {
      const ref = apiBackendFor(k, tail);
      if (ref) return ref;
    }
  }
  const low = v.toLowerCase();
  if (KNOWN_CLI.has(low)) return { kind: "cli", service: low };
  if (isApiProvider(low)) return apiBackendFor(low) as BackendRef;
  if (low === "fake") return { kind: "fake" };
  if (low === "in-process" || low === "inprocess") return { kind: "in-process" };
  return { kind: "local", model: v };
}
