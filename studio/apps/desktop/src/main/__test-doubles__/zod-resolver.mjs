// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { dirname, resolve as resolvePath } from "node:path";
/**
 * __test-doubles__/zod-resolver.mjs — an ESM resolver hook that maps the bare
 * specifier `zod` to the local test-double (./zod.mjs) for node:test runs.
 *
 * main/validate.ts imports the REAL `zod` (a runtime dep used only in the
 * privileged main process at the IPC seam). The decoupled node:test runner has
 * no installed app-level node_modules and no bundler, so `zod` is unresolvable
 * there. validate.test.ts registers this hook BEFORE importing validate.ts, so
 * validate.ts's real schema code executes against the faithful minimal double in
 * zod.mjs. Production resolves the real zod via electron-vite — this hook is a
 * TEST artefact, scoped entirely under apps/desktop/src/.
 *
 * It chains to the workspace dev-resolver for everything else (the .js→.ts
 * rewrite + @prometheus/* mapping), so the test file's own relative imports and
 * any engine-bridge/core specifiers still resolve.
 */
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ZOD_DOUBLE = pathToFileURL(resolvePath(HERE, "zod.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "zod") {
    return { url: ZOD_DOUBLE, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
