/**
 * run-config.test.ts — node:test for the PURE run/debug configuration model.
 *
 * Pins JSONC stripping (comments + trailing commas, string-safe), launch.json → typed
 * RunConfig[] normalization (incl. compounds), and cycle-guarded compound resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type RunConfig,
  buildRawConfig,
  buildRunInvocation,
  buildRunPickerRows,
  debugTypeAndPython,
  dedupeConfigsByName,
  deleteConfig,
  duplicateConfig,
  mergeImportCandidates,
  parseJetBrainsRunConfig,
  parseJsonc,
  parseLaunchJson,
  parseRunAnything,
  resolveRunOrder,
  runToolbarState,
  sanitizeRunEnv,
  serializeLaunchJson,
  stripJsonc,
  substituteVars,
  upsertConfig,
} from "./run-config.js";

test("stripJsonc removes line + block comments and trailing commas, keeps strings", () => {
  const src = `{
    // line comment
    "a": 1, /* block */
    "url": "http://x//y", // keep the // inside the string
    "b": [1, 2,],
  }`;
  const parsed = JSON.parse(stripJsonc(src));
  assert.deepEqual(parsed, { a: 1, url: "http://x//y", b: [1, 2] });
});

test("stripJsonc: a `,}` / `,]` INSIDE a string value is preserved (not mistaken for a trailing comma)", () => {
  const src = `{ "args": ["{a,}", "*.{js,}"], "msg": "hi,]" }`;
  assert.deepEqual(JSON.parse(stripJsonc(src)), { args: ["{a,}", "*.{js,}"], msg: "hi,]" });
});

test("parseJsonc is fail-soft (null on garbage)", () => {
  assert.equal(parseJsonc("{ not json"), null);
});

test("parseLaunchJson normalizes configurations", () => {
  const cfgs = parseLaunchJson(`{
    "version": "0.2.0",
    "configurations": [
      { "name": "API", "type": "debugpy", "request": "launch", "module": "uvicorn",
        "args": ["app:api"], "env": { "DEBUG": "1" }, "preLaunchTask": "build" },
      { "name": "Attach", "type": "python", "request": "attach" }
    ]
  }`);
  assert.equal(cfgs.length, 2);
  const api = cfgs.find((c) => c.name === "API");
  assert.ok(api);
  assert.equal(api.type, "debugpy");
  assert.equal(api.module, "uvicorn");
  assert.deepEqual(api.args, ["app:api"]);
  assert.deepEqual(api.env, { DEBUG: "1" });
  assert.equal(api.preLaunchTask, "build");
  assert.equal(cfgs.find((c) => c.name === "Attach")?.request, "attach");
});

test("configs without a name are dropped; a bare array is accepted", () => {
  const cfgs = parseLaunchJson(`[{ "type": "python" }, { "name": "ok", "type": "python" }]`);
  assert.deepEqual(
    cfgs.map((c) => c.name),
    ["ok"],
  );
});

test("compounds become type:compound entries with member names", () => {
  const cfgs = parseLaunchJson(`{
    "configurations": [
      { "name": "Server", "type": "python", "request": "launch" },
      { "name": "Worker", "type": "python", "request": "launch" }
    ],
    "compounds": [ { "name": "All", "configurations": ["Server", "Worker"] } ]
  }`);
  const all = cfgs.find((c) => c.name === "All");
  assert.ok(all);
  assert.equal(all.type, "compound");
  assert.deepEqual(all.compound, ["Server", "Worker"]);
});

test("resolveRunOrder expands a compound to its members (missing dropped)", () => {
  const cfgs = parseLaunchJson(`{
    "configurations": [
      { "name": "A", "type": "python", "request": "launch" },
      { "name": "B", "type": "python", "request": "launch" }
    ],
    "compounds": [ { "name": "AB", "configurations": ["A", "B", "GONE"] } ]
  }`);
  const order = resolveRunOrder(cfgs, "AB").map((c) => c.name);
  assert.deepEqual(order, ["A", "B"]);
});

test("resolveRunOrder is cycle-guarded and dedupes", () => {
  const cfgs = parseLaunchJson(`{
    "configurations": [ { "name": "X", "type": "python", "request": "launch" } ],
    "compounds": [
      { "name": "C1", "configurations": ["C2", "X"] },
      { "name": "C2", "configurations": ["C1", "X"] }
    ]
  }`);
  const order = resolveRunOrder(cfgs, "C1").map((c) => c.name);
  assert.deepEqual(order, ["X"]); // X once, no infinite recursion
  assert.deepEqual(resolveRunOrder(cfgs, "nope"), []);
});

test("a plain config resolves to itself", () => {
  const cfgs = parseLaunchJson(
    `{ "configurations": [ { "name": "solo", "type": "node", "request": "launch" } ] }`,
  );
  assert.deepEqual(
    resolveRunOrder(cfgs, "solo").map((c) => c.name),
    ["solo"],
  );
});

test("debugTypeAndPython: null config defaults to python, no interpreter", () => {
  assert.deepEqual(debugTypeAndPython(null), { type: "python" });
});

test("debugTypeAndPython: normalizes the legacy 'debugpy' type to 'python'", () => {
  assert.deepEqual(debugTypeAndPython({ type: "debugpy" }), { type: "python" });
});

test("debugTypeAndPython: carries a resolved interpreter path through", () => {
  assert.deepEqual(debugTypeAndPython({ type: "python", python: "/venv/bin/python" }), {
    type: "python",
    python: "/venv/bin/python",
  });
});

test("debugTypeAndPython: passes through a non-python type unchanged (no interpreter)", () => {
  assert.deepEqual(debugTypeAndPython({ type: "node" }), { type: "node" });
});

test("debugTypeAndPython: a missing/non-string type defaults to python", () => {
  assert.deepEqual(debugTypeAndPython({ name: "x" }), { type: "python" });
});

/* ── buildRunInvocation (APP-032) ───────────────────────────────────────────*/

function cfg(over: Partial<RunConfig> & { raw?: Record<string, unknown> }): RunConfig {
  return {
    name: "t",
    type: "python",
    request: "launch",
    raw: over.raw ?? {},
    ...over,
  };
}

test("substituteVars: bounded known set; unknown ${...} stays literal", () => {
  const ctx = { workspaceRoot: "/proj/app", file: "/proj/app/src/m.py", env: { USER: "fp" } };
  assert.equal(substituteVars("${workspaceFolder}/x", ctx), "/proj/app/x");
  assert.equal(substituteVars("${workspaceFolderBasename}", ctx), "app");
  assert.equal(substituteVars("${cwd}", ctx), "/proj/app");
  assert.equal(substituteVars("${file}", ctx), "/proj/app/src/m.py");
  assert.equal(substituteVars("${fileDirname}", ctx), "/proj/app/src");
  assert.equal(substituteVars("${env:USER}-${env:NOPE}", ctx), "fp-");
  assert.equal(substituteVars("${command:pickProcess}", ctx), "${command:pickProcess}");
  // no active file → the file vars stay literal instead of crashing
  assert.equal(substituteVars("${file}", { workspaceRoot: "/p" }), "${file}");
});

test("buildRunInvocation: program vs module argv; module name validated", () => {
  const prog = buildRunInvocation(
    cfg({ program: "${workspaceFolder}/main.py", args: ["--verbose", "a b"] }),
    "/proj",
  );
  assert.ok(typeof prog !== "string");
  assert.equal(prog.cmd, "python3");
  // args stay an ARRAY — the spaced value is ONE token, never a shell fragment
  assert.deepEqual(prog.args, ["/proj/main.py", "--verbose", "a b"]);
  assert.equal(prog.cwd, "/proj");
  const mod = buildRunInvocation(cfg({ module: "pkg.tool" }), "/proj");
  assert.ok(typeof mod !== "string");
  assert.deepEqual(mod.args, ["-m", "pkg.tool"]);
  // a flag-shaped module name must never reach python as a flag
  assert.equal(typeof buildRunInvocation(cfg({ module: "-c" }), "/proj"), "string");
  assert.equal(typeof buildRunInvocation(cfg({ module: "evil; rm" }), "/proj"), "string");
});

test("buildRunInvocation: a `-`-leading program is rejected (no option-injection / RCE)", () => {
  // a workspace launch.json `program:"--eval=…"` would otherwise reach node/python as a FLAG.
  assert.equal(
    typeof buildRunInvocation(cfg({ program: "--eval=require('x')" }), "/proj"),
    "string",
  );
  assert.equal(
    typeof buildRunInvocation({ ...cfg({ program: "-cimport os" }), type: "node" }, "/proj"),
    "string",
  );
});

test("buildRunInvocation: interpreter from raw.python > opts > python3; debugpy = python", () => {
  const own = buildRunInvocation(
    cfg({ program: "m.py", type: "debugpy", raw: { python: "/venv/bin/python" } }),
    "/p",
  );
  assert.ok(typeof own !== "string");
  assert.equal(own.cmd, "/venv/bin/python");
  const opt = buildRunInvocation(cfg({ program: "m.py" }), "/p", { interpreter: "/opt/py" });
  assert.ok(typeof opt !== "string");
  assert.equal(opt.cmd, "/opt/py");
});

test("buildRunInvocation: env merge sanitized — hostile keys dropped AND reported", () => {
  const inv = buildRunInvocation(
    cfg({
      program: "m.py",
      env: { DEBUG: "${workspaceFolder}", LD_PRELOAD: "/evil.so", PATH: "/evil" },
    }),
    "/proj",
  );
  assert.ok(typeof inv !== "string");
  assert.deepEqual(inv.env, { DEBUG: "/proj" });
  assert.deepEqual(inv.droppedEnvKeys.sort(), ["LD_PRELOAD", "PATH"]);
});

test("buildRunInvocation: honest error strings for unrunnable configs", () => {
  assert.match(buildRunInvocation(cfg({ type: "compound" }), "/p") as string, /compound/);
  assert.match(
    buildRunInvocation(cfg({ request: "attach", program: "x" }), "/p") as string,
    /attach/,
  );
  assert.match(buildRunInvocation(cfg({}), "/p") as string, /neither program nor module/);
  assert.match(
    buildRunInvocation(cfg({ type: "cobol", program: "x" }), "/p") as string,
    /unsupported/,
  );
  // node runs its program under node
  const node = buildRunInvocation(cfg({ type: "node", program: "srv.js" }), "/p");
  assert.ok(typeof node !== "string");
  assert.equal(node.cmd, "node");
});

test("sanitizeRunEnv: ident-only keys, denylist enforced, drops reported", () => {
  const { env, dropped } = sanitizeRunEnv({
    OK_1: "v",
    "bad key": "v",
    dyld_insert_libraries: "v",
    NODE_OPTIONS: "v",
  });
  assert.deepEqual(env, { OK_1: "v" });
  assert.deepEqual(dropped.sort(), ["NODE_OPTIONS", "bad key", "dyld_insert_libraries"]);
});

/* ── launch.json mutation + serialization (APP-033) ─────────────────────────*/

const DOC = `{
  // user comment (lost at parse — accepted trade)
  "version": "0.2.0",
  "configurations": [
    { "name": "api", "type": "debugpy", "request": "launch", "module": "uvicorn",
      "args": ["app:main"], "justMyCode": false, "env": { "STAGE": "dev" } },
    { "name": "worker", "type": "debugpy", "request": "launch", "program": "\${workspaceFolder}/w.py" },
  ],
  "compounds": [ { "name": "all", "configurations": ["api", "worker"], "stopAll": true } ],
}`;

test("round-trip: parse → serialize → parse is deep-equal incl. unknown fields + compounds", () => {
  const configs = parseLaunchJson(DOC);
  const text = serializeLaunchJson(configs);
  const again = parseLaunchJson(text);
  assert.deepEqual(
    again.map((c) => c.raw),
    configs.map((c) => c.raw),
  );
  // unknown field + ${...} variable survive VERBATIM
  assert.match(text, /"justMyCode": false/);
  assert.match(text, /\$\{workspaceFolder\}\/w\.py/);
  assert.match(text, /"stopAll": true/);
  assert.ok(text.endsWith("\n"));
});

test("buildRawConfig: known keys first, unknown prevRaw fields survive, cleared fields drop", () => {
  const prev = {
    name: "api",
    type: "debugpy",
    request: "launch",
    module: "uvicorn",
    justMyCode: false,
  };
  const raw = buildRawConfig(
    { name: "api", type: "debugpy", request: "launch", program: "m.py" },
    prev,
  );
  assert.deepEqual(Object.keys(raw).slice(0, 3), ["name", "type", "request"]);
  assert.equal(raw.program, "m.py");
  assert.equal(raw.module, undefined, "the cleared module is NOT resurrected from prevRaw");
  assert.equal(raw.justMyCode, false, "unknown fields ride along");
});

test("upsertConfig: create, edit-in-place, rename ripples through compounds, collisions refused", () => {
  const configs = parseLaunchJson(DOC);
  // create
  const created = upsertConfig(configs, {
    name: "new",
    type: "debugpy",
    request: "launch",
    program: "x.py",
  });
  assert.ok(Array.isArray(created));
  assert.equal(created.length, configs.length + 1);
  // edit in place (same name) keeps position + unknown fields
  const edited = upsertConfig(
    configs,
    { name: "api", type: "debugpy", request: "launch", module: "uvicorn", args: ["app:alt"] },
    "api",
  );
  assert.ok(Array.isArray(edited));
  assert.equal(edited[0]?.name, "api");
  assert.deepEqual(edited[0]?.args, ["app:alt"]);
  assert.equal(edited[0]?.raw.justMyCode, false);
  // rename updates the compound member list — never a silent orphan
  const renamed = upsertConfig(
    configs,
    { name: "api2", type: "debugpy", request: "launch", module: "uvicorn" },
    "api",
  );
  assert.ok(Array.isArray(renamed));
  const compound = renamed.find((c) => c.type === "compound");
  assert.deepEqual(compound?.compound, ["api2", "worker"]);
  assert.deepEqual(compound?.raw.configurations, ["api2", "worker"]);
  // refusals
  assert.match(
    upsertConfig(configs, { name: "  ", type: "debugpy", request: "launch" }) as string,
    /empty/,
  );
  assert.match(
    upsertConfig(configs, { name: "worker", type: "debugpy", request: "launch" }, "api") as string,
    /already exists/,
  );
});

test("duplicateConfig: independent clone with a uniquified name", () => {
  const configs = parseLaunchJson(DOC);
  const once = duplicateConfig(configs, "api");
  assert.ok(Array.isArray(once));
  const twice = duplicateConfig(once, "api");
  assert.ok(Array.isArray(twice));
  const names = twice.map((c) => c.name);
  assert.ok(names.includes("api copy"));
  assert.ok(names.includes("api copy 2"));
  const clone = twice.find((c) => c.name === "api copy");
  // deep-independent raw: mutating the clone's env never touches the original
  (clone?.raw.env as Record<string, string>).STAGE = "prod";
  assert.equal((configs[0]?.raw.env as Record<string, string>).STAGE, "dev");
  assert.match(duplicateConfig(configs, "nope") as string, /no configuration/);
});

test("deleteConfig: removes exactly one; compound members drop the deleted name", () => {
  const configs = parseLaunchJson(DOC);
  const next = deleteConfig(configs, "worker");
  assert.deepEqual(
    next.map((c) => c.name),
    ["api", "all"],
  );
  const compound = next.find((c) => c.type === "compound");
  assert.deepEqual(compound?.compound, ["api"]);
  assert.deepEqual(compound?.raw.configurations, ["api"]);
  // unknown name → unchanged
  assert.equal(deleteConfig(configs, "ghost").length, configs.length);
});

/* ── Run-Anything tokenizer + picker rows + toolbar truth table (APP-034) ────*/

test("parseRunAnything: quote-aware argv with ZERO shell expansion", () => {
  assert.deepEqual(parseRunAnything("python -m pytest"), ["python", "-m", "pytest"]);
  assert.deepEqual(parseRunAnything("echo \"a b\" 'c d'"), ["echo", "a b", "c d"]);
  assert.deepEqual(parseRunAnything("printf a\\ b"), ["printf", "a b"]);
  // the security pin: catastrophic if ever shell-joined, harmless as argv
  assert.deepEqual(parseRunAnything("rm -rf /; echo pwned"), ["rm", "-rf", "/;", "echo", "pwned"]);
  // $VAR, ~, *, backticks, && , | all stay literal characters
  assert.deepEqual(parseRunAnything("echo $HOME ~/x * `id` && ls | cat"), [
    "echo",
    "$HOME",
    "~/x",
    "*",
    "`id`",
    "&&",
    "ls",
    "|",
    "cat",
  ]);
  // empty / whitespace-only / empty-quoted program → refused (nothing spawnable)
  assert.deepEqual(parseRunAnything(""), []);
  assert.deepEqual(parseRunAnything("   "), []);
  assert.deepEqual(parseRunAnything('""'), []);
  // an unterminated trailing backslash stays literal
  assert.deepEqual(parseRunAnything("echo x\\"), ["echo", "x\\"]);
});

test("buildRunPickerRows: fuzzy-ranked configs; freeform ALWAYS present and ALWAYS last", () => {
  const configs: RunConfig[] = [
    cfg({ name: "api", program: "a.py" }),
    cfg({ name: "worker", program: "w.py" }),
    { name: "all", type: "compound", request: "launch", compound: ["api"], raw: {} },
  ];
  const score = (q: string, t: string) =>
    t.includes(q) ? { score: t === q ? 100 : 10, positions: [] } : null;
  // empty query: every config + the freeform hint row last
  const all = buildRunPickerRows("", configs, score);
  assert.equal(all.length, 4);
  assert.equal(all[3]?.kind, "freeform");
  assert.deepEqual(all[3]?.argv, []);
  assert.ok(
    all.some((r) => r.label === "all" && r.compound),
    "compounds flagged",
  );
  // a query that prefix-collides with a config name: config ranks first, the
  // freeform row survives (never filtered out) with the resolved argv
  const rows = buildRunPickerRows("api --debug", configs, (q, t) =>
    t.startsWith("api") ? { score: 5, positions: [] } : null,
  );
  const last = rows[rows.length - 1];
  assert.equal(last?.kind, "freeform");
  assert.deepEqual(last?.argv, ["api", "--debug"]);
});

test("runToolbarState: the disabled-state truth table", () => {
  // nothing selected, nothing running
  assert.deepEqual(runToolbarState({ hasConfig: false, runId: null, dapSessionId: null }), {
    runDisabled: true,
    debugDisabled: true,
    stopDisabled: true,
  });
  // config selected, idle
  assert.deepEqual(runToolbarState({ hasConfig: true, runId: null, dapSessionId: null }), {
    runDisabled: false,
    debugDisabled: false,
    stopDisabled: true, // stop disabled when nothing live
  });
  // a live plain run: its Run disables, Stop enables, Debug stays available
  assert.deepEqual(runToolbarState({ hasConfig: true, runId: "r1", dapSessionId: null }), {
    runDisabled: true,
    debugDisabled: false,
    stopDisabled: false,
  });
  // a live DAP session is NOT a plain run: Run stays available, Stop enabled
  assert.deepEqual(runToolbarState({ hasConfig: true, runId: null, dapSessionId: "s1" }), {
    runDisabled: false,
    debugDisabled: true,
    stopDisabled: false,
  });
});

/* ── run-config importers: .vscode / JetBrains (APP-081) ────────────────────*/

test("coerceConfig collects dropped raw keys into unsupported (consumed keys exempt)", () => {
  const cfgs = parseLaunchJson(`{
    "configurations": [
      { "name": "flagged", "type": "debugpy", "request": "launch", "program": "a.py",
        "python": "/venv/bin/python", "console": "integratedTerminal",
        "runtimeArgs": ["-r"], "connect": { "host": "127.0.0.1", "port": 5678 },
        "justMyCode": false, "stopOnEntry": true },
      { "name": "clean", "type": "python", "request": "launch", "program": "b.py" }
    ]
  }`);
  const flagged = cfgs.find((c) => c.name === "flagged");
  assert.ok(flagged);
  // ONLY the fields no consumer maps — python/console/connect/runtimeArgs all ride raw
  assert.deepEqual(flagged.unsupported, ["justMyCode", "stopOnEntry"]);
  assert.equal(cfgs.find((c) => c.name === "clean")?.unsupported, undefined);
});

test("unresolvable ${command:}/${input:} variables are flagged, deduped, never dropped", () => {
  const cfgs = parseLaunchJson(`{
    "configurations": [
      { "name": "x", "type": "python", "request": "launch",
        "program": "\${command:pickProcess}",
        "args": ["\${input:port}", "\${command:pickProcess}", "\${workspaceFolder}/ok"],
        "env": { "P": "\${input:port}" } }
    ]
  }`);
  const c = cfgs[0];
  assert.ok(c);
  assert.deepEqual(c.unsupported, ["var:${command:pickProcess}", "var:${input:port}"]);
  // the values themselves stay in place (visible), only flagged
  assert.equal(c.program, "${command:pickProcess}");
});

test("parseJetBrainsRunConfig: python script config (macros, params, cwd, env, sdk)", () => {
  const c = parseJetBrainsRunConfig(`<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Serve App" type="PythonConfigurationType" factoryName="Python">
    <module name="proj" />
    <option name="SDK_HOME" value="$PROJECT_DIR$/.venv/bin/python" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/src" />
    <option name="SCRIPT_NAME" value="$PROJECT_DIR$/src/app.py" />
    <option name="PARAMETERS" value="--port 8080 &quot;two words&quot;" />
    <envs>
      <env name="MODE" value="a&amp;b" />
      <env name="MULTI" value="l1&#10;l2" />
    </envs>
  </configuration>
</component>`);
  assert.ok(c);
  assert.equal(c.name, "Serve App");
  assert.equal(c.type, "python");
  assert.equal(c.request, "launch");
  // $PROJECT_DIR$ → ${workspaceFolder}, resolved later by the ONE launch substitution site
  assert.equal(c.program, "${workspaceFolder}/src/app.py");
  assert.equal(c.cwd, "${workspaceFolder}/src");
  assert.deepEqual(c.args, ["--port", "8080", "two words"]);
  assert.deepEqual(c.env, { MODE: "a&b", MULTI: "l1\nl2" });
  assert.equal(c.raw.python, "${workspaceFolder}/.venv/bin/python");
  assert.equal(c.unsupported, undefined);
  // raw mirrors the launch.json shape → the native store round-trips it
  assert.equal(c.raw.program, c.program);
  assert.equal(c.raw.type, "python");
});

test("parseJetBrainsRunConfig: MODULE_MODE runs -m (module, not program)", () => {
  const c = parseJetBrainsRunConfig(`<component>
  <configuration name="Mod" type="PythonConfigurationType">
    <option name="SCRIPT_NAME" value="uvicorn" />
    <option name="MODULE_MODE" value="true" />
  </configuration>
</component>`);
  assert.ok(c);
  assert.equal(c.module, "uvicorn");
  assert.equal(c.program, undefined);
});

test("parseJetBrainsRunConfig: node config maps attribute-carried fields", () => {
  const c = parseJetBrainsRunConfig(`<component>
  <configuration name="Serve JS" type="NodeJSConfigurationType"
    path-to-js-file="$PROJECT_DIR$/server.js" working-dir="$PROJECT_DIR$"
    application-parameters="--watch" node-parameters="--inspect=9229">
    <envs><env name="NODE_ENV" value="dev" /></envs>
  </configuration>
</component>`);
  assert.ok(c);
  assert.equal(c.type, "node");
  assert.equal(c.program, "${workspaceFolder}/server.js");
  assert.equal(c.cwd, "${workspaceFolder}");
  assert.deepEqual(c.args, ["--watch"]);
  assert.deepEqual(c.raw.runtimeArgs, ["--inspect=9229"]);
  assert.deepEqual(c.env, { NODE_ENV: "dev" });
});

test("parseJetBrainsRunConfig: unknown type imports name-only, flagged", () => {
  const c = parseJetBrainsRunConfig(
    `<configuration name="Dockerized" type="docker-deploy"></configuration>`,
  );
  assert.ok(c);
  assert.equal(c.type, "docker-deploy");
  assert.deepEqual(c.unsupported, ["type:docker-deploy"]);
});

test("parseJetBrainsRunConfig: malformed / nameless / template XML → null", () => {
  assert.equal(parseJetBrainsRunConfig("not xml at all"), null);
  assert.equal(parseJetBrainsRunConfig(`<configuration type="PythonConfigurationType">`), null);
  // default="true" is the type TEMPLATE, never a user config
  assert.equal(
    parseJetBrainsRunConfig(
      `<configuration default="true" name="tmpl" type="PythonConfigurationType"></configuration>`,
    ),
    null,
  );
});

test("parseJetBrainsRunConfig: entity unescape order — &amp; LAST, numeric hex ok", () => {
  const c = parseJetBrainsRunConfig(`<configuration name="E" type="PythonConfigurationType">
    <option name="SCRIPT_NAME" value="a.py" />
    <envs>
      <env name="DOUBLE" value="&amp;lt;" />
      <env name="TAB" value="x&#9;y" />
      <env name="HEX" value="&#x41;" />
    </envs>
  </configuration>`);
  assert.ok(c);
  // &amp;lt; is the LITERAL text "&lt;" — a wrong order would yield "<"
  assert.deepEqual(c.env, { DOUBLE: "&lt;", TAB: "x\ty", HEX: "A" });
});

test("parseJetBrainsRunConfig: unknown macros stay literal and are flagged", () => {
  const c = parseJetBrainsRunConfig(`<configuration name="M" type="PythonConfigurationType">
    <option name="SCRIPT_NAME" value="$USER_HOME$/run.py" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$" />
  </configuration>`);
  assert.ok(c);
  assert.equal(c.program, "$USER_HOME$/run.py");
  assert.equal(c.cwd, "${workspaceFolder}");
  assert.deepEqual(c.unsupported, ["macro:$USER_HOME$"]);
});

test("an imported JetBrains python config is runnable end-to-end", () => {
  const c = parseJetBrainsRunConfig(`<configuration name="R" type="PythonConfigurationType">
    <option name="SCRIPT_NAME" value="$PROJECT_DIR$/main.py" />
    <option name="PARAMETERS" value="--n 1" />
  </configuration>`);
  assert.ok(c);
  const inv = buildRunInvocation(c, "/proj");
  assert.ok(typeof inv !== "string");
  assert.deepEqual(inv.args, ["/proj/main.py", "--n", "1"]);
  assert.equal(inv.cwd, "/proj");
});

test("mergeImportCandidates: vscode precedence, .idea suffix on collision, native names skipped", () => {
  const vs = [cfg({ name: "API" }), cfg({ name: "done" })];
  const jb = [cfg({ name: "API", raw: { name: "API" } }), cfg({ name: "Worker" })];
  const out = mergeImportCandidates(vs, jb, new Set(["done"]));
  assert.deepEqual(
    out.map((c) => [c.config.name, c.source]),
    [
      ["API", "vscode"],
      ["API (.idea)", "jetbrains"],
      ["Worker", "jetbrains"],
    ],
  );
  // the rename follows into raw.name so the written store stays consistent
  assert.equal(out[1]?.config.raw.name, "API (.idea)");
});

test("mergeImportCandidates: suffix uniquifies; a jetbrains name already native is skipped", () => {
  const jb = [cfg({ name: "X" }), cfg({ name: "X" }), cfg({ name: "native" })];
  const out = mergeImportCandidates([cfg({ name: "X" })], jb, new Set(["native", "X (.idea)"]));
  assert.deepEqual(
    out.map((c) => c.config.name),
    ["X", "X (.idea 2)", "X (.idea 3)"],
  );
});

test("dedupeConfigsByName keeps the FIRST occurrence", () => {
  const out = dedupeConfigsByName([
    cfg({ name: "a", program: "first.py" }),
    cfg({ name: "b" }),
    cfg({ name: "a", program: "second.py" }),
  ]);
  assert.deepEqual(
    out.map((c) => [c.name, c.program]),
    [
      ["a", "first.py"],
      ["b", undefined],
    ],
  );
});

test("a dangling compound member survives the import merge (resolve skips it)", () => {
  const vs = parseLaunchJson(`{
    "configurations": [ { "name": "A", "type": "python", "request": "launch" } ],
    "compounds": [ { "name": "Both", "configurations": ["A", "GONE"] } ]
  }`);
  const merged = mergeImportCandidates(vs, [], new Set());
  const configs = merged.map((c) => c.config);
  assert.deepEqual(
    resolveRunOrder(configs, "Both").map((c) => c.name),
    ["A"],
  );
});
