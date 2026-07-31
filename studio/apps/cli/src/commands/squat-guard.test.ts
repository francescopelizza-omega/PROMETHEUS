/**
 * squat-guard.test.ts — the offline typosquat / slopsquat heuristic: name
 * normalization, the one-edit distance (sub/insert/delete/transpose), and the
 * package-name verdict. Pure; no network, no spawn.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { checkPackageName, flaggedSpecs, normalizePkgName, withinOneEdit } from "./squat-guard.js";

test("normalizePkgName: strips version/extras/markers, PEP-503 normalizes, skips URLs", () => {
  assert.equal(normalizePkgName("requests==2.31.0"), "requests");
  assert.equal(normalizePkgName("NumPy>=1.0"), "numpy");
  assert.equal(normalizePkgName("pkg[extra]>=1"), "pkg");
  assert.equal(normalizePkgName("my_cool.pkg"), "my-cool-pkg");
  assert.equal(normalizePkgName("uvicorn ; python_version>='3.9'"), "uvicorn");
  // URL / VCS / path / option requirements are NOT simple names → "" (not name-checked)
  assert.equal(normalizePkgName("git+https://github.com/x/y"), "");
  assert.equal(normalizePkgName("https://example.com/pkg.whl"), "");
  assert.equal(normalizePkgName("./local/pkg"), "");
  assert.equal(normalizePkgName("-r requirements.txt"), "");
});

test("withinOneEdit: substitution / insertion / deletion / adjacent transposition", () => {
  assert.equal(withinOneEdit("requests", "reqeusts"), true); // transposition
  assert.equal(withinOneEdit("numpy", "numpyy"), true); // insertion
  assert.equal(withinOneEdit("flask", "flas"), true); // deletion
  assert.equal(withinOneEdit("requests", "reqxests"), true); // substitution
  assert.equal(withinOneEdit("requests", "requests"), false); // equal → not a typo
  assert.equal(withinOneEdit("requests", "django"), false); // far apart
  assert.equal(withinOneEdit("numpy", "numbpyx"), false); // two edits
});

test("checkPackageName: popular = ok; typo-adjacent = typo (+nearest); patterns = suspicious", () => {
  assert.equal(checkPackageName("numpy").risk, "ok");
  assert.equal(checkPackageName("requests==2.0").risk, "ok");

  const typo = checkPackageName("reqeusts");
  assert.equal(typo.risk, "typo");
  assert.equal(typo.nearest, "requests");

  const typo2 = checkPackageName("numpyy");
  assert.equal(typo2.risk, "typo");
  assert.equal(typo2.nearest, "numpy");

  // suspicious substring + leading hyphen
  assert.equal(checkPackageName("acme-official").risk, "suspicious");
  assert.equal(checkPackageName("discord-token-x").risk, "suspicious");

  // a genuinely novel, far-from-popular name is NOT flagged (no false positive)
  assert.equal(checkPackageName("zxcv-internal-toolkit").risk, "ok");
});

test("flaggedSpecs: returns ONLY the non-ok verdicts", () => {
  const flagged = flaggedSpecs(["numpy", "reqeusts", "pandas", "acme-official"]);
  assert.deepEqual(
    flagged.map((f) => [f.name, f.risk]),
    [
      ["reqeusts", "typo"],
      ["acme-official", "suspicious"],
    ],
  );
  assert.deepEqual(flaggedSpecs(["numpy", "pandas"]), []); // all clean → empty
});

test("withinOneEdit: two transpositions / transposition+diff are NOT within one edit (rest is checked)", () => {
  assert.equal(withinOneEdit("abcd", "badc"), false); // ab->ba AND cd->dc = 2 edits
  assert.equal(withinOneEdit("abcx", "bacy"), false); // transposition + a trailing substitution
  assert.equal(withinOneEdit("ab", "ba"), true); // a single adjacent transposition still holds
  assert.equal(withinOneEdit("abcd", "abdc"), true); // one transposition, rest identical
});
