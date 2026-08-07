/**
 * slash-enter.test.ts — the Enter contract against the REAL slash registry.
 *
 * reducer.test.ts pins the state machine with a hand-made 5-item list; this pins the thing
 * the user actually feels, over all ~172 resolvable names: type a slash command, press Enter
 * ONCE, and it runs. The regression it guards is specific — holding on `sel.args` (truthy for
 * an OPTIONAL "[topic]" too) made ~40 commands need a second press, and the command typed
 * after the first press was swallowed as the held command's argument.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SLASH_REGISTRY } from "../session/slash-registry.js";
import type { AcItem } from "./autocomplete.js";
import type { KeyEvent, KeyName } from "./keys.js";
import { type ReduceCtx, initialTuiState, reduce } from "./reducer.js";

/** The SAME projection tui/app.ts feeds the reducer — this test is only honest if it matches. */
const ITEMS: AcItem[] = SLASH_REGISTRY.map((c) => ({
  name: c.name,
  summary: c.summary,
  aliases: c.aliases,
  ...(c.args ? { args: c.args } : {}),
  group: c.group,
}));
const CTX: ReduceCtx = { items: ITEMS, running: false };

const k = (name: KeyName, ch?: string): KeyEvent => (ch === undefined ? { name } : { name, ch });

/** Type `text` then press Enter once; return the submitted text (null = nothing submitted). */
function typeThenEnter(text: string): string | null {
  let state = initialTuiState();
  for (const ch of text) state = reduce(state, k("char", ch), CTX).state;
  const r = reduce(state, k("enter"), CTX);
  const submitted = r.effects.find((e) => e.type === "submit");
  return submitted ? submitted.text : null;
}

test("the report's three acceptance cases each run on ONE Enter", () => {
  assert.equal(typeThenEnter("/faq"), "/faq"); // args "[topic|words]" — optional
  assert.equal(typeThenEnter("/think"), "/think"); // args "[off|low|…]" — optional
  assert.equal(typeThenEnter("/status"), "/status"); // no args at all
});

test("a typed ALIAS survives Enter (it must not be rewritten to the primary name)", () => {
  const think = SLASH_REGISTRY.find((c) => c.name === "think");
  assert.ok(think?.aliases?.includes("effort"), "fixture: /effort is an alias of /think");
  assert.equal(typeThenEnter("/effort"), "/effort");
});

test("EVERY registry command without a REQUIRED arg submits on the first Enter", () => {
  const stuck: string[] = [];
  for (const item of ITEMS) {
    if (typeof item.args === "string" && item.args.trim().startsWith("<")) continue; // required
    if (typeThenEnter(`/${item.name}`) !== `/${item.name}`) stuck.push(item.name);
  }
  assert.deepEqual(stuck, [], `these commands still swallow the first Enter: ${stuck.join(", ")}`);
});

test("a REQUIRED-arg command still completes-and-waits, then submits once the arg is there", () => {
  const needsArg = ITEMS.filter((i) => typeof i.args === "string" && i.args.trim().startsWith("<"));
  assert.ok(needsArg.length > 0, "fixture: the registry has required-arg commands");
  for (const item of needsArg) {
    // bare → held (completed, not submitted)
    assert.equal(typeThenEnter(`/${item.name}`), null, `/${item.name} must wait for its argument`);
    // with the argument present, the caret walked back into the command token → runs
    let state = initialTuiState();
    const line = `/${item.name} x`;
    for (const ch of line) state = reduce(state, k("char", ch), CTX).state;
    state = reduce(state, k("left"), CTX).state; // caret between the space and "x"
    state = reduce(state, k("left"), CTX).state; // caret inside the command token → dropdown open
    const r = reduce(state, k("enter"), CTX);
    const submitted = r.effects.find((e) => e.type === "submit");
    assert.equal(submitted?.text, line, `/${item.name} must run once its argument is typed`);
  }
});

test("narrowing a query after ↑/↓ cannot run a DIFFERENT command (/status ≠ /plugin-status)", () => {
  let state = initialTuiState();
  for (const ch of "/s") state = reduce(state, k("char", ch), CTX).state;
  for (let i = 0; i < 3; i++) state = reduce(state, k("down"), CTX).state; // stale highlight
  for (const ch of "tatus") state = reduce(state, k("char", ch), CTX).state;
  assert.equal(state.ac.items[state.ac.index]?.name, "status");
  const r = reduce(state, k("enter"), CTX);
  assert.equal(r.effects.find((e) => e.type === "submit")?.text, "/status");
});
