/**
 * agent/modes.ts — modes-as-agents: Plan/Build + roster + @-mention + extra tools (file 14 §3.1).
 *
 * Makes "mode == agent" first-class: shipped Build (default) + Plan (edit/bash → ask)
 * primaries, read-only Explore + Scout subagents, a markdown agent-file loader
 * (`.prometheus/agents/*.md`, mirroring opencode's `.opencode/agents/`), an @-mention
 * parser for inline delegation, and the `todowrite`/`todoread`/`question` tool
 * descriptors the loop exposes. PURE: produces AgentDefs (09 §4.1) + parses files; the
 * narrower-sandbox rule (09 §4) still binds — a subagent can never widen grants.
 */
import type {
  AgentDef,
  AgentSandbox,
  AgentSource,
  AgentToolGrant,
  ModelRef,
} from "../agents/types.js";

/** A primary "mode" is just an agent (§3.1). */
export type AgentModeId = "build" | "plan" | "explore" | "scout";

const FULL_READ = ["**/*"];
const DEFAULT_MODEL: ModelRef = { provider: "local", modelId: "default" };

function sandbox(over: Partial<AgentSandbox>): AgentSandbox {
  return {
    fsRead: FULL_READ,
    fsWrite: [],
    network: "mcp-only",
    shell: false,
    timeoutSec: 600,
    ...over,
  };
}

/** Build — the default primary: full (gated) tool grant, writes + bash auto where read-only-safe. */
export const AGENT_BUILD: AgentDef = {
  id: "build",
  name: "Build",
  description: "Primary agent — full, gate-aware tool access for implementing changes.",
  model: DEFAULT_MODEL,
  system:
    "You are the Build agent. Implement the user's request end to end. Every code-fetch/exec/install still crosses the nemesis gate; never pass --force.",
  tools: [{ ref: "*", autoApprove: true }],
  sandbox: sandbox({ fsWrite: FULL_READ, shell: true }),
  source: "builtin",
};

/** Plan — read-first; edit/bash default to ASK (routes through the §3.4 permission engine). */
export const AGENT_PLAN: AgentDef = {
  id: "plan",
  name: "Plan",
  description:
    "Read-first agent — explores + proposes a plan; edits and bash require confirmation.",
  model: DEFAULT_MODEL,
  system:
    "You are the Plan agent. Read the code, propose a concrete plan, and ASK before any edit or shell command. Default to read-only.",
  tools: [{ ref: "*", autoApprove: false }],
  sandbox: sandbox({ fsWrite: [], shell: false }),
  source: "builtin",
};

/** Explore — read-only subagent for broad fan-out search. */
export const AGENT_EXPLORE: AgentDef = {
  id: "explore",
  name: "Explore",
  description: "Read-only subagent — searches + reads broadly, returns findings; never edits.",
  model: DEFAULT_MODEL,
  system:
    "You are the Explore subagent. Search + read only; return a findings report. You cannot write or run code.",
  tools: [
    { ref: "engine:scan", autoApprove: true },
    { ref: "*:read", autoApprove: true },
    { ref: "*:grep", autoApprove: true },
    { ref: "*:glob", autoApprove: true },
  ],
  sandbox: sandbox({ network: "none" }),
  source: "builtin",
};

/** Scout — read-only subagent for narrow, targeted lookups. */
export const AGENT_SCOUT: AgentDef = {
  id: "scout",
  name: "Scout",
  description: "Read-only subagent — narrow targeted lookups (where is X, who calls Y).",
  model: DEFAULT_MODEL,
  system:
    "You are the Scout subagent. Locate specific symbols/usages; return file:line results. Read-only.",
  tools: [
    { ref: "*:read", autoApprove: true },
    { ref: "*:grep", autoApprove: true },
  ],
  sandbox: sandbox({ network: "none" }),
  source: "builtin",
};

/** The shipped seed roster (Build is the default primary). */
export const SEED_AGENTS: readonly AgentDef[] = Object.freeze([
  AGENT_BUILD,
  AGENT_PLAN,
  AGENT_EXPLORE,
  AGENT_SCOUT,
]);
export const DEFAULT_AGENT_ID = "build";

/** Look up a seed (or loaded) agent by id. */
export function getAgent(agents: readonly AgentDef[], id: string): AgentDef | undefined {
  return agents.find((a) => a.id === id);
}

/* ── markdown agent-file loader (§3.1) ─────────────────────────────────────── */

/** A parsed `.prometheus/agents/<id>.md` file (frontmatter + system body). */
export interface ParsedAgentFile {
  meta: Record<string, string | string[] | boolean>;
  body: string;
}

/** Parse a tiny YAML-subset frontmatter block + the markdown body (no deps). */
export function parseAgentFile(markdown: string): ParsedAgentFile {
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!fm) return { meta: {}, body: markdown.trim() };
  const meta: Record<string, string | string[] | boolean> = {};
  for (const line of (fm[1] as string).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1] as string;
    const raw = (m[2] as string).trim();
    if (raw === "true" || raw === "false") meta[key] = raw === "true";
    else if (raw.startsWith("[") && raw.endsWith("]")) {
      meta[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else meta[key] = raw.replace(/^["']|["']$/g, "");
  }
  return { meta, body: (fm[2] as string).trim() };
}

function asString(v: string | string[] | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse a "provider:modelId" / "provider/modelId" string into a ModelRef. */
export function parseModelRef(s: string | undefined): ModelRef {
  if (!s) return DEFAULT_MODEL;
  const sep = s.includes(":") ? ":" : s.includes("/") ? "/" : "";
  if (!sep) return { provider: "local", modelId: s };
  const [provider, ...rest] = s.split(sep);
  return { provider: provider || "local", modelId: rest.join(sep) || "default" };
}

/** Build an AgentDef from a parsed agent file (§3.1 markdown loader). */
export function agentFileToDef(
  parsed: ParsedAgentFile,
  id: string,
  source: AgentSource = "user",
): AgentDef {
  const { meta, body } = parsed;
  const mode = asString(meta.mode);
  const isReadOnly =
    mode === "plan" || mode === "explore" || mode === "scout" || meta.readonly === true;
  const tools = Array.isArray(meta.tools)
    ? meta.tools.map((ref): AgentToolGrant => ({ ref, autoApprove: !isReadOnly }))
    : [{ ref: "*", autoApprove: !isReadOnly }];
  return {
    id,
    name: asString(meta.name) ?? id,
    description: asString(meta.description) ?? "",
    model: parseModelRef(asString(meta.model)),
    system: body,
    tools,
    sandbox: sandbox(
      isReadOnly
        ? { fsWrite: [], shell: false, network: "none" }
        : { fsWrite: FULL_READ, shell: true },
    ),
    source,
  };
}

/* ── @-mention inline delegation (§3.1) ────────────────────────────────────── */

const MENTION_RE = /^@([A-Za-z][A-Za-z0-9_-]*)\b\s*([\s\S]*)$/;

/** Parse a leading "@agent rest" mention (case-insensitive id), or null. */
export function parseMention(input: string): { agentId: string; rest: string } | null {
  const m = MENTION_RE.exec(input.trim());
  if (!m) return null;
  return { agentId: (m[1] as string).toLowerCase(), rest: (m[2] as string).trim() };
}

/* ── extra agent tools (§3.1) — descriptors the loop exposes ───────────────── */

/** A minimal tool descriptor (annotations mirror mcp/server/tools ToolAnnotations). */
export interface AgentExtraTool {
  name: string;
  title: string;
  description: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

/** `todowrite` — persist a structured todo list for the run (mutates agent memory, not the FS). */
export const TOOL_TODOWRITE: AgentExtraTool = {
  name: "todowrite",
  title: "Write todos",
  description: "Create/update the structured task list for this run.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
/** `todoread` — read the current todo list (read-only). */
export const TOOL_TODOREAD: AgentExtraTool = {
  name: "todoread",
  title: "Read todos",
  description: "Read the current structured task list.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
/** `question` — ask the user a clarifying question mid-run (read-only; blocks on input). */
export const TOOL_QUESTION: AgentExtraTool = {
  name: "question",
  title: "Ask a question",
  description: "Ask the user a clarifying question and wait for the answer.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const AGENT_EXTRA_TOOLS: readonly AgentExtraTool[] = Object.freeze([
  TOOL_TODOWRITE,
  TOOL_TODOREAD,
  TOOL_QUESTION,
]);
