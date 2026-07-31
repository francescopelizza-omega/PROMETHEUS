/**
 * tokens.test.ts — the verifiable core of file 08: the WCAG contrast commitment (§7),
 * the verdict-token DRIFT guard vs the TUI (§0 rule 1 / §2.2), and the tokens.json /
 * theme-gen structure. Pure — no rendering. Run via the dev-register node:test runner.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultTheme } from "../theme.js";
import { darkSemantic, highContrastSemantic, lightSemantic } from "../tokens.js";
import { ANSI_NAME, ANSI_SGR, sgrFor } from "./ansi.js";
import { blend, contrastRatio, meetsAA } from "./contrast.js";
import {
  monacoThemeFromSemantic,
  monacoThemeFromTheme,
  xtermThemeFromSemantic,
} from "./monaco-theme.js";
import { VERDICT_ROLE } from "./semantic.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ─── contrast math sanity ───────────────────────────────────────────────── */
test("contrast: black/white is 21:1, identical is 1:1", () => {
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.1);
  assert.ok(Math.abs(contrastRatio("#777777", "#777777") - 1) < 0.001);
});

/* ─── §7 WCAG AA: body text >= 4.5, verdict/UI tokens >= 3, on dark + HC ──── */
for (const [name, s] of [
  ["dark", darkSemantic],
  ["light", lightSemantic],
  ["high-contrast", highContrastSemantic],
] as const) {
  test(`a11y(${name}): body text >= 4.5:1`, () => {
    assert.ok(meetsAA(s["text-primary"], s["bg-app"], "text"), "text-primary on bg-app");
    assert.ok(meetsAA(s["text-primary"], s["bg-surface"], "text"), "text-primary on bg-surface");
    assert.ok(
      meetsAA(s["text-secondary"], s["bg-surface"], "text"),
      "text-secondary on bg-surface",
    );
  });
  test(`a11y(${name}): verdict/role tokens >= 3:1 on surfaces (UI)`, () => {
    for (const role of ["ok", "warn", "danger", "info", "brand", "accent"] as const) {
      assert.ok(
        meetsAA(s[role], s["bg-surface"], "ui"),
        `${role}=${s[role]} on bg-surface=${s["bg-surface"]} ratio=${contrastRatio(s[role], s["bg-surface"]).toFixed(2)}`,
      );
    }
  });
  // §7 / §81: the verdict chips render text in the role color over a 14% tint of
  // THAT SAME color (VerdictBadge/FindingRow color-mix) — validate the EFFECTIVE
  // foreground-vs-tinted-background pair, not just role-vs-plain-surface.
  test(`a11y(${name}): verdict chips legible on their 14% tint`, () => {
    for (const role of ["ok", "warn", "danger", "info"] as const) {
      const tinted = blend(s[role], s["bg-surface"], 0.14);
      assert.ok(
        meetsAA(s[role], tinted, "ui"),
        `${role}=${s[role]} on tint=${tinted} ratio=${contrastRatio(s[role], tinted).toFixed(2)}`,
      );
    }
  });
}

/* ─── §0 rule 1 / §2.2: verdict tokens MUST NOT DRIFT from the TUI semantics ─ */
test("verdict drift guard: GUI VERDICT_ROLE matches the TUI VERDICT_COLOR families", () => {
  // The source of truth is prometheus_plugin/tui/src/theme.ts VERDICT_COLOR:
  //   allow→green · warn→yellow · block→red · error→red   (clean is a SEVERITY, green).
  // The GUI role→TUI-color family must agree exactly (a green/yellow/red means the same
  // thing in both shells — file 08 §0 rule 1). If VERDICT_ROLE ever changes, this fails.
  const ROLE_TO_TUI_FAMILY: Record<string, string> = {
    ok: "green",
    warn: "yellow",
    danger: "red",
    info: "cyan",
  };
  const EXPECTED_TUI: Record<"allow" | "warn" | "block" | "error", string> = {
    allow: "green",
    warn: "yellow",
    block: "red",
    error: "red",
  };
  for (const tier of ["allow", "warn", "block", "error"] as const) {
    const role = VERDICT_ROLE[tier];
    assert.equal(
      ROLE_TO_TUI_FAMILY[role],
      EXPECTED_TUI[tier],
      `verdict "${tier}" → role "${role}" → family "${ROLE_TO_TUI_FAMILY[role]}" but TUI expects "${EXPECTED_TUI[tier]}"`,
    );
  }
});

/* ─── tokens.json: the flat export the CLI + Monaco read (§8) ─────────────── */
test("tokens.json: all 3 themes present with the full SemanticColors key set", () => {
  const json = JSON.parse(readFileSync(join(HERE, "tokens.json"), "utf8"));
  assert.deepEqual(Object.keys(json.themes).sort(), ["dark", "high-contrast", "light"]);
  const keys = Object.keys(darkSemantic).sort();
  for (const theme of ["dark", "light", "high-contrast"]) {
    assert.deepEqual(Object.keys(json.themes[theme]).sort(), keys, `${theme} key set`);
  }
  assert.equal(json.themes.dark.ok, darkSemantic.ok);
});

/* ─── Monaco + xterm theme-gen (§6) ──────────────────────────────────────── */
test("theme-gen: Monaco theme shape + xterm ANSI mapping from tokens", () => {
  const m = monacoThemeFromSemantic(darkSemantic, "vs-dark");
  assert.equal(m.base, "vs-dark");
  assert.ok(Array.isArray(m.rules) && m.rules.length > 0);
  assert.equal(m.colors["editor.background"], darkSemantic["bg-inset"]);
  const x = xtermThemeFromSemantic(darkSemantic);
  assert.equal(x.green, darkSemantic.ok);
  assert.equal(x.red, darkSemantic.danger);
  assert.equal(x.yellow, darkSemantic.warn);
  assert.equal(x.magenta, darkSemantic.brand);
  assert.equal(x.cyan, darkSemantic.accent);
});

/* ─── §5.7 / §8.1: the ANSI-16 resolver the CLI + TUI consume ─────────────── */
test("ansi: the §5.7 role→ANSI mapping (brand=magenta, accent=cyan, ok=green, …)", () => {
  assert.equal(ANSI_NAME.brand, "magenta");
  assert.equal(ANSI_NAME.accent, "cyan");
  assert.equal(ANSI_NAME.ok, "green");
  assert.equal(ANSI_NAME.warn, "yellow");
  assert.equal(ANSI_NAME.danger, "red");
  assert.equal(ANSI_NAME.secondary, "brightBlack");
  // …and the resolved SGR codes (magenta 35, cyan 36, green 32, yellow 33, red 31, brightBlack 90).
  assert.equal(sgrFor("brand"), 35);
  assert.equal(sgrFor("accent"), 36);
  assert.equal(sgrFor("ok"), 32);
  assert.equal(sgrFor("warn"), 33);
  assert.equal(sgrFor("danger"), 31);
  assert.equal(sgrFor("secondary"), 90);
  assert.equal(ANSI_SGR.brightBlack, 90);
});

test("ansi: the operator accent pins light-blue (cyan) to bold #16b3f5 truecolor", async () => {
  const { ACCENT_HEX, ACCENT_RGB, ACCENT_SGR, sgrParamsFor, sgrParamsForName } = await import(
    "./ansi.js"
  );
  assert.equal(ACCENT_HEX, "#16b3f5");
  assert.deepEqual({ ...ACCENT_RGB }, { r: 22, g: 179, b: 245 });
  assert.equal(ACCENT_SGR, "1;38;2;22;179;245");
  // cyan (the light blue) resolves to the bold-truecolor accent; non-cyan stays a 16-color int.
  assert.equal(sgrParamsForName("cyan"), "1;38;2;22;179;245");
  assert.equal(sgrParamsForName("green"), "32");
  // accent + info roles are cyan → accent; brand (magenta) is unchanged.
  assert.equal(sgrParamsFor("accent"), "1;38;2;22;179;245");
  assert.equal(sgrParamsFor("info"), "1;38;2;22;179;245");
  assert.equal(sgrParamsFor("brand"), "35");
});

/* ─── §79: a full theme@1 → Monaco theme preserves bold/italic font intent ──── */
test("theme-gen: monacoThemeFromTheme carries syntax fontStyle (comment italic, keyword bold)", () => {
  const m = monacoThemeFromTheme(defaultTheme(), "vs-dark");
  const comment = m.rules.find((r) => r.token === "comment");
  const keyword = m.rules.find((r) => r.token === "keyword");
  assert.ok(comment?.fontStyle?.includes("italic"), "comment italic preserved");
  assert.ok(keyword?.fontStyle?.includes("bold"), "keyword bold preserved");
  assert.equal(m.colors["editor.background"], defaultTheme().uiTokens["bg-inset"]);
});
