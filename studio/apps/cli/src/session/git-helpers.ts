// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/git-helpers.ts — thin re-export shim (desktop parity, Task #5).
 *
 * The dependency-injected git wrappers for `/worktree` (CLI-054) moved to
 * `@prometheus/core`'s `git/worktree.ts` so the desktop app's worktree command/panel can call
 * the EXACT SAME functions instead of a reimplementation of the trust rules (option-injection
 * guard, never `--force`, never throws, the read-only-pane allowlist). Every existing import
 * site in this package (`host.ts`, `slash-registry.ts`, `session-bridge.ts`) and
 * `git-helpers.test.ts` keeps working unchanged because the exported names are identical.
 */
export * from "@prometheus/core/git-worktree";
