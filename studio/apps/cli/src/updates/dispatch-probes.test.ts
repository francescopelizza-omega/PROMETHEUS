/**
 * dispatch-probes.test.ts — the read-only facts "update everything" plans from.
 *
 * Parsers are fed brew's real JSON and receipt shapes (captured from Homebrew 7.0.7); the
 * filesystem probes run against throwaway trees under the OS temp dir. The runner is a fake that
 * answers `brew --cellar`, `brew --caskroom`, `brew --prefix`, `brew info`, `brew deps` and
 * `npm root -g` — nothing is spawned.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  brewEnvFiles,
  brewEnvOverrides,
  caskNeedsRoot,
  inspectVenv,
  makeDispatchProbes,
  parseCaskInfo,
  parseDepsForEach,
  readCaskReceipt,
  readFormulae,
} from "./dispatch-probes.js";
import type { StepRunner } from "./run-step.js";

const answer =
  (stdoutFor: (argv: readonly string[]) => string, code = 0): StepRunner =>
  async (argv) => ({ code, stdout: stdoutFor(argv), stderr: "", timedOut: false, aborted: false });

/** Every target writable — the parsers' own rules, without this machine's folders. */
const anywhere = (): boolean => true;

const INFO = JSON.stringify({
  formulae: [],
  casks: [
    {
      token: "codex",
      tap: "homebrew/cask",
      sha256: "007df41b607dbbc8",
      auto_updates: null,
      disabled: false,
      artifacts: [{ binary: ["bin/codex"], target: "/opt/homebrew/bin/codex" }],
    },
    {
      token: "anydesk",
      tap: "homebrew/cask",
      sha256: "no_check",
      artifacts: [{ uninstall: [{ quit: ["com.philandro.anydesk"], delete: ["/Library/x"] }] }],
    },
    { token: "flutter", tap: "homebrew/cask", sha256: "a1", auto_updates: true, artifacts: [] },
    { token: "tool", tap: "someone/tap", sha256: "b2", artifacts: [{ pkg: ["Tool.pkg"] }] },
    { token: "gone", tap: "homebrew/cask", sha256: "c3", disabled: true, artifacts: [] },
  ],
});

const RECEIPT = { tap: "homebrew/cask", flightBlocks: false } as const;

test("brew's cask JSON + receipts → tap, receipt, checksum, self-updating, disabled, needs-root", () => {
  const receipts = new Map(
    ["codex", "anydesk", "flutter", "tool", "gone"].map((t) => [t, { ...RECEIPT }]),
  );
  const facts = parseCaskInfo(INFO, receipts, anywhere);
  assert.deepEqual(facts?.get("codex"), {
    tap: "homebrew/cask",
    receipt: true,
    currentTap: "homebrew/cask",
    checksum: true,
    autoUpdates: false,
    disabled: false,
    needsRoot: false,
  });
  assert.equal(facts?.get("anydesk")?.checksum, false);
  assert.equal(facts?.get("anydesk")?.needsRoot, true);
  assert.equal(facts?.get("flutter")?.autoUpdates, true);
  assert.equal(facts?.get("tool")?.needsRoot, true);
  assert.equal(facts?.get("gone")?.disabled, true);
  assert.equal(parseCaskInfo("not json", receipts), null);
  assert.equal(parseCaskInfo("{}", receipts), null);
});

test("the INSTALLED cask's receipt wins — and a token without one is reported, not filled in", () => {
  // brew info resolves a bare token to today's official cask; the receipt says what is installed
  const facts = parseCaskInfo(
    INFO,
    new Map([
      [
        "codex",
        {
          tap: "someone/codex-tap",
          uninstallArtifacts: [{ uninstall: [{ pkgutil: "com.example.codex" }] }],
          flightBlocks: false,
        },
      ],
      // installed from a file or a URL: the receipt's null tap is an answer
      ["flutter", { tap: "", flightBlocks: false }],
      // old Ruby uninstall blocks: what they run is not in the JSON
      ["tool", { tap: "homebrew/cask", flightBlocks: true }],
    ]),
    anywhere,
  );
  assert.equal(facts?.get("codex")?.tap, "someone/codex-tap");
  assert.equal(facts?.get("codex")?.currentTap, "homebrew/cask");
  assert.equal(facts?.get("codex")?.needsRoot, true);
  assert.equal(facts?.get("flutter")?.tap, "");
  assert.equal(facts?.get("tool")?.needsRoot, true);
  assert.equal(facts?.get("anydesk")?.receipt, false, "no receipt is never brew's tap instead");
  assert.equal(facts?.get("anydesk")?.tap, "");
});

test("caskNeedsRoot: everything Homebrew 7 escalates for — and nothing it does not", () => {
  const root = (artifacts: unknown, canWrite: (t: string) => boolean = anywhere) =>
    caskNeedsRoot(artifacts, canWrite);
  assert.equal(root([{ app: ["X.app"] }, { uninstall: [{ quit: "com.x" }] }]), false);
  assert.equal(root([{ installer: [{ script: "x" }] }]), true);
  assert.equal(root([{ uninstall: [{ pkgutil: "com.x.pkg" }] }]), true);
  assert.equal(root([{ uninstall: [{ kext: "com.x.kext" }] }]), true);
  assert.equal(root([{ uninstall: [{ script: { executable: "x", sudo: true } }] }]), true);
  assert.equal(root([{ uninstall: [{ early_script: { executable: "x", sudo: true } }] }]), true);
  assert.equal(root([{ uninstall: [{ early_script: { executable: "x", sudo: false } }] }]), false);
  // the real `bepo` entry: keyboard layouts go to /Library/Keyboard Layouts
  assert.equal(
    root([
      { keyboard_layout: ["bepo 1.1.bundle"], target: "/Library/Keyboard Layouts/bepo 1.1.bundle" },
    ]),
    true,
  );
  // the real `lightproxy` step: runs `security … sudo: true` in the OLD cask's uninstall
  assert.equal(
    root([
      { app: ["LightProxy.app"], target: "/Applications/LightProxy.app" },
      {
        uninstall_postflight_steps: [
          { steps: [{ name: "LightProxy", type: "delete_keychain_certificate" }] },
        ],
      },
    ]),
    true,
  );
  assert.equal(root([{ preflight_steps: [{ steps: [{ type: "x", sudo: true }] }] }]), true);
  assert.equal(root([{ postflight_steps: [{ steps: [{ type: "x", sudo: "if_needed" }] }] }]), true);
  // the real `taskexplorer` step: brew's chown runs without sudo under HOMEBREW_NO_SUDO
  assert.equal(
    root([
      {
        uninstall_preflight_steps: [
          { steps: [{ paths: [{ base: "appdir", path: "X.app" }], type: "set_ownership" }] },
        ],
      },
    ]),
    false,
  );
  // legacy Ruby flight blocks, serialised by name only
  assert.equal(root([{ uninstall_postflight: null }]), true);
  assert.equal(root([{ "preflight, uninstall_preflight": null }]), true);
  assert.equal(root([{ postflight: null }]), false, "a new install's block is rolled back");
  // the real `kicad` entry: an `artifact` under /Library/Application Support
  const kicad = [
    {
      artifact: ["demos", { target: "/Library/Application Support/kicad/demos" }],
      target: "/Library/Application Support/kicad/demos",
    },
    { suite: ["KiCad"], target: "/Applications/KiCad" },
  ];
  const system = (t: string) => !t.startsWith("/Library/");
  assert.equal(root(kicad, system), true);
  assert.equal(root([{ suite: ["KiCad"], target: "/Applications/KiCad" }], system), false);
  // a zap stanza is never run by an upgrade
  assert.equal(root([{ zap: [{ delete: "/Library/x", trash: ["~/Library/x"] }] }], system), false);
  assert.equal(root(undefined), true, "an unreadable list is assumed to need root");
});

test("readCaskReceipt: tap, uninstall artifacts and flight blocks; null tap is a file install", () => {
  const room = mkdtempSync(join(tmpdir(), "prom-caskroom-"));
  try {
    const write = (token: string, body: unknown): void => {
      mkdirSync(join(room, token, ".metadata"), { recursive: true });
      writeFileSync(join(room, token, ".metadata", "INSTALL_RECEIPT.json"), JSON.stringify(body));
    };
    write("codex", {
      source: { tap: "homebrew/cask" },
      uninstall_artifacts: [{ binary: ["bin/codex"] }],
      uninstall_flight_blocks: false,
    });
    write("local", {
      source: { tap: null, path: "/Users/u/foo.rb" },
      uninstall_flight_blocks: true,
    });
    assert.deepEqual(readCaskReceipt(room, "codex"), {
      tap: "homebrew/cask",
      uninstallArtifacts: [{ binary: ["bin/codex"] }],
      flightBlocks: false,
    });
    assert.deepEqual(readCaskReceipt(room, "local"), { tap: "", flightBlocks: true });
    assert.equal(readCaskReceipt(room, "absent"), undefined);
  } finally {
    rmSync(room, { recursive: true, force: true });
  }
});

test("install receipts → each keg's closure (all kept versions) and tap; an unreadable one fails ALL", () => {
  const cellar = mkdtempSync(join(tmpdir(), "prom-cellar-"));
  try {
    const receipt = (
      f: string,
      v: string,
      deps: string[],
      tap: string | null = "homebrew/core",
    ) => {
      mkdirSync(join(cellar, f, v), { recursive: true });
      writeFileSync(
        join(cellar, f, v, "INSTALL_RECEIPT.json"),
        JSON.stringify({
          runtime_dependencies: deps.map((d) => ({ full_name: d, declared_directly: true })),
          source: { tap },
        }),
      );
    };
    receipt("node", "26.10.0_1", ["abseil", "llhttp"]);
    receipt("node", "26.10.0_2", ["abseil", "simdjson"]); // an old keg kept by NO_INSTALL_CLEANUP
    receipt("tool", "1.0", ["jq"], "someone/tap");
    receipt("mixed", "1.0", [], "someone/tap"); // any kept keg from a tap makes it a tap's
    receipt("mixed", "2.0", []);
    receipt("local", "1.0", ["jq"], null); // installed from a file: not official either
    writeFileSync(join(cellar, ".DS_Store"), ""); // a stray file, not a keg
    writeFileSync(join(cellar, "node", ".DS_Store"), ""); // nor a version
    mkdirSync(join(cellar, "empty")); // nothing installed
    const f = readFormulae(cellar);
    assert.deepEqual([...(f?.get("node")?.deps ?? [])].sort(), ["abseil", "llhttp", "simdjson"]);
    assert.equal(f?.get("node")?.tap, "homebrew/core");
    assert.deepEqual(f?.get("tool"), { deps: ["jq"], tap: "someone/tap" });
    assert.equal(f?.get("mixed")?.tap, "someone/tap");
    assert.equal(f?.get("local")?.tap, "");
    assert.equal(f?.has(".DS_Store"), false);
    assert.equal(f?.has("empty"), false);

    // a keg with no receipt could depend on anything: no answer, never "depends on nothing"
    mkdirSync(join(cellar, "broken", "1.0"), { recursive: true });
    assert.equal(readFormulae(cellar), null);
    writeFileSync(join(cellar, "broken", "1.0", "INSTALL_RECEIPT.json"), '{"source":{}}');
    assert.equal(readFormulae(cellar), null, "a receipt without the dependency list");
  } finally {
    rmSync(cellar, { recursive: true, force: true });
  }
});

test("brew deps --for-each → name → current closure", () => {
  const m = parseDepsForEach(
    "hdrhistogram_c: \npipx: ca-certificates lz4 python@3.14\nsdl3:\nWarning: noise\n",
  );
  assert.deepEqual(m.get("hdrhistogram_c"), []);
  assert.deepEqual(m.get("pipx"), ["ca-certificates", "lz4", "python@3.14"]);
  assert.deepEqual(m.get("sdl3"), []);
  assert.equal(m.has("Warning"), false);
});

test("brew.env: the three files bin/brew loads, and the lines that undo a step's environment", () => {
  assert.deepEqual(brewEnvFiles("/opt/homebrew", { HOME: "/Users/u" }), [
    "/etc/homebrew/brew.env",
    "/opt/homebrew/etc/homebrew/brew.env",
    "/Users/u/.homebrew/brew.env",
  ]);
  assert.equal(
    brewEnvFiles("/p", { HOME: "/h", XDG_CONFIG_HOME: "/x" })[2],
    "/x/homebrew/brew.env",
  );
  assert.equal(
    brewEnvFiles("/p", { HOME: "/h", HOMEBREW_XDG_CONFIG_HOME: "/y" })[2],
    "/y/homebrew/brew.env",
  );
  const dir = mkdtempSync(join(tmpdir(), "prom-brewenv-"));
  try {
    const file = join(dir, "brew.env");
    writeFileSync(
      file,
      [
        "# a comment",
        "HOMEBREW_NO_ANALYTICS=1", // unrelated
        "HOMEBREW_NO_AUTO_UPDATE=1", // the same as the step's: harmless
        "HOMEBREW_UPGRADE_GREEDY=", // empty: off, harmless
        "  HOMEBREW_FORCE_API_AUTO_UPDATE=1  ", // read -r trims it: ON
        "HOMEBREW_NO_SUDO=", // empty: turns sudo protection OFF
        "export HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1", // bin/brew skips this line
      ].join("\n"),
    );
    assert.deepEqual(brewEnvOverrides([file, join(dir, "absent")]), [
      `${file}: HOMEBREW_FORCE_API_AUTO_UPDATE`,
      `${file}: HOMEBREW_NO_SUDO`,
    ]);
    if (process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      assert.equal(brewEnvOverrides([file]), null, "a file that cannot be read is no answer");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a venv is the tool's only when nothing else in it needs the package, and no project owns it", () => {
  const root = mkdtempSync(join(tmpdir(), "prom-venv-"));
  try {
    const home = join(root, "home");
    const venv = join(home, "tool", "venv");
    const site = join(venv, "lib", "python3.14", "site-packages");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, "bin", "pip"), "");
    const dist = (name: string, requires: string[]): void => {
      const d = join(site, `${name}-1.0.dist-info`);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "METADATA"),
        [`Name: ${name}`, ...requires.map((r) => `Requires-Dist: ${r}`)].join("\n"),
      );
    };
    dist("huggingface_hub", ["requests>=2"]);
    assert.deepEqual(inspectVenv(venv, "huggingface-hub", { home }), {
      pip: true,
      uvTool: false,
      project: false,
      requiredBy: [],
    });

    // PEP 503: `huggingface_hub; extra == "test"` (outlines_core, on this machine) names it too
    dist("outlines_core", ['Huggingface_Hub>=1; extra == "test"']);
    dist("transformers", ["huggingface-hub<1.0,>=0.34"]);
    assert.deepEqual(inspectVenv(venv, "huggingface-hub", { home }).requiredBy.sort(), [
      "outlines_core",
      "transformers",
    ]);

    // activated, or under a project directory the session was launched from: a project's venv
    assert.equal(inspectVenv(venv, "x", { activeVenv: venv, home }).project, true);
    assert.equal(inspectVenv(venv, "x", { cwd: join(home, "tool"), home }).project, true);
    // launched from the home folder (a fresh terminal), above it, or from / — never a project root
    for (const cwd of [home, root, "/"]) {
      assert.equal(inspectVenv(venv, "x", { cwd, home }).project, false, cwd);
    }
    writeFileSync(join(home, "tool", "pyproject.toml"), "");
    assert.equal(inspectVenv(venv, "x", { home }).project, true, "next to a project file");

    const uv = join(home, "uvtool");
    mkdirSync(uv, { recursive: true });
    writeFileSync(join(uv, "uv-receipt.toml"), "");
    assert.equal(inspectVenv(uv, "x", { home }).uvTool, true);
    assert.equal(inspectVenv(uv, "x", { home }).pip, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real probes: Cellar + brew deps, Caskroom receipts, brew.env, npm's root, bin and links", async () => {
  const root = mkdtempSync(join(tmpdir(), "prom-probes-"));
  try {
    const prefix = join(root, "brew");
    const cellar = join(prefix, "Cellar");
    mkdirSync(join(cellar, "uv", "0.9.0"), { recursive: true });
    writeFileSync(
      join(cellar, "uv", "0.9.0", "INSTALL_RECEIPT.json"),
      '{"runtime_dependencies":[],"source":{"tap":"homebrew/core"}}',
    );
    const caskroom = join(prefix, "Caskroom");
    mkdirSync(join(caskroom, "codex", ".metadata"), { recursive: true });
    // a receipt that DIFFERS from brew info's view, so only a probe that reads it can pass
    writeFileSync(
      join(caskroom, "codex", ".metadata", "INSTALL_RECEIPT.json"),
      JSON.stringify({
        source: { tap: "someone/tap" },
        uninstall_artifacts: [{ uninstall: [{ pkgutil: "com.example.codex" }] }],
      }),
    );
    mkdirSync(join(prefix, "etc", "homebrew"), { recursive: true });
    writeFileSync(join(prefix, "etc", "homebrew", "brew.env"), "HOMEBREW_UPGRADE_GREEDY=1\n");
    const npmPrefix = join(root, "npm");
    const npmRoot = join(npmPrefix, "lib", "node_modules");
    mkdirSync(join(npmRoot, "real-pkg"), { recursive: true });
    mkdirSync(join(npmPrefix, "bin"), { recursive: true });
    mkdirSync(join(root, "checkout"), { recursive: true });
    symlinkSync(join(root, "checkout"), join(npmRoot, "my-fork"));

    const seen: string[] = [];
    const probes = makeDispatchProbes(
      answer((argv) => {
        seen.push(argv.join(" "));
        if (argv[0] === "npm") return `${npmRoot}\n`;
        if (argv[1] === "--cellar") return `${cellar}\n`;
        if (argv[1] === "--caskroom") return `${caskroom}\n`;
        if (argv[1] === "--prefix") return `${prefix}\n`;
        if (argv[1] === "deps") return "uv: ca-certificates openssl@3\n";
        return INFO;
      }),
      () => ({ HOME: join(root, "home") }),
      () => ({}),
      anywhere,
    );
    const f = await probes.formulae(["uv", "someone/tap/tool"]);
    assert.deepEqual(f?.get("uv")?.deps, ["ca-certificates", "openssl@3"]);
    assert.ok(
      seen.includes("brew deps --for-each --full-name uv"),
      "a tap's formula is never expanded: it is never run",
    );
    const casks = await probes.casks(["codex"]);
    assert.equal(casks?.get("codex")?.tap, "someone/tap");
    assert.equal(casks?.get("codex")?.needsRoot, true);
    // (includes, not equals: /etc/homebrew/brew.env is the real machine's, outside this tree)
    assert.ok(
      (await probes.brewEnv())?.includes(
        `${join(prefix, "etc", "homebrew", "brew.env")}: HOMEBREW_UPGRADE_GREEDY`,
      ),
    );
    const npm = await probes.npmGlobal(["real-pkg", "my-fork", "absent"]);
    assert.equal(npm?.root, npmRoot);
    assert.equal(npm?.writable, true);
    assert.deepEqual([...(npm?.linked ?? [])], ["my-fork"]);
    assert.deepEqual(await probes.casks([]), new Map(), "no tokens, no spawn");

    // npm writes its bin links into <prefix>/bin as well: a root-owned bin fails every install
    if (process.getuid?.() !== 0) {
      chmodSync(join(npmPrefix, "bin"), 0o555);
      assert.equal((await probes.npmGlobal(["real-pkg"]))?.writable, false);
      chmodSync(join(npmPrefix, "bin"), 0o755);
    }

    // a manager that cannot answer is null — never an empty, reassuring answer
    const failing = makeDispatchProbes(
      answer(() => "", 1),
      () => ({}),
    );
    assert.equal(await failing.formulae([]), null);
    assert.equal(await failing.npmGlobal(["x"]), null);
    assert.equal(await failing.casks(["codex"]), null);
    assert.equal(await failing.brewEnv(), null);
    // brew info answered, the Caskroom did not: no receipt could be read, so no cask facts
    const noRoom = makeDispatchProbes(
      async (argv) =>
        argv[1] === "--caskroom"
          ? { code: 1, stdout: "", stderr: "", timedOut: false, aborted: false }
          : { code: 0, stdout: INFO, stderr: "", timedOut: false, aborted: false },
      () => ({}),
    );
    assert.equal(await noRoom.casks(["codex"]), null);
    // the Cellar read, brew deps did not
    const noDeps = makeDispatchProbes(
      async (argv) =>
        argv[1] === "deps"
          ? { code: 1, stdout: "", stderr: "", timedOut: false, aborted: false }
          : { code: 0, stdout: `${cellar}\n`, stderr: "", timedOut: false, aborted: false },
      () => ({}),
    );
    assert.equal(await noDeps.formulae(["uv"]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
