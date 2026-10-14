// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * no-unsandboxed-exec.test.ts — `ide:exec` is gone, and stays gone.
 *
 * It ran `$SHELL -c <command>` outside the exec sandbox, behind a regex screen and a click. No
 * renderer called it any more (`agent:systemTool` replaced it), but the preload still exposed
 * it — a second path to root that bypassed the privileged gate whenever sudo's credentials were
 * cached globally. Privileged work has ONE path now (`privileged-ipc.ts`); this pins it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { IPC } from "./ipc-contract.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the IPC table has no ide:exec channel", () => {
  assert.equal("ideExec" in IPC, false);
  assert.ok(!Object.values(IPC).includes("ide:exec" as never));
});

test("neither the preload nor main mention the removed channel or its shell runner", () => {
  for (const f of ["preload/api.ts", "main/ide-ipc.ts"]) {
    const src = readFileSync(join(SRC, f), "utf8");
    assert.ok(!src.includes("IPC.ideExec"), `${f} still references IPC.ideExec`);
    assert.ok(!src.includes("defaultExecRunner"), `${f} still references the shell runner`);
  }
});
