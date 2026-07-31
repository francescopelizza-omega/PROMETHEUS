# Prometheus MCP tools

> Generated from `src/tools.ts` by `npm run docs` — do not edit by hand.

**25** tools exposed to MCP clients.

## `prometheus_scan`

Detect which AI agent CLIs (Claude Code, Codex, Cursor, Gemini, Windsurf, Zed, Continue, Copilot, …) are installed on this machine. Returns each agent with present/absent and where it was found.

- **destructive:** no
- **params:** none

## `prometheus_superscan`

Deep inventory of every known agent: present/forgotten state, binary + version, config dir, staleness, and per-agent counts of installed plugins/skills/MCP/extensions/rules/commands, plus host prerequisite tools.

- **destructive:** no
- **params:** none

## `prometheus_list`

The full Prometheus plugin catalog with per-agent install state. Each entry has tier, summary, repo, scope (claude-only/universal) and a targets map.

- **destructive:** no
- **params:** none

## `prometheus_info`

Full metadata for one plugin: summary, tier, repo, automation, security note, caveats, install targets and selectable components.

- **destructive:** no
- **params:**
  - `name` — registry plugin name (see prometheus_list)

## `prometheus_where`

Show exactly where a plugin would install (per-agent method + destination path) BEFORE installing it.

- **destructive:** no
- **params:**
  - `name` — registry plugin name

## `prometheus_status`

Install + enable/disable state of a plugin and its components across every targeted agent. Pass 'all' for the whole registry.

- **destructive:** no
- **params:**
  - `name` — registry plugin name, or 'all'

## `prometheus_audit`

Static security audit of a plugin's install artifacts (no install): the built-in regex scan PLUS the deep nemesis gate verdict per remote source. Returns active findings, downgraded count and a worst verdict. Use 'all' to audit the whole registry.

- **destructive:** no
- **params:**
  - `name` — registry plugin name, or 'all'

## `prometheus_matrix`

Which plugin can go into which agent: native, via-sync, or unavailable, for every registry plugin.

- **destructive:** no
- **params:** none

## `prometheus_skills_list`

List installed SKILL.md folders (~/.claude/skills) with their enabled/disabled/muted state.

- **destructive:** no
- **params:** none

## `prometheus_vault_status`

Status of the offline Repo Vault: known repos and which versions are stored locally. (invoke/rollback are interactive and not exposed here.)

- **destructive:** no
- **params:** none

## `prometheus_install`

Install a registry plugin (or 'all' / 'official-bundle') into every detected target agent. nemesis seeds/refreshes its malware DB and scans the code FIRST — a DANGEROUS (block-verdict) plugin is reported as a 'blocked' event and NOT installed. ALWAYS preview with dryRun:true first; set yes:true only when the user approved non-critical findings. To install code nemesis flagged as DANGEROUS, the user must explicitly approve it — set force:true (equivalent to `/prometheus --force`); the result then carries a `forced_danger` block and ok:false.

- **destructive:** yes
- **params:**
  - `name` — registry plugin name, 'all', or 'official-bundle'
  - `only` — component selection, e.g. a sub-plugin id
  - `dryRun` — preview without changing anything (default true)
  - `yes` — auto-approve non-critical gate findings
  - `strict` — block on medium-or-higher findings too
  - `force` — DANGER: override a nemesis BLOCK and install code flagged as malicious/unsafe. Only set when the user has explicitly accepted the risk for THIS source.

## `prometheus_uninstall`

Remove a registry plugin (or 'all' / 'official-bundle') from every detected agent. Preview with dryRun:true first. Foreign (non-registry) ids are not removable through this tool.

- **destructive:** yes
- **params:**
  - `name` — registry plugin name, 'all', or 'official-bundle'
  - `only` — component selection
  - `dryRun` — preview without changing anything (default true)
  - `yes` — confirm the removal — REQUIRED for a real (non-dry-run) uninstall, since the engine is non-interactive here and otherwise declines

## `prometheus_enable`

Re-arm a disabled plugin or component (reversible).

- **destructive:** no
- **params:**
  - `name` — registry plugin name (optionally name:selection)
  - `component` — toggle the plugin's on-disk hooks or MCP servers

## `prometheus_disable`

Turn off a plugin or component WITHOUT uninstalling it (reversible).

- **destructive:** no
- **params:**
  - `name` — registry plugin name (optionally name:selection)
  - `component` — toggle the plugin's on-disk hooks or MCP servers

## `prometheus_describe`

Rich card for any catalog id (plugin / model-tool / app / open-model / documented): what it is, where it installs, how, its security note, and the exact install & remove commands. Omit the id for the whole catalog index.

- **destructive:** no
- **params:**
  - `id` — catalog id (see prometheus_list / prometheus_models)

## `prometheus_tutorial`

Print the deep tutorial (dossier) for a catalog id — the 'Learn more' surface.

- **destructive:** no
- **params:**
  - `id` — catalog id

## `prometheus_methods`

List every install method documented for a catalog id.

- **destructive:** no
- **params:**
  - `id` — catalog id

## `prometheus_doctor`

Check the host OS, detected agents, git, and resolved paths.

- **destructive:** no
- **params:** none

## `prometheus_inventory`

Re-scan every detected agent for ALL installed plugins/skills/MCP (managed AND foreign). Optionally restrict to specific detected agents.

- **destructive:** no
- **params:**
  - `host` — restrict to these detected agents (e.g. ['claude','gemini'])

## `prometheus_models`

3rd functionality — the local/cloud model-running tools (AirLLM, FlashAttention, …): list the catalog, show install status/versions, browse, or show the config folder. Read-only subactions only; installs/updates go through the gated engine directly.

- **destructive:** no
- **params:**
  - `action` — which read view (config = show the default models folder)
  - `tool` — tool id (airllm|flashattention|…) for status/versions

## `prometheus_apps`

4th functionality — self-hosted apps & repos (yt-dlp, ollama, n8n, penpot, …): list the catalog, show installed apps, status, versions, or logs. Read-only subactions only.

- **destructive:** no
- **params:**
  - `action` — which read view
  - `tool` — app id (see the list action)

## `prometheus_worldsim`

8th functionality — agent-based world-simulation engines (MiroFish, …): list the catalog, show installed engines, status, versions, or logs. Read-only subactions only.

- **destructive:** no
- **params:**
  - `action` — which read view
  - `tool` — engine id (see the list action)

## `prometheus_secure`

Scan any file / archive / folder / git URL / owner-repo for threats with the nemesis engine and report the verdict. A READ-only scan (nothing is modified). Use full:true to scan the whole home directory (slow).

- **destructive:** no
- **params:**
  - `target` — file, archive, folder, git URL, or owner/repo (omit with full:true)
  - `full` — scan the entire home directory (slow)

## `prometheus_harden`

Defensive, localhost-only, read-only self-audit of THIS machine (firewall/ports/ssh/encryption/secret perms) with hardening steps. Advisory — it changes nothing.

- **destructive:** no
- **params:** none

## `prometheus_sync`

Replicate an installed SKILL.md into OTHER agents (cross-CLI portability). This WRITES files into other agents' config dirs, so it requires an explicit confirm:true — without it the engine is never invoked.

- **destructive:** yes
- **params:**
  - `skill` — skill folder name in ~/.claude/skills/
  - `to` — target agents (comma-sep) or 'all' (default: all with a skills dir)
  - `confirm` — REQUIRED — sync writes into other agents; set true only with the user's OK
