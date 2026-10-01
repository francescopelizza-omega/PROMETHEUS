// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * repl/run.ts — launch the interactive Ink REPL (file 11 §3).
 *
 * EXCLUDED from the tsc build (ink/react are packaging-time deps). bin.ts loads this
 * via a non-literal dynamic import and falls back to one-shot help when ink is absent.
 * The semantic brain (slash/tuning/state/footer) is @prometheus/core/repl — this file
 * is only the node-side render glue.
 */
import { render } from "ink";
import { createElement } from "react";

import type { ParsedArgs } from "../parse.js";
import { App } from "./App.js";

export async function runRepl(parsed: ParsedArgs): Promise<void> {
  const instance = render(createElement(App, { parsed }));
  await instance.waitUntilExit();
}
