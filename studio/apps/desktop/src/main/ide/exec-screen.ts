// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/exec-screen.ts — re-export of core's layer 6 (full_wrapper_compose Phase 6).
 *
 * STATUS (verified 2026-11-02): `ide:exec` no longer exists — no IPC channel, no handler, no
 * preload method. Studio runs commands through `agent:systemTool` → core's `run_command`,
 * which parses and spawns each program directly with no shell (main/ide-ipc.ts). Nothing in
 * production imports this file; it remains only as the stable import site its own test pins.
 * Do not reintroduce a `shell -c` executor behind this denylist: a regex over a shell string
 * cannot hold (`${IFS}sudo`, `$(echo … | base64 -d)`, `eval "$X"` all walk past it).
 */
export {
  type CommandScreen,
  MAX_SCREENED_LENGTH,
  screenCommand,
} from "@prometheus/core/agent-exec";
