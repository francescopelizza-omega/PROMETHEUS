/**
 * pty-host.test.ts — node:test for the PTY host venv-env construction + a FAKE
 * backend round-trip (file 07 §6.1).
 *
 * Runs NOW (no electron, no node-pty — the native addon is NOT installed here, so
 * the PtyBackend is INJECTED as a fake). It pins:
 *   - buildVenvEnv: PATH prepend of <venv>/bin (posix) / <venv>\Scripts (win),
 *     VIRTUAL_ENV set, stale PYTHONHOME dropped, and NO venv → base env unchanged,
 *   - the host round-trip: spawn → write → onData relay → resize → kill → exit,
 *     all over the fake backend with NO real shell.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test pty-host.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PtyBackend,
  PtyHost,
  type PtyProcess,
  type PtySpawnOptions,
  buildVenvEnv,
} from "./pty-host.js";

/* ── buildVenvEnv (the load-bearing pure bit) ───────────────────────────────*/

test("buildVenvEnv prepends <venv>/bin to PATH + sets VIRTUAL_ENV (posix)", () => {
  const env = buildVenvEnv(
    { PATH: "/usr/bin:/bin", HOME: "/home/x" },
    {
      root: "/proj/.venv",
      platform: "posix",
    },
  );
  assert.equal(env.PATH, "/proj/.venv/bin:/usr/bin:/bin");
  assert.equal(env.VIRTUAL_ENV, "/proj/.venv");
  assert.equal(env.HOME, "/home/x"); // unrelated vars preserved
});

test("buildVenvEnv prepends <venv>\\Scripts to PATH (windows, case-insensitive key)", () => {
  const env = buildVenvEnv(
    { Path: "C:\\Windows", USERPROFILE: "C:\\Users\\x" },
    {
      root: "C:\\proj\\.venv",
      platform: "win32",
    },
  );
  assert.equal(env.Path, "C:\\proj\\.venv\\Scripts;C:\\Windows");
  assert.equal(env.VIRTUAL_ENV, "C:\\proj\\.venv");
});

test("buildVenvEnv drops a stale PYTHONHOME (would break the venv interpreter)", () => {
  const env = buildVenvEnv(
    { PATH: "/usr/bin", PYTHONHOME: "/some/old/python" },
    {
      root: "/proj/.venv",
      platform: "posix",
    },
  );
  assert.equal(env.PYTHONHOME, undefined);
  assert.ok(!("PYTHONHOME" in env));
});

test("buildVenvEnv with NO venv returns the base env unchanged (copy)", () => {
  const base = { PATH: "/usr/bin", FOO: "bar" };
  const env = buildVenvEnv(base, null);
  assert.deepEqual(env, base);
  assert.notEqual(env, base); // a copy, not the same ref
  assert.equal(env.VIRTUAL_ENV, undefined);
});

test("buildVenvEnv handles an empty PATH (no separator junk)", () => {
  const env = buildVenvEnv({}, { root: "/proj/.venv", platform: "posix" });
  assert.equal(env.PATH, "/proj/.venv/bin");
});

/* ── the fake backend + host round-trip ─────────────────────────────────────*/

/** A controllable fake pty process: records writes, lets the test emit data/exit. */
class FakePty implements PtyProcess {
  pid = 9001;
  writes: string[] = [];
  resizes: { cols: number; rows: number }[] = [];
  killed = false;
  readonly opts: PtySpawnOptions;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  constructor(opts: PtySpawnOptions) {
    this.opts = opts;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  kill(): void {
    this.killed = true;
    this.exitCb?.({ exitCode: 0 });
  }
  /** test helper: simulate shell output. */
  emitData(d: string): void {
    this.dataCb?.(d);
  }
}

/** A fake backend that hands back the FakePty it spawned (so the test can drive it). */
function fakeBackend(): { backend: PtyBackend; last(): FakePty | undefined } {
  let last: FakePty | undefined;
  return {
    backend: {
      spawn(opts: PtySpawnOptions): PtyProcess {
        last = new FakePty(opts);
        return last;
      },
    },
    last: () => last,
  };
}

test("PtyHost spawns a terminal that inherits the venv env + relays output", () => {
  const fb = fakeBackend();
  const host = new PtyHost({
    backend: fb.backend,
    baseEnv: { PATH: "/usr/bin", TERM: "dumb" },
    defaultShell: "/bin/bash",
    mintId: () => "pty-1",
  });
  const out: string[] = [];
  host.on("data", (e) => out.push(e.data));

  const { ptyId } = host.spawn({
    cwd: "/proj",
    venv: { root: "/proj/.venv", platform: "posix" },
  });
  assert.equal(ptyId, "pty-1");
  const proc = fb.last()!;
  // venv inheritance reached the backend.
  assert.equal(proc.opts.cwd, "/proj");
  assert.equal(proc.opts.env.PATH, "/proj/.venv/bin:/usr/bin");
  assert.equal(proc.opts.env.VIRTUAL_ENV, "/proj/.venv");
  assert.equal(proc.opts.shell, "/bin/bash");

  // shell output is relayed to the renderer feed.
  proc.emitData("(.venv) $ ");
  assert.deepEqual(out, ["(.venv) $ "]);

  // status reflects the inherited venv.
  assert.equal(host.status("pty-1")?.venvRoot, "/proj/.venv");
  host.dispose();
});

test("PtyHost write/resize forward to the backend; kill emits exit + removes the row", () => {
  const fb = fakeBackend();
  const host = new PtyHost({ backend: fb.backend, baseEnv: {}, mintId: () => "pty-1" });
  const exits: { ptyId: string; exitCode: number }[] = [];
  host.on("exit", (e) => exits.push(e));

  const { ptyId } = host.spawn({ cwd: "/proj" });
  host.write(ptyId, "ls\n");
  host.resize(ptyId, 120, 40);
  const proc = fb.last()!;
  assert.deepEqual(proc.writes, ["ls\n"]);
  assert.deepEqual(proc.resizes, [{ cols: 120, rows: 40 }]);

  host.kill(ptyId);
  assert.equal(proc.killed, true);
  assert.deepEqual(exits, [{ ptyId: "pty-1", exitCode: 0 }]);
  // the row was removed on exit.
  assert.equal(host.status(ptyId), undefined);
  host.dispose();
});

test("PtyHost write/resize to an unknown pty is a safe no-op", () => {
  const fb = fakeBackend();
  const host = new PtyHost({ backend: fb.backend, baseEnv: {} });
  // no spawn — these must not throw.
  host.write("nope", "x");
  host.resize("nope", 80, 24);
  host.kill("nope");
  assert.equal(fb.last(), undefined);
  host.dispose();
});

test("PtyHost spawn WITHOUT a venv passes the base env through unchanged", () => {
  const fb = fakeBackend();
  const host = new PtyHost({
    backend: fb.backend,
    baseEnv: { PATH: "/usr/bin", FOO: "bar" },
    mintId: () => "pty-1",
  });
  host.spawn({ cwd: "/proj" });
  const proc = fb.last()!;
  assert.equal(proc.opts.env.PATH, "/usr/bin");
  assert.equal(proc.opts.env.FOO, "bar");
  assert.equal(proc.opts.env.VIRTUAL_ENV, undefined);
  host.dispose();
});
