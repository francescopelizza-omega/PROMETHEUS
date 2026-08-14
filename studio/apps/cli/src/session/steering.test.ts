/**
 * steering.test.ts — AGENTS.md/CLAUDE.md/PROMETHEUS.md discovery + assembly + the /memory
 * controller (CLI-061). Injected read/write/editor/confirm seams — no real fs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ReadSeam,
  assembleSteering,
  createSteeringController,
  discoverSteering,
  renderSteeringList,
  resolveSteeringTarget,
  steeringBadge,
  steeringToRuleSources,
} from "./steering.js";

const HOME = "/home/.prometheus";
const CWD = "/proj";

/** An in-memory fs: path → content. */
function fs(files: Record<string, string>): { read: ReadSeam; store: Record<string, string> } {
  const store = { ...files };
  return { read: (p) => (p in store ? store[p]! : null), store };
}

test("discoverSteering finds project + global candidates in precedence order (CLI-061)", () => {
  const { read } = fs({
    "/proj/AGENTS.md": "project agents rules",
    "/proj/CLAUDE.md": "project claude rules",
    "/home/.prometheus/AGENTS.md": "global agents rules",
  });
  const files = discoverSteering(CWD, HOME, read);
  // project AGENTS, project CLAUDE, project PROMETHEUS, global AGENTS, global CLAUDE (5 candidates).
  assert.deepEqual(
    files.map((f) => `${f.scope}:${f.name}`),
    [
      "project:AGENTS.md",
      "project:CLAUDE.md",
      "project:PROMETHEUS.md",
      "global:AGENTS.md",
      "global:CLAUDE.md",
    ],
  );
  const loaded = files.filter((f) => f.loaded).map((f) => f.path);
  assert.ok(loaded.includes("/proj/AGENTS.md"));
  assert.ok(loaded.includes("/home/.prometheus/AGENTS.md")); // BOTH scopes present
  assert.equal(files.find((f) => f.name === "PROMETHEUS.md")?.loaded, false); // missing
});

test("a remote-instruction file is flagged + NEVER folded into the prompt (CLI-061)", () => {
  const { read } = fs({ "/proj/AGENTS.md": "https://evil.example/inject.md" });
  const files = discoverSteering(CWD, HOME, read);
  const agents = files.find((f) => f.name === "AGENTS.md" && f.scope === "project");
  assert.equal(agents?.remote, true);
  assert.equal(steeringToRuleSources(files).length, 0); // excluded from the prompt
  assert.match(renderSteeringList(files).join("\n"), /REMOTE/);
});

test("assembleSteering concatenates loaded files in precedence order (CLI-061)", () => {
  const { read } = fs({
    "/proj/AGENTS.md": "AAA project agents",
    "/home/.prometheus/CLAUDE.md": "GGG global claude",
  });
  const files = discoverSteering(CWD, HOME, read);
  const text = assembleSteering(files);
  assert.match(text, /AAA project agents/);
  assert.match(text, /GGG global claude/);
  assert.ok(
    text.indexOf("AAA") < text.indexOf("GGG"),
    "project before global (DEFAULT_PRECEDENCE)",
  );
  assert.match(steeringBadge(files), /2 files \(global\+project\)/);
});

test("resolveSteeringTarget: 1-based index or name/path (CLI-061)", () => {
  const { read } = fs({ "/proj/AGENTS.md": "x", "/proj/CLAUDE.md": "y" });
  const files = discoverSteering(CWD, HOME, read);
  assert.equal(resolveSteeringTarget(files, "1")?.name, "AGENTS.md");
  assert.equal(resolveSteeringTarget(files, "CLAUDE.md")?.name, "CLAUDE.md");
  assert.equal(resolveSteeringTarget(files, "/proj/AGENTS.md")?.name, "AGENTS.md");
  assert.equal(resolveSteeringTarget(files, "nope"), undefined);
});

test("controller: edit → reload → block() re-reads the NEW content for the next turn (CLI-061)", async () => {
  const backing = fs({ "/proj/AGENTS.md": "OLD rules" });
  const opened: string[] = [];
  const ctl = createSteeringController({
    cwd: () => CWD,
    home: HOME,
    read: backing.read,
    write: (p, content) => {
      backing.store[p] = content;
    },
    // the "editor" mutates the file (as a real save would), then returns exit 0.
    openEditor: (file) => {
      opened.push(file);
      backing.store[file] = "NEW rules after edit";
      return 0;
    },
    confirm: async () => true,
  });
  assert.match(ctl.block() ?? "", /OLD rules/);
  const status = await ctl.edit("1");
  assert.deepEqual(opened, ["/proj/AGENTS.md"]);
  assert.match(status, /edited AGENTS\.md/);
  assert.match(ctl.block() ?? "", /NEW rules after edit/); // reload fed the next turn
});

test("controller: create scaffolds a project AGENTS.md behind confirm (CLI-061)", async () => {
  const backing = fs({}); // nothing yet
  let confirmed = false;
  const ctl = createSteeringController({
    cwd: () => CWD,
    home: HOME,
    read: backing.read,
    write: (p, content) => {
      backing.store[p] = content;
    },
    openEditor: () => 0,
    confirm: async () => {
      confirmed = true;
      return true;
    },
  });
  assert.equal(ctl.block(), null); // nothing loaded
  const status = await ctl.create();
  assert.ok(confirmed);
  assert.match(status, /created \/proj\/AGENTS\.md/);
  assert.match(backing.store["/proj/AGENTS.md"] ?? "", /Agent Rules/); // initRulesScaffold content
  assert.match(ctl.block() ?? "", /Agent Rules/); // reloaded into the block

  // declining create writes nothing.
  const backing2 = fs({});
  const ctl2 = createSteeringController({
    cwd: () => CWD,
    home: HOME,
    read: backing2.read,
    write: (p, content) => {
      backing2.store[p] = content;
    },
    openEditor: () => 0,
    confirm: async () => false,
  });
  assert.match(await ctl2.create(), /not created/);
  assert.equal(backing2.store["/proj/AGENTS.md"], undefined);
});

test("controller: edit refuses an unknown target + an option-shaped path (CLI-061)", async () => {
  const ctl = createSteeringController({
    cwd: () => CWD,
    home: HOME,
    read: fs({}).read,
    write: () => {},
    openEditor: () => 0,
    confirm: async () => true,
  });
  assert.match(await ctl.edit("99"), /no steering file matches/);
});

/* ── the monorepo case: a subdirectory must not lose the root AGENTS.md ─────── */

test("steering walks UP to the repository root", () => {
  // Discovery read `cwd` and nothing else, so working in `packages/core/` of a monorepo
  // silently lost the root AGENTS.md — the file carrying the conventions for the whole repo,
  // and the one a user most expects to be in force. Nothing said it had been skipped.
  const files: Record<string, string> = {
    "/repo/AGENTS.md": "root rules",
    "/repo/.git": "",
    "/repo/packages/core/AGENTS.md": "package rules",
  };
  const read = (p: string): string | null => files[p] ?? null;
  const out = discoverSteering("/repo/packages/core", "/home", read, (p) => p in files);
  const loaded = out.filter((f) => f.loaded).map((f) => f.path);
  assert.ok(loaded.includes("/repo/AGENTS.md"), "the root AGENTS.md was lost");
  assert.ok(loaded.includes("/repo/packages/core/AGENTS.md"));
  // NEAREST LAST — a subdirectory that says something different is being specific on purpose,
  // and `assembleSteering` concatenates in order, so the deeper file must come after.
  assert.ok(
    loaded.indexOf("/repo/AGENTS.md") < loaded.indexOf("/repo/packages/core/AGENTS.md"),
    "the nearer file must be applied last",
  );
});

test("the walk STOPS at the repository boundary", () => {
  // Reading steering out of a user's parent directories would pick up files from unrelated
  // projects — or from whatever happens to sit in $HOME.
  const files: Record<string, string> = {
    "/repo/.git": "",
    "/AGENTS.md": "somebody else's rules",
  };
  const read = (p: string): string | null => files[p] ?? null;
  const out = discoverSteering("/repo", "/home", read, (p) => p in files);
  assert.equal(
    out.some((f) => f.path === "/AGENTS.md"),
    false,
    "steering was read from outside the repository",
  );
});

test("an ANCESTOR contributes only files that exist — no phantom candidates", () => {
  // `cwd` still offers every candidate so `/memory create` has something to create; doing that
  // for every ancestor would list one phantom AGENTS.md per directory up to the root.
  const files: Record<string, string> = { "/repo/.git": "" };
  const read = (p: string): string | null => files[p] ?? null;
  const out = discoverSteering("/repo/a/b", "/home", read, (p) => p in files);
  const project = out.filter((f) => f.scope === "project");
  assert.ok(project.every((f) => f.path.startsWith("/repo/a/b/") || f.loaded));
});
