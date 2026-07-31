import assert from "node:assert/strict";
/**
 * catalog/normalize.test.ts — the PURE engine-JSON → CatalogItem[] projection (file 06 §2,§4).
 *
 * Covers: list-row + info projection (including the richer info fields + component derivation),
 * the matrix reach map + reach application, the where → InstallTarget[] preview, the
 * DOCUMENTED_ONLY → installable:false enforcement (file 06 §0 rule 2 / §10), the apps/worldsim/
 * models HUMAN-TABLE parser, and the OFFICIAL-above-EXTERNAL ranked-ties-by-name ordering.
 * Fixtures mirror LIVE `prometheus.py --json` output @ 0.15.0.
 */
import { test } from "node:test";

import {
  type DocumentedEntry,
  type EngineInfoPlugin,
  type EngineListRow,
  type MatrixReachRow,
  type WhereTargetRow,
  appTableToItems,
  applyReach,
  buildPluginCatalog,
  documentedToItem,
  documentedToItems,
  infoComponents,
  infoToItem,
  listRowToItem,
  listToItems,
  mergeInfo,
  reachIndex,
  reachRowToMap,
  sortCatalog,
  whereTargets,
} from "./normalize.js";

// ── list rows (LIVE shape) ──────────────────────────────────────────────────── //

const officialRow: EngineListRow = {
  name: "claude-plugins-official",
  tier: "official",
  summary: "Official Anthropic plugin marketplace.",
  repo: "anthropics/claude-plugins-official",
  stars: 29253,
  license: "Apache-2.0",
  scope: "claude-only",
  supported_os: ["macos", "linux"],
  recommend_rank: 0,
  targets: { claude: { method: "claude_marketplace", installed: true } },
};

const universalSkillRow: EngineListRow = {
  name: "skills",
  tier: "official",
  summary: "Agent-Skills SKILL.md standard.",
  repo: "anthropics/skills",
  stars: 146071,
  license: "Apache-2.0",
  scope: "universal",
  supported_os: ["macos", "linux"],
  recommend_rank: 0,
  targets: { claude: { method: "universal_skill", installed: false } },
};

const communityRow: EngineListRow = {
  name: "codegraph",
  tier: "community",
  summary: "Local code knowledge graph via MCP.",
  repo: "colbymchenry/codegraph",
  stars: 39233,
  license: "MIT",
  scope: "universal",
  supported_os: ["macos", "linux"],
  recommend_rank: 4,
  targets: { "*": { method: "shell", installed: false } },
};

test("listRowToItem projects a plugin row with scope + provenance", () => {
  const it = listRowToItem(officialRow);
  assert.equal(it.id, "claude-plugins-official");
  assert.equal(it.kind, "plugin");
  assert.equal(it.tier, "official");
  assert.equal(it.title, "claude-plugins-official");
  assert.equal(it.repo, "anthropics/claude-plugins-official");
  assert.equal(it.stars, 29253);
  assert.equal(it.license, "Apache-2.0");
  assert.equal(it.scope, "claude-only");
  assert.equal(it.recommendRank, 0);
  assert.equal(it.installable, true); // every list row is installable
  assert.deepEqual(it.supportedOs, ["macos", "linux"]);
  assert.equal(it.state.installed, false); // empty until reconciled
});

test("installsSkills is derived from universal_skill/git_clone target methods", () => {
  assert.equal(listRowToItem(universalSkillRow).installsSkills, true);
  assert.equal(listRowToItem(officialRow).installsSkills, false); // claude_marketplace drops no skill
});

test("unknown tier falls back to community; absent os defaults to macos+linux", () => {
  const it = listRowToItem({ name: "x", tier: "weird", supported_os: undefined });
  assert.equal(it.tier, "community");
  assert.deepEqual(it.supportedOs, ["macos", "linux"]);
});

test("null/absent optional fields collapse to undefined (not null)", () => {
  const it = listRowToItem({ name: "x", stars: null, license: null, recommend_rank: null });
  assert.equal(it.stars, undefined);
  assert.equal(it.license, undefined);
  assert.equal(it.recommendRank, undefined);
});

// ── info projection (richer detail) ─────────────────────────────────────────── //

const infoPlugin: EngineInfoPlugin = {
  name: "codegraph",
  summary: "Local code knowledge graph via MCP.",
  tier: "community",
  scope: "universal",
  repo: "colbymchenry/codegraph",
  license: "MIT",
  stars: 39233,
  category: "code-graph",
  recommend_rank: 4,
  automation: "auto-wires MCP into 8 agents",
  security_note: "curl|sh installer FETCHED + scanned first",
  caveats: ["install is curl|sh", "code-graph group A — pick ONE"],
  post_install_note: "",
  supported_os: ["macos", "linux"],
  targets: { "*": { method: "shell" } },
  components: [
    { name: "core", kind: "subplugin", desc: "the graph" },
    { id: "watcher", kind: "hook", desc: "the watcher" },
  ],
};

test("infoToItem carries the richer guidance fields verbatim", () => {
  const it = infoToItem(infoPlugin);
  assert.equal(it.category, "code-graph");
  assert.equal(it.automation, "auto-wires MCP into 8 agents");
  assert.equal(it.securityNote, "curl|sh installer FETCHED + scanned first");
  assert.deepEqual(it.caveats, ["install is curl|sh", "code-graph group A — pick ONE"]);
  assert.equal(it.postInstallNote, undefined); // empty string -> undefined
});

test("infoComponents maps id||name + kind, dropping empties", () => {
  const comps = infoComponents(infoPlugin);
  assert.deepEqual(comps, [
    { id: "core", kind: "subplugin" },
    { id: "watcher", kind: "hook" },
  ]);
});

test("mergeInfo enriches a list item WITHOUT clobbering reconciled state", () => {
  const base = listRowToItem(communityRow);
  base.state = { installed: true, enabled: true };
  const merged = mergeInfo(base, infoPlugin);
  assert.equal(merged.category, "code-graph"); // enriched
  assert.equal(merged.automation, "auto-wires MCP into 8 agents");
  assert.equal(merged.state.installed, true); // state preserved
  assert.equal(merged.state.enabled, true);
});

// ── matrix reach ─────────────────────────────────────────────────────────────── //

const reachRows: MatrixReachRow[] = [
  {
    plugin: "claude-plugins-official",
    scope: "C",
    native: ["claude"],
    sync: [],
    unavailable: ["codex", "cursor"],
  },
  {
    plugin: "codegraph",
    scope: "U",
    native: ["claude"],
    sync: ["cursor", "codex"],
    unavailable: ["zed"],
  },
];

test("reachRowToMap builds the per-agent native|sync|- map", () => {
  const m = reachRowToMap(reachRows[1]);
  assert.equal(m.claude, "native");
  assert.equal(m.cursor, "sync");
  assert.equal(m.codex, "sync");
  assert.equal(m.zed, "-");
});

test("reachIndex keys by plugin name", () => {
  const idx = reachIndex(reachRows);
  assert.equal(idx.size, 2);
  assert.equal(idx.get("codegraph")?.cursor, "sync");
});

test("applyReach attaches reach + fills scope from the compact matrix code", () => {
  const items = listToItems([{ name: "codegraph", tier: "community" }]); // scope absent in row
  const [it] = applyReach(items, reachRows);
  assert.equal(it.reach?.claude, "native");
  assert.equal(it.reach?.cursor, "sync");
  assert.equal(it.scope, "universal"); // filled from "U"
});

test("applyReach leaves items with no reach row untouched", () => {
  const items = listToItems([{ name: "lonely", tier: "community" }]);
  const [it] = applyReach(items, reachRows);
  assert.equal(it.reach, undefined);
});

// ── where → InstallTarget[] ───────────────────────────────────────────────────── //

const whereRows: WhereTargetRow[] = [
  {
    agent: "claude",
    method: "claude_plugin",
    dest: "~/.claude/plugins (+ enabledPlugins)",
    mcp_name: null,
    repo_url: null,
    universal_add: null,
  },
];

test("whereTargets projects per-agent destinations, nulls -> undefined", () => {
  const [t] = whereTargets(whereRows);
  assert.equal(t.agent, "claude");
  assert.equal(t.method, "claude_plugin");
  assert.equal(t.dest, "~/.claude/plugins (+ enabledPlugins)");
  assert.equal(t.mcpName, undefined);
  assert.equal(t.repoUrl, undefined);
});

// ── DOCUMENTED_ONLY -> installable:false (ENFORCED IN CORE) ───────────────────── //

const docEntry: DocumentedEntry = {
  id: "awesome-claude-plugins",
  summary: "Automated n8n leaderboard — a DISCOVERY FEED.",
  why_excluded: "aggregator/list, not a plugin; no license",
  doc_url: "https://github.com/quemsah/awesome-claude-plugins",
};

test("documentedToItem sets installable:false + docUrl + whyExcluded (file 06 §0/§10)", () => {
  const it = documentedToItem(docEntry);
  assert.equal(it.tier, "documented");
  assert.equal(it.installable, false); // ENFORCED in core, not just hidden in UI
  assert.equal(it.docUrl, "https://github.com/quemsah/awesome-claude-plugins");
  assert.equal(it.whyExcluded, "aggregator/list, not a plugin; no license");
});

test("documentedToItems maps the whole registry", () => {
  assert.equal(documentedToItems([docEntry, docEntry]).length, 2);
});

// ── apps/worldsim/models HUMAN-TABLE parser (LIVE shape) ─────────────────────── //

const appsLines = [
  "  [downloader] yt-dlp — yt-dlp   isolated venv (delete-folder uninstall)",
  "      Feature-rich command-line audio/video downloader.",
  "      safest: isolated venv (pip) — its own virtualenv.",
  "      https://github.com/yt-dlp/yt-dlp",
  "  [runner] ollama — Ollama   official container + volume",
  "      Run open LLMs locally behind a simple API on :11434.",
  "      safest: official Docker image — isolated + trivially removable.",
  "      serves on :11434",
  "      https://github.com/ollama/ollama",
];

test("appTableToItems parses a multi-row apps table (id, title, repo, port, safest)", () => {
  const items = appTableToItems(appsLines, { kind: "app" });
  assert.equal(items.length, 2);

  const yt = items[0];
  assert.equal(yt.id, "yt-dlp");
  assert.equal(yt.kind, "app");
  assert.equal(yt.tier, "devtool");
  assert.equal(yt.title, "yt-dlp");
  assert.equal(yt.category, "downloader");
  assert.equal(yt.summary, "Feature-rich command-line audio/video downloader.");
  assert.equal(yt.repo, "yt-dlp/yt-dlp");
  assert.equal(yt.owner, "yt-dlp");
  assert.ok((yt.securityNote ?? "").startsWith("isolated venv"));

  const ollama = items[1];
  assert.equal(ollama.id, "ollama");
  assert.equal(ollama.repo, "ollama/ollama");
  assert.equal(ollama.state.port, "11434"); // serves on :11434
});

test("appTableToItems tags model-tool rows as kind/tier model-tool/community", () => {
  const lines = [
    "  [library] airllm — AirLLM",
    "      Run a 70B LLM on a small GPU by streaming layers.",
    "      docs 27-airllm.md  ·  https://github.com/lyogavin/airllm",
  ];
  const [it] = appTableToItems(lines, { kind: "model-tool" });
  assert.equal(it.kind, "model-tool");
  assert.equal(it.tier, "community");
  assert.equal(it.id, "airllm");
  assert.equal(it.repo, "lyogavin/airllm");
});

test("appTableToItems on empty lines yields no rows (no fabrication)", () => {
  assert.deepEqual(appTableToItems([], { kind: "app" }), []);
  assert.deepEqual(appTableToItems(["  just noise, no header"], { kind: "app" }), []);
});

// ── ordering (file 06 §4.1) ───────────────────────────────────────────────────── //

test("sortCatalog: official above external, ranked, ties by name", () => {
  const items = listToItems([
    { name: "zeta", tier: "community", recommend_rank: 2 },
    { name: "alpha", tier: "community", recommend_rank: 2 }, // tie -> name
    { name: "official-b", tier: "official", recommend_rank: 0 },
    { name: "official-a", tier: "official", recommend_rank: 0 }, // tie -> name
    { name: "ranked-1", tier: "community", recommend_rank: 1 },
    { name: "devtool-x", tier: "devtool", recommend_rank: 9 },
  ]);
  const order = sortCatalog(items).map((i) => i.id);
  assert.deepEqual(order, [
    "official-a", // official tier first, ties by name
    "official-b",
    "ranked-1", // community by rank
    "alpha", // rank 2 tie -> name
    "zeta",
    "devtool-x", // devtool tier last (before documented)
  ]);
});

test("sortCatalog: unranked items sort after ranked within a tier", () => {
  const items = listToItems([
    { name: "no-rank", tier: "community" }, // unranked
    { name: "rank-5", tier: "community", recommend_rank: 5 },
  ]);
  assert.deepEqual(
    sortCatalog(items).map((i) => i.id),
    ["rank-5", "no-rank"],
  );
});

test("buildPluginCatalog folds list + documented, sorted, docs last", () => {
  const items = buildPluginCatalog({
    list: [officialRow, communityRow],
    documented: [docEntry],
    reach: reachRows,
  });
  const ids = items.map((i) => i.id);
  // official first, community next, documented last
  assert.equal(ids[0], "claude-plugins-official");
  assert.equal(ids[ids.length - 1], "awesome-claude-plugins");
  // reach was applied to codegraph
  const cg = items.find((i) => i.id === "codegraph");
  assert.equal(cg?.reach?.cursor, "sync");
  // the documented item is non-installable
  const doc = items.find((i) => i.id === "awesome-claude-plugins");
  assert.equal(doc?.installable, false);
});
