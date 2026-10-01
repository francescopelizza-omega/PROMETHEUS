# PROMETHEUS

**An AI-native development platform with security in the critical path.** PROMETHEUS
lets you — or an AI agent — discover, audit, install and run AI tooling (agent
plugins, skills, local model runtimes, self-hosted apps, pentest sandboxes) across
your machine, where **every piece of fetched code is scanned by a fail-closed
supply-chain gate before a single line of it is allowed to execute.**

It ships as three primary surfaces over one gated engine, plus two lighter integrations for
working inside an existing editor:

| Surface | What it is |
|---|---|
| 🖥️ **Studio** | A hardened **Electron desktop IDE** — code editor, catalog/installer, local-model hub, environments, repos, security console, and an AI chat rail. |
| ⌨️ **`prometheus` CLI / TUI** | A terminal-first Node CLI + interactive TUI with **full Studio feature parity** over the same engine. |
| 🔌 **Plugin (MCP)** | A cross-agent bridge that exposes PROMETHEUS to **Claude Code, Codex, Gemini, Cursor, Windsurf, Zed, Continue, Cline** and any MCP-capable CLI. |
| 🧩 **VS Code extension** | A sidebar chat panel that drives the real agent loop against your open VS Code workspace (`studio/apps/vscode-extension`). |
| 🧪 **JetBrains plugin (draft)** | An IntelliJ-family plugin scaffold (`studio/apps/jetbrains-plugin-DRAFT-UNTESTED`) — written without a JVM available to compile or run it; treat it as an unverified starting point, not a working build. |

All of these route through **`prometheus.py`** (the zero-dependency Python engine) and
its **`nemesis`** security gate. The agent loop itself — sub-agents, a lifecycle-hooks system,
cross-session memory, multi-provider model support, and a real per-command OS sandbox
(macOS Seatbelt today; Linux via bubblewrap, unit-tested but not yet run on a real Linux
kernel) — lives once in `studio/packages/core` and is shared by every surface above, not
reimplemented per host.

> **Status:** active development. APIs and layout may change.
> **License:** [Apache-2.0](./LICENSE) — Copyright 2026 Francesco Pelizza ([NOTICE](./NOTICE)).
> **The whole repository**, one licence: the engine, `nemesis`, Studio, the `prometheus`
> CLI/TUI, the VS Code extension and the `prometheus_plugin` adapters. Each package's own
> `license` field is the source of truth, and all eleven read Apache-2.0. (The one exception is
> `studio/examples/extensions/csv-lens/` — a reference fixture carrying its own MIT licence to
> demonstrate that a third-party extension brings its own terms. Nothing depends on it.)
>
> **If you fork it, credit it.** Apache-2.0 §4(d) requires every derivative work to carry a
> readable copy of the attribution notices in [NOTICE](./NOTICE) — that is part of the licence,
> not a request. §4(b) requires you to mark changed files as changed. §6 grants no trademark
> rights: the names *PROMETHEUS* and *nemesis* are reserved, so name your fork something else.
> [NOTICE](./NOTICE) spells out what credit looks like in practice.

---

## Table of contents

- [Install in one command](#install-in-one-command)
- [What people use it for](#what-people-use-it-for)
- [Everything it does](#everything-it-does)
- [Why PROMETHEUS](#why-prometheus)
- [Architecture at a glance](#architecture-at-a-glance)
- [The engine — `prometheus.py`](#the-engine--prometheuspy)
- [The security gate — `nemesis`](#the-security-gate--nemesis)
- [Studio — the desktop app](#studio--the-desktop-app)
- [`prometheus` — the CLI / TUI](#prometheus--the-cli--tui)
- [The plugin — drive it from any AI agent](#the-plugin--drive-it-from-any-ai-agent)
- [The AI agent loop — tools, permissions and mechanics](#the-ai-agent-loop--tools-permissions-and-mechanics)
- [Install & run](#install--run)
- [Configuration, state & exit codes](#configuration-state--exit-codes)
- [Security model](#security-model)
- [Honest limits](#honest-limits)
- [Repository layout](#repository-layout)

---

## Install in one command

```bash
curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
```

No `curl`? Use `wget`:

```bash
wget -qO- https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
```

Linux and macOS. No `sudo`, nothing written outside `~/.prometheus`, `~/.local/bin` and one
marked block in your shell rc. Then:

```bash
prometheus              # the interactive TUI
prometheus doctor       # check the environment end to end
prometheus-app          # launch Prometheus Studio (the desktop app)
```

**This pipes a script from the internet into a shell.** That is a real trade, so the script is
built to let you refuse it. Read it first — [`install.sh`](install.sh) is 400 lines and says what
every step does — or see exactly what it would run, changing nothing:

```bash
curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh -o install.sh
bash install.sh --dry-run          # prints every command; touches nothing
bash install.sh                    # run it once you are satisfied
```

Prefer this two-step form in scripts and CI: in `curl … | bash` the pipeline's exit status is
*bash's*, so a failed download still reports success.

Useful flags: `--ref <tag>` pins a reviewed revision instead of tracking `main`, `--prefix DIR`,
`--home DIR`, `--with-app` also builds the desktop app, `--no-modify-path`, and `--uninstall`
reverses every step including the PATH block. `install.sh --help` lists them all.

**Requirements** — Linux or macOS (Windows: use WSL); **`python3` 3.9+** (the engine and `nemesis`
are standard-library only, *zero* pip dependencies); **Node ≥ 22.6** and `git` for the CLI build.
The installer checks all three and refuses to guess. `pnpm` is installed for you if it is missing.

---

## What people use it for

Ten concrete situations, each with the command that answers it. Everything here is shipped —
nothing in this section is a plan.

### 1. Check whether a plugin is safe *before* it runs

You found an agent plugin, a skill pack, or a repo on the internet and you are about to install
it. That install is the moment the code first executes.

```bash
nemesis scan owner/repo          # fetches read-only, hooks neutralised, never executes it
prometheus install <name>        # every catalog install routes through the gate first
```

The gate is fail-closed: `0` allow, `10` warn, `20` block, and **anything it cannot classify is
not allowed**. It detects pipe-to-shell droppers, reverse shells, miners, obfuscated and
dynamic-exec payloads, persistence hooks, and credential exfiltration. Remediation is dry-run by
default and reversible.

### 2. Run a full coding agent with no cloud account, no API key, no data leaving the machine

```bash
prometheus model hw              # what this box can actually run
prometheus model list --fits     # models scored against your RAM
prometheus                       # the TUI, on a local model
```

Local is **tier A** — the default and the only tier ever promoted. Ollama and LM Studio are
first-class; `/ram` explains any refusal with real KV-cache arithmetic instead of a guess.

### 3. Put a security gate in front of an agent CLI you already use

Keep Claude Code, Codex, Cursor, Gemini CLI, Windsurf, Zed, Continue or Cline. Add the gate under
them:

```bash
prometheus mcp add               # registers the MCP bridge into the CLIs you have
prometheus scan                  # which agents are installed
prometheus matrix                # which plugins reach which agent
```

### 4. Decide exactly how much an agent may do on your machine

```
/auth 0      ask before everything, including reads
/auth 4      run commands, ask before installs
/auth 7      fully autonomous
Shift-Tab    cycle default → acceptEdits → plan (read-only)
/tools disarm run_command
```

Approved commands re-spawn under a kernel sandbox — Seatbelt on macOS, bubblewrap on Linux. The
agent cannot pass `--force` in any spelling; it is stripped from its argv. `/revert` undoes the
last turn's edits.

### 5. Stop an AI bill before it happens

```bash
prometheus budget set-daily 5.00
/stats                           # turns, tokens, model-aware cost
/context                         # what is eating the window
```

Metered providers need one-time explicit consent, so a paid call is never silent.

### 6. Audit a machine you just inherited

```bash
prometheus superscan             # every agent, plugin and forgotten install
prometheus harden                # firewall, ports, ssh, disk encryption — read-only
prometheus audit <name>          # deep-scan one installed plugin's artifacts
prometheus purge <agent>         # back up and remove a forgotten agent's config
```

### 7. Run a model that does not fit in your RAM

```bash
/remote add                      # a box you own, over LAN or ssh
prometheus models                # offload / AirLLM techniques, ranked by feasibility
```

### 8. Work on several things at once without collisions

```bash
/orchestrate <task>              # fan out to parallel sub-agents
/worktree create <branch>        # isolated git worktrees per session
/demos                           # a swarm across claude / codex / gemini / local
/fleet                           # every window and its CPU/RAM/GPU split
```

Sub-agents return only their final answer, so their intermediate work never fills the parent's
context. Resource guards keep a swarm from starving the machine.

### 9. Get oriented in a codebase you have never seen

```bash
prometheus meet                  # what this repo is and where things are
/repomap                         # a budgeted file + symbol map, injected up front
prometheus diagram uml src/      # Mermaid or Graphviz, from a read-only AST walk
prometheus refactor structure    # structure tree, imports, call graph
```

### 10. Keep the whole toolchain current without breaking it

```bash
prometheus updates               # CLIs, local models, host tools, Prometheus itself
```

It also catches the trap where a tool is installed **twice** and only the copy on `PATH` matters —
so `brew upgrade` succeeds, reports success, and changes nothing you run. `/updates fix <tool>`
names the one command that actually resolves it, and the commands that look right and are
destructive.

---

## Everything it does

A map of the whole surface. Every row below is shipped and reachable today unless it says
otherwise; `⚠` marks something partial, and the [Honest limits](#honest-limits) section carries
the full list of what is *not* finished.

### 🛡️ Security — the `nemesis` gate

| | |
|---|---|
| **Supply-chain scanner** | A stdlib-only Python scanner (8,158 lines) over a directory, an archive, or a remote repo it fetches itself. `nemesis scan <path\|owner/repo\|git-url>` |
| **What it detects** | Pipe-to-shell droppers, reverse shells, crypto miners, obfuscated and dynamic-exec payloads, persistence hooks (cron/systemd/launchd), credential and data exfiltration |
| **Fail-closed gate** | `nemesis gate` emits a JSON verdict plus a decision exit code the whole platform routes on: `0` allow, `10` warn, `20` block, `2` error. Anything unknown is **not** allowed |
| **Safe remote fetch** | Shallow clone with `ext::`/`file::` transports disabled and hooks neutralised — fetching a hostile repo cannot execute it |
| **Signature feeds** | Optional local DB seeded from ClamAV hash + `.ndb` body signatures, compiled to an in-process matcher. `nemesis update` |
| **Reversible remediation** | Dry-run by default; `--fix` applies three conservative, undoable actions (neutralize / quarantine / restore) |
| **Trust ledger + vault** | Records what was accepted and when, with revoke and quarantine-restore. `/trust` |
| **Machine posture audit** | Read-only, this-machine-only: firewall, open ports, ssh, disk encryption, plus proposed fixes. `prometheus harden` |
| **Repo hygiene** | Full-history secret scanning (gitleaks, allowlisted *by value*), personal-data and orphan scanners, and a third-party-notices generator — all wired into CI and a pre-push hook |

### 🤖 The agent loop

| | |
|---|---|
| **One loop, every surface** | Sub-agents, lifecycle hooks, memory, providers and the sandbox live once in `packages/core` and drive the CLI, Studio and the VS Code extension identically |
| **Authorization ladder A0–A7** | One autonomy dial: read < write < config < command < install < destructive. `0` asks for everything, `7` is fully autonomous. `/auth <0-7>` |
| **Permission modes** | `default` · `acceptEdits` · `plan` (read-only, proposes and never writes). `Shift-Tab` cycles them |
| **Lifecycle hooks** | Your own shell hooks around each turn; a non-zero `PreToolUse` exit **blocks** the tool call. `/hooks` |
| **OS-enforced sandbox** ⚠ | Every approved `run_command` re-spawns under a kernel confinement driver — Seatbelt (SBPL) on macOS, bubblewrap on Linux. Linux is unit-tested but not yet run on a real kernel |
| **The agent cannot `--force`** | `--force` in any spelling is stripped from agent-issued argv, including `--force=value` and raw arrays |
| **Per-tool arm/disarm** | Disarm exactly the tools you do not want reachable. `/tools` |
| **Checkpoints + revert** | One workspace checkpoint per editing turn; `/revert` restores the last turn's edits deterministically |
| **Works with any model** | An in-band text protocol lets a model with *no* tool-calling API still drive tools, including numbered and attribute tag dialects |
| **Reasoning-effort dial** | `off · low · medium · high · xhigh · ultra · max`, applied per provider including an Ollama `/v1` shim. `/think` |
| **Background + scheduled runs** | Detach a prompt so it survives the prompt returning (`/background`), or scaffold cron/launchd headless runs (`prometheus tasks`) |

### 🧰 The agent's toolbox — 49 tools

| | |
|---|---|
| **Read (16)** | `read_file` `list_dir` `glob` `grep` `semantic_search` `stat_path` `git_status` `git_diff` `git_log` `git_show` `system_info` `gpu_info` `process_list` `which` … |
| **Write** | `propose_edit` (exact-match hunks, human-approved), `write_file`, `apply_patch`, `delete_file` (captures contents first, so it is undoable), `move_file` |
| **Execute** | `run_command` under the OS sandbox, with `job_status` / `job_output` / `job_kill` for long jobs — plus `propose_elevated`, because the agent never escalates itself |
| **Web** | `web_fetch` through a fail-closed SSRF/nemesis proxy, returning web content as **untrusted data, never instructions**; `web_search`; sandboxed `browser_*` tools ⚠ in the agent's *own* isolated tab, never your session |
| **Memory + tasks** | `memory_write` / `memory_read` for durable cross-session facts; `todowrite` / `todoread` for the run's task list |
| **Delegation** | `spawn_agent` returns only a sub-agent's final answer, so its intermediate work never enters the parent's context; `question` asks you one thing and waits |
| **Engine verbs (14)** | `prometheus_scan` `prometheus_superscan` `prometheus_list` `prometheus_info` `prometheus_audit` `prometheus_matrix` … |
| **External programs** | Detect and gate-install `imagemagick`, `ffmpeg`, `yt-dlp` and friends, then use them. `/deps` |

### 🧠 Models, providers and local runtimes

| | |
|---|---|
| **Local-first, three tiers** | **A** local/free is the default and the only tier ever promoted; **B** subscription-included is bounded; **C** metered is allowed, never promoted, and needs explicit one-time consent |
| **Providers** | Local (Model Hub) and any OpenAI-compatible endpoint · Claude · ChatGPT · Gemini · GitHub Copilot · plus native wire formats with real tool calling for each |
| **Local runtimes** | Ollama and LM Studio as first-class runners with live endpoint discovery; llama.cpp and vLLM as conversion/serve targets |
| **Model Hub** | Probe your hardware, score models against it, pull through the gate, build a serve profile, start/stop a supervisor. `prometheus model …` |
| **Hugging Face import** | `/hug org/repo` — convert and install for Ollama / llama.cpp / vLLM / LM Studio, with one copy on disk |
| **RAM admission** | Refuses a model that cannot fit, using real KV-cache arithmetic — and `/ram` tells you *why* |
| **Model health ledger** | What we learned per endpoint: native vs text protocol, the context window actually served, observed failures. `/model-health` |
| **Remote compute** | Register machines you own over LAN or ssh, confirm host keys, open tunnels, score remote RAM fit. `/remote` |
| **Won't-fit toolkit** | A curated offload/AirLLM technique registry plus a feasibility assessor for models bigger than your RAM |

### 💸 Cost and context economy

| | |
|---|---|
| **Spend budget** | A real enforced cap — session and daily limits, warn threshold, unpriced-model policy, spend ledger. `prometheus budget` |
| **Session cost** | Turns, tokens in/out and a model-aware estimate. `/stats` |
| **Context breakdown** | Usage by component, a settable auto-compact ceiling, and `/condense` to summarize older turns |
| **Repo map** | A budgeted file+symbol map injected up front so the agent stops grepping to orient itself. `/repomap` |
| **Token-saving toolkit** | A curated registry of techniques proposed by default — terse output, prompt caching, local RAG. `prometheus tokens` |

### 💾 Memory, context and sessions

| | |
|---|---|
| **Project memory** | `/init` generates a `PROMETHEUS.md` the agent reads at session start |
| **Honours your existing files** | `AGENTS.md`, `CLAUDE.md` and `PROMETHEUS.md` with a defined precedence chain |
| **Sessions** | Persisted, listable, searchable, forkable. `prometheus sessions` |
| **Export** | `/export [--json]` writes the conversation out; `/copy` puts the last reply on the clipboard |
| **Working set** | `/add-dir` widens file access *and* the sandbox together |
| **Local file history** | A git-independent, capped snapshot timeline with diff and revert that survives uncommitted work |

### 🐝 Sub-agents and orchestration

| | |
|---|---|
| **Multi-CLI swarm** | An orchestrator plus sub-agents each bound to a different backend — claude / codex / gemini / a local model. `/demos` |
| **Fan-out workflows** | Decompose a task across parallel sub-agents, or fan out research and get a cited synthesis. `/orchestrate` |
| **Fleet view** | Every Prometheus window on the machine with its CPU/RAM/GPU split. `/fleet` |
| **Resource guards** | Concurrency caps, an idle classifier and a guard so a swarm cannot starve the machine |
| **Git worktrees** | Parallel sessions that do not collide. `/worktree` |

### 📦 Catalog — plugins, skills, apps

| | |
|---|---|
| **Agent inventory** | Which AI CLIs and IDEs are installed (`scan`), a deep census including forgotten installs (`superscan`), and a reach matrix (`matrix`) |
| **Gated install** | Browse the catalog with per-agent install state, see dossiers, preview exactly what lands where — every install passes the gate |
| **Skills** | List, enable, disable, mute and scaffold auto-firing `SKILL.md` folders |
| **Self-hosted apps** | yt-dlp, ollama, n8n, penpot and more, with a target dir and version rollback. `prometheus apps` |
| **Pentest sandbox** | Authorized pentest tooling inside an airgapped, rules-of-engagement-gated sandbox. `prometheus pentest` |
| **World simulation** | Agent-based world-sim engines via docker-compose. `prometheus worldsim` |

### 🗂️ Repos, environments and analysis

| | |
|---|---|
| **Managed repos** | The *only* arbitrary-URL clone path, and every fetch is staged and scanned before it is adopted. `prometheus repo` |
| **Offline vault** | A versioned ZIP archive of every managed repo, with rollback. `prometheus vault` |
| **Python environments** | Create, clone, export, import and doctor venv/conda/system envs. `prometheus env` |
| **Test manager** | Discover a test tree, run with JUnit output, `--retry-failed`, `--tolerate-flaky`, coverage |
| **Diagrams** | Read-only AST walk → Mermaid or Graphviz. `prometheus diagram uml\|deps` |
| **Refactor analyses** | Structure tree, import list, intra-module call graph |
| **Metadata privacy** | Inspect, scrub, edit and timestomp one file's metadata, with privacy flags on sensitive keys |
| **Meet your codebase** | A human-facing read of a repo you just opened. `prometheus meet` |

### 🖥️ Studio — the desktop IDE

| | |
|---|---|
| **Hardened by construction** | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, preload + CSP. Only two files may import the engine; the renderer reaches it across a typed bridge |
| **Editor** | Monaco with file tree, breadcrumbs, outline, problems, search/replace, merge view, blame, call/type hierarchies |
| **LSP + DAP** | Language servers over stdio for python, typescript, javascript, json, yaml, markdown, rust and go — with debugging |
| **Terminal** | Real ptys with profiles, AI presets and venv-activated spawns, in a session list that survives |
| **Notebooks** | Jupyter `.ipynb` editing backed by a kernel sidecar, with a notebook agent tool |
| **Database + profiler** | Data sources, schema tree and a SQL console; a CPU profile panel with a flame view |
| **Security console** | The arbitrary-target gate, threat-DB status, trust ledger and remediation views |
| **AI chat rail** | Runs core's real agent loop — not a fork — with inline edit, diff review, a permission queue and @-mentions |
| **Extension API** | A `.promext` manifest with a fail-soft validator, semver gate and a default-deny permission enforcer |

### 🔌 Editors and MCP — both directions

| | |
|---|---|
| **VS Code extension** | A sidebar chat panel driving the real core agent loop against your open workspace |
| **JetBrains plugin** ⚠ | A scaffold only — never compiled or run. Treat it as unverified |
| **MCP host** | Manage connectors: list, add by command or URL, remove, test. Every server definition carries a gate verdict |
| **MCP server** | Prometheus exposes *itself* over stdio MCP — 25 tools — to Claude Code, Cursor, Codex CLI, Gemini CLI, Windsurf, Zed, Continue and Cline |

### ⌨️ Terminal UX

| | |
|---|---|
| **Full-screen TUI** | Bare `prometheus` — history, autocomplete, markdown and syntax-highlighted rendering, a status strip |
| **140 slash commands** | One registry drives every `/command`, and the same registry drives the CLI verbs and the GUI. `/commands` lists them |
| **67 CLI subcommands** | `scan` `doctor` `model` `repo` `env` `budget` `updates` `sessions` `test` `harden` `pentest` … |
| **Headless** | `prometheus -p "<prompt>"` for one shot; `prometheus chat` for terminal chat |
| **tmux** | `prometheus session --tmux N` with auto-scaled sub-agent fan-out and a swarm board |
| **Shell completion + man page** | bash/zsh/fish completions and a roff man page, both generated from the one command registry |
| **8 languages** | English, Italian, French, Spanish, German, Portuguese, Dutch, Polish — with per-key fallback to English, so a partial translation never shows a blank |

### ⚙️ The engine

| | |
|---|---|
| **One file, zero dependencies** | `prometheus.py` is a single ~868 KB standard-library-only Python file that every surface routes through |
| **38 subcommands** | `scan` `superscan` `matrix` `where` `purge` `inventory` `doctor` `install` `status` `vault` `wizard` … |
| **A machine contract** | Every command prints exactly **one** JSON object on stdout; human logs go to stderr. That contract is what the MCP bridge, the CLI and Studio all speak |
| **One gateway** | `engine-bridge` is the only package allowed to spawn `python3` or `nemesis` — security logic is never reimplemented in JavaScript |

---

## Why PROMETHEUS

Installing AI tooling means running other people's code — bash installers, git
clones in any language, `docker-compose` stacks, downloaded ZIPs, even piped
`curl | sh` bodies. PROMETHEUS treats **every** such artifact as untrusted and puts
a real security scan **between "fetched" and "executed"**, on every install path,
whether the action came from a human clicking *Install* in Studio, from the `prometheus`
CLI, or from an AI agent calling an MCP tool.

Three ideas hold it together:

1. **One engine, three faces.** Studio, the CLI, and the agent plugin are all thin
   clients of `prometheus.py`. Nothing reimplements install or security logic —
   they call `python3 prometheus.py --json <command>` and read one JSON object back.
2. **Fail-closed gating.** If the scanner is missing, errors, times out, or returns
   garbage, the verdict is *error* and the install is **blocked**. A missing scanner
   never silently passes.
3. **JavaScript never decides "safe".** In Studio the privileged layers relay
   verdicts verbatim; they perform no scoring, no allow-listing, and can never
   upgrade a verdict toward *allow*. The Python gate is the sole authority.

---

## Architecture at a glance

```
  You / an AI agent
        │
        ├── Studio (Electron)  ─┐
        ├── prometheus  (CLI / TUI)  ─┤   thin clients — read-only + gated actions
        └── MCP plugin tools   ─┘
                                │   bridge contract:  --json → exactly ONE JSON object
                                ▼
                       prometheus.py  (zero-dep engine)
                                │   fetch → STAGE (never execute yet)
                                ▼
                          nemesis gate            ← scan + score, fail-closed
                          ├─ allow → install proceeds
                          ├─ warn  → prompt, default NO
                          └─ block → refused (override only with --force + typed confirm)
                                │
                                ▼
                   per-agent adapter installs into the target's OWN native mechanism
```

**The bridge contract:** `prometheus.py --json <command>` prints exactly one JSON
object on **stdout** and routes all human/log text to **stderr**. Every client
spawns it, reads that one object, and never parses human text.

---

## The engine — `prometheus.py`

A single **standard-library-only** Python script (zero pip deps) that runs on stock
macOS/Linux `python3`. It detects every AI coding agent on the machine and
installs / uninstalls / manages tooling into each one **using that agent's own
native mechanism** — idempotent (re-run = no-op), OS-aware, fail-closed on security.

### The model: hosts × plugins

A **plugin** declares a `targets` map (`host → InstallSpec`). At install time the
engine intersects *(detected hosts) ∩ (plugin targets)* and runs each spec. A plugin
that only supports Claude installs only into Claude; one that supports all hosts
installs into whichever are present.

- **Host kinds:** `cli` (standalone terminal agents — claude, codex, gemini,
  cursor-agent) and `ide` (agents embedded in an IDE — the JetBrains family + AIR).
- **Reference:** installing CAVEMAN into Claude runs
  `claude plugin marketplace add …` then `claude plugin install caveman@caveman
  --scope user`, after reading Claude's on-disk state so a re-run is a no-op.

### The eight functionalities

| # | Command | What it manages |
|---|---|---|
| 1–2 | `install` / `uninstall` / `enable` / `disable` / `bundle` / `skills` / `sync` / `scaffold-skill` | **Plugins & skills** — the core install engine (per-agent, component-aware, arm/auto-fire). |
| 3 | `models` | **Local/cloud model-running tools** (AirLLM, FlashAttention, Odysseus, …), gated like any source. |
| 4 | `apps` | **Self-hosted apps & repos** (yt-dlp, ollama, n8n, penpot, plausible, bitwarden, …) — safest-method-first, full lifecycle install/update/rollback/uninstall (`apps wizard` guides it). |
| 5 | `pentest` | **Authorized pentest tools & AIs** inside a strongly armored sandbox (airgapped by default, Rules-of-Engagement gated). |
| 7 | `vault` | Offline versioned **ZIP archive of every repo** (re-pulls only when upstream is newer). |
| 8 | `worldsim` | Agent-based **world-simulation engines** (MiroFish, …) via docker-compose. |
| — | `localai` | Audit every AI repo (paid-API vs free-local) + a catalog of open-source models and the recipe to re-point a paid API at a free OpenAI-compatible one. |

### Command surface (grouped)

**Discovery / inspection** — `scan` (detect agent CLIs), `superscan` (deep inventory:
installed / absent / forgotten + prerequisites), `inventory` (all plugins/skills/MCP
per agent, managed *and* foreign), `matrix` (which tool can install into which agent),
`where <name>` (where it *would* land, before you commit), `list`, `status <name>`,
`info <name>`, `doctor` (environment check).

**Core** — `wizard` (interactive menu), `bundle` (official Anthropic bundle in one
run), `install <name>` / `uninstall <name>` (names: a plugin, `all`,
`official-bundle`, or a subset `plugin:comp1,comp2`), `enable` / `disable`
(reversible), `skills <list|enable|disable|mute|unmute>`, `scaffold-skill`
(write a new auto-firing `SKILL.md`), `sync` (replicate a skill across agents),
`audit <name>` (security-scan only, **no install**).

### Typical flow

```bash
python3 prometheus.py superscan        # what agents do I have?
python3 prometheus.py where caveman    # where would it land?
python3 prometheus.py audit caveman    # is the source safe? (no install)
python3 prometheus.py install caveman  # install (auto-gated) everywhere
python3 prometheus.py status caveman   # confirm + inspect components
```

---

## The security gate — `nemesis`

`nemesis` is a separate, **stdlib-only, zero-dep** malware / supply-chain scanner
that ships next to `prometheus.py`. **Every install path runs the fetched code
through nemesis before any of it can execute.**

### The automatic workflow (runs on every install)

1. **PREPARE** — `prepare_nemesis()` seeds the signature DB on first use, or
   refreshes it when stale (TTL-skips fresh feeds, so repeats are cheap). Best-effort:
   offline with an existing DB proceeds; first-use offline still gates via static
   analysis. `--gate-fresh` forces a full re-download.
2. **SCAN + SCORE** — nemesis scans the staged code and returns a verdict + a
   **0–100 risk score**:
   - `allow` → **safe**, install proceeds.
   - `warn` → **risky**; prompt, **default NO** (non-interactive without `--yes`
     refuses; `--strict` blocks outright).
   - `block` → **dangerous**; PROMETHEUS refuses.
3. **FORCE PATH** — to install a *blocked* source anyway, the operator must
   explicitly override: `--force` (script) or `/prometheus --force` (agent). A
   deep-red ☠ **DANGER** banner shows; on a TTY a typed `install-dangerous`
   confirmation is required; the override is written to the signed audit log and
   surfaced as `forced_danger` (`ok:false`). Without `--force`, dangerous code is
   never installed.

### How PROMETHEUS invokes it

```
nemesis gate <target> --sandbox auto --jail auto --timeout 840 --sign \
                      [--policy <tier-file>] [--no-cache]
```

`<target>` is a **staged** clone, a downloaded file, or `-` (code streamed on stdin,
never landing on disk). The gate runs **after fetch, before** the code is moved into
place or executed. **Fail-closed:** a missing / erroring / timed-out / unparseable
scanner ⇒ verdict *error* ⇒ install **blocked**. Approved verdicts are remembered
(bound to the source commit) in `trust.json`, so unchanged code isn't re-prompted;
`audit <name> --revoke` forgets it.

### What nemesis detects

Droppers (`curl|sh`), reverse shells, miners, persistence (cron/launchd/systemd/
rc-files/ssh/git-hooks), credential + keychain + browser-cookie theft, env-var
exfil, npm/pip/`setup.py`/`pyproject` install-time hooks, CI/CD attack surface
(`pull_request_target`, unpinned actions, untrusted-input interpolation), git-config
weaponization, obfuscation (base64/hex/charcode/concat — with a real
decode-and-recurse pass), archive threats (zip/tar/rar/7z/zst incl. nested), SCA
dependency CVEs (OSV + CISA-KEV), and ClamAV body-pattern signatures. **Every
verdict is HMAC-signed** so a stored / transported verdict is tamper-evident.

### Clone-time hardening (TOCTOU closed)

Every git clone/pull runs with `core.hooksPath=/dev/null`, `core.fsmonitor=`,
`protocol.ext.allow=never`, and `--no-recurse-submodules`, so **nothing** in a
fetched repo (a checkout hook, an fsmonitor program, an `ext::` submodule) can run
before nemesis has scanned the staged tree. `pyproject` PEP-517 build hooks are
scanned (closes "code runs at pip install time"), and dynamic shell sinks
(`os.system` / `os.popen` / `subprocess.getoutput` built at runtime) are caught at
the AST level.

### Context discrimination (low false positives)

A pattern only counts as a threat if it is **executable install code**. Matches
inside comments, docs, test files, or CI workflows are suppressed to *info*; a
credential path inside a string/echo is a *mention*, not an action — while a bare
action (`cat ~/.aws/credentials`) still fires. Use `--show-info` to see suppressed
hits.

### Use it standalone, any time

```bash
nemesis scan <dir|owner/repo|git-url>   # scan a tree or remote repo (never runs it)
nemesis gate <target>                   # one JSON verdict + exit 0/10/20/2
nemesis ui  [dir]                       # interactive browse + remediate
nemesis update                          # refresh signature / CVE / KEV feeds
nemesis verify <verdict.json>           # check a signed verdict
nemesis selftest                        # offline self-check (must stay green)
```

---

## Studio — the desktop app

A hardened **Electron 33** desktop IDE (`studio/apps/desktop`) that puts the whole
engine behind a real UI. It bundles a **relocatable CPython runtime**, so end users
don't need Python installed.

**Security-first process model (four processes):**

- **Main** — the only privileged process; creates a hardened `BrowserWindow`
  (`contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, preload + CSP)
  and owns the one engine client.
- **Renderer** — a sandboxed React view. It reaches the engine *only* across a typed
  `contextBridge` IPC seam; it can't import Node, Electron, or the engine bridge.
- **Worker** — an offloaded `utilityProcess` for heavy tasks.
- **Sidecars / servers** — supervised long-lived processes (`engine-bridge` is the
  **only** thing that spawns `python3` / `nemesis`, with a curated child environment).

**Panels & surfaces:**

| Panel | What it does |
|---|---|
| **Home** | Landing + engine status. |
| **Catalog** | Browse & install plugins/skills/apps/model-tools — each install runs the full nemesis gate; dry-run first, with streaming progress. |
| **Model Hub / Models** | Discover and manage local model runtimes (Ollama, LocalAI, …), pull/serve models. |
| **Environments** | Detect and manage Python/toolchain environments and packages. |
| **Repos** | Clone & manage git repositories **through the nemesis gate** (every clone URL audited before fetch). |
| **Extensions** | A sandboxed extension host (VS-Code-style; ships a `csv-lens` example). |
| **Security** | The verdict console + the append-only **Gate audit log** + quarantine/remediation. |
| **Editor / IDE** | Monaco-based editor with LSP/DAP, terminals (PTY), git, notebooks, refactors, tests. |
| **AI rail (chat)** | A collapsible right-side agent/chat + inspector rail. |

**The edit-apply wrapper.** The layer that turns model chat output into on-disk edits
is **deterministic-first and fail-closed**: an ordered fallback ladder (exact →
trailing-whitespace → indent → blank-skip → anchor), unique-or-ambiguous at every
rung, byte-preserving on untouched regions (CRLF/BOM/trailing-newline), verifying
bracket balance before writing, and refusing with a structured retry hint rather than
guessing. A **permission spectrum** runs from *ask-for-everything* → *bypass* → a
run-to-done *YOLO* mode — where **autonomy never overrides the security gate**.

---

## `prometheus` — the CLI / TUI

`studio/apps/cli` builds `prometheus` — a Node ≥22.6 terminal CLI with
**full Studio feature parity over the same engine-bridge**, plus an interactive TUI.
It exposes scan/gate, catalog install/audit, model + provider management,
environments, repos, MCP management, agent sessions, refactors, health/doctor, token
economy, and more. Because it speaks the same bridge, anything Studio can do, `prometheus`
can do headless.

---

## The plugin — drive it from any AI agent

`prometheus_plugin/` is a thin wrapper that exposes the entire gated engine to AI
agent CLIs **and** a standalone terminal GUI. It reimplements nothing — it shells out
to `python prometheus.py --json …`.

**Three npm packages:**

- **`@prometheus-plugin/mcp`** (bin `prometheus-mcp`) — an MCP stdio server exposing
  **14 tools**: `scan`, `superscan`, `list`, `info`, `where`, `matrix`, `status`,
  `skills_list`, `vault_status`, `audit`, `install`, `uninstall`, `enable`,
  `disable`. Read tools are safe; **install/uninstall run the full nemesis gate**
  (`isError` set on a block/error verdict).
- **`@prometheus-plugin/tui`** (bin `prometheus-tui`) — an Ink (React-for-CLI)
  terminal GUI: menu + live agent grid + Scan/Catalog/Install/Audit/Matrix/Skills/
  Vault views.
- **`@prometheus-plugin/installer`** (bin `prometheus-install`) — registers the MCP
  server into each detected CLI's native config, **merge-safely** (splices only the
  `prometheus` key, preserving siblings + comments).

**Register into a CLI:**

```bash
npx -y @prometheus-plugin/installer --py /ABS/PATH/prometheus.py
# flags: --agent <name>  --dry-run  --py <path>  --list
```

Static per-CLI manifests live in `prometheus_plugin/adapters/` (Claude `.mcp.json`,
Codex TOML, Cursor `mcp.json`, Gemini extension, Windsurf, Zed, Continue YAML, Cline,
generic-mcp). Net effect: an agent asks *"install caveman everywhere safely"* and the
call travels **agent → MCP tool → `prometheus.py --json install` → nemesis gate →
per-agent adapter** — fully gated, one machine-readable result returned.

---

## The AI agent loop — tools, permissions and mechanics

Every surface — Studio's AI rail, the `prometheus` CLI/TUI, the VS Code extension, and any
external agent talking through the MCP plugin above — drives the **same** agent loop, implemented
once in `studio/packages/core/src/agent/` and shared, never reimplemented per host.

### Tool catalog

The model is never handed a shell directly — it calls typed tools, each independently gated:

| Category | Tools |
|---|---|
| **Read / inspect** | `read_file`, `list_dir`, `stat_path`, `grep`, `glob`, `semantic_search`, `git_status`, `git_diff`, `git_log`, `git_show`, `system_info`, `gpu_info`, `process_list`, `which`, `package_list`, `env_get`, `job_status`, `job_output` |
| **Write / edit** | `propose_edit` (deterministic patching, below), `write_file`, `delete_file`, `move_file`, `mkdir` |
| **Execute** | `run_command` (parsed argv, never a shell string), `job_kill`, `propose_elevated` (drafts a privileged command for a *human* to run themselves — the agent never executes it) |
| **Network** | `web_fetch`, `web_search` |
| **Memory** | `memory_write`, `memory_read` |
| **Delegation** | `spawn_agent`, `question` (ask the human mid-turn) |
| **Desktop-only** | `browser_navigate`, `browser_screenshot`, `browser_extract_text` |
| **Engine** | `prometheus_scan` / `superscan` / `list` / `info` / `where` / `status` / `audit` / `matrix` / `skills_list` / `vault_status` (read-only) and `prometheus_install` / `uninstall` / `enable` / `disable` — gated exactly like a human typing the same command |

### The authorization ladder — A0 through A7

One knob controls how much the agent may do without asking, each rung unlocking one more risk
category: read < write < config < command < install < destructive.

| Level | Name | Auto-approves |
|---|---|---|
| A0 | paranoid | nothing — asks before every action, including reads |
| A1 | readonly (**default**) | reads |
| A2 | edits | + file writes |
| A3 | config | + local settings changes |
| A4 | commands | + shell commands |
| A5 | installs | + installs / network calls |
| A6 | trusted | everything the engine allows |
| A7 | runall | + runs to completion with no per-turn pauses |

Two things never move with the ladder: `propose_elevated` is never auto-approved at any level, and
the **nemesis** security check can still hard-block a dangerous action regardless of level —
autonomy is not the same as safety. A separate **permission-mode** layer sits alongside the ladder
and can only *narrow* it further, never widen it: `default` (ask before each change), `acceptEdits`
(auto-run local file edits only), `plan` (read-only — proposes a plan instead of acting),
`bypassPermissions` (auto-run everything the engine allows), and `yolo` (bypass, plus no per-turn
pauses on a long task). nemesis still blocks a dangerous action even under `bypassPermissions`/`yolo`.

### `propose_edit` — deterministic patch application

File edits never go through a diff-and-hope-it-lands. A five-rung fallback ladder — **exact match
→ trailing-whitespace-insensitive → indent-insensitive → blank-line-insensitive → anchor match** —
is tried in order, and every rung is *unique-or-ambiguous*: a rung that matches more than one site
in the file fails outright with a structured retry hint, rather than guessing which site the model
meant. There is no fuzzy/edit-distance fallback, by design — byte-preserving on every region the
patch doesn't touch (CRLF, BOM, trailing newline included).

### The command sandbox

An approved `run_command` still runs inside an OS-level confinement, applied last, after every
app-layer check has already passed: **Seatbelt** on macOS, **bubblewrap** on Linux. It restricts
writes outside the working set and network access below A5; it does **not** restrict file reads
(the read-only inspection tools need the whole machine readable by design), CPU/memory limits, or
fork bombs. A missing sandbox driver on Linux runs the command unconfined and says so in the log —
an honest absence, never a silent downgrade; a broken one on macOS refuses to run at all
(fail-closed). See [Honest limits](#honest-limits) for the full, current caveat list.

### Lifecycle hooks

`PreToolUse`, `PostToolUse`, and `SessionStart` hooks run your own script around every tool call or
at session open — a linter before every write, a notification after every install, project context
injected at start. Only `PreToolUse` can refuse a call (a clean nonzero exit denies it; a timeout,
crash, or missing binary all fail *soft*, as if no hook existed at all). Your own global hooks
always run. A **workspace's** own hook config — the one checked into a repo you cloned — is trusted
far less: any command that isn't byte-identical to one you already had globally is scanned by
nemesis and needs a one-time human confirmation, cached per exact novel set, so a hook someone else
added to the repo can't start silently running on your machine, and a repo that later *changes*
that hook re-prompts rather than reusing your old approval.

### Cross-session memory

`memory_write` / `memory_read` persist markdown notes per project — scoped to the repo root, so any
subdirectory of a monorepo shares one store — plus an auto-maintained index folded into every new
session's context. The agent can leave itself notes that survive a restart.

### Sub-agent delegation

`spawn_agent` runs a child agent turn to completion and returns only its final answer, keeping
exploratory noise (every file it read, every command it ran along the way) out of the parent's
context. Delegation can only narrow privilege from parent to child, never widen it, and is
depth-capped (a child cannot itself spawn) and budget-capped per turn, so a runaway fan-out can't
happen by accident. Four built-in roles ship — `explore`, `scout` (read-only lookups), `plan`
(read-only, returns an ordered plan instead of acting), `build` (read/write, still gated per call)
— and custom personas are markdown files with a small frontmatter: your own
(`~/.prometheus/agents/*.md`) are trusted as written; a project's own
(`<repo>/.prometheus/agents/*.md`) is clamped — forced read-only, can't choose its own model, and
its instructions can only narrow the tools available to the child, never widen them.

### Custom slash commands

`/name` commands are markdown files under `~/.prometheus/command/` (global) or
`<repo>/.prometheus/command/` (project), supporting `$ARGUMENTS`, positional `$1`–`$9`, `@file`
references, and `` !`shell command` `` interpolation. The same trust asymmetry as hooks applies: a
project-scope command can reference workspace files but can never embed a shell command — a repo
you clone cannot smuggle in a command that runs something the moment you type `/deploy` — only your
own global commands can, and even those still pass through the nemesis gate and a confirmation like
any other command.

### Token economy

A built-in **repo map** (`/repomap`) walks the tree once (gitignore-aware, symlink-safe) and
extracts exported symbols per language into a token-budgeted map, so the agent can answer "where is
X defined?" without a grep round-trip, degrading gracefully as the budget tightens. Terse-output
prompting and prompt-caching guidance are wired into runtime behavior today; a broader technique
catalog (local code RAG, structured outputs, LLMLingua-2, server-side compaction, …) is documented
with install steps rather than reimplemented, and scored honestly rather than oversold.

### Connecting external tools — the MCP client

Point the agent at any MCP server — a spawned stdio subprocess or a streamable-HTTP endpoint, with
keychain-backed bearer auth so a secret never sits in a config file — and its tools join the
catalog above. Adding a server runs its launch command (or, for a marketplace entry, its source
repo) through the nemesis gate first, exactly like a plugin install: a blocked verdict means the
server is never spawned. Read-only tools you've pre-approved run without asking; anything with a
`destructiveHint` never auto-runs, no matter what you granted.

**Tool-descriptor pinning.** The add-time scan only sees the launch command — not what a server's
tools *say* they do. So on every later reconnect, PROMETHEUS hashes the server's full tool
descriptor set (name, description, schema, annotations, compared order-independently) against the
hash pinned at the last clean connection. Any drift — even one that reads perfectly innocent on its
own — blocks the server outright and tears the connection down; a deliberate re-add is required to
approve the new definition. A server that redefines itself after you've already trusted it doesn't
get to vouch for its own new description.

### Model providers

Native tool-calling support for **OpenAI**, **Anthropic**, and **Gemini**'s own protocols; every
other provider (OpenRouter, Groq, DeepSeek, and more) speaks the OpenAI-compatible dialect. A
**local** tier runs entirely offline through Ollama, including a one-step "repoint" that swaps a
metered open-weight model for its free local pull. A reasoning-effort knob (off / low / medium /
high / max) adapts per model and runtime, preferring a live capability probe over guessing from a
model's name.

### Exposing PROMETHEUS's own tools outward

`studio/apps/mcp-server` runs the inverse direction of the client above: a real MCP server exposing
PROMETHEUS's own agent tool catalog to **other** MCP clients — read-only only (`scan`, `list`,
`info`, `status`, `audit`, …), enforced by a fail-closed double check at both load time and dispatch
time, since a headless JSON-RPC caller has no human on the other end to answer a confirmation
prompt.

---

## Install & run

> **Status of the published routes.** The `npx -y @prometheus-plugin/*` commands below are not
> live yet — those packages have **never been published to npm**. Their manifests are
> publish-ready; the publish itself has not happened. Until it does, register the MCP server from
> a source checkout (see `prometheus_plugin/README.md`).
>
> The `curl … install.sh` route is the supported one. `studio/scripts/release-preflight.mjs`
> verifies it end to end — including an **unauthenticated** fetch of the raw URL, so "works for
> the maintainer" can never again be mistaken for "works for everyone" — and fails loudly if any
> documented route would break for a new user.

### Linux

```bash
curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
# or, without curl:
wget -qO-  https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
```

Installs to `~/.prometheus`, links **`prometheus`** (CLI/TUI) and **`prometheus-app`** (the Studio
desktop app) into `~/.local/bin`, and patches that onto `PATH` in your shell profile (bash/zsh/fish
— open a new terminal, or re-source your profile, to pick it up). No `sudo`, nothing written
outside your home directory.

Studio's per-command OS sandbox uses **bubblewrap** (`bwrap`) on Linux. It's optional — its
absence is handled as an honest, logged "ran unconfined," never a silent downgrade — but install it
first if you want `run_command` calls actually confined at the kernel level:

```bash
sudo apt install bubblewrap      # Debian / Ubuntu
sudo dnf install bubblewrap      # Fedora
sudo pacman -S bubblewrap        # Arch
```

### macOS

```bash
curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
# or, without curl:
wget -qO-  https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
```

Same script, same destination — `~/.local/bin` on your `PATH`, nothing outside your home directory.
macOS's per-command sandbox uses the OS's own **Seatbelt** (`sandbox-exec`); there's nothing extra
to install.

> A Finder/Dock-launched Studio build repairs its `PATH` at startup so Homebrew/`~/.local` tools
> (`git`, `ollama`, `hf`, …) stay visible to the engine's install and detection steps — a
> GUI-launched app doesn't inherit your shell's `PATH` the way a terminal-launched one does.

### Both

```bash
prometheus              # the interactive TUI
prometheus scan         # detect the AI agents on this machine
prometheus doctor       # check the environment end to end
prometheus-app          # launch Prometheus Studio
```

This runs a script from the internet. Before you do that, you may want to read it —
[`install.sh`](install.sh) — or see exactly what it would do without changing anything:

```bash
curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh -o install.sh
bash install.sh --dry-run
```

Useful flags: `--ref <tag>` (pin a revision instead of tracking `main`), `--prefix DIR`,
`--home DIR`, `--with-app` (also build the desktop app), `--no-modify-path`, `--uninstall`.
`install.sh --help` lists them all.

Already have a checkout? `./install.sh --from-local .` wires up the same commands without
cloning anything.

### Requirements

- **Linux or macOS** (Windows: use WSL) — a stock **`python3`** (3.9+); the engine and nemesis
  are standard-library only, **zero pip dependencies**.
- **Node ≥ 22.6** and **git** — the installer builds the CLI bundle from source. The workspace
  sets `engines.node ">=22.6"` with `engineStrict`, so an older Node is refused up front rather
  than after the clone. `pnpm` is installed for you if it is missing — **corepack is no longer
  bundled with Node**, so the installer falls back to `npm install -g pnpm@<pinned>`.
- `git` on `PATH` (installs stage via git clone).

### From source (both Linux and macOS)

```bash
# 1) the engine directly — no build step, works the moment you have python3
python3 prometheus.py wizard            # interactive menu
python3 prometheus.py scan              # detect installed AI agents
python3 prometheus.py install caveman   # gated install into every supported agent
./nemesis scan owner/repo               # standalone security scan

# 2) register into your AI agent (MCP)
npx -y @prometheus-plugin/installer --py "$PWD/prometheus.py"

# 3) Studio desktop
cd studio
corepack enable && pnpm install
pnpm dev                 # run the desktop app (electron-vite dev)
pnpm package             # build a distributable (staged engine + pyruntime + electron-builder)

# 4) `prometheus` CLI
cd studio
pnpm install
pnpm dev:cli             # run the CLI/TUI in dev
pnpm --filter @prometheus/cli run prepack   # build the bundle bin/prometheus launches
```

`bin/prometheus` and `bin/prometheus-app` work straight out of a checkout — put `bin/` on
your `PATH`, or let `./install.sh --from-local .` link them for you. Both resolve the
checkout from their own location, so symlinking them anywhere is safe.

---

## Configuration, state & exit codes

**Global flags** (must precede the command): `--dry-run`, `--verbose`, `--force`,
`--no-color`, `--version`, `--json`. **Security:** `--no-scan` (skip the regex
pre-scan; the deep gate still runs), `--no-gate` (disable the gate this run),
`--gate-mode enforce|warn|off`, `--gate-fresh`, `--yes`, `--strict`, `--force` /
`--force-unsafe`, `--show-info`. **Targeting:** `--host <agent>` (repeatable),
`--only`, `--skip`, `--arm`.

**Environment variables**

| Var | Meaning |
|---|---|
| `PROMETHEUS_GATE` | `enforce` \| `warn` \| `off` — default gate behaviour (flags override). |
| `NEMESIS_BIN` | Explicit scanner path (else: the script's dir, then `PATH`). |
| `PROMETHEUS_PY` | Where the plugin layer finds `prometheus.py`. |

**State on disk**

| Path | Contents |
|---|---|
| `~/.config/prometheus/trust.json` | Approved (plugin + source commit) verdicts. |
| `~/.config/prometheus/nemesis-policy-<tier>.json` | Per-tier gate policy. |
| `~/.nemesis/gate-audit.jsonl` | Append-only, signed gate decisions. |

**Exit codes:** `0` success / nothing to do · `1` one or more installs failed ·
`2` bad usage / unsupported OS / missing prerequisite / gate **BLOCK**. (Standalone
`nemesis gate` uses `0` allow / `10` warn / `20` block / `2` error.)

---

## Security model

- **Fail-closed everywhere.** No scanner, no timeout budget, no parseable verdict ⇒
  blocked.
- **Untrusted-by-default.** Bash installers, clones, compose files, ZIPs, piped
  bodies — all staged and scanned before execution.
- **JS never decides "safe."** Studio's privileged layers relay engine verdicts
  verbatim; no scoring, no allow-listing, never upgrade toward *allow*. The `--force`
  override requires a typed confirmation **and** is written to the signed audit log.
- **Tamper-evident.** Every verdict is HMAC-signed; `nemesis verify` checks a stored
  verdict.
- **Least privilege.** Studio's renderer is sandboxed; only one bridge process
  spawns `python3` / `nemesis`, with a curated child environment that strips
  loader/interpreter-hijack variables (`LD_PRELOAD`, `DYLD_*`, `PYTHONPATH`, …).

### Defending the agent loop against prompt injection

`nemesis` gates fetched *code*. A separate set of defenses gates fetched *text* — the biggest
attack surface an agent loop actually has, since anything the model reads that a third party
controls (a file in a cloned repo, an MCP server's response, a PR comment, a sub-agent's own
report) can carry instructions trying to redirect it. This is treated as **untrusted by
construction**, not by best-effort detection:

- **Structural framing, always.** MCP tool results, PR titles/descriptions/comments/diffs, a
  sub-agent's report (once it touches any untrusted surface), and repo file content — `read_file`,
  `grep`, `git log`, and their `run_command` equivalents alike, so `cat secret.env` isn't a
  lower-friction way to read the same bytes than `read_file` is — are wrapped in an explicit
  `<<untrusted-…-data>>` marker before they ever reach the model's context. The frame applies
  unconditionally, whether or not anything looks suspicious — it is the actual protection.
- **Pattern scanning on top, advisory.** A lightweight, in-process scanner flags override / persona
  / exfiltration / tool-invocation phrasing and hidden Unicode characters, appending a visible
  warning when it fires. It is a heuristic layered *on top of* the frame above, not a substitute
  for it — an attacker who phrases around every pattern still lands inside the unconditional frame.
- **A canary tripwire.** Each agent turn plants a random, never-to-be-repeated token in the model's
  own context, with an explicit instruction never to reveal it. If that token ever shows up in the
  model's output, something upstream got it to act against an explicit instruction — a
  near-zero-false-positive signal that a defense layer was bypassed, written to an audit log rather
  than silently missed.
- **Workspace-hook and steering-file trust.** A cloned repo's own `.prometheus/settings.json` can
  only *narrow* your existing hooks, never introduce a new command unscanned and unconfirmed (see
  [Lifecycle hooks](#lifecycle-hooks) above); project-scope `AGENTS.md` / `CLAUDE.md` content is
  labeled as repo-supplied advisory context and explicitly told it cannot grant tools or relax the
  approval ladder.
- **MCP tool-descriptor pinning** closes the "rug pull" case where a server redefines its own tools
  after you've already approved it (see [Connecting external tools](#connecting-external-tools--the-mcp-client)
  above).

None of this claims prompt injection is *solved* — see [Honest limits](#honest-limits) below — it's
defense in depth applied at every point untrusted text crosses into the model's context, with the
same fail-closed instinct the rest of this project applies to fetched code. One real, deliberate
trade-off: MCP tool-descriptor pinning hard-blocks on ANY drift, including a routine, benign
upstream update to a server you run via a floating version (`npx pkg@latest`) — that's treated as
the safer failure mode than trusting a server's own claim that its new definition is fine, but it
does mean an innocent version bump can require you to manually re-approve a server you did nothing
wrong with.

---

## Honest limits

`nemesis` is **heuristic + signature static analysis, not a sandbox**. A clean
`allow` means "no *known-pattern* threat", never "proven safe". It cannot see a
payload fetched at runtime from a clean host, a novel evasion tuned against its
thresholds, or a native/compiled blob's behaviour. Use it as strong
defense-in-depth: run untrusted sources `--strict`, `nemesis update` first, pin
commit SHAs, install as a non-privileged user / in a container, and human-review the
diff for anything you're about to grant credentials to.

Separately, the agent's own shell/command execution (not `nemesis` — a different layer) *does*
run under a real OS-level sandbox on macOS (Seatbelt, live-verified: real writes outside the
working set are kernel-refused) and Linux (bubblewrap — real, but only unit-tested on this
project's own dev machine; no Linux kernel was available to verify enforcement live). Windows
has no equivalent primitive and runs unconfined at the OS level — the app-layer confirm/gate
still applies there, it's just not backed by a kernel sandbox. Neither sandbox restricts file
*reads*, CPU/memory/disk, or the temp/toolchain-cache directories a sandboxed command needs
to be writable to actually run — see `studio/packages/core/src/agent/system/host/exec-sandbox.ts`'s
own header comment for the precise, current list of what is and isn't confined.

---

## Repository layout

| Path | What it is |
|---|---|
| `install.sh` | The one-command installer (`--dry-run`, `--from-local`, `--uninstall`). Builds the CLI, wires the engine, links the commands, patches `PATH`. |
| `bin/` | `prometheus` and `prometheus-app` launchers. POSIX shell, resolve the checkout from their own path, safe to symlink anywhere. |
| `prometheus.py` | The zero-dep Python engine (installer/manager). Reading this file alone documents the whole system (it carries the full operator manual). |
| `nemesis` | The stdlib-only supply-chain security scanner / gate. |
| `studio/` | pnpm + Turbo monorepo: `apps/desktop` (Electron Studio), `apps/cli` (`prometheus`), `apps/mcp-server` (a real stdio MCP server exposing the studio agent's own tool catalog — read-only tools only, see its own README), `apps/vscode-extension` (a sidebar chat panel driving the real agent loop inside VS Code), `apps/jetbrains-plugin-DRAFT-UNTESTED` (an IntelliJ-family plugin draft, never compiled — no JVM was available when it was written), `packages/*` (`core`, `engine-bridge`, `ui`), `python/sidecar` (gated sidecars), `staging/pyruntime` (bundled CPython). |
| `prometheus_plugin/` | The cross-agent bridge for **other** tools (Claude Code, Cline, Gemini, …) to call into PROMETHEUS over MCP: `mcp-server` (bridges to the Python engine — distinct from `studio/apps/mcp-server`, which bridges to the newer TS agent runtime), `tui`, `installer`, `adapters/`. |

---

*PROMETHEUS — bring AI tooling to your machine, gated by fire.*
