# CLAUDE.md — working instructions for the PROMETHEUS repo

Read this before running anything. The rules in **Resource safety** are not style
preferences: violating them has repeatedly hard-locked the development machine.

---

## 1. What this project is

PROMETHEUS is an AI-native development platform with a fail-closed supply-chain gate in
the critical path. Everything routes through **`prometheus.py`** (the zero-dependency
Python engine, ~868 KB, repo root) and its **`nemesis`** security gate. The agent loop —
sub-agents, lifecycle hooks, cross-session memory, multi-provider models, per-command OS
sandbox — lives once in `studio/packages/core` and is shared by every surface.

| Surface | Path | Notes |
|---|---|---|
| Studio desktop IDE | `studio/apps/desktop` | Electron, hardened main + sandboxed renderer |
| `prometheus` CLI / TUI | `studio/apps/cli` | Full Studio feature parity |
| Plugin (MCP) | `prometheus_plugin`, `studio/apps/mcp-server` | Cross-agent bridge |
| VS Code extension | `studio/apps/vscode-extension` | Sidebar chat panel |
| JetBrains plugin | `studio/apps/jetbrains-plugin-DRAFT-UNTESTED` | Scaffold only — never compiled or run. Treat as unverified. |

Shared packages: `studio/packages/core`, `studio/packages/engine-bridge`,
`studio/packages/ui`. Python sidecar: `studio/python/sidecar`.

Licensing is mixed and deliberate: Apache-2.0 for the engine, `nemesis` and Studio;
MIT for `studio/apps/cli`, `studio/apps/vscode-extension` and `prometheus_plugin`. Each
package's own `license` field is the source of truth. `THIRD-PARTY-NOTICES.md` is a
redistribution obligation — never strip it.

Remote is **GitLab**, not GitHub: `gitlab.com/red-beard-phoenix/PROMETHEUS`.

---

## 2. STOP — resource safety (mandatory, not advisory)

There are TWO separate hazards here. They were conflated for days, and the wrong one got
all the attention. Keep them apart.

**Hazard A — the session killer (root cause FOUND and FIXED 2026-09-06).** The "lockups"
were not lockups. `model-server.test.ts` looped `[-1, 0, NaN, 2**40]` into `signalPid`,
which passed the value straight to `process.kill`. In `kill(2)` a pid of `-1` is not a
process, it is the BROADCAST — *every process this uid may signal* — so each run of that
suite SIGKILLed the whole logged-in session (Dock, Finder, WindowServer's clients, the
Terminal, the editor) and then asserted, truthfully, that nothing had thrown. It happened
four times: 2026-09-05 19:48:54 (147 processes), 23:13:22 (211), 2026-09-06 08:22:16 (140),
12:09:53 (64). The kernel logged every victim as `exited due to SIGKILL | sent by node[…]`.
The machine was never locked up and never panicked — it has no panic report in its entire
history. `signalPid` now refuses any pid that is not an integer greater than 1, and the
test asserts the refusal instead of tolerating the outcome.
**If a "lockup" happens again, this is the FIRST thing to check** — see 2.7 for the query.

**Hazard B — real memory starvation (NOT fixed, only guarded).** Separately and genuinely:
an UNSCOPED test run drove free RAM to **58.9 MB** at 2026-09-05 14:19:33 while
`llama-server` went 8.67 GB → 16.94 GB in two seconds. On Apple Silicon unified memory the
compositor starves before jetsam kills anything. That episode did NOT take the display
down and did not require a reboot, but it came close enough that everything in 2.2 and 2.3
stands unchanged. Treat those rules as a hard constraint on your own behaviour.

### 2.1 Pre-flight — run this before ANY command that builds, tests, or spawns processes

```bash
sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level ; pgrep -xl llama-server ; ollama ps 2>/dev/null
```

Decision rule, no exceptions:

- **Kernel memory pressure ≥ 2** (first number: 1 normal, 2 warning, 4 critical), **or
  kernel memory-free ≤ 25%** (second number) → do not run it. Report the numbers to the
  user and stop. (Only if `sysctl` cannot be read: fall back to free + speculative < 256 MB.)
- **`llama-server` running, or `ollama ps` lists a model** → do not run it. Tell the user
  what is loaded and ask. Never unload it yourself; it may be in deliberate use.
  **Since 2026-09-25 `scripts/run-tests.mjs` enforces this itself.** It used to enforce only the
  memory half of this rule, so this half depended on whoever happened to be reading — and on
  2026-09-25 a four-package sweep ran twice while qwen3.6 (26 GB) was resident. It now refuses
  with exit 2 and names what is holding memory. Override, deliberately separate from the
  full-suite switch so you do not have to give up the memory floor to get it:
  `PROMETHEUS_ALLOW_MODEL_RESIDENT=1`.
- **Run this pre-flight as its OWN command.** Putting it in the same shell invocation as the
  build or test is how it stops being a check: the output arrives with the damage already done
  and there is no point left at which anything can stop. That is exactly how the second
  2026-09-25 violation happened, an hour after the first one was acknowledged.
- **All clear** → proceed, one command at a time.

Until 2026-09-22 the first rule was "free + speculative < 4 GB". On this Mac that is the
normal state: the file cache keeps it at 0.9–1.5 GB while the kernel reports ~90% free.
It refused everything for the wrong reason. `scripts/run-tests.mjs` enforces the same
kernel rule, and so do the watchdogs (`handoffs/mem-guard-lib.sh`, §2.8).
Use `pgrep -x`, not `pgrep -f`: `-f` matches any process whose arguments merely contain
the word.

### 2.2 Never run these

| Forbidden | Use instead |
|---|---|
| `pnpm test` (root) | `node scripts/run-tests.mjs <path>` |
| `node scripts/run-tests.mjs` with no path | `node scripts/run-tests.mjs packages/core` |
| `pnpm typecheck` (root — three full `tsc` passes) | `pnpm --filter @prometheus/desktop run typecheck` |
| `pnpm package` | ask the user; this is a release action, not a verification step |
| `pnpm --filter @prometheus/desktop run e2e` | ask the user; launches real Electron repeatedly |
| `PROMETHEUS_ALLOW_FULL_SUITE=1 …` | never set this yourself — it exists for the user |

These are also blocked in `.claude/settings.local.json` under `permissions.deny`, and
`scripts/run-tests.mjs` refuses unscoped runs, low-memory runs, and runs started while a model
is resident, on its own. **Do not
route around either guard** — not with `env`, not by inlining the node command, not by
calling the runner through another script. If a guard fires, that is the correct outcome:
report it and stop.

### 2.3 Why the full suite is lethal here

`scripts/run-tests.mjs` sweeps **575 `*.test.ts(x)` files** and node:test forks one
process per file — observed: ~1,350 processes in two seconds. Separately, 20+ suites are
wired to a live ollama on `127.0.0.1:11434`
(`packages/core/src/modelhub/localai.test.ts`,
`apps/cli/src/session/model-candidates.test.ts`,
`apps/vscode-extension/src/model-discovery.test.ts`, and others). When one of them lands,
`llama-server` has been measured going 8.7 GB → 17 GB in two seconds. Fork storm plus
model load plus ~4.4 GB pinned as unpageable wired memory on the Neural Engine = display
death.

The runner now caps parallelism via `--test-concurrency` (default 4, override with
`PROMETHEUS_TEST_CONCURRENCY`). That helps; it does not make an unscoped run safe.

### 2.4 Verification discipline

After a change, verify with the **narrowest thing that proves it**, and stop there:

1. The single test file you touched.
2. If that passes and more coverage is genuinely needed, the one package.
3. Anything wider — ask the user first, and say what it will cost.

Do not "just run the whole suite to be sure". That instinct is what breaks this machine.
A green scoped run plus a clear statement of what was *not* covered is the correct
deliverable.

### 2.5 One heavy command at a time

Never run a build, a test run and a dev server concurrently, and never start a second
long-running command while one is still going. Wait for each to exit.

### 2.6 Python tests

Root `tests/` has 18 `test_*.py` suites; `studio/python/sidecar` has 16. These are cheap
compared to the node suites — a scoped `pytest tests/test_<name>.py` is fine. Still name
the file rather than running the directory.

### 2.7 If the machine locks up anyway

**Ask the kernel first. It has always known.** A mass-SIGKILL leaves an exact record, and
one query settles in seconds what took a multi-agent investigation to reconstruct:

```bash
log show --last 6h --style compact --predicate 'eventMessage CONTAINS "sent by node"' | head -40
log show --last 6h --style compact --predicate 'eventMessage CONTAINS "deny(1) signal"' | head -20
```

Hits mean Hazard A: some process broadcast a signal and killed the session. The victim
count and the killer's pid are right there. **Zero hits means it was not a mass kill** —
only then start looking at memory.

Two more things worth knowing before reasoning from the local logs:

- **The screen going black is usually just display sleep.** `did_power_off`,
  `IOAVVideoInterface terminated` and `unplug_gated: display HPD removed` in the event log
  are what a routine idle `displaysleep` looks like on this hardware. They are NOT evidence
  of a fault, and reading them as one cost days.
- **A watcher running in Terminal cannot survive Hazard A**, because Terminal is one of the
  things that gets killed. That is why every previous log ended mid-sentence a fraction of a
  second before the interesting part. `handoffs/prometheus-sentinel.sh` is therefore
  installed as a LaunchAgent (`~/Library/LaunchAgents/ai.prometheus.sentinel.plist`,
  `RunAtLoad` + `KeepAlive`), so launchd restarts it immediately after any such kill and its
  logs survive:

```bash
launchctl print gui/501/ai.prometheus.sentinel | grep -E 'state|pid'
tail -40 ~/ALPHA/PROMETHEUS/handoffs/sentinel/{state,events,actions}.log
```

  It records process + free-memory state every 2 s to `sentinel/state.log`, display/kernel
  events AND the shutdown path (launchd, loginwindow, shutdownd, softwareupdated, sysextd,
  powerd) to `sentinel/events.log`, and its own interventions to `sentinel/actions.log`.
  The shutdown-path stream was added after the first investigation found the old watcher
  could see the display die but never who requested it.

The older `handoffs/blackscreen-watch.sh` writes the same kind of state to
`~/blackscreen-state.log` / `~/blackscreen-events.log` but must be started by hand and dies
with its Terminal. Prefer the sentinel. macOS crash logs will be empty either way — there
has never been a panic on this machine; don't waste time there.

### 2.8 The standing memory guards (installed 2026-09-05)

Two scripts in `handoffs/` exist because guarding the test runner alone did not stop the
lockups. Do not remove or bypass them.

**`ollama-safe-limits.sh`** — caps ollama so it cannot exhaust unified memory:
one loaded model, one parallel request, 60s keep-alive, flash attention and a q8_0 KV
cache. Re-run it after an ollama upgrade, or after pulling a new model.

**There is no small context cap, and do not reintroduce one.** The script asks the
installed models what they support and uses the largest (262,144 here);
`PROMETHEUS_OLLAMA_CTX=<tokens>` overrides it in either direction.

The cap used to be 8192, and it was the bug, not the guard: Prometheus's own prompt
(system text + ~46 tool schemas) measures ~7.2k tokens, so a thinking model had ~900
tokens left, spent them reasoning, and was cut off mid-thought — turns that produced
nothing at all (2026-09-24). A limit that stops the work is not a safety device.

What a full context actually costs, measured rather than assumed — ollama's own log for
qwen3.6 (36B MoE) at 32768: `llama_kv_cache: size = 340.00 MiB ( 32768 cells, 10 layers …)`
with K and V at q8_0, i.e. **10.6 KB/token → ~2.7 GB at 262,144**. That model keeps KV on
10 of 40 layers; gemma4 keeps most layers on a sliding window. Full windows cost GBs, not
the tens of GBs the old cap implied. Before assuming a model is expensive, read its
`llama_kv_cache: size` line in `~/.ollama/logs/server.log` — it is always there.

Memory is protected by `ram-guard.sh` firing on real kernel pressure (§2.8 below), by one
model resident at a time, and by ollama's own allocation failing loudly — never by a
number small enough to break the client. `PROMETHEUS_OLLAMA_CAPS`
(`studio/packages/engine-bridge/src/model-server.ts`) carries a generous default for a
daemon Prometheus starts itself.

The caps were silently gone from 2026-09-16 to 2026-09-22, for two reasons that still apply:
`launchctl setenv` does not survive a reboot, and the server on `:11434` is **Ollama.app's**,
whose Context length slider overrides `OLLAMA_CONTEXT_LENGTH` (it was sending 262144). So
the LaunchAgent `ai.prometheus.ollama-limits` re-applies the env at every login, and the
script pins `settings.context_length` in the app's `db.sqlite`. **Moving that slider undoes
the cap.** The brew `ollama` service is stopped on purpose: it fought the app for the port
and crash-looped 36,135 times. Check the live values, not the script:
`ps eww -p $(pgrep -f 'ollama serve') | tr ' ' '\n' | grep OLLAMA_`.

**`ram-guard.sh`** — a watchdog. Polls every two seconds and kills `llama-server` /
`ollama runner` (matched by process name, never by a substring of the command line) when
a model server is running AND the kernel reports memory pressure ≥ warning, OR kernel
memory-free ≤ 15%, OR free + speculative < 256 MB while kernel memory-free is ≤ 25%. It
logs to `~/ram-guard.log`, with a `SAMPLE` line of all three numbers every minute. The rule
lives in `mem-guard-lib.sh`, shared with the sentinel's own kill branch. Until 2026-09-22
both guards used "free < 3 GB", which on this Mac is true almost all the time (file cache).
They fired on nearly every poll and killed every model within seconds of loading it. Low
free memory ALONE is not a danger sign either: loading a 23 GB model drained free +
speculative to 44 MB while the kernel still reported 57% free (2026-09-22).
It targets ONLY known model-server processes; it never touches the user's applications.
It runs as the LaunchAgent `ai.prometheus.ram-guard` (`RunAtLoad` + `KeepAlive`). The
hand-started copy died in the 2026-09-16 reboot and stayed dead for six days.

If a lockup happens with both running, read `~/ram-guard.log` first. An `ACT:` line means
the guard fired and the culprit is named there. NO `ACT:` line means memory was not the
cause this time — do not assume it was.

## 3. Toolchain

- **Node 22** (`.nvmrc`). `engines.node >= 22.6` and `engineStrict: true`, so a wrong
  runtime is a hard install error. Homebrew's node may be much newer — check `node -v`
  before an install, and use Node 22 if `pnpm install` misbehaves.
- **pnpm 10.34.3**, `nodeLinker: isolated`, `shamefullyHoist: false`. A package may import
  only what it declares. This is the dependency boundary made physical — do not "fix" a
  missing import by hoisting.
- **Settings live in `studio/pnpm-workspace.yaml`, not `.npmrc` or `package.json`.**
  Overrides (`boolean: 3.2.0`) and `onlyBuiltDependencies` (`@biomejs/biome`, `electron`,
  `esbuild`, `node-pty`) are there. pnpm 10 blocks dependency lifecycle scripts silently by
  default; a package needing its postinstall must be added to that list or it will fail in
  confusing ways.
- **Electron 44.2.0** (upgraded from 33 on 2026-09-05), electron-builder 26,
  electron-vite 5, Playwright 1.63, Vite 5. `electron-vite@5` accepts Vite 5/6/7, so Vite
  does not need to move in lockstep.
- **Biome** for lint/format — not ESLint, not Prettier.
- **ripgrep (`rg`) is a hard prerequisite.** The `glob` host tool shells out to it, and
  `packages/core/.../system-tools.test.ts` fails without it (`spawn failed (ripgrep is not
  installed on this machine)`). Install with `brew install ripgrep`. A failure naming
  ripgrep is an ENVIRONMENT gap — never "fix" it by changing the test or the tool.
- `node-pty` is an optional native addon. If installed it must be rebuilt against
  Electron's Node ABI; `apps/desktop/scripts/fix-pty-helper.mjs` runs on postinstall.

Common commands, all from `studio/`:

```bash
pnpm --filter @prometheus/desktop run typecheck
pnpm --filter @prometheus/desktop run build
pnpm --filter @prometheus/desktop run dev
pnpm lint                      # biome + no-raw-hex + layout-rules
pnpm format
```

---

## 4. Conventions and invariants

- **No raw hex colours.** `scripts/check-no-raw-hex.mjs` gates this; use design tokens.
- **Layout rules** are enforced by `scripts/check-layout-rules.mjs`. Both run as part of
  `pnpm lint` and `pnpm test` — run `pnpm lint` after UI changes.
- **The renderer is a sandboxed view.** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, preload + CSP. Only `main/index.ts` and `main/ipc.ts` may import
  `engine-bridge` and `core`. The renderer reaches the engine exclusively across the typed
  `contextBridge` seam. Do not widen this to make something easier.
- **Comments in this repo are load-bearing.** `.gitignore`, `pnpm-workspace.yaml` and
  `apps/desktop/package.json` carry long explanations of why a rule exists and what broke
  without it. Read them before changing the rule, and update them in the same commit if
  the reasoning changes.
- Working notes are gitignored by pattern: `/*-PLAN.md`, `/*-REPORT.md`, `/*-AUDIT.md`,
  `/*-NOTES.md`, `/notes/`, `/handoff*/`. Name new internal docs to match so they stay
  out of the published repo. `/MDS/`, `/AI_SKILLS_WONDERLAND/` and `.claude/` are
  local-only too.
- `studio/apps/desktop/release/`, `studio/apps/vscode-extension/.vscode-test/` and
  `studio/staging/` are gitignored build output — roughly 4.2 GB of the repo's 7.9 GB.
  Never edit anything in them; never commit them.

---

## 5. Security posture

Security is the product here, not a side concern.

- `nemesis` is a fail-closed gate: fetched code is scanned before it is allowed to execute.
  Do not add a bypass, a "dev mode" skip, or a default-allow branch.
- `scripts/secret-scan.sh` + `.gitleaks.toml` — the config is the durable artifact; scan
  output under `/.security/` is gitignored and regenerated.
- `scripts/check-personal-data.sh` and `scripts/verify-no-orphans.sh` exist for a reason;
  run them before anything that touches published content.
- MCP server definitions carry a `gate` verdict. Entries marked `blocked` are blocked
  deliberately — including deliberately hostile fixtures. Never enable one to "test" it.

---

## 6. Working style in this repo

- Prefer editing in place with a command or script that reads the file itself. Never
  reconstruct a large file from earlier tool output — `prometheus.py` alone is 868 KB and
  will have been truncated.
- Change one of the user's files in place only when asked to change that file. Cleaned or
  converted versions go beside the original under a new name.
- After a fix, verify with the *narrowest* thing that proves it: the single test file, then
  the package. Escalate only if asked.
- Prefer `cd studio && claude` when the work is confined to the monorepo — that project's
  session history is small and it has never destabilised the machine.
- Use `/clear` between unrelated tasks. Long sessions in this repo accumulate very large
  transcripts because file reads here are big.
- State assumptions explicitly when a command could be expensive, and ask before running it.
