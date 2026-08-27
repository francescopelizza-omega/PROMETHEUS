/**
 * loader.test.ts — markdown command-file parser + rules chain + formatter registry
 * (file 14 §3.2/§3.3/§3.5).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILTIN_FORMATTERS,
  type FormatPolicy,
  buildFormatArgv,
  extOf,
  formatterForExt,
  resolveFormatter,
  shouldFormatOnSave,
} from "../format/registry.js";
import {
  DEFAULT_PRECEDENCE,
  type RuleSource,
  assembleRules,
  initRulesScaffold,
  isRemoteInstruction,
  orderRuleSources,
} from "../rules/loader.js";
import {
  commandFileToSlash,
  commandNameFromFile,
  isRemoteRef,
  parseCommandFile,
  substituteArgs,
} from "./loader.js";

// ---- §3.2 command-file loader ---------------------------------------------- //

test("commandNameFromFile derives the slash name", () => {
  assert.equal(commandNameFromFile(".prometheus/command/review-pr.md"), "review-pr");
  assert.equal(commandNameFromFile("init.md"), "init");
});

test("parseCommandFile extracts frontmatter + detects @refs and !cmd injections (never runs them)", () => {
  const md = [
    "---",
    "description: Review a pull request",
    "agent: plan",
    "model: anthropic:claude-sonnet-4-6",
    "subtask: true",
    "---",
    "Review @src/app.ts for $1 and run !`git diff` then summarize $ARGUMENTS.",
  ].join("\n");
  const out = parseCommandFile("review-pr.md", md);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const f = out.file;
  assert.equal(f.name, "review-pr");
  assert.equal(f.description, "Review a pull request");
  assert.equal(f.agent, "plan");
  assert.deepEqual(f.model, "anthropic:claude-sonnet-4-6");
  assert.equal(f.subtask, true);
  assert.deepEqual(f.fileRefs, ["src/app.ts"]);
  assert.deepEqual(f.shellInjections, ["git diff"]);
  assert.ok(f.args.some((a) => a.name === "arg1"));
  assert.ok(f.args.some((a) => a.name === "ARGUMENTS"));
});

test("substituteArgs fills $ARGUMENTS + $1/$2 but leaves @file/!cmd intact", () => {
  const tmpl = "fix $1 in @file.ts using !`ls` — all: $ARGUMENTS";
  assert.equal(
    substituteArgs(tmpl, ["bug", "extra"]),
    "fix bug in @file.ts using !`ls` — all: bug extra",
  );
  assert.equal(substituteArgs("$1 $2", ["a"]), "a ", "missing positional → empty");
});

test("commandFileToSlash maps args to a hint string; isRemoteRef flags URLs", () => {
  const out = parseCommandFile("deploy.md", "do $1 [$2]");
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const slash = commandFileToSlash(out.file);
  assert.equal(slash.name, "deploy");
  assert.match(slash.arg ?? "", /<arg1>/);
  assert.equal(isRemoteRef("https://x/y.md"), true);
  assert.equal(isRemoteRef("src/a.ts"), false);
});

// ---- §3.3 rules precedence chain ------------------------------------------- //

test("assembleRules orders local AGENTS → local CLAUDE → global AGENTS → global CLAUDE", () => {
  const sources: RuleSource[] = [
    { scope: "global", kind: "claude", path: "~/.claude/CLAUDE.md", content: "g-claude" },
    { scope: "project", kind: "claude", path: "./CLAUDE.md", content: "p-claude" },
    { scope: "project", kind: "agents", path: "./AGENTS.md", content: "p-agents" },
    { scope: "global", kind: "agents", path: "~/AGENTS.md", content: "g-agents" },
  ];
  const ordered = orderRuleSources(sources);
  assert.deepEqual(
    ordered.map((s) => s.path),
    ["./AGENTS.md", "./CLAUDE.md", "~/AGENTS.md", "~/.claude/CLAUDE.md"],
  );
  const asm = assembleRules(sources);
  assert.equal(asm.order[0], "./AGENTS.md");
  assert.ok(
    asm.text.indexOf("p-agents") < asm.text.indexOf("g-claude"),
    "project agents come first in the text",
  );
  assert.equal(DEFAULT_PRECEDENCE.length, 4);
});

test("assembleRules skips empty sources; isRemoteInstruction flags URLs", () => {
  const asm = assembleRules([
    { scope: "project", kind: "agents", path: "./AGENTS.md", content: "   " },
  ]);
  assert.equal(asm.order.length, 0);
  assert.equal(isRemoteInstruction("https://rules.example/AGENTS.md"), true);
  assert.equal(isRemoteInstruction("./local.md"), false);
});

test("initRulesScaffold builds an AGENTS.md with the analyzed commands", () => {
  const md = initRulesScaffold({
    projectName: "studio",
    buildCmd: "pnpm build",
    testCmd: "pnpm test",
    lintCmd: "biome check .",
  });
  assert.match(md, /# studio — Agent Rules/);
  assert.match(md, /pnpm build/);
  assert.match(md, /nemesis gate/);
});

// ---- §3.5 formatter registry ----------------------------------------------- //

test("formatter presets cover the opencode set; ext lookup + argv build", () => {
  assert.equal(BUILTIN_FORMATTERS.length, 6);
  assert.equal(extOf("src/app.tsx"), "tsx");
  assert.equal(formatterForExt("py")?.id, "ruff");
  assert.equal(formatterForExt("go")?.id, "gofmt");
  assert.equal(formatterForExt("unknownext"), undefined);
  const ruff = formatterForExt("py");
  assert.ok(ruff);
  assert.deepEqual(buildFormatArgv(ruff as NonNullable<typeof ruff>, "x.py"), [
    "ruff",
    "format",
    "x.py",
  ]);
});

test("resolveFormatter honors byExt override + disabled; shouldFormatOnSave gates on policy", () => {
  const policy: FormatPolicy = {
    onSave: true,
    afterAiEdit: true,
    byExt: { ts: "biome" },
    disabledExts: ["md"],
  };
  assert.equal(resolveFormatter("a.ts", policy)?.id, "biome", "override wins");
  assert.equal(resolveFormatter("a.md", policy), undefined, "disabled ext");
  assert.equal(resolveFormatter("a.py", policy)?.id, "ruff", "default when no override");
  assert.equal(shouldFormatOnSave("a.ts", policy), true);
  assert.equal(shouldFormatOnSave("a.ts", { onSave: false, afterAiEdit: true }), false);
  assert.equal(shouldFormatOnSave("a.unknown", policy), false, "no formatter → no format");
});

test("an `@` inside a !`cmd` injection is part of the COMMAND, not a file ref", () => {
  /**
   * `FILE_REF_RE` scanned the whole body, so `!`npm view react@latest version`` reported BOTH a
   * shell injection and a fileRef `latest`. Both CLI hosts and the desktop pane resolve reads
   * first and `text.split("@latest").join(marker)` — which rewrites the inside of the run token,
   * so the later `text.split("!`npm view react@latest version`")` matches nothing. In user scope
   * that means the human is prompted, approves, the command RUNS through the gate, and its
   * output is thrown away; in project scope the refusal marker lands nowhere at all.
   */
  const body = "Check: !`npm view react@latest version`\nDiff: !`git diff @{u}`\nRead @notes.md";
  const out = parseCommandFile("deps.md", body);
  assert.equal(out.ok, true);
  if (!out.ok) return;

  assert.deepEqual(out.file.fileRefs, ["notes.md"], "a ref inside a command leaked out as a read");
  assert.deepEqual(out.file.shellInjections, ["npm view react@latest version", "git diff @{u}"]);

  // self-validating: the same body WITHOUT the backticks still yields the refs, so a scan that
  // simply stopped finding anything would fail here rather than pass silently.
  const bare = parseCommandFile("deps.md", "npm view react@latest version");
  assert.deepEqual((bare.ok && bare.file.fileRefs) || [], ["latest"]);

  // masking must not shift anything else in the body
  assert.equal(out.file.template, body);
});
