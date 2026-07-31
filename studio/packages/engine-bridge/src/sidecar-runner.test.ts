import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * sidecar-runner.test.ts — runSidecar abort/cancellation (APP-046 profile.stop).
 * A fake "profile.py" (JS, run by node standing in for python3) lets us drive the
 * AbortSignal path without python. parseSidecarObject already has coverage elsewhere.
 */
import { test } from "node:test";

import { runSidecar } from "./sidecar-runner.js";

/** Write a fake sidecar script (JS body, named *.py so the union type accepts it). */
function fakeDir(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-runner-"));
  writeFileSync(join(dir, "profile.py"), body);
  return dir;
}

test("runSidecar aborts an in-flight run via signal → ok:false 'aborted'", async () => {
  const dir = fakeDir(
    'setTimeout(() => process.stdout.write(JSON.stringify({ok:true,command:"run"}) + "\\n"), 5000);',
  );
  try {
    const ac = new AbortController();
    const p = runSidecar("profile.py", ["run"], {
      pythonBin: process.execPath,
      sidecarDir: dir,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    const env = await p;
    assert.equal(env.ok, false);
    assert.match(String(env.error), /aborted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSidecar with an already-aborted signal fails closed immediately", async () => {
  const dir = fakeDir('setTimeout(() => process.stdout.write("{}"), 5000);');
  try {
    const ac = new AbortController();
    ac.abort();
    const env = await runSidecar("profile.py", ["run"], {
      pythonBin: process.execPath,
      sidecarDir: dir,
      signal: ac.signal,
    });
    assert.equal(env.ok, false);
    assert.match(String(env.error), /aborted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSidecar returns the envelope on normal completion (no signal)", async () => {
  const dir = fakeDir(
    'process.stdout.write(JSON.stringify({ok:true,command:"run",totalUs:42}) + "\\n");',
  );
  try {
    const env = await runSidecar("profile.py", ["run"], {
      pythonBin: process.execPath,
      sidecarDir: dir,
    });
    assert.equal(env.ok, true);
    assert.equal(env.totalUs, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSidecar pipes opts.input to the child's stdin (APP-089 snapshot save)", async () => {
  // the fake reads all of stdin then echoes its byte length back in the envelope.
  const dir = fakeDir(
    'let d="";process.stdin.on("data",c=>{d+=c});process.stdin.on("end",()=>' +
      'process.stdout.write(JSON.stringify({ok:true,command:"snapshot",got:d.length})+"\\n"));',
  );
  try {
    const env = await runSidecar("profile.py", ["snapshot"], {
      pythonBin: process.execPath,
      sidecarDir: dir,
      input: '{"hello":"world"}',
    });
    assert.equal(env.ok, true);
    assert.equal((env as { got?: number }).got, '{"hello":"world"}'.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSidecar onEvent streams the JSON-line events; envelope still returned (CLI-007)", async () => {
  // emit two `{"event":…}` lines then the terminal envelope (no `event` field).
  const dir = fakeDir(
    'const w=s=>process.stdout.write(s+"\\n");' +
      'w(JSON.stringify({event:"test",id:"a",status:"pass"}));' +
      'w(JSON.stringify({event:"test",id:"b",status:"fail"}));' +
      'w(JSON.stringify({ok:true,command:"run",summary:{total:2,passed:1,failed:1}}));',
  );
  try {
    const events: Record<string, unknown>[] = [];
    const env = await runSidecar("profile.py", ["run"], {
      pythonBin: process.execPath,
      sidecarDir: dir,
      onEvent: (e) => events.push(e),
    });
    assert.equal(env.ok, true);
    assert.equal((env as { summary?: { failed?: number } }).summary?.failed, 1);
    // only the two event lines fired — the envelope (no `event` field) is NOT an event
    assert.deepEqual(
      events.map((e) => e.id),
      ["a", "b"],
    );
    assert.deepEqual(
      events.map((e) => e.status),
      ["pass", "fail"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
