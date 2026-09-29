/**
 * tool-registry.test.ts — the third-party dependency table.
 *
 * A table is the easiest thing in a codebase to get quietly wrong: a package name that does not
 * exist, a brew token that 404s, a command for the wrong install method. None of those throw.
 * They produce a row that says "up to date" forever, or an instruction that installs a second
 * copy of something the user already has.
 *
 * So these tests are mostly about the table's SHAPE being checkable without the network, plus
 * the three parsing traps that were measured on real responses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { partitionCommands, resolveTool } from "./install-owner.js";
import { UPDATE_SERVICES, updateSourceFor } from "./sources.js";
import {
  TOOL_CHECKS,
  type ToolCheck,
  latestUrl,
  parseLatest,
  parseVendorDelta,
  toolCheck,
  toolsInRole,
  updateCommandsFor,
  vendorDeltaUrl,
} from "./tool-registry.js";

/* ── table hygiene ──────────────────────────────────────────────────────────────────────────*/

test("every tool has a unique lowercase id and at least one channel and one command", () => {
  const ids = TOOL_CHECKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate tool id");
  for (const t of TOOL_CHECKS) {
    assert.match(t.id, /^[a-z][a-z0-9.-]*$/, `${t.id} is not a plain id`);
    assert.ok(t.label.trim() !== "", `${t.id} has no label`);
    assert.ok(t.latest.length > 0, `${t.id} has no version channel`);
    assert.ok(t.update.length > 0, `${t.id} has no update command`);
  }
});

test("a tool whose version cannot be read still tells the user how to update, and why", () => {
  // The honest shape for hermes and cursor: no version comparison, but never a dead end — and
  // never an unexplained blank where a version should be.
  //
  // The reason lives on the CHANNEL (`{kind:"none", why}`) rather than on the row, because it
  // is a fact about that lookup, not about the tool: a tool can have one dead channel and one
  // working one. A row-level `note` is the optional extra. This test accepts either, which is
  // what it should have said in the first place — the first version demanded both and failed
  // on `cursor`, whose `why` already explains it perfectly well.
  for (const t of TOOL_CHECKS) {
    const dead = t.latest.every((c) => c.kind === "none");
    if (!dead) continue;
    assert.ok(
      t.update.some((c) => c.command.trim() !== ""),
      `${t.id} can neither be versioned nor updated — it would render as a dead row`,
    );
    const why = t.latest.find((c) => c.kind === "none") as { why: string };
    assert.ok(
      (why.why?.trim() ?? "") !== "" || (t.note?.trim() ?? "") !== "",
      `${t.id} shows no version and does not say why`,
    );
  }
});

test("a command with an empty string is a self-updater and must explain itself", () => {
  // An empty command renders as "nothing to run". Without a note that reads as a bug.
  for (const t of TOOL_CHECKS) {
    for (const c of t.update) {
      if (c.command.trim() !== "") continue;
      assert.ok(c.note, `${t.id}/${c.via} has an empty command and no explanation`);
    }
  }
});

test("every non-empty update command is a single line with no shell substitution", () => {
  // These are shown for the user to copy. A newline would paste as two commands; `$(...)` in a
  // displayed string is a thing a reader cannot audit at a glance.
  for (const t of TOOL_CHECKS) {
    for (const c of t.update) {
      if (c.command === "") continue;
      assert.ok(!c.command.includes("\n"), `${t.id}/${c.via} spans lines`);
      assert.ok(!/\$\(/.test(c.command), `${t.id}/${c.via} contains a command substitution`);
      assert.ok(!c.command.includes("&&"), `${t.id}/${c.via} chains commands`);
    }
  }
});

test("roles partition the table, and the engines come first", () => {
  const roles = ["engine", "agent", "toolchain", "optional"] as const;
  const counted = roles.reduce((n, r) => n + toolsInRole(r).length, 0);
  assert.equal(counted, TOOL_CHECKS.length, "a tool has a role outside the four");
  assert.ok(toolsInRole("engine").length >= 2, "ollama and LM Studio at minimum");
});

test("lookup is case-insensitive and returns undefined rather than throwing", () => {
  assert.equal(toolCheck("OLLAMA")?.id, "ollama");
  assert.equal(toolCheck("  ollama  ")?.id, "ollama");
  assert.equal(toolCheck("nope"), undefined);
});

/* ── URL construction ───────────────────────────────────────────────────────────────────────*/

test("each channel builds the URL that was actually verified", () => {
  assert.equal(
    latestUrl({ kind: "npm", pkg: "@openai/codex" }),
    "https://registry.npmjs.org/@openai/codex/latest",
  );
  assert.equal(
    latestUrl({ kind: "brew-formula", name: "llama.cpp" }),
    "https://formulae.brew.sh/api/formula/llama.cpp.json",
  );
  assert.equal(
    latestUrl({ kind: "brew-cask", token: "ollama-app" }),
    "https://formulae.brew.sh/api/cask/ollama-app.json",
  );
  assert.equal(latestUrl({ kind: "pypi", pkg: "mlx-lm" }), "https://pypi.org/pypi/mlx-lm/json");
  assert.equal(
    latestUrl({ kind: "github", repo: "ollama/ollama" }),
    "https://api.github.com/repos/ollama/ollama/releases/latest",
  );
  assert.equal(latestUrl({ kind: "none", why: "x" }), null);
  assert.equal(latestUrl({ kind: "vendor-delta", url: "https://x/y", note: "" }), null);
});

test("a vendor-delta URL refuses to be built without a plausible version", () => {
  const ch = { kind: "vendor-delta", url: "https://ollama.com/api/update", note: "" } as const;
  assert.equal(
    vendorDeltaUrl(ch, { os: "darwin", arch: "arm64", version: "0.34.1" }),
    "https://ollama.com/api/update?os=darwin&arch=arm64&version=0.34.1",
  );
  // Asking "what is the latest" without saying what you have is meaningless to this endpoint.
  assert.equal(vendorDeltaUrl(ch, { os: "darwin", arch: "arm64", version: "" }), null);
  assert.equal(vendorDeltaUrl(ch, { os: "darwin", arch: "arm64", version: "unknown" }), null);
  // and the os/arch go into a query string, so they are constrained
  assert.equal(vendorDeltaUrl(ch, { os: "dar win", arch: "arm64", version: "1.0.0" }), null);
  assert.equal(vendorDeltaUrl(ch, { os: "darwin", arch: "a&b=c", version: "1.0.0" }), null);
});

/* ── the three parsing traps, each measured on a real response ──────────────────────────────*/

test("brew FORMULA reads .versions.stable; brew CASK reads .version", () => {
  // Two different shapes behind two nearly identical URLs.
  assert.equal(
    parseLatest({ kind: "brew-formula", name: "ollama" }, { versions: { stable: "0.34.4" } }),
    "0.34.4",
  );
  assert.equal(
    parseLatest({ kind: "brew-cask", token: "ollama-app" }, { version: "0.34.4" }),
    "0.34.4",
  );
  // and neither accepts the other's shape
  assert.equal(parseLatest({ kind: "brew-formula", name: "x" }, { version: "1.2.3" }), null);
  assert.equal(
    parseLatest({ kind: "brew-cask", token: "x" }, { versions: { stable: "1.2.3" } }),
    null,
  );
});

test("a cask revision suffix is dropped, not rejected", () => {
  // MEASURED: `lm-studio` reports "0.4.25,1". `parseVersion` rejects the whole string, so a
  // naive reader gets null and LM Studio silently never has an update. The revision identifies
  // a repackaging of the same upstream release, so it is not part of the comparison.
  assert.equal(
    parseLatest({ kind: "brew-cask", token: "lm-studio" }, { version: "0.4.25,1" }),
    "0.4.25",
  );
  assert.equal(parseLatest({ kind: "brew-cask", token: "x" }, { version: "1.2.3" }), "1.2.3");
});

test("github reads tag_name, never name — the prerelease trap", () => {
  // MEASURED on ollama: the releases atom feed titles an entry `v0.40.0` while linking the tag
  // `v0.40.0-rc0`, and `/releases/latest` is still v0.34.4. Reading `name` announces a general
  // release that does not exist.
  assert.equal(
    parseLatest(
      { kind: "github", repo: "ollama/ollama" },
      { tag_name: "v0.34.4", name: "v0.40.0" },
    ),
    "v0.34.4",
  );
  assert.equal(parseLatest({ kind: "github", repo: "x/y" }, { name: "v9.9.9" }), null);
});

test("every parser returns null on junk rather than coercing", () => {
  // A garbled version compares as "different" and produces a phantom update — a download
  // offered for no reason.
  const channels = [
    { kind: "npm", pkg: "x" },
    { kind: "brew-formula", name: "x" },
    { kind: "brew-cask", token: "x" },
    { kind: "pypi", pkg: "x" },
    { kind: "github", repo: "x/y" },
  ] as const;
  for (const ch of channels) {
    for (const junk of [null, undefined, "", 42, [], {}, { version: "" }, { version: "latest" }]) {
      assert.equal(parseLatest(ch, junk), null, `${ch.kind} accepted ${JSON.stringify(junk)}`);
    }
  }
});

test("vendor-delta distinguishes 'current' from 'could not tell'", () => {
  // The distinction the whole endpoint exists for. Collapsing an error into "current" reports
  // "you are up to date" when nothing was checked.
  assert.deepEqual(
    parseVendorDelta(
      200,
      '{"url":"https://github.com/ollama/ollama/releases/download/v0.34.4/Ollama-darwin.zip"}',
    ),
    { url: "https://github.com/ollama/ollama/releases/download/v0.34.4/Ollama-darwin.zip" },
  );
  assert.equal(parseVendorDelta(204, ""), "current");
  for (const [status, body] of [
    [500, ""],
    [403, "rate limited"],
    [200, "not json"],
    [200, "{}"],
    [200, '{"url":"http://insecure"}'],
    [200, '{"url":123}'],
  ] as const) {
    assert.equal(parseVendorDelta(status, body), null, `${status} ${body} must be 'unknown'`);
  }
});

/* ── the ollama double-install trap ─────────────────────────────────────────────────────────*/

test("ollama's channels are ordered vendor → cask → formula → github", () => {
  // Preference order is load-bearing, not cosmetic: the vendor endpoint is authoritative and
  // uncapped, brew is uncapped, and GitHub is 60 requests/hour for the whole machine.
  const kinds = (toolCheck("ollama") as ToolCheck).latest.map((c) => c.kind);
  assert.deepEqual(kinds, ["vendor-delta", "brew-cask", "brew-formula", "github"]);
  assert.equal(kinds.indexOf("github"), kinds.length - 1, "github must be the last resort");
});

test("an Ollama.app user is NEVER told to brew upgrade the formula", () => {
  /**
   * CLAUDE.md §2.8: the brew service and Ollama.app fought over :11434 and crash-looped 36,135
   * times. `brew upgrade ollama` moves the CLI formula and cannot move the server inside the app.
   *
   * This test used to assert the command was ABSENT FROM THE TABLE, and that was the wrong
   * guard — it also hid the command from the machine that genuinely has the formula installed
   * and first on PATH, which is this one. The command is correct for the artifact it names; what
   * must never happen is offering it to someone whose ollama is the APP. That is now a property
   * of `partitionCommands`, so it is asserted behaviourally, where it actually binds.
   */
  const ollama = toolCheck("ollama") as ToolCheck;
  const forApp = updateCommandsFor(ollama, "darwin", "app");
  assert.equal(forApp.length, 1);
  assert.equal(forApp[0]?.command, "", "the app updates itself");
  assert.ok(forApp[0]?.note, "and says so");

  const appOnly = resolveTool("ollama", [
    {
      pathEntry: "/usr/local/bin/ollama",
      realPath: "/Applications/Ollama.app/Contents/Resources/ollama",
      owner: "app-bundle",
      version: "0.34.1",
      versionSource: "bundle",
    },
  ]);
  const { offer, withheld } = partitionCommands(appOnly, updateCommandsFor(ollama, "darwin"));
  assert.ok(
    offer.every((c) => !/brew upgrade ollama\b/.test(c.command)),
    "an app-bundle install must never be OFFERED the formula upgrade",
  );
  assert.ok(
    withheld.some((w) => /brew upgrade ollama\b/.test(w.command.command)),
    "…and it must be withheld explicitly, not silently dropped",
  );
  assert.deepEqual(
    offer.map((c) => c.command),
    [""],
    "the only thing an app-bundle install is offered is the app updating itself",
  );
});

test("the formula upgrade IS offered to the machine that actually has the formula", () => {
  /**
   * The other half, and the reason the absence-based guard had to go: on this machine ollama IS
   * the Homebrew formula and IS first on PATH. Withholding its only real update command would
   * have left it permanently un-upgradable with no explanation.
   */
  const ollama = toolCheck("ollama") as ToolCheck;
  const formula = resolveTool("ollama", [
    {
      pathEntry: "/opt/homebrew/bin/ollama",
      realPath: "/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama",
      owner: "brew-formula",
      name: "ollama",
      version: "0.34.4",
      versionSource: "path",
    },
  ]);
  const { offer } = partitionCommands(formula, updateCommandsFor(ollama, "darwin"));
  const cmd = offer.find((c) => /brew upgrade ollama\b/.test(c.command));
  assert.ok(cmd, "the formula install must get the formula command");
  // The consequence travels WITH the command, so it can never be shown bare.
  assert.match(cmd?.note ?? "", /:11434|CLI only/);
});

test("update commands are filtered by platform, and linux gets the install script", () => {
  const ollama = toolCheck("ollama") as ToolCheck;
  const linux = updateCommandsFor(ollama, "linux");
  // The darwin-only app and cask rows drop out; the platform-agnostic formula row stays, because
  // Linuxbrew is real and `brew upgrade ollama` is correct there.
  assert.deepEqual(
    linux.map((c) => c.via),
    ["brew-formula", "script"],
  );
  assert.ok(linux.some((c) => /install\.sh/.test(c.command)));
  assert.ok(
    updateCommandsFor(ollama, "linux").every((c) => !c.command.includes("--cask")),
    "casks do not exist on linux",
  );
});

test("hermes reports a command and refuses to report a version", () => {
  // Four sources gave four different numbers, and PyPI is not even the install channel.
  const h = toolCheck("hermes") as ToolCheck;
  assert.deepEqual(
    h.latest.map((c) => c.kind),
    ["none"],
  );
  assert.equal(updateCommandsFor(h, "darwin")[0]?.command, "hermes update");
});

test("opencode points at the package that exists", () => {
  // `opencode` on npm is a 404. `opencode-ai` is the real one — and a 404 would have read as
  // "no update, ever".
  const o = toolCheck("opencode") as ToolCheck;
  assert.deepEqual(o.latest, [{ kind: "npm", pkg: "opencode-ai" }]);
});

/* ── the two tables must not drift ──────────────────────────────────────────────────────────
 *
 * `sources.ts` predates this file and still drives `apps/cli/src/updates/check.ts`. Both
 * describe claude, codex, gemini, cursor and ollama, so both can be edited independently — and
 * they HAD already contradicted each other: `sources.ts` recommended
 * `brew upgrade ollama` while this table forbids it, because on a machine running Ollama.app
 * that installs a second CLI to fight for :11434 (CLAUDE.md §2.8 — 36,135 crash-loops).
 *
 * Rather than a risky refactor of a live code path, the overlap is pinned. One table may carry
 * more detail than the other; neither may say something the other contradicts.
 */

test("the five tools in BOTH tables agree on identity", () => {
  for (const service of UPDATE_SERVICES) {
    const old = updateSourceFor(service);
    const now = toolCheck(service);
    assert.ok(old, `${service} missing from sources.ts`);
    assert.ok(
      now,
      `${service} is in sources.ts but not in TOOL_CHECKS — the newer table is the
      one surfaces will grow toward, so a gap here is a tool that silently stops being checked`,
    );

    // the npm package name, where both name one, must be identical
    const oldNpm = old.channel === "npm" ? old.id : undefined;
    const newNpm = now.latest.find((c) => c.kind === "npm") as { pkg: string } | undefined;
    if (oldNpm && newNpm) {
      assert.equal(newNpm.pkg, oldNpm, `${service}: npm package disagrees between the tables`);
    }
  }
});

test("neither table recommends `brew upgrade ollama` — the second-install trap", () => {
  // The specific contradiction that was live. Asserted on BOTH tables so fixing one and not the
  // other fails here.
  const old = updateSourceFor("ollama");
  assert.ok(old);
  assert.ok(
    !/brew upgrade ollama\b/.test(old.selfUpdate),
    "sources.ts is back to recommending the formula upgrade",
  );
  /**
   * `tool-registry.ts` may now CARRY `brew upgrade ollama` — it is the right command for a
   * formula install — but only as a `brew-formula` row, and only with the consequence attached.
   * A row that offered it under any other `via` would reach an install it cannot update.
   */
  for (const c of (toolCheck("ollama") as ToolCheck).update) {
    if (!/brew upgrade ollama\b/.test(c.command)) continue;
    assert.equal(c.via, "brew-formula", "the formula command must be tied to a formula install");
    assert.match(c.note ?? "", /:11434/, "and must carry the server-split warning");
  }
});

test("a tool that can self-update says the same thing in both tables", () => {
  // `claude update` / `codex update` / `cursor-agent update` are the vendor's own path; if one
  // table learned a different command the user would be shown two ways to do one thing.
  for (const service of UPDATE_SERVICES) {
    const old = updateSourceFor(service);
    const now = toolCheck(service);
    if (!old || !now) continue;
    const selfCmd = now.update.find((c) => c.via === "self")?.command;
    if (!selfCmd || selfCmd === "") continue;
    assert.ok(
      old.selfUpdate.includes(selfCmd),
      `${service}: sources.ts says "${old.selfUpdate}" but tool-registry says "${selfCmd}"`,
    );
  }
});
