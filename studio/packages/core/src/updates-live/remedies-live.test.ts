/**
 * remedies-live.test.ts — where a PATH repair may be written, and where it may NOT.
 *
 * The refusals are the point of this module. An rc file is often years of hand-tuning that
 * cannot be regenerated, it frequently holds credentials, and a broken one greets the user with
 * a non-functioning shell on a machine whose recovery path is "open a terminal". So the tests
 * that matter are the ones asserting that nothing was written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { pathBlock, shellInitFor } from "./remedies-live.js";

const HOME = "/Users/someone";
const DIR = `${HOME}/.local/share/npm/bin`;

function deps(files: Record<string, string>, links: string[] = []) {
  return {
    home: HOME,
    env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
    exists: (p: string) => p in files,
    read: (p: string) => files[p] ?? "",
    isSymlink: (p: string) => links.includes(p),
  };
}

test(".zshenv wins, because it is the only file EVERY zsh reads", () => {
  /**
   * `man zsh`: .zshenv runs for every shell, .zprofile only for login shells, .zshrc only for
   * interactive ones. A PATH entry a non-interactive `zsh -c` cannot see is exactly the failure
   * being repaired, so the fix must land where scripts and LaunchAgents will read it too.
   */
  const t = shellInitFor(
    DIR,
    deps({ [`${HOME}/.zshenv`]: "", [`${HOME}/.zshrc`]: "export PATH=/x:$PATH\n" }),
  );
  assert.equal(t.path, `${HOME}/.zshenv`);
  assert.equal(t.refused, undefined);
  assert.equal(t.alreadyPresent, false);
});

test("the block appends and guards itself, so running it twice cannot extend PATH twice", () => {
  const block = pathBlock(DIR);
  assert.match(block, /export PATH="\$PATH:/, "APPEND — prepending would shadow a newer tool");
  assert.ok(!block.includes(`PATH="${DIR}:$PATH"`), "must never prepend");
  assert.match(block, /case ":\$PATH:" in/, "self-guarding, so a second source is a no-op");
  assert.match(block, /# >>> prometheus PATH >>>/, "delimited, so it can be found and replaced");
});

test("a symlinked rc file is REFUSED — it belongs to a dotfiles manager", () => {
  /**
   * Both ways of writing it are wrong: through the link silently edits the user's dotfiles repo,
   * and atomically (temp + rename) replaces the link with a regular file and detaches them from
   * their own dotfiles. So neither is offered.
   */
  const t = shellInitFor(DIR, deps({ [`${HOME}/.zshenv`]: "" }, [`${HOME}/.zshenv`]));
  assert.ok(t.refused, "a symlink must not be written through");
  assert.match(t.refused, /symlink/);
  assert.match(t.refused, /chezmoi|stow|home-manager|dotfiles/);
});

test("a file owned by another tool's generated block is REFUSED", () => {
  /**
   * Measured: `~/.zshrc` carries `# >>> ai-cli-multi manager >>>` … `<<<`, and `~/.zprofile` two
   * such blocks. A tool that regenerates its region reverts anything it swallows — this user's
   * own notes already record losing a hand-applied zsh fix exactly that way.
   */
  const t = shellInitFor(
    DIR,
    deps({
      [`${HOME}/.zprofile`]:
        "# >>> ai-cli-multi manager >>>\nfoo\n# <<< ai-cli-multi manager <<<\n",
    }),
  );
  assert.ok(t.refused, "a generated block means the end of the file is not ours");
  assert.match(t.refused, /generated block/);
});

test("a directory already handled is reported as present, not appended again", () => {
  const t = shellInitFor(DIR, deps({ [`${HOME}/.zshenv`]: `export PATH="$PATH:${DIR}"\n` }));
  assert.equal(t.alreadyPresent, true);
  assert.equal(t.refused, undefined);
});

test("no rc file at all refuses rather than creating one", () => {
  // Creating a .zshenv that did not exist changes the startup behaviour of every future shell,
  // which is a larger act than the problem justifies and one the user never asked for.
  const t = shellInitFor(DIR, deps({}));
  assert.ok(t.refused);
  assert.match(t.refused, /no shell init file/);
});

test("bash gets bash's files, not zsh's", () => {
  const t = shellInitFor(DIR, {
    ...deps({ [`${HOME}/.bash_profile`]: "", [`${HOME}/.zshenv`]: "" }),
    env: { SHELL: "/bin/bash" } as NodeJS.ProcessEnv,
  });
  assert.equal(t.path, `${HOME}/.bash_profile`);
});

test("the returned target never carries the file's contents", () => {
  /**
   * A shell rc file routinely holds exported provider keys, and `~/.npmrc` holds a registry auth
   * token. Echoing a diff of one would put the credential in the terminal, in the session
   * transcript and in any log — so this module returns only the block it would ADD and the path
   * it would add it to, never what is already there.
   *
   * The sentinel below is assembled from fragments on purpose. A literal that LOOKS like a real
   * provider key does not belong in a public repository even as a fixture: every third-party
   * secret scanner that crawls the repo will report it, and each report costs someone the work
   * of proving a non-incident. This repo's own `.gitleaks.toml` makes the same argument for
   * allowlisting BY VALUE rather than by path.
   */
  const sentinel = `NOT${"_A_REAL"}_CREDENTIAL_${"fixture"}`;
  const t = shellInitFor(DIR, deps({ [`${HOME}/.zshenv`]: `export SOME_API_KEY=${sentinel}\n` }));
  assert.ok(!JSON.stringify(t).includes(sentinel), "the file's contents must never be returned");
});
