/**
 * prometheus.test.ts — file 11 additions: §1 globals, toEngineArgv, the §2 tree routing,
 * profiles, and the doctor --bridge probe.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listCommandSpecs } from "@prometheus/core";
import type { NemesisVerdict, SecurityVerdict } from "@prometheus/engine-bridge";

import {
  engineSubcommand,
  isManagerRead,
  notYetWired,
  passthroughArgv,
} from "./commands/generic.js";
import { PROM_VERSION, renderCommandHelp, runVersion } from "./commands/help.js";
import { specIdFor } from "./commands/route.js";
import { usageError } from "./commands/sidecar-cmd.js";
import { makeContext } from "./context.js";
import {
  type HandshakeCache,
  type HandshakeDeps,
  engineHandshake,
  probeBridge,
} from "./doctor-bridge.js";
import { run } from "./index.js";
import { parseArgs } from "./parse.js";
import {
  box,
  defaultColorEnabled,
  defaultUnicodeEnabled,
  setColorEnabled,
  setUnicodeEnabled,
  sym,
  table,
} from "./render.js";
import { RECOGNIZED_VERBS, ROUTED_VERBS } from "./route-table.js";
import {
  STDIN_PROMPT_CAP_BYTES,
  readStdinPrompt,
  shouldReadStdinPrompt,
  stdinPromptSink,
} from "./stdin.js";
import { globalArgv, toEngineArgv } from "./toEngineArgv.js";
import { renderVerdictCard, tierLabel, verdictCardFromEnvelope } from "./verdict-view.js";

// ── CLI-039: the unified verdict CARD ─────────────────────────────────────────
const ANSI = /\x1b\[[0-9;]*m/;

function nemesisFixture(over: Record<string, unknown> = {}): NemesisVerdict {
  return {
    schema: "nemesis.verdict/1",
    verdict: "block",
    target: "github.com/evil/repo",
    risk_score: 92,
    scanned_at: "2026-07-17T00:00:00Z",
    policy: "default",
    cached: false,
    unscannable: false,
    class_counts: { malware: 1 },
    top_findings: [
      {
        rule_id: "PROM-MAL-001",
        rule: "curl|wget piped to shell",
        severity: "CRITICAL",
        klass: "malware",
        path: "setup.py",
        detail: "pipes a remote script straight into sh",
        remediable: false,
      },
    ],
    blocking_reasons: ["known-malware indicator match"],
    recommendation: "Do not install this package.",
    ...over,
  } as unknown as NemesisVerdict;
}

test("verdict card: RED NemesisVerdict shows banner + rule id + excerpt + block next-step (CLI-039)", () => {
  setColorEnabled(true);
  try {
    const card = renderVerdictCard(nemesisFixture());
    assert.match(card, /GATE BLOCKED/);
    assert.match(card, /PROM-MAL-001/); // rule id column
    assert.match(card, /pipes a remote script/); // excerpt column
    assert.match(card, /known-malware indicator match/); // blocking reason
    assert.match(card, /do NOT install\/run/); // block-class next-step hint
    assert.match(card, ANSI); // colored in pretty mode
  } finally {
    setColorEnabled(true);
  }
});

test("verdict card: capped verdict shows the blind-ceiling line; uncapped does not (CLI-039)", () => {
  const capped = renderVerdictCard(nemesisFixture({ unscannable: true }));
  assert.match(capped, /CAPPED \(blind ceiling\)/);
  const uncapped = renderVerdictCard(nemesisFixture({ unscannable: false }));
  assert.doesNotMatch(uncapped, /blind ceiling/);
  // a "container"-class finding also caps, even when unscannable is false.
  const containerCapped = renderVerdictCard(
    nemesisFixture({
      unscannable: false,
      top_findings: [
        {
          rule_id: "R",
          severity: "HIGH",
          klass: "container",
          path: "img",
          detail: "d",
          remediable: false,
        },
      ],
    }),
  );
  assert.match(containerCapped, /blind ceiling/);
});

test("verdict card: GREEN SecurityVerdict shows the pass banner + allow next-step (CLI-039)", () => {
  const green: SecurityVerdict = {
    verdict: "allow",
    risk_score: 0,
    signed: true,
    findings: [],
    scannedAt: "2026-07-17T00:00:00Z",
    target: "./local/pkg",
  };
  const card = renderVerdictCard(green);
  assert.match(card, /GATE PASSED/);
  assert.match(card, /safe to proceed/);
});

test("verdict card: NO_COLOR renders a readable plain card, banner still present as text (CLI-039)", () => {
  setColorEnabled(false);
  try {
    const card = renderVerdictCard(nemesisFixture());
    assert.doesNotMatch(card, ANSI); // no ANSI escapes at all
    assert.match(card, /GATE BLOCKED/); // banner survives as plain text
    assert.match(card, /PROM-MAL-001/);
  } finally {
    setColorEnabled(true);
  }
});

test("verdictCardFromEnvelope: forced_danger → block card; plain envelope → null passthrough (CLI-039)", () => {
  setColorEnabled(false);
  try {
    const withDanger = verdictCardFromEnvelope({
      ok: false,
      command: "install",
      forced_danger: [
        { label: "evil-pkg", verdict: "block", risk_score: 88, blocking_reasons: ["malware"] },
      ],
    });
    assert.ok(withDanger && /GATE BLOCKED/.test(withDanger));
    assert.match(withDanger as string, /malware/);
    // a plain success envelope carries no verdict → null (caller passes text through unchanged).
    assert.equal(verdictCardFromEnvelope({ ok: true, command: "install" }), null);
    assert.equal(verdictCardFromEnvelope("not an object"), null);
  } finally {
    setColorEnabled(true);
  }
});

test("registry routing: single-token spec verbs map; multi-word nouns do NOT (no hijack)", () => {
  // SPECTACULAR + single-word verbs route through the canonical parity registry.
  for (const id of ["describe", "tutorial", "methods", "harden", "chat", "install", "apps"]) {
    assert.equal(specIdFor([id]), id, `${id} should resolve to its CommandSpec`);
  }
  // multi-word nouns keep the §2-tree / not-yet-wired mapping — never registry-routed.
  assert.equal(specIdFor(["repo", "add"]), undefined);
  assert.equal(specIdFor(["model", "pull"]), undefined);
  assert.equal(specIdFor(["plugin", "install"]), undefined);
  // a verb with no CommandSpec is undefined (falls back to generic/help).
  assert.equal(specIdFor(["definitely-not-a-verb"]), undefined);
  assert.equal(specIdFor([]), undefined);
});

test("parseArgs: §1 globals lifted; full §2 tree recognized", () => {
  const p = parseArgs([
    "--dry-run",
    "--yes",
    "--gate-mode",
    "warn",
    "--profile",
    "ci",
    "plugin",
    "install",
    "foo",
  ]);
  assert.equal(p.dryRun, true);
  assert.equal(p.yes, true);
  assert.equal(p.gateMode, "warn");
  assert.equal(p.profile, "ci");
  assert.deepEqual(p.command, ["plugin", "install"]);
  assert.deepEqual(p.positionals, ["foo"]);
  // force-unsafe folds into force
  assert.equal(parseArgs(["--force-unsafe", "scan"]).force, true);
  // new two-word verbs parse
  assert.deepEqual(parseArgs(["secure", "audit", "x"]).command, ["secure", "audit"]);
  assert.deepEqual(parseArgs(["app", "list"]).command, ["app", "list"]);
});

test("parseArgs: boolean flags never swallow the next positional (CLI-001)", () => {
  // --strict must NOT eat the path after it
  const gate = parseArgs(["gate", "--strict", "./x"]);
  assert.deepEqual(gate.positionals, ["./x"]);
  assert.equal(gate.strict, true);
  // --yes must NOT eat the following arg
  const install = parseArgs(["install", "--yes", "foo"]);
  assert.deepEqual(install.positionals, ["foo"]);
  assert.equal(install.yes, true);
  // value-taking control: --profile still consumes its value
  const prof = parseArgs(["scan", "--profile", "ci"]);
  assert.equal(prof.profile, "ci");
  assert.deepEqual(prof.positionals, []);
  // explicit --flag=value form still honored + parsed (not cast) for booleans
  const strictFalse = parseArgs(["gate", "--strict=false", "./x"]);
  assert.equal(strictFalse.strict, false);
  assert.deepEqual(strictFalse.positionals, ["./x"]);
  assert.equal(parseArgs(["gate", "--strict=true", "./x"]).strict, true);
  // --no-gate is a boolean too (was silently reverted by the greedy branch)
  const noGate = parseArgs(["gate", "--no-gate", "./x"]);
  assert.equal(noGate.noGate, true);
  assert.deepEqual(noGate.positionals, ["./x"]);
  // -y short alias lifts to yes and doesn't eat its neighbour
  const shortYes = parseArgs(["install", "-y", "foo"]);
  assert.equal(shortYes.yes, true);
  assert.deepEqual(shortYes.positionals, ["foo"]);
  // gate --fresh/--sign, env create/remove --conda/--keep-pin, model serve --autostart:
  // all presence-only booleans consumed via flagSet() — none were in BOOLEAN_FLAGS, so each
  // ate its command's REQUIRED positional (`gate --fresh .` reported "missing target").
  const gateFresh = parseArgs(["gate", "--fresh", "."]);
  assert.equal(gateFresh.flags.fresh, true);
  assert.deepEqual(gateFresh.positionals, ["."]);
  const gateSign = parseArgs(["gate", "--sign", "."]);
  assert.equal(gateSign.flags.sign, true);
  assert.deepEqual(gateSign.positionals, ["."]);
  const envConda = parseArgs(["env", "create", "--conda", "myenv"]);
  assert.equal(envConda.flags.conda, true);
  assert.deepEqual(envConda.positionals, ["myenv"]);
  const envKeepPin = parseArgs(["env", "remove", "--keep-pin", "myenv", "mypkg"]);
  assert.equal(envKeepPin.flags["keep-pin"], true);
  assert.deepEqual(envKeepPin.positionals, ["myenv", "mypkg"]);
  const modelAutostart = parseArgs(["model", "serve", "--autostart", "myid"]);
  assert.equal(modelAutostart.flags.autostart, true);
  assert.deepEqual(modelAutostart.positionals, ["myid"]);
  // secure trust log --blocks/--forced/--last24h, secure db update --all: same class, found by
  // a full mechanical cross-reference of every flagSet() call against BOOLEAN_FLAGS.
  const secureBlocks = parseArgs(["secure", "trust", "--blocks", "log"]);
  assert.equal(secureBlocks.flags.blocks, true);
  assert.deepEqual(secureBlocks.positionals, ["log"]);
  const secureAll = parseArgs(["secure", "db", "--all", "update"]);
  assert.equal(secureAll.flags.all, true);
  assert.deepEqual(secureAll.positionals, ["update"]);
});

test("toEngineArgv: globals come BEFORE the subcommand (§1 contract)", () => {
  const p = parseArgs(["--dry-run", "--yes", "plugin", "install", "foo"]);
  assert.deepEqual(globalArgv(p), ["--dry-run", "--yes"]);
  assert.deepEqual(toEngineArgv(p, "install", ["foo"]), ["--dry-run", "--yes", "install", "foo"]);
  // --json / --no-color are NOT forwarded (the bridge adds them; CLI output concern)
  assert.equal(globalArgv(parseArgs(["--json", "list"])).includes("--json"), false);
  assert.deepEqual(toEngineArgv(parseArgs(["--gate-mode", "off", "matrix"]), "matrix"), [
    "--gate-mode",
    "off",
    "matrix",
  ]);
});

test("engineSubcommand maps the tree; unknown verbs → not-yet-wired", () => {
  assert.deepEqual(engineSubcommand(["superscan"], []), ["superscan"]);
  assert.deepEqual(engineSubcommand(["plugin", "install"], ["foo"]), ["install", "foo"]);
  assert.deepEqual(engineSubcommand(["skill", "enable"], ["x"]), ["skills", "enable", "x"]);
  assert.deepEqual(engineSubcommand(["app", "logs"], ["yt-dlp"]), ["apps", "logs", "yt-dlp"]);
  assert.deepEqual(engineSubcommand(["secure", "audit"], ["p"]), ["audit", "p"]);
  assert.deepEqual(engineSubcommand(["repo", "vault"], ["status"]), ["vault", "status"]);
  // model pull / env create / repo add are sidecar-owned → null (not-yet-wired)
  assert.equal(engineSubcommand(["model", "pull"], ["x"]), null);
  assert.equal(engineSubcommand(["repo", "add"], ["url"]), null);
  assert.equal(
    notYetWired(["model", "pull"]).json &&
      (notYetWired(["model", "pull"]).json as { status: string }).status,
    "not-yet-wired",
  );
});

test("single-token registry verbs are REACHABLE (in ONE_WORD — not swallowed to the help screen)", () => {
  // regression: these are real CommandSpec ids; if absent from ONE_WORD, parseArgs flags
  // help:true and `prometheus install foo` prints usage instead of installing (GUI-parity bug).
  for (const v of [
    "install",
    "uninstall",
    "enable",
    "disable",
    "describe",
    "tutorial",
    "methods",
    "harden",
    "apps",
    "models",
    "status",
    "audit",
    "bundle",
    "where",
    "purge",
    "vault",
    "auto",
  ]) {
    const p = parseArgs([v, "x"]);
    assert.deepEqual(p.command, [v], `${v} should parse as a single-token command`);
    assert.equal(p.help, false, `${v} must not fall through to help`);
    // and it resolves to its CommandSpec (the canonical parity router)
    assert.equal(specIdFor([v]), v, `${v} should resolve to its CommandSpec id`);
  }
});

test("isManagerRead: apps/worldsim/models/localai/pentest are whole-family human-text; others are JSON", () => {
  // whole-family human-text → rawEngine (reads AND mutations) — no bad_json over the table
  assert.equal(isManagerRead(["apps", "list"]), true);
  assert.equal(isManagerRead(["apps", "install", "yt-dlp"]), true);
  assert.equal(isManagerRead(["worldsim", "logs"]), true);
  assert.equal(isManagerRead(["models", "config"]), true);
  assert.equal(isManagerRead(["localai", "audit"]), true);
  assert.equal(isManagerRead(["apps"]), true); // bare family → list → text
  // Regression: pentest used to split — only its READS (list/scope/status/runtimes/logs) went
  // through rawEngine; every mutating action (build/install/shell/run/destroy) stayed on the
  // JSON-envelope path even though the engine's cmd_pentest and every pentest/pentagent helper
  // never call emit_json for ANY action — so a successful destroy, a clean ROE-gate refusal,
  // and a genuine crash were all indistinguishable, all rendered as the identical
  // "prometheus.py produced no JSON on stdout (crashed before emitting)" error. pentest's WHOLE
  // surface is human-text now, matching apps/worldsim/models/localai.
  assert.equal(isManagerRead(["pentest", "list"]), true);
  assert.equal(isManagerRead(["pentest", "run"]), true);
  assert.equal(isManagerRead(["pentest", "shell"]), true);
  assert.equal(isManagerRead(["pentest", "build"]), true);
  assert.equal(isManagerRead(["pentest", "destroy"]), true);
  assert.equal(isManagerRead(["pentest"]), true); // bare family → list → text
  // JSON-envelope families are NOT human-text
  assert.equal(isManagerRead(["plugin", "list"]), false);
  assert.equal(isManagerRead(["vault", "status"]), false);
  assert.equal(isManagerRead(["install", "foo"]), false);
});

test("passthroughArgv: the §2 tree forwards per-verb flags (+ repeatable --host), drops unknowns", () => {
  // plugin install foo --only a --skip b --arm --host claude,codex  → full affordance set
  assert.deepEqual(passthroughArgv({ only: "a", skip: "b", arm: true, host: "claude,codex" }), [
    "--only",
    "a",
    "--skip",
    "b",
    "--arm",
    "--host",
    "claude",
    "--host",
    "codex",
  ]);
  // app install yt-dlp --path /opt → --path forwards
  assert.deepEqual(passthroughArgv({ path: "/opt" }), ["--path", "/opt"]);
  // unknown flags are NOT forwarded (only the known engine flags ride through)
  assert.deepEqual(passthroughArgv({ "totally-made-up": "x" }), []);
});

test("dispatch: prom-native + stubs route without the engine", async () => {
  const prof = await run(["profile", "list"]);
  assert.equal(prof.exitCode, 0);
  // CLI-044: profiles are now {name,source,active} objects (builtin + user, active-marked).
  assert.ok(
    (prof.json as { profiles: { name: string }[] }).profiles.some((p) => p.name === "local-safe"),
  );

  const chat = await run(["chat"]);
  assert.equal((chat.json as { status: string }).status, "repl-tui");

  // `repo add` is now WIRED (repo.py sidecar): a mutating verb PREVIEWS by default
  // (touches nothing, no spawn) and only executes on --yes. Parity with the GUI's
  // plan→confirm flow, and safe to call here because preview never runs the sidecar.
  const preview = await run(["repo", "add", "https://x"]);
  assert.equal((preview.json as { status: string }).status, "preview");
  assert.equal(preview.exitCode, 0);

  const cfg = await run(["config", "path"]);
  assert.equal(cfg.exitCode, 0);
  assert.ok((cfg.json as { configDir: string }).configDir.endsWith("prometheus-studio"));

  // ci profile blocks --force without PROM_ALLOW_FORCE (§4 / Open Q6)
  const forced = await run(["--profile", "ci", "--force", "plugin", "install", "foo"]);
  assert.equal(forced.exitCode, 2);
  assert.equal((forced.json as { error: string }).error, "force-blocked");
});

test("doctor --bridge probe finds the engine + a working --json contract", async (t) => {
  const r = await probeBridge();
  if (!existsSync(r.paths.py)) {
    t.skip("engine not present");
    return;
  }
  assert.equal(r.pyFound, true);
  assert.equal(r.probeOk, true); // a real scan envelope came back
});

// ── CLI-049: per-command help from the CommandSpec registry ─────────────────────
test("gate --help shows gate synopsis/flags/examples, not the global screen (CLI-049)", async () => {
  const out = await run(["gate", "--help"]);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /SYNOPSIS/);
  assert.match(out.text ?? "", /prometheus gate <path\|git-url\|owner\/repo>/);
  assert.match(out.text ?? "", /EXAMPLES/);
  assert.doesNotMatch(out.text ?? "", /Prometheus Studio CLI \(over @prometheus/); // NOT the global usage
});

test("help updates shows native usage; a leading slash resolves the same (CLI-049)", async () => {
  const u = await run(["help", "updates"]);
  assert.equal(u.exitCode, 0);
  assert.match(u.text ?? "", /prometheus updates/);
  const slash = await run(["help", "/updates"]);
  assert.equal(slash.exitCode, 0);
  assert.match(slash.text ?? "", /prometheus updates/);
});

test("unknown help topic exits 2 and suggests the closest command (CLI-049)", async () => {
  const out = await run(["help", "gatee"]); // 1 edit from "gate"
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /unknown help topic/);
  assert.equal((out.json as { suggestion?: string }).suggestion, "gate");
});

test("bare --help / help are unchanged (global usage screen) (CLI-049)", async () => {
  for (const argv of [["--help"], ["help"]]) {
    const out = await run(argv);
    assert.equal(out.exitCode, 0);
    assert.match(out.text ?? "", /Prometheus Studio CLI \(over @prometheus/); // the global screen
  }
});

test("every CLI-surfaced CommandSpec renders a non-empty synopsis + at least one example (CLI-049)", () => {
  const cliSpecs = listCommandSpecs("CLI");
  assert.ok(cliSpecs.length > 5, "there is a meaningful CLI-surfaced set");
  for (const spec of cliSpecs) {
    const help = renderCommandHelp(spec);
    assert.match(help, /SYNOPSIS/, `${spec.id} has a synopsis`);
    assert.match(help, /EXAMPLES/, `${spec.id} has examples`);
    // the synopsis line is non-empty (more than just the header)
    const synLine = help.split("\n")[3] ?? "";
    assert.ok(synLine.trim().length > 0, `${spec.id} synopsis line is non-empty`);
  }
});

// ── CLI-050: help ↔ router parity ───────────────────────────────────────────────
const isRoutable = (v: string) => RECOGNIZED_VERBS.includes(v) || specIdFor([v]) !== undefined;

test("help --json commands === the routed-verb SoT (generated, not hand-typed) (CLI-050)", async () => {
  const help = await run(["help", "--json"]);
  const commands = (help.json as { commands: string[] }).commands;
  assert.deepEqual([...commands].sort(), [...ROUTED_VERBS].sort());
});

test("parity: every listed verb is routable; every routed verb is listed (CLI-050)", () => {
  // listed → routed: no verb appears in help that the dispatcher can't handle.
  for (const v of ROUTED_VERBS) assert.ok(isRoutable(v), `${v} listed but not routable`);
  // routed → listed: every direct §2/native verb + user-facing single-token spec id is listed.
  const internal = new Set(["env-list", "model-hw", "provider-list", "secure-scan", "nemesis"]);
  const specIds = listCommandSpecs("CLI")
    .map((s) => s.id)
    .filter((id) => !internal.has(id));
  const routed = new Set(ROUTED_VERBS);
  for (const v of [...RECOGNIZED_VERBS, ...specIds]) {
    assert.ok(routed.has(v), `${v} is routed but missing from the help list`);
  }
});

test("parity: required verbs visible in BOTH the usage text and --json (CLI-050)", async () => {
  // strip ANSI so a color-wrapped `\x1b[36mupdates\x1b[0m` still word-boundary matches.
  const text = ((await run(["help"])).text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const json = ((await run(["help", "--json"])).json as { commands: string[] }).commands;
  for (const v of ["updates", "profile", "config", "schedule", "inventory"]) {
    assert.ok(json.includes(v), `${v} missing from help --json commands`);
    assert.match(text, new RegExp(`\\b${v}\\b`), `${v} missing from the usage text`);
  }
});

test("parity guard: a fake verb is neither routable nor listed (both directions) (CLI-050)", () => {
  assert.ok(!ROUTED_VERBS.includes("zzfakeverb"));
  assert.ok(!isRoutable("zzfakeverb")); // routed-but-unlisted / listed-but-unrouted both impossible for it
  // and every routed §2/native verb is present in the SoT (routed → listed, direct half).
  for (const v of RECOGNIZED_VERBS) assert.ok(ROUTED_VERBS.includes(v), `${v} routed but unlisted`);
});

/* ── CLI-083: stdin-piped prompt for a one-shot `prometheus chat` ─────────────────────── */

/** An async source over a list of chunks (mimics process.stdin). */
async function* src(...chunks: (string | Buffer)[]): AsyncIterable<string | Buffer> {
  for (const c of chunks) yield c;
}

test("CLI-083 readStdinPrompt: piped text becomes the prompt (BOM stripped)", async () => {
  const r = await readStdinPrompt(src("fix the ", "bug\n"));
  assert.equal(r.text, "fix the bug\n");
  assert.equal(r.error, undefined);
  // a leading UTF-8 BOM is stripped so it can't confuse the model/trim.
  const bom = await readStdinPrompt(src("﻿hello"));
  assert.equal(bom.text, "hello");
});

test("CLI-083 readStdinPrompt: empty / whitespace-only stdin → 'no prompt' error", async () => {
  assert.match((await readStdinPrompt(src())).error ?? "", /no prompt/); // immediate EOF
  assert.match((await readStdinPrompt(src(""))).error ?? "", /no prompt/);
  assert.match((await readStdinPrompt(src("\n \t\n"))).error ?? "", /no prompt/); // whitespace only
});

test("CLI-083 readStdinPrompt: an oversized payload fails with a size-limit error (no OOM)", async () => {
  const cap = 1024;
  const big = "x".repeat(cap + 1);
  const r = await readStdinPrompt(src(big), cap);
  assert.equal(r.text, undefined);
  assert.match(r.error ?? "", /exceeds the .* limit/);
  // the cap is enforced DURING the drain — many small chunks abort once over.
  const chunks = Array.from({ length: 20 }, () => "y".repeat(100)); // 2000 > 1024
  assert.match((await readStdinPrompt(src(...chunks), cap)).error ?? "", /exceeds/);
});

test("CLI-083 shouldReadStdinPrompt: only chat + no positional + non-TTY + not --cli", () => {
  const f = {};
  // eligible: piped chat, no positional (isTTY undefined for a pipe).
  assert.equal(shouldReadStdinPrompt(["chat"], [], f, undefined), true);
  assert.equal(shouldReadStdinPrompt(["chat"], [], f, false), true);
  // a positional message takes PRECEDENCE → do not read stdin.
  assert.equal(shouldReadStdinPrompt(["chat"], ["already a prompt"], f, undefined), false);
  // an interactive TTY → the REPL, not a stdin read.
  assert.equal(shouldReadStdinPrompt(["chat"], [], f, true), false);
  // --cli terminal path sources its own message.
  assert.equal(shouldReadStdinPrompt(["chat"], [], { cli: "claude" }, undefined), false);
  // a different command is never eligible.
  assert.equal(shouldReadStdinPrompt(["scan"], [], f, undefined), false);
  assert.ok(STDIN_PROMPT_CAP_BYTES >= 1024 * 1024); // a sane MB-scale cap
});

/* ── CLI-086: real version reporting from the package ──────────────────────────── */

test("CLI-086 PROM_VERSION is real + equals apps/cli/package.json (never 0.0.0, module-relative)", () => {
  assert.notEqual(PROM_VERSION, "0.0.0", "PROM_VERSION must not regress to the hardcoded 0.0.0");
  // read package.json via a MODULE-relative path (this test file is apps/cli/src/prometheus.test.ts →
  // ../package.json), matching how resolvePromVersion walks up from its own module — cwd-independent.
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  );
  assert.equal(PROM_VERSION, pkg.version);
});

test("CLI-098 package.json is npm-publish-ready (pack-audit: whitelist + zero workspace deps)", () => {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  );
  assert.equal(pkg.private, false, "must be publishable");
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, "real semver, not 0.0.0");
  assert.notEqual(pkg.version, "0.0.0");
  // strict files whitelist ⇒ no src/test/map/dev-register can ever reach the tarball.
  assert.deepEqual(pkg.files, ["dist/bin.js", "README.md"]);
  assert.equal(pkg.engines?.node, ">=20");
  // `prometheus` is the ONE published command name — the old `prom` alias is gone.
  assert.equal(pkg.bin?.prometheus, "dist/bin.js");
  assert.deepEqual(Object.keys(pkg.bin ?? {}), ["prometheus"]);
  assert.equal(pkg.publishConfig?.access, "public");
  assert.ok(pkg.scripts?.prepack?.includes("bundle"), "prepack must produce the bundle");
  // the published `dependencies` must carry NO `workspace:*` (they'd 404 on install) — the
  // @prometheus/* deps are bundled and live in devDependencies (dropped on publish).
  const runtimeDeps = pkg.dependencies ?? {};
  for (const [name, spec] of Object.entries(runtimeDeps)) {
    assert.ok(
      !String(spec).startsWith("workspace:"),
      `runtime dep ${name} still uses workspace:* — the tarball would be uninstallable`,
    );
  }
});

test("CLI-086 runVersion reports the CLI + detected ENGINE version, exits 0 (text + json)", async () => {
  const j = await runVersion(makeContext(parseArgs(["--json", "--version"])));
  assert.equal(j.exitCode, 0);
  assert.equal(j.json?.version, PROM_VERSION);
  assert.ok(j.json?.engine === null || typeof j.json?.engine === "string"); // honest null when missing
  const t = await runVersion(makeContext(parseArgs(["--version"])));
  assert.equal(t.exitCode, 0);
  assert.match(
    t.text ?? "",
    new RegExp(`^prometheus ${PROM_VERSION.replace(/\./g, "\\.")} \\(engine `),
  );
});

test("CLI-086 an unlocatable engine → engine null, CLI still exits 0", async () => {
  const prev = process.env.PROMETHEUS_PY;
  process.env.PROMETHEUS_PY = "/no/such/prometheus-binary-xyz";
  try {
    const out = await runVersion(makeContext(parseArgs(["--json", "--version"])));
    assert.equal(out.exitCode, 0); // the CLI-version part never fails on a missing engine
    assert.equal(out.json?.engine, null);
  } finally {
    // biome-ignore lint/performance/noDelete: restore the env exactly (unset vs a stale value)
    if (prev === undefined) delete process.env.PROMETHEUS_PY;
    else process.env.PROMETHEUS_PY = prev;
  }
});

/* ── CLI-087: cached startup engine handshake + throttled warning ──────────────── */

function memHandshake(over: {
  initial?: HandshakeCache | null;
  enginePath?: () => string | undefined;
  statMtime?: () => number | null;
  version?: string | null;
  now?: () => Date;
}) {
  let store: HandshakeCache | null = over.initial ?? null;
  let detectCalls = 0;
  const deps: HandshakeDeps = {
    home: "/x",
    now: over.now ?? (() => new Date("2026-07-18T00:00:00.000Z")),
    enginePath: over.enginePath ?? (() => "/engine/prometheus.py"),
    statMtime: over.statMtime ?? (() => 1000.5),
    detectVersion: async () => {
      detectCalls++;
      return over.version ?? "0.15.0";
    },
    readCache: () => store,
    writeCache: (c) => {
      store = c;
    },
  };
  return {
    deps,
    get store() {
      return store;
    },
    get detectCalls() {
      return detectCalls;
    },
  };
}

test("CLI-087 missing engine → ONE warning, no probe (spawn-free fast path)", async () => {
  const m = memHandshake({ enginePath: () => undefined });
  const r = await engineHandshake(m.deps);
  assert.equal(r.verdict, "missing");
  assert.match(r.warning ?? "", /engine not found.*prometheus doctor/);
  assert.equal(r.probed, false);
  assert.equal(m.detectCalls, 0);
});

test("CLI-087 fresh valid cache → ZERO probe (no spawn on the hit path), ok → no warning", async () => {
  const m = memHandshake({
    initial: {
      enginePath: "/engine/prometheus.py",
      mtimeMs: 1000.5,
      scriptVersion: "0.15.0",
      verdict: "ok",
      checkedAt: "2026-07-17T00:00:00.000Z",
    },
  });
  const r = await engineHandshake(m.deps);
  assert.equal(r.verdict, "ok");
  assert.equal(r.probed, false);
  assert.equal(m.detectCalls, 0);
  assert.equal(r.warning, null);
});

test("CLI-087 cache miss (mtime changed) → probes, re-keys, a skew warns", async () => {
  const m = memHandshake({
    initial: {
      enginePath: "/engine/prometheus.py",
      mtimeMs: 999, // differs from statMtime 1000.5 → miss
      scriptVersion: "0.15.0",
      verdict: "ok",
      checkedAt: "2026-07-17T00:00:00.000Z",
    },
    version: "0.14.0",
  });
  const r = await engineHandshake(m.deps);
  assert.equal(r.probed, true);
  assert.equal(m.detectCalls, 1);
  assert.equal(r.verdict, "mismatch");
  assert.match(r.warning ?? "", /engine 0\.14\.0 < required 0\.15\.0/);
  assert.equal(m.store?.mtimeMs, 1000.5); // cache re-keyed to the new mtime
});

test("CLI-087 warning throttled within 24h; re-emits after the window", async () => {
  const first = memHandshake({
    enginePath: () => undefined,
    now: () => new Date("2026-07-18T00:00:00.000Z"),
  });
  assert.ok((await engineHandshake(first.deps)).warning, "first miss warns");
  const persisted = first.store;
  // 6h later, same verdict → suppressed.
  const soon = memHandshake({
    enginePath: () => undefined,
    initial: persisted,
    now: () => new Date("2026-07-18T06:00:00.000Z"),
  });
  assert.equal((await engineHandshake(soon.deps)).warning, null);
  // 25h later → re-emits.
  const later = memHandshake({
    enginePath: () => undefined,
    initial: persisted,
    now: () => new Date("2026-07-19T01:00:00.000Z"),
  });
  assert.ok((await engineHandshake(later.deps)).warning, "re-warns after 24h");
});

/* ── CLI-097: NO_COLOR + accessibility output modes ─────────────────────────────── */

test("CLI-097 NO_COLOR: verdict card / table / box / sym output has ZERO ESC bytes", () => {
  setColorEnabled(false);
  try {
    const parts = [
      renderVerdictCard(nemesisFixture()), // scan/gate verdict surface
      table([{ header: "A" }, { header: "B" }], [["1", "2"]]),
      box(["boxed line"]),
      sym.ok() + sym.warn() + sym.bad() + sym.off() + sym.bullet(),
      tierLabel("allow") + tierLabel("warn") + tierLabel("block") + tierLabel("error"),
    ].join("\n");
    // deliverable 4: match \x1b BROADLY (CSI-m, OSC-8, cursor/erase) — none may leak under NO_COLOR.
    assert.ok(!/\x1b/.test(parts), "no ESC bytes when color is disabled");
  } finally {
    setColorEnabled(true);
  }
});

test("CLI-097: verdict tiers are distinguishable by TEXT alone in monochrome (marker = the tier word)", () => {
  setColorEnabled(false);
  try {
    assert.equal(tierLabel("allow"), "ALLOW");
    assert.equal(tierLabel("warn"), "WARN");
    assert.equal(tierLabel("block"), "BLOCK");
    assert.equal(tierLabel("error"), "ERROR");
    // the card's banner also carries the tier in TEXT (bgBanner degrades to a plain label).
    assert.match(renderVerdictCard(nemesisFixture()), /GATE BLOCKED/);
  } finally {
    setColorEnabled(true);
  }
});

test("CLI-097 TERM=dumb: unicode glyphs degrade to ASCII (sym + box borders)", () => {
  setColorEnabled(false);
  setUnicodeEnabled(false);
  try {
    assert.equal(sym.ok(), "+");
    assert.equal(sym.warn(), "!");
    assert.equal(sym.bad(), "x");
    assert.equal(sym.off(), "-");
    assert.equal(sym.bullet(), "*");
    const b = box(["hi"]);
    assert.ok(!/[●▲✖○•│─╭╮╰╯]/.test(b), "no unicode glyphs in a dumb-terminal box");
    assert.match(b, /\+-+\+/); // ASCII corners + rule
  } finally {
    setUnicodeEnabled(true);
    setColorEnabled(true);
  }
});

test("CLI-097: color/unicode default predicates honor NO_COLOR presence + FORCE_COLOR precedence", () => {
  const save = {
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    TERM: process.env.TERM,
  };
  const set = (k: string, v: string | undefined) => {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  };
  try {
    // NO_COLOR presence (even empty string) disables — test presence, not truthiness.
    set("FORCE_COLOR", undefined);
    set("NO_COLOR", "");
    assert.equal(defaultColorEnabled(), false, "NO_COLOR='' still disables (presence)");
    // FORCE_COLOR wins over NO_COLOR (deterministic, documented precedence).
    set("FORCE_COLOR", "1");
    set("NO_COLOR", "1");
    assert.equal(defaultColorEnabled(), true, "FORCE_COLOR beats NO_COLOR");
    // FORCE_COLOR=0 forces off.
    set("FORCE_COLOR", "0");
    assert.equal(defaultColorEnabled(), false);
    // unicode: TERM=dumb → ASCII, else unicode.
    set("TERM", "dumb");
    assert.equal(defaultUnicodeEnabled(), false);
    set("TERM", "xterm-256color");
    assert.equal(defaultUnicodeEnabled(), true);
  } finally {
    set("NO_COLOR", save.NO_COLOR);
    set("FORCE_COLOR", save.FORCE_COLOR);
    set("TERM", save.TERM);
  }
});

test("a --args value may start with a dash — it is someone else's command line", () => {
  /**
   * The generic rule refuses to treat the next token as a value when it looks like a flag, which
   * is right for `--json --quiet` and wrong for a flag whose whole job is to carry another
   * program's arguments. `prometheus mcp add fs --cmd npx --args "-y @modelcontextprotocol/
   * server-filesystem /tmp"` silently stored `args: []`, so the MCP server was registered with
   * NO arguments — unusable, and nothing said so. The `--args=…` form always worked, which is
   * what made it hard to see.
   */
  const spaced = parseArgs([
    "mcp",
    "add",
    "fs",
    "--cmd",
    "npx",
    "--args",
    "-y @modelcontextprotocol/server-filesystem /tmp",
  ]);
  assert.equal(spaced.flags.args, "-y @modelcontextprotocol/server-filesystem /tmp");
  assert.equal(spaced.flags.cmd, "npx");
  assert.deepEqual(spaced.positionals, ["fs"]);

  // the equals form keeps working, and both agree
  const equals = parseArgs([
    "mcp",
    "add",
    "fs",
    "--cmd",
    "npx",
    "--args=-y @modelcontextprotocol/server-filesystem /tmp",
  ]);
  assert.equal(equals.flags.args, spaced.flags.args);

  // …and an ordinary flag still refuses to eat the next flag as its value
  const ordinary = parseArgs(["scan", "--label", "--quiet"]);
  assert.equal(ordinary.flags.label, true, "an ordinary flag swallowed the next flag");
  assert.equal(ordinary.quiet, true);

  // a trailing `--args` with nothing after it is still just a boolean, not a crash
  assert.equal(parseArgs(["mcp", "add", "fs", "--args"]).flags.args, true);
});

test("a TYPED but unrecognized plugin/skill verb reaches the engine instead of defaulting to list", () => {
  // regression: `plugin` and `skill` are TWO_WORD commands, so an unrecognized verb leaves
  // `command` as `["plugin"]` and parks the typo in `positionals`. Both branches defaulted to
  // `list` on that, so `prometheus --json plugin uninstal skills` printed the catalog with
  // `ok:true` and exit 0 — a mistyped uninstall reporting success. Measured against the built
  // binary before the fix; after it the engine refuses with "invalid choice" and exit 2.
  assert.deepEqual(engineSubcommand(["plugin"], ["uninstal", "skills"]), ["uninstal", "skills"]);
  assert.deepEqual(engineSubcommand(["plugin"], ["remove", "skills"]), ["remove", "skills"]);
  assert.deepEqual(engineSubcommand(["skill"], ["bogusverb"]), ["skills", "bogusverb"]);
  // a TRULY bare command still defaults to list — "bare" means no second word at all.
  assert.deepEqual(engineSubcommand(["plugin"], []), ["list"]);
  assert.deepEqual(engineSubcommand(["skill"], []), ["skills", "list"]);
  // and a recognized verb is unchanged.
  assert.deepEqual(engineSubcommand(["plugin", "install"], ["foo"]), ["install", "foo"]);
  assert.deepEqual(engineSubcommand(["skill", "enable"], ["x"]), ["skills", "enable", "x"]);
});

test("a piped prompt for a BARE -p goes to the FLAG sink — the documented `cat task.md | prometheus -p`", () => {
  // regression: `--help` line 74 advertises "cat task.md | prometheus -p  stdin is the prompt when
  // none is given", but the gate only knew about `chat`. A bare `-p` parses as boolean `true`,
  // `oneShotPrompt` needs a non-empty STRING, so the run printed the help screen and exited 0
  // with the piped task discarded. Measured against the built binary.
  for (const flag of ["p", "print", "prompt"]) {
    assert.equal(
      stdinPromptSink([], [], { [flag]: true }, undefined),
      "flag",
      `a bare --${flag} must take its prompt from stdin`,
    );
  }
  // chat keeps its own sink — a positional, which is where `chat` reads its message from.
  assert.equal(stdinPromptSink(["chat"], [], {}, undefined), "positional");
  // an EXPLICIT prompt wins: stdin is the fallback source, never an override.
  assert.equal(stdinPromptSink([], [], { p: "already a prompt" }, undefined), null);
  // a real TTY means a human is typing — the readline owns the stream.
  assert.equal(stdinPromptSink([], [], { p: true }, true), null);
  // --cli is the terminal hand-off path, not an agent turn.
  assert.equal(stdinPromptSink([], [], { p: true, cli: "claude" }, undefined), null);
  // a positional alongside a bare -p is already a prompt source.
  assert.equal(stdinPromptSink([], ["something"], { p: true }, undefined), null);
  // no prompt flag at all and not chat → stdin is not the prompt.
  assert.equal(stdinPromptSink(["scan"], [], {}, undefined), null);
  // the old predicate stays true wherever a sink exists (its callers are unchanged).
  assert.equal(shouldReadStdinPrompt([], [], { p: true }, undefined), true);
  assert.equal(shouldReadStdinPrompt(["scan"], [], {}, undefined), false);
});

test("CLI-084: a usage error is class 1, so `$? -eq 2` still means a security block", () => {
  // regression: `usageError` hard-coded exit 2 — the code `context.ts`'s table reserves for a
  // fail-closed SECURITY/ENGINE block and calls "load-bearing for CI". So a plain typo was
  // indistinguishable from a nemesis BLOCK, while the SAME mistake caught one layer earlier by
  // core's command-registry validation came back as 1 through `outcomeFromError`. Measured on
  // the built binary: `--json info` exited 2 and `--json where` exited 1 for the identical
  // class of user error. The table's own words settled which one moved: "a command hand-rolling
  // its own error→code mapping is a divergence to fix".
  const out = usageError("model info", "<id>");
  assert.equal(out.exitCode, 1);
  assert.equal((out.json as { ok: boolean; error: string }).ok, false);
  assert.equal((out.json as { error: string }).error, "missing-argument");
});

test("CLI-084 drift guard: no bad-args refusal in the tree may exit 2", () => {
  /**
   * Source-level, because this is a contract that splits SILENTLY. Round 18 moved `usageError`
   * from 2 to 1; round 19 found the same divergence still live in twelve `unknown-verb` branches,
   * two bare `{ok:false}` returns, and the top-level `unknown-command` — so a typo still set
   * `$? -eq 2`, the code `context.ts` reserves for a fail-closed security block and calls
   * "load-bearing for CI". A per-site fix without this guard just waits for the next branch.
   *
   * Only the BAD-ARGS family is checked. A nemesis BLOCK, an option-shaped-id refusal and an
   * engine transport failure are all correctly 2 and must stay 2.
   */
  const dir = join(dirname(fileURLToPath(import.meta.url)), "commands");
  const offenders: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    // each `error: "<bad-args-kind>"` payload, paired with the exitCode that follows it
    for (const m of src.matchAll(
      /error: "(unknown-verb|unknown-command|missing-argument)"[\s\S]{0,300}?exitCode: (\d)/g,
    )) {
      if (m[2] !== "1") offenders.push(`${file}: ${m[1]} → exit ${m[2]}`);
    }
  }
  assert.deepEqual(offenders, [], `bad-args refusals must exit 1, not 2:\n${offenders.join("\n")}`);
});
