/**
 * slash-smoke.test.ts — EVERY registered slash command is invoked, once, and must behave.
 *
 * The registry has 130 commands and the behavioural suite next door asserts a couple of dozen
 * of them in detail. That left a long tail nobody executed: a command could throw on a bare
 * invocation, or do nothing at all, and every suite stayed green because no test ever called it.
 *
 * Two properties are checked for each command, both of them things a USER would notice
 * immediately and a type-checker never will:
 *
 *   1. it does not THROW on a bare invocation (`/foo` with no argument);
 *   2. it is not a SILENT no-op — it either writes something, or drives one of the ctx seams
 *      (a verb, a prompt, a tune, a control, a git call, …). A command that returns having done
 *      neither is indistinguishable from an unwired one.
 *
 * Everything runs against the shared fake ctx, whose seams RECORD instead of acting, so no
 * engine is spawned, no network is touched, and nothing outside the fixture is written.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { setColorEnabled } from "../render.js";
import { makeFakeSlashCtx } from "./__fixtures__/slash-ctx.js";
import { SLASH_REGISTRY } from "./slash-registry.js";

setColorEnabled(false);

/**
 * Arguments for the commands whose BARE form is deliberately inert.
 *
 * A command that requires a target prints a usage line and stops — correct behaviour, and
 * already covered by rule 2 (it writes). This map only exists for commands whose bare form is
 * genuinely a no-op by design, so the smoke test exercises a real path instead.
 */
const ARGS: Record<string, string> = {
  mention: "src/x.ts",
  describe: "caveman",
  info: "caveman",
  tutorial: "caveman",
  methods: "caveman",
};

/** Did the command do ANYTHING observable through the ctx? */
function acted(calls: ReturnType<typeof makeFakeSlashCtx>["calls"]): boolean {
  return (
    calls.writes.length > 0 ||
    calls.verbs.length > 0 ||
    calls.prompts.length > 0 ||
    calls.tunes.length > 0 ||
    calls.controls.length > 0 ||
    calls.gitArgv.length > 0 ||
    calls.setCwds.length > 0 ||
    calls.steering.length > 0 ||
    calls.copies.length > 0 ||
    calls.repoMapVerbs.length > 0 ||
    calls.repoMapStats > 0 ||
    calls.continues > 0 ||
    calls.authLevels.length > 0 ||
    calls.applies > 0 ||
    calls.delegated.length > 0
  );
}

test("every registered command runs without throwing", async () => {
  const broken: string[] = [];
  for (const cmd of SLASH_REGISTRY) {
    const { ctx } = makeFakeSlashCtx();
    try {
      await cmd.run(ARGS[cmd.name] ?? "", ctx);
    } catch (err) {
      broken.push(`/${cmd.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  assert.deepEqual(broken, [], `commands threw on a bare invocation:\n${broken.join("\n")}`);
});

test("no registered command is a SILENT no-op", async () => {
  const silent: string[] = [];
  for (const cmd of SLASH_REGISTRY) {
    const { ctx, calls } = makeFakeSlashCtx();
    try {
      await cmd.run(ARGS[cmd.name] ?? "", ctx);
    } catch {
      continue; // the throw is the other test's finding, not this one's
    }
    if (!acted(calls)) silent.push(`/${cmd.name}`);
  }
  assert.deepEqual(
    silent,
    [],
    `these commands returned without writing anything or driving any seam — ` +
      `a user sees nothing happen:\n${silent.join("\n")}`,
  );
});

test("every command declares the metadata the pickers and docs render", () => {
  const bad: string[] = [];
  for (const cmd of SLASH_REGISTRY) {
    if (!cmd.name.trim()) bad.push("a command has an empty name");
    if (!cmd.summary?.trim()) bad.push(`/${cmd.name}: no summary (the picker renders a blank row)`);
    if (!cmd.group) bad.push(`/${cmd.name}: no group (it is dropped from the grouped help)`);
  }
  assert.deepEqual(bad, []);
});
