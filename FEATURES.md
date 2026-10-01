# PROMETHEUS Features — AI Development Platform with Supply Chain Security

**Keywords:** AI agent, code security, plugin management, supply-chain security, development platform, AI CLI, desktop IDE, security scanning, malware detection

## 🛡️ Security & Supply Chain

- **Fail-closed security gate** — Every fetched code is scanned before execution. Block dangerous code, warn on risky patterns, allow safe installations.
- **Nemesis supply-chain scanner** — Detects pipe-to-shell droppers, reverse shells, crypto miners, obfuscated payloads, persistence hooks, credential theft, and archive threats.
- **HMAC-signed verdicts** — Tamper-evident security decisions stored in append-only audit log.
- **Reversible remediation** — Dry-run by default, undo any action with one command.
- **Machine posture audit** — Read-only security assessment of firewall, SSH, disk encryption, and open ports.
- **Secret scanning** — Full-history gitleaks integration with allowlisting, personal-data detection, and orphan-file scanning.

---

## 🤖 AI Agent Loop — Works with Any Model

- **Local-first computing** — Run full coding agents offline with Ollama or LM Studio. No cloud account, no API key, no data leaving your machine.
- **Multi-provider support** — Claude, ChatGPT, Gemini, GitHub Copilot, DeepSeek, Groq, and OpenAI-compatible endpoints.
- **Native tool-calling** — Real tool-calling protocol support for Anthropic, OpenAI, and Gemini with automatic text-protocol fallback.
- **Reasoning-effort dial** — Configure thinking depth: off, low, medium, high, xhigh, ultra, max — per provider and model.
- **Authorization ladder** — A0–A7 autonomy levels: from "ask before everything" to fully autonomous, still gated by security.
- **Permission modes** — Read-only, accept-edits, plan-only, and full-bypass modes for flexible agent workflows.
- **Lifecycle hooks** — PreToolUse hooks block dangerous operations; PostToolUse sends notifications; SessionStart injects context.
- **Sub-agent delegation** — Fan-out parallel research or analysis; child agents return only final answers, keeping intermediate work clean.

---

## 🧰 49 Powerful Tools

**File & Code Operations**
- Read files, list directories, glob patterns, semantic search, grep with context
- Deterministic code patching with exact-match + fallback ladder
- Apply diffs, delete files (undoable), move files, create directories

**Execution & Sandboxing**
- Run shell commands under OS-level confinement (Seatbelt on macOS, bubblewrap on Linux)
- Job management: status, output, kill long-running tasks
- Propose elevated commands (agent never escalates itself)

**Web & Network**
- Web fetch through SSRF-proof fail-closed proxy
- Web search integration
- Sandboxed browser tools (isolated from your session)

**Code Analysis**
- Git: status, diff, log, show, annotate
- System inspection: GPU info, process list, environment, package list
- Semantic file search across codebases
- Call graph and refactor analysis

**Memory & Persistence**
- Cross-session memory — leave yourself notes that survive a restart
- Project-scoped memory per repository
- Task list management within a session

**Delegation**
- Spawn parallel sub-agents with resource guards
- Ask the human mid-turn for clarification
- Fan-out orchestration with synchronization

---

## 🖥️ Multiple Surfaces — One Engine

All powered by the same agent loop in `studio/packages/core`:

**Studio Desktop IDE** (Hardened Electron)
- Monaco editor with file tree, outline, breadcrumbs, merge/blame views
- Integrated LSP + DAP debugging for Python, TypeScript, JavaScript, Rust, Go, etc.
- Real PTY terminals with profiles and venv activation
- Jupyter notebook editing with kernel sidecar
- Database explorer and SQL console
- CPU profiler with flame graph view
- Security console: gate verdicts, trust ledger, threat database
- AI chat rail driving the real agent loop

**`prometheus` CLI / TUI** (Terminal-first)
- Interactive full-screen TUI with autocomplete and markdown rendering
- 140+ slash commands: `/scan`, `/model`, `/budget`, `/sessions`, `/orchestrate`, etc.
- 67 CLI subcommands for headless automation
- Shell completion for bash/zsh/fish
- Man page generation
- Headless mode: `prometheus -p "<prompt>"` for one-shot operations
- tmux integration with auto-scaled sub-agent swarms

**MCP Plugin Server** (Integrate with Claude Code, Cursor, Gemini, etc.)
- 14 read + 5 write tools exposed via Model Context Protocol
- Works with Claude Code, Codex, Gemini CLI, Cursor, Windsurf, Zed, Continue, Cline
- Full nemesis gating on all installs
- Reads from the same JSON API as Studio and CLI

**VS Code Extension** (Sidebar Chat Panel)
- Drives the real core agent loop
- Full feature parity with Studio
- AI chat + inline editing in your existing editor

---

## 📦 Catalog & Plugins

- **Agent inventory** — Detect installed AI CLIs and IDEs, deep census, reach matrix
- **Gated install** — Browse plugins, preview exactly what lands where
- **Skills** — Enable, disable, mute auto-firing skill packs
- **Self-hosted apps** — Install yt-dlp, ollama, n8n, penpot, bitwarden, etc.
- **Pentest sandbox** — Authorized security tools in airgapped, rules-gated sandbox
- **World simulation** — Agent-based simulators via docker-compose

---

## 🧠 Model & Compute Management

- **RAM admission** — Real KV-cache arithmetic: refuses models that won't fit, explains why
- **Model Hub** — Score models against your hardware, pull through gate, manage runtimes
- **Local runtimes** — Ollama and LM Studio first-class; llama.cpp and vLLM as targets
- **Hugging Face import** — Convert and install models with one command
- **Remote compute** — SSH or LAN GPU boxes with feasibility assessment for offloading
- **Model health ledger** — Tracks native vs. text-protocol, context window served, failures

---

## 💸 Cost & Budget Control

- **Spend ceiling** — Real enforced cap on daily/session spend with warning thresholds
- **Token economy** — Per-turn cost estimate with model-aware pricing
- **Context breakdown** — See what's eating your token window by component
- **Repo map** — Budgeted file+symbol extraction to avoid repeated grepping
- **Token-saving techniques** — Registry of prompt caching, terse output, local RAG

---

## 🗂️ Repository Management

- **Managed repos** — Fetch from arbitrary URLs, all staged and gated before adoption
- **Offline vault** — Versioned ZIP archive of every repo with instant rollback
- **Environment manager** — Create, clone, export, import venv/conda/system environments
- **Test runner** — Discover and run tests with JUnit output, retry-failed, flaky tolerance, coverage
- **Diagrams** — Read-only AST to Mermaid or Graphviz (UML, dependencies)
- **Meet your codebase** — Human-friendly orientation to unknown repos
- **Metadata privacy** — Inspect and scrub file metadata

---

## 🌍 Internationalization

8 languages with per-key English fallback:
- English, Italian, French, Spanish, German, Portuguese, Dutch, Polish

---

## 📊 Session & Memory

- **Persistent sessions** — List, search, fork, and resume any prior conversation
- **Project memory** — Cross-session notes and context per repo
- **Honors existing files** — Respects CLAUDE.md, AGENTS.md, PROMETHEUS.md
- **File history** — Git-independent snapshot timeline with diff and revert
- **Export conversations** — JSON or markdown for documentation or sharing

---

## ⚙️ The Engine

- **One file, zero dependencies** — `prometheus.py` is 868 KB, pure Python stdlib
- **38 subcommands** — Complete operator interface
- **Machine contract** — Every command outputs exactly one JSON object on stdout
- **Engine bridge** — Only JS package allowed to spawn Python or nemesis

---

## 🔐 Prompt Injection Defense

- **Structural framing** — All untrusted data wrapped in explicit markers
- **Pattern scanning** — Lightweight heuristic detector for override/exfiltration attempts
- **Canary tripwire** — Random never-to-repeat token planted in context; leakage signals bypass
- **Workspace hooks trust** — Cloned repos can't introduce new commands, only narrow existing ones
- **MCP tool-descriptor pinning** — Hard-block if any server redefines itself after approval

---

## ✅ What's Shipped & Working Today

- ✅ All 49 tools fully functional
- ✅ Studio desktop IDE (Electron 44, hardened)
- ✅ `prometheus` CLI/TUI with 140+ commands
- ✅ MCP server for external agents
- ✅ VS Code extension
- ✅ Local model support (Ollama, LM Studio)
- ✅ Full security gate and audit logging
- ✅ Playground with sub-agents and orchestration

---

**Install in one command:**
```bash
curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
```

**Read the full documentation:** [README.md](README.md)
