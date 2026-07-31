# Prometheus (via MCP)

This extension exposes the **Prometheus** AI-agent plugin scanner/installer as MCP
tools. Prometheus detects which AI agent CLIs are installed on the machine and
installs, audits, enables, or removes plugins/skills/MCP servers in each — every
install passing through the **nemesis** security gate.

## Available tools (prefix `prometheus_`)
- `prometheus_scan` / `prometheus_superscan` — detect agents + full inventory
- `prometheus_list` / `prometheus_info` / `prometheus_where` / `prometheus_matrix` — browse the catalog
- `prometheus_status` / `prometheus_skills_list` / `prometheus_vault_status` — state
- `prometheus_audit` — static security audit (no install)
- `prometheus_install` / `prometheus_uninstall` — change state (always preview with `dryRun:true` first)
- `prometheus_enable` / `prometheus_disable` — toggle without removing

## Safety
`prometheus_install` runs the nemesis gate before installing; a blocked plugin
returns a `blocked` event and is **not** installed. Prefer `dryRun:true` and only
set `yes:true` after the user has reviewed any findings.
