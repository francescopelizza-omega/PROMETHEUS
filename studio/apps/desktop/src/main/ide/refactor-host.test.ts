/**
 * refactor-host.test.ts — node:test for the `ide:refactor` marshaller (APP-026).
 *
 * ide-ipc.ts is relay-only (imports electron) so, exactly like the other hosts,
 * the testable seam is this pure module: argv building (option-value form, no
 * string concatenation), envelope→IdeRefactorResult mapping, and the deliverable-4
 * invariant that the sidecar's WorkspaceEdit reaches the renderer boundary
 * UNTOUCHED (same object graph — deep-equal AND reference-equal), with sidecar
 * failures surfacing as ok:false data, never a throw.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test refactor-host.test.ts
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildRefactorArgv,
  normalizeRefactorPaths,
  runRefactorVerb,
  toRefactorResult,
} from "./refactor-host.js";

test("buildRefactorArgv: every transform maps to its refactor.py verb in option-value form", () => {
  assert.deepEqual(
    buildRefactorArgv({
      transform: "rename",
      file: "/proj/m.py",
      line: 1,
      col: 5,
      newName: "compute",
      root: "/proj",
    }),
    [
      "rename",
      "--file",
      "/proj/m.py",
      "--line",
      "1",
      "--col",
      "5",
      "--new-name",
      "compute",
      "--root",
      "/proj",
    ],
  );
  assert.deepEqual(
    buildRefactorArgv({
      transform: "extract",
      file: "/proj/m.py",
      startLine: 2,
      endLine: 3,
      name: "extracted",
      kind: "variable",
      startCol: 9,
      endCol: 13,
    }),
    [
      "extract",
      "--file",
      "/proj/m.py",
      "--start-line",
      "2",
      "--end-line",
      "3",
      "--name",
      "extracted",
      "--kind",
      "variable",
      "--start-col",
      "9",
      "--end-col",
      "13",
    ],
  );
  assert.deepEqual(buildRefactorArgv({ transform: "inline", file: "/p/m.py", line: 2, col: 5 }), [
    "inline",
    "--file",
    "/p/m.py",
    "--line",
    "2",
    "--col",
    "5",
  ]);
  assert.deepEqual(
    buildRefactorArgv({ transform: "move", file: "/p/m.py", symbol: "helper", dest: "util.py" }),
    ["move", "--file", "/p/m.py", "--symbol", "helper", "--dest", "util.py"],
  );
  assert.deepEqual(
    buildRefactorArgv({
      transform: "change-signature",
      file: "/p/m.py",
      line: 1,
      col: 5,
      order: [2, 1, 0],
      remove: 0,
    }),
    [
      "change-signature",
      "--file",
      "/p/m.py",
      "--line",
      "1",
      "--col",
      "5",
      "--order",
      "2,1,0",
      "--remove",
      "0",
    ],
  );
  assert.deepEqual(
    buildRefactorArgv({ transform: "safe-delete", file: "/p/m.py", line: 9, col: 5 }),
    ["safe-delete", "--file", "/p/m.py", "--line", "9", "--col", "5"],
  );
});

test("buildRefactorArgv: every gen-* transform maps to its verb (APP-028)", () => {
  assert.deepEqual(buildRefactorArgv({ transform: "gen-init", file: "/p/m.py", line: 5 }), [
    "gen-init",
    "--file",
    "/p/m.py",
    "--line",
    "5",
  ]);
  assert.deepEqual(
    buildRefactorArgv({ transform: "gen-repr", file: "/p/m.py", line: 5, attrs: ["x", "tag"] }),
    ["gen-repr", "--file", "/p/m.py", "--line", "5", "--attrs", "x,tag"],
  );
  assert.deepEqual(
    buildRefactorArgv({ transform: "gen-eq", file: "/p/m.py", line: 5, attrs: ["x"] }),
    ["gen-eq", "--file", "/p/m.py", "--line", "5", "--attrs", "x"],
  );
  assert.deepEqual(buildRefactorArgv({ transform: "gen-dataclass", file: "/p/m.py", line: 4 }), [
    "gen-dataclass",
    "--file",
    "/p/m.py",
    "--line",
    "4",
  ]);
  assert.deepEqual(
    buildRefactorArgv({ transform: "gen-property", file: "/p/m.py", line: 5, attr: "_speed" }),
    ["gen-property", "--file", "/p/m.py", "--line", "5", "--attr", "_speed"],
  );
  assert.deepEqual(
    buildRefactorArgv({ transform: "gen-override", file: "/p/m.py", line: 5, method: "run" }),
    ["gen-override", "--file", "/p/m.py", "--line", "5", "--method", "run"],
  );
  assert.deepEqual(
    buildRefactorArgv({
      transform: "gen-delegate",
      file: "/p/m.py",
      line: 5,
      attr: "engine",
      method: "start",
    }),
    ["gen-delegate", "--file", "/p/m.py", "--line", "5", "--attr", "engine", "--method", "start"],
  );
  assert.deepEqual(buildRefactorArgv({ transform: "gen-docstring", file: "/p/m.py", line: 9 }), [
    "gen-docstring",
    "--file",
    "/p/m.py",
    "--line",
    "9",
  ]);
});

test("runRefactorVerb: gen-docstring noop envelope passes through (edit {}, files [])", async () => {
  // the idempotent second run — ok:true with an EMPTY edit must survive the
  // boundary as data (the renderer renders "no edits", it must not throw)
  const res = await runRefactorVerb(
    { transform: "gen-docstring", file: "/p/m.py", line: 3 },
    async () => ({
      ok: true,
      command: "gen-docstring",
      edit: { changes: {} },
      files: [],
      noop: true,
      reason: "docstring already present",
    }),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.edit, { changes: {} });
  assert.deepEqual(res.files, []);
});

test("runRefactorVerb: gen file:// uri is normalized and sensitive gen paths refused", async () => {
  const seen: string[][] = [];
  const res = await runRefactorVerb(
    { transform: "gen-init", file: "file:///p/m.py", line: 2 },
    async (_s, argv) => {
      seen.push(argv);
      return { ok: true, command: "gen-init", edit: { changes: { "file:///p/m.py": [] } } };
    },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [["gen-init", "--file", "/p/m.py", "--line", "2"]]);
  let called = 0;
  const refused = await runRefactorVerb(
    { transform: "gen-repr", file: join(homedir(), ".ssh", "config"), line: 1 },
    async () => {
      called += 1;
      return { ok: true, command: "gen-repr" };
    },
  );
  assert.equal(refused.ok, false);
  assert.equal(called, 0);
});

test("buildRefactorArgv: a '-'-leading path stays a --file VALUE (argparse-safe)", () => {
  // the zod seam already forces absolute paths, but the builder's own invariant
  // is that user strings only ever occupy value slots, never flag positions.
  const argv = buildRefactorArgv({
    transform: "rename",
    file: "/proj/-weird/m.py",
    line: 1,
    col: 1,
    newName: "ok",
  });
  assert.equal(argv[argv.indexOf("--file") + 1], "/proj/-weird/m.py");
});

test("normalizeRefactorPaths: editor file:// URIs become fs paths on every path field", () => {
  const req = normalizeRefactorPaths({
    transform: "move",
    file: "file:///proj/m.py",
    symbol: "helper",
    dest: "file:///proj/util.py",
    root: "file:///proj",
  });
  assert.equal(req.file, "/proj/m.py");
  assert.equal(req.root, "/proj");
  if (req.transform === "move") assert.equal(req.dest, "/proj/util.py");
  // plain paths pass through untouched
  const plain = normalizeRefactorPaths({
    transform: "inline",
    file: "/proj/m.py",
    line: 1,
    col: 1,
  });
  assert.equal(plain.file, "/proj/m.py");
});

test("a sensitive-path --root is refused (ok:false, no sidecar call)", async () => {
  let called = 0;
  const res = await runRefactorVerb(
    {
      transform: "rename",
      file: join(homedir(), ".ssh", "config"),
      line: 1,
      col: 1,
      newName: "x",
    },
    async () => {
      called += 1;
      return { ok: true, command: "rename" };
    },
  );
  assert.equal(res.ok, false);
  assert.equal(called, 0);
  assert.match(res.error ?? "", /sensitive|refus|denied|blocked/i);
});

test("buildRefactorArgv: empty order (remove the only param) emits --order ''", () => {
  const argv = buildRefactorArgv({
    transform: "change-signature",
    file: "/p/m.py",
    line: 1,
    col: 5,
    order: [],
    remove: 0,
  });
  assert.equal(argv[argv.indexOf("--order") + 1], "");
  assert.equal(argv[argv.indexOf("--remove") + 1], "0");
});

test("toRefactorResult passes the WorkspaceEdit through VERBATIM (same reference)", () => {
  // a multi-file edit exactly as refactor.py emits it (0-based UTF-16 positions)
  const edit = {
    changes: {
      "file:///proj/mod.py": [
        {
          range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } },
          newText: "compute",
        },
        {
          range: { start: { line: 6, character: 11 }, end: { line: 6, character: 15 } },
          newText: "compute",
        },
      ],
      "file:///proj/util.py": [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
          newText: "from mod import compute\n",
        },
      ],
    },
  };
  const env = {
    ok: true,
    command: "rename",
    edit,
    files: ["file:///proj/mod.py", "file:///proj/util.py"],
    new_name: "compute",
  };
  const res = toRefactorResult(env);
  assert.equal(res.ok, true);
  // deep-equal AND the same object graph — no re-stringify, no key reorder,
  // no `line: 0` dropped (the classic falsy-coercion bug).
  assert.deepEqual(res.edit, edit);
  assert.equal(res.edit, edit);
  assert.deepEqual(res.files, env.files);
  assert.equal(res.error, undefined);
});

test("toRefactorResult surfaces sidecar refusals as ok:false data (never a throw)", () => {
  const res = toRefactorResult({
    ok: false,
    command: "safe-delete",
    error: "2 live usage(s) of 'calc' remain — not deleting",
    code: "usages-remain",
    usages: [
      { uri: "file:///proj/mod.py", line: 7 },
      { uri: "file:///proj/other.py", line: 3 },
    ],
    _exit: 2,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "usages-remain");
  assert.match(res.error ?? "", /live usage/);
  assert.deepEqual(res.usages, [
    { uri: "file:///proj/mod.py", line: 7 },
    { uri: "file:///proj/other.py", line: 3 },
  ]);
  assert.equal(res.edit, undefined);
});

test("runRefactorVerb: injected fake sidecar → deep-equal edit at the IPC boundary", async () => {
  const edit = {
    changes: {
      "file:///p/m.py": [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          newText: "z",
        },
      ],
    },
  };
  const seen: string[][] = [];
  const fake = async (script: "refactor.py", argv: string[]) => {
    seen.push([script, ...argv]);
    return { ok: true, command: argv[0] ?? "", edit };
  };
  const res = await runRefactorVerb(
    { transform: "inline", file: "/p/m.py", line: 2, col: 5 },
    fake,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.edit, edit);
  assert.deepEqual(seen, [
    ["refactor.py", "inline", "--file", "/p/m.py", "--line", "2", "--col", "5"],
  ]);
});

test("runRefactorVerb: runner failure envelopes (timeout/missing verb) surface ok:false", async () => {
  // engine-bridge fail-closes to {ok:false, error} — must pass through as data
  const res = await runRefactorVerb(
    { transform: "rename", file: "/p/m.py", line: 1, col: 1, newName: "x" },
    async () => ({ ok: false, command: "rename", error: "sidecar timed out after 120s" }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /timed out/);
});

test("runRefactorVerb: an unexpected runner THROW still lands as ok:false", async () => {
  const res = await runRefactorVerb(
    { transform: "rename", file: "/p/m.py", line: 1, col: 1, newName: "x" },
    async () => {
      throw new Error("spawn EACCES");
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /EACCES/);
});
