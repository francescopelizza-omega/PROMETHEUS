// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/exec-screen.ts — re-export of core's layer 6 (full_wrapper_compose Phase 6).
 *
 * The patterns MOVED to `@prometheus/core/agent-exec` so the CLI and Studio screen commands
 * with one list instead of two that drift. This file stays as the import site `ide-ipc.ts`
 * already uses.
 *
 * Note what promoting it did NOT do: `ide:exec` still spawns a real `shell -c <command>`,
 * and a denylist over a shell string cannot hold (`${IFS}sudo`, `$(echo … | base64 -d)`,
 * `eval "$X"` all walk past it). The fix for that is the rest of Phase 6 — Studio dispatching
 * core's `run_command`, which parses and spawns each program directly with no shell at all.
 */
export {
  type CommandScreen,
  MAX_SCREENED_LENGTH,
  screenCommand,
} from "@prometheus/core/agent-exec";
