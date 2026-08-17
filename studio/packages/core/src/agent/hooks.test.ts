/**
 * hooks.test.ts — the PURE half of lifecycle hooks (`agent/hooks.ts`).
 *
 * Every test here names the failure it prevents. The theme is fail-soft: a hook is
 * user-authored shell on the hot path of every tool call, so the only way it may change a
 * turn is a clean nonzero PreToolUse exit. Anything else — a throw, a timeout, a garbage
 * exit code, an unrunnable command — must leave the turn exactly as it would have been with
 * no hook configured. Any of those becoming a silent veto over every tool would look, from
 * the user's side, like the agent had simply stopped working.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_REFUSAL_HINT,
  type HookInvocation,
  type HookOutcome,
  type HookRunner,
  type HookSpec,
  firePostToolUseHooks,
  hookMatchesTool,
  hookRefusal,
  matchingHooks,
  runPreToolUseHooks,
  runSessionStartHooks,
  sessionStartHookBlock,
  validateHooks,
} from "./hooks.js";

/** A runner that records what it was asked to run and answers from a scripted table. */
function fakeRunner(
  answer: (inv: HookInvocation) => Partial<HookOutcome> | Promise<Partial<HookOutcome>>,
): { runner: HookRunner; seen: HookInvocation[] } {
  const seen: HookInvocation[] = [];
  const runner: HookRunner = async (inv) => {
    seen.push(inv);
    const out = await answer(inv);
    return { exitCode: 0, stdout: "", stderr: "", ...out };
  };
  return { runner, seen };
}

const PRE = (command: string, matcher?: string): HookSpec => ({
  event: "PreToolUse",
  command,
  ...(matcher !== undefined ? { matcher } : {}),
});

/* ── configuration parsing ───────────────────────────────────────────────────*/

test("validateHooks drops ONE malformed row, not the whole user's configuration", () => {
  // The alternative (reject the array) would mean a single typo silently disarms every hook
  // the user wrote, which is the failure mode a security-shaped feature can least afford.
  const rows = validateHooks([
    { event: "PreToolUse", command: "guard.sh" },
    { event: "NotAnEvent", command: "x.sh" },
    { event: "PostToolUse", command: "" },
    { event: "PostToolUse", command: "log.sh", matcher: "write_*" },
  ]);
  assert.deepEqual(rows, [
    { event: "PreToolUse", command: "guard.sh" },
    { event: "PostToolUse", command: "log.sh", matcher: "write_*" },
  ]);
});

test("validateHooks returns [] for a non-array so a corrupt settings value cannot throw", () => {
  assert.deepEqual(validateHooks(undefined), []);
  assert.deepEqual(validateHooks("PreToolUse:guard.sh"), []);
  assert.deepEqual(validateHooks({ event: "PreToolUse", command: "x" }), []);
});

test("validateHooks rejects a whitespace-only command (an empty shell line is not a hook)", () => {
  assert.deepEqual(validateHooks([{ event: "PreToolUse", command: "   " }]), []);
});

/* ── matching ────────────────────────────────────────────────────────────────*/

test("an absent matcher selects EVERY tool (the documented default, not 'nothing')", () => {
  assert.equal(hookMatchesTool(PRE("g.sh"), "write_file"), true);
  assert.equal(hookMatchesTool(PRE("g.sh", "*"), "prometheus_install"), true);
});

test("a glob matcher selects by tool name, including the mcp__ namespace", () => {
  assert.equal(hookMatchesTool(PRE("g.sh", "write_*"), "write_file"), true);
  assert.equal(hookMatchesTool(PRE("g.sh", "write_*"), "read_file"), false);
  assert.equal(hookMatchesTool(PRE("g.sh", "mcp__*"), "mcp__srv__tool"), true);
});

test("matchingHooks filters by EVENT as well as name — a PostToolUse hook never pre-vetoes", () => {
  const hooks: HookSpec[] = [
    { event: "PreToolUse", command: "pre.sh", matcher: "write_file" },
    { event: "PostToolUse", command: "post.sh" },
    { event: "SessionStart", command: "start.sh" },
  ];
  assert.deepEqual(
    matchingHooks(hooks, "PreToolUse", "write_file").map((h) => h.command),
    ["pre.sh"],
  );
  assert.deepEqual(
    matchingHooks(hooks, "PreToolUse", "read_file").map((h) => h.command),
    [],
  );
  assert.deepEqual(
    matchingHooks(hooks, "SessionStart").map((h) => h.command),
    ["start.sh"],
  );
});

test("SessionStart matching ignores the matcher (there is no tool to match against)", () => {
  const hooks: HookSpec[] = [{ event: "SessionStart", command: "start.sh", matcher: "write_*" }];
  assert.equal(matchingHooks(hooks, "SessionStart").length, 1);
});

/* ── PreToolUse: the one place a hook may change the outcome ──────────────────*/

test("a clean nonzero exit DENIES, and names the command so the user can find it", async () => {
  const { runner } = fakeRunner(() => ({ exitCode: 2 }));
  const denial = await runPreToolUseHooks([PRE("guard.sh")], runner, {
    name: "write_file",
    args: { path: "a.ts" },
  });
  assert.deepEqual(denial, { command: "guard.sh" });
});

test("exit 0 allows the call through (a hook that approves is not a veto)", async () => {
  const { runner } = fakeRunner(() => ({ exitCode: 0 }));
  assert.equal(
    await runPreToolUseHooks([PRE("guard.sh")], runner, { name: "write_file", args: {} }),
    undefined,
  );
});

test("the tool-call JSON `{tool,args}` reaches the hook on stdin", async () => {
  // The whole point of a PreToolUse hook is deciding from the ARGUMENTS; a hook that only
  // learns the tool name cannot tell `write_file src/x.ts` from `write_file ~/.ssh/config`.
  const { runner, seen } = fakeRunner(() => ({ exitCode: 0 }));
  await runPreToolUseHooks([PRE("guard.sh")], runner, {
    name: "write_file",
    args: { path: "a.ts", content: "x" },
  });
  assert.deepEqual(JSON.parse(seen[0]?.stdin ?? "{}"), {
    tool: "write_file",
    args: { path: "a.ts", content: "x" },
  });
  assert.equal(seen[0]?.timeoutMs, DEFAULT_HOOK_TIMEOUT_MS);
});

test("hooks run in configuration order and STOP at the first deny", async () => {
  // Attribution matters: the user must be told which rule refused, and a later hook should not
  // get to run side effects for a call that was already refused.
  const { runner, seen } = fakeRunner((inv) => ({ exitCode: inv.command === "second.sh" ? 0 : 1 }));
  const denial = await runPreToolUseHooks([PRE("first.sh"), PRE("second.sh")], runner, {
    name: "write_file",
    args: {},
  });
  assert.deepEqual(denial, { command: "first.sh" });
  assert.deepEqual(
    seen.map((s) => s.command),
    ["first.sh"],
  );
});

test("a hook whose matcher does not select the tool is never even spawned", async () => {
  const { runner, seen } = fakeRunner(() => ({ exitCode: 1 }));
  const denial = await runPreToolUseHooks([PRE("guard.sh", "write_*")], runner, {
    name: "read_file",
    args: {},
  });
  assert.equal(denial, undefined);
  assert.deepEqual(seen, []);
});

test("no runner injected ⇒ no hook fires (a host that opted out is not silently denied)", async () => {
  assert.equal(
    await runPreToolUseHooks([PRE("guard.sh")], undefined, { name: "write_file", args: {} }),
    undefined,
  );
});

/* ── PreToolUse fail-soft: none of these may become a veto ────────────────────*/

test("a runner that THROWS does not deny — a broken hook is not a refusal", async () => {
  const errors: string[] = [];
  const runner: HookRunner = async () => {
    throw new Error("ENOENT: guard.sh");
  };
  const denial = await runPreToolUseHooks([PRE("guard.sh")], runner, {
    name: "write_file",
    args: {},
  });
  assert.equal(denial, undefined);
  await runPreToolUseHooks(
    [PRE("guard.sh")],
    runner,
    { name: "write_file", args: {} },
    {
      onError: (m) => errors.push(m),
    },
  );
  assert.match(errors[0] ?? "", /failed to run \(guard\.sh\)/);
});

test("a TIMED-OUT hook does not deny, even though its exit code is nonzero", async () => {
  // A killed child reports a nonzero code. Reading that as a deny would turn every slow
  // machine into one where the agent refuses every tool call it was configured to watch.
  const errors: string[] = [];
  const { runner } = fakeRunner(() => ({ exitCode: 143, timedOut: true }));
  const denial = await runPreToolUseHooks(
    [PRE("slow.sh")],
    runner,
    { name: "write_file", args: {} },
    { onError: (m) => errors.push(m) },
  );
  assert.equal(denial, undefined);
  assert.match(errors[0] ?? "", /timed out/);
});

test("a hook that could not be SPAWNED does not deny", async () => {
  const { runner } = fakeRunner(() => ({ exitCode: -1, error: "spawn /bin/sh ENOENT" }));
  assert.equal(
    await runPreToolUseHooks([PRE("guard.sh")], runner, { name: "write_file", args: {} }),
    undefined,
  );
});

test("a garbage exit code (NaN/undefined) does not deny", async () => {
  const { runner } = fakeRunner(() => ({ exitCode: Number.NaN }));
  assert.equal(
    await runPreToolUseHooks([PRE("guard.sh")], runner, { name: "write_file", args: {} }),
    undefined,
  );
});

test("a circular args object is serialized as null rather than throwing into the turn", async () => {
  const args: Record<string, unknown> = { path: "a.ts" };
  args.self = args;
  const { runner, seen } = fakeRunner(() => ({ exitCode: 0 }));
  await runPreToolUseHooks([PRE("guard.sh")], runner, { name: "write_file", args });
  assert.equal(seen[0]?.stdin, "null");
});

/* ── PostToolUse: an observer that can never affect the turn ──────────────────*/

test("PostToolUse receives {tool,args,result} and is NOT awaited by the caller", async () => {
  let resolveHook: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    resolveHook = r;
  });
  const seen: HookInvocation[] = [];
  const runner: HookRunner = async (inv) => {
    seen.push(inv);
    await gate;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const pending = firePostToolUseHooks(
    [{ event: "PostToolUse", command: "log.sh" }],
    runner,
    { name: "read_file", args: { path: "a.ts" } },
    { ok: true, summary: "contents" },
  );
  // The call returned while the hook is still blocked — that IS the fire-and-forget property.
  assert.equal(pending.length, 1);
  assert.deepEqual(JSON.parse(seen[0]?.stdin ?? "{}"), {
    tool: "read_file",
    args: { path: "a.ts" },
    result: { ok: true, summary: "contents" },
  });
  resolveHook?.();
  await Promise.all(pending);
});

test("a PostToolUse hook that rejects never surfaces as an unhandled rejection", async () => {
  const errors: string[] = [];
  const runner: HookRunner = async () => {
    throw new Error("boom");
  };
  const pending = firePostToolUseHooks(
    [{ event: "PostToolUse", command: "log.sh" }],
    runner,
    { name: "read_file", args: {} },
    { ok: true },
    { onError: (m) => errors.push(m) },
  );
  // `await` must RESOLVE, not reject: the loop does not await these, so a rejecting promise
  // would escape as an unhandled rejection and can take the whole process down under
  // --unhandled-rejections=throw.
  await Promise.all(pending);
  assert.match(errors[0] ?? "", /failed to run \(log\.sh\)/);
});

/* ── SessionStart: stdout becomes a system block ──────────────────────────────*/

test("SessionStart stdout is folded into ONE system block, in configuration order", async () => {
  const { runner } = fakeRunner((inv) => ({
    exitCode: 0,
    stdout: inv.command === "a.sh" ? "sprint: CLI-090\n" : "  branch: main  ",
  }));
  const block = await runSessionStartHooks(
    [
      { event: "SessionStart", command: "a.sh" },
      { event: "SessionStart", command: "b.sh" },
    ],
    runner,
  );
  assert.equal(
    block,
    "<session-start-hooks>\nsprint: CLI-090\n\nbranch: main\n</session-start-hooks>",
  );
});

test("a SessionStart hook that prints nothing contributes no block at all", async () => {
  const { runner } = fakeRunner(() => ({ exitCode: 0, stdout: "   \n" }));
  assert.equal(
    await runSessionStartHooks([{ event: "SessionStart", command: "a.sh" }], runner),
    undefined,
  );
  assert.equal(sessionStartHookBlock([]), undefined);
});

test("a FAILING SessionStart hook is skipped and the session still opens", async () => {
  // A nonzero exit means nothing for SessionStart — there is no call to deny. The only
  // acceptable behaviour is to drop that hook's output and carry on.
  const errors: string[] = [];
  const { runner } = fakeRunner((inv) =>
    inv.command === "bad.sh" ? { exitCode: 1, error: "nope" } : { exitCode: 0, stdout: "ok" },
  );
  const block = await runSessionStartHooks(
    [
      { event: "SessionStart", command: "bad.sh" },
      { event: "SessionStart", command: "good.sh" },
    ],
    runner,
    { onError: (m) => errors.push(m) },
  );
  assert.equal(block, "<session-start-hooks>\nok\n</session-start-hooks>");
  assert.equal(errors.length, 1);
});

test("a SessionStart runner that throws yields no block instead of failing the session", async () => {
  const runner: HookRunner = async () => {
    throw new Error("boom");
  };
  assert.equal(
    await runSessionStartHooks([{ event: "SessionStart", command: "a.sh" }], runner),
    undefined,
  );
});

/* ── the refusal contract ─────────────────────────────────────────────────────*/

test("hookRefusal mirrors planModeRefusal's shape so the model learns ONE refusal contract", () => {
  assert.deepEqual(hookRefusal("write_file", "guard.sh"), {
    denied: true,
    tool: "write_file",
    event: "PreToolUse",
    hook: "guard.sh",
    hint: HOOK_REFUSAL_HINT,
  });
});
