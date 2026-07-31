# prometheus_plugin

Run **Prometheus** — the AI-agent plugin scanner/installer (with the nemesis
security gate) — from *inside* every major AI agent CLI, plus a standalone
terminal GUI.

`prometheus.py` already installs plugins *into* Claude/Codex/Cursor/Gemini/….
This package is the inverse: it lets those agents (and you, in a TUI) **drive**
Prometheus — detect installed agents, browse the catalog, audit a plugin's
security verdict, and install/remove plugins — through one MCP server.

```
prometheus_plugin/
  mcp-server/   @prometheus-plugin/mcp        one stdio MCP server → bridges to prometheus.py --json
  tui/          @prometheus-plugin/tui        Ink terminal GUI (npx prometheus-tui)
  installer/    @prometheus-plugin/installer  detect agents → register the MCP server in each
  adapters/     per-CLI native manifests (Claude/Gemini/Cursor/Codex/Windsurf/Cline/Zed/generic)
  docs/         the master build spec + raw research
```

## How it fits together

```
 AI agent CLI ──(MCP stdio)──▶ @prometheus-plugin/mcp ──(subprocess)──▶ python prometheus.py --json
   (Claude, Codex,                14 tools                              (scan/list/audit/install/…)
    Cursor, Gemini,                                                     emits ONE JSON object/cmd
    Windsurf, Zed, …)                                                   nemesis gate rides along
```

The MCP server adds a `--json` machine-output layer contract: every prometheus
command prints exactly one JSON object on stdout (human logs go to stderr). The
TUI talks to the same `--json` surface directly.

## Requirements
- **Python 3** with `prometheus.py` present (set `PROMETHEUS_PY` to its absolute path).
- **Node ≥ 18**. `npx` only needed for `--mode npx` (after the packages are published).

## Launch modes (how the agent starts the server)

| mode | the agent runs | works… | needs |
|------|----------------|--------|-------|
| **`local`** (default) | `node <abs>/mcp-server/dist/server.js` | **today** | the repo cloned + built |
| `npx` | `npx -y @prometheus-plugin/mcp` | after publish | the 3 packages published to npm |

The packages are **not yet on npm**, so `npx -y @prometheus-plugin/mcp` would 404.
Local mode sidesteps that entirely by pointing each agent at the built server on
disk — it is the works-out-of-the-box path. Switch with `--mode`.

To publish later: `cd <pkg> && npm publish --access public` for each of mcp-server,
tui, installer (they carry `publishConfig.access=public` + a `prepublishOnly` build);
then `--mode npx` and the static `adapters/` manifests work on any machine.

## Install the plugin into your agents

One command registers the MCP server into every detected agent (merge-safe — it
never clobbers your other MCP servers):

```bash
# build the server the agents will launch (local mode), then build the installer
cd prometheus_plugin/mcp-server && npm install && npm run build
cd ../installer            && npm install && npm run build

PROMETHEUS_PY=/abs/path/to/prometheus.py node dist/cli.js          # all detected agents (local mode)
node dist/cli.js --list           # show which agents are detected
node dist/cli.js --dry-run        # preview the plan, write nothing
node dist/cli.js --agent claude   # just one agent
node dist/cli.js --mode npx       # wire the npx launcher instead (post-publish)
node dist/cli.js --server /abs/dist/server.js   # explicit built-server path
```

In local mode the installer refuses to write if the built `server.js` is missing
(the #1 "installed but nothing starts" trap) and tells you to build it first.

## Verify & repair (health check after a repo move)

Registrations point at an absolute `server.js` / `prometheus.py`. **Move the repo and
they go stale** — the agent silently launches nothing. `verify` checks each detected
agent's registration and the paths it points at; `repair` rewrites the fixable ones.

```bash
node dist/cli.js verify              # per-agent: reg present? · path OK/MISSING/DRIFTED · boot smoke
node dist/cli.js verify --json       # same, machine-readable
node dist/cli.js verify --no-smoke   # skip the MCP boot smoke (faster)
node dist/cli.js repair              # rewrite stale/absent registrations (asks to confirm first)
node dist/cli.js repair --yes        # non-interactive (CI)
```

`verify` **never writes** and exits `1` when anything is wrong (scriptable). Each row is
`reg:✓/○ · path:✓/✗missing/⚠drifted · boot:✓/✗`. The boot smoke spawns the registered
server and sends a single `initialize` over stdio (5s timeout) — the server also answers
`node dist/server.js --selftest` (exits 0, no engine roundtrip) for CI.

**After moving the repo** (e.g. `ALPHA/AI` → `ALPHA/PROMETHEUS`): `verify` flags every
registration `MISSING`/`DRIFTED`; `repair` rewrites them to the current build in one pass.
Claude is checked/repaired through its own `claude mcp` store, not by editing `~/.claude.json`.

Or hand-install from `adapters/<cli>/` (each file is a ready manifest/snippet —
they use the `npx` launcher, so they apply **after** publishing, or edit the
`command`/`args` to `node <abs>/dist/server.js` for local mode).
Per-CLI notes:

| Agent | Config written | After install |
|-------|----------------|---------------|
| Claude Code | `~/.claude.json` (`mcpServers`) — *not* settings.json | `/mcp` → approve `prometheus` |
| Cursor | `~/.cursor/mcp.json` | Settings → MCP → enable |
| Codex CLI | `~/.codex/config.toml` `[mcp_servers.prometheus]` | `codex mcp list` |
| Gemini CLI | `~/.gemini/extensions/prometheus/` | restart; auto-loads |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | refresh MCP |
| Zed | `~/.config/zed/settings.json` `context_servers` (`source:custom`) | restart |
| Continue | `~/.continue/config.yaml` (`mcpServers` list) | Agent mode only |
| anything else | `adapters/generic-mcp/mcpServers.json` | paste into its MCP config |

## The 14 MCP tools

Read-only: `prometheus_scan`, `prometheus_superscan`, `prometheus_list`,
`prometheus_info`, `prometheus_where`, `prometheus_status`, `prometheus_audit`,
`prometheus_matrix`, `prometheus_skills_list`, `prometheus_vault_status`.
State-changing: `prometheus_install`, `prometheus_uninstall`, `prometheus_enable`,
`prometheus_disable`.

`prometheus_install` runs the nemesis gate first; a blocked plugin returns a
`blocked` event and is **not** installed. It defaults to `dryRun:true` — set
`yes:true` only after a human approves the findings.

## The terminal GUI

```bash
cd prometheus_plugin/tui && npm install && npm run build
PROMETHEUS_PY=/abs/path/to/prometheus.py node dist/cli.js     # (after publish: npx prometheus-tui)
```

Menu-driven: scan agents, browse the catalog, dry-run installs, security-audit a
plugin (with the nemesis verdict), reach matrix, skills, vault. `↑/↓` select ·
`enter` open · `esc` menu · `q` quit.

## Gotchas baked in
- MCP SDK **v1.x** (not the v2 pre-alpha). Tool input schemas are raw zod shapes.
- **stdout is JSON-RPC** for the server / one JSON object for the engine — all
  logs go to stderr.
- prometheus global flags (`--json`, `--dry-run`) come **before** the subcommand.
- Claude `mcp add` needs the `--` separator; Codex uses `[mcp_servers.*]` TOML;
  Zed needs `"source":"custom"`; Continue's `mcpServers` is a YAML **list**.
- The installer merge-writes — re-running only replaces the `prometheus` entry.

## License
MIT — see `LICENSE`.
