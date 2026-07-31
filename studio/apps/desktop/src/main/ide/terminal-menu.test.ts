/**
 * terminal-menu.test.ts — node:test for the MAIN terminal-launcher bridge over core
 * (APP-048). The mapping + resolution are pure (import @prometheus/core, no electron),
 * so the menu-view + resolve plumbing is tested directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IdeTerminalEnv } from "../../shared/ipc-contract.js";
import { buildTerminalMenuItems, coerceEnvs, resolveTerminalItem } from "./terminal-menu.js";

const CTX = { workspaceRoot: "/proj", home: "/home/me", platform: "posix" as const };
const ENV: IdeTerminalEnv = {
  name: "ml",
  path: "/proj/.venv-ml",
  kind: "venv",
  pythonVersion: "3.11",
};

test("buildTerminalMenuItems sources shells + AI presets from core (★ project first)", () => {
  const items = buildTerminalMenuItems([]);
  assert.equal(items[0]?.id, "shell.project", "the ★ project shell leads");
  assert.ok(items.some((i) => i.id === "shell.system" && i.kind === "shell"));
  const claude = items.find((i) => i.id === "ai.claude");
  assert.equal(claude?.kind, "ai-preset");
  assert.equal(claude?.detectBin, "claude");
  assert.match(
    claude?.install ?? "",
    /^npm i -g @anthropic-ai\/claude-code$/,
    "install hint cleaned",
  );
  // no env profiles without an env list
  assert.ok(!items.some((i) => i.kind === "env"));
});

test("buildTerminalMenuItems adds one env profile per non-system env", () => {
  const items = buildTerminalMenuItems([ENV]);
  const env = items.find((i) => i.kind === "env");
  assert.ok(env, "an env profile is present");
  assert.match(env!.title, /ml/);
});

test("resolveTerminalItem: project shell → cwd=root, no launch", () => {
  const r = resolveTerminalItem("shell.project", CTX);
  assert.ok(r);
  assert.equal(r!.cwd, "/proj");
  assert.equal(r!.kind, "shell");
  assert.equal(r!.launch, undefined);
  assert.equal(r!.venv, null);
});

test("resolveTerminalItem: system shell → cwd=home", () => {
  const r = resolveTerminalItem("shell.system", CTX);
  assert.equal(r!.cwd, "/home/me");
});

test("resolveTerminalItem: an AI preset carries its launch + autorun + ai group", () => {
  const r = resolveTerminalItem("ai.claude", CTX);
  assert.ok(r);
  assert.equal(r!.kind, "ai-preset");
  assert.equal(r!.group, "ai");
  assert.equal(r!.launch, "claude");
  assert.equal(r!.autorun, true);
});

test("resolveTerminalItem: an env profile resolves its venv root", () => {
  const r = resolveTerminalItem("env.ml", { ...CTX, envs: [ENV] });
  assert.ok(r);
  assert.equal(r!.kind, "env");
  assert.equal(r!.venv?.root, "/proj/.venv-ml");
  assert.equal(r!.venv?.platform, "posix");
});

test("resolveTerminalItem: unknown id → undefined", () => {
  assert.equal(resolveTerminalItem("nope.whatever", CTX), undefined);
});

test("coerceEnvs filters malformed rows + defaults kind", () => {
  const out = coerceEnvs([ENV, { name: "", path: "" } as IdeTerminalEnv]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "venv");
  assert.equal(out[0]!.packagesCount, 0);
});
