/**
 * install-owner.test.ts — attribution, shadowing, and the refusals that follow from them.
 *
 * Every path in here was observed on a real machine on 2026-09-29 (see the file header of
 * install-owner.ts). They are not illustrative: each one is a layout that a previous version of
 * this code classified wrongly, and the test names say which wrong answer it used to give.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ToolCopy,
  classifyPath,
  fallbackCommandFor,
  ownerLabel,
  partitionCommands,
  resolveTool,
  targetsWinner,
  viaForOwner,
  zapHazard,
} from "./install-owner.js";
import type { UpdateCommand } from "./tool-registry.js";

const HOME = "/Users/someone";

/* ------------------------------ attribution ------------------------------ */

test("a Homebrew FORMULA is attributed by its Cellar segment, with name and version", () => {
  const r = classifyPath("/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama");
  assert.equal(r.owner, "brew-formula");
  assert.equal(r.name, "ollama");
  assert.equal(r.version, "0.34.4");
  assert.equal(r.prefix, "/opt/homebrew");
});

test("a Homebrew CASK is a DIFFERENT owner from a formula — they are different packages", () => {
  const r = classifyPath("/opt/homebrew/Caskroom/claude-code/2.1.274/claude");
  assert.equal(r.owner, "brew-cask");
  assert.equal(r.name, "claude-code");
  assert.equal(r.version, "2.1.274");
  // The distinction is the whole point: `brew upgrade <formula>` and `brew upgrade --cask <token>`
  // act on different artifacts, and ollama ships BOTH under names one letter apart.
  assert.notEqual(r.owner, classifyPath("/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama").owner);
});

test("the brew prefix is not hardcoded — Intel macOS and Linuxbrew classify identically", () => {
  assert.equal(classifyPath("/usr/local/Cellar/git/2.4.0/bin/git").owner, "brew-formula");
  assert.equal(
    classifyPath("/home/linuxbrew/.linuxbrew/Cellar/ripgrep/14.1.1/bin/rg").owner,
    "brew-formula",
  );
  assert.equal(classifyPath("/usr/local/Cellar/git/2.4.0/bin/git").prefix, "/usr/local");
});

test("REGRESSION: an npm global under Homebrew's node is npm-global, NOT brew", () => {
  /**
   * The bug this replaces. `probe.ts`'s old classifier tested /Cellar|homebrew|linuxbrew/ FIRST,
   * so every npm-global package installed under Homebrew's node prefix was called "brew" — and
   * was then handed a `brew upgrade` command for a package Homebrew has never heard of.
   */
  const r = classifyPath("/opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js");
  assert.equal(r.owner, "npm-global");
  assert.equal(r.name, "@google/gemini-cli");
  assert.equal(r.prefix, "/opt/homebrew");
});

test("a scoped npm package keeps both segments of its name", () => {
  const r = classifyPath(`${HOME}/.local/share/npm/lib/node_modules/@openai/codex/bin/codex.js`);
  assert.equal(r.owner, "npm-global");
  assert.equal(r.name, "@openai/codex");
});

test("an unscoped npm package takes one segment", () => {
  assert.equal(
    classifyPath("/usr/local/lib/node_modules/opencode-ai/bin/opencode").name,
    "opencode-ai",
  );
});

test("a vendor's own installer is recognised by its versions/<v> tree, and the version is free", () => {
  /**
   * `curl -fsSL https://claude.ai/install.sh | bash` writes ~/.local/share/claude/versions/<v>
   * and symlinks ~/.local/bin/claude at it. Reading the version out of the PATH means a copy we
   * must never execute still gets compared.
   */
  const r = classifyPath(`${HOME}/.local/share/claude/versions/2.1.284/claude`);
  assert.equal(r.owner, "native-installer");
  assert.equal(r.name, "claude");
  assert.equal(r.version, "2.1.284");
});

test("a macOS app bundle is its own owner and carries NO path version", () => {
  const r = classifyPath("/Applications/Ollama.app/Contents/Resources/ollama");
  assert.equal(r.owner, "app-bundle");
  assert.equal(r.name, "Ollama");
  // Info.plist is the only authority for an app's version; inventing one from the path would be
  // a guess, and this module never guesses.
  assert.equal(r.version, undefined);
});

test("pipx needs the metadata hint — a pyvenv.cfg alone is NOT enough to tell them apart", () => {
  const p = `${HOME}/Library/Application Support/pipx/venvs/huggingface-hub/bin/hf`;
  // A pipx venv contains pyvenv.cfg exactly like a hand-made one, so the cfg cannot discriminate.
  assert.equal(classifyPath(p, { pyvenvCfg: true, pipxVenv: true }).owner, "pipx");
  const handMade = classifyPath(`${HOME}/venvs/mine/bin/hf`, { pyvenvCfg: true });
  assert.equal(handMade.owner, "python-venv");
  // …and a hand-made venv must NOT be offered `pipx upgrade`, which errors outright on a package
  // pipx never installed. The two owners map to two different `via` values, so the table's
  // `pipx upgrade huggingface-hub` row can never match a plain venv.
  assert.equal(viaForOwner("python-venv"), "venv");
  assert.equal(viaForOwner("pipx"), "pipx");
});

test("a tool that owns a dot-directory in $HOME is attributed, not left unmanaged", () => {
  /**
   * Measured: `lms` is at ~/.lmstudio/bin/lms and `opencode` at ~/.opencode/bin/opencode. Both
   * were previously "unattributed", which offered them NO update command at all — a silent gap in
   * two of the tools this feature was asked to cover.
   */
  assert.deepEqual(classifyPath(`${HOME}/.lmstudio/bin/lms`, { home: HOME }), {
    owner: "native-installer",
    name: "lmstudio",
  });
  assert.equal(classifyPath(`${HOME}/.opencode/bin/opencode`, { home: HOME }).name, "opencode");
  // A dot-directory WITHOUT a bin/ below it is not this layout.
  assert.equal(classifyPath(`${HOME}/.config/thing`, { home: HOME }).owner, "unknown");
});

test("brew's two kinds map to two DIFFERENT via values", () => {
  // The single-`brew` vocabulary this replaced matched a cask command to a formula install, which
  // is how `brew upgrade --cask ollama-app` was offered for a Cellar install of ollama.
  assert.equal(viaForOwner("brew-formula"), "brew-formula");
  assert.equal(viaForOwner("brew-cask"), "brew-cask");
  assert.notEqual(viaForOwner("brew-formula"), viaForOwner("brew-cask"));
});

test("pipx is also recognised structurally, for the Linux layout where PIPX_HOME differs", () => {
  assert.equal(classifyPath(`${HOME}/.local/share/pipx/venvs/mlx-lm/bin/mlx_lm`).owner, "pipx");
});

test("cargo and go need the home hint, and get it wrong without one", () => {
  assert.equal(classifyPath(`${HOME}/.cargo/bin/rg`, { home: HOME }).owner, "cargo");
  assert.equal(classifyPath(`${HOME}/go/bin/gopls`, { home: HOME }).owner, "go");
  // Without the hint we say "unknown" rather than guessing — an honest gap, not a wrong answer.
  assert.equal(classifyPath(`${HOME}/.cargo/bin/rg`).owner, "unknown");
});

test("/usr/bin is system, but /usr/local is NOT", () => {
  assert.equal(classifyPath("/usr/bin/python3").owner, "system");
  assert.equal(classifyPath("/bin/ls").owner, "system");
  /**
   * /usr/local is Homebrew's default prefix on Intel macOS and the conventional home of
   * hand-installed software everywhere. Calling it "system" would tell a user their tool cannot
   * be upgraded when it simply has not been attributed.
   */
  assert.equal(classifyPath("/usr/local/bin/codex").owner, "unknown");
});

test("a directory segment that is not a version defeats the layout match, rather than mis-reading it", () => {
  // `Cellar` with no version below it is not a keg; reporting it as one would invent a version.
  assert.equal(classifyPath("/opt/homebrew/Cellar/ollama").owner, "unknown");
  assert.equal(classifyPath("/some/project/versions/notes/file").owner, "unknown");
});

test("a brew rebuild suffix and a cask revision survive attribution verbatim", () => {
  // They matter for `brew outdated` and must not be silently normalised here — only at compare
  // time, where `_1` and `,1` are known to identify a repackaging rather than a new release.
  assert.equal(classifyPath("/opt/homebrew/Cellar/node/26.10.0_1/bin/node").version, "26.10.0_1");
  assert.equal(classifyPath("/opt/homebrew/Caskroom/lm-studio/0.4.25,1/x").version, "0.4.25,1");
});

/* -------------------------------- verdicts -------------------------------- */

const copy = (pathEntry: string, realPath: string, extra: Partial<ToolCopy> = {}): ToolCopy => {
  const info = classifyPath(realPath, { home: HOME });
  return {
    pathEntry,
    realPath,
    owner: info.owner,
    ...(info.name ? { name: info.name } : {}),
    ...(info.version ? { version: info.version, versionSource: "path" as const } : {}),
    ...extra,
  };
};

test("one copy is `single`, and nothing is withheld", () => {
  const r = resolveTool("rg", [
    copy("/opt/homebrew/bin/rg", "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg"),
  ]);
  assert.equal(r.state, "single");
  assert.equal(r.shadowed.length, 0);
  assert.equal(r.winner?.owner, "brew-formula");
});

test("nothing installed is `absent`, not an error", () => {
  const r = resolveTool("lms", []);
  assert.equal(r.state, "absent");
  assert.equal(r.winner, undefined);
});

test("THE USER'S BUG: a newer copy behind the PATH winner is `shadowed`", () => {
  /**
   * claude, measured: the native installer's 2.1.284 wins PATH, and a Homebrew cask sits behind
   * it at 2.1.274. The old code reported one row and one command.
   */
  const r = resolveTool("claude", [
    copy(`${HOME}/.local/bin/claude`, `${HOME}/.local/share/claude/versions/2.1.284/claude`),
    copy("/opt/homebrew/bin/claude", "/opt/homebrew/Caskroom/claude-code/2.1.274/claude"),
  ]);
  // The winner here is the NEWER one, so this is a duplicate, not a shadow…
  assert.equal(r.state, "duplicate");
  assert.equal(r.shadowed.length, 1);
  assert.equal(r.shadowed[0]?.owner, "brew-cask");
});

test("…and with the order reversed it IS a shadow, naming the copy that is newer", () => {
  const r = resolveTool("claude", [
    copy("/opt/homebrew/bin/claude", "/opt/homebrew/Caskroom/claude-code/2.1.274/claude"),
    copy(`${HOME}/.local/bin/claude`, `${HOME}/.local/share/claude/versions/2.1.284/claude`),
  ]);
  assert.equal(r.state, "shadowed");
  assert.equal(r.newerShadow?.version, "2.1.284");
  assert.equal(r.winner?.version, "2.1.274");
});

test("a copy whose version cannot be read makes the verdict `ambiguous`, never `single`", () => {
  /**
   * The failure mode this whole module is built to avoid is a silent downgrade of "I could not
   * tell" into "everything is fine". An app bundle has no path version, so without an Info.plist
   * read the comparison is genuinely unknown and must say so.
   */
  const r = resolveTool("ollama", [
    copy("/opt/homebrew/bin/ollama", "/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama"),
    copy("/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"),
  ]);
  assert.equal(r.state, "ambiguous");
  assert.equal(r.shadowed.length, 1);
});

test("with the app's Info.plist version supplied, the ollama split-brain resolves exactly", () => {
  const r = resolveTool("ollama", [
    copy("/opt/homebrew/bin/ollama", "/opt/homebrew/Cellar/ollama/0.34.4/bin/ollama"),
    copy("/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama", {
      version: "0.34.1",
      versionSource: "bundle",
    }),
  ]);
  // The brew formula is genuinely newer than the app — so this is a duplicate, and the danger is
  // not the version at all: it is that the OLDER app owns :11434. That is the caller's finding to
  // make; what this module must not do is call it "single".
  assert.equal(r.state, "duplicate");
  assert.equal(r.shadowed[0]?.owner, "app-bundle");
});

test("a brew REBUILD is not a newer program — `26.10.0_1` does not shadow `26.10.0`", () => {
  const r = resolveTool("node", [
    copy("/opt/homebrew/bin/node", "/opt/homebrew/Cellar/node/26.10.0/bin/node"),
    copy("/usr/local/bin/node", "/usr/local/Cellar/node/26.10.0_1/bin/node"),
  ]);
  assert.equal(r.state, "duplicate");
  assert.equal(r.newerShadow, undefined);
});

test("the same literal PATH entry twice is not a shadow", () => {
  const one = copy("/opt/homebrew/bin/rg", "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg");
  assert.equal(resolveTool("rg", [one]).state, "single");
});

test("shadowed copies are ordered newest-first so a renderer need not re-sort", () => {
  const r = resolveTool("codex", [
    copy("/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.157.1/codex"),
    copy(
      `${HOME}/.local/share/npm/bin/codex`,
      `${HOME}/.local/share/npm/lib/node_modules/@openai/codex/bin/codex.js`,
      {
        version: "0.142.5",
        versionSource: "path",
      },
    ),
    copy("/usr/local/bin/codex", `${HOME}/.local/share/claude/versions/0.150.0/codex`),
  ]);
  assert.equal(r.shadowed[0]?.version, "0.150.0");
  assert.equal(r.shadowed[1]?.version, "0.142.5");
});

/* ---------------------------- command targeting ---------------------------- */

const cmd = (via: UpdateCommand["via"], command: string): UpdateCommand => ({ via, command });

test("a brew command is withheld when the PATH winner is the native install", () => {
  const r = resolveTool("claude", [
    copy(`${HOME}/.local/bin/claude`, `${HOME}/.local/share/claude/versions/2.1.284/claude`),
    copy("/opt/homebrew/bin/claude", "/opt/homebrew/Caskroom/claude-code/2.1.274/claude"),
  ]);
  const { offer, withheld } = partitionCommands(r, [
    cmd("self", "claude update"),
    cmd("brew-cask", "brew upgrade --cask claude-code"),
  ]);
  assert.deepEqual(
    offer.map((c) => c.command),
    ["claude update"],
  );
  assert.equal(withheld.length, 1);
  // The reason must NAME the copy, because "this command is wrong" is not actionable and the
  // user will otherwise find the same command in `brew outdated` and run it anyway.
  assert.match(withheld[0]?.reason ?? "", /Homebrew cask copy at .*Caskroom.*2\.1\.274/);
});

test("`self` and `git` target the winner by default — they update whatever is running", () => {
  const r = resolveTool("codex", [
    copy("/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.157.1/codex"),
  ]);
  assert.equal(targetsWinner(r, cmd("self", "codex update")), true);
  assert.equal(targetsWinner(r, cmd("git", "git pull")), true);
  assert.equal(targetsWinner(r, cmd("manual", "download it")), true);
  // …and a cask command DOES target this one, because the winner is a cask.
  assert.equal(targetsWinner(r, cmd("brew-cask", "brew upgrade --cask codex")), true);
  assert.equal(targetsWinner(r, cmd("brew-formula", "brew upgrade codex")), false);
  assert.equal(targetsWinner(r, cmd("npm", "npm i -g @openai/codex")), false);
});

test("SELF-INFLICTED: `onlyOwners` stops a vendor installer creating the very shadow we detect", () => {
  /**
   * `codex update` is `via: "self"`, so the default rule offers it to anything. On this machine
   * codex came from a Homebrew cask — and `codex update` does not update the cask: it runs the
   * vendor installer, writes ~/.local/bin/codex, and from then on PATH resolves to THAT instead.
   * Running the update would have manufactured the double-install this feature exists to report.
   */
  const cask = resolveTool("codex", [
    copy("/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.157.1/codex"),
  ]);
  const selfCmd: UpdateCommand = {
    via: "self",
    onlyOwners: ["native-installer", "npm-global"],
    command: "codex update",
  };
  assert.equal(targetsWinner(cask, selfCmd), false);
  const { withheld } = partitionCommands(cask, [selfCmd]);
  assert.match(
    withheld[0]?.reason ?? "",
    /would install a separate copy rather than update the Homebrew cask one/,
  );

  // …and for the install it IS correct for, it is offered.
  const native = resolveTool("codex", [
    copy(`${HOME}/.local/bin/codex`, `${HOME}/.local/share/codex/versions/0.157.1/codex`),
  ]);
  assert.equal(targetsWinner(native, selfCmd), true);
});

test("a command for an install that does not exist says so, rather than naming a copy", () => {
  const r = resolveTool("gemini", [
    copy("/opt/homebrew/bin/gemini", "/opt/homebrew/Cellar/gemini-cli/0.46.0/bin/gemini"),
  ]);
  const { withheld } = partitionCommands(r, [
    cmd("npm", "npm install -g @google/gemini-cli@latest"),
  ]);
  assert.equal(withheld.length, 1);
  assert.match(withheld[0]?.reason ?? "", /no npm install of this tool was found/);
});

test("nothing targets the winner when the tool is absent", () => {
  const r = resolveTool("lms", []);
  assert.equal(targetsWinner(r, cmd("brew-cask", "x")), false);
  assert.equal(targetsWinner(r, cmd("self", "x")), false);
});

test("an unattributed winner offers no manager command — and that is the honest answer", () => {
  const r = resolveTool("mystery", [copy("/usr/local/bin/mystery", "/usr/local/bin/mystery")]);
  assert.equal(r.winner?.owner, "unknown");
  const { offer, withheld } = partitionCommands(r, [
    cmd("brew-formula", "brew upgrade mystery"),
    cmd("npm", "npm i -g mystery"),
  ]);
  assert.equal(offer.length, 0);
  assert.equal(withheld.length, 2);
});

/* ------------------------------- zap interlock ------------------------------- */

test("SAFETY: zapping the stale cask would delete the NEWER native install", () => {
  /**
   * Measured from `brew info --json=v2 --cask claude-code`. The obvious cleanup command for a
   * duplicate is `brew uninstall --zap`, and here it takes ~/.local/share/claude with it — five
   * versions, ~1.1 GB, including the 2.1.284 the user actually runs — plus their config.
   */
  const native = copy(
    `${HOME}/.local/bin/claude`,
    `${HOME}/.local/share/claude/versions/2.1.284/claude`,
  );
  const cask = copy(
    "/opt/homebrew/bin/claude",
    "/opt/homebrew/Caskroom/claude-code/2.1.274/claude",
  );
  const zap = [
    `${HOME}/.local/bin/claude`,
    `${HOME}/.local/share/claude`,
    `${HOME}/.claude.json`,
    `${HOME}/.config/claude`,
  ];
  const hit = zapHazard(zap, [native, cask], cask);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.realPath, native.realPath);
});

test("containment, not equality — the zap lists the PARENT of the live binary", () => {
  /**
   * The zap entry is `~/.local/share/claude`; the binary is
   * `~/.local/share/claude/versions/2.1.284/claude`. Those strings are not equal, and an equality
   * test — the obvious implementation — would have reported this command as safe.
   */
  const native = copy("/x/bin/claude", `${HOME}/.local/share/claude/versions/2.1.284/claude`);
  assert.equal(
    zapHazard([`${HOME}/.local/share/claude`], [native], { ...native, realPath: "/other" }).length,
    1,
  );
  // A sibling directory with a shared prefix must NOT match: ".../claude" is not ".../claude-code".
  assert.equal(
    zapHazard([`${HOME}/.local/share/claude`], [copy("/x", `${HOME}/.local/share/claude-code/x`)], {
      ...native,
      realPath: "/other",
    }).length,
    0,
  );
});

test("the copy being removed is never reported as its own hazard", () => {
  const cask = copy(
    "/opt/homebrew/bin/claude",
    "/opt/homebrew/Caskroom/claude-code/2.1.274/claude",
  );
  assert.equal(zapHazard(["/opt/homebrew/Caskroom/claude-code"], [cask], cask).length, 0);
});

/* ------------------------- synthesised commands ------------------------- */

test("a plain virtualenv gets its OWN pip, because the table cannot know the path", () => {
  /**
   * Measured: `hf` resolves into ~/.hf-cli/venv, a virtualenv pipx has never heard of. The
   * table's `pipx upgrade huggingface-hub` errors; the only command that works contains a path
   * that is a property of this machine.
   */
  const c = copy(`${HOME}/.local/bin/hf`, `${HOME}/.hf-cli/venv/bin/hf`, {
    owner: "python-venv",
  });
  const f = fallbackCommandFor(c, "huggingface-hub");
  assert.equal(f?.via, "venv");
  assert.equal(f?.command, `"${HOME}/.hf-cli/venv/bin/pip" install -U huggingface-hub`);
});

test("a venv path containing a space is quoted, so pasting it does not split", () => {
  const c: ToolCopy = {
    pathEntry: "/x/hf",
    realPath: `${HOME}/Library/Application Support/venv/bin/hf`,
    owner: "python-venv",
  };
  const f = fallbackCommandFor(c, "huggingface-hub");
  assert.match(
    f?.command ?? "",
    /^"\/Users\/someone\/Library\/Application Support\/venv\/bin\/pip" /,
  );
});

test("brew fallbacks emit the right flag for the right kind", () => {
  const formula = copy("/opt/homebrew/bin/rg", "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg");
  const cask = copy(
    "/opt/homebrew/bin/claude",
    "/opt/homebrew/Caskroom/claude-code/2.1.274/claude",
  );
  assert.equal(fallbackCommandFor(formula)?.command, "brew upgrade ripgrep");
  assert.equal(fallbackCommandFor(cask)?.command, "brew upgrade --cask claude-code");
});

test("no command is invented for a system binary or an unattributed one", () => {
  assert.equal(fallbackCommandFor(copy("/usr/bin/git", "/usr/bin/git")), null);
  assert.equal(fallbackCommandFor(copy("/usr/local/bin/x", "/usr/local/bin/x")), null);
  // go install needs the module path, which a binary's path never carries — so it says nothing
  // rather than guessing a plausible one.
  assert.equal(fallbackCommandFor(copy(`${HOME}/go/bin/gopls`, `${HOME}/go/bin/gopls`)), null);
});

/* --------------------------------- labels --------------------------------- */

test("every owner has a distinct human label, so two channels never read as one", () => {
  const owners = [
    "brew-formula",
    "brew-cask",
    "npm-global",
    "pnpm-global",
    "pipx",
    "python-venv",
    "cargo",
    "go",
    "native-installer",
    "app-bundle",
    "system",
    "unknown",
  ] as const;
  const labels = owners.map(ownerLabel);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(ownerLabel("brew-formula"), "Homebrew formula");
  assert.equal(ownerLabel("brew-cask"), "Homebrew cask");
});
