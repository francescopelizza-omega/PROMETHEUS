/**
 * demos-cmd.test.ts — topology persistence + the /demos run flow end-to-end (real
 * Coordinator, fake backends, temp home). No real CLI/model touched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import { type DemosDeps, loadTopology, runDemos, saveTopology } from "./demos-cmd.js";

const fakeEngine = (): EngineClient =>
  ({ runPrometheus: async () => ({ ok: true, response: "x" }) }) as unknown as EngineClient;

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "prom-demos-"));
}

function deps(home: string, lines: string[]): DemosDeps {
  return {
    client: fakeEngine(),
    home,
    caps: "none",
    write: (l) => lines.push(l),
    ask: async () => "",
    confirm: async () => true,
    localModels: async () => [],
    now: () => new Date("2026-06-24T00:00:00Z"),
  };
}

test("saveTopology → loadTopology round-trips", () => {
  const home = tmpHome();
  try {
    const t = orch.normalizeTopology({
      orchestrator: "lead",
      agents: [
        { name: "lead", backend: { kind: "fake" }, role: "orchestrate", children: ["w"] },
        { name: "w", backend: { kind: "fake" }, role: "work" },
      ],
    });
    saveTopology(home, t);
    const back = loadTopology(home);
    assert.equal(back?.orchestrator, "lead");
    assert.equal(back?.agents.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos <goal> runs the saved swarm + persists the bus", async () => {
  const home = tmpHome();
  try {
    saveTopology(
      home,
      orch.normalizeTopology({
        orchestrator: "demo",
        agents: [{ name: "demo", backend: { kind: "fake" }, role: "orchestrate" }],
      }),
    );
    const lines: string[] = [];
    // --headless = the in-process Coordinator path (bare `/demos <goal>` now uses tmux).
    await runDemos("--headless build a small parser", deps(home, lines));
    const out = lines.join("\n");
    assert.match(out, /\/demos swarm/); // the header rendered
    assert.match(out, /Participants:/); // CLI-074: the live participant board summary
    assert.match(out, /swarm done/); // the summary rendered
    // the bus was persisted as JSONL
    const runs = readdirSync(join(home, "orchestration", "runs"));
    assert.ok(runs.some((f) => f.endsWith(".jsonl")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos status shows the roster; /demos reset deletes it", async () => {
  const home = tmpHome();
  try {
    saveTopology(
      home,
      orch.normalizeTopology({
        orchestrator: "lead",
        agents: [
          { name: "lead", backend: { kind: "cli", service: "claude" }, role: "orchestrate" },
        ],
      }),
    );
    const lines: string[] = [];
    await runDemos("status", deps(home, lines));
    assert.match(lines.join("\n"), /orchestrator: lead/);

    await runDemos("reset", deps(home, lines));
    assert.equal(existsSync(join(home, "orchestration", "topology.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos with no saved swarm runs setup (auto-accepts the proposal)", async () => {
  const home = tmpHome();
  try {
    const lines: string[] = [];
    // confirm:true accepts the proposed topology (all-fake since nothing is detected here)
    await runDemos("", deps(home, lines));
    // a topology was saved
    assert.equal(existsSync(join(home, "orchestration", "topology.json")), true);
    assert.match(lines.join("\n"), /swarm saved|swarm ready/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── CLI-071: /demos recipes + preflight ──────────────────────────────────────────
test("/demos recipes lists every service + requirements (text) (CLI-071)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    await runDemos("recipes", deps(home, lines));
    const out = lines.join("\n");
    assert.match(out, /Recipes \(backend requirements\)/);
    assert.match(out, /claude/);
    assert.match(out, /cursor/);
    assert.match(out, /auth:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos recipes --json emits a jq-parseable array to stdout, no ANSI (CLI-071)", async () => {
  const home = tmpHome();
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => {
    captured.push(String(s));
    return true;
  };
  try {
    await runDemos("recipes --json", deps(home, []));
  } finally {
    (process.stdout as { write: unknown }).write = orig;
    rmSync(home, { recursive: true, force: true });
  }
  const joined = captured.join("");
  assert.ok(!/\x1b\[/.test(joined), "no ANSI in the json output");
  const parsed = JSON.parse(joined.trim());
  assert.ok(Array.isArray(parsed));
  const names = parsed.map((r: { name: string }) => r.name);
  for (const svc of [
    "claude",
    "codex",
    "gemini",
    "cursor",
    "aider",
    "opencode",
    "hermes",
    "cline",
    "kilocode",
  ]) {
    assert.ok(names.includes(svc), `json must list ${svc}`);
  }
  assert.equal(typeof parsed[0].bin, "string");
});

test("preflight BLOCKS a spawn when a cli backend is missing (remedy, not launch) (CLI-071)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    // a cli agent whose binary is absent in this environment (claude not installed in CI).
    saveTopology(
      home,
      orch.normalizeTopology({
        orchestrator: "c",
        agents: [{ name: "c", backend: { kind: "cli", service: "claude" }, role: "orchestrate" }],
      }),
    );
    // inject a detector so the test is fast + deterministic (no real CLI spawns): claude absent.
    const d = {
      ...deps(home, lines),
      detect: async () => [
        { service: "claude", bin: "claude", installed: false, authed: false, note: "" },
      ],
    };
    await runDemos("--headless build a parser", d);
    const out = lines.join("\n");
    assert.match(out, /Preflight/);
    assert.match(out, /claude/);
    assert.match(out, /remedy:/); // named remedy, not a launch
    assert.ok(!/swarm done/.test(out), "must NOT have spawned the swarm");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── CLI-074: /demos status --watch (live participant board) ────────────────────────
test("/demos status --watch folds injected liveness snapshots + prints a final board (CLI-074)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    saveTopology(
      home,
      orch.normalizeTopology({
        orchestrator: "lead",
        agents: [
          {
            name: "lead",
            backend: { kind: "cli", service: "claude" },
            role: "orchestrate",
            children: ["api"],
          },
          { name: "api", backend: { kind: "cli", service: "codex" }, role: "work" },
        ],
      }),
    );
    let n = 0;
    const d: DemosDeps = {
      ...deps(home, lines),
      watch: {
        maxTicks: 3,
        intervalMs: 0,
        poll: async () => {
          n++;
          if (n === 1) return { live: ["lead", "api"], roster: ["lead", "api"] };
          return { live: ["lead"], roster: ["lead", "api"] }; // api's pane died
        },
      },
    };
    await runDemos("status --watch", d);
    const out = lines.join("\n");
    assert.match(out, /Live swarm participants/);
    assert.match(out, /final participant board/);
    assert.match(out, /api.*dead/); // the board caught the dead pane during watch
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos status --watch with no live run falls back to the static board (CLI-074)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    saveTopology(
      home,
      orch.normalizeTopology({
        orchestrator: "lead",
        agents: [
          { name: "lead", backend: { kind: "cli", service: "claude" }, role: "orchestrate" },
        ],
      }),
    );
    const d: DemosDeps = { ...deps(home, lines), watch: { poll: async () => null } };
    await runDemos("status --watch", d);
    const out = lines.join("\n");
    assert.match(out, /No run in progress/);
    assert.match(out, /lead.*idle/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── CLI-073: /demos replay ────────────────────────────────────────────────────────
const RUN_JSONL = [
  JSON.stringify({
    id: "m0",
    from: "lead",
    to: "api",
    kind: "task",
    content: "build the parser",
    ts: 1000,
  }),
  JSON.stringify({
    id: "m1",
    from: "api",
    to: "lead",
    kind: "result",
    content: "parser done",
    ts: 1200,
  }),
].join("\n");

/** Write a headless-layout run log (runs/run-<id>.jsonl). */
function writeRun(home: string, id: string, jsonl: string): void {
  const dir = join(home, "orchestration", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `run-${id}.jsonl`), jsonl);
}

test("/demos replay <id> re-renders a saved run through the projector (CLI-073)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    writeRun(home, "abc", RUN_JSONL);
    await runDemos("replay abc", deps(home, lines));
    const out = lines.join("\n");
    assert.match(out, /replaying abc — 2 messages/);
    assert.match(out, /build the parser/);
    assert.match(out, /parser done/);
    assert.match(out, /lead/); // the from→to arrow rendered
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos replay reads an explicit file path as-is (CLI-073)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    const dir = join(home, "orchestration", "runs");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "run-xyz.jsonl");
    writeFileSync(p, RUN_JSONL);
    await runDemos(`replay ${p}`, deps(home, lines));
    assert.match(lines.join("\n"), /parser done/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos replay resolves the tmux layout (run-<id>/bus.jsonl) for a bare id (CLI-073)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    const dir = join(home, "orchestration", "run-t7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bus.jsonl"), RUN_JSONL);
    await runDemos("replay t7", deps(home, lines));
    assert.match(lines.join("\n"), /parser done/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos replay fails CLOSED on a truncated run log, naming the bad line (CLI-073)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    // a crash mid-write leaves the last line an incomplete object (line 3).
    writeRun(home, "bad", `${RUN_JSONL}\n{"id":"m2","from":"api","kind":"res`);
    await runDemos("replay bad", deps(home, lines));
    const out = lines.join("\n");
    assert.match(out, /Replay aborted/);
    assert.match(out, /line 3/);
    assert.ok(!/replaying/.test(out), "no partial replay was presented as complete");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/demos replay --json emits the full message array to stdout, no ANSI (CLI-073)", async () => {
  const home = tmpHome();
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => {
    captured.push(String(s));
    return true;
  };
  try {
    writeRun(home, "j1", RUN_JSONL);
    await runDemos("replay j1 --json", deps(home, []));
  } finally {
    (process.stdout as { write: unknown }).write = orig;
    rmSync(home, { recursive: true, force: true });
  }
  const joined = captured.join("");
  assert.ok(!/\x1b\[/.test(joined), "no ANSI in the json output");
  const parsed = JSON.parse(joined.trim());
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].content, "build the parser");
  assert.equal(parsed[1].kind, "result");
});

test("/demos replay errors clearly when no run log matches the id (CLI-073)", async () => {
  const home = tmpHome();
  const lines: string[] = [];
  try {
    await runDemos("replay nope", deps(home, lines));
    assert.match(lines.join("\n"), /no run log for id "nope"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
