/**
 * tmux-driver.test.ts — the RelayTmux impl over a FAKE tmux runner (no real tmux):
 * observe-classifies, deliver issues the footgun-safe send-keys, live/teardown argv.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type TmuxResult, type TmuxRun, makeTmuxRelay } from "./tmux-driver.js";

/** A scripted tmux runner: maps an argv-join substring → a result; records every call. */
function fakeRun(routes: { match: string; out?: string; status?: number }[]) {
  const calls: string[][] = [];
  const run: TmuxRun = (argv) => {
    calls.push(argv);
    const joined = argv.join(" ");
    for (const r of routes) {
      if (joined.includes(r.match))
        return { status: r.status ?? 0, stdout: r.out ?? "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" } as TmuxResult;
  };
  return { run, calls };
}

const deps = (run: TmuxRun) => ({
  session: "swarm",
  agents: ["lead", "api"],
  serviceOf: (a: string) => (a === "lead" ? "claude" : "codex"),
  run,
});

test("observe → classifies a pane from display-message + capture", () => {
  const f = fakeRun([
    { match: "pane_dead", out: "0|0" }, // not dead, not in copy mode
    { match: "capture-pane", out: "did the thing\n❯ " }, // claude ready marker
  ]);
  const r = makeTmuxRelay(deps(f.run));
  const obs = r.observe("lead");
  assert.equal(obs.state, "idle");
  assert.ok(obs.digest.length > 0);
});

test("observe → a missing window is dead", () => {
  const f = fakeRun([{ match: "pane_dead", status: 1 }]); // display-message fails
  const r = makeTmuxRelay(deps(f.run));
  assert.equal(r.observe("api").state, "dead");
});

test("observe → the pane_dead flag → dead", () => {
  const f = fakeRun([{ match: "pane_dead", out: "1|0" }]); // process exited
  assert.equal(makeTmuxRelay(deps(f.run)).observe("api").state, "dead");
});

test("observe → a busy spinner is busy", () => {
  const f = fakeRun([
    { match: "pane_dead", out: "0|0" },
    { match: "capture-pane", out: "Working… Generating" }, // codex busy
  ]);
  assert.equal(makeTmuxRelay(deps(f.run)).observe("api").state, "busy");
});

test("deliver → literal body then a SEPARATE Enter", () => {
  const f = fakeRun([]);
  makeTmuxRelay(deps(f.run)).deliver("api", "[from lead] build the endpoint");
  const sends = f.calls.filter((c) => c[0] === "send-keys");
  assert.equal(sends.length, 2);
  // first: -l -- <text>
  assert.deepEqual(sends[0], [
    "send-keys",
    "-t",
    "swarm:api",
    "-l",
    "--",
    "[from lead] build the endpoint",
  ]);
  // second: a genuine Enter (NOT folded into the literal)
  assert.deepEqual(sends[1], ["send-keys", "-t", "swarm:api", "Enter"]);
});

test("deliver → strips control bytes + collapses newlines (injection-safe)", () => {
  const f = fakeRun([]);
  makeTmuxRelay(deps(f.run)).deliver("api", "hi\x07\x1b[31m there\nline2");
  const literal = f.calls.find((c) => c.includes("-l"));
  assert.equal(literal?.at(-1), "hi[31m there line2"); // bell + ESC[ stripped, \n → space... ESC stripped leaves [31m
});

test("respawn CLI-075: a crashed pane is re-launched in place with respawn-pane -k", () => {
  const f = fakeRun([{ match: "pane_dead_status", out: "1|139" }]); // dead, non-zero exit (crash)
  const r = makeTmuxRelay({
    ...deps(f.run),
    relaunch: (a) => ["-e", `PROM_AGENT=${a}`, "claude"],
  });
  assert.equal(r.respawn?.("api"), true);
  const respawn = f.calls.find((c) => c[0] === "respawn-pane");
  assert.deepEqual(respawn, [
    "respawn-pane",
    "-k",
    "-t",
    "swarm:api",
    "-e",
    "PROM_AGENT=api",
    "claude",
  ]);
});

test("respawn CLI-075: a CLEAN exit (status 0) is not respawned — it's legitimate completion", () => {
  const f = fakeRun([{ match: "pane_dead_status", out: "1|0" }]); // dead, exit 0 = clean
  const r = makeTmuxRelay({ ...deps(f.run), relaunch: () => ["claude"] });
  assert.equal(r.respawn?.("api"), false);
  assert.ok(!f.calls.some((c) => c[0] === "respawn-pane"), "no respawn on a clean exit");
});

test("respawn CLI-075: no relaunch spec → cannot respawn (false, no tmux write)", () => {
  const f = fakeRun([{ match: "pane_dead_status", out: "1|1" }]);
  const r = makeTmuxRelay(deps(f.run)); // no relaunch
  assert.equal(r.respawn?.("api"), false);
  assert.ok(!f.calls.some((c) => c[0] === "respawn-pane"));
});

test("liveAgents → only windows that exist; teardown kills the session", () => {
  const f = fakeRun([{ match: "swarm:api #{pane_id}", status: 1 }]); // api window gone
  // pane_id probe: lead ok (status 0 default), api → status 1
  const run: TmuxRun = (argv) => {
    if (argv.join(" ").includes("swarm:api") && argv.includes("#{pane_id}"))
      return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout: "%1", stderr: "" };
  };
  const r = makeTmuxRelay({ ...deps(run), run });
  assert.deepEqual(r.liveAgents(), ["lead"]);
  r.teardown("complete");
});
