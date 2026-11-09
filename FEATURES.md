# PROMETHEUS Features — AI Development Platform with Supply Chain Security

**Keywords:** AI agent, code security, plugin management, supply-chain security, development platform, AI CLI, desktop IDE, security scanning, malware detection

## 🛡️ Security & Supply Chain

- **Fail-closed security gate** — Every fetched code is scanned before execution. Block dangerous code, warn on risky patterns, allow safe installations.
- **Nemesis supply-chain scanner** — Detects pipe-to-shell droppers (incl. process substitution, interpreters, multi-pipe chains, backslash-continued and quote/printf/concat-obfuscated forms), reverse shells, crypto miners, obfuscated payloads, persistence hooks, credential theft, and archive threats. Unreadable files, deep-nested archives and impersonated nemesis artifacts are blind spots that block — never silent skips.
- **Model-file scanning** — Pickle opcode analysis (torch `.pt/.pth/.bin/.ckpt`, joblib, object `.npy`) without unpickling; safetensors and GGUF structural validation (bounded headers, exact tensor sizes, no overlaps or trailing payloads); GGUF and `tokenizer_config.json` chat-template injection checks; Keras `Lambda` and torch.package code detection.
- **HMAC-signed verdicts** — Tamper-evident security decisions stored in append-only audit log.
- **Reversible remediation** — Dry-run by default, undo any action with one command.
- **Machine posture audit** — Read-only security assessment of firewall, SSH, disk encryption, and open ports.
- **Privileged commands, one approval at a time** — Prometheus may run sudo, but never on its own authority: each privileged command is shown verbatim and runs only after you approve that exact command, every time, at every level (A7 included). Audited to `~/.prometheus/audit/sudo.log`.
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
- Privileged commands (sudo) through one gate: shown verbatim, run only after you approve that exact command — never auto-approved, never remembered

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
- 141 slash commands: `/scan`, `/model`, `/budget`, `/sessions`, `/orchestrate`, `/disk-space`, etc.
- 73 CLI subcommands for headless automation
- Shell completion for bash/zsh/fish
- Man page generation
- Headless mode: `prometheus run <prompt…>` or `prometheus -p "<prompt>"` — one turn with a model, the answer on stdout, then exit
- tmux integration (optional): named multi-window sessions and a windowed `/demos` swarm; without tmux the same features run in one terminal (compatibility mode), and sub-agents run in-process either way

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
- **Full-screen model browser (`/model`, `/models`)** — In the TUI, `/model` takes the whole terminal, laid out like the disk-space explorer: a RAM gauge for this machine, a breadcrumb, then three panes — layers (serving now · fits this machine · every local model by RAM tier from 2 GB to 2 TB · free cloud · paid cloud · endless free spinner · model servers) │ the models of that layer, two rows each (name left, two description lines, the RAM it needs and the server that will run it) │ details with exactly what Enter will do. `/` searches, `c` filters coding/tools/reasoning/vision, `f` keeps what fits, `s` sorts, `i` zooms the details on a narrow terminal; a pick runs the same prepare-and-switch path as a typed `/models use`, with every consent and gate
- **The right engine for each model, chosen for you** — A model with an Ollama build runs on Ollama; one without goes to LM Studio when it is installed, else llama.cpp (installed from Homebrew); an MLX-only build goes to MLX-LM or LM Studio's MLX engine on Apple Silicon; a split GGUF is linked shard by shard. When a pick needs a different engine than your default server, the default moves to it once the model is ready (and `/server` changes it back) — the terminal and the app share the setting
- **Models that don't fit RAM are refused — unless you insist** — The picker compares each model's RAM need with this machine and refuses what does not fit (a smaller quant is used when only that fits). A too-big row stays visible with the reason; `!` (or `/models use local:<id>@<runtime>`) runs it anyway by streaming weights between disk and RAM, after you type the model's id: colibri for the MoE architectures it reads (experts streamed from NVMe), llama.cpp from SSD for any GGUF (memory-mapped, weights kept pageable), or AirLLM for dense Llama/Mistral models (one layer at a time, minutes per token). Prometheus installs and runs them itself: AirLLM through gated pip into its own venv, served by Prometheus's offline loopback shim; colibri from its pinned source commit, scanned by nemesis and built locally (its prebuilt binaries are refused by the gate), served on loopback with a per-session key
- **Endless free spinner** — One model that never runs dry: rotates across free LLM APIs (NVIDIA NIM, Groq, Cerebras, Gemini, Mistral, OpenRouter, SambaNova, Z.ai, Ollama Cloud, Hugging Face, keyless OVHcloud) on quota limits, before the first token
- **366-model local catalogue** — From 2 GB machines (sub-1B models, embeddings) to 1.5 TB+ frontier MoE (DeepSeek, Kimi, Qwen, GLM, Mistral Large…): every row researched against Hugging Face and ollama.com, with its official repo, GGUF/MLX/Ollama coordinates, measured Q4 size, RAM need and a two-line description. The TUI shows it two-column — model name on the left, its two description lines on the right. Regenerated reproducibly by `studio/python/tools/build_model_catalog.py`.
- **Every download nemesis-gated** — Hugging Face GGUFs are revision-pinned, verified against Hugging Face's own sha256, scanned and admitted before use (`stage-hf`); Ollama-registry pulls are scanned after download and removed on a block; a nemesis WARN is never adopted silently — the user sees the findings and must type the model's name to accept it; `hf.co/…` tags never go through `ollama pull` (the app's "Hug a model" uses the same gated path); pickle files and repository code are never downloaded with a model. Admission records are signed and carry each GGUF's sha256, so a file that changed after its scan is never imported, and a model already admitted is not downloaded again.
- **One copy of every model, in its own software's folder** — Prometheus keeps no model folder of its own. After the nemesis gate admits a download, the bytes are moved (never copied) into the store of the software that serves them: the Hugging Face cache in Hugging Face's own layout (read in place by llama.cpp, MLX-LM, AirLLM, colibri, vLLM), LM Studio's models folder as real files under `<publisher>/<repo>/` (home pointer honoured), or Ollama's store through `ollama create`, after which the transit copy is deleted. A copy already there with the same bytes is reused instead of downloaded twice, and two stores on one disk share a hard link. A signed placement ledger re-verifies every byte before a server Prometheus starts reads it. The old "models folder" setting (`models_root`, which pointed Ollama at a Prometheus folder) is retired; `prometheus models config` and `/paths` show where each runtime keeps its models, and `prometheus doctor` reports any weights left in old Prometheus folders
- **Local runtimes** — Ollama, LM Studio, llama.cpp and MLX managed; vLLM, KoboldCpp, LocalAI, Jan, llamafile and SGLang adopted when running. `/models runtimes` shows what is installed and installs runtimes and agents (OpenCode, Goose, aider, Claude Code, Codex) through official package channels; vendor `curl | sh` installers are only ever shown. A catalogue pick can be served by Ollama, llama.cpp or LM Studio from both the terminal (`/models use local:<id>@llamacpp`) and the app's guided picker ("Serve with"): the gated download is admitted once, llama.cpp serves that file offline and LM Studio gets a link to it — neither runtime ever downloads weights itself. Local-model agents launch against any served model with `prometheus chat --cli <opencode|hermes|aider|goose> --model <m> [--runner ollama|lmstudio|llamacpp|vllm]`, wired per run through env/argv only (nothing written to the agent's config). Hermes has no per-run endpoint flags, so it is launched as is with the one-time `hermes model` setup spelled out.
- **Default local server** — Ollama unless you pick another: `/server` in the TUI opens a dropdown (LM Studio, llama.cpp, MLX-LM, vLLM) and `/server <id>` sets it directly; the app has the same choice in Models → Endpoints and Settings → AI & Agents (one shared setting). The default is the server a session adopts when several serve models, the one started first when none runs, the runtime a local pick is prepared for, and the chat's preselected runner.
- **Hugging Face import** — Convert and install models with one command; the source is scanned first, and a repo that needs `trust_remote_code` is refused
- **Remote compute** — SSH or LAN GPU boxes with feasibility assessment for offloading
- **Model health ledger** — Tracks native vs. text-protocol, context window served, failures
- **Disk space** — `/disk-space` opens the full disk explorer over the TUI (Ctrl+] minimise/resume, Ctrl+D quit); `map` / `levels` / `files` / `mounts` views, plan-first delete with every protection, Linux cleanup, and a root rescan you approve (`--sudo`). `prometheus disk-space` from a shell runs the explorer full-screen and exits on Ctrl+D (`sudo prometheus disk-space` as root). Studio: a Disk space panel with treemap, pie and levels, and Open as administrator (approve, then the system password dialog, then the explorer as root in its own window, where only your keyboard can type). MCP: read-only `prometheus_disk_space`

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
- **MCP tools never auto-run on their own say-so** — a server's `readOnlyHint` counts only for tools the user listed in that server's `autoApprove`; everything else is open-world + destructive on the autonomy ladder
- **Credential-free child environments** — commands the agent runs and MCP servers get no inherited API keys or tokens (pass specific names deliberately with `PROMETHEUS_EXEC_PASS_ENV`)

## 🛡️ Consent the Renderer Cannot Forge (Studio)

- **Native confirms in the main process** for every action a compromised renderer could otherwise approve on its own: forced installs (`force`/`confirmForce` on env, repo, catalog, model and security installs), privileged commands, extension installs, writes outside the project, security-posture settings (gate floor, network, `--force`, cloud, hooks), opening programs/installers, links to unknown hosts, and restart-to-update
- **Hardened agent browser** — no permissions (camera/mic/location/notifications), no popups, no downloads, and no page subresource can reach loopback/private addresses (a page cannot load a local model through `127.0.0.1:11434`)
- **Repository config cannot run code** — `core.fsmonitor` from a repo's own `.git/config` is disabled for every git call Studio makes
- **Main checks who is asking** — every IPC message must come from a top-level frame of one of Studio's own pages, and the two terminal windows can reach only the few channels they use
- **Main has its own autonomy ladder** — an agent tool call your level would ask about runs only with a single-use approval bound to that exact call (minted when you click Run), or after Studio asks you in a native dialog
- **Hardened packaged binary** — Electron fuses turn off `NODE_OPTIONS` and `--inspect`, validate the app archive and encrypt cookies; the macOS build no longer accepts `DYLD_*` library injection
- **Pinned, scanned tooling** — llama.cpp's converter is a pinned commit and Hugging Face's `hf` CLI a pinned version; both are scanned by nemesis and installed into Prometheus's own environments, never your global Python
- **Notifications** — downloads, pulls and installs that finish (or fail) while you are on another screen now say so
- **Raising autonomy needs you** — moving the A-level UP asks in a native dialog (lowering never does); a scheduled task that may edit or run commands unattended, and any MCP connector that starts a program, are confirmed the same way
- **Every fetched dependency is gated** — an isolated tool's Python dependencies (and its rollback cache) and npm build dependencies are staged, scanned by nemesis and installed from the scanned bytes only; package specs that are URLs, VCS refs or paths are refused

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
