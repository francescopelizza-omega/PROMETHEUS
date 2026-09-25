/**
 * launch-noise.test.ts — the launcher's rebuild log is erased exactly once, at the CLI's first
 * VISIBLE write, and never by a child.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAUNCH_ERASE_ENV,
  type NoiseStream,
  armLaunchNoiseErase,
  eraseSequence,
  isVisibleChunk,
} from "./launch-noise.js";

function fakeStream(isTTY: boolean): NoiseStream & { out: string[] } {
  const out: string[] = [];
  return {
    isTTY,
    out,
    write(chunk: unknown): boolean {
      out.push(String(chunk));
      return true;
    },
  };
}

test("escape-only writes are invisible; text, newlines and bytes are visible", () => {
  assert.equal(isVisibleChunk("\x1b[?2004h\x1b[?7l\x1b[?25l"), false, "ENTER_TUI");
  assert.equal(isVisibleChunk("\x1b]11;rgb:00/00/00\x07"), false, "OSC background");
  assert.equal(isVisibleChunk("\r\x1b[0J"), false);
  assert.equal(isVisibleChunk("\n"), true, "a newline moves to a new row");
  assert.equal(isVisibleChunk("\r\x1b[0Jprometheus v0.1"), true);
  assert.equal(isVisibleChunk(Buffer.from("hi")), true);
});

test("the erase fires once, BEFORE the first visible write, on the stream that wrote it", () => {
  const env: NodeJS.ProcessEnv = { [LAUNCH_ERASE_ENV]: "17" };
  const stdout = fakeStream(true);
  const stderr = fakeStream(true);
  armLaunchNoiseErase(env, [stdout, stderr]);
  assert.equal(env[LAUNCH_ERASE_ENV], undefined, "removed at once: no child erases again");

  stdout.write("\x1b[?2004h\x1b[?25l"); // the TUI's enter sequence: nothing on screen yet
  assert.deepEqual(stdout.out, ["\x1b[?2004h\x1b[?25l"]);

  stdout.write("\r\x1b[0J● prometheus");
  assert.deepEqual(stdout.out.slice(1), [eraseSequence(17), "\r\x1b[0J● prometheus"]);

  stdout.write("more");
  stderr.write("a warning");
  assert.equal(stdout.out.filter((s) => s === eraseSequence(17)).length, 1, "only once");
  assert.deepEqual(stderr.out, ["a warning"], "the other stream is not erased again");
});

test("an earlier startup WARNING triggers the erase first, so it is never itself erased", () => {
  const env: NodeJS.ProcessEnv = { [LAUNCH_ERASE_ENV]: "5" };
  const stdout = fakeStream(true);
  const stderr = fakeStream(true);
  armLaunchNoiseErase(env, [stdout, stderr]);
  stderr.write("prometheus: cleaned up 2 orphaned process(es)\n");
  assert.deepEqual(stderr.out, [
    eraseSequence(5),
    "prometheus: cleaned up 2 orphaned process(es)\n",
  ]);
  stdout.write("banner");
  assert.deepEqual(stdout.out, ["banner"]);
});

test("nothing is armed without a request, with a junk count, or when no stream is a terminal", () => {
  for (const env of [
    {},
    { [LAUNCH_ERASE_ENV]: "0" },
    { [LAUNCH_ERASE_ENV]: "x" },
  ] as NodeJS.ProcessEnv[]) {
    const s = fakeStream(true);
    armLaunchNoiseErase(env, [s]);
    s.write("hello");
    assert.deepEqual(s.out, ["hello"]);
  }
  const env: NodeJS.ProcessEnv = { [LAUNCH_ERASE_ENV]: "9" };
  const piped = fakeStream(false);
  armLaunchNoiseErase(env, [piped]);
  piped.write("to a file");
  assert.deepEqual(piped.out, ["to a file"], "the log was never on this stream's screen");
  assert.equal(env[LAUNCH_ERASE_ENV], undefined, "…and the request is still consumed");
});

test("disarm drops the erase without performing it", () => {
  const env: NodeJS.ProcessEnv = { [LAUNCH_ERASE_ENV]: "3" };
  const s = fakeStream(true);
  const disarm = armLaunchNoiseErase(env, [s]);
  disarm();
  s.write("hello");
  assert.deepEqual(s.out, ["hello"]);
});
