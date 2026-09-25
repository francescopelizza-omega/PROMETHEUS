/**
 * in.test.ts — `/in` sets where produced files go, and GRANTS that folder for writing.
 *
 * The grant is the part worth testing: the exec sandbox's writable roots are
 * `[cwd, ...workingSet]`, so an output directory that was set but never granted produces a
 * session where every download is refused by Seatbelt with nothing in the transcript to say why.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createWorkingSet } from "@prometheus/core/agent-system-host";

import {
  applyInDirective,
  createOutputDir,
  expandVars,
  extractInDirective,
  parseInArgs,
  resolveInPath,
} from "./in.js";

const DIR = mkdtempSync(join(tmpdir(), "prom-in-"));

test("parse: no args shows, --clear unsets, a path sets", () => {
  assert.equal(parseInArgs("").ok === true ? parseInArgs("").action : "", "show");
  assert.equal(parseInArgs("--clear").ok === true ? parseInArgs("--clear").action : "", "clear");
  const set = parseInArgs("~/Downloads");
  assert.equal(set.ok === true && set.action === "set" ? set.dir : "", "~/Downloads");
});

test("parse: an unknown flag is an error, and a quoted path may contain spaces", () => {
  assert.equal(parseInArgs("-z").ok, false);
  const q = parseInArgs('"/tmp/my folder"');
  assert.equal(q.ok === true && q.action === "set" ? q.dir : "", "/tmp/my folder");
});

test("$VAR and ${VAR} expand; an unknown variable stays LITERAL", () => {
  const env = { USER: "ada", HOME: "/home/ada" } as NodeJS.ProcessEnv;
  assert.equal(expandVars("/Users/$USER/Downloads", env), "/Users/ada/Downloads");
  assert.equal(expandVars("${HOME}/x", env), "/home/ada/x");
  // Left literal on purpose: emptying it would silently resolve to the PARENT directory.
  assert.equal(expandVars("/Users/$NOPE/x", env), "/Users/$NOPE/x");
});

test("a relative path resolves against the session cwd", () => {
  assert.equal(resolveInPath("out", "/proj"), "/proj/out");
  assert.equal(resolveInPath("/abs/out", "/proj"), "/abs/out");
});

test("inline: the directive is pulled out of a sentence and the prompt reads naturally", () => {
  const r = extractInDirective("download this video at URL and save it /in /Users/me/Downloads");
  assert.equal(r.dir, "/Users/me/Downloads");
  assert.equal(r.prompt, "download this video at URL and save it");
});

test("inline: /info and /install are NOT the /in directive", () => {
  for (const text of ["show /info about it", "run /install ffmpeg", "just /in"]) {
    assert.equal(extractInDirective(text).dir, null, text);
    assert.equal(extractInDirective(text).prompt, text.trim(), text);
  }
});

test("inline: the last directive wins and every occurrence is stripped", () => {
  const r = extractInDirective("put it /in /tmp/a actually /in /tmp/b please");
  assert.equal(r.dir, "/tmp/b");
  assert.equal(r.prompt, "put it actually please");
  assert.ok(!r.prompt.includes("/in"));
});

test("inline: a quoted destination may contain spaces", () => {
  const r = extractInDirective('save it /in "/tmp/my downloads" now');
  assert.equal(r.dir, "/tmp/my downloads");
  assert.equal(r.prompt, "save it now");
});

test("setting an output dir GRANTS it in the working set", () => {
  const ws = createWorkingSet();
  const out = createOutputDir(ws, () => DIR);
  assert.equal(out.get(), null);
  const res = out.set(DIR);
  assert.equal(res.ok, true);
  assert.equal(out.get(), res.resolved);
  // the grant is what makes the sandbox permit a write there.
  assert.deepEqual(ws.list(), [res.resolved]);
});

test("a destination that does not exist yet is created", () => {
  const ws = createWorkingSet();
  const fresh = join(DIR, "new", "nested");
  assert.equal(existsSync(fresh), false);
  const res = createOutputDir(ws, () => DIR).set(fresh);
  assert.equal(res.ok, true);
  assert.equal(existsSync(fresh), true);
});

test("clear unsets the directory but KEEPS the grant", () => {
  const ws = createWorkingSet();
  const out = createOutputDir(ws, () => DIR);
  out.set(DIR);
  const granted = ws.list().length;
  out.clear();
  assert.equal(out.get(), null);
  // revoking would break a later reference to a file already downloaded there.
  assert.equal(ws.list().length, granted);
});

test("applyInDirective: an inline directive sets the folder and tells the model", () => {
  const ws = createWorkingSet();
  const out = createOutputDir(ws, () => DIR);
  const said: string[] = [];
  const sent = applyInDirective(`download this video at URL and save it /in ${DIR}`, out, (l) =>
    said.push(l),
  );
  assert.equal(out.get(), ws.list()[0]);
  assert.match(sent, /^download this video at URL and save it\n\n/);
  assert.match(sent, /Output directory for produced files/);
  assert.match(sent, new RegExp(DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(said.join("\n"), /output folder for this turn/);
});

test("applyInDirective: a session-scoped /in keeps applying to later turns", () => {
  const out = createOutputDir(createWorkingSet(), () => DIR);
  out.set(DIR);
  const sent = applyInDirective("convert a.png to jpg", out, () => {});
  assert.match(sent, /convert a\.png to jpg/);
  assert.match(sent, /Output directory for produced files/);
});

test("applyInDirective: with nothing set the message is passed through UNCHANGED", () => {
  const out = createOutputDir(createWorkingSet(), () => DIR);
  assert.equal(
    applyInDirective("just a question", out, () => {}),
    "just a question",
  );
});

test("applyInDirective: an unusable folder is reported, and the turn still runs", () => {
  const out = createOutputDir(createWorkingSet(), () => DIR);
  const said: string[] = [];
  // a path under a FILE cannot be created: mkdir -p fails with ENOTDIR.
  const badParent = join(DIR, "afile");
  writeFileSync(badParent, "x");
  const sent = applyInDirective(`save it /in ${badParent}/sub`, out, (l) => said.push(l));
  assert.equal(out.get(), null, "a failed set must not leave a half-applied directory");
  assert.equal(sent, "save it", "the turn still runs, against the working directory");
  assert.match(said.join("\n"), /using the working directory/);
});
