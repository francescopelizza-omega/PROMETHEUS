/**
 * contract.test.ts — what the extension permission model actually bounds.
 *
 * The runner's header claimed "the utility process holds NO ambient authority". It is a full
 * Node process: the module loaded by `await import(mainPath)` can reach `node:child_process`,
 * `node:fs` and `node:net` directly and never touch a capability proxy. A reader who believed
 * the claim would treat an unreviewed `.promext` as sandboxed.
 *
 * There is no cheap way to make the claim TRUE — real confinement is an architecture change —
 * so the fix was to state the boundary correctly and name the control that does the work
 * (the install-time nemesis gate). This test pins the honest wording so it cannot quietly
 * revert to the reassuring one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const header = readFileSync(new URL("./index.ts", import.meta.url), "utf8").slice(0, 3000);

test("the runner does not claim to remove ambient authority", () => {
  assert.ok(
    !header.includes("holds NO ambient authority"),
    "that claim is false — the extension's module can import node:child_process directly",
  );
});

test("the header names what isolation DOES buy, and where the real control lives", () => {
  assert.ok(
    header.includes("gates the ExtensionContext API and nothing else"),
    "the permission model's actual scope must be stated",
  );
  assert.ok(
    /ISOLATION FROM MAIN|isolation from main/i.test(header),
    "the genuine property (crash/hang isolation, no Electron APIs) must be stated",
  );
  assert.ok(
    header.includes("nemesis-gated"),
    "the load-bearing control on untrusted extension code is the install-time gate",
  );
});
