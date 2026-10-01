// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * dev-register.mjs — register the workspace dev resolver so `node --import
 * ./dev-register.mjs src/bin.ts <cmd>` runs the prometheus CLI straight from TS source
 * (no build, no node_modules). Dev/proof convenience only; production uses the
 * compiled dist/bin.js via the package "bin".
 */
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Silence the cosmetic DEP0205 (`module.register()` deprecation) so the dev session
// banner isn't polluted — this is a dev-only loader convenience, not an app concern.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === "object" && rest[0] ? rest[0].code : rest[1];
  if (code === "DEP0205" || String(warning).includes("module.register()")) return;
  return _emitWarning(warning, ...rest);
};

const HERE = dirname(fileURLToPath(import.meta.url));
register(`file://${resolve(HERE, "dev-resolver.mjs")}`);
