/**
 * security-claims.test.ts — the UI may not promise a scan that does not run.
 *
 * An adversarial pass over this app found FOUR user-facing strings asserting a security
 * property the code does not provide. They are the highest-severity class of defect here,
 * because they are read in exactly the moment a user is deciding whether to trust something,
 * and because nothing else in the suite can see them — every one of them shipped green.
 *
 *   1. Model Hub pull note — "manifest scanned by nemesis · will not auto-serve".
 *      `python/sidecar/modelhub.py::v_pull` hands the tag to `ollama pull` and never touches
 *      `nemesis_gate`; `_ensure_ollama_daemon` spawns `ollama serve`. Both halves false.
 *   2. Home hero tagline — "every install gated by nemesis". Not every install: the ollama
 *      pull path is not gated at all.
 *   3. Download progress — "staging <id> for the nemesis gate…", emitted BEFORE the sidecar
 *      chooses between the gated HF/GGUF spine and the ungated ollama runner.
 *   4. MCP connector form — "The launch command is scanned by nemesis before the server can
 *      connect", shown for http connectors too. `createMcpGateRunner` short-circuits
 *      `kind: "endpoint"` to a hardcoded `allow` with risk 0 (engine-bridge/src/security/
 *      mcp-gate.ts) — nemesis never runs, and the "allow" chip beside it is a JS constant.
 *
 * This guard pins each correction in BOTH directions: the false claim must stay gone, and
 * the honest replacement must still say something. A silent deletion would pass a
 * one-directional guard while leaving the user with no information at all.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]): string => readFileSync(join(HERE, ...p), "utf8");

/**
 * A file's CODE, comments stripped.
 *
 * Several of these guards forbid a phrase that the correcting comment legitimately quotes
 * ("NOT 'for the nemesis gate': …"). A guard a correct explanation can trip is a guard the
 * next person deletes.
 */
const codeOf = (...p: string[]): string =>
  read(...p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the pull note claims neither a scan nor that it will not auto-serve", () => {
  const src = read("routes", "models-hub-view.ts");
  const note = /export const PULL_SCAN_NOTE\s*=\s*\n?\s*"([^"]*)"/.exec(src);
  assert.ok(note, "PULL_SCAN_NOTE is no longer a single string literal");
  const text = note[1] ?? "";
  // Forbid the POSITIVE claim, not the substring: the honest note says "NOT scanned by
  // nemesis", and a guard that cannot tell an assertion from its negation would push the
  // next author into vaguer wording to get past it.
  assert.doesNotMatch(text, /(?<!not )scanned by nemesis/i, "the note claims a scan again");
  assert.match(text, /not scanned by nemesis/i, "it must say plainly that no scan ran");
  assert.doesNotMatch(text, /will not auto-serve/i);
  assert.match(text, /registry/i, "it must still say where the trust actually comes from");
  // …and it must not name ONE registry: a pulled tag can point anywhere (the Pull island
  // takes free text, and the HF fast path builds `hf.co/<source>`).
  assert.doesNotMatch(text, /ollama's signed registry/i, "a tag does not have to be ollama's");
});

test("the Home hero does not claim EVERY install is gated", () => {
  const src = read("renderer", "routes", "home.tsx");
  assert.doesNotMatch(src, /every install gated by nemesis/i);
  assert.doesNotMatch(src, /The gate runs before any install/i);
  // …but the page must still tell the user the gate exists. Collapse whitespace first:
  // JSX text is reflowed by the formatter, and an assertion that pins line breaks is an
  // assertion that fails on `biome check --write` rather than on a real regression.
  const flat = src.replace(/\s+/g, " ");
  assert.match(flat, /gated by nemesis, fail-closed/i);
  assert.match(flat, /catalog, repo and extension installs/i, "the claim must name its scope");
});

test("the download progress line does not promise a gate before the path is chosen", () => {
  const src = codeOf("main", "model-ipc.ts");
  assert.doesNotMatch(src, /for the nemesis gate/i);
  assert.match(src, /message: `staging \$\{a\.id\}/, "the progress line itself is gone");
});

test("the MCP form only claims a nemesis scan for the transport that gets one", () => {
  const src = read("routes", "extensions.tsx");
  // the claim must be inside a transport conditional, not unconditional prose
  assert.match(
    src,
    /fKind === "stdio"\s*\n?\s*\?\s*"The launch command is scanned by nemesis/,
    "the nemesis claim is no longer scoped to the stdio transport",
  );
  assert.match(src, /not scanned by nemesis/i, "the http branch must say what it is NOT");
  assert.match(src, /SSRF/i, "…and what it IS — the allow-list check that really runs");
});

test("engine-bridge still documents the endpoint short-circuit these strings depend on", () => {
  // If this ever starts really scanning endpoints, the extensions copy above becomes
  // needlessly pessimistic and should be revisited — so pin the assumption, not just the UI.
  const gate = readFileSync(
    join(HERE, "..", "..", "..", "packages", "engine-bridge", "src", "security", "mcp-gate.ts"),
    "utf8",
  );
  assert.match(
    gate,
    /if \(kind === "endpoint"\) \{\s*\n\s*return \{ verdict: "allow"/,
    "the endpoint branch changed — re-check the MCP connector copy in extensions.tsx",
  );
});
