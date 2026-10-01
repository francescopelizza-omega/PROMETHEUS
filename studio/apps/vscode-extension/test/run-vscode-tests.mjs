// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * test/run-vscode-tests.mjs — the HOST side of the integration run.
 *
 * Runs on plain Node. `@vscode/test-electron` downloads a pinned, throwaway VS Code build into
 * `.vscode-test/` (first run only — it is cached afterwards) and launches it with this package
 * as the extension under test and `out/test/suite/index.cjs` as the test entry point. That is
 * why these tests are runnable on a machine with NO VS Code installed: the harness brings its
 * own, and it never touches the user's real VS Code install, settings or extensions.
 *
 * The suite gets a FRESH temp workspace folder each run. Using a checked-in fixture directory
 * would mean the tests (which create, edit, move and delete files) leave the repo dirty and
 * fail differently on a second run.
 */
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = dirname(here);
const extensionTestsPath = join(extensionDevelopmentPath, "out", "test", "suite", "index.cjs");

const workspace = mkdtempSync(join(tmpdir(), "prometheus-vscode-test-"));
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "README.md"), "# fixture workspace\n");
writeFileSync(join(workspace, "src", "index.ts"), "export const hello = 'world';\n");

/**
 * The isolated profile directory — deliberately on a SHORT path.
 *
 * VS Code opens a unix domain socket inside `--user-data-dir`, and the OS caps a socket path at
 * 103 characters. macOS's `os.tmpdir()` is already ~51 of them
 * (`/var/folders/rn/zw5cc…/T/`), so a profile nested under the temp workspace overflows the cap
 * and VS Code dies at startup with `EINVAL` before a single test runs. `/tmp` keeps the whole
 * path near 30 characters. The profile MUST still be isolated — without `--user-data-dir` at
 * all, the run would use (and pollute) the developer's real VS Code profile.
 */
const userDataDir = join(process.platform === "win32" ? tmpdir() : "/tmp", `pvsc-${process.pid}`);
mkdirSync(userDataDir, { recursive: true });

/**
 * Resolve the downloaded VS Code executable, working around a real version skew.
 *
 * `@vscode/test-electron` 2.5.x hard-codes the macOS binary as
 * `Visual Studio Code.app/Contents/MacOS/Electron`. Current VS Code (1.133) ships that binary
 * as `MacOS/Code` instead, so the launch fails with ENOENT even though the 300MB download and
 * extraction both succeeded perfectly. Rather than pin an old VS Code to match the helper's
 * assumption, probe the app bundle for whatever executable is actually there — which also keeps
 * this working when the name changes back.
 */
function resolveExecutable(reported) {
  if (existsSync(reported)) return reported;
  const macosDir = dirname(reported);
  if (!existsSync(macosDir)) return reported;
  const candidates = readdirSync(macosDir);
  // "Code" (stable), "Electron" (older/OSS), "Code - Insiders" — take the first that exists.
  const found = ["Code", "Electron", "Code - Insiders"].find((n) => candidates.includes(n));
  if (!found) {
    throw new Error(
      `no VS Code executable found in ${macosDir} (saw: ${candidates.join(", ") || "nothing"})`,
    );
  }
  console.log(`resolved VS Code executable: ${found} (helper expected ${basenameOf(reported)})`);
  return join(macosDir, found);
}

function basenameOf(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

try {
  const vscodeExecutablePath = resolveExecutable(await downloadAndUnzipVSCode());
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      // A clean, isolated profile. Without these the run inherits the developer's real
      // extensions and settings, which is both slow and a source of "works on my machine".
      "--disable-extensions",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-workspace-trust",
      `--user-data-dir=${userDataDir}`,
    ],
  });
  console.log("\nintegration tests: PASS");
} catch (err) {
  console.error("\nintegration tests: FAIL");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}
