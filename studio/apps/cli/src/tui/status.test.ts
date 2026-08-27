/**
 * status.test.ts — justified status bar, mode-indicator line, composer hint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type StatusModel,
  TRAIT_INLINE_MAX,
  capabilityPanel,
  composerHint,
  contextMeterSegment,
  costMeterSegment,
  effortBadge,
  justify,
  modelTraits,
  statusLines,
  traitCells,
  traitRailFits,
  traitRailLine,
} from "./status.js";
import { stringWidth } from "./width.js";

const BASE: StatusModel = {
  permMode: "default",
  authLevel: 1,
  model: "qwen2.5",
  modelSource: "local",
  tools: true,
  gate: "enforce",
  dryRun: false,
  profile: "default",
  cwd: "~/proj",
};

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("justify places left + right with a gap filling the width", () => {
  const line = justify(
    [{ text: "LEFT", role: "accent" }],
    [{ text: "RIGHT", role: "muted" }],
    20,
    "none",
  );
  assert.equal(line.length, 20);
  assert.ok(line.startsWith("LEFT"));
  assert.ok(line.endsWith("RIGHT"));
});

test("justify drops right segments tail-first when they don't fit", () => {
  const line = justify(
    [{ text: "[PROMETHEUS:DEFAULT]", role: "muted" }],
    [
      { text: "modelnamelong", role: "muted" },
      { text: "/default", role: "modelOpen" },
      { text: "~/very/long/path", role: "muted" },
    ],
    24,
    "none",
  );
  assert.ok(strip(line).length <= 24);
  assert.ok(strip(line).includes("[PROMETHEUS:DEFAULT]")); // left is load-bearing, kept
});

test("default mode: bar + hint only (no indicator line)", () => {
  // width 80: room for the load-bearing auth chip + model + profile (the auth chip sits
  // immediately left of the model and is always kept — it drops last on a narrow terminal).
  const lines = statusLines(BASE, 80, "none");
  assert.equal(lines.length, 2); // bar + hint
  assert.match(lines[0] ?? "", /\[PROMETHEUS:DEFAULT\]/);
  assert.match(lines[0] ?? "", /auth:1·readonly/); // authorisation chip, left of the model
  assert.match(lines[0] ?? "", /\/default/); // profile chip
  assert.match(lines[1] ?? "", /commands/); // hint
});

test("bypass mode: indicator line shows the exact bypass text", () => {
  const lines = statusLines({ ...BASE, permMode: "bypassPermissions" }, 60, "none");
  assert.equal(lines.length, 3); // bar + indicator + hint
  assert.match(lines[0] ?? "", /\[PROMETHEUS:BYPASS-PERMISSIONS\]/);
  assert.equal(lines[1], "⏵⏵ bypass permissions on");
});

test("plan + acceptEdits indicators", () => {
  assert.equal(statusLines({ ...BASE, permMode: "plan" }, 60, "none")[1], "⏸ plan mode on");
  assert.equal(
    statusLines({ ...BASE, permMode: "acceptEdits" }, 60, "none")[1],
    "⏵⏵ accept edits on",
  );
});

test("local model paints modelOpen, cloud paints modelPaid (truecolor)", () => {
  // 80 cols: the narrowest width that still paints the model segment (the `[PROMETHEUS:…]`
  // chip is wider than the old `[PROM:…]`, so 60 now drops the model on both sides).
  const local = statusLines(BASE, 80, "truecolor")[0] ?? "";
  const cloud =
    statusLines({ ...BASE, model: "opus", modelSource: "cloud" }, 80, "truecolor")[0] ?? "";
  assert.match(local, /38;2;/); // colored
  assert.notEqual(strip(local), strip(cloud)); // different model text
});

test("composerHint mentions the key bindings", () => {
  const h = strip(composerHint("none"));
  assert.match(h, /send/);
  assert.match(h, /mode/);
  assert.match(h, /cancel/);
});

test("status bar reflects tools on/off + degrades at width 40 (CLI-018)", () => {
  const on = strip(statusLines({ ...BASE, tools: true }, 80, "none").join("\n"));
  assert.match(on, /tools:on/);
  const off = strip(statusLines({ ...BASE, tools: false }, 80, "none").join("\n"));
  assert.match(off, /tools:off/);
  // narrow width must not crash and keeps the mode chip (load-bearing)
  const narrow = strip(statusLines({ ...BASE, tools: false }, 40, "none").join("\n"));
  assert.ok(narrow.length > 0);
});

// ── CLI-052: the context-usage meter ────────────────────────────────────────────
test("contextMeterSegment: k-format + floored-percent → warn/danger roles (CLI-052)", () => {
  const seg = (used: number, window?: number) =>
    contextMeterSegment({ ...BASE, ctxUsage: { used, window, estimated: false } });
  assert.equal(seg(12300, 131072)?.text, "⎋ 12.3k/131k (9%)");
  assert.equal(seg(1000, 10000)?.role, "muted"); // 10%
  assert.equal(seg(8000, 10000)?.role, "warn"); // 80%
  assert.equal(seg(9499, 10000)?.role, "warn"); // 94%
  assert.equal(seg(9600, 10000)?.role, "danger"); // 96%
});

test("contextMeterSegment: `~` estimate marker + unknown window (no percent) + empty → null (CLI-052)", () => {
  assert.equal(
    contextMeterSegment({ ...BASE, ctxUsage: { used: 12300, window: 131072, estimated: true } })
      ?.text,
    "⎋ ~12.3k/131k (9%)",
  );
  const unknown = contextMeterSegment({ ...BASE, ctxUsage: { used: 12300, estimated: true } });
  assert.equal(unknown?.text, "⎋ ~12.3k used"); // no percent, no divide-by-undefined
  assert.equal(unknown?.role, "muted");
  assert.equal(
    contextMeterSegment({ ...BASE, ctxUsage: { used: 0, window: 100, estimated: true } }),
    null,
  );
  assert.equal(contextMeterSegment(BASE), null); // no ctxUsage → no meter
});

test("statusLines: meter text changes as usage grows; unknown model → no percent, no crash (CLI-052)", () => {
  const line = (used: number, window?: number) =>
    strip(
      statusLines({ ...BASE, ctxUsage: { used, window, estimated: true } }, 120, "none")[0] ?? "",
    );
  const small = line(5000, 131072);
  const big = line(50000, 131072);
  assert.match(small, /~5\.0k\/131k \(3%\)/);
  assert.match(big, /~50\.0k\/131k \(38%\)/);
  assert.notEqual(small, big);
  assert.match(line(5000, undefined), /~5\.0k used/); // unknown window, no crash
});

test("statusLines: width sweep 5..200 — bar never exceeds width; ⎋ width is 1 (CLI-052)", () => {
  assert.equal(stringWidth("⎋"), 1); // guard against a wcwidth misclassification corrupting justify
  for (let w = 5; w <= 200; w++) {
    const bar = statusLines(
      { ...BASE, ctxUsage: { used: 12300, window: 131072, estimated: true } },
      w,
      "none",
    )[0];
    assert.ok(stringWidth(strip(bar ?? "")) <= w, `width ${w}: bar exceeds ${w}`);
  }
});

// ── CLI-089: the live per-turn cost ticker ───────────────────────────────────────
test("costMeterSegment: priced model → `~$U.UU · Nk tok`; local $0 → tokens only (CLI-089)", () => {
  const priced = costMeterSegment({ ...BASE, cost: { estTokens: 4200, estUsd: 0.12 } });
  assert.equal(priced?.text, "~$0.12 · 4.2k tok");
  assert.equal(priced?.role, "muted");
  // local model (cost 0) → show the token count, suppress a meaningless $0.00
  const local = costMeterSegment({ ...BASE, cost: { estTokens: 4200, estUsd: 0 } });
  assert.equal(local?.text, "4.2k tok");
});

test("costMeterSegment: omitted when no cost data / zero tokens (never `$0.00`) (CLI-089)", () => {
  assert.equal(costMeterSegment(BASE), null); // no cost field → no chip
  assert.equal(costMeterSegment({ ...BASE, cost: { estTokens: 0, estUsd: 0 } }), null); // pre-first-turn
});

test("costMeterSegment: a sub-cent priced cost (0<usd<0.005) shows tokens-only, never `~$0.00`", () => {
  const subCent = costMeterSegment({ ...BASE, cost: { estTokens: 1100, estUsd: 0.0045 } });
  assert.equal(subCent?.text, "1.1k tok"); // rounds to $0.00 → suppress the $ segment
  assert.ok(!(subCent?.text ?? "").includes("$0.00"));
  // just at the display threshold: 0.005 rounds to $0.01 → shown.
  const cent = costMeterSegment({ ...BASE, cost: { estTokens: 1100, estUsd: 0.005 } });
  assert.equal(cent?.text, "~$0.01 · 1.1k tok");
});

test("statusLines: cost chip appears with data, absent without; refreshes with the number (CLI-089)", () => {
  const withCost = strip(
    statusLines({ ...BASE, cost: { estTokens: 4200, estUsd: 0.12 } }, 120, "none")[0] ?? "",
  );
  assert.match(withCost, /~\$0\.12 · 4\.2k tok/);
  const grown = strip(
    statusLines({ ...BASE, cost: { estTokens: 42000, estUsd: 1.2 } }, 120, "none")[0] ?? "",
  );
  assert.match(grown, /~\$1\.20 · 42\.0k tok/);
  assert.notEqual(withCost, grown); // ticks up per turn
  const withoutCost = strip(statusLines(BASE, 120, "none")[0] ?? "");
  assert.doesNotMatch(withoutCost, /tok/); // omitted entirely when unpriced
});

test("statusLines: cost chip width sweep 5..200 — bar never exceeds width (CLI-089)", () => {
  for (let w = 5; w <= 200; w++) {
    const bar = statusLines({ ...BASE, cost: { estTokens: 42000, estUsd: 1.23 } }, w, "none")[0];
    assert.ok(stringWidth(strip(bar ?? "")) <= w, `width ${w}: cost bar exceeds ${w}`);
  }
});

/* ── the composer-border effort badge ───────────────────────────────────────── */

test("effortBadge names the unavailable case instead of showing an inert tier", () => {
  // Showing `effort: high` on a model that will ignore it is the exact misreport the
  // whole feature exists to remove, so the unusable case must read as unusable.
  assert.equal(
    effortBadge({ ...BASE, effort: { tier: "high", available: false, degraded: true } }),
    "effort: not available",
  );
});

test("effortBadge shows the APPLIED tier and never a degradation marker", () => {
  assert.equal(
    effortBadge({ ...BASE, effort: { tier: "high", available: true, degraded: false } }),
    "effort: high",
  );
  // A clamped/emulated tier reads identically. `~` already means "estimated" on this same
  // chrome (`~12.3k` context, `~$0.12` cost), so a second meaning would be ambiguous; the
  // warn tint carries it instead, and `/effort` spells it out.
  assert.equal(
    effortBadge({ ...BASE, effort: { tier: "high", available: true, degraded: true } }),
    "effort: high",
  );
  // and nothing in the badge may contain a tilde at all
  for (const degraded of [true, false]) {
    const badge = effortBadge({ ...BASE, effort: { tier: "max", available: true, degraded } });
    assert.equal(badge?.includes("~"), false);
  }
});

test("effortBadge is absent before an endpoint is bound", () => {
  assert.equal(effortBadge(BASE), undefined);
});

test("the effort badge does NOT leak into the status bar", () => {
  // It belongs in the composer border; the bar is already dense and a chip there is easy
  // to miss at the moment it matters (the turn right after switching models).
  const withEffort = statusLines(
    { ...BASE, effort: { tier: "high", available: false, degraded: true } },
    80,
    "none",
  ).join("\n");
  assert.equal(withEffort.includes("effort"), false);
  assert.equal(withEffort, statusLines(BASE, 80, "none").join("\n"));
});

/* ── the model trait strip ──────────────────────────────────────────────────*/

const THINKER: StatusModel = {
  ...BASE,
  effort: { tier: "high", available: true, degraded: false },
};

test("modelTraits: capabilities first, the one CONTROL last", () => {
  // Properties on the left, the dial on the right. That ordering is what makes the strip read
  // as "here is the model, and here is your knob" instead of an undifferentiated chip soup.
  assert.deepEqual(
    modelTraits({ ...THINKER, capabilities: ["completion", "vision", "tools", "thinking"] }),
    ["completion", "vision", "tools", "thinking", "effort: high"],
  );
});

test("modelTraits: the runner's own order is preserved, not sorted", () => {
  // Ollama answers `/api/show` in a stable per-model order. Sorting would make the strip
  // reshuffle between models for no gain.
  assert.deepEqual(modelTraits({ ...THINKER, capabilities: ["thinking", "tools", "completion"] }), [
    "thinking",
    "tools",
    "completion",
    "effort: high",
  ]);
});

test("modelTraits: blanks and duplicates are dropped — a doubled chip reads as a bug", () => {
  assert.deepEqual(
    modelTraits({ ...THINKER, capabilities: ["tools", "", "  ", "tools", "thinking"] }),
    ["tools", "thinking", "effort: high"],
  );
});

test("modelTraits: no capabilities probed yet ⇒ the effort cell alone", () => {
  assert.deepEqual(modelTraits(THINKER), ["effort: high"]);
  assert.deepEqual(modelTraits(BASE), []);
});

test("effortBadge inlines the whole strip while it fits", () => {
  assert.equal(
    effortBadge({ ...THINKER, capabilities: ["completion", "tools"] }),
    "completion \u00b7 tools \u00b7 effort: high",
  );
});

test("effortBadge yields to the panel past the threshold, rather than being dropped whole", () => {
  // `inlayBadge` refuses to truncate (a half-shown `thinki` reads as a rendering bug), so a
  // strip that cannot fit would vanish silently. Returning undefined hands the decision to the
  // caller, which renders `capabilityPanel` instead.
  const many: StatusModel = {
    ...THINKER,
    capabilities: ["completion", "vision", "audio", "tools", "thinking"],
  };
  assert.equal(modelTraits(many).length > TRAIT_INLINE_MAX, true);
  assert.equal(effortBadge(many), undefined);
  // …and the last-resort rendering, for a terminal too short for the panel, is the dial alone.
  assert.equal(effortBadge(many, { traits: false }), "effort: high");
});

/** gemma4:12b's real capability list, as the live daemon reports it. */
const GEMMA4: StatusModel = {
  ...THINKER,
  capabilities: ["completion", "vision", "audio", "tools", "thinking"],
};
/** qwen3.6:latest's real capability list — an ODD trait count once effort joins. */
const QWEN36: StatusModel = {
  ...THINKER,
  capabilities: ["completion", "vision", "tools", "thinking"],
};

test("capabilityPanel: exactly two rows, tab-aligned, effort BOTTOM-RIGHT", () => {
  const rows = capabilityPanel(GEMMA4, 76);
  assert.ok(rows);
  assert.equal(rows?.length, 2);
  assert.match(rows?.[0] ?? "", /^completion\s+vision\s+audio$/);
  assert.match(rows?.[1] ?? "", /^tools\s+thinking\s+effort: high$/);
});

test("capabilityPanel: an odd trait count pads BEFORE the dial, so it stays bottom-right", () => {
  // Five traits ⇒ one empty cell. It must be the one to the LEFT of the effort cell: a control
  // that wanders with the capability count is harder to find than one that is always in the
  // same corner.
  const rows = capabilityPanel(QWEN36, 76);
  assert.equal(rows?.length, 2);
  assert.match(rows?.[0] ?? "", /^completion\s+vision\s+tools$/);
  assert.match(rows?.[1] ?? "", /^thinking\s+effort: high$/);
  // the gap before `effort:` proves the padding went in front of it, not after.
  assert.ok((rows?.[1]?.indexOf("effort:") ?? 0) > "thinking".length + 1);
});

test("capabilityPanel: columns line up across BOTH rows", () => {
  const rows = capabilityPanel(GEMMA4, 76);
  // `vision` (row 0, col 1) and `thinking` (row 1, col 1) must start at the same column.
  assert.equal((rows?.[0] ?? "").indexOf("vision"), (rows?.[1] ?? "").indexOf("thinking"));
});

test("capabilityPanel: null below the threshold — the inline strip owns that case", () => {
  assert.equal(capabilityPanel({ ...THINKER, capabilities: ["tools"] }, 76), null);
  assert.equal(capabilityPanel(BASE, 76), null);
});

test("capabilityPanel: null when the grid cannot be legible — never a clipped cell", () => {
  // A truncated `thinki` reads as a rendering bug, not as information, so a width that cannot
  // hold the widest cell whole declines entirely and lets the caller fall back.
  assert.equal(capabilityPanel(GEMMA4, 20), null);
});

test("capabilityPanel: no row ever exceeds the width it was given", () => {
  for (const inner of [40, 56, 76, 100, 200]) {
    for (const row of capabilityPanel(GEMMA4, inner) ?? []) {
      assert.ok(stringWidth(row) <= inner, `width ${inner}: row overflowed`);
    }
  }
});

test("the rail-fit predicate is the same answer the painter gives", () => {
  /**
   * ⌃T enters a MODAL focus in which every key that is not an arrow, esc, ⌃T or ⌃C is swallowed.
   * Its entry guard only asked whether there were cells at all — never whether the rail is on
   * screen — while `traitRailLine` returns null whenever the rail does not fit, which on a narrow
   * terminal it does not (the standard rail is ~35-38 columns against a budget of cols-5). The
   * result was a composer that looked completely normal, with no rail, no focus ring and no hint
   * row, in which every printable key, Enter, Backspace and ⌃D did nothing. The user reads that
   * as a frozen terminal.
   *
   * One predicate backs both, so the key that ENTERS the mode and the code that PAINTS it cannot
   * disagree about whether the rail is there.
   */
  const cells = traitCells({
    ...BASE,
    capabilities: ["completion", "vision", "tools", "thinking"],
    effort: { tier: "high", available: true },
  } as never);
  assert.ok(cells.length > 0, "precondition: the model produced a rail");

  const wide = 200;
  const narrow = 4;
  assert.equal(traitRailFits(cells, wide), true);
  assert.equal(traitRailFits(cells, narrow), false);

  // the painter must agree at BOTH widths — that agreement is the whole point
  assert.notEqual(traitRailLine(cells, null, wide, "none"), null);
  assert.equal(traitRailLine(cells, null, narrow, "none"), null);

  // an empty rail never fits, so ⌃T falls back to its blind flip rather than trapping the user
  assert.equal(traitRailFits([], wide), false);
  assert.equal(traitRailLine([], null, wide, "none"), null);
});
