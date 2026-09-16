/**
 * profiles.test.ts — TOML subset parse + profile resolve/merge + the 4 seeds (§6).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { configDir, configPath, discoverProjectToml, profilePath, profilesDir } from "./paths.js";
import {
  type CliProfile,
  type ProfileFlagOverrides,
  mergeFlags,
  parseModelRef,
  parseProfile,
  resolveEffectiveProfile,
  resolveEffectiveProfileWithNotes,
  resolveTuning,
  serializeProfile,
} from "./profile.js";
import { CONFIG_SCHEMA, effectiveConfig, nearestKey, validateConfig, valueType } from "./schema.js";
import { BUILTIN_CLI_PROFILES, getCliProfile, listProfiles, profileForbidsForce } from "./seeds.js";
import { type TomlTable, getPath, parseToml, setPath, stringifyToml } from "./toml.js";

const SAMPLE = `
# the §6 example
[agent]
model        = "ollama:qwen3:8b"
systemPrompt = "Always scan before installing."
[agent.tools]
enabled = true
deny    = ["prometheus_install"]

[engine]
gateMode = "enforce"
dryRun   = true
yes      = false
[engine.paths]
prometheusPy = "/Users/me/ALPHA/PROMETHEUS/prometheus.py"
python       = "python3"
`;

test("parseToml: sections, nested tables, arrays, scalars, comments", () => {
  const doc = parseToml(SAMPLE) as Record<string, Record<string, unknown>>;
  assert.equal((doc.agent as Record<string, unknown>).model, "ollama:qwen3:8b");
  const tools = (doc.agent as Record<string, Record<string, unknown>>).tools;
  assert.equal(tools.enabled, true);
  assert.deepEqual(tools.deny, ["prometheus_install"]);
  assert.equal((doc.engine as Record<string, unknown>).dryRun, true);
  const paths = (doc.engine as Record<string, Record<string, unknown>>).paths;
  assert.equal(paths.python, "python3");
  // fail-soft on junk
  assert.deepEqual(parseToml("@@@ not toml"), {});
});

test("parseProfile: §6 example → CliProfile; null when agent.model missing", () => {
  const p = parseProfile(SAMPLE, "local-safe");
  assert.ok(p);
  assert.equal(p?.agent.model, "ollama:qwen3:8b");
  assert.deepEqual(p?.agent.tools?.deny, ["prometheus_install"]);
  assert.equal(p?.engine.gateMode, "enforce");
  assert.equal(p?.engine.dryRun, true);
  assert.equal(p?.engine.paths?.python, "python3");
  assert.equal(parseProfile("[engine]\ndryRun = true"), null); // no agent.model
});

test("parseProfile: [budget] keys parse; a profile cannot set force-budget (CLI-030)", () => {
  const p = parseProfile(
    '[agent]\nmodel = "gpt-4o"\n[budget]\nsession_usd = 5.0\ndaily_usd = 2.0\nwarn_at_percent = 70\nforce_budget = true\n',
  );
  assert.ok(p);
  assert.equal(p?.budget?.sessionUsd, 5);
  assert.equal(p?.budget?.dailyUsd, 2);
  assert.equal(p?.budget?.warnAtPercent, 70);
  // force-budget is a per-RUN CLI flag only — the profile schema has no such key.
  assert.equal((p?.budget as { forceBudget?: unknown })?.forceBudget, undefined);
});

test("parseProfile: NO [budget] table → budget undefined (zero regression, CLI-030)", () => {
  const p = parseProfile('[agent]\nmodel = "ollama:qwen3:8b"\n');
  assert.ok(p);
  assert.equal(p?.budget, undefined);
});

test("parseModelRef: provider:modelId split; bare → cloud", () => {
  assert.deepEqual(parseModelRef("ollama:qwen3:8b"), { provider: "ollama", modelId: "qwen3:8b" });
  assert.deepEqual(parseModelRef("claude-opus"), { provider: "anthropic", modelId: "claude-opus" });
});

test("mergeFlags: flags win over the profile (§6)", () => {
  const base = getCliProfile("local-safe");
  assert.ok(base);
  const flags: ProfileFlagOverrides = { gateMode: "off", dryRun: false, model: "claude-opus" };
  const merged = mergeFlags(base as NonNullable<typeof base>, flags);
  assert.equal(merged.engine.gateMode, "off");
  assert.equal(merged.engine.dryRun, false);
  assert.equal(merged.agent.model, "claude-opus");
});

test("resolveTuning: profile → AgentTuning", () => {
  const tuning = resolveTuning(
    getCliProfile("local-safe") as NonNullable<ReturnType<typeof getCliProfile>>,
  );
  assert.deepEqual(tuning.model, { provider: "ollama", modelId: "qwen3:8b" });
  assert.equal(tuning.tools.enabled, true);
  assert.deepEqual(tuning.tools.deny, ["prometheus_install"]);
  assert.equal(tuning.gateMode, "enforce");
  assert.equal(tuning.dryRun, true);
  assert.equal(tuning.verbosity, "normal");
  assert.equal(tuning.maxRounds, undefined); // unset ⇒ loop default (no forced cap)
});

test("resolveTuning CLI-072: agent.maxIterations → maxRounds; <1 clamps to default", () => {
  const mk = (mi: number) =>
    resolveTuning(
      parseProfile(`[agent]\nmodel = "ollama:qwen3:8b"\nmaxIterations = ${mi}\n`, "x")!,
    );
  assert.equal(mk(2).maxRounds, 2); // a low cap (acceptance: honored from config)
  assert.equal(mk(40).maxRounds, 40);
  assert.equal(mk(0).maxRounds, undefined); // 0 must NOT brick the agent → default
  assert.equal(mk(-5).maxRounds, undefined);
  // survives a serialize→parse round-trip (CLI-044 persistence).
  const back = parseProfile(
    serializeProfile({ agent: { model: "ollama:qwen3:8b", maxIterations: 3 }, engine: {} }),
    "y",
  );
  assert.equal(back?.agent.maxIterations, 3);
});

test("the 4 shipped profiles + ci forbids force", () => {
  assert.deepEqual(Object.keys(BUILTIN_CLI_PROFILES).sort(), [
    "airgapped",
    "ci",
    "default",
    "local-safe",
  ]);
  assert.equal(
    getCliProfile("local-safe")?.agent.tools?.deny?.includes("prometheus_install"),
    true,
  );
  assert.equal(getCliProfile("airgapped")?.agent.model.startsWith("ollama:"), true);
  assert.equal(profileForbidsForce("ci"), true);
  assert.equal(profileForbidsForce("default"), false);
});

test("profilesDir / profilePath", () => {
  assert.equal(profilesDir("/home/u"), "/home/u/.prometheus/config/profiles");
  assert.equal(profilePath("ci", "/home/u"), "/home/u/.prometheus/config/profiles/ci.toml");
});

test("stringifyToml round-trips parseToml for the value types profiles use (CLI-005)", () => {
  const table: TomlTable = {
    topStr: 'has "quote" and \\ backslash',
    topNum: 42,
    topFloat: 1.5,
    topBool: false,
    arr: ["a", "b", 3, true],
    agent: { model: "ollama:x", tools: { enabled: true, deny: ["prometheus_install"] } },
  };
  const text = stringifyToml(table);
  const back = parseToml(text);
  assert.deepEqual(back, table, "round-trip must be lossless for the subset");
  // re-serializing the parsed table is stable (idempotent)
  assert.equal(stringifyToml(back), text);
});

test("getPath / setPath walk + create dotted key paths (CLI-005)", () => {
  const t: TomlTable = {};
  setPath(t, "a.b.c", 1);
  setPath(t, "a.b.d", "x");
  setPath(t, "top", true);
  assert.equal(getPath(t, "a.b.c"), 1);
  assert.equal(getPath(t, "a.b.d"), "x");
  assert.equal(getPath(t, "top"), true);
  assert.equal(getPath(t, "a.b"), t.a && (t.a as TomlTable).b); // returns the table
  assert.equal(getPath(t, "a.b.missing"), undefined);
  assert.equal(getPath(t, "no.such.path"), undefined);
  // a nested set survives a stringify → parse → getPath round-trip
  const back = parseToml(stringifyToml(t));
  assert.equal(getPath(back, "a.b.c"), 1);
});

test("configDir / configPath locate the shared user config (CLI-005)", () => {
  assert.equal(configDir("/home/u"), "/home/u/.prometheus/config");
  assert.equal(configPath("/home/u"), "/home/u/.prometheus/config/config.toml");
  assert.equal(profilesDir("/home/u"), "/home/u/.prometheus/config/profiles");
});

test("serializeProfile round-trips every builtin through parseProfile (CLI-044)", () => {
  for (const [name, seed] of Object.entries(BUILTIN_CLI_PROFILES)) {
    const back = parseProfile(serializeProfile(seed), name);
    assert.ok(back, `${name} re-parses`);
    const { name: _n, ...seedRest } = seed;
    const { name: _b, ...backRest } = back as NonNullable<typeof back>;
    assert.deepEqual(backRest, seedRest); // name is supplied to parseProfile; the rest is identical
  }
});

test("serializeProfile builds from a copy (frozen seed untouched) + budget snake_case (CLI-044)", () => {
  const toml = serializeProfile({
    name: "x",
    agent: { model: "m", tools: { enabled: true, deny: ["a"] } },
    engine: { gateMode: "enforce", dryRun: true },
    budget: { sessionUsd: 5, warnAtPercent: 80 },
  });
  assert.match(toml, /session_usd = 5/); // budget keys are snake_case
  const back = parseProfile(toml, "x");
  assert.equal(back?.budget?.sessionUsd, 5);
  assert.equal(back?.budget?.warnAtPercent, 80);
  assert.deepEqual(back?.agent.tools?.deny, ["a"]);
  // serializing a builtin never mutates the frozen seed (Object.freeze would throw otherwise)
  serializeProfile(
    BUILTIN_CLI_PROFILES.default as NonNullable<typeof BUILTIN_CLI_PROFILES.default>,
  );
  assert.equal(BUILTIN_CLI_PROFILES.default?.engine.gateMode, "warn");
});

test("listProfiles: builtins + user names; a user file shadows a same-named builtin (CLI-044)", () => {
  const byName = Object.fromEntries(
    listProfiles(["mine", "default"]).map((e) => [e.name, e.source]),
  );
  assert.equal(byName.mine, "user");
  assert.equal(byName.default, "user"); // user file shadows the builtin
  assert.equal(byName.ci, "builtin");
  assert.equal(byName.airgapped, "builtin");
});

test("nearestKey: near typos suggest; an unrelated typo suggests nothing (CLI-045)", () => {
  const known = Object.keys(CONFIG_SCHEMA);
  assert.equal(nearestKey("profile.activ", known), "profile.active"); // 1 edit
  assert.equal(nearestKey("profil.actve", known), "profile.active"); // 2 edits
  assert.equal(nearestKey("zzzzz.qqqqqq", known), undefined); // nowhere near
});

test("valueType: string/number/boolean/string[] incl. empty array (CLI-045)", () => {
  assert.equal(valueType("x"), "string");
  assert.equal(valueType(1), "number");
  assert.equal(valueType(true), "boolean");
  assert.equal(valueType(["a", "b"]), "string[]");
  assert.equal(valueType([]), "string[]"); // empty array is a valid string[]
});

test("validateConfig: unknown key warns; known key wrong type errors (CLI-045)", () => {
  const t = parseToml('[profile]\nactive = 5\n[unknown]\nkey = "x"\n'); // active is a string key
  const v = validateConfig(t);
  assert.ok(
    v.errors.some(
      (e) => e.key === "profile.active" && /expects string, got number/.test(e.message),
    ),
  );
  assert.ok(v.warnings.some((w) => w.key === "unknown.key"));
});

test("effectiveConfig: default vs user provenance; unknown user keys appended (CLI-045)", () => {
  const eff = effectiveConfig(parseToml("[extra]\nz = 1\n")); // profile.active unset
  assert.equal(eff.find((e) => e.key === "profile.active")?.source, "default");
  assert.equal(eff.find((e) => e.key === "extra.z")?.source, "user");
  const eff2 = effectiveConfig(parseToml('[profile]\nactive = "ci"\n'));
  assert.equal(eff2.find((e) => e.key === "profile.active")?.source, "user");
});

test("discoverProjectToml: finds nearest; stops at git root / home / fs root (CLI-046)", () => {
  const home = "/home/u";
  const set = (...p: string[]) => {
    const s = new Set(p);
    return (path: string) => s.has(path);
  };
  // nearest wins, and a repo config beside .git is searched BEFORE the git-root stop.
  assert.equal(
    discoverProjectToml("/home/u/proj/src/deep", {
      exists: set("/home/u/proj/.prom.toml", "/home/u/proj/.git"),
      home,
    }),
    "/home/u/proj/.prom.toml",
  );
  // a .prom.toml ABOVE the git root is never reached (walk stops at the repo root).
  assert.equal(
    discoverProjectToml("/home/u/proj/src", {
      exists: set("/home/u/.prom.toml", "/home/u/proj/.git"),
      home,
    }),
    undefined,
  );
  // home boundary: home itself is searched, then the walk stops (dotfile-repo case).
  assert.equal(
    discoverProjectToml("/home/u/sub", { exists: set("/home/u/.prom.toml"), home }),
    "/home/u/.prom.toml",
  );
  // above home is never crossed.
  assert.equal(
    discoverProjectToml("/home/u/sub", { exists: set("/home/.prom.toml"), home }),
    undefined,
  );
  // .git as a FILE (submodule / linked worktree) also stops.
  assert.equal(
    discoverProjectToml("/home/u/proj/x", { exists: set("/home/u/proj/.git"), home }),
    undefined,
  );
  // nothing anywhere → undefined, and the walk terminates at fs root.
  assert.equal(discoverProjectToml("/a/b/c", { exists: () => false, home: "/nope" }), undefined);
});

test("resolveEffectiveProfile: project > user > builtin, scalar-replace (CLI-046)", () => {
  const builtin = getCliProfile("default") as CliProfile;
  const user: CliProfile = { agent: { model: "user-model" }, engine: { gateMode: "warn" } };
  const project: CliProfile = { agent: { model: "project-model" }, engine: {} };
  const eff = resolveEffectiveProfile({ builtin, user, project });
  assert.equal(eff.agent.model, "project-model"); // project wins
  assert.equal(eff.engine.gateMode, "warn"); // project didn't set it → user's value
  // no project layer → user wins over builtin
  assert.equal(resolveEffectiveProfile({ builtin, user }).agent.model, "user-model");
  // A DENY ACCUMULATES across layers rather than being replaced. Wholesale replacement was
  // right for a preference and wrong for a safety decision: under it, a user who denied
  // `run_command` had it silently re-armed by any repo whose config happened to deny something
  // else. A project file may ADD a deny; it may not lift one.
  const u: CliProfile = { agent: { model: "m", tools: { deny: ["a", "b"] } }, engine: {} };
  const p: CliProfile = { agent: { model: "m", tools: { deny: ["z"] } }, engine: {} };
  assert.deepEqual(resolveEffectiveProfile({ builtin, user: u, project: p }).agent.tools?.deny, [
    "a",
    "b",
    "z",
  ]);
});

/* ── the project layer is untrusted: tighten-only ───────────────────────────*/

/**
 * A `.prometheus.toml` is found by walking UPWARD from the working directory, so it arrives with
 * the code. Cloning a repository and running `prometheus` inside it was enough to apply it — and
 * it was the top-priority layer for every key, including `gateMode`. A checked-in
 * `gateMode = "off"` silently disabled the nemesis scan for anyone who visited that directory.
 *
 * These pin the asymmetry that fixes it: the project layer may make the posture STRICTER than
 * the user's, and may still do everything a project config is for. It cannot make it looser.
 */

const BUILTIN = (): CliProfile => getCliProfile("default") as CliProfile;
const proj = (over: Partial<CliProfile>): CliProfile => ({
  agent: { model: "m" },
  engine: {},
  ...over,
});

test("a project file CANNOT turn the nemesis gate down", () => {
  const user: CliProfile = { agent: { model: "m" }, engine: { gateMode: "enforce" } };
  const project = proj({ engine: { gateMode: "off" } });
  const { profile, rejected } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project,
  });
  assert.equal(profile.engine.gateMode, "enforce");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.key, "engine.gateMode");
  assert.match(rejected[0]?.reason ?? "", /cannot turn the scanner down/);
});

test("`warn` is still a downgrade from `enforce` and is refused too", () => {
  const user: CliProfile = { agent: { model: "m" }, engine: { gateMode: "enforce" } };
  const { profile } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ engine: { gateMode: "warn" } }),
  });
  assert.equal(profile.engine.gateMode, "enforce");
});

test("a project file CAN tighten the gate — that direction is allowed", () => {
  // The rule is about direction, not about ignoring the repo. A repo that wants MORE scrutiny
  // than the user's default gets it.
  const user: CliProfile = { agent: { model: "m" }, engine: { gateMode: "warn" } };
  const { profile, rejected } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ engine: { gateMode: "enforce" } }),
  });
  assert.equal(profile.engine.gateMode, "enforce");
  assert.deepEqual(rejected, []);
});

test("a project file cannot grant blanket auto-approval", () => {
  const user: CliProfile = { agent: { model: "m" }, engine: { yes: false } };
  const { profile, rejected } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ engine: { yes: true } }),
  });
  assert.notEqual(profile.engine.yes, true);
  assert.ok(rejected.some((r) => r.key === "engine.yes"));
});

test("a project file CAN withdraw auto-approval the user granted", () => {
  const user: CliProfile = { agent: { model: "m" }, engine: { yes: true } };
  const { profile } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ engine: { yes: false } }),
  });
  assert.equal(profile.engine.yes, false);
});

test("a project file cannot cancel the user's dry-run", () => {
  const user: CliProfile = { agent: { model: "m" }, engine: { dryRun: true } };
  const { profile, rejected } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ engine: { dryRun: false } }),
  });
  assert.equal(profile.engine.dryRun, true);
  assert.ok(rejected.some((r) => r.key === "engine.dryRun"));
});

test("a project file can NEVER repoint the engine or interpreter binary", () => {
  // There is no "tightening" direction for a path — it is arbitrary code execution by config,
  // so the project layer does not get the key at all, in either direction.
  const { profile, rejected } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user: { agent: { model: "m" }, engine: {} },
    project: proj({ engine: { paths: { python: "/tmp/evil", prometheusPy: "/tmp/evil.py" } } }),
  });
  assert.equal(profile.engine.paths, undefined);
  assert.ok(rejected.some((r) => r.key === "engine.paths"));
});

test("a project file cannot re-arm a tool the user denied", () => {
  const user: CliProfile = {
    agent: { model: "m", tools: { deny: ["run_command"] } },
    engine: {},
  };
  const { profile, rejected } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ agent: { model: "m", tools: { deny: ["web_fetch"] } } }),
  });
  assert.deepEqual(profile.agent.tools?.deny, ["run_command", "web_fetch"]);
  assert.ok(rejected.some((r) => r.key === "agent.tools.deny"));
});

test("a project file cannot widen the user's allow-list, but can narrow it", () => {
  const user: CliProfile = {
    agent: { model: "m", tools: { allow: ["read_file", "grep"] } },
    engine: {},
  };
  const widen = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ agent: { model: "m", tools: { allow: ["read_file", "run_command"] } } }),
  });
  assert.deepEqual(widen.profile.agent.tools?.allow, ["read_file"]);
  assert.ok(widen.rejected.some((r) => r.key === "agent.tools.allow"));

  const narrow = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ agent: { model: "m", tools: { allow: ["grep"] } } }),
  });
  assert.deepEqual(narrow.profile.agent.tools?.allow, ["grep"]);
});

test("a budget cap may only come DOWN", () => {
  const user: CliProfile = { agent: { model: "m" }, engine: {}, budget: { sessionUsd: 5 } };
  const raise = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ budget: { sessionUsd: 500 } }),
  });
  assert.equal(raise.profile.budget?.sessionUsd, 5);
  const lower = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({ budget: { sessionUsd: 1 } }),
  });
  assert.equal(lower.profile.budget?.sessionUsd, 1);
});

test("the benign keys a project config is actually FOR still win outright", () => {
  // The fix must not turn `.prometheus.toml` into a decoration.
  const user: CliProfile = { agent: { model: "user-model", maxIterations: 4 }, engine: {} };
  const { profile, rejected } = resolveEffectiveProfileWithNotes({
    builtin: BUILTIN(),
    user,
    project: proj({
      agent: { model: "project-model", systemPrompt: "repo prompt", maxIterations: 12 },
    }),
  });
  assert.equal(profile.agent.model, "project-model");
  assert.equal(profile.agent.systemPrompt, "repo prompt");
  assert.equal(profile.agent.maxIterations, 12);
  assert.deepEqual(rejected, []);
});

test("the plain resolver is the SAFE one — the hole cannot be reintroduced by forgetting", () => {
  // resolveEffectiveProfile delegates to the sanitizing path; there is no raw merge exported.
  const eff = resolveEffectiveProfile({
    builtin: BUILTIN(),
    user: { agent: { model: "m" }, engine: { gateMode: "enforce" } },
    project: proj({ engine: { gateMode: "off" } }),
  });
  assert.equal(eff.engine.gateMode, "enforce");
});

/* ── [agent] effort — a configured tier has to survive session start (P3) ───*/

test("[agent] effort round-trips TOML → profile → AgentTuning", () => {
  // The whole point of the key: `effort = "high"` in a profile was a line the file accepted
  // and nothing read, so a session always started unset regardless.
  const p = parseProfile('[agent]\nmodel = "ollama:qwen3:8b"\neffort = "high"\n', "x");
  assert.equal(p?.agent.effort, "high");
  assert.equal(resolveTuning(p as CliProfile).effort, "high");
  const back = parseProfile(serializeProfile(p as CliProfile), "x");
  assert.equal(back?.agent.effort, "high");
});

test("a typo'd tier is REFUSED, not carried as a string that fails a comparison later", () => {
  // `effort = "maximum"` must read as "not configured", which is what it is — and must not
  // reach `AgentTuning.effort` as a value nothing in the ladder matches.
  const p = parseProfile('[agent]\nmodel = "m"\neffort = "maximum"\n', "x");
  assert.equal(p?.agent.effort, undefined);
  assert.equal(resolveTuning(p as CliProfile).effort, undefined);
});

test("UNSET is not `off` — the two mean different things to the badge and to /status", () => {
  const p = parseProfile('[agent]\nmodel = "m"\n', "x");
  assert.equal(resolveTuning(p as CliProfile).effort, undefined);
  const off = parseProfile('[agent]\nmodel = "m"\neffort = "off"\n', "x");
  assert.equal(resolveTuning(off as CliProfile).effort, "off");
});

test("--effort / --force-effort win over every config layer (flags are the human, §6)", () => {
  const profile: CliProfile = { agent: { model: "m", effort: "low" }, engine: {} };
  const merged = mergeFlags(profile, { effort: "max", effortForce: true });
  assert.equal(merged.agent.effort, "max");
  assert.equal(resolveTuning(merged).effort, "max");
  assert.equal(resolveTuning(merged).effortForce, true);
  // …and an absent flag leaves the configured value alone.
  assert.equal(mergeFlags(profile, {}).agent.effort, "low");
});

test("the PROJECT layer may pin a tier but NOT force past the capability table", () => {
  // `.prometheus.toml` arrives with the code. A repo pinning `effort = "high"` is a
  // preference; a repo enabling `effortForce` would be deciding, for anyone who cloned it,
  // to send parameters this table says will 400 — the same reason the project layer may
  // tighten the safety posture and never loosen it.
  const builtin: CliProfile = { agent: { model: "builtin" }, engine: {} };
  const user: CliProfile = { agent: { model: "u", effortForce: true }, engine: {} };
  const project: CliProfile = {
    agent: { model: "p", effort: "max", effortForce: true },
    engine: {},
  };

  const fromProject = resolveEffectiveProfile({ builtin, project });
  assert.equal(fromProject.agent.effort, "max", "a project MAY pin the tier");
  assert.equal(fromProject.agent.effortForce, undefined, "a project may NOT enable forcing");

  const fromUser = resolveEffectiveProfile({ builtin, user, project });
  assert.equal(fromUser.agent.effortForce, true, "the user's own machine still may");
});

/* ── one home: the config root move + its migration ────────────────────────── */

test("configDir hangs off the ONE Prometheus home, and the twin agrees with prometheusHome()", async () => {
  // `paths.ts` cannot import the agent host layer, so it carries a local copy of the
  // `$PROMETHEUS_HOME` → `~/.prometheus` rule. Two copies of a path rule is exactly how the
  // config tree and the state tree came to disagree in the first place; this pins them together.
  const { prometheusHome } = await import("../agent/system/host/home.js");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const saved = process.env.PROMETHEUS_HOME;
  try {
    process.env.PROMETHEUS_HOME = "";
    assert.equal(configDir(), join(prometheusHome({}), "config"));
    assert.equal(configDir(), join(homedir(), ".prometheus", "config"));

    // $PROMETHEUS_HOME sandboxes the config tree too — it used to have ZERO effect on it, so one
    // variable moved the state tree and left the settings pointing at the real machine.
    process.env.PROMETHEUS_HOME = "/tmp/sandbox-home";
    assert.equal(configDir(), join("/tmp/sandbox-home", "config"));
    assert.equal(configDir(), join(prometheusHome(process.env), "config"));

    // an EXPLICIT home still wins over the env — that is the DI seam every host and test uses
    assert.equal(configDir("/home/u"), "/home/u/.prometheus/config");
  } finally {
    // Reflect.deleteProperty, not `delete` — biome flags the operator, and the fix it suggests
    // (`= undefined`) is wrong for process.env: Node coerces it to the STRING "undefined".
    if (saved === undefined) Reflect.deleteProperty(process.env, "PROMETHEUS_HOME");
    else process.env.PROMETHEUS_HOME = saved;
  }
});

test("a $PROMETHEUS_HOME sandbox does NOT read the real ~/.config — the legacy fallback is off", async () => {
  // The read side used to undo what the migration refuses: an EMPTY sandbox tree still inherited
  // the developer's real saved autonomy level, effort tier and active profile, because the legacy
  // root resolves to the OS home whatever $PROMETHEUS_HOME says. A CI run with an old
  // `{"level":7}` on the machine started at full autonomy instead of the safe default.
  const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readSavedAuthLevel } = await import("./authorisation-store.js");
  const { readSavedEffort } = await import("./effort-store.js");
  const { hasLegacyConfigDir } = await import("./paths.js");

  const fakeHome = mkdtempSync(join(tmpdir(), "prom-fakehome-"));
  const sandbox = mkdtempSync(join(tmpdir(), "prom-sandbox-"));
  const savedHome = process.env.HOME;
  const savedProm = process.env.PROMETHEUS_HOME;
  try {
    // a real machine with settings from an old install
    const legacy = join(fakeHome, ".config", "prometheus-studio");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "authorisation.json"), '{"level":7}');
    writeFileSync(join(legacy, "effort.json"), '{"tier":"max"}');
    process.env.HOME = fakeHome;

    // with no sandbox, the legacy values ARE the fallback — that path must keep working
    process.env.PROMETHEUS_HOME = "";
    assert.equal(hasLegacyConfigDir(), true);
    assert.equal(readSavedAuthLevel(), 7, "an unmigrated install still finds its saved level");
    assert.equal(readSavedEffort(), "max");

    // inside a sandbox, nothing leaks in from the real home
    process.env.PROMETHEUS_HOME = sandbox;
    assert.equal(hasLegacyConfigDir(), false);
    assert.equal(readSavedAuthLevel(), null, "a sandbox must not inherit the machine's level");
    assert.equal(readSavedEffort(), null);

    // an EXPLICIT home is the DI seam and always has a legacy root, sandbox or not
    assert.equal(hasLegacyConfigDir(fakeHome), true);
    assert.equal(readSavedAuthLevel(fakeHome), 7);
  } finally {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = savedHome;
    if (savedProm === undefined) Reflect.deleteProperty(process.env, "PROMETHEUS_HOME");
    else process.env.PROMETHEUS_HOME = savedProm;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("migrateLegacyConfigDir copies the old tree once, never clobbers, never deletes", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { migrateLegacyConfigDir } = await import("./migrate.js");

  const home = mkdtempSync(join(tmpdir(), "prom-migrate-"));
  try {
    const legacy = join(home, ".config", "prometheus-studio");
    mkdirSync(join(legacy, "profiles"), { recursive: true });
    writeFileSync(join(legacy, "authorisation.json"), '{"level":6}');
    writeFileSync(join(legacy, "config.toml"), "gate = 'warn'\n");
    writeFileSync(join(legacy, "profiles", "ci.toml"), "name = 'ci'\n");

    const first = migrateLegacyConfigDir(home);
    assert.deepEqual(first.copied.sort(), [
      "authorisation.json",
      "config.toml",
      "profiles/ci.toml",
    ]);
    const now = configDir(home);
    assert.equal(readFileSync(join(now, "authorisation.json"), "utf8"), '{"level":6}');
    assert.equal(readFileSync(join(now, "profiles", "ci.toml"), "utf8"), "name = 'ci'\n");
    // the originals are LEFT IN PLACE — an older build, or a rollback, must still find them
    assert.equal(existsSync(join(legacy, "authorisation.json")), true);

    // idempotent, and a value the user has since changed is NOT reverted by a second run
    writeFileSync(join(now, "authorisation.json"), '{"level":2}');
    const second = migrateLegacyConfigDir(home);
    assert.deepEqual(second.copied, [], "a second run must copy nothing");
    assert.equal(second.skipped.length, 3);
    assert.equal(
      readFileSync(join(now, "authorisation.json"), "utf8"),
      '{"level":2}',
      "migration overwrote a newer value the user had already set",
    );

    // a home with no legacy tree is a no-op, not an error
    const fresh = mkdtempSync(join(tmpdir(), "prom-migrate-fresh-"));
    assert.equal(migrateLegacyConfigDir(fresh).reason, "no-legacy");
    rmSync(fresh, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
