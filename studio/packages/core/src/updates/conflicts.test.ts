/**
 * conflicts.test.ts — the cross-check between "what a manager offers" and "what actually runs".
 *
 * Every scenario is reproduced from one machine on 2026-09-29, and each one is a case where both
 * inputs are individually TRUE and the conclusion is only visible when they are put together.
 * That is the whole reason this module exists, so the tests are written as the pairs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { findConflicts, plainUpgrades } from "./conflicts.js";
import { type ToolCopy, resolveTool } from "./install-owner.js";
import type { OutdatedPackage } from "./package-managers.js";

const HOME = "/Users/someone";

const copy = (
  p: Partial<ToolCopy> & Pick<ToolCopy, "pathEntry" | "realPath" | "owner">,
): ToolCopy => p as ToolCopy;

/* --------------------------- the reported bug --------------------------- */

test("THE BUG: brew offers claude-code 2.1.277 while 2.1.284 is what runs", () => {
  /**
   * `brew outdated --greedy` says `claude-code 2.1.274 -> 2.1.277`. True.
   * `claude --version` says 2.1.284, from the vendor installer. Also true.
   *
   * Together: the upgrade Homebrew is offering installs something OLDER than what the user runs,
   * into a path PATH never reaches. The command succeeds, so nothing signals the failure — and
   * `brew outdated` offers it again tomorrow. This is "brew installs another newer version
   * alongside and never lets me use it", exactly.
   */
  const res = resolveTool("claude", [
    copy({
      pathEntry: `${HOME}/.local/bin/claude`,
      realPath: `${HOME}/.local/share/claude/versions/2.1.284/claude`,
      owner: "native-installer",
      name: "claude",
      version: "2.1.284",
    }),
    copy({
      pathEntry: "/opt/homebrew/bin/claude",
      realPath: "/opt/homebrew/Caskroom/claude-code/2.1.274/claude",
      owner: "brew-cask",
      name: "claude-code",
      version: "2.1.274",
    }),
  ]);
  const outdated: OutdatedPackage[] = [
    {
      manager: "brew",
      name: "claude-code",
      kind: "cask",
      installed: "2.1.274",
      available: "2.1.277",
    },
  ];
  const found = findConflicts({ resolutions: [res], outdated });
  const downgrade = found.find((c) => c.kind === "downgrade-offer");
  assert.ok(downgrade, "the downgrade must be detected");
  assert.equal(downgrade?.severity, "high");
  assert.match(downgrade?.consequence ?? "", /OLDER than the 2\.1\.284/);
  // The dangerous command must be NAMED. The user will otherwise find it in `brew outdated`
  // themselves and run it with no warning attached.
  assert.equal(downgrade?.avoid, "brew upgrade --cask claude-code");
});

test("a shadowed upgrade that is genuinely NEWER is still flagged, at lower severity", () => {
  // Same shape, but the offered version really is ahead. It still changes nothing the user runs,
  // so it is reported — as a no-op rather than as a downgrade.
  const res = resolveTool("codex", [
    copy({
      pathEntry: "/opt/homebrew/bin/codex",
      realPath: "/opt/homebrew/Caskroom/codex/0.157.1/bin/codex",
      owner: "brew-cask",
      name: "codex",
      version: "0.157.1",
    }),
    copy({
      pathEntry: "/usr/local/bin/codex",
      realPath: `${HOME}/.local/share/npm/lib/node_modules/@openai/codex/bin/codex.js`,
      owner: "npm-global",
      name: "@openai/codex",
      version: "0.142.5",
    }),
  ]);
  const outdated: OutdatedPackage[] = [
    { manager: "npm-global", name: "@openai/codex", installed: "0.142.5", available: "0.158.0" },
  ];
  const found = findConflicts({ resolutions: [res], outdated });
  const shadow = found.find((c) => c.kind === "shadowed-upgrade");
  assert.ok(shadow);
  assert.equal(shadow?.severity, "medium");
  assert.match(shadow?.consequence ?? "", /upgrades a copy you never run/);
  assert.equal(shadow?.avoid, "npm install -g @openai/codex@latest");
});

test("an upgrade that DOES target the PATH copy produces no conflict at all", () => {
  // The control. Over-reporting would train the user to ignore the section.
  const res = resolveTool("codex", [
    copy({
      pathEntry: "/opt/homebrew/bin/codex",
      realPath: "/opt/homebrew/Caskroom/codex/0.157.1/bin/codex",
      owner: "brew-cask",
      name: "codex",
      version: "0.157.1",
    }),
  ]);
  const outdated: OutdatedPackage[] = [
    { manager: "brew", name: "codex", kind: "cask", installed: "0.157.1", available: "0.158.0" },
  ];
  assert.deepEqual(findConflicts({ resolutions: [res], outdated }), []);
});

test("a brew FORMULA row never matches a CASK copy, or ollama would match ollama-app", () => {
  /**
   * The two Homebrew kinds are different packages whose names differ by a suffix. Matching them
   * loosely is how `brew upgrade ollama` gets attached to an Ollama.app install.
   */
  const res = resolveTool("ollama", [
    copy({
      pathEntry: "/usr/local/bin/ollama",
      realPath: "/Applications/Ollama.app/Contents/Resources/ollama",
      owner: "app-bundle",
      name: "Ollama",
      version: "0.34.1",
    }),
  ]);
  const outdated: OutdatedPackage[] = [
    { manager: "brew", name: "ollama", kind: "formula", installed: "0.34.1", available: "0.34.4" },
  ];
  // The app-bundle copy is not owned by the formula row, so no shadowed-upgrade is claimed.
  const found = findConflicts({ resolutions: [res], outdated });
  assert.equal(
    found.filter((c) => c.kind === "shadowed-upgrade" || c.kind === "downgrade-offer").length,
    0,
  );
});

/* --------------------------- the other two --------------------------- */

test("a newer copy behind the PATH winner says the update will NOT help", () => {
  /**
   * The remedy here is not an upgrade — the newer version is already on disk. Telling the user to
   * update would send them round the loop they are already stuck in.
   */
  const res = resolveTool("claude", [
    copy({
      pathEntry: "/opt/homebrew/bin/claude",
      realPath: "/opt/homebrew/Caskroom/claude-code/2.1.274/claude",
      owner: "brew-cask",
      version: "2.1.274",
    }),
    copy({
      pathEntry: `${HOME}/.local/bin/claude`,
      realPath: `${HOME}/.local/share/claude/versions/2.1.284/claude`,
      owner: "native-installer",
      version: "2.1.284",
    }),
  ]);
  const c = findConflicts({ resolutions: [res], outdated: [] }).find(
    (x) => x.kind === "shadowed-newer",
  );
  assert.ok(c);
  assert.equal(c?.severity, "high");
  assert.match(c?.consequence ?? "", /already on disk/);
  assert.match(c?.remedy ?? "", /ahead of/);
});

test("a client driving an older server is reported even though both versions look fine", () => {
  /**
   * Measured: ollama's PATH client is the 0.34.4 Homebrew formula; the server answering on
   * :11434 is the 0.34.1 inside Ollama.app. No version comparison of the CLI can see this, and
   * upgrading the CLI makes the reported number move while every request still runs on 0.34.1.
   */
  const res = resolveTool("ollama", [
    copy({
      pathEntry: "/opt/homebrew/bin/ollama",
      realPath: "/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama",
      owner: "brew-formula",
      name: "ollama",
      version: "0.34.4",
    }),
    copy({
      pathEntry: "/usr/local/bin/ollama",
      realPath: "/Applications/Ollama.app/Contents/Resources/ollama",
      owner: "app-bundle",
      version: "0.34.1",
    }),
  ]);
  const c = findConflicts({
    resolutions: [res],
    outdated: [],
    serverVersions: { ollama: "0.34.1" },
  }).find((x) => x.kind === "client-server-skew");
  assert.ok(c);
  assert.match(c?.consequence ?? "", /client only/);
  assert.match(c?.remedy ?? "", /app itself/);
});

test("matching client and server produce no skew finding", () => {
  const res = resolveTool("ollama", [
    copy({
      pathEntry: "/opt/homebrew/bin/ollama",
      realPath: "/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama",
      owner: "brew-formula",
      name: "ollama",
      version: "0.34.4",
    }),
  ]);
  const found = findConflicts({
    resolutions: [res],
    outdated: [],
    serverVersions: { ollama: "0.34.4" },
  });
  assert.equal(found.filter((c) => c.kind === "client-server-skew").length, 0);
});

test("a bin directory that is not on PATH makes every install through it a silent no-op", () => {
  /**
   * Measured: a `codex update` run rewrote ~/.npmrc to point npm's global prefix at
   * ~/.local/share/npm, and nothing ever added its `bin` to PATH. `npm install -g` then exits 0
   * having produced a launcher no shell will find.
   */
  const c = findConflicts({
    resolutions: [],
    outdated: [],
    unreachableBinDirs: [
      {
        manager: "npm (global)",
        dir: `${HOME}/.local/share/npm/bin`,
        installCommand: "npm install -g <pkg>",
      },
    ],
  })[0];
  assert.equal(c?.kind, "unreachable-bin-dir");
  assert.equal(c?.severity, "high");
  assert.match(c?.consequence ?? "", /report success/);
});

/* ------------------------------ presentation ------------------------------ */

test("findings are ordered most-misleading first", () => {
  const res = resolveTool("claude", [
    copy({
      pathEntry: "/a/claude",
      realPath: `${HOME}/.local/share/claude/versions/2.1.284/c`,
      owner: "native-installer",
      version: "2.1.284",
    }),
    copy({
      pathEntry: "/b/claude",
      realPath: "/opt/homebrew/Caskroom/claude-code/2.1.274/c",
      owner: "brew-cask",
      name: "claude-code",
      version: "2.1.274",
    }),
  ]);
  const found = findConflicts({
    resolutions: [res],
    outdated: [
      {
        manager: "brew",
        name: "claude-code",
        kind: "cask",
        installed: "2.1.274",
        available: "2.1.277",
      },
    ],
  });
  assert.equal(found[0]?.severity, "high");
  assert.ok(found.length >= 2);
  assert.equal(found[found.length - 1]?.severity, "low");
});

test("a flagged package is removed from the plain list but NOT from the report", () => {
  /**
   * The row still exists and the user is still told about it — under its explanation. Hiding it
   * outright would leave them to rediscover the same command in `brew outdated`, with nothing
   * attached to say what it does.
   */
  const outdated: OutdatedPackage[] = [
    {
      manager: "brew",
      name: "claude-code",
      kind: "cask",
      installed: "2.1.274",
      available: "2.1.277",
    },
    { manager: "brew", name: "pcre2", kind: "formula", installed: "10.48", available: "10.49" },
  ];
  const conflicts = [
    {
      kind: "downgrade-offer" as const,
      subject: "claude",
      summary: "",
      consequence: "",
      avoid: "brew upgrade --cask claude-code",
      severity: "high" as const,
    },
  ];
  assert.deepEqual(
    plainUpgrades(outdated, conflicts).map((p) => p.name),
    ["pcre2"],
  );
});

test("a rebuild is not reported as a downgrade — `3.6.4 -> 3.6.4_1` is a repackaging", () => {
  const res = resolveTool("openssl", [
    copy({
      pathEntry: "/usr/local/bin/openssl",
      realPath: "/opt/homebrew/Cellar/openssl@3/3.6.4/bin/openssl",
      owner: "brew-formula",
      name: "openssl@3",
      version: "3.6.4",
    }),
    copy({ pathEntry: "/other/openssl", realPath: "/other/openssl", owner: "unknown" }),
  ]);
  const found = findConflicts({
    resolutions: [res],
    outdated: [
      {
        manager: "brew",
        name: "openssl@3",
        kind: "formula",
        installed: "3.6.4",
        available: "3.6.4_1",
      },
    ],
  });
  assert.equal(found.filter((c) => c.kind === "downgrade-offer").length, 0);
});
