/**
 * agent/protocol/preamble.ts — tell the model what it can do, in as few tokens as possible.
 *
 * Nothing in this repo rendered the tool catalog into prompt text. The only path by which a
 * tool's existence reached a model was the native `tools:[…]` array, which means that on
 * every endpoint without native function-calling the model was asked to act with no idea
 * what it could act WITH. And the CLI's live system prompt is one sentence —
 * `cli-profiles/profile.ts:38`, "You are Prometheus. Always scan before installing. Prefer
 * free/local tools." — so even the behavioural rules in `AGENT_TOOL_DISCIPLINE` never
 * arrived. A model told nothing does the thing models do when told nothing: it writes out
 * the code it *would* have written and calls that done.
 *
 * THE BUDGET IS THE DESIGN. There are ~38 exposed tools. Rendered generously that is well
 * over a thousand tokens on EVERY turn, against a default context window of 8192 — and the
 * readline host never auto-compacts, so that overhead is permanent and unreclaimable. So
 * this renderer degrades in defined stages instead of emitting whatever it happens to
 * produce, and when it drops something it SAYS SO in the prompt. A model that knows there
 * are more tools can ask; a model handed a silently-truncated list concludes they do not
 * exist.
 *
 * PURE: no node, no IO.
 */

import type { FieldSpec, ToolDef } from "../tools.js";
import { isModelVisibleArg } from "./schema.js";

/** How the tools reach the model, which decides how much the preamble must carry. */
export type PreambleMode =
  /** The endpoint renders `tools:[…]` itself — the preamble adds discipline and an index. */
  | "native"
  /** The model only has text — the preamble must teach the call syntax and the signatures. */
  | "text";

export interface PreambleOptions {
  mode: PreambleMode;
  /**
   * Rough token ceiling for the whole preamble. Enforced by the degrade ladder below.
   *
   * Prefer `contextWindow` — it derives this from the model actually in use. An explicit value
   * still wins, for a caller that has its own reason.
   */
  maxTokens?: number;
  /**
   * The model's measured context window, from which the budget is derived.
   *
   * This is the field callers should set. Without it every model got the 8192-sized budget,
   * which on a large-window model spent the tool DESCRIPTIONS — the part that tells a model
   * which tool to reach for — to save a fraction of a percent of its context.
   */
  contextWindow?: number;
  /** chars-per-token, matching `agent/compact.ts`'s estimator. */
  charsPerToken?: number;
}

/** What was rendered, and what had to be given up to fit. */
export interface RenderedPreamble {
  text: string;
  /** Tools whose signatures were dropped entirely (still named if `namedOnly`). */
  omitted: string[];
  /** The degrade stage actually used. */
  detail: "full" | "signatures" | "required-only" | "names";
  approxTokens: number;
}

/* ── ordering ────────────────────────────────────────────────────────────────*/

/**
 * The tools a coding turn reaches for first, in the order a turn tends to need them.
 *
 * This is a BUDGET priority, not a permission: everything else is still exposed and still
 * callable. It exists so that when the ladder has to drop detail, the last thing to lose it
 * is `read_file`, and the first is the twelfth registry verb.
 */
const PRIORITY: readonly string[] = Object.freeze([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "propose_edit",
  "write_file",
  "run_command",
  "git_status",
  "git_diff",
  "stat_path",
  "git_log",
  "git_show",
  "which",
  "job_status",
  "job_output",
  "web_fetch",
]);

/** Priority index — unlisted tools keep catalog order after the listed ones. */
function rank(name: string): number {
  const i = PRIORITY.indexOf(name);
  return i === -1 ? PRIORITY.length : i;
}

/** Sort a stable copy by priority, preserving catalog order within a tier. */
function byPriority(tools: readonly ToolDef[]): ToolDef[] {
  return tools
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t.name) - rank(b.t.name) || a.i - b.i)
    .map((x) => x.t);
}

/* ── signature rendering ─────────────────────────────────────────────────────*/

/** The type as the model should read it: enum values inline, arrays as `T[]`. */
function renderType(spec: FieldSpec): string {
  if (spec.type === "enum" && spec.enum?.length) {
    return spec.enum.map((v) => `"${v}"`).join("|");
  }
  if (spec.type === "array") {
    // `{old,new}[]` says more in six characters than "array" does, and it is the difference
    // between a model sending the right shape and sending a stringified blob.
    return `${spec.items?.shape ?? spec.items?.type ?? "string"}[]`;
  }
  return spec.type;
}

/** Render one argument: `path*: string`, `component*: "hooks"|"mcp"`, `mode?: string=collect`. */
export function renderField(name: string, spec: FieldSpec): string {
  const mark = spec.required ? "*" : "?";
  const dflt = spec.default !== undefined ? `=${String(spec.default)}` : "";
  return `${name}${mark}: ${renderType(spec)}${dflt}`;
}

/**
 * `read_file(path*: string, offset?: number)` — the argument list alone.
 *
 * Forbidden arguments are filtered here as well as in the JSON Schema. The two renderings
 * feed the same model on different transports, and an argument that is invisible on one and
 * advertised on the other is the drift this whole directory exists to stop.
 */
export function renderSignature(tool: ToolDef, requiredOnly = false): string {
  const entries = Object.entries(tool.schema).filter(
    ([n, s]) => isModelVisibleArg(n) && (!requiredOnly || s.required),
  );
  const args = entries.map(([n, s]) => renderField(n, s)).join(", ");
  return `${tool.name}(${args})`;
}

/** Collapse a tool description to its first sentence, capped — the model needs the gist. */
export function shortDescription(tool: ToolDef, maxChars = 110): string {
  const flat = tool.description.replace(/\s+/g, " ").trim();
  const stop = flat.search(/\.\s/);
  const first = stop > 0 ? flat.slice(0, stop + 1) : flat;
  return first.length <= maxChars ? first : `${first.slice(0, maxChars - 1).trimEnd()}…`;
}

/* ── the protocol instructions ───────────────────────────────────────────────*/

/**
 * How to emit a call, for a model with no native tool channel.
 *
 * Deliberately one shape and one example. Offering alternatives measurably increases the
 * rate at which small models invent a fourth shape by blending two of them — the parser
 * accepts several dialects precisely so the prompt does not have to enumerate them.
 */
export const TEXT_CALL_PROTOCOL = [
  "To use a tool, emit exactly this, on its own line:",
  '<tool_call>{"name":"TOOL","arguments":{...}}</tool_call>',
  "Then STOP and wait. The result comes back as `[tool_result TOOL]` and you continue from there.",
  "You may call several tools in one reply. Writing code or a command in prose does NOT run it — only a tool_call does.",
].join("\n");

/** The one-line rule that survives every degrade stage, because it is the one that matters. */
export const ACT_DONT_DESCRIBE =
  "To change anything on this machine you MUST call a tool; describing the change does nothing.";

/* ── the renderer ────────────────────────────────────────────────────────────*/

const DEFAULT_MAX_TOKENS = 700;

/**
 * Share of the model's context window the tool preamble may occupy.
 *
 * 8% of 8192 is ~655 tokens, which is where the 700 default came from — it was sized for the
 * smallest window in the fleet and then applied to every model regardless. With 45 tools that
 * budget forces the degrade ladder down to `signatures`, so NO tool description reaches the
 * model at all: not "prefer this over repeated propose_edit when a change spans files", not
 * "send the WHOLE list every time", not "use web_fetch to read a URL you already have". The
 * descriptions are the part that tells a model WHICH tool to reach for, and they were being
 * spent away on a 262144-token model to save 700 tokens.
 */
export const PREAMBLE_WINDOW_SHARE = 0.08;

/** Never spend less than this, however small the window — below it the ladder has no room. */
export const PREAMBLE_MIN_TOKENS = 700;

/**
 * Never spend more than this, however large the window.
 *
 * 8% of a 262144-token window would be ~21000 tokens of tool listing, which is far past the
 * point where more detail helps: the full catalogue at full detail is ~1400 tokens today, so
 * this ceiling is really a guard against a future catalogue exploding unnoticed rather than a
 * limit anyone hits.
 */
export const PREAMBLE_MAX_TOKENS = 4000;

/**
 * The preamble budget for a model with `contextWindow` tokens.
 *
 * Clamped at both ends: the floor keeps a small-window model working exactly as it did, and the
 * ceiling stops a huge window from turning the header into a document.
 */
export function preambleBudget(contextWindow: number | undefined): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return DEFAULT_MAX_TOKENS;
  }
  const share = Math.floor(contextWindow * PREAMBLE_WINDOW_SHARE);
  return Math.min(Math.max(share, PREAMBLE_MIN_TOKENS), PREAMBLE_MAX_TOKENS);
}

function approx(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

/** Assemble the preamble body for one degrade stage. */
function bodyFor(tools: readonly ToolDef[], detail: RenderedPreamble["detail"]): string {
  if (detail === "names") return tools.map((t) => t.name).join(", ");
  return tools
    .map((t) => {
      const sig = renderSignature(t, detail === "required-only");
      return detail === "full" ? `- ${sig} — ${shortDescription(t)}` : `- ${sig}`;
    })
    .join("\n");
}

/**
 * Render the tool preamble.
 *
 * The ladder, in order: full signatures with descriptions → signatures alone → required
 * arguments only → bare names. Only if bare names STILL do not fit are tools dropped, lowest
 * priority first, and the count is stated in the prompt.
 */
export function renderToolPreamble(
  tools: readonly ToolDef[],
  opts: PreambleOptions,
): RenderedPreamble {
  const charsPerToken = opts.charsPerToken ?? 4;
  const budget = opts.maxTokens ?? preambleBudget(opts.contextWindow);
  const ordered = byPriority(tools);

  const header =
    opts.mode === "text"
      ? `${ACT_DONT_DESCRIBE}\n\n${TEXT_CALL_PROTOCOL}\n\nTools available:`
      : // The parenthetical matters: a bare name list with no explanation reads to a model as
        // "these tools take no arguments".
        `${ACT_DONT_DESCRIBE}\n\nTools available (their arguments and full descriptions are in the tool schemas you already have):`;

  const assemble = (
    kept: readonly ToolDef[],
    detail: RenderedPreamble["detail"],
    dropped: number,
  ): string => {
    const plural = dropped === 1 ? "" : "s";
    const note =
      dropped > 0
        ? `\n(${dropped} more tool${plural} exist but did not fit here — ask and they will be listed.)`
        : "";
    return `${header}\n${bodyFor(kept, detail)}${note}`;
  };

  // On `native` the endpoint already carries name + FULL description + JSON Schema for every
  // tool in `tools:[…]` (`schema.ts:toOpenAiTool`). Rendering the signatures and a truncated
  // copy of the same descriptions here told the model nothing it did not already have, and
  // cost ~1.2k tokens on EVERY request of EVERY round — the system prompt is rebuilt per
  // round by both hosts. What `tools[]` cannot carry is the act-don't-describe rule and the
  // PRIORITY ORDER, so on native that — and only that — is the preamble.
  const STAGES: RenderedPreamble["detail"][] =
    opts.mode === "native" ? ["names"] : ["full", "signatures", "required-only", "names"];
  for (const detail of STAGES) {
    const text = assemble(ordered, detail, 0);
    if (approx(text, charsPerToken) <= budget) {
      return { text, omitted: [], detail, approxTokens: approx(text, charsPerToken) };
    }
  }

  // Even bare names overflow. Drop from the bottom of the priority order until it fits,
  // keeping at least the top tools so the agent is never left with nothing to call.
  const MIN_KEPT = Math.min(ordered.length, 8);
  for (let keep = ordered.length - 1; keep >= MIN_KEPT; keep -= 1) {
    const kept = ordered.slice(0, keep);
    const text = assemble(kept, "names", ordered.length - keep);
    if (approx(text, charsPerToken) <= budget) {
      return {
        text,
        omitted: ordered.slice(keep).map((t) => t.name),
        detail: "names",
        approxTokens: approx(text, charsPerToken),
      };
    }
  }
  const kept = ordered.slice(0, MIN_KEPT);
  const text = assemble(kept, "names", ordered.length - MIN_KEPT);
  return {
    text,
    omitted: ordered.slice(MIN_KEPT).map((t) => t.name),
    detail: "names",
    approxTokens: approx(text, charsPerToken),
  };
}

/**
 * Compose the final system prompt: the host's own prompt, then the preamble.
 *
 * The host's text comes FIRST and is never trimmed. It carries the persona and any
 * user-authored `/system` override, and a preamble that displaced it would silently undo a
 * setting the user typed. It is also the stable prefix a provider's prompt cache keys on.
 */
export function withToolPreamble(
  systemPrompt: string,
  tools: readonly ToolDef[],
  opts: PreambleOptions,
): { prompt: string; preamble: RenderedPreamble } {
  const preamble = renderToolPreamble(tools, opts);
  const base = systemPrompt.trim();
  return { prompt: base ? `${base}\n\n${preamble.text}` : preamble.text, preamble };
}
