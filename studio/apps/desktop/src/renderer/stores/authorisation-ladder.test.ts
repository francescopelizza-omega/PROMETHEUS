/**
 * authorisation-ladder.test.ts — the colour ladder Studio paints A0–A7 with.
 *
 * `authLevelVar` had no test at all, and it is exactly the shape this repo keeps getting
 * bitten by: a pure function returning a STRING that three components interpolate straight
 * into `var(...)`. A typo returns a variable that does not exist, CSS silently resolves it to
 * nothing, and the pill renders with no colour — no error, no failing test, nothing to notice
 * until someone looks at the right level in the right theme.
 *
 * So the first assertion here is the one that matters most: every name this function can
 * return is a token that actually exists.
 *
 * The rest pins the two decisions the ladder encodes:
 *   - the top rung is NOT red. A6/A7 are settings an operator chose to get work done
 *     unprompted, not faults, and `--danger` is reserved for things that genuinely failed.
 *   - the rungs match the CLI's ladder (`apps/cli/src/tui/status.ts`, `authRole`). The two had
 *     drifted — A0 was grey in the terminal and GREEN in Studio, which claimed an "ok/clean"
 *     verdict for what is really the most cautious setting on the dial.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AUTH_LEVEL, MAX_AUTH_LEVEL } from "@prometheus/core/agent-authorization";
import { darkSemantic, highContrastSemantic, lightSemantic } from "@prometheus/ui/tokens";

import { authLevelVar, clampAuthLevel } from "./authorisation.js";

/** Every level the dial can actually reach. */
const LEVELS = Array.from({ length: MAX_AUTH_LEVEL + 1 }, (_, i) => i);

test("every var the ladder returns is a token that EXISTS — in all three base themes", () => {
  // The whole failure mode: `var(--autonmy)` resolves to nothing and paints an uncoloured pill.
  // Checked against all three themes because a token added to only one would fail the same way
  // for anyone not on the default.
  for (const level of LEVELS) {
    const name = authLevelVar(level);
    assert.match(name, /^--[a-z][a-z0-9-]*$/, `A${level} returned a malformed var name: ${name}`);
    const key = name.slice(2);
    for (const [theme, tokens] of [
      ["dark", darkSemantic],
      ["light", lightSemantic],
      ["high-contrast", highContrastSemantic],
    ] as const) {
      assert.ok(
        Object.hasOwn(tokens, key),
        `A${level} → ${name}, which the ${theme} theme does not define`,
      );
      assert.match(
        (tokens as Record<string, string>)[key] as string,
        /^#[0-9a-f]{6}$/i,
        `${theme}.${key} is not a colour`,
      );
    }
  }
});

test("the top of the ladder is NOT danger — A6 and A7 are a setting, not a fault", () => {
  assert.equal(authLevelVar(6), "--autonomy");
  assert.equal(authLevelVar(7), "--autonomy");
  for (const level of LEVELS) {
    const name = authLevelVar(level);
    assert.notEqual(name, "--danger", `A${level} still paints the error colour`);
    assert.notEqual(name, "--danger-fg", `A${level} still paints the error colour`);
  }
});

test("the rungs match the CLI's ladder, including the grey bottom", () => {
  // `authRole` in apps/cli/src/tui/status.ts: 0–1 muted · 2–3 accent · 4–5 warn · 6–7 autonomy.
  // Studio used to start at `--ok` (green), which is this product's "clean / enabled" colour —
  // a verdict A0 is not making. A0 is the most CAUTIOUS rung, not the healthiest.
  assert.deepEqual(
    LEVELS.map(authLevelVar),
    [
      "--text-muted",
      "--text-muted",
      "--accent",
      "--accent",
      "--warn",
      "--warn",
      "--autonomy",
      "--autonomy",
    ],
    "the Studio ladder no longer matches the terminal's",
  );
  assert.ok(
    !LEVELS.map(authLevelVar).includes("--ok"),
    "green means clean/enabled elsewhere; spending it on A0 claims a verdict",
  );
});

test("the ladder is total — no input can reach a level it has no colour for", () => {
  // It is fed a persisted number from localStorage, so it sees whatever was last written there.
  for (const bad of [-1, 99, 3.7, Number.NaN, Number.POSITIVE_INFINITY]) {
    const name = authLevelVar(bad);
    assert.match(name, /^--[a-z][a-z0-9-]*$/, `${bad} produced ${name}`);
  }
  assert.equal(authLevelVar(-1), authLevelVar(0), "below the floor clamps to A0");
  assert.equal(authLevelVar(99), authLevelVar(MAX_AUTH_LEVEL), "above the ceiling clamps to A7");
  assert.equal(authLevelVar(Number.NaN), authLevelVar(DEFAULT_AUTH_LEVEL), "NaN → the default");
  assert.equal(clampAuthLevel(3.7), 3, "a fractional level truncates rather than rounding up");
});
