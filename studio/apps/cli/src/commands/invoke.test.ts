/**
 * invoke.test.ts — the /invoke repo-install picker (status marks + nemesis-gated dispatch).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { EngineClient } from "@prometheus/engine-bridge";

import { type InvokeDeps, runInvoke } from "./invoke.js";

const CATALOG = {
  ok: true,
  catalog: [
    {
      name: "alpha-tool",
      summary: "first",
      recommend_rank: 1,
      targets: { claude: { installed: false } },
    },
    {
      name: "beta-tool",
      summary: "second",
      recommend_rank: 2,
      targets: { claude: { installed: true } },
    },
    { name: "gamma-tool", summary: "third", targets: undefined },
  ],
};

function deps(
  over: Partial<InvokeDeps> & { answers?: string[] } = {},
): InvokeDeps & { out: string[]; installs: Array<[string, boolean]> } {
  const out: string[] = [];
  const installs: Array<[string, boolean]> = [];
  const answers = over.answers ?? [];
  let i = 0;
  return {
    client: { list: async () => CATALOG } as unknown as EngineClient,
    write: (l) => out.push(l),
    ask: async () => answers[i++] ?? "",
    confirm: async () => true,
    install: async (name, opts) => {
      installs.push([name, opts?.yes === true]);
    },
    out,
    installs,
    ...over,
  };
}

test("/invoke renders the catalog with present/absent marks", async () => {
  const d = deps({ answers: [""] }); // cancel
  await runInvoke("", d);
  const text = d.out.join("\n");
  assert.match(text, /alpha-tool/);
  assert.match(text, /✗/); // alpha absent
  assert.match(text, /✓/); // beta installed
  assert.match(text, /cancelled/);
  assert.equal(d.installs.length, 0);
});

test("/invoke installs the picked repo via the gated verb (preview then execute)", async () => {
  const d = deps({ answers: ["1"] }); // pick alpha (absent), confirm true throughout
  await runInvoke("", d);
  // install called twice: preview (yes=false) then execute (yes=true)
  assert.deepEqual(d.installs, [
    ["alpha-tool", false],
    ["alpha-tool", true],
  ]);
});

test("/invoke filters by query + warns before reinstalling a present repo", async () => {
  const d = deps({ answers: ["1", "y"] }); // only beta matches; it is installed
  await runInvoke("beta", d);
  const text = d.out.join("\n");
  assert.match(text, /beta-tool/);
  assert.ok(!text.includes("alpha-tool"), "filtered out non-matching");
  // it still installs after the reinstall confirm (confirm returns true)
  assert.equal(d.installs.length, 2);
});

test("/invoke handles an empty/failed catalog", async () => {
  const d = deps();
  d.client = { list: async () => ({ ok: false, error: "engine down" }) } as unknown as EngineClient;
  await runInvoke("", d);
  assert.match(d.out.join("\n"), /unavailable/);
});

test("/invoke ignores an out-of-range pick", async () => {
  const d = deps({ answers: ["99"] });
  await runInvoke("", d);
  assert.match(d.out.join("\n"), /cancelled/);
  assert.equal(d.installs.length, 0);
});
