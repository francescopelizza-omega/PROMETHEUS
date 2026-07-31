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
  assert.equal(profilesDir("/home/u"), "/home/u/.config/prometheus-studio/profiles");
  assert.equal(profilePath("ci", "/home/u"), "/home/u/.config/prometheus-studio/profiles/ci.toml");
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
  assert.equal(configDir("/home/u"), "/home/u/.config/prometheus-studio");
  assert.equal(configPath("/home/u"), "/home/u/.config/prometheus-studio/config.toml");
  assert.equal(profilesDir("/home/u"), "/home/u/.config/prometheus-studio/profiles");
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
  // arrays are REPLACED wholesale by the winning layer, never concatenated
  const u: CliProfile = { agent: { model: "m", tools: { deny: ["a", "b"] } }, engine: {} };
  const p: CliProfile = { agent: { model: "m", tools: { deny: ["z"] } }, engine: {} };
  assert.deepEqual(resolveEffectiveProfile({ builtin, user: u, project: p }).agent.tools?.deny, [
    "z",
  ]);
});
