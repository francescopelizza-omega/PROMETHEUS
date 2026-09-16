/**
 * tokens/ramp-contrast.test.ts — the WHOLE text ramp, on EVERY ground, for EVERY scheme.
 *
 * Why this exists. `tokens.test.ts` proves §7 for three colours (`text-primary`,
 * `text-secondary`) on two grounds, and only for the three hand-authored base schemes.
 * `themes.test.ts` proves the save-gate, which covers `text-primary` and the four verdict
 * roles. Nothing measured `text-title`, `text-body`, `text-muted` or `text-disabled`, and
 * nothing measured ANY of them against `bg-surface-2` or `bg-inset` — and nothing at all
 * covered the 38 DERIVED schemes' middle ramp.
 *
 * That gap is the whole shape of the "grey text on a dark background" report:
 * `scheme-derive.ts` builds a monotone, AA-clear ramp BY CONSTRUCTION, and a construction
 * guarantee with no test is this repo's documented failure mode ("a tested module with zero
 * callers", "looks implemented, isn't"). One refactor of `derivePalette` and the property is
 * gone with nothing to notice. So it is asserted here, for all 41 schemes at once.
 *
 * The last two assertions cover the `on-<role>` tokens. A label drawn ON a role fill (a
 * verdict chip's solid variant, a primary button, the Git `tag:` pill, the search Aa/.*\/ab
 * toggles, the MCP enable switch) is TEXT, so it carries the 4.5:1 bar, not the 3:1 UI bar.
 * Before these tokens existed the call sites reached for `--brand-fg` (white on the dark
 * scheme: 1.63:1 over `--ok`), and "just use `--bg-app`" fails the light schemes for the
 * mirror-image reason. Measured across the 41 built-ins, 19 sat between 3.19:1 and 4.49:1.
 *
 * Pure math, no rendering — reuses §7's `contrastRatio`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_SCHEMES, type SemanticColors, resolveScheme } from "../tokens.js";
import { contrastRatio, onFill } from "./contrast.js";

/** AA body text. Every step of the ramp is copy someone has to read. */
const AA_TEXT = 4.5;

/** Every ground a scheme paints text on. */
const GROUNDS = ["bg-app", "bg-surface", "bg-surface-2", "bg-inset"] as const;

/** The ramp, brightest first. `text-strong` is an alias of `text-primary`, so it is skipped. */
const RAMP = [
  "text-primary",
  "text-title",
  "text-body",
  "text-secondary",
  "text-muted",
  "text-disabled",
] as const satisfies readonly (keyof SemanticColors)[];

/** Role fills a component paints a `--bg-app` LABEL on. */
const FILLS = ["brand", "accent", "ok", "warn", "danger", "info"] as const;

/** The worst ratio this colour achieves against any ground the scheme paints. */
function worstOnGrounds(s: SemanticColors, fg: string): number {
  return Math.min(...GROUNDS.map((g) => contrastRatio(fg, s[g])));
}

for (const scheme of BUILTIN_SCHEMES) {
  const s = resolveScheme(scheme);

  test(`ramp(${scheme.id}): every text step clears AA on every ground`, () => {
    for (const key of RAMP) {
      for (const g of GROUNDS) {
        const r = contrastRatio(s[key], s[g]);
        assert.ok(
          r >= AA_TEXT,
          `${scheme.id}: ${key}=${s[key]} on ${g}=${s[g]} is ${r.toFixed(2)}:1 (needs >= ${AA_TEXT})`,
        );
      }
    }
  });

  test(`ramp(${scheme.id}): the ramp is monotone — no step is brighter than the one above it`, () => {
    // The inversion this catches is the one that was measured across every derived scheme
    // before `derivePalette`: `text-muted` (metadata, timestamps — the hardest copy to read)
    // coming out DIMMER than `text-disabled`. A small tolerance absorbs rounding in the
    // 24-step interpolation; it is far below one JND.
    let prev = Number.POSITIVE_INFINITY;
    for (const key of RAMP) {
      const w = worstOnGrounds(s, s[key]);
      assert.ok(
        w <= prev + 0.05,
        `${scheme.id}: ${key} reads ${w.toFixed(2)}:1, BRIGHTER than the step above it (${prev.toFixed(2)}:1) — the ramp is inverted`,
      );
      prev = w;
    }
  });

  test(`ramp(${scheme.id}): the on-<role> label is legible on every role fill`, () => {
    for (const fill of FILLS) {
      const fg = s[`on-${fill}`];
      const r = contrastRatio(fg, s[fill]);
      assert.ok(
        r >= AA_TEXT,
        `${scheme.id}: on-${fill}=${fg} on ${fill}=${s[fill]} is ${r.toFixed(2)}:1 (needs >= ${AA_TEXT}) — a solid ${fill} chip's label is unreadable`,
      );
    }
  });

  test(`ramp(${scheme.id}): every on-<role> token equals what onFill computes`, () => {
    // The three base maps author these as literals so the GENERATED tokens.css carries them
    // (the renderer paints from CSS vars before React mounts). A literal can drift from the
    // rule that produced it the moment a role colour is retuned, and the drift would be
    // invisible — the label would simply go quiet. So the literals are pinned to the function.
    for (const fill of FILLS) {
      assert.equal(
        s[`on-${fill}`],
        onFill(s[fill], s["bg-app"]),
        `${scheme.id}: on-${fill} is ${s[`on-${fill}`]} but onFill(${s[fill]}, ${s["bg-app"]}) says ${onFill(s[fill], s["bg-app"])}`,
      );
    }
  });
}
