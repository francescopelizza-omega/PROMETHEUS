// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * privileged-verify.test.ts — root runs EXACTLY the bytes the human approved.
 *
 * The gate hashes a script when it asks and again just before sudo starts, but root opens the
 * file only after the password has been typed — seconds later. `verifiedRun` closes that window:
 * a Python script is read, hashed and run by root from the same bytes (a fixed loader), a shell
 * script's approved bytes are handed to the shell directly, and a script only root can change
 * runs as it is. Anything else is refused.
 *
 * The produced argv is RUN here (as the user — the elevator is not under test) with real python3
 * and /bin/sh, so the semantics a script sees are pinned, not assumed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PY_LOADER, verifiedRun } from "./privileged-verify.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function dir(): string {
  return mkdtempSync(join(tmpdir(), "prom-verify-"));
}

const userOwned = { rootControlled: () => false };
const PY = "/usr/bin/python3";

const PY_SCRIPT = [
  "import sys",
  "from dataclasses import dataclass",
  "@dataclass",
  "class P:",
  "    x: int",
  "if __name__ == '__main__':",
  "    print('name', __name__)",
  "    print('file', __file__)",
  "    print('argv', sys.argv)",
  "    print('dc', P(3))",
  "",
].join("\n");

test("no script: the argv is unchanged", () => {
  assert.deepEqual(verifiedRun(["apt-get", "install", "-y", "rg"], "/tmp", null, userOwned), {
    argv: ["apt-get", "install", "-y", "rg"],
    mode: "none",
  });
});

test("a script only root can change runs as it is", () => {
  const d = dir();
  const p = join(d, "t.py");
  writeFileSync(p, PY_SCRIPT);
  const r = verifiedRun(
    [PY, p],
    d,
    { path: p, sha256: sha(PY_SCRIPT) },
    {
      rootControlled: () => true,
    },
  );
  assert.deepEqual(r, { argv: [PY, p], mode: "root-owned" });
});

test("python: the loader reads, hashes and runs the approved bytes — a script sees what it always saw", () => {
  const d = dir();
  const p = join(d, "tool.py");
  writeFileSync(p, PY_SCRIPT);
  const r = verifiedRun(
    [PY, "-I", "tool.py", "--no-sudo", "x"],
    d,
    {
      path: p,
      sha256: sha(PY_SCRIPT),
    },
    userOwned,
  );
  assert.ok("argv" in r && r.mode === "python-loader");
  assert.deepEqual(r.argv, [PY, "-I", "-c", PY_LOADER, sha(PY_SCRIPT), p, "--no-sudo", "x"]);
  const run = spawnSync(r.argv[0] as string, r.argv.slice(1), { cwd: d, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^name __main__$/m);
  assert.match(run.stdout, new RegExp(`^file ${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(run.stdout, /^argv \[.*tool\.py', '--no-sudo', 'x'\]$/m);
  assert.match(run.stdout, /^dc P\(x=3\)$/m);
});

test("python: a file changed after approval is refused BY THE LOADER (exit 126), never run", () => {
  const d = dir();
  const p = join(d, "tool.py");
  writeFileSync(p, PY_SCRIPT);
  const r = verifiedRun([PY, "-I", p], d, { path: p, sha256: sha(PY_SCRIPT) }, userOwned);
  assert.ok("argv" in r);
  // the swap lands while sudo waits for the password
  writeFileSync(p, "print('SWAPPED-RAN')\n");
  const run = spawnSync(r.argv[0] as string, r.argv.slice(1), { cwd: d, encoding: "utf8" });
  assert.equal(run.status, 126);
  assert.doesNotMatch(run.stdout, /SWAPPED-RAN/);
  assert.match(run.stderr, /changed after you approved it/);
});

test("shell: the approved bytes go to the shell directly; a later change to the file cannot run", () => {
  const d = dir();
  const p = join(d, "fix.sh");
  const body = '#!/bin/sh\necho "zero=$0 one=$1"\n';
  writeFileSync(p, body);
  const r = verifiedRun(
    ["/bin/sh", "fix.sh", "arg1"],
    d,
    { path: p, sha256: sha(body) },
    userOwned,
  );
  assert.ok("argv" in r && r.mode === "shell-inline");
  assert.deepEqual(r.argv, ["/bin/sh", "-c", body, p, "arg1"]);
  writeFileSync(p, "#!/bin/sh\necho SWAPPED-RAN\n");
  const run = spawnSync(r.argv[0] as string, r.argv.slice(1), { cwd: d, encoding: "utf8" });
  assert.equal(run.stdout.trim(), `zero=${p} one=arg1`);
});

test("shell: bytes that no longer match the approval when read are refused here", () => {
  const d = dir();
  const p = join(d, "fix.sh");
  writeFileSync(p, "#!/bin/sh\necho hi\n");
  const r = verifiedRun(["bash", p], d, { path: p, sha256: sha("something else") }, userOwned);
  assert.ok("refusal" in r);
  assert.match(r.refusal, /changed after/);
});

test("a directly executed script follows its #! line: sh inline, python through the loader", () => {
  const d = dir();
  const sh = join(d, "fix.sh");
  const shBody = "#!/bin/sh -e\necho ok\n";
  writeFileSync(sh, shBody);
  chmodSync(sh, 0o755);
  const a = verifiedRun(["./fix.sh", "z"], d, { path: sh, sha256: sha(shBody) }, userOwned);
  assert.ok("argv" in a);
  assert.deepEqual(a.argv, ["/bin/sh", "-e", "-c", shBody, sh, "z"]);

  const py = join(d, "tool");
  const pyBody = `#!/usr/bin/env python3\n${PY_SCRIPT}`;
  writeFileSync(py, pyBody);
  chmodSync(py, 0o755);
  const b = verifiedRun(
    [py, "q"],
    d,
    { path: py, sha256: sha(pyBody) },
    {
      ...userOwned,
      trusted: (x) => x === "/usr/bin/python3",
    },
  );
  assert.ok("argv" in b && b.mode === "python-loader");
  assert.deepEqual(b.argv, ["/usr/bin/python3", "-c", PY_LOADER, sha(pyBody), py, "q"]);
  const run = spawnSync(b.argv[0] as string, b.argv.slice(1), { cwd: d, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^argv \[.*tool', 'q'\]$/m);
});

test("what cannot be verified is refused, with the way out", () => {
  const d = dir();
  const pl = join(d, "x.pl");
  writeFileSync(pl, "print 1;\n");
  const r = verifiedRun(
    ["/usr/bin/perl", pl],
    d,
    { path: pl, sha256: sha("print 1;\n") },
    userOwned,
  );
  assert.ok("refusal" in r);
  assert.match(r.refusal, /only root can (write|change)/);

  const odd = join(d, "odd");
  const oddBody = "#!/usr/bin/env -S python3 -u\nprint(1)\n";
  writeFileSync(odd, oddBody);
  const r2 = verifiedRun([odd], d, { path: odd, sha256: sha(oddBody) }, userOwned);
  assert.ok("refusal" in r2);

  const big = join(d, "big.sh");
  const bigBody = `#!/bin/sh\n${"# pad\n".repeat(30_000)}`;
  writeFileSync(big, bigBody);
  const r3 = verifiedRun(["/bin/sh", big], d, { path: big, sha256: sha(bigBody) }, userOwned);
  assert.ok("refusal" in r3);
  assert.match(r3.refusal, /too large/);
});
