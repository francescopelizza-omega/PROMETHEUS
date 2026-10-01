// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/probe.ts — a thin re-export of the shared probe seams.
 *
 * The implementation moved to `packages/core/src/updates-live/probe.ts` so the desktop main
 * process could reach it: Studio previously had NO update surface beyond Electron's own
 * auto-updater, because every line of this logic lived inside `apps/cli`. Duplicating it in the
 * desktop would have recreated the defect this whole area exists to remove — two PATH resolvers
 * that disagree about the same machine.
 *
 * This file stays so the CLI's own call sites (`session/run-notify.ts` uses `which`) keep
 * working, and so a future reader looking for the probe in the obvious place finds the pointer.
 */
export {
  which,
  cliVersion,
  detectInstallMethod,
  engineVersion,
} from "@prometheus/core/updates-live";
