/**
 * tokens.test.ts — `prometheus tokens` (toolkit proposals + tool detail + Gemini Nano).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { runTokens } from "./tokens.js";

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));

test("prometheus tokens: proposes the default toolkit (exit 0)", () => {
  const out = runTokens(ctxFor(["tokens"]));
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /Token-saving toolkit/);
});

test("prometheus tokens all --json: full menu includes experimental nano connector", () => {
  const out = runTokens(ctxFor(["tokens", "all", "--json"]));
  const j = out.json as { tools: { id: string }[] };
  assert.ok(j.tools.some((t) => t.id === "gemini-nano-chrome"));
  assert.ok(j.tools.some((t) => t.id === "terse-output"));
});

test("prometheus tokens <id>: tool detail renders install + tradeoff", () => {
  const out = runTokens(ctxFor(["tokens", "terse-output"]));
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /tradeoff/);
});

test("prometheus tokens nano: honest PARTIAL verdict, no weight extraction endorsed", () => {
  const out = runTokens(ctxFor(["tokens", "nano", "--json"]));
  const j = out.json as { geminiNano: { feasible: string; weightsRedistributable: boolean } };
  assert.equal(j.geminiNano.feasible, "partial");
  assert.equal(j.geminiNano.weightsRedistributable, false);
});

/* ── CLI-088: enable/disable + wiring + persistence ─────────────────────────────── */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tokenEconomy } from "@prometheus/core";

import { readTokenToggles, setTokenToggle } from "./token-toggles.js";

test("CLI-088 enable/disable persists; advisory warns; unknown id → exit 1 + suggestion", () => {
  const prev = process.env.HOME;
  const tmp = mkdtempSync(join(tmpdir(), "prom-tok-"));
  process.env.HOME = tmp; // configDir(homedir()) resolves under here → no real-config pollution
  try {
    const en = runTokens(ctxFor(["tokens", "enable", "terse-output"]));
    assert.equal(en.exitCode, 0);
    assert.equal(readTokenToggles()["terse-output"], true);

    const adv = runTokens(ctxFor(["tokens", "enable", "subagent-offloading"]));
    assert.equal(adv.exitCode, 0);
    assert.match(adv.text ?? "", /advisory/); // persisted but honestly labeled no-op
    assert.equal(readTokenToggles()["subagent-offloading"], true);

    const dis = runTokens(ctxFor(["tokens", "disable", "terse-output"]));
    assert.equal(dis.exitCode, 0);
    assert.equal(readTokenToggles()["terse-output"], false);

    const bad = runTokens(ctxFor(["tokens", "enable", "terse-outpt"]));
    assert.equal(bad.exitCode, 1);
    assert.match(bad.text ?? "", /unknown technique/);
    assert.match(bad.text ?? "", /did you mean 'terse-output'/);
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: restore env exactly
      delete process.env.HOME;
    } else {
      process.env.HOME = prev;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI-088 wiring: terse-output/prompt-caching wired, others advisory; list json carries enabled+wiring", () => {
  assert.equal(tokenEconomy.tokenWiring("terse-output"), "wired");
  assert.equal(tokenEconomy.tokenWiring("prompt-caching"), "wired");
  assert.equal(tokenEconomy.tokenWiring("subagent-offloading"), "advisory");
  const out = runTokens(ctxFor(["tokens", "all", "--json"]));
  const j = out.json as { tools: Array<{ id: string; enabled: boolean; wiring: string }> };
  const terse = j.tools.find((t) => t.id === "terse-output");
  assert.ok(terse);
  assert.equal(typeof terse?.enabled, "boolean");
  assert.equal(terse?.wiring, "wired");
});

test("CLI-088 persistence round-trips across a fresh read (restart-equivalent) on a temp home", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prom-tok2-"));
  try {
    setTokenToggle("terse-output", true, tmp);
    assert.equal(readTokenToggles(tmp)["terse-output"], true);
    setTokenToggle("terse-output", false, tmp);
    assert.equal(readTokenToggles(tmp)["terse-output"], false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* ── CLI-090: `prometheus tokens report` — measured effectiveness ──────────────────────── */

import { mkdirSync, writeFileSync } from "node:fs";

test("CLI-090 report --json: reads the session acct file → measured cache stats + raw counters", () => {
  const prev = process.env.PROMETHEUS_HOME;
  const tmp = mkdtempSync(join(tmpdir(), "prom-rep-"));
  process.env.PROMETHEUS_HOME = tmp; // prometheusHome() honors PROMETHEUS_HOME
  try {
    const dir = join(tmp, "sessions");
    mkdirSync(dir, { recursive: true });
    const recs = [
      {
        model: "claude-sonnet-4",
        endpointId: "anthropic",
        promptTokens: 1000,
        completionTokens: 200,
        estimated: false,
        atIso: "2026-07-18T00:00:00Z",
        cacheRead: 60000,
        cacheCreate: 5000,
      },
      {
        model: "claude-sonnet-4",
        endpointId: "anthropic",
        promptTokens: 900,
        completionTokens: 150,
        estimated: false,
        atIso: "2026-07-18T00:01:00Z",
        cacheRead: 40000,
      },
    ];
    writeFileSync(
      join(dir, "sess-A.acct.jsonl"),
      `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );

    const out = runTokens(ctxFor(["tokens", "report", "--json"]));
    assert.equal(out.exitCode, 0);
    const j = out.json as {
      ok: boolean;
      measurable: boolean;
      raw: { cacheRead: number; turns: number };
      techniques: Array<{ id: string; measured: boolean; cacheReadTokens?: number }>;
    };
    assert.equal(j.ok, true);
    assert.equal(j.measurable, true);
    assert.equal(j.raw.cacheRead, 100000);
    assert.equal(j.raw.turns, 2);
    const pc = j.techniques.find((t) => t.id === "prompt-caching");
    assert.equal(pc?.measured, true);
    assert.equal(pc?.cacheReadTokens, 100000);
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: restore env exactly
      delete process.env.PROMETHEUS_HOME;
    } else {
      process.env.PROMETHEUS_HOME = prev;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI-090 report: no accounting yet → advisory only, never a fabricated number", () => {
  const prev = process.env.PROMETHEUS_HOME;
  const tmp = mkdtempSync(join(tmpdir(), "prom-rep2-"));
  process.env.PROMETHEUS_HOME = tmp;
  try {
    const out = runTokens(ctxFor(["tokens", "report"]));
    assert.equal(out.exitCode, 0);
    assert.match(out.text ?? "", /advisory only|not available/);
    assert.doesNotMatch(out.text ?? "", /est saved ~\$/); // no measurement → no $ figure
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: restore env exactly
      delete process.env.PROMETHEUS_HOME;
    } else {
      process.env.PROMETHEUS_HOME = prev;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
