/**
 * dispatch-cmd.test.ts — "Do you want to update everything right now? y/N", end to end, faked.
 *
 * The runner, the probes, the model pull, the audit trail and the disk are all fakes: nothing here
 * spawns, downloads or writes outside memory. What is pinned is ORDER and CONSENT — the exact
 * question, asked once, after the preview and only when an answer could be acted on; nothing at
 * all on anything but y/yes; and once running, one step at a time, a failure moving on, a cancel
 * letting the step in flight finish and starting nothing more.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { updates as u } from "@prometheus/core";

import { setColorEnabled } from "../render.js";
import {
  type DispatchDeps,
  UPDATE_EVERYTHING_PROMPT,
  offerAndDispatch,
  runtimeBrewFormula,
  updateEnv,
} from "./dispatch-cmd.js";
import type { DispatchProbes } from "./dispatch-probes.js";
import type { ModelActionDeps } from "./model-actions-cmd.js";
import type { StepOptions, StepResult } from "./run-step.js";

setColorEnabled(false);

const HOME = "/Users/u";

const OFFICIAL: u.CaskFacts = {
  tap: "homebrew/cask",
  receipt: true,
  currentTap: "homebrew/cask",
  checksum: true,
  autoUpdates: false,
  needsRoot: false,
};

/** ripgrep (formula) + codex and flutter (casks) outdated, a model moved, opencode self-updates. */
function report(over: Partial<u.UpdateReport> = {}): u.UpdateReport {
  return {
    clis: [],
    models: {
      diff: { changed: [], added: [], removed: [] },
      suggestions: [],
      upstream: [
        {
          ok: true,
          update: {
            model: "qwen3.6:latest",
            ref: {
              registry: "registry.ollama.ai",
              namespace: "library",
              name: "qwen3.6",
              tag: "latest",
            },
            localDigest: "sha256:aaa",
            remoteDigest: "sha256:bbb",
            changed: true,
            localBytes: 23.9e9,
            remoteBytes: 22.6e9,
            delta: {},
            satisfiable: true,
            newer: true,
            peakDiskBytes: 46.5e9,
          },
        },
      ],
    },
    self: {
      prometheus: "0.1.0",
      updateAvailable: null,
      plan: u.buildSelfUpdatePlan({ method: "git", repoDir: `${HOME}/src/prometheus` }),
    },
    checkedAt: "2026-10-02T00:00:00.000Z",
    managers: [
      {
        manager: "brew",
        label: "Homebrew",
        checkable: true,
        ok: true,
        packages: [
          {
            manager: "brew",
            name: "ripgrep",
            kind: "formula",
            installed: "15.1.0",
            available: "15.2.0",
          },
          {
            manager: "brew",
            name: "codex",
            kind: "cask",
            installed: "0.159.3",
            available: "0.160.0",
          },
          {
            manager: "brew",
            name: "flutter",
            kind: "cask",
            installed: "3.44.6",
            available: "3.47.6",
          },
        ],
      },
    ],
    conflicts: [],
    tools: [
      {
        id: "opencode",
        label: "opencode",
        role: "agent",
        installed: true,
        state: "single",
        copies: [
          {
            pathEntry: `${HOME}/.opencode/bin/opencode`,
            realPath: `${HOME}/.opencode/bin/opencode`,
            owner: "native-installer",
          },
        ],
        current: "1.18.4",
        latest: "1.18.34",
        updateAvailable: true,
        offer: [{ via: "script", command: "opencode upgrade" }],
        withheld: [],
      },
    ],
    ...over,
  };
}

const ok = (stdout = ""): StepResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  aborted: false,
});

const fail = (stderr: string, code = 1): StepResult => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
  aborted: false,
});

interface Harness {
  lines: string[];
  asked: string[];
  ran: { argv: readonly string[]; opts: StepOptions }[];
  audits: { decision: string; command: string; exitCode?: number; reason?: string }[];
  pulled: string[];
  order: string[];
  invalidated: number;
  ac: AbortController;
  actions: Omit<ModelActionDeps, "write">;
  dispatch: DispatchDeps;
  out(): string;
}

function harness(
  o: {
    answer?: string;
    level?: number;
    step?: (argv: readonly string[], opts: StepOptions) => StepResult | Promise<StepResult>;
    pull?: DispatchDeps["pull"];
    free?: () => number | undefined;
    perm?: string;
    dryRun?: boolean;
    closed?: () => boolean;
    onAsk?: (h: Harness) => void;
    probes?: Partial<DispatchProbes>;
    runtime?: string;
    ctrlCIsAbort?: boolean;
  } = {},
): Harness {
  const h = {
    lines: [] as string[],
    asked: [] as string[],
    ran: [] as { argv: readonly string[]; opts: StepOptions }[],
    audits: [] as Harness["audits"],
    pulled: [] as string[],
    order: [] as string[],
    invalidated: 0,
    ac: new AbortController(),
  } as Harness;
  h.out = () => h.lines.join("\n");
  h.actions = {
    confirm: async () => {
      throw new Error("the y/N must go through ask — confirm adds [y/N] and the TUI's is one key");
    },
    ask: async (prompt) => {
      h.order.push("ask");
      h.asked.push(prompt);
      o.onAsk?.(h);
      return o.answer ?? "";
    },
    getAuthLevel: () => o.level ?? 7,
    signal: () => h.ac.signal,
  };
  const probes: DispatchProbes = {
    casks: async (tokens) =>
      new Map(
        tokens.map((t) => [t, t === "flutter" ? { ...OFFICIAL, autoUpdates: true } : OFFICIAL]),
      ),
    formulae: async () => new Map(),
    brewEnv: async () => [],
    npmGlobal: async () => ({
      root: `${HOME}/.npm-global/lib/node_modules`,
      writable: true,
      linked: new Set(),
    }),
    venv: () => ({ pip: true, uvTool: false, project: false, requiredBy: [] }),
    modelStoreHas: () => true,
    modelStorePath: () => `${HOME}/.ollama/models`,
    ...o.probes,
  };
  h.dispatch = {
    run: async (argv, opts) => {
      h.ran.push({ argv, opts });
      return (o.step ?? (() => ok()))(argv, opts);
    },
    probes,
    pull:
      o.pull ??
      (async (tag) => {
        h.pulled.push(tag);
        return { ok: true, error: "", aborted: false };
      }),
    audit: (e) => {
      h.audits.push({
        decision: e.decision,
        command: e.command,
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
      });
    },
    freeDiskBytes: o.free ?? (() => 100e9),
    runtimeFormula: () => o.runtime,
    getPermMode: () => o.perm,
    ctrlCIsAbort: () => o.ctrlCIsAbort ?? true,
    dryRun: () => o.dryRun === true,
    closed: o.closed ?? (() => false),
    invalidateCache: () => {
      h.invalidated += 1;
    },
    platform: "darwin",
    baseEnv: () => ({
      PATH: "/usr/bin",
      SUDO_ASKPASS: "/usr/local/bin/askpass",
      HOMEBREW_CASK_OPTS: "--appdir=~/Applications",
      HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1",
      HOMEBREW_UPGRADE_GREEDY: "1",
    }),
    settle: async () => {
      h.order.push("settle");
    },
  };
  return h;
}

async function go(h: Harness, r: u.UpdateReport = report()) {
  return offerAndDispatch(r, {
    write: (l) => {
      h.lines.push(l);
    },
    actions: h.actions,
    dispatch: h.dispatch,
  });
}

const installs = (h: Harness): string[] => h.ran.map((r) => r.argv.join(" "));

test("asks EXACTLY the owner's question, once, after the preview — and y runs everything in order", async () => {
  const h = harness({ answer: "y" });
  let previewAtAsk = "";
  h.actions.ask = async (prompt) => {
    h.order.push("ask");
    h.asked.push(prompt);
    previewAtAsk = h.out();
    return "y";
  };
  const res = await go(h);
  assert.deepEqual(h.asked, [UPDATE_EVERYTHING_PROMPT]);
  assert.equal(UPDATE_EVERYTHING_PROMPT, "Do you want to update everything right now? y/N");
  // the preview was complete BEFORE the question: every command, and what is NOT run
  assert.match(previewAtAsk, /\$ brew upgrade --formula --yes ripgrep/);
  assert.match(previewAtAsk, /\$ brew upgrade --cask --yes --require-sha codex/);
  assert.match(previewAtAsk, /▸ pull qwen3\.6:latest/);
  assert.match(previewAtAsk, /run these yourself[\s\S]*opencode upgrade/);
  assert.match(previewAtAsk, /brew upgrade --cask flutter[\s\S]*updates itself/);
  assert.ok(!/✓|Done:/.test(previewAtAsk), "nothing had run yet");
  assert.deepEqual(h.order, ["settle", "ask"], "keys typed during the check get a turn first");
  assert.deepEqual(installs(h), [
    "brew upgrade --formula --yes ripgrep",
    "brew upgrade --cask --yes --require-sha codex",
  ]);
  assert.deepEqual(h.pulled, ["qwen3.6:latest"]);
  assert.equal(res.confirmed, true);
  assert.deepEqual(
    res.results.map((r) => r.status),
    ["updated", "updated", "updated"],
  );
  // a "started" line BEFORE each step and the outcome after, so a killed run is still on record
  assert.deepEqual(
    h.audits.map((a) => [a.decision, a.command, a.exitCode ?? null]),
    [
      ["approved", "brew upgrade --formula --yes ripgrep", null],
      ["approved", "brew upgrade --formula --yes ripgrep", 0],
      ["approved", "brew upgrade --cask --yes --require-sha codex", null],
      ["approved", "brew upgrade --cask --yes --require-sha codex", 0],
      ["approved", "ollama pull qwen3.6:latest", null],
      ["approved", "ollama pull qwen3.6:latest", 0],
    ],
  );
  assert.match(h.audits[0]?.reason ?? "", /not scanned by nemesis; started/);
  assert.equal(h.invalidated, 1, "the cached report no longer advertises what just ran");
  assert.match(h.out(), /Done: 3 updated/);
  assert.match(h.out(), /Still yours to run:[\s\S]*opencode upgrade/);
});

test("only y or yes runs anything — Return, n, Esc's empty answer and near-misses run nothing", async () => {
  for (const answer of ["Y", " yes ", "YES"]) {
    const h = harness({ answer });
    await go(h);
    assert.equal(installs(h).length, 2, `"${answer}" should dispatch`);
  }
  for (const answer of ["", "n", "no", "yy", "y es", "ok"]) {
    const h = harness({ answer });
    const res = await go(h);
    assert.deepEqual(installs(h), [], `"${answer}" must run nothing`);
    assert.deepEqual(h.pulled, []);
    assert.equal(res.confirmed, false);
    assert.equal(h.invalidated, 0);
    assert.match(h.out(), /nothing was run/);
    assert.ok(h.audits.length > 0 && h.audits.every((a) => a.decision === "declined"));
  }
});

test("no question when a y could not be acted on: plan mode, dry-run, below A5", async () => {
  for (const [o, why] of [
    [{ perm: "plan" }, "plan mode"],
    [{ dryRun: true }, "dry-run is on"],
    [{ level: 1 }, "this session is at A1, below A5"],
  ] as const) {
    const h = harness({ answer: "y", ...o });
    await go(h);
    assert.deepEqual(h.asked, [], JSON.stringify(o));
    assert.deepEqual(installs(h), []);
    assert.match(h.out(), /\$ brew upgrade --formula --yes ripgrep/, "the plan is still shown");
    // …but never under a heading that reads as an offer, and with no Ctrl-C footer
    assert.ok(h.out().includes(`ℹ Update everything — not offered (${why}); y would run`), why);
    assert.ok(!/y runs these|Ctrl-C stops the run/.test(h.out()), why);
    assert.match(h.out(), /run \/updates again/);
  }
  // A1 is the default level: the remedy is named
  const low = harness({ answer: "y", level: 1 });
  await go(low);
  assert.match(
    low.out(),
    /needs authorisation A5; this session is at A1\. Raise it with \/authorisation 5/,
  );
});

test("Ctrl-C that would arrive as a process signal (output not a terminal): no run is offered", async () => {
  const h = harness({ answer: "y", ctrlCIsAbort: false });
  await go(h);
  assert.deepEqual(h.asked, []);
  assert.deepEqual(installs(h), []);
  assert.match(
    h.out(),
    /output is not a terminal here, so Ctrl-C would stop a package manager mid-install/,
  );
});

test("every formula goes in ONE brew step — Ctrl-C cannot leave a library moved under its dependents", async () => {
  const r = report();
  const brew = r.managers?.[0];
  if (!brew) throw new Error("fixture");
  brew.packages = [
    ...brew.packages,
    { manager: "brew", name: "pcre2", kind: "formula", installed: "10.44", available: "10.45" },
  ];
  let previewAtAsk = "";
  const h = harness({
    answer: "y",
    onAsk: (hh) => {
      previewAtAsk = hh.out();
    },
    step: (argv) => {
      if (argv.includes("ripgrep")) h.ac.abort(); // Ctrl-C while brew works through the formulae
      return ok();
    },
  });
  const res = await go(h, r);
  assert.match(
    previewAtAsk,
    /\$ brew upgrade --formula --yes ripgrep pcre2\n {2}⎿ ripgrep[^\n]*\n {2}⎿ pcre2/,
  );
  assert.deepEqual(installs(h), ["brew upgrade --formula --yes ripgrep pcre2"]);
  assert.deepEqual(
    res.results.map((x) => [x.item.name, x.status]),
    [
      ["ripgrep", "updated"],
      ["pcre2", "updated"],
      ["codex", "not-started"],
      ["qwen3.6:latest", "not-started"],
    ],
  );
  // one audit pair for the one command that ran
  assert.deepEqual(
    h.audits.map((a) => [a.command, a.exitCode ?? null]),
    [
      ["brew upgrade --formula --yes ripgrep pcre2", null],
      ["brew upgrade --formula --yes ripgrep pcre2", 0],
    ],
  );
});

test("the runtime hold reaches the planner: with brew's node outdated, NO formula is installed", async () => {
  const r = report();
  const brew = r.managers?.[0];
  if (!brew) throw new Error("fixture");
  brew.packages = [
    {
      manager: "brew",
      name: "node",
      kind: "formula",
      installed: "26.10.0_1",
      available: "26.10.0_2",
    },
    ...brew.packages,
  ];
  // formulae facts present and benign: only the forwarded runtime can stop ripgrep from running
  const h = harness({ answer: "y", runtime: "node" });
  await go(h, r);
  assert.ok(!installs(h).some((c) => c.includes("--formula")), installs(h).join("\n"));
  assert.match(h.out(), /Prometheus is running on this node/);
  assert.match(h.out(), /node, which Prometheus is running on, is outdated too/);
});

test("switching to plan mode, or dropping below A5, mid-run starts nothing further", async () => {
  let perm: string | undefined;
  const plan = harness({
    answer: "y",
    step: () => {
      perm = "plan"; // Shift-Tab while the first step runs
      return ok();
    },
  });
  plan.dispatch.getPermMode = () => perm;
  const res = await go(plan);
  assert.deepEqual(
    res.results.map((x) => [x.item.name, x.status, x.detail ?? ""]),
    [
      ["ripgrep", "updated", ""],
      ["codex", "not-started", "plan mode was switched on"],
      ["qwen3.6:latest", "not-started", "plan mode was switched on"],
    ],
  );
  let level = 7;
  const lowered = harness({
    answer: "y",
    step: () => {
      level = 1;
      return ok();
    },
  });
  lowered.actions.getAuthLevel = () => level;
  const res2 = await go(lowered);
  assert.equal(res2.results.at(-1)?.detail, "the authorisation level dropped below A5");
});

test("a venv's pip that installs past another package's pin is reported FAILED, though it exits 0", async () => {
  const venvReport = report({
    managers: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    tools: [
      {
        id: "huggingface-cli",
        label: "HuggingFace CLI",
        role: "optional",
        installed: true,
        state: "single",
        source: "pypi:huggingface-hub",
        copies: [
          {
            pathEntry: `${HOME}/.local/bin/hf`,
            realPath: `${HOME}/.hf-cli/venv/bin/hf`,
            owner: "python-venv",
          },
        ],
        current: "1.25.1",
        latest: "2.1.1",
        updateAvailable: true,
        offer: [
          { via: "venv", command: `"${HOME}/.hf-cli/venv/bin/pip" install -U huggingface-hub` },
        ],
        withheld: [],
      },
    ],
  });
  const h = harness({
    answer: "y",
    step: () => ({
      ...ok(),
      stderr:
        "ERROR: pip's dependency resolver does not currently take into account all the packages that are installed. transformers 4.57 requires huggingface-hub<1.0, but you have huggingface-hub 2.1.1 which is incompatible.\n",
    }),
  });
  const res = await go(h, venvReport);
  assert.deepEqual(installs(h), [
    `${HOME}/.hf-cli/venv/bin/python -I -m pip install --upgrade huggingface-hub==2.1.1`,
  ]);
  assert.equal(res.results[0]?.status, "failed");
  assert.match(h.out(), /installed, but it conflicts with other packages/);
});

test("brew's own refusal before touching anything is not reported as a half-removed app", async () => {
  const h = harness({
    answer: "y",
    step: (argv) =>
      argv.includes("codex")
        ? fail(
            "Error: codex: The keyboard_layout artifact requires sudo, but HOMEBREW_NO_SUDO is set.\n",
          )
        : ok(),
  });
  await go(h);
  assert.match(
    h.out(),
    /needs your password, which Prometheus never asks for — nothing was changed/,
  );
  assert.ok(!/may be partly removed/.test(h.out()));
});

test("a surface that cannot cancel is not offered a run at all", async () => {
  const h = harness({ answer: "y" });
  const noSignal = { ...h.actions };
  // biome-ignore lint/performance/noDelete: an actions seam WITHOUT a signal, not one set to undefined.
  delete noSignal.signal;
  await offerAndDispatch(report(), {
    write: (l) => {
      h.lines.push(l);
    },
    actions: noSignal,
    dispatch: h.dispatch,
  });
  assert.deepEqual(h.asked, []);
  assert.deepEqual(installs(h), []);
  assert.match(h.out(), /cannot cancel a running update/);
});

test("nothing runnable: no question, and the user is told what is theirs to run", async () => {
  const h = harness({ answer: "y" });
  await go(
    h,
    report({
      managers: [],
      models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    }),
  );
  assert.deepEqual(h.asked, []);
  assert.match(h.out(), /Nothing here for Prometheus to run/);
  assert.match(h.out(), /opencode upgrade/);
});

test("a report the plan cannot use is refused without a question", async () => {
  const h = harness({ answer: "y" });
  await go(h, report({ partial: { packages: true } }));
  assert.deepEqual(h.asked, []);
  assert.match(h.out(), /Not offering to update: .*skipped the package managers/);
});

test("Ctrl-C before or during the question means no", async () => {
  const early = harness({ answer: "y" });
  early.ac.abort();
  await go(early);
  assert.deepEqual(early.asked, []);
  assert.deepEqual(installs(early), []);

  // readline can leave the question open after Ctrl-C; a "y" typed afterwards must not count
  const during = harness({ answer: "y", onAsk: (h) => h.ac.abort() });
  const res = await go(during);
  assert.equal(during.asked.length, 1);
  assert.equal(res.confirmed, false);
  assert.deepEqual(installs(during), []);
});

test("Ctrl-C mid-run lets the package step FINISH, says so, and starts nothing after it", async () => {
  const h = harness({
    answer: "y",
    step: (_argv, opts) => {
      h.ac.abort(); // the user presses Ctrl-C while brew is mid-upgrade
      assert.equal(opts.signal, undefined, "a package step is never handed the signal");
      return ok();
    },
  });
  const res = await go(h);
  assert.deepEqual(
    res.results.map((r) => [r.item.name, r.status]),
    [
      ["ripgrep", "updated"],
      ["codex", "not-started"],
      ["qwen3.6:latest", "not-started"],
    ],
  );
  assert.match(h.out(), /stopping after this step/);
  assert.deepEqual(h.pulled, []);
  assert.match(h.out(), /Done: 1 updated · 2 not started/);
});

test("a formula that did not finish is named — never a bare `brew upgrade`, which moves held ones", async () => {
  const h = harness({
    answer: "y",
    step: (argv) => (argv.includes("ripgrep") ? fail("Error: x\n") : ok()),
  });
  await go(h);
  // the command on a line of its own: no terminal width can wrap it right after `brew upgrade`
  assert.ok(h.lines.includes("ℹ Not finished — when you are ready, run:"));
  assert.ok(h.lines.includes("  $ brew upgrade --formula ripgrep"));
});

test("a model pull IS cancelled at once — it resumes later", async () => {
  const h = harness({
    answer: "y",
    pull: async (_tag, opts) => {
      assert.ok(opts?.signal, "the pull gets the signal");
      return { ok: false, error: "cancelled", aborted: true };
    },
  });
  const res = await go(h);
  assert.equal(res.results.at(-1)?.status, "cancelled");
  assert.match(h.out(), /resumes where this one stopped/);
});

test("failures are reported in words — never npm's log-file line — and the run moves on", async () => {
  const h = harness({
    answer: "y",
    step: (argv) =>
      argv.includes("ripgrep")
        ? fail("==> Upgrading ripgrep\nError: boom\n")
        : argv.includes("codex")
          ? fail("Error: codex: sudo is disabled by HOMEBREW_NO_SUDO.\n")
          : ok(),
  });
  const res = await go(h);
  assert.deepEqual(
    res.results.map((r) => r.status),
    ["failed", "failed", "updated"],
  );
  assert.match(h.out(), /✗ exit 1: Error: boom/);
  assert.match(h.out(), /needs your password, which Prometheus never asks for/);
  assert.match(h.out(), /Done: 1 updated · 2 failed/);

  const npm = harness({
    answer: "y",
    step: () =>
      fail(
        "npm error code EACCES\nnpm error syscall mkdir\nnpm error A complete log of this run can be found in: /x/_logs/debug-0.log\n",
        243,
      ),
  });
  await go(
    npm,
    report({
      managers: [
        {
          manager: "npm-global",
          label: "npm (global)",
          checkable: true,
          ok: true,
          packages: [
            {
              manager: "npm-global",
              name: "@google/gemini-cli",
              installed: "0.45.0",
              available: "0.46.0",
            },
          ],
        },
      ],
      // a KNOWN tool whose copy on PATH is this npm install: the proof an npm row needs to run
      tools: [
        {
          id: "gemini",
          label: "Gemini CLI",
          role: "agent",
          installed: true,
          state: "single",
          copies: [
            {
              pathEntry: `${HOME}/.npm-global/bin/gemini`,
              realPath: `${HOME}/.npm-global/lib/node_modules/@google/gemini-cli/bundle/gemini.js`,
              owner: "npm-global",
              name: "@google/gemini-cli",
            },
          ],
          current: "0.45.0",
          latest: "0.46.0",
          updateAvailable: true,
          offer: [],
          withheld: [],
        },
      ],
      models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    }),
  );
  assert.match(npm.out(), /permission denied — this install belongs to another user/);
  assert.ok(!/A complete log of this run/.test(npm.out().split("Done:")[1] ?? ""));
});

test("models: ollama not running stops the remaining pulls; the disk is measured again first", async () => {
  const down = harness({
    answer: "y",
    pull: async () => ({ ok: false, error: "fetch failed", aborted: false }),
  });
  const twoModels = report();
  const first = twoModels.models.upstream?.[0];
  if (!first?.ok) throw new Error("fixture");
  twoModels.models.upstream = [
    first,
    { ok: true, update: { ...first.update, model: "gemma4:12b", remoteBytes: 7.5e9 } },
  ];
  const res = await go(down, twoModels);
  assert.deepEqual(
    res.results.filter((r) => r.item.kind === "model").map((r) => r.status),
    ["failed", "not-started"],
  );
  assert.match(down.out(), /ollama is not running — start it, then \/updates pull qwen3\.6:latest/);

  // planned with 100 GB free, but the packages before it used the disk
  let calls = 0;
  const full = harness({ answer: "y", free: () => (calls++ === 0 ? 100e9 : 10e9) });
  const res2 = await go(full);
  assert.equal(res2.results.at(-1)?.status, "not-started");
  assert.match(full.out(), /not started — needs 27\.6 GB free, 10\.0 GB is/);
  assert.deepEqual(full.pulled, []);
});

test("a session that is closing starts nothing further", async () => {
  let n = 0;
  const h = harness({
    answer: "y",
    closed: () => n > 0,
    step: () => {
      n += 1;
      return ok();
    },
  });
  const res = await go(h);
  assert.deepEqual(
    res.results.map((r) => [r.item.name, r.status, r.detail ?? ""]),
    [
      ["ripgrep", "updated", ""],
      ["codex", "not-started", "the session is closing"],
      ["qwen3.6:latest", "not-started", "the session is closing"],
    ],
  );
});

test("the probes are asked only for what the rows need, and an unanswered one fails closed", async () => {
  const asked: string[] = [];
  const h = harness({
    answer: "y",
    probes: {
      casks: async (tokens) => {
        asked.push(`casks:${tokens.join(",")}`);
        return null; // brew could not answer
      },
      formulae: async (names) => {
        asked.push(`formulae:${names.join(",")}`);
        return new Map();
      },
      brewEnv: async () => {
        asked.push("brewEnv");
        return [];
      },
      npmGlobal: async () => {
        asked.push("npmGlobal");
        return null;
      },
    },
  });
  await go(h);
  assert.deepEqual(
    asked,
    ["casks:codex,flutter", "formulae:ripgrep", "brewEnv"],
    "no npm rows → npm not asked",
  );
  assert.deepEqual(installs(h), ["brew upgrade --formula --yes ripgrep"]);
  assert.match(h.out(), /brew upgrade --cask codex[\s\S]*could not describe it/);
});

test("every brew step runs without sudo, auto-update, cleanup or a greedy override — dependents stay on", async () => {
  const h = harness({ answer: "y" });
  await go(h);
  const env = h.ran.find((r) => r.argv.includes("ripgrep"))?.opts.env ?? {};
  assert.equal(env.SUDO_ASKPASS, undefined, "SUDO_ASKPASS makes brew run `sudo -A`");
  assert.equal(env.HOMEBREW_NO_SUDO, "1");
  assert.equal(env.HOMEBREW_NO_AUTO_UPDATE, "1");
  assert.equal(env.HOMEBREW_NO_INSTALL_CLEANUP, "1");
  assert.equal(
    env.HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK,
    undefined,
    "brew must upgrade and relink a formula's dependents together with it",
  );
  assert.equal(env.HOMEBREW_UPGRADE_GREEDY, undefined);
  assert.equal(
    env.HOMEBREW_CASK_OPTS,
    "--appdir=~/Applications",
    "the user's own brew settings stay",
  );
  assert.equal(env.TERM, "dumb");

  const forced = updateEnv("brew-formula", { HOMEBREW_FORCE_API_AUTO_UPDATE: "1" });
  assert.equal(
    forced.HOMEBREW_FORCE_API_AUTO_UPDATE,
    undefined,
    "it would override NO_AUTO_UPDATE",
  );
  const npm = updateEnv("npm-global", { SUDO_ASKPASS: "x", HOMEBREW_FORCE_API_AUTO_UPDATE: "1" });
  assert.equal(npm.SUDO_ASKPASS, undefined);
  assert.equal(npm.HOMEBREW_NO_SUDO, undefined, "brew switches only for brew steps");
});

test("child output is framed so the TUI never feeds it to the markdown renderer", async () => {
  const h = harness({
    answer: "y",
    step: (_argv, opts) => {
      opts.onLine?.("==> Pouring ripgrep--15.2.0.bottle.tar.gz");
      opts.onLine?.("# not a heading, *not* emphasis");
      return ok();
    },
  });
  await go(h);
  assert.ok(h.lines.includes("  ⎿ ==> Pouring ripgrep--15.2.0.bottle.tar.gz"));
  assert.ok(h.lines.includes("  ⎿ # not a heading, *not* emphasis"));
  // every line written from the preview on starts with a framing glyph or "$ "
  const from = h.lines.findIndex((l) => l.startsWith("ℹ Update everything"));
  assert.ok(from >= 0);
  for (const l of h.lines.slice(from)) assert.match(l.trimStart(), /^([●⎿ℹ▸]|\$ )/u, l);
});

test("runtimeBrewFormula reads the keg out of the real path of the running node", () => {
  assert.equal(
    runtimeBrewFormula(
      "/opt/homebrew/bin/node",
      () => "/opt/homebrew/Cellar/node/26.10.0_1/bin/node",
    ),
    "node",
  );
  assert.equal(
    runtimeBrewFormula("/x", () => "/opt/homebrew/Cellar/node@22/22.20.0/bin/node"),
    "node@22",
  );
  assert.equal(
    runtimeBrewFormula("/x", () => `${HOME}/.nvm/versions/node/v22/bin/node`),
    undefined,
  );
  assert.equal(
    runtimeBrewFormula("/x", () => {
      throw new Error("ENOENT");
    }),
    undefined,
  );
});
