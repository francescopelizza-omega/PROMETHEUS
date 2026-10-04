/**
 * dispatch.test.ts — what a "y" to "update everything" may run, decided from the report alone.
 *
 * The first test walks the report this feature was built against (2026-10-02, home paths
 * neutralised): two outdated casks of which only one may run, an npm row that upgrades a copy PATH
 * never reaches, a vendor self-updater, a system git, a virtualenv CLI and two models that moved
 * upstream. Every other test pins one rule, and each rule is a way the obvious "run every printed
 * command" would have done damage.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Conflict } from "./conflicts.js";
import {
  type CaskFacts,
  type DispatchContext,
  type FormulaFacts,
  MODEL_DISK_FLOOR_BYTES,
  planUpdateDispatch,
} from "./dispatch.js";
import type { ModelCheck } from "./model-registry.js";
import type { ManagerReport, ToolUpdateStatus, UpdateReport } from "./report.js";
import { buildSelfUpdatePlan } from "./self-update.js";

const HOME = "/Users/u";

const VENV_OK = { pip: true, uvTool: false, project: false, requiredBy: [] };

/** formula → {deps, tap}, official unless said otherwise. */
function formulae(
  entries: Record<string, readonly string[] | { deps: readonly string[]; tap: string }>,
): Map<string, FormulaFacts> {
  return new Map(
    Object.entries(entries).map(([k, v]) => [
      k,
      Array.isArray(v) ? { deps: v, tap: "homebrew/core" } : (v as FormulaFacts),
    ]),
  );
}

const OFFICIAL: CaskFacts = {
  tap: "homebrew/cask",
  receipt: true,
  currentTap: "homebrew/cask",
  checksum: true,
  autoUpdates: false,
  needsRoot: false,
};

/** Every fact present and benign — each test overrides the one it is about. */
function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    platform: "darwin",
    freeDiskBytes: 100e9,
    modelStoreHas: () => true,
    formulae: new Map(),
    casks: new Map(),
    brewEnv: [],
    npmGlobal: { root: `${HOME}/.npm-global/lib/node_modules`, writable: true, linked: new Set() },
    inspectVenv: () => VENV_OK,
    ...over,
  };
}

function report(over: Partial<UpdateReport> = {}): UpdateReport {
  return {
    clis: [],
    models: { diff: { changed: [], added: [], removed: [] }, suggestions: [] },
    self: {
      prometheus: "0.1.0",
      updateAvailable: null,
      plan: buildSelfUpdatePlan({ method: "git", repoDir: `${HOME}/src/prometheus` }),
    },
    checkedAt: "2026-10-02T00:00:00.000Z",
    tools: [],
    managers: [],
    conflicts: [],
    ...over,
  };
}

function mgr(
  manager: ManagerReport["manager"],
  label: string,
  packages: ManagerReport["packages"],
): ManagerReport {
  return { manager, label, checkable: true, ok: true, packages };
}

function formula(name: string, installed = "1.0.0", available = "1.1.0") {
  return { manager: "brew" as const, name, kind: "formula" as const, installed, available };
}

function tool(over: Partial<ToolUpdateStatus> & Pick<ToolUpdateStatus, "id">): ToolUpdateStatus {
  return {
    label: over.id,
    role: "agent",
    installed: true,
    state: "single",
    copies: [],
    current: "1.0.0",
    latest: "2.0.0",
    updateAvailable: true,
    offer: [],
    withheld: [],
    ...over,
  };
}

function model(
  name: string,
  o: { local: number; remote: number; newer?: boolean; satisfiable?: boolean },
): ModelCheck {
  const [base, tag] = name.split(":");
  return {
    ok: true,
    update: {
      model: name,
      ref: {
        registry: "registry.ollama.ai",
        namespace: "library",
        name: base ?? name,
        tag: tag ?? "latest",
      },
      localDigest: "sha256:aaa",
      remoteDigest: "sha256:bbb",
      changed: true,
      localBytes: o.local,
      remoteBytes: o.remote,
      delta: {},
      satisfiable: o.satisfiable ?? true,
      ...(o.newer !== undefined ? { newer: o.newer } : {}),
      peakDiskBytes: o.local + o.remote,
    },
  };
}

const NPM_UNREACHABLE: Conflict = {
  kind: "unreachable-bin-dir",
  subject: "npm (global)",
  manager: "npm-global",
  summary: `npm (global) installs executables into ${HOME}/.local/share/npm/bin, which is not on your PATH.`,
  consequence: "…",
  severity: "high",
};

const HF_TOOL = tool({
  id: "huggingface-cli",
  label: "HuggingFace CLI",
  role: "optional",
  current: "1.25.1",
  latest: "2.1.1",
  source: "pypi:huggingface-hub",
  copies: [
    {
      pathEntry: `${HOME}/.local/bin/hf`,
      realPath: `${HOME}/.hf-cli/venv/bin/hf`,
      owner: "python-venv",
    },
  ],
  offer: [{ via: "venv", command: `"${HOME}/.hf-cli/venv/bin/pip" install -U huggingface-hub` }],
});

/** The report from the machine this was built on, home paths neutralised. */
function thisMachine(): UpdateReport {
  return report({
    managers: [
      mgr("brew", "Homebrew", [
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
      ]),
      mgr("npm-global", "npm (global)", [
        {
          manager: "npm-global",
          name: "@openai/codex",
          installed: "0.142.5",
          available: "0.160.0",
        },
      ]),
      mgr("pipx", "pipx", []),
    ],
    conflicts: [
      NPM_UNREACHABLE,
      {
        kind: "shadowed-upgrade",
        subject: "codex",
        summary: "npm-global offers an upgrade for the npm global copy of codex.",
        consequence: "…",
        avoid: "npm install -g @openai/codex@latest",
        severity: "medium",
      },
      {
        kind: "duplicate-install",
        subject: "claude",
        summary: "claude is installed 2 times",
        consequence: "…",
        severity: "low",
      },
    ],
    tools: [
      tool({
        id: "codex",
        label: "Codex CLI",
        current: "0.159.3",
        latest: "0.160.0",
        state: "duplicate",
        copies: [
          {
            pathEntry: "/opt/homebrew/bin/codex",
            realPath: "/opt/homebrew/Caskroom/codex/0.159.3/codex",
            owner: "brew-cask",
            name: "codex",
            version: "0.159.3",
          },
          {
            pathEntry: "/usr/local/bin/codex",
            realPath: `${HOME}/.local/share/npm/lib/node_modules/@openai/codex/bin/codex.js`,
            owner: "npm-global",
            name: "@openai/codex",
            version: "0.142.5",
          },
        ],
        offer: [{ via: "brew-cask", command: "brew upgrade --cask codex" }],
      }),
      tool({
        id: "opencode",
        label: "opencode",
        current: "1.18.4",
        latest: "1.18.34",
        copies: [
          {
            pathEntry: `${HOME}/.opencode/bin/opencode`,
            realPath: `${HOME}/.opencode/bin/opencode`,
            owner: "native-installer",
          },
        ],
        offer: [{ via: "script", command: "opencode upgrade" }],
      }),
      tool({
        id: "git",
        label: "git",
        role: "toolchain",
        current: "2.54.0",
        latest: "2.56.0",
        copies: [{ pathEntry: "/usr/bin/git", realPath: "/usr/bin/git", owner: "system" }],
      }),
      HF_TOOL,
      tool({ id: "claude", label: "Claude Code", updateAvailable: false }),
    ],
    models: {
      diff: { changed: [], added: [], removed: [] },
      suggestions: [],
      upstream: [
        model("qwen3.6:latest", { local: 23.94e9, remote: 22.6e9, newer: true }),
        model("gemma4:12b", { local: 7.56e9, remote: 7.5e9 }),
      ],
    },
  });
}

const THIS_MACHINE_CASKS = new Map<string, CaskFacts>([
  ["codex", OFFICIAL],
  ["flutter", { ...OFFICIAL, autoUpdates: true }],
]);

test("this machine: the vouched cask, the venv CLI and both models run; the rest is accounted for", () => {
  const plan = planUpdateDispatch(
    thisMachine(),
    ctx({ runtimeFormula: "node", casks: THIS_MACHINE_CASKS }),
  );
  assert.equal(plan.refusal, undefined);
  assert.deepEqual(
    plan.run.map((i) => [i.kind, i.name]),
    [
      ["brew-cask", "codex"],
      ["venv-pip", "huggingface-hub"],
      ["model", "qwen3.6:latest"],
      ["model", "gemma4:12b"],
    ],
  );
  // brew already spares the app hosting it; no flag that would leave apps swapped underneath
  assert.deepEqual(plan.run[0]?.argv, [
    "brew",
    "upgrade",
    "--cask",
    "--yes",
    "--require-sha",
    "codex",
  ]);
  // the venv's OWN interpreter, isolated (-I), pinned to the version the report showed
  assert.deepEqual(plan.run[1]?.argv, [
    `${HOME}/.hf-cli/venv/bin/python`,
    "-I",
    "-m",
    "pip",
    "install",
    "--upgrade",
    "huggingface-hub==2.1.1",
  ]);
  const manual = plan.manual.map((m) => `${m.command} :: ${m.why}`).join("\n");
  assert.match(manual, /brew upgrade --cask flutter :: updates itself/);
  assert.match(manual, /opencode upgrade :: its own updater/);
  const skipped = plan.skipped.map((s) => `${s.label} :: ${s.why}`).join("\n");
  assert.match(skipped, /@openai\/codex.*never runs — \/updates fix codex/);
  assert.match(skipped, /git.*no update command applies/);
  // Up-to-date tools contribute nothing at all, however many `update:` lines the report prints.
  assert.ok(!JSON.stringify(plan).includes("Claude Code"));
});

test("the tool row and the package row for one cask are ONE item", () => {
  const plan = planUpdateDispatch(
    thisMachine(),
    ctx({
      casks: new Map([
        ["codex", OFFICIAL],
        ["flutter", OFFICIAL],
      ]),
    }),
  );
  assert.equal(plan.run.filter((i) => i.name === "codex").length, 1);
  assert.ok(!plan.manual.some((m) => m.label.startsWith("Codex CLI")));
});

test("NEVER_RUN is checked on the canonical argv, before any flag is appended", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("brew", "Homebrew", [
          {
            manager: "brew",
            name: "ollama-app",
            kind: "cask",
            installed: "0.34.1",
            available: "0.35.0",
          },
        ]),
      ],
    }),
    ctx({ casks: new Map([["ollama-app", OFFICIAL]]) }),
  );
  assert.equal(plan.run.length, 0);
  assert.match(plan.skipped[0]?.why ?? "", /never run — installs a cask over/);
});

test("held: ollama and npm's own toolchain are the user's to run; the rest runs", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("brew", "Homebrew", [formula("ollama"), formula("ripgrep")]),
        mgr("npm-global", "npm (global)", [
          { manager: "npm-global", name: "npm", installed: "11.19.1", available: "11.20.0" },
        ]),
      ],
    }),
    ctx({ runtimeFormula: "node", formulae: formulae({ ollama: [], ripgrep: ["pcre2"] }) }),
  );
  assert.deepEqual(
    plan.run.map((i) => i.argv),
    [["brew", "upgrade", "--formula", "--yes", "ripgrep"]],
  );
  const why = Object.fromEntries(plan.manual.map((m) => [m.command, m.why]));
  assert.match(why["brew upgrade ollama"] ?? "", /server/);
  assert.match(why["npm install -g npm@latest"] ?? "", /ships with Node/);
});

test("while the node Prometheus runs on is outdated, NO formula runs", () => {
  /**
   * node is outdated when one of its soname-versioned libraries moved (Homebrew revision-bumps
   * them together). Upgrading that library — directly, or dragged by a sibling like node@22 that
   * shares it without depending on node — moves opt/<lib> away from the dylib node links.
   */
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("brew", "Homebrew", [
          formula("node", "26.10.0_1", "26.10.0_2"),
          formula("simdjson"),
          formula("node@22"),
          formula("ripgrep"),
        ]),
      ],
    }),
    ctx({
      runtimeFormula: "node",
      formulae: formulae({
        node: ["simdjson", "abseil"],
        "node@22": ["simdjson"],
        ripgrep: ["pcre2"],
      }),
    }),
  );
  assert.equal(plan.run.length, 0);
  const why = Object.fromEntries(plan.manual.map((m) => [m.label.split(" ")[0], m.why]));
  assert.match(why.node ?? "", /Prometheus is running on this node/);
  for (const f of ["simdjson", "node@22", "ripgrep"]) {
    assert.match(why[f] ?? "", /which Prometheus is running on, is outdated too/, f);
  }
  // a bare `brew upgrade` would also move the held ollama — no reason may advise one
  assert.ok(
    plan.manual.every((m) => !/\bbrew upgrade\b/.test(m.why)),
    plan.manual.map((m) => m.why).join("\n"),
  );
});

test("the formulae a y runs form a CLOSED set — brew moves dependencies and dependents too", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("brew", "Homebrew", [
          formula("ollama"), // held: never runs
          formula("ggml"), // ollama depends on it → brew would drag ollama along
          { ...formula("libngtcp2"), pinned: true }, // pinned: never runs
          formula("gemini-cli"), // depends on the pinned libngtcp2
          formula("cli-a"), // depends on gemini-cli → cascades
          formula("jq"), // a third-party tap's formula depends on it
          formula("ripgrep"), // unrelated: runs
          formula("pcre2"), // ripgrep's dependency, outdated, runs WITH it
        ]),
      ],
    }),
    ctx({
      formulae: formulae({
        ollama: ["ggml"],
        "gemini-cli": ["node", "libngtcp2"],
        "cli-a": ["gemini-cli"],
        "someone-tool": { deps: ["jq"], tap: "someone/tap" },
        ripgrep: ["pcre2"],
        pcre2: [],
      }),
    }),
  );
  assert.deepEqual(plan.run.map((i) => i.name).sort(), ["pcre2", "ripgrep"]);
  const why = Object.fromEntries(plan.manual.map((m) => [m.label.split(" ")[0], m.why]));
  assert.match(why.ggml ?? "", /ollama depends on it and is outdated but not run here/);
  assert.match(why["gemini-cli"] ?? "", /depends on libngtcp2, which is outdated but not run here/);
  assert.match(why["cli-a"] ?? "", /depends on gemini-cli/);
  assert.match(why.jq ?? "", /from the third-party tap someone\/tap/);

  // no dependency records at all: nothing proves an upgrade moves only what it names
  const blind = planUpdateDispatch(
    report({ managers: [mgr("brew", "Homebrew", [formula("ripgrep")])] }),
    { ...ctx(), formulae: null },
  );
  assert.equal(blind.run.length, 0);
  assert.match(blind.manual[0]?.why ?? "", /dependency records could not be read/);
});

test("the closure is a FIXPOINT — a dependent listed before what demotes it is caught on a later pass", () => {
  // brew lists rows alphabetically; a single pass would keep the earlier row and only then demote
  // the one it depends on, running a formula whose upgrade drags a held or pinned one along
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("brew", "Homebrew", [
          formula("aaa"), // depends on zzz
          formula("cli-a"), // depends on gemini-cli, listed FIRST
          formula("gemini-cli"), // depends on the pinned libngtcp2
          { ...formula("libngtcp2"), pinned: true },
          formula("ollama"), // held, depends on zzz
          formula("zzz"),
        ]),
      ],
    }),
    ctx({
      formulae: formulae({
        aaa: ["zzz"],
        "cli-a": ["gemini-cli"],
        "gemini-cli": ["libngtcp2"],
        ollama: ["zzz"],
        zzz: [],
      }),
    }),
  );
  assert.deepEqual(plan.run, []);
  const why = Object.fromEntries(plan.manual.map((m) => [m.label.split(" ")[0], m.why]));
  assert.match(why["cli-a"] ?? "", /depends on gemini-cli/);
  assert.match(why.aaa ?? "", /depends on zzz/);
  assert.match(why.zzz ?? "", /ollama depends on it/);
});

test("a formula installed from a file or URL is never official: what it links stays the user's", () => {
  const plan = planUpdateDispatch(
    report({ managers: [mgr("brew", "Homebrew", [formula("jq"), formula("ripgrep")])] }),
    ctx({
      formulae: formulae({
        "local-build": { deps: ["jq"], tap: "" },
        ripgrep: [],
      }),
    }),
  );
  assert.deepEqual(
    plan.run.map((i) => i.name),
    ["ripgrep"],
  );
  assert.match(plan.manual[0]?.why ?? "", /local-build, installed from a file or a URL, links it/);
});

test("brew.env: a setting that would undo the step's environment, or files that could not be read, run no brew item", () => {
  const r = report({
    managers: [
      mgr("brew", "Homebrew", [
        formula("ripgrep"),
        { manager: "brew", name: "codex", kind: "cask", installed: "1.0", available: "2.0" },
      ]),
      mgr("pipx", "pipx", [
        { manager: "pipx", name: "ruff", installed: "0.5.0", available: "0.6.0" },
      ]),
    ],
  });
  const facts = {
    formulae: formulae({ ripgrep: [] }),
    casks: new Map([["codex", OFFICIAL]]),
  };
  const set = planUpdateDispatch(
    r,
    ctx({ ...facts, brewEnv: ["~/.homebrew/brew.env: HOMEBREW_FORCE_API_AUTO_UPDATE"] }),
  );
  assert.deepEqual(
    set.run.map((i) => i.kind),
    ["pipx"],
    "only brew is affected",
  );
  assert.ok(
    set.manual.every((m) =>
      /HOMEBREW_FORCE_API_AUTO_UPDATE would change how brew runs/.test(m.why),
    ),
  );
  const unread = planUpdateDispatch(r, { ...ctx(facts), brewEnv: null });
  assert.deepEqual(
    unread.run.map((i) => i.kind),
    ["pipx"],
  );
  assert.match(unread.manual[0]?.why ?? "", /configuration files could not be checked/);
});

test("Prometheus itself is never upgraded from inside the running session", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("npm-global", "npm (global)", [
          {
            manager: "npm-global",
            name: "@prometheus/cli",
            installed: "0.1.0",
            available: "0.2.0",
          },
        ]),
        mgr("pipx", "pipx", [
          { manager: "pipx", name: "Prometheus", installed: "0.1.0", available: "0.2.0" },
        ]),
      ],
      self: {
        prometheus: "0.1.0",
        latest: "0.2.0",
        updateAvailable: true,
        plan: buildSelfUpdatePlan({ method: "npm-global" }),
      },
    }),
    ctx(),
  );
  assert.equal(plan.run.length, 0);
  assert.equal(plan.skipped.filter((s) => /Prometheus itself/.test(s.why)).length, 2);
  assert.ok(
    plan.manual.some((m) => /close it first/.test(m.why) && /npm install -g/.test(m.command)),
  );
});

test("nothing that needs root runs, and each root manager is ONE whole-system line", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("apt", "apt (Debian/Ubuntu)", [
          { manager: "apt", name: "curl", installed: "8.5.0", available: "8.5.1" },
          { manager: "apt", name: "git", installed: "2.43", available: "2.44" },
        ]),
        mgr("pacman", "pacman (Arch)", [
          { manager: "pacman", name: "git", installed: "2.54", available: "2.56" },
        ]),
      ],
    }),
    ctx({ platform: "linux" }),
  );
  assert.equal(plan.run.length, 0);
  assert.deepEqual(
    plan.manual.map((m) => [m.label, m.command]),
    [
      ["apt (Debian/Ubuntu): 2 packages", "sudo apt upgrade -y"],
      ["pacman (Arch): 1 package", "sudo pacman -Syu --noconfirm"],
    ],
  );
  assert.ok(plan.manual.every((m) => /root/.test(m.why)));
});

test("pinned rows and third-party tap formulae are not run", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("brew", "Homebrew", [{ ...formula("jq"), pinned: true }, formula("someone/tap/tool")]),
      ],
    }),
    ctx(),
  );
  assert.equal(plan.run.length, 0);
  assert.match(plan.skipped[0]?.why ?? "", /pinned/);
  assert.match(plan.manual[0]?.why ?? "", /third-party tap/);
});

test("casks run only from the official tap, with a checksum, no self-updates and no root", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].map((n) => ({
    manager: "brew" as const,
    name: n,
    kind: "cask" as const,
    installed: "1.0",
    available: "2.0",
  }));
  const plan = planUpdateDispatch(
    report({ managers: [mgr("brew", "Homebrew", rows)] }),
    ctx({
      casks: new Map<string, CaskFacts>([
        ["a", OFFICIAL],
        ["b", { ...OFFICIAL, tap: "someone/tap" }],
        ["c", { ...OFFICIAL, checksum: false }],
        ["d", { ...OFFICIAL, autoUpdates: true }],
        ["e", { ...OFFICIAL, needsRoot: true }],
        // f: brew said nothing about it
        ["g", { ...OFFICIAL, receipt: false }],
        ["h", { ...OFFICIAL, tap: "" }],
        // installed before Homebrew emptied its font tap into homebrew/cask: official today
        ["i", { ...OFFICIAL, tap: "homebrew/cask-fonts" }],
        // the same receipt, but brew no longer resolves the token to homebrew/cask
        ["j", { ...OFFICIAL, tap: "homebrew/cask-fonts", currentTap: "someone/fonts" }],
        ["k", { ...OFFICIAL, disabled: true }],
      ]),
    }),
  );
  assert.deepEqual(
    plan.run.map((i) => i.name),
    ["a", "i"],
  );
  const why = Object.fromEntries(plan.manual.map((m) => [m.label.split(" ")[0], m.why]));
  assert.match(why.b ?? "", /third-party tap someone\/tap/);
  assert.match(why.c ?? "", /no checksum/);
  assert.match(why.d ?? "", /updates itself/);
  assert.match(why.e ?? "", /needs your password/);
  assert.match(why.f ?? "", /could not describe it/);
  assert.match(why.g ?? "", /no readable install receipt/);
  assert.match(why.h ?? "", /installed from a file or a URL/);
  assert.match(why.j ?? "", /third-party tap homebrew\/cask-fonts/);
  assert.match(why.k ?? "", /disabled upstream/);

  const noProbe = planUpdateDispatch(report({ managers: [mgr("brew", "Homebrew", rows)] }), {
    ...ctx(),
    casks: null,
  });
  assert.equal(noProbe.run.length, 0, "an unanswered probe runs no cask at all");
});

test("npm: strictly newer, pinned, writable, never a linked checkout, never an unreachable prefix", () => {
  const rows: ManagerReport["packages"] = [
    { manager: "npm-global", name: "@google/gemini-cli", installed: "0.45.0", available: "0.46.0" },
    // installed from a `next` tag AHEAD of latest: npm still lists it
    { manager: "npm-global", name: "typescript", installed: "6.1.0-dev.1", available: "6.0.2" },
    { manager: "npm-global", name: "my-fork", installed: "1.0.0", available: "1.1.0" },
  ];
  const geminiTool = tool({
    id: "gemini",
    label: "Gemini CLI",
    copies: [
      {
        pathEntry: "/x/bin/gemini",
        realPath: "/x/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
        owner: "npm-global",
        name: "@google/gemini-cli",
      },
    ],
  });
  const r = report({
    managers: [
      mgr("npm-global", "npm (global)", [
        ...rows,
        // newer, unlinked — but nothing says it came from the registry
        { manager: "npm-global", name: "some-cli", installed: "1.0.0", available: "1.1.0" },
      ]),
    ],
    tools: [geminiTool],
  });
  const linked = ctx({
    npmGlobal: { root: "/x/lib/node_modules", writable: true, linked: new Set(["my-fork"]) },
  });
  const ok = planUpdateDispatch(r, linked);
  assert.deepEqual(
    ok.run.map((i) => i.argv),
    [["npm", "install", "-g", "@google/gemini-cli@0.46.0"]],
  );
  const skipped = Object.fromEntries(ok.skipped.map((s) => [s.label.split(" ")[0], s.why]));
  assert.match(skipped.typescript ?? "", /not a newer version/);
  assert.match(skipped["my-fork"] ?? "", /npm link/);
  assert.match(
    ok.manual.find((m) => m.label.startsWith("some-cli"))?.why ?? "",
    /nothing proves it was installed from the npm registry/,
  );
  // a copy the gemini tool owns, under npm's root — but published as ANOTHER package than the one
  // the registry table knows for it: a fork, which the same-named registry package would replace
  const fork = planUpdateDispatch(
    report({
      managers: [
        mgr("npm-global", "npm (global)", [
          {
            manager: "npm-global",
            name: "@someone/gemini-fork",
            installed: "1.0.0",
            available: "1.1.0",
          },
        ]),
      ],
      tools: [
        tool({
          id: "gemini",
          label: "Gemini CLI",
          copies: [
            {
              pathEntry: "/x/bin/gemini",
              realPath: "/x/lib/node_modules/@someone/gemini-fork/bundle/gemini.js",
              owner: "npm-global",
              name: "@someone/gemini-fork",
            },
          ],
        }),
      ],
    }),
    linked,
  );
  assert.equal(fork.run.length, 0);
  assert.match(
    fork.manual[0]?.why ?? "",
    /not a package Prometheus knows to come from the npm registry/,
  );

  // the same package, but the copy on PATH lives in ANOTHER prefix: upgrading here would not
  // touch it
  const otherPrefix = planUpdateDispatch(
    r,
    ctx({ npmGlobal: { root: "/y/lib/node_modules", writable: true, linked: new Set() } }),
  );
  assert.ok(!otherPrefix.run.some((i) => i.name === "@google/gemini-cli"));

  const rootOwned = planUpdateDispatch(
    r,
    ctx({ npmGlobal: { root: "/usr/lib/node_modules", writable: false, linked: new Set() } }),
  );
  assert.equal(rootOwned.run.length, 0);
  assert.match(rootOwned.manual[0]?.why ?? "", /not writable by you/);

  const unknown = planUpdateDispatch(r, { ...ctx(), npmGlobal: null });
  assert.match(unknown.manual[0]?.why ?? "", /could not be located/);

  // the unreachable-prefix check comes BEFORE the npm/corepack hold
  const unreachable = planUpdateDispatch(
    report({
      managers: [
        mgr("npm-global", "npm (global)", [
          { manager: "npm-global", name: "npm", installed: "11.0.0", available: "11.1.0" },
          ...rows,
        ]),
      ],
      conflicts: [NPM_UNREACHABLE],
    }),
    ctx(),
  );
  assert.equal(unreachable.run.length, 0);
  assert.equal(unreachable.manual.length, 0);
  assert.ok(
    unreachable.skipped.every((s) =>
      /no shell searches — \/updates fix npm \(global\)/.test(s.why),
    ),
  );
});

test("pipx: the venv for a --suffix install; a non-semver version is pip's call, not a skip", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("pipx", "pipx", [
          {
            manager: "pipx",
            name: "black",
            environment: "black24",
            installed: "24.1.0",
            available: "25.1.0",
          },
          { manager: "pipx", name: "ruff", installed: "3.31", available: "3.32" },
          { manager: "pipx", name: "old", installed: "1.2.0", available: "1.1.0" },
        ]),
      ],
    }),
    ctx(),
  );
  assert.deepEqual(
    plan.run.map((i) => i.argv),
    [
      ["pipx", "upgrade", "black24"],
      ["pipx", "upgrade", "ruff"],
    ],
  );
  assert.match(plan.skipped[0]?.why ?? "", /not a newer version/);
});

test("a virtualenv runs its own pip only when it has one — a uv tool env is uv's", () => {
  const r = report({ tools: [HF_TOOL] });
  assert.equal(planUpdateDispatch(r, ctx()).run[0]?.kind, "venv-pip");

  const uv = planUpdateDispatch(
    r,
    ctx({ inspectVenv: () => ({ ...VENV_OK, pip: false, uvTool: true }) }),
  );
  assert.equal(uv.run.length, 0);
  assert.equal(uv.manual[0]?.command, "uv tool upgrade huggingface-hub");

  const noPip = planUpdateDispatch(r, ctx({ inspectVenv: () => ({ ...VENV_OK, pip: false }) }));
  assert.match(noPip.manual[0]?.why ?? "", /no pip of its own/);

  // a PROJECT's environment, or one where other packages pin it, is not the tool's to change
  const project = planUpdateDispatch(
    r,
    ctx({ inspectVenv: () => ({ ...VENV_OK, project: true }) }),
  );
  assert.match(project.manual[0]?.why ?? "", /a project's virtualenv/);
  const pinned = planUpdateDispatch(
    r,
    ctx({ inspectVenv: () => ({ ...VENV_OK, requiredBy: ["transformers"] }) }),
  );
  assert.match(
    pinned.manual[0]?.why ?? "",
    /other packages in this virtualenv depend on huggingface-hub \(transformers\)/,
  );

  const blind = ctx();
  // biome-ignore lint/performance/noDelete: a context WITHOUT the probe, not one set to undefined.
  delete blind.inspectVenv;
  assert.match(planUpdateDispatch(r, blind).manual[0]?.why ?? "", /could not be inspected/);
});

test("a row for a copy whose tool has a shadowed-newer or skew conflict is not run", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [mgr("brew", "Homebrew", [formula("uv", "0.8.0", "0.9.0")])],
      tools: [
        tool({
          id: "uv",
          copies: [
            {
              pathEntry: "/opt/homebrew/bin/uv",
              realPath: "/opt/homebrew/Cellar/uv/0.8.0/bin/uv",
              owner: "brew-formula",
              name: "uv",
            },
          ],
        }),
      ],
      conflicts: [
        {
          kind: "shadowed-newer",
          subject: "uv",
          summary: "uv 0.9.1 is installed (vendor installer) but PATH resolves to 0.8.0.",
          consequence: "…",
          severity: "high",
        },
      ],
    }),
    ctx(),
  );
  assert.equal(plan.run.length, 0);
  assert.match(plan.skipped[0]?.why ?? "", /0\.9\.1 is installed/);
});

test("a managed copy its manager did not list is reported, not guessed at", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [mgr("brew", "Homebrew", [])],
      tools: [
        tool({
          id: "codex",
          label: "Codex CLI",
          copies: [
            {
              pathEntry: "/opt/homebrew/bin/codex",
              realPath: "/opt/homebrew/Caskroom/codex/1.0.0/codex",
              owner: "brew-cask",
              name: "codex",
            },
          ],
          offer: [{ via: "brew-cask", command: "brew upgrade --cask codex" }],
        }),
      ],
    }),
    ctx(),
  );
  assert.equal(plan.run.length, 0);
  assert.match(plan.skipped[0]?.why ?? "", /Homebrew offers no upgrade for it yet/);
});

test("models: the store must be proven, free space known, the floor kept, and a pull's real cost budgeted", () => {
  const r = report({
    models: {
      diff: { changed: [], added: [], removed: [] },
      suggestions: [],
      upstream: [
        model("a:latest", { local: 20e9, remote: 22e9 }),
        model("b:latest", { local: 8e9, remote: 9e9 }),
        model("c:latest", { local: 1e9, remote: 1e9, newer: false }),
        model("d:latest", { local: 1e9, remote: 1e9, satisfiable: false }),
      ],
    },
  });
  const noFree = ctx();
  // biome-ignore lint/performance/noDelete: a context WITHOUT the measurement, not undefined.
  delete noFree.freeDiskBytes;
  const unknown = planUpdateDispatch(r, noFree);
  assert.equal(unknown.run.length, 0);
  assert.ok(unknown.skipped.some((s) => /could not be measured/.test(s.why)));

  // Ollama.app can keep its models on another volume: a store that does not hold the tag
  // proves nothing about the disk the daemon writes to
  const elsewhere = planUpdateDispatch(r, ctx({ modelStoreHas: () => false }));
  assert.equal(elsewhere.run.length, 0);
  assert.ok(elsewhere.skipped.some((s) => /does not hold it/.test(s.why)));

  // a adds at most 22 GB (+ floor); afterwards the volume has lost 2 GB for good; b adds 9 GB
  const free = 22e9 + MODEL_DISK_FLOOR_BYTES + 0.5e9;
  const fits = planUpdateDispatch(r, ctx({ freeDiskBytes: free }));
  assert.deepEqual(
    fits.run.map((i) => i.name),
    ["a:latest", "b:latest"],
  );
  // an OLDER build upstream is a rollback: offered as a command, never run
  assert.ok(fits.manual.some((m) => m.command === "/updates pull c:latest"));
  assert.ok(fits.skipped.some((s) => /d:latest/.test(s.label) && /needs ollama/.test(s.why)));

  const tight = planUpdateDispatch(r, ctx({ freeDiskBytes: 20e9 }));
  assert.deepEqual(
    tight.run.map((i) => i.name),
    ["b:latest"],
  );
  assert.ok(tight.skipped.some((s) => /a:latest/.test(s.label) && /headroom/.test(s.why)));

  // the LASTING cost of an accepted pull is budgeted: after x, 11 GB would be left, and y needs 14
  const pair = report({
    models: {
      diff: { changed: [], added: [], removed: [] },
      suggestions: [],
      upstream: [
        model("x:latest", { local: 1e9, remote: 20e9 }),
        model("y:latest", { local: 1e9, remote: 9e9 }),
      ],
    },
  });
  const budgeted = planUpdateDispatch(pair, ctx({ freeDiskBytes: 30e9 }));
  assert.deepEqual(
    budgeted.run.map((i) => i.name),
    ["x:latest"],
  );
  // a projection is never printed as what is free now
  assert.match(
    budgeted.skipped[0]?.why ?? "",
    /11\.0 GB would be left after the pulls above \(30\.0 GB is free now\)/,
  );
  // a disk that WAS measured and is full is not "could not be measured"
  const full = planUpdateDispatch(pair, ctx({ freeDiskBytes: 0 }));
  assert.equal(full.run.length, 0);
  assert.ok(full.skipped.every((s) => /the disk is full/.test(s.why)));
});

test("reports the plan cannot be built from are refused, not half-run", () => {
  assert.match(
    planUpdateDispatch(report({ partial: { packages: true } }), ctx()).refusal ?? "",
    /skipped the package managers/,
  );
  const noTools = report();
  // biome-ignore lint/performance/noDelete: the point is a report WITHOUT the field, not undefined.
  delete noTools.tools;
  assert.match(
    planUpdateDispatch(noTools, ctx()).refusal ?? "",
    /predates the install-conflict check/,
  );
});

test("Windows: package steps become commands to run by hand; models still run", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        mgr("pipx", "pipx", [
          { manager: "pipx", name: "ruff", installed: "0.5.0", available: "0.6.0" },
        ]),
      ],
      models: {
        diff: { changed: [], added: [], removed: [] },
        suggestions: [],
        upstream: [model("a:latest", { local: 1e9, remote: 1e9 })],
      },
    }),
    ctx({ platform: "win32" }),
  );
  assert.deepEqual(
    plan.run.map((i) => i.kind),
    ["model"],
  );
  assert.equal(plan.manual[0]?.command, "pipx upgrade ruff");
});

test("a manager that could not be asked is named, so silence is never read as 'nothing to do'", () => {
  const plan = planUpdateDispatch(
    report({
      managers: [
        {
          manager: "brew",
          label: "Homebrew",
          checkable: true,
          ok: false,
          packages: [],
          note: "timed out",
        },
      ],
    }),
    ctx(),
  );
  assert.deepEqual(plan.skipped, [{ label: "Homebrew", why: "check failed — timed out" }]);
});
