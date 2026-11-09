// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * model-browser.test.ts — the full-screen `/model` picker: layout fits every terminal size it
 * accepts, the keys move where disk_space's do, and the ONLY output is a command line to submit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { KeyEvent } from "./keys.js";
import {
  type BrowserData,
  type BrowserItem,
  browserFits,
  onBrowserKey,
  openBrowser,
  renderBrowser,
  visibleItems,
} from "./model-browser.js";
import { stringWidth } from "./width.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function item(over: Partial<BrowserItem> & { key: string }): BrowserItem {
  return {
    label: over.key,
    lines: ["first line about the model", "second line with its limits"],
    badge: "fits",
    need: "8 GB",
    runner: "Ollama",
    submit: `/models use local:${over.key}`,
    search: over.key,
    sort: { ramGb: 8, name: over.key, released: "2026-01", paramsB: 8 },
    ram: { needGb: 8, totalGb: 36 },
    details: () => ["publisher · 8B · 128K context", { text: "✓ runs here", role: "traitOn" }],
    ...over,
  };
}

function data(): BrowserData {
  const fits = [
    item({
      key: "small-a",
      sort: { ramGb: 4, name: "small-a", released: "2025-01", paramsB: 3 },
      traits: ["coding"],
    }),
    item({
      key: "mid-b",
      sort: { ramGb: 16, name: "mid-b", released: "2026-05", paramsB: 14 },
      traits: ["tools"],
    }),
  ];
  const big = item({
    key: "huge-c",
    badge: "too-big",
    need: "512 GB",
    runner: "AirLLM?",
    submit: undefined,
    disabled: "Too big for this machine: needs about 512 GB of RAM, 36 GB here.",
    insist: {
      submit: "/models use local:huge-c@airllm",
      runtime: "AirLLM",
      speed: "minutes per token",
    },
    sort: { ramGb: 512, name: "huge-c", released: "2026-02", paramsB: 400 },
    ram: { needGb: 512, totalGb: 36 },
  });
  return {
    machine: "36 GB unified (Apple Silicon) · 400 GB free disk",
    server: "default server: Ollama · running",
    ram: { totalGb: 36, freeGb: 20, budgetGb: 30 },
    layers: [
      { id: "serving", label: "Serving now", depth: 0, items: [], empty: "nothing serving" },
      { id: "fits", label: "Fits this machine", depth: 0, items: fits },
      { id: "local", label: "All local models", depth: 0, items: [...fits, big] },
      {
        id: "tier:datacenter",
        label: "Datacenter",
        depth: 1,
        items: [big],
        note: "384 GB – 2 TB RAM",
      },
      {
        id: "servers",
        label: "Model servers",
        depth: 0,
        items: [
          item({ key: "lmstudio", badge: "server", submit: "/server lmstudio", ram: undefined }),
        ],
      },
    ],
    start: "fits",
  };
}

const k = (name: KeyEvent["name"], ch?: string): KeyEvent => (ch ? { name, ch } : { name });
const press = (s: ReturnType<typeof openBrowser>, ...keys: KeyEvent[]) => {
  let st = s;
  let last: ReturnType<typeof onBrowserKey>["action"] = { type: "none" };
  for (const key of keys) {
    const r = onBrowserKey(st, key);
    st = r.state;
    last = r.action;
  }
  return { st, last };
};

test("renders exactly `rows` lines, none wider than cols−1, at every size it accepts and in every colour depth", () => {
  for (const [cols, rows] of [
    [72, 18],
    [80, 24],
    [120, 40],
    [160, 50],
    [220, 60],
  ] as const) {
    for (const caps of ["truecolor", "ansi256", "ansi16", "none"] as const) {
      for (const zoom of [false, true]) {
        const st = { ...openBrowser(data()), zoom };
        const lines = renderBrowser(st, cols, rows, caps);
        assert.equal(lines.length, rows, `${cols}x${rows} ${caps}`);
        for (const l of lines) {
          assert.ok(stringWidth(strip(l)) <= cols - 1, `${cols}x${rows} ${caps}: "${strip(l)}"`);
        }
      }
    }
  }
  assert.equal(browserFits(71, 30), false);
  assert.equal(browserFits(80, 24), true);
});

test("opens on the start layer; the wide layout shows layers, the models with two lines each, and details", () => {
  const st = openBrowser(data());
  assert.equal(st.data.layers[st.layer]?.id, "fits");
  const screen = renderBrowser(st, 180, 40, "none").map(strip).join("\n");
  assert.match(screen, /Layers/);
  assert.match(screen, /Fits this machine/);
  assert.match(screen, /first line about the model/);
  assert.match(screen, /second line with its limits/);
  assert.match(screen, /Details/);
  assert.match(screen, /36 GB RAM · 20 GB free now/);
  assert.match(screen, /default server: Ollama/);
});

test("Enter on a runnable row submits its command; Enter on a too-big row does nothing and says why", () => {
  const st = openBrowser(data());
  const { last } = press(st, k("enter"));
  assert.deepEqual(last, { type: "pick", text: "/models use local:small-a" });
  // the All layer, sorted by RAM: small-a, mid-b, huge-c
  const { st: onBig, last: none } = press(
    st,
    k("left"),
    k("down"),
    k("right"),
    k("end"),
    k("enter"),
  );
  assert.equal(onBig.data.layers[onBig.layer]?.id, "local");
  assert.equal(none.type, "none");
  assert.match(onBig.message?.text ?? "", /Too big .* Press ! to run it anyway via AirLLM/);
});

test("! on a too-big row submits the streaming ref; on a fitting row it explains there is no need", () => {
  const st = openBrowser(data());
  const fit = press(st, k("char", "!"));
  assert.equal(fit.last.type, "none");
  assert.match(fit.st.message?.text ?? "", /already runs here/);
  const all = press(st, k("left"), k("down"), k("right"), k("end"), k("char", "!"));
  assert.deepEqual(all.last, { type: "pick", text: "/models use local:huge-c@airllm" });
});

test("layers: ←/→ move focus, ↑/↓ move layer, Tab jumps to the next layer, Esc steps back then closes", () => {
  const st = openBrowser(data());
  const a = press(st, k("left"));
  assert.equal(a.st.focus, "layers");
  const b = press(a.st, k("down"));
  assert.equal(b.st.data.layers[b.st.layer]?.id, "local");
  const c = press(b.st, k("tab"));
  assert.equal(c.st.focus, "list");
  const d = press(c.st, k("tab"));
  assert.equal(d.st.data.layers[d.st.layer]?.id, "tier:datacenter");
  const e = press(d.st, k("esc"));
  assert.equal(e.st.focus, "layers");
  assert.deepEqual(press(e.st, k("esc")).last, { type: "close" });
  assert.deepEqual(press(st, k("char", "q")).last, { type: "close" });
  assert.deepEqual(press(st, k("ctrl-c")).last, { type: "close" });
});

test("/ filters, c cycles a capability, f keeps runnable rows only, s cycles the sort", () => {
  const all = press(openBrowser(data()), k("left"), k("down"), k("right")).st;
  assert.equal(visibleItems(all).length, 3);
  const q = press(
    all,
    k("char", "/"),
    k("char", "m"),
    k("char", "i"),
    k("char", "d"),
    k("enter"),
  ).st;
  assert.equal(q.editing, false);
  assert.deepEqual(
    visibleItems(q).map((i) => i.key),
    ["mid-b"],
  );
  const cleared = press(q, k("esc")).st;
  assert.equal(cleared.query, "");
  const coding = press(cleared, k("char", "c")).st;
  assert.equal(coding.trait, "coding");
  assert.deepEqual(
    visibleItems(coding).map((i) => i.key),
    ["small-a"],
  );
  const fitsOnly = press(cleared, k("char", "f")).st;
  assert.ok(!visibleItems(fitsOnly).some((i) => i.badge === "too-big"));
  const newest = press(cleared, k("char", "s"), k("char", "s")).st;
  assert.equal(newest.sort, "new");
  assert.equal(visibleItems(newest)[0]?.key, "mid-b");
  // an empty result says how to get rows back
  const none = press(all, k("char", "/"), k("char", "z"), k("char", "z"), k("enter")).st;
  assert.match(
    renderBrowser(none, 120, 30, "none").map(strip).join("\n"),
    /No model matches these filters/,
  );
});

test("a narrow terminal hides the layers pane but ← still reaches the layers; i zooms the details", () => {
  const st = openBrowser(data());
  const narrow = renderBrowser(st, 80, 24, "none").map(strip).join("\n");
  assert.doesNotMatch(narrow, /Layers/);
  assert.match(narrow, /← → layers/);
  // and they DO switch layers there — → used to submit the highlighted model
  const right = onBrowserKey(st, k("right"), 80);
  assert.equal(right.action.type, "none");
  assert.notEqual(right.state.layer, st.layer);
  assert.equal(onBrowserKey(right.state, k("left"), 80).state.layer, st.layer);
  const z = press(st, k("char", "i")).st;
  assert.match(renderBrowser(z, 80, 24, "none").map(strip).join("\n"), /i \/ Esc back/);
  assert.equal(press(z, k("esc")).st.zoom, false);
});

test("the layer marker never eats a label's first letter; monochrome selection keeps the right column", () => {
  const st = openBrowser(data());
  const screen = renderBrowser(st, 180, 40, "none").map(strip).join("\n");
  assert.match(screen, /▸Fits this machine/);
  assert.match(screen, /›✓ small-a/);
  assert.match(screen, /Ollama/, "the runner column of the highlighted row is not clipped");
  const layers = press(st, k("left")).st;
  assert.match(renderBrowser(layers, 180, 40, "none").map(strip).join("\n"), /›Fits this machine/);
});
