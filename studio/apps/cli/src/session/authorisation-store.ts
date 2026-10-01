// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/authorisation-store.ts — the CLI's view of the ONE saved authorisation level.
 *
 * The implementation moved to `@prometheus/core`'s `cliProfiles` barrel so the desktop's main
 * process and the VS Code extension read and write the SAME file: the level was previously the
 * CLI's alone, with the GUI keeping a private copy in renderer localStorage and VS Code a third
 * on a ladder that did not even have the same range. This module stays as the CLI's import point
 * (every host file already reaches for it by this path) and adds nothing of its own — a second
 * implementation is exactly what it exists to prevent.
 *
 * WHAT MAY WRITE: only an explicit numbered choice — see `AuthLevelOrigin` in `slash-registry.ts`.
 */
import { cliProfiles } from "@prometheus/core";

export const readSavedAuthLevel = cliProfiles.readSavedAuthLevel;
export const saveAuthLevel = cliProfiles.saveAuthLevel;
