/**
 * host-tools.test.ts — the external-tool manifest: small, stable, and honest about absence.
 *
 * The two properties that matter are not "it lists things". They are (a) it costs ~100 tokens,
 * not thousands, and (b) it is byte-identical between turns unless something was installed —
 * because it sits inside the prompt-cache prefix and anything volatile in it would invalidate
 * that cache on every single turn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { HOST_TOOLS, installPackage, renderHostToolManifest } from "./host-tools.js";
import { hostToolsContributor } from "./protocol/contributors/host-tools.js";
import { probeHostTools } from "./system/host/host-tool-probe.js";

const seeded = (present: readonly string[]) =>
  probeHostTools((bin) => (present.includes(bin) ? `/usr/bin/${bin}` : null));

test("the manifest names what is here and what is not, and says who can install", () => {
  const text = renderHostToolManifest(seeded(["rg", "magick", "ffmpeg"])) ?? "";
  assert.match(text, /External tools installed here: /);
  assert.match(text, /imagemagick \(magick\)/, "a multi-binary tool names the one that resolved");
  assert.match(text, /ffmpeg/);
  assert.match(text, /Not installed: /);
  assert.match(text, /yt-dlp/, "an absent tool is named so the model stops guessing");
  assert.match(text, /\/deps install <name>/, "the remedy is the command the USER runs");
  assert.match(text, /cannot install software yourself/);
});

test("it is ~100 tokens, not thousands — the whole reason it is not a set of tools", () => {
  const all = renderHostToolManifest(seeded(HOST_TOOLS.flatMap((t) => [...t.bins]))) ?? "";
  const approxTokens = Math.ceil(all.length / 4);
  assert.ok(approxTokens < 200, `manifest is ${approxTokens} tokens: ${all.length} chars`);
});

test("it carries a provenance frame: data, never permission", () => {
  // Machine-derived text the model reads must never read as an instruction that widens scope.
  const text = renderHostToolManifest(seeded(["rg"])) ?? "";
  assert.match(text, /grants no permission/);
});

test("it is byte-stable across renders — no versions, paths, counts or timestamps", () => {
  const a = renderHostToolManifest(seeded(["rg", "jq"]));
  const b = renderHostToolManifest(seeded(["jq", "rg"]));
  assert.equal(a, b, "probe order must not change the text, or the prompt cache dies every turn");
  assert.ok(a && !/\d{4}-\d{2}-\d{2}/.test(a), "no timestamp");
  assert.ok(a && !a.includes("/usr/bin/"), "no absolute paths");
});

test("every catalog entry can be installed by brew AND apt", () => {
  // A tool the installer cannot install is a dead end: the manifest would tell the user to run
  // `/install x` and `/install x` would have nothing to do.
  for (const tool of HOST_TOOLS) {
    assert.ok(installPackage(tool, "brew"), `${tool.id} has no brew package`);
    assert.ok(installPackage(tool, "apt"), `${tool.id} has no apt package`);
    assert.equal(installPackage(tool, "apt-get"), installPackage(tool, "apt"), tool.id);
  }
});

test("every catalog entry is also allowlisted in the exec registry", async () => {
  // The two lists must move together: advertising a tool that classifies `destructive` means
  // the model is told it exists and then prompts the human on every single use.
  const { PROGRAMS } = await import("./exec/registry.js");
  for (const tool of HOST_TOOLS) {
    const known = tool.bins.some((b) => b in PROGRAMS);
    assert.ok(known, `${tool.id}: none of ${tool.bins.join("/")} is in PROGRAMS`);
  }
});

test("the contributor fires only when a host actually passed a manifest", () => {
  const ctx = { tools: [] } as unknown as Parameters<typeof hostToolsContributor.applies>[0];
  assert.equal(hostToolsContributor.applies(ctx), false, "no manifest ⇒ no block, no tokens");
  const withText = { ...ctx, hostTools: "External tools installed here: jq." };
  assert.equal(hostToolsContributor.applies(withText), true);
  const unit = hostToolsContributor.render(withText, 1000);
  assert.equal(unit?.mergeTarget, "block", "reference data is its own message, not the persona");
});

test("the contributor is dropped WHOLE when it does not fit — never half a list", () => {
  // A truncated list reads as an exhaustive one, which is worse than no list.
  const ctx = {
    tools: [],
    hostTools: renderHostToolManifest(seeded(["rg", "jq"])) ?? "",
  } as unknown as Parameters<typeof hostToolsContributor.render>[0];
  assert.equal(hostToolsContributor.render(ctx, 2), null);
  assert.ok(hostToolsContributor.render(ctx, 1000));
});

test("priority sits between the repo map and token-economy", () => {
  assert.equal(hostToolsContributor.priority, 85);
});

/* ══ the per-tool defaults ═══════════════════════════════════════════════════*/

test("the defaults reach the model as one compact line", async () => {
  const { DEFAULT_EXTERNAL_TOOLS, renderToolDefaults } = await import("./host-tools.js");
  const line = renderToolDefaults(DEFAULT_EXTERNAL_TOOLS);
  assert.match(line, /images png quality 85/);
  assert.match(line, /OCR language eng/);
  assert.match(line, /video mp4 max 1080p/);
  assert.match(line, /yt-dlp format bv\*\+ba\/b/);
  assert.match(line, /Settings → Tools → External Tools/, "it says where to change them");
  assert.ok(line.length < 400, `defaults line is ${line.length} chars`);
});

test("0 means no height cap, and says so rather than printing `max 0p`", async () => {
  const { DEFAULT_EXTERNAL_TOOLS, renderToolDefaults } = await import("./host-tools.js");
  const line = renderToolDefaults({ ...DEFAULT_EXTERNAL_TOOLS, videoMaxHeight: 0 });
  assert.match(line, /no height cap/);
  assert.ok(!line.includes("max 0p"));
});

test("the defaults line only appears when some tool is actually present", async () => {
  const { DEFAULT_EXTERNAL_TOOLS } = await import("./host-tools.js");
  const none = renderHostToolManifest(seeded([]), DEFAULT_EXTERNAL_TOOLS) ?? "";
  assert.ok(!none.includes("Defaults when"), "no tools ⇒ no defaults to talk about");
  const some = renderHostToolManifest(seeded(["magick"]), DEFAULT_EXTERNAL_TOOLS) ?? "";
  assert.match(some, /Defaults when the user does not specify/);
});

test("every choice-shaped default has its allowed set declared for the UI", async () => {
  const { DEFAULT_EXTERNAL_TOOLS, EXTERNAL_TOOL_CHOICES } = await import("./host-tools.js");
  for (const [key, allowed] of Object.entries(EXTERNAL_TOOL_CHOICES)) {
    const current = (DEFAULT_EXTERNAL_TOOLS as Record<string, unknown>)[key];
    assert.ok(allowed.includes(String(current)), `default ${key}=${current} is not in its own set`);
  }
});

test("every External Tools settings node persists somewhere and offers its choices", async () => {
  // `resolveRichRows` skips a node without a schemaKey, so a page node alone would persist
  // nothing; and a `select` without `options` renders as free text, which is not a choice.
  const { SETTINGS_TREE, flattenTree } = await import("../settings/tree.js");
  const leaves = flattenTree(SETTINGS_TREE).filter(
    (n) => n.id.startsWith("tools.externalTools.") && n.control !== "page",
  );
  assert.ok(leaves.length >= 8, `expected the 8 external-tool leaves, found ${leaves.length}`);
  for (const leaf of leaves) {
    assert.ok(leaf.schemaKey, `${leaf.id} has no schemaKey — it would persist nowhere`);
    if (leaf.control === "select") {
      assert.ok(leaf.options?.length, `${leaf.id} is a select with no options — free text`);
    }
  }
});
