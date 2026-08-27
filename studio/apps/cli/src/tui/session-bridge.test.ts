/**
 * session-bridge.test.ts — createSessionBridge over injected deps (no real TTY/engine/model).
 *
 * `session-bridge.ts` (the Ink TUI's backend) had no dedicated test file before this one — every
 * other host-facing surface (`slash-registry.ts`'s command table) has its own. This exercises
 * `/cd` + `/context window` through THIS host's real `changeProjectDirectory`/`contextWindowTokens`
 * wiring — `host.test.ts` exercises the SAME two features through the readline host's OWN,
 * separately-implemented `changeProjectDirectory` (a deliberately parallel function, not shared
 * code), since the two hosts are siblings that must behave identically but do not share this logic.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import { type BridgeDeps, createSessionBridge } from "./session-bridge.js";

setColorEnabled(false);

const TMP_HOME = mkdtempSync(join(tmpdir(), "prom-bridge-home-"));

function args(over: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: [],
    positionals: [],
    json: false,
    noColor: true,
    help: false,
    version: false,
    repl: true,
    dryRun: false,
    yes: false,
    strict: false,
    force: false,
    noGate: false,
    verbose: false,
    quiet: false,
    flags: {},
    cwd: "/tmp/session-bridge-cwd",
    ...over,
  };
}

async function makeBridge(over: Partial<BridgeDeps> = {}, write: (s: string) => void = () => {}) {
  const deps: BridgeDeps = {
    parsed: args(),
    write,
    confirm: async () => false,
    confirmPhrase: async () => false,
    ask: async () => "",
    askPath: async (_p, def) => def,
    quit: () => {},
    backends: { liveRunners: [], paidClis: [] },
    home: TMP_HOME,
    configHome: TMP_HOME,
    ...over,
  };
  const bridge = await createSessionBridge(deps);
  return bridge;
}

/**
 * Regression: user-defined command files (project/user `.prometheus/command/*.md`) were wired
 * into the readline host's slash dispatch (host.ts) but had ZERO presence in the TUI's own
 * `submit()` — a custom command that worked under --plain/--tmux silently did not exist on the
 * default raw-mode TUI surface. Same shape of gap as /background before it was fixed.
 */
test("a user-defined command file (.prometheus/command/*.md) now works on the default TUI surface too", async () => {
  const base = mkdtempSync(join(tmpdir(), "prom-bridge-cmdfile-"));
  mkdirSync(join(base, ".prometheus", "command"), { recursive: true });
  writeFileSync(
    join(base, ".prometheus", "command", "zzcustom.md"),
    "Please zzcustom-echo: $ARGUMENTS",
  );
  const out: string[] = [];
  const bridge = await makeBridge({ parsed: args({ cwd: base }) }, (s) => out.push(s));

  await bridge.submit("/zzcustom something suspicious");

  assert.doesNotMatch(out.join("\n"), /unknown command/i);
  await bridge.dispose();
});

test("/background: the default TUI surface actually wires startBackground now (used to always fail)", async () => {
  // Regression: this host's SlashCtx had no `startBackground` at all, so /background, /bg, and
  // /detach unconditionally printed "this surface cannot run a detached agent" for every task,
  // on the one surface (the modern raw-mode TUI) almost every interactive user actually runs —
  // the readline host (host.ts) had this wired correctly the whole time.
  const out: string[] = [];
  const bridge = await makeBridge({}, (s) => out.push(s));
  assert.ok(bridge.slashCtx.startBackground, "startBackground must be wired on the TUI's SlashCtx");
  await bridge.submit("/background write a haiku");
  const text = out.join("\n");
  assert.doesNotMatch(text, /this surface cannot run a detached agent/);
  assert.match(text, /started background run/);
  assert.match(text, /agents list.*agents attach/s);
  await bridge.dispose();
});

test("createSessionBridge boots + submit routes an unknown slash to the legacy brain (no throw)", async () => {
  const out: string[] = [];
  const bridge = await makeBridge({}, (s) => out.push(s));
  await bridge.submit("/totallyunknownslash foo");
  assert.match(out.join("\n"), /unknown command/i);
  await bridge.dispose();
});

test("/cd: a valid target rotates the session (fresh id echoed, tuning untouched)", async () => {
  const base = mkdtempSync(join(tmpdir(), "prom-bridge-cd-"));
  const target = join(base, "other-project");
  mkdirSync(target, { recursive: true });
  const out: string[] = [];
  const bridge = await makeBridge({ parsed: args({ cwd: base }) }, (s) => out.push(s));
  const beforeTuning = bridge.slashCtx.tuning();

  await bridge.submit(`/cd ${target}`);

  const text = out.join("\n");
  assert.match(text, /moved to/);
  assert.match(text, new RegExp(target.replace(/[/\\]/g, "\\$&")));
  assert.match(text, /model\/tuning kept/);
  assert.deepEqual(bridge.slashCtx.tuning(), beforeTuning); // tuning is byte-identical after /cd
  await bridge.dispose();
});

test("/cd: a nonexistent target reports the error and leaves the session untouched", async () => {
  const base = mkdtempSync(join(tmpdir(), "prom-bridge-cd-bad-"));
  const out: string[] = [];
  const bridge = await makeBridge({ parsed: args({ cwd: base }) }, (s) => out.push(s));

  await bridge.submit(`/cd ${join(base, "does-not-exist")}`);

  assert.match(out.join("\n"), /\/cd: no such directory/);
  assert.equal(bridge.slashCtx.cwd(), base); // cwd is untouched on a rejected target
  await bridge.dispose();
});

test("/context window: set directly, then bare /context shows the new ceiling", async () => {
  const out: string[] = [];
  const bridge = await makeBridge({}, (s) => out.push(s));

  await bridge.submit("/context window 500000");
  assert.match(out.join("\n"), /500,000/);

  out.length = 0;
  await bridge.submit("/context");
  assert.match(out.join("\n"), /auto-compact ceiling: 500,000 tokens/);
  await bridge.dispose();
});

test("/context window: the no-arg menu states a custom current value even off-preset", async () => {
  const out: string[] = [];
  const bridge = await makeBridge({}, (s) => out.push(s));
  await bridge.submit("/context window 325000");
  out.length = 0;
  await bridge.submit("/context window"); // no-arg menu; ask() (fixed "") cancels afterward
  assert.match(out.join("\n"), /current: 325,000 tokens \(custom\)/);
  await bridge.dispose();
});

test("/cd: accepting the pre-filled default (blank Enter) is a genuine no-op, not a rotation", async () => {
  const base = mkdtempSync(join(tmpdir(), "prom-bridge-cd-noop-"));
  const out: string[] = [];
  const bridge = await makeBridge({ parsed: args({ cwd: base }) }, (s) => out.push(s));
  const before = bridge.slashCtx.tuning();

  await bridge.submit("/cd"); // no path arg → askPath, which (per makeBridge's fake) returns `def`

  assert.match(out.join("\n"), /already in/);
  assert.doesNotMatch(out.join("\n"), /fresh session/);
  assert.equal(bridge.slashCtx.cwd(), base);
  assert.deepEqual(bridge.slashCtx.tuning(), before);
  await bridge.dispose();
});

test("/cd: expands a leading ~ the same way /add-dir does", async () => {
  const marker = mkdtempSync(join(homedir(), "prom-bridge-cd-tilde-"));
  try {
    const base = mkdtempSync(join(tmpdir(), "prom-bridge-cd-from-"));
    const rel = `~/${relative(homedir(), marker)}`;
    const out: string[] = [];
    const bridge = await makeBridge({ parsed: args({ cwd: base }) }, (s) => out.push(s));

    await bridge.submit(`/cd ${rel}`);

    assert.match(out.join("\n"), /moved to/);
    assert.equal(bridge.slashCtx.cwd(), marker);
    await bridge.dispose();
  } finally {
    rmSync(marker, { recursive: true, force: true });
  }
});

/**
 * Regression: /cd deliberately resets repoMapState, agentFiles, permissionRules, and reloads
 * steering for the new project — each with a comment justifying the reset — but the /add-dir
 * working set was the one omission with no such comment: a directory granted access in the OLD
 * project silently remained in the read/write scope of a totally unrelated new project.
 */
test("/cd: clears the /add-dir working set — a grant from the OLD project must not leak into the new one", async () => {
  const projectA = mkdtempSync(join(tmpdir(), "prom-bridge-cdws-A-"));
  const projectB = mkdtempSync(join(tmpdir(), "prom-bridge-cdws-B-"));
  const secrets = mkdtempSync(join(tmpdir(), "prom-bridge-cdws-SECRETS-"));
  const bridge = await makeBridge({ parsed: args({ cwd: projectA }) });

  await bridge.submit(`/add-dir ${secrets}`);
  assert.ok(bridge.slashCtx.workingSet.list().length > 0, "fixture: the grant was added");

  await bridge.submit(`/cd ${projectB}`);

  assert.deepEqual(bridge.slashCtx.workingSet.list(), []);
  await bridge.dispose();
});

test("/cd: re-discovers steering (AGENTS.md) from the NEW directory, not the old one", async () => {
  // Regression test for the ordering bug where steering.reload() ran before state.cwd was
  // updated, so it silently re-read the OLD project's AGENTS.md forever. Checked directly via
  // slashCtx.steering.list() rather than scraping rendered text, since the bridge exposes it.
  const projectA = mkdtempSync(join(tmpdir(), "prom-bridge-steerA-"));
  const projectB = mkdtempSync(join(tmpdir(), "prom-bridge-steerB-"));
  writeFileSync(join(projectA, "AGENTS.md"), "Project A steering rules.");
  writeFileSync(join(projectB, "AGENTS.md"), "Project B steering rules — totally different.");
  const bridge = await makeBridge({ parsed: args({ cwd: projectA }) });

  await bridge.submit(`/cd ${projectB}`);

  const files = bridge.slashCtx.steering.list();
  const agents = files.find((f) => f.name === "AGENTS.md" && f.loaded);
  assert.ok(agents, "no loaded AGENTS.md after /cd");
  assert.equal(agents?.content, "Project B steering rules — totally different.");
  assert.equal(agents?.path, join(projectB, "AGENTS.md"));
  await bridge.dispose();
});

test("the bridge starts when an endpoint EXISTS — the setup path a real user takes", async () => {
  /**
   * `adoptEndpoint` assigns `toolCapability`, and it is called fire-and-forget during setup —
   * but only inside `if (endpoint)`. The declaration of `toolCapability` sat ~700 lines BELOW
   * that call, so with a real endpoint the setup touched a `let` still in its temporal dead
   * zone and threw `Cannot access 'toolCapability' before initialization`. `launchTui` catches
   * that and reports "Prometheus's modern terminal UI failed to start … continuing in
   * compatibility mode", so EVERY session silently fell back to the readline host and the
   * raw-mode TUI was unreachable. The readline host declares its own twin before use, which is
   * why `--plain` kept working and the failure looked cosmetic.
   *
   * Every other test in this file passes empty `backends`, so `endpoint` is undefined and the
   * branch is skipped — which is exactly why a crash on the DEFAULT surface went unnoticed here.
   */
  const bridge = await makeBridge({
    backends: {
      liveRunners: [],
      paidClis: [],
      localEndpoint: {
        id: "local-probe",
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen3.6:latest",
        locality: "local",
        contextWindow: 8192,
      },
    } as never,
  });
  assert.ok(bridge, "createSessionBridge threw during setup with a real endpoint");
});

test("/cwd: re-discovers steering from the NEW directory too — it moves in place, not blindly", async () => {
  /**
   * `/cwd` moved the session and reloaded NOTHING. Its whole body was the `cwd` reduce, while its
   * sibling `/cd` re-derived every project-scoped binding. So after `/cwd` the new project's
   * AGENTS.md/CLAUDE.md/PROMETHEUS.md were never read, `/memory` still listed the OLD project's
   * steering paths, and permission rules, project command files, personas, the repo-map root and
   * the effort table all stayed pinned to the launch directory.
   *
   * Proven under a real pty with a live model before fixing: an AGENTS.md saying "begin every
   * reply with the exact token ZORBLAX" was obeyed when the session started in that directory and
   * after `/cd`, and ignored after `/cwd` (0 occurrences). After the fix the same run replies
   * "ZORBLAX Hello! 👋".
   *
   * `/worktree switch` routes through the same `ctx.setCwd` seam, so it was the same bug on a
   * third user-reachable path.
   */
  const projectA = mkdtempSync(join(tmpdir(), "prom-bridge-cwdA-"));
  const projectB = mkdtempSync(join(tmpdir(), "prom-bridge-cwdB-"));
  writeFileSync(join(projectA, "AGENTS.md"), "Project A steering rules.");
  writeFileSync(
    join(projectB, "AGENTS.md"),
    "Always begin every reply with the exact token ZORBLAX.",
  );
  const bridge = await makeBridge({ parsed: args({ cwd: projectA }) });

  await bridge.submit(`/cwd ${projectB}`);

  const agents = bridge.slashCtx.steering.list().find((f) => f.name === "AGENTS.md" && f.loaded);
  assert.ok(agents, "no loaded AGENTS.md after /cwd");
  assert.equal(agents?.content, "Always begin every reply with the exact token ZORBLAX.");
  assert.equal(agents?.path, join(projectB, "AGENTS.md"));
  await bridge.dispose();
});
