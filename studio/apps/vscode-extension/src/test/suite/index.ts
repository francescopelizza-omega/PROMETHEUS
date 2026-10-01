// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * index.ts — the module `@vscode/test-electron` loads as `--extensionTestsPath`.
 *
 * The contract is exactly this: export `run()`, resolve on success, REJECT on failure. VS Code
 * exits non-zero when it rejects, which is what turns a failing assertion into a failing
 * command in the terminal.
 */

import { runAll } from "./harness.js";

// Imported for side effect: each spec module registers its cases with the harness at import
// time. Listed explicitly rather than globbed because esbuild bundles this file statically and
// a runtime glob would resolve to nothing inside the bundle.
import "./extension.spec.js";

export async function run(): Promise<void> {
  await runAll();
}
