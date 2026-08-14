/**
 * session/slash-registry.ts — the host-side `/command` registry (80+ commands) that
 * makes the interactive session as proficient as Claude Code / Codex, and then some.
 *
 * The host consults THIS registry first; an unknown `/name` falls back to the legacy
 * core `execSlash` (tuning/pane brain) so nothing regresses. Each command is one of:
 *   • VERB passthrough  — runs a real CLI verb through the SAME parity registry the
 *     GUI + one-shot CLI use (`/scan`, `/install foo`, `/harden`, …). Zero drift.
 *   • AGENT macro       — feeds a templated prompt to the agent turn (`/commit`,
 *     `/review`, `/explain <x>`, …) — the Claude-Code "prompt command" model.
 *   • SESSION/INFO/AGENTS — imperative handlers over the host capabilities (clear,
 *     compact, export, /help, /faq, /commands, /agents, /setup, /paths, …).
 *
 * Handlers are IMPERATIVE: they receive a rich `SlashCtx` (write / runVerb / sendToAgent
 * / tune / control / ask / askPath / agents / …) and do their work; the host just
 * dispatches. Pure data + thin closures — fully unit-testable with a fake SlashCtx.
 */
import { COMMAND_SPECS, agent, ai, tokenEconomy } from "@prometheus/core";

import { CATEGORY_LABEL, PATH_CATEGORIES, type PathCategory } from "../home.js";
import { c } from "../render.js";
import { type KeymapResolution, renderKeymap } from "../tui/keys.js";
import { clipToWidth, stringWidth } from "../tui/width.js";
import { type ContextComponent, type UsageStats, contextBreakdown } from "./agent-runtime.js";
import { renderFaq } from "./faq.js";
import {
  type DiffRole,
  type GitSpawn,
  type StatusEntry,
  addWorktree,
  clampLogCount,
  diffLineRole,
  gitDiff,
  gitLog,
  gitStatus,
  isDirty,
  isGitRepo,
  listWorktrees,
  removeWorktree,
  samePath,
  truncateDiff,
} from "./git-helpers.js";
import { type SteeringFile, renderSteeringList } from "./steering.js";
import type { ResolveResult } from "./working-set.js";

type AgentTuning = agent.AgentTuning;
type ToolDef = ReturnType<typeof agent.exposedTools>[number];
type ToolFieldSpec = ToolDef["schema"][string];
type EffortTier = ai.EffortTier;
type EffortResolution = ai.EffortResolution;
const { isEffortTier } = ai;

/**
 * One configured hook, resolved for display (CLI-102's `/hooks`): the event/matcher/command the
 * user wrote, plus which settings LAYER it came from — `hooks-config.ts` merges global +
 * workspace before this ever sees them, so this is the only place that still knows.
 */
export interface HookListing {
  event: agent.HookEvent;
  matcher?: string;
  command: string;
  source: "global" | "workspace";
}

/**
 * One hook's outcome from a `/hooks test` dry run — the exact `HookOutcome` the real loop would
 * have seen, plus the spec it came from so a user with three hooks on one event can tell them
 * apart.
 */
export interface HookTestOutcome extends agent.HookOutcome {
  matcher?: string;
  command: string;
}

/**
 * The `/status` think line. Reports what the ACTIVE model will do with the stored tier, not
 * the stored tier alone — `think max` beside a model that cannot reason is the exact
 * misreport this feature removes.
 */
function describeThink(ctx: SlashCtx): string {
  const tier = ctx.tuning().effort;
  const res = ctx.effortResolution?.(tier ?? "medium");
  if (!res) return tier ?? "default";
  if (res.applied === null) {
    return `not available (${res.degraded?.message ?? "no reasoning control"})`;
  }
  const label = tier ?? `${res.applied} (default)`;
  return res.degraded ? `${label} → ${res.applied} (${res.degraded.message})` : label;
}

/**
 * The full agent tool surface (for /tools list + name validation, CLI-018).
 *
 * Computed from the LIVE tuning, not once at module load, because the host-local tools live in
 * `tools.extra` — the system tools, the file mutators, apply_patch, web_search, spawn_agent and
 * every connected MCP server's tools. A static catalog listed none of them, which meant
 * `/tools list` under-reported what the agent could do AND `/tools off write_file` was refused
 * as an unknown name: the user could not disarm precisely the tools that touch their machine.
 *
 * `deny` is deliberately EMPTY here — this is the surface, not the armed subset, so a
 * disarmed tool still appears (and can be re-armed).
 */
function agentToolDefs(tuning: AgentTuning): ToolDef[] {
  return agent.exposedTools({
    enabled: true,
    allow: [],
    deny: [],
    ...(tuning.tools.extra ? { extra: tuning.tools.extra } : {}),
  });
}

/* ── /hooks test — synthesized payloads (diagnostic only; NEVER a real tool call) ─────────── */

/**
 * A plausible value for one schema field, keyed off the field NAME where a generic guess would
 * read as obviously fake (a hook script that `grep`s its stdin for a path should see one).
 * `spec.default` wins when the tool declared one — that is a truer "realistic" value than any
 * guess this function could make.
 */
function sampleFieldValue(name: string, spec: ToolFieldSpec): unknown {
  if (spec.default !== undefined) return spec.default;
  switch (spec.type) {
    case "string":
      if (/path|file|dir/i.test(name)) return "hooks-test-probe.txt";
      if (/content|body|text/i.test(name)) return "hello from /hooks test";
      if (/command|cmd/i.test(name)) return "echo hooks-test";
      if (/url/i.test(name)) return "https://example.com";
      return "example";
    case "boolean":
      return false;
    case "number":
      return 0;
    case "enum":
      return spec.enum?.[0] ?? "";
    case "array":
      return [];
    default:
      return null;
  }
}

/**
 * Synthesize `{...args}` for a tool call, schema-driven off the LIVE tool surface (the same one
 * `/tools list` reads) so `/hooks test PreToolUse write_file` sends the hook the shape a real
 * `write_file` call actually has. An unrecognized name (an MCP tool not currently connected,
 * say) still gets a plausible fallback rather than refusing the test outright.
 */
function synthesizeToolArgs(tool: string, defs: readonly ToolDef[]): Record<string, unknown> {
  const def = defs.find((t) => t.name === tool);
  if (!def) return { path: "hooks-test-probe.txt" };
  const args: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(def.schema)) args[name] = sampleFieldValue(name, spec);
  return args;
}

/**
 * The full synthesized stdin body for `/hooks test`, matching the EXACT shapes
 * `runPreToolUseHooks` / `firePostToolUseHooks` / `runSessionStartHooks` (agent/hooks.ts) build
 * for a real call — a test that showed the hook a different shape than production would be
 * worse than no diagnostic at all.
 */
function synthesizeHookPayload(
  event: agent.HookEvent,
  tool: string | undefined,
  defs: readonly ToolDef[],
  cwd: string,
): unknown {
  if (event === "SessionStart") return { event: "SessionStart", cwd };
  const args = synthesizeToolArgs(tool ?? "", defs);
  if (event === "PreToolUse") return { tool, args };
  return { tool, args, result: { ok: true, summary: `synthetic /hooks test result for ${tool}` } };
}

/** Render `/hooks` (no args): every effective hook, grouped by nothing — configuration order IS
 *  the order hooks run in, and this list is meant to read the same way the settings file does. */
export function renderHooksList(rows: readonly HookListing[]): string[] {
  if (rows.length === 0) {
    return [
      c.dim(
        "no hooks configured — add one under `hooks: [...]` in ~/.prometheus/config/settings.json " +
          "or <repo>/.prometheus/settings.json",
      ),
    ];
  }
  const eventW = Math.max(...rows.map((r) => r.event.length));
  const lines = [c.bold(`Hooks (${rows.length} configured)`)];
  for (const r of rows) {
    const matcher = r.matcher?.trim() || "*";
    const src = r.source === "workspace" ? "workspace" : "global";
    lines.push(`  ${c.cyan(r.event.padEnd(eventW))}  ${matcher.padEnd(10)}  ${c.dim(`[${src}]`)}`);
    lines.push(`      ${c.dim(r.command)}`);
  }
  return lines;
}

/** Render `/hooks test <event> [tool]`'s results — one block per matching hook, in run order. */
export function renderHooksTest(
  event: agent.HookEvent,
  tool: string | undefined,
  rows: readonly HookTestOutcome[],
): string[] {
  const label = tool ? `${event} ${tool}` : event;
  if (rows.length === 0) return [c.dim(`/hooks test: no hook matches ${label}`)];
  const lines = [c.bold(`/hooks test ${label} — ${rows.length} matching hook(s)`)];
  for (const r of rows) {
    const status =
      r.error !== undefined
        ? c.red(`error: ${r.error}`)
        : r.timedOut
          ? c.yellow("timed out")
          : r.exitCode === 0
            ? c.green("exit 0")
            : c.red(`exit ${r.exitCode}`);
    const matcher = r.matcher?.trim() ? ` (matcher ${r.matcher})` : "";
    lines.push(`  ${c.bold(r.command)}${c.dim(matcher)}`);
    lines.push(`      ${status}`);
    if (r.stdout.trim()) lines.push(`      stdout: ${r.stdout.trim()}`);
    if (r.stderr.trim()) lines.push(`      stderr: ${r.stderr.trim()}`);
  }
  return lines;
}

/** The imperative capabilities the host hands every slash handler. */
export interface SlashCtx {
  /** write a line to the transcript/stdout (already colored). */
  write: (line: string) => void;
  /** --json mode. */
  json: boolean;
  /** read the LIVE tuning (model/gate/dry-run/…) — a getter since the host reassigns it. */
  tuning: () => AgentTuning;
  /** the working directory. */
  cwd: () => string;
  /** run a CLI verb through the parity router + print its outcome. */
  runVerb: (tokens: string[]) => Promise<void>;
  /** feed a templated prompt to the agent (a macro command). */
  sendToAgent: (prompt: string) => Promise<void>;
  /** resume a turn that paused at its iteration cap, with full prior tool state (CLI-072). A
   *  readable no-op ("nothing to continue") when the last turn was not capped. */
  continueTurn: () => Promise<void>;
  /** apply a tuning patch + redraw the footer. */
  tune: (patch: Partial<AgentTuning>) => void;
  /** What the ACTIVE model would actually do with a given effort tier — so `/effort` can
   *  report "not available" instead of echoing a success it cannot deliver. Optional so
   *  existing fake SlashCtx fixtures keep compiling. */
  effortResolution?: (tier: EffortTier) => EffortResolution | undefined;
  /** the active 0–7 --authorisation level. */
  getAuthLevel: () => number;
  /** set the 0–7 --authorisation level (persists as the next-session default). */
  setAuthLevel: (level: number) => void;
  /**
   * The coarse autonomy POSTURE (`default`/`acceptEdits`/`plan`/…), Shift-Tab's dial in the
   * TUI. Optional so existing fake SlashCtx fixtures keep compiling; `/permission-mode`
   * reports honestly that the surface has no mode dial when it is absent, rather than
   * printing a success it cannot deliver.
   */
  getPermMode?: () => agent.PermissionModeId;
  setPermMode?: (mode: agent.PermissionModeId) => void;
  /**
   * Run a prompt DETACHED, in the background-run table `prometheus agents` reads.
   *
   * Optional so existing fake SlashCtx fixtures keep compiling; `/background` says the surface
   * cannot detach rather than pretending it started something.
   */
  startBackground?: (task: string) => string | undefined;
  /** session controls owned by the host. */
  control: (signal: "clear" | "new" | "quit") => void;
  /** change the working directory. */
  setCwd: (dir: string) => void;
  /** reclaim context (host clears history, keeps project memory). */
  compact: (focus: string) => void | Promise<void>;
  /** export the transcript to a file; returns the written path (or "" on failure). */
  exportTranscript: (file?: string) => string;
  /** CLI-082: export a STRUCTURED JSON transcript ({sessionId, exportedAt, turns}); "" on failure. */
  exportTranscriptJson: (file?: string) => string;
  /** free-text prompt. */
  ask: (prompt: string) => Promise<string>;
  /** yes/no prompt. */
  confirm: (prompt: string) => Promise<boolean>;
  /** folder picker with tab-completion. */
  askPath: (prompt: string, def: string) => Promise<string>;
  /** run the /setup onboarding wizard. */
  runSetup: () => Promise<void>;
  /** run the /paths download-folder wizard. */
  runPaths: () => Promise<void>;
  /** run the /demos multi-CLI agent-swarm command (setup / run a goal / status). */
  runDemos: (rest: string) => Promise<void>;
  /** run the /updates command (check vendor CLIs · local models · Prometheus self-update). */
  runUpdates: (rest: string) => Promise<void>;
  /** session usage for /stats (CLI-058): in/out token split (estimated? ) + model-aware cost. */
  usage: () => UsageStats;
  /** open the /recall past-session history picker. */
  runRecall: (rest: string) => Promise<void>;
  /** open the /invoke repo-install picker (catalog + green✓/red✗ marks → nemesis-gated install). */
  runInvoke: (rest: string) => Promise<void>;
  /** the subagent orchestrator knobs (tmux auto-fan-out). */
  agents: {
    count: () => number;
    setCount: (n: number) => void;
    insideTmux: boolean;
    /** the orchestrator's recommended subagent count for a prompt (heuristic). */
    recommend: (prompt: string) => number;
  };
  /** the ~/.prometheus home root. */
  home: string;
  /** the profile's system prompt captured at session start — /system reset restores it (CLI-017). */
  systemPromptDefault: string;
  /** turn-atomic workspace checkpoints for /revert + /checkpoints (CLI-015). */
  checkpoints: {
    /** restore the last turn's captured files; returns a summary line. */
    revert: () => string;
    /** list stored checkpoints (label · time · file count). */
    list: () => string;
  };
  /** the session working set — extra dirs the agent may read (CLI-004). cwd is implicit. */
  workingSet: {
    /** resolved added dirs, insertion order (does NOT include the implicit cwd). */
    list: () => string[];
    /** validate + add a dir (dedup by resolved path). */
    add: (dir: string) => ResolveResult;
    /** remove a dir; false iff it was not in the set. */
    remove: (dir: string) => boolean;
  };
  /** the built-in repo map (CLI-053): `/repomap` stats + on|off|refresh. Walking is the cost, so
   *  refresh is explicit-only; the toggle is session-scoped and injects a system-context block. */
  repoMap: {
    /** the no-arg stats line (on/off · files · tokens · truncated?). */
    stats: () => string;
    /** apply on|off|refresh (walks the tree on refresh / first enable); returns a status line. */
    apply: (verb: string) => string;
  };
  /** the git spawn seam for `/worktree` (CLI-054): the host injects the engine-bridge safe-env
   *  spawn; tests inject a fake so the registry never spawns real git. */
  git: GitSpawn;
  /** the effective TUI keymap (CLI-096) for `/keys` — resolved from `[keymap]` config at session
   *  start; carries the bindings, per-action source (default|user), and any load diagnostics. */
  keymap: KeymapResolution;
  /** copy the last assistant reply (or `text`) to the system clipboard via OSC 52 (CLI-068); the
   *  host writes the raw sequence to the tty and returns a status line. Works over SSH/tmux. */
  copyToClipboard: (text?: string) => string;
  /** apply SEARCH/REPLACE + ```diff edit blocks from the last assistant reply to disk (confirm-gated). */
  applyFromLastReply: () => Promise<void>;
  /** live per-component context sizes for `/context` (CLI-057): system prompt / transcript / tool
   *  defs / repo map (only when present). `window` = the active endpoint's context window (undefined
   *  ⇒ `% n/a`). Implemented by BOTH the host + the TUI bridge from the live session. */
  contextBreakdown: () => { parts: ContextComponent[]; window?: number };
  /** steering files (CLI-061): `/memory` list + reload + edit + create. edit/create spawn/write via
   *  the host's safe seams; reload re-assembles the steering system block for the next turn. */
  steering: {
    list: () => SteeringFile[];
    /** re-discover + re-assemble into the agent system block; returns a status line. */
    reload: () => string;
    /** open $EDITOR on file `n|path`, then reload; returns a status line. */
    edit: (target: string) => Promise<string>;
    /** scaffold a project AGENTS.md (confirm inside), then reload; returns a status line. */
    create: () => Promise<string>;
  };
  /**
   * Lifecycle-hook diagnostics (CLI-102): `/hooks` lists what's configured, `/hooks test` runs
   * the matching hook(s) FOR REAL with a synthesized payload — never through the live
   * PreToolUse/PostToolUse/SessionStart seams, so a dry run can never gate or delay a real turn.
   *
   * Optional so existing fake SlashCtx fixtures keep compiling; `/hooks` reports "not available
   * on this surface" rather than throwing when a host has not wired it.
   */
  hooks?: {
    /** every effective hook (post global/workspace resolution), in configuration order. */
    list: () => HookListing[];
    /**
     * Run every hook bound to `event` (and matching `tool`, when given) with `payload` as its
     * stdin, returning each one's real exit code/stdout/stderr. `[]` when nothing matched.
     */
    test: (event: agent.HookEvent, payload: string, tool?: string) => Promise<HookTestOutcome[]>;
  };
}

export type SlashGroup =
  | "session"
  | "context"
  | "model"
  | "review"
  | "agents"
  | "inventory"
  | "catalog"
  | "security"
  | "env"
  | "models"
  | "repo"
  | "privacy"
  | "apps"
  | "config"
  | "info";

export interface SlashCmd {
  name: string;
  aliases?: readonly string[];
  group: SlashGroup;
  summary: string;
  /** usage hint shown after the name (e.g. "<target>", "[on|off]"). */
  args?: string;
  run: (rest: string, ctx: SlashCtx) => Promise<void> | void;
}

/* --------------------------------- helpers -------------------------------- */

const toks = (rest: string): string[] =>
  rest
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

/** Deterministic comma-grouping (NOT toLocaleString — its separator is locale-dependent and would
 *  break goldens: on a European locale 1000000 → "1.000.000"). CLI-057/058. */
function grp(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A command that forwards to a CLI verb (optionally with fixed leading args). */
function verb(
  name: string,
  group: SlashGroup,
  summary: string,
  opts: {
    verb?: string;
    fixed?: readonly string[];
    aliases?: readonly string[];
    args?: string;
  } = {},
): SlashCmd {
  const target = opts.verb ?? name;
  return {
    name,
    group,
    summary,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    ...(opts.args ? { args: opts.args } : {}),
    run: (rest, ctx) => ctx.runVerb([target, ...(opts.fixed ?? []), ...toks(rest)]),
  };
}

/** A command that feeds a templated prompt to the agent. */
function macro(
  name: string,
  group: SlashGroup,
  summary: string,
  template: (rest: string) => string,
  opts: { aliases?: readonly string[]; args?: string } = {},
): SlashCmd {
  return {
    name,
    group,
    summary,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    ...(opts.args ? { args: opts.args } : {}),
    run: (rest, ctx) => ctx.sendToAgent(template(rest.trim())),
  };
}

/** A boolean tuning toggle (`on`/`off`/blank toggles). */
function toggle(name: string, field: "dryRun" | "yes", summary: string): SlashCmd {
  return {
    name,
    group: "model",
    summary,
    args: "[on|off]",
    run: (rest, ctx) => {
      const r = rest.trim().toLowerCase();
      const cur = ctx.tuning()[field];
      const next = r === "on" ? true : r === "off" ? false : !cur;
      ctx.tune({ [field]: next } as Partial<AgentTuning>);
      ctx.write(c.dim(`${name} → ${next ? "on" : "off"}`));
    },
  };
}

/**
 * Render the token-saving toolkit for the in-session `/savetokens` slash — the terminal
 * twin of the app's "Save tokens" panel + `prometheus tokens`. Compact (full detail lives in
 * `prometheus tokens <id>` / the GUI panel). Reads the PURE core `tokenEconomy` registry.
 */
/** A non-local provider ⇒ paid $ (token caching/compaction matter most). */
function isPaidProvider(provider: string | undefined): boolean {
  return !/^(local|ollama|lmstudio|llamacpp|vllm|mythos)$/i.test(provider ?? "local");
}

function renderSaveTokens(paid: boolean): string {
  const tools = tokenEconomy.proposeToolkits({ usingPaidModel: paid });
  if (tools.length === 0) return c.dim("No token-saving tools proposed.");
  const lines = [
    c.bold(`Save tokens — proposed toolkit${paid ? " (paid model)" : ""}`),
    c.dim(tokenEconomy.proposeHeadline(paid)),
    "",
  ];
  for (const t of tools) {
    const star = t.defaultOn ? c.green("★") : c.dim("·");
    lines.push(`  ${star} ${c.bold(t.name)}  ${c.dim(`— ${t.tokenSaving}`)}`);
  }
  const n = tokenEconomy.GEMINI_NANO;
  lines.push("");
  lines.push(
    c.dim(
      `Gemini Nano: ${n.feasible} — account-free local ONLY via Chrome Built-in AI; weights NOT redistributable. Open ~4GB default: ${n.alternatives[0]?.label ?? "Qwen3-4B"}.`,
    ),
  );
  lines.push(
    c.dim(
      "detail: prometheus tokens · prometheus tokens nano · or the 'Save tokens' panel in the app",
    ),
  );
  return lines.join("\n");
}

/**
 * Render the `/context` breakdown (CLI-057): component · ~tokens · %-of-window rows, a total row,
 * and a near-limit warning (≥80% of a KNOWN window). Unknown window ⇒ `n/a` + no warning
 * (fail-honest). Percent is display-only; the total is the exact integer sum of the row tokens.
 * Every line is kept ≤ 80 visible columns; padding is applied to PLAIN strings before any color.
 */
export function renderContext(ctx: SlashCtx): string[] {
  const t = ctx.tuning();
  const { parts, window } = ctx.contextBreakdown();
  const { rows, total } = contextBreakdown(parts, window);

  const tokStr = (n: number): string => `~${grp(n)}`;
  const pctStr = (pct: number | null): string => (pct === null ? "n/a" : `${Math.round(pct)}%`);
  const labelW = Math.max(9, "total".length, ...rows.map((r) => stringWidth(r.label)));
  const tokW = Math.max(tokStr(total).length, ...rows.map((r) => tokStr(r.estTokens).length));

  const lines: string[] = [
    c.bold("Context"),
    `  ${c.dim(`model ${t.model.provider}:${t.model.modelId}`)}`,
  ];
  for (const r of rows) {
    lines.push(
      `  ${r.label.padEnd(labelW)}  ${tokStr(r.estTokens).padStart(tokW)}  ${pctStr(r.pct).padStart(4)}`,
    );
  }
  lines.push(c.dim(`  ${"─".repeat(labelW + tokW + 8)}`));
  const totalPct = window && window > 0 ? `${Math.round((total * 100) / window)}%` : "n/a";
  lines.push(
    `  ${c.bold("total".padEnd(labelW))}  ${c.bold(tokStr(total).padStart(tokW))}  ${totalPct.padStart(4)}`,
  );

  if (window && window > 0) {
    if (total / window >= 0.8) {
      lines.push(c.yellow(`  ⚠ near the ${grp(window)}-token limit — /condense to reclaim space`));
    }
  } else {
    lines.push(c.dim("  window unknown → % n/a"));
  }
  lines.push(c.dim("  (estimated, chars/4 — no tokenizer)"));
  return lines;
}

/**
 * Render `/stats` (CLI-058): turns · worker model · tokens in/out (`~` when estimated) · model-aware
 * cost. An UNPRICED model prints `n/a` + the add-it hint (never a synthesized `$`); a local model
 * prints `$0.00 (local)`; a priced model shows the computed cost (with `~` while it's estimated).
 */
export function renderStats(u: UsageStats): string[] {
  const mark = u.estimated ? "~" : "";
  const inOut = `${mark}${grp(u.inputTokens)} in · ${mark}${grp(u.outputTokens)} out · ${mark}${grp(u.estTokens)} total`;
  let costLine: string;
  if (u.cost === null) {
    const model = u.model.includes(":") ? u.model.slice(u.model.indexOf(":") + 1) : u.model;
    costLine = `  cost       ${c.yellow("n/a")}  ${c.dim(`(no pricing for ${model} — add it to providers.config.json)`)}`;
  } else if (u.cost === 0) {
    costLine = `  cost       ${c.green("$0.00")} ${c.dim("(local)")}`;
  } else {
    costLine = `  cost       ${mark}$${u.cost.toFixed(4)}  ${c.dim(u.estimated ? "(model-aware, estimated tokens)" : "(model-aware)")}`;
  }
  return [
    c.bold("Usage"),
    `  turns      ${u.turns}`,
    `  worker     ${u.model}`,
    `  tokens     ${inOut}`,
    costLine,
  ];
}

/**
 * `/worktree` (CLI-054): create/list/switch/remove git worktrees for parallel sessions. All git
 * spawns route through `ctx.git` (the engine-bridge safe-env seam); non-repo cwd errors before any
 * FURTHER spawn; `switch` repoints the ONE canonical `state.cwd` via `ctx.setCwd`.
 */
async function runWorktree(rest: string, ctx: SlashCtx): Promise<void> {
  const [sub, ...args] = toks(rest);
  const cwd = ctx.cwd();
  const git: GitSpawn = ctx.git;

  if (!sub || sub === "list") {
    if (!(await isGitRepo(cwd, git))) {
      ctx.write(c.red("not a git repository"));
      return;
    }
    const wts = await listWorktrees(cwd, git);
    if (wts.length === 0) {
      ctx.write(c.dim("no worktrees"));
      return;
    }
    for (const w of wts) {
      const here = samePath(cwd, w.path) ? c.green("* ") : "  ";
      const ref = w.bare
        ? "(bare)"
        : w.detached
          ? `(detached ${w.head.slice(0, 7)})`
          : (w.branch ?? "?");
      const flags = `${w.locked ? " 🔒locked" : ""}${w.prunable ? " prunable" : ""}`;
      ctx.write(`${here}${w.path}  ${c.dim(ref)}${c.dim(flags)}`);
    }
    return;
  }

  // every non-list verb requires a repo — guard BEFORE any create/switch/remove spawn.
  if (!(await isGitRepo(cwd, git))) {
    ctx.write(c.red("not a git repository"));
    return;
  }

  if (sub === "create") {
    const branch = args[0];
    if (!branch) {
      ctx.write(c.red("usage: /worktree create <branch> [path]"));
      return;
    }
    const res = await addWorktree(cwd, branch, args[1], git);
    ctx.write(res.ok ? c.green(`✓ ${res.message}`) : c.red(res.message));
    return;
  }

  if (sub === "switch") {
    const target = args[0];
    if (!target) {
      ctx.write(c.red("usage: /worktree switch <branch|path>"));
      return;
    }
    const wts = await listWorktrees(cwd, git);
    const match = wts.find(
      (w) => w.branch === target || w.path === target || samePath(target, w.path),
    );
    if (!match) {
      ctx.write(c.red(`no worktree matches "${target}"`));
      return;
    }
    ctx.setCwd(match.path);
    ctx.write(c.dim(`cwd → ${match.path}${match.branch ? ` (${match.branch})` : ""}`));
    return;
  }

  if (sub === "remove") {
    const target = args[0];
    if (!target) {
      ctx.write(c.red("usage: /worktree remove <branch|path>"));
      return;
    }
    const wts = await listWorktrees(cwd, git);
    const match = wts.find(
      (w) => w.branch === target || w.path === target || samePath(target, w.path),
    );
    if (!match) {
      ctx.write(c.red(`no worktree matches "${target}"`));
      return;
    }
    if (match.locked) {
      ctx.write(
        c.red(
          `worktree is locked${typeof match.locked === "string" ? `: ${match.locked}` : ""} — unlock it first`,
        ),
      );
      return;
    }
    const dirty = await isDirty(match.path, git);
    if (dirty.dirty) {
      ctx.write(
        c.red(
          `refusing to remove a dirty worktree — ${dirty.tracked} tracked · ${dirty.untracked} untracked file(s). Commit/stash or clean it first.`,
        ),
      );
      return;
    }
    // typed confirm (never-force): the user must retype the branch/path exactly.
    const typed = (
      await ctx.ask(`type "${match.branch ?? match.path}" to confirm removal: `)
    ).trim();
    if (typed !== (match.branch ?? match.path)) {
      ctx.write(c.dim("cancelled"));
      return;
    }
    const r = await removeWorktree(cwd, match.path, git);
    ctx.write(
      r.ok ? c.green(`✓ removed ${match.path}`) : c.red(r.stderr.trim() || "remove failed"),
    );
    return;
  }

  ctx.write(c.red(`/worktree: unknown "${sub}" — use create | list | switch | remove`));
}

/* ------------------------------ /git (read-only pane, CLI-091) ------------------------------ */

/** role → color for a diff line (no raw ANSI — render.ts `c` roles only). */
const DIFF_PAINT: Record<DiffRole, (s: string) => string> = {
  add: c.green,
  del: c.red,
  hunk: c.cyan,
  meta: c.dim,
  context: (s) => s,
};

/** Render one status group ("Staged"/"Unstaged"/"Untracked") through `tint`; nothing when empty. */
function writeStatusGroup(
  ctx: SlashCtx,
  label: string,
  entries: readonly StatusEntry[],
  which: "x" | "y",
  tint: (s: string) => string,
): void {
  if (entries.length === 0) return;
  ctx.write(c.bold(`${label} (${entries.length})`));
  for (const e of entries) {
    const code = which === "x" ? e.x : e.y;
    const rename = e.orig ? c.dim(`  (was ${e.orig})`) : "";
    ctx.write(`  ${tint(code === "?" ? "?" : code)} ${e.path}${rename}`);
  }
}

/**
 * `/git [status|diff|log]` (CLI-091) — a HARD read-only git surface. Only three inspection verbs;
 * every git spawn routes through the allowlisted read-only helpers (assertReadOnlyGit), so no
 * mutating command is reachable. A bogus verb lists the valid ones WITHOUT spawning git.
 */
async function runGitPane(rest: string, ctx: SlashCtx): Promise<void> {
  const [sub, ...args] = toks(rest);
  const verb = (sub ?? "status").toLowerCase();
  if (verb !== "status" && verb !== "diff" && verb !== "log") {
    // bogus verb: no spawn, just the valid set (acceptance §4).
    ctx.write(c.red(`/git: unknown "${sub}" — use status | diff | log`));
    return;
  }
  const cwd = ctx.cwd();
  const git: GitSpawn = ctx.git;
  if (!(await isGitRepo(cwd, git))) {
    ctx.write(c.red("not a git repository"));
    return;
  }

  if (verb === "status") {
    const st = await gitStatus(cwd, git);
    if (st.staged.length + st.unstaged.length + st.untracked.length === 0) {
      ctx.write(c.dim("working tree clean"));
      return;
    }
    writeStatusGroup(ctx, "Staged", st.staged, "x", c.green);
    writeStatusGroup(ctx, "Unstaged", st.unstaged, "y", c.yellow);
    writeStatusGroup(ctx, "Untracked", st.untracked, "y", c.red);
    return;
  }

  if (verb === "diff") {
    const staged = args[0] === "staged" || args[0] === "cached";
    const r = await gitDiff(cwd, { staged }, git);
    if (!r.ok && r.stderr.trim()) {
      ctx.write(c.red(r.stderr.trim()));
      return;
    }
    const { shown, omitted } = truncateDiff(r.stdout);
    if (shown.length === 0) {
      ctx.write(c.dim(staged ? "no staged changes" : "no unstaged changes"));
      return;
    }
    for (const line of shown) ctx.write(DIFF_PAINT[diffLineRole(line)](line));
    if (omitted > 0) {
      ctx.write(c.dim(`… truncated (${omitted} more lines) — run git diff in a terminal`));
    }
    return;
  }

  // log
  const count = clampLogCount(args[0]);
  const entries = await gitLog(cwd, count, git);
  if (entries.length === 0) {
    ctx.write(c.dim("no commits"));
    return;
  }
  for (const e of entries) {
    const refs = e.refs ? ` ${c.cyan(`(${e.refs})`)}` : "";
    ctx.write(`${c.dim(e.hash)}${refs} ${e.subject}`);
  }
}

/* ------------------------------ the registry ------------------------------ */

export const SLASH_REGISTRY: readonly SlashCmd[] = Object.freeze([
  /* ---- session / lifecycle ---- */
  {
    name: "reset",
    aliases: ["clear", "new"],
    group: "session",
    summary: "Start a fresh conversation (empty context; project memory kept).",
    run: (_r, ctx) => ctx.control("clear"),
  },
  {
    name: "quit",
    aliases: ["exit", "q"],
    group: "session",
    summary: "Leave the session.",
    run: (_r, ctx) => ctx.control("quit"),
  },
  {
    name: "condense",
    aliases: ["compact"],
    group: "session",
    summary: "Summarize + reclaim context (keeps project memory).",
    args: "[focus]",
    run: async (rest, ctx) => {
      await ctx.compact(rest.trim());
    },
  },
  {
    name: "export",
    group: "session",
    summary: "Export the conversation transcript to a file (--json for a structured document).",
    args: "[file] [--json]",
    run: (rest, ctx) => {
      // CLI-082: `--json` writes the structured {sessionId, exportedAt, turns} document; plain
      // `/export` keeps today's flat [role] text .txt (byte-identical).
      const toks = rest.trim().split(/\s+/).filter(Boolean);
      const json = toks.includes("--json");
      const file = toks.find((t) => t !== "--json");
      const p = json ? ctx.exportTranscriptJson(file) : ctx.exportTranscript(file);
      ctx.write(p ? c.green(`✓ exported → ${p}`) : c.red("export failed"));
    },
  },
  {
    name: "recap",
    group: "session",
    summary: "Ask for a one-line summary of this session.",
    run: (_r, ctx) =>
      ctx.sendToAgent("Give a one-line recap of what we've done so far this session."),
  },
  {
    name: "continue",
    aliases: ["go-on"],
    group: "session",
    summary: "Resume a turn that paused at its step cap, keeping full tool state.",
    run: (_r, ctx) => ctx.continueTurn(),
  },
  {
    name: "apply",
    aliases: ["apply-edits"],
    group: "session",
    summary:
      "Apply SEARCH/REPLACE or ```diff edit blocks from the last reply to disk (confirm-gated).",
    run: (_r, ctx) => ctx.applyFromLastReply(),
  },
  {
    name: "cwd",
    aliases: ["cd"],
    group: "session",
    summary: "Show or change the working directory (tab-completes).",
    args: "[path]",
    run: async (rest, ctx) => {
      const dir = rest.trim() || (await ctx.askPath("Change directory to:", ctx.cwd()));
      if (dir) {
        ctx.setCwd(dir);
        ctx.write(c.dim(`cwd → ${dir}`));
      }
    },
  },
  {
    name: "add-dir",
    group: "context",
    summary: "Grant the agent file access to another directory.",
    args: "[path] | --remove <path>",
    run: async (rest, ctx) => {
      const arg = rest.trim();
      // no args → list the working set (cwd is the implicit root).
      if (!arg) {
        ctx.write(c.dim(`root: ${ctx.cwd()} (implicit)`));
        const dirs = ctx.workingSet.list();
        if (dirs.length === 0) ctx.write(c.dim("working set empty — /add-dir <path> to grant one"));
        else for (const d of dirs) ctx.write(`  ${d}`);
        return;
      }
      // --remove <path> → delete an entry.
      if (arg === "--remove" || arg.startsWith("--remove ")) {
        const path =
          arg.slice("--remove".length).trim() ||
          (await ctx.askPath("Remove working directory:", ctx.cwd()));
        if (!path) {
          ctx.write(c.dim("cancelled"));
          return;
        }
        ctx.write(
          ctx.workingSet.remove(path)
            ? c.green(`✓ removed ${path} from the working set`)
            : c.red(`add-dir: not in the working set: ${path}`),
        );
        return;
      }
      // add a validated dir.
      const res = ctx.workingSet.add(arg);
      ctx.write(
        res.ok
          ? c.green(`✓ added ${res.resolved} to the working set`)
          : c.red(`add-dir: ${res.error}`),
      );
    },
  },
  {
    // NATIVE (executing) slash — runs the diagram sidecar via the parity router and
    // prints a terse summary to the pane (NOT a prompt macro). CLI-008.
    name: "diagram",
    group: "context",
    summary: "UML / dependency diagram (mermaid) for a path — terse pane summary.",
    args: "[uml|deps] [path]",
    run: async (rest, ctx) => {
      const toks = rest.trim().split(/\s+/).filter(Boolean);
      let verb = "uml";
      if (toks[0] === "uml" || toks[0] === "deps") verb = toks.shift() as string;
      const path = toks[0] ?? ctx.cwd();
      await ctx.runVerb(["diagram", verb, path, "--summary"]);
    },
  },
  {
    // NATIVE (executing) slash over refactor.py's read-only AST analyses. Distinct
    // NAME from the `/refactor` PROMPT MACRO (below) so neither shadows the other. CLI-009.
    name: "refactor-scan",
    group: "context",
    summary: "AST structure / imports / callgraph for a file (read-only).",
    args: "[structure|imports|callgraph] [file]",
    run: async (rest, ctx) => {
      const toks = rest.trim().split(/\s+/).filter(Boolean);
      let verb = "structure";
      if (toks[0] === "structure" || toks[0] === "imports" || toks[0] === "callgraph") {
        verb = toks.shift() as string;
      }
      const file = toks[0] ?? ctx.cwd();
      await ctx.runVerb(["refactor", verb, file]);
    },
  },

  /* ---- context / memory ---- */
  macro(
    "init",
    "context",
    "Generate a PROMETHEUS.md project-memory file.",
    () =>
      "Create a concise PROMETHEUS.md at the repo root documenting the project's stack, conventions, build/test commands, and architecture for future agent sessions.",
  ),
  {
    name: "memory",
    aliases: ["steering"],
    group: "context",
    summary: "View/edit steering (AGENTS.md/CLAUDE.md/PROMETHEUS.md); refresh reloads it live.",
    args: "[refresh | edit <n|path> | create | update]",
    run: async (rest, ctx) => {
      const [sub, ...args] = toks(rest);
      if (!sub) {
        for (const line of renderSteeringList(ctx.steering.list())) ctx.write(line);
        return;
      }
      if (sub === "refresh" || sub === "reload") {
        ctx.write(c.dim(ctx.steering.reload()));
        return;
      }
      if (sub === "edit") {
        ctx.write(c.dim(await ctx.steering.edit(args[0] ?? "")));
        return;
      }
      if (sub === "create" || sub === "init") {
        ctx.write(c.dim(await ctx.steering.create()));
        return;
      }
      if (sub === "update") {
        // the legacy prompt-delegation: ask the agent to review + update the memory file.
        await ctx.sendToAgent(
          "Review the project and update PROMETHEUS.md (or CLAUDE.md / AGENTS.md) with anything important an agent should remember.",
        );
        return;
      }
      ctx.write(c.red(`/memory: unknown "${sub}" — use refresh | edit <n|path> | create | update`));
    },
  },
  macro(
    "mention",
    "context",
    "Attach a file's content to the conversation.",
    (r) => `Read the file ${r || "<path>"} and keep it in mind for the next requests.`,
    { args: "<file>" },
  ),
  {
    name: "context",
    group: "context",
    summary: "Show conversation size + context usage.",
    run: (_r, ctx) => {
      for (const line of renderContext(ctx)) ctx.write(line);
    },
  },

  /* ---- model / tuning ---- */
  verb("worker", "model", "Show or switch the active worker model.", {
    verb: "model",
    aliases: ["model"],
    args: "[name]",
  }),
  {
    name: "think",
    aliases: ["effort"],
    group: "model",
    summary: "Set the worker's reasoning effort (off/low/medium/high/max).",
    args: "[off|low|medium|high|max]",
    run: (rest, ctx) => {
      const v = rest.trim().toLowerCase();
      if (isEffortTier(v)) {
        ctx.tune({ effort: v });
        // Report what the ACTIVE model will actually do with it, not just what was stored —
        // `/effort max` on a model with no reasoning mode used to echo success and send
        // nothing, which is the exact failure this feature exists to remove.
        const res = ctx.effortResolution?.(v);
        if (res && res.applied === null) {
          ctx.write(
            `${c.cyan(`think → ${v}`)} ${c.dim(`(not available — ${res.degraded?.message ?? "no reasoning control"})`)}`,
          );
        } else if (res?.degraded) {
          ctx.write(`${c.cyan(`think → ${res.applied}`)} ${c.dim(`(${res.degraded.message})`)}`);
        } else {
          ctx.write(c.cyan(`think → ${v}`));
        }
      } else {
        ctx.write(
          c.dim(`think: ${ctx.tuning().effort ?? "default"} (use off|low|medium|high|max)`),
        );
      }
    },
  },
  {
    // Show / set / reset the session system prompt live (CLI-017). `reset` is a whole
    // word; a literal prompt that IS "reset …" is set via a `-- ` escape.
    name: "system",
    group: "model",
    summary: "Show / set / reset the session system prompt.",
    args: "[<text> | reset]",
    run: (rest, ctx) => {
      const trimmed = rest.trim();
      if (trimmed === "") {
        // SHOW — verbatim (multi-line safe), NOT painted, so backticks/$/# survive.
        const cur = ctx.tuning().systemPrompt;
        const origin = cur === ctx.systemPromptDefault ? "profile default" : "session override";
        ctx.write(c.dim(`system prompt (${origin}):`));
        ctx.write(cur);
        return;
      }
      if (/^reset$/i.test(trimmed)) {
        ctx.tune({ systemPrompt: ctx.systemPromptDefault });
        ctx.write(c.dim("system prompt reset to the profile default."));
        return;
      }
      // `-- ` escape lets a literal prompt begin with the word "reset".
      const lead = rest.replace(/^\s+/, "");
      const text = lead.startsWith("-- ") ? lead.slice(3) : rest;
      ctx.tune({ systemPrompt: text }); // store the FULL text (preview is display-only)
      const preview = clipToWidth(text.replace(/\s+/g, " "), 60);
      ctx.write(c.green(`✓ system prompt set (${text.length} chars): ${preview}`));
    },
  },
  {
    // Arm/disarm agent tool use live (CLI-018). Global via tuning.tools.enabled, per-tool
    // via tuning.tools.deny — the loop's exposedTools filter reads both at the model seam.
    name: "tools",
    group: "model",
    summary: "List / arm / disarm agent tools (global or per tool).",
    args: "[list | on|off [name]]",
    run: (rest, ctx) => {
      const toks = rest.trim().split(/\s+/).filter(Boolean);
      const verb = toks[0] ?? "list";
      const tuning = ctx.tuning();
      const deny = new Set(tuning.tools.deny ?? []);
      const defs = agentToolDefs(tuning);
      const names = defs.map((t) => t.name);
      if (verb === "list") {
        ctx.write(
          c.dim(`agent tools — global ${tuning.tools.enabled ? c.green("on") : c.red("off")}:`),
        );
        for (const t of defs) {
          const on = tuning.tools.enabled && !deny.has(t.name);
          ctx.write(
            `  ${on ? c.green("on ") : c.red("off")}  ${t.name}  ${c.dim(t.description.slice(0, 50))}`,
          );
        }
        return;
      }
      if (verb !== "on" && verb !== "off") {
        ctx.write(c.red(`tools: unknown "${verb}" — use list | on|off [name]`));
        return;
      }
      const name = toks[1];
      if (!name) {
        // global toggle
        ctx.tune({ tools: { ...tuning.tools, enabled: verb === "on" } });
        ctx.write(verb === "on" ? c.green("⚒ tools ON") : c.red("⚒ tools OFF"));
        return;
      }
      if (!names.includes(name)) {
        ctx.write(c.red(`tools: no tool "${name}". Valid: ${names.join(", ")}`));
        return; // ZERO state change on an unknown name
      }
      if (verb === "on") deny.delete(name);
      else deny.add(name);
      ctx.tune({ tools: { ...tuning.tools, deny: [...deny] } });
      ctx.write(`${verb === "on" ? c.green("armed") : c.red("disarmed")} ${name}`);
    },
  },
  {
    name: "gate",
    aliases: ["gatemode"],
    group: "model",
    summary: "Set the nemesis gate mode (enforce|warn|off).",
    args: "[enforce|warn|off]",
    run: (rest, ctx) => {
      const m = rest.trim().toLowerCase();
      if (m === "enforce" || m === "warn" || m === "off") {
        ctx.tune({ gateMode: m });
        ctx.write(c.dim(`gate → ${m}`));
      } else ctx.write(c.dim(`gate: ${ctx.tuning().gateMode} (use enforce|warn|off)`));
    },
  },
  {
    name: "authorisation",
    aliases: ["authorisations", "authorization", "authorizations", "auth"],
    group: "model",
    summary: "Set autonomy 0–7 (0 paranoid … 7 runall): higher = fewer permission prompts.",
    args: "[0-7 | name]",
    run: (rest, ctx) => {
      const arg = rest.trim();
      if (!arg) {
        const cur = agent.authLevelMeta(ctx.getAuthLevel());
        ctx.write(c.dim(`authorisation: ${cur.level} ${cur.name} — ${cur.description}`));
        ctx.write(c.dim(`levels: ${agent.authLevelLegend()}`));
        return;
      }
      const lvl = agent.parseAuthLevel(arg);
      if (lvl === null) {
        ctx.write(c.dim(`unknown authorisation "${arg}" — use a level 0–7 or a name`));
        ctx.write(c.dim(`levels: ${agent.authLevelLegend()}`));
        return;
      }
      ctx.setAuthLevel(lvl);
      const m = agent.authLevelMeta(lvl);
      ctx.write(
        c.dim(`authorisation → ${m.level} ${m.name} — ${m.description} (saved as default)`),
      );
    },
  },
  {
    name: "permission-mode",
    aliases: ["permission-modes", "permissions-mode", "permmode"],
    group: "model",
    summary: "Set the autonomy posture (default|acceptEdits|plan|bypassPermissions|yolo).",
    args: "[mode]",
    /**
     * The REAL plan mode. `/plan` next to this is a prompt macro — it asks the model to outline
     * first and nothing stops it writing a file halfway through the outline. This sets the
     * posture the shared agent loop enforces, so `plan` is a hard read-only DENY on every
     * surface rather than a request the model may decline to honour.
     */
    run: (rest, ctx) => {
      const get = ctx.getPermMode;
      const set = ctx.setPermMode;
      if (!get || !set) {
        ctx.write(c.dim("this surface has no permission-mode dial"));
        return;
      }
      const legend = agent.PERMISSION_MODES.map((m) => m.id).join(" · ");
      const arg = rest.trim();
      if (!arg) {
        const cur = agent.permissionModeMeta(get());
        ctx.write(c.dim(`permission mode: ${cur.id} — ${cur.description}`));
        ctx.write(c.dim(`modes: ${legend}`));
        return;
      }
      // Case-insensitive match on the id, so `/permission-mode acceptedits` works from a
      // terminal where nobody wants to hunt for the capital E.
      const found = agent.PERMISSION_MODES.find((m) => m.id.toLowerCase() === arg.toLowerCase());
      if (!found) {
        ctx.write(c.dim(`unknown permission mode "${arg}"`));
        ctx.write(c.dim(`modes: ${legend}`));
        return;
      }
      set(found.id);
      ctx.write(c.dim(`permission mode → ${found.id} — ${found.description}`));
    },
  },
  toggle("dry-run", "dryRun", "Toggle dry-run (preview mutations)."),
  toggle("yes", "yes", "Toggle auto-approve non-critical findings."),
  {
    name: "strict",
    group: "model",
    summary: "Strict gating: enforce the nemesis verdict (vs warn).",
    args: "[on|off]",
    run: (rest, ctx) => {
      const next = rest.trim().toLowerCase() === "off" ? "warn" : "enforce";
      ctx.tune({ gateMode: next });
      ctx.write(c.dim(`strict → ${next === "enforce" ? "on (enforce)" : "off (warn)"}`));
    },
  },
  {
    name: "tune",
    group: "model",
    summary: "Show the current tuning (model · tools · gate · dry-run · verbosity).",
    run: (_r, ctx) => {
      const t = ctx.tuning();
      ctx.write(
        `model ${t.model.provider}:${t.model.modelId} · gate:${t.gateMode} · dry-run:${t.dryRun ? "on" : "off"} · verbosity:${t.verbosity}`,
      );
    },
  },
  {
    name: "verbose",
    group: "model",
    summary: "Toggle verbose output.",
    args: "[on|off]",
    run: (rest, ctx) => {
      const r = rest.trim().toLowerCase();
      const next =
        r === "off"
          ? "quiet"
          : r === "on"
            ? "debug"
            : ctx.tuning().verbosity === "debug"
              ? "normal"
              : "debug";
      ctx.tune({ verbosity: next as AgentTuning["verbosity"] });
      ctx.write(c.dim(`verbosity → ${next}`));
    },
  },

  /* ---- setup / paths / accounts ---- */
  {
    name: "setup",
    group: "config",
    summary: "Pick + download a local model, or connect a paid CLI.",
    run: (_r, ctx) => ctx.runSetup(),
  },
  {
    name: "paths",
    group: "config",
    summary: "View/repoint heavy-download folders (models/videos/files).",
    run: (_r, ctx) => ctx.runPaths(),
  },
  {
    name: "updates",
    aliases: ["update", "upgrade"],
    group: "config",
    summary:
      "Check for updates: vendor CLIs (claude/codex/gemini/…), local models, + Prometheus itself.",
    run: (rest, ctx) => ctx.runUpdates(rest),
  },
  verb("accounts", "config", "List installed agent CLIs (claude/codex/gemini/…).", {
    verb: "scan",
  }),
  verb("login", "config", "Sign into a paid CLI (launches it).", {
    verb: "chat",
    fixed: ["--cli"],
    args: "<svc>",
  }),
  verb("config", "config", "Prometheus config dir / settings.", { verb: "config" }),
  {
    name: "privacy",
    group: "config",
    summary: "Privacy posture: local-first, your data stays on this machine.",
    run: (_r, ctx) =>
      ctx.write(
        `${c.bold("Privacy")}\n  Local models run on THIS machine — no code leaves it.\n  Downloads + settings live under ~/.prometheus. Paid CLIs are the only cloud path.`,
      ),
  },

  /* ---- agents / orchestration ---- */
  {
    name: "demos",
    aliases: ["swarm", "orchestrate", "fleet"],
    group: "agents",
    summary:
      "Multi-CLI agent swarm: orchestrator + dedicated subagents (claude/codex/gemini/…) that talk + spawn children.",
    args: "[setup|status|probe|providers|reset | <goal>]",
    run: (rest, ctx) => ctx.runDemos(rest),
  },
  {
    name: "agents",
    aliases: ["subagents", "team"],
    group: "agents",
    summary: "Show/set the subagent fan-out count (auto-scales under tmux).",
    args: "[n]",
    run: (rest, ctx) => {
      const n = Number(rest.trim());
      if (Number.isInteger(n) && n >= 1 && n <= 16) {
        ctx.agents.setCount(n);
        ctx.write(c.green(`✓ subagents → ${n}`));
      } else {
        const cur = ctx.agents.count();
        ctx.write(
          `${c.bold("Orchestrator")}\n  subagents: ${c.bold(String(cur))}${ctx.agents.insideTmux ? c.dim("  (tmux active — auto-scales per prompt)") : c.dim("  (tmux off — single agent)")}\n  ${c.dim("set with /agents <n> (1–16). Roster: build · plan · explore · scout.")}`,
        );
      }
    },
  },
  macro(
    "plan",
    "agents",
    "Enter plan mode: outline before doing.",
    (r) =>
      `Plan the following before making changes — list the steps, files, and risks, then wait for my go-ahead:\n${r || "(describe the task)"}`,
    { args: "[task]" },
  ),
  {
    name: "background",
    aliases: ["bg", "detach"],
    group: "agents",
    summary: "Run a prompt DETACHED — keeps going after the prompt returns; track with /agents.",
    args: "<task>",
    /**
     * The trigger the `agents` surface never had.
     *
     * `RunRegistry`, `startBackgroundRun` and `prometheus agents list|attach|kill` all shipped
     * complete and unit-tested with no production caller between them, so `agents list` was a
     * correct renderer of a table nothing wrote to — it printed "no background agent runs in
     * this process" no matter what you did. This is what writes to it.
     */
    run: (rest, ctx) => {
      const task = rest.trim();
      if (!task) {
        ctx.write(c.dim("usage: /background <task>"));
        return;
      }
      if (!ctx.startBackground) {
        ctx.write(c.dim("this surface cannot run a detached agent"));
        return;
      }
      const note = ctx.startBackground(task);
      ctx.write(note ? c.dim(note) : c.red("could not start a background run"));
    },
  },
  macro(
    "orchestrate",
    "agents",
    "Decompose a big task into parallel subagents.",
    (r) =>
      `Act as orchestrator: decompose this into independent subtasks, say how many subagents you'd fan out and why, then execute:\n${r || "(describe the task)"}`,
    { aliases: ["spawn", "parallel", "batch"], args: "<task>" },
  ),
  macro(
    "research",
    "agents",
    "Fan-out research + a cited synthesis.",
    (r) =>
      `Research this thoroughly (multiple angles), cross-check, and give a cited synthesis:\n${r || "(question)"}`,
    { args: "<question>" },
  ),
  {
    name: "workflow",
    aliases: ["workflows"],
    group: "agents",
    summary: "About multi-agent workflows (deterministic fan-out).",
    run: (_r, ctx) =>
      ctx.write(
        c.dim(
          "Workflows fan out many subagents deterministically. Use /orchestrate <task> to plan one.",
        ),
      ),
  },

  /* ---- review / dev macros ---- */
  macro(
    "diff",
    "review",
    "Summarize the current git changes.",
    () => "Summarize the current git diff (staged + unstaged): what changed and why it matters.",
  ),
  macro(
    "review",
    "review",
    "Review the working changes for bugs.",
    (r) =>
      `Review ${r || "the current working changes"} for correctness bugs, edge cases, and regressions. Be specific with file:line.`,
    { args: "[target]" },
  ),
  macro(
    "security-review",
    "review",
    "Scan changes for security vulnerabilities.",
    () =>
      "Audit the current branch changes for security vulnerabilities (injection, secrets, unsafe shell, supply-chain). Report severity + fix.",
  ),
  macro(
    "commit",
    "review",
    "Draft a Conventional Commit and commit.",
    () =>
      "Generate a Conventional Commit message for the staged changes (refuse if tests/TODOs look unfinished), then commit.",
  ),
  macro(
    "pr",
    "review",
    "Open/update a pull request from the branch.",
    () =>
      "Summarize the branch commits into a PR title + description and open (or update) the pull request.",
  ),
  macro(
    "test",
    "review",
    "Run the tests and fix failing code.",
    (r) =>
      `Run the test suite${r ? ` for ${r}` : ""}, read the failures, and fix the CODE (not the tests) until green.`,
    { args: "[target]" },
  ),
  macro(
    "explain",
    "review",
    "Explain a file or symbol.",
    (r) => `Explain ${r || "the selected code"} clearly: what it does, why, and any gotchas.`,
    { args: "<target>" },
  ),
  macro(
    "refactor",
    "review",
    "Refactor for readability/maintainability.",
    (r) =>
      `Refactor ${r || "the target"} for readability + maintainability without changing behavior; keep tests green.`,
    { args: "<target>" },
  ),
  macro(
    "optimize",
    "review",
    "Performance optimization pass.",
    (r) =>
      `Profile + optimize ${r || "the target"} for performance; preserve behavior + show the before/after.`,
    { args: "<target>" },
  ),
  macro(
    "gendocs",
    "review",
    "Generate/update project documentation (README + inline). (`/docs` = the command reference.)",
    (r) =>
      `Generate or update the documentation for ${r || "the project"} (README + inline) accurately.`,
    { args: "[target]" },
  ),
  macro(
    "fix",
    "review",
    "Diagnose + fix a described problem.",
    (r) =>
      `Diagnose and fix: ${r || "(describe the bug)"}. Find the root cause, fix it, and verify.`,
    { args: "<description>" },
  ),
  {
    // NATIVE (deterministic) checkpoint restore — supersedes the old prompt macro that
    // merely ASKED the agent to git-revert. Restores the last turn's files exactly. CLI-015.
    name: "revert",
    aliases: ["undo"],
    group: "review",
    summary: "Undo the last turn's file edits (deterministic checkpoint restore).",
    run: (_r, ctx) => ctx.write(ctx.checkpoints.revert()),
  },
  {
    name: "checkpoints",
    group: "review",
    summary: "List workspace checkpoints (one per agent turn that edited files).",
    run: (_r, ctx) => ctx.write(ctx.checkpoints.list()),
  },

  /* ---- inventory / catalog (verb passthroughs) ---- */
  verb("scan", "inventory", "Detect installed AI agents / CLIs / IDEs."),
  verb("superscan", "inventory", "Deep census: installed/absent/forgotten + prereqs."),
  verb("matrix", "inventory", "Reach matrix — which plugin reaches which agent."),
  verb("inventory", "inventory", "Re-scan every agent for installed plugins/skills/MCP."),
  {
    name: "invoke",
    aliases: ["install-picker", "pick"],
    group: "catalog",
    summary:
      "Install a repo (nemesis-gated): arrow-nav overlay in the TUI, number-pick otherwise (✓/✗ marks).",
    args: "[filter]",
    run: (rest, ctx) => ctx.runInvoke(rest),
  },
  verb("list", "catalog", "List the installable plugin/agent catalog.", { aliases: ["ls"] }),
  verb("info", "catalog", "Show details for one plugin.", { args: "<name>" }),
  verb("describe", "catalog", "Rich card for any catalog id.", { args: "<id>" }),
  verb("tutorial", "catalog", "Deep dossier ('Learn more') for an id.", { args: "<id>" }),
  verb("methods", "catalog", "Every documented install method for an id.", { args: "<id>" }),
  verb("install", "catalog", "Install a plugin (nemesis-gated).", { args: "<name>" }),
  verb("uninstall", "catalog", "Remove a plugin.", { args: "<name>" }),
  verb("enable", "catalog", "Re-arm a disabled plugin/component.", { args: "<name>" }),
  verb("disable", "catalog", "Turn off a plugin without uninstalling.", { args: "<name>" }),
  verb("bundle", "catalog", "Install the official Anthropic bundle."),
  verb("sync", "catalog", "Replicate a skill across agents.", { args: "<skill>" }),
  verb("skills", "catalog", "list / enable / disable installed skills.", { args: "[action]" }),
  verb("where", "catalog", "Preview where a plugin installs.", { args: "<name>" }),
  verb("plugin-status", "catalog", "Install + enabled state of a plugin.", {
    verb: "status",
    args: "<name>",
  }),

  /* ---- security ---- */
  verb("gate-target", "security", "Gate a path/url/repo via nemesis.", {
    verb: "gate",
    args: "<target>",
  }),
  // Free, on-demand nemesis threat scan (backdoors / malware / supply-chain / code threats)
  // of any path, url, or repo — the same fail-closed nemesis verdict the install gate uses,
  // surfaced as a first-class command. Available identically in the GUI (Security route).
  verb(
    "nemesis",
    "security",
    "FREE nemesis threat scan of a path/url/repo (backdoors/malware/code threats).",
    {
      verb: "nemesis",
      aliases: ["nemesis-scan", "threatscan", "scan-threats"],
      args: "<target>",
    },
  ),
  verb("secure", "security", "Security tree (scan/db/trust/disinfect/quarantine).", {
    args: "<action>",
  }),
  verb("harden", "security", "Defensive THIS-machine posture audit + fixes."),
  verb("audit", "security", "Deep-scan an installed plugin's artifacts.", { args: "<name>" }),
  verb("trust", "security", "Trust ledger (list/log/verify/revoke).", {
    verb: "secure",
    fixed: ["trust"],
    args: "[action]",
  }),
  verb("quarantine", "security", "Quarantine listing / restore.", {
    verb: "secure",
    fixed: ["quarantine"],
    args: "[action]",
  }),
  verb("disinfect", "security", "Neutralize findings in a target.", {
    verb: "secure",
    fixed: ["disinfect"],
    args: "<target> --out D",
  }),
  verb("threatdb", "security", "Threat-DB status / update.", {
    verb: "secure",
    fixed: ["db"],
    args: "[status|update]",
  }),

  /* ---- env ---- */
  verb("env", "env", "Environments: list/create/clone/add/remove/cuda/…", { args: "[action]" }),
  verb("envs", "env", "List Python environments.", { verb: "env", fixed: ["list"] }),
  verb("pkg", "env", "Install a package into an env.", {
    verb: "env",
    fixed: ["add"],
    args: "<env> <spec...>",
  }),
  verb("cuda", "env", "GPU/CUDA info + gated torch wheel.", {
    verb: "env",
    fixed: ["cuda"],
    args: "[info|torch|install]",
  }),

  /* ---- model hub ---- */
  verb("models", "models", "Model-running tools (AirLLM/FlashAttention/…).", { args: "[action]" }),
  verb("hw", "models", "Scan host hardware + usable model budget.", {
    verb: "model",
    fixed: ["hw"],
  }),
  verb("pull", "models", "Download an open model (gated).", {
    verb: "model",
    fixed: ["pull"],
    args: "<id>",
  }),
  verb("serve", "models", "Build a serve profile for a model.", {
    verb: "model",
    fixed: ["serve"],
    args: "<id>",
  }),
  verb("fit", "models", "Score models against your hardware.", {
    verb: "model",
    fixed: ["fit"],
    args: "[id]",
  }),
  verb("endpoints", "models", "LIVE local + open-weight endpoints.", {
    verb: "model",
    fixed: ["endpoints"],
  }),
  verb("repoint", "models", "Re-point a tool to a local endpoint.", {
    verb: "model",
    fixed: ["repoint"],
    args: "<tool> --base-url URL",
  }),
  verb("localai", "models", "Audit AI repos (paid vs free-local) + catalog.", { args: "[action]" }),
  verb("providers", "models", "Inference providers (Tier-A free/local first).", {
    verb: "provider",
    fixed: ["list"],
  }),

  /* ---- repo ---- */
  verb("repo", "repo", "Repos: add/list/update/pin/branch/rescan/remove/vault.", {
    args: "[action]",
  }),
  verb("repos", "repo", "List managed repos.", { verb: "repo", fixed: ["list"] }),
  verb("clone", "repo", "Clone an arbitrary URL (gated).", {
    verb: "repo",
    fixed: ["add"],
    args: "<url>",
  }),
  verb("vault", "repo", "Offline versioned repo archive.", { args: "[action]" }),

  /* ---- privacy ---- */
  verb("metadata", "privacy", "File-metadata privacy (inspect/scrub/edit/timestomp).", {
    args: "<action> <file>",
  }),
  verb("scrub", "privacy", "Strip all metadata from a file.", {
    verb: "metadata",
    fixed: ["scrub"],
    args: "<file>",
  }),
  verb("inspect", "privacy", "Read a file's metadata.", {
    verb: "metadata",
    fixed: ["inspect"],
    args: "<file>",
  }),

  /* ---- apps / worldsim / pentest / chat ---- */
  verb("apps", "apps", "Self-hosted apps (yt-dlp/ollama/n8n/…).", { args: "[action]" }),
  verb("worldsim", "apps", "World-simulation engines.", { args: "[action]" }),
  verb("pentest", "apps", "ROE-gated, airgapped pentest sandbox.", { args: "[action]" }),
  verb("chat", "apps", "Terminal chat with a paid CLI.", { args: "--cli <svc>" }),

  /* ---- system / info ---- */
  {
    name: "help",
    aliases: ["h", "?"],
    group: "info",
    summary: "Show help + the top commands.",
    run: (_r, ctx) => ctx.write(renderHelp()),
  },
  {
    name: "commands",
    aliases: ["cmds"],
    group: "info",
    summary: "List every /command, grouped.",
    run: (_r, ctx) => ctx.write(renderCommands()),
  },
  {
    name: "docs",
    aliases: ["reference", "ref"],
    group: "info",
    summary: "Full command reference (id · group · args · description); type a term to filter.",
    args: "[search]",
    run: (rest, ctx) => ctx.write(renderDocs(rest.trim())),
  },
  {
    name: "faq",
    group: "info",
    summary: "Answers to common questions (all functionalities).",
    args: "[topic|words]",
    run: (rest, ctx) => ctx.write(renderFaq(rest.trim())),
  },
  {
    name: "savetokens",
    aliases: ["toolkit", "tokeneconomy", "economy"],
    group: "info",
    summary: "Token-saving toolkit (terse output, prompt caching, repo map, …) + Gemini Nano.",
    args: "[--paid|--free]",
    run: (rest, ctx) => {
      // auto-detect from the session worker (a non-local provider ⇒ paid $) unless overridden.
      const paid = /--paid\b/.test(rest)
        ? true
        : /--free\b/.test(rest)
          ? false
          : isPaidProvider(ctx.tuning().model.provider);
      ctx.write(renderSaveTokens(paid));
    },
  },
  {
    name: "repomap",
    group: "repo",
    summary: "Built-in repo map: inject a budgeted file+symbol map so the agent skips grepping.",
    args: "[on|off|refresh]",
    run: (rest, ctx) => {
      const v = rest.trim();
      // no-arg → stats (walking is the cost, so bare /repomap never rebuilds); else on|off|refresh.
      ctx.write(c.dim(v ? ctx.repoMap.apply(v) : ctx.repoMap.stats()));
    },
  },
  {
    name: "worktree",
    aliases: ["wt"],
    group: "repo",
    summary: "Git worktrees for parallel sessions: create/list/switch/remove.",
    args: "create <branch> [path] | list | switch <ref> | remove <ref>",
    run: (rest, ctx) => runWorktree(rest, ctx),
  },
  {
    name: "git",
    group: "repo",
    summary: "Read-only git: status · diff · log (no mutating command reachable).",
    args: "[status | diff [staged] | log [count]]",
    run: (rest, ctx) => runGitPane(rest, ctx),
  },
  {
    name: "keys",
    group: "config",
    summary: "Show the effective TUI keymap (key · action · default|user), marking rebinds.",
    run: (_rest, ctx) => {
      // CLI-096: print the resolved keymap; a refused config leads with its error lines.
      const res = ctx.keymap;
      const paint = res.ok ? c.dim : c.red;
      for (const line of renderKeymap(res)) {
        ctx.write(/\buser \*/.test(line) ? c.cyan(line) : paint(line));
      }
    },
  },
  {
    // CLI-102: the only diagnostic a configured lifecycle hook had before this was a status
    // line IF it errored mid-turn. `/hooks` lists what's resolved (global vs workspace, §7.1
    // precedence); `/hooks test` runs the matching hook(s) FOR REAL with a synthesized payload —
    // never through the live PreToolUse/PostToolUse/SessionStart seams, so it can never gate or
    // delay an actual turn.
    name: "hooks",
    group: "config",
    summary: "List configured lifecycle hooks, or dry-run one (test) without gating a real call.",
    args: "[test <event> [tool]]",
    run: async (rest, ctx) => {
      if (!ctx.hooks) {
        ctx.write(c.dim("this surface has no hooks diagnostic"));
        return;
      }
      const [sub, ...args] = toks(rest);
      if (!sub) {
        for (const line of renderHooksList(ctx.hooks.list())) ctx.write(line);
        return;
      }
      if (sub !== "test") {
        ctx.write(c.red(`/hooks: unknown "${sub}" — use (no args) | test <event> [tool]`));
        return;
      }
      const [eventArg, toolArg] = args;
      const event = agent.HOOK_EVENTS.find(
        (e) => e.toLowerCase() === (eventArg ?? "").toLowerCase(),
      );
      if (!event) {
        ctx.write(
          c.red(
            `/hooks test: unknown event "${eventArg ?? ""}" — use ${agent.HOOK_EVENTS.join(" | ")}`,
          ),
        );
        return;
      }
      if (event !== "SessionStart" && !toolArg) {
        ctx.write(c.red(`/hooks test: ${event} needs a tool name — /hooks test ${event} <tool>`));
        return;
      }
      const payload = synthesizeHookPayload(event, toolArg, agentToolDefs(ctx.tuning()), ctx.cwd());
      const rows = await ctx.hooks.test(event, JSON.stringify(payload), toolArg);
      for (const line of renderHooksTest(event, toolArg, rows)) ctx.write(line);
    },
  },
  {
    name: "copy",
    aliases: ["yank"],
    group: "session",
    summary:
      "Copy the last assistant reply to the system clipboard (OSC 52 — works over SSH/tmux).",
    run: (_r, ctx) => ctx.write(c.dim(ctx.copyToClipboard())),
  },
  verb("checkup", "info", "Health: OS/agents/git/paths.", { verb: "doctor", aliases: ["doctor"] }),
  verb("version", "info", "Print the engine/CLI version."),
  {
    name: "status",
    group: "info",
    summary: "Session status: model, gate, cwd, subagents.",
    run: (_r, ctx) => {
      const t = ctx.tuning();
      ctx.write(
        `${c.bold("Status")}\n  worker     ${t.model.provider}:${t.model.modelId}\n  gate       ${t.gateMode}\n  think      ${describeThink(ctx)}\n  cwd        ${ctx.cwd()}\n  subagents  ${ctx.agents.count()}${ctx.agents.insideTmux ? " (tmux)" : ""}`,
      );
    },
  },
  {
    name: "stats",
    aliases: ["usage", "cost", "tokens"],
    group: "info",
    summary: "Session usage: turns, tokens in/out + model-aware cost.",
    run: (_r, ctx) => {
      for (const line of renderStats(ctx.usage())) ctx.write(line);
    },
  },
  {
    name: "recall",
    aliases: ["resume", "sessions", "session"],
    group: "session",
    summary: "Pick + recall a past session (history picker: id + first words of the prompt).",
    run: (rest, ctx) => ctx.runRecall(rest),
  },
  {
    name: "feedback",
    aliases: ["bug"],
    group: "info",
    summary: "How to report a bug / give feedback.",
    run: (_r, ctx) =>
      ctx.write(
        c.dim("Report issues on the Prometheus repo with the command you ran + the output."),
      ),
  },
  {
    name: "about",
    group: "info",
    summary: "What Prometheus is.",
    run: (_r, ctx) =>
      ctx.write(
        `${c.bold("Prometheus")} — the AI-everything control plane: install AI skills across every agent CLI,\nrun local models, gate every install with nemesis, and orchestrate it all from one terminal.`,
      ),
  },
]);

/* ----------------------------- lookup + listing --------------------------- */

const BY_NAME = new Map<string, SlashCmd>();
for (const cmd of SLASH_REGISTRY) {
  BY_NAME.set(cmd.name, cmd);
  for (const a of cmd.aliases ?? []) BY_NAME.set(a, cmd);
}

/** Resolve a slash name (or alias) to its command. */
export function findSlash(name: string): SlashCmd | undefined {
  return BY_NAME.get(name);
}

/** Every registered slash name + alias (for tab-completion / counting). */
export function allSlashNames(): string[] {
  return [...BY_NAME.keys()].sort();
}

/** Distinct primary commands (no aliases). */
export function primaryCommands(): readonly SlashCmd[] {
  return SLASH_REGISTRY;
}

const GROUP_ORDER: readonly SlashGroup[] = [
  "session",
  "context",
  "model",
  "agents",
  "review",
  "inventory",
  "catalog",
  "security",
  "env",
  "models",
  "repo",
  "privacy",
  "apps",
  "config",
  "info",
];

const GROUP_TITLE: Record<SlashGroup, string> = {
  session: "Session",
  context: "Context & memory",
  model: "Model & tuning",
  agents: "Agents & orchestration",
  review: "Review & dev",
  inventory: "Inventory",
  catalog: "Catalog",
  security: "Security",
  env: "Environments",
  models: "Models",
  repo: "Repos",
  privacy: "Privacy",
  apps: "Apps & chat",
  config: "Setup & config",
  info: "System & info",
};

/** Render the full grouped `/commands` listing. */
export function renderCommands(): string {
  const lines: string[] = [
    `${c.bold("Commands")} ${c.dim(`(${SLASH_REGISTRY.length} commands — type a /name)`)}`,
  ];
  for (const g of GROUP_ORDER) {
    const cmds = SLASH_REGISTRY.filter((cmd) => cmd.group === g);
    if (cmds.length === 0) continue;
    lines.push("");
    lines.push(c.bold(GROUP_TITLE[g]));
    for (const cmd of cmds) {
      const name = `/${cmd.name}${cmd.args ? ` ${c.dim(cmd.args)}` : ""}`;
      lines.push(`  ${c.cyan(name)}`);
      lines.push(`      ${c.dim(cmd.summary)}`);
    }
  }
  return lines.join("\n");
}

/** Full engine command reference (the canonical COMMAND_SPECS registry: id · group ·
 *  args · description), grouped by category. Pass a term to narrow live. */
export function renderDocs(filter = ""): string {
  const q = filter.trim().toLowerCase();
  const specs = q
    ? COMMAND_SPECS.filter((s) =>
        `${s.id} ${s.title} ${s.description} ${s.group}`.toLowerCase().includes(q),
      )
    : [...COMMAND_SPECS];
  if (specs.length === 0)
    return c.dim(`no commands match “${filter.trim()}” — try /docs with no term`);
  const lines: string[] = [
    q
      ? `${c.bold("Docs")} ${c.dim(`(${specs.length} match “${filter.trim()}”)`)}`
      : `${c.bold("Prometheus commands")} ${c.dim(`(${specs.length} — /docs <term> to filter)`)}`,
  ];
  const groups = new Map<string, typeof specs>();
  for (const s of specs) {
    const g = groups.get(s.group) ?? [];
    g.push(s);
    groups.set(s.group, g);
  }
  for (const [g, gs] of groups) {
    lines.push("", c.bold(String(g)));
    for (const s of gs) {
      const pos = (s.argsSchema?.positionals ?? []).map((a) =>
        a.required ? `<${a.name}>` : `[${a.name}]`,
      );
      const flags = (s.argsSchema?.flags ?? []).map((a) => `--${a.name}`);
      const sig = [...pos, ...flags].join(" ");
      lines.push(`  ${c.cyan(s.id)}${sig ? ` ${c.dim(sig)}` : ""}  ${s.title}`);
      lines.push(`      ${c.dim(s.description)}`);
    }
  }
  return lines.join("\n");
}

/** A compact help block (top commands per group). */
export function renderHelp(): string {
  const lines = [`${c.bold("Prometheus session — help")}`, ""];
  lines.push(
    c.dim("Type a message to chat · a /command runs an action · a bare verb (scan) runs it."),
  );
  lines.push("");
  const picks: Array<[string, string]> = [
    ["/help · /commands", "this help · the full command list"],
    ["/faq [topic]", "answers to common questions"],
    ["/setup · /paths", "pick a model · choose download folders"],
    ["/worker · /think · /gate", "switch model · reasoning effort · gate mode"],
    ["/scan · /list · /install <x>", "detect agents · catalog · install (gated)"],
    ["/harden · /secure scan <t>", "audit this machine · gate a target"],
    ["/agents [n] · /orchestrate <t>", "subagent fan-out · decompose a big task"],
    ["/recall · /stats", "past-session picker · session usage"],
    ["/reset · /condense · /quit", "fresh start · reclaim context · exit"],
  ];
  for (const [k, v] of picks) lines.push(`  ${c.cyan(k)}\n      ${c.dim(v)}`);
  lines.push("");
  lines.push(c.dim(`${SLASH_REGISTRY.length} commands total — /commands for all.`));
  return lines.join("\n");
}

/** The category list used by /paths (re-exported convenience). */
export const PATHS_HINT: string = PATH_CATEGORIES.map(
  (cat: PathCategory) => CATEGORY_LABEL[cat],
).join(" · ");
