/**
 * themes.test.ts — the file-13 theming layer (§3.1/§3.4/§3.7): the 20-scheme registry,
 * the contrast save-gate (verdict tokens fail-closed), fail-soft parsing, and asset gen.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BUILTIN_SCHEMES, getScheme } from "../tokens.js";
import { contrastRatio, meetsAA } from "../tokens/contrast.js";
import {
  type CustomThemeFile,
  activeScheme,
  addUserScheme,
  applySchemeToRoot,
  autoFix,
  canSave,
  checkContrast,
  contrastVerdictFor,
  createThemeRegistry,
  customFileToScheme,
  getSchemeById,
  listSchemes,
  parseCustomThemeFile,
  prepareSave,
  saveBlockers,
  schemeAssets,
  schemeToCustomFile,
  setActive,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---- registry: builtin = 08's 20 schemes (single source, §3.1) ------------- //

test("registry exposes all 41 builtin schemes; default is prometheus-dark", () => {
  const reg = createThemeRegistry();
  assert.equal(reg.builtin.length, 41); // 20 first-party + 20 famous + Pelly (custom)
  assert.equal(listSchemes(reg).length, 41);
  assert.equal(reg.active.global, "prometheus-dark");
  // the 20 ids from §3.1 are all present
  for (const id of [
    "prometheus-dark",
    "prometheus-light",
    "dracula",
    "tokyo-night",
    "high-contrast",
    "synthwave-84",
  ]) {
    assert.ok(getSchemeById(reg, id), `missing builtin ${id}`);
  }
});

test("user customs add to the registry and shadow a builtin id", () => {
  const reg0 = createThemeRegistry();
  const custom = customFileToScheme({
    $schema: "prometheus-studio/theme@1",
    meta: {
      id: "my-theme",
      name: "My Theme",
      base: "dark",
      version: "1.0.0",
      createdAt: "2026-06-19T00:00:00Z",
    },
    uiTokens: { brand: "#ff00ff" },
    syntaxTokens: {},
  });
  const reg = addUserScheme(reg0, custom);
  assert.equal(listSchemes(reg).length, 42);
  assert.equal(getSchemeById(reg, "my-theme")?.name, "My Theme");
  assert.equal(reg0.user.length, 0, "addUserScheme is immutable");
});

test("per-window active override falls back to global (§3.5)", () => {
  let reg = createThemeRegistry();
  reg = setActive(reg, "dracula"); // global
  reg = setActive(reg, "tokyo-night", "win-2"); // per-window
  assert.equal(activeScheme(reg).id, "dracula");
  assert.equal(activeScheme(reg, "win-2").id, "tokyo-night");
  assert.equal(activeScheme(reg, "win-other").id, "dracula", "unset window → global");
});

// ---- contrast save-gate (§3.4) -------------------------------------------- //

test("first-party Prometheus + high-contrast schemes are verdict-legible (security)", () => {
  // The Prometheus identity + the AAA high-contrast scheme MUST clear the verdict gate.
  for (const id of [
    "prometheus-dark",
    "prometheus-light",
    "high-contrast",
    "ember",
    "dracula",
    "tokyo-night",
  ]) {
    const report = checkContrast(getScheme(id));
    assert.ok(
      canSave(report),
      `${id} verdict tokens must be legible: ${report.verdictFailures.map((f) => f.label).join(", ")}`,
    );
  }
});

test("the save-gate catches a faithful community-palette verdict dip (would block on save)", () => {
  // This used to assert on nord-frost, because the shipped Nord/Solarized reproductions
  // really did dip below 3:1 on the verdict tint. They no longer do — every builtin is
  // derived through `derivePalette`, which floors the role tokens — so the case is made with
  // a purpose-built palette instead. Asserting the gate works by shipping a broken scheme was
  // always the wrong way round: it made "fix the scheme" and "keep the test green" opposites.
  const nord = getScheme("nord-frost");
  // Nord's ORIGINAL danger (#bf616a) put back on Nord's own surface: 2.46:1 on the surface and
  // 2.21:1 on its own 14% tint — the exact dip this gate exists to catch.
  const dip = {
    ...nord,
    id: "verdict-dip",
    builtin: false,
    tokens: { ...nord.tokens, danger: "#bf616a" },
  };
  const report = checkContrast(dip);
  assert.ok(
    report.verdictFailures.some((f) => f.role === "danger"),
    "a sub-3:1 danger token must be detected by the gate",
  );
  assert.equal(canSave(report), false, "a verdict dip must block the save (fail-closed)");
});

test("every shipped builtin clears the save-gate it would be held to on save", () => {
  // The other half of the same point: a preset the user can pick from the Appearance list
  // must not be a scheme the editor would refuse to save. Before the derive rewrite, 28 of
  // the 41 shipped exactly that contradiction.
  const blocked = BUILTIN_SCHEMES.filter((s) => !canSave(checkContrast(s))).map((s) => s.id);
  assert.deepEqual(blocked, [], `builtins that would be blocked on save: ${blocked.join(", ")}`);
});

test("the deliberately low-contrast fixture FAILS the save-gate (fail-closed; §3.4 CI)", () => {
  const json = readFileSync(join(here, "__fixtures__", "low-contrast.json"), "utf8");
  const parsed = parseCustomThemeFile(json);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const outcome = prepareSave(parsed.file);
  assert.equal(outcome.ok, false, "a theme with illegible verdict tokens must be blocked");
  if (outcome.ok) return;
  assert.ok(outcome.report.verdictFailures.length > 0);
  assert.match(outcome.reason, /cannot save/i);
});

test("prepareSave stamps the contrast badge into meta on success", () => {
  const ok: CustomThemeFile = schemeToCustomFile(getScheme("prometheus-dark"), {
    createdAt: "2026-06-19T00:00:00Z",
  });
  const outcome = prepareSave(ok);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(["AA", "AAA"].includes(outcome.file.meta.contrast ?? ""));
});

test("autoFix nudges an illegible pair until it meets AA (user never stuck; §3.4)", () => {
  const fixed = autoFix("#777777", "#808080", "ui"); // near-invisible gray-on-gray
  assert.ok(
    meetsAA(fixed, "#808080", "ui"),
    `autoFix should reach AA, got ${fixed} ratio=${contrastRatio(fixed, "#808080").toFixed(2)}`,
  );
});

// ---- fail-soft parsing (§3.7) --------------------------------------------- //

test("parseCustomThemeFile is fail-soft (never throws) on bad input", () => {
  assert.equal(parseCustomThemeFile("not json").ok, false);
  assert.equal(parseCustomThemeFile("{}").ok, false);
  assert.equal(
    parseCustomThemeFile(
      JSON.stringify({
        $schema: "prometheus-studio/theme@1",
        meta: { id: "x", name: "X", base: "dark", version: "1.0.0" },
        uiTokens: { brand: "not-a-color" },
        syntaxTokens: {},
      }),
    ).ok,
    false,
    "non-color token value is rejected",
  );
});

// ---- asset generation (§3.1) — chrome + editor + terminal in lockstep ------ //

test("schemeAssets produces css vars + a monaco theme + an xterm 16-color map", () => {
  const assets = schemeAssets(getScheme("prometheus-dark"));
  assert.ok(assets.cssVars["--bg-app"], "css vars carry --bg-app");
  assert.ok(assets.monaco.rules.length > 0 || assets.monaco.colors, "monaco theme built");
  assert.ok(assets.xterm.background, "xterm theme built");
});

test("applySchemeToRoot writes CSS vars + data-theme to a fake root (no DOM needed)", () => {
  const props: Record<string, string> = {};
  let dataTheme = "";
  const fakeRoot = {
    style: {
      setProperty: (k: string, v: string) => {
        props[k] = v;
      },
    },
    setAttribute: (k: string, v: string) => {
      if (k === "data-theme") dataTheme = v;
    },
  };
  const vars = applySchemeToRoot(
    getScheme("tokyo-night"),
    fakeRoot as unknown as Parameters<typeof applySchemeToRoot>[1],
  );
  assert.ok(vars["--bg-app"]);
  assert.equal(props["--bg-app"], vars["--bg-app"]);
  assert.equal(dataTheme, "dark");
});

/* ── APP-094: per-token verdict + extended save-gate ────────────────────────*/

test("contrastVerdictFor rates a token against its effective background", () => {
  const dark = getScheme("prometheus-dark");
  // text-primary on bg-app is a legible pair on the flagship scheme.
  const tp = contrastVerdictFor("text-primary", dark);
  assert.notEqual(tp.level, "FAIL");
  assert.equal(tp.required, 4.5);
  assert.ok(tp.ratio >= 4.5);
  // a verdict token is rated on its 14% tint (UI threshold 3:1).
  const danger = contrastVerdictFor("danger", dark);
  assert.equal(danger.required, 3);
  // a background token is rated by the primary text that sits on it (text threshold).
  assert.equal(contrastVerdictFor("bg-app", dark).required, 4.5);
  // an unknown token still returns a verdict (rated on bg-surface), never throws.
  assert.ok(["AAA", "AA", "FAIL", "na"].includes(contrastVerdictFor("accent", dark).level));
});

test("contrastVerdictFor: an illegible text-primary FAILs; a strong one is AAA", () => {
  const base = getScheme("prometheus-dark");
  const bad = {
    ...base,
    id: "c-bad",
    builtin: false,
    filled: true,
    tokens: { ...base.tokens, "text-primary": "#0a0a0a" },
  };
  assert.equal(contrastVerdictFor("text-primary", bad).level, "FAIL"); // dark text on dark bg
  const good = {
    ...base,
    id: "c-good",
    builtin: false,
    filled: true,
    tokens: { ...base.tokens, "text-primary": "#ffffff", "bg-app": "#000000" },
  };
  assert.equal(contrastVerdictFor("text-primary", good).level, "AAA");
});

test("saveBlockers extends the gate to primary-text failures (verdicts still block)", () => {
  const base = getScheme("prometheus-dark");
  // an illegible primary text now BLOCKS the save (the APP-094 extension).
  const badText = {
    ...base,
    id: "b-txt",
    builtin: false,
    filled: true,
    tokens: { ...base.tokens, "text-primary": "#0b0d10" },
  };
  const rep = checkContrast(badText);
  assert.ok(saveBlockers(rep).some((p) => p.role === "text-primary"));
  assert.equal(canSave(rep), false);
  // the flagship scheme still saves (no verdict + no primary-text failure).
  assert.equal(canSave(checkContrast(base)), true);
});
