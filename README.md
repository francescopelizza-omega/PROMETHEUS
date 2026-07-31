# PROMETHEUS

An AI-native development environment: an agentic coding **Studio** (desktop IDE),
a terminal-first **`prom` CLI/TUI**, and a cross-agent **plugin** that exposes
PROMETHEUS's capabilities to other AI CLIs over MCP.

## What's inside

| Path | What it is |
|------|-----------|
| `studio/` | Monorepo for the Studio desktop app (Electron) + the `prom` CLI/TUI. Core agent loop, edit-apply engine, syntax highlighting, permission modes. |
| `prometheus_plugin/` | MCP server + TUI installer that wire PROMETHEUS into other AI agents (Claude, Codex, Cline, Continue, Windsurf, Zed, …). |
| `nemesis` | Security scanner with fail-closed gating and secret-pattern detection. |
| `MDS/` | Design specs and the build backlog that drive the app. |

## The edit-apply wrapper

The layer that turns model chat output into safe on-disk edits is **deterministic-first
and fail-closed**: an ordered fallback ladder (exact → trailing-whitespace → indent →
blank-skip → anchor) that is unique-or-ambiguous at every rung, byte-preserves untouched
regions (CRLF/BOM/trailing-newline), verifies bracket balance before writing, and refuses
with a structured retry hint rather than guessing. A permission spectrum runs from
ask-for-everything through bypass to a run-to-done **YOLO** mode — where autonomy never
overrides the security gate.

## Status

Active development. APIs and layout may change.

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 Francesco Pelizza. See [NOTICE](./NOTICE).
