/**
 * model-admission.test.ts — the two rules, and what a refusal owes the user.
 *
 * Written against this machine's real numbers (64 GB, qwen3.6 23.94 GB, gemma4:12b 7.56 GB) so
 * the scenarios are ones that actually occur rather than round invented ones.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ModelCandidate,
  admitModelLoad,
  affordableModels,
  reclaimableBytes,
  renderRefusal,
} from "./model-admission.js";
import { type MemoryBudget, parseKvGeometry } from "./model-footprint.js";

const GIB = 1024 ** 3;

const QWEN_INFO: Record<string, unknown> = {
  "qwen35moe.attention.head_count_kv": Array.from({ length: 40 }, (_, i) =>
    (i + 1) % 4 === 0 ? 2 : 0,
  ),
  "qwen35moe.attention.key_length": 256,
  "qwen35moe.attention.value_length": 256,
};

const qwen: ModelCandidate = {
  id: "qwen3.6:latest",
  weightsBytes: 23.94e9,
  contextTokens: 262144,
  geometry: parseKvGeometry(QWEN_INFO),
  runner: "ollama",
};
/** gemma4:12b — 5 of every 6 layers windowed at 1024, which is what keeps its cache small. */
const GEMMA_INFO: Record<string, unknown> = {
  "gemma4.attention.head_count_kv": Array.from({ length: 48 }, (_, i) =>
    (i + 1) % 6 === 0 ? 1 : 8,
  ),
  "gemma4.attention.key_length": 256,
  "gemma4.attention.value_length": 256,
  "gemma4.attention.sliding_window": 1024,
  "gemma4.attention.sliding_window_pattern": Array.from(
    { length: 48 },
    (_, i) => (i + 1) % 6 !== 0,
  ),
};

const gemma: ModelCandidate = {
  id: "gemma4:12b",
  weightsBytes: 7.56e9,
  contextTokens: 262144,
  geometry: parseKvGeometry(GEMMA_INFO),
  runner: "ollama",
};

const budget = (availableGiB: number, headroomGiB = 6): MemoryBudget => ({
  totalBytes: 64 * GIB,
  availableBytes: availableGiB * GIB,
  headroomBytes: headroomGiB * GIB,
});

test("a model that fits is admitted, with the spare room reported", () => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(55) });
  assert.equal(d.ok, true);
  assert.ok(d.ok && d.spareBytes > 0);
  assert.equal(d.ok && d.footprint.source, "computed");
});

test("a model that does not fit is refused, naming the shortfall in plain units", () => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(12), alternatives: [qwen, gemma] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "too-big");
  assert.match(d.reason, /qwen3\.6:latest needs about/);
  assert.match(d.reason, /of weights plus/, "the breakdown says WHERE the memory goes");
  assert.match(d.reason, /262,144 tokens/, "and at what context");
  assert.match(d.reason, /more than is free/);
  assert.ok(d.shortfallBytes > 0);
});

test("a refusal LISTS what fits — the answer to 'then what can I run?'", () => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(20), alternatives: [qwen, gemma] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  const out = renderRefusal(d).join("\n");
  assert.match(out, /Models that fit right now:/);
  assert.match(out, /gemma4:12b/);
  assert.match(out, /too large: qwen3\.6:latest/, "the one that does not fit is still shown");
  assert.match(out, /\/context window/, "and the knob that would shrink the cache");
});

test("when nothing fits, it says so instead of printing an empty list", () => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(8), alternatives: [qwen, gemma] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.match(renderRefusal(d).join("\n"), /Nothing installed fits/);
});

test("ONE SERVER: a second runner is refused even when the model itself would fit", () => {
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: budget(55),
    resident: [{ runner: "ollama", models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }] }],
    alternatives: [gemma],
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "second-server");
  assert.match(d.reason, /ollama is already serving a model/);
  assert.match(d.reason, /one model server running at a time/);
});

test("…but an explicit opt-in allows it", () => {
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: budget(55),
    resident: [{ runner: "ollama", models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }] }],
    allowSecondServer: true,
  });
  assert.equal(d.ok, true);
});

test("swapping models on the SAME runner counts the evicted one as reclaimable", () => {
  // The machine has 20 GiB free with qwen (26 GB) resident. Loading gemma must succeed: ollama
  // evicts qwen first. Refusing here would refuse every swap on a machine sized for one model.
  const d = admitModelLoad({
    candidate: gemma,
    budget: budget(20),
    resident: [{ runner: "ollama", models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }] }],
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.ok ? d.evicting : [], ["qwen3.6:latest"], "and it says what it will evict");
});

test("reclaimable memory is same-runner only — another runner's RAM is not ours to plan with", () => {
  const resident = [
    { runner: "ollama", models: [{ id: "a", sizeBytes: 10e9 }] },
    { runner: "lmstudio", models: [{ id: "b", sizeBytes: 5e9 }] },
  ];
  assert.equal(reclaimableBytes(resident, "ollama"), 10e9);
  assert.equal(reclaimableBytes(resident, "lmstudio"), 5e9);
  assert.equal(reclaimableBytes(resident, "vllm"), 0);
  assert.equal(reclaimableBytes(undefined, "ollama"), 0);
});

test("the affordable list is biggest-first, and keeps the ones that do not fit", () => {
  const list = affordableModels([gemma, qwen], budget(20));
  assert.equal(list.length, 2, "a model that does not fit is shown, not hidden");
  assert.equal(list[0]?.candidate.id, "gemma4:12b", "fitting models come first");
  assert.equal(list[0]?.fits, true);
  assert.equal(list[1]?.fits, false);
  assert.ok((list[1]?.spareBytes ?? 0) < 0, "a shortfall is a negative spare");
});

test("the budget's host is used verbatim — a remote model is never judged by local RAM", () => {
  const remote: MemoryBudget = {
    totalBytes: 24 * GIB,
    availableBytes: 20 * GIB,
    headroomBytes: 4 * GIB,
    host: "gpu-box.lan",
  };
  const d = admitModelLoad({ candidate: qwen, budget: remote, alternatives: [gemma] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.match(d.reason, /on gpu-box\.lan/, "the refusal names WHICH machine ran out");
});

test("a second-server refusal on a remote host names that host too", () => {
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: {
      totalBytes: 64 * GIB,
      availableBytes: 60 * GIB,
      headroomBytes: 4 * GIB,
      host: "gpu-box.lan",
    },
    resident: [{ runner: "ollama", models: [{ id: "x", sizeBytes: 1e9 }] }],
  });
  assert.equal(d.ok === false && /on gpu-box\.lan/.test(d.reason), true);
});

test("an idle runner with no models loaded is not 'already serving'", () => {
  // A daemon that is up but holding nothing costs no weights, so it must not block a load.
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: budget(55),
    resident: [{ runner: "ollama", models: [] }],
  });
  assert.equal(d.ok, true);
});

/* ── LAYOUT ─────────────────────────────────────────────────────────────────────────────────
 *
 * A refusal arrives unasked-for and gets about a second of attention, so its shape has to do
 * the work reading would otherwise have to. What was there before was one long string plus
 * `id  —  size  (note)` rows: the terminal wrapped the paragraph at whatever column it happened
 * to be, mid-word and with no indent, and every row put its size at a different x — defeating
 * the one comparison the list exists to support.
 *
 * None of that is visible to a test that only greps for phrases, which is why these measure
 * columns instead of words.
 */

/** The refusal used for the layout tests: the one that also carries the figures table. */
const refused = (avail: number, alts: ModelCandidate[] = [qwen, gemma]) => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(avail), alternatives: alts });
  if (d.ok) throw new Error("expected a refusal");
  return d;
};

test("`reason` is exactly headline + detail — the prose is not a third, drifting wording", () => {
  // Two fields and a joined string is three chances to say it differently. It must stay one.
  const d = refused(12);
  assert.equal(d.reason, [d.headline, ...d.detail].join(" "));
  assert.ok(!d.headline.includes("\n"), "a headline is one line by definition");
  assert.ok(d.detail.length > 0, "and the explanation survives into the prose form");
});

test("prose is wrapped to the width it was given, at spaces, and stays wrapped when narrow", () => {
  for (const width of [52, 60, 76, 96]) {
    const lines = renderRefusal(refused(12), { width });
    // Only the prose is width-bound: a column row is as wide as its content needs and is never
    // broken, because a wrapped column is worse than a wide one.
    const prose = lines.filter((l) => l !== "" && !/^ {4}/.test(l));
    for (const line of prose) {
      assert.ok(line.length <= width, `at width ${width}, ${line.length} cols: ${line}`);
    }
    assert.ok(
      prose.some((l) => l.length > width - 24),
      `at width ${width} the text should USE the width, not wrap at some fixed 40 columns`,
    );
  }
});

test("a narrow terminal produces more lines, not truncated ones", () => {
  const wide = renderRefusal(refused(12), { width: 96 });
  const narrow = renderRefusal(refused(12), { width: 52 });
  assert.ok(narrow.length > wide.length, "narrower means more lines");
  // Nothing is dropped: the same words come out either way.
  const words = (ls: string[]) => ls.join(" ").split(/\s+/).filter(Boolean).join(" ");
  assert.equal(words(narrow), words(wide));
});

test("the models that fit are a COLUMN — every size ends at the same x", () => {
  // The reason this is a test and not a comment: `id  —  size` looks fine in any one example
  // and only falls apart across rows, which is exactly where the eye needs it to hold.
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: budget(55),
    resident: [{ runner: "ollama", models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }] }],
    alternatives: [qwen, gemma],
  });
  if (d.ok) throw new Error("expected a refusal");
  const lines = renderRefusal(d);
  const at = lines.indexOf("Models that fit right now:");
  assert.ok(at >= 0, "the list is still headed");
  const rows = lines.slice(at + 1).filter((l) => /^ {4}\S/.test(l) && !/too large:/.test(l));
  assert.ok(rows.length >= 2, "two rows of different lengths are the whole point");

  const ends = rows.map((row) => {
    const m = /^ {4}(\S+) +([\d.,]+ [KMGT]?B(?:–[\d.,]+ [KMGT]?B)?)/.exec(row);
    assert.ok(m, `row is not id + size: ${JSON.stringify(row)}`);
    return {
      nameAt: row.indexOf(m[1] as string),
      sizeEnd: row.indexOf(m[2] as string) + (m[2] as string).length,
    };
  });
  assert.equal(new Set(ends.map((e) => e.nameAt)).size, 1, "names start at one column");
  assert.equal(new Set(ends.map((e) => e.sizeEnd)).size, 1, "and sizes END at one column");
});

test("the too-big block shows all THREE addends, a rule, and what is free", () => {
  // Weights + cache under a total they do not add up to reads as an arithmetic error. The
  // missing term is the runner's own process, which is the one a user cannot guess from a name.
  const out = renderRefusal(refused(12)).join("\n");
  assert.match(out, /^ {4}\s*\S+ GB {3}weights$/m);
  assert.match(out, /^ {4}\s*\S+ GB {3}context cache at 262,144 tokens$/m);
  assert.match(out, /^ {4}\s*\S+ GB {3}compute buffers and the runner itself$/m);
  assert.match(out, /^ {4}─+$/m, "a rule separates the addends from the total");
  assert.match(out, /needed in total/);
  assert.match(out, /free right now/);
});

test("the figures come from the decision, so the table cannot drift from the verdict", () => {
  const d = refused(12);
  // usable = what it needed, less what it was short by. Derived, never re-measured.
  assert.equal(d.usableBytes, d.footprint.totalBytes - d.shortfallBytes);
});

test("the third addend is the RESIDUAL, so the column adds up on a MEASURED footprint too", () => {
  // `overheadBytes` is 0 on a measured footprint while `kvBytes` is real — printing it would
  // put three figures under a rule that visibly do not reach the total above them. A table
  // whose arithmetic is wrong discredits the numbers in it that are right.
  const measured: ModelCandidate = {
    ...qwen,
    // One row that knows BOTH the whole and the cache — an `/api/ps` total folded together with
    // the log's own `llama_kv_cache: size` line. That combination is what zeroes `overheadBytes`.
    observations: [
      {
        model: "qwen3.6:latest",
        contextTokens: 262144,
        totalBytes: 28.5e9,
        kvBytes: 2.85e9,
        observedAt: new Date().toISOString(),
        via: "api-ps",
      },
    ],
  };
  const d = admitModelLoad({ candidate: measured, budget: budget(12), alternatives: [gemma] });
  if (d.ok) throw new Error("expected a refusal");
  assert.equal(d.footprint.source, "measured");
  assert.equal(d.footprint.overheadBytes, 0, "the precondition this test exists for");

  // Read the printed column back by LABEL, not by position — a table that adds up in the right
  // order but prints the rows in the wrong one would still be wrong.
  const rows = new Map<string, number>();
  for (const l of renderRefusal(d)) {
    const m = /^ {4}\s*([\d.,]+) ([KMGT]?B) {3}(.+)$/.exec(l);
    if (m)
      rows.set(
        m[3] as string,
        Number((m[1] as string).replace(/,/g, "")) * (m[2] === "GB" ? 1 : 1 / 1024),
      );
  }
  const w = rows.get("weights") as number;
  const kv = rows.get("context cache at 262,144 tokens") as number;
  const other = rows.get("compute buffers and the runner itself") as number;
  const total = rows.get("needed in total (measured)") as number;
  for (const [name, v] of [
    ["weights", w],
    ["cache", kv],
    ["buffers", other],
    ["total", total],
  ] as const) {
    assert.equal(typeof v, "number", `the ${name} row is missing from the table`);
  }
  // One decimal per row ⇒ at most 0.05 of rounding slack each, so the column ties AS PRINTED.
  // This is the whole reason the table does not use `humanBytes`, which drops the decimal above
  // 10 and would print `22 GB + 2.7 GB + 1.6 GB` ruled into a total of `27 GB`.
  assert.ok(
    Math.abs(w + kv + other - total) < 0.2,
    `the printed column does not add up: ${w} + ${kv} + ${other} ≠ ${total}`,
  );
});

test("a second-server refusal gets no figures table — its problem is not size", () => {
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: budget(55),
    resident: [{ runner: "ollama", models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }] }],
    alternatives: [gemma],
  });
  if (d.ok) throw new Error("expected a refusal");
  const out = renderRefusal(d).join("\n");
  assert.doesNotMatch(out, /needed in total/, "gemma4:12b fits fine; printing its size misleads");
  assert.doesNotMatch(out, /\/context window/, "and a smaller context would not help either");
  assert.match(out, /one model server running at a time/, "the explanation is still there");
});
