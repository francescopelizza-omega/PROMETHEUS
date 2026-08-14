/**
 * slash-registry.test.ts — the 80+ /command registry: the count goal, lookup +
 * aliases, no duplicates, and that each command TYPE wires its capability (verb
 * passthrough → runVerb, macro → sendToAgent, toggle → tune, control → control).
 * A fake SlashCtx captures every call — no host, no engine.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { agent } from "@prometheus/core";

import { setColorEnabled } from "../render.js";
import { resolveKeymap } from "../tui/keys.js";
import { stringWidth } from "../tui/width.js";
import { contextBreakdown } from "./agent-runtime.js";
import {
  SLASH_REGISTRY,
  type SlashCtx,
  allSlashNames,
  findSlash,
  renderCommands,
  renderContext,
  renderDocs,
  renderHelp,
  renderStats,
} from "./slash-registry.js";
import { createWorkingSet } from "./working-set.js";

setColorEnabled(false);

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const TUNING = {
  model: { provider: "ollama", modelId: "qwen2.5-coder" },
  systemPrompt: "",
  tools: { enabled: true },
  gateMode: "warn",
  dryRun: false,
  verbosity: "normal",
  yes: false,
} as unknown as agent.AgentTuning;

function fakeCtx() {
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
  };
  let subagents = 3;
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
    control: (s) => {
      calls.controls.push(s);
    },
    setCwd: (d) => {
      calls.setCwds.push(d);
      cwd = d;
    },
    compact: () => {},
    exportTranscript: () => "/tmp/proj/session.txt",
    exportTranscriptJson: () => "/tmp/proj/session.json",
    ask: async () => "",
    confirm: async () => false,
    askPath: async (_p, d) => d,
    runSetup: async () => {},
    runPaths: async () => {},
    runDemos: async () => {},
    runUpdates: async () => {},
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
    runRecall: async () => {},
    runInvoke: async () => {},
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
  };
  return {
    ctx,
    calls,
    setCwd: (d: string) => {
      cwd = d;
    },
  };
}

test("GOAL: the registry ships at least 80 commands", () => {
  assert.ok(SLASH_REGISTRY.length >= 80, `expected ≥80 commands, got ${SLASH_REGISTRY.length}`);
});

test("/docs is registered + renderDocs lists the full registry and narrows", () => {
  assert.ok(findSlash("docs"), "/docs must be registered");
  assert.ok(findSlash("ref"), "/docs alias 'ref' resolves");
  const all = renderDocs("");
  assert.match(all, /secure/);
  assert.match(all, /auto/);
  const scan = renderDocs("scan");
  assert.ok(scan.length < all.length, "a filtered docs view is shorter");
  assert.match(scan.toLowerCase(), /scan/);
});

test("no duplicate primary command names", () => {
  const seen = new Set<string>();
  for (const cmd of SLASH_REGISTRY) {
    assert.ok(!seen.has(cmd.name), `duplicate command /${cmd.name}`);
    seen.add(cmd.name);
  }
});

test("/savetokens renders the token-economy toolkit + Gemini Nano", async () => {
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("savetokens");
  assert.ok(cmd, "/savetokens must be registered");
  // resolves via its aliases too
  assert.equal(findSlash("toolkit")?.name, "savetokens");
  assert.equal(findSlash("economy")?.name, "savetokens");
  await cmd.run("", ctx);
  const out = calls.writes.join("\n");
  assert.match(out, /Save tokens/);
  assert.match(out, /Gemini Nano/);
  // --paid tailors the proposal (no throw, still renders)
  await cmd.run("--paid", ctx);
  assert.match(calls.writes.join("\n"), /paid model/);
});

test("/repomap: no-arg shows stats; on|off|refresh apply the verb (CLI-053)", async () => {
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("repomap");
  assert.ok(cmd, "/repomap must be registered");
  assert.equal(cmd.group, "repo");
  await cmd.run("", ctx); // no-arg → stats (never rebuilds)
  assert.equal(calls.repoMapStats, 1);
  assert.deepEqual(calls.repoMapVerbs, []);
  await cmd.run("on", ctx);
  await cmd.run("refresh", ctx);
  await cmd.run("off", ctx);
  assert.deepEqual(calls.repoMapVerbs, ["on", "refresh", "off"]);
  assert.match(calls.writes.join("\n"), /repo map applied: on/);
});

test("/continue dispatches to continueTurn (+ its resume alias) (CLI-072)", async () => {
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("continue");
  assert.ok(cmd, "/continue must be registered");
  assert.equal(cmd.group, "session");
  assert.equal(findSlash("go-on")?.name, "continue"); // alias
  await cmd.run("", ctx);
  assert.equal(calls.continues, 1, "/continue calls continueTurn");
});

test("/git registered + in tab-completion; a bogus verb lists valid verbs WITHOUT spawning git (CLI-091)", async () => {
  assert.ok(findSlash("git"), "/git must be registered");
  assert.ok(allSlashNames().includes("git"), "/git appears in tab-completion");
  const { ctx, calls } = fakeCtx();
  await findSlash("git")?.run("bogus", ctx);
  assert.equal(calls.gitArgv.length, 0, "a bogus verb must not spawn git");
  assert.match(strip(calls.writes.join("\n")), /status \| diff \| log/);
});

test("/keys prints the effective keymap, marks user overrides + lists reserved keys (CLI-096)", async () => {
  assert.ok(findSlash("keys"), "/keys must be registered");
  const { ctx, calls } = fakeCtx();
  // a user rebind of history-prev to a free key (pageup); the rest stay default.
  ctx.keymap = resolveKeymap({ "history-prev": "pageup" });
  await findSlash("keys")?.run("", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /pageup\s+history-prev\s+\(user \*\)/); // override marked
  assert.match(out, /enter\s+send\s+\(default\)/); // unchanged default
  assert.match(out, /reserved \(unbindable\): ctrl-c, esc/); // reserved listed
});

test("/git status spawns the read-only status argv + renders a clean tree on empty output (CLI-091)", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("git")?.run("status", ctx);
  // it probed the repo then ran the allowlisted status argv (never a mutating verb).
  const argvs = calls.gitArgv.map((a) => a.join(" "));
  assert.ok(argvs.some((a) => a.includes("status --porcelain=v2 -z")));
  assert.ok(!argvs.some((a) => /\b(push|commit|checkout|reset|add)\b/.test(a)));
  assert.match(strip(calls.writes.join("\n")), /working tree clean/);
});

test("/worktree list renders worktrees; switch repoints session cwd (CLI-054)", async () => {
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("worktree");
  assert.ok(cmd, "/worktree must be registered");
  assert.equal(findSlash("wt")?.name, "worktree"); // alias
  assert.equal(cmd.group, "repo");

  await cmd.run("list", ctx);
  const listed = strip(calls.writes.join("\n"));
  assert.match(listed, /\/repo\b/);
  assert.match(listed, /main/);
  assert.match(listed, /feat/);

  await cmd.run("switch feat", ctx);
  assert.deepEqual(calls.setCwds, ["/repo-wt-feat"]); // repointed to the matching worktree root
});

test("/worktree: non-repo cwd errors without further git spawns (CLI-054)", async () => {
  const { ctx, calls } = fakeCtx();
  // override git so the repo check returns false.
  (ctx as { git: (a: string[]) => Promise<{ code: number; stdout: string; stderr: string }> }).git =
    async (args) => {
      calls.gitArgv.push(args);
      return { code: 1, stdout: "false\n", stderr: "" };
    };
  await findSlash("worktree")?.run("create feature", ctx);
  assert.match(strip(calls.writes.join("\n")), /not a git repository/);
  // only the rev-parse guard ran — no `worktree add` spawn.
  assert.ok(
    calls.gitArgv.every((a) => !a.includes("add")),
    "no further git spawn after the guard",
  );
});

test("contextBreakdown: rows sum to the exact total; unknown window → pct null (CLI-057)", () => {
  const { rows, total } = contextBreakdown(
    [
      { label: "a", chars: 400 }, // 100 tok
      { label: "b", chars: 2000 }, // 500 tok
    ],
    8192,
  );
  assert.equal(rows[0]?.estTokens, 100);
  assert.equal(rows[1]?.estTokens, 500);
  assert.equal(
    rows.reduce((n, r) => n + r.estTokens, 0),
    total,
  ); // rows sum to total (exact)
  // unknown / 0 / NaN / Infinity window ⇒ every pct null
  for (const w of [undefined, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { rows: r2, window } = contextBreakdown([{ label: "a", chars: 4 }], w);
    assert.equal(r2[0]?.pct, null);
    assert.equal(window, undefined);
  }
});

test("/context: long transcript dominates; every line ≤ 80 cols (CLI-057)", () => {
  const { ctx, calls } = fakeCtx();
  (
    ctx as {
      contextBreakdown: () => { parts: { label: string; chars: number }[]; window?: number };
    }
  ).contextBreakdown = () => ({
    parts: [
      { label: "system prompt", chars: 400 },
      { label: "transcript", chars: 200_000 }, // dominates
      { label: "tool definitions", chars: 800 },
    ],
    window: 131_072,
  });
  const out = findSlash("context");
  assert.ok(out);
  out.run("", ctx);
  const lines = calls.writes.flatMap((w) => w.split("\n")).map(strip);
  // transcript row tokens > all other rows combined
  assert.match(calls.writes.join("\n"), /transcript/);
  for (const line of lines) {
    assert.ok(stringWidth(line) <= 80, `line exceeds 80 cols: ${JSON.stringify(line)}`);
  }
});

test("/context: ≥80% of a known window warns; unknown window → n/a + no warn (CLI-057)", () => {
  const near = fakeCtx();
  (near.ctx as { contextBreakdown: () => unknown }).contextBreakdown = () => ({
    parts: [{ label: "transcript", chars: 30_000 }], // ~7500 tok
    window: 8192, // 91%
  });
  for (const l of renderContext(near.ctx)) near.ctx.write(l);
  assert.match(strip(near.calls.writes.join("\n")), /condense to reclaim space/);

  const unk = fakeCtx();
  (unk.ctx as { contextBreakdown: () => unknown }).contextBreakdown = () => ({
    parts: [{ label: "transcript", chars: 30_000 }],
    // no window
  });
  for (const l of renderContext(unk.ctx)) unk.ctx.write(l);
  const text = strip(unk.calls.writes.join("\n"));
  assert.match(text, /n\/a/);
  assert.doesNotMatch(text, /condense to reclaim/); // no warning when window unknown
});

test("renderStats: unknown model → n/a + hint, no $ figure (CLI-058)", () => {
  const out = renderStats({
    turns: 3,
    inputTokens: 1000,
    outputTokens: 500,
    estTokens: 1500,
    estimated: true,
    cost: null,
    model: "custom:mystery-model",
    estCostUsd: 0,
  }).join("\n");
  assert.match(out, /n\/a/);
  assert.match(out, /no pricing for mystery-model/);
  assert.doesNotMatch(out, /\$/); // never a synthesized dollar figure
});

test("renderStats: local → $0.00 (local); estimated tokens carry ~ (CLI-058)", () => {
  const out = renderStats({
    turns: 1,
    inputTokens: 2000,
    outputTokens: 1000,
    estTokens: 3000,
    estimated: true,
    cost: 0,
    model: "ollama:qwen2.5",
    estCostUsd: 0,
  }).join("\n");
  assert.match(out, /\$0\.00/);
  assert.match(out, /\(local\)/);
  assert.match(out, /~2,000 in/); // estimate marker present
});

test("renderStats: priced model shows the cost; provider-reported drops ~ (CLI-058)", () => {
  const priced = renderStats({
    turns: 1,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    estTokens: 2_000_000,
    estimated: false, // provider-reported
    cost: 18, // e.g. $3 in + $15 out per MTok
    model: "anthropic:claude-sonnet-4",
    estCostUsd: 18,
  }).join("\n");
  assert.match(priced, /\$18\.0000/);
  assert.doesNotMatch(priced, /~1,000,000 in/); // provider counts: no ~ marker
  assert.match(priced, /1,000,000 in/);
});

test("/memory: no-arg lists steering; refresh/edit/create/update route (CLI-061)", async () => {
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("memory");
  assert.ok(cmd, "/memory must be registered");
  assert.equal(findSlash("steering")?.name, "memory"); // alias

  await cmd.run("", ctx); // list
  assert.match(strip(calls.writes.join("\n")), /Steering files/);
  assert.match(strip(calls.writes.join("\n")), /AGENTS\.md/);

  await cmd.run("refresh", ctx);
  await cmd.run("edit 1", ctx);
  await cmd.run("create", ctx);
  assert.deepEqual(calls.steering, ["reload", "edit:1", "create"]);

  await cmd.run("update", ctx); // legacy prompt-delegation
  assert.match(calls.prompts.join("\n"), /update PROMETHEUS\.md/);
});

test("/copy copies the last assistant reply via the clipboard hook (CLI-068)", async () => {
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("copy");
  assert.ok(cmd, "/copy must be registered");
  assert.equal(findSlash("yank")?.name, "copy"); // alias
  await cmd.run("", ctx);
  assert.deepEqual(calls.copies, ["(last-reply)"]); // no text arg → last reply
  assert.match(calls.writes.join("\n"), /terminal clipboard/);
});

test("findSlash resolves names AND aliases", () => {
  assert.equal(findSlash("scan")?.name, "scan");
  assert.equal(findSlash("ls")?.name, "list"); // alias
  assert.equal(findSlash("new")?.name, "reset"); // alias (clear → reset, flavored primary)
  assert.equal(findSlash("clear")?.name, "reset"); // old Claude-Code name kept as alias
  assert.equal(findSlash("compact")?.name, "condense"); // alias preserved
  assert.equal(findSlash("model")?.name, "worker"); // alias preserved
  assert.equal(findSlash("h")?.name, "help"); // alias
  assert.equal(findSlash("__nope__"), undefined);
  assert.ok(allSlashNames().length >= SLASH_REGISTRY.length); // names + aliases
});

test("verb passthrough → runVerb with the right tokens", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("scan")?.run("", ctx);
  await findSlash("install")?.run("rust-analyzer --only x", ctx);
  await findSlash("pull")?.run("meta/llama", ctx); // fixed-arg verb: model pull
  assert.deepEqual(calls.verbs[0], ["scan"]);
  assert.deepEqual(calls.verbs[1], ["install", "rust-analyzer", "--only", "x"]);
  assert.deepEqual(calls.verbs[2], ["model", "pull", "meta/llama"]);
});

test("macro → sendToAgent with a templated prompt", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("commit")?.run("", ctx);
  await findSlash("explain")?.run("src/auth.ts", ctx);
  assert.equal(calls.prompts.length, 2);
  assert.match(calls.prompts[0] ?? "", /commit/i);
  assert.match(calls.prompts[1] ?? "", /src\/auth\.ts/);
});

test("toggle + gate → tune; clear/quit → control", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("dry-run")?.run("on", ctx);
  await findSlash("gate")?.run("enforce", ctx);
  await findSlash("clear")?.run("", ctx);
  await findSlash("quit")?.run("", ctx);
  assert.deepEqual(calls.tunes[0], { dryRun: true });
  assert.deepEqual(calls.tunes[1], { gateMode: "enforce" });
  assert.deepEqual(calls.controls, ["clear", "quit"]);
});

test("/agents sets the subagent count", async () => {
  const { ctx } = fakeCtx();
  await findSlash("agents")?.run("5", ctx);
  assert.equal(ctx.agents.count(), 5);
});

test("renderCommands lists the count + groups; renderHelp mentions /faq", () => {
  const cmds = renderCommands();
  assert.match(cmds, new RegExp(`${SLASH_REGISTRY.length} commands`));
  assert.match(cmds, /Session/);
  assert.match(cmds, /Security/);
  assert.match(renderHelp(), /\/faq/);
});

test("/add-dir: validates, lists, and removes a real working-set dir (CLI-004)", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "prom-ws-"));
  const cmd = findSlash("add-dir");
  assert.ok(cmd, "/add-dir must be registered");

  // no-arg → lists the (empty) working set + the implicit cwd root.
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("", ctx);
    assert.ok(calls.writes.some((w) => /root:/.test(w)));
    assert.ok(calls.writes.some((w) => /empty/.test(w)));
  }
  // add a real dir → confirmed + listed; nonexistent → error, nothing added.
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run(base, ctx);
    assert.ok(calls.writes.some((w) => /✓ added/.test(w)));
    calls.writes.length = 0;
    await cmd.run("/nonexistent/path/xyz", ctx);
    assert.ok(calls.writes.some((w) => /add-dir:/.test(w) && /no such path/.test(w)));
    assert.equal(ctx.workingSet.list().length, 1, "an invalid add must not grow the set");
    // list now shows the added dir
    calls.writes.length = 0;
    await cmd.run("", ctx);
    assert.ok(calls.writes.some((w) => w.includes(base) || w.includes("/private")));
  }
  // --remove round-trip: present → removed; unknown → error.
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run(base, ctx);
    calls.writes.length = 0;
    await cmd.run(`--remove ${base}`, ctx);
    assert.ok(calls.writes.some((w) => /✓ removed/.test(w)));
    assert.equal(ctx.workingSet.list().length, 0);
    await cmd.run("--remove /not/in/set", ctx);
    assert.ok(calls.writes.some((w) => /not in the working set/.test(w)));
  }
});

test("/system: set → show round-trip, reset default, -- escape, no truncation (CLI-017)", async () => {
  const cmd = findSlash("system");
  assert.ok(cmd, "/system must be registered");
  // no-arg SHOW = the default, verbatim
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("", ctx);
    assert.ok(calls.writes.some((w) => /profile default/.test(w)));
    assert.ok(calls.writes.some((w) => w === "You are Prometheus."));
  }
  // set stores the FULL text; show reflects it as an override
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("Be terse and precise.", ctx);
    assert.deepEqual(calls.tunes.at(-1), { systemPrompt: "Be terse and precise." });
    calls.writes.length = 0;
    await cmd.run("", ctx);
    assert.ok(calls.writes.some((w) => /session override/.test(w)));
    assert.ok(calls.writes.some((w) => w === "Be terse and precise."));
  }
  // `reset` (whole word) restores the captured default
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("custom", ctx);
    await cmd.run("reset", ctx);
    assert.deepEqual(calls.tunes.at(-1), { systemPrompt: "You are Prometheus." });
  }
  // `-- ` escape lets a literal prompt begin with the word "reset"
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("-- reset the module state", ctx);
    assert.deepEqual(calls.tunes.at(-1), { systemPrompt: "reset the module state" });
  }
  // the stored value is the full input (preview is display-only)
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("y".repeat(300), ctx);
    assert.equal((calls.tunes.at(-1) as { systemPrompt: string }).systemPrompt.length, 300);
  }
});

test("/tools: list, global on/off, per-tool disarm, unknown name no-op (CLI-018)", async () => {
  const cmd = findSlash("tools");
  assert.ok(cmd, "/tools must be registered");
  // list shows each tool + a global header
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("list", ctx);
    assert.ok(calls.writes.some((w) => /global/.test(w)));
    assert.ok(calls.writes.some((w) => /propose_edit/.test(w)));
  }
  // global off → tune enabled:false
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("off", ctx);
    assert.equal((calls.tunes.at(-1) as { tools: { enabled: boolean } }).tools.enabled, false);
  }
  // per-tool disarm adds to deny; others untouched
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("off propose_edit", ctx);
    assert.deepEqual((calls.tunes.at(-1) as { tools: { deny: string[] } }).tools.deny, [
      "propose_edit",
    ]);
  }
  // unknown tool name → error, ZERO state change
  {
    const { ctx, calls } = fakeCtx();
    await cmd.run("off no_such_tool", ctx);
    assert.equal(calls.tunes.length, 0, "an unknown tool must not mutate tuning");
    assert.ok(calls.writes.some((w) => /no tool/.test(w)));
  }
});

test("/export --json uses the structured export; plain /export unchanged (CLI-082)", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("export")?.run("", ctx);
  assert.match(strip(calls.writes.at(-1) ?? ""), /session\.txt/); // plain-text path
  await findSlash("export")?.run("--json", ctx);
  assert.match(strip(calls.writes.at(-1) ?? ""), /session\.json/); // structured JSON sibling
});

test("/tools reaches the HOST-LOCAL tools, so the machine-touching ones can be disarmed", async () => {
  // `/tools` listed only the shared catalog, which meant write_file, run_command, apply_patch,
  // spawn_agent and every MCP tool were invisible to `list` AND rejected as unknown names by
  // `off` — the user could not disarm exactly the tools that touch their machine.
  const cmd = findSlash("tools");
  assert.ok(cmd);
  const hostTool = {
    name: "mcp__github__create_issue",
    title: "",
    description: "opens an issue",
    schema: {},
    annotations: {},
    toArgv: () => [],
  };
  const withExtra = {
    ...TUNING,
    tools: { enabled: true, allow: [], deny: [], extra: [hostTool] },
  } as unknown as agent.AgentTuning;

  {
    const { ctx, calls } = fakeCtx();
    ctx.tuning = () => withExtra;
    await cmd.run("list", ctx);
    assert.ok(
      calls.writes.some((w) => /mcp__github__create_issue/.test(w)),
      "a connected server's tool was not listed",
    );
  }
  {
    const { ctx, calls } = fakeCtx();
    ctx.tuning = () => withExtra;
    await cmd.run("off mcp__github__create_issue", ctx);
    assert.deepEqual((calls.tunes.at(-1) as { tools: { deny: string[] } })?.tools.deny, [
      "mcp__github__create_issue",
    ]);
  }
  // …and a name that is in NEITHER catalog is still refused with zero state change.
  {
    const { ctx, calls } = fakeCtx();
    ctx.tuning = () => withExtra;
    await cmd.run("off mcp__ghost__nope", ctx);
    assert.equal(calls.tunes.length, 0);
  }
});

/* ---- /hooks (CLI-102): list configured lifecycle hooks + dry-run one for real ---- */

test("/hooks: a surface with no diagnostic wired says so, rather than throwing", async () => {
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("hooks");
  assert.ok(cmd, "/hooks must be registered");
  await cmd.run("", ctx); // fakeCtx() never sets ctx.hooks
  assert.match(calls.writes.join("\n"), /no hooks diagnostic/);
});

test("/hooks: no-arg lists every configured hook — event, matcher, command, source", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.hooks = {
    list: () => [
      { event: "PreToolUse", matcher: "write_*", command: "guard.sh", source: "workspace" },
      { event: "SessionStart", command: "welcome.sh", source: "global" },
    ],
    test: async () => [],
  };
  await findSlash("hooks")?.run("", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /PreToolUse/);
  assert.match(out, /write_\*/);
  assert.match(out, /guard\.sh/);
  assert.match(out, /workspace/);
  assert.match(out, /SessionStart/);
  assert.match(out, /welcome\.sh/);
  assert.match(out, /global/);
});

test("/hooks: no-arg with nothing configured says so instead of an empty list", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.hooks = { list: () => [], test: async () => [] };
  await findSlash("hooks")?.run("", ctx);
  assert.match(calls.writes.join("\n"), /no hooks configured/);
});

test("/hooks test: rejects an unknown event before calling into the runner", async () => {
  const { ctx, calls } = fakeCtx();
  let called = false;
  ctx.hooks = {
    list: () => [],
    test: async () => {
      called = true;
      return [];
    },
  };
  await findSlash("hooks")?.run("test Whoops write_file", ctx);
  assert.match(calls.writes.join("\n"), /unknown event/);
  assert.equal(called, false, "an invalid event must never reach the runner");
});

test("/hooks test: PreToolUse/PostToolUse require a tool name", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.hooks = { list: () => [], test: async () => [] };
  await findSlash("hooks")?.run("test PreToolUse", ctx);
  assert.match(calls.writes.join("\n"), /needs a tool name/);
});

test("/hooks test: SessionStart needs no tool and synthesizes {event, cwd}", async () => {
  const { ctx, calls, setCwd } = fakeCtx();
  setCwd("/tmp/proj");
  let seenPayload = "";
  ctx.hooks = {
    list: () => [],
    test: async (event, payload) => {
      seenPayload = payload;
      assert.equal(event, "SessionStart");
      return [{ command: "welcome.sh", exitCode: 0, stdout: "hi\n", stderr: "" }];
    },
  };
  await findSlash("hooks")?.run("test SessionStart", ctx);
  assert.deepEqual(JSON.parse(seenPayload), { event: "SessionStart", cwd: "/tmp/proj" });
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /welcome\.sh/);
  assert.match(out, /exit 0/);
  assert.match(out, /hi/);
});

test("/hooks test: PreToolUse synthesizes a schema-shaped {tool, args} payload", async () => {
  const { ctx } = fakeCtx();
  let seenPayload = "";
  let seenTool: string | undefined;
  ctx.hooks = {
    list: () => [],
    test: async (_event, payload, tool) => {
      seenPayload = payload;
      seenTool = tool;
      return [{ command: "guard.sh", matcher: "write_*", exitCode: 1, stdout: "", stderr: "nope" }];
    },
  };
  await findSlash("hooks")?.run("test PreToolUse write_file", ctx);
  assert.equal(seenTool, "write_file");
  const payload = JSON.parse(seenPayload) as { tool: string; args: Record<string, unknown> };
  assert.equal(payload.tool, "write_file");
  // write_file's real schema is {path, content} (both required strings) — the synthesized args
  // must carry both keys so a hook script reading `.args.path` sees something.
  assert.ok("path" in payload.args, "synthesized args must include the tool's `path` field");
  assert.ok("content" in payload.args, "synthesized args must include the tool's `content` field");
});

test("/hooks test: PostToolUse's payload additionally carries a synthesized `result`", async () => {
  const { ctx } = fakeCtx();
  let seenPayload = "";
  ctx.hooks = {
    list: () => [],
    test: async (_event, payload) => {
      seenPayload = payload;
      return [];
    },
  };
  await findSlash("hooks")?.run("test PostToolUse write_file", ctx);
  const payload = JSON.parse(seenPayload) as { tool: string; result: unknown };
  assert.equal(payload.tool, "write_file");
  assert.ok(payload.result, "PostToolUse must synthesize a `result` alongside tool/args");
});

test("/hooks test: renders exit code, stdout, stderr, and a no-match line honestly", async () => {
  // a matching hook that fails
  {
    const { ctx, calls } = fakeCtx();
    ctx.hooks = {
      list: () => [],
      test: async () => [
        {
          command: "guard.sh",
          matcher: "write_*",
          exitCode: 1,
          stdout: "checking…\n",
          stderr: "denied",
        },
      ],
    };
    await findSlash("hooks")?.run("test PreToolUse write_file", ctx);
    const out = strip(calls.writes.join("\n"));
    assert.match(out, /guard\.sh/);
    assert.match(out, /exit 1/);
    assert.match(out, /checking/);
    assert.match(out, /denied/);
  }
  // nothing matched → an honest "no hook matches" line, not a blank screen
  {
    const { ctx, calls } = fakeCtx();
    ctx.hooks = { list: () => [], test: async () => [] };
    await findSlash("hooks")?.run("test PreToolUse run_command", ctx);
    assert.match(calls.writes.join("\n"), /no hook matches/);
  }
});
