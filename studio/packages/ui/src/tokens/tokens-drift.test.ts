/**
 * tokens-drift.test.ts — the committed artifacts must equal what the source generates.
 *
 * This test exists because of a silent, months-long failure. `tokens.ts` is the source of
 * truth, but the renderer does not read it: it loads the GENERATED `tokens.css`. Someone lifted
 * the dark text ramp, re-based every border off its 1.06–1.87:1 floor, and moved body type from
 * 13px to 14px in `tokens.ts` — and never re-ran the generator. Every unit test read `tokens.ts`
 * and stayed green, while the running app kept painting `--text-secondary: #9db4d4`,
 * `--text-muted: #7d97bd`, `--text-disabled: #5f7899` and `--border-subtle: #172a47`. The user
 * reported grey text on a dark ground and panel edges they could not see, and both fixes were
 * already in the repo — just not in the file that ships.
 *
 * A design system whose source and artifact can disagree does not have a source of truth. This
 * closes that: change `tokens.ts`, re-run the generator, or this fails and tells you which.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildTokensCss, buildTokensJson } from "./build-tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const REGEN = "node --import ./apps/cli/dev-register.mjs packages/ui/src/tokens/build-tokens.ts";

test("tokens.css is in sync with tokens.ts", () => {
  const committed = readFileSync(join(here, "tokens.css"), "utf8");
  assert.equal(
    committed,
    buildTokensCss(),
    `tokens.css is STALE — the renderer would paint the old values. Regenerate:\n  ${REGEN}`,
  );
});

test("tokens.json is in sync with tokens.ts", () => {
  const committed = readFileSync(join(here, "tokens.json"), "utf8");
  assert.equal(
    committed,
    buildTokensJson(),
    `tokens.json is STALE — the CLI/Monaco theme-gen would read the old values. Regenerate:\n  ${REGEN}`,
  );
});

test("importing the generator does not write to disk", () => {
  // The guard that makes the two tests above possible: the module used to write at import
  // time, so any check of the artifacts overwrote the thing it was checking.
  const before = readFileSync(join(here, "tokens.css"), "utf8");
  buildTokensCss();
  buildTokensJson();
  assert.equal(readFileSync(join(here, "tokens.css"), "utf8"), before);
});
