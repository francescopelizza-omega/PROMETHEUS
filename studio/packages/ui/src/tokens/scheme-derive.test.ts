/**
 * scheme-derive.test.ts — the registry-wide legibility guard.
 *
 * This is the "stop rediscovering it" test for the grey-on-dark report. On 2026-09-09 an audit
 * of all 41 built-in schemes against WCAG found 28 of them shipping text below AA on their own
 * grounds, and EVERY derived scheme shipping an INVERTED text ramp — `text-muted`, the tone
 * that carries timestamps and sublabels, coming out dimmer than `text-disabled`. Both were
 * properties of the derivation, not of any one palette, so both are asserted here across the
 * whole registry rather than fixed scheme by scheme.
 *
 * A new palette that violates either fails this file. That is the point: the next person to add
 * a scheme should not have to know any of the above.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_SCHEMES, resolveScheme } from "../tokens.js";
import { blend, contrastRatio } from "./contrast.js";
import { derivePalette } from "./scheme-derive.js";

/** The ramp, brightest → quietest. Contrast must never increase down this list. */
const RAMP = [
  "text-primary",
  "text-title",
  "text-body",
  "text-secondary",
  "text-muted",
  "text-disabled",
] as const;

/** Every ground a scheme paints text on. */
const GROUNDS = ["bg-app", "bg-surface", "bg-surface-2", "bg-inset"] as const;

/** The role tokens that render as chips over a 14% tint of themselves. */
const VERDICTS = ["ok", "warn", "danger", "info"] as const;

function tokensOf(scheme: (typeof BUILTIN_SCHEMES)[number]): Record<string, string> {
  return resolveScheme(scheme) as unknown as Record<string, string>;
}

test("every builtin scheme's text ramp clears AA on every one of its own grounds", () => {
  const bad: string[] = [];
  for (const scheme of BUILTIN_SCHEMES) {
    const t = tokensOf(scheme);
    for (const ground of GROUNDS) {
      for (const step of [...RAMP, "text-strong"]) {
        const ratio = contrastRatio(t[step] as string, t[ground] as string);
        if (ratio < 4.5) bad.push(`${scheme.id}: ${step} on ${ground} = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(bad, [], `text below AA (4.5:1):\n${bad.join("\n")}`);
});

test("every builtin scheme's text ramp is monotone — muted is never brighter than secondary", () => {
  // The defect this catches, verbatim from the audit: Monokai muted 4.06:1 vs disabled 5.53:1;
  // Ayu Dark 2.21 vs 2.79; Palenight 2.05 vs 2.49; Ember muted 9.11 vs its own secondary 6.67.
  const bad: string[] = [];
  for (const scheme of BUILTIN_SCHEMES) {
    const t = tokensOf(scheme);
    const bg = t["bg-surface"] as string;
    for (let i = 1; i < RAMP.length; i++) {
      const prev = contrastRatio(t[RAMP[i - 1] as string] as string, bg);
      const cur = contrastRatio(t[RAMP[i] as string] as string, bg);
      // a hair of tolerance: two steps may resolve to the same colour, they may not invert.
      if (cur > prev + 0.01) {
        bad.push(
          `${scheme.id}: ${RAMP[i]} (${cur.toFixed(2)}) brighter than ${RAMP[i - 1]} (${prev.toFixed(2)})`,
        );
      }
    }
  }
  assert.deepEqual(bad, [], `inverted ramps:\n${bad.join("\n")}`);
});

test("every builtin scheme's role tokens clear the 3:1 UI bar on surface and on their tint", () => {
  const bad: string[] = [];
  for (const scheme of BUILTIN_SCHEMES) {
    const t = tokensOf(scheme);
    const surface = t["bg-surface"] as string;
    for (const role of [...VERDICTS, "brand", "accent"]) {
      const onSurface = contrastRatio(t[role] as string, surface);
      if (onSurface < 3)
        bad.push(`${scheme.id}: ${role} on bg-surface = ${onSurface.toFixed(2)}:1`);
    }
    for (const role of VERDICTS) {
      const tint = blend(t[role] as string, surface, 0.14);
      const onTint = contrastRatio(t[role] as string, tint);
      if (onTint < 3) bad.push(`${scheme.id}: ${role} on its 14% tint = ${onTint.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(bad, [], `roles below the 3:1 UI bar:\n${bad.join("\n")}`);
});

test("derivePalette lifts a palette that is far below AA without leaving its hue", () => {
  // Ayu Dark's real numbers before the rewrite: secondary/muted/disabled at 2.79 / 2.21 / 2.79.
  const derived = derivePalette(
    {
      bg: "#0b0e14",
      surface: "#0d1017",
      surface2: "#131721",
      inset: "#070a0f",
      borderSubtle: "#1b1f2a",
      borderStrong: "#2a2f3a",
      text: "#bfbdb6",
      textDim: "#565b66",
      brand: "#e6b450",
      accent: "#39bae6",
      ok: "#7fd962",
      warn: "#e6b450",
      danger: "#f26d78",
      info: "#39bae6",
      selection: "#1c2430",
    },
    "dark",
  );
  const t = derived as unknown as Record<string, string>;
  for (const step of RAMP) {
    assert.ok(
      contrastRatio(t[step] as string, t["bg-surface"] as string) >= 4.5,
      `${step} must clear AA, got ${contrastRatio(t[step] as string, t["bg-surface"] as string).toFixed(2)}`,
    );
  }
  // hue preserved: the lift walks toward the palette's OWN text tone, which is warm grey — so
  // the dim end must not have been dragged to a neutral white.
  const dim = t["text-disabled"] as string;
  assert.notEqual(dim, "#ffffff", "the dim end must not collapse to the white pole");
});

test("derivePalette keeps a bright palette from collapsing its ramp", () => {
  // Nord hands us a textDim (#d8dee9) that is ALREADY ~9:1. Without backing it down to the
  // floor the whole ramp crushes into the sliver between it and text-primary.
  const nord = derivePalette(
    {
      bg: "#2e3440",
      surface: "#3b4252",
      surface2: "#434c5e",
      inset: "#272c36",
      borderSubtle: "#434c5e",
      borderStrong: "#4c566a",
      text: "#eceff4",
      textDim: "#d8dee9",
      brand: "#b48ead",
      accent: "#88c0d0",
      ok: "#a3be8c",
      warn: "#ebcb8b",
      danger: "#bf616a",
      info: "#81a1c1",
      selection: "#434c5e",
    },
    "dark",
  );
  const t = nord as unknown as Record<string, string>;
  const surface = t["bg-surface"] as string;
  const top = contrastRatio(t["text-primary"] as string, surface);
  const bottom = contrastRatio(t["text-disabled"] as string, surface);
  assert.ok(bottom >= 4.5, `dim end must stay legible, got ${bottom.toFixed(2)}`);
  assert.ok(
    top - bottom > 2,
    `the ramp needs usable range: primary ${top.toFixed(2)} vs disabled ${bottom.toFixed(2)}`,
  );
});

test("derivePalette never lets a selection band swallow the text drawn on it", () => {
  const derived = derivePalette(
    {
      bg: "#101010",
      surface: "#181818",
      surface2: "#202020",
      inset: "#0c0c0c",
      borderSubtle: "#2a2a2a",
      borderStrong: "#3a3a3a",
      text: "#f0f0f0",
      textDim: "#909090",
      brand: "#a855f7",
      accent: "#35c7ee",
      ok: "#8be04a",
      warn: "#f5c944",
      danger: "#ff5566",
      info: "#35c7ee",
      // a near-white selection: primary text on top of it would be invisible.
      selection: "#e8e8e8",
    },
    "dark",
  );
  const t = derived as unknown as Record<string, string>;
  assert.ok(
    contrastRatio(t["text-primary"] as string, t.selection as string) >= 4.5,
    "primary text must stay legible on the selection band",
  );
});
