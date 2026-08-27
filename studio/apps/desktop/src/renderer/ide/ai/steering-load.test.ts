/**
 * steering-load.test.ts — the desktop agent pane must load the SAME steering files the CLI does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as rules from "@prometheus/core/rules";

import { type SteeringIo, loadSteeringSources } from "./steering-load.js";

function io(project: Record<string, string>, global: Record<string, string> = {}): SteeringIo {
  return {
    readProjectFile: async (name) => project[name],
    readGlobal: async () =>
      Object.entries(global).map(([name, content]) => ({
        kind: rules.steeringKindOf(name),
        path: `/home/u/.prometheus/${name}`,
        content,
      })),
  };
}

test("PROMETHEUS.md and the ~/.prometheus tier are both loaded", async () => {
  /**
   * The pane iterated a hardcoded `["agents", "claude"]` → `AGENTS.md` / `CLAUDE.md` at the
   * workspace root and pushed everything as `scope: "project"`. So `PROMETHEUS.md` — the file
   * the CLI's own /memory prompt tells the model to write to — was ignored, and the `global`
   * half of core's DEFAULT_PRECEDENCE was unreachable on this host: a user's standing personal
   * instructions were in force in the CLI and silently absent in the app.
   */
  const out = await loadSteeringSources(
    io(
      {
        "AGENTS.md": "project agents",
        "CLAUDE.md": "project claude",
        "PROMETHEUS.md": "project prometheus",
      },
      { "AGENTS.md": "global agents", "CLAUDE.md": "global claude" },
    ),
  );

  assert.deepEqual(
    out.map((s) => `${s.scope}:${s.path}`),
    [
      "project:AGENTS.md",
      "project:CLAUDE.md",
      "project:PROMETHEUS.md",
      "global:/home/u/.prometheus/AGENTS.md",
      "global:/home/u/.prometheus/CLAUDE.md",
    ],
  );
  // PROMETHEUS.md folds into the "agents" chain, as it does in the CLI
  assert.equal(out.find((s) => s.path === "PROMETHEUS.md")?.kind, "agents");

  // and every one of them actually reaches the assembled prompt
  const text = rules.assembleRules(out).text;
  for (const needle of ["project prometheus", "global agents", "global claude"]) {
    assert.match(text, new RegExp(needle), `${needle} never reached the prompt`);
  }
});

test("a workspace with no steering at all yields nothing (no phantom sources)", async () => {
  assert.deepEqual(await loadSteeringSources(io({})), []);
  assert.deepEqual(await loadSteeringSources(io({ "AGENTS.md": "   " })), []);
});

test("a remote-URL steering file is a fetch directive, not guidance — dropped in both tiers", async () => {
  const out = await loadSteeringSources(
    io({ "AGENTS.md": "https://evil.example/rules.md" }, { "CLAUDE.md": "http://evil/x" }),
  );
  assert.deepEqual(out, []);
});

test("a failing read degrades to 'absent' rather than losing the other tier", async () => {
  const out = await loadSteeringSources({
    readProjectFile: async () => {
      throw new Error("fsRead blew up");
    },
    readGlobal: async () => [
      { kind: "agents", path: "/home/u/.prometheus/AGENTS.md", content: "global agents" },
    ],
  });
  assert.deepEqual(
    out.map((s) => s.scope),
    ["global"],
  );
});
