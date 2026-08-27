/**
 * system-tools.test.ts — `run_command`'s redirect-target pre-image capture.
 *
 * `write_file`/`propose_edit`/the Tier-W fs tools (delete_file/move_file, see
 * fs-mutate-host.test.ts) all snapshot through `onPreImage` before mutating, so a host with a
 * checkpoint store can undo them via `/revert`. `echo x > file.txt` changes a file exactly the
 * same way, but reaches the file as a SIDE EFFECT of a `run_command` exec rather than through one
 * of those tools — so it never fired `onPreImage`, and `/revert` silently could not undo it.
 * These are real-shell tests (no spawnImpl mock): the redirect itself is the thing under test.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { FsPreImage } from "./fs-mutate-host.js";
import { clearSecretInodeCache, runSystemTool } from "./system-tools.js";

function ws(): string {
  return mkdtempSync(join(tmpdir(), "prom-run-cmd-"));
}

test("`echo > existing-file` captures the file's PRIOR content as a pre-image", async () => {
  const dir = ws();
  writeFileSync(join(dir, "out.txt"), "old content");
  const captured: FsPreImage[] = [];
  const out = await runSystemTool(
    "run_command",
    { command: "echo new > out.txt" },
    { cwd: dir, roots: [dir], gateMode: "off", onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, true, out?.summary);
  assert.equal(readFileSync(join(dir, "out.txt"), "utf8").trim(), "new");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.path, join(dir, "out.txt"));
  assert.equal(captured[0]?.preImage, "old content");
  assert.equal(captured[0]?.existed, true);
});

test("`echo > new-file` captures existed:false, so a revert DELETES rather than empties it", async () => {
  const dir = ws();
  const captured: FsPreImage[] = [];
  const out = await runSystemTool(
    "run_command",
    { command: "echo hi > brand-new.txt" },
    { cwd: dir, roots: [dir], gateMode: "off", onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, true, out?.summary);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.existed, false);
  assert.equal(captured[0]?.preImage, "");
});

test("`>>` append also captures the pre-image — the file changes too, same as `>`", async () => {
  const dir = ws();
  writeFileSync(join(dir, "log.txt"), "line1\n");
  const captured: FsPreImage[] = [];
  const out = await runSystemTool(
    "run_command",
    { command: "echo line2 >> log.txt" },
    { cwd: dir, roots: [dir], gateMode: "off", onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, true, out?.summary);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.preImage, "line1\n");
  assert.equal(captured[0]?.existed, true);
});

test("a `<` stdin redirect (a READ, not a mutation) captures nothing", async () => {
  const dir = ws();
  writeFileSync(join(dir, "in.txt"), "input data");
  const captured: FsPreImage[] = [];
  const out = await runSystemTool(
    "run_command",
    { command: "cat < in.txt" },
    { cwd: dir, roots: [dir], gateMode: "off", onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, true, out?.summary);
  assert.deepEqual(captured, []);
});

test("no `onPreImage` supplied: the redirect still runs, nothing throws", async () => {
  const dir = ws();
  const out = await runSystemTool(
    "run_command",
    { command: "echo hi > f.txt" },
    { cwd: dir, roots: [dir], gateMode: "off" },
  );
  assert.equal(out?.ok, true, out?.summary);
  assert.equal(existsSync(join(dir, "f.txt")), true);
});

test("a redirect target outside the working set is still refused BEFORE any pre-image capture", async () => {
  const dir = ws();
  const outsider = mkdtempSync(join(tmpdir(), "prom-run-cmd-outside-"));
  const captured: FsPreImage[] = [];
  const out = await runSystemTool(
    "run_command",
    { command: `echo hi > ${join(outsider, "escaped.txt")}` },
    { cwd: dir, roots: [dir], gateMode: "off", onPreImage: (r) => captured.push(r) },
  );
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /outside the working set/);
  assert.deepEqual(captured, []);
  assert.equal(existsSync(join(outsider, "escaped.txt")), false);
});

test("EVERY read path refuses a credential file, not just read_file", async () => {
  /**
   * `redact.ts` mechanism 1 REFUSES whole credential files, and its header says plainly that the
   * redactor beside it "is a MITIGATION, not a guarantee — a secret with no distinguishing shape
   * will not be caught, which is exactly why mechanism 1 exists alongside it". That refusal was
   * wired into `read_file` and `run_command`'s argv and nowhere else, so
   * `grep({pattern:".", path:".env"})` returned the file's contents — at the DEFAULT
   * authorisation level, since grep is readOnlyHint and A1 auto-approves reads with no prompt.
   *
   * Measured on a real .env before the fix: of three secrets the redactor caught ONE.
   * `AWS_SECRET=abc` and `PLAIN_KEY=value123` reached the model verbatim, and on a cloud endpoint
   * the thread leaves the machine. `git_show HEAD -- .env` had the same hole.
   */
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "prom-secret-"));
  writeFileSync(join(dir, ".env"), "DB_PASSWORD=hunter2\nAWS_SECRET=abc\nPLAIN_KEY=value123\n");
  writeFileSync(join(dir, "ok.txt"), "nothing secret here\n");
  const deps = { cwd: dir, roots: [dir] } as never;

  for (const [tool, args] of [
    ["read_file", { path: ".env" }],
    ["grep", { pattern: ".", path: ".env" }],
    ["git_show", { ref: "HEAD", path: ".env" }],
  ] as const) {
    const out = await runSystemTool(tool, args as never, deps);
    assert.equal(out?.ok, false, `${tool} did not refuse a credential file`);
    assert.doesNotMatch(
      String(out?.summary ?? ""),
      /hunter2|AWS_SECRET=abc|value123/,
      `${tool} leaked the file's contents`,
    );
  }

  // an ordinary file is still readable — this is a refusal for credential paths, not a ban
  const fine = await runSystemTool("read_file", { path: "ok.txt" } as never, deps);
  assert.equal(fine?.ok, true);
  assert.match(String(fine?.summary ?? ""), /nothing secret here/);
});

test("renaming a credential file does not launder it past the refusal", async () => {
  /**
   * `read_file .env` is refused — that refusal is MECHANISM ONE, and its own message says why:
   * tool output is folded into the thread and the thread may go to a cloud endpoint.
   *
   * `move_file` takes `from`/`to`, and neither name was in `pathArgsOf`'s key set, so the one
   * chokepoint that guards credential paths never saw them. Renaming `.env` to `notes.txt` and
   * reading that back returned the file verbatim. Reproduced end to end: `AWS_SECRET=abc`
   * reached the model in full, because `redactSecrets` — mechanism TWO — only masks values long
   * enough to look like secrets, and a three-character one sails straight through. That is
   * exactly why the refusal exists and why it must not be defeatable by a rename.
   */
  const dir = mkdtempSync(join(tmpdir(), "prom-secret-move-"));
  writeFileSync(join(dir, ".env"), "AWS_SECRET=abc\n");
  const deps = { cwd: dir, roots: [dir], authLevel: 7 } as never;

  const read = await runSystemTool("read_file", { path: ".env" }, deps);
  assert.equal(read?.ok, false, "precondition: a direct read is refused");

  const moved = await runSystemTool("move_file", { from: ".env", to: "notes.txt" }, deps);
  assert.equal(moved?.ok, false, "a credential file was renamed out of its own protection");
  assert.match(moved?.summary ?? "", /refused to move/);
  assert.equal(existsSync(join(dir, ".env")), true, "the file was moved anyway");
  assert.equal(existsSync(join(dir, "notes.txt")), false);

  // self-validating: an ORDINARY file still moves, so this is a targeted refusal and not a
  // move_file that now refuses everything.
  writeFileSync(join(dir, "plain.txt"), "hello\n");
  const ok = await runSystemTool("move_file", { from: "plain.txt", to: "renamed.txt" }, deps);
  assert.equal(ok?.ok, true, `an ordinary move was refused: ${ok?.summary}`);
  assert.equal(existsSync(join(dir, "renamed.txt")), true);
});

test("list_dir and read_file REFUSE work they did not do", async () => {
  /**
   * All three answered `ok: true` for inputs they had not processed, and the model branches on
   * `ok`:
   *
   *   list_dir <missing dir> → ok:true, with "(cannot read …: ENOENT)" buried in the listing
   *   list_dir <a file>      → ok:true, same shape — the model re-asks for a file it already has
   *   read_file offset=9999  → ok:true and a COMPLETELY EMPTY summary, indistinguishable from
   *                            reading an empty file, so the model concludes the file is empty
   *
   * Measured against the compiled host in a real temp workspace.
   */
  const dir = mkdtempSync(join(tmpdir(), "prom-tool-honesty-"));
  writeFileSync(join(dir, "a.txt"), "line1\nline2\nline3\n");
  const deps = { cwd: dir, roots: [dir], authLevel: 7 } as never;

  const missing = await runSystemTool("list_dir", { path: "no-such-dir" }, deps);
  assert.equal(missing?.ok, false, "list_dir on a missing directory reported success");
  assert.match(missing?.summary ?? "", /cannot read/);

  const onAFile = await runSystemTool("list_dir", { path: "a.txt" }, deps);
  assert.equal(onAFile?.ok, false, "list_dir on a FILE reported success");
  assert.match(onAFile?.summary ?? "", /is a file, not a directory/);
  assert.match(onAFile?.summary ?? "", /read_file/, "the message must name the next action");

  const pastEof = await runSystemTool("read_file", { path: "a.txt", offset: 9999 }, deps);
  assert.equal(pastEof?.ok, false, "read_file past EOF reported success");
  assert.match(pastEof?.summary ?? "", /past the end/);
  assert.match(pastEof?.summary ?? "", /4 lines/, "the message must say how long the file is");

  /* self-validating: every legitimate call still works, or these guards would be a regression. */
  const listed = await runSystemTool("list_dir", { path: "." }, deps);
  assert.equal(listed?.ok, true, listed?.summary);
  assert.match(listed?.summary ?? "", /a\.txt/);

  const whole = await runSystemTool("read_file", { path: "a.txt" }, deps);
  assert.equal(whole?.ok, true, whole?.summary);
  assert.match(whole?.summary ?? "", /line1/);

  const tail = await runSystemTool("read_file", { path: "a.txt", offset: 2 }, deps);
  assert.equal(tail?.ok, true, tail?.summary);
  assert.match(tail?.summary ?? "", /line2/);
  assert.doesNotMatch(tail?.summary ?? "", /line1/);

  // …and a genuinely EMPTY file still reads as a success, not as "past the end".
  writeFileSync(join(dir, "empty.txt"), "");
  const empty = await runSystemTool("read_file", { path: "empty.txt" }, deps);
  assert.equal(empty?.ok, true, empty?.summary);
});

test("glob does not split a filename that contains a newline into two entries", async () => {
  /**
   * ripgrep's output was split on "\n", and a newline is a LEGAL character in a POSIX filename.
   * One such file became TWO entries, and `relative()` rebuilt the second fragment against `cwd`
   * into a path pointing OUTSIDE the workspace. Measured with a file named `evil\netc-passwd.txt`:
   *
   *     sub/normal.txt
   *     sub/evil
   *     ../../Users/…/studio/etc-passwd.txt     ← a path that exists nowhere
   *
   * It is NOT a read primitive — `read_file` on that fabricated path fails ENOENT and the
   * working-set guard would refuse it anyway. What it is, is a listing the model believes: it
   * invents files, hides the real one, and points outside the workspace.
   */
  const dir = mkdtempSync(join(tmpdir(), "prom-glob-nl-"));
  writeFileSync(join(dir, "normal.txt"), "inside\n");
  writeFileSync(join(dir, "evil\netc-passwd.txt"), "planted\n");
  const deps = { cwd: dir, roots: [dir], authLevel: 7 } as never;

  const out = await runSystemTool("glob", { pattern: "**/*" }, deps);
  assert.equal(out?.ok, true, out?.summary);
  const listed = (out?.summary ?? "")
    .split("\n")
    .filter((l) => l && !l.startsWith("<<") && !l.startsWith("[")); // drop the frame lines

  assert.equal(listed.length, 2, `one file became ${listed.length} entries:\n${listed.join("\n")}`);
  assert.ok(
    !listed.some((l) => l.includes("..")),
    `a listed path escaped the workspace:\n${listed.join("\n")}`,
  );
  // the real file is still listed, with its newline escaped so it reads as ONE entry
  assert.ok(
    listed.some((l) => l.includes("evil\\netc-passwd.txt")),
    listed.join("\n"),
  );
  assert.ok(listed.some((l) => l.includes("normal.txt")));
});

/* ── round 20: three confirmed credential-exfiltration paths through run_command/read_file ── */

test("run_command: a credential path hidden in an =-attached FLAG value is refused", async () => {
  // regression: the argv guard skipped every token starting with `-`, so the path rode inside
  // the flag. `grep -r --include=.env .` returned the whole .env to the model, auto-approved at
  // the DEFAULT authorisation level — measured against the compiled runner.
  const dir = mkdtempSync(join(tmpdir(), "prom-r20-flag-"));
  writeFileSync(join(dir, ".env"), "AWS_SECRET=abc\n", "utf8");
  const deps = { cwd: dir, roots: [dir], gateMode: "off" as const };
  const out = await runSystemTool(
    "run_command",
    { command: `grep -r --include=.env . ${dir}` },
    deps,
  );
  assert.equal(out?.ok, false, "the flag-embedded credential path was not refused");
  assert.ok(!/AWS_SECRET=abc/.test(String(out?.text ?? out?.summary ?? "")), "the secret leaked");
  rmSync(dir, { recursive: true, force: true });
});

test("run_command: a RECURSIVE reader over a tree containing a credential file is refused", async () => {
  // regression: `grep -r AWS_SECRET <dir>` named no credential path at all — the operand is the
  // directory — so nothing in argv could be checked and the whole .env came back. Output
  // filtering cannot fix this either: `grep -rh` prints matches with no path attribution.
  const dir = mkdtempSync(join(tmpdir(), "prom-r20-rec-"));
  writeFileSync(join(dir, ".env"), "AWS_SECRET=abc\n", "utf8");
  writeFileSync(join(dir, "code.txt"), "AWS_SECRET mentioned here\n", "utf8");
  const deps = { cwd: dir, roots: [dir], gateMode: "off" as const };
  for (const command of [`grep -r AWS_SECRET ${dir}`, `grep -rh AWS_SECRET ${dir}`]) {
    const out = await runSystemTool("run_command", { command }, deps);
    assert.equal(out?.ok, false, `${command} was not refused`);
    assert.ok(!/AWS_SECRET=abc/.test(String(out?.text ?? out?.summary ?? "")), `${command} leaked`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("run_command: a recursive reader over a CLEAN tree still runs — the guard is not a blanket ban", async () => {
  // the control that keeps the guard usable: it fires only when a credential file is really
  // there. A blanket refusal of `grep -r` would have been unusable rather than strict.
  const dir = mkdtempSync(join(tmpdir(), "prom-r20-clean-"));
  writeFileSync(join(dir, "a.txt"), "hello world\n", "utf8");
  const deps = { cwd: dir, roots: [dir], gateMode: "off" as const };
  const out = await runSystemTool("run_command", { command: `grep -r hello ${dir}` }, deps);
  assert.equal(out?.ok, true, `a clean tree must not be refused: ${out?.summary}`);
  rmSync(dir, { recursive: true, force: true });
});

test("read_file: a SYMLINK whose own name is innocuous cannot read a credential file", async () => {
  // regression: the refusal matched the LEXICAL path only, so `notes.txt -> .env` matched
  // nothing and returned the whole file. (A HARDLINK is not fixable this way — it IS the file —
  // but creating one is already refused, because `ln <credential> <name>` names it in argv.)
  const dir = mkdtempSync(join(tmpdir(), "prom-r20-link-"));
  writeFileSync(join(dir, ".env"), "AWS_SECRET=abc\n", "utf8");
  symlinkSync(join(dir, ".env"), join(dir, "notes.txt"));
  const deps = { cwd: dir, roots: [dir], gateMode: "off" as const };
  const out = await runSystemTool("read_file", { path: join(dir, "notes.txt") }, deps);
  assert.equal(out?.ok, false, "the symlink read was not refused");
  assert.ok(!/AWS_SECRET=abc/.test(String(out?.text ?? out?.summary ?? "")), "the secret leaked");
  rmSync(dir, { recursive: true, force: true });
});

test("the exec audit records REFUSED attempts, not only what ran", async () => {
  // regression: `ExecDecision` has always carried "refused" — "parse / classify /
  // forbidden-program refusal — never reached a human" — but nothing emitted one. Only commands
  // that RAN, plus nemesis blocks, reached the log, so the credential guard, the shell ban, the
  // `-c` ban and the recursive-reader guard each turned an attempt away and left no trace.
  // Measured before the fix: 7 attempts, 4 refused, 0 lines for the refusals.
  const dir = mkdtempSync(join(tmpdir(), "prom-audit-"));
  const home = mkdtempSync(join(tmpdir(), "prom-audit-home-"));
  writeFileSync(join(dir, ".env"), "AWS_SECRET=abc\n", "utf8");
  const deps = { cwd: dir, home, roots: [dir], gateMode: "off" as const, authLevel: 4 };

  for (const command of [
    `cat ${join(dir, ".env")}`,
    "sh -c 'cat .env'",
    `grep -r AWS_SECRET ${dir}`,
  ]) {
    const out = await runSystemTool("run_command", { command }, deps);
    assert.equal(out?.ok, false, `${command} should have been refused`);
  }

  const auditPath = join(home, "config", "exec-audit.jsonl");
  const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
  const refusals = lines.map((l) => JSON.parse(l)).filter((e) => e.decision === "refused");
  assert.equal(refusals.length, 3, `expected 3 refusal lines, got ${lines.length} total`);
  for (const r of refusals) {
    assert.ok(r.reason, "a refusal line must say WHY");
    assert.equal(r.authLevel, 4, "the audit must record the level actually in force");
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("read_file: a HARDLINK to a credential file is refused by inode identity", async () => {
  // regression: a hardlink is not a reference to another path — it IS the file, so `realpath`
  // returns the link's own innocuous name and every name-based rule sees nothing. This was
  // previously written off as "a path-based control cannot express inode identity"; it cannot,
  // but an INODE-based one can, and (device, inode) is exactly what a hard link shares.
  const dir = mkdtempSync(join(tmpdir(), "prom-hl-"));
  writeFileSync(join(dir, ".env"), "AWS_SECRET=abc\n", "utf8");
  linkSync(join(dir, ".env"), join(dir, "notes.txt")); // innocuous NAME, same inode
  writeFileSync(join(dir, "ordinary.txt"), "nothing secret\n", "utf8");
  const deps = { cwd: dir, roots: [dir], gateMode: "off" as const };
  clearSecretInodeCache();

  const linked = await runSystemTool("read_file", { path: join(dir, "notes.txt") }, deps);
  assert.equal(linked?.ok, false, "the hardlinked credential was readable");
  assert.ok(!/AWS_SECRET=abc/.test(String(linked?.text ?? linked?.summary ?? "")), "it leaked");
  assert.match(String(linked?.summary ?? ""), /hard link/, "the refusal must say what it found");

  // controls: the credential itself is still refused, and an ordinary file still reads.
  const direct = await runSystemTool("read_file", { path: join(dir, ".env") }, deps);
  assert.equal(direct?.ok, false);
  const plain = await runSystemTool("read_file", { path: join(dir, "ordinary.txt") }, deps);
  assert.equal(plain?.ok, true, `an ordinary file must still read: ${plain?.summary}`);
  rmSync(dir, { recursive: true, force: true });
});

test("run_command: a hardlinked credential named in argv is refused too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-hl2-"));
  writeFileSync(join(dir, ".env"), "AWS_SECRET=abc\n", "utf8");
  linkSync(join(dir, ".env"), join(dir, "notes.txt"));
  const deps = { cwd: dir, roots: [dir], gateMode: "off" as const };
  clearSecretInodeCache();
  const out = await runSystemTool(
    "run_command",
    { command: `cat ${join(dir, "notes.txt")}` },
    deps,
  );
  assert.equal(out?.ok, false);
  assert.ok(!/AWS_SECRET=abc/.test(String(out?.text ?? out?.summary ?? "")));
  rmSync(dir, { recursive: true, force: true });
});

test("with NO roots the inode check is skipped — it cannot index what it was not given", async () => {
  // the honest boundary: the index is built from the working-set roots, so a host that declares
  // none gets the name-based rules only. Stated as a test so the limit is not a surprise.
  const dir = mkdtempSync(join(tmpdir(), "prom-hl3-"));
  writeFileSync(join(dir, ".env"), "AWS_SECRET=abc\n", "utf8");
  linkSync(join(dir, ".env"), join(dir, "notes.txt"));
  clearSecretInodeCache();
  const out = await runSystemTool("read_file", { path: join(dir, "notes.txt") }, { cwd: dir });
  assert.equal(out?.ok, true, "documents the boundary: no roots ⇒ no inode index");
  rmSync(dir, { recursive: true, force: true });
});
