/**
 * env-ipc-ref.test.ts — the Environments panel's id must reach the sidecar as something it knows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEnvRefWith } from "./env-ref.js";

test("a synthetic env_<hash> id resolves to the NAME the sidecar understands", () => {
  /**
   * `env:list` hands the renderer rows whose `id` is `env_<hash>` — a djb2 of the absolute path,
   * minted by engine-bridge purely so React has a stable key. The envmgr sidecar has never heard
   * of it: it resolves environments by NAME. Every handler passed the id straight through, so for
   * EVERY environment in the panel (measured against this machine's real envs):
   *
   *   env:doctor {id:"env_1t4gemz"}   → ok:false "environment not found: env_1t4gemz"
   *   env:doctor {id:"skytronix"}     → ok:true
   *   pkg:list  {envId:"env_1t4gemz"} → {ok:true, packages:[]}   ← a SUCCESS with no rows
   *   pkg:list  {envId:"skytronix"}   → the real package list
   *
   * The package table rendered empty and Doctor / Export / Use / Delete all failed, on every row.
   */
  const map = new Map([
    ["env_1t4gemz", "skytronix"],
    ["env_qys55w", "system"],
  ]);
  assert.equal(resolveEnvRefWith(map, "env_1t4gemz"), "skytronix");
  assert.equal(resolveEnvRefWith(map, "env_qys55w"), "system");
});

test("a name or a path passed directly is left alone", () => {
  // the map only ever rewrites ids IT minted — a caller that already knows the name still works,
  // which is what kept the CLI path working while the panel was broken.
  const map = new Map([["env_1t4gemz", "skytronix"]]);
  assert.equal(resolveEnvRefWith(map, "skytronix"), "skytronix");
  assert.equal(resolveEnvRefWith(map, "/Users/me/venvs/thing"), "/Users/me/venvs/thing");
  assert.equal(resolveEnvRefWith(map, "system"), "system");
});

test("an unknown env_<hash> is NOT answered from a stale map", () => {
  // `null` means "ask again after refreshing" — guessing here would send the sidecar an id it
  // cannot resolve, which is the original bug.
  assert.equal(resolveEnvRefWith(new Map(), "env_unknown"), null);
  assert.equal(resolveEnvRefWith(new Map([["env_a", "a"]]), "env_b"), null);
});
