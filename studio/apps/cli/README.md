# @prometheus/cli — `prometheus`

The Prometheus Studio terminal CLI. A hand-rolled, **zero-runtime-dependency** Node CLI
(Node built-ins only, ESM) that renders inventory + security verdicts over
`@prometheus/engine-bridge` and the C11 provider policy from `@prometheus/core`.

Per the GOLDEN RULE (C5) the CLI **never decides safety** — it renders the verdict the
engine / nemesis produced and mirrors the decision tier into its exit code.

The CLI has **full feature parity with the Studio GUI**: anything a GUI panel can do, a
`prometheus` verb can do, because both route through the one `@prometheus/core` parity registry
(single-token verbs) or the same engine/sidecar bridges (the §2 trees).

## Install

Requires **Node ≥ 20**. The published package is a single self-contained bundle with
**zero runtime dependencies** — install is instant.

```sh
npm install -g @prometheus/cli      # global: adds `prometheus` (and `prometheus`) to PATH
prometheus --version
prometheus help

npx --yes @prometheus/cli help      # one-off, no install
```

**Single binary (no Node needed).** A self-contained `prometheus` executable is built via Node SEA
(`pnpm --filter @prometheus/cli build:sea`, output under `release/`). Drop it on your `PATH` and
run it like any binary — no `node`, no `node_modules`, no repo checkout:

```sh
install -m 0755 prom-darwin-arm64 /usr/local/bin/prometheus
prometheus --version
```

### The engine (required for scan / gate / install)

`prometheus` renders verdicts the **Prometheus engine** (`prometheus.py` + `nemesis`) produces —
that engine is **not** bundled in the npm package. `prometheus` locates it in this order
(`doctor-bridge.ts` / engine-bridge `locate.ts`): the **`PROMETHEUS_PY`** env var
(and **`NEMESIS_BIN`** for the scanner) → a sibling checkout → your **`PATH`**. If none
resolve, `prometheus doctor` reports the miss **loudly** and engine-backed verbs fail closed —
they never silently "pass". Point `prometheus` at your engine with:

```sh
export PROMETHEUS_PY=/path/to/prometheus.py
export NEMESIS_BIN=/path/to/nemesis          # optional; falls back to PATH
prometheus doctor --bridge                          # verify the engine handshake
```

The interactive full-screen **Ink REPL** is optional and loaded lazily; without `ink`/
`react` present, `prometheus` uses the built-in one-shot session (no error). Install them
alongside (`npm i ink react`) only if you want the full-screen view.

## Shell completions

`prometheus completion <bash|zsh|fish>` prints a completion script generated from the SAME command
registry the CLI itself uses — it never goes stale as commands are added.

```sh
# bash — in ~/.bashrc
eval "$(prometheus completion bash)"

# zsh — save on the fpath BEFORE compinit (the robust convention), or eval in ~/.zshrc
prometheus completion zsh > "${fpath[1]}/_prom"    # then: compinit

# fish — auto-loaded, no eval
prometheus completion fish > ~/.config/fish/completions/prometheus.fish
```

A roff **man page** comes from the same registry: `prometheus man > prometheus.1` (view with `prometheus man | man -l -`).

## Interactive session

```sh
prometheus                       # bare → unified single-window session (chat + agent loop + panes)
prometheus session [--tmux [N]]  # span MANY tmux windows when enabled (--tmux / PROMETHEUS_TMUX=1)
prometheus chat --cli claude [--open|--tmux]   # preview the injection-safe launch, then open a live terminal
```

A bare `prometheus` on a TTY opens the readline session (catalog / models / env / security / health
panes + slash + `/help`); without tmux it stays single-window, with tmux enabled it fans out.

## Commands

| area | verbs |
|---|---|
| **inventory / catalog** | `scan` · `superscan` · `matrix` · `list` · `info <n>` · `describe`/`tutorial`/`methods <id>` · `where <n>` |
| **lifecycle** | `install`/`uninstall <name>` `[--only --skip --host --arm]` · `enable`/`disable <name>` `[--component hooks\|mcp --host]` · `bundle` · `sync` · `plugin`/`skill`/`app`/`worldsim` `<action>` |
| **security** | `gate <t>` · `secure scan <t>` · `secure db [status\|update]` · `secure trust [list\|log\|verify <f>\|revoke <n>]` · `secure disinfect <t> --out D` · `secure quarantine [list\|restore <id>]` · `harden` · `audit <name>` |
| **environments** | `env <list\|create\|clone\|delete\|use\|export\|import\|doctor\|add\|remove\|update\|upgrade\|enable\|disable\|cuda>` (over `envmgr.py`) |
| **models** | `model <hw\|list\|search\|fit\|pull\|remove\|serve\|endpoints\|repoint>` (over `modelhub.py`) · `models <…> --set-root DIR` (model-running tools) |
| **repos** | `repo <add\|list\|status\|update\|pin\|branch\|rescan\|remove\|vault>` (over `repo.py`, the only arbitrary-URL clone path — nemesis-gated) |
| **privacy** | `metadata <inspect\|scrub\|edit\|timestomp> <file>` (over `metadata.py`) |
| **providers / system** | `provider list` (C11 Tier-A first) · `doctor [--bridge]` · `pentest <action>` · `version` · `help` |

### Mutating verbs: preview → execute

Every state-changing sidecar/remediation verb **previews by default** (prints the exact plan,
touches nothing) and only executes when you pass `--yes`; the engine/sidecar still runs the
**real nemesis gate** on execute (C5). `--force` overrides a nemesis BLOCK and is hard-blocked
under the non-interactive `ci` profile unless `PROM_ALLOW_FORCE=1` (never-force / gate-first).

```sh
prometheus repo add https://github.com/x/y          # PREVIEW — nothing cloned
prometheus repo add https://github.com/x/y --yes     # stage → gate → promote | quarantine
prometheus env create ml --python 3.11 --yes         # create the venv
prometheus metadata scrub photo.jpg --yes            # strip metadata (copy-then-replace; original safe)
```

### `prometheus gate` exit codes (mirror nemesis decision tiers)

```
allow -> 0    warn -> 10    block -> 20    error (fail-closed BLOCK) -> 2
```

A missing / timed-out / unparseable nemesis collapses to verdict `error` (exit 2): the
CLI fails closed and never reports "safe" on a broken scanner.

## Global flags

```
--json        emit ONE machine JSON object instead of pretty output
--no-color    disable ANSI color (also auto-off when piped / NO_COLOR / not a TTY)
-h, --help    usage
-v, --version version
```

## Run it

Production build (compiled to `dist/bin.js`, wired as the `prometheus` bin):

```sh
pnpm -C apps/cli build   # tsc -b  ->  dist/bin.js
node apps/cli/dist/bin.js scan
```

Dev / no-build (runs straight from TS source under Node 20+ native type-stripping via a
tiny workspace resolver hook — no `node_modules` needed):

```sh
node --import ./dev-register.mjs src/bin.ts scan
node --import ./dev-register.mjs src/bin.ts gate /path/to/repo
pnpm -C apps/cli test    # node:test suite (parser + live engine smoke)
```

## Layout

```
src/
  bin.ts            entrypoint (shebang; argv read, color setup, print, exit code)
  index.ts          command dispatcher (parse -> command -> outcome)  [testable core]
  parse.ts          hand-rolled arg parser (zero deps)
  render.ts         ANSI color + ANSI-aware table helpers (zero deps)
  verdict-view.ts   C3 verdict rendering + tier->exit-code mapping
  context.ts        per-invocation context (the single EngineClient) + error mapping
  sidecar.ts        envmgr.py / modelhub.py runner (C7 one-JSON-object, fail-closed)
  commands/*.ts     one module per command
  cli.test.ts       node:test (no framework): parser + verdict + live scan/env smoke
dev-resolver.mjs    dev-only: maps @prometheus/* bare specifiers + .js->.ts to source
dev-register.mjs    dev-only: registers the resolver for `node --import`
```
