// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { askpassScript, prepareAskpass } from "./askpass.js";

test("the macOS helper is a fixed osascript dialog with a hidden answer; the prompt arrives as $1", () => {
  const s = askpassScript({ kind: "osascript", path: "/usr/bin/osascript" });
  assert.match(s, /^#!\/bin\/sh\n/);
  assert.match(s, /exec \/usr\/bin\/osascript /);
  assert.match(s, /with hidden answer/);
  assert.match(s, /"\$1"/);
});

test("the Linux helpers take the prompt as $1 and nothing else", () => {
  assert.match(
    askpassScript({ kind: "zenity", path: "/usr/bin/zenity" }),
    /--hide-text .*--text="\$1"/,
  );
  assert.match(askpassScript({ kind: "kdialog", path: "/usr/bin/kdialog" }), /--password "\$1"/);
  assert.match(
    askpassScript({ kind: "ssh-askpass", path: "/usr/bin/ssh-askpass" }),
    /ssh-askpass "\$1"/,
  );
});

test("Linux without a display has no graphical helper", async () => {
  const p = await prepareAskpass({ platform: "linux", env: {}, trusted: () => true, fresh: true });
  assert.equal(p, null);
});

test("no trusted helper binary means null — never a PATH lookup", async () => {
  const p = await prepareAskpass({
    platform: "linux",
    env: { DISPLAY: ":0" },
    trusted: () => false,
    fresh: true,
  });
  assert.equal(p, null);
});

test("the helper is written 0700 inside a private 0700 directory, and reused", async () => {
  const p = await prepareAskpass({ platform: "darwin", env: {}, trusted: () => true, fresh: true });
  assert.ok(p);
  assert.equal(statSync(p as string).mode & 0o777, 0o700);
  assert.equal(statSync(dirname(p as string)).mode & 0o777, 0o700);
  assert.match(readFileSync(p as string, "utf8"), /osascript/);
  const again = await prepareAskpass({ platform: "darwin", env: {}, trusted: () => true });
  assert.equal(again, p);
});

test("a helper the OS purged from its temp dir is written again, not handed to sudo missing", async () => {
  // macOS clears $TMPDIR entries after days without access; a long-lived Studio window would
  // otherwise get `sudo: unable to run askpass` on every privileged command until restart.
  const first = await prepareAskpass({
    platform: "darwin",
    env: {},
    trusted: () => true,
    fresh: true,
  });
  assert.ok(first);
  rmSync(dirname(first as string), { recursive: true, force: true });
  const again = await prepareAskpass({ platform: "darwin", env: {}, trusted: () => true });
  assert.ok(again && existsSync(again), "a fresh helper exists");
});
