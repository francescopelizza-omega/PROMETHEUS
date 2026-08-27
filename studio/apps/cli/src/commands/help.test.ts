/**
 * help.test.ts — `prometheus <verb> --help`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { helpForTopic } from "./help.js";

test("`<real verb> --help` points at the verb instead of denying it exists", () => {
  /**
   * `prometheus budget --help` answered `unknown help topic: budget` and exited 2, even though
   * `prometheus budget` prints its own usage and works. Six verbs were in that state — budget,
   * completion, man, meet, persona, tasks — so the standard way to ask a command what it does
   * told the user the command did not exist. Measured against the built binary.
   */
  for (const verb of ["budget", "completion", "man", "meet", "persona", "tasks"]) {
    const out = helpForTopic(makeContext(parseArgs([verb, "--help"])), verb);
    assert.equal(out.exitCode, 0, `${verb} --help still fails`);
    assert.doesNotMatch(out.text ?? "", /unknown help topic/);
    assert.match(out.text ?? "", new RegExp(`prometheus ${verb}`));
  }

  // a genuinely unknown topic must STILL fail, with a suggestion — otherwise this would have
  // turned every typo into a success.
  const bad = helpForTopic(makeContext(parseArgs(["wroktree", "--help"])), "wroktree");
  assert.equal(bad.exitCode, 2);
  assert.match(bad.text ?? "", /unknown help topic/);

  // …and a verb that DOES have a real help page still renders it, not the fallback.
  const real = helpForTopic(makeContext(parseArgs(["scan", "--help"])), "scan");
  assert.equal(real.exitCode, 0);
  assert.doesNotMatch(real.text ?? "", /No detailed help page/);
});
