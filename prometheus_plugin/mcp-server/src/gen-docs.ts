// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * gen-docs.ts — regenerate docs/TOOLS.md from the tool table (CLI-035). Run `npm run docs`.
 * Pure over TOOLS via renderToolsDoc, so the reference can never drift by hand.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOLS, renderToolsDoc } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "docs", "TOOLS.md");
writeFileSync(out, renderToolsDoc(TOOLS));
// eslint-disable-next-line no-console
console.log(`wrote ${out} (${TOOLS.length} tools)`);
