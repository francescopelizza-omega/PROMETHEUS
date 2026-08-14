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
kernel) — lives once in `packages/core` and is shared by every surface above, not
reimplemented per host.

> **Status:** active development. APIs and layout may change.
> **License:** [Apache-2.0](./LICENSE) — Copyright 2026 Francesco Pelizza ([NOTICE](./NOTICE)).
> The engine, `nemesis`, and the Studio desktop app/monorepo are Apache-2.0. The standalone,
> independently-publishable client packages — the `prometheus` CLI (`studio/apps/cli`), the
> VS Code extension (`studio/apps/vscode-extension`), and the `prometheus_plugin` cross-agent
> adapters (own [`LICENSE`](./prometheus_plugin/LICENSE)) — are MIT, so they can be embedded
> or redistributed with fewer conditions than the core project. Each package's own
> `license` field is the source of truth for that package.

---

## Table of contents

- [Why PROMETHEUS](#why-prometheus)
- [Architecture at a glance](#architecture-at-a-glance)
- [The engine — `prometheus.py`](#the-engine--prometheuspy)
- [The security gate — `nemesis`](#the-security-gate--nemesis)
- [Studio — the desktop app](#studio--the-desktop-app)
- [`prometheus` — the CLI / TUI](#prom--the-cli--tui)
- [The plugin — drive it from any AI agent](#the-plugin--drive-it-from-any-ai-agent)
- [Install & run](#install--run)
- [Configuration, state & exit codes](#configuration-state--exit-codes)
- [Security model](#security-model)
- [Honest limits](#honest-limits)
- [Repository layout](#repository-layout)

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

`studio/apps/cli` builds `prometheus` — a Node ≥20 terminal CLI with
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

## Install & run

> **Status of the published routes.** Neither published route works yet, and the reasons are
> unrelated to the code:
>
> - The `curl … install.sh` line below fetches from the `main` branch. `install.sh` is not on
>   `main` yet, so that URL 404/403s. Until it is pushed there, use **[From source](#from-source)**
>   or pass an explicit `--ref`.
> - The `npx -y @prometheus-plugin/*` commands 404 because those packages have **never been
>   published to npm**. Their manifests are publish-ready; the publish simply has not happened.
>   Until it does, register the MCP server from a source checkout (see
>   `prometheus_plugin/README.md`).
>
> `studio/scripts/release-preflight.mjs` checks both of these and fails loudly, so they cannot
> silently regress again once fixed.

### Quick install

```bash
curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | bash
```

Installs to `~/.prometheus`, links **`prometheus`** (CLI/TUI) and **`prometheus-app`**
(the Studio desktop app) into `~/.local/bin`, and adds that to your `PATH`. No `sudo`,
nothing written outside your home directory.

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

- **macOS or Linux** (Windows: use WSL), a stock **`python3`** (3.9+) — the engine and
  nemesis are standard-library only, **zero pip deps**.
- **Node ≥ 20** — the installer builds the CLI bundle from source. `pnpm` comes from
  `corepack`, which ships with Node.
- `git` on `PATH` (installs stage via git clone).

### 1) The engine directly (no build step)

```bash
python3 prometheus.py wizard            # interactive menu
python3 prometheus.py scan              # detect installed AI agents
python3 prometheus.py install caveman   # gated install into every supported agent
./nemesis scan owner/repo               # standalone security scan
```

### 2) Register into your AI agent (MCP)

```bash
npx -y @prometheus-plugin/installer --py "$PWD/prometheus.py"
```

### 3) Studio desktop (from source)

```bash
cd studio
corepack enable && pnpm install
pnpm dev                 # run the desktop app (electron-vite dev)
pnpm package             # build a distributable (staged engine + pyruntime + electron-builder)
```

### 4) `prometheus` CLI (from source)

```bash
cd studio
pnpm install
pnpm dev:cli             # run the CLI/TUI in dev
pnpm --filter @prometheus/cli run prepack   # build the bundle bin/prometheus launches
```

`bin/prometheus` and `bin/prometheus-app` work straight out of a checkout — put `bin/` on
your `PATH`, or let `./install.sh --from-local .` link them for you. Both resolve the
checkout from their own location, so symlinking them anywhere is safe.

> **macOS note:** a Finder/Dock-launched Studio build repairs its `PATH` at startup so
> Homebrew/`~/.local` tools (git, ollama, hf, …) are visible to the engine's install
> and detection steps.

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
to be writable to actually run — see `packages/core/src/agent/system/host/exec-sandbox.ts`'s
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
