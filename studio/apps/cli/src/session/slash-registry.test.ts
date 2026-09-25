/**
 * slash-registry.test.ts — the 80+ /command registry: the count goal, lookup +
 * aliases, no duplicates, and that each command TYPE wires its capability (verb
 * passthrough → runVerb, macro → sendToAgent, toggle → tune, control → control).
 * A fake SlashCtx captures every call — no host, no engine.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type agent, ai } from "@prometheus/core";

import { setColorEnabled } from "../render.js";
import { resolveKeymap } from "../tui/keys.js";
import { stringWidth } from "../tui/width.js";
import { contextBreakdown } from "./agent-runtime.js";
import type { ModelCandidate } from "./model-candidates.js";
import { MAX_SUBAGENTS } from "./orchestrator.js";
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
    // A LOCAL twin of `__fixtures__/slash-ctx.ts` lives in this file, so a new required member
    // of SlashCtx has to be added in both places — which is exactly how `/think` came to write
    // through `tune` here while the hosts had a setter of their own. Recorded as a tune so the
    // existing assertions on `calls.tunes` keep meaning "what /think asked for".
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
      // no filesystem here — every move "succeeds", so these tests stay about the COMMAND.
      // (This fake is a second copy of `__fixtures__/slash-ctx.ts`'s; both must return a
      // result now that `setCwd` reports whether it actually moved.)
      return { ok: true, cwd: d };
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

/**
 * Regression: /demos declared "orchestrate" as an alias, but a LATER, unrelated command in this
 * same array had "orchestrate" as its own PRIMARY name — BY_NAME's build loop has no
 * duplicate-key guard, so the later registration silently won and findSlash("orchestrate") never
 * actually reached /demos, contradicting /demos's own declared alias table. This test generalizes
 * past that one instance: no alias may collide with ANY other command's primary name or alias.
 */
test("no alias collides with another command's primary name or a different command's alias", () => {
  const owner = new Map<string, string>();
  for (const cmd of SLASH_REGISTRY) owner.set(cmd.name, cmd.name);
  for (const cmd of SLASH_REGISTRY) {
    for (const alias of cmd.aliases ?? []) {
      const existing = owner.get(alias);
      assert.ok(
        !existing || existing === cmd.name,
        `alias "${alias}" declared on /${cmd.name} collides with /${existing} — one silently shadows the other`,
      );
      owner.set(alias, cmd.name);
    }
  }
});

test("findSlash('orchestrate') resolves to the standalone macro, not /demos (alias collision fix)", () => {
  assert.equal(findSlash("orchestrate")?.name, "orchestrate");
  assert.equal(findSlash("swarm")?.name, "demos");
  // `fleet` used to be a third alias of /demos and is now a command of its own — the per-window
  // presence table the fleet bar's legend tells the user to run. Two different nouns had claimed
  // one word: a swarm of AGENTS, and the fleet of terminal WINDOWS. `swarm` says the first one,
  // and a legend cannot point at a command that resolves to something else.
  assert.equal(findSlash("fleet")?.name, "fleet");
  assert.ok(!findSlash("demos")?.aliases?.includes("orchestrate"));
});

test("/mention: a bare invocation shows a usage hint, never leaks the '<path>' placeholder to the agent", async () => {
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("mention");
  assert.ok(cmd, "/mention must be registered");
  await cmd.run("", ctx);
  assert.equal(calls.prompts.length, 0, "must not send a bogus prompt to the agent");
  assert.match(calls.writes.join("\n"), /usage: \/mention <file>/);

  await cmd.run("src/auth.ts", ctx);
  assert.equal(calls.prompts.length, 1);
  assert.match(calls.prompts[0] ?? "", /Read the file src\/auth\.ts/);
  assert.doesNotMatch(calls.prompts[0] ?? "", /<path>/);
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

test("/tab-complete: off by default, reports + persists on/off, rejects a bogus arg", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.home = mkdtempSync(join(tmpdir(), "prom-tab-complete-"));
  const cmd = findSlash("tab-complete");
  assert.ok(cmd, "/tab-complete must be registered");
  assert.equal(cmd.group, "config");

  await cmd.run("", ctx);
  assert.match(strip(calls.writes.pop() ?? ""), /off/);

  await cmd.run("on", ctx);
  assert.match(strip(calls.writes.pop() ?? ""), /→ on/);
  await cmd.run("", ctx);
  assert.match(strip(calls.writes.pop() ?? ""), /: on/, "the toggle persisted across calls");

  await cmd.run("off", ctx);
  assert.match(strip(calls.writes.pop() ?? ""), /→ off/);

  await cmd.run("sideways", ctx);
  assert.match(strip(calls.writes.pop() ?? ""), /usage: \/tab-complete/);
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

test("/ls lists the SESSION cwd (not process.cwd): dirs first with a slash, dotfiles hidden unless -a", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "prom-ls-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "README.md"), "x");
  writeFileSync(join(dir, "a.ts"), "x");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  setColorEnabled(false);
  try {
    const { ctx, calls, setCwd } = fakeCtx();
    setCwd(dir);
    const cmd = findSlash("ls");
    assert.ok(cmd, "/ls is registered");
    await cmd.run("", ctx);
    const out = calls.writes.join("\n");
    assert.match(out, new RegExp(`${dir.split("/").pop()}`), "the header names the directory");
    assert.match(out, /2 dirs, 2 files, 1 hidden \(\/ls -a\)/);
    // dirs first, then files, each alphabetical; dirs carry a trailing slash
    assert.ok(out.indexOf("docs/") < out.indexOf("src/"));
    assert.ok(out.indexOf("src/") < out.indexOf("README.md"));
    assert.doesNotMatch(out, /\.env/, "dotfiles hidden by default");

    calls.writes.length = 0;
    await cmd.run("-a", ctx);
    assert.match(calls.writes.join("\n"), /\.env/, "-a shows them");

    calls.writes.length = 0;
    await cmd.run("src", ctx); // relative to the SESSION cwd
    assert.match(calls.writes.join("\n"), /0 dirs, 0 files/);
    assert.match(calls.writes.join("\n"), /\(empty\)/);

    calls.writes.length = 0;
    await cmd.run("nope", ctx);
    assert.match(calls.writes.join("\n"), /no such directory: .*nope/);

    calls.writes.length = 0;
    await cmd.run("-x", ctx);
    assert.match(calls.writes.join("\n"), /unknown option -x/);
  } finally {
    setColorEnabled(true);
  }
});

test("findSlash resolves names AND aliases", () => {
  assert.equal(findSlash("scan")?.name, "scan");
  assert.equal(findSlash("ls")?.name, "ls"); // its own command now: the directory listing
  assert.equal(findSlash("list")?.name, "list"); // the catalog keeps its name
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

/**
 * Regression: a quoted value used to reach the verb WORSE than an unquoted one — the plain
 * `.split(/\s+/)` truncated a bare `/gate-target my target` to just "my", and quoting it made
 * the literal `"`/`'` characters part of the first/last token instead of being stripped, since
 * nothing in this path is a real shell. `toks()` now honors "..."/'...' quoting.
 */
test("verb passthrough: a quoted value reaches the verb as ONE token, not truncated or quote-corrupted", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("gate-target")?.run('"my target with spaces"', ctx);
  assert.deepEqual(calls.verbs[0], ["gate", "my target with spaces"]);

  await findSlash("quarantine")?.run("restore abc123 --dir '/Users/me/My Drive/quarantine'", ctx);
  assert.deepEqual(calls.verbs[1], [
    "secure",
    "quarantine",
    "restore",
    "abc123",
    "--dir",
    "/Users/me/My Drive/quarantine",
  ]);

  // unquoted multi-word input is unchanged (still one token per word — quoting is opt-in, not
  // magic reassembly of unmarked input).
  await findSlash("gate-target")?.run("my target with spaces", ctx);
  assert.deepEqual(calls.verbs[2], ["gate", "my", "target", "with", "spaces"]);

  // an unterminated quote degrades leniently (no throw, no shell to reprompt) instead of
  // corrupting adjacent tokens.
  await findSlash("gate-target")?.run('"unterminated', ctx);
  assert.deepEqual(calls.verbs[3], ["gate", "unterminated"]);
});

test("/worktree create: a quoted path with a space is no longer truncated at the first word", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("worktree")?.run('create mybranch "/Users/name/My Documents/proj"', ctx);
  assert.deepEqual(calls.gitArgv.at(-1), [
    "-C",
    "/tmp/proj",
    "worktree",
    "add",
    "/Users/name/My Documents/proj",
    "mybranch",
  ]);
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

/** A candidate + fake `modelPicker` (mirrors the real session-bridge/host `select` contract). */
function fakeModelCandidate(id: string, label: string, current = false): ModelCandidate {
  return {
    id,
    label,
    detail: "local · ollama",
    current,
    model: { provider: "ollama", modelId: label },
    endpoint: {
      id,
      baseUrl: "http://localhost:11434/v1",
      locality: "local",
      contextWindow: 8192,
      supportsTools: true,
      model: label,
    },
  };
}
function fakeModelPicker(candidates: ModelCandidate[]): {
  picker: NonNullable<SlashCtx["modelPicker"]>;
  selected: string[];
} {
  const selected: string[] = [];
  return {
    picker: {
      candidates: () => candidates,
      select: (id) => {
        const picked = candidates.find((c) => c.id === id);
        if (!picked) return { ok: false, reason: `no model matching "${id}"` };
        selected.push(id);
        return { ok: true, label: picked.label };
      },
    },
    selected,
  };
}

test("/model (alias /worker) with NO picker wired: says so — never silently forwards to runVerb", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("model")?.run("qwen3", ctx);
  assert.equal(
    calls.verbs.length,
    0,
    "must never route through the model-hub verb tree — that was the bug",
  );
  assert.match(calls.writes.join("\n"), /model switching isn't available/);
});

test("/model <id>: resolves against the picker and switches — the confirmed CLI-1xx bug fix", async () => {
  const { ctx, calls } = fakeCtx();
  const { picker, selected } = fakeModelPicker([
    fakeModelCandidate("local:ollama:qwen3:8b", "qwen3:8b"),
  ]);
  await findSlash("model")?.run("qwen3:8b", { ...ctx, modelPicker: picker });
  assert.deepEqual(selected, ["local:ollama:qwen3:8b"]);
  assert.equal(calls.verbs.length, 0);
  assert.match(calls.writes.join("\n"), /✓ model → qwen3:8b/);
});

test("/model: an unrecognized argument reports a clear error, never 'unknown model verb'", async () => {
  const { ctx, calls } = fakeCtx();
  const { picker } = fakeModelPicker([]);
  await findSlash("model")?.run("gpt-99", { ...ctx, modelPicker: picker });
  assert.match(calls.writes.join("\n"), /no model matching "gpt-99"/);
  assert.doesNotMatch(calls.writes.join("\n"), /unknown model verb/);
});

test("/model (bare): the numbered baseline picker resolves the number the user typed", async () => {
  const { ctx } = fakeCtx();
  const { picker, selected } = fakeModelPicker([
    fakeModelCandidate("a", "model-a"),
    fakeModelCandidate("b", "model-b", true),
  ]);
  await findSlash("model")?.run("", { ...ctx, modelPicker: picker, ask: async () => "1" });
  assert.deepEqual(selected, ["a"]);
});

test("/model (bare): a blank answer cancels cleanly, does not select anything", async () => {
  const { ctx, calls } = fakeCtx();
  const { picker, selected } = fakeModelPicker([fakeModelCandidate("a", "model-a")]);
  await findSlash("model")?.run("", { ...ctx, modelPicker: picker, ask: async () => "" });
  assert.deepEqual(selected, []);
  assert.match(calls.writes.join("\n"), /cancelled/);
});

test("/model AWAITS an async select — the ✓ line means switched AND measured", async () => {
  // The real hosts measure the newly chosen endpoint before returning (`ai/endpoint-probe.ts`):
  // `modelCandidates` mints an endpoint with the 8192 floor and no `probedCapabilities`, so a
  // `/model` that reported success before the probe landed left the very next `/think`
  // answering for the model the user had just LEFT. Pinned here because the picker contract
  // deliberately still accepts a synchronous double, so nothing else would catch a regression
  // to `const r = picker.select(...)`.
  const { ctx, calls } = fakeCtx();
  const order: string[] = [];
  let resolveSelect: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    resolveSelect = r;
  });
  const picker: NonNullable<SlashCtx["modelPicker"]> = {
    candidates: () => [fakeModelCandidate("local:ollama:qwen3.6", "qwen3.6:latest")],
    select: async (id) => {
      await gate;
      order.push(`selected:${id}`);
      return { ok: true, label: "qwen3.6:latest" };
    },
  };
  const run = findSlash("model")?.run("qwen3.6:latest", { ...ctx, modelPicker: picker });
  // Nothing may be reported while the switch is still in flight.
  await Promise.resolve();
  assert.equal(calls.writes.length, 0, "the ✓ was written before the switch completed");
  resolveSelect?.();
  await run;
  order.push("reported");
  assert.deepEqual(order, ["selected:local:ollama:qwen3.6", "reported"]);
  assert.match(calls.writes.join("\n"), /✓ model → qwen3\.6:latest/);
});

test("/model: a synchronous picker double still works — the contract is a union, not a Promise", async () => {
  const { ctx, calls } = fakeCtx();
  const { picker, selected } = fakeModelPicker([fakeModelCandidate("a", "model-a")]);
  await findSlash("model")?.run("model-a", { ...ctx, modelPicker: picker });
  assert.deepEqual(selected, ["a"]);
  assert.match(calls.writes.join("\n"), /✓ model → model-a/);
});

/* ── /think: three states, not two ──────────────────────────────────────────*/

/** A `SlashCtx` whose `effortResolution` answers with a fixed resolution. */
function thinkCtx(res: ai.EffortResolution | undefined) {
  const { ctx, calls } = fakeCtx();
  return { ctx: { ...ctx, effortResolution: () => res } as SlashCtx, calls };
}

test("/think on a model with no knob says EMULATED — not 'not available'", () => {
  // The regression this pins: `resolveEffort` used to return `applied: null` here, so `/think`
  // printed "not available" while `agent/protocol/contributors/effort-text.ts` injected a
  // graded instruction on every single turn. True of the request parameter, false of the
  // outcome — and the outcome is the thing the user asked about.
  const res = ai.resolveEffort("high", {
    mechanism: "none",
    supported: [],
    note: "Gemma 2/3 have no reasoning mode (Gemma 4 does)",
  });
  const { ctx, calls } = thinkCtx(res);
  findSlash("think")?.run("high", ctx);
  const out = calls.writes.join("\n");
  assert.match(out, /think → high/, "the tier IS in force, so it must be reported");
  assert.match(out, /emulated/);
  assert.match(out, /no reasoning mode/, "the model's own sentence must survive");
  assert.match(out, /step-by-step prompting/, "…and say HOW the tier is being honoured");
  assert.doesNotMatch(out, /not available/);
});

test("/think still says 'not available' where genuinely nothing is in force", () => {
  // `always-on`: the model reasons at a fixed depth and there is no dial to move. This is the
  // case the phrase is now reserved for, and it must not be lost in the rewording.
  const res = ai.resolveEffort("high", {
    mechanism: "always-on",
    supported: [],
    note: "DeepSeek R1 always reasons; depth is not adjustable",
  });
  const { ctx, calls } = thinkCtx(res);
  findSlash("think")?.run("high", ctx);
  const out = calls.writes.join("\n");
  assert.match(out, /not available/);
  assert.match(out, /always reasons/);
  assert.doesNotMatch(out, /emulated/);
});

test("/think on a working knob reports the tier plainly, with no caveat", () => {
  const { cap } = ai.resolveCapability({
    modelId: "qwen3.6:latest",
    runtime: "ollama",
    probedCapabilities: ["completion", "tools", "thinking"],
  });
  const { ctx, calls } = thinkCtx(ai.resolveEffort("high", cap));
  findSlash("think")?.run("high", ctx);
  const out = calls.writes.join("\n");
  assert.match(out, /think → high/);
  assert.doesNotMatch(out, /emulated/);
  assert.doesNotMatch(out, /not available/);
});

test("/think stores the tier even when the model cannot use it as a parameter", () => {
  // Switching to a model that CAN honour it must find the tier already set.
  const { ctx, calls } = thinkCtx(ai.resolveEffort("max", { mechanism: "none", supported: [] }));
  findSlash("think")?.run("max", ctx);
  assert.deepEqual(
    calls.tunes.map((t) => t.effort),
    ["max"],
  );
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

/* ── /cd, /context window, /restore + /compress aliases ────────────────────── */

test("/recall resolves 'restore' and 'resume' to the SAME command", () => {
  assert.equal(findSlash("restore")?.name, "recall");
  assert.equal(findSlash("resume")?.name, "recall");
});

test("/condense resolves 'compact' and 'compress' to the SAME command", () => {
  assert.equal(findSlash("compact")?.name, "condense");
  assert.equal(findSlash("compress")?.name, "condense");
});

test("/cd: a valid target rotates the session via changeProjectDirectory", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.changeProjectDirectory = (dir: string) => ({
    ok: true,
    movedTo: dir,
    newSessionId: "abc1234567-def1234567-abc1234567-def1234567-abc1234567",
    rotated: true,
  });
  await findSlash("cd")?.run("/other/project", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /moved to \/other\/project/);
  assert.match(out, /abc1234567/); // the fresh session id is echoed
  assert.match(out, /model\/tuning kept/);
});

test("/cd: a no-op move (target === current cwd) reports it plainly, without claiming a fresh session", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.changeProjectDirectory = (dir: string) => ({
    ok: true,
    movedTo: dir,
    newSessionId: "same-session-id-unchanged",
    rotated: false,
  });
  await findSlash("cd")?.run("/same/place", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /already in \/same\/place/);
  assert.doesNotMatch(out, /fresh session/);
});

test("/cd: a rejected target reports the error and does NOT fall back to a plain cwd change", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.changeProjectDirectory = () => ({ ok: false, error: "no such directory: /nope" });
  await findSlash("cd")?.run("/nope", ctx);
  assert.match(strip(calls.writes.join("\n")), /no such directory: \/nope/);
  assert.deepEqual(calls.setCwds, []); // the fake ctx's setCwd was never called
});

test("/cd: on a surface with no rotation wired, degrades to a plain cwd change", async () => {
  const { ctx, calls } = fakeCtx();
  assert.equal(ctx.changeProjectDirectory, undefined);
  await findSlash("cd")?.run("/other", ctx);
  assert.deepEqual(calls.setCwds, ["/other"]);
  assert.match(strip(calls.writes.join("\n")), /context kept/);
});

test("/context window: no surface support → an honest 'not available' line", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("context")?.run("window", ctx);
  assert.match(calls.writes.join("\n"), /no context-window setting/);
});

test("/context window <size>: sets directly via a plain count, k-suffix, or preset number", async () => {
  const { ctx } = fakeCtx();
  let stored = 250_000;
  ctx.contextWindowTokens = {
    get: () => stored,
    set: (n: number) => {
      stored = n;
    },
  };
  await findSlash("context")?.run("window 400000", ctx);
  assert.equal(stored, 400_000);
  await findSlash("context")?.run("window 600k", ctx);
  assert.equal(stored, 600_000);
  await findSlash("context")?.run("window 1", ctx); // preset #1 = 100k, not the literal "1"
  assert.equal(stored, 100_000);
});

test("/context window <garbage>: refuses without changing the stored value", async () => {
  const { ctx, calls } = fakeCtx();
  let stored = 250_000;
  ctx.contextWindowTokens = {
    get: () => stored,
    set: (n: number) => {
      stored = n;
    },
  };
  await findSlash("context")?.run("window not-a-size", ctx);
  assert.equal(stored, 250_000);
  assert.match(strip(calls.writes.join("\n")), /can't parse/);
});

test("/context window (no arg): lists every preset, marks the current one, then applies the pick", async () => {
  const { ctx, calls } = fakeCtx();
  let stored = 250_000;
  ctx.contextWindowTokens = {
    get: () => stored,
    set: (n: number) => {
      stored = n;
    },
  };
  ctx.ask = async () => "3"; // 3rd preset
  await findSlash("context")?.run("window", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /250,000.*← current/);
  assert.equal(stored, 400_000); // CONTEXT_WINDOW_PRESETS[2]
});

test("/context window (no arg), cancel on blank input: does not change the stored value", async () => {
  const { ctx, calls } = fakeCtx();
  let stored = 250_000;
  ctx.contextWindowTokens = {
    get: () => stored,
    set: (n: number) => {
      stored = n;
    },
  };
  ctx.ask = async () => "  ";
  await findSlash("context")?.run("window", ctx);
  assert.equal(stored, 250_000);
  assert.match(strip(calls.writes.join("\n")), /cancelled/);
});

test("bare /context (no subcommand) is unaffected by contextWindowTokens being absent", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("context")?.run("", ctx);
  assert.doesNotMatch(calls.writes.join("\n"), /auto-compact ceiling/);
});

test("bare /context appends the auto-compact ceiling line when the surface supports it", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.contextWindowTokens = { get: () => 250_000, set: () => {} };
  await findSlash("context")?.run("", ctx);
  assert.match(strip(calls.writes.join("\n")), /auto-compact ceiling: 250,000 tokens/);
});

/* ── /timeout: the inactivity-pause threshold (idle-watchdog) ─────────────────────────── */

test("/timeout: no surface support → an honest 'not available' line", async () => {
  const { ctx, calls } = fakeCtx();
  await findSlash("timeout")?.run("", ctx);
  assert.match(calls.writes.join("\n"), /no inactivity-timeout setting/);
});

test("/timeout <minutes>: sets directly via a plain number, or a duration with a unit", async () => {
  const { ctx } = fakeCtx();
  let storedMs = 10 * 60_000;
  ctx.idleTimeoutSetting = {
    get: () => storedMs,
    set: (ms: number) => {
      storedMs = ms;
    },
  };
  await findSlash("timeout")?.run("15", ctx);
  assert.equal(storedMs, 15 * 60_000);
  await findSlash("timeout")?.run("90s", ctx);
  assert.equal(storedMs, 90_000);
  // MAX_IDLE_TIMEOUT_MS is 60 minutes, so "2h" would be out of range — use a valid duration.
  await findSlash("timeout")?.run("45m", ctx);
  assert.equal(storedMs, 45 * 60_000);
  // "3" is ambiguous between preset index #3 (5 min) and a literal 3-minute duration — the
  // preset-index reading must win (mirrors /context window's own precedent), so this is what
  // actually proves the index check runs FIRST rather than merely happening to agree with it.
  await findSlash("timeout")?.run("3", ctx);
  assert.equal(storedMs, 5 * 60_000);
});

test("/timeout <garbage>: refuses without changing the stored value", async () => {
  const { ctx, calls } = fakeCtx();
  let storedMs = 10 * 60_000;
  ctx.idleTimeoutSetting = {
    get: () => storedMs,
    set: (ms: number) => {
      storedMs = ms;
    },
  };
  await findSlash("timeout")?.run("not-a-duration", ctx);
  assert.equal(storedMs, 10 * 60_000);
  assert.match(strip(calls.writes.join("\n")), /can't parse/);
});

test("/timeout: a value below the 30s floor is refused, not silently clamped and accepted", async () => {
  const { ctx, calls } = fakeCtx();
  let storedMs = 10 * 60_000;
  ctx.idleTimeoutSetting = {
    get: () => storedMs,
    set: (ms: number) => {
      storedMs = ms;
    },
  };
  await findSlash("timeout")?.run("5s", ctx);
  assert.equal(
    storedMs,
    10 * 60_000,
    "an out-of-range duration must not silently change the setting",
  );
  assert.match(strip(calls.writes.join("\n")), /can't parse/);
});

test("/timeout (no arg): lists every preset, marks the current one, then applies the pick", async () => {
  const { ctx, calls } = fakeCtx();
  let storedMs = 10 * 60_000;
  ctx.idleTimeoutSetting = {
    get: () => storedMs,
    set: (ms: number) => {
      storedMs = ms;
    },
  };
  ctx.ask = async () => "2"; // 2nd preset
  await findSlash("timeout")?.run("", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /10 min.*← current/);
  assert.equal(storedMs, 2 * 60_000); // IDLE_TIMEOUT_PRESETS_MIN[1]
});

test("/timeout (no arg), cancel on blank input: does not change the stored value", async () => {
  const { ctx, calls } = fakeCtx();
  let storedMs = 10 * 60_000;
  ctx.idleTimeoutSetting = {
    get: () => storedMs,
    set: (ms: number) => {
      storedMs = ms;
    },
  };
  ctx.ask = async () => "  ";
  await findSlash("timeout")?.run("", ctx);
  assert.equal(storedMs, 10 * 60_000);
  assert.match(strip(calls.writes.join("\n")), /cancelled/);
});

function queuedAsk(answers: string[]): () => Promise<string> {
  let i = 0;
  return async () => answers[i++] ?? "";
}

test("/hug: a blank source cancels before any prompt for target/quant", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.ask = queuedAsk([""]);
  await findSlash("hug")?.run("", ctx);
  assert.match(strip(calls.writes.join("\n")), /cancelled/);
  assert.deepEqual(calls.verbs, []);
});

test("/hug: inline source + Enter-through-defaults + confirm → ollama/q4_k_m", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.ask = queuedAsk(["", ""]); // target: Enter (ollama), quant: Enter (q4_k_m)
  ctx.confirm = async () => true;
  await findSlash("hug")?.run("acme/tiny", ctx);
  assert.deepEqual(calls.verbs, [
    ["model", "hug", "acme/tiny", "--target", "ollama", "--quant", "q4_k_m", "--yes"],
  ]);
});

test("/hug: picking target 2 and quant 3 by number selects llamacpp / q6_k", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.ask = queuedAsk(["2", "3"]);
  ctx.confirm = async () => true;
  await findSlash("hug")?.run("acme/tiny", ctx);
  assert.deepEqual(calls.verbs, [
    ["model", "hug", "acme/tiny", "--target", "llamacpp", "--quant", "q6_k", "--yes"],
  ]);
});

test("/hug: declining the final confirm runs nothing", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.ask = queuedAsk(["", ""]);
  ctx.confirm = async () => false;
  await findSlash("hug")?.run("acme/tiny", ctx);
  assert.match(strip(calls.writes.join("\n")), /cancelled/);
  assert.deepEqual(calls.verbs, []);
});

test("/hug: an out-of-range target number cancels before the quant prompt", async () => {
  const { ctx, calls } = fakeCtx();
  let askCount = 0;
  ctx.ask = async () => {
    askCount++;
    return "9"; // no 9th target
  };
  await findSlash("hug")?.run("acme/tiny", ctx);
  assert.equal(askCount, 1, "must not reach the quant prompt");
  assert.deepEqual(calls.verbs, []);
  assert.match(strip(calls.writes.join("\n")), /isn't one of the listed numbers/);
});

test("/hug: an out-of-range quant number cancels (the identically-shaped guard below target)", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.ask = queuedAsk(["1", "9"]); // target: Enter-equivalent "1" (ollama), quant: out of range
  await findSlash("hug")?.run("acme/tiny", ctx);
  assert.deepEqual(calls.verbs, []);
  assert.match(strip(calls.writes.join("\n")), /isn't one of the listed numbers/);
});

test("/hug: a blank rest prompts for the source, and the ASKED value is actually used", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.ask = queuedAsk(["acme/asked-tiny", "", ""]); // source, target default, quant default
  ctx.confirm = async () => true;
  await findSlash("hug")?.run("", ctx);
  assert.deepEqual(calls.verbs, [
    ["model", "hug", "acme/asked-tiny", "--target", "ollama", "--quant", "q4_k_m", "--yes"],
  ]);
});

test("/hug: the confirm prompt always shows the chosen quant, even for target ollama", async () => {
  // Regression test: the confirm text used to hide the quant whenever target was
  // "ollama", but for a LOCAL source the quant genuinely is applied (only Ollama's
  // zero-download HF-repo passthrough makes it moot) — so it must never be hidden.
  const { ctx, calls } = fakeCtx();
  let confirmPrompt = "";
  ctx.ask = queuedAsk(["1", "4"]); // target: ollama (default), quant: 4) q8_0
  ctx.confirm = async (prompt) => {
    confirmPrompt = prompt;
    return true;
  };
  await findSlash("hug")?.run("/home/me/models/my-local-model", ctx);
  assert.match(confirmPrompt, /ollama/);
  assert.match(confirmPrompt, /q8_0/);
});

test("/hug: the target/quant menus are numbered with a marked default", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.ask = queuedAsk(["", ""]);
  ctx.confirm = async () => true;
  await findSlash("hug")?.run("acme/tiny", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /1\) ollama {2}\(default\)/);
  assert.match(out, /4\) lmstudio/);
  assert.match(out, /1\) q4_k_m {2}\(default/);
});

test("/traits opens the rail where there is one, and says so where there is not", async () => {
  const cmd = findSlash("traits");
  assert.ok(cmd, "/traits must be registered");
  assert.equal(findSlash("rail")?.name, "traits");
  assert.equal(findSlash("dim")?.name, "traits");

  // the readline host wires no rail: the command must NAME the equivalent one-shot commands
  // rather than silently doing nothing, which is the report the whole rail exists to answer.
  const bare = fakeCtx();
  await cmd.run("", bare.ctx);
  assert.match(bare.calls.writes.join("\n"), /no trait rail on this surface/);
  assert.match(bare.calls.writes.join("\n"), /\/tools on\|off/);

  // wired: it focuses the rail and prints nothing (the chrome IS the feedback).
  const wired = fakeCtx();
  let focused = 0;
  await cmd.run("", {
    ...wired.ctx,
    focusTraitRail: () => {
      focused += 1;
      return true;
    },
  });
  assert.equal(focused, 1);
  assert.deepEqual(wired.calls.writes, []);
});

test("/traits reports honestly when the surface HAS a rail but cannot focus it", async () => {
  // A terminal too short for the rail, or a model that was never probed: the app returns false
  // rather than opening a focus ring over nothing.
  const { ctx, calls } = fakeCtx();
  const cmd = findSlash("traits");
  assert.ok(cmd);
  await cmd.run("", { ...ctx, focusTraitRail: () => false });
  assert.match(calls.writes.join("\n"), /no trait rail on this surface/);
});

test("/agents cannot confirm a fan-out larger than the delegation budget allows", async () => {
  /**
   * It accepted 1–16 and answered `✓ subagents → 16`, while `spawnCapFor` clamps to
   * MAX_SUBAGENTS (8). Half the advertised range confirmed a number the budget could never
   * reach, and the 9th spawn came back "this turn has already spawned 8 sub-agents (limit 8)"
   * for a setting the user had been told was accepted.
   */
  const cmd = findSlash("agents");
  assert.ok(cmd, "/agents must be registered");

  const over = fakeCtx();
  await cmd.run(String(MAX_SUBAGENTS + 8), over.ctx);
  const said = over.calls.writes.join("\n");
  assert.match(said, new RegExp(`subagents → ${MAX_SUBAGENTS}\\b`), "it must confirm the REAL cap");
  assert.match(said, /caps a turn at/, "…and say why the number changed");

  // a value inside the cap is confirmed plainly
  const ok = fakeCtx();
  await cmd.run("3", ok.ctx);
  assert.match(ok.calls.writes.join("\n"), /subagents → 3/);
  assert.doesNotMatch(ok.calls.writes.join("\n"), /caps a turn at/);

  // the bare form advertises the real range, not 1–16
  const bare = fakeCtx();
  await cmd.run("", bare.ctx);
  assert.match(bare.calls.writes.join("\n"), new RegExp(`1–${MAX_SUBAGENTS}`));
});

/* -- a missing directory is an OBSTACLE, not a dead end: offer to create it -- */

/** A fakeCtx whose setCwd reports the target as missing until it is created. */
function missingDirCtx(answer) {
  const base = fakeCtx();
  const created = [];
  let exists = false;
  base.ctx.confirm = async (p) => {
    base.calls.writes.push(`CONFIRM:${p}`);
    return answer;
  };
  base.ctx.setCwd = (d, opts) => {
    if (opts?.create) {
      created.push(d);
      exists = true;
    }
    if (!exists) return { ok: false, error: `no such directory: ${d}`, missing: true, path: d };
    base.calls.setCwds.push(d);
    return { ok: true, cwd: d };
  };
  return { ...base, created };
}

test("/cwd: a missing directory prompts, and YES creates it and moves", async () => {
  const { ctx, calls, created } = missingDirCtx(true);
  await findSlash("cwd")?.run("/new/place", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /CONFIRM:\/new\/place does not exist\. Create it\? \[y\/N\]/);
  assert.deepEqual(created, ["/new/place"]);
  assert.match(out, /cwd → \/new\/place/);
});

test("/cwd: NO leaves the disk alone and says where you still are", async () => {
  const { ctx, calls, created } = missingDirCtx(false);
  await findSlash("cwd")?.run("/new/place", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.deepEqual(created, [], "declining must not create anything");
  assert.match(out, /not created/);
  assert.match(out, /no such directory/);
  assert.match(out, /still in/);
  assert.doesNotMatch(out, /cwd → \/new\/place/, "it must not claim a move it did not make");
});

test("/cd: the same offer, on the rotating path", async () => {
  const { ctx, calls } = fakeCtx();
  const seen = [];
  let exists = false;
  ctx.confirm = async (p) => {
    calls.writes.push(`CONFIRM:${p}`);
    return true;
  };
  ctx.changeProjectDirectory = (dir, opts) => {
    seen.push(opts?.create === true);
    if (opts?.create) exists = true;
    return exists
      ? { ok: true, movedTo: dir, newSessionId: "sess_abcdefghij", rotated: true }
      : { ok: false, error: `no such directory: ${dir}`, missing: true, path: dir };
  };
  await findSlash("cd")?.run("/fresh/proj", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /CONFIRM:\/fresh\/proj does not exist/);
  assert.deepEqual(seen, [false, true], "it retries WITH create after a yes");
  assert.match(out, /moved to \/fresh\/proj/);
});

test("/cd: declining reports the refusal, not a move", async () => {
  const { ctx, calls } = fakeCtx();
  ctx.confirm = async () => false;
  ctx.changeProjectDirectory = (dir) => ({
    ok: false,
    error: `no such directory: ${dir}`,
    missing: true,
    path: dir,
  });
  await findSlash("cd")?.run("/nope", ctx);
  const out = strip(calls.writes.join("\n"));
  assert.match(out, /not created/);
  assert.match(out, /\/cd: no such directory: \/nope/);
  assert.doesNotMatch(out, /moved to/);
});

test("a target that exists as a FILE is never offered for creation", async () => {
  const { ctx, calls } = fakeCtx();
  let asked = false;
  ctx.confirm = async () => {
    asked = true;
    return true;
  };
  ctx.setCwd = (d) => ({ ok: false, error: `not a directory: ${d}`, path: d });
  await findSlash("cwd")?.run("/tmp/notes.md", ctx);
  assert.equal(asked, false, "mkdir -p over a file would fail anyway - do not offer it");
  assert.match(strip(calls.writes.join("\n")), /not a directory/);
});
