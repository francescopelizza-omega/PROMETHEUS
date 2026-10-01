// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/exec-gate.ts — re-export of the SHARED host implementation (Phase 6).
 *
 * The module moved to `@prometheus/core/agent-system-host` so Studio runs the same code
 * rather than its own shell-based executor. This shim keeps the CLI's import sites — and
 * their tests — pointing at a stable path.
 */
export * from "@prometheus/core/agent-system-host";
