/**
 * status.test.ts — justified status bar, mode-indicator line, composer hint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type StatusModel,
  composerHint,
  contextMeterSegment,
  costMeterSegment,
  justify,
  statusLines,
} from "./status.js";
import { stringWidth } from "./width.js";

const BASE: StatusModel = {
  permMode: "default",
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
    [{ text: "[PROM:DEFAULT]", role: "muted" }],
    [
      { text: "modelnamelong", role: "muted" },
      { text: "/default", role: "modelOpen" },
      { text: "~/very/long/path", role: "muted" },
    ],
    24,
    "none",
  );
  assert.ok(strip(line).length <= 24);
  assert.ok(strip(line).includes("[PROM:DEFAULT]")); // left is load-bearing, kept
});

test("default mode: bar + hint only (no indicator line)", () => {
  const lines = statusLines(BASE, 60, "none");
  assert.equal(lines.length, 2); // bar + hint
  assert.match(lines[0] ?? "", /\[PROM:DEFAULT\]/);
  assert.match(lines[0] ?? "", /\/default/); // profile chip
  assert.match(lines[1] ?? "", /commands/); // hint
});

test("bypass mode: indicator line shows the exact bypass text", () => {
  const lines = statusLines({ ...BASE, permMode: "bypassPermissions" }, 60, "none");
  assert.equal(lines.length, 3); // bar + indicator + hint
  assert.match(lines[0] ?? "", /\[PROM:BYPASS-PERMISSIONS\]/);
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
  const local = statusLines(BASE, 60, "truecolor")[0] ?? "";
  const cloud =
    statusLines({ ...BASE, model: "opus", modelSource: "cloud" }, 60, "truecolor")[0] ?? "";
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
