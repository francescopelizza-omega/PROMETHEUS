---
"@prometheus/cli": minor
"@prometheus/core": minor
"@prometheus/engine-bridge": minor
"@prometheus/ui": minor
"prometheus-vscode": minor
---

Privileged commands and `/disk-space`.

- **New principle: Prometheus may run sudo, but never on its own authority.** Every privileged
  command is shown to you verbatim and runs only after you approve that exact command, every
  time. No authorization level (A7 included), flag, grant, setting, agent or tool can
  pre-approve, remember or skip it. One module (`privileged-gate.ts`) is the only path to root;
  `run_command` refuses privileged commands — including `pkexec`/`run0`, which A6/A7 used to
  auto-approve as unknown programs — and a remembered grant can no longer answer for one.
  Approve once / Deny (Deny by default, a timeout denies, a catastrophic command needs its target
  typed), approval bound to argv + folder + script hash, the password via the TTY or a native
  dialog straight to sudo, audit in `~/.prometheus/audit/sudo.log`. TUI, `--plain`, Studio and
  VS Code ask; MCP and headless runs return the command instead. Studio's unused unsandboxed
  `ide:exec` channel is removed.
- **`/disk-space`**: the full disk_space.py explorer over the TUI (Ctrl+] minimise/resume
  without stopping it, Ctrl+D quit), `map` / `levels` / `files` / `mounts`, a plan-first
  delete keeping every protection, Linux `cleanup`, and `--sudo` for a root rescan you approve.
  `prometheus disk-space …` one-shot, a Studio Disk space panel (treemap, pie, levels), and a
  read-only `prometheus_disk_space` MCP tool. New validated `--chart-*` design tokens.
