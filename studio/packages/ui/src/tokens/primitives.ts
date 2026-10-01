// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * primitives.ts — the raw primitive ramps (file 08 §2.1, 50..950). The CANONICAL
 * source of the hex values is ../tokens.ts (which the ~30 existing consumers import);
 * this module re-exports them under the file-08 `tokens/` structure so primitives and
 * semantic tokens have stable, separately-importable homes.
 */
export { neutral, violet, cyan, green, amber, red, slate, ramps } from "../tokens.js";
export type { Ramp, RampName } from "../tokens.js";
