/**
 * __fixtures__/slash-ctx.ts — one fake `SlashCtx` every slash-command suite drives.
 *
 * Extracted from slash-registry.test.ts so a SECOND suite can exercise the registry without a
 * second, drifting copy of the fake. The smoke suite (`slash-smoke.test.ts`) runs EVERY
 * registered command through this ctx; the behavioural suite asserts specific outcomes through
 * the same one. A fake that only one of them used would let the other silently test a different
 * host than the one it thinks it is testing.
 *
 * Every seam RECORDS rather than acts: `runVerb`/`sendToAgent`/`git`/`control` push to `calls`,
 * so a command can be invoked here without spawning the engine, reaching the network, or
 * touching the user's real config.
 */
import type { agent } from "@prometheus/core";

import { resolveKeymap } from "../../tui/keys.js";
import type { SlashCtx } from "../slash-registry.js";
import { createWorkingSet } from "../working-set.js";

const TUNING = {
  model: { provider: "ollama", modelId: "qwen2.5-coder" },
  systemPrompt: "",
  tools: { enabled: true },
  gateMode: "warn",
  dryRun: false,
  verbosity: "normal",
  yes: false,
} as unknown as agent.AgentTuning;

export function makeFakeSlashCtx() {
  const calls = {
    verbs: [] as string[][],
    prompts: [] as string[],
    writes: [] as string[],
    tunes: [] as Array<Partial<agent.AgentTuning>>,
    controls: [] as string[],
    repoMapVerbs: [] as string[],
    repoMapStats: 0,
    gitArgv: [] as string[][],
    setCwds: [] as string[],
    steering: [] as string[],
    copies: [] as string[],
    continues: 0,
    authLevels: [] as number[],
    applies: 0,
    /** the host-delegating seams (`/setup`, `/paths`, `/demos`, `/updates`, `/invoke`,
     *  `/recall`, `/condense`) — recorded so a suite can tell "delegated to the host" apart
     *  from "did nothing at all". */
    delegated: [] as string[],
  };
  let subagents = 3;
  let authLevel = 3;
  const ws = createWorkingSet();
  let cwd = "/tmp/proj";
  const DEFAULT_SYS = "You are Prometheus.";
  let liveTuning = { ...TUNING, systemPrompt: DEFAULT_SYS } as unknown as agent.AgentTuning;
  const ctx: SlashCtx = {
    write: (s) => calls.writes.push(s),
    json: false,
    tuning: () => liveTuning,
    cwd: () => cwd,
    runVerb: async (t) => {
      calls.verbs.push(t);
    },
    sendToAgent: async (p) => {
      calls.prompts.push(p);
    },
    continueTurn: async () => {
      calls.continues++;
    },
    tune: (patch) => {
      liveTuning = { ...liveTuning, ...patch };
      calls.tunes.push(patch);
    },
    // The hosts persist here; the fixture only has to move the live tuning, so a test can read
    // back what `/think` asked for.
    setEffort: (tier) => {
      liveTuning = { ...liveTuning, effort: tier };
      calls.tunes.push({ effort: tier });
    },
    control: (s) => {
      calls.controls.push(s);
    },
    setCwd: (d) => {
      calls.setCwds.push(d);
      cwd = d;
      // the fixture has no filesystem — every move "succeeds", which keeps command tests
      // about the COMMAND rather than about statSync.
      return { ok: true, cwd: d };
    },
    compact: () => {
      calls.delegated.push("compact");
    },
    exportTranscript: () => "/tmp/proj/session.txt",
    exportTranscriptJson: () => "/tmp/proj/session.json",
    ask: async () => "",
    confirm: async () => false,
    askPath: async (_p, d) => d,
    runSetup: async () => {
      calls.delegated.push("runSetup");
    },
    runPaths: async () => {
      calls.delegated.push("runPaths");
    },
    runDemos: async () => {
      calls.delegated.push("runDemos");
    },
    runUpdates: async () => {
      calls.delegated.push("runUpdates");
    },
    usage: () => ({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      estTokens: 0,
      estimated: true,
      cost: 0,
      model: "local:test",
      estCostUsd: 0,
    }),
    runRecall: async () => {
      calls.delegated.push("runRecall");
    },
    runInvoke: async () => {
      calls.delegated.push("runInvoke");
    },
    agents: {
      count: () => subagents,
      setCount: (n) => {
        subagents = n;
      },
      insideTmux: true,
      recommend: () => subagents,
    },
    home: "/tmp/home",
    systemPromptDefault: DEFAULT_SYS,
    checkpoints: {
      revert: () => "nothing to revert",
      list: () => "no checkpoints yet",
    },
    workingSet: {
      list: () => ws.list(),
      add: (dir) => ws.add(dir, cwd),
      remove: (dir) => ws.remove(dir, cwd),
    },
    repoMap: {
      stats: () => {
        calls.repoMapStats++;
        return "repo map off — not built yet";
      },
      apply: (verb) => {
        calls.repoMapVerbs.push(verb);
        return `repo map applied: ${verb}`;
      },
    },
    // fake steering (CLI-061): records reload/edit/create calls.
    steering: {
      list: () => [
        {
          path: "/tmp/proj/AGENTS.md",
          scope: "project" as const,
          name: "AGENTS.md",
          loaded: true,
          size: 42,
          content: "x",
          remote: false,
        },
      ],
      reload: () => {
        calls.steering.push("reload");
        return "steering reloaded — 1 file";
      },
      edit: async (t: string) => {
        calls.steering.push(`edit:${t}`);
        return `edited ${t}`;
      },
      create: async () => {
        calls.steering.push("create");
        return "created AGENTS.md";
      },
    },
    // fake context breakdown (CLI-057): overridable per-test via `ctx.contextBreakdown`.
    contextBreakdown: () => ({
      parts: [
        { label: "system prompt", chars: 400 },
        { label: "transcript", chars: 2000 },
        { label: "tool definitions", chars: 800 },
      ],
      window: 8192,
    }),
    // fake OSC 52 clipboard (CLI-068).
    copyToClipboard: (text?: string) => {
      calls.copies.push(text ?? "(last-reply)");
      return "📋 sent to terminal clipboard (OSC 52)";
    },
    // fake git seam: records argv, replies from a script keyed on the subcommand (CLI-054).
    git: async (args: string[]) => {
      calls.gitArgv.push(args);
      const a = args.join(" ");
      if (a.includes("rev-parse --is-inside-work-tree"))
        return { code: 0, stdout: "true\n", stderr: "" };
      if (a.includes("worktree list --porcelain"))
        return {
          code: 0,
          stdout:
            "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-wt-feat\nHEAD def\nbranch refs/heads/feat\n",
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
    // CLI-096: the effective keymap for /keys (defaults unless a test overrides it).
    keymap: resolveKeymap(undefined),
    getAuthLevel: () => authLevel,
    setAuthLevel: (l) => {
      authLevel = l;
      calls.authLevels.push(l);
    },
    applyFromLastReply: async () => {
      calls.applies++;
    },
  };
  return {
    ctx,
    calls,
    setCwd: (d: string) => {
      cwd = d;
    },
  };
}
