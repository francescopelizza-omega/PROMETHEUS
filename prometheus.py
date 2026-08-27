#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""
================================================================================
 prometheus.py  —  Universal AI-agent plugin installer
================================================================================

README
------
Prometheus brings fire (plugins) to every AI coding agent on your machine.

It is a single self-contained installer that:
  1. SCANS the PC for installed AI agents — standalone CLIs (claude, codex,
     cursor, gemini, ...) AND IDE-embedded agents: the JetBrains IDE family
     (IntelliJ, PyCharm, WebStorm, GoLand, Rider, CLion, ...) and the
     JetBrains AIR multi-agentic IDE.
  2. Installs each requested plugin into EVERY detected agent that supports it,
     using that agent's own native plugin mechanism.

Plugins are therefore not Claude-only: the same plugin can land in a terminal
CLI agent and inside a JetBrains IDE / JetBrains AIR, wherever the host exposes
an install path.

It is OS-aware (macOS vs Linux), idempotent (re-run = no-op, not error), and
driven by two registries so adding an agent or a plugin later is a one-entry
change — no new code paths.

Catalog model (two sections + a documented-only list)
-----------------------------------------------------
  * OFFICIAL BUNDLE  : anthropics/* plugins (tier="official", bundle=True).
                       Auto-trusted, Claude-native, installed in ONE run via
                       `bundle` / `install official-bundle` / the wizard.
  * EXTERNAL PLUGINS : third-party (community / devtool). Ranked, opt-in, and
                       ALWAYS scanned + gated. A plugin marked claude_exclusive
                       installs into claude only; a universal one installs AND
                       uninstalls into EVERY detected compatible agent using the
                       repo's OWN official mechanism (universal_skill / shell).
  * DOCUMENTED-ONLY  : never installed (aggregators, self-hosted apps, paid
                       SaaS, deprecated). The wizard shows an info card + manual
                       pointer only. Files 25 (ECC-Tools, paid) & 26 (odysseus,
                       self-hosted) live here and are EXCLUDED from install.

  Each markdown dossier in AI_SKILLS_WONDERLAND/ maps to one Plugin() inserted
  into OFFICIAL_BUNDLE or EXTERNAL_PLUGINS (clearly-marked INSERT slots).

This first version ships with:
  * HOSTS  : claude (fully wired); codex / cursor / gemini and the JetBrains
             IDEs + JetBrains AIR are DETECTED, with install adapters stubbed
             until each one's plugin mechanism is added.
  * PLUGINS: CAVEMAN  (https://github.com/JuliusBrussee/caveman) — example
             external entry; the official bundle + ranked external plugins get
             inserted from the dossiers, one Plugin() per md.

Host kinds
----------
  * cli  : standalone terminal agent (claude, codex, gemini, cursor-agent).
  * ide  : plugin installs into an IDE that embeds an AI agent — the JetBrains
           family (IntelliJ/PyCharm/WebStorm/... via Toolbox launchers or the
           JetBrains config dir) and JetBrains AIR. IDE plugin formats differ
           from CLI ones, so their adapters are wired per-host when known.

Why Python instead of Bash
---------------------------
  * Two structured registries (hosts, plugins) + a per-host install matrix.
    Python holds that cleanly; Bash arrays-of-structs rot at scale.
  * argparse gives a real subcommand help menu for free.
  * try/except lets one failed (agent, plugin) pair not abort the rest.
  * Still shells out (subprocess) to each agent's CLI / git / brew / apt.
  * Standard library only — runs on stock macOS/Linux python3, zero deps.

Model: hosts x plugins
----------------------
  A PLUGIN declares a `targets` map: host-name -> InstallSpec. At install time
  Prometheus intersects (detected hosts) ∩ (plugin targets) and runs each spec.
  A plugin that only supports claude installs only into claude; one that
  supports all four installs into whichever of the four are present.

How CAVEMAN installs into claude (reference)
--------------------------------------------
  Claude Code plugins live in a "marketplace" (a GitHub repo), installed by id:

      claude plugin marketplace add JuliusBrussee/caveman
      claude plugin install caveman@caveman --scope user

  Prometheus first reads claude's on-disk state files
  (~/.claude/plugins/known_marketplaces.json, installed_plugins.json) so a
  re-run is a no-op. Other agents use their own mechanisms (added later).

Quick start
-----------
      python3 prometheus.py wizard              # interactive terminal GUI menu
      python3 prometheus.py scan                # list detected AI agents
      python3 prometheus.py list                # registry + per-host state
      python3 prometheus.py bundle              # official Anthropic bundle, one run
      python3 prometheus.py install caveman     # into every supported agent
      python3 prometheus.py install all          # every plugin, every agent
      python3 prometheus.py uninstall caveman    # remove from detected agents
      python3 prometheus.py doctor               # environment check
      python3 prometheus.py info caveman         # plugin details
      python3 prometheus.py audit caveman        # security-scan, no install
      python3 prometheus.py models               # 3rd functionality: local-model tools (AirLLM/FlashAttention/Odysseus)
      python3 prometheus.py apps                 # 4th functionality: self-hosted apps & repos (full lifecycle, safest-first)
      python3 prometheus.py apps wizard          # guided install/update/rollback/uninstall for the apps
      python3 prometheus.py pentest              # 5th functionality: AUTHORIZED pentest tools/AIs in an armored sandbox
      python3 prometheus.py --help               # full help menu

Security scanner (pre-install audit)
------------------------------------
  Every install artifact is UNTRUSTED — a single bash installer, a git-clone
  payload in any language, or shell steps. Before any adapter runs, Prometheus:
    1. Fetches the artifacts (on-disk marketplace dir, or a temp shallow clone
       of the repo, or the literal shell command strings).
    2. Walks every script / hook / manifest and runs a severity-scored rule
       engine: destructive FS, pipe-to-shell, privilege escalation, persistence
       (cron/launchd/rc-files/ssh-keys/git+agent hooks), reverse shells, exfil,
       obfuscation (base64-decode-exec, high-entropy blobs), credential access,
       and OS-security tampering (SIP/Gatekeeper/firewall, history wipe).
    3. Gates the install:
         critical   -> BLOCK   (override only with --force-unsafe)
         high/medium-> CONFIRM (interactive y/N; auto-approve with --yes)
         low/clean  -> proceed
       --strict promotes medium to block-worthy. Non-interactive shells without
       --yes default to NO.
    4. Remembers approved (plugin + source commit) in
       ~/.config/prometheus/trust.json so unchanged code is not re-warned.
       `audit <name> --revoke` forgets it.

  Context discrimination (low false positives): a pattern match only counts if
  it is EXECUTABLE install code. Matches inside comments, markdown/docs, test
  files, or CI workflows are suppressed to "info" and do not drive the verdict.
  For path-presence rules (hooks/credentials/history), a match inside a string
  literal or an echo/print/log message is treated as a MENTION, not an action,
  and suppressed too — while a bare action (`cat ~/.aws/credentials`,
  `cp x ~/.claude/hooks/`) still fires. Use `--show-info` to see suppressed hits.

  This is heuristic static analysis, not a sandbox: a clean verdict means "no
  known-bad patterns in executable install code", not "proven safe". `audit`
  runs the same scan without installing.

Targeting + safety flags
------------------------
      --host claude         restrict actions to one agent (repeatable)
      --dry-run             print actions, change nothing
      --verbose             echo every shell command + output
      --force               reinstall even if already present
      --no-color            plain output (auto-off when not a TTY)
      --no-scan             skip the security scan (loud, discouraged)
      --yes                 auto-approve non-critical findings (no prompt)
      --strict              block on medium-or-higher findings too
      --force-unsafe        override a BLOCK on critical/strict findings
      --show-info           also list context-suppressed (comment/doc/test) hits

Exit codes
----------
      0  success / nothing to do
      1  one or more (agent, plugin) installs failed
      2  bad usage / unsupported OS / missing prerequisite

Extending (for future runs)
---------------------------
  Add an AGENT  : append an AIHost(...) to HOSTS (detection = CLI name(s)).
  Add a PLUGIN  : append a Plugin(...) to PLUGINS with a `targets` map.
  Add a host's install mechanism: implement an adapter in the _HOST_ADAPTERS
  table keyed by (host, method). No other code should need to change.

================================================================================
 COMPLETE OPERATOR MANUAL  —  prometheus.py · nemesis · prometheus_plugin
================================================================================
Everything this tool does, explained in-file so reading prometheus.py alone is
enough. Three parts: (A) the prometheus.py installer/manager, (B) the nemesis
security gate it runs before any fetched code is trusted, (C) the
prometheus_plugin packages that expose all of this to AI agent CLIs + a GUI.

--------------------------------------------------------------------------------
 PART A — prometheus.py : the universal installer & manager
--------------------------------------------------------------------------------
WHAT IT IS
  One stdlib-only Python script (zero pip deps) that detects every AI coding
  agent on the machine and installs / uninstalls / manages plugins, skills,
  local-model tooling, self-hosted apps, pentest sandboxes, world-sim engines and
  an offline repo vault into each one — using each agent's OWN native mechanism.
  Idempotent (re-run = no-op, never an error), OS-aware (macOS / Linux), and
  fail-closed on security (see PART B).

INVOCATION
  python3 prometheus.py [GLOBAL FLAGS] <command> [args]
  Global flags must come BEFORE the command (argparse). `<command> --help` for
  per-command options. `python3 prometheus.py wizard` for an interactive menu.

THE COMMANDS  (grouped; the "(n) name" tags match the numbered functionalities)

  Discovery / inspection
    scan            detect the AI agent CLIs installed on this machine
    superscan       P5 deep inventory: every agent installed / absent / forgotten
                    + counts + per-agent prerequisites
    inventory       re-scan each detected agent for ALL plugins/skills/MCP it
                    carries — managed by prometheus AND foreign (--host to narrow)
    matrix          reach matrix — which tool can install into which agent
                    (native / sync / no)
    where  <name>   where a tool WOULD install (scope + per-agent path), before
                    you commit to installing it
    list            registered plugins + per-agent install state
    status <name>   install + enabled/disabled state of a plugin & its components
                    ('all' for everything)
    info   <name>   full details of one plugin
    doctor          environment check (OS, agents, git, paths)

  (1-2) Plugins / skills — the core install engine
    wizard          interactive terminal menu (browse / install / uninstall)
    bundle          install the official Anthropic plugin bundle in one run
    install   <name>   install into every supported detected agent.
                       names: a plugin, 'all', 'official-bundle', or a SUBSET as
                       'plugin:comp1,comp2'.  flags: --host (repeatable), --only,
                       --skip, --arm (auto-arm so it self-fires)
    uninstall <name>   remove from detected agents (same name forms; --only/--skip)
    enable    <name>   re-arm a disabled plugin/component (--only, --component
                       {hooks,mcp}, --host for a foreign item)
    disable   <name>   turn off WITHOUT uninstalling — reversible (same flags)
    skills <action>    manage installed SKILL.md folders (~/.claude/skills/):
                       list | enable | disable | mute | unmute [skill]
    scaffold-skill <name>  write a new auto-firing SKILL.md (--description = the
                       'Use when …' trigger, --body = the instructions)
    sync               replicate an installed SKILL.md into other agents
    audit  <name>      run the security scan on a plugin's artifacts, NO install
                       ('all' allowed; --revoke clears remembered trust)

  (3) models    install local/cloud model-running tools (AirLLM, FlashAttention,
                Odysseus, ...) — gated like every other source
  (4) apps      install/manage self-hosted apps & repos (yt-dlp, ollama, n8n,
                penpot, plausible, bitwarden, ...) — safest-method-first, full
                lifecycle (install/update/rollback/uninstall); `apps wizard` guides it
  (5) pentest   AUTHORIZED pentest tools + AIs, each run inside a strongly armored
                sandbox (airgapped by default, Rules-of-Engagement gated). actions:
                list/wizard/scope/status/runtimes/build/install/uninstall/shell/run/
                destroy/enable/disable/logs/update; --kali, --allow-net (in-scope
                egress only), --init (rewrite ROE), `run -- <cmd>` into the sandbox
  (7) vault     offline versioned ZIP archive of every repo (re-pulls only when
                GitHub has a newer version). subcommand: `vault <list|status|invoke|
                invoke-all|rollback>`. Equivalent top-level interactive wizards
                (work with or without a subcommand): --invoke / --invoke-all /
                --rollback
  (8) worldsim  install/manage agent-based World-Simulation & Understanding engines
                (MiroFish, ...) via docker-compose, safest-first lifecycle
      localai   audit every AI repo (paid-API vs free-local) + a catalog of
                open-source models + the exact recipe to re-point a paid API at a
                free OpenAI-compatible model
      purge     back up + remove a forgotten agent's config/state (NOT its binary)
      schedule  scaffold a scheduled headless watcher (cron/launchd), confirm-gated
                (--name, --interval, --cron)

GLOBAL FLAGS
  Behaviour : --dry-run  --verbose  --force  --no-color  --version
  Machine   : --json   emit ONE JSON object on stdout and route ALL human/log text
                       to stderr — the bridge contract for the MCP server + Ink TUI
                       (PART C). Must precede the command.
  Security  : --no-scan      skip the built-in regex pre-scan (the deep nemesis
                             gate STILL runs)
              --no-gate       disable the nemesis gate this run (= PROMETHEUS_GATE=off)
              --gate-mode M   enforce | warn | off
              --gate-fresh    force a full feed re-download + bypass the verdict cache
              --yes           auto-approve non-critical findings (no prompt)
              --strict        treat MEDIUM findings as block-worthy too
              --force         override a nemesis BLOCK (dangerous code) — see the
                             AUTOMATIC SECURITY WORKFLOW below. Also reinstalls.
              --force-unsafe  alias of --force for the block override
              --show-info     also show context-suppressed (comment/doc/test/CI) hits

ENV VARS
  PROMETHEUS_GATE = enforce|warn|off   default gate behaviour (CLI flags override)
  NEMESIS_BIN     = /path/to/nemesis   explicit scanner location (else: this
                                       script's dir, then PATH)
  PROMETHEUS_PY   = /path/prometheus.py used by the plugin layer (PART C) to locate
                                        this script

STATE ON DISK
  ~/.config/prometheus/trust.json                  approved (plugin + source commit)
  ~/.config/prometheus/nemesis-policy-<tier>.json  per-tier gate policy
  ~/.nemesis/gate-audit.jsonl                      append-only signed gate decisions

EXIT CODES
  0 success / nothing to do   ·   1 one or more installs failed   ·
  2 bad usage / unsupported OS / missing prerequisite / gate BLOCK

TYPICAL FLOW
  python3 prometheus.py superscan          # what agents do I have?
  python3 prometheus.py where caveman      # where would it land?
  python3 prometheus.py audit caveman      # is the source safe? (no install)
  python3 prometheus.py install caveman    # install (auto-gated) everywhere
  python3 prometheus.py status caveman     # confirm + inspect components

--------------------------------------------------------------------------------
 PART B — nemesis : the supply-chain security gate
--------------------------------------------------------------------------------
WHAT IT IS
  `nemesis` is a separate, stdlib-only (also zero-dep) malware / supply-chain
  scanner that ships next to this file. EVERY install path in prometheus runs the
  fetched code through nemesis BEFORE a single line of it can execute. Prometheus
  treats every artifact — a bash installer, a git clone in any language, a
  docker-compose, a downloaded ZIP, even a piped installer body — as untrusted.

AUTOMATIC SECURITY WORKFLOW  (runs on EVERY install — script OR plugin)
  The moment a source is chosen to install, before anything is trusted:
    1. PREPARE — prepare_nemesis() seeds the signature DB on first ever use, or
       refreshes it when stale, so the scan scores against the latest feeds.
       Idempotent (nemesis `update` TTL-skips fresh feeds, so repeats are cheap);
       best-effort (offline with an existing DB → proceed; first-use offline →
       static analysis still gates). `--gate-fresh` forces a full re-download.
    2. SCAN + SCORE — nemesis scans the fetched code and returns a verdict + a
       0-100 risk score:
         allow  -> SAFE: install proceeds.
         warn   -> RISKY: "some risk can't be cleared" — prompt, DEFAULT NO
                   (non-interactive without --yes refuses).
         block  -> DANGEROUS / "better not to install": prometheus AVOIDS it.
    3. FORCE PATH — to install a BLOCKed (dangerous) source anyway, the operator
       must explicitly override:
         script :  re-run with  --force
         plugin :  call  /prometheus --force
       A deep-red ☠ DANGER banner is shown; on a TTY a typed 'install-dangerous'
       confirmation is required; the override is written to the gate-audit log and
       surfaced in the --json result as `forced_danger` (ok:false). WITHOUT --force,
       red-flagged dangerous code is never installed.

HOW PROMETHEUS USES IT   (nemesis_gate() / enforce_gate())
  Per source, prometheus runs (subprocess, fail-closed):
      nemesis gate <target> --sandbox auto --jail auto --timeout 840 --sign \
                            [--policy <tier-file>] [--no-cache]
  and parses the ONE JSON verdict. `<target>` is a STAGED clone, a downloaded
  file, or `-` (the code is streamed in on stdin and never lands on disk). The
  gate runs AFTER fetch but BEFORE the code is moved into place or executed.

  FAIL-CLOSED: if nemesis is missing, errors, times out, or returns unparseable
  output, the verdict is "error" and the install is BLOCKED. A missing scanner
  never silently passes. Override only with --no-gate / PROMETHEUS_GATE=off.

VERDICT TIERS
  allow  -> proceed
  warn   -> if it carries CRITICAL/HIGH findings (or MEDIUM under --strict) it
            prompts and DEFAULTS TO NO. Non-interactive without --yes refuses;
            --strict blocks outright unless --force-unsafe.
  block  -> install ABORTED (exit 2) — dangerous. Override only with --force
            (deep-red banner + typed confirm). Inspect it: nemesis ui <target>
  Approved verdicts are remembered (bound to the source commit) in trust.json so
  unchanged code is not re-prompted; `audit <name> --revoke` forgets it.

WHAT NEMESIS DETECTS  (high level — the `nemesis` file holds the full rule set)
  Droppers (curl|sh), reverse shells, miners, persistence (cron/launchd/systemd/
  rc-files/ssh/git-hooks), credential + keychain + browser-cookie theft, env-var
  exfil, npm/pip/setup.py/pyproject install-time hooks, CI/CD attack surface
  (pull_request_target, unpinned actions, untrusted-input interpolation), git
  config weaponization, obfuscation (base64/hex/charcode/concat — with a real
  decode-and-recurse pass), archive threats (zip/tar/rar/7z/zst/... incl. nested),
  SCA dependency CVEs (OSV + CISA-KEV), and ClamAV body-pattern signatures. Each
  verdict is HMAC-signed so a stored / transported verdict is tamper-evident.

GITHUB-SHIELD HARDENING  (from a 22-agent adversarial maturity audit)
  - Clone-time TOCTOU closed: every git clone/pull here runs with
    core.hooksPath=/dev/null, core.fsmonitor= , protocol.ext.allow=never and
    --no-recurse-submodules (_GIT_SAFE_FLAGS / _git_clone_argv) so NOTHING in the
    fetched repo (a checkout hook, an fsmonitor program, an ext:: submodule) can
    execute before nemesis has scanned the staged tree.
  - pyproject PEP-517 build hooks scanned (in-tree backend-path, custom
    build-backend, before-build shell) — closes "code runs at pip install time".
  - Dynamic shell sinks caught at the AST level: os.system / os.popen /
    subprocess.getoutput with a runtime-built command — the classic way a
    `curl URL | sh` is reassembled from separate variables to dodge line-regex.

STANDALONE NEMESIS  (use it directly, any time)
  nemesis scan <dir|owner/repo|git-url>   scan a tree or a remote repo (never run)
  nemesis gate <target>                   one JSON verdict + exit 0/10/20/2
  nemesis ui  [dir]                       interactive browse + remediate
  nemesis update                          refresh signature / CVE / KEV feeds
  nemesis verify <verdict.json>           check a signed verdict
  nemesis selftest                        offline self-check (must stay green)

HONEST LIMITS
  nemesis is heuristic + signature static analysis, NOT a sandbox. A clean
  "allow" means "no KNOWN-pattern threat", never "proven safe". It cannot see a
  payload fetched at runtime from a clean host, a targeted novel evasion tuned
  against its thresholds, or a native/compiled blob's behaviour. Use it as strong
  defense-in-depth: run untrusted sources --strict, `nemesis update` first, pin
  commit SHAs, install as a non-privileged user / in a container, and human-review
  the diff for anything you are about to grant credentials to.

--------------------------------------------------------------------------------
 PART C — prometheus_plugin : drive all of this from any AI agent CLI
--------------------------------------------------------------------------------
WHAT IT IS  (subfolder prometheus_plugin/)
  A thin wrapper that exposes everything above to the AI agents themselves —
  Claude Code, Codex, Gemini, Cursor, Windsurf, Zed, Continue, Cline and any other
  MCP-capable CLI — so the agent can scan, audit and install through the SAME
  gated prometheus.py, plus a standalone terminal GUI. It reimplements NOTHING: it
  shells out to `python prometheus.py --json ...` (the bridge).

THE BRIDGE CONTRACT
  prometheus.py --json <command> prints EXACTLY ONE JSON object on stdout and
  routes all human/log text to stderr. The plugin packages spawn it, read that one
  object, and never parse human text. Set PROMETHEUS_PY so they can find it.

THREE NPM PACKAGES
  @prometheus-plugin/mcp        (bin: prometheus-mcp) — an MCP stdio server
      exposing 14 tools: prometheus_scan / _superscan / _list / _info / _where /
      _matrix / _status / _skills_list / _vault_status / _audit / _install /
      _uninstall / _enable / _disable. Read tools are safe; install/uninstall run
      the FULL nemesis gate. isError is set on a block / error verdict.
  @prometheus-plugin/tui        (bin: prometheus-tui) — an Ink (React-for-CLI)
      terminal GUI: a menu + live agent grid + Scan/Catalog/Install/Audit/Matrix/
      Skills/Vault views, all backed by the same --json bridge.
  @prometheus-plugin/installer  (bin: prometheus-install) — registers the MCP
      server into each detected CLI's native config, MERGE-SAFELY (splices only
      the `prometheus` key, preserving sibling servers + comments).
      flags: --agent <name>  --dry-run  --py <path>  --list

REGISTERING INTO A CLI
  Easiest:  npx -y @prometheus-plugin/installer --py /ABS/PATH/prometheus.py
  Static per-CLI manifests live in prometheus_plugin/adapters/ (claude .mcp.json,
  codex toml, cursor mcp.json, gemini extension, windsurf, zed, continue yaml,
  cline, generic-mcp). Each points npx at @prometheus-plugin/mcp with env
  PROMETHEUS_PY. Claude registers via `claude mcp add --scope user` when present.

  Net effect: an agent asks "install caveman everywhere safely" and the call
  travels   agent -> MCP tool -> prometheus.py --json install -> nemesis gate ->
  per-agent adapter   — fully gated, with one machine-readable result returned.
================================================================================
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import difflib
import gzip
import hashlib
import hmac
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
from xml.sax.saxutils import escape as _xml_escape

try:
    import fcntl  # POSIX advisory file locks (macOS/Linux); absent on Windows
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Optional

# ----------------------------------------------------------------------------
#  Metadata
# ----------------------------------------------------------------------------
SCRIPT_NAME = "prometheus"
SCRIPT_VERSION = "0.15.0"
HOME = Path.home()


def _resolve_prom_dir() -> Path:
    """Prometheus' OWN config dir — the single source of truth for `~/.config/prometheus`.

    `$PROMETHEUS_CONFIG_DIR` overrides it so a test run, a sandbox or a probe never writes
    into the real user's dir. Without an override there was no way to isolate the engine at
    all: a single unit test that trips the global crash guard (SECTION main) overwrote the
    user's genuine `last-crash.log` — the very file the crash guard tells them to report.

    Defined next to HOME (not down in SECTION 7B) because several module-level constants
    below resolve at import time and MUST all agree; four separate copies of this expression
    used to drift apart under an override.
    """
    override = (os.environ.get("PROMETHEUS_CONFIG_DIR") or "").strip()
    return Path(override).expanduser() if override else HOME / ".config" / "prometheus"


PROM_DIR = _resolve_prom_dir()


# ============================================================================
#  SECTION 1 — Output helpers (color, logging)
# ============================================================================
class Log:
    """Tiny logger with TTY-aware color and verbosity control."""

    USE_COLOR = sys.stdout.isatty()
    VERBOSE = False
    STREAM = sys.stdout          # human output sink; --json reroutes it to stderr
                                 # so stdout carries only the machine JSON object

    C = {
        "reset": "\033[0m", "bold": "\033[1m", "dim": "\033[2m",
        "red": "\033[31m", "green": "\033[32m", "yellow": "\033[33m",
        "blue": "\033[34m", "cyan": "\033[36m", "magenta": "\033[35m",
    }

    @classmethod
    def _c(cls, s: str, color: str) -> str:
        if not cls.USE_COLOR:
            return s
        return f"{cls.C.get(color, '')}{s}{cls.C['reset']}"

    @classmethod
    def info(cls, msg: str) -> None:
        print(f"{cls._c('::', 'blue')} {msg}", file=cls.STREAM)

    @classmethod
    def ok(cls, msg: str) -> None:
        print(f"{cls._c('OK', 'green')} {msg}", file=cls.STREAM)

    @classmethod
    def warn(cls, msg: str) -> None:
        print(f"{cls._c('WARN', 'yellow')} {msg}", file=cls.STREAM)

    @classmethod
    def err(cls, msg: str) -> None:
        print(f"{cls._c('FAIL', 'red')} {msg}", file=sys.stderr)

    @classmethod
    def step(cls, msg: str) -> None:
        print(f"    {cls._c('->', 'cyan')} {msg}", file=cls.STREAM)

    @classmethod
    def debug(cls, msg: str) -> None:
        if cls.VERBOSE:
            print(f"    {cls._c('dbg', 'dim')} {msg}", file=cls.STREAM)

    @classmethod
    def head(cls, msg: str) -> None:
        print(cls._c(f"\n=== {msg} ===", "bold"), file=cls.STREAM)


# ============================================================================
#  SECTION 2 — OS detection + shell runner
# ============================================================================
@dataclass(frozen=True)
class OSInfo:
    family: str                  # "macos" | "linux" | "unsupported"
    pkg_manager: Optional[str]   # brew | apt | dnf | pacman | zypper | None
    raw: str                     # platform.system()


def detect_os() -> OSInfo:
    """Classify the host and find a usable package manager (for future plugins)."""
    raw = platform.system()
    if raw == "Darwin":
        pm = "brew" if shutil.which("brew") else None
        return OSInfo("macos", pm, raw)
    if raw == "Linux":
        for pm in ("apt-get", "dnf", "pacman", "zypper"):
            if shutil.which(pm):
                return OSInfo("linux", "apt" if pm == "apt-get" else pm, raw)
        return OSInfo("linux", None, raw)
    return OSInfo("unsupported", None, raw)


# Wired in main(); read by install routines.
DRY_RUN = False
FORCE = False
JSON_OUT = False          # --json: emit one machine JSON object on stdout, humans → stderr


def emit_json(obj: dict) -> int:
    """Print exactly one JSON object to stdout (the machine channel) and return the
    process exit code. All human/log output has already been routed to stderr, so
    stdout carries only this object — the contract the MCP server + Ink TUI parse."""
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()
    return int(obj.get("_exit", 0 if obj.get("ok", True) else 2))


def emit_table_json(command: str, render, **extra) -> int:
    """Bridge-safe emit for HUMAN-TABLE commands (models/apps/inventory list). Under --json
    the bridge contract requires ONE JSON object on stdout — but these render human tables via
    print(). So under JSON_OUT we CAPTURE the render's stdout into `lines` and emit it as JSON
    (stdout never carries raw text → no `error (bad_json)`); non-JSON just renders the table.
    The engine-bridge catalog client reads these WITHOUT --json, so its text path is untouched."""
    if not JSON_OUT:
        render()
        return 0
    import io

    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        render()
    finally:
        sys.stdout = old
    return emit_json({"command": command, "ok": True, "lines": buf.getvalue().splitlines(), **extra})


def emit_console_json(command: str, render, **extra) -> int:
    """Bridge-safe emit for READ commands that report through `Log.*` rather than `print`.

    `emit_table_json` captures `sys.stdout`, which is enough for the commands that build a table
    with bare prints. It is NOT enough for the read actions that narrate through `Log`, because
    `Log.STREAM` is already rerouted to stderr under --json: capturing stdout would produce a
    correct-but-empty `lines[]`, and capturing nothing at all produced NO envelope, which is what
    actually happened. The MCP bridge prepends --json unconditionally and rejects a call whose
    stdout is not one JSON object, so `apps installed|status|versions|logs` (and the worldsim
    twins) failed hard for the agent — half of them with "stdout was not valid JSON" from leaked
    raw text, the other half with "produced no JSON on stdout" from an empty stream.

    So both sinks are pointed at one buffer for the duration of the render, and the captured text
    becomes `lines[]`. Non-JSON runs render exactly as before.
    """
    if not JSON_OUT:
        return render()
    import io

    buf = io.StringIO()
    old_stdout, old_stream = sys.stdout, Log.STREAM
    sys.stdout = buf
    Log.STREAM = buf
    try:
        rc = render()
    finally:
        sys.stdout = old_stdout
        Log.STREAM = old_stream
    return emit_json({
        "command": command,
        "ok": rc == 0,
        "exit_code": rc,
        "lines": buf.getvalue().splitlines(),
        **extra,
    })


# Default wall-clock cap so a stuck OR foreground-blocking command can never hang
# Prometheus: the child is killed on expiry and the shell terminates. Generous so big
# clones / pip downloads / docker pulls finish. A long-running SERVICE that must KEEP
# running does NOT belong here — use the detached path (_run_detached / ModelTool.serve_steps).
_RUN_TIMEOUT = 3600  # seconds (1h)


def run(cmd: list[str], check: bool = True, timeout: Optional[int] = None) -> subprocess.CompletedProcess:
    """Run a shell command to completion, then RETURN (the shell terminates).

    Honors --dry-run and --verbose. A wall-clock `timeout` (default _RUN_TIMEOUT)
    guarantees we never hang: on expiry the child process is killed and we return rc 124.
    Services that must stay up belong in the detached path, never here.
    """
    printable = " ".join(cmd)
    if DRY_RUN:
        Log.step(f"[dry-run] {printable}")
        return subprocess.CompletedProcess(cmd, 0, "", "")
    Log.debug(f"$ {printable}")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout if timeout is not None else _RUN_TIMEOUT)
    except FileNotFoundError as e:
        if check:
            raise RuntimeError(f"command not found: {cmd[0]} ({e})")
        Log.err(f"command not found: {cmd[0]}")
        return subprocess.CompletedProcess(cmd, 127, "", str(e))
    except subprocess.TimeoutExpired as e:
        # subprocess.run kills the child on timeout → no orphan/hanging shell left behind
        Log.err(f"command timed out after {e.timeout:.0f}s (killed): {printable}")
        if check:
            raise RuntimeError(f"command timed out ({printable})")
        return subprocess.CompletedProcess(cmd, 124, "", "timeout")
    if proc.stdout and Log.VERBOSE:
        Log.debug(proc.stdout.rstrip())
    if proc.returncode != 0:
        if proc.stderr:
            Log.debug(proc.stderr.rstrip())
        if check:
            raise RuntimeError(f"command failed ({proc.returncode}): {printable}\n{proc.stderr.strip()}")
    return proc


def _run_timed(cmd, *, timeout: int, **kw) -> subprocess.CompletedProcess:
    """subprocess.run with a MANDATORY wall-clock timeout (CLI-077 hardening). On TimeoutExpired
    the child is killed by subprocess.run; we warn + return a CompletedProcess(rc=124) so callers
    reading .returncode/.stdout/.stderr keep working — never a raw traceback. Used by the many
    direct-subprocess sites that need bespoke kwargs (capture_output/env/cwd/input/inherited-stdio)
    and so can't route through run(). Long-lived daemons use Popen and are timeout-EXEMPT by design."""
    try:
        return subprocess.run(cmd, timeout=timeout, **kw)
    except subprocess.TimeoutExpired as e:
        name = cmd[0] if isinstance(cmd, (list, tuple)) and cmd else str(cmd)
        try:
            Log.warn(f"'{name}' timed out after {timeout}s (killed)")
        except Exception:
            pass
        def _s(v):
            if v is None:
                return ""
            return v if isinstance(v, str) else v.decode("utf-8", "replace")
        return subprocess.CompletedProcess(cmd, 124, _s(e.stdout), _s(e.stderr))


def _read_json(path: Path) -> dict:
    """Read a JSON object from `path`, or {} — NEVER a non-dict.

    The annotation said `dict` and the body returned whatever `json.loads` produced, so a file
    holding `0`, `null`, `[]` or `"x"` came back as that value. Every one of this function's
    ~18 call sites then does `.get(...)`, `key in ...` or item assignment on it, so a single
    malformed file turns into a raw TypeError out of the middle of an install.

    Found live on a real machine: `~/.config/prometheus/trust.json` contained the single token
    `0`, so `is_trusted()` raised `TypeError: argument of type 'int' is not a container or
    iterable` and `record_trust()` raised `'int' object does not support item assignment` — i.e.
    every gate that reached the WARN tier, and every trust decision, died with exit 1.

    A corrupt file is discarded rather than propagated: the caller's own "nothing recorded yet"
    path is always a safe answer, and refusing to start is not.
    """
    try:
        data = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    except OSError:
        # unreadable (permissions, a directory where a file was expected) — same story
        return {}
    if isinstance(data, dict):
        return data
    Log.warn(f"ignoring {path}: expected a JSON object, found {type(data).__name__}")
    return {}


# ============================================================================
#  SECTION 3 — AI HOST registry (the agents Prometheus scans for)
# ============================================================================
@dataclass
class AIHost:
    name: str                              # canonical id used everywhere
    label: str                             # human name
    cli_candidates: tuple[str, ...]        # executables to probe on PATH
    kind: str = "cli"                      # "cli" | "ide"
    home_hints: tuple[str, ...] = ()       # config dir glob(s); presence = signal
    # --- inventory: where THIS agent keeps installed plugins/skills/MCP on disk
    skills_dirs: tuple[str, ...] = ()           # candidate SKILL.md folders
    mcp_configs: tuple[str, ...] = ()           # JSON files holding the MCP object
    mcp_key: str = "mcpServers"                 # JSON key for MCP (zed=context_servers, opencode=mcp)
    plugin_state_file: Optional[str] = None     # claude installed_plugins.json (id -> enabled)
    marketplaces_file: Optional[str] = None     # claude known_marketplaces.json
    extensions_dir: Optional[str] = None        # gemini extensions/* (one dir per extension)
    settings_file: Optional[str] = None         # enabledPlugins overlay (claude settings.json)

    _resolved_cli: Optional[str] = field(default=None, init=False, repr=False)
    _resolved_hint: Optional[str] = field(default=None, init=False, repr=False)

    def detect(self) -> bool:
        for exe in self.cli_candidates:
            path = shutil.which(exe)
            if path:
                self._resolved_cli = path
                return True
        # fall back to config dir presence (IDE / GUI-installed agent, no CLI)
        for pattern in self.home_hints:
            expanded = os.path.expanduser(os.path.expandvars(pattern))
            if any(c in expanded for c in "*?["):
                from glob import glob
                hits = glob(expanded)
                if hits:
                    self._resolved_hint = hits[0]
                    return True
            elif Path(expanded).exists():
                self._resolved_hint = expanded
                return True
        return False

    @property
    def cli(self) -> Optional[str]:
        return self._resolved_cli

    @property
    def where(self) -> str:
        return self._resolved_cli or self._resolved_hint or "not found"


# JetBrains config root differs per OS; Toolbox shell launchers also vary.
# Cover macOS ("~/Library/Application Support/JetBrains/*") and Linux/XDG
# ("~/.config/JetBrains/*", "~/.local/share/JetBrains/*") with globs.
_JB_CLI = ("idea", "pycharm", "webstorm", "goland", "rider", "clion",
           "phpstorm", "rubymine", "datagrip", "rustrover")
_JB_HINTS = (
    "~/Library/Application Support/JetBrains/*",
    "~/.config/JetBrains/*",
    "~/.local/share/JetBrains/*",
)

# --- known agents (append more here) ---------------------------------------
#  Inventory paths reflect each agent's documented on-disk layout. Claude Code is
#  fully wired (installed_plugins.json + known_marketplaces.json + skills + MCP);
#  codex/cursor/gemini get their known skills dirs + MCP config + (gemini)
#  extensions — best-effort where the layout is conventional.
HOSTS: list[AIHost] = [
    AIHost("claude", "Claude Code", ("claude",), kind="cli", home_hints=("~/.claude",),
           skills_dirs=("~/.claude/skills",),
           mcp_configs=("~/.claude.json", "~/.claude/settings.json"),
           plugin_state_file="~/.claude/plugins/installed_plugins.json",
           marketplaces_file="~/.claude/plugins/known_marketplaces.json",
           settings_file="~/.claude/settings.json"),
    AIHost("codex",  "OpenAI Codex CLI", ("codex",), kind="cli", home_hints=("~/.codex",),
           skills_dirs=("~/.codex/skills", "~/.codex/prompts", "~/.codex/agents")),
    AIHost("cursor", "Cursor", ("cursor", "cursor-agent"), kind="cli", home_hints=("~/.cursor",),
           # skills-cursor is the real on-disk skill folder Cursor ships; rules/skills kept too.
           skills_dirs=("~/.cursor/skills", "~/.cursor/skills-cursor", "~/.cursor/rules"),
           mcp_configs=("~/.cursor/mcp.json",)),
    AIHost("gemini", "Gemini CLI", ("gemini",), kind="cli", home_hints=("~/.gemini",),
           skills_dirs=("~/.gemini/skills", "~/.gemini/commands"),
           mcp_configs=("~/.gemini/settings.json",),
           extensions_dir="~/.gemini/extensions"),
    # --- P3 second-tier agents (MCP-centric; heterogeneous JSON keys) ---------
    # skills_dirs are best-effort (presence = signal; absent dirs are skipped) so
    # prometheus reads SKILL.md/AGENTS.md from EVERY agent that conventionally has them.
    AIHost("opencode", "OpenCode", ("opencode",), kind="cli",
           home_hints=("~/.config/opencode", "~/.opencode"),
           skills_dirs=("~/.config/opencode/skills", "~/.opencode/skills"),
           mcp_configs=("~/.config/opencode/opencode.json",), mcp_key="mcp"),
    AIHost("windsurf", "Windsurf (Codeium)", ("windsurf",), kind="ide",
           home_hints=("~/.codeium/windsurf",),
           skills_dirs=("~/.codeium/windsurf/skills",),
           mcp_configs=("~/.codeium/windsurf/mcp_config.json",), mcp_key="mcpServers"),
    AIHost("zed", "Zed", ("zed",), kind="ide", home_hints=("~/.config/zed",),
           skills_dirs=("~/.config/zed/skills",),
           mcp_configs=("~/.config/zed/settings.json",), mcp_key="context_servers"),
    AIHost("continue", "Continue", ("cn",), kind="ide", home_hints=("~/.continue",),
           skills_dirs=("~/.continue/skills",),
           mcp_configs=("~/.continue/config.json",), mcp_key="mcpServers"),
    # --- P5.6 additions ---
    AIHost("copilot", "GitHub Copilot CLI", ("copilot",), kind="cli",
           home_hints=("~/.config/github-copilot", "~/.copilot"),
           skills_dirs=("~/.config/github-copilot/skills", "~/.copilot/skills")),
    AIHost("aider", "Aider", ("aider",), kind="cli",
           home_hints=("~/.aider", "~/.aider.conf.yml"),
           skills_dirs=("~/.aider/skills",)),
    AIHost("jetbrains", "JetBrains IDEs", _JB_CLI, kind="ide", home_hints=_JB_HINTS),
    AIHost("jetbrains-air", "JetBrains AIR (multi-agent IDE)", ("air",),
           kind="ide",
           home_hints=("~/Library/Application Support/JetBrains/AIR*",
                       "~/.config/JetBrains/AIR*")),
]


def host_registry() -> dict[str, AIHost]:
    return {h.name: h for h in HOSTS}


def detect_hosts() -> list[AIHost]:
    return [h for h in HOSTS if h.detect()]


# ============================================================================
#  SECTION 4 — Claude state readers (idempotency for the claude adapter)
# ============================================================================
CLAUDE_PLUGINS_DIR = HOME / ".claude" / "plugins"
CLAUDE_KNOWN_MKTS = CLAUDE_PLUGINS_DIR / "known_marketplaces.json"
CLAUDE_INSTALLED = CLAUDE_PLUGINS_DIR / "installed_plugins.json"


def claude_marketplace_present(name: str) -> bool:
    return name in _read_json(CLAUDE_KNOWN_MKTS)


def claude_plugin_present(plugin_id: str) -> bool:
    plugins = _read_json(CLAUDE_INSTALLED).get("plugins", {})
    return plugin_id in plugins and bool(plugins[plugin_id])


# ============================================================================
#  SECTION 4B — Granular control (settings.json enable/disable + on-disk skill/
#  hook/MCP toggling). This is the "any state in between fully-installed and
#  eradicated" layer: a plugin can be installed-but-disabled, and individual
#  skills/hooks/MCP servers can be muted/disabled without removing the package.
# ============================================================================
USER_SETTINGS = HOME / ".claude" / "settings.json"
CLAUDE_SKILLS_DIR = HOME / ".claude" / "skills"

# The central prometheus skill folder (APP + CLI default). Every skill prometheus
# integrates lands here; it is NOT a trust assertion — nemesis re-checks every file
# in it at each startup + on demand. `_pin_iter_sources` + the startup pin-audit
# include it, and `skills integrate` copies nemesis-green skills from other agents in.
PROMETHEUS_SKILLS_DIR = PROM_DIR / "prometheus_skills"


def _read_settings() -> dict:
    return _read_json(USER_SETTINGS)


def _write_settings(data: dict) -> None:
    """Persist the agent's settings file — never CLOBBERING a config we could not read.

    `_read_settings` goes through `_read_json`, which swallows `JSONDecodeError` and returns
    `{}`. Every caller here is a read-modify-write, so an unparseable `settings.json` meant the
    modify step started from an empty dict and this function then wrote it back: `env`, `model`,
    `hooks`, `statusLine`, `effortLevel`, `theme`, `editorMode` — every key the user had —
    replaced by whatever this one caller happened to assemble, with no backup and no warning.
    One stray trailing comma from a hand-edit, or one interrupted non-atomic write, and the
    whole file was gone.

    Two guards: back the file up (and SAY so) when it is present but unreadable, and write
    through a temp + rename so an interrupted write can never be what makes it unreadable next
    time.
    """
    if DRY_RUN:
        Log.step(f"[dry-run] write {USER_SETTINGS}")
        return
    USER_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    if USER_SETTINGS.exists():
        try:
            json.loads(USER_SETTINGS.read_text())
        except (json.JSONDecodeError, OSError, ValueError):
            _backup_file(USER_SETTINGS)
            Log.warn(f"{USER_SETTINGS} did not parse as JSON — its previous contents were "
                     f"backed up next to it (.prom.bak) before this rewrite; merge anything "
                     f"you still need back by hand")
    tmp = USER_SETTINGS.with_name(USER_SETTINGS.name + ".tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2))
        os.replace(tmp, USER_SETTINGS)
    except OSError:
        try:
            tmp.unlink(missing_ok=True)   # never leave a half-written .tmp orphan behind
        except OSError:
            pass
        raise


def _backup_file(path: Path) -> None:
    """Back up a config before editing → <file>.prom.bak (timestamped if taken)."""
    if not path.exists():
        return
    bak = path.with_name(path.name + ".prom.bak")
    if bak.exists():
        bak = path.with_name(f"{path.name}.prom.bak.{int(time.time())}")
    shutil.copy2(path, bak)
    Log.step(f"backup -> {bak.name}")


def edit_json(path: Path, mutator: Callable[[dict], bool], create: bool = True) -> bool:
    """Load a JSON config (tolerant of missing/empty), apply mutator(data)->changed,
    write pretty with a backup. Honors --dry-run. Returns True if it changed."""
    data = _read_json(path)
    if not mutator(data):
        return False
    if DRY_RUN:
        Log.step(f"[dry-run] edit {path}")
        return True
    if not path.exists() and not create:
        Log.warn(f"{path} does not exist — not creating")
        return False
    _backup_file(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))
    return True


def set_enabled_plugin(plugin_id: str, enabled: bool) -> None:
    """The OFFICIAL Claude-Code mechanism for 'installed but off': settings.json
    enabledPlugins[id] = false (disable) / true (re-arm). Reversible, no removal."""
    s = _read_settings()
    s.setdefault("enabledPlugins", {})[plugin_id] = enabled
    _write_settings(s)


def set_extra_marketplace(name: str, repo: str) -> None:
    """P5.6 auto-arm: register a marketplace in settings.json extraKnownMarketplaces
    so it's auto-available on folder-trust (no secrets — just the source pointer)."""
    s = _read_settings()
    s.setdefault("extraKnownMarketplaces", {})[name] = {
        "source": {"source": "github", "repo": repo}}
    _write_settings(s)


def plugin_enabled(plugin_id: str) -> Optional[bool]:
    """True/False if explicitly set in settings; None = default (enabled if installed)."""
    return _read_settings().get("enabledPlugins", {}).get(plugin_id)


# ---- on-disk SKILL.md control (the reversible "comment-out a skill") ---------
#  Disable = rename SKILL.md -> SKILL.md.disabled (Claude stops loading it).
#  Mute    = set `disable-model-invocation: true` (no auto-fire; manual /name ok).
def _skill_paths(name: str) -> tuple[Path, Path, Path]:
    d = CLAUDE_SKILLS_DIR / name
    return d, d / "SKILL.md", d / "SKILL.md.disabled"


def skill_state(name: str) -> str:
    """enabled | muted | disabled | absent."""
    _d, md, dis = _skill_paths(name)
    if md.exists():
        txt = md.read_text(errors="ignore")
        if re.search(r"(?mi)^disable-model-invocation:\s*true", txt):
            return "muted"
        return "enabled"
    if dis.exists():
        return "disabled"
    return "absent"


def list_installed_skills() -> list[str]:
    if not CLAUDE_SKILLS_DIR.exists():
        return []
    out = []
    for d in sorted(CLAUDE_SKILLS_DIR.iterdir()):
        if d.is_dir() and ((d / "SKILL.md").exists() or (d / "SKILL.md.disabled").exists()):
            out.append(d.name)
    return out


def disable_skill(name: str) -> bool:
    _d, md, dis = _skill_paths(name)
    if not md.exists():
        Log.warn(f"skill '{name}': SKILL.md not present (state={skill_state(name)})")
        return False
    if DRY_RUN:
        Log.step(f"[dry-run] mv {md} {dis}")
        return True
    md.rename(dis)
    return True


def enable_skill(name: str) -> bool:
    """Fully re-arm: restore SKILL.md if disabled AND clear any mute flag."""
    _d, md, dis = _skill_paths(name)
    if md.exists():
        unmute_skill(name)               # clear mute if present (no-op otherwise)
        return True
    if not dis.exists():
        Log.warn(f"skill '{name}' not found")
        return False
    if DRY_RUN:
        Log.step(f"[dry-run] mv {dis} {md}")
        return True
    dis.rename(md)
    unmute_skill(name)                    # enable = fully on
    return True


def _set_frontmatter_flag(text: str, key: str, value: str) -> str:
    if re.search(rf"(?mi)^{re.escape(key)}:", text):
        return re.sub(rf"(?mi)^{re.escape(key)}:.*$", f"{key}: {value}", text)
    if text.startswith("---"):
        parts = text.split("---", 2)             # ['', frontmatter, body]
        if len(parts) == 3:
            fm = parts[1].rstrip("\n")
            return f"---{fm}\n{key}: {value}\n---{parts[2]}"
    return f"---\n{key}: {value}\n---\n{text}"


def mute_skill(name: str) -> bool:
    _d, md, _dis = _skill_paths(name)
    if not md.exists():
        Log.warn(f"skill '{name}': SKILL.md not present (state={skill_state(name)})")
        return False
    new = _set_frontmatter_flag(md.read_text(), "disable-model-invocation", "true")
    if DRY_RUN:
        Log.step(f"[dry-run] set disable-model-invocation: true in {md}")
        return True
    md.write_text(new)
    return True


def unmute_skill(name: str) -> bool:
    _d, md, _dis = _skill_paths(name)
    if not md.exists():
        return False
    txt = md.read_text()
    if not re.search(r"(?mi)^disable-model-invocation:", txt):
        return False
    new = _set_frontmatter_flag(txt, "disable-model-invocation", "false")
    if DRY_RUN:
        Log.step(f"[dry-run] set disable-model-invocation: false in {md}")
        return True
    md.write_text(new)
    return True


# ---- on-disk plugin internals (hooks / MCP) — reversible rename -------------
def find_plugin_dir(plugin_short_name: str) -> Optional[Path]:
    """Best-effort: locate an installed plugin's root dir under ~/.claude/plugins
    by matching .claude-plugin/plugin.json `name`."""
    if not CLAUDE_PLUGINS_DIR.exists():
        return None
    for pj in CLAUDE_PLUGINS_DIR.rglob(".claude-plugin/plugin.json"):
        meta = _read_json(pj)
        if meta.get("name") == plugin_short_name:
            return pj.parent.parent
    return None


def _set_file_enabled(active: Path, enabled: bool, label: str) -> Optional[str]:
    """Reversible enable/disable of an on-disk feature file by rename.
    active <-> active+'.disabled'. Returns the resulting state or None."""
    disabled = active.with_name(active.name + ".disabled")
    if enabled:
        if active.exists():
            Log.ok(f"{label} already enabled")
            return "enabled"
        if disabled.exists():
            if DRY_RUN:
                Log.step(f"[dry-run] mv {disabled} {active}")
            else:
                disabled.rename(active)
            return "enabled"
        Log.warn(f"no {label} present to enable")
        return None
    # disable
    if disabled.exists():
        Log.ok(f"{label} already disabled")
        return "disabled"
    if active.exists():
        if DRY_RUN:
            Log.step(f"[dry-run] mv {active} {disabled}")
        else:
            active.rename(disabled)
        return "disabled"
    Log.warn(f"no {label} present to disable")
    return None


def set_plugin_hooks(plugin_short_name: str, enabled: bool) -> Optional[str]:
    d = find_plugin_dir(plugin_short_name)
    if not d:
        Log.warn(f"plugin dir for '{plugin_short_name}' not found under {CLAUDE_PLUGINS_DIR} "
                 f"(install it first, or it has no on-disk hooks)")
        return None
    return _set_file_enabled(d / "hooks" / "hooks.json", enabled, f"{plugin_short_name} hooks")


def set_plugin_mcp(plugin_short_name: str, enabled: bool) -> Optional[str]:
    d = find_plugin_dir(plugin_short_name)
    if not d:
        Log.warn(f"plugin dir for '{plugin_short_name}' not found under {CLAUDE_PLUGINS_DIR}")
        return None
    return _set_file_enabled(d / ".mcp.json", enabled, f"{plugin_short_name} MCP servers")


# ---- cross-agent INVENTORY: discover what's ACTUALLY installed (incl. foreign)
#  Re-reads disk every call (always live — 're-scan' = run it again). Reports
#  registry-managed AND unknown/foreign plugins, skills, MCP servers, extensions.
def _expand(p: str) -> Path:
    return Path(os.path.expanduser(os.path.expandvars(p)))


def _scan_skill_folders(dirpath: str) -> list[dict]:
    base = _expand(dirpath)
    if not base.exists() or not base.is_dir():
        return []
    out = []
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        md, dis = d / "SKILL.md", d / "SKILL.md.disabled"
        if md.exists():
            txt = md.read_text(errors="ignore")
            state = "muted" if re.search(r"(?mi)^disable-model-invocation:\s*true", txt) else "enabled"
        elif dis.exists():
            state = "disabled"
        else:
            continue
        out.append({"name": d.name, "state": state, "dir": str(d)})
    return out


def _read_mcp_servers(cfgpath: str, key: str = "mcpServers") -> dict:
    """Read an MCP map from a JSON config. `key` differs per agent
    (mcpServers / context_servers / mcp). Normalizes a list (Continue-style
    [{name, ...}]) to {name: conf}."""
    p = _expand(cfgpath)
    if not p.exists():
        return {}
    servers = _read_json(p).get(key, {})
    if isinstance(servers, dict):
        return servers
    if isinstance(servers, list):
        return {s.get("name", f"server{i}"): s for i, s in enumerate(servers) if isinstance(s, dict)}
    return {}


def _scan_rule_files(dirpath: Path, suffix: str = ".mdc") -> list[dict]:
    """Scan a flat dir of rule/command files (Cursor .mdc / .md) with state."""
    if not dirpath.exists() or not dirpath.is_dir():
        return []
    out = []
    for f in sorted(dirpath.iterdir()):
        n = f.name
        if n.endswith(suffix):
            txt = f.read_text(errors="ignore")
            state = "muted" if re.search(r"(?mi)^alwaysApply:\s*false", txt) else "enabled"
            out.append({"name": n[: -len(suffix)], "state": state, "dir": str(f)})
        elif n.endswith(suffix + ".disabled"):
            out.append({"name": n[: -(len(suffix) + 9)], "state": "disabled", "dir": str(f)})
    return out


def _inventory_agent_extras(host: AIHost, inv: dict) -> None:
    """Per-agent stores the generic scan can't see (P1: Cursor rules/commands, Gemini commands)."""
    if host.name == "cursor":
        for base in (Path.cwd() / ".cursor" / "rules", _expand("~/.cursor/rules")):
            for r in _scan_rule_files(base, ".mdc"):
                inv.setdefault("rules", []).append(r)
        for base in (Path.cwd() / ".cursor" / "commands", _expand("~/.cursor/commands")):
            for c in _scan_rule_files(base, ".md"):
                inv.setdefault("commands", []).append(c)
    if host.name == "gemini":
        cmds = _expand("~/.gemini/commands")
        if cmds.exists():
            inv.setdefault("commands", []).extend(
                {"name": f.stem, "state": "enabled", "dir": str(f)}
                for f in sorted(cmds.glob("*.toml")))
    if host.name == "codex":
        pr = CODEX_PROMPTS
        if pr.exists():
            for f in sorted(pr.glob("*.md")):
                inv.setdefault("commands", []).append({"name": f.stem, "state": "enabled", "dir": str(f)})
            for f in sorted(pr.glob("*.md.disabled")):
                inv.setdefault("commands", []).append(
                    {"name": f.name[:-len(".md.disabled")], "state": "disabled", "dir": str(f)})
        for name in _read_codex_mcp():               # TOML [mcp_servers.*] (not JSON)
            inv["mcp"].append({"name": name, "config": str(CODEX_CONFIG)})


def inventory_host(host: AIHost) -> dict:
    """Live snapshot of everything installed for one agent."""
    inv = {"marketplaces": [], "plugins": [], "skills": [], "mcp": [], "extensions": []}
    if host.marketplaces_file:
        inv["marketplaces"] = list(_read_json(_expand(host.marketplaces_file)).keys())
    if host.plugin_state_file:
        data = _read_json(_expand(host.plugin_state_file))
        plugins = data.get("plugins", data if isinstance(data, dict) else {})
        ep = _read_json(_expand(host.settings_file)).get("enabledPlugins", {}) if host.settings_file else {}
        if isinstance(plugins, dict):
            for pid, val in plugins.items():
                installed = bool(val)
                inv["plugins"].append({"id": pid, "installed": installed,
                                       "enabled": ep.get(pid, installed)})
    if host.extensions_dir:
        ed = _expand(host.extensions_dir)
        if ed.exists():
            inv["extensions"] = [d.name for d in sorted(ed.iterdir()) if d.is_dir()]
    seen = set()
    for sd in host.skills_dirs:
        for sk in _scan_skill_folders(sd):
            if sk["dir"] in seen:
                continue
            seen.add(sk["dir"])
            inv["skills"].append(sk)
    mcp_seen = set()
    for cfg in host.mcp_configs:
        for name in _read_mcp_servers(cfg, host.mcp_key):
            if name in mcp_seen:
                continue
            mcp_seen.add(name)
            inv["mcp"].append({"name": name, "config": cfg})
    _inventory_agent_extras(host, inv)
    return inv


def registry_plugin_ids() -> set:
    ids = set()
    for p in PLUGINS:
        for s in p.targets.values():
            for i in _claude_plugin_ids(s):
                ids.add(i)
    return ids


def registry_repo_names() -> set:
    """Loose name set for tagging foreign-vs-managed skills/extensions."""
    out = set()
    for p in PLUGINS:
        out.add(p.name)
        if p.repo:
            out.add(p.repo.split("/")[-1].lower())
    return out


# ============================================================================
#  SECTION 5 — Plugin registry model + per-host install adapters
# ============================================================================
@dataclass
class InstallSpec:
    """How a single plugin installs into (and uninstalls from) a single host.

    Methods (each md dossier maps its repo's official mechanism to one of these):
      claude_plugin      — Claude-native marketplace add + plugin install.
      claude_marketplace — register a marketplace ROOT only (no plugin_id), e.g.
                           the official/community registries; auto-trusted.
      git_clone       — shallow clone the repo into `dest` (a skills folder).
      git_clone_shell — clone, then run the repo's own `shell_steps` (e.g. ./setup).
      shell           — run per-OS `shell_steps` (npx / uv / pip / brew installers).
      universal_skill — ONE install-everywhere command (npx skills add /
                        gh skill install) that fans a SKILL.md into every
                        compatible agent; keyed under target "*", run once.
      shell_or_action — scaffolds CI / slash command (e.g. security-review):
                        runs `shell_steps` if given, else prints manual steps.
      documented_only — never installed; info card + manual pointer only.

    Uninstall mirrors the install method using the repo's OFFICIAL removal path
    (uninstall_cmd / uninstall_steps); claude_plugin removes the plugin (and the
    marketplace if marketplace_remove); git_clone removes `dest`.
    """
    method: str
    # --- method == "claude_plugin"
    marketplace_name: Optional[str] = None
    marketplace_repo: Optional[str] = None
    plugin_id: Optional[str] = None
    plugin_ids: list[str] = field(default_factory=list)   # extra sub-plugins from the same marketplace
    scope: str = "user"
    marketplace_remove: bool = False            # also drop the marketplace on uninstall
    # --- method == "claude_marketplace" (register a marketplace ROOT; no plugin_id)
    secondary_marketplace_name: Optional[str] = None    # e.g. the community marketplace
    secondary_marketplace_repo: Optional[str] = None
    auto_available: bool = False                # pre-registered by Claude Code (skip add / never remove)
    # --- method == "git_clone" / "git_clone_shell"
    repo_url: Optional[str] = None
    dest: Optional[str] = None
    # --- method == "shell" / "git_clone_shell" / "shell_or_action"  (per-OS cmd lists)
    shell_steps: dict[str, list[list[str]]] = field(default_factory=dict)
    # --- method == "universal_skill"
    universal_add: list[str] = field(default_factory=list)   # e.g. ["npx","skills","add","owner/repo"]
    # --- shell installers that pipe a remote script: fetch + scan it (not blind).
    prefetch_scan_urls: list[str] = field(default_factory=list)   # raw install.sh URLs to fetch & audit
    # --- method == "gemini_extension"  (P1)
    gemini_source: Optional[str] = None         # git url / path for `gemini extensions install`
    gemini_name: Optional[str] = None           # installed extension name (uninstall/enable/disable/inventory)
    # --- method == "cursor_mcp" / generic MCP wiring (P1)
    mcp_name: Optional[str] = None
    mcp_server: dict = field(default_factory=dict)   # {command,args,env,url,...} — NO secrets, ${ENV} only
    # --- method == "cursor_rule"  (P1)
    rule_name: Optional[str] = None
    rule_body: Optional[str] = None
    rule_globs: Optional[str] = None
    rule_always: bool = False
    rules_dir: Optional[str] = None             # default: ./.cursor/rules (project-scoped)
    # --- method == "codex_prompt"  (P2; codex_mcp reuses mcp_name/mcp_server)
    prompt_name: Optional[str] = None
    prompt_body: Optional[str] = None
    # --- uninstall (officially-provided removal; mirrors the install method)
    uninstall_cmd: Optional[list[str]] = None                # single removal command
    uninstall_steps: dict[str, list[list[str]]] = field(default_factory=dict)  # per-OS removal
    # --- docs / pointers (documented_only, or extra manual notes surfaced by the wizard)
    manual_note: Optional[str] = None
    doc_url: Optional[str] = None


@dataclass
class Component:
    """A surgically-selectable sub-unit of a plugin (for --only/--skip, enable/
    disable, status). kind drives how it is toggled:
      subplugin — a claude_plugin sub-id (install/uninstall + enabledPlugins)
      skill     — a SKILL.md folder (enable/disable/mute on disk)
      hook      — hooks/hooks.json (rename to disable)
      mcp       — .mcp.json server(s) (rename/edit to disable)
      command   — a slash command file
      dial      — a tunable config value written into a skill (e.g. taste-skill)
    """
    name: str
    kind: str = "subplugin"
    desc: str = ""


@dataclass
class Plugin:
    name: str
    summary: str
    targets: dict[str, InstallSpec]             # host-name -> InstallSpec ("*" = universal/one-run)
    supported_os: tuple[str, ...] = ("macos", "linux")
    components: tuple[Component, ...] = ()       # declared selectable sub-units (else derived)
    # --- catalog metadata (drives bundle / tiers / wizard rows; sourced from the dossiers) ---
    tier: str = "community"                      # official | community | devtool
    bundle: bool = False                         # part of the one-run official bundle
    claude_exclusive: bool = True               # True = Claude-only; False = universal/multi-CLI
    repo: Optional[str] = None                  # owner/repo (display + source of truth)
    owner: Optional[str] = None
    license: Optional[str] = None
    stars: Optional[int] = None
    forks: Optional[int] = None
    category: Optional[str] = None
    redundancy_group: Optional[str] = None      # A_code_graph, D_dev_workflow, ...
    recommend_rank: Optional[int] = None        # 0 = official; 1..N = community ranking
    automation: str = ""                        # fire-on-prompt / auto-arm note (shown by `info`)
    security_note: str = ""                     # one-line gate guidance for the wizard
    caveats: tuple[str, ...] = ()
    post_install_note: str = ""                 # required next step (e.g. priming) surfaced after install

    def hosts(self) -> tuple[str, ...]:
        return tuple(self.targets.keys())

    @property
    def universal(self) -> bool:
        return not self.claude_exclusive

    def components_for(self) -> list[Component]:
        """Selectable sub-units: declared, else derived from claude_plugin ids."""
        if self.components:
            return list(self.components)
        out: list[Component] = []
        for spec in self.targets.values():
            if spec.method == "claude_plugin":
                for pid in _claude_plugin_ids(spec):
                    out.append(Component(pid, "subplugin"))
        return out

    @property
    def installs_skills(self) -> bool:
        """True if this plugin drops SKILL.md folders we can toggle on disk."""
        return any(s.method in ("universal_skill", "git_clone", "git_clone_shell")
                   for s in self.targets.values())


# ---- adapter registry: (host, method) -> callable --------------------------
# Adapters return True if an action changed state, False if already-installed.
AdapterFn = Callable[["Plugin", InstallSpec, AIHost, OSInfo], bool]


def _claude_plugin_ids(spec: InstallSpec) -> list[str]:
    """All plugin ids a claude_plugin spec installs (single + extra sub-plugins)."""
    return ([spec.plugin_id] if spec.plugin_id else []) + list(spec.plugin_ids)


def _adapt_claude_plugin(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    cli = host.cli or shutil.which("claude")
    if not cli:
        raise RuntimeError("claude CLI not found")
    ids = _claude_plugin_ids(spec)
    if not spec.marketplace_name or not ids:
        raise RuntimeError(f"{p.name}: claude_plugin spec needs marketplace_name + plugin_id(s)")

    if claude_marketplace_present(spec.marketplace_name) and not FORCE:
        Log.step(f"marketplace '{spec.marketplace_name}' already added")
    else:
        Log.step(f"adding marketplace {spec.marketplace_repo}")
        run([cli, "plugin", "marketplace", "add", spec.marketplace_repo])

    changed = False
    for pid in ids:
        if claude_plugin_present(pid) and not FORCE:
            Log.ok(f"{pid} already installed — skip")
            continue
        Log.step(f"installing {pid} (scope={spec.scope})")
        run([cli, "plugin", "install", pid, "--scope", spec.scope])
        changed = True
    if not changed:
        Log.ok(f"{p.name}@claude already installed — skip")
    return changed


def _adapt_claude_marketplace(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    """Register a marketplace ROOT (primary + optional secondary). Installs no
    plugin_id — it makes the catalog available. The official root is usually
    pre-registered by Claude Code (auto_available) so this is a verified no-op."""
    cli = host.cli or shutil.which("claude")
    if not cli:
        raise RuntimeError("claude CLI not found")
    if not spec.marketplace_name or not spec.marketplace_repo:
        raise RuntimeError(f"{p.name}: claude_marketplace spec needs marketplace_name + marketplace_repo")
    changed = False
    pairs = [(spec.marketplace_name, spec.marketplace_repo, True),
             (spec.secondary_marketplace_name, spec.secondary_marketplace_repo, False)]
    for name, repo, primary in pairs:
        if not name or not repo:
            continue
        if claude_marketplace_present(name) and not FORCE:
            note = " (auto-available)" if primary and spec.auto_available else ""
            Log.step(f"marketplace '{name}' already registered{note}")
            continue
        Log.step(f"adding marketplace {repo}")
        run([cli, "plugin", "marketplace", "add", repo])
        changed = True
    if not changed:
        Log.ok(f"{p.name}@{host.name}: marketplace(s) already registered — skip")
    return changed


# Git config flags that neutralize every repo-controlled code path which could
# fire DURING clone / checkout / pull — i.e. BEFORE the nemesis gate ever scans
# the tree. Closes the clone-time TOCTOU: a fetched repo must not be able to run
# a checkout/post-merge hook, an `ext::` submodule transport, or an fsmonitor
# program to execute code before enforce_gate() has vetted what was fetched.
_GIT_SAFE_FLAGS = [
    "-c", "core.hooksPath=/dev/null",   # no hook (post-checkout/post-merge/...) runs
    "-c", "core.fsmonitor=",            # no fsmonitor helper program is spawned
    "-c", "protocol.ext.allow=never",   # refuse ext:: transport (submodule RCE vector)
]


def _git_clone_argv(git: str, url: str, dest: str) -> list:
    """Hardened `git clone`: shallow, no submodules, no hooks/ext-transport. Nothing
    the cloned repo ships can execute before enforce_gate() scans the staged tree."""
    return [git, *_GIT_SAFE_FLAGS, "clone", "--depth", "1",
            "--no-recurse-submodules", url, dest]


def _adapt_git_clone(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    if not spec.repo_url or not spec.dest:
        raise RuntimeError(f"{p.name}: git_clone spec needs repo_url + dest")
    git = shutil.which("git")
    if not git:
        raise RuntimeError("git not found on PATH")
    dest = Path(os.path.expandvars(os.path.expanduser(spec.dest)))
    if dest.exists() and not FORCE:
        Log.ok(f"{p.name}@{host.name} already cloned at {dest} — skip")
        return False
    if dest.exists() and FORCE:
        Log.step(f"pulling latest in {dest}")
        run([git, *_GIT_SAFE_FLAGS, "-C", str(dest), "pull", "--ff-only"])
        if DRY_RUN:
            # pull was a no-op; show the verdict of the CURRENT tree, change nothing
            enforce_gate(str(dest), f"{p.name} ({spec.repo_url}, dry-run)")
            return True
        # the pull may have brought new code — re-vet before anything runs it.
        # On block the existing tree is kept (it is the user's install dir);
        # inspect/clean it with `nemesis ui <dest>`.
        if not enforce_gate(str(dest), f"{p.name} ({spec.repo_url}, updated)"):
            raise RuntimeError(f"{p.name}: updated tree blocked by nemesis gate — "
                               f"review it with: nemesis ui {dest}")
        return True
    if DRY_RUN:
        Log.step(f"[dry-run] git clone --depth 1 {spec.repo_url} -> {dest} (staged)")
        # Still show the verdict a real run would gate on — nemesis fetches the repo into its
        # own temp snapshot, so no install artifact is written. The gate's WARN tier CAN still
        # ask (or auto-approve under --yes); `_save_trust` is what refuses to remember the
        # answer under DRY_RUN, so this stays a preview instead of pre-approving a later
        # real install.
        enforce_gate(spec.repo_url, f"{p.name} ({spec.repo_url}, dry-run)")
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Stage the clone next to dest, vet it, and only then rename into place —
    # a blocked tree never exists at the real install path, even transiently.
    staging = Path(tempfile.mkdtemp(prefix=f".{dest.name}.staging-", dir=str(dest.parent)))
    try:
        Log.step(f"cloning {spec.repo_url} -> {dest} (staged)")
        run(_git_clone_argv(git, spec.repo_url, str(staging)))
        if not enforce_gate(str(staging), f"{p.name} ({spec.repo_url})"):
            raise RuntimeError(f"{p.name}: install blocked by nemesis security gate")
        os.rename(staging, dest)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return True


def _adapt_shell(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    steps = spec.shell_steps.get(osi.family) or spec.shell_steps.get("all")
    if not steps:
        raise RuntimeError(f"{p.name}@{host.name}: no shell_steps for OS '{osi.family}'")
    _gate_shell_steps(p.name, host.name, steps)   # nemesis-gate the commands BEFORE running
    for cmd in steps:
        Log.step(" ".join(cmd))
        run(cmd)
    return True


def _adapt_git_clone_shell(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    """Clone the repo (idempotent), then run its own setup steps (e.g. ./setup)."""
    _adapt_git_clone(p, spec, host, osi)
    steps = spec.shell_steps.get(osi.family) or spec.shell_steps.get("all")
    # the clone TREE was gated by _adapt_git_clone; the repo's own setup steps are
    # separate command bytes and must be gated too (BYPASS #1).
    _gate_shell_steps(p.name, host.name, steps, " (setup)")
    for cmd in (steps or []):
        Log.step(" ".join(cmd))
        run(cmd)
    return True


def _adapt_universal_skill(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    """One install-everywhere command (npx skills add / gh skill install).

    The CLI itself detects and fans the SKILL.md into every compatible agent, so
    Prometheus runs it ONCE (this spec is keyed under target "*").
    """
    if not spec.universal_add:
        raise RuntimeError(f"{p.name}: universal_skill spec needs universal_add command")
    Log.step("install-everywhere: " + " ".join(spec.universal_add))
    run(spec.universal_add)
    return True


def _adapt_shell_or_action(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    """CI Action / slash-command installs (e.g. claude-code-security-review)."""
    steps = spec.shell_steps.get(osi.family) or spec.shell_steps.get("all")
    if not steps:
        Log.warn(f"{p.name}@{host.name}: installs as a CI Action / slash command — manual scaffold")
        if spec.manual_note:
            Log.step(spec.manual_note)
        return False
    _gate_shell_steps(p.name, host.name, steps)   # nemesis-gate before running (BYPASS #1)
    for cmd in steps:
        Log.step(" ".join(cmd))
        run(cmd)
    return True


def _adapt_stub(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    raise RuntimeError(
        f"install mechanism for host '{host.name}' not implemented yet "
        f"(method '{spec.method}'). Add an adapter in _GENERIC_ADAPTERS."
    )


# ---- uninstall adapters (officially-provided removal, mirrors install) ------
def _uninstall_claude_plugin(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    cli = host.cli or shutil.which("claude")
    if not cli:
        raise RuntimeError("claude CLI not found")
    ids = _claude_plugin_ids(spec)
    if not ids:
        raise RuntimeError(f"{p.name}: claude_plugin spec needs plugin_id(s) to uninstall")
    changed = False
    for pid in ids:
        if not claude_plugin_present(pid):
            Log.ok(f"{pid} not installed — skip")
            continue
        Log.step(f"uninstalling {pid}")
        run([cli, "plugin", "uninstall", pid])
        changed = True
    if spec.marketplace_remove and spec.marketplace_name:
        Log.step(f"removing marketplace {spec.marketplace_name}")
        run([cli, "plugin", "marketplace", "remove", spec.marketplace_name], check=False)
    if not changed:
        Log.ok(f"{p.name}@{host.name} not installed — nothing to remove")
    return changed


def _uninstall_claude_marketplace(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    """Unregister a marketplace root. The official auto-available root is managed
    by Claude Code itself — Prometheus refuses to remove it (would break /plugin)."""
    if spec.auto_available:
        Log.warn(f"{p.name}: official root marketplace is managed by Claude Code "
                 f"(auto-available) — not removing")
        return False
    cli = host.cli or shutil.which("claude")
    if not cli:
        raise RuntimeError("claude CLI not found")
    changed = False
    for name in (spec.secondary_marketplace_name, spec.marketplace_name):
        if name and claude_marketplace_present(name):
            Log.step(f"removing marketplace {name}")
            run([cli, "plugin", "marketplace", "remove", name], check=False)
            changed = True
    if not changed:
        Log.ok(f"{p.name}@{host.name}: no removable marketplace registered — nothing to do")
    return changed


def _uninstall_git_clone(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    if not spec.dest:
        raise RuntimeError(f"{p.name}: git_clone spec needs dest to uninstall")
    dest = Path(os.path.expandvars(os.path.expanduser(spec.dest)))
    if not dest.exists():
        Log.ok(f"{p.name}@{host.name} not present at {dest} — nothing to remove")
        return False
    if DRY_RUN:
        Log.step(f"[dry-run] rm -rf {dest}")
        return True
    Log.step(f"removing {dest}")
    shutil.rmtree(dest, ignore_errors=True)
    return True


def _uninstall_shell(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    """Run the repo's documented uninstall (uninstall_steps per-OS, or uninstall_cmd)."""
    steps = spec.uninstall_steps.get(osi.family) or spec.uninstall_steps.get("all")
    if not steps and spec.uninstall_cmd:
        steps = [spec.uninstall_cmd]
    if not steps:
        raise RuntimeError(f"{p.name}@{host.name}: repo ships no documented uninstall "
                           f"(no uninstall_steps/uninstall_cmd). Remove manually.")
    for cmd in steps:
        Log.step(" ".join(cmd))
        run(cmd, check=False)
    return True


def _uninstall_stub(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    raise RuntimeError(f"no uninstall mechanism for host '{host.name}' method '{spec.method}'.")


# ---- P1 per-agent adapters: Gemini extensions + Cursor MCP/rules ------------
GEMINI_EXT_DIR = HOME / ".gemini" / "extensions"


def _gemini_cli(host: AIHost) -> Optional[str]:
    return host.cli or shutil.which("gemini")


def gemini_ext_present(name: str) -> bool:
    return (GEMINI_EXT_DIR / name).exists()


def _adapt_gemini_extension(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    cli = _gemini_cli(host)
    if not cli:
        raise RuntimeError("gemini CLI not found")
    src = spec.gemini_source or spec.repo_url or (
        f"https://github.com/{spec.marketplace_repo}" if spec.marketplace_repo else None)
    if not src:
        raise RuntimeError(f"{p.name}: gemini_extension needs gemini_source (git url/path)")
    name = spec.gemini_name or p.name
    if gemini_ext_present(name) and not FORCE:
        Log.ok(f"{p.name}@gemini extension '{name}' already installed — skip")
        return False
    Log.step(f"gemini extensions install {src}")
    run([cli, "extensions", "install", src])
    return True


def _uninstall_gemini_extension(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    cli = _gemini_cli(host)
    if not cli:
        raise RuntimeError("gemini CLI not found")
    name = spec.gemini_name or p.name
    if not gemini_ext_present(name):
        Log.ok(f"{p.name}@gemini extension '{name}' not installed — nothing to remove")
        return False
    Log.step(f"gemini extensions uninstall {name}")
    run([cli, "extensions", "uninstall", name], check=False)
    return True


def set_gemini_extension(name: str, enabled: bool) -> Optional[str]:
    """Native reversible toggle: `gemini extensions enable|disable <name>`."""
    cli = shutil.which("gemini")
    if not cli:
        Log.warn("gemini CLI not found")
        return None
    if not gemini_ext_present(name):
        Log.warn(f"gemini extension '{name}' not installed")
        return None
    if DRY_RUN:
        Log.step(f"[dry-run] gemini extensions {'enable' if enabled else 'disable'} {name}")
        return "enabled" if enabled else "disabled"
    run([cli, "extensions", "enable" if enabled else "disable", name], check=False)
    return "enabled" if enabled else "disabled"


CURSOR_MCP_JSON = HOME / ".cursor" / "mcp.json"


def _cursor_rules_dir(spec: Optional[InstallSpec] = None) -> Path:
    if spec and spec.rules_dir:
        return Path(os.path.expanduser(os.path.expandvars(spec.rules_dir)))
    return Path.cwd() / ".cursor" / "rules"        # project-scoped (Cursor has no file-based global rules)


def _adapt_cursor_mcp(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    name = spec.mcp_name or p.name
    if not spec.mcp_server:
        raise RuntimeError(f"{p.name}: cursor_mcp needs mcp_server config (no secrets — ${{ENV}} only)")
    _gate_mcp_descriptor(p.name, host.name, name, spec.mcp_server)   # gate cmd+args+env (BYPASS #1)
    added = {"v": False}

    def mut(data):
        servers = data.setdefault("mcpServers", {})
        if name in servers and not FORCE:
            return False
        servers[name] = spec.mcp_server
        added["v"] = True
        return True

    changed = edit_json(CURSOR_MCP_JSON, mut)
    if not changed and not added["v"]:
        Log.ok(f"{name} already in {CURSOR_MCP_JSON.name} — skip")
    else:
        Log.step(f"wired MCP '{name}' into {CURSOR_MCP_JSON}  (run `cursor`/auth to provide secrets)")
    return changed


def _uninstall_cursor_mcp(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    name = spec.mcp_name or p.name

    def mut(data):
        servers = data.get("mcpServers", {})
        if name in servers:
            del servers[name]
            return True
        return False

    changed = edit_json(CURSOR_MCP_JSON, mut, create=False)
    if not changed:
        Log.ok(f"{name} not in {CURSOR_MCP_JSON.name} — nothing to remove")
    return changed


def _cursor_rule_mdc(spec: InstallSpec, name: str) -> str:
    fm = ["---", f"description: {name}"]
    if spec.rule_globs:
        fm.append(f"globs: {spec.rule_globs}")
    fm.append(f"alwaysApply: {'true' if spec.rule_always else 'false'}")
    fm.append("---")
    body = spec.rule_body or f"<rule body for {name}>"
    return "\n".join(fm) + "\n\n" + body + "\n"


def _adapt_cursor_rule(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    name = spec.rule_name or p.name
    dest = _cursor_rules_dir(spec) / f"{name}.mdc"
    if dest.exists() and not FORCE:
        Log.ok(f"{p.name}@cursor rule '{name}' already present at {dest} — skip")
        return False
    if DRY_RUN:
        Log.step(f"[dry-run] write {dest}")
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(_cursor_rule_mdc(spec, name))
    Log.step(f"wrote rule {dest}  (project-scoped)")
    return True


def _uninstall_cursor_rule(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    name = spec.rule_name or p.name
    base = _cursor_rules_dir(spec)
    for cand in (base / f"{name}.mdc", base / f"{name}.mdc.disabled"):
        if cand.exists():
            if DRY_RUN:
                Log.step(f"[dry-run] rm {cand}")
            else:
                cand.unlink()
            return True
    Log.ok(f"cursor rule '{name}' not present — nothing to remove")
    return False


def cursor_rule_state(name: str, spec: Optional[InstallSpec] = None) -> str:
    base = _cursor_rules_dir(spec)
    md, dis = base / f"{name}.mdc", base / f"{name}.mdc.disabled"
    if md.exists():
        txt = md.read_text(errors="ignore")
        return "muted" if re.search(r"(?mi)^alwaysApply:\s*false", txt) else "enabled"
    if dis.exists():
        return "disabled"
    return "absent"


def set_cursor_rule(name: str, enabled: bool, spec: Optional[InstallSpec] = None) -> Optional[str]:
    """Reversible: rename <name>.mdc <-> .mdc.disabled (project .cursor/rules/)."""
    base = _cursor_rules_dir(spec)
    return _set_file_enabled(base / f"{name}.mdc", enabled, f"cursor rule '{name}'")


# ---- P2 per-agent adapter: OpenAI Codex CLI (TOML config + prompts) ----------
CODEX_CONFIG = HOME / ".codex" / "config.toml"
CODEX_PROMPTS = HOME / ".codex" / "prompts"


def _codex_cli(host: Optional[AIHost] = None) -> Optional[str]:
    return (host.cli if host else None) or shutil.which("codex")


def _read_codex_mcp() -> dict:
    """Parse `[mcp_servers.*]` from ~/.codex/config.toml (read-only via tomllib)."""
    if not CODEX_CONFIG.exists():
        return {}
    try:
        import tomllib
        data = tomllib.loads(CODEX_CONFIG.read_text())
    except Exception:  # noqa: BLE001 — missing tomllib (<3.11) or parse error
        return {}
    servers = data.get("mcp_servers", {})
    return servers if isinstance(servers, dict) else {}


def codex_mcp_present(name: str) -> bool:
    return name in _read_codex_mcp()


def _toml_str(s) -> str:
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _toml_arr(xs) -> str:
    return "[" + ", ".join(_toml_str(x) for x in xs) + "]"


def _emit_codex_mcp_block(name: str, srv: dict) -> str:
    lines = [f"[mcp_servers.{name}]", f"command = {_toml_str(srv['command'])}"]
    if srv.get("args"):
        lines.append(f"args = {_toml_arr(srv['args'])}")
    env = srv.get("env") or {}
    if env:
        lines.append(f"[mcp_servers.{name}.env]")
        lines += [f"{k} = {_toml_str(v)}" for k, v in env.items()]
    return "\n".join(lines)


def _append_codex_mcp_toml(name: str, srv: dict) -> None:
    if DRY_RUN:
        Log.step(f"[dry-run] append [mcp_servers.{name}] to {CODEX_CONFIG}")
        return
    _backup_file(CODEX_CONFIG)
    CODEX_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    existing = CODEX_CONFIG.read_text() if CODEX_CONFIG.exists() else ""
    sep = "" if (not existing or existing.endswith("\n")) else "\n"
    CODEX_CONFIG.write_text(existing + sep + "\n" + _emit_codex_mcp_block(name, srv) + "\n")


def _remove_codex_mcp_toml(name: str) -> bool:
    if not CODEX_CONFIG.exists():
        return False
    if DRY_RUN:
        Log.step(f"[dry-run] remove [mcp_servers.{name}] table(s) from {CODEX_CONFIG}")
        return True
    _backup_file(CODEX_CONFIG)
    out, skip, removed = [], False, False
    for ln in CODEX_CONFIG.read_text().splitlines():
        s = ln.strip()
        if s.startswith("[") and s.endswith("]"):           # table header → recompute skip
            skip = (s == f"[mcp_servers.{name}]") or s.startswith(f"[mcp_servers.{name}.")
            removed = removed or skip
        if not skip:
            out.append(ln)
    CODEX_CONFIG.write_text("\n".join(out).rstrip("\n") + "\n")
    return removed


def _adapt_codex_mcp(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    name = spec.mcp_name or p.name
    srv = spec.mcp_server or {}
    if not srv.get("command"):
        raise RuntimeError(f"{p.name}: codex_mcp needs mcp_server.command (no secrets — ${{ENV}} only)")
    _gate_mcp_descriptor(p.name, "codex", name, srv)   # gate cmd+args+env before wiring (BYPASS #1)
    if codex_mcp_present(name) and not FORCE:
        Log.ok(f"{p.name}@codex MCP '{name}' already in config.toml — skip")
        return False
    cli = _codex_cli(host)
    if cli:                                                  # prefer the official CLI
        cmd = [cli, "mcp", "add", name]
        for k, v in (srv.get("env") or {}).items():
            cmd += ["--env", f"{k}={v}"]
        cmd += ["--", str(srv["command"]), *[str(a) for a in srv.get("args", [])]]
        Log.step(" ".join(cmd))
        run(cmd)
    else:                                                   # fallback: safe TOML append (backup first)
        Log.step(f"codex CLI not found — writing [mcp_servers.{name}] into {CODEX_CONFIG}")
        _append_codex_mcp_toml(name, srv)
    Log.step("provide secrets via `codex mcp login` / env — Prometheus never writes them")
    return True


def _uninstall_codex_mcp(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    name = spec.mcp_name or p.name
    if not codex_mcp_present(name):
        Log.ok(f"{p.name}@codex MCP '{name}' not present — nothing to remove")
        return False
    cli = _codex_cli(host)
    if cli:
        Log.step(f"codex mcp remove {name}")
        run([cli, "mcp", "remove", name], check=False)
        return True
    return _remove_codex_mcp_toml(name)


def codex_prompt_state(name: str) -> str:
    if (CODEX_PROMPTS / f"{name}.md").exists():
        return "enabled"
    if (CODEX_PROMPTS / f"{name}.md.disabled").exists():
        return "disabled"
    return "absent"


def set_codex_prompt(name: str, enabled: bool) -> Optional[str]:
    """Reversible: rename ~/.codex/prompts/<name>.md <-> .md.disabled."""
    return _set_file_enabled(CODEX_PROMPTS / f"{name}.md", enabled, f"codex prompt '{name}'")


def _adapt_codex_prompt(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    name = spec.prompt_name or p.name
    dest = CODEX_PROMPTS / f"{name}.md"
    if dest.exists() and not FORCE:
        Log.ok(f"{p.name}@codex prompt '{name}' already present — skip")
        return False
    if DRY_RUN:
        Log.step(f"[dry-run] write {dest}")
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(spec.prompt_body or f"<prompt body for {name}>\n")
    Log.step(f"wrote codex prompt {dest}  (invoke with /{name})")
    return True


def _uninstall_codex_prompt(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    name = spec.prompt_name or p.name
    for cand in (CODEX_PROMPTS / f"{name}.md", CODEX_PROMPTS / f"{name}.md.disabled"):
        if cand.exists():
            if DRY_RUN:
                Log.step(f"[dry-run] rm {cand}")
            else:
                cand.unlink()
            return True
    Log.ok(f"codex prompt '{name}' not present — nothing to remove")
    return False


# ---- P5.6: GitHub Copilot CLI plugin adapter (marketplace add + install) -----
def _copilot_cli(host: Optional[AIHost] = None) -> Optional[str]:
    return (host.cli if host else None) or shutil.which("copilot")


def _adapt_copilot_plugin(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    cli = _copilot_cli(host)
    if not cli:
        raise RuntimeError("copilot CLI not found")
    if not spec.marketplace_repo or not spec.plugin_id:
        raise RuntimeError(f"{p.name}: copilot_plugin needs marketplace_repo + plugin_id")
    Log.step(f"copilot plugin marketplace add {spec.marketplace_repo}")
    run([cli, "plugin", "marketplace", "add", spec.marketplace_repo], check=False)
    Log.step(f"copilot plugin install {spec.plugin_id}")
    run([cli, "plugin", "install", spec.plugin_id], check=False)
    return True


def _uninstall_copilot_plugin(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    cli = _copilot_cli(host)
    if not cli:
        raise RuntimeError("copilot CLI not found")
    if not spec.plugin_id:
        raise RuntimeError(f"{p.name}: copilot_plugin needs plugin_id to uninstall")
    Log.step(f"copilot plugin uninstall {spec.plugin_id}")
    run([cli, "plugin", "uninstall", spec.plugin_id], check=False)
    return True


# ---- P3 second-tier MCP adapters: opencode / Windsurf / Zed / Continue -------
#  All wire an MCP server into a JSON config (different top-level key per agent).
#  edit_json backs up + honors --dry-run. Secrets are never written (${ENV} only).
_AGENT_MCP_CFG = {                                   # method -> (config path, json key)
    "opencode_mcp":       ("~/.config/opencode/opencode.json", "mcp"),
    "windsurf_mcp":       ("~/.codeium/windsurf/mcp_config.json", "mcpServers"),
    "zed_context_server": ("~/.config/zed/settings.json", "context_servers"),
    "continue_mcp":       ("~/.continue/config.json", "mcpServers"),
}
_HOST_MCP_METHOD = {                                 # host name -> its MCP method (foreign routing)
    "opencode": "opencode_mcp", "windsurf": "windsurf_mcp",
    "zed": "zed_context_server", "continue": "continue_mcp",
}


def _mcp_add_json(path: Path, key: str, name: str, server: dict) -> bool:
    def mut(data):
        bucket = data.get(key)
        if isinstance(bucket, list):                 # Continue-style list of {name, ...}
            if any(isinstance(s, dict) and s.get("name") == name for s in bucket) and not FORCE:
                return False
            bucket.append({"name": name, **server})
            return True
        b = data.setdefault(key, {})
        if not isinstance(b, dict):
            return False
        if name in b and not FORCE:
            return False
        b[name] = server
        return True
    return edit_json(path, mut)


def _mcp_remove_json(path: Path, key: str, name: str) -> bool:
    def mut(data):
        bucket = data.get(key)
        if isinstance(bucket, list):
            keep = [s for s in bucket if not (isinstance(s, dict) and s.get("name") == name)]
            if len(keep) != len(bucket):
                data[key] = keep
                return True
            return False
        if isinstance(bucket, dict) and name in bucket:
            del bucket[name]
            return True
        return False
    return edit_json(path, mut, create=False)


def _agent_mcp_present(method: str, name: str) -> bool:
    pathstr, key = _AGENT_MCP_CFG[method]
    return name in _read_mcp_servers(pathstr, key)


def _adapt_agent_mcp(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    pathstr, key = _AGENT_MCP_CFG[spec.method]
    name = spec.mcp_name or p.name
    if not spec.mcp_server:
        raise RuntimeError(f"{p.name}: {spec.method} needs mcp_server config (no secrets — ${{ENV}} only)")
    _gate_mcp_descriptor(p.name, host.name, name, spec.mcp_server)   # gate cmd+args+env (BYPASS #1)
    if _agent_mcp_present(spec.method, name) and not FORCE:
        Log.ok(f"{p.name}@{host.name} MCP '{name}' already in {Path(pathstr).name} — skip")
        return False
    changed = _mcp_add_json(_expand(pathstr), key, name, spec.mcp_server)
    if changed:
        Log.step(f"wired MCP '{name}' into {pathstr} (key '{key}') — provide secrets yourself")
    return changed


def _uninstall_agent_mcp(p: Plugin, spec: InstallSpec, host: AIHost, osi: OSInfo) -> bool:
    pathstr, key = _AGENT_MCP_CFG[spec.method]
    name = spec.mcp_name or p.name
    changed = _mcp_remove_json(_expand(pathstr), key, name)
    if not changed:
        Log.ok(f"{p.name}@{host.name} MCP '{name}' not present — nothing to remove")
    return changed


# Keyed by method. A per-host override can be added later if an agent differs.
_GENERIC_ADAPTERS: dict[str, AdapterFn] = {
    "claude_plugin": _adapt_claude_plugin,    # claude-native
    "claude_marketplace": _adapt_claude_marketplace,
    "git_clone": _adapt_git_clone,
    "git_clone_shell": _adapt_git_clone_shell,
    "shell": _adapt_shell,
    "universal_skill": _adapt_universal_skill,
    "shell_or_action": _adapt_shell_or_action,
    "gemini_extension": _adapt_gemini_extension,    # P1
    "cursor_mcp": _adapt_cursor_mcp,                # P1
    "cursor_rule": _adapt_cursor_rule,              # P1
    "codex_mcp": _adapt_codex_mcp,                  # P2
    "codex_prompt": _adapt_codex_prompt,            # P2
    "opencode_mcp": _adapt_agent_mcp,               # P3
    "windsurf_mcp": _adapt_agent_mcp,               # P3
    "zed_context_server": _adapt_agent_mcp,         # P3
    "continue_mcp": _adapt_agent_mcp,               # P3
    "copilot_plugin": _adapt_copilot_plugin,        # P5.6
}

_GENERIC_UNINSTALLERS: dict[str, AdapterFn] = {
    "claude_plugin": _uninstall_claude_plugin,
    "claude_marketplace": _uninstall_claude_marketplace,
    "git_clone": _uninstall_git_clone,
    "git_clone_shell": _uninstall_shell,      # repos ship their own; dest-rm fallback below
    "shell": _uninstall_shell,
    "universal_skill": _uninstall_shell,      # uninstall_cmd = npx skills remove ...
    "shell_or_action": _uninstall_shell,
    "gemini_extension": _uninstall_gemini_extension,   # P1
    "cursor_mcp": _uninstall_cursor_mcp,               # P1
    "cursor_rule": _uninstall_cursor_rule,             # P1
    "codex_mcp": _uninstall_codex_mcp,                 # P2
    "codex_prompt": _uninstall_codex_prompt,           # P2
    "opencode_mcp": _uninstall_agent_mcp,              # P3
    "windsurf_mcp": _uninstall_agent_mcp,              # P3
    "zed_context_server": _uninstall_agent_mcp,        # P3
    "continue_mcp": _uninstall_agent_mcp,              # P3
    "copilot_plugin": _uninstall_copilot_plugin,       # P5.6
}


def resolve_adapter(host: AIHost, spec: InstallSpec) -> AdapterFn:
    return _GENERIC_ADAPTERS.get(spec.method, _adapt_stub)


def resolve_uninstaller(host: AIHost, spec: InstallSpec) -> AdapterFn:
    fn = _GENERIC_UNINSTALLERS.get(spec.method)
    # shell uninstaller with no documented removal but a cloned dir -> rm the dir
    if fn is _uninstall_shell and not (spec.uninstall_steps or spec.uninstall_cmd) and spec.dest:
        return _uninstall_git_clone
    return fn or _uninstall_stub


def is_installed(p: Plugin, host: AIHost, spec: InstallSpec) -> Optional[bool]:
    """True/False if knowable, None if not statically checkable."""
    if spec.method == "claude_plugin":
        ids = _claude_plugin_ids(spec)
        return all(claude_plugin_present(i) for i in ids) if ids else None
    if spec.method == "claude_marketplace":
        return claude_marketplace_present(spec.marketplace_name or "")
    if spec.method in ("git_clone", "git_clone_shell"):
        return Path(os.path.expandvars(os.path.expanduser(spec.dest or ""))).exists()
    if spec.method == "gemini_extension":
        return gemini_ext_present(spec.gemini_name or p.name)
    if spec.method == "cursor_mcp":
        return (spec.mcp_name or p.name) in _read_mcp_servers(str(CURSOR_MCP_JSON))
    if spec.method == "cursor_rule":
        return cursor_rule_state(spec.rule_name or p.name, spec) != "absent"
    if spec.method == "codex_mcp":
        return codex_mcp_present(spec.mcp_name or p.name)
    if spec.method == "codex_prompt":
        return codex_prompt_state(spec.prompt_name or p.name) != "absent"
    if spec.method in _AGENT_MCP_CFG:                # P3: opencode/windsurf/zed/continue MCP
        return _agent_mcp_present(spec.method, spec.mcp_name or p.name)
    if spec.method == "universal_skill":
        # The skill fans a SKILL.md folder into agents' skill dirs. CONSERVATIVE: present if a
        # matching skill folder is found on disk; else None (unknown) — NEVER False, so a
        # detector miss shows a neutral mark, not a false red ✗ (Phase 1 status-truth rule).
        cand = None
        if spec.universal_add:
            last = str(spec.universal_add[-1]).rstrip("/")
            cand = last.split("/")[-1].replace(".git", "")
        wanted = {n for n in (cand, p.name) if n}
        installed = set(list_installed_skills())
        if wanted & installed:
            return True
        # Broaden: skill dirs often normalise the name (case + separators), e.g.
        # "My Skill" / "my_skill" → "my-skill". Match on an alnum-lowercased key so an
        # installed skill is still detected (still returns None — never False — on a miss,
        # preserving the never-false-red rule).
        def _norm_skill(s: str) -> str:
            return "".join(ch for ch in s.lower() if ch.isalnum())
        inst_norm = {_norm_skill(x) for x in installed}
        if any(_norm_skill(w) in inst_norm for w in wanted):
            return True
        return None
    # shell / shell_or_action (arbitrary installers) + copilot_plugin (needs a live
    # `copilot plugin list` spawn) have NO reliable STATIC presence signal → None ('unknown',
    # neutral mark). Returning False here would paint a false red ✗ — never do that.
    return None


# ============================================================================
#  SECTION 5C — SECURITY SCANNER  (pre-install static audit)
# ============================================================================
#  Threat model (T1): plugin installers are UNTRUSTED code — a single bash
#  installer, a git-clone payload (any language), or shell steps. They run with
#  the user's privileges and can arm the PC. So Prometheus statically audits the
#  install artifacts BEFORE any adapter executes, scores findings by severity,
#  and gates the install (block / confirm / proceed). Approved sources are
#  remembered so the user is not re-warned for unchanged code.
#
#  This is heuristic static analysis, not a sandbox. It catches the common,
#  high-signal patterns; it is NOT a guarantee. Treat a clean verdict as "no
#  known-bad patterns found", not "proven safe".
# ============================================================================
import atexit
import math
import re
import tempfile
import urllib.error
import urllib.request
from glob import glob as _glob

# Scan/gate flags — wired in main().
NO_SCAN = False
ASSUME_YES = False
STRICT = False
FORCE_UNSAFE = False
SHOW_INFO = False

TRUST_FILE = PROM_DIR / "trust.json"

SEVERITY_ORDER = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}

# Files worth reading as source/installers (T3).
_SCAN_SUFFIXES = {".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts",
                  ".rb", ".pl", ".ps1", ".bat", ".cmd", ".json", ".yaml", ".yml",
                  ".toml"}
_SCAN_NAMES = {"Makefile", "makefile", "Dockerfile"}
_SCAN_PREFIXES = ("install", "setup", "bootstrap", "postinstall", "preinstall")
_MAX_FILE_BYTES = 2_000_000
_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"}

# Markdown an AI AGENT loads and acts on. This scanner reads no `.md` at all, on the premise —
# still written at the rule table below — that markdown "does not run when the plugin installs".
# For a skill, a slash command or a subagent that premise is false: the file IS the program, and
# the interpreter is a language model. A plugin whose entire payload is `skills/demo/SKILL.md`
# and `commands/deploy.md` was therefore reported CLEAN by this layer, which matters most where
# this layer is the only one running (see `_serve_tree_gate_ok`, and any run with the gate off).
#
# Deliberately NOT every `.md`: ordinary prose is full of fenced install snippets, and reading
# it all here — with no equivalent of nemesis's doc-suppression — would turn every README with a
# `curl … | sh` line into a finding. The carve-out mirrors nemesis's: agent-instruction files by
# NAME, and the directories whose markdown is agent input whatever the file is called.
_AGENT_MD_SUFFIXES = {".md", ".markdown", ".mdx", ".mdc"}
_AGENT_MD_NAMES = {
    "skill.md", "agents.md", "claude.md", "gemini.md", "copilot-instructions.md",
    "cursorrules.md", "windsurfrules.md",
}
_AGENT_MD_DIRS = ("commands", "agents", "skills", "prompts", "rules", "command")


def _is_agent_markdown(fn: str, dirpath: str) -> bool:
    """True for markdown an agent executes: by filename, or by the directory it sits in."""
    low = fn.lower()
    if os.path.splitext(low)[1] not in _AGENT_MD_SUFFIXES:
        return False
    if low in _AGENT_MD_NAMES:
        return True
    parts = {p.lower().lstrip(".") for p in Path(dirpath).parts}
    return any(d in parts for d in _AGENT_MD_DIRS)


def _is_scannable(fn: str, dirpath: str) -> bool:
    """Does this file get read by the 5C regex layer? One predicate, so the COUNT cannot drift
    from what was actually inspected."""
    return (Path(fn).suffix.lower() in _SCAN_SUFFIXES
            or fn in _SCAN_NAMES
            or fn.lower().startswith(_SCAN_PREFIXES)
            or _is_agent_markdown(fn, dirpath))


def _count_scannable(root: Path) -> int:
    """How many files the 5C layer would actually open under `root`."""
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        n += sum(1 for fn in filenames if _is_scannable(fn, dirpath))
    return n


@dataclass
class Rule:
    id: str
    severity: str
    pattern: re.Pattern
    desc: str
    advice: str


def _rx(p: str) -> re.Pattern:
    return re.compile(p, re.IGNORECASE)


# Rule engine (R1..R9). Patterns are intentionally broad — false positives are
# acceptable for a security gate; the user confirms.
RULES: list[Rule] = [
    # R1 destructive FS
    #  A bare `rm -rf <relative|$VAR>` (installer cleaning its own dir) = HIGH
    #  (confirm). Only `rm -rf` of a system/home LITERAL or --no-preserve-root is
    #  critical (block). Split so a benign self-clean doesn't hard-block.
    # Critical ONLY for a WHOLE root/home/system-dir wipe: `rm -rf /`, `/*`, `~`, `$HOME`, or a
    # top-level system dir wiped entirely (`/var`, `/var/*`, `/etc `). A deep sub-path delete
    # like `rm -rf /var/lib/apt/lists/*` (routine apt-cache cleanup) is NOT this — it falls to
    # the generic low R1.rmrf. The system-dir alternative therefore requires the dir to be the
    # TERMINAL target (followed by `*`, `/*`, whitespace, or end), never `/dir/subpath`.
    Rule("R1.rmrf_sys", "critical",
         _rx(r"\brm\s+-[a-z]*[rf][a-z]*\s+(--no-preserve-root\s+)?"
             r"(/(\s|\*|$)|~(/|\s|$)|\$HOME|\$\{HOME\}|"
             r"/(etc|usr|var|bin|lib|opt|boot|sys|System|Library|Applications)(/?\*|/?\s|/?$))"),
         "recursive delete of a system/home path", "never auto-run — can wipe the machine"),
    # Down-weighted to LOW: a generic `rm -rf` (e.g. `rm -rf ./dist`, `rm -rf node_modules`,
    # a cache clean) is routine in build/setup scripts. The CATASTROPHIC form — `rm -rf /`,
    # `$HOME`, a system dir, or --no-preserve-root — is a SEPARATE critical rule (R1.rmrf_sys).
    Rule("R1.rmrf", "low", _rx(r"\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r"),
         "recursive force delete (verify the target)", "verify the target path before running"),
    Rule("R1.devwrite", "critical", _rx(r"\bdd\b[^\n]*\bof=/dev/|\bmkfs\b|>\s*/dev/sd|\bshred\b"),
         "raw device write / disk format", "destroys disks — never auto-run"),
    # R2 remote-exec / pipe to shell
    Rule("R2.pipe", "critical", _rx(r"(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b"),
         "download piped straight into a shell", "inspect the remote script first"),
    Rule("R2.procsub", "critical", _rx(r"(ba|z)?sh\s+<\(|source\s+<\(|eval\s+\$\((curl|wget)"),
         "exec of process-substituted/remote content", "run nothing you can't read"),
    # R3 privilege
    # Down-weighted to LOW: `sudo`/`su`/`doas` are routine in Dockerfiles, devcontainers, and
    # setup scripts (`sudo apt-get`, `sudo chown`). It is a signal to review, NOT a block on its
    # own — the truly dangerous privilege patterns (setuid, chmod 777, sshkeys) stay higher, and
    # the deep nemesis scan judges intent in context.
    Rule("R3.sudo", "low", _rx(r"\bsudo\b|\bsu\s+-\b|\bdoas\b"),
         "uses elevated privileges (sudo/su/doas)", "normal in setup scripts; confirm it's expected"),
    Rule("R3.chmod777", "high", _rx(r"\bchmod\s+(-[a-z]+\s+)?(0?777|a\+rwx)\b|\bchown\s+root\b"),
         "world-writable / root ownership", "tightens nothing, opens attack surface"),
    Rule("R3.setuid", "high", _rx(r"\bchmod\s+[ug]\+s\b|\b[0-7]?[4267][0-7]{3}\b\s*\$?\w*setuid"),
         "setuid/setgid bit", "setuid binaries are a privilege vector"),
    # R4 persistence
    Rule("R4.cron", "high", _rx(r"\bcrontab\b|/etc/cron|\blaunchctl\s+load|\blaunchd\b|systemctl\s+enable"),
         "scheduled/persistent execution", "installer adding persistence is suspicious"),
    Rule("R4.rc", "high", _rx(r">>\s*~?/?\.?(bashrc|zshrc|profile|bash_profile|zprofile|zshenv)"),
         "appends to shell startup file", "persistence + runs on every shell"),
    Rule("R4.sshkeys", "critical", _rx(r"\.ssh/authorized_keys|\bssh-keygen\b[^\n]*authorized"),
         "writes SSH authorized_keys", "backdoor login vector"),
    Rule("R4.hooks", "high", _rx(r"\.git/hooks/|core\.hooksPath|\.claude/hooks|/hooks/[A-Za-z]+\.(sh|js|py)"),
         "installs git/agent hooks", "hooks run automatically — review them"),
    # R5 exfil / reverse shell
    Rule("R5.revshell", "critical", _rx(r"\bnc\b[^\n]*-e\b|/dev/tcp/|/dev/udp/|bash\s+-i\s+>&|mkfifo[^\n]*\|\s*nc"),
         "reverse shell / netcat exec", "remote control of your machine"),
    # Down-weighted to LOW: a raw-IP fetch is often a localhost/health-check/mirror call
    # (127.0.0.1, 10.x, 192.168.x). Still worth a glance, but not a medium finding on its own —
    # actual exfil/C2 combines it with upload flags (R5.upload) or a reverse shell (R5.revshell).
    Rule("R5.rawip", "low", _rx(r"(curl|wget|nc|fetch)\b[^\n]*\b\d{1,3}(\.\d{1,3}){3}\b"),
         "network call to a raw IP", "check the address; often a local/health-check endpoint"),
    Rule("R5.upload", "high", _rx(r"(curl|wget)\b[^\n]*(-F|--data|-d|--upload-file|-T)\b[^\n]*(base64|/etc/|\.ssh|\.env)"),
         "uploads local/secret data", "possible exfiltration"),
    # R6 obfuscation
    Rule("R6.b64sh", "critical", _rx(r"base64\s+(-d|--decode|-D)[^\n]*\|\s*(ba|z)?sh|openssl\s+enc[^\n]*\|\s*sh"),
         "decode-then-execute", "classic payload hiding"),
    Rule("R6.evalexec", "high", _rx(r"\beval\b[^\n]*\$\(|python[0-9]?\s+-c\s+[\"'][^\"']*exec\(|node\s+-e\s+[\"'][^\"']*eval"),
         "dynamic eval/exec of code", "obscures real behavior"),
    Rule("R6.hexblob", "medium", _rx(r"(\\x[0-9a-f]{2}){12,}"),
         "long hex-encoded blob", "often hides shellcode/strings"),
    # R7 credential / secret access
    Rule("R7.creds", "high", _rx(r"~?/?\.aws/credentials|~?/?\.ssh/id_|/\.env\b|\.netrc\b|security\s+find-generic-password|/Cookies\b|/login\.keychain"),
         "reads credentials/secrets", "no installer needs your keys"),
    Rule("R7.history", "medium", _rx(r"\.(bash|zsh)_history\b|/Cookies/|/History\b"),
         "reads shell/browser history", "data-harvesting signal"),
    # R8 security tamper
    Rule("R8.sip", "critical", _rx(r"\bcsrutil\s+disable\b|\bspctl\s+--master-disable\b|defaults\s+write[^\n]*GloballyEnabled\s+-bool\s+false"),
         "disables OS security (SIP/Gatekeeper/firewall)", "never let an installer do this"),
    Rule("R8.histwipe", "medium", _rx(r"\bhistory\s+-c\b|unset\s+HISTFILE|HISTFILE=/dev/null|set\s+\+o\s+history"),
         "wipes/disables command history", "anti-forensics signal"),
    Rule("R8.killsec", "medium", _rx(r"\b(pkill|killall)\b[^\n]*(mdworker|XProtect|socketfilterfw|Little\s*Snitch|firewall)"),
         "kills security processes", "tampering with defenses"),
]

# Long high-entropy token heuristic (R6) — flags likely encoded payloads.
_TOKEN_RX = re.compile(r"[A-Za-z0-9+/=_-]{60,}")

# Context discrimination — cut false positives.
#   A pattern match only matters if it is EXECUTABLE install code. The same text
#   in a comment, a markdown doc, a test assertion, or a CI workflow does not run
#   when the plugin installs, so its severity is dropped to "info" (still listed
#   under --show-info, but it no longer drives the verdict/gate).
_DOC_SUFFIXES = {".md", ".rst", ".txt", ".adoc"}
_CODE_COMMENT_PREFIX = {
    ".py": ("#",), ".rb": ("#",), ".pl": ("#",), ".sh": ("#",), ".bash": ("#",),
    ".zsh": ("#",), ".yaml": ("#",), ".yml": ("#",), ".toml": ("#",),
    ".js": ("//", "*", "/*"), ".mjs": ("//", "*", "/*"), ".cjs": ("//", "*", "/*"),
    ".ts": ("//", "*", "/*"),
    ".ps1": ("#",), ".bat": ("::", "rem "), ".cmd": ("::", "rem "),
}


def _file_role(rel_path: str) -> str:
    """code | test | doc | ci — drives severity weighting."""
    low = rel_path.replace("\\", "/").lower()
    parts = low.split("/")
    name = parts[-1]
    suffix = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    if any(p in ("tests", "test", "__tests__", "fixtures", "testdata", "spec") for p in parts) \
            or name.startswith("test_") or any(t in name for t in ("_test.", ".test.", ".spec.")):
        return "test"
    if any(p in (".github", ".gitlab", ".circleci", "ci") for p in parts):
        return "ci"
    if any(p in ("docs", "doc", "examples", "example", "samples", "demo") for p in parts) \
            or suffix in _DOC_SUFFIXES:
        return "doc"
    return "code"


def _is_comment(line: str, suffix: str) -> bool:
    s = line.strip()
    if not s:
        return False
    for pre in _CODE_COMMENT_PREFIX.get(suffix, ()):
        if s.startswith(pre):
            return True
    return False


def _effective_severity(base: str, role: str, is_comment: bool) -> tuple[str, str]:
    """Return (effective_severity, context_reason)."""
    if role in ("test", "doc", "ci"):
        return "info", role          # not executed on install
    if is_comment:
        return "info", "comment"     # not executed
    return base, "code"


# Rules that fire on the mere PRESENCE of a sensitive path/keyword. For these, a
# match that lives inside a string literal or an echo/print/log message is a
# MENTION, not an executed action → suppress. (An action like `cat ~/.aws/...`
# or `cp x ~/.claude/hooks/` has the path as a bare argument and still fires.)
#  Also the remote-exec/obfuscation rules: a `curl … | sh` printed inside a help
#  string ("Install: curl … | sh") is documentation, not an executed pipe; a bare
#  `curl … | sh` on its own line still fires.
_PATH_MENTION_RULES = {"R4.hooks", "R7.creds", "R7.history", "R4.rc",
                       "R2.pipe", "R2.procsub", "R6.b64sh"}
_MSG_LINE_RX = re.compile(
    r"^\s*(echo|printf|print|println|puts|console\.(log|error|warn|info)|"
    r"Write-Host|Write-Output|logger|log|say)\b", re.IGNORECASE)


def _quoted_ranges(line: str) -> list[tuple[int, int]]:
    ranges, i, n = [], 0, len(line)
    while i < n:
        ch = line[i]
        if ch in "\"'`":
            q, j = ch, i + 1
            while j < n and line[j] != q:
                j += 2 if line[j] == "\\" else 1
            ranges.append((i, j))
            i = j + 1
        else:
            i += 1
    return ranges


def _is_mention(line: str, start: int, end: int) -> bool:
    if _MSG_LINE_RX.match(line):
        return True
    return any(s <= start and end <= e + 1 for s, e in _quoted_ranges(line))


@dataclass
class Finding:
    rule: Rule
    rel_path: str
    line_no: int
    snippet: str
    severity: str = ""               # effective severity (after context weighting)
    context: str = "code"            # code | comment | test | doc | ci

    def __post_init__(self):
        if not self.severity:
            self.severity = self.rule.severity

    @property
    def active(self) -> bool:
        return self.context == "code"


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    freq = {c: s.count(c) for c in set(s)}
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in freq.values())


def _is_binary(data: bytes) -> bool:
    return b"\x00" in data[:4096]


def _join_continuations(text: str) -> list[tuple[int, str]]:
    """Collapse shell line-continuations into logical lines so a payload split across
    physical lines still matches the single-line rules. A physical line that ends with an
    odd number of backslashes (`curl x \\` <nl> `| sh`) or with a trailing pipe
    (`curl x |` <nl> `sh`) continues onto the next. Reported line number = the logical
    line's first physical line. Defeats multi-line scanner evasion."""
    out: list[tuple[int, str]] = []
    buf = ""
    start = 0
    for i, raw in enumerate(text.splitlines(), 1):
        if start == 0:
            start = i
        stripped = raw.rstrip()
        trailing_bs = len(stripped) - len(stripped.rstrip("\\"))
        if trailing_bs % 2 == 1:                       # shell `\` line-continuation
            buf += stripped[:-1] + " "
            continue
        if stripped.endswith("|"):                     # pipeline continues on the next line
            buf += stripped + " "
            continue
        out.append((start, buf + raw))
        buf = ""; start = 0
    if buf:
        out.append((start or 1, buf))
    return out


def _scan_text(rel_path: str, text: str, role: Optional[str] = None) -> list[Finding]:
    findings: list[Finding] = []
    if role is None:
        role = _file_role(rel_path)
    suffix = ("." + rel_path.rsplit(".", 1)[-1].lower()) if "." in rel_path else ""
    for i, line in _join_continuations(text):
        comment = _is_comment(line, suffix)
        for rule in RULES:
            m = rule.pattern.search(line)
            if not m:
                continue
            eff, ctx = _effective_severity(rule.severity, role, comment)
            if ctx == "code" and rule.id in _PATH_MENTION_RULES and _is_mention(line, m.start(), m.end()):
                eff, ctx = "info", "mention"
            findings.append(Finding(rule, rel_path, i, line.strip()[:160], eff, ctx))
        for tok in _TOKEN_RX.findall(line):
            if _shannon_entropy(tok) >= 4.3:
                eff, ctx = _effective_severity("medium", role, comment)
                findings.append(Finding(
                    Rule("R6.entropy", "medium", _TOKEN_RX,
                         "long high-entropy string", "may be an encoded/obfuscated payload"),
                    rel_path, i, (tok[:40] + "…"), eff, ctx))
                break
    return findings


def _walk_and_scan(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for fn in filenames:
            if not _is_scannable(fn, dirpath):
                continue
            fpath = Path(dirpath) / fn
            try:
                data = fpath.read_bytes()
            except OSError:
                continue
            if len(data) > _MAX_FILE_BYTES or _is_binary(data):
                continue
            rel = str(fpath.relative_to(root))
            findings += _scan_text(rel, data.decode("utf-8", "replace"))
    return findings


@dataclass
class ScanReport:
    plugin: str
    source: str            # repo / dir / "shell"
    identity: str          # commit sha or dir hash — trust key
    findings: list[Finding]
    scanned_files: int = 0

    @property
    def active(self) -> list[Finding]:
        """Findings that are real executable install code (drive the verdict)."""
        return [f for f in self.findings if f.active]

    @property
    def downgraded(self) -> list[Finding]:
        """Matches in comments/docs/tests/CI — context-suppressed to info."""
        return [f for f in self.findings if not f.active]

    @property
    def verdict(self) -> str:
        act = self.active
        if not act:
            return "clean"
        return max((f.severity for f in act), key=lambda s: SEVERITY_ORDER[s])

    def counts(self) -> dict[str, int]:
        out = {"critical": 0, "high": 0, "medium": 0, "low": 0}
        for f in self.active:
            if f.severity in out:
                out[f.severity] += 1
        return out


# ---- artifact gathering (T2) ----------------------------------------------
def _git_identity(path: Path) -> str:
    git = shutil.which("git")
    if git:
        p = _run_timed([git, "-C", str(path), "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=30)
        if p.returncode == 0:
            return p.stdout.strip()[:16]
    return "dir:" + str(abs(hash(str(path))))[:12]


def _fetch_text(url: str, max_bytes: int = _MAX_FILE_BYTES) -> Optional[str]:
    """Download a remote installer script for static audit (curl|sh tuning)."""
    try:
        with urllib.request.urlopen(url, timeout=15) as r:  # noqa: S310 — explicit https installer
            data = r.read(max_bytes + 1)
    except Exception:  # noqa: BLE001 — network/parse failure = unfetched
        return None
    if len(data) > max_bytes or _is_binary(data):
        return None
    return data.decode("utf-8", "replace")


def _temp_clone(repo: str) -> Optional[Path]:
    git = shutil.which("git")
    if not git:
        return None
    url = repo if repo.startswith(("http", "git@")) else f"https://github.com/{repo}.git"
    tmp = Path(tempfile.mkdtemp(prefix="prom_sec_"))
    p = _run_timed(_git_clone_argv(git, url, str(tmp)),
                       capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        shutil.rmtree(tmp, ignore_errors=True)
        return None
    return tmp


# --------------------------------------------------------------------------- #
# nemesis security gate — vet a materialized source BEFORE installing it.
# Subprocess + JSON contract (see nemesis `gate`). Fail-closed: a missing/erroring
# scanner, or a block verdict, aborts the install. Override with PROMETHEUS_GATE.
# Verdict tiers: allow → proceed · warn → proceed unless it carries critical/high
# findings (then the same confirm-default-NO flow as the 5C gate, remembered in
# the trust store) · block/error → abort.
# --------------------------------------------------------------------------- #
def _find_nemesis() -> str:
    env = os.environ.get("NEMESIS_BIN")
    if env:
        return env
    sib = Path(__file__).resolve().parent / "nemesis"
    if sib.exists():
        return str(sib)
    return shutil.which("nemesis") or str(sib)


NEMESIS_BIN = _find_nemesis()
GATE_MODE = os.environ.get("PROMETHEUS_GATE", "enforce").lower()  # enforce | warn | off
GATE_FRESH = False            # --gate-fresh: bypass the nemesis verdict cache
_GATE_AUDIT_LOG = Path(os.path.expanduser("~")) / ".nemesis" / "gate-audit.jsonl"

# Auto-prepare: before the FIRST gated scan of a run, nemesis seeds its signature
# DB (first use) or refreshes it (stale), so every install is scored against the
# freshest feeds. nemesis `update` is idempotent — per-feed TTL skips fresh feeds,
# so repeat installs are cheap. Best-effort + memoized once per process.
_NEMESIS_PREP_TIMEOUT = int(os.environ.get("PROMETHEUS_PREP_TIMEOUT", "600"))
_NEMESIS_PREPARED: Optional[dict] = None     # memoized prepare_nemesis() result
_DANGER_OVERRIDES: list = []                 # forced installs of BLOCK/error verdicts
_GATE_DISABLED = False                        # set when --no-gate/--gate-mode off|warn was confirmed

# Per-tier nemesis policies. Pentest/offensive sources get a stricter bar
# (SAST vulns block, lower risk threshold); everything else uses nemesis defaults.
_GATE_POLICIES = {
    "pentest": {"vuln_block": True, "block_score": 50},
}


def _silent_unlink(path: str) -> None:
    """Best-effort removal for the temp policy files; never raises at interpreter exit."""
    try:
        os.unlink(path)
    except OSError:
        pass


# Temp policy files minted under --dry-run, one per tier, cleaned up when the process ends.
_DRY_RUN_POLICY_FILES: dict[str, str] = {}


def _gate_policy_file(tier: str) -> Optional[str]:
    body = _GATE_POLICIES.get(tier)
    if not body:
        return None
    p = PROM_DIR / f"nemesis-policy-{tier}.json"
    want = json.dumps(body, indent=2) + "\n"
    if DRY_RUN:
        """--dry-run is documented as "print actions, change nothing", and this wrote.

        `pentest install` runs its two pentest-tier gates BEFORE the dry-run early return, and
        the gate path lands here — which mkdir -p'd PROM_DIR and, by design, OVERWROTE a
        "drifted/hand-edited" policy with the code-side default. So previewing an install
        silently destroyed a policy file the operator had deliberately tuned.

        Skipping the write outright would drop the gate to its laxer DEFAULT policy and make the
        preview report a different verdict than the real install, which is its own kind of lie.
        So the body goes to a TEMP file instead: the scan runs at exactly the right tier, and
        nothing under PROM_DIR is created or touched.
        """
        cached = _DRY_RUN_POLICY_FILES.get(tier)
        if cached and os.path.exists(cached):
            return cached
        try:
            fd, tmp = tempfile.mkstemp(prefix=f"nemesis-policy-{tier}-", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(want)
            _DRY_RUN_POLICY_FILES[tier] = tmp
            atexit.register(lambda path=tmp: _silent_unlink(path))
            return tmp
        except OSError as e:
            Log.warn(f"cannot stage {tier} gate policy for the dry run ({e}) — nemesis runs "
                     f"with its laxer DEFAULT policy for this scan")
            return None
    try:
        # _GATE_POLICIES is the source of truth: rewrite a drifted/hand-edited
        # file so a code-side tightening actually reaches the gate.
        if not p.exists() or p.read_text() != want:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(want)
        return str(p)
    except OSError as e:
        Log.warn(f"cannot write {tier} gate policy ({e}) — nemesis runs with its "
                 f"laxer DEFAULT policy for this scan")
        return None


def _gate_audit(label: str, target: str, verdict: dict,
                decision: Optional[str] = None, tier: str = "default") -> None:
    try:
        _GATE_AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        rec = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "label": label, "target": target,
            "verdict": verdict.get("verdict"), "risk_score": verdict.get("risk_score"),
            "blocking_reasons": verdict.get("blocking_reasons"),
            "decision": decision,                # proceed | refuse | None (informational)
            "tier": tier, "gate_mode": GATE_MODE,
            # full signed verdict: `nemesis verify` needs every canonical field,
            # not a summary — extract this object to a file and verify it there.
            "verdict_full": verdict,
        }
        if DRY_RUN:
            rec["dry_run"] = True
        with open(_GATE_AUDIT_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")
    except OSError:
        pass


def nemesis_gate(target: str, tier: str = "default",
                 stdin_text: Optional[str] = None) -> dict:
    """Run nemesis as a pre-install gate; return its verdict dict. Fail-closed.
    target '-' scans stdin_text (fetched installer/compose bodies — the code
    never has to land in an install location to be vetted)."""
    prepare_nemesis()       # seed/refresh the signature DB before ANY scan path
    if not os.path.exists(NEMESIS_BIN):
        return {"verdict": "error", "exit_code": 2,
                "error": f"nemesis not found (env NEMESIS_BIN, script dir, PATH) — looked at {NEMESIS_BIN}",
                "recommendation": "scanner missing — fail-closed. Place `nemesis` next to "
                                  "prometheus.py or set NEMESIS_BIN."}
    cmd = [sys.executable, NEMESIS_BIN, "gate",
           "--sandbox", "auto", "--jail", "auto", "--timeout", "840", "--sign"]
    pol = _gate_policy_file(tier)
    if pol:
        cmd += ["--policy", pol]
    if GATE_FRESH:
        cmd += ["--no-cache"]
    # "--" end-of-options so a target beginning with '-' is the positional, never a flag.
    cmd += ["--", target]
    try:
        # --timeout 840 lets nemesis self-abort with a clean fail-closed verdict JSON
        # (exit 2 + a reason we can audit) before the outer subprocess 900s SIGKILL,
        # which would otherwise leave us with empty stdout / "unparseable verdict".
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=900,
                           input=(stdin_text if target == "-" else None))
    except (OSError, subprocess.SubprocessError) as e:
        return {"verdict": "error", "exit_code": 2, "error": str(e),
                "recommendation": "scanner failed — fail-closed"}
    try:
        verdict = json.loads(p.stdout)
    except (json.JSONDecodeError, ValueError):
        return {"verdict": "error", "exit_code": 2, "error": (p.stderr or p.stdout)[:200],
                "recommendation": "unparseable verdict — fail-closed"}
    # Defense-in-depth: reconcile nemesis's PROCESS exit code with the parsed verdict.
    # nemesis exit map: allow=0, warn=10, block=20, error=2. If the two disagree (e.g.
    # truncated/tampered stdout that parsed to a permissive verdict while the process
    # exited block/error), fail-closed to the STRICTER of the two.
    rc = p.returncode
    rc_verdict = {0: "allow", 10: "warn", 20: "block", 2: "error"}.get(rc)
    _rank = {"allow": 0, "warn": 1, "block": 2, "error": 3}
    parsed_v = verdict.get("verdict") if isinstance(verdict, dict) else None
    if rc_verdict and parsed_v in _rank and _rank[rc_verdict] > _rank[parsed_v]:
        return {"verdict": rc_verdict, "exit_code": rc,
                "error": f"exit/verdict mismatch (process exit {rc}={rc_verdict}, "
                         f"stdout verdict {parsed_v}) — fail-closed to the stricter",
                "recommendation": "scanner exit code and verdict disagree — fail-closed",
                "reconciled_from": parsed_v}
    if rc_verdict is None and rc != 0:
        return {"verdict": "error", "exit_code": 2,
                "error": f"nemesis exited with unrecognized non-zero code {rc}",
                "recommendation": "unrecognized scanner exit — fail-closed"}
    return verdict


def prepare_nemesis() -> dict:
    """Seed/refresh the nemesis signature DB BEFORE the gate scans an install.

    Run automatically before the first gated scan of a prometheus invocation:
      * first ever use (no DB) → full seed of the enabled feeds;
      * stale DB              → refresh;
      * fresh DB              → nemesis TTL-skips every feed (cheap no-op).
    Best-effort and memoized once per process. A network failure does NOT abort:
    if a DB already exists the scan proceeds against it; on a first-use offline box
    the signature/IOC/CVE layers stay inactive but the static + AST + heuristic
    engine still gates (and the verdict surfaces the empty-DB warning). `--gate-fresh`
    forces a full re-download (passes nemesis `update --force`)."""
    global _NEMESIS_PREPARED
    if _NEMESIS_PREPARED is not None:
        return _NEMESIS_PREPARED
    res = {"ran": False, "ok": False, "note": ""}
    if GATE_MODE == "off":
        res["note"] = "gate off — DB prepare skipped"
        _NEMESIS_PREPARED = res
        return res
    if not os.path.exists(NEMESIS_BIN):
        res["note"] = "nemesis binary missing — prepare skipped (gate fails closed)"
        _NEMESIS_PREPARED = res
        return res
    Log.info("nemesis: preparing the malware signature DB (seed/refresh) before scanning…")
    cmd = [sys.executable, NEMESIS_BIN, "update"]
    if GATE_FRESH:
        cmd.append("--force")
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=_NEMESIS_PREP_TIMEOUT)
        res["ran"] = True
        res["ok"] = (p.returncode == 0)
        if not res["ok"]:
            res["note"] = (p.stderr or p.stdout or "update returned non-zero").strip()[:200]
    except subprocess.TimeoutExpired:
        res["ran"] = True
        res["note"] = f"update exceeded {_NEMESIS_PREP_TIMEOUT}s — using the existing DB"
    except (OSError, subprocess.SubprocessError) as e:
        res["note"] = f"update could not run: {e}"
    if res["ok"]:
        Log.ok("nemesis: signature DB ready — scanning against the latest feeds")
    else:
        Log.warn(f"nemesis: DB prepare incomplete ({res['note']}) — the scan proceeds "
                 f"with static analysis + whatever signatures are already cached")
    _NEMESIS_PREPARED = res
    return res


def _danger_banner(label: str, verdict: str, score, reasons: list) -> None:
    """Loud, deep-red DANGER banner shown on a BLOCK/error verdict before any
    forced override — the operator must not be able to miss what they install."""
    red = "\033[1;97;41m"      # bold white on red
    rst = "\033[0m"
    use = Log.USE_COLOR
    out = Log.STREAM

    def line(s: str) -> None:
        print((f"{red} {s:<70}{rst}" if use else s), file=out)

    unverified = (verdict == "error")
    print("", file=out)
    line("  ☠  DANGER  ☠   nemesis flagged this source as UNSAFE TO INSTALL")
    if unverified:
        line("     The scanner could NOT verify this code — installing is UNVERIFIED.")
    else:
        line("     Installing it may execute MALICIOUS code on your machine.")
    line(f"     {label}    verdict={verdict.upper()}    risk={score}/100")
    for r in (reasons or [])[:6]:
        line(f"       • {str(r)[:62]}")
    print("", file=out)


def _confirm_dangerous_override(label: str, v: dict, verdict: str, score) -> bool:
    """A BLOCK (dangerous) or error (unverifiable) verdict. Refuse by default.
    Allow ONLY with an explicit --force (alias --force-unsafe) override, behind the
    deep-red DANGER banner and, on a TTY, a typed confirmation. User contract:
    script → pass --force; plugin → call `/prometheus --force`."""
    reasons = v.get("blocking_reasons") or []
    _danger_banner(label, verdict, score, reasons)
    if not (FORCE or FORCE_UNSAFE):
        Log.err(f"install REFUSED — {label} is dangerous (nemesis {verdict.upper()}); it "
                f"will NOT be installed. To override at your own risk re-run with --force "
                f"(in a plugin: call `/prometheus --force`).")
        return False
    # --force present: the operator is explicitly overriding a dangerous verdict.
    if sys.stdin.isatty() and not ASSUME_YES:
        Log.warn("--force given on DANGEROUS code — one final confirmation required.")
        ans = input(f"    {Log._c('!!', 'red')} type 'install-dangerous' to proceed "
                    f"(anything else aborts): ").strip().lower()
        if ans != "install-dangerous":
            Log.warn("aborted — dangerous code NOT installed")
            return False
    Log.err(f"⚠ FORCED install of DANGEROUS code: {label} (nemesis {verdict.upper()}, "
            f"risk {score}/100) — proceeding under --force at the operator's risk")
    _DANGER_OVERRIDES.append({"label": label, "verdict": verdict, "risk_score": score,
                              "blocking_reasons": reasons[:8]})
    return True


def _confirm_gate_disable(mode: str) -> bool:
    """Disabling/weakening the nemesis gate (--no-gate / --gate-mode off|warn) is a SECURITY
    decision and must be as explicit as --force (closes BYPASS #2: one boolean flag from the
    GUI/CLI could silently disable scanning of shell-exec installs). Returns True only if the
    operator explicitly confirmed; otherwise the gate stays ENFORCED (fail-closed).

      • interactive TTY  → require typing 'disable-gate' (anything else keeps the gate on);
      • non-interactive  → refuse UNLESS PROM_ALLOW_FORCE=1 (the CI escape, same as --force).

    On confirm it sets _GATE_DISABLED so the result envelope can never be reported clean.
    """
    global _GATE_DISABLED
    Log.warn(f"⚠ you are DISABLING the nemesis security gate (gate-mode={mode}); installs will "
             f"NOT be scanned for backdoors / malware / supply-chain threats.")
    if sys.stdin.isatty() and not ASSUME_YES:
        ans = input(f"    {Log._c('!!', 'red')} type 'disable-gate' to proceed UNSCANNED "
                    f"(anything else keeps the gate on): ").strip().lower()
        if ans != "disable-gate":
            Log.ok("keeping the nemesis gate ENFORCED — the safer choice")
            return False
    elif os.environ.get("PROM_ALLOW_FORCE") != "1":
        Log.err("refusing to disable the nemesis gate non-interactively without "
                "PROM_ALLOW_FORCE=1 — gate stays ENFORCED (fail-closed)")
        return False
    _GATE_DISABLED = True
    Log.err(f"⚠ nemesis gate DISABLED (gate-mode={mode}) at the operator's risk — "
            f"this run's result is marked unscanned, never clean")
    return True


def _tree_ident(path: str) -> str:
    """Content-bound identity for a directory: git HEAD when available, else a
    hash over the (relpath, size) listing. Keeps a warn-approval pinned to WHAT
    was approved, not just the label."""
    p = Path(path)
    if (p / ".git").exists():
        ident = _git_identity(p)
        if ident and ident != "unknown":
            return ident
    h = hashlib.sha256()
    try:
        files = sorted(str(f.relative_to(p)) + ":" + str(f.stat().st_size)
                       for f in p.rglob("*") if f.is_file())[:4000]
        for line in files:
            h.update(line.encode("utf-8", "replace"))
            h.update(b"\n")
    except OSError:
        return "unreadable"
    return "tree:" + h.hexdigest()[:16]


def _gate_ident(target: str, v: dict, stdin_text: Optional[str]) -> str:
    if target == "-" and stdin_text is not None:
        return "stdin:" + hashlib.sha256(stdin_text.encode("utf-8", "replace")).hexdigest()[:16]
    if v.get("target_sha256"):
        return str(v["target_sha256"])
    if os.path.isdir(target):
        return _tree_ident(target)
    # remote URL / owner-repo: pin to the findings shape + ruleset (best available)
    c = v.get("severity_counts") or {}
    tops = ",".join(sorted(f"{f.get('rule_id')}@{f.get('path')}"
                           for f in (v.get("top_findings") or [])[:10]))
    return ("remote:" + (v.get("provenance") or {}).get("ruleset_sha", "")
            + ":" + json.dumps(c, sort_keys=True) + ":" + tops)


def _gate_trust_key(label: str, ident: str) -> str:
    return f"nemesis:{label}#{ident}"


def _gate_confirm_warn(label: str, v: dict, ident: str) -> bool:
    """A WARN verdict that carries critical/high findings (or medium under
    --strict) needs the same explicit approval as the 5C gate: default NO,
    remembered in the trust store on approve. Ordering mirrors security_gate:
    --strict refuses outright (only --force-unsafe overrides) BEFORE --yes."""
    counts = v.get("severity_counts") or {}
    serious = counts.get("CRITICAL", 0) + counts.get("HIGH", 0)
    if STRICT:
        serious += counts.get("MEDIUM", 0)
    if not serious:
        return True                                  # low-grade warn — proceed, logged
    if DRY_RUN:
        Log.warn(f"[dry-run] nemesis WARN with {serious} serious finding(s) on {label} "
                 f"— a real run would prompt for approval here")
        return True
    key = _gate_trust_key(label, ident)
    if key in _load_trust() and not FORCE:
        Log.ok(f"nemesis WARN previously approved for {label} (trust store) — proceeding")
        return True
    Log.warn(f"nemesis WARN carries {serious} serious finding(s) for {label}:")
    Log.step(f"  {v.get('recommendation', '')}")
    for f in (v.get("top_findings") or [])[:3]:
        Log.step(f"  • [{f.get('severity')}] {f.get('rule_id')} {f.get('path')}:{f.get('line')}")
    if STRICT and not FORCE_UNSAFE:
        Log.err(f"BLOCKED (--strict): serious nemesis WARN findings on {label}. "
                f"Override: --force-unsafe")
        return False
    if FORCE_UNSAFE:
        Log.warn("--force-unsafe — proceeding despite serious WARN findings")
        return True
    if ASSUME_YES:
        Log.warn("auto-approved serious WARN via --yes")
        data = _load_trust()
        data[key] = {"source": v.get("target"), "verdict": "warn", "approvedBy": "--yes"}
        _save_trust(data)
        return True
    if not sys.stdin.isatty():
        Log.err(f"non-interactive + serious WARN findings on {label} → refusing. "
                f"Use --yes to approve.")
        return False
    ans = input(f"    {Log._c('?', 'yellow')} nemesis flagged {label} (warn tier, "
                f"{serious} serious). Install anyway? [y/N] ").strip().lower()
    if ans in ("y", "yes"):
        data = _load_trust()
        data[key] = {"source": v.get("target"), "verdict": "warn", "approvedBy": "user"}
        _save_trust(data)
        return True
    Log.warn("declined by user")
    return False


def enforce_gate(target: str, label: str, tier: str = "default",
                 stdin_text: Optional[str] = None) -> bool:
    """True ⇒ safe to proceed with the install. Fail-closed on block/error;
    warn verdicts with critical/high findings require explicit approval."""
    if GATE_MODE == "off":
        Log.warn(f"nemesis gate disabled (--no-gate / PROMETHEUS_GATE=off) — {label} NOT vetted")
        return True
    # nemesis_gate() seeds/refreshes the signature DB (prepare_nemesis) before it
    # scans, so every gated source is scored against the freshest feeds.
    v = nemesis_gate(target, tier=tier, stdin_text=stdin_text)
    verdict = v.get("verdict", "error")
    score = v.get("risk_score", "?")
    db = (v.get("provenance") or {}).get("db") or {}
    if db and not db.get("seeded", True):
        Log.warn("nemesis signature DB is EMPTY — hash/IOC/CVE layers inactive. "
                 "Seed it: nemesis update")
    elif db.get("stale"):
        Log.warn(f"nemesis signature DB is {db.get('age_days')} days old — refresh: nemesis update")
    ok: bool
    if verdict == "allow":
        Log.ok(f"nemesis: ALLOW {label} (risk {score}/100)")
        ok = True
    elif verdict == "warn":
        Log.warn(f"nemesis: WARN {label} (risk {score}/100) — {v.get('recommendation', '')}")
        for r in (v.get("blocking_reasons") or [])[:5]:
            Log.step(f"  • {r}")
        if GATE_MODE == "warn":
            ok = True        # gate-mode warn: log every tier and proceed, uniformly
        else:
            ok = _gate_confirm_warn(label, v, _gate_ident(target, v, stdin_text))
    else:
        # block or error → dangerous / unverifiable code. Fail-closed by default;
        # an explicit --force overrides behind the deep-red DANGER banner.
        Log.err(f"nemesis: {verdict.upper()} {label} (risk {score}/100) — {v.get('recommendation', '')}")
        for r in (v.get("blocking_reasons") or [])[:8]:
            Log.step(f"  • {r}")
        if GATE_MODE == "warn":
            Log.warn("gate-mode=warn — overriding block and proceeding")
            ok = True
        else:
            ok = _confirm_dangerous_override(label, v, verdict, score)
    if not ok:
        decision = "refuse"
    elif verdict in ("allow", "warn"):
        decision = "proceed"
    else:
        decision = "proceed-forced-danger"     # a BLOCK/error overridden by --force
    _gate_audit(label, target, v, decision=decision, tier=tier)
    return ok


def enforce_gate_text(text: str, label: str, tier: str = "default") -> bool:
    """Gate an in-memory body (fetched installer script, compose file, build
    recipe) through `nemesis gate -` — nothing is written to disk here."""
    return enforce_gate("-", label, tier=tier, stdin_text=text)


def _gate_shell_steps(plugin_name: str, host_name: str, steps, suffix: str = "") -> None:
    """SELF-GATE raw shell steps through nemesis BEFORE running them. Fail-closed.

    Shell-exec methods (shell / shell_or_action / git_clone_shell setup-steps) have NO
    materialized tree for `_gate_targets_for_spec` to return, so the standalone enforce_gate
    loop in `_run_installs` iterates zero targets and the regex pre-scan is skipped under
    --no-scan. The literal command BYTES are therefore vetted here, in the adapter, on a code
    path --no-scan cannot reach — so the nemesis gate fires for these methods regardless
    (closing the historical BYPASS #1). Raises on a blocked verdict.
    """
    body = "\n".join(" ".join(str(c) for c in cmd) for cmd in (steps or []))
    if not body.strip():
        return
    if not enforce_gate_text(body, f"{plugin_name}@{host_name} shell steps{suffix}"):
        raise RuntimeError(f"{plugin_name}: shell steps blocked by nemesis security gate")


def _gate_mcp_descriptor(plugin_name: str, host_name: str, mcp_name: str, server: dict) -> None:
    """SELF-GATE an MCP server descriptor (command + args + env) before it is wired into an
    agent config. Same rationale as `_gate_shell_steps`: cursor_mcp/codex_mcp have no gate
    target, so the descriptor bytes are vetted here, fail-closed. Raises on block."""
    body = json.dumps(server or {}, sort_keys=True)
    if not enforce_gate_text(body, f"{plugin_name}@{host_name} mcp {mcp_name}"):
        raise RuntimeError(
            f"{plugin_name}: MCP descriptor '{mcp_name}' blocked by nemesis security gate")


def _gate_targets_for_spec(spec: "InstallSpec") -> list[str]:
    """Remote sources a spec will pull code from, for methods whose adapters do
    not already gate a materialized tree themselves. git_clone(_shell) returns
    []: its adapter gates the staged clone on disk (deeper than a URL re-fetch)."""
    m = spec.method
    if m in ("claude_plugin", "claude_marketplace"):
        return [r for r in (spec.marketplace_repo,
                            getattr(spec, "secondary_marketplace_repo", None)) if r]
    if m == "copilot_plugin":
        return [spec.marketplace_repo] if spec.marketplace_repo else []
    if m == "gemini_extension":
        # same resolution order as _adapt_gemini_extension, incl. its
        # marketplace_repo fallback — gate exactly what the adapter installs
        src = (spec.gemini_source or spec.repo_url
               or (f"https://github.com/{spec.marketplace_repo}"
                   if spec.marketplace_repo else None))
        return [src] if src else []
    if m == "universal_skill":
        return [spec.universal_add[-1]] if spec.universal_add else []
    return []


# Methods whose ADAPTER gates the exact bytes it will run/write (via _gate_shell_steps /
# _gate_mcp_descriptor / the staged-clone gate), so they are safe even though
# _gate_targets_for_spec returns [] for them. Every other method MUST yield a gate target;
# the _run_installs fail-closed guard refuses anything that is neither (esp. under --no-scan).
_SELF_GATING_METHODS = frozenset({
    "shell", "shell_or_action", "git_clone", "git_clone_shell", "cursor_mcp", "codex_mcp",
    # the agent-MCP family (opencode/windsurf/zed/continue) self-gates its descriptor too.
    "opencode_mcp", "windsurf_mcp", "zed_context_server", "continue_mcp",
})


def scan_spec(plugin_name: str, spec: InstallSpec) -> ScanReport:
    """Gather artifacts for a spec and statically audit them."""
    tmp_to_clean: Optional[Path] = None
    try:
        if spec.method == "claude_marketplace":  # registering an Anthropic-owned
            # registry root — no payload to fetch/execute; auto-trusted (clean).
            return ScanReport(plugin_name, f"marketplace:{spec.marketplace_name}",
                              "official:" + (spec.marketplace_name or "anthropic"), [], 0)

        if spec.method == "cursor_rule":  # plain text rule — scan the body
            findings = _scan_text("<cursor_rule>", spec.rule_body or "")
            return ScanReport(plugin_name, "cursor_rule", "rule:" + (spec.rule_name or plugin_name), findings, 1)

        if spec.method in ("cursor_mcp", "codex_mcp") or spec.method in _AGENT_MCP_CFG:  # MCP wiring
            srv = spec.mcp_server or {}
            text = " ".join([str(srv.get("command", ""))]
                            + [str(x) for x in srv.get("args", [])]
                            + [f"{k}={v}" for k, v in (srv.get("env", {}) or {}).items()])
            findings = _scan_text(f"<{spec.method}>", text) if text else []
            return ScanReport(plugin_name, spec.method, "mcp:" + (spec.mcp_name or plugin_name), findings, 1)

        if spec.method == "codex_prompt":  # plain markdown prompt — scan the body
            findings = _scan_text("<codex_prompt>", spec.prompt_body or "")
            return ScanReport(plugin_name, "codex_prompt", "prompt:" + (spec.prompt_name or plugin_name), findings, 1)

        if spec.method in ("shell", "shell_or_action"):  # T2c — scan literal commands
            text = "\n".join(" ".join(c) for steps in spec.shell_steps.values() for c in steps)
            findings = _scan_text("<shell_steps>", text) if text else []
            if spec.prefetch_scan_urls:
                # curl|sh installer: FETCH the real script and scan IT, so the pipe
                # is inspected, not blind. Drop the meta pipe-to-shell finding.
                findings = [f for f in findings if f.rule.id not in ("R2.pipe", "R2.procsub")]
                for url in spec.prefetch_scan_urls:
                    body = _fetch_text(url)
                    if body is None:
                        findings.append(Finding(
                            Rule("S0.unfetched", "medium", _TOKEN_RX,
                                 f"could not fetch installer {url}", "install blind = risk"),
                            url, 0, url))
                    else:
                        findings += _scan_text(url, body)
                        # deep nemesis pass over the fetched body (signatures, IOC
                        # feeds, deobfuscation — far beyond the 5C regexes). The
                        # verdict folds into THIS report so the normal gate flow
                        # (block / confirm / proceed) decides; code never lands.
                        if GATE_MODE != "off":
                            nv = nemesis_gate("-", stdin_text=body)
                            _gate_audit(f"{plugin_name} installer", url, nv)
                            # gate-mode warn: surface as HIGH (prompt), never hard-block
                            block_sev = "high" if GATE_MODE == "warn" else "critical"
                            if nv.get("verdict") in ("block", "error"):
                                findings.append(Finding(
                                    Rule("NEMESIS.block", block_sev, _TOKEN_RX,
                                         f"nemesis {nv.get('verdict')}: "
                                         + "; ".join((nv.get("blocking_reasons") or ["scan error"])[:3]),
                                         nv.get("recommendation", "do not install")),
                                    url, 0, url))
                            elif nv.get("verdict") == "warn":
                                c = nv.get("severity_counts") or {}
                                if c.get("CRITICAL", 0) + c.get("HIGH", 0) > 0:
                                    findings.append(Finding(
                                        Rule("NEMESIS.warn", "high", _TOKEN_RX,
                                             f"nemesis warn ({c.get('CRITICAL', 0)}c/"
                                             f"{c.get('HIGH', 0)}h) on installer body",
                                             nv.get("recommendation", "review before install")),
                                        url, 0, url))
            return ScanReport(plugin_name, spec.method,
                              spec.method + ":" + str(abs(hash(text)))[:12], findings, 1)

        root: Optional[Path] = None
        source = ""
        if spec.method == "claude_plugin":  # T2b — prefer on-disk marketplace
            mkts = _read_json(CLAUDE_KNOWN_MKTS)
            loc = mkts.get(spec.marketplace_name or "", {}).get("installLocation")
            if loc and Path(loc).exists():
                root, source = Path(loc), f"marketplace:{spec.marketplace_name}"
            elif spec.marketplace_repo:
                root = tmp_to_clean = _temp_clone(spec.marketplace_repo)
                source = spec.marketplace_repo
        elif spec.method in ("git_clone", "git_clone_shell"):  # T2a — clone (+ setup steps)
            if spec.repo_url:
                root = tmp_to_clean = _temp_clone(spec.repo_url)
                source = spec.repo_url
        elif spec.method == "universal_skill":  # T2d — clone the SKILL repo behind the installer
            slug = spec.universal_add[-1] if spec.universal_add else None
            if slug:
                root = tmp_to_clean = _temp_clone(slug)
                source = slug
        elif spec.method == "gemini_extension":  # clone the extension repo and scan it
            src = spec.gemini_source or spec.repo_url
            if src:
                root = tmp_to_clean = _temp_clone(src)
                source = src

        if root is None:
            # could not fetch artifacts — report as unknown/medium signal
            unknown = Finding(
                Rule("S0.unfetched", "medium", _TOKEN_RX,
                     "could not fetch install artifacts to scan", "install blind = risk"),
                "<source>", 0, source or spec.method)
            return ScanReport(plugin_name, source or spec.method, "unknown", [unknown])

        findings = _walk_and_scan(root)
        if spec.method == "git_clone_shell" and spec.shell_steps:  # also scan setup commands
            text = "\n".join(" ".join(c) for steps in spec.shell_steps.values() for c in steps)
            findings += _scan_text("<setup_steps>", text)
        # what was INSPECTED, not what exists: this counted every file under the tree while the
        # walker opened only the allowlisted subset, so "files: N" overstated the scan — the
        # number a reader uses to judge whether a clean verdict means anything.
        nfiles = _count_scannable(root)
        return ScanReport(plugin_name, source, _git_identity(root), findings, nfiles)
    finally:
        if tmp_to_clean:
            shutil.rmtree(tmp_to_clean, ignore_errors=True)


# ---- trust store (TS1..TS4) -----------------------------------------------
def _load_trust() -> dict:
    return _read_json(TRUST_FILE)


def _save_trust(data: dict) -> None:
    """Persist the trust store — unless this is a --dry-run.

    Guarded at the SINK rather than at each caller so every writer is covered at once
    (`record_trust`, `revoke_trust`, and the two WARN-approval paths in
    `_gate_confirm_warn`).

    A dry run reaching this function is not hypothetical: `install_repo_spec` calls
    `enforce_gate` under DRY_RUN on purpose, to show the verdict a real run would gate on.
    If that gate hit the WARN tier and the user answered `y` (or passed `--yes`), the
    approval was WRITTEN — so the next REAL install of the same artifact skipped the prompt
    entirely, silently pre-approved by a run whose whole contract is that it changes
    nothing. A security decision is exactly the last thing a dry run may persist.
    """
    if DRY_RUN:
        Log.step("[dry-run] trust store NOT written — a real run will ask again")
        return
    TRUST_FILE.parent.mkdir(parents=True, exist_ok=True)
    TRUST_FILE.write_text(json.dumps(data, indent=2))


def _trust_key(report: ScanReport, host_name: str) -> str:
    return f"{report.plugin}@{host_name}#{report.identity}"


def is_trusted(report: ScanReport, host_name: str) -> bool:
    return _trust_key(report, host_name) in _load_trust()


def record_trust(report: ScanReport, host_name: str) -> None:
    data = _load_trust()
    data[_trust_key(report, host_name)] = {
        "source": report.source, "verdict": report.verdict, "approvedBy": "user"}
    _save_trust(data)


def revoke_trust(plugin_name: str) -> int:
    data = _load_trust()
    drop = [k for k in data if k.startswith(plugin_name + "@")]
    for k in drop:
        del data[k]
    _save_trust(data)
    return len(drop)


# ---- reporting + gating (G1..G4) ------------------------------------------
_SEV_COLOR = {"critical": "red", "high": "red", "medium": "yellow", "low": "cyan", "info": "dim"}


def _print_findings(findings: list[Finding], limit: int = 40) -> None:
    shown = sorted(findings, key=lambda f: -SEVERITY_ORDER[f.severity])[:limit]
    for f in shown:
        tag = Log._c(f.severity.upper(), _SEV_COLOR.get(f.severity, "yellow"))
        loc = f"{f.rel_path}:{f.line_no}" if f.line_no else f.rel_path
        ctx = "" if f.active else Log._c(f" ({f.context})", "dim")
        # Log.STREAM (stderr under --json) keeps the single-JSON stdout contract.
        print(f"      {tag} [{f.rule.id}] {loc}  {f.rule.desc}{ctx}", file=Log.STREAM)
        print(f"          ↳ {f.snippet}", file=Log.STREAM)
        print(f"          fix: {f.rule.advice}", file=Log.STREAM)
    if len(findings) > len(shown):
        Log.step(f"... {len(findings) - len(shown)} more")


def print_report(report: ScanReport) -> None:
    Log.step(f"source: {report.source}  files: {report.scanned_files}  id: {report.identity}")
    dn = report.downgraded
    if report.verdict == "clean":
        Log.ok("scan clean — no known-bad patterns in executable install code")
        if dn:
            Log.step(f"{len(dn)} match(es) suppressed as non-executable "
                     f"(comments/docs/tests/CI){' — see --show-info' if not SHOW_INFO else ''}")
            if SHOW_INFO:
                _print_findings(dn)
        return
    c = report.counts()
    verdict_col = _SEV_COLOR.get(report.verdict, "yellow")
    Log.warn(f"verdict: {Log._c(report.verdict.upper(), verdict_col)}  "
             f"(crit {c['critical']} / high {c['high']} / med {c['medium']} / low {c['low']})  "
             f"[{len(dn)} suppressed]")
    _print_findings(report.active)
    if dn:
        Log.step(f"{len(dn)} non-executable match(es) suppressed"
                 f"{' — see --show-info' if not SHOW_INFO else ''}")
        if SHOW_INFO:
            _print_findings(dn)


def security_gate(report: ScanReport, host_name: str, auto_trust: bool = False) -> bool:
    """Return True if install may proceed. Honors flags + trust store (G3/G4).

    auto_trust=True (official Anthropic tier) proceeds after printing the report:
    the bundle is trusted by design, so heuristic false-positives in example/build
    scripts (e.g. `rm -rf dist`) do not block — but findings are still shown.
    """
    if NO_SCAN:
        Log.warn("SECURITY SCAN SKIPPED (--no-scan). Installing unaudited code.")
        return True

    print_report(report)

    if report.verdict == "clean":
        return True

    if auto_trust:
        Log.warn(f"auto-trusted (official tier) — proceeding despite {report.verdict.upper()} "
                 f"heuristic finding(s); review above")
        return True

    if is_trusted(report, host_name) and not FORCE:
        Log.ok("source previously approved (trust store) — proceeding")
        return True

    sev = report.verdict
    # AUTHORITATIVE-DEEP-SCAN (solution 2): the deep nemesis gate (enforce_gate) runs next in
    # the install flow and is the real, context-aware verdict. When it is live, this regex
    # pre-scan is ADVISORY for NON-catastrophic findings — its context-blind heuristics must not
    # BLOCK or nag on their own (that is what turned a benign `sudo apt-get` / `rm -rf ./dist`
    # into a scary "CRITICAL"). We STILL hard-block the pre-scan's own CATASTROPHIC criticals
    # (rm -rf /, reverse shell, disk-wipe, curl|sh) as cheap belt-and-suspenders. `--strict`
    # restores the old, block-on-anything bar for the paranoid.
    deep_gate_live = GATE_MODE != "off" and not _GATE_DISABLED and os.path.exists(NEMESIS_BIN)
    if deep_gate_live and not STRICT and sev != "critical":
        Log.step(
            f"heuristic pre-scan: {sev} — ADVISORY only (findings above); the deep nemesis "
            f"scan is authoritative and runs next"
        )
        return True

    block_critical = sev == "critical"
    block_strict = STRICT and SEVERITY_ORDER[sev] >= SEVERITY_ORDER["medium"]

    if block_critical and not FORCE_UNSAFE:
        Log.err(f"BLOCKED: critical findings in {report.plugin}. "
                f"Override only if you trust it: --force-unsafe")
        return False
    if block_strict and not FORCE_UNSAFE:
        Log.err(f"BLOCKED (--strict): {sev} findings in {report.plugin}. Override: --force-unsafe")
        return False

    if ASSUME_YES:
        Log.warn(f"auto-approved ({sev}) via --yes")
        record_trust(report, host_name)
        return True

    if not sys.stdin.isatty():  # C4 — non-interactive defaults to NO
        Log.err(f"non-interactive + {sev} findings → refusing. Use --yes to approve.")
        return False

    ans = input(f"    {Log._c('?', 'yellow')} Proceed installing {report.plugin}@{host_name} "
                f"with {sev} findings? [y/N] ").strip().lower()
    if ans in ("y", "yes"):
        record_trust(report, host_name)
        return True
    Log.warn("declined by user")
    return False


# ============================================================================
#  SECTION 6 — THE PLUGIN REGISTRY  (add new plugins here)
# ============================================================================
#  INSERTION TEMPLATE — one Plugin() per dossier (ais_skills_registry.json →
#  plugins[]). Copy, fill from the md, drop into OFFICIAL_BUNDLE or
#  EXTERNAL_PLUGINS. Map the registry "method" to an InstallSpec method:
#    claude_plugin   → marketplace_name/marketplace_repo/plugin_id/scope
#    git_clone       → repo_url/dest (+ uninstall via dest-rm)
#    git_clone_shell → repo_url/dest + shell_steps{os:[...]}  (e.g. gstack ./setup)
#    shell           → shell_steps{os:[...]} (+ uninstall_cmd, e.g. ["graphify","uninstall"])
#    universal_skill → target "*": InstallSpec(universal_add=["npx","skills","add","owner/repo"])
#    shell_or_action → shell_steps or manual_note (CI/slash, e.g. security-review)
#
#  Plugin(
#      name="<id>", summary="<one-liner>",
#      tier="community",            # official | community | devtool
#      bundle=False,                # True only for the 7 official
#      claude_exclusive=False,      # False = universal (multi-CLI) → installs into all agents
#      repo="owner/repo", owner="owner", license="MIT", stars=12345, forks=678,
#      category="<cat>", redundancy_group="A_code_graph", recommend_rank=4,
#      automation="<fire-on-prompt / auto-arm note>",
#      security_note="<one-line gate guidance>",
#      caveats=("<caveat 1>",),
#      targets={
#          "claude": InstallSpec(method="claude_plugin", marketplace_name=..., ...),
#          # universal example (one run fans into every detected agent):
#          # "*": InstallSpec(method="universal_skill",
#          #                  universal_add=["npx","skills","add","owner/repo"],
#          #                  uninstall_cmd=["npx","skills","remove","owner/repo"]),
#      },
#  ),
# ============================================================================
# ----------------------------------------------------------------------------
#  OFFICIAL BUNDLE — anthropics/* (tier="official", bundle=True).
#  Auto-trusted; installed in one run via `bundle` / `install official-bundle`
#  / the wizard. Claude-native. INSERT dossiers here, one Plugin() per md.
#  Members (from ais_skills_registry.json): claude-plugins-official, skills,
#  knowledge-work-plugins, financial-services, claude-for-legal,
#  frontend-design, claude-code-security-review.
# ----------------------------------------------------------------------------
OFFICIAL_BUNDLE: list[Plugin] = [
    # 01 — claude-plugins-official: the ROOT marketplace (curated install hub +
    # canonical plugin/skill/hook model reference). Registers the official +
    # community registries; installs no plugin_id. Pre-available in Claude Code
    # (marketplace add usually a no-op). Claude-exclusive.
    Plugin(
        name="claude-plugins-official",
        summary="Official Anthropic plugin marketplace (root registry) — curated install hub + the canonical plugin/skill/hook model.",
        tier="official", bundle=True, claude_exclusive=True,
        repo="anthropics/claude-plugins-official", owner="anthropics",
        license="Apache-2.0", stars=29253, forks=3130,
        category="marketplace-root", recommend_rank=0,
        automation="Root registry. Prometheus can write extraKnownMarketplaces + enabledPlugins into .claude/settings.json to auto-arm any plugin from here. Listed external plugins are SHA-pinned + Anthropic safety-screened.",
        security_note="Auto-trust the marketplace (often pre-registered); scan each external sub-plugin id on sub-install.",
        caveats=(
            "pre-available in Claude Code — `marketplace add` is often a no-op; verify known_marketplaces.json first",
            "Anthropic cannot guarantee third-party plugin contents — scan the specific plugin id, not just the marketplace",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_marketplace",
                marketplace_name="claude-plugins-official",
                marketplace_repo="anthropics/claude-plugins-official",
                secondary_marketplace_name="claude-community",
                secondary_marketplace_repo="anthropics/claude-plugins-community",
                auto_available=True,
            ),
        },
    ),
    # 02 — anthropics/skills: the Agent-Skills SKILL.md standard (agentskills.io)
    # + document/example skills — the model-invoked auto-fire engine every other
    # skills repo conforms to. Universal FORMAT; the Claude install is the
    # marketplace path (two sub-plugins). Non-Claude agents use the universal
    # `npx skills add` / ~/.claude/skills/ folder-drop (auto-armed, hot-watched).
    Plugin(
        name="skills",
        summary="Agent-Skills SKILL.md standard (agentskills.io) + document (PDF/DOCX/PPTX/XLSX) & example skills — the model-invoked auto-fire engine.",
        tier="official", bundle=True, claude_exclusive=False,
        repo="anthropics/skills", owner="anthropics",
        license="Apache-2.0 (doc-skills source-available)", stars=146071, forks=17211,
        category="core-skills", recommend_rank=0,
        automation="Model-invoked auto-fire by `description`/`when_to_use` (no slash); dynamic context injection (!`cmd`, $ARGUMENTS, ${CLAUDE_SKILL_DIR}); context:fork subagent exec; allowed/disallowed-tools. Universal drop ~/.claude/skills/<name>/ is auto-armed + hot-watched.",
        security_note="Auto-trust this repo. For THIRD-PARTY skills scan bundled scripts + !`...` injection lines + frontmatter allowed-tools (auto-granted tools = privilege surface).",
        caveats=(
            "document-skills are source-available, not OSS (usable, not freely re-licensable)",
            "universal FORMAT: the marketplace path is Claude-only; other agents install via `npx skills add` / folder-drop into their skills dir",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="anthropic-agent-skills",
                marketplace_repo="anthropics/skills",
                plugin_ids=["document-skills@anthropic-agent-skills",
                            "example-skills@anthropic-agent-skills"],
                scope="user",
            ),
        },
    ),
    # 03 — anthropics/knowledge-work-plugins: 11 role plugins (skills + commands +
    # MCP connectors) — the connector reference. Install path Claude-only (Cowork +
    # Code); the underlying MCP servers are reusable across MCP-capable CLIs.
    # Bundle installs all 11 roles; connectors auto-start on enable but need
    # per-connector /mcp OAuth (Prometheus scaffolds wiring, NEVER secrets).
    Plugin(
        name="knowledge-work-plugins",
        summary="11 role plugins (sales/support/PM/marketing/legal/finance/data/enterprise-search/bio-research/productivity/cowork-mgmt) wired to MCP connectors.",
        tier="official", bundle=True, claude_exclusive=True,
        repo="anthropics/knowledge-work-plugins", owner="anthropics",
        license="Apache-2.0", stars=19014, forks=2224,
        category="knowledge-work", recommend_rank=0,
        automation="Skills auto-fire by description; each plugin's .mcp.json connectors AUTO-START on enable; commands /{plugin}:{command}. Tool Search defers MCP defs (cheap to enable many). Prometheus can write enabledPlugins + scaffold .mcp.json but NEVER secrets — hand off /mcp OAuth once per connector.",
        security_note="Auto-trust install; connectors = runtime prompt-injection vector + broad-scope creds. Surface connector list + per-connector OAuth; pin oauth.scopes / allowedMcpServers.",
        caveats=(
            "11 role plugins; the bundle installs ALL — uninstall unused roles (commands are /{plugin}:{command})",
            "connectors need per-user OAuth via /mcp — Prometheus scaffolds wiring, never writes secrets",
            "MCP connectors fetch external content = prompt-injection vector; verify each server before connecting",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="knowledge-work-plugins",
                marketplace_repo="anthropics/knowledge-work-plugins",
                plugin_ids=[
                    "productivity@knowledge-work-plugins",
                    "sales@knowledge-work-plugins",
                    "customer-support@knowledge-work-plugins",
                    "product-management@knowledge-work-plugins",
                    "marketing@knowledge-work-plugins",
                    "legal@knowledge-work-plugins",
                    "finance@knowledge-work-plugins",
                    "data@knowledge-work-plugins",
                    "enterprise-search@knowledge-work-plugins",
                    "bio-research@knowledge-work-plugins",
                    "cowork-plugin-management@knowledge-work-plugins",
                ],
                scope="user",
            ),
        },
    ),
    # 04 — anthropics/financial-services: deep finance vertical (agents + skills +
    # 11 MCP connectors). Install path Claude-only (Code/Cowork/Managed-Agents/M365).
    # CORE-FIRST: financial-analysis holds all 11 connectors — install it before the
    # other vertical plugins (plugin_ids order is preserved). Headless Managed Agents
    # (deploy-managed-agent.sh → /v1/agents) + cron/launchd watchers are OPTIONAL
    # post-install automation (scan/confirm persistence; never writes ANTHROPIC_API_KEY).
    Plugin(
        name="financial-services",
        summary="Deep finance vertical: 11 agents + vertical plugins (IB/equity/PE/wealth/fund-admin) + 11 MCP data connectors. The Managed-Agents + headless reference.",
        tier="official", bundle=True, claude_exclusive=True,
        repo="anthropics/financial-services", owner="anthropics",
        license="Apache-2.0", stars=29752, forks=4179,
        category="vertical-finance", recommend_rank=0,
        automation="Interactive skills auto-fire + /commands. HEADLESS Managed Agents: scripts/deploy-managed-agent.sh <agent> → POST /v1/agents (runs server-side, unattended). Scheduled watchers: cron/launchd wrapping `claude --bare -p '<task>'` (--output-format json for per-run spend). M365 add-in via /claude-for-msft-365-install:setup. Prometheus 'automate this agent' step = run deploy script (scan first) OR scaffold cron (confirm persistence).",
        security_note="Auto-trust plugin install (markdown/JSON). Scan deploy-managed-agent.sh + orchestrate.py only if deploying headless; confirm cron/launchd persistence; surface 11-connector OAuth + Agent-SDK credit (from 2026-06-15).",
        caveats=(
            "DRAFTING ONLY — agents never recommend, trade, or post to ledgers",
            "financial-analysis installs FIRST (holds all 11 MCP connectors); other plugins build on it",
            "domain-heavy — stays dormant for non-finance users",
            "headless deploy (deploy-managed-agent.sh) + cron watchers + M365 add-in are OPTIONAL post-install (scan/confirm persistence; secrets handed to user, never written)",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="claude-for-financial-services",
                marketplace_repo="anthropics/financial-services",
                plugin_ids=[
                    "financial-analysis@claude-for-financial-services",   # CORE FIRST — connectors
                    "pitch-agent@claude-for-financial-services",
                    "investment-banking@claude-for-financial-services",
                    "equity-research@claude-for-financial-services",
                    "private-equity@claude-for-financial-services",
                    "wealth-management@claude-for-financial-services",
                    "fund-admin@claude-for-financial-services",
                    "operations@claude-for-financial-services",
                ],
                scope="user",
            ),
        },
    ),
    # 05 — anthropics/claude-for-legal: deep legal vertical (14 plugins, 100+
    # agents/skills). Install path Claude-only (Code/Cowork/Managed-Agents/M365
    # Word+Excel). REQUIRED priming: /<plugin>:cold-start-interview writes a
    # practice-profile CLAUDE.md — skills are GENERIC until run. legal-builder-hub
    # = the trust-gate blueprint to mirror in SECTION 5C. Partner cocounsel-legal
    # (Thomson Reuters/Westlaw) is NOT auto-installed (needs partner access).
    Plugin(
        name="claude-for-legal",
        summary="Deep legal vertical: 14 plugins, 100+ skills/agents (commercial/corporate/privacy/IP/litigation/...). Scheduled-agents + practice-profile priming + the legal-builder-hub trust-gate blueprint.",
        tier="official", bundle=True, claude_exclusive=True,
        repo="anthropics/claude-for-legal", owner="anthropics",
        license="Apache-2.0", stars=8016, forks=1445,
        category="vertical-legal", recommend_rank=0,
        automation="Practice-profile priming (cold-start-interview writes CLAUDE.md every skill auto-reads — run once → firm-specific output, survives updates); scheduled watchers (renewal/docket/reg-monitor via cron frontmatter or deploy-managed-agent.sh); legal-builder-hub trust-gated community installs; deterministic citation guardrail (source-tagged vs [verify]).",
        security_note="Auto-trust plugin install (markdown/JSON). Scan deploy-managed-agent.sh/orchestrate.py if deploying headless; confirm scheduled-agent persistence + connector OAuth. legal-builder-hub = scanner prior-art to mirror in SECTION 5C (source/license/freshness allowlists, re-scan-on-update, auditable log).",
        caveats=(
            "DRAFTS for attorney review — not legal advice",
            "skills produce GENERIC output until /<plugin>:cold-start-interview is run (required priming)",
            "domain-heavy — dormant for non-legal users",
            "partner cocounsel-legal (Thomson Reuters/Westlaw) NOT auto-installed — needs partner access",
            "scheduled watchers + headless deploy + M365 are OPTIONAL post-install (confirm persistence; secrets never written)",
        ),
        post_install_note="run /<plugin>:cold-start-interview to prime each plugin's practice profile (~/.claude/plugins/config/claude-for-legal/<plugin>/CLAUDE.md). Practice profiles are YOUR data — Prometheus only triggers the interview, never writes content.",
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="claude-for-legal",
                marketplace_repo="anthropics/claude-for-legal",
                plugin_ids=[
                    "commercial-legal@claude-for-legal",
                    "corporate-legal@claude-for-legal",
                    "privacy-legal@claude-for-legal",
                    "product-legal@claude-for-legal",
                    "employment-legal@claude-for-legal",
                    "ai-governance-legal@claude-for-legal",
                    "regulatory-legal@claude-for-legal",
                    "ip-legal@claude-for-legal",
                    "litigation-legal@claude-for-legal",
                    "law-student@claude-for-legal",
                    "legal-clinic@claude-for-legal",
                    "legal-builder-hub@claude-for-legal",
                ],
                scope="user",
            ),
        },
    ),
    # 06 — anthropics/claude-code → plugins/frontend-design: the purest fire-on-
    # prompt example (one model-invoked skill, sharp description, auto-applied for
    # frontend work, zero-config). Subdir plugin of anthropics/claude-code; usually
    # ALREADY bundled with Claude Code. Frontend redundancy default (taste-skill =
    # community alt). Template shape for the `scaffold-skill` command. Claude-only.
    Plugin(
        name="frontend-design",
        summary="Anti-slop production frontend skill — auto-applied by Claude for UI work. The purest fire-on-prompt example + author-your-own-skill template.",
        tier="official", bundle=True, claude_exclusive=True,
        repo="anthropics/claude-code (plugins/frontend-design)", owner="anthropics",
        license="claude-code repo", stars=None, forks=None,
        category="frontend", redundancy_group="C_frontend", recommend_rank=0,
        automation="Model-invocable skill with a sharp description → auto-fires on frontend-shaped prompts, zero-config (ships enabled). Progressive disclosure keeps it ~free when idle. Canonical template for `prometheus scaffold-skill`.",
        security_note="Auto-trust (official, Anthropic-authored). Pure skill text — no executable payload, no hooks/MCP.",
        caveats=(
            "subdir plugin of anthropics/claude-code — verify the exact plugin id at install; usually already bundled",
            "redundant with community taste-skill (frontend group C) — official is the default; don't run both",
            "sibling official plugins live in claude-code/plugins/ (code-review, security-guidance, hookify, plugin-dev, feature-dev, pr-review-toolkit, ...) — auto-trusted mini-catalog",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="claude-code",
                marketplace_repo="anthropics/claude-code",
                plugin_id="frontend-design@claude-code",
                scope="user",
            ),
        },
    ),
    # 07 — anthropics/claude-code-security-review: AI security PR reviewer. Installs
    # as a GitHub Action workflow + /security-review slash override — NOT a
    # marketplace plugin. Scanner prior-art (github_action_audit.py/findings_filter.py).
    Plugin(
        name="claude-code-security-review",
        summary="AI security PR reviewer — GitHub Action (CI) + /security-review slash command (built-in). Scanner prior-art.",
        tier="official", bundle=True, claude_exclusive=True,
        repo="anthropics/claude-code-security-review", owner="anthropics",
        license="MIT", stars=4926, forks=490,
        category="code-review-security", redundancy_group="E_code_review", recommend_rank=0,
        automation="CI-on-every-PR (fail build on findings-count) + /security-review interactive + local `claude --bare -p` pre-push gate + scheduled whole-repo scan. Prometheus scaffolds .github/workflows/security.yml + slash override (confirm; NEVER writes the API key).",
        security_note="Auto-trust (official). Installs as a CI Action / slash command, NOT a marketplace plugin. NOT prompt-injection-hardened — trusted PRs only; require external approval. Prior art: github_action_audit.py / findings_filter.py / evals.",
        caveats=(
            "not a marketplace plugin — installs as a GitHub Action workflow + /security-review slash override",
            "needs CLAUDE_API_KEY in CI secrets — Prometheus never writes it",
            "/security-review is built-in to Claude Code; the CI Action is the add-on",
        ),
        targets={
            "claude": InstallSpec(
                method="shell_or_action",
                manual_note="scaffold .github/workflows/security.yml (uses the anthropics/claude-code-security-review action) + optional .claude/commands/security-review.md slash override; set CLAUDE_API_KEY as a CI secret yourself.",
            ),
        },
    ),
    # >>> INSERT OFFICIAL PLUGINS HERE (one Plugin(... tier="official", bundle=True,
    #     claude_exclusive=True, recommend_rank=0 ...) per official md) <<<
]


# ----------------------------------------------------------------------------
#  EXTERNAL PLUGINS — third-party (tier="community" | "devtool"). Ranked,
#  opt-in, ALWAYS scanned + gated. claude_exclusive=False plugins install AND
#  uninstall into every detected compatible agent via the repo's OWN official
#  mechanism (universal_skill / per-agent shell). INSERT dossiers here.
#  Ranked members: superpowers(1) claude-mem(2) cybersecurity(3) codegraph(4)
#  scientific(5) academic(6) gstack(7) taste(8) ecc(9) graphify(10)
#  code-review-graph(11) scholar(12) lev(13) reviewdog(devtool 14).
# ----------------------------------------------------------------------------
EXTERNAL_PLUGINS: list[Plugin] = [
    Plugin(
        name="caveman",
        summary="Ultra-compressed 'caveman' comms mode + cavecrew subagents/skills",
        tier="community", bundle=False, claude_exclusive=True,
        repo="JuliusBrussee/caveman", owner="JuliusBrussee", license="MIT",
        category="comms-style",
        automation="Output-style + skills plugin; activates per session once enabled.",
        supported_os=("macos", "linux"),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="caveman",
                marketplace_repo="JuliusBrussee/caveman",
                plugin_id="caveman@caveman",
                scope="user",
                marketplace_remove=False,
            ),
            # codex/cursor/gemini specs get added when their plugin mechanism is wired.
        },
    ),
    # 09 — obra/superpowers (rank 1, D_dev_workflow): agentic dev methodology.
    Plugin(
        name="superpowers",
        summary="Agentic dev methodology: clarify→design→plan→subagent-execute→review→test. Mandatory auto-activating workflows + skill-creation framework. Top pick.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="obra/superpowers", owner="obra", license="MIT", stars=216841, forks=19300,
        category="dev-workflow", redundancy_group="D_dev_workflow", recommend_rank=1,
        automation="MANDATORY workflows: using-superpowers meta-skill + hooks make the agent check skills before EVERY task (persistent). Sequenced auto-activation brainstorm→worktrees→plan→subagent-exec→TDD→review→finish. writing-skills authors new cross-agent skills.",
        security_note="Prefer the official vetted path (superpowers@claude-plugins-official) — inherits Anthropic screening + enabledPlugins auto-arm. Raw repo: expect shell + hooks (R4.hooks), both expected-for-category.",
        caveats=(
            "installs hooks (persistent activation, like CAVEMAN)",
            "per-agent installs differ: gemini `gemini extensions install`, cursor `/add-plugin`, codex `/plugins search`, factory `droid plugin ...`, copilot marketplace add",
            "HN reception mixed — some call it over-engineered; strip to the ~30% you use",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="claude-plugins-official",
                marketplace_repo="anthropics/claude-plugins-official",
                plugin_id="superpowers@claude-plugins-official",
                scope="user",
            ),
            # P4.1 — same registry entry installs natively on Gemini:
            "gemini": InstallSpec(
                method="gemini_extension",
                gemini_source="https://github.com/obra/superpowers",
                gemini_name="superpowers",
            ),
        },
    ),
    # 11 — thedotmack/claude-mem (rank 2, F_memory): persistent cross-session memory.
    Plugin(
        name="claude-mem",
        summary="Persistent cross-session memory: 5 lifecycle hooks + :37777 worker + SQLite/Chroma. Auto context-injection. Only memory tool here.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="thedotmack/claude-mem", owner="thedotmack", license="Apache-2.0", stars=80444, forks=6925,
        category="memory", redundancy_group="F_memory", recommend_rank=2,
        automation="SessionStart hook re-injects relevant past summaries automatically (restart → context appears, no command); PostToolUse captures + SessionEnd AI-compresses; mem-search skill auto-fires; MCP 3-layer search ~10x token savings.",
        security_note="Scan; surface 3 consent facts (5 hooks R4.hooks / localhost:37777 worker / reads-all-by-design). Local-only/private. OpenClaw path is curl|bash — prefer npx/marketplace.",
        caveats=(
            "installs 5 lifecycle hooks + a localhost:37777 worker — consciously opt in",
            "community security-audit issue #1251 flagged port 37777 capturing secrets",
            "per-agent: `npx claude-mem install --ide gemini-cli|opencode`; OpenClaw via curl|bash (scan first)",
        ),
        targets={
            "claude": InstallSpec(
                method="shell",
                shell_steps={"all": [["npx", "claude-mem", "install"]]},
                uninstall_cmd=["npx", "claude-mem", "uninstall"],
            ),
            # P4.1 — per-agent install variants from the SAME registry entry:
            "gemini": InstallSpec(
                method="shell",
                shell_steps={"all": [["npx", "claude-mem", "install", "--ide", "gemini-cli"]]},
                uninstall_cmd=["npx", "claude-mem", "uninstall"],
            ),
            "opencode": InstallSpec(
                method="shell",
                shell_steps={"all": [["npx", "claude-mem", "install", "--ide", "opencode"]]},
                uninstall_cmd=["npx", "claude-mem", "uninstall"],
            ),
        },
    ),
    # 08 — mukul975/Anthropic-Cybersecurity-Skills (rank 3): 754 ATT&CK-mapped skills.
    Plugin(
        name="anthropic-cybersecurity-skills",
        summary="754 cybersecurity skills mapped to MITRE ATT&CK v19.1/ATLAS/D3FEND, NIST CSF/AI-RMF. 26 domains. Universal install-everywhere.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="mukul975/Anthropic-Cybersecurity-Skills", owner="mukul975", license="Apache-2.0", stars=13860, forks=1622,
        category="cybersecurity", recommend_rank=3,
        automation="`npx skills add` auto-detects + installs into EVERY compatible CLI; keyword-rich descriptions auto-fire the relevant security skill across all agents.",
        security_note="Scan (esp scripts/); dual-use offensive content (red-team/pentest) — authorized use only. Cisco AI Defense weekly scan.",
        caveats=(
            "NAME reads 'Anthropic-*' but owned by mukul975 — repo SELF-DISCLOSES non-affiliation (honest, not deceptive); still surface",
            "dual-use offensive security content — authorized engagements only",
        ),
        targets={
            "*": InstallSpec(
                method="universal_skill",
                universal_add=["npx", "skills", "add", "mukul975/Anthropic-Cybersecurity-Skills"],
                uninstall_cmd=["npx", "skills", "remove", "mukul975/Anthropic-Cybersecurity-Skills"],
            ),
        },
    ),
    # 12 — colbymchenry/codegraph (rank 4, A_code_graph default): local code graph.
    Plugin(
        name="codegraph",
        summary="Local pre-indexed code knowledge graph via MCP (8 tools); -47% tokens, -58% tool calls. Code-graph group default. File-watcher auto-sync.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="colbymchenry/codegraph", owner="colbymchenry", license="MIT", stars=39233, forks=2439,
        category="code-graph", redundancy_group="A_code_graph", recommend_rank=4,
        automation="`codegraph install` auto-wires MCP into 8 agents; MCP usage guidance auto-delivered in initialize response (agent self-uses tools); 3-layer file-watcher auto-syncs index; `codegraph affected` → pre-commit/CI hook.",
        security_note="curl|sh installer FETCHED + scanned first (prefetch) — benign self-contained binary-dropper (bundles Node, no shell mod). Local-only. Surface optional Claude auto-allow permissions as a choice.",
        caveats=(
            "install is curl|sh (fetched + audited before running by Prometheus)",
            "code-graph redundancy group A — pick ONE (codegraph is the default)",
        ),
        targets={
            "*": InstallSpec(
                method="shell",
                shell_steps={"all": [
                    ["sh", "-lc", "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh"],
                    ["codegraph", "install"],
                    ["codegraph", "init", "-i"],
                ]},
                prefetch_scan_urls=["https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh"],
                uninstall_cmd=["codegraph", "uninstall"],
            ),
        },
    ),
    # 15 — K-Dense-AI/scientific-agent-skills (rank 5, B_research): doing-science.
    Plugin(
        name="scientific-agent-skills",
        summary="142 science skills (genomics/chem/clinical/ML) + 100+ databases. Doing-science leader. Universal via npx/gh skill.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="K-Dense-AI/scientific-agent-skills", owner="K-Dense-AI", license="MIT (per-skill varies)", stars=27113, forks=2799,
        category="research-science", redundancy_group="B_research", recommend_rank=5,
        automation="npx/gh skill install-everywhere; auto-discover by description on science prompts; dependency auto-install on demand (no pre-provisioning); own weekly skill-scanner (behavioral pass).",
        security_note="Scan; surface pip-package auto-install (supply-chain) + per-skill license variance + cloud-API creds. Vendor-scanned (Cisco AI Defense).",
        caveats=(
            "per-skill licenses differ from repo MIT — license-policy gate for commercial use",
            "skills auto-install pip packages on demand (supply-chain surface)",
            "research group B is complementary — scientific=doing science; academic=paper pipeline; scholar=personal KM",
        ),
        targets={
            "*": InstallSpec(
                method="universal_skill",
                universal_add=["npx", "skills", "add", "K-Dense-AI/scientific-agent-skills"],
                uninstall_cmd=["npx", "skills", "remove", "K-Dense-AI/scientific-agent-skills"],
            ),
        },
    ),
    # 16 — Imbad0202/academic-research-skills (rank 6, B_research): paper pipeline.
    Plugin(
        name="academic-research-skills",
        summary="Full academic paper pipeline (4 skills, multi-agent teams): research→write→review→revise. Deterministic integrity gates + Material Passport resume.",
        tier="community", bundle=False, claude_exclusive=True,
        repo="Imbad0202/academic-research-skills", owner="Imbad0202", license="CC BY-NC 4.0", stars=26690, forks=2198,
        category="research-writing", redundancy_group="B_research", recommend_rank=6,
        automation="SessionStart banner; auto-orchestrated 10-stage multi-agent pipeline; UNSKIPPABLE integrity gates = deterministic citation checks vs Semantic Scholar+OpenAlex+Crossref+arXiv (catch fabricated DOIs); Material Passport cross-session resume.",
        security_note="Scan; HARD-surface CC BY-NC NON-COMMERCIAL license (license-policy gate). SessionStart hook + API spend. Low install surface (native marketplace).",
        caveats=(
            "LICENSE: CC BY-NC 4.0 — NON-COMMERCIAL only; not for paid products",
            "needs ANTHROPIC_API_KEY; optional pandoc/tectonic for PDF",
            "research group B is complementary (academic = paper pipeline)",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="academic-research-skills",
                marketplace_repo="Imbad0202/academic-research-skills",
                plugin_id="academic-research-skills@academic-research-skills",
                scope="user",
            ),
        },
    ),
    # 10 — garrytan/gstack (rank 7, D_dev_workflow): opinionated dev factory.
    Plugin(
        name="gstack",
        summary="Garry Tan's opinionated dev factory (~40 tools by sprint phase) + GBrain memory + browser/iOS agent control. #2 dev-workflow.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="garrytan/gstack", owner="garrytan", license="MIT", stars=106709, forks=15870,
        category="dev-workflow", redundancy_group="D_dev_workflow", recommend_rank=7,
        automation="Phase-detection skill auto-suggestion + chaining; continuous-checkpoint auto-commit WIP; GBrain persistent memory; hourly auto-upgrade; taste-learning (5%/wk decay); /browse Chromium (deny-default allowlist) + /ios-qa real iPhone (audited loopback daemon).",
        security_note="HIGHEST install surface in group — clone-then-execute ./setup + bin/ toolchain + CLAUDE.md edits. Scan setup + bin/ before executing; confirm CLAUDE.md edit + daemons + auto-commit + persistence.",
        caveats=(
            "clone-then-execute ./setup edits CLAUDE.md, symlinks skills, runs bun install, optional daemons",
            "CURATED PERSONAL CONFIG (107k stars / ~10 contributors) — one person's judgment; TechCrunch 'love and hate'",
            "per-agent: ./setup --host codex|opencode|cursor|factory|slate|kiro|hermes|gbrain",
            "dev-workflow redundancy group D — superpowers is the default pick; uninstall only removes the clone (not CLAUDE.md edits)",
        ),
        targets={
            "*": InstallSpec(
                method="git_clone_shell",
                repo_url="https://github.com/garrytan/gstack.git",
                dest="~/.claude/skills/gstack",
                shell_steps={"all": [["sh", "-lc", "cd ~/.claude/skills/gstack && ./setup"]]},
            ),
        },
    ),
    # 18 — Leonxlnx/taste-skill (rank 8, C_frontend): anti-slop frontend w/ dials.
    Plugin(
        name="taste-skill",
        summary="Anti-slop frontend skills with tunable dials (DESIGN_VARIANCE/MOTION_INTENSITY/VISUAL_DENSITY) + image-to-code + redesign-audit. Community alt to official frontend-design.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="Leonxlnx/taste-skill", owner="Leonxlnx", license="MIT", stars=32438, forks=2384,
        category="frontend", redundancy_group="C_frontend", recommend_rank=8,
        automation="npx skills install-everywhere; design-taste-frontend auto-fires on frontend prompts; the 3 dials (1-10 in SKILL.md) = configure-once-applies-globally. 'set your taste dials' = write values into the installed SKILL.md.",
        security_note="Scan installer; low risk (design instructions, no exec beyond installer).",
        caveats=(
            "overlaps official frontend-design (frontend group C) — official is the default; taste adds tunable dials",
        ),
        targets={
            "*": InstallSpec(
                method="universal_skill",
                universal_add=["npx", "skills", "add", "https://github.com/Leonxlnx/taste-skill"],
                uninstall_cmd=["npx", "skills", "remove", "https://github.com/Leonxlnx/taste-skill"],
            ),
        },
    ),
    # 21 — affaan-m/ECC (rank 9, D_dev_workflow): all-in-one harness, free MIT core.
    Plugin(
        name="ecc",
        summary="All-in-one agent harness: 63 agents, 249 skills, instinct-learning + memory + AgentShield security. Core free MIT. Ships AgentShield (scanner prior-art).",
        tier="community", bundle=False, claude_exclusive=False,
        repo="affaan-m/ECC", owner="affaan-m", license="MIT", stars=205500, forks=31537,
        category="dev-workflow-allinone", redundancy_group="D_dev_workflow", recommend_rank=9,
        automation="Self-improving: instincts auto-extracted (confidence-scored) → /evolve clusters into new skills; memory hooks (SessionStart inject 8000 chars / Stop save); AgentShield continuous security. Prometheus can reuse AgentShield taxonomy AND shell out to `npx ecc-agentshield scan`.",
        security_note="Large surface — scan install.sh + profile; prefer marketplace. SELF-AUDITING (ships AgentShield = positive, major scanner prior-art). Surface free-vs-paid + memory hooks + don't-stack-methods.",
        caveats=(
            "CORE is free MIT forever; only the separate hosted ECC-Tools SaaS ($19/mo) is paid (excluded — file 25)",
            "don't stack install methods (marketplace OR ./install.sh, not both); rules need manual copy",
            "memory hooks inject 8000 chars at SessionStart — review ECC_HOOK_PROFILE / ECC_SESSION_START_MAX_CHARS",
            "dev-workflow redundancy group D — superpowers is the default pick",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="ecc",
                marketplace_repo="https://github.com/affaan-m/ECC",
                plugin_id="ecc@ecc",
                scope="user",
            ),
        },
    ),
    # 13 — safishamsi/graphify (rank 10, A_code_graph): multimodal knowledge graph.
    Plugin(
        name="graphify",
        summary="Multimodal knowledge graph: code+SQL+docs+PDF+images+video → architecture maps + interactive HTML. Widest agent matrix (~19).",
        tier="community", bundle=False, claude_exclusive=False,
        repo="safishamsi/graphify", owner="safishamsi", license="MIT", stars=58848, forks=6134,
        category="code-graph", redundancy_group="A_code_graph", recommend_rank=10,
        automation="`graphify install` wires skills into ~19 agents; /graphify auto-fires on architecture prompts; `graphify hook install` = post-commit auto-rebuild (AST-only, no cost) + merge driver; MCP server for repeated queries.",
        security_note="VERIFY PyPI pkg 'graphifyy' (typosquat-confusable double-y). Surface LLM-egress + cost for non-code files (docs/PDF/img) — offer local OLLAMA_BASE_URL.",
        caveats=(
            "PyPI package is 'graphifyy' (double-y) — typosquat-confusable; verify before install",
            "non-code modalities (docs/PDF/img) are sent to the model API — egress + cost; set OLLAMA_BASE_URL for local",
            "code-graph redundancy group A — codegraph is the default pick",
        ),
        targets={
            "*": InstallSpec(
                method="shell",
                shell_steps={"all": [["uv", "tool", "install", "graphifyy"], ["graphify", "install"]]},
                uninstall_cmd=["graphify", "uninstall"],
            ),
        },
    ),
    # 14 — tirth8205/code-review-graph (rank 11, A_code_graph): PR blast-radius.
    Plugin(
        name="code-review-graph",
        summary="Review blast-radius graph; 30 MCP tools; benchmarked 38-528x token cut, 100% recall. PR-review specialist. 14 platforms.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="tirth8205/code-review-graph", owner="tirth8205", license="MIT", stars=17985, forks=1925,
        category="code-graph-review", redundancy_group="A_code_graph", recommend_rank=11,
        automation="install writes MCP config for 14 agents; multi-repo self-healing daemon (crg-daemon, 30s health-checks); hook/watch-mode incremental updates on save/commit. Needs explicit init, then auto-maintains.",
        security_note="Clean pip (no curl-pipe); verify PyPI identity. Multi-repo daemon = persistent process (opt-in). Local SQLite, no egress.",
        caveats=(
            "multi-repo daemon (crg-daemon) is a persistent background process — opt-in",
            "code-graph redundancy group A — codegraph is the default pick",
        ),
        targets={
            "*": InstallSpec(
                method="shell",
                shell_steps={"all": [
                    ["pip", "install", "code-review-graph"],
                    ["code-review-graph", "install"],
                    ["code-review-graph", "build"],
                ]},
                uninstall_cmd=["pip", "uninstall", "-y", "code-review-graph"],
            ),
        },
    ),
    # 17 — Galaxy-Dawn/claude-scholar (rank 12, B_research): personal research KM.
    Plugin(
        name="claude-scholar",
        summary="Personal research KM: Zotero + Obsidian + 5 cross-platform hooks (incl. own security-guard). Research-KM niche leader.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="Galaxy-Dawn/claude-scholar", owner="Galaxy-Dawn", license="MIT", stars=4185, forks=373,
        category="research-km", redundancy_group="B_research", recommend_rank=12,
        automation="5 Node hooks: skill-forced-eval.js (mandatory skill-check before each prompt), session-start/summary, stop-summary, security-guard.js (two-tier Block+Confirm dangerous-command gate); /kb-sync deterministic KB maintenance; Obsidian vault + Zotero MCP.",
        security_note="Prefer marketplace (lower surface). Backup-aware installer (timestamped backups, clean uninstall). Ships own security-guard.js (two-tier gate prior-art).",
        caveats=(
            "installs 5 Node hooks + settings.json merge (note manual 'rules' step)",
            "small community (~4k) = least battle-tested of the research trio",
            "per-agent branches: codex / kimi / opencode",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="claude-scholar",
                marketplace_repo="Galaxy-Dawn/claude-scholar",
                plugin_id="claude-scholar@claude-scholar",
                scope="user",
            ),
        },
    ),
    # 19 — levnikolaevich/claude-code-skills (rank 13, D_dev_workflow): lifecycle + MCP.
    Plugin(
        name="claude-code-skills-lev",
        summary="Lifecycle suite (137 skills/7 plugins) + 4 bundled MCP servers (hex-line/hex-graph/hex-ssh/hex-research). Orchestrator-worker + Claude↔Codex cross-review. Lowest adoption.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="levnikolaevich/claude-code-skills", owner="levnikolaevich", license="MIT", stars=480, forks=69,
        category="dev-workflow", redundancy_group="D_dev_workflow", recommend_rank=13,
        automation="Orchestrator-worker pipeline auto-fires stages (stateful/resumable checkpoints); hex-line hooks HARD-redirect built-in Read/Edit/Write to hash-verified equivalents + block dangerous commands + enforce plan mode; Claude↔Codex cross-validation.",
        security_note="Scan; EXPLICITLY surface hex-ssh (remote command execution — never enable silently) + hex-line tool-redirect (invasive default-behavior change) + npm-MCP supply chain. Verify @levnikolaevich/* publisher.",
        caveats=(
            "hex-ssh MCP = REMOTE COMMAND EXECUTION — Prometheus does NOT auto-add it; enable knowingly",
            "hex-line HARD-redirects built-in Read/Edit/Write (invasive) — consent point",
            "4 MCP servers are executable npm packages; lowest adoption (~480) = least battle-tested",
            "dev-workflow redundancy group D — superpowers is the default pick",
        ),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="levnikolaevich-skills-marketplace",
                marketplace_repo="levnikolaevich/claude-code-skills",
                plugin_id="claude-code-skills@levnikolaevich-skills-marketplace",
                scope="user",
            ),
        },
    ),
    # 20 — reviewdog/reviewdog (rank 14, devtool, E_code_review): linter→PR glue.
    Plugin(
        name="reviewdog",
        summary="Linter→PR-comment glue (NOT AI, no MCP). Most mature repo here (since 2016). CI/dev tool; agent-wrappable via a SKILL.md.",
        tier="devtool", bundle=False, claude_exclusive=False,
        repo="reviewdog/reviewdog", owner="reviewdog", license="MIT", stars=9334, forks=489,
        category="code-review-linter", redundancy_group="E_code_review", recommend_rank=14,
        automation="CI-on-every-PR (inline comments + code suggestions); local pre-commit/pre-push hook; SARIF aggregation. Prometheus can scaffold a lint-review SKILL.md (Bash wrapper) so an agent auto-fires reviewdog on review prompts.",
        security_note="Prefer brew/go install; the curl|sh fallback pins a SHA → fetch+scan first. Oldest/most battle-tested; low risk once installed.",
        caveats=(
            "not an AI skill — no native MCP/skill layer; it's a CI/dev binary (agent-wrap via `scaffold-skill`)",
            "code-review group E STACKS (reviewdog=linters + security-review=AI + code-review-graph=structural)",
            "Linux install uses `go install` (needs Go); macOS uses Homebrew",
        ),
        targets={
            "*": InstallSpec(
                method="shell",
                shell_steps={
                    "macos": [["brew", "install", "reviewdog/tap/reviewdog"]],
                    "linux": [["go", "install", "github.com/reviewdog/reviewdog/cmd/reviewdog@latest"]],
                },
                uninstall_steps={"macos": [["brew", "uninstall", "reviewdog"]]},
            ),
        },
    ),
    # ===== github_repos_c.txt — community plugins/agents + a devtool =====
    # 61 — Egonex-AI/Understand-Anything: codebase -> interactive knowledge graph (cross-agent plugin/skill).
    Plugin(
        name="understand-anything",
        summary="Turns any codebase into an interactive, searchable knowledge graph (multi-agent map of files/functions/deps) + a local dashboard. Cross-agent plugin/skill.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="Egonex-AI/Understand-Anything", owner="Egonex-AI", license="MIT", stars=64300,
        category="codebase-knowledge-graph",
        automation="Model-invoked skill + /understand commands; builds .understand-anything/knowledge-graph.json on demand. Cross-agent (Claude/Cursor/Copilot/Codex/Gemini/Cline + ~15).",
        security_note="Scan. DUAL-USE egress: it recursively reads ALL project files and ships contents to the configured LLM (use a local model/Ollama for private code). Raw installer is curl|bash — prefer the marketplace path; gitignore .understand-anything/.",
        caveats=(
            "reads every project file -> LLM egress (point at a local model for sensitive code)",
            "raw install is curl|bash / iwr|iex (prefer the /plugin marketplace path; scan first)",
            "launches a local dashboard server; run on non-sensitive checkouts",
        ),
        supported_os=("macos", "linux"),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="Understand-Anything",
                marketplace_repo="Egonex-AI/Understand-Anything",
                plugin_id="understand-anything@Understand-Anything",
                scope="user",
            ),
        },
    ),
    # 62 — nanocoai/nanoclaw: self-hosted, container-isolated personal AI agent (Claude Agent SDK) bridged to chat apps.
    Plugin(
        name="nanoclaw",
        summary="Self-hosted personal AI agent (Claude Agent SDK / Claude Code; drop-in OpenAI/OpenRouter/Google/DeepSeek/local) that runs per-group agents in isolated Docker containers and bridges WhatsApp/Telegram/Slack/Discord/Gmail, with memory + scheduled jobs.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="nanocoai/nanoclaw", owner="nanocoai", license="MIT", stars=29929,
        category="self-hosted-ai-agent",
        automation="Agent-runner polls an inbound message DB and runs the agent (full Claude Code toolset incl. in-container bash) on each message + on scheduled 'cron' jobs; replies via an outbound DB. Per-group memory via CLAUDE.md.",
        security_note="DUAL-USE, AUTHORIZED-USE-ONLY. Autonomous agents execute code/shell driven by UNTRUSTED inbound chat messages + scheduled jobs = prompt-injection / unauthorized-action surface. The project mitigates with per-agent Docker isolation (non-root, ephemeral, project root read-only, optional micro-VM) + OneCLI credential vault. Keep agents in those containers; never run on the host. Scan the setup script.",
        caveats=(
            "autonomous AI agents run shell/code in response to untrusted chat messages (prompt-injection vector)",
            "keep per-agent Docker container isolation on; never run agents on the host; scope mounted volumes/creds",
            "needs an AI provider credential (Anthropic by default) + Docker; broad messaging-platform tokens",
            "setup script auto-installs Node/pnpm/Docker — review nanoclaw.sh before running",
        ),
        supported_os=("macos", "linux"),
        targets={
            "*": InstallSpec(
                method="git_clone_shell",
                repo_url="https://github.com/nanocoai/nanoclaw.git",
                dest="~/nanoclaw-v2",
                shell_steps={"all": [["bash", "nanoclaw.sh"]]},
                uninstall_steps={"all": [["bash", "nanoclaw.sh", "--uninstall", "--yes"]]},
            ),
        },
    ),
    # 63 — ruvnet/RuView: WiFi-CSI "sensing" platform + Claude Code plugin/MCP. FLAGGED low-trust/overhyped.
    Plugin(
        name="ruview",
        summary="WiFi CSI 'sensing' platform claiming through-wall pose/vitals/presence detection, shipping a Claude Code plugin (skills + /ruview-* commands + agents) and a SENSE-BRIDGE MCP server. ⚠️ widely reported as overhyped / largely unimplemented.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="ruvnet/RuView", owner="ruvnet", license="MIT", stars=74800,
        category="ai-agent-plugin",
        automation="Claude Code plugin: 9 skills, 7 /ruview-* commands, 3 agents + a SENSE-BRIDGE MCP server (@ruvnet/rvagent) exposing sensor tools to Claude/Cursor/ruflo swarms.",
        security_note="LOW-TRUST / EXPERIMENTAL — independent reviews (HN, Cybernews) call the core sensing/pose pipeline largely unimplemented 'vibe-coded boilerplate'; the ~75k stars are viral hype, not working capability. Scan + caution. DUAL-USE: bundled agents/MCP build code, FLASH ESP32 firmware (esptool), and run training pipelines under agent control; pulls precompiled binaries.",
        caveats=(
            "OVERHYPED: reviewers report the through-wall sensing claims are unverified / largely non-functional",
            "agents/MCP autonomously build code, flash ESP32 firmware, run training pipelines — sandbox execution",
            "downloads precompiled 'Cog' binaries + native Rust/PyO3 wheels — pin/verify provenance",
            "privacy/surveillance implications of a human-sensing tool; star count inflated by hype",
        ),
        supported_os=("macos", "linux"),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="ruview",
                marketplace_repo="ruvnet/RuView",
                plugin_id="ruview@ruview",
                scope="user",
            ),
        },
    ),
    # 63b — ruvnet/ruflo: agent meta-harness / swarm orchestrator for Claude (claude-flow lineage). FLAGGED dual-use + hype.
    Plugin(
        name="ruflo",
        summary="ruvnet's 'agent meta-harness for Claude' — orchestrates multi-agent swarms with 100+ specialist agents, HNSW vector memory, background workers, and cross-machine agent federation. Ships BOTH a Claude Code plugin (`ruflo-core@ruflo`) and a standalone `ruflo` CLI + an MCP server (`npx ruflo mcp start`).",
        tier="community", bundle=False, claude_exclusive=False,
        repo="ruvnet/ruflo", owner="ruvnet", license="MIT", stars=60900,
        category="agent-orchestration",
        automation="Claude plugin: skills + slash commands that spin up autonomous agent swarms; the CLI/MCP coordinate workers, persistent memory, and cross-machine federation that Claude/Cursor agents drive.",
        security_note="DUAL-USE + caution (same ruvnet/claude-flow lineage as [[ruview]]). Spins up 100+ AUTONOMOUS agents + background workers that generate and RUN code, persist HNSW memory, and FEDERATE across machines (network egress + remote agent control) — broad attack surface under agent control. Upstream offers a `curl … | bash` installer — PREFER the gated `npm`/marketplace path. Star count is large but historically inflated by viral hype, not audited capability. Scan + sandbox; review before granting swarm/network powers.",
        caveats=(
            "autonomous swarms + background workers execute generated code — run sandboxed",
            "cross-machine agent FEDERATION = network egress + remote control surface; isolate the network",
            "avoid the upstream curl|bash installer — prefer `npm i -g ruflo` / the Claude marketplace",
            "ruvnet ecosystem: star count inflated by hype — verify behaviour before trusting it",
        ),
        supported_os=("macos", "linux"),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="ruflo",
                marketplace_repo="ruvnet/ruflo",
                plugin_id="ruflo-core@ruflo",
                scope="user",
            ),
            "*": InstallSpec(
                method="shell",
                shell_steps={"all": [["npm", "install", "-g", "ruflo@latest"]]},
                uninstall_cmd=["npm", "uninstall", "-g", "ruflo"],
            ),
        },
    ),
    # 60 — gosom/google-maps-scraper (DEV-TOOL): Go Google-Maps business-data scraper (Playwright browser).
    Plugin(
        name="google-maps-scraper",
        summary="Go-based Google Maps business-data scraper driving a headless Playwright browser; CLI + Web UI (:8080) + REST API. Dev-tool, not an AI skill.",
        tier="devtool", bundle=False, claude_exclusive=False,
        repo="gosom/google-maps-scraper", owner="gosom", license="MIT", stars=4400,
        category="web-scraper",
        automation="Not a fire-on-prompt skill — a standalone scraper run via CLI/Docker/REST.",
        security_note="DUAL-USE, AUTHORIZED-USE-ONLY. Drives a real headless browser and crawls arbitrary third-party business sites (email harvesting) at scale = network egress + SSRF/malicious-page surface; exposes :8080. Prefer the Docker image (isolation) over the curl|sh PROVISION path. Scraping Google Maps may violate ToS; email/PII raises privacy/legal concerns.",
        caveats=(
            "drives a browser + crawls arbitrary sites at scale (ToS / PII / SSRF) — run network-isolated in Docker",
            "avoid the curl|sh PROVISION installer on untrusted machines; expose :8080 only locally",
            "authorized-use-only (Google ToS + email/PII privacy)",
        ),
        supported_os=("macos", "linux"),
        targets={
            "*": InstallSpec(
                method="shell",
                shell_steps={"all": [["docker", "pull", "gosom/google-maps-scraper"]]},
                uninstall_cmd=["docker", "rmi", "gosom/google-maps-scraper"],
            ),
        },
    ),
    # ===== ais_plugins.txt — community skill packs =====
    # 68 — AI-Marketing-Hub/claude-blog: AI blog-writing + SEO skill suite.
    Plugin(
        name="claude-blog",
        summary="AI blog-writing + SEO skill suite for Claude Code: 30 sub-skills, 5 agents, slash commands for research→draft→optimize→publish.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="AI-Marketing-Hub/claude-blog", owner="AI-Marketing-Hub", license="MIT",
        category="content-seo",
        automation="Skills auto-fire on blog/SEO prompts once enabled; /commands for the pipeline.",
        security_note="Scan: ships an install.sh and a requirements.txt (pip). Prefer the marketplace/`npx skills add` path over the curl|bash installer.",
        caveats=("upstream also offers `curl ... | bash` — prefer marketplace or `npx skills add` (gated)",),
        supported_os=("macos", "linux"),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="ai-marketing-hub-claude-blog",
                marketplace_repo="AI-Marketing-Hub/claude-blog",
                plugin_id="claude-blog@ai-marketing-hub-claude-blog",
                scope="user",
            ),
            "*": InstallSpec(
                method="universal_skill",
                universal_add=["npx", "-y", "skills", "add", "agricidaniel/claude-blog"],
            ),
        },
    ),
    # 72 — forrestchang/andrej-karpathy-skills: behavioral coding guidelines.
    Plugin(
        name="andrej-karpathy-skills",
        summary="Four behavioral coding guidelines (from Karpathy's notes on common LLM coding pitfalls) packaged as a Claude plugin / CLAUDE.md / Cursor rule.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="forrestchang/andrej-karpathy-skills", owner="forrestchang", license="MIT",
        category="dev-guidelines",
        automation="Guideline skills nudge the agent away from common pitfalls; doc-only content (CLAUDE.md / rule).",
        security_note="Documentation/guidelines only — no code execution. Safe; lowest-risk install.",
        supported_os=("macos", "linux"),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="karpathy-skills",
                marketplace_repo="forrestchang/andrej-karpathy-skills",
                plugin_id="andrej-karpathy-skills@karpathy-skills",
                scope="user",
                manual_note="non-Claude: `curl -o CLAUDE.md https://raw.githubusercontent.com/forrestchang/andrej-karpathy-skills/main/CLAUDE.md` or copy .cursor/rules/karpathy-guidelines.mdc",
            ),
        },
    ),
    # 77 — NVIDIA/skills: official NVIDIA Agent Skills catalog (signed SKILL.md sets).
    Plugin(
        name="nvidia-skills",
        summary="NVIDIA's official Agent-Skills catalog (CUDA/cuOpt/RAPIDS/Triton/... domains) — portable SKILL.md sets installable into any compatible agent.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="NVIDIA/skills", owner="NVIDIA", license="Apache-2.0",
        category="vendor-skills",
        automation="Domain skills auto-fire on matching prompts once added; browse with `--list` and add only what you need.",
        security_note="Vendor (NVIDIA) skill catalog via the universal `skills` installer → low risk; review each SKILL.md (some reference GPU/CUDA tooling).",
        supported_os=("macos", "linux"),
        targets={
            "*": InstallSpec(
                method="universal_skill",
                universal_add=["npx", "skills", "add", "nvidia/skills"],
                manual_note="browse first: `npx skills add nvidia/skills --list`; single: `npx skills add nvidia/skills --skill <name> --agent <claude-code|codex|...>`; remove: `npx skills remove <name>`",
            ),
        },
    ),
    # 78 — addyosmani/agent-skills: production engineering-workflow skills.
    Plugin(
        name="addyosmani-agent-skills",
        summary="24 engineering-workflow skills + 8 slash commands + 4 agent personas (by addyosmani) — review, refactor, testing, perf, a11y, release pipelines.",
        tier="community", bundle=False, claude_exclusive=False,
        repo="addyosmani/agent-skills", owner="addyosmani", license="MIT",
        category="dev-workflow",
        automation="Workflow skills auto-fire on matching tasks; /commands + personas for structured engineering flows.",
        security_note="Skill content (instructions/commands) — scan; low risk. Installs across Claude/Gemini/Cursor.",
        supported_os=("macos", "linux"),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="addy-agent-skills",
                marketplace_repo="addyosmani/agent-skills",
                plugin_id="agent-skills@addy-agent-skills",
                scope="user",
            ),
            "gemini": InstallSpec(
                method="shell",
                shell_steps={"all": [["gemini", "skills", "install", "https://github.com/addyosmani/agent-skills.git", "--path", "skills"]]},
            ),
        },
    ),
    # 81 — kepano/obsidian-skills: teach an agent to work with Obsidian vaults.
    Plugin(
        name="obsidian-skills",
        summary="Agent Skills (by @kepano, Obsidian CEO) that teach an AI coding agent to read/write/organize an Obsidian Markdown vault (links, properties, canvases).",
        tier="community", bundle=False, claude_exclusive=False,
        repo="kepano/obsidian-skills", owner="kepano", license="MIT",
        category="notes-knowledge",
        automation="Skills auto-fire when working inside an Obsidian vault once enabled.",
        security_note="Skill content only — low risk. Point it at YOUR vault; it edits Markdown files there.",
        supported_os=("macos", "linux"),
        targets={
            "claude": InstallSpec(
                method="claude_plugin",
                marketplace_name="obsidian-skills",
                marketplace_repo="kepano/obsidian-skills",
                plugin_id="obsidian@obsidian-skills",
                scope="user",
            ),
            "*": InstallSpec(
                method="universal_skill",
                universal_add=["npx", "skills", "add", "https://github.com/kepano/obsidian-skills"],
            ),
        },
    ),
    # ===== ais_plugins.txt — devtools (gated installers; not Claude-exclusive) =====
    # 91 — abhigyanpatwari/GitNexus: code-knowledge-graph CLI + MCP server.
    Plugin(
        name="gitnexus",
        summary="Zero-server code-intelligence engine: statically indexes a codebase into a queryable knowledge graph (imports/calls/types). CLI + MCP server for any agent.",
        tier="devtool", bundle=False, claude_exclusive=False,
        repo="abhigyanpatwari/GitNexus", owner="abhigyanpatwari", license="MIT",
        category="code-intelligence",
        automation="Run as an MCP server (`npx -y gitnexus@latest mcp`) so agents query the graph live.",
        security_note="npm package + native deps (tree-sitter). Scan the install; runs locally over your code (no egress by default).",
        caveats=("MCP add: `claude mcp add gitnexus -- npx -y gitnexus@latest mcp`; works in Cursor/OpenCode/Codex via their mcp config",),
        supported_os=("macos", "linux"),
        targets={
            "*": InstallSpec(
                method="shell",
                shell_steps={"all": [["npm", "install", "-g", "gitnexus"]]},
                uninstall_cmd=["npm", "uninstall", "-g", "gitnexus"],
                manual_note="no-install run: `npx gitnexus@latest serve`; clean removal of MCP wiring: `gitnexus uninstall --force`",
            ),
        },
    ),
    # 80 — vercel-labs/agent-browser: native Rust browser-driver CLI for agents (DUAL-USE).
    Plugin(
        name="agent-browser",
        summary="Vercel Labs' fast native (Rust) CLI that drives real browsers for AI agents via raw Chrome DevTools Protocol — navigate/click/type/extract from the terminal.",
        tier="devtool", bundle=False, claude_exclusive=False,
        repo="vercel-labs/agent-browser", owner="vercel-labs", license="Apache-2.0",
        category="browser-automation",
        automation="Agents shell out to `agent-browser` to act in a real browser; can install as a skill too (`npx skills add vercel-labs/agent-browser`).",
        security_note="DUAL-USE + AUTHORIZED-USE-ONLY: drives a REAL browser on arbitrary/untrusted pages → page content (prompt injection) can drive real actions / exfiltrate from logged-in sessions. Use a throwaway profile, isolate egress, never on credentialed sessions.",
        caveats=("use a DEDICATED throwaway browser profile (no real cookies/credentials)",
                 "run network-isolated; treat fetched page content as untrusted input to the agent",
                 "`agent-browser install` downloads a browser runtime — scan/confirm"),
        supported_os=("macos", "linux"),
        targets={
            "*": InstallSpec(
                method="shell",
                shell_steps={"all": [["npm", "install", "-g", "agent-browser"], ["agent-browser", "install"]]},
                uninstall_cmd=["npm", "uninstall", "-g", "agent-browser"],
                manual_note="alternatives: `brew install agent-browser` / `cargo install agent-browser` / skill: `npx skills add vercel-labs/agent-browser`",
            ),
        },
    ),
    # >>> INSERT COMMUNITY + DEVTOOL PLUGINS HERE (one Plugin() per md) <<<
]


# ----------------------------------------------------------------------------
#  DOCUMENTED-ONLY / EXCLUDED — Prometheus NEVER installs these. The wizard may
#  show an info card + manual pointer only (aggregators, self-hosted apps, paid
#  SaaS, deprecated, product pages). Files 25 (ECC-Tools paid SaaS) & 26
#  (odysseus self-hosted app) belong here and are EXCLUDED from install by
#  design — no adapter, no scan, no alias. Each entry is a plain dict.
# ----------------------------------------------------------------------------
DOCUMENTED_ONLY: list[dict] = [
    # 22 — quemsah/awesome-claude-plugins: aggregator / discovery feed (never installed).
    {"id": "awesome-claude-plugins",
     "summary": "Automated n8n leaderboard (20,010 repos indexed, top 100 shown) — a DISCOVERY FEED.",
     "why_excluded": "aggregator/list, not a plugin; no license (read metrics, don't vendor content); surfaces unvetted repos — scan each before install",
     "doc_url": "https://github.com/quemsah/awesome-claude-plugins"},
    # 23 — github.com/features/code-review: GitHub Copilot Code Review (product page).
    {"id": "github-features-code-review",
     "summary": "GitHub Copilot Code Review — hosted service (product page, not a repo).",
     "why_excluded": "paid Copilot-tier hosted service; enable via repo/org rulesets (auto-request Copilot review). GitHub-side counterpart to claude-code-security-review",
     "doc_url": "https://github.com/features/code-review"},
    # 24 — gitpod-io/gitpod: cloud dev environment, DEPRECATED (→ Ona).
    {"id": "gitpod",
     "summary": "Gitpod cloud dev environment — DEPRECATED (→ Ona, sunset 2025-10-15).",
     "why_excluded": "deprecated; cloud dev-env infra, not an AI skill; AGPL-3.0. Ona successor hosts agents but Prometheus does not provision it",
     "doc_url": "https://github.com/gitpod-io/gitpod"},
    # ===== ais_plugins.txt — EXCLUDED by safety policy (jailbreak / leaked-prompt / ToS-risk) =====
    {"id": "g0dm0d3",
     "summary": "elder-plinius/G0DM0D3 — a collection of LLM jailbreak / 'liberation' prompts.",
     "why_excluded": "JAILBREAK content: prompts designed to subvert AI safety guardrails. Installing it into an agent arms it to bypass its own safety — Prometheus does not install/auto-run it. Documented for awareness/defense only (red-teamers know what to defend against). NOT an authorized-pentest tool.",
     "doc_url": "https://github.com/elder-plinius/G0DM0D3"},
    {"id": "cl4r1t4s",
     "summary": "elder-plinius/CL4R1T4S — an archive of leaked/extracted AI system prompts.",
     "why_excluded": "Leaked system-prompt archive — reference/curiosity content, not a skill or installable tool. Documented only; nothing to install or run.",
     "doc_url": "https://github.com/elder-plinius/CL4R1T4S"},
    {"id": "free-claude-code",
     "summary": "Alishahryar1/free-claude-code — wiring to use Claude Code via unofficial/free proxies.",
     "why_excluded": "ToS RISK: routes Claude Code through unofficial 'free' model proxies — likely violates provider Terms of Service and can leak your code/prompts to untrusted third parties. Prometheus will not install it. Use real provider auth (see `ai-cli-multi`) instead.",
     "doc_url": "https://github.com/Alishahryar1/free-claude-code"},
    # ===== ais_plugins.txt — EXCLUDED (desktop apps / appliances / paid / product pages) =====
    {"id": "omnivoice-studio",
     "summary": "debpalash/OmniVoice-Studio — free local desktop voice-AI studio (ElevenLabs-style TTS).",
     "why_excluded": "GUI desktop app distributed as signed installers (.dmg/.msi/.AppImage/.deb) or `docker run -it palashdeb/omnivoice-studio`. Best installed via the OS installer, not a CLI wizard. Documented with the download links.",
     "doc_url": "https://github.com/debpalash/OmniVoice-Studio"},
    {"id": "finceptterminal",
     "summary": "Fincept-Corporation/FinceptTerminal — free open-source 'Bloomberg alternative' desktop finance terminal (Qt, v4.x).",
     "why_excluded": "Standalone desktop GUI app — install via the official per-OS installers (or build with setup.sh). The legacy v2.x had a `pip install fincept-terminal` TUI; current 4.x is a desktop build. Documented with install pointers.",
     "doc_url": "https://github.com/Fincept-Corporation/FinceptTerminal"},
    {"id": "openjarvis",
     "summary": "open-jarvis/OpenJarvis — Stanford lab's local-first personal AI agent framework (Rust+Python).",
     "why_excluded": "Primary install is `curl ... | bash` (or PowerShell `irm | iex`); the cleaner path is `git clone` + `./scripts/quickstart.sh` / `uv sync`. Documented rather than auto-piped; review the installer before running it.",
     "doc_url": "https://github.com/open-jarvis/OpenJarvis"},
    {"id": "project-nomad",
     "summary": "Crosstalk-Solutions/project-nomad — offline-first 'survival computer' appliance (offline media/archives/data + local AI).",
     "why_excluded": "Appliance install via a ROOT `curl ... | sudo bash` one-liner aimed at a DEDICATED host/Pi (or an inspectable management_compose.yaml). Not for a dev workstation; documented with the compose path. Review before running on real hardware.",
     "doc_url": "https://github.com/Crosstalk-Solutions/project-nomad"},
    {"id": "web-check",
     "summary": "Lissy93/web-check — self-hosted OSINT dashboard (DNS/SSL/headers/tech/cookies recon for a website).",
     "why_excluded": "DUAL-USE OSINT (AUTHORIZED-USE-ONLY): self-host via `docker run -p 3000:3000 lissy93/web-check` and only scan domains you own/are authorized to assess. Documented (with the self-host command) rather than auto-installed.",
     "doc_url": "https://github.com/Lissy93/web-check"},
    {"id": "ecc-tools-github",
     "summary": "ECC-Tools/.github — GitHub org profile for the ECC tooling (see the `ecc` plugin entry).",
     "why_excluded": "Org profile/landing repo (paid ECC ecosystem), not an installable artifact. The installable ECC lives under the `ecc` plugin; this is documentation only.",
     "doc_url": "https://github.com/ECC-Tools/.github"},
    {"id": "google-ai-edge-eloquent",
     "summary": "Google AI Edge 'Eloquent' — an iOS app (Apple App Store), on-device AI.",
     "why_excluded": "Closed-source mobile app on the Apple App Store — install on iOS, not via Prometheus. Documented pointer only.",
     "doc_url": "https://apps.apple.com/us/app/google-ai-edge-eloquent/id6756505519"},
    {"id": "wan",
     "summary": "Wan (Alibaba) — open-weights text/image-to-VIDEO generation model family (Apache-2.0).",
     "why_excluded": "A video diffusion model, not an OpenAI-compatible text LLM — run it via ComfyUI / diffusers / DiffSynth-Studio with the open weights (needs a strong GPU), not via the chat/ollama path. Documented in the local-models catalog as a media model.",
     "doc_url": "https://github.com/Wan-Video/Wan2.1"},
    # ===== ais_plugins.txt — aggregators / reference lists (discovery only, never installed) =====
    {"id": "awesome-selfhosted",
     "summary": "awesome-selfhosted/awesome-selfhosted — the canonical curated list of self-hostable open-source software.",
     "why_excluded": "A discovery list, not a tool. Browse it to find apps; install the specific ones (many are already in Prometheus `apps`). Scan anything you pick.",
     "doc_url": "https://github.com/awesome-selfhosted/awesome-selfhosted"},
    {"id": "awesome-tunneling",
     "summary": "anderspitman/awesome-tunneling — curated list of tunneling / reverse-proxy / ngrok-style tools.",
     "why_excluded": "Reference list, not a tool. Use it to choose a tunneling solution (Cloudflare Tunnel / Tailscale / frp / ...); install the chosen one yourself.",
     "doc_url": "https://github.com/anderspitman/awesome-tunneling"},
    {"id": "homelab",
     "summary": "khuedoan/homelab — one person's GitOps homelab (K8s + Terraform + Ansible) reference.",
     "why_excluded": "A personal infrastructure reference/template, not a generally-installable app. Read it for ideas; it provisions whole clusters and is environment-specific. Documented only.",
     "doc_url": "https://github.com/khuedoan/homelab"},
    {"id": "proxmoxve",
     "summary": "community-scripts/ProxmoxVE — community helper scripts to deploy apps/LXCs on a Proxmox host.",
     "why_excluded": "DANGEROUS context: scripts are run as ROOT on a Proxmox HYPERVISOR via `bash -c \"$(curl ...)\"`. Host-level, not for a workstation; review each script before running on your hypervisor. Documented only.",
     "doc_url": "https://github.com/community-scripts/ProxmoxVE"},
    # NOTE: files 25 (ECC-Tools paid SaaS) & 26 (odysseus self-hosted app) are also
    # excluded from install by design — documented in the registry, not actioned here.
]


# Combined view used by list/install/audit. Bundle + external; documented-only
# stays out of install paths.
PLUGINS: list[Plugin] = OFFICIAL_BUNDLE + EXTERNAL_PLUGINS


def plugin_registry() -> dict[str, Plugin]:
    return {p.name: p for p in PLUGINS}


def bundle_plugins() -> list[Plugin]:
    """The official one-run bundle (tier official or explicitly flagged bundle)."""
    return [p for p in PLUGINS if p.bundle or p.tier == "official"]


# ============================================================================
#  SECTION 6B — LOCAL-MODEL TOOLS  (the 3rd functionality)
#  A SEPARATE track from the agent-plugin installer: tools that RUN models
#  locally / in cloud (runners, kernels, workspace apps). Short blurb per tool +
#  guided install. Extensible — append a ModelTool to MODEL_TOOLS.
# ============================================================================
@dataclass
class ModelTool:
    id: str
    name: str
    category: str                 # library | kernel | local-app
    blurb: str                    # short, plain explanation (shown in the wizard)
    install_steps: dict[str, list[list[str]]] = field(default_factory=dict)  # os|"all" -> cmds
    prereq: Optional[str] = None  # "nvidia" → needs an NVIDIA GPU + CUDA
    guided: bool = False          # confirm-heavy (clone + run a server, e.g. odysseus)
    clone_url: Optional[str] = None      # guided apps: repo to clone (scanned) before running steps
    dest: Optional[str] = None
    isolated: bool = False        # install into a separated, versioned on-disk workspace (root/<tool>/...)
    install_kind: str = "pip"     # "pip" | "python-venv" | "docker"  (how the isolated tool is set up)
    requirements: Optional[str] = None   # python-venv: requirements file (relative to the clone) else pip the pkg
    pip_pkg: Optional[str] = None        # python-venv: PyPI package name (default = id)
    pip_extras: tuple[str, ...] = ()     # python-venv: optional extra pip packages (e.g. bitsandbytes)
    live_steps: tuple[tuple[str, ...], ...] = ()  # isolated: commands run WITH cwd=<live install dir>, run-and-RETURN (the shell terminates)
    serve_steps: tuple[tuple[str, ...], ...] = ()  # isolated: long-running SERVERS started DETACHED ("let it run") with cwd=<live install dir>
    security: str = ""
    warnings: tuple[str, ...] = ()
    post_notes: tuple[str, ...] = ()
    repo: str = ""
    docs: str = ""


MODEL_TOOLS: list[ModelTool] = [
    ModelTool(
        id="airllm", name="AirLLM", category="library",
        blurb="Run a 70B (or 405B) LLM on a 4–8GB GPU by streaming layers from disk. No quantization needed. Trade-off: SLOW (disk-bound) — best for 'too big to fit' models + offline jobs.",
        isolated=True, install_kind="python-venv",   # own tree: venv_airllm + versioned, offline-rollback wheels
        clone_url="https://github.com/lyogavin/airllm.git",   # source preserved per version (zipped git package)
        pip_pkg="airllm", pip_extras=("bitsandbytes",),       # bitsandbytes = optional 4/8-bit compression
        security="Pure-Python pip install (no kernel build, no curl|sh) → low risk. Downloads HF weights at runtime; your hf_token stays with you.",
        post_notes=("activate the env: `source venv_airllm/bin/activate` (Windows: venv_airllm\\Scripts\\activate)",
                    "use it: `from airllm import AutoModel` (see 27-airllm.md for the 70B-on-4GB example)",
                    "bitsandbytes installed for 4/8-bit compression (smaller shards = faster streaming)",
                    "use an NVMe SSD — latency is dominated by streaming the model off disk per token",
                    "offline rollback works: each version's wheel is cached under archives_airllm/wheels-vN/"),
        repo="https://github.com/lyogavin/airllm", docs="27-airllm.md",
    ),
    ModelTool(
        id="flashattention", name="FlashAttention", category="kernel",
        blurb="Makes attention 2–3× faster + ~20× less memory on NVIDIA GPUs (Ampere/Ada/Hopper). Exact, no quality loss. A KERNEL embedded into another engine's Python env — 7 install paths (prebuilt wheel / source build / FA3 Hopper / FA4 / HF kernels / AMD ROCm).",
        install_kind="kernel",                 # special multi-method, env-targeted installer
        prereq="nvidia",                       # method-aware gate inside _install_flashattention
        clone_url="https://github.com/Dao-AILab/flash-attention.git",
        security="BSD-3 from the original authors. Source/Hopper/ROCm methods COMPILE native CUDA at install (real build). Prebuilt-wheel + kernels methods don't build. No secrets/network beyond PyPI + GitHub release wheels.",
        post_notes=("most models use it transparently via HuggingFace attn_implementation='flash_attention_2'",
                    "it must match the TARGET env's torch+CUDA — install into the engine venv, not a bare one"),
        repo="https://github.com/dao-ailab/flash-attention", docs="28-flashattention.md",
    ),
    ModelTool(
        id="odysseus", name="Odysseus", category="local-app",
        blurb="Self-hosted private AI workspace (ChatGPT/Claude-style) on your own hardware: multi-model chat, agent, model 'Cookbook', deep-research, memory, email/calendar. Runs on http://localhost:7000.",
        guided=True, isolated=True, install_kind="docker",
        clone_url="https://github.com/pewdiepie-archdaemon/odysseus.git",
        # isolated install: these run WITH cwd=<live install dir> (root/odysseus/odysseus)
        live_steps=(("sh", "-lc", "cp -n .env.example .env || true"),
                    ("sh", "-lc", "docker compose up -d --build")),
        security="HEAVY + broad-reach app. Reads email(IMAP/SMTP)+calendar(CalDAV)+files and runs shell. Auth on by default; binds 127.0.0.1. Days-old repo, unproven maintainer — pin a commit.",
        warnings=("self-hosting an app that can read your mail/calendar + run shell is a deliberate choice",
                  "do NOT expose to the public internet without HTTPS + a trusted reverse proxy (Tailscale/Cloudflare/Caddy)",
                  "needs Docker (or Python 3.11+ native); first boot prints a temp admin password in the logs",
                  "new repo (created 2026-05-31) — least battle-tested; review before running"),
        post_notes=("first boot: `docker compose logs odysseus` to get the temp admin password",
                    "ports: 7000 UI · 8080 SearXNG · 8091 ntfy · 8100 ChromaDB · 11434 Ollama"),
        repo="https://github.com/pewdiepie-archdaemon/odysseus", docs="26-pewdiepie-odysseus.md",
    ),
    # ===== github_repos_c.txt — AI libraries (isolated venv, offline-rollback wheels) =====
    ModelTool(
        id="langchain", name="LangChain", category="library",
        blurb="The dominant Python framework for building LLM apps + agents (models, tools, retrievers, integrations) on the LangGraph runtime. Orchestration glue, not a model runner.",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/langchain-ai/langchain.git",
        pip_pkg="langchain",
        security="MIT core, huge adoption → low supply-chain risk. DUAL-USE at agent runtime: langchain-community/experimental ship tools that execute arbitrary Python/shell (PythonREPLTool/ShellTool), run SQL, and fetch arbitrary URLs (SSRF) — all LLM-driven. Importing is inert; risk is at tool execution.",
        warnings=("agent tools can run arbitrary Python/shell + fetch arbitrary URLs (RCE/SSRF via prompt injection)",
                  "run agent workloads in an isolated container/VM, egress-allowlisted, least-privilege creds",
                  "historic CVEs in community/experimental integrations"),
        post_notes=("activate: `source venv_langchain/bin/activate` (Windows: venv_langchain\\Scripts\\activate)",
                    "add providers in the venv, e.g. `pip install langchain-openai langchain-community`",
                    "for just running local models prefer ollama; LangChain is the glue"),
        repo="https://github.com/langchain-ai/langchain", docs="48-langchain-ai-langchain.md",
    ),
    ModelTool(
        id="browser-use", name="Browser Use", category="library",
        blurb="Let LLM agents autonomously drive a REAL web browser (navigate/click/type/extract) to complete online tasks. Native Rust core (0.13+).",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/browser-use/browser-use.git",
        pip_pkg="browser-use",
        security="MIT, ~100k stars, active. HIGH DUAL-USE: an LLM drives a real browser on arbitrary/untrusted pages with no human in the loop → prompt-injection from page content can exfiltrate data, submit forms, or act using any logged-in sessions. AUTHORIZED-USE-ONLY.",
        warnings=("an LLM autonomously acts in a real browser — prompt injection from pages can take real actions",
                  "use a DEDICATED throwaway browser profile (no real cookies/credentials)",
                  "run in an isolated container/VM with restricted egress; scope + rotate LLM API keys"),
        post_notes=("activate: `source venv_browser-use/bin/activate`",
                    "browser runtime: `pip install \"browser-use[core]\" && playwright install chromium`",
                    "use it from Python (see 49-browser-use-browser-use.md)"),
        repo="https://github.com/browser-use/browser-use", docs="49-browser-use-browser-use.md",
    ),
    ModelTool(
        id="crawl4ai", name="Crawl4AI", category="library",
        blurb="LLM-friendly web crawler/scraper: drives a headless browser to turn pages into clean Markdown / structured data for RAG + agents.",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/unclecode/crawl4ai.git",
        pip_pkg="crawl4ai",
        security="Apache-2.0, ~69k stars. DUAL-USE + high-egress: launches a real browser that executes JS from arbitrary fetched pages (SSRF/malicious-page), can send page content to external LLM APIs, exposes a Docker API on :11235. AUTHORIZED-USE-ONLY.",
        warnings=("executes JS from arbitrary fetched pages (SSRF / malicious-page surface)",
                  "sandbox with constrained egress; isolate from internal/metadata endpoints (169.254.169.254)",
                  "prefer the Docker image for isolation; firewall the API port 11235"),
        post_notes=("activate: `source venv_crawl4ai/bin/activate`",
                    "finish setup (installs Playwright browsers): `crawl4ai-setup`",
                    "or run the API server via docker: `docker run -d -p 11235:11235 unclecode/crawl4ai:latest`"),
        repo="https://github.com/unclecode/crawl4ai", docs="50-unclecode-crawl4ai.md",
    ),
    # ===== github_repos_c.txt — self-hosted AI apps (isolated docker; enable/disable via compose) =====
    ModelTool(
        id="langflow", name="Langflow", category="local-app",
        blurb="Low-code visual builder for AI agents + workflows; deploys as a self-hosted app with REST/MCP API servers (UI on :7860).",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/langflow-ai/langflow.git",
        live_steps=(("sh", "-lc", "cat > docker-compose.yml <<'YML'\nservices:\n  langflow:\n    image: langflowai/langflow:latest\n    ports:\n      - \"7860:7860\"\n    restart: unless-stopped\nYML"),
                    ("sh", "-lc", "docker compose up -d")),
        security="MIT. DUAL-USE: runs arbitrary Python via custom components + LLM agents; exposes REST/MCP + UI on :7860. PRIOR actively-exploited unauthenticated RCE (CVE-2025-3248) + account-takeover/RCE (CVE-2025-34291).",
        warnings=("executes arbitrary Python via custom components — treat the engine as code-exec capable",
                  "MANDATORY: run behind authentication, port firewalled (never public), patched to latest",
                  "isolate in a container/VM with restricted egress (CVE history)"),
        post_notes=("UI: http://localhost:7860", "enable auth + do not expose :7860 publicly"),
        repo="https://github.com/langflow-ai/langflow", docs="51-langflow-ai-langflow.md",
    ),
    ModelTool(
        id="flowise", name="Flowise", category="local-app",
        blurb="Low-code visual builder for LLM apps + AI agents (drag-and-drop LangChain/LlamaIndex flows). UI + prediction API on :3000.",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/FlowiseAI/Flowise.git",
        live_steps=(("sh", "-lc", "cd docker && cp -n .env.example .env || true"),
                    ("sh", "-lc", "cd docker && docker compose up -d")),
        security="Open-core: core Apache-2.0, BUT packages/server/src/enterprise (SSO/RBAC) is PROPRIETARY Commercial-licensed — verify LICENSE.md. DUAL-USE: Custom Tool/Function nodes run arbitrary server-side JS (+ arbitrary npm); an exposed/unauthenticated instance is effectively RCE.",
        warnings=("Custom Tool/Function nodes execute arbitrary server-side JavaScript (+ external npm deps)",
                  "require authentication; never expose :3000 to untrusted users; gate TOOL_FUNCTION_EXTERNAL_DEP",
                  "open-core license — the enterprise/ directory is proprietary (not OSI)"),
        post_notes=("UI: http://localhost:3000", "set FLOWISE_USERNAME/FLOWISE_PASSWORD in docker/.env"),
        repo="https://github.com/FlowiseAI/Flowise", docs="52-flowiseai-flowise.md",
    ),
    ModelTool(
        id="dify", name="Dify", category="local-app",
        blurb="Open-source LLM app development platform: visual workflow + RAG + agents + model management to build and operate GenAI apps.",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/langgenius/dify.git",
        live_steps=(("sh", "-lc", "cd docker && cp -n .env.example .env || true"),
                    ("sh", "-lc", "cd docker && docker compose up -d")),
        security="License = Apache-2.0 + additional conditions (no multi-tenant SaaS resale; keep logo/copyright) — NOT pure OSI. DUAL-USE: runs agent tools/plugins + a code-execution sandbox service; multi-container stack with many secrets in docker/.env.",
        warnings=("runs agent tools/plugins + a code-execution sandbox — keep behind auth + reverse proxy/TLS",
                  "rotate the example secrets in docker/.env (SECRET_KEY, DB, provider keys) before any non-local use",
                  "open-core license conditions — review before commercial/SaaS use"),
        post_notes=("UI: the configured nginx port (default http://localhost/)", "set the LLM provider keys in docker/.env"),
        repo="https://github.com/langgenius/dify", docs="53-langgenius-dify.md",
    ),
    ModelTool(
        id="open-webui", name="Open WebUI", category="local-app",
        blurb="Self-hosted ChatGPT-style web UI over local/remote LLMs (Ollama, OpenAI-compatible) with RAG, web search, voice. UI on :3000.",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/open-webui/open-webui.git",
        live_steps=(("sh", "-lc", "cat > docker-compose.yml <<'YML'\nservices:\n  open-webui:\n    image: ghcr.io/open-webui/open-webui:main\n    ports:\n      - \"3000:8080\"\n    volumes:\n      - open-webui:/app/backend/data\n    restart: unless-stopped\nvolumes:\n  open-webui: {}\nYML"),
                    ("sh", "-lc", "docker compose up -d")),
        security="License = Open WebUI License (BSD-3 + branding addendum, v0.6.6+) — source-available, NOT OSI. DUAL-USE: backend can execute user-defined Python Tools + web-browsing fetches arbitrary URLs; outbound LLM/API egress. Stores accounts + data.",
        warnings=("backend can execute user-defined Python Tools + fetch arbitrary URLs (web search/browsing)",
                  "enable auth + disable public signup (ENABLE_SIGNUP=false); reverse proxy + TLS; don't expose raw :3000",
                  "source-available license (not OSI) — branding must stay intact for free use"),
        post_notes=("UI: http://localhost:3000", "pairs with Ollama as the model backend"),
        repo="https://github.com/open-webui/open-webui", docs="54-open-webui-open-webui.md",
    ),
    ModelTool(
        id="supabase", name="Supabase", category="local-app",
        blurb="Open-source Firebase alternative: self-hostable Postgres backend (auth, auto REST/GraphQL APIs, realtime, storage, edge functions, pgvector).",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/supabase/supabase.git",
        live_steps=(("sh", "-lc", "cd docker && cp -n .env.example .env || true"),
                    ("sh", "-lc", "cd docker && docker compose up -d")),
        security="Apache-2.0, ~105k stars. Not an autonomous agent. RISK is operational: the shipped default docker/.env has INSECURE default secrets (JWT secret, anon/service-role keys, Postgres password, dashboard creds) that MUST be rotated; service-role key bypasses Row Level Security.",
        warnings=("ROTATE the default secrets in docker/.env before any non-local use (not production-safe by default)",
                  "bind Studio + Postgres to localhost or behind a firewall/reverse proxy",
                  "never expose the service-role key or default dashboard credentials"),
        post_notes=("Studio dashboard + Kong API gateway come up via docker/", "rotate JWT secret + anon/service-role keys first"),
        repo="https://github.com/supabase/supabase", docs="55-supabase-supabase.md",
    ),
    ModelTool(
        id="stirling-pdf", name="Stirling-PDF", category="local-app",
        blurb="Self-hosted, locally-run web platform with 50+ tools to edit/convert/merge/split/OCR/sign/redact PDFs. UI on :8080.",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/Stirling-Tools/Stirling-PDF.git",
        live_steps=(("sh", "-lc", "cat > docker-compose.yml <<'YML'\nservices:\n  stirling-pdf:\n    image: docker.stirlingpdf.com/stirlingtools/stirling-pdf:latest\n    ports:\n      - \"8080:8080\"\n    volumes:\n      - stirling-data:/usr/share/tessdata\n    restart: unless-stopped\nvolumes:\n  stirling-data: {}\nYML"),
                    ("sh", "-lc", "docker compose up -d")),
        security="Open-core: MIT core, proprietary/source-available subdirs (app/saas, engine, editor/portal/cloud) — per-dir LICENSE. DUAL-USE: no auth by default; processes untrusted uploaded PDFs and shells out to native binaries (Ghostscript/qpdf/Tesseract/LibreOffice/Calibre); URL-to-PDF can fetch arbitrary URLs (SSRF).",
        warnings=("no authentication by default — enable login/SSO before exposing it",
                  "processes untrusted uploads via native binaries (file-parser RCE surface) — network-isolate it",
                  "URL-to-PDF features fetch arbitrary URLs (SSRF) — restrict egress"),
        post_notes=("UI: http://localhost:8080", "pin a version tag instead of :latest for reproducible deploys"),
        repo="https://github.com/Stirling-Tools/Stirling-PDF", docs="56-stirling-tools-stirling-pdf.md",
    ),
    ModelTool(
        id="maxun", name="Maxun", category="local-app",
        blurb="No-code web data-extraction platform: build 'robots' that turn websites into APIs/spreadsheets via a real browser. Self-hosted via docker compose.",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/getmaxun/maxun.git",
        live_steps=(("sh", "-lc", "cp -n .env.example .env || true"),
                    ("sh", "-lc", "docker compose up -d")),
        security="AGPL-3.0 (copyleft). DUAL-USE: drives a real (Playwright) browser to scrape arbitrary/untrusted sites + fetches arbitrary URLs at scale; multi-container (frontend/backend/minio/redis/postgres) with secrets in .env. Scraping may carry ToS/PII/legal obligations.",
        warnings=("drives a real browser to scrape arbitrary sites + fetch arbitrary URLs (SSRF / ToS / PII risk)",
                  "AGPL-3.0 copyleft; set secrets in .env; reverse proxy + auth before exposure",
                  "network-isolate the scraping container; authorized-use-only"),
        post_notes=("UI: the configured frontend port (see .env)", "set ENCRYPTION_KEY + DB/MinIO secrets in .env"),
        repo="https://github.com/getmaxun/maxun", docs="58-getmaxun-maxun.md",
    ),
    # ===== github_repos_c.txt — autonomous dev agent (isolated venv; guided; runs code in a docker sandbox) =====
    ModelTool(
        id="openhands", name="OpenHands", category="local-app",
        guided=True, isolated=True, install_kind="python-venv",
        blurb="Autonomous AI software-development agent ('OpenHands', formerly OpenDevin): it writes + runs code, edits files, and browses to complete dev tasks, executing code inside a Docker sandbox runtime.",
        clone_url="https://github.com/All-Hands-AI/OpenHands.git",
        pip_pkg="openhands-ai",
        security="MIT, All-Hands-AI. HIGH DUAL-USE: an LLM autonomously executes arbitrary code/shell. It runs that code inside a Docker SANDBOX runtime and typically MOUNTS THE DOCKER SOCKET to spawn sandbox containers — powerful + sensitive. Prompt injection / a bad completion can run real commands. AUTHORIZED-USE-ONLY.",
        warnings=("an autonomous agent writes + executes arbitrary code/shell on your machine",
                  "it runs code in a Docker sandbox runtime (mounts the docker socket to spawn containers) — keep it isolated",
                  "run on non-sensitive projects, scoped credentials, restricted egress; review actions",
                  "needs Docker running for the sandbox runtime"),
        post_notes=("activate: `source venv_openhands/bin/activate`",
                    "GUI server: `openhands serve` then open http://localhost:3000 ; CLI: `openhands`",
                    "the agent executes code in a Docker sandbox — confirm actions, keep it off production"),
        repo="https://github.com/All-Hands-AI/OpenHands", docs="59-all-hands-ai-openhands.md",
    ),
    # ===== github_repos_c.txt — self-hosted PaaS (guided; official curl|sh root installer, prefetched+scanned) =====
    ModelTool(
        id="coolify", name="Coolify", category="local-app",
        guided=True, isolated=False, install_kind="docker",
        blurb="Open-source self-hostable PaaS (Heroku/Vercel/Railway alternative): deploy apps, databases, and 280+ one-click services on your own servers over SSH.",
        install_steps={"all": [["sh", "-lc", "curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash"]]},
        security="Apache-2.0, ~57k stars. Install is a REMOTE ROOT pipe-to-shell (curl ... | sudo bash) that installs Docker + the Coolify stack with broad privileges. Coolify is a privileged control plane: it holds SSH keys/credentials and orchestrates Docker (root-equivalent) on managed hosts; it builds/runs arbitrary git repos + container images.",
        warnings=("official install is `curl ... | sudo bash` (remote ROOT shell) — review/pin the script first",
                  "it installs Docker + stores SSH keys/server credentials = a high-impact, privileged service",
                  "firewall the dashboard (:8000) + realtime ports (:6001/:6002); only the proxy (:80/:443) should be public",
                  "deploy on an isolated host; it runs arbitrary user workloads (code-exec by design)"),
        post_notes=("dashboard: http://localhost:8000 (first run creates the admin account)",
                    "manage/UPDATE/UNINSTALL via Coolify's own tooling — this is a system install, not an isolated folder"),
        repo="https://github.com/coollabsio/coolify", docs="57-coollabsio-coolify.md",
    ),
    # ===== ais_plugins.txt — AI/ML libraries (isolated venv, offline-rollback wheels) =====
    ModelTool(
        id="ultralytics", name="Ultralytics YOLO", category="library",
        blurb="Official framework for the YOLO computer-vision family (detect / segment / classify / pose / track). Python library + `yolo` CLI; trains + runs on images/video/webcam.",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/ultralytics/ultralytics.git",
        pip_pkg="ultralytics",
        security="AGPL-3.0 (commercial license sold separately) — note the COPYLEFT before shipping. ~40k stars, very mature. Pure pip, no build/curl|sh → low install risk. Pulls model weights from the network at runtime; downloads/executes model files.",
        warnings=("AGPL-3.0 copyleft — using it in a distributed product may require open-sourcing or a paid commercial license",),
        post_notes=("activate: `source venv_ultralytics/bin/activate`",
                    "quick test: `yolo predict model=yolo11n.pt source=https://ultralytics.com/images/bus.jpg`",
                    "GPU strongly recommended for training; CPU works for light inference"),
        repo="https://github.com/ultralytics/ultralytics", docs="73-ultralytics-ultralytics.md",
    ),
    ModelTool(
        id="supervision", name="Supervision (Roboflow)", category="library",
        blurb="Model-agnostic computer-vision toolkit: annotators, detection/zone/line utilities, dataset loaders, trackers. Glue for building CV apps around any detector.",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/roboflow/supervision.git",
        pip_pkg="supervision",
        security="MIT, mature, widely used. Pure pip → low install risk; no network/secrets at import.",
        post_notes=("activate: `source venv_supervision/bin/activate`",
                    "pairs with ultralytics/any detector — see 87-roboflow-supervision.md"),
        repo="https://github.com/roboflow/supervision", docs="87-roboflow-supervision.md",
    ),
    ModelTool(
        id="crewai", name="CrewAI", category="library",
        blurb="Lean standalone Python framework for orchestrating multi-agent 'crews' + deterministic 'flows'. No LangChain dependency; `crewai` CLI scaffolds projects.",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/crewAIInc/crewAI.git",
        pip_pkg="crewai",
        security="MIT, ~54k stars, mature library. DUAL-USE at RUNTIME: the CodeInterpreterTool / allow_code_execution=True lets agents generate + run arbitrary Python; `unsafe_mode` runs it on the host (RCE). Publicly disclosed RCE/SSRF/sandbox-escape (CERT/CC VU#221883, CVE-2026-2275). Importing the lib is inert — risk is enabling code-exec tools. Telemetry ON by default (OTEL_SDK_DISABLED=true to silence).",
        warnings=("NEVER enable code execution (CodeInterpreterTool / allow_code_execution) outside Docker; never use unsafe_mode off a throwaway VM",
                  "do not point a code-exec agent at untrusted input (prompt-injection → host RCE)",
                  "run agent workloads container/VM-isolated with restricted egress + scoped LLM keys",
                  "set OTEL_SDK_DISABLED=true to disable anonymous telemetry"),
        post_notes=("activate: `source venv_crewai/bin/activate`",
                    "add tools in the venv: `pip install 'crewai[tools]'`; scaffold: `crewai create crew my_crew`"),
        repo="https://github.com/crewAIInc/crewAI", docs="64-crewaiinc-crewai.md",
    ),
    ModelTool(
        id="kronos", name="Kronos (K-line foundation model)", category="library",
        blurb="Open-source decoder-only foundation model for financial K-line (OHLCV candlestick) sequences — forecasting/representation for markets. Research repo (clone + requirements).",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/shiyu-coder/Kronos.git",
        pip_pkg=None, requirements="requirements.txt",
        security="Research code (clone + `pip install -r requirements.txt`) → no curl|sh; low install risk. Pulls pretrained weights from HuggingFace at runtime. NOT financial advice — backtest before trusting any forecast.",
        warnings=("predictions are model output, not investment advice — validate/backtest before any real use",),
        post_notes=("activate: `source venv_kronos/bin/activate`",
                    "fine-tune extra: `pip install pyqlib`; weights load via `Kronos.from_pretrained('NeoQuasar/Kronos-base')`"),
        repo="https://github.com/shiyu-coder/Kronos", docs="71-shiyu-coder-kronos.md",
    ),
    ModelTool(
        id="openmythos", name="OpenMythos", category="library",
        blurb="PyTorch research library — a community 'theoretical reconstruction' of a Claude-style model architecture. Educational/experimental, not a production model runner.",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/kyegomez/OpenMythos.git",
        pip_pkg="open-mythos",
        security="Pure pip (`open-mythos`) → low install risk. LOW MATURITY: a kyegomez 'reconstruction' research repo — treat as experimental, not battle-tested; verify it does what you expect before depending on it.",
        warnings=("experimental research code (low adoption) — not a maintained product; review before use",),
        post_notes=("activate: `source venv_openmythos/bin/activate`",
                    "flash-attn extra: `pip install open-mythos[flash]` (needs an NVIDIA GPU)"),
        repo="https://github.com/kyegomez/OpenMythos", docs="76-kyegomez-openmythos.md",
    ),
    ModelTool(
        id="notebooklm-py", name="notebooklm-py", category="library",
        blurb="Unofficial Python API + CLI + agent-skill for Google NotebookLM (programmatic notebooks, sources, audio overviews). `notebooklm` CLI after install.",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/teng-lin/notebooklm-py.git",
        pip_pkg="notebooklm-py",
        security="Pure pip. UNOFFICIAL: it automates Google NotebookLM via a logged-in browser session → using it may violate Google's ToS and can break when Google changes the UI. Handle your Google auth/cookies carefully (keep them local). AUTHORIZED-USE-ONLY against your own account.",
        warnings=("unofficial automation of a Google product — may breach Google ToS and break without notice",
                  "guards your Google session cookies — keep them local; never share the auth store"),
        post_notes=("activate: `source venv_notebooklm-py/bin/activate`",
                    "browser extra: `pip install 'notebooklm-py[browser]'`; then `notebooklm login`"),
        repo="https://github.com/teng-lin/notebooklm-py", docs="79-teng-lin-notebooklm-py.md",
    ),
    ModelTool(
        id="turbovec", name="TurboVec", category="library",
        blurb="Vector-search index library (Rust core + Python bindings) implementing Google Research's TurboQuant scalar quantization — fast, memory-light ANN for RAG/embeddings.",
        isolated=True, install_kind="python-venv",
        clone_url="https://github.com/RyanCodrai/turbovec.git",
        pip_pkg="turbovec",
        security="Open-source, prebuilt wheels via pip → low install risk (Rust core ships compiled). No network/secrets at import.",
        post_notes=("activate: `source venv_turbovec/bin/activate`",
                    "framework extras: `pip install 'turbovec[langchain]'` (or llama-index / haystack / agno)"),
        repo="https://github.com/RyanCodrai/turbovec", docs="83-ryancodrai-turbovec.md",
    ),
    # ===== ais_plugins.txt — self-hosted AI apps (isolated docker; enable/disable via compose) =====
    ModelTool(
        id="firecrawl", name="Firecrawl", category="local-app",
        blurb="Open-source web-data engine: turns sites into LLM-ready markdown/JSON at scale (scrape/crawl/search/extract). Self-host the API, or use the pip/npm SDK + MCP server.",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/firecrawl/firecrawl.git",
        live_steps=(("sh", "-lc", "docker compose up -d"),),
        security="AGPL-3.0 (self-host) — note copyleft. ~40k stars, active. DUAL-USE + high-egress: drives headless browsers that execute JS from arbitrary fetched pages (SSRF / malicious-page), can crawl at scale (ToS/PII), and sends page content to LLM providers. Self-host exposes an API (:3002) — keep it firewalled + authed.",
        warnings=("executes JS from arbitrary fetched pages — SSRF / malicious-page surface; isolate egress (block 169.254.169.254)",
                  "crawling at scale has ToS/PII implications — authorized targets only",
                  "set a strong .env (POSTGRES_*, BULL_AUTH_KEY) before exposing; never expose :3002 publicly"),
        post_notes=("configure `.env` in the repo root first (PORT, USE_DB_AUTHENTICATION, secrets) — see 65-firecrawl-firecrawl.md",
                    "SDK alternative (no self-host): `pip install firecrawl-py` / `npm install firecrawl`",
                    "MCP server: `npx -y firecrawl-mcp`"),
        repo="https://github.com/firecrawl/firecrawl", docs="65-firecrawl-firecrawl.md",
    ),
    ModelTool(
        id="onyx", name="Onyx (ex-Danswer)", category="local-app",
        blurb="Self-hostable 'application layer for LLMs': AI chat + enterprise knowledge search over your docs/connectors, with assistants + RAG. Web UI after `docker compose up`.",
        isolated=True, install_kind="docker",
        clone_url="https://github.com/onyx-dot-app/onyx.git",
        live_steps=(("sh", "-lc", "cd deployment/docker_compose && cp -n env.template .env 2>/dev/null || true"),
                    ("sh", "-lc", "cd deployment/docker_compose && docker compose up -d")),
        security="MIT, mature (formerly Danswer). Self-hosted platform that connects to your data sources (Slack/GDrive/Confluence/...) → broad data reach; holds connector credentials. LLM egress to whatever provider you configure (can point at a local Ollama). Keep it firewalled + authed; do not expose publicly without a reverse proxy.",
        warnings=("connects to your data sources + stores their credentials — treat as sensitive infrastructure",
                  "default LLM may be a cloud API — point it at a local Ollama for a $0/private path (`localai show onyx`)",
                  "do not expose the UI publicly without auth + HTTPS reverse proxy"),
        post_notes=("edit `deployment/docker_compose/.env` (set IMAGE_TAG, model provider) before/after first up",
                    "official one-liner alt (guided): `curl -fsSL https://onyx.app/install_onyx.sh | bash` — review first",
                    "stop: `cd deployment/docker_compose && docker compose down`"),
        repo="https://github.com/onyx-dot-app/onyx", docs="66-onyx-dot-app-onyx.md",
    ),
    # ===== ais_plugins.txt — local-model GUI runner =====
    ModelTool(
        id="lm-studio", name="LM Studio", category="local-app",
        guided=True, isolated=False, install_kind="docker",
        blurb="Desktop app to discover, download, and run local LLMs (GGUF/MLX) with a chat UI + an OpenAI-compatible local server (:1234) + the `lms` CLI. The friendly LM runner.",
        install_steps={"macos": [["brew", "install", "--cask", "lm-studio"]],
                       "linux": [["sh", "-lc", "echo 'LM Studio (Linux): download the AppImage from https://lmstudio.ai/download , chmod +x, run it. (No official apt/curl installer.)'"]]},
        security="Desktop GUI app. The app itself is free/closed-source (the `lms` CLI + SDKs are MIT). Models you download run fully locally (no egress) and expose a local OpenAI-compatible server on 127.0.0.1:1234 — do not bind it to 0.0.0.0 on untrusted networks. Downloads model weights (large) from HuggingFace.",
        warnings=("the desktop app is proprietary/closed-source (the CLI/SDK are open) — review the EULA if that matters to you",
                  "keep the local server bound to 127.0.0.1; only expose on a trusted LAN deliberately"),
        post_notes=("after install: open LM Studio, download a model, then 'Start Server' for an OpenAI-compatible endpoint at http://localhost:1234/v1",
                    "CLI: `lms ls` / `lms server start`; point any tool's OpenAI base-URL at it for $0 local inference",
                    "Prometheus default model folder: `models config --show` (set it, then point LM Studio's models dir there)"),
        repo="https://lmstudio.ai", docs="96-lm-studio.md",
    ),
    # >>> APPEND MORE LOCAL-MODEL TOOLS HERE (ollama, vllm, llama.cpp, mlx, lm-studio, ...) <<<
]


def model_tool_registry() -> dict[str, ModelTool]:
    return {t.id: t for t in MODEL_TOOLS}


def _has_nvidia() -> bool:
    return bool(shutil.which("nvidia-smi") or shutil.which("nvcc"))


# ============================================================================
#  SECTION 6C — ISOLATED, VERSIONED ON-DISK WORKSPACE  (for local-model tools)
#  Each isolated tool lands in its OWN tree the user picks. Inside <root>/<tool>/:
#     <tool>/                       live working install (the "main folder")
#     venv_<tool>/                  python virtualenv (python-venv tools)
#     engine_<tool>_version_N/      full immutable snapshot of the engine at vN
#     backups_<tool>/               tarballs of the prior live tree (taken before update)
#     archives_<tool>/              original zipped git package per version (offline history)
#     .prometheus_tool.json         manifest: versions, shas, active version, kind
#  Enables updates that preserve old versions + offline rollback between snapshots.
# ============================================================================
@dataclass
class ToolLayout:
    tool: str
    root: Path                                    # <user-base>/<tool>  (basename == tool)

    @property
    def live(self) -> Path:      return self.root / self.tool
    @property
    def venv(self) -> Path:      return self.root / f"venv_{self.tool}"
    @property
    def backups(self) -> Path:   return self.root / f"backups_{self.tool}"
    @property
    def archives(self) -> Path:  return self.root / f"archives_{self.tool}"
    @property
    def manifest(self) -> Path:  return self.root / ".prometheus_tool.json"

    def engine(self, n: int) -> Path:
        return self.root / f"engine_{self.tool}_version_{n}"

    def ensure(self) -> None:
        for d in (self.root, self.backups, self.archives):
            if DRY_RUN:
                Log.step(f"[dry-run] mkdir -p {d}")
            else:
                d.mkdir(parents=True, exist_ok=True)


def _resolve_tool_root(base: Path, tool: str) -> Path:
    """If the chosen folder is already named <tool>, use it as the root; else nest <tool> inside it."""
    base = Path(os.path.expanduser(str(base)))
    return base if base.name == tool else base / tool


def _layout_preview(tool: str) -> list[str]:
    return [f"<your-folder>/{tool}/",
            f"  ├── {tool}/                      live working install",
            f"  ├── venv_{tool}/                 python virtualenv (if needed)",
            f"  ├── engine_{tool}_version_N/     full snapshot of each version",
            f"  ├── backups_{tool}/              pre-update tarballs (rollback safety)",
            f"  ├── archives_{tool}/             original zipped git package per version",
            f"  └── .prometheus_tool.json        version manifest"]


def _human_size(p: Path) -> str:
    try:
        b: float = p.stat().st_size
    except OSError:
        return "?"
    for u in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.0f}{u}"
        b /= 1024
    return f"{b:.1f}TB"


def _rmtree(p: Path) -> None:
    if DRY_RUN:
        Log.step(f"[dry-run] rm -rf {p}"); return
    shutil.rmtree(p, ignore_errors=True)


def _copytree(src: Path, dst: Path) -> None:
    if DRY_RUN:
        Log.step(f"[dry-run] copy {src} -> {dst}"); return
    shutil.copytree(src, dst, dirs_exist_ok=True, symlinks=True)


def _safe_extract(tf: tarfile.TarFile, dest: Path) -> None:
    """Extract a tar with Zip-Slip protection (cross-Python-version).

    The archived tree comes from a third-party git clone, so a member could carry a
    `..`/absolute path or a symlink whose target escapes the destination. Validate every
    member against the resolved destination root, then extract with `filter='data'` where
    available (Python 3.12+) as defense-in-depth.
    """
    base = dest.resolve()
    for m in tf.getmembers():
        target = (dest / m.name).resolve()
        if target != base and base not in target.parents:
            raise RuntimeError(f"unsafe tar member (path traversal): {m.name!r}")
        if m.issym() or m.islnk():
            link_target = (target.parent / m.linkname).resolve()
            if link_target != base and base not in link_target.parents:
                raise RuntimeError(f"unsafe tar link escaping archive root: {m.name!r} -> {m.linkname!r}")
    try:
        tf.extractall(dest, filter="data")        # Python 3.12+: built-in traversal/symlink guard
    except TypeError:
        tf.extractall(dest)                        # older Python: manual validation above covers it


def _short_sha(repo: Path) -> str:
    try:
        p = _run_timed(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
                           capture_output=True, text=True, timeout=30)
        return p.stdout.strip() or "nosha"
    except Exception:
        return "nosha"


def _run_in(cmd: list[str], cwd: Path, timeout: Optional[int] = None) -> int:
    """Run a command in `cwd` to completion, then RETURN (the shell terminates).

    Bounded by a wall-clock `timeout` (default _RUN_TIMEOUT) so a foreground-blocking or
    stuck step (e.g. a server started without a detach flag) can never hang the install —
    on expiry the child is killed and we return rc 124. Long-running services use
    `_run_detached` (ModelTool.serve_steps) instead.
    """
    printable = " ".join(cmd)
    if DRY_RUN:
        Log.step(f"[dry-run] (cd {cwd}) {printable}"); return 0
    Log.debug(f"$ (cd {cwd}) {printable}")
    try:
        return subprocess.run(cmd, cwd=str(cwd),
                              timeout=timeout if timeout is not None else _RUN_TIMEOUT).returncode
    except FileNotFoundError:
        Log.err(f"command not found: {cmd[0]}"); return 127
    except subprocess.TimeoutExpired as e:
        Log.err(f"command timed out after {e.timeout:.0f}s (killed): {printable}"); return 124


def _run_detached(cmd: list[str], cwd: Path, log_path: Path) -> int:
    """Start a long-running SERVICE and LET IT RUN — don't block, don't terminate it.

    For ModelTool.serve_steps (a foreground server that must keep running). The process is
    detached into its OWN session (`start_new_session=True`) so it survives Prometheus
    exiting; stdin is closed and stdout/stderr tee to `log_path`. Returns 0 once launched
    (we never wait on it). This is the "unless it is necessary to let it run" exception to
    the terminate-the-shell default.
    """
    printable = " ".join(cmd)
    if DRY_RUN:
        Log.step(f"[dry-run] (cd {cwd}) {printable}   [detached → {log_path.name}, let it run]"); return 0
    Log.debug(f"$ (cd {cwd}) {printable}   [detached]")
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        logf = open(log_path, "ab")                       # child keeps the handle; intentionally not closed here
        subprocess.Popen(cmd, cwd=str(cwd), stdout=logf, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True)
        Log.ok(f"started in background (let it run): {printable}")
        Log.step(f"logs: {log_path}  ·  stop it via the tool's own control (e.g. `models disable <id>` for docker apps)")
        return 0
    except FileNotFoundError:
        Log.err(f"command not found: {cmd[0]}"); return 127
    except OSError as e:
        Log.err(f"could not start: {printable} ({e})"); return 1


def _read_tool_manifest(lay: ToolLayout) -> dict:
    return _read_json(lay.manifest)


def _write_tool_manifest(lay: ToolLayout, data: dict) -> None:
    if DRY_RUN:
        Log.step(f"[dry-run] write manifest {lay.manifest.name}"); return
    lay.manifest.write_text(json.dumps(data, indent=2))


def _next_version(lay: ToolLayout) -> int:
    man = _read_tool_manifest(lay)
    if man.get("versions"):
        return max(int(v["n"]) for v in man["versions"]) + 1
    ns: list[int] = []
    if lay.root.exists():
        for p in lay.root.glob(f"engine_{lay.tool}_version_*"):
            m = re.search(r"_version_(\d+)$", p.name)
            if m:
                ns.append(int(m.group(1)))
    return (max(ns) + 1) if ns else 1


def _archive_clone(src: Path, lay: ToolLayout, n: int, sha: str) -> Path:
    out = lay.archives / f"{lay.tool}-v{n}-{sha}.tar.gz"
    if DRY_RUN:
        Log.step(f"[dry-run] archive {src} -> {out}"); return out
    with tarfile.open(out, "w:gz") as tf:
        tf.add(src, arcname=f"{lay.tool}-v{n}")
    Log.ok(f"archived pristine package → archives_{lay.tool}/{out.name} ({_human_size(out)})")
    return out


def _backup_live(lay: ToolLayout, prev_n) -> Optional[Path]:
    if not lay.live.exists():
        return None
    ts = time.strftime("%Y%m%d-%H%M%S")
    out = lay.backups / f"{lay.tool}-v{prev_n}-{ts}.tar.gz"
    if DRY_RUN:
        Log.step(f"[dry-run] backup live {lay.live} -> {out}"); return out
    with tarfile.open(out, "w:gz") as tf:
        tf.add(lay.live, arcname=f"{lay.tool}-v{prev_n}")
    Log.ok(f"backed up current install → backups_{lay.tool}/{out.name} ({_human_size(out)})")
    return out


def _make_venv(lay: ToolLayout) -> None:
    if lay.venv.exists():
        Log.ok(f"venv exists: venv_{lay.tool}/"); return
    Log.step(f"create virtualenv → venv_{lay.tool}/")
    run([sys.executable, "-m", "venv", str(lay.venv)], check=False)


def _venv_pip(lay: ToolLayout) -> str:
    sub = "Scripts" if os.name == "nt" else "bin"
    return str(lay.venv / sub / "pip")


def _venv_python(lay: ToolLayout) -> str:
    sub = "Scripts" if os.name == "nt" else "bin"
    return str(lay.venv / sub / "python")


def _venv_pkg_version(lay: ToolLayout, pkg: str) -> str:
    if DRY_RUN or not lay.venv.exists():
        return ""
    try:
        p = _run_timed([_venv_python(lay), "-m", "pip", "show", pkg],
                           capture_output=True, text=True, timeout=30)
        for line in p.stdout.splitlines():
            if line.startswith("Version:"):
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return ""


def _print_layout_map(lay: ToolLayout, n: int, kind: str) -> None:
    Log.head(f"Install map — {lay.tool} landed here (isolated, version {n})")
    rows = [
        ("root",        lay.root),
        ("live install", lay.live),
        (f"engine snapshot v{n}", lay.engine(n)),
        ("backups",     lay.backups),
        ("archives",    lay.archives),
    ]
    if kind == "python-venv":
        rows.insert(2, ("virtualenv", lay.venv))
    for label, path in rows:
        exists = "✓" if (DRY_RUN or path.exists()) else "·"
        print(f"  {exists} {label:<22} {path}")
    Log.step(f"manifest: {lay.manifest}")
    Log.step(f"versions: `models versions {lay.tool} --path {lay.root}`   ·   "
             f"rollback: `models rollback {lay.tool} --version <N> --path {lay.root}`")


def _prompt_install_path(tool: str) -> Optional[Path]:
    """Pick a base folder: paste a path or browse by number. Returns the chosen base (root is resolved after)."""
    # NON-INTERACTIVE FIRST, before a single line of the chooser is printed.
    #
    # This check sat AFTER the whole browser UI, so a piped/CI run printed a folder picker nobody
    # could answer, then returned None — and every caller reads None as "the user cancelled" and
    # returns 0. `apps versions yt-dlp` therefore exited 0 with ok:true having done nothing, and
    # the hint named `models install` no matter which verb the user had actually run.
    #
    # Raising (rather than returning None) fixes all NINE call sites at once: `main()` already
    # turns a RuntimeError into a clean message and exit 2, and under --json into a proper
    # envelope. A caller cannot mistake it for a cancellation.
    if not sys.stdin.isatty():
        raise RuntimeError(
            f"cannot choose an install folder for '{tool}': no interactive terminal. "
            "Pass one explicitly with `--path /your/folder`."
        )
    Log.head(f"Choose where to install {tool} (separated space on disk)")
    Log.info("This tool lands in its OWN versioned tree. Planned layout:")
    for line in _layout_preview(tool):
        print("    " + Log._c(line, "dim"))
    Log.info("If the folder you pick is already named "
             f"'{tool}', it becomes the root; otherwise '{tool}/' is created inside it.")
    print("    Controls:  [number] enter subfolder · .. up · ~ home · "
          "/abs/path or name jump · '.' SELECT current dir · q cancel")
    cur = Path.cwd()
    while True:
        try:
            subs = sorted(p for p in cur.iterdir() if p.is_dir() and not p.name.startswith("."))
        except (PermissionError, OSError):
            subs = []
        print(f"\n  now: {Log._c(str(cur), 'cyan')}")
        for i, p in enumerate(subs[:40], 1):
            print(f"    {i:>2}) {p.name}/")
        if len(subs) > 40:
            print(f"    … (+{len(subs) - 40} more — type a name or path)")
        raw = input(f"  {tool} path> ").strip()
        if raw in ("q", "Q", ""):
            return None
        if raw == ".":
            return cur
        if raw == "..":
            cur = cur.parent; continue
        if raw == "~":
            cur = HOME; continue
        if raw.isdigit():
            idx = int(raw) - 1
            if 0 <= idx < len(subs):
                cur = subs[idx]; continue
            Log.warn("out of range"); continue
        cand = Path(os.path.expanduser(raw))
        if raw.startswith(("~", "/")) or cand.is_absolute():
            if cand.exists() and cand.is_dir():
                cur = cand; continue
            return cand                                  # not-yet-existing absolute path = creation target
        nxt = cur / raw
        if nxt.exists() and nxt.is_dir():
            cur = nxt; continue
        return nxt                                       # new relative name under cur = creation target


def _npm_pkg_meta(pkg_dir: Path) -> str:
    """'name@version' from a package.json (best-effort, '' on failure)."""
    try:
        d = json.loads((pkg_dir / "package.json").read_text())
        return f"{d.get('name', pkg_dir.name)}@{d.get('version', '?')}"
    except (OSError, json.JSONDecodeError):
        return ""


def _npm_build_install(t: "RepoTool", lay: "ToolLayout") -> str:
    """Build + install every npm sub-tool from the GATED clone (lay.live) into the
    tool's OWN npm prefix — bins land in <root>/npm_prefix/bin, nothing global is
    touched. Returns a 'name@ver, …' summary. Isolated + uninstall = delete the root."""
    npm = shutil.which("npm")
    if not npm:
        Log.err("npm not found — install Node.js first (brew install node / apt install nodejs npm)")
        return ""
    prefix = lay.root / "npm_prefix"
    if not DRY_RUN:
        if prefix.exists():
            _rmtree(prefix)
        prefix.mkdir(parents=True, exist_ok=True)
    subdirs = t.npm_subdirs or (".",)
    installed: list[str] = []
    for sub in subdirs:
        d = lay.live / sub
        if not d.exists():
            Log.warn(f"npm sub-tool not found in clone: {sub}")
            continue
        Log.step(f"npm install + build: {sub}")
        # --ignore-scripts: transitive deps' pre/post/install lifecycle hooks are
        # arbitrary, NETWORK-fetched code that the nemesis gate never saw — running them
        # would defeat the fail-closed gate. The tool's OWN build runs explicitly below.
        Log.warn("npm lifecycle scripts DISABLED (--ignore-scripts) — ungated dep hooks are not run")
        _run_in([npm, "install", "--ignore-scripts"], d)
        _run_in([npm, "run", "build"], d)                  # the tool's OWN build (was gated in the clone)
        # install the built package into the isolated prefix (bin → prefix/bin)
        _run_in([npm, "install", "-g", "--ignore-scripts", "--prefix", str(prefix), str(d)], lay.live)
        meta = _npm_pkg_meta(d)
        if meta:
            installed.append(meta)
    binp = prefix / "bin"
    for cli in t.npm_clis:
        Log.step(f"CLI available: {binp / cli}")
    if t.npm_clis and not DRY_RUN:
        Log.step(f"add to PATH: export PATH=\"{binp}:$PATH\"   (or run via the full path above)")
    summary = ", ".join(installed)
    if summary:
        Log.ok(f"npm tools installed in npm_prefix/: {summary}")
    return summary


def _serve_tree_gate_ok(t: "ModelTool", lay: "ToolLayout") -> bool:
    """CLI-077: deep-gate the on-disk live tree before launching a long-running server. Returns
    False (⇒ do not launch, keep the install on disk) when the nemesis gate BLOCKs the actual bytes
    about to run — an install-time gate can't catch a rug-pull where live/ changed after install.
    Reuses the same ScanReport / security_gate / NO_SCAN path as install (fail-closed)."""
    if NO_SCAN:
        return True
    tree_rep = ScanReport(t.id, "serve_tree", _git_identity(lay.live),
                          _walk_and_scan(lay.live),
                          sum(1 for _ in lay.live.rglob("*") if _.is_file()))
    return security_gate(tree_rep, "local")


def _install_into_layout(t: ModelTool, osi: OSInfo, base: Path) -> int:
    """Clone + set up an isolated tool into a versioned on-disk workspace under <base>/<tool>/."""
    root = _resolve_tool_root(base, t.id)
    lay = ToolLayout(t.id, root)
    Log.head(f"Isolated install: {t.name}  →  {root}")
    for line in _layout_preview(t.id):
        print("    " + Log._c(line, "dim"))
    if not _confirm(f"Create the {t.name} workspace at {root} ?"):
        Log.warn("declined"); return 0
    lay.ensure()

    man = _read_tool_manifest(lay)
    prev = man.get("current_version")
    n = _next_version(lay)
    if prev:
        Log.info(f"existing install at v{prev} → updating to v{n} (old version preserved)")
        _backup_live(lay, prev)

    if not t.clone_url:
        Log.err("isolated install needs a clone_url"); return 2
    git = shutil.which("git")
    if not git:
        Log.err("git not found"); return 2

    stage = root / f".stage_v{n}"
    if stage.exists():
        _rmtree(stage)
    if DRY_RUN:
        Log.step(f"[dry-run] git clone {t.clone_url} -> {stage}")
        sha = "dryrun"
    else:
        Log.step(f"git clone {t.clone_url} -> .stage_v{n}")
        run([git, "clone", t.clone_url, str(stage)])
        sha = _short_sha(stage)

    if stage.exists() and not DRY_RUN:
        if not NO_SCAN:
            Log.step("security scan of the cloned app")
            rep = ScanReport(t.id, t.clone_url, _git_identity(stage), _walk_and_scan(stage), 0)
            if not security_gate(rep, "local"):
                Log.warn(f"{t.name} aborted by security gate — removing staged clone")
                _rmtree(stage); return 1
        if not enforce_gate(str(stage), f"{t.name} ({t.clone_url})"):  # deep nemesis gate
            Log.warn(f"{t.name} aborted by nemesis gate — removing staged clone")
            _rmtree(stage); return 1

    _archive_clone(stage, lay, n, sha)                    # offline version history (pristine clone)

    if lay.live.exists():                                 # promote stage -> live
        _rmtree(lay.live)
    if DRY_RUN:
        Log.step(f"[dry-run] move .stage_v{n} -> {t.id}/  (live)")
    else:
        shutil.move(str(stage), str(lay.live))

    if not lay.engine(n).exists():                        # immutable engine snapshot
        Log.step(f"snapshot engine → engine_{t.id}_version_{n}/")
        _copytree(lay.live, lay.engine(n))

    pip_version = ""
    npm_version = ""
    if t.install_kind == "npm":                           # isolated npm prefix (build from gated clone)
        npm_version = _npm_build_install(t, lay)  # type: ignore[arg-type]
    if t.install_kind == "python-venv":                   # isolated python env
        _make_venv(lay)
        pip = _venv_pip(lay)
        pkg = t.pip_pkg or t.id
        if t.requirements:
            run([pip, "install", "-r", str(lay.live / t.requirements)], check=False)
        else:
            wheels = lay.archives / f"wheels-v{n}"         # cache wheels → offline reinstall/rollback
            if not DRY_RUN:
                wheels.mkdir(parents=True, exist_ok=True)
            run([pip, "download", "--no-deps", pkg, "-d", str(wheels)], check=False)
            run([pip, "install", "--find-links", str(wheels), pkg], check=False)
        for extra in t.pip_extras:                         # optional extras (e.g. bitsandbytes)
            run([pip, "install", "-U", extra], check=False)
        pip_version = _venv_pkg_version(lay, pkg)
        if pip_version:
            Log.ok(f"{pkg} {pip_version} installed in venv_{t.id}/")

    steps = list(t.live_steps)
    if steps and not NO_SCAN:                              # scan the literal commands too
        text = "\n".join(" ".join(c) for c in steps)
        rep = ScanReport(t.id, "live_steps", "steps:" + str(abs(hash(text)))[:8],
                         _scan_text("<model_tool>", text), 1)
        if not security_gate(rep, "local"):
            Log.warn(f"{t.name} run-steps blocked by security gate (install kept on disk)"); return 1
    for cmd in steps:
        _run_in(list(cmd), lay.live)                      # run-and-return (terminates); won't hang (timeout-bounded)

    serve = list(t.serve_steps)                           # long-running servers: scan, then LET THEM RUN (detached)
    if serve and not NO_SCAN:
        text = "\n".join(" ".join(c) for c in serve)
        rep = ScanReport(t.id, "serve_steps", "serve:" + str(abs(hash(text)))[:8],
                         _scan_text("<model_tool>", text), 1)
        if not security_gate(rep, "local"):
            Log.warn(f"{t.name} serve-steps blocked by security gate (install kept on disk)"); return 1
        # CLI-077: DEEP-gate the on-disk live tree BEFORE launching the long-running server (a
        # rug-pull where live/ changed after install can't slip past the install-time gate).
        # BLOCK ⇒ do not launch, keep the install on disk, exit 1.
        if not _serve_tree_gate_ok(t, lay):
            Log.warn(f"{t.name} live tree blocked by security gate at serve time (install kept on disk)"); return 1
    for cmd in serve:
        _run_detached(list(cmd), lay.live, lay.root / f"{t.id}-serve.log")

    versions = man.get("versions", [])
    versions = [v for v in versions if int(v["n"]) != n]
    entry = {"n": n, "sha": sha, "date": time.strftime("%Y-%m-%dT%H:%M:%S"),
             "archive": f"archives_{t.id}/{t.id}-v{n}-{sha}.tar.gz",
             "engine": lay.engine(n).name}
    if pip_version:
        entry["pip_version"] = pip_version
    if npm_version:
        entry["npm_version"] = npm_version
    versions.append(entry)
    _write_tool_manifest(lay, {"tool": t.id, "kind": t.install_kind, "repo": t.repo,
                               "current_version": n, "active_engine": lay.engine(n).name,
                               "versions": sorted(versions, key=lambda v: int(v["n"]))})

    Log.ok(f"{t.name} v{n} installed in its own space")
    for note in t.post_notes:
        Log.step(note)
    _print_layout_map(lay, n, t.install_kind)
    return 0


def _tool_versions(t: ModelTool, base: Path) -> int:
    lay = ToolLayout(t.id, _resolve_tool_root(base, t.id))
    man = _read_tool_manifest(lay)
    if not man.get("versions"):
        Log.warn(f"no isolated install of {t.name} under {lay.root} (look for .prometheus_tool.json)")
        return 1
    Log.head(f"{t.name} — local version history  ({lay.root})")
    cur = man.get("current_version")
    for v in man["versions"]:
        n = int(v["n"])
        mark = Log._c("● active", "green") if n == cur else Log._c("  stored", "dim")
        arc = lay.root / v.get("archive", "")
        eng = lay.engine(n)
        flags = []
        flags.append("engine✓" if eng.exists() else "engine✗")
        flags.append(f"zip✓ {_human_size(arc)}" if arc.exists() else "zip✗")
        if t.install_kind == "python-venv":
            flags.append("wheel✓(offline)" if (lay.archives / f"wheels-v{n}").exists() else "wheel✗")
        pv = f" {t.pip_pkg or t.id} {v['pip_version']}" if v.get("pip_version") else ""
        print(f"  v{n:<3} {mark}  {v.get('date',''):<20} {v.get('sha',''):<10}{pv:<18} {' · '.join(flags)}")
    Log.step(f"rollback: `models rollback {t.id} --version <N> --path {lay.root}`")
    return 0


def _rollback_tool(t: ModelTool, base: Path, version: Optional[int]) -> int:
    lay = ToolLayout(t.id, _resolve_tool_root(base, t.id))
    man = _read_tool_manifest(lay)
    if not man.get("versions"):
        Log.err(f"no version history for {t.name} under {lay.root}"); return 2
    if t.install_kind == "kernel":                          # FlashAttention: wheel reinstall into target env
        target = version if version is not None else man.get("current_version")
        return _fa_rollback(t, lay, man, target)
    known = {int(v["n"]): v for v in man["versions"]}
    if version is not None:
        target = version
    else:
        others = [n for n in known if n != man.get("current_version")]
        if not others:
            Log.err(f"only v{man.get('current_version')} exists — nothing earlier to roll back to. "
                    f"Pass --version <N> to re-restore a specific version (have: {sorted(known)})."); return 2
        target = max(others)
    if target not in known:
        Log.err(f"version {target} not found. Have: {sorted(known)}"); return 2
    if target == man.get("current_version"):
        Log.warn(f"v{target} already active"); return 0
    eng = lay.engine(target)
    arc = lay.root / known[target].get("archive", "")
    if not eng.exists() and not arc.exists():
        Log.err(f"v{target}: neither engine snapshot nor zip archive present — cannot restore"); return 2

    Log.head(f"Rollback {t.name}: v{man.get('current_version')} → v{target}")
    Log.warn("the current live install will be replaced (a backup is taken first)")
    if not _confirm(f"Roll {t.name} back to v{target} ?"):
        Log.warn("declined"); return 0

    # a stored snapshot/archive predating the gate (or tampered at rest) would
    # otherwise reach live + venv reinstall unvetted — mirror the vault re-gate
    if not DRY_RUN:
        src_to_vet = str(eng) if eng.exists() else str(arc)
        if not enforce_gate(src_to_vet, f"{t.id} (rollback v{target})"):
            Log.err("rollback blocked by nemesis gate — nothing was changed")
            return 1

    _backup_live(lay, man.get("current_version"))
    if lay.live.exists():
        _rmtree(lay.live)
    if eng.exists():
        Log.step(f"restore engine snapshot engine_{t.id}_version_{target}/ → live")
        _copytree(eng, lay.live)
    else:
        Log.step(f"extract zip archive {arc.name} → live")
        if not DRY_RUN:
            with tarfile.open(arc, "r:gz") as tf:
                tmp = lay.root / f".restore_v{target}"
                _rmtree(tmp)
                _safe_extract(tf, tmp)
                roots = [p for p in tmp.iterdir()]
                if len(roots) != 1 or not roots[0].is_dir():
                    _rmtree(tmp)
                    Log.err(f"archive {arc.name} has an unexpected layout (expected one top-level dir) — refusing"); return 2
                shutil.move(str(roots[0]), str(lay.live))
                _rmtree(tmp)

    if t.install_kind == "npm":                            # rebuild + reinstall the restored clone
        _npm_build_install(t, lay)  # type: ignore[arg-type]
    if t.install_kind == "python-venv":                    # reinstall the target version into the venv
        pkg = t.pip_pkg or t.id
        if not lay.venv.exists():
            _make_venv(lay)
        pip = _venv_pip(lay)
        wheels = lay.archives / f"wheels-v{target}"
        if wheels.exists():                                # offline: use the cached wheel (network-down OK)
            Log.step(f"reinstall {pkg} from cached wheels-v{target}/ (offline)")
            run([pip, "install", "--force-reinstall", "--no-deps", "--no-index",
                 "--find-links", str(wheels), pkg], check=False)
        else:                                              # no cache → fetch from PyPI
            tgt = known[target].get("pip_version")
            spec = f"{pkg}=={tgt}" if tgt else pkg
            Log.step(f"reinstall {spec} from PyPI (no local wheel cache for v{target})")
            run([pip, "install", "--force-reinstall", "--no-deps", spec], check=False)

    for cmd in t.live_steps:                               # re-arm the service for the restored version
        _run_in(list(cmd), lay.live)
    man["current_version"] = target
    man["active_engine"] = lay.engine(target).name
    _write_tool_manifest(lay, man)
    Log.ok(f"{t.name} now running v{target}")
    _print_layout_map(lay, target, t.install_kind)
    return 0


# ----------------------------------------------------------------------------
#  FlashAttention — multi-method, env-targeted kernel installer
#  FA is a GPU kernel compiled INTO another engine's Python env (must match that
#  env's torch+CUDA). 7 install paths; the prebuilt-wheel path is cached per
#  version under archives_/wheels-v<ver>/ for offline reinstall + rollback.
# ----------------------------------------------------------------------------
FA_REPO_URL = "https://github.com/Dao-AILab/flash-attention"
FA_CLONE_URL = "https://github.com/Dao-AILab/flash-attention.git"
FA_DEFAULT_VERSION = "2.8.3"          # latest stable FA2 line (2026-06-05); override with --fa-version

# id -> (label, blurb, needs)   needs: nvidia | nvidia-build | amd | any
FA_METHODS: list[tuple[str, str, str, str]] = [
    ("wheel",   "Prebuilt wheel (GitHub release)",
     "FASTEST + recommended. Auto-matches the target env's torch/CUDA/python/abi, downloads the official "
     "prebuilt .whl, no compile. Cached for offline reinstall. NVIDIA + Linux.", "nvidia"),
    ("pypi",    "Build from PyPI source",
     "`pip install flash-attn --no-build-isolation` (installs ninja first; MAX_JOBS to cap RAM). Compiles "
     "CUDA: ~3–5 min with ninja. NVIDIA + Linux + a CUDA toolkit matching torch.", "nvidia-build"),
    ("source",  "Build from a git clone",
     "`git clone --recursive` (cutlass submodule) then `pip install . --no-build-isolation`. Pin a commit; "
     "FLASH_ATTENTION_FORCE_BUILD. NVIDIA + Linux.", "nvidia-build"),
    ("hopper",  "FlashAttention-3 (Hopper / H100)",
     "Build the hopper/ subdir (`cd hopper && python setup.py install`). CUDA ≥12.3; H100/H800; adds FP8 "
     "forward. NVIDIA Hopper only.", "nvidia-build"),
    ("fa4",     "FlashAttention-4 (CuTeDSL)",
     "`pip install flash-attn-4` (or `flash-attn-4[cu13]`). Hopper + Blackwell; pure-python wheel, no local "
     "CUDA build.", "nvidia"),
    ("kernels", "HuggingFace kernels (runtime fetch)",
     "`pip install kernels`; transformers/your engine fetches the compiled kernel at runtime via "
     "get_kernel('kernels-community/flash-attn2'). No local build; works with attn_implementation='flash_attention_2'.", "any"),
    ("rocm",    "AMD ROCm (Triton backend)",
     "`FLASH_ATTENTION_TRITON_AMD_ENABLE=TRUE pip install --no-build-isolation .` from a clone. AMD "
     "MI200/MI250/MI300, RDNA 3/4. Needs ROCm 6.0+.", "amd"),
]
_FA_META = {m[0]: m for m in FA_METHODS}


def _download(url: str, dest: Path) -> bool:
    if DRY_RUN:
        Log.step(f"[dry-run] download {url} -> {dest}"); return True
    try:
        Log.step(f"download {url}")
        urllib.request.urlretrieve(url, str(dest))
        Log.ok(f"got {dest.name} ({_human_size(dest)})")
        # Gate the downloaded artifact (archive/binary) before it is used (fail-closed).
        if not enforce_gate(str(dest), f"download {dest.name}"):
            dest.unlink(missing_ok=True)
            return False
        return True
    except Exception as e:
        Log.err(f"download failed: {e}")
        if dest.exists():
            dest.unlink(missing_ok=True)
        return False


def _run_env(cmd: list[str], env: dict, cwd: Optional[Path] = None) -> int:
    printable = " ".join(cmd)
    extra = " ".join(f"{k}={v}" for k, v in env.items() if k in ("MAX_JOBS", "FLASH_ATTENTION_TRITON_AMD_ENABLE",
                                                                 "FLASH_ATTENTION_FORCE_BUILD", "NVCC_THREADS"))
    if DRY_RUN:
        Log.step(f"[dry-run] {extra + ' ' if extra else ''}{printable}{f'  (cd {cwd})' if cwd else ''}"); return 0
    Log.debug(f"$ {extra} {printable}")
    full = os.environ.copy(); full.update(env)
    try:
        return _run_timed(cmd, env=full, cwd=str(cwd) if cwd else None, timeout=_RUN_TIMEOUT).returncode
    except FileNotFoundError:
        Log.err(f"command not found: {cmd[0]}"); return 127


def _fa_env_tags(py_exe: str) -> Optional[dict]:
    """Detect a target python's torch/cuda/abi/python tags for the prebuilt-wheel filename."""
    code = ("import torch,sys\n"
            "print(torch.__version__)\n"
            "print(getattr(torch.version,'cuda',None))\n"
            "print(int(torch._C._GLIBCXX_USE_CXX11_ABI))\n"
            "print('cp%d%d'%(sys.version_info.major,sys.version_info.minor))\n")
    try:
        p = _run_timed([py_exe, "-c", code], capture_output=True, text=True, timeout=60)
    except Exception:
        return None
    if p.returncode != 0:
        return None
    out = p.stdout.strip().splitlines()
    if len(out) < 4:
        return None
    torch_full, cuda, abi, py = out[0], out[1], out[2], out[3]
    mm = re.match(r"(\d+)\.(\d+)", torch_full)
    return {"torch_full": torch_full,
            "torch_tag": (f"torch{mm.group(1)}.{mm.group(2)}" if mm else None),
            "cu": (f"cu{cuda.split('.')[0]}" if cuda and cuda != "None" else None),
            "abi": ("TRUE" if abi == "1" else "FALSE"),
            "py": py, "platform": "linux_x86_64"}


def _fa_wheel_name(ver: str, tags: dict) -> str:
    return (f"flash_attn-{ver}+{tags['cu']}{tags['torch_tag']}"
            f"cxx11abi{tags['abi']}-{tags['py']}-{tags['py']}-{tags['platform']}.whl")


def _fa_wheel_url(ver: str, name: str) -> str:
    return f"{FA_REPO_URL}/releases/download/v{ver}/{name}"


def _fa_pick_method() -> Optional[str]:
    Log.head("FlashAttention — choose an install method")
    for i, (mid, label, blurb, needs) in enumerate(FA_METHODS, 1):
        gate = {"nvidia": "NVIDIA", "nvidia-build": "NVIDIA+build", "amd": "AMD/ROCm", "any": "any GPU"}[needs]
        print(f"  {i}) {Log._c(mid, 'bold'):<12} {label}   {Log._c('[' + gate + ']', 'dim')}")
        print(f"       {blurb}")
    if not sys.stdin.isatty():
        Log.err("non-interactive — pass --method <id> (e.g. --method wheel)"); return None
    raw = input("  method # or id (blank=cancel): ").strip().lower()
    if not raw:
        return None
    if raw.isdigit() and 1 <= int(raw) <= len(FA_METHODS):
        return FA_METHODS[int(raw) - 1][0]
    return raw if raw in _FA_META else None


def _fa_target(target_python: Optional[str], lay: ToolLayout) -> Optional[dict]:
    """Resolve the env FA installs INTO. --target-python = an existing engine env; else a fresh isolated venv."""
    if target_python:
        py = Path(os.path.expanduser(target_python))
        if not py.exists():
            Log.err(f"target python not found: {py}"); return None
        sub = py.parent
        pip = str(sub / ("pip.exe" if os.name == "nt" else "pip"))
        return {"py": str(py), "pip": pip, "label": str(py), "isolated": False}
    Log.warn("no --target-python given → creating a FRESH isolated venv (venv_flashattention).")
    Log.step("NOTE: FlashAttention needs a matching torch in that env. For a real engine, prefer "
             "`--target-python /path/to/engine/venv/bin/python`.")
    _make_venv(lay)
    return {"py": _venv_python(lay), "pip": _venv_pip(lay), "label": f"venv_{lay.tool}/", "isolated": True}


def _fa_record(lay: ToolLayout, method: str, ver: str, target_py: str, wheel: Optional[str]) -> None:
    man = _read_tool_manifest(lay)
    versions = [v for v in man.get("versions", []) if v.get("ver") != ver or v.get("method") != method]
    versions.append({"n": len(versions) + 1, "ver": ver, "method": method, "target": target_py,
                     "wheel": wheel, "date": time.strftime("%Y-%m-%dT%H:%M:%S")})
    _write_tool_manifest(lay, {"tool": lay.tool, "kind": "kernel", "repo": FA_REPO_URL,
                               "current_version": ver, "current_method": method, "target": target_py,
                               "versions": versions})


def _install_flashattention(t: ModelTool, osi: OSInfo, path: Optional[str] = None, method: Optional[str] = None,
                            target_python: Optional[str] = None, max_jobs: Optional[int] = None,
                            cuda: Optional[str] = None, fa_version: Optional[str] = None) -> int:
    Log.info("FlashAttention is a GPU kernel EMBEDDED into an engine's Python env (it must match that env's torch+CUDA).")
    if not method:
        method = _fa_pick_method()
        if not method:
            Log.warn("cancelled — no method chosen"); return 0
    if method not in _FA_META:
        Log.err(f"unknown method '{method}'. Choices: {', '.join(m for m, *_ in FA_METHODS)}"); return 2
    _, label, blurb, needs = _FA_META[method]
    Log.head(f"FlashAttention · method = {method} ({label})")
    print(f"  {blurb}")

    # --- method-aware prerequisite gating -----------------------------------
    if needs in ("nvidia", "nvidia-build") and not _has_nvidia():
        Log.warn("no NVIDIA GPU / CUDA detected on THIS machine.")
        if method == "wheel":
            if not _confirm("Still download the prebuilt wheel (e.g. to stage it for a separate GPU box)?"):
                Log.step("on Apple Silicon / CPU: use AirLLM (`models install airllm`) or MLX / llama.cpp."); return 2
        else:
            Log.err(f"method '{method}' builds/runs CUDA — needs an NVIDIA GPU here. "
                    "Use --method wheel to stage a wheel, or AirLLM/MLX on Mac/CPU."); return 2
    if needs == "nvidia-build" and not shutil.which("nvcc"):
        Log.warn("nvcc not on PATH — a source/Hopper build needs a CUDA toolkit matching your torch.")
    if needs == "amd" and not (shutil.which("rocminfo") or shutil.which("hipcc")):
        Log.warn("ROCm not detected (rocminfo/hipcc missing) — the AMD build will likely fail without ROCm 6.0+.")
    Log.step(f"security: {t.security}")

    # --- cache/workspace + target env ---------------------------------------
    root = _resolve_tool_root(Path(os.path.expanduser(path)), t.id) if path else (PROM_DIR / "flashattention")
    lay = ToolLayout(t.id, root)
    lay.ensure()
    tgt = _fa_target(target_python, lay)
    if tgt is None:
        return 2
    py, pip = tgt["py"], tgt["pip"]
    Log.step(f"target env: {tgt['label']}  ({py})")
    if not _confirm(f"Install FlashAttention via '{method}' into {tgt['label']} ?"):
        Log.warn("declined"); return 0

    # --- per-method execution -----------------------------------------------
    ver = fa_version or FA_DEFAULT_VERSION
    if method == "wheel":
        tags = _fa_env_tags(py)
        if cuda and tags:
            tags["cu"] = f"cu{cuda}"
        if not tags or not tags.get("torch_tag") or not tags.get("cu"):
            Log.err("could not detect torch+CUDA in the target env. Point --target-python at an env that has "
                    "torch installed (or build with --method pypi)."); return 2
        name = _fa_wheel_name(ver, tags)
        url = _fa_wheel_url(ver, name)
        Log.step(f"matched wheel: {name}")
        wheels = lay.archives / f"wheels-v{ver}"
        if not DRY_RUN:
            wheels.mkdir(parents=True, exist_ok=True)
        dest = wheels / name
        if dest.exists():
            Log.ok("wheel already cached (offline) — skipping download")
            # cached wheel may predate the gate or have been tampered with at
            # rest — re-vet before pip touches it (verdict cache → free if clean)
            if not DRY_RUN and not enforce_gate(str(dest), f"{t.id} cached wheel {name}"):
                Log.err("cached wheel blocked by nemesis gate"); return 1
        elif not _download(url, dest):
            Log.err("could not fetch that wheel. Check the torch/CUDA/python tags, try another --fa-version, "
                    "or build from source (--method pypi)."); return 1
        run([pip, "install", "--force-reinstall", "--no-deps", str(dest)], check=False)
        _fa_record(lay, "wheel", ver, py, name)

    elif method == "pypi":
        run([pip, "install", "ninja"], check=False)
        env = {}
        if max_jobs:
            env["MAX_JOBS"] = str(max_jobs)
        cmd = [pip, "install", "flash-attn", "--no-build-isolation"]
        if not NO_SCAN:
            rep = ScanReport(t.id, "pypi", "fa-pypi", _scan_text("<flashattention>", " ".join(cmd)), 1)
            if not security_gate(rep, "local"):
                Log.warn("blocked by security gate"); return 1
        _run_env(cmd, env)
        _fa_record(lay, "pypi", "latest", py, None)

    elif method == "fa4":
        pkg = "flash-attn-4[cu13]" if cuda == "13" else "flash-attn-4"
        run([pip, "install", pkg], check=False)
        _fa_record(lay, "fa4", "4.x", py, None)

    elif method == "kernels":
        run([pip, "install", "kernels"], check=False)
        Log.ok("kernels installed — FlashAttention is fetched at RUNTIME (no local build).")
        Log.step("use it: from kernels import get_kernel; fa = get_kernel('kernels-community/flash-attn2')")
        Log.step("or transparently: model = AutoModel.from_pretrained(..., attn_implementation='flash_attention_2')")
        _fa_record(lay, "kernels", "runtime", py, None)

    elif method in ("source", "hopper", "rocm"):
        git = shutil.which("git")
        if not git:
            Log.err("git not found"); return 2
        if lay.live.exists():
            Log.ok(f"clone present at {lay.live} — reusing")
        elif DRY_RUN:
            Log.step(f"[dry-run] git clone --recursive {FA_CLONE_URL} -> {lay.live}")
        else:
            Log.step(f"git clone --recursive {FA_CLONE_URL} -> {t.id}/ (cutlass submodule)")
            run([git, "clone", "--recursive", FA_CLONE_URL, str(lay.live)])
        if lay.live.exists() and not DRY_RUN:
            if not NO_SCAN:
                rep = ScanReport(t.id, FA_CLONE_URL, _git_identity(lay.live), _walk_and_scan(lay.live), 0)
                if not security_gate(rep, "local"):
                    Log.warn("aborted by security gate"); return 1
            if not enforce_gate(str(lay.live), f"{t.id} ({FA_CLONE_URL})"):
                Log.warn("aborted by nemesis gate"); return 1
        env = {}
        if max_jobs:
            env["MAX_JOBS"] = str(max_jobs)
        if method == "source":
            env["FLASH_ATTENTION_FORCE_BUILD"] = "TRUE"
            _run_env([pip, "install", ".", "--no-build-isolation"], env, cwd=lay.live)
        elif method == "hopper":
            _run_env([py, "setup.py", "install"], env, cwd=lay.live / "hopper")
        else:  # rocm
            env["FLASH_ATTENTION_TRITON_AMD_ENABLE"] = "TRUE"
            _run_env([pip, "install", "--no-build-isolation", "."], env, cwd=lay.live)
        _fa_record(lay, method, "git", py, None)

    Log.ok(f"FlashAttention ({method}) install step complete")
    for note in t.post_notes:
        Log.step(note)
    Log.head("Install map — FlashAttention")
    print(f"  method        {method} ({label})")
    print(f"  target env    {py}")
    print(f"  cache/workdir {lay.root}")
    if (lay.archives).exists() or DRY_RUN:
        print(f"  wheel cache   {lay.archives}/wheels-v*  (offline reinstall)")
    Log.step(f"versions: `models versions flashattention --path {lay.root}`   ·   "
             f"rollback: `models rollback flashattention --version <ver> --path {lay.root}`")
    return 0


def _fa_rollback(t: ModelTool, lay: ToolLayout, man: dict, target) -> int:
    """Rollback for FlashAttention = reinstall a cached wheel version into the recorded target env (offline)."""
    entry = next((v for v in man.get("versions", []) if str(v.get("ver")) == str(target) and v.get("wheel")), None)
    if not entry:
        Log.err(f"no cached wheel for version {target} (only wheel-method installs are rollback-able). "
                f"Have: {[v.get('ver') for v in man.get('versions', []) if v.get('wheel')]}"); return 2
    py = entry.get("target") or man.get("target")
    pip = str(Path(py).parent / "pip") if py else None
    wheel = lay.archives / f"wheels-v{target}" / entry["wheel"]
    if not wheel.exists():
        Log.err(f"cached wheel missing on disk: {wheel}"); return 2
    if not pip:
        Log.err("no recorded target env for this install"); return 2
    if not DRY_RUN and not Path(pip).exists():
        Log.err(f"recorded target env is gone (no pip at {pip}). Reinstall FlashAttention into a live env: "
                f"`models install flashattention --method wheel --target-python <engine>/bin/python`"); return 2
    Log.head(f"Rollback FlashAttention → wheel v{target}  (into {py})")
    if not _confirm(f"Reinstall {entry['wheel']} into {py} ?"):
        Log.warn("declined"); return 0
    # cached wheel may predate the gate or have been tampered with at rest
    if not DRY_RUN and not enforce_gate(str(wheel), f"{t.id} rollback wheel v{target}"):
        Log.err("rollback blocked by nemesis gate"); return 1
    run([pip, "install", "--force-reinstall", "--no-deps", str(wheel)], check=False)
    man["current_version"] = target
    man["current_method"] = "wheel"
    _write_tool_manifest(lay, man)
    Log.ok(f"FlashAttention reinstalled from cached wheel v{target} (offline)")
    return 0


def _fa_versions(t: ModelTool, base: Path) -> int:
    lay = ToolLayout(t.id, _resolve_tool_root(base, t.id) if base else (PROM_DIR / "flashattention"))
    man = _read_tool_manifest(lay)
    if not man.get("versions"):
        Log.warn(f"no FlashAttention install recorded under {lay.root}")
        return 1
    Log.head(f"FlashAttention — install history  ({lay.root})")
    cur = (str(man.get("current_version")), man.get("current_method"))
    for v in man["versions"]:
        active = (str(v.get("ver")), v.get("method")) == cur
        mark = Log._c("● active", "green") if active else Log._c("  stored", "dim")
        cached = ""
        if v.get("wheel"):
            wf = lay.archives / f"wheels-v{v.get('ver')}" / v["wheel"]
            cached = "wheel✓(offline)" if wf.exists() else "wheel✗"
        print(f"  {v.get('method',''):<8} {str(v.get('ver','')):<10} {mark}  {v.get('date',''):<20} "
              f"{cached:<16} → {v.get('target','')}")
    Log.step(f"rollback a cached wheel: `models rollback flashattention --version <ver> --path {lay.root}`")
    return 0


# ============================================================================
#  SECTION 6D — SELF-HOSTED APPS & REPOS  (the 4th functionality)
#  A SEPARATE track from the agent-plugin installer and the local-model tools:
#  general GitHub apps/libraries/services (downloaders, runners, design, analytics,
#  automation, vaults, workspaces). Prometheus owns their WHOLE lifecycle —
#  install · uninstall · enable · disable · status (+ versions/rollback for the
#  isolated pip tools) — and ALWAYS steers the user to the SAFEST install path:
#
#    pip-venv   → cloned + pip-installed into a DEDICATED, versioned virtualenv.
#                 Uninstall = delete one folder. Nothing touches system Python.
#    docker-run → one official container + named volume. Disable = `docker stop`,
#                 uninstall = `docker rm -f` + drop the volume. No host install.
#    compose    → official docker-compose stack in a folder you pick. Enable/disable
#                 = compose up/down; uninstall = `down -v` + delete the folder.
#
#  The unsafe alternatives (curl|sh installers, `npm i -g`, native .sh installers)
#  are only ever MENTIONED (safest_alt), never the default. Extend by appending a
#  RepoTool to REPO_TOOLS.
# ============================================================================
@dataclass
class RepoTool:
    id: str
    name: str
    category: str                 # downloader | runner | library | image-gen | speech | analytics | workspace | automation | design | vault
    repo: str
    blurb: str
    kind: str                     # "pip-venv" | "docker-run" | "compose"
    recommend: str                # the one-line "safest way" steer (printed green)
    security: str = ""
    secrets_note: str = ""        # what the user must provide by hand (NEVER written by Prometheus)
    safest_alt: str = ""          # the less-safe alternatives, mentioned not used
    system_prereqs: tuple[str, ...] = ()   # host binaries to check + warn (ffmpeg, ...)
    warnings: tuple[str, ...] = ()
    post_notes: tuple[str, ...] = ()
    run_hint: str = ""
    docs: str = ""
    # --- pip-venv (these names DUCK-TYPE into _install_into_layout / _tool_versions / _rollback_tool) ---
    install_kind: str = "python-venv"      # constant for the isolated-venv path
    isolated: bool = True
    clone_url: Optional[str] = None        # source cloned for the per-version archive
    pip_pkg: Optional[str] = None          # PyPI package installed into the venv (None → use requirements)
    pip_extras: tuple[str, ...] = ()
    requirements: Optional[str] = None     # requirements file inside the clone (Fooocus)
    pip_cli: Optional[str] = None          # console-script the venv exposes (yt-dlp, whisper)
    live_steps: tuple[tuple[str, ...], ...] = ()
    serve_steps: tuple[tuple[str, ...], ...] = ()  # long-running servers (shared _install_into_layout reads this; pip-venv RepoTools left it absent → AttributeError on install)
    dest: Optional[str] = None
    # --- npm (kind="npm", install_kind="npm"): build + install npm sub-package(s)
    #     from the GATED clone into the tool's own npm prefix (bins → npm_prefix/bin) ---
    npm_subdirs: tuple[str, ...] = ()      # package dirs inside the clone (e.g. tools/loop-audit); () = repo root
    npm_clis: tuple[str, ...] = ()         # bin names the install exposes (for run hints)
    # --- docker-run (single official container) ---
    docker_image: Optional[str] = None
    docker_run: tuple[str, ...] = ()       # full argv after `docker`
    docker_name: Optional[str] = None
    docker_volumes: tuple[str, ...] = ()   # named volumes dropped on uninstall
    post_run: tuple[tuple[str, ...], ...] = ()   # e.g. pull a model after first start
    port: Optional[str] = None
    # --- compose (official docker-compose stack) ---
    compose_url: Optional[str] = None      # raw URL of a compose file to fetch
    compose_clone: Optional[str] = None    # OR a repo that ships the compose file
    compose_project: Optional[str] = None  # docker compose -p NAME
    compose_file: Optional[str] = None     # -f NAME (None → let compose auto-detect)
    version_env: Optional[str] = None      # compose: env var that pins the image version (e.g. PENPOT_VERSION) → enables tag rollback
    compose_inline: Optional[str] = None    # OR an embedded compose we scaffold
    env_file: str = ".env"
    env_copy: Optional[str] = None         # cp <file> -> env_file inside the stack
    env_static: tuple[str, ...] = ()       # literal KEY=VALUE lines written to env_file
    env_secrets: tuple[str, ...] = ()      # KEYs filled with a freshly GENERATED random app secret
    env_template: tuple[str, ...] = ()     # placeholder lines (${...}) the user edits by hand
    needs_secrets: bool = False            # user must supply real secrets → do NOT auto-up
    auto_up: bool = True                   # compose: bring the stack up right after setup


REPO_TOOLS: list[RepoTool] = [
    # ---- 1. yt-dlp — video/audio downloader (pure-python CLI) -----------------
    RepoTool(
        id="yt-dlp", name="yt-dlp", category="downloader",
        repo="https://github.com/yt-dlp/yt-dlp",
        blurb="Feature-rich command-line audio/video downloader (a maintained youtube-dl fork). Thousands of sites, format selection, post-processing.",
        kind="pip-venv", clone_url="https://github.com/yt-dlp/yt-dlp.git", pip_pkg="yt-dlp", pip_cli="yt-dlp",
        recommend="isolated venv (pip) — installed into its own virtualenv; uninstall = delete the one folder. No system Python touched.",
        security="Pure-Python pip install, no build step, no curl|sh → low install-time risk. Downloads are user-driven at runtime.",
        safest_alt="`pipx install yt-dlp` (also isolated) · a standalone binary release · `brew install yt-dlp`. Avoid a bare global `pip install`.",
        system_prereqs=("ffmpeg",),
        run_hint="source venv_yt-dlp/bin/activate && yt-dlp <URL>     (or run the venv's bin/yt-dlp directly)",
        post_notes=("ffmpeg is needed for merging/transcoding (install via brew/apt) — without it some formats won't merge",
                    "self-update inside the venv: `bin/yt-dlp -U` (or re-run `apps install yt-dlp` for a fresh versioned snapshot)"),
        docs="github_repos_a.txt", warnings=(),
    ),
    # ---- 2. ollama — local LLM runner (official container) --------------------
    RepoTool(
        id="ollama", name="Ollama", category="runner",
        repo="https://github.com/ollama/ollama",
        blurb="Run open LLMs locally (Llama, Qwen, Mistral, …) behind a simple API on :11434. The de-facto easy local-model server.",
        kind="docker-run", docker_image="ollama/ollama", docker_name="ollama", docker_volumes=("ollama",), port="11434",
        docker_run=("run", "-d", "-v", "ollama:/root/.ollama", "-p", "11434:11434", "--name", "ollama", "ollama/ollama"),
        post_run=(("docker", "exec", "ollama", "ollama", "--version"),),
        recommend="official Docker image — isolated + trivially removable (`docker rm -f ollama` + drop the volume). Safer than the curl|sh installer.",
        security="Official `ollama/ollama` image. Binds 127.0.0.1:11434 by default via the published port; do not expose :11434 publicly.",
        safest_alt="macOS: `brew install ollama` (clean uninstall). Linux: `curl -fsSL https://ollama.com/install.sh | sh` (a piped installer — less isolated; we don't run it for you).",
        post_notes=("pull + chat a model: `docker exec -it ollama ollama run llama3.2`",
                    "API check: `curl http://localhost:11434/api/tags`",
                    "GPU passthrough (NVIDIA): add `--gpus all` to the run — re-install with it if you have a GPU"),
        run_hint="docker exec -it ollama ollama run llama3.2",
        docs="github_repos_a.txt",
    ),
    # ---- 3. ollama-python — python client library ----------------------------
    RepoTool(
        id="ollama-python", name="Ollama Python", category="library",
        repo="https://github.com/ollama/ollama-python",
        blurb="Official Python client for the Ollama API — `chat()`, `generate()`, streaming, embeddings. Pairs with the Ollama runner.",
        kind="pip-venv", clone_url="https://github.com/ollama/ollama-python.git", pip_pkg="ollama",
        recommend="isolated venv (pip) — its own virtualenv; uninstall = delete the folder.",
        security="Pure-Python pip install → low risk. It only talks to a local Ollama server you run.",
        safest_alt="a project-local `python -m venv` then `pip install ollama`. Avoid global installs.",
        post_notes=("needs the Ollama runner up first: `apps install ollama`",
                    "use it: `source venv_ollama-python/bin/activate` then `import ollama; ollama.chat(...)`"),
        run_hint="source venv_ollama-python/bin/activate && python -c \"import ollama; print(ollama.list())\"",
        docs="github_repos_a.txt",
    ),
    # ---- 4. Fooocus — Stable Diffusion image generation UI -------------------
    RepoTool(
        id="fooocus", name="Fooocus", category="image-gen",
        repo="https://github.com/lllyasviel/Fooocus",
        blurb="Focused, simplified Stable-Diffusion image generator (Midjourney-style). Clone + run; no prompt-engineering ceremony.",
        kind="pip-venv", clone_url="https://github.com/lllyasviel/Fooocus.git",
        requirements="requirements_versions.txt", pip_pkg=None,
        recommend="isolated venv (git + pinned requirements) — its own virtualenv; uninstall = delete the folder. (Upstream's other option is conda; venv keeps it self-contained.)",
        security="Open-source (lllyasviel). Pip installs pinned torch + deps into the venv (real, heavy download, no curl|sh). First run pulls several GB of model weights from HuggingFace.",
        safest_alt="upstream also documents an Anaconda `environment.yaml` path; the venv path here is the most self-contained for clean removal.",
        warnings=("first launch downloads SEVERAL GB of model checkpoints — ensure disk + bandwidth",
                  "needs an NVIDIA GPU (≥4GB) for usable speed; on Mac/CPU it runs but is very slow (`--always-cpu`)"),
        post_notes=("launch it: `source venv_fooocus/bin/activate && cd fooocus && python entry_with_update.py`",
                    "`entry_with_update.py` self-updates the checkout on launch; add `--listen` for LAN access"),
        run_hint="source venv_fooocus/bin/activate && cd fooocus && python entry_with_update.py",
        docs="github_repos_a.txt",
    ),
    # ---- 5. Whisper — speech-to-text -----------------------------------------
    RepoTool(
        id="whisper", name="Whisper", category="speech",
        repo="https://github.com/openai/whisper",
        blurb="OpenAI's robust speech recognition / transcription + translation. CLI `whisper audio.mp3` or the Python API.",
        kind="pip-venv", clone_url="https://github.com/openai/whisper.git", pip_pkg="openai-whisper", pip_cli="whisper",
        system_prereqs=("ffmpeg",),
        recommend="isolated venv (pip `openai-whisper`) — its own virtualenv; uninstall = delete the folder.",
        security="Pure-Python pip install → low risk. Model weights download on first use; inference is fully local.",
        safest_alt="`pipx install openai-whisper` (isolated). For speed, faster-whisper / whisper.cpp are community alternatives.",
        warnings=("ffmpeg is REQUIRED (audio decoding) — install via brew/apt before transcribing",
                  "first transcription downloads the chosen model (tiny→large); GPU optional but much faster"),
        post_notes=("transcribe: `source venv_whisper/bin/activate && whisper audio.mp3 --model small`",),
        run_hint="source venv_whisper/bin/activate && whisper audio.mp3 --model small",
        docs="github_repos_a.txt",
    ),
    # ---- 6. Plausible — privacy-friendly web analytics (self-host) -----------
    RepoTool(
        id="plausible", name="Plausible Analytics", category="analytics",
        repo="https://github.com/plausible/analytics",
        blurb="Lightweight, privacy-friendly, cookieless web analytics — a self-hosted Google-Analytics alternative.",
        kind="compose", compose_clone="https://github.com/plausible/community-edition", compose_project="plausible", port="8000",
        env_static=("BASE_URL=http://localhost:8000", "HTTP_PORT=8000"),
        env_secrets=("SECRET_KEY_BASE",),     # freshly generated app secret (not a user credential)
        recommend="official Community-Edition Docker Compose stack — runs in a folder you pick; disable = `compose down`, uninstall = `down -v` + delete the folder.",
        security="Official `plausible/community-edition`. We generate a random SECRET_KEY_BASE (the app's own key, not your credential) into .env. Bind behind a reverse proxy + HTTPS for real use.",
        secrets_note="SECRET_KEY_BASE is auto-generated locally (random). No external API keys needed for a basic local instance.",
        safest_alt="Plausible's paid hosted SaaS (no self-host). For production self-host, set a real BASE_URL + TLS proxy.",
        post_notes=("open http://localhost:8000 and create the first user",
                    "production: edit .env BASE_URL to your domain + put HTTPS in front (Caddy/Cloudflare/Tailscale)"),
        docs="github_repos_a.txt",
    ),
    # ---- 7. AppFlowy (Cloud) — self-hosted Notion alternative ----------------
    RepoTool(
        id="appflowy", name="AppFlowy Cloud", category="workspace",
        repo="https://github.com/appflowy-io/appflowy",
        blurb="Open-source Notion alternative — projects, wikis, docs, AI. This installs the self-host BACKEND (AppFlowy-Cloud); the desktop/mobile client is a separate download.",
        kind="compose", compose_clone="https://github.com/AppFlowy-IO/AppFlowy-Cloud.git",
        env_copy="deploy.env", needs_secrets=True, auto_up=False, port="80",
        recommend="official AppFlowy-Cloud Docker Compose stack in a folder you pick. It needs secrets/SMTP configured in .env first, so we set it up but DON'T auto-start.",
        security="Official AppFlowy-Cloud. Copies `deploy.env`→.env for you to edit (GoTrue JWT secret, SMTP, Postgres/Redis live in the compose). Review .env before starting.",
        secrets_note="You must edit .env: set GOTRUE_JWT_SECRET / admin creds / (optional) SMTP. Prometheus writes the template only — never your real secrets.",
        safest_alt="The AppFlowy DESKTOP app (download a release) needs no server at all — simplest if you don't want self-host infra.",
        warnings=("self-hosting a full workspace = Postgres + Redis + GoTrue + MinIO containers — review resource needs",
                  "set a strong GOTRUE_JWT_SECRET and admin password in .env before exposing anything"),
        post_notes=("1) edit the .env in the stack folder (secrets/SMTP/FQDN)",
                    "2) start it: `apps enable appflowy --path <your-folder>`",
                    "then pair the AppFlowy desktop client → Settings → self-host URL",
                    "FREE AI: AI is optional — use AppFlowy desktop's 'Local AI' (Ollama) for zero-cost AI, or give the cloud AI service your own OpenAI-compatible key (`localai show appflowy`)"),
        docs="github_repos_a.txt",
    ),
    # ---- 8. n8n — workflow automation (official container) -------------------
    RepoTool(
        id="n8n", name="n8n", category="automation",
        repo="https://github.com/n8n-io/n8n",
        blurb="Fair-code workflow automation (Zapier/Make alternative) with 400+ integrations + a visual editor on :5678.",
        kind="docker-run", docker_image="docker.n8n.io/n8nio/n8n", docker_name="n8n", docker_volumes=("n8n_data",), port="5678",
        docker_run=("run", "-d", "--name", "n8n", "-p", "5678:5678", "-v", "n8n_data:/home/node/.n8n", "docker.n8n.io/n8nio/n8n"),
        recommend="official Docker image + named volume — isolated + removable (`docker rm -f n8n` + drop the volume). Safer than a global `npm i -g n8n`.",
        security="Official `docker.n8n.io/n8nio/n8n`. Editor on :5678 — set auth + don't expose publicly without a proxy. Workflows can run code/HTTP, so treat it as trusted-internal.",
        safest_alt="`npx n8n` for a throwaway local try (no install). Avoid `npm install -g n8n` (pollutes the global Node env, messy to remove).",
        post_notes=("open http://localhost:5678 and create the owner account",
                    "data persists in the `n8n_data` volume — survives container recreation",
                    "FREE AI: use the Ollama node, or set an OpenAI/LangChain credential's Base-URL to http://localhost:11434/v1 (key: any) — no paid cloud nodes needed (`localai show n8n`)"),
        run_hint="open http://localhost:5678",
        docs="github_repos_a.txt",
    ),
    # ---- 9. Penpot — open-source design & prototyping (self-host) ------------
    RepoTool(
        id="penpot", name="Penpot", category="design",
        repo="https://github.com/penpot/penpot",
        blurb="Open-source design + prototyping platform (a self-hostable Figma alternative), SVG-native, dev-friendly handoff.",
        kind="compose",
        compose_url="https://raw.githubusercontent.com/penpot/penpot/main/docker/images/docker-compose.yaml",
        compose_project="penpot", compose_file="docker-compose.yaml", version_env="PENPOT_VERSION", port="9001",
        recommend="official Docker Compose stack in a folder you pick — works out-of-the-box for local eval; disable = `compose ... down`, uninstall = `down -v` + delete the folder.",
        security="Official Penpot compose (fetched + SCANNED before it runs). Defaults are for local evaluation; harden (real secrets + TLS) before production.",
        safest_alt="Penpot's hosted SaaS at penpot.app (no self-host) if you don't want to run infra.",
        post_notes=("open http://localhost:9001 and register the first account",
                    "local-eval defaults send no email; flip on SMTP + disable demo for production"),
        docs="github_repos_a.txt",
    ),
    # ---- 10. Bitwarden — password manager (self-host, Lite/unified) ----------
    RepoTool(
        id="bitwarden", name="Bitwarden (self-host)", category="vault",
        repo="https://github.com/bitwarden",
        blurb="Self-hosted Bitwarden vault using the single-container 'Lite' (formerly unified) image — full clients, your data on your box.",
        kind="compose", compose_project="bitwarden", env_file="settings.env", needs_secrets=True, auto_up=False, port="8000",
        compose_inline=(
            "services:\n"
            "  bitwarden:\n"
            "    image: ghcr.io/bitwarden/lite\n"
            "    container_name: bitwarden\n"
            "    restart: unless-stopped\n"
            "    env_file:\n"
            "      - settings.env\n"
            "    ports:\n"
            "      - \"8000:8080\"\n"
            "    volumes:\n"
            "      - ./bwdata:/etc/bitwarden\n"
        ),
        env_template=(
            "# Bitwarden Lite self-host settings — fill the placeholders, then `apps enable bitwarden --path <folder>`",
            "# Installation ID + Key: generate yours at https://bitwarden.com/host/  (free, required)",
            "BW_DOMAIN=localhost",
            "BW_DB_PROVIDER=sqlite",
            "BW_INSTALLATION_ID=${BW_INSTALLATION_ID}",
            "BW_INSTALLATION_KEY=${BW_INSTALLATION_KEY}",
        ),
        recommend="single-container 'Lite' image with a local SQLite DB (no MariaDB to run). Scaffolded in a folder you pick; uninstall = `down -v` + delete the folder.",
        security="Official `ghcr.io/bitwarden/lite`. Needs a free Installation ID/Key from https://bitwarden.com/host/. A password vault MUST sit behind HTTPS — never expose :8000 in the clear.",
        secrets_note="BW_INSTALLATION_ID / BW_INSTALLATION_KEY are YOUR values from bitwarden.com/host — Prometheus writes only ${PLACEHOLDERS}; you paste the real ones into settings.env.",
        safest_alt="Vaultwarden (`vaultwarden/server`) is a lighter community-built Bitwarden-compatible server: `docker run -d --name vaultwarden -v vw-data:/data -p 8000:80 vaultwarden/server`.",
        warnings=("a password manager demands HTTPS + a trusted reverse proxy — do NOT run it exposed over plain HTTP",
                  "back up the ./bwdata folder (your encrypted vault lives there)"),
        post_notes=("1) get an Installation ID/Key at https://bitwarden.com/host/ and paste them into settings.env",
                    "2) start it: `apps enable bitwarden --path <your-folder>`",
                    "3) put HTTPS in front before real use (Caddy/Cloudflare/Tailscale)"),
        docs="github_repos_a.txt",
    ),
    # ---- uptime-kuma — self-hosted uptime/status monitoring (official container) ----
    RepoTool(
        id="uptime-kuma", name="Uptime Kuma", category="automation",
        repo="https://github.com/louislam/uptime-kuma",
        blurb="Self-hosted uptime/status monitoring (Pingdom/UptimeRobot alternative): HTTP/TCP/ping/DNS checks, status pages, 90+ notification channels. UI on :3001.",
        kind="docker-run", docker_image="louislam/uptime-kuma:2", docker_name="uptime-kuma",
        docker_volumes=("uptime-kuma",), port="3001",
        docker_run=("run", "-d", "--restart=always", "-p", "3001:3001", "-v", "uptime-kuma:/app/data", "--name", "uptime-kuma", "louislam/uptime-kuma:2"),
        recommend="official Docker image — isolated + trivially removable (`docker rm -f uptime-kuma` + drop the volume). Safer than the bare npm/pm2 path.",
        security="Official `louislam/uptime-kuma` image, very popular/mature. You create the admin account on first visit; do not expose :3001 publicly without auth + HTTPS.",
        safest_alt="docker compose (curl the official compose.yaml) · bare `git clone` + `npm run setup` + pm2 (less isolated).",
        post_notes=("open http://localhost:3001 and create the admin account on first run",
                    "add monitors + a status page; wire notifications (Telegram/Slack/email/...)"),
        run_hint="open http://localhost:3001",
        docs="92-louislam-uptime-kuma.md",
    ),
    # ---- 12. loop-engineering — npm CLI tools for agent loop engineering ------
    RepoTool(
        id="loop-engineering", name="Loop Engineering CLIs", category="automation",
        repo="https://github.com/cobusgreyling/loop-engineering",
        blurb="Practical CLI tools for loop engineering with AI coding agents — loop-audit "
              "(audit an agent loop), loop-init (scaffold a loop), loop-cost (estimate run cost). "
              "MIT, 3.8k★. Built from the nemesis-gated clone into an isolated npm prefix.",
        kind="npm", install_kind="npm",
        clone_url="https://github.com/cobusgreyling/loop-engineering.git",
        npm_subdirs=("tools/loop-audit", "tools/loop-init", "tools/loop-cost"),
        npm_clis=("loop-audit", "loop-init", "loop-cost"),
        system_prereqs=("node", "npm"),
        recommend="isolated npm install in a folder you pick — clone is nemesis-gated, each sub-tool "
                  "built from that gated source into npm_prefix/bin; uninstall = delete the one folder.",
        security="Repo nemesis-gated (clone → deep scan) before any build; each tools/* is built from "
                 "that vetted source (not the npm registry). npm fetches transitive deps (normal npm "
                 "supply-chain risk, same as pip).",
        post_notes=("CLIs land in <folder>/loop-engineering/npm_prefix/bin (loop-audit / loop-init / loop-cost)",
                    "add that bin dir to PATH, or run via the full path printed above"),
        run_hint="loop-audit --help   (after adding npm_prefix/bin to PATH)",
        docs="https://github.com/cobusgreyling/loop-engineering",
    ),
    # >>> APPEND MORE SELF-HOSTED APPS / REPOS HERE <<<
]


def repo_tool_registry() -> dict[str, RepoTool]:
    return {t.id: t for t in REPO_TOOLS}


def _apps_root() -> Path:
    return PROM_DIR / "apps"


def _apps_dir(tool: str, path: Optional[str]) -> Path:
    base = Path(os.path.expanduser(path)) if path else _apps_root()
    return base if base.name == tool else base / tool


def _docker_bin() -> Optional[str]:
    return shutil.which("docker")


def _fetch_url_text(url: str, timeout: int = 20,
                    max_bytes: int = 8 * 1024 * 1024) -> Optional[str]:
    """Fetch a remote text file (compose/env). Size-capped; binary refused.
    NOTE: deliberately NOT named _fetch_text — that is the hardened SECTION 5C
    installer-body fetcher, which this definition used to shadow silently."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:    # noqa: S310 (https raw file)
            data = r.read(max_bytes + 1)
    except Exception as e:
        Log.err(f"fetch failed: {url} ({e})")
        return None
    if len(data) > max_bytes:
        Log.err(f"fetch refused: {url} exceeds {max_bytes} bytes")
        return None
    if _is_binary(data):
        Log.err(f"fetch refused: {url} is binary, expected text")
        return None
    return data.decode("utf-8", "replace")


def _gen_secret() -> str:
    import secrets as _s
    return _s.token_urlsafe(48)


def _app_marker(folder: Path) -> Path:
    return folder / ".prometheus_app.json"


def _write_app_marker(folder: Path, data: dict) -> None:
    if DRY_RUN:
        Log.step(f"[dry-run] write {_app_marker(folder).name}"); return
    folder.mkdir(parents=True, exist_ok=True)
    _app_marker(folder).write_text(json.dumps(data, indent=2))


def _read_app_marker(folder: Path) -> dict:
    return _read_json(_app_marker(folder))


def _compose_prefix(project: Optional[str], compose_file: Optional[str]) -> list[str]:
    cmd = ["docker", "compose"]
    if project:
        cmd += ["-p", project]
    if compose_file:
        cmd += ["-f", compose_file]
    return cmd


# ---- presentation ----------------------------------------------------------
def _print_repo_tools() -> None:
    Log.head("Self-Hosted Apps & Repos — install / uninstall / enable / disable / status")
    kind_col = {"pip-venv": "cyan", "docker-run": "blue", "compose": "magenta"}
    kind_tag = {"pip-venv": "isolated venv (delete-folder uninstall)",
                "docker-run": "official container + volume",
                "compose": "docker-compose stack (folder you pick)"}
    for t in REPO_TOOLS:
        tag = Log._c(f"[{t.category}]", "yellow")
        kt = Log._c(kind_tag.get(t.kind, "external tool"), kind_col.get(t.kind, "dim"))
        print(f"  {tag} {Log._c(t.id, 'bold')} — {t.name}   {kt}")
        print(f"      {t.blurb}")
        print(f"      {Log._c('safest: ' + t.recommend, 'green')}")
        if t.port:
            print(f"      {Log._c('serves on :' + t.port, 'dim')}")
        print(f"      {Log._c(t.repo, 'dim')}")
    Log.step("install: `apps install <id> [--path DIR]`  ·  uninstall: `apps uninstall <id> [--path DIR]`")
    Log.step("update: `apps update <id>`  ·  rollback: `apps rollback <id> --version <N|tag>`  ·  versions: `apps versions <id>`")
    Log.step("services: `apps enable|disable|restart|logs|open|status <id> [--path DIR]`")
    Log.step("guided (no repetitive commands): `apps wizard`  ·  overview: `apps installed`  ·  `apps update-all`")


def _print_repo_header(t: RepoTool) -> None:
    Log.head(f"{t.name}  [{t.category}]  ·  {t.kind}")
    print(f"  {t.blurb}")
    Log.ok(f"SAFEST WAY → {t.recommend}")
    if t.security:
        Log.step(f"security: {t.security}")
    if t.secrets_note:
        Log.step(f"secrets (you provide, never written by Prometheus): {t.secrets_note}")
    if t.safest_alt:
        Log.step(f"alternatives (not used by default): {t.safest_alt}")
    for w in t.warnings:
        Log.warn(w)
    for binname in t.system_prereqs:
        if shutil.which(binname):
            Log.ok(f"prereq present: {binname}")
        else:
            Log.warn(f"prereq missing: {binname} — install it (brew/apt) for full functionality")


# RepoTool kinds that install into an isolated, versioned on-disk layout (clone →
# gate → archive → build/install). pip-venv (python) and npm share this machinery.
_ISOLATED_REPO_KINDS = {"pip-venv", "npm"}


# ---- install ---------------------------------------------------------------
def _install_repo_tool(t: RepoTool, osi: OSInfo, path: Optional[str]) -> int:
    _print_repo_header(t)
    if t.kind in _ISOLATED_REPO_KINDS:
        # reuse the isolated, versioned workspace (RepoTool duck-types into _install_into_layout)
        base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
        if base is None:
            Log.warn("cancelled — no folder chosen"); return 0
        return _install_into_layout(t, osi, base)        # clone + venv + pip + version snapshot
    if t.kind == "docker-run":
        return _docker_run_install(t)
    if t.kind == "compose":
        return _compose_install(t, path)
    Log.err(f"unknown repo kind: {t.kind}"); return 2


def _docker_run_install(t: RepoTool) -> int:
    docker = _docker_bin()
    if not docker:
        Log.err("docker not found — install Docker Desktop / Engine first.")
        if t.safest_alt:
            Log.step(f"or use the alternative: {t.safest_alt}")
        return 2
    if not _confirm(f"Run the official {t.name} container ({t.docker_image}) now?"):
        Log.warn("declined"); return 0
    # already present?
    existing = _run_timed([docker, "ps", "-aq", "-f", f"name=^{t.docker_name}$"],
                              capture_output=True, text=True, timeout=30).stdout.strip() if not DRY_RUN else ""
    if existing:
        Log.ok(f"a container named '{t.docker_name}' already exists — starting it (use `apps uninstall {t.id}` to recreate)")
        run([docker, "start", t.docker_name], check=False)
    else:
        Log.step("docker " + " ".join(t.docker_run))
        rc = run([docker, *t.docker_run], check=False).returncode
        if rc != 0:
            Log.err(f"{t.name} container failed to start (rc={rc})"); return 1
    for cmd in t.post_run:
        run(list(cmd), check=False)
    # remember it for lifecycle ops
    _write_app_marker(_apps_dir(t.id, None), {
        "tool": t.id, "kind": t.kind, "repo": t.repo,
        "docker_name": t.docker_name, "docker_volumes": list(t.docker_volumes), "port": t.port})
    Log.ok(f"{t.name} running")
    if t.port:
        Log.step(f"serves on http://localhost:{t.port}")
    for n in t.post_notes:
        Log.step(n)
    return 0


def _compose_install(t: RepoTool, path: Optional[str]) -> int:
    docker = _docker_bin()
    if not docker:
        Log.err("docker not found — install Docker Desktop / Engine first.")
        if t.safest_alt:
            Log.step(f"or use the alternative: {t.safest_alt}")
        return 2
    folder = _apps_dir(t.id, path)
    stack = folder / "stack"                         # the compose stack lives here
    Log.info(f"stack folder: {stack}")
    if not _confirm(f"Set up the {t.name} compose stack at {stack} ?"):
        Log.warn("declined"); return 0
    if DRY_RUN:
        Log.step(f"[dry-run] mkdir -p {stack}")
    else:
        stack.mkdir(parents=True, exist_ok=True)

    # 1) obtain the compose definition (clone repo · fetch url · scaffold inline) + SCAN it
    if t.compose_clone:
        git = shutil.which("git")
        if not git:
            Log.err("git not found"); return 2
        srcdir = stack / "app"
        if srcdir.exists() and any(srcdir.iterdir()):
            Log.ok(f"{srcdir} already populated — reusing")
        elif DRY_RUN:
            Log.step(f"[dry-run] git clone {t.compose_clone} -> {srcdir}")
        else:
            Log.step(f"git clone {t.compose_clone} -> stack/app")
            run([git, "clone", "--depth", "1", t.compose_clone, str(srcdir)])
        if srcdir.exists() and not DRY_RUN:
            if not NO_SCAN:
                Log.step("security scan of the compose stack")
                rep = ScanReport(t.id, t.compose_clone, _git_identity(srcdir), _walk_and_scan(srcdir), 0)
                if not security_gate(rep, "local"):
                    Log.warn(f"{t.name} aborted by security gate"); return 1
            if not enforce_gate(str(srcdir), f"{t.name} ({t.compose_clone})"):  # deep nemesis gate
                Log.warn(f"{t.name} aborted by nemesis gate — blocked tree kept "
                         f"for inspection: nemesis ui {srcdir}")
                return 1
    else:
        srcdir = stack
        cf = t.compose_file or "docker-compose.yaml"
        if t.compose_url:
            Log.step(f"fetch compose: {t.compose_url}")
            text = None if DRY_RUN else _fetch_url_text(t.compose_url)
            if not DRY_RUN:
                if text is None:
                    return 2
                if not NO_SCAN:                       # scan the compose text before writing/running it
                    rep = ScanReport(t.id, t.compose_url, "compose:" + str(abs(hash(text)))[:8],
                                     _scan_text(cf, text), 0)
                    if not security_gate(rep, "local"):
                        Log.warn(f"{t.name} aborted by security gate"); return 1
                if not enforce_gate_text(text, f"{t.id} compose ({t.compose_url})"):
                    Log.warn(f"{t.name} aborted by nemesis gate"); return 1
                (srcdir / cf).write_text(text)
        elif t.compose_inline:
            if DRY_RUN:
                Log.step(f"[dry-run] write {cf}")
            else:
                if not enforce_gate_text(t.compose_inline, f"{t.id} compose (inline)"):
                    Log.warn(f"{t.name} aborted by nemesis gate"); return 1
                (srcdir / cf).write_text(t.compose_inline)

    # 2) environment file (copy template · static · generated app-secret · placeholders)
    envp = srcdir / t.env_file
    if not DRY_RUN:
        if t.env_copy and (srcdir / t.env_copy).exists() and not envp.exists():
            shutil.copy(srcdir / t.env_copy, envp)
            Log.ok(f"copied {t.env_copy} → {t.env_file} (edit your secrets there)")
        lines: list[str] = []
        lines += list(t.env_static)
        for key in t.env_secrets:
            lines.append(f"{key}={_gen_secret()}")     # app's own random secret, generated locally
        lines += list(t.env_template)
        if lines and not (t.env_copy and envp.exists()):
            with envp.open("a" if envp.exists() else "w") as fh:
                fh.write("\n".join(lines) + "\n")
            if t.env_secrets:
                Log.ok(f"generated random {', '.join(t.env_secrets)} into {t.env_file} (the app's own key — not your credential)")
            if t.env_template:
                Log.warn(f"{t.env_file} has ${{PLACEHOLDERS}} you must fill in — see the secrets note above")
    elif t.env_static or t.env_secrets or t.env_template or t.env_copy:
        Log.step(f"[dry-run] write {t.env_file}")

    # 3) marker for lifecycle ops
    _write_app_marker(folder, {
        "tool": t.id, "kind": t.kind, "repo": t.repo, "srcdir": str(srcdir),
        "compose_project": t.compose_project, "compose_file": t.compose_file,
        "port": t.port, "needs_secrets": t.needs_secrets})

    # 4) bring it up (only if it doesn't require hand-entered secrets first)
    pref = _compose_prefix(t.compose_project, t.compose_file)
    if t.needs_secrets or not t.auto_up:
        Log.warn(f"{t.name} needs configuration before first start — NOT auto-starting.")
        Log.step(f"edit {srcdir / t.env_file}, then: `apps enable {t.id} --path {folder}`")
    else:
        Log.step(" ".join(pref + ["up", "-d"]))
        rc = _run_in(pref + ["up", "-d"], srcdir)
        if rc != 0:
            Log.err(f"{t.name} stack failed to come up (rc={rc}) — files are on disk; fix + `apps enable {t.id} --path {folder}`")
            return 1
        Log.ok(f"{t.name} stack is up")
        if t.port:
            Log.step(f"serves on http://localhost:{t.port}")
    for n in t.post_notes:
        Log.step(n)
    Log.step(f"manage: `apps status|disable|uninstall {t.id} --path {folder}`")
    return 0


# ---- enable / disable (services) -------------------------------------------
def _service_repo(t: RepoTool, path: Optional[str], on: bool) -> int:
    verb = "enable (start)" if on else "disable (stop)"
    if t.kind in _ISOLATED_REPO_KINDS:
        Log.info(f"{t.name} is a {t.category} installed in its own venv — there is no running service to {('enable','disable')[not on]}.")
        Log.step(f"use it: {t.run_hint or 'activate venv_' + t.id + '/ and run it'}")
        Log.step(f"to remove it entirely: `apps uninstall {t.id} --path <folder>`")
        return 0
    docker = _docker_bin()
    if not docker:
        Log.err("docker not found"); return 2
    if t.kind == "docker-run":
        Log.head(f"{verb} {t.name}")
        rc = run([docker, "start" if on else "stop", t.docker_name], check=False).returncode
        Log.ok(f"{t.name} {'started' if on else 'stopped'}") if rc == 0 else Log.err(f"docker {'start' if on else 'stop'} failed (rc={rc})")
        return 0 if rc == 0 else 1
    # compose
    folder = _apps_dir(t.id, path)
    marker = _read_app_marker(folder)
    srcdir = Path(marker.get("srcdir") or (folder / "stack"))
    if not srcdir.exists():
        Log.err(f"no {t.name} stack found at {srcdir} — run `apps install {t.id}` first (or pass the right --path)"); return 2
    pref = _compose_prefix(t.compose_project, t.compose_file)
    Log.head(f"{verb} {t.name}")
    action = ["up", "-d"] if on else ["down"]
    rc = _run_in(pref + action, srcdir)
    if rc == 0:
        Log.ok(f"{t.name} {'is up' if on else 'stopped (containers down; data + folder kept)'}")
        if on and t.port:
            Log.step(f"serves on http://localhost:{t.port}")
    return 0 if rc == 0 else 1


# ---- uninstall -------------------------------------------------------------
def _uninstall_repo_tool(t: RepoTool, path: Optional[str]) -> int:
    Log.head(f"Uninstall {t.name}")
    if t.kind in _ISOLATED_REPO_KINDS:
        base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
        if base is None:
            Log.warn("cancelled"); return 0
        root = _resolve_tool_root(base, t.id)
        if not root.exists():
            Log.warn(f"nothing to remove at {root}"); return 0
        Log.warn(f"this DELETES the whole isolated folder: {root}  ({_human_size_dir(root)})")
        if not _confirm(f"Delete {root} (venv + all versions + archives) ?"):
            Log.warn("declined"); return 0
        _rmtree(root)
        Log.ok(f"{t.name} removed — folder deleted. Clean, nothing left on the system.")
        return 0
    docker = _docker_bin()
    if t.kind == "docker-run":
        if not docker:
            Log.err("docker not found"); return 2
        Log.warn(f"removes container '{t.docker_name}'" + (f" + volume(s) {', '.join(t.docker_volumes)} (DATA LOSS)" if t.docker_volumes else ""))
        if not _confirm(f"Remove {t.name} container + its data volume(s)?"):
            Log.warn("declined"); return 0
        run([docker, "rm", "-f", t.docker_name], check=False)
        for vol in t.docker_volumes:
            run([docker, "volume", "rm", vol], check=False)
        _rmtree(_apps_dir(t.id, None))
        Log.ok(f"{t.name} removed (container + volume gone)")
        return 0
    # compose
    if not docker:
        Log.err("docker not found"); return 2
    folder = _apps_dir(t.id, path)
    marker = _read_app_marker(folder)
    srcdir = Path(marker.get("srcdir") or (folder / "stack"))
    pref = _compose_prefix(t.compose_project, t.compose_file)
    Log.warn(f"removes the {t.name} stack at {folder} AND its docker volumes (DATA LOSS)")
    if not _confirm(f"Tear down {t.name} (`compose down -v`) and delete {folder} ?"):
        Log.warn("declined"); return 0
    if srcdir.exists():
        _run_in(pref + ["down", "-v"], srcdir)
    _rmtree(folder)
    Log.ok(f"{t.name} removed — stack down, volumes dropped, folder deleted.")
    return 0


# ---- status ----------------------------------------------------------------
def _status_repo_tool(t: RepoTool, path: Optional[str]) -> int:
    Log.head(f"{t.name} — status")
    if t.kind in _ISOLATED_REPO_KINDS:
        base = Path(os.path.expanduser(path)) if path else None
        if base is None:
            Log.step(f"isolated pip tool — pass --path to inspect a specific install, e.g. `apps status {t.id} --path <folder>`")
            return 0
        return _tool_versions(t, base)                # version history of the isolated venv install
    docker = _docker_bin()
    if not docker:
        Log.err("docker not found"); return 2
    if t.kind == "docker-run":
        p = _run_timed([docker, "ps", "-a", "--filter", f"name=^{t.docker_name}$",
                            "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"], capture_output=True, text=True, timeout=30)
        out = p.stdout.strip()
        if out:
            print("  " + out.replace("\t", "  "))
            Log.step(f"enable: `apps enable {t.id}` · disable: `apps disable {t.id}` · remove: `apps uninstall {t.id}`")
        else:
            Log.warn(f"no '{t.docker_name}' container — `apps install {t.id}` to create it")
        return 0
    folder = _apps_dir(t.id, path)
    marker = _read_app_marker(folder)
    srcdir = Path(marker.get("srcdir") or (folder / "stack"))
    if not srcdir.exists():
        Log.warn(f"no stack at {srcdir} — `apps install {t.id}` first (or pass --path)"); return 0
    _run_in(_compose_prefix(t.compose_project, t.compose_file) + ["ps"], srcdir)
    Log.step(f"enable: `apps enable {t.id} --path {folder}` · disable: `apps disable {t.id} --path {folder}` · remove: `apps uninstall {t.id} --path {folder}`")
    return 0


def _human_size_dir(p: Path) -> str:
    total = 0
    try:
        for f in p.rglob("*"):
            if f.is_file():
                try:
                    total += f.stat().st_size
                except OSError:
                    pass
    except OSError:
        return "?"
    b: float = total
    for u in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.0f}{u}"
        b /= 1024
    return f"{b:.1f}TB"


# ---- update / restart / logs / open (manager ops, no repetitive commands) --
def _update_repo_tool(t: RepoTool, osi: OSInfo, path: Optional[str]) -> int:
    Log.head(f"Update {t.name}")
    if t.kind in _ISOLATED_REPO_KINDS:
        # a fresh versioned snapshot: clone latest + reinstall into the venv; old versions kept for rollback
        base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
        if base is None:
            Log.warn("cancelled"); return 0
        root = _resolve_tool_root(base, t.id)
        if not root.exists():
            Log.warn(f"not installed at {root} — installing fresh");
        Log.info("creates a NEW version snapshot (old version preserved → `apps rollback` if needed)")
        return _install_into_layout(t, osi, base)
    docker = _docker_bin()
    if not docker:
        Log.err("docker not found"); return 2
    if t.kind == "docker-run":
        if not _confirm(f"Pull the latest {t.docker_image} and recreate the container (data volume kept)?"):
            Log.warn("declined"); return 0
        run([docker, "pull", t.docker_image], check=False)
        run([docker, "rm", "-f", t.docker_name], check=False)        # volume(s) persist → data safe
        Log.step("docker " + " ".join(t.docker_run))
        rc = run([docker, *t.docker_run], check=False).returncode
        for cmd in t.post_run:
            run(list(cmd), check=False)
        Log.ok(f"{t.name} updated to latest image") if rc == 0 else Log.err(f"recreate failed (rc={rc})")
        return 0 if rc == 0 else 1
    # compose
    folder = _apps_dir(t.id, path)
    marker = _read_app_marker(folder)
    srcdir = Path(marker.get("srcdir") or (folder / "stack"))
    if not srcdir.exists():
        Log.err(f"no stack at {srcdir} — `apps install {t.id}` first"); return 2
    if not _confirm(f"Update {t.name}: refresh compose, pull images, recreate (volumes/data kept)?"):
        Log.warn("declined"); return 0
    if t.compose_clone:                                  # repo-shipped compose → git pull
        git = shutil.which("git")
        if git and (srcdir / ".git").exists():
            _run_in([git, "pull", "--ff-only"], srcdir)
            # the pull may have brought new code — re-vet before compose runs it
            if not DRY_RUN and not enforce_gate(str(srcdir), f"{t.id} (updated stack)"):
                Log.warn("update aborted by nemesis gate"); return 1
    elif t.compose_url:                                  # url compose → re-fetch + rescan
        cf = t.compose_file or "docker-compose.yaml"
        text = _fetch_url_text(t.compose_url) if not DRY_RUN else None
        if text and not NO_SCAN:
            rep = ScanReport(t.id, t.compose_url, "compose:" + str(abs(hash(text)))[:8], _scan_text(cf, text), 0)
            if not security_gate(rep, "local"):
                Log.warn("update aborted by security gate"); return 1
        if text and not enforce_gate_text(text, f"{t.id} compose ({t.compose_url})"):
            Log.warn("update aborted by nemesis gate"); return 1
        if text:
            (srcdir / cf).write_text(text); Log.ok(f"refreshed {cf}")
    pref = _compose_prefix(t.compose_project, t.compose_file)
    _run_in(pref + ["pull"], srcdir)
    rc = _run_in(pref + ["up", "-d"], srcdir)
    Log.ok(f"{t.name} updated") if rc == 0 else Log.err(f"compose up failed (rc={rc})")
    return 0 if rc == 0 else 1


def _restart_repo(t: RepoTool, path: Optional[str]) -> int:
    if t.kind in _ISOLATED_REPO_KINDS:
        Log.info(f"{t.name} is not a long-running service — nothing to restart."); return 0
    docker = _docker_bin()
    if not docker:
        Log.err("docker not found"); return 2
    Log.head(f"Restart {t.name}")
    if t.kind == "docker-run":
        rc = run([docker, "restart", t.docker_name], check=False).returncode
        return 0 if rc == 0 else 1
    folder = _apps_dir(t.id, path)
    srcdir = Path(_read_app_marker(folder).get("srcdir") or (folder / "stack"))
    if not srcdir.exists():
        Log.err(f"no stack at {srcdir}"); return 2
    return _run_in(_compose_prefix(t.compose_project, t.compose_file) + ["restart"], srcdir)


def _logs_repo(t: RepoTool, path: Optional[str]) -> int:
    if t.kind in _ISOLATED_REPO_KINDS:
        Log.info(f"{t.name} writes no service log (it's a CLI/library)."); return 0
    docker = _docker_bin()
    if not docker:
        Log.err("docker not found"); return 2
    Log.head(f"{t.name} — last logs")
    if t.kind == "docker-run":
        return run([docker, "logs", "--tail", "80", t.docker_name], check=False).returncode
    folder = _apps_dir(t.id, path)
    srcdir = Path(_read_app_marker(folder).get("srcdir") or (folder / "stack"))
    if not srcdir.exists():
        Log.err(f"no stack at {srcdir}"); return 2
    return _run_in(_compose_prefix(t.compose_project, t.compose_file) + ["logs", "--tail", "80"], srcdir)


def _open_repo(t: RepoTool) -> int:
    if not t.port:
        Log.warn(f"{t.name} has no web UI to open"); return 0
    url = f"http://localhost:{t.port}"
    Log.ok(f"{t.name} → {url}")
    try:
        import webbrowser
        if not DRY_RUN:
            webbrowser.open(url)
    except Exception:
        pass
    return 0


def _apps_installed_overview(osi: OSInfo) -> int:
    Log.head("Self-hosted apps — what's installed / running on this machine")
    docker = _docker_bin()
    running = set()
    if docker:
        p = _run_timed([docker, "ps", "-a", "--format", "{{.Names}}\t{{.Status}}"], capture_output=True, text=True, timeout=30)
        names = {ln.split("\t")[0]: (ln.split("\t")[1] if "\t" in ln else "") for ln in p.stdout.splitlines()}
    else:
        names = {}
    for t in REPO_TOOLS:
        state = "—"
        if t.kind == "docker-run":
            st = names.get(t.docker_name)
            state = (Log._c(st, "green") if st and st.lower().startswith("up") else
                     (Log._c(st, "yellow") if st else Log._c("not installed", "dim")))
        elif t.kind == "compose":
            folder = _apps_dir(t.id, None)
            state = (Log._c("stack present (" + str(folder) + ")", "cyan")
                     if _app_marker(folder).exists() else Log._c("not installed (default dir)", "dim"))
        else:  # pip-venv
            folder = _apps_dir(t.id, None)               # default-dir probe; real installs may live elsewhere (--path)
            state = (Log._c("venv present (default dir)", "cyan")
                     if (folder / ".prometheus_tool.json").exists() else Log._c("not in default dir (use --path)", "dim"))
        print(f"  {Log._c(t.id, 'bold'):<22} [{t.kind:<10}] {state}")
    Log.step("manage any: `apps <update|restart|logs|open|status|disable|uninstall> <id> [--path DIR]`  ·  guided: `apps wizard`")
    return 0


def _apps_update_all(osi: OSInfo) -> int:
    Log.head("Update wizard — refresh installed apps")
    docker = _docker_bin()
    names = {}
    if docker:
        p = _run_timed([docker, "ps", "-a", "--format", "{{.Names}}"], capture_output=True, text=True, timeout=30)
        names = set(p.stdout.split())
    candidates = []
    for t in REPO_TOOLS:
        if t.kind == "docker-run" and t.docker_name in names:
            candidates.append(t)
        elif t.kind == "compose" and _app_marker(_apps_dir(t.id, None)).exists():
            candidates.append(t)
        elif t.kind == "pip-venv" and (_apps_dir(t.id, None) / ".prometheus_tool.json").exists():
            candidates.append(t)
    if not candidates:
        Log.warn("no installed apps detected in the default locations.")
        Log.step("if you installed with a custom --path, update one explicitly: `apps update <id> --path DIR`")
        return 0
    Log.info("detected installed: " + ", ".join(t.id for t in candidates))
    if not _confirm(f"Update all {len(candidates)} now?"):
        Log.warn("declined — update individually with `apps update <id>`"); return 0
    rc = 0
    for t in candidates:
        Log.head(f"→ {t.name}")
        rc |= _update_repo_tool(t, osi, None)
    Log.ok("update-all complete")
    return 0 if rc == 0 else 1


def _apps_wizard(osi: OSInfo) -> int:
    if not sys.stdin.isatty():
        Log.err("wizard needs an interactive terminal. Use `apps <action> <id>` directly."); return 2
    while True:
        Log.head("Apps manager — wizard")
        for i, t in enumerate(REPO_TOOLS, 1):
            print(f"  {i:>2}) {Log._c(t.id, 'bold'):<22} {t.name}  [{t.kind}]")
        print("   i) what's installed   ·   u) update-all   ·   q) quit")
        raw = input("  pick app #> ").strip().lower()
        if raw in ("q", ""):
            return 0
        if raw == "i":
            _apps_installed_overview(osi); continue
        if raw == "u":
            _apps_update_all(osi); continue
        if not raw.isdigit() or not (1 <= int(raw) <= len(REPO_TOOLS)):
            Log.warn("pick a number"); continue
        t = REPO_TOOLS[int(raw) - 1]
        acts = (["install", "update", "versions", "rollback", "status", "uninstall"] if t.kind == "pip-venv"
                else ["install", "update", "versions", "rollback", "enable", "disable", "restart",
                      "status", "logs", "open", "uninstall"])
        Log.head(f"{t.name} — actions")
        for i, a in enumerate(acts, 1):
            print(f"  {i:>2}) {a}")
        print("   b) back")
        sel = input(f"  {t.id} action #> ").strip().lower()
        if sel in ("b", "q", ""):
            continue
        if not sel.isdigit() or not (1 <= int(sel) <= len(acts)):
            Log.warn("pick a number"); continue
        action = acts[int(sel) - 1]
        path = None
        if t.kind in ("pip-venv", "compose"):
            pin = input(f"  folder (--path) [Enter = default {_apps_dir(t.id, None)}]> ").strip()
            path = pin or (str(_apps_dir(t.id, None)) if t.kind == "compose" else None)
        version = None
        if action == "rollback":
            _versions_repo(t, path)                       # show what's available first
            version = input("  rollback to version/tag> ").strip() or None
        _apps_run_action(t, osi, action, path, version)
        input("  ↵ to return to the wizard ")


# ---- versions / rollback for EVERY kind (pip snapshot · docker tag · compose tag) ----
def _versions_repo(t: RepoTool, path: Optional[str]) -> int:
    if t.kind in _ISOLATED_REPO_KINDS:
        base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
        if base is None:
            Log.warn("cancelled"); return 0
        return _tool_versions(t, base)
    docker = _docker_bin()
    if t.kind == "docker-run":
        Log.head(f"{t.name} — image versions you can roll to")
        if docker:
            p = _run_timed([docker, "image", "ls", t.docker_image, "--format", "{{.Repository}}:{{.Tag}}\t{{.Size}}"],
                               capture_output=True, text=True, timeout=30)
            if p.stdout.strip():
                Log.info("locally pulled tags:")
                print("  " + p.stdout.strip().replace("\t", "  "))
            else:
                Log.step("no tags pulled locally yet")
        Log.step(f"any published tag works: `apps rollback {t.id} --version <tag>` (e.g. a release like 1.x). Tags: {t.repo}/releases or Docker Hub.")
        return 0
    # compose
    folder = _apps_dir(t.id, path)
    srcdir = Path(_read_app_marker(folder).get("srcdir") or (folder / "stack"))
    Log.head(f"{t.name} — versions you can roll to")
    if t.compose_clone and (srcdir / ".git").exists():
        git = shutil.which("git")
        if git:
            p = _run_timed([git, "-C", str(srcdir), "tag", "--sort=-creatordate"], capture_output=True, text=True, timeout=30)
            tags = [x for x in p.stdout.split()][:15]
            if tags:
                Log.info("recent upstream tags (git):")
                print("  " + "  ".join(tags))
        Log.step(f"roll to one: `apps rollback {t.id} --version <tag> --path {folder}` (git checkout + redeploy)")
    elif t.version_env:
        Log.step(f"pin any release: `apps rollback {t.id} --version <ver> --path {folder}` "
                 f"(sets {t.version_env} + redeploys). Releases: {t.repo}/releases")
    else:
        Log.step(f"rollback = pin the image tag in {srcdir}/{t.compose_file or 'compose file'}; releases at {t.repo}/releases")
    return 0


def _rollback_repo(t: RepoTool, osi: OSInfo, path: Optional[str], version: Optional[str]) -> int:
    if t.kind in _ISOLATED_REPO_KINDS:
        base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
        if base is None:
            Log.warn("cancelled — no folder chosen"); return 0
        ver = version
        if ver is not None:
            try:
                ver = int(ver)
            except (TypeError, ValueError):
                Log.err(f"--version must be an integer (e.g. 1, 2). Got: {ver!r}"); return 2
        return _rollback_tool(t, base, ver)                  # engine-snapshot rollback (offline)
    if not version:
        Log.err(f"rollback needs a target: `apps rollback {t.id} --version <tag/release>` (see `apps versions {t.id}`)"); return 2
    docker = _docker_bin()
    if not docker:
        Log.err("docker not found"); return 2
    if t.kind == "docker-run":
        image_tag = f"{t.docker_image}:{version}"
        Log.head(f"Rollback {t.name} → {image_tag}")
        if not _confirm(f"Pull {image_tag} and recreate the container (data volume kept)?"):
            Log.warn("declined"); return 0
        if run([docker, "pull", image_tag], check=False).returncode != 0:
            Log.err(f"could not pull {image_tag} — check the tag (`apps versions {t.id}`)"); return 1
        run([docker, "rm", "-f", t.docker_name], check=False)        # volume(s) persist → data safe
        run_argv = [a if a != t.docker_image else image_tag for a in t.docker_run]
        Log.step("docker " + " ".join(run_argv))
        rc = run([docker, *run_argv], check=False).returncode
        Log.ok(f"{t.name} rolled back to {version}") if rc == 0 else Log.err(f"recreate failed (rc={rc})")
        return 0 if rc == 0 else 1
    # compose
    folder = _apps_dir(t.id, path)
    srcdir = Path(_read_app_marker(folder).get("srcdir") or (folder / "stack"))
    if not srcdir.exists():
        Log.err(f"no stack at {srcdir} — `apps install {t.id}` first"); return 2
    pref = _compose_prefix(t.compose_project, t.compose_file)
    Log.head(f"Rollback {t.name} → {version}")
    if t.compose_clone and (srcdir / ".git").exists():
        git = shutil.which("git")
        if not git:
            Log.err("git not found"); return 2
        if not _confirm(f"git checkout {version} and redeploy (data volumes kept)?"):
            Log.warn("declined"); return 0
        if _run_in([git, "checkout", version], srcdir) != 0:
            Log.err(f"git checkout {version} failed — see `apps versions {t.id}` for valid tags"); return 1
        # the install gate only ever saw HEAD — an older tag is new (to the gate)
        # code and runs via compose, so re-vet it before deploying
        if not DRY_RUN and not enforce_gate(str(srcdir), f"{t.id} (rollback {version})"):
            Log.err(f"rollback blocked by nemesis gate — tree left at {version}; "
                    f"inspect with: nemesis ui {srcdir}")
            return 1
        _run_in(pref + ["pull"], srcdir)
        rc = _run_in(pref + ["up", "-d"], srcdir)
    elif t.version_env:
        if not _confirm(f"set {t.version_env}={version} and redeploy?"):
            Log.warn("declined"); return 0
        _run_env(pref + ["pull"], {t.version_env: version}, cwd=srcdir)
        rc = _run_env(pref + ["up", "-d"], {t.version_env: version}, cwd=srcdir)
    else:
        Log.err(f"{t.name}: pin the image tag manually in {srcdir}/{t.compose_file or 'the compose file'} then "
                f"`apps update {t.id}`. (No automatic tag rollback for this stack.)"); return 2
    Log.ok(f"{t.name} rolled back to {version}") if rc == 0 else Log.err(f"redeploy failed (rc={rc})")
    return 0 if rc == 0 else 1


def _apps_run_action(t: RepoTool, osi: OSInfo, action: str, path: Optional[str], version: Optional[str]) -> int:
    if action == "install":
        return _install_repo_tool(t, osi, path)
    if action == "uninstall":
        return _uninstall_repo_tool(t, path)
    if action == "update":
        return _update_repo_tool(t, osi, path)
    if action == "enable":
        return _service_repo(t, path, True)
    if action == "disable":
        return _service_repo(t, path, False)
    if action == "restart":
        return _restart_repo(t, path)
    if action == "status":
        return _status_repo_tool(t, path)
    if action == "logs":
        return _logs_repo(t, path)
    if action == "open":
        return _open_repo(t)
    if action == "versions":
        return _versions_repo(t, path)
    if action == "rollback":
        return _rollback_repo(t, osi, path, version)
    Log.err(f"unknown action: {action}"); return 2


def cmd_apps(args, osi: OSInfo) -> int:
    action = getattr(args, "action", None) or "list"
    if action == "list":  # human-table READ; --json → bridge-safe envelope (was bad_json)
        return emit_table_json("apps", _print_repo_tools, action="list")
    if action == "wizard":
        return _apps_wizard(osi)
    if action == "installed":
        return emit_console_json("apps", lambda: _apps_installed_overview(osi), action="installed")
    if action == "update-all":
        return _apps_update_all(osi)
    if not getattr(args, "tool", None):
        Log.err(f"usage: apps {action} <id>  (see `apps list`, or `apps wizard`)"); return 2
    t = repo_tool_registry().get(args.tool)
    if not t:
        Log.err(f"unknown app: {args.tool}. Try: apps list"); return 2
    # status/versions/logs are READ actions the MCP bridge calls: they must land as an envelope.
    if action in ("status", "versions", "logs"):
        return emit_console_json(
            "apps",
            lambda: _apps_run_action(
                t, osi, action, getattr(args, "path", None), getattr(args, "version", None)
            ),
            action=action,
            tool=t.id,
        )
    return _apps_run_action(t, osi, action, getattr(args, "path", None), getattr(args, "version", None))


# ============================================================================
#  SECTION 6G — WORLD SIMULATION & UNDERSTANDING  (the 8th functionality)
# ----------------------------------------------------------------------------
#  A SEPARATE, themed track for "world models" / agent-based social-simulation &
#  forecasting engines: tools that spin up a parallel digital world full of
#  LLM-driven agents, let it run, and read the emergent behaviour back as a
#  prediction / understanding of the real system.
#
#  These are self-hosted web apps (docker-compose stacks), so they REUSE the
#  whole RepoTool lifecycle from SECTION 6D (install · uninstall · enable ·
#  disable · restart · status · logs · open · update · versions · rollback) and
#  the SAME safest-path-first rules — but they live under their own roof
#  (~/.config/prometheus/worldsim/<id>) and answer to their own `worldsim`
#  command, so the section reads as one coherent capability. The Repo Vault
#  (SECTION 6F) archives them automatically.
#
#  COST/THREAT NOTE: these engines drive an OpenAI-compatible LLM. Prometheus
#  never writes your real keys — only ${PLACEHOLDERS} into the stack's .env —
#  and always points out the local-endpoint (Ollama / self-host) path so the
#  whole thing can run with ZERO cloud billing. Extend by appending a RepoTool.
# ============================================================================
WORLDSIM_TOOLS: list[RepoTool] = [
    # ---- MiroFish — multi-agent "parallel digital world" prediction engine ----
    RepoTool(
        id="mirofish", name="MiroFish", category="world-sim",
        repo="https://github.com/666ghj/MiroFish",
        blurb="AI prediction engine that spins up a high-fidelity parallel digital world of thousands of LLM agents: feed it seed material + a plain-language question and it 'rehearses the future' in a sandbox (opinion dynamics, event spread, story what-ifs) and reads back a forecast. Python backend + Vue frontend.",
        kind="compose", compose_clone="https://github.com/666ghj/MiroFish.git",
        compose_project="mirofish",
        env_copy=".env.example", needs_secrets=True, auto_up=False, port="3000",
        recommend="official Docker Compose stack (bundles the Python backend + Vue frontend) in a folder you pick — no host Node/uv/Python touched; disable = `compose down`, uninstall = `down -v` + delete the folder.",
        security="Official upstream compose. Copies `.env.example`→`.env` for you to edit; the stack reaches an external LLM API + (optionally) Zep at RUNTIME based on that .env. Put auth + a reverse proxy in front before exposing :3000/:5001 — agent runs can be costly and the UI is unauthenticated by default.",
        secrets_note="You paste your own keys into .env — Prometheus writes only the ${PLACEHOLDER} template. Needs an LLM API key (OpenAI-compatible; upstream recommends Alibaba Qwen) + a Zep key for agent memory. BILLING-FREE PATH: point the LLM base-URL at a local Ollama / LM-Studio / mythos endpoint and self-host Zep (Community Edition) instead of Zep Cloud — then no paid cloud account is required. Open-model picks: `localai models` (local gpt-oss/qwen3, or a big open model like Kimi K2 / DeepSeek / Qwen3-235B via an OpenAI-compatible API).",
        safest_alt="Source path (NOT used by default — it touches the host): `cp .env.example .env && npm run setup:all && npm run dev` (needs Node 18+, Python 3.11–3.12 and the `uv` package manager). The compose path here keeps everything in containers for clean removal.",
        warnings=("an agent simulation calls the LLM thousands of times per run — set spend limits or use a local endpoint, and never expose the unauthenticated UI publicly",
                  "the source path pins Python strictly (>=3.11,<=3.12); the compose path sidesteps that"),
        post_notes=("1) edit the .env in the stack folder: set your LLM API key/base-URL (or a local Ollama URL) + Zep key",
                    "2) start it: `worldsim enable mirofish --path <your-folder>`  (frontend → http://localhost:3000, backend → http://localhost:5001)",
                    "3) to avoid cloud billing: set the OpenAI-compatible base-URL to your local model server and self-host Zep CE"),
        docs="world-simulation (666ghj/MiroFish)",
    ),
    # >>> APPEND MORE WORLD-SIMULATION / WORLD-MODEL ENGINES HERE <<<
]


def worldsim_tool_registry() -> dict[str, RepoTool]:
    return {t.id: t for t in WORLDSIM_TOOLS}


def _worldsim_root() -> Path:
    return PROM_DIR / "worldsim"


def _worldsim_dir(tool: str, path: Optional[str]) -> Path:
    base = Path(os.path.expanduser(path)) if path else _worldsim_root()
    return base if base.name == tool else base / tool


def _worldsim_path(t: RepoTool, path: Optional[str]) -> Optional[str]:
    """Default compose/venv installs under the worldsim roof (not the apps roof)."""
    if path:
        return path
    if t.kind in ("compose", "pip-venv"):
        return str(_worldsim_dir(t.id, None))
    return None


def _print_worldsim_tools() -> None:
    Log.head("World Simulation & Understanding — agent-based world-model / forecasting engines")
    for t in WORLDSIM_TOOLS:
        tag = Log._c(f"[{t.category}]", "yellow")
        kt = Log._c("docker-compose stack (folder you pick)" if t.kind == "compose" else t.kind, "magenta")
        print(f"  {tag} {Log._c(t.id, 'bold')} — {t.name}   {kt}")
        print(f"      {t.blurb}")
        print(f"      {Log._c('safest: ' + t.recommend, 'green')}")
        if t.port:
            print(f"      {Log._c('serves on :' + t.port, 'dim')}")
        print(f"      {Log._c(t.repo, 'dim')}")
    Log.step("install: `worldsim install <id> [--path DIR]`  ·  uninstall: `worldsim uninstall <id> [--path DIR]`")
    Log.step("services: `worldsim enable|disable|restart|logs|open|status <id> [--path DIR]`  ·  versions/rollback: `worldsim update|versions|rollback <id>`")
    Log.step("guided: `worldsim wizard`  ·  overview: `worldsim installed`  ·  default home: " + str(_worldsim_root()))


def _worldsim_installed_overview(osi: OSInfo) -> int:
    Log.head("World-sim engines — what's installed on this machine")
    for t in WORLDSIM_TOOLS:
        folder = _worldsim_dir(t.id, None)
        state = (Log._c("stack present (" + str(folder) + ")", "cyan")
                 if _app_marker(folder).exists() else Log._c("not installed (default dir)", "dim"))
        print(f"  {Log._c(t.id, 'bold'):<22} [{t.kind:<10}] {state}")
    Log.step("manage any: `worldsim <enable|disable|logs|status|uninstall> <id> [--path DIR]`  ·  guided: `worldsim wizard`")
    return 0


def _worldsim_wizard(osi: OSInfo) -> int:
    if not sys.stdin.isatty():
        Log.err("wizard needs an interactive terminal. Use `worldsim <action> <id>` directly."); return 2
    while True:
        Log.head("World Simulation manager — wizard")
        for i, t in enumerate(WORLDSIM_TOOLS, 1):
            print(f"  {i:>2}) {Log._c(t.id, 'bold'):<22} {t.name}  [{t.kind}]")
        print("   i) what's installed   ·   q) quit")
        raw = input("  pick engine #> ").strip().lower()
        if raw in ("q", ""):
            return 0
        if raw == "i":
            _worldsim_installed_overview(osi); continue
        if not raw.isdigit() or not (1 <= int(raw) <= len(WORLDSIM_TOOLS)):
            Log.warn("pick a number"); continue
        t = WORLDSIM_TOOLS[int(raw) - 1]
        acts = ["install", "update", "versions", "rollback", "enable", "disable",
                "restart", "status", "logs", "open", "uninstall"]
        Log.head(f"{t.name} — actions")
        for i, a in enumerate(acts, 1):
            print(f"  {i:>2}) {a}")
        print("   b) back")
        sel = input(f"  {t.id} action #> ").strip().lower()
        if sel in ("b", "q", ""):
            continue
        if not sel.isdigit() or not (1 <= int(sel) <= len(acts)):
            Log.warn("pick a number"); continue
        action = acts[int(sel) - 1]
        pin = input(f"  folder (--path) [Enter = default {_worldsim_dir(t.id, None)}]> ").strip()
        path = pin or str(_worldsim_dir(t.id, None))
        version = None
        if action == "rollback":
            _versions_repo(t, path)
            version = input("  rollback to version/tag> ").strip() or None
        _apps_run_action(t, osi, action, path, version)
        input("  ↵ to return to the wizard ")


def cmd_worldsim(args, osi: OSInfo) -> int:
    action = getattr(args, "action", None) or "list"
    if action == "list":
        # human-table READ; under --json emit the SAME bridge-safe `lines[]` envelope its
        # siblings do (`apps list`, `models list`, `inventory`). It was the only one of the four
        # still printing raw text under --json, so a consumer that asked for JSON got something
        # that is not JSON — the exact `error (bad_json)` case emit_table_json exists to prevent.
        return emit_table_json("worldsim", _print_worldsim_tools, action="list")
    if action == "wizard":
        return _worldsim_wizard(osi)
    if action == "installed":
        return emit_console_json(
            "worldsim", lambda: _worldsim_installed_overview(osi), action="installed"
        )
    if not getattr(args, "tool", None):
        Log.err(f"usage: worldsim {action} <id>  (see `worldsim list`, or `worldsim wizard`)"); return 2
    t = worldsim_tool_registry().get(args.tool)
    if not t:
        Log.err(f"unknown world-sim engine: {args.tool}. Try: worldsim list"); return 2
    path = _worldsim_path(t, getattr(args, "path", None))
    # status/versions/logs are READ actions the MCP bridge calls: they must land as an envelope.
    if action in ("status", "versions", "logs"):
        return emit_console_json(
            "worldsim",
            lambda: _apps_run_action(t, osi, action, path, getattr(args, "version", None)),
            action=action,
            tool=t.id,
        )
    return _apps_run_action(t, osi, action, path, getattr(args, "version", None))


# ============================================================================
#  SECTION 6H — LOCAL-AI / BILLING-FREE AUDIT  (turn paid API calls into FREE
#               local OpenAI-compatible models)
# ----------------------------------------------------------------------------
#  Many AI repos default to a PAID cloud API (OpenAI/Anthropic/DeepSeek/…) that
#  bills per call. Almost all of them speak the OpenAI "chat/completions" wire
#  format, so they can be re-pointed at a FREE local model server (Ollama,
#  LM-Studio, llama.cpp, vLLM, or a self-hosted "mythos" gateway) exposing the
#  SAME OpenAI-compatible endpoint — usually by changing ONE base-URL env var +
#  a throwaway key. This section AUDITS every AI tool Prometheus manages
#  (paid-API vs already-local vs patchable) and prints the exact local recipe.
#  Prometheus still writes NO real keys — only non-secret base-URLs and a dummy
#  ${KEY}=ollama placeholder — the same secret rule as everywhere else.
# ============================================================================

# OpenAI-compatible base-URLs for common FREE local model servers.
LOCAL_AI_ENDPOINTS: dict[str, str] = {
    "ollama":   "http://localhost:11434/v1",   # `ollama serve` (in Docker: http://host.docker.internal:11434/v1)
    "lmstudio": "http://localhost:1234/v1",     # LM Studio local server
    "llamacpp": "http://localhost:8080/v1",     # llama.cpp ./llama-server
    "vllm":     "http://localhost:8000/v1",     # vLLM OpenAI server
    "mythos":   "http://localhost:11434/v1",    # self-hosted mythos gateway (Ollama-backed)
}
# In a Docker container, localhost is the container — reach a host model server via:
_HOST_OLLAMA = "http://host.docker.internal:11434/v1"

# OPEN-WEIGHT model API endpoints (OpenAI-compatible). NOT the same as the FREE
# local servers above: these BILL per call (most have a free tier), but they
# serve OPEN-SOURCE models — far cheaper than closed GPT/Claude, swappable, and
# self-hostable (no vendor lock-in). Use them for the BIG open models (Kimi K2,
# DeepSeek-V3, Qwen3-235B, GLM-4.6) that are too large to run on a laptop; for a
# true $0, self-host the same open weights on your own GPU box (vLLM/SGLang) and
# point the SAME base-URL var there instead.
OPEN_AI_ENDPOINTS: dict[str, str] = {
    # first-party (the model author's own OpenAI-compatible API)
    "moonshot":    "https://api.moonshot.ai/v1",                              # Kimi K2 (Moonshot)
    "deepseek":    "https://api.deepseek.com",                               # DeepSeek V3 / R1
    "dashscope":   "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",  # Qwen3 (Alibaba)
    "zai":         "https://api.z.ai/api/paas/v4",                           # GLM-4.6 (Zhipu / Z.ai)
    # aggregators (host MANY open models; free tiers + pay-as-you-go)
    "openrouter":  "https://openrouter.ai/api/v1",
    "groq":        "https://api.groq.com/openai/v1",
    "together":    "https://api.together.xyz/v1",
    "fireworks":   "https://api.fireworks.ai/inference/v1",
    "deepinfra":   "https://api.deepinfra.com/v1/openai",
    "siliconflow": "https://api.siliconflow.cn/v1",
    "nvidia":      "https://integrate.api.nvidia.com/v1",                     # NVIDIA NIM (build.nvidia.com) — free tier, all Nemotron open models
}


@dataclass(frozen=True)
class OpenModel:
    id: str
    name: str
    license: str
    params: str                       # rough size / architecture
    local: str                        # "yes" fits consumer HW · "small" only small/distill sizes · "no" server-class
    ollama: str = ""                  # `ollama pull` tag for the locally-runnable size ("" = not a practical local pull)
    served: str = ""                  # OpenAI-compatible model id when called via an API
    endpoints: tuple[str, ...] = ()   # keys into OPEN_AI_ENDPOINTS that serve it
    note: str = ""


# Curated OPEN-SOURCE model catalog. Any of these drops into the PATCH→LOCAL tools:
#   local-free  → `ollama pull <tag>`, then use <tag> as the model + a local base-URL ($0)
#   big open    → use <served> as the model + point the tool's base-URL var at one of
#                 <endpoints> (open weights, cheaper than closed, self-hostable)
OPEN_MODELS: list[OpenModel] = [
    OpenModel("gpt-oss", "gpt-oss (OpenAI open-weight)", "Apache-2.0", "20B / 120B MoE", "yes",
              ollama="gpt-oss:20b", served="openai/gpt-oss-120b",
              endpoints=("groq", "openrouter", "together", "fireworks", "deepinfra"),
              note="gpt-oss:20b fits ~16GB → strong local default; 120b needs ~80GB or a served endpoint."),
    OpenModel("qwen3", "Qwen3 (Alibaba)", "Apache-2.0", "0.6B–32B dense + 30B/235B MoE", "yes",
              ollama="qwen3:8b", served="qwen3-235b-a22b",
              endpoints=("dashscope", "openrouter", "together", "siliconflow", "deepinfra"),
              note="small/mid sizes run locally; the 235B MoE flagship via a served endpoint."),
    OpenModel("llama3", "Llama 3.1 / 3.3 (Meta)", "Llama Community", "8B / 70B / 405B", "yes",
              ollama="llama3.1:8b", served="meta-llama/Llama-3.3-70B-Instruct",
              endpoints=("groq", "together", "fireworks", "deepinfra", "openrouter"),
              note="llama3.1:8b is a solid local default; 70B/405B via a served endpoint."),
    OpenModel("mistral", "Mistral / Mixtral", "Apache-2.0", "7B / 8x7B / 8x22B", "yes",
              ollama="mistral", served="mistralai/Mixtral-8x7B-Instruct-v0.1",
              endpoints=("together", "fireworks", "deepinfra", "openrouter"),
              note="fully Apache-2.0; 7B runs locally, the Mixtral MoEs via a served endpoint."),
    OpenModel("gemma3", "Gemma 3 (Google)", "Gemma Terms", "1B / 4B / 12B / 27B", "yes",
              ollama="gemma3", served="google/gemma-3-27b-it",
              endpoints=("openrouter", "together", "deepinfra"),
              note="open weights; 4B/12B run locally, 27B local on a big GPU or served."),
    OpenModel("deepseek-r1", "DeepSeek-R1 (reasoning)", "MIT", "671B MoE (+ 1.5–70B distills)", "small",
              ollama="deepseek-r1:8b", served="deepseek-reasoner",
              endpoints=("deepseek", "openrouter", "together", "fireworks", "siliconflow"),
              note="local distills (1.5–70B) run on consumer HW; the full 671B reasoner via a served endpoint."),
    OpenModel("deepseek-v3", "DeepSeek-V3 (chat)", "MIT", "671B MoE / 37B active", "no",
              served="deepseek-chat",
              endpoints=("deepseek", "openrouter", "together", "fireworks", "siliconflow"),
              note="server-class; self-host on a multi-GPU box (vLLM/SGLang) or use a served endpoint."),
    OpenModel("kimi-k2", "Kimi K2 / K2 Thinking (Moonshot)", "Modified MIT", "~1T MoE / 32B active", "no",
              served="kimi-k2-thinking",
              endpoints=("moonshot", "groq", "openrouter", "together", "fireworks", "siliconflow"),
              note="\"Kimi 2.x\" = the Kimi K2 family (K2 Thinking = latest reasoner). Too big for a laptop → served endpoint, or self-host the open weights."),
    OpenModel("glm-4.6", "GLM-4.6 (Zhipu / Z.ai)", "MIT", "355B MoE (+ 9B dense)", "small",
              ollama="glm4:9b", served="glm-4.6",
              endpoints=("zai", "openrouter", "siliconflow", "deepinfra"),
              note="GLM-4 9B runs locally; the GLM-4.6 flagship via a served endpoint."),
    OpenModel("doubao-seed-oss", "Doubao / Seed-OSS-36B (ByteDance)", "Apache-2.0", "36B dense (Seed-OSS open weights)", "small",
              ollama="", served="",
              note="ByteDance's OPEN release = Seed-OSS-36B — run locally via LM Studio / llama.cpp (GGUF, ~20GB+ at 4-bit). The hosted 'Doubao' chat models are a SEPARATE paid Volcengine cloud API; no official ollama tag."),
    # ---- NVIDIA Nemotron (build.nvidia.com open-weight family) ----
    OpenModel("nemotron", "NVIDIA Nemotron (Nano / Super / Ultra)", "NVIDIA Open Model License", "4B–12B Nano · 49B Super · 253B Ultra · 30B/120B MoE", "yes",
              ollama="nemotron-mini:4b", served="nvidia/llama-3.3-nemotron-super-49b-v1.5",
              endpoints=("nvidia", "openrouter", "deepinfra"),
              note="NVIDIA's open reasoning family (Nemotron-H hybrid Mamba-Transformer + NAS-compressed Llama-Nemotron). Nano 4–12B run locally; Super-49B / Ultra-253B via the free NVIDIA NIM endpoint (build.nvidia.com). Commercial-friendly NVIDIA Open Model License. ollama: nemotron-mini, nemotron, nemotron-3-nano, nemotron-3-super."),
    OpenModel("qwen3-coder", "Qwen3-Coder (Alibaba)", "Apache-2.0", "30B-A3B MoE + 480B-A35B MoE", "yes",
              ollama="qwen3-coder:30b", served="qwen3-coder-480b-a35b-instruct",
              endpoints=("dashscope", "together", "fireworks", "openrouter", "deepinfra"),
              note="agentic SWE coder; the 30B-A3B MoE runs on a single 24GB GPU, the 480B flagship via a served endpoint. Fully Apache-2.0, 256K context."),
    OpenModel("qwen2.5-coder", "Qwen2.5-Coder (Alibaba)", "Apache-2.0 (7B/14B/32B) · Qwen-Research (≤3B)", "0.5B–32B dense", "yes",
              ollama="qwen2.5-coder:7b", served="Qwen/Qwen2.5-Coder-32B-Instruct",
              endpoints=("together", "fireworks", "openrouter", "deepinfra", "siliconflow"),
              note="best-in-class local coder; 7B/14B/32B are Apache-2.0 (the 0.5–3B tags are Qwen-Research = non-commercial). 32B ≈ GPT-4o-class on code."),
    OpenModel("devstral", "Devstral (Mistral agentic coder)", "Apache-2.0 (Small) · modified-MIT (123B)", "24B Small + 123B", "yes",
              ollama="devstral:24b", served="mistralai/Devstral-Small-2507",
              endpoints=("together", "fireworks", "openrouter", "deepinfra"),
              note="purpose-built agentic software-engineering model (top open SWE-bench Verified at release); Devstral Small 24B runs on a single 4090 / 32GB Mac, Apache-2.0."),
    OpenModel("phi4", "Phi-4 (Microsoft)", "MIT", "3.8B mini · 14B · reasoning variants", "yes",
              ollama="phi4:14b", served="microsoft/phi-4",
              endpoints=("openrouter", "deepinfra"),
              note="MIT-licensed; Phi-4-mini 3.8B (128K ctx) runs on modest machines, Phi-4 14B is strong at math/reasoning. Phi-4-reasoning / mini-reasoning add chain-of-thought."),
    OpenModel("granite", "IBM Granite 3.x", "Apache-2.0", "2B–8B dense + 3B/34B (MoE/code)", "yes",
              ollama="granite3.3:8b", served="ibm-granite/granite-3.3-8b-instruct",
              endpoints=("openrouter", "together", "deepinfra"),
              note="fully Apache-2.0 enterprise family (128K ctx, RAG/tool-use); Granite-Code 3B–34B for coding. IBM-supported, permissive."),
    OpenModel("mistral-nemo", "Mistral NeMo 12B (NVIDIA+Mistral)", "Apache-2.0", "12B dense", "yes",
              ollama="mistral-nemo:12b", served="mistralai/Mistral-Nemo-Instruct-2407",
              endpoints=("together", "fireworks", "openrouter", "deepinfra", "nvidia"),
              note="joint NVIDIA+Mistral 12B, Apache-2.0, 128K context, strong multilingual; runs locally on a 16GB GPU."),
    OpenModel("llama4", "Llama 4 Scout / Maverick (Meta)", "Llama 4 Community", "Scout 109B-A17B MoE · Maverick 400B-A17B MoE", "no",
              ollama="", served="meta-llama/Llama-4-Scout-17B-16E-Instruct",
              endpoints=("together", "fireworks", "groq", "openrouter", "deepinfra"),
              note="natively multimodal MoE; Scout's 10M-token context is class-leading but server-class (≥1 H100). ollama `llama4:scout`/`llama4:maverick` exist for big rigs; otherwise a served endpoint."),
    OpenModel("command-r", "Cohere Command R / R+ / A", "CC-BY-NC-4.0 (NON-COMMERCIAL)", "35B R · 104B R+ · 111B A", "small",
              ollama="command-r", served="command-r-plus",
              endpoints=("openrouter",),
              note="NON-COMMERCIAL (CC-BY-NC-4.0) — research/eval only. Best-in-class RAG + tool-use; Command R 35B runs locally, R+/A via a served endpoint. Do NOT ship commercially."),
    OpenModel("olmo2", "OLMo 2 (Allen AI, fully open)", "Apache-2.0", "13B · 32B (open data + code)", "yes",
              ollama="olmo2:13b", served="allenai/OLMo-2-0325-32B-Instruct",
              endpoints=("openrouter",),
              note="FULLY open (weights + training data + code), Apache-2.0 — the most reproducible option; 13B runs locally."),
    OpenModel("smollm2", "SmolLM2 (HuggingFace, edge)", "Apache-2.0", "135M · 360M · 1.7B", "yes",
              ollama="smollm2:1.7b", served="",
              note="tiny Apache-2.0 family for truly low-resource / edge / on-device; 135M–1.7B."),
]


def _open_model_index() -> dict[str, OpenModel]:
    return {m.id: m for m in OPEN_MODELS}


@dataclass(frozen=True)
class AIBilling:
    tool: str
    name: str
    track: str                 # which command manages it: apps | worldsim | pentest | models
    mode: str                  # local | hybrid | api | scanner | cloud | n/a
    patchable: bool            # can a PAID API be swapped for a FREE local OpenAI-compatible model?
    recipe: str = ""           # the exact env / flag change that points it at a local model
    note: str = ""             # one-line caveat


# Audit of EVERY AI-using repo Prometheus manages. mode:
#   local   — only ever runs free local models (no external billing possible)
#   hybrid  — supports cloud OR local out of the box; the local path is already wired
#   api     — defaults to a PAID cloud API but is PATCHABLE to a free local one
#   scanner — an LLM-tester; "free" = aim it at a LOCAL target model
#   cloud   — needs a frontier / commercial cloud; NO free-local equivalent
#   n/a     — AI lives in the user's editor / not an LLM caller Prometheus drives
AI_BILLING: list[AIBilling] = [
    # ---- inherently local (zero external billing) ----
    AIBilling("ollama", "Ollama", "apps", "local", False,
              note="IS the local OpenAI-compatible model server the others point at (:11434)."),
    AIBilling("ollama-python", "Ollama Python", "apps", "local", False,
              note="client library for a local Ollama — no cloud calls."),
    AIBilling("fooocus", "Fooocus", "apps", "local", False,
              note="local Stable-Diffusion image gen — runs on your GPU, no API."),
    AIBilling("whisper", "Whisper", "apps", "local", False,
              note="OpenAI Whisper open weights run locally — no API calls."),
    AIBilling("airllm", "AirLLM", "models", "local", False,
              note="streams local HF weights off disk — no external API."),
    AIBilling("odysseus", "Odysseus", "models", "local", False,
              note="self-hosted workspace that bundles its own local Ollama (:11434)."),
    # ---- hybrid: local path already wired upstream ----
    AIBilling("n8n", "n8n", "apps", "hybrid", True,
              recipe="use the Ollama node, or set any OpenAI/LangChain credential's Base-URL to " + LOCAL_AI_ENDPOINTS["ollama"] + " (key: any).",
              note="AI is user-built workflows; cloud nodes bill, the Ollama node is free."),
    AIBilling("appflowy", "AppFlowy", "apps", "hybrid", True,
              recipe="use AppFlowy desktop's 'Local AI' (Ollama) for free AI, or give the cloud AI service your own OpenAI-compatible key.",
              note="AI is optional; the workspace itself needs no AI."),
    AIBilling("ptai", "pentest-ai (ptai)", "pentest", "hybrid", True,
              recipe="PENTEST_AI_LLM_PROVIDER=ollama (local, no key) instead of an Anthropic/OpenAI key.",
              note="local provider already supported upstream."),
    AIBilling("pluto", "Pluto", "pentest", "hybrid", True,
              recipe="point Pluto at Ollama (local, no key) instead of ${ANTHROPIC_API_KEY}/${OPENAI_API_KEY}.",
              note="local Ollama already supported upstream."),
    AIBilling("swarm", "Pentest Swarm AI", "pentest", "hybrid", True,
              recipe="config.yaml → provider: ollama|lmstudio + endpoint: " + LOCAL_AI_ENDPOINTS["ollama"] + "  (no API billing).",
              note="provider-agnostic; local endpoint = zero billing."),
    # ---- api: paid by default, PATCHABLE to a free local OpenAI-compatible model ----
    AIBilling("mirofish", "MiroFish", "worldsim", "api", True,
              recipe="in .env set the OpenAI-compatible base-URL to " + _HOST_OLLAMA + " + key=ollama (local gpt-oss/qwen3, $0), OR to an open-weight API for a big model (Kimi K2/DeepSeek/Qwen3-235B); self-host Zep CE for memory.",
              note="an agent sim calls the LLM thousands of times/run — local or an open-weight API avoids huge bills. Models: `localai models`."),
    AIBilling("pentestgpt", "PentestGPT", "pentest", "api", True,
              recipe="export OPENAI_BASEURL=" + LOCAL_AI_ENDPOINTS["ollama"] + " OPENAI_API_KEY=ollama ; `pentestgpt --reasoning_model <gpt-oss|qwen3>` ($0). Big open: point OPENAI_BASEURL at an open-weight API + model kimi-k2-thinking/deepseek-reasoner.",
              note="honors a custom OpenAI base-URL → any local server or open-weight API. Models: `localai models`."),
    AIBilling("strix", "Strix", "pentest", "api", True,
              recipe="export STRIX_LLM=openai/<gpt-oss|qwen3> LLM_API_KEY=ollama LLM_API_BASE=" + LOCAL_AI_ENDPOINTS["ollama"] + " ($0); or point LLM_API_BASE at an open-weight API for Kimi K2/DeepSeek.",
              note="LiteLLM-based; LLM_API_BASE re-points it at a local server or open-weight API. Models: `localai models`."),
    AIBilling("hunter", "Hunter", "pentest", "api", True,
              recipe="workspace .env: DEFAULT_BASE_URL=" + LOCAL_AI_ENDPOINTS["ollama"] + " DEFAULT_API_KEY=ollama + model gpt-oss/qwen3 ($0); or DEFAULT_BASE_URL=an open-weight API for Kimi K2/DeepSeek.",
              note="DeepSeek default is OpenAI-compatible — just swap the base-URL. Models: `localai models`."),
    AIBilling("pentagi", "PentAGI", "pentest", "api", True,
              recipe="in .env point the Custom/OpenAI-compatible provider group (LLM_SERVER_URL/KEY/MODEL) at " + _HOST_OLLAMA + " (local gpt-oss/qwen3, $0) or at an open-weight API for a big model (Kimi K2/DeepSeek).",
              note="runs in Docker → use host.docker.internal for a host Ollama. Models: `localai models`."),
    # ---- scanner: 'free' = aim it at a LOCAL target model ----
    AIBilling("garak", "garak (LLM red-team)", "pentest", "scanner", True,
              recipe="scan a LOCAL target ($0): `garak --model_type ollama --model_name <gpt-oss|qwen3> --probes ...`; or an open-weight API target via --model_type openai + OPENAI_BASE_URL.",
              note="cost depends on the TARGET model; a local (or open-weight) target is cheap/free. Models: `localai models`."),
    # ---- cloud: needs a frontier / commercial cloud (no free-local swap) ----
    AIBilling("shannon", "Shannon Lite", "pentest", "cloud", False,
              note="built around frontier models (Claude/Bedrock/Vertex) for white-box reasoning — no free-local equivalent."),
    AIBilling("revelion", "Revelion Daemon", "pentest", "cloud", False,
              note="the AI IS a PAID commercial cloud; the local daemon is only its client."),
    # ---- n/a: AI in the user's editor / not an LLM caller ----
    AIBilling("ai-pentest-mcp", "AI-Pentesting-Tool (MCP/Kali)", "pentest", "n/a", False,
              note="LLM lives in your VS Code (Copilot/Continue) — bill/local is your editor's setting."),
]


def _localai_audit_index() -> dict[str, AIBilling]:
    return {a.tool: a for a in AI_BILLING}


def _print_open_models() -> None:
    Log.head("Open-source model catalog — load any of these into the PATCH→LOCAL tools")
    local_list = [m for m in OPEN_MODELS if m.ollama]
    big_list = [m for m in OPEN_MODELS if m.local in ("no", "small")]
    print(f"\n  {Log._c('▸ RUN LOCALLY for $0  (Ollama / LM-Studio / vLLM — open weights on your hardware)', 'green')}")
    for m in local_list:
        scope = "all sizes" if m.local == "yes" else "small/distill sizes only"
        print(f"    {Log._c(m.id, 'bold'):<14} {m.name}  [{m.license}]  {scope}")
        print(f"        {Log._c('local: `ollama pull ' + m.ollama + '`  → model `' + m.ollama + '` + a local base-URL', 'green')}")
        print(f"        {Log._c(m.note, 'dim')}")
    print(f"\n  {Log._c('▸ BIG OPEN-WEIGHT models  (OpenAI-compatible API — open, cheaper than closed, self-hostable; NOT $0 unless you self-host)', 'yellow')}")
    for m in big_list:
        eps = ", ".join(m.endpoints)
        print(f"    {Log._c(m.id, 'bold'):<14} {m.name}  [{m.license}]  {m.params}")
        print(f"        {Log._c('served: model `' + m.served + '`  → base-URL one of: ' + eps, 'cyan')}")
        print(f"        {Log._c(m.note, 'dim')}")
    Log.head("OpenAI-compatible endpoints for the big open models (key stays a ${PLACEHOLDER} you paste)")
    for prov, url in OPEN_AI_ENDPOINTS.items():
        kind = "first-party" if prov in ("moonshot", "deepseek", "dashscope", "zai") else "aggregator"
        print(f"    {Log._c(prov, 'bold'):<14} {url:<52} {Log._c(kind, 'dim')}")
    Log.step("plug into any PATCH→LOCAL tool (see `localai audit`): keep its base-URL var — set it to a local server (gpt-oss/qwen3/llama3) for $0, or to an open-weight API (kimi-k2/deepseek) for cheap.")
    Log.step("true $0 for a big model = self-host its open weights on your own GPU box (vLLM/SGLang) and point the same base-URL there.")
    Log.step("rule unchanged: Prometheus writes only the non-secret base-URL — the API key stays a ${PLACEHOLDER} you paste, NEVER written.")


def _print_localai_audit() -> None:
    Log.head("Local-AI / billing-free audit — which AI repos call PAID APIs, and how to run them FREE")
    colour = {"local": "green", "hybrid": "cyan", "api": "yellow",
              "scanner": "blue", "cloud": "red", "n/a": "dim"}
    label = {"local": "LOCAL (free, no billing)", "hybrid": "HYBRID (local path ready)",
             "api": "PAID API  →  PATCHABLE to free local", "scanner": "SCANNER (free = local target)",
             "cloud": "CLOUD-ONLY (paid, no free-local swap)", "n/a": "editor / n-a"}
    order = ["api", "scanner", "hybrid", "local", "cloud", "n/a"]
    by_mode: dict[str, list[AIBilling]] = {}
    for a in AI_BILLING:
        by_mode.setdefault(a.mode, []).append(a)
    for mode in order:
        rows = by_mode.get(mode, [])
        if not rows:
            continue
        print(f"\n  {Log._c('▸ ' + label[mode], colour[mode])}")
        for a in rows:
            patch = Log._c("PATCH→LOCAL", "green") if a.patchable else Log._c("—", "dim")
            print(f"    {Log._c(a.tool, 'bold'):<28} [{a.track:<8}] {patch}")
            if a.recipe:
                print(f"        {Log._c('free local: ' + a.recipe, 'green')}")
            if a.note:
                print(f"        {Log._c(a.note, 'dim')}")
    n_patch = sum(1 for a in AI_BILLING if a.patchable)
    n_paid = sum(1 for a in AI_BILLING if a.mode in ("api", "cloud"))
    Log.head("Free local model servers (OpenAI-compatible base-URLs)")
    for prov, url in LOCAL_AI_ENDPOINTS.items():
        print(f"    {Log._c(prov, 'bold'):<20} {url}")
    Log.step(f"{len(AI_BILLING)} AI repos audited · {n_paid} default to a paid API · {n_patch} run FREE on a local OpenAI-compatible model.")
    Log.step("install a local server first: `apps install ollama`  ·  then re-point any PAID-API tool with its 'free local' recipe.")
    Log.step(f"WHICH model? `localai models` → {len(OPEN_MODELS)} open-source models: local-free (gpt-oss · qwen3 · llama3) + big open via OpenAI-compatible API (Kimi K2 · DeepSeek · Qwen3-235B · GLM-4.6).")
    Log.step("rule: Prometheus writes only non-secret base-URLs + a dummy key (e.g. `ollama`) — NEVER your real API keys.")


def _localai_envelope(action: str, tool: Optional[str]) -> dict:
    """Versioned machine envelope for `localai <sub> --json` (CLI-026, version 1).

    Structured payloads per subcommand; the human (non-json) path stays byte-identical.
    The engine-bridge modelhub client consumes THIS (version-branched); the old
    table-scraper is now a fallback for pre-envelope engines only."""
    base = {"command": "localai", "version": 1, "action": action, "ok": True}

    def _tool_row(a: "AIBilling") -> dict:
        return {"tool": a.tool, "name": a.name, "track": a.track, "mode": a.mode,
                "patchable": a.patchable, "recipe": a.recipe, "note": a.note}

    def _model_row(m: "OpenModel") -> dict:
        return {"id": m.id, "name": m.name, "license": m.license, "params": m.params,
                "local": m.local, "ollama": m.ollama, "served": m.served,
                "endpoints": list(m.endpoints), "note": m.note}

    if action in ("audit", "list"):
        base["action"] = "audit"
        base["tools"] = [_tool_row(a) for a in AI_BILLING]
        base["local_endpoints"] = dict(LOCAL_AI_ENDPOINTS)
        base["summary"] = {
            "total": len(AI_BILLING),
            "paid": sum(1 for a in AI_BILLING if a.mode in ("api", "cloud")),
            "patchable": sum(1 for a in AI_BILLING if a.patchable),
        }
        return base
    if action == "models":
        base["models"] = [_model_row(m) for m in OPEN_MODELS]
        base["open_endpoints"] = dict(OPEN_AI_ENDPOINTS)
        # The reasoning-effort table this build resolves `--effort` against. Additive on a
        # versioned envelope, so a pre-effort consumer is unaffected. `provenance` travels
        # with each rule on purpose: two thirds of the table is inferred rather than measured,
        # and a consumer deserves to know which rows to trust.
        _eff_rules, _eff_notes = effort_rules()
        base["effort"] = {
            "tiers": list(EFFORT_TIERS),
            "rules": len(_eff_rules),
            "provenance": {
                # `unattributed` closes the books: `rules` counts every LAYER (builtin + user +
                # project) while only builtins carry a provenance, so without this bucket the
                # three counts summed to less than `rules` and a consumer could not tell whether
                # rows were missing or merely unlabelled.
                **{k: sum(1 for r in _eff_rules if r.get("provenance") == k)
                   for k in ("measured", "published", "inferred")},
                "unattributed": sum(
                    1 for r in _eff_rules
                    if r.get("provenance") not in ("measured", "published", "inferred")),
            },
            "source": str(_EFFORT_BUILTIN_ARTIFACT.name),
            "notes": _eff_notes,
        }
        return base
    if action == "endpoints":
        base["local"] = dict(LOCAL_AI_ENDPOINTS)
        base["open"] = dict(OPEN_AI_ENDPOINTS)
        base["host_ollama"] = _HOST_OLLAMA
        return base
    if action == "model" and tool:
        m = _open_model_index().get(tool)
        if not m:
            return {"command": "localai", "version": 1, "action": "model", "ok": False,
                    "_exit": 2, "error": f"unknown open model: {tool}"}
        base["model"] = _model_row(m)
        return base
    # otherwise: `show <tool>` (or a bare tool) → billing/patchability for one AI tool.
    if not tool:
        return {"command": "localai", "version": 1, "action": action, "ok": False,
                "_exit": 2, "error": "usage: localai <audit|models|endpoints|show <tool>|model <model>>"}
    a = _localai_audit_index().get(tool)
    if not a:
        return {"command": "localai", "version": 1, "action": "show", "ok": False,
                "_exit": 2, "error": f"unknown AI tool: {tool}"}
    base["action"] = "show"
    base["tool"] = _tool_row(a)
    return base


def cmd_localai(args, osi: OSInfo) -> int:
    action = getattr(args, "action", None) or "audit"
    # localai NOW ships a versioned JSON envelope (CLI-026, version 1): under --json we
    # emit_json the structured payload; the engine-bridge modelhub client version-branches
    # on it (the old human-table scraper is its pre-envelope fallback). The non-json human
    # path below is byte-identical to before — do NOT let JSON leak onto it.
    if JSON_OUT:
        return emit_json(_localai_envelope(action, getattr(args, "tool", None)))
    if action in ("audit", "list"):
        _print_localai_audit(); return 0
    if action == "models":
        _print_open_models(); return 0
    if action == "endpoints":
        Log.head("OpenAI-compatible local endpoints (FREE local model servers)")
        for prov, url in LOCAL_AI_ENDPOINTS.items():
            print(f"    {Log._c(prov, 'bold'):<20} {url}")
        Log.step("in Docker, reach a host Ollama via " + _HOST_OLLAMA)
        Log.head("OpenAI-compatible endpoints for BIG open-weight models (Kimi K2 / DeepSeek / Qwen3 / GLM)")
        for prov, url in OPEN_AI_ENDPOINTS.items():
            print(f"    {Log._c(prov, 'bold'):<20} {url}")
        Log.step("catalog of which model runs where: `localai models`")
        return 0
    tool = getattr(args, "tool", None)
    if action == "model" and tool:
        m = _open_model_index().get(tool)
        if not m:
            Log.err(f"unknown open model: {tool}. Try `localai models`."); return 2
        Log.head(f"{m.name} — open-source model")
        print(f"  license   : {m.license}")
        print(f"  params    : {m.params}")
        print(f"  local-$0  : {Log._c('`ollama pull ' + m.ollama + '`', 'green') if m.ollama else Log._c('no (server-class — use a served endpoint or self-host)', 'dim')}")
        if m.served:
            print(f"  served    : model `{m.served}`  → base-URL one of: {', '.join(m.endpoints)}")
        print(f"  note      : {m.note}")
        return 0
    if not tool:
        Log.err("usage: localai <audit|models|endpoints|show <tool-id>|model <model-id>>  (see `localai audit` / `localai models`)"); return 2
    a = _localai_audit_index().get(tool)
    if not a:
        Log.err(f"unknown AI tool: {tool}. Try `localai audit` (tools) or `localai models` (open models)."); return 2
    Log.head(f"{a.name} — billing / local-model status")
    print(f"  track     : {a.track}")
    print(f"  mode      : {a.mode}")
    print(f"  patchable : {Log._c('yes — a free local OpenAI-compatible model works', 'green') if a.patchable else Log._c('no', 'dim')}")
    if a.recipe:
        print(f"  {Log._c('free local: ' + a.recipe, 'green')}")
    if a.note:
        print(f"  note      : {a.note}")
    return 0


# ============================================================================
#  SECTION 6E — PENTEST ARMORY  (the 5th functionality — sandboxed offensive sec)
# ----------------------------------------------------------------------------
#  AUTHORIZED SECURITY TESTING ONLY. This installs high-end penetration-testing
#  programs + AI-assisted pentest tools, and runs every one of them inside a
#  STRONGLY-ARMORED SANDBOX — deliberately harder to break out of than an
#  env-hardening sandbox: OS-level container isolation with a layered defense
#  stack, AIRGAPPED BY DEFAULT, behind a mandatory Rules-of-Engagement gate.
#
#  The armor (strongest available is auto-selected):
#    runtime    gVisor (runsc) ▸ Kata ▸ rootless Podman ▸ Docker  (userspace
#               kernel / VM isolation beats a shared host kernel)
#    network    --network none by DEFAULT (no packets leave the box). Egress is
#               opt-in, target-scoped, confirmed, and only to ROE-listed hosts.
#    privilege  --cap-drop ALL · --security-opt no-new-privileges · non-root
#               user 1000 · setuid bits stripped from the image · userns remap
#    filesystem --read-only rootfs · noexec/nosuid/nodev tmpfs · the ONLY writable
#               path is the bind-mounted /engagement loot dir
#    syscalls   a strict deny-list seccomp profile blocks escape/host-tamper
#               primitives (mount/ptrace/bpf/kexec/init_module/setns/unshare/…)
#    resources  pids/memory(no-swap)/cpu/nofile ceilings · private ipc+cgroupns
#
#  GATE: build/install/run REFUSE until ~/.config/prometheus/pentest/SCOPE.md is
#  filled in and marked `authorized: true` with an authorization reference + at
#  least one in-scope target. Unauthorized use is a crime; this enforces intent.
# ============================================================================
PENTEST_BANNER = (
    "AUTHORIZED PENETRATION TESTING ONLY. Use these tools exclusively against "
    "systems you OWN or have EXPLICIT WRITTEN PERMISSION to test (signed engagement, "
    "bug-bounty scope, CTF, or a lab you control). Unauthorized access, scanning, or "
    "exploitation is illegal in most jurisdictions. You are solely responsible."
)

# Deny-list seccomp: default ALLOW, ERRNO on container-escape / host-tamper syscalls.
# Low breakage for normal tools (nmap connect-scan, sqlmap, nuclei, python) while
# removing the primitives a breakout needs. gVisor/Kata add a second, stronger layer.
_SECCOMP_DENY = [
    "mount", "umount", "umount2", "pivot_root", "chroot",
    "ptrace", "process_vm_readv", "process_vm_writev", "kcmp",
    "kexec_load", "kexec_file_load", "reboot",
    "init_module", "finit_module", "delete_module",
    "bpf", "perf_event_open",
    "add_key", "keyctl", "request_key",
    "unshare", "setns",
    "open_by_handle_at", "name_to_handle_at",
    "swapon", "swapoff", "acct", "quotactl",
    "settimeofday", "clock_settime", "adjtimex", "clock_adjtime",
    "sethostname", "setdomainname",
    "create_module", "get_kernel_syms", "query_module", "nfsservctl", "_sysctl",
    "iopl", "ioperm", "modify_ldt", "vm86", "vm86old",
    "userfaultfd", "fanotify_init", "lookup_dcookie", "personality",
]


def _seccomp_profile() -> dict:
    return {
        "defaultAction": "SCMP_ACT_ALLOW",
        "archMap": [],
        "syscalls": [{"names": sorted(set(_SECCOMP_DENY)),
                      "action": "SCMP_ACT_ERRNO", "errnoRet": 1}],
    }


@dataclass
class PentestTool:
    id: str
    name: str
    category: str                 # recon | scanner | web | exploit | password | framework | ai
    repo: str
    blurb: str
    kind: str = "tool"            # "tool" (runs INSIDE the armor) | "orchestrator" (self-isolating compose stack)
    dual_use: bool = False        # heightened confirm (exploitation / credential attack)
    autonomous: bool = False      # AI agent that PLANS + EXECUTES on its own → top-tier confirm
    needs_net: bool = False       # only useful with egress to an in-scope target
    secrets_note: str = ""        # API keys etc. — ${ENV} placeholders only, never written
    apt: tuple[str, ...] = ()     # apt packages installed into the armored image
    pip: tuple[str, ...] = ()     # pip packages (into a venv inside the image)
    git_clone: Optional[str] = None
    build_steps: tuple[str, ...] = ()   # extra Containerfile RUN lines (already-trusted forms)
    entry: str = ""               # how to launch inside the sandbox (shown post-install)
    docs: str = ""
    # --- orchestrator (compose stack that manages its OWN tool isolation) ---
    compose_url: Optional[str] = None
    env_url: Optional[str] = None
    compose_project: Optional[str] = None
    port: Optional[str] = None
    isolation_note: str = ""
    # --- AI agent (host-side, isolated-workspace install; drives its OWN sandbox) ---
    install_kind: str = ""          # python-venv | git-venv | node-npm | go-build | git-manual
    pypi: str = ""                  # PyPI package (python-venv)
    npm_pkg: str = ""               # npm package (node-npm)
    run_cmd: str = ""               # launch line from the isolated install
    subdir: str = ""                # git-venv/go: work/build subdir within the clone
    requirements: str = ""          # git-venv: requirements file (default requirements.txt)
    account_required: bool = False  # commercial cloud client (e.g. Revelion) — needs an account
    manages_docker: bool = False    # spawns its OWN container sandbox / wraps a Kali box


PENTEST_TOOLS: list[PentestTool] = [
    PentestTool(id="nmap", name="Nmap", category="recon",
                repo="https://github.com/nmap/nmap",
                blurb="Network discovery + port/service/version scanning. The standard recon tool. (Armor denies raw sockets → use connect scans `-sT`.)",
                apt=("nmap",), needs_net=True, entry="nmap -sT -sV <in-scope-host>",
                docs="github_repos_a.txt"),
    PentestTool(id="nuclei", name="Nuclei", category="scanner",
                repo="https://github.com/projectdiscovery/nuclei",
                blurb="Fast template-based vulnerability scanner (ProjectDiscovery). Community + custom YAML templates.",
                apt=("nuclei",), needs_net=True, entry="nuclei -u https://<in-scope-target>",
                docs="github_repos_a.txt"),
    PentestTool(id="ffuf", name="ffuf", category="web",
                repo="https://github.com/ffuf/ffuf",
                blurb="Fast web fuzzer for content/parameter/vhost discovery.",
                apt=("ffuf",), needs_net=True, entry="ffuf -u https://<target>/FUZZ -w <wordlist>",
                docs="github_repos_a.txt"),
    PentestTool(id="sqlmap", name="sqlmap", category="web", dual_use=True,
                repo="https://github.com/sqlmapproject/sqlmap",
                blurb="Automatic SQL-injection detection + exploitation. Dual-use — authorized targets only.",
                apt=("sqlmap",), needs_net=True, entry="sqlmap -u 'https://<target>/?id=1' --batch",
                docs="github_repos_a.txt"),
    PentestTool(id="wpscan", name="WPScan", category="scanner",
                repo="https://github.com/wpscanteam/wpscan",
                blurb="WordPress security scanner (themes/plugins/users/known CVEs).",
                apt=("ruby", "ruby-dev", "build-essential", "libcurl4-openssl-dev", "libxml2-dev", "zlib1g-dev"),
                build_steps=("gem install wpscan",), needs_net=True,
                secrets_note="WPScan API token (vuln DB) = ${WPSCAN_API_TOKEN} — paste at runtime, never written by Prometheus.",
                entry="wpscan --url https://<target>", docs="github_repos_a.txt"),
    PentestTool(id="nikto", name="Nikto", category="web",
                repo="https://github.com/sullo/nikto",
                blurb="Web-server misconfiguration + dangerous-file scanner.",
                apt=("nikto",), needs_net=True, entry="nikto -h https://<target>",
                docs="github_repos_a.txt"),
    PentestTool(id="zaproxy", name="OWASP ZAP", category="web",
                repo="https://github.com/zaproxy/zaproxy",
                blurb="OWASP web-app security scanner / proxy. Defensive-leaning DAST; great for your own apps.",
                apt=("zaproxy",), needs_net=True, entry="zap.sh -cmd -quickurl https://<target>",
                docs="github_repos_a.txt"),
    PentestTool(id="amass", name="OWASP Amass", category="recon",
                repo="https://github.com/owasp-amass/amass",
                blurb="Attack-surface mapping + subdomain enumeration (OSINT/recon).",
                apt=("amass",), needs_net=True, entry="amass enum -d <in-scope-domain>",
                docs="github_repos_a.txt"),
    PentestTool(id="hydra", name="THC-Hydra", category="password", dual_use=True,
                repo="https://github.com/vanhauser-thc/thc-hydra",
                blurb="Network login auditor (brute/credential testing). Dual-use — authorized targets only.",
                apt=("hydra",), needs_net=True, entry="hydra -L users.txt -P pass.txt <target> ssh",
                docs="github_repos_a.txt"),
    PentestTool(id="john", name="John the Ripper", category="password", dual_use=True,
                repo="https://github.com/openwall/john",
                blurb="Offline password-hash auditing/cracking. Runs fully airgapped (no network needed).",
                apt=("john",), needs_net=False, entry="john --wordlist=<list> hashes.txt",
                docs="github_repos_a.txt"),
    PentestTool(id="metasploit", name="Metasploit Framework", category="framework", dual_use=True,
                repo="https://github.com/rapid7/metasploit-framework",
                blurb="The exploitation framework (modules/payloads/post). Dual-use — authorized engagements/CTF only.",
                build_steps=(
                    "apt-get update && apt-get install -y --no-install-recommends gnupg2 curl ca-certificates",
                    "curl -fsSL https://apt.metasploit.com/metasploit-framework.gpg.key | gpg --dearmor -o /usr/share/keyrings/metasploit.gpg",
                    "echo 'deb [signed-by=/usr/share/keyrings/metasploit.gpg] https://apt.metasploit.com/ buster main' > /etc/apt/sources.list.d/metasploit.list",
                    "apt-get update && apt-get install -y --no-install-recommends metasploit-framework",
                ),
                needs_net=True, entry="msfconsole  (DB-less ok inside the sandbox)",
                docs="github_repos_a.txt"),
    PentestTool(id="impacket", name="Impacket", category="exploit", dual_use=True,
                repo="https://github.com/fortra/impacket",
                blurb="Python classes for network protocols (SMB/Kerberos/…). AD-pentest staple. Dual-use.",
                pip=("impacket",), needs_net=True, entry="(venv) python -m impacket examples, e.g. secretsdump.py",
                docs="github_repos_a.txt"),
    # ---- AI-assisted pentest ----
    PentestTool(id="pentestgpt", name="PentestGPT", category="ai",
                repo="https://github.com/GreyDGL/PentestGPT",
                blurb="LLM-guided penetration-testing assistant — reasons about recon output + suggests next steps.",
                pip=("pentestgpt",),
                secrets_note="LLM API key = ${OPENAI_API_KEY} (or your provider) — exported at runtime, NEVER written by Prometheus. FREE LOCAL (no billing): PentestGPT honors a custom OpenAI base-URL — `export OPENAI_BASEURL=http://localhost:11434/v1 OPENAI_API_KEY=ollama` and run `pentestgpt --reasoning_model <local-model>` against a local Ollama/LM-Studio. Pick a model with `localai models` (local-free gpt-oss/qwen3/llama3, or a big open model like Kimi K2/DeepSeek via its OpenAI-compatible API → point OPENAI_BASEURL there). See `localai show pentestgpt`.",
                needs_net=True, entry="(venv) pentestgpt --reasoning_model gpt-4o   (free local: OPENAI_BASEURL=http://localhost:11434/v1 OPENAI_API_KEY=ollama pentestgpt --reasoning_model <local-model>)", docs="github_repos_a.txt"),
    PentestTool(id="garak", name="garak (LLM red-team)", category="ai",
                repo="https://github.com/NVIDIA/garak",
                blurb="LLM vulnerability scanner (NVIDIA) — probes a target model for jailbreaks/prompt-injection/leakage. AI-security testing.",
                pip=("garak",),
                secrets_note="target-model API key (e.g. ${OPENAI_API_KEY}) exported at runtime — never written by Prometheus. FREE LOCAL (no paid target): garak ships an Ollama generator — scan a LOCAL model with `garak --model_type ollama --model_name <local-model> --probes encoding`, zero API billing. Open-model targets (gpt-oss/qwen3 local, or Kimi K2/DeepSeek served): `localai models`. See `localai show garak`.",
                needs_net=True, entry="(venv) garak --model_type openai --model_name gpt-3.5-turbo --probes encoding   (free local target: garak --model_type ollama --model_name <local-model> --probes encoding)",
                docs="github_repos_a.txt"),
    # ---- AI PENTEST AGENTS (host-side, isolated-workspace install; each DRIVES its
    #      OWN sandbox / Kali box, so — like PentAGI — it is NOT wrapped in the
    #      `--network none --cap-drop ALL` per-tool armor (that would just break it).
    #      Instead Prometheus gives the SAFEST host install: a dedicated, self-contained
    #      workspace (venv / local node_modules / git-checkout / go-build) so UNINSTALL =
    #      delete the folder, with ${ENV} key placeholders only + an isolation disclosure. ----
    PentestTool(id="strix", name="Strix", category="ai", kind="agent",
                repo="https://github.com/usestrix/strix",
                blurb="Autonomous AI hacker agents (Apache-2.0, usestrix) — run your code dynamically, find + validate vulns with real PoCs. Spawns its OWN Docker sandbox per run.",
                dual_use=True, autonomous=True, needs_net=True, manages_docker=True,
                install_kind="python-venv", pypi="strix-agent", run_cmd="strix --target ./app-directory",
                secrets_note="STRIX_LLM (e.g. openai/gpt-5.4) + LLM_API_KEY=${LLM_API_KEY} — pasted/exported at runtime, NEVER written by Prometheus. FREE LOCAL (no billing): Strix is LiteLLM-based — `export STRIX_LLM=openai/<local-model> LLM_API_KEY=ollama LLM_API_BASE=http://localhost:11434/v1` points it at a local Ollama/LM-Studio. For a big open model (Kimi K2/DeepSeek) point LLM_API_BASE at its OpenAI-compatible API instead; pick one with `localai models`. See `localai show strix`.",
                isolation_note="Strix pulls + runs its OWN sandbox container for the target (needs Docker running). Prometheus installs the driver in an isolated venv (delete-folder uninstall).",
                entry="strix --target ./app   (headless: -n)", docs="github_repos_b.txt"),
    PentestTool(id="ptai", name="pentest-ai (ptai)", category="ai", kind="agent",
                repo="https://github.com/0xsteph/pentest-ai",
                blurb="Offensive-security MCP server + CLI (MIT, 0xSteph) — 200+ wrapped tools, specialist agents, PoC validation, audit-ready reports. BYO LLM.",
                dual_use=True, autonomous=True, needs_net=True, manages_docker=True,
                install_kind="python-venv", pypi="ptai", run_cmd="ptai --help",
                secrets_note="MCP path = none (uses your editor subscription); CLI = ${ANTHROPIC_API_KEY} or ${OPENAI_API_KEY}, or PENTEST_AI_LLM_PROVIDER=ollama (local). Pasted at runtime, never written.",
                isolation_note="On first run ptai batch-installs many HOST security tools (nmap/nuclei/sqlmap/…). Prometheus keeps ptai itself in an isolated venv; review that tool batch before approving it.",
                entry="ptai setup --tier core   then   ptai (MCP) / ptai run …", docs="github_repos_b.txt"),
    PentestTool(id="shannon", name="Shannon Lite", category="ai", kind="agent",
                repo="https://github.com/KeygraphHQ/shannon",
                blurb="Autonomous white-box AI pentester for web apps/APIs (AGPL-3.0 Lite; Pro is commercial). Reads your source + executes real exploits. Node 18+, runs a Docker worker.",
                dual_use=True, autonomous=True, needs_net=True, manages_docker=True,
                install_kind="node-npm", npm_pkg="@keygraph/shannon",
                run_cmd="shannon start -u https://your-app.com -r /path/to/your-repo",
                secrets_note="Anthropic (recommended) / AWS Bedrock / Google Vertex creds = ${ANTHROPIC_API_KEY} — set via `shannon setup` at runtime, never written by Prometheus.",
                isolation_note="Shannon Lite (AGPL-3.0) is the free self-host core; Shannon Pro is paid/commercial. Runs a Docker worker (needs Docker). Installed locally (node_modules) → delete-folder uninstall.",
                entry="shannon setup   then   shannon start -u <url> -r <repo>", docs="github_repos_b.txt"),
    PentestTool(id="pluto", name="Pluto", category="ai", kind="agent",
                repo="https://github.com/0xSaikat/pluto-ai",
                blurb="AI code-security analyzer (MIT, 0xSaikat) — CLI that uses an LLM to find vulns in files/dirs/repos + package-malware checks. Defensive SAST, not an attacker.",
                dual_use=False, autonomous=False, needs_net=True, manages_docker=False,
                install_kind="python-venv", pypi="pluto-ai", run_cmd="pluto scan ./your-code",
                secrets_note="${ANTHROPIC_API_KEY} or ${OPENAI_API_KEY}, or Ollama (local, no key). Pasted at runtime, never written by Prometheus.",
                entry="pluto scan <file|dir|repo>", docs="github_repos_b.txt"),
    PentestTool(id="hunter", name="Hunter", category="ai", kind="agent",
                repo="https://github.com/Pillow-mycode/Hunter",
                blurb="LLM-driven automated pentest system (MIT) — multi-agent (Leader/Attacker/Hawkeye/Analyst) orchestrating 101 tools on Kali. DeepSeek by default.",
                dual_use=True, autonomous=True, needs_net=True, manages_docker=True,
                install_kind="git-venv", git_clone="https://github.com/Pillow-mycode/Hunter",
                subdir="hunter-server", requirements="requirements.txt", run_cmd="python server/app.py",
                secrets_note="DEFAULT_API_KEY=${DEFAULT_API_KEY} + DEFAULT_BASE_URL (DeepSeek default) — pasted into the workspace .env at runtime, never written by Prometheus. FREE LOCAL (no billing): DeepSeek's API is OpenAI-compatible, so set DEFAULT_BASE_URL=http://localhost:11434/v1 + DEFAULT_API_KEY=ollama + a local model to run on a local Ollama instead. Or point DEFAULT_BASE_URL at an open-weight API for a big model (Kimi K2/DeepSeek); pick one with `localai models`. See `localai show hunter`.",
                isolation_note="Hunter wraps 101 Kali tools and is meant to run ON a Kali box; it executes real offensive tools against the target. Installed into an isolated clone + venv (delete-folder uninstall).",
                entry="(from src/hunter-server) python server/app.py  → web UI", docs="github_repos_b.txt"),
    PentestTool(id="ai-pentest-mcp", name="AI-Pentesting-Tool (MCP/Kali)", category="ai", kind="agent",
                repo="https://github.com/xgledsp/AI-Pentesting-Tool",
                blurb="Educational workflow wiring an AI agent to Kali tooling via MCP in VS Code (Copilot/Continue). A guided setup, not a single CLI.",
                dual_use=True, autonomous=True, needs_net=True, manages_docker=False,
                install_kind="git-manual", git_clone="https://github.com/xgledsp/AI-Pentesting-Tool",
                secrets_note="GitHub Copilot (or a custom LLM) key — configured in your editor, never written by Prometheus.",
                isolation_note="An MCP + editor workflow that drives Kali tools (nmap/nikto/dirb/gobuster) from VS Code. Prometheus clones + scans it; you complete the MCP-Kali-server + editor wiring per its README.",
                entry="install mcp-kali-server\nstart the Kali MCP API server (systemd)\nopen the repo in VS Code Insiders\ninit Copilot Chat / Continue (see README)",
                docs="github_repos_b.txt"),
    PentestTool(id="revelion", name="Revelion Daemon", category="ai", kind="agent",
                repo="https://github.com/RevelionAI/revelion-daemon",
                blurb="Local execution daemon (Go) for Revelion — a COMMERCIAL white-label AI-pentest cloud for MSPs. Runs/manages the sandbox locally; the AI + control plane are the paid cloud.",
                dual_use=True, autonomous=True, needs_net=True, manages_docker=True, account_required=True,
                install_kind="go-build", git_clone="https://github.com/RevelionAI/revelion-daemon", run_cmd="revelion-daemon",
                secrets_note="Revelion platform token = ${REVELION_TOKEN} (from your Revelion account) — pasted at runtime, never written by Prometheus.",
                isolation_note="NOT self-contained: only the local CLIENT of a PAID cloud platform — needs a Revelion account/token to do anything. Manages a local sandbox container and connects out to Revelion. Built from source into an isolated workspace.",
                entry="revelion-daemon   (after pasting REVELION_TOKEN; needs a Revelion account)", docs="github_repos_b.txt"),
    PentestTool(id="swarm", name="Pentest Swarm AI", category="ai", kind="agent",
                repo="https://github.com/Armur-Ai/Pentest-Swarm-AI",
                blurb="Autonomous swarm of pentest agents (recon/classifier/exploit/report, ReAct) with live access to nmap/sqlmap/Burp/Metasploit (AGPL-3.0, Go, ~1.7k★, alpha — stable sequential runner). Provider-agnostic LLM.",
                dual_use=True, autonomous=True, needs_net=True, manages_docker=False,
                install_kind="go-build", git_clone="https://github.com/Armur-Ai/Pentest-Swarm-AI",
                run_cmd="pentestswarm scan example.com --scope example.com --swarm",
                secrets_note="LLM is provider-agnostic — PREFER a FREE local model (provider: ollama|lmstudio, or any OpenAI-compatible `endpoint`) = NO API billing; the cloud default would need ${PENTESTSWARM_ORCHESTRATOR_API_KEY}. Keys pasted at runtime, never written by Prometheus.",
                isolation_note="Alpha (sequential runner stable; swarm/dashboard alpha). RUNS REAL offensive tools (nmap/sqlmap/Metasploit) directly — run it on a Kali VM / isolated host you own. Built from source into an isolated workspace (delete-folder uninstall). Point provider at a local OpenAI-compatible model (mythos/Ollama) to avoid API billing entirely.",
                entry="edit config.yaml → provider: ollama|lmstudio|openai + endpoint (local = no billing)   then   pentestswarm scan <target> --scope <target> --swarm",
                docs="github_repos_b.txt"),
    # ---- REFERENCE catalog (a curated 'awesome list' — a READING LIST, not a runnable tool) ----
    PentestTool(id="bluetooth-awesome", name="Awesome Bluetooth Security", category="reference", kind="agent",
                repo="https://github.com/engn33r/awesome-bluetooth-security",
                blurb="Curated CATALOG of Bluetooth security (CVEs, conference talks, tools, references) — a READING LIST, not a scanner. Clones locally for offline reference; links real tools (btlejack/sniffle/internalblue/btlejuice/BlueZ).",
                dual_use=False, autonomous=False, needs_net=False, manages_docker=False,
                install_kind="reference", git_clone="https://github.com/engn33r/awesome-bluetooth-security",
                isolation_note="Not a runnable program — a curated markdown list (no explicit license). The actual BT-testing tools it links need RADIO hardware (BLE sniffer / HCI adapter) + device access, so they do NOT run in the airgapped armor; install those on a host that has the adapter.",
                entry="open src/README.md  ·  curated tools: btlejack, sniffle, internalblue, btlejuice, BlueZ",
                docs="github_repos_b.txt (user-added)"),
    # ---- AI orchestrator (self-isolating compose stack — NOT wrapped in the per-tool armor) ----
    PentestTool(id="pentagi", name="PentAGI", category="ai", kind="orchestrator",
                repo="https://github.com/vxcontrol/pentagi",
                blurb="Fully AUTONOMOUS multi-agent AI pentester (researcher/developer/executor). Plans + runs attacks by itself, spawning a fresh container per tool. MIT, ~17.5k★.",
                dual_use=True, autonomous=True, needs_net=True,
                compose_url="https://raw.githubusercontent.com/vxcontrol/pentagi/master/docker-compose.yml",
                env_url="https://raw.githubusercontent.com/vxcontrol/pentagi/master/.env.example",
                compose_project="pentagi", port="8443",
                secrets_note="≥1 LLM key (${OPENAI_API_KEY}/${ANTHROPIC_API_KEY}/${GEMINI_API_KEY}) + DB creds — ${ENV} placeholders only, you paste them into .env; Prometheus never writes keys. FREE LOCAL (no LLM billing): PentAGI supports a Custom/OpenAI-compatible provider — point its LLM_SERVER_URL/KEY/MODEL group in .env at a local Ollama (http://host.docker.internal:11434/v1, key=ollama) for gpt-oss/qwen3, or at an open-weight API for a big model (Kimi K2/DeepSeek). Pick one with `localai models`. See `localai show pentagi`.",
                isolation_note="PentAGI already isolates each tool in its own container — but the stock compose mounts the HOST docker socket (root-equivalent on your machine). Prometheus defaults it to an ISOLATED docker-in-docker daemon so it never touches your host socket.",
                entry="https://localhost:8443  (after `pentest enable pentagi`)", docs="github_repos_a.txt"),
    # >>> APPEND MORE (AUTHORIZED) PENTEST TOOLS HERE <<<
]


def pentest_tool_registry() -> dict[str, PentestTool]:
    return {t.id: t for t in PENTEST_TOOLS}


# ---- sandbox plumbing ------------------------------------------------------
ARMORY_BASE_IMAGE = "prometheus-armory-base"
ARMORY_TOOL_PREFIX = "prometheus-armory"          # per-tool image: prometheus-armory-<id>


def _pentest_dir() -> Path:
    return PROM_DIR / "pentest"


def _oci_engine() -> Optional[tuple[str, str]]:
    """Prefer rootless Podman (stronger default isolation) over Docker."""
    for name in ("podman", "docker"):
        path = shutil.which(name)
        if path:
            return path, name
    return None


def _strongest_runtime(engine: str) -> Optional[str]:
    """Pick the strongest container runtime available: gVisor (runsc) ▸ Kata."""
    if shutil.which("runsc"):
        return "runsc"
    for k in ("kata-runtime", "kata"):
        if shutil.which(k):
            return k
    # also consult the engine's registered runtimes
    try:
        p = subprocess.run([engine, "info", "--format", "{{json .Runtimes}}"],
                           capture_output=True, text=True, timeout=8)
        if "runsc" in p.stdout:
            return "runsc"
        if "kata" in p.stdout:
            return "kata-runtime"
    except Exception:
        pass
    return None


def _armor_flags(engine: str, runtime: Optional[str], net: str, engagement: Optional[Path]) -> list[str]:
    prof = _pentest_dir() / "seccomp-armored.json"
    flags: list[str] = []
    if runtime:
        flags += ["--runtime", runtime]                       # gVisor/Kata userspace-kernel isolation
    flags += [
        "--network", net,                                     # default "none" → airgapped
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m",
        "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=64m",
        "--pids-limit", "512",
        "--memory", "3g", "--memory-swap", "3g",              # no swap
        "--cpus", "2",
        "--ulimit", "nofile=2048:2048",
        "--ipc", "private",
        "--cgroupns", "private",
        "--hostname", "armored-sandbox",
        "--user", "1000:1000",
    ]
    if prof.exists():
        flags += ["--security-opt", f"seccomp={prof}"]
    if Path(engine).name == "podman":
        flags += ["--userns", "auto"]                         # extra uid remap on top of rootless
    if engagement:
        flags += ["-v", f"{engagement}:/engagement:rw"]
    return flags


def _armor_run(engine: str, runtime: Optional[str], image: str, *, net: str = "none",
               engagement: Optional[Path] = None, interactive: bool = False,
               cmd: Optional[list[str]] = None) -> list[str]:
    argv = [engine, "run", "--rm"]
    if interactive:
        argv.append("-it")
    argv += _armor_flags(engine, runtime, net, engagement)
    argv.append(image)
    if cmd:
        argv += cmd
    return argv


# ---- Rules-of-Engagement (authorization) gate ------------------------------
def _scope_path() -> Path:
    return _pentest_dir() / "SCOPE.md"


_SCOPE_TEMPLATE = """\
# Prometheus Pentest Armory — Rules of Engagement (REQUIRED)
#
# Fill this in HONESTLY. Build/install/run stay BLOCKED until:
#   authorized: true   AND   authorization_ref is set   AND   >=1 target listed.
# Only the hosts under `targets:` may ever be touched. Unauthorized testing is a crime.

authorized: false
authorization_ref:        # signed engagement / bug-bounty program / CTF name / "personal lab I own"
operator:                 # your name
engagement:               # engagement / project name
window:                   # YYYY-MM-DD .. YYYY-MM-DD (testing window)

targets:                  # ONE in-scope host/CIDR/domain per line, prefixed with '- '
  # - 10.10.0.0/24
  # - test.example.com

out_of_scope:             # explicitly forbidden (production, third parties, …)
  # - prod.example.com

notes:
"""


def _read_scope() -> dict:
    p = _scope_path()
    if not p.exists():
        return {}
    data: dict = {"targets": [], "out_of_scope": []}
    section = None
    for raw in p.read_text().splitlines():
        line = raw.split("#", 1)[0].rstrip() if not raw.strip().startswith("#") else ""
        if not line:
            continue
        if line.endswith(":") and not line.startswith(" "):
            section = line[:-1].strip(); continue
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m:
            section = None
            data[m.group(1)] = m.group(2).strip()
        elif line.lstrip().startswith("- "):
            data.setdefault(section or "targets", [])
            if isinstance(data.get(section or "targets"), list):
                data[section or "targets"].append(line.lstrip()[2:].strip())
    return data


def _scope_ok() -> tuple[bool, list[str]]:
    data = _read_scope()
    if not data:
        return False, ["no SCOPE.md yet — run `pentest scope` to create it"]
    reasons = []
    if str(data.get("authorized", "false")).lower() != "true":
        reasons.append("authorized: is not true")
    if not data.get("authorization_ref"):
        reasons.append("authorization_ref: is empty")
    targets = [t for t in data.get("targets", []) if t]
    if not targets:
        reasons.append("no in-scope targets listed")
    return (not reasons), reasons


def _require_scope() -> bool:
    Log.warn(PENTEST_BANNER)
    ok, reasons = _scope_ok()
    if ok:
        data = _read_scope()
        Log.ok(f"ROE accepted — operator={data.get('operator','?')} ref={data.get('authorization_ref','?')} "
               f"targets={len([t for t in data.get('targets',[]) if t])}")
        return True
    Log.err("Rules-of-Engagement gate NOT satisfied:")
    for r in reasons:
        Log.step(f"• {r}")
    Log.step(f"edit {_scope_path()} then re-run (see `pentest scope`).")
    return False


def cmd_pentest_scope(write: bool) -> int:
    p = _scope_path()
    if write or not p.exists():
        if p.exists():
            Log.warn(f"SCOPE.md already exists at {p} — not overwriting");
        else:
            if DRY_RUN:
                Log.step(f"[dry-run] write {p}")
            else:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(_SCOPE_TEMPLATE)
            Log.ok(f"wrote ROE template → {p}")
            Log.step("edit it: set `authorized: true`, an authorization_ref, and your in-scope targets.")
    ok, reasons = _scope_ok()
    Log.head("ROE status")
    if ok:
        Log.ok("authorized — build/install/run unlocked")
    else:
        for r in reasons:
            Log.warn(r)
    print(f"  file: {p}")
    return 0


# ---- sandbox build + tool lifecycle ----------------------------------------
def _ensure_seccomp() -> None:
    prof = _pentest_dir() / "seccomp-armored.json"
    if DRY_RUN:
        Log.step(f"[dry-run] write {prof.name}"); return
    prof.parent.mkdir(parents=True, exist_ok=True)
    prof.write_text(json.dumps(_seccomp_profile(), indent=2))


def _base_containerfile(kali: bool) -> str:
    base = "kalilinux/kali-rolling" if kali else "debian:bookworm-slim"
    return f"""\
# Prometheus Armory base — minimal, non-root, setuid-stripped
FROM {base}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
        ca-certificates curl git python3 python3-pip python3-venv tini \\
    && rm -rf /var/lib/apt/lists/*
# strip setuid/setgid bits across the image (defense-in-depth vs SUID escalation)
RUN find / -xdev -type f -perm /6000 -exec chmod a-s {{}} + 2>/dev/null || true
RUN useradd -m -u 1000 -s /bin/bash operator && mkdir -p /engagement && chown operator /engagement
USER operator
WORKDIR /engagement
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/bin/bash"]
"""


def _tool_containerfile(t: PentestTool) -> str:
    lines = [f"FROM {ARMORY_BASE_IMAGE}", "USER root", "ENV DEBIAN_FRONTEND=noninteractive"]
    if t.apt:
        lines.append("RUN apt-get update && apt-get install -y --no-install-recommends "
                     + " ".join(t.apt) + " && rm -rf /var/lib/apt/lists/*")
    for step in t.build_steps:
        lines.append(f"RUN {step}")
    if t.git_clone:
        lines.append(f"RUN git clone --depth 1 {t.git_clone} /opt/{t.id}")
    if t.pip:
        lines.append(f"RUN python3 -m venv /opt/{t.id}-venv && /opt/{t.id}-venv/bin/pip install --no-cache-dir "
                     + " ".join(t.pip))
    # re-strip setuid (apt may have re-added some) and drop back to non-root
    lines.append("RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true")
    lines.append("USER operator")
    lines.append("WORKDIR /engagement")
    return "\n".join(lines) + "\n"


def _armory_status_line(engine: str) -> tuple[Optional[str], set]:
    runtime = _strongest_runtime(engine)
    images = set()
    try:
        p = _run_timed([engine, "images", "--format", "{{.Repository}}"], capture_output=True, text=True, timeout=30)
        images = set(p.stdout.split())
    except Exception:
        pass
    return runtime, images


def _print_pentest_tools(engine: Optional[str]) -> None:
    Log.head("Pentest Armory — sandboxed offensive-security tools (AUTHORIZED USE ONLY)")
    Log.warn(PENTEST_BANNER)
    images = set()
    runtime = None
    if engine:
        runtime, images = _armory_status_line(engine)
    cat_col = {"recon": "cyan", "scanner": "blue", "web": "magenta",
               "exploit": "red", "password": "yellow", "framework": "red", "ai": "green"}
    for t in PENTEST_TOOLS:
        if t.kind == "orchestrator":
            installed = (_orchestrator_dir(t) / "docker-compose.yml").exists()
            mark = Log._c("● installed", "green") if installed else Log._c("  not set up", "dim")
            tag = Log._c("[orchestrator]", "red")
            flags = [Log._c("AUTONOMOUS", "red"), Log._c("self-isolating (NOT double-jailed)", "yellow")]
        elif t.kind == "agent":
            inst = _app_marker(_pentagent_dir(t)).exists()
            disabled = _pentagent_disabled_marker(t).exists()
            mark = (Log._c("● disabled", "yellow") if disabled else Log._c("● installed", "green")) if inst \
                else Log._c("  not installed", "dim")
            if t.install_kind == "reference":
                tag = Log._c("[reference]", "blue")
                flags = [Log._c("curated reading-list (NOT a tool — nothing to run)", "cyan")]
            else:
                tag = Log._c("[agent]", "green")
                flags = [Log._c(f"install:{t.install_kind}", "cyan")]
                if t.autonomous:
                    flags.append(Log._c("AUTONOMOUS", "red"))
                if t.dual_use:
                    flags.append(Log._c("dual-use", "red"))
                if t.account_required:
                    flags.append(Log._c("cloud-account REQUIRED", "magenta"))
                if t.manages_docker:
                    flags.append(Log._c("drives own Docker sandbox", "yellow"))
        else:
            installed = f"{ARMORY_TOOL_PREFIX}-{t.id}" in images
            mark = Log._c("● installed", "green") if installed else Log._c("  not built", "dim")
            tag = Log._c(f"[{t.category}]", cat_col.get(t.category, "yellow"))
            flags = []
            if t.dual_use:
                flags.append(Log._c("dual-use", "red"))
            flags.append(Log._c("needs egress", "yellow") if t.needs_net else Log._c("airgap-OK", "green"))
        print(f"  {mark}  {tag} {Log._c(t.id, 'bold')} — {t.name}   {' · '.join(flags)}")
        print(f"      {t.blurb}")
        if t.isolation_note:
            print(f"      {Log._c('isolation: ' + t.isolation_note, 'yellow')}")
        if t.secrets_note:
            print(f"      {Log._c('secrets: ' + t.secrets_note, 'dim')}")
        print(f"      {Log._c(t.repo, 'dim')}")
    base = Log._c("built ✓", "green") if ARMORY_BASE_IMAGE in images else Log._c("not built", "yellow")
    rt = Log._c(runtime or "default runc (no gVisor/Kata found)", "green" if runtime else "yellow")
    Log.step(f"sandbox base image: {base}   ·   strongest runtime: {rt}   ·   network default: "
             + Log._c("none (airgapped)", "green"))
    Log.step("build sandbox: `pentest build`   ·   install a tool: `pentest install <id>`   ·   shell: `pentest shell <id>`")
    Log.step("ROE gate: `pentest scope`   ·   run: `pentest run <id> -- <args>`   ·   destroy all: `pentest destroy`")


def _pentest_build(osi: OSInfo, kali: bool) -> int:
    if not _require_scope():
        return 1
    eng = _oci_engine()
    if not eng:
        Log.err("no container engine — install Podman (preferred) or Docker. The armor needs OS-level isolation.")
        return 2
    engine, name = eng
    runtime = _strongest_runtime(engine)
    Log.head(f"Build armored sandbox base  (engine={name}, runtime={runtime or 'runc default'})")
    if not runtime:
        Log.warn("no gVisor (runsc) or Kata runtime found — falling back to the host kernel via runc.")
        Log.step("for the STRONGEST armor install gVisor (https://gvisor.dev) or Kata Containers, then re-run `pentest build`.")
    _ensure_seccomp()
    cf = _pentest_dir() / "Containerfile.base"
    if DRY_RUN:
        Log.step(f"[dry-run] write {cf} ({'kali' if kali else 'debian-slim'} base)")
        Log.step(f"[dry-run] {name} build -t {ARMORY_BASE_IMAGE} -f {cf} {cf.parent}")
        return 0
    cf.parent.mkdir(parents=True, exist_ok=True)
    cf.write_text(_base_containerfile(kali))
    Log.warn("this build step needs network to fetch packages; the RUNTIME sandbox stays airgapped by default.")
    if not _confirm(f"Build {ARMORY_BASE_IMAGE} from {'Kali' if kali else 'Debian-slim'} now?"):
        Log.warn("declined"); return 0
    rc = run([engine, "build", "-t", ARMORY_BASE_IMAGE, "-f", str(cf), str(cf.parent)], check=False).returncode
    if rc != 0:
        Log.err(f"base image build failed (rc={rc})"); return 1
    Log.ok(f"armored base image built: {ARMORY_BASE_IMAGE}")
    Log.step("now install tools into it: `pentest install nmap` (etc.)")
    return 0


def _pentest_install(t: PentestTool, osi: OSInfo) -> int:
    if not _require_scope():
        return 1
    eng = _oci_engine()
    if not eng:
        Log.err("no container engine (Podman/Docker)"); return 2
    engine, name = eng
    _, images = _armory_status_line(engine)
    if ARMORY_BASE_IMAGE not in images and not DRY_RUN:
        Log.err(f"armored base not built yet — run `pentest build` first."); return 2
    Log.head(f"Install into armored sandbox: {t.name}  [{t.category}]")
    print(f"  {t.blurb}")
    if t.secrets_note:
        Log.step(f"secrets: {t.secrets_note}")
    if t.dual_use:
        Log.warn("DUAL-USE tool (exploitation / credential attack). Authorized, in-scope targets ONLY.")
        if not _confirm(f"Confirm you are authorized to use {t.name} against your in-scope targets?"):
            Log.warn("declined"); return 0
    cf = _pentest_dir() / f"Containerfile.{t.id}"
    content = _tool_containerfile(t)
    # Scan only the TOOL-SUPPLIED recipe (upstream shell: build_steps + clone) — that's the
    # untrusted part. Prometheus's own apt/pip/cleanup boilerplate (e.g. `rm -rf /var/lib/apt/lists`)
    # is authored here and trusted, so it isn't re-flagged as a destructive command.
    recipe = "\n".join(list(t.build_steps) + ([f"git clone {t.git_clone}"] if t.git_clone else []))
    if recipe.strip() and not NO_SCAN:
        rep = ScanReport(t.id, t.repo, "armory:" + str(abs(hash(recipe)))[:8],
                         _scan_text(f"{t.id}-recipe", recipe), 1)
        if not security_gate(rep, "local"):
            Log.warn(f"{t.name} build recipe blocked by security gate"); return 1
    if recipe.strip():
        if not enforce_gate_text(recipe, f"{t.id} build recipe", tier="pentest"):
            Log.warn(f"{t.name} build recipe blocked by nemesis gate"); return 1
        # the recipe clones an offensive-security repo INSIDE the image build —
        # deep-scan that source up front too (nemesis fetches its own snapshot)
        if t.git_clone and not enforce_gate(t.git_clone, f"{t.id} source", tier="pentest"):
            Log.warn(f"{t.name} source blocked by nemesis gate"); return 1
    if DRY_RUN:
        Log.step(f"[dry-run] write {cf}")
        Log.step(f"[dry-run] {name} build -t {ARMORY_TOOL_PREFIX}-{t.id} -f {cf} {cf.parent}")
        return 0
    cf.write_text(content)
    Log.warn("build needs network to fetch the tool; the runtime sandbox stays airgapped by default.")
    if not _confirm(f"Build the {t.name} sandbox image now?"):
        Log.warn("declined"); return 0
    rc = run([engine, "build", "-t", f"{ARMORY_TOOL_PREFIX}-{t.id}", "-f", str(cf), str(cf.parent)], check=False).returncode
    if rc != 0:
        Log.err(f"{t.name} image build failed (rc={rc})"); return 1
    Log.ok(f"{t.name} built into its armored image: {ARMORY_TOOL_PREFIX}-{t.id}")
    Log.step(f"open a hardened shell: `pentest shell {t.id}`   ·   run: `pentest run {t.id} -- {t.entry or '<args>'}`")
    return 0


def _engagement_dir() -> Path:
    d = _pentest_dir() / "engagement"
    if not DRY_RUN:
        d.mkdir(parents=True, exist_ok=True)
    return d


def _pentest_shell(t: PentestTool, osi: OSInfo, allow_net: bool) -> int:
    if not _require_scope():
        return 1
    eng = _oci_engine()
    if not eng:
        Log.err("no container engine"); return 2
    engine, name = eng
    image = f"{ARMORY_TOOL_PREFIX}-{t.id}"
    _, images = _armory_status_line(engine)
    if image not in images and not DRY_RUN:
        Log.err(f"{t.name} not built — `pentest install {t.id}` first"); return 2
    runtime = _strongest_runtime(engine)
    net = "bridge" if allow_net else "none"
    if allow_net:
        Log.warn("EGRESS ENABLED for this session — only touch ROE-listed in-scope targets. You are responsible.")
        if not _confirm("Enable network for this sandbox session?"):
            Log.warn("declined — staying airgapped"); net = "none"
    Log.head(f"Armored shell: {t.name}   (runtime={runtime or 'runc'}, network={net})")
    Log.step(f"engagement loot dir (the only writable mount): {_engagement_dir()} → /engagement")
    Log.step(f"launch tip: {t.entry}" if t.entry else "tool is on PATH inside the sandbox")
    argv = _armor_run(engine, runtime, image, net=net, engagement=_engagement_dir(), interactive=True)
    if DRY_RUN:
        Log.step("[dry-run] " + " ".join(argv)); return 0
    return run(argv, check=False).returncode


def _pentest_run(t: PentestTool, osi: OSInfo, tool_args: list[str], allow_net: bool) -> int:
    if not _require_scope():
        return 1
    eng = _oci_engine()
    if not eng:
        Log.err("no container engine"); return 2
    engine, name = eng
    image = f"{ARMORY_TOOL_PREFIX}-{t.id}"
    _, images = _armory_status_line(engine)
    if image not in images and not DRY_RUN:
        Log.err(f"{t.name} not built — `pentest install {t.id}` first"); return 2
    runtime = _strongest_runtime(engine)
    net = "bridge" if allow_net else "none"
    if allow_net:
        Log.warn("EGRESS ENABLED — in-scope ROE targets ONLY.")
    if t.needs_net and not allow_net:
        Log.warn(f"{t.name} usually needs egress to a target — re-run with `--allow-net` (still scoped to your ROE).")
    Log.head(f"Armored run: {t.name} {' '.join(tool_args)}   (network={net})")
    argv = _armor_run(engine, runtime, image, net=net, engagement=_engagement_dir(),
                      interactive=False, cmd=tool_args or None)
    if DRY_RUN:
        Log.step("[dry-run] " + " ".join(argv)); return 0
    return run(argv, check=False).returncode


def _pentest_uninstall(t: PentestTool) -> int:
    eng = _oci_engine()
    if not eng:
        Log.err("no container engine"); return 2
    engine, _ = eng
    image = f"{ARMORY_TOOL_PREFIX}-{t.id}"
    if not _confirm(f"Remove the {t.name} sandbox image ({image})?"):
        Log.warn("declined"); return 0
    run([engine, "rmi", "-f", image], check=False)
    if not DRY_RUN:
        (_pentest_dir() / f"Containerfile.{t.id}").unlink(missing_ok=True)
    Log.ok(f"{t.name} removed")
    return 0


def _pentest_destroy() -> int:
    eng = _oci_engine()
    Log.head("Destroy the entire Pentest Armory")
    Log.warn("removes ALL armory images (base + every tool). The engagement loot dir is KEPT unless you also confirm.")
    if not _confirm("Remove all armory images now?"):
        Log.warn("declined"); return 0
    if eng:
        engine, _ = eng
        _, images = _armory_status_line(engine)
        for img in sorted(images):
            if img == ARMORY_BASE_IMAGE or img.startswith(f"{ARMORY_TOOL_PREFIX}-"):
                run([engine, "rmi", "-f", img], check=False)
    if _engagement_dir().exists() and _confirm(f"also DELETE the engagement loot dir {_engagement_dir()} (your findings)?"):
        _rmtree(_engagement_dir())
    Log.ok("armory destroyed")
    return 0


def _pentest_status(osi: OSInfo) -> int:
    Log.head("Pentest Armory — status")
    ok, reasons = _scope_ok()
    Log.ok("ROE: authorized") if ok else Log.warn("ROE: NOT authorized (" + "; ".join(reasons) + ")")
    eng = _oci_engine()
    if not eng:
        Log.warn("no container engine (Podman/Docker) — the sandbox cannot run"); return 0
    engine, name = eng
    runtime = _strongest_runtime(engine)
    _, images = _armory_status_line(engine)
    print(f"  engine: {name}   runtime: {runtime or 'runc (host kernel — install gVisor/Kata for stronger armor)'}")
    print(f"  base image: {'built' if ARMORY_BASE_IMAGE in images else 'NOT built'}   ·   network default: none (airgapped)")
    built = [t.id for t in PENTEST_TOOLS if f"{ARMORY_TOOL_PREFIX}-{t.id}" in images]
    print(f"  tools built: {', '.join(built) if built else '(none)'}")
    print(f"  seccomp profile: {'present' if (_pentest_dir()/'seccomp-armored.json').exists() else 'absent (run pentest build)'}")
    print(f"  engagement dir: {_engagement_dir()}")
    return 0


def _pentest_wizard(osi: OSInfo) -> int:
    if not sys.stdin.isatty():
        Log.err("wizard needs an interactive terminal"); return 2
    while True:
        eng = _oci_engine()
        _print_pentest_tools(eng[0] if eng else None)
        print("  b) build/rebuild sandbox base   ·   s) ROE scope   ·   x) status   ·   D) destroy all   ·   q) quit")
        raw = input("  armory> ").strip()
        if raw in ("q", "Q", ""):
            return 0
        if raw == "b":
            _pentest_build(osi, kali=_confirm("use the Kali base image (heavier, more tools preinstalled)?")); continue
        if raw == "s":
            cmd_pentest_scope(write=False); continue
        if raw == "x":
            _pentest_status(osi); continue
        if raw == "D":
            _pentest_destroy(); continue
        t = pentest_tool_registry().get(raw.lower())
        if not t:
            Log.warn("unknown tool id"); continue
        if t.kind == "agent":
            acts = ["install", "run", "update", "enable", "disable", "status", "uninstall"]
            for i, a in enumerate(acts, 1):
                print(f"  {i}) {a}")
            sel = input(f"  {t.id} action> ").strip()
            {"1": lambda: _pentagent_install(t, osi),
             "2": lambda: _pentagent_run(t, osi, input("  args (after the tool name)> ").strip().split(),
                                         _confirm("enable egress (in-scope targets only)?")),
             "3": lambda: _pentagent_update(t, osi),
             "4": lambda: _pentagent_service(t, True),
             "5": lambda: _pentagent_service(t, False),
             "6": lambda: _pentagent_status(t),
             "7": lambda: _pentagent_uninstall(t)}.get(sel, lambda: None)()
            input("  ↵ to return "); continue
        if t.kind == "orchestrator":
            acts = ["install", "enable", "disable", "logs", "status", "uninstall"]
            for i, a in enumerate(acts, 1):
                print(f"  {i}) {a}")
            sel = input(f"  {t.id} action> ").strip()
            {"1": lambda: _orchestrator_install(t, osi), "2": lambda: _orchestrator_service(t, True),
             "3": lambda: _orchestrator_service(t, False), "4": lambda: _orchestrator_logs(t),
             "5": lambda: _orchestrator_status(t), "6": lambda: _orchestrator_uninstall(t)}.get(sel, lambda: None)()
            input("  ↵ to return "); continue
        acts = ["install", "shell", "run", "uninstall"]
        for i, a in enumerate(acts, 1):
            print(f"  {i}) {a}")
        sel = input(f"  {t.id} action> ").strip()
        if sel == "1":
            _pentest_install(t, osi)
        elif sel == "2":
            _pentest_shell(t, osi, allow_net=_confirm("enable egress (in-scope targets only)?"))
        elif sel == "3":
            argline = input("  args (after the tool name)> ").strip()
            _pentest_run(t, osi, argline.split(), allow_net=_confirm("enable egress (in-scope targets only)?"))
        elif sel == "4":
            _pentest_uninstall(t)
        input("  ↵ to return ")


# ----------------------------------------------------------------------------
#  AI ORCHESTRATORS (e.g. PentAGI) — SELF-ISOLATING compose stacks.
#
#  SECURITY DECISION (PentAGI): an autonomous agent that spawns its OWN tool
#  containers MUST talk to a Docker daemon — so it cannot run inside the per-tool
#  armor (`--network none`, `--cap-drop ALL`, no socket): that armor would both
#  break it AND, to make it work, force us to mount the host docker socket into a
#  container = root-equivalent host escape = the exact primitive the armor forbids.
#  Double-jailing it is therefore strictly WORSE. The correct hardening is at the
#  DAEMON boundary: keep PentAGI's own per-tool container isolation, and point it
#  at a DEDICATED, ISOLATED docker-in-docker daemon (DOCKER_HOST=tcp://dind) with
#  the host socket replaced by /dev/null — so its workers spawn inside the nested
#  daemon and NEVER touch your host. Still ROE-gated + localhost-only + scanned.
# ----------------------------------------------------------------------------
_DIND_OVERRIDE = """\
# Prometheus hardening override — run PentAGI's tool containers in an ISOLATED
# docker-in-docker daemon instead of on your HOST docker socket. Compose auto-merges
# this with docker-compose.yml. The base compose is ALSO rewritten (host socket bind
# stripped, ports pinned to 127.0.0.1) so this does not merely rely on env overrides.
services:
  dind:
    image: docker:27-dind
    privileged: true            # a nested daemon needs this; its blast radius is the
    restart: unless-stopped     # dind container only — the HOST daemon is never exposed
    environment:
      DOCKER_TLS_CERTDIR: ""
    # 2375 is NOT published to the host (no `ports:`) → only PentAGI on the compose
    # network can reach it; your machine + LAN cannot touch this daemon.
    command: ["dockerd", "--host=tcp://0.0.0.0:2375", "--storage-driver=overlay2"]
    networks: [default]          # default net = egress so dind can pull tool images
    volumes:
      - pentagi-dind-storage:/var/lib/docker   # nested images/layers stay in a named volume
    tmpfs:
      - /run
  pentagi:
    environment:
      DOCKER_HOST: "tcp://dind:2375"   # PentAGI spawns workers in the nested daemon
    depends_on:
      - dind
    security_opt:
      - "no-new-privileges:true"       # block setuid privilege escalation inside the container
    pids_limit: 4096                    # fork-bomb / runaway ceiling
    mem_limit: 6g                       # resource-abuse ceiling
    restart: unless-stopped
volumes:
  pentagi-dind-storage:
"""


def _harden_pentagi_compose(text: str) -> tuple[str, list[str]]:
    """Rewrite the upstream compose to be escape-resistant WITHOUT a YAML lib:
    (1) neutralize any host `/var/run/docker.sock` bind (the root-equiv host-escape
        primitive) so PentAGI can never reach the HOST docker daemon; (2) pin every
        published port to 127.0.0.1 so nothing is exposed to the LAN. Returns the new
        text + a list of the changes applied (for the report)."""
    out: list[str] = []
    changes: list[str] = []
    cur_key: Optional[str] = None
    for line in text.splitlines():
        stripped = line.strip()
        m = re.match(r"^(\s{2,})([A-Za-z0-9_]+):\s*$", line)        # a key that opens a block (ports:/volumes:)
        if m:
            cur_key = m.group(2)
        elif re.match(r"^\S", line):                                # back to column 0 → reset
            cur_key = None
        if "docker.sock" in line and not stripped.startswith("#"):
            out.append(re.sub(r"^(\s*)-",
                              r"\1# [prometheus-hardened: host docker socket removed] -", line))
            changes.append("removed the host /var/run/docker.sock bind mount (no host-daemon access)")
            continue
        if cur_key == "ports" and stripped.startswith("- "):
            new = line
            if "0.0.0.0:" in new:
                new = new.replace("0.0.0.0:", "127.0.0.1:")
                changes.append("rebound a 0.0.0.0 published port to 127.0.0.1")
            else:
                mm = re.match(r'^(\s*-\s*"?)(\d+:\d+)("?)\s*$', new)   # bare host:container (no interface)
                if mm:
                    new = f"{mm.group(1)}127.0.0.1:{mm.group(2)}{mm.group(3)}"
                    changes.append("pinned a published port to 127.0.0.1 (no LAN exposure)")
            out.append(new)
            continue
        out.append(line)
    return "\n".join(out) + "\n", changes


_HARDENING_REPORT = """\
# PentAGI — Prometheus hardening report

PentAGI is an AUTONOMOUS offensive agent that spawns a container per tool. It is NOT
wrapped in the per-tool armored sandbox (that would need the host docker socket inside a
container = root-equivalent host escape — strictly worse). Instead it is contained at the
**daemon boundary**, with these controls applied at install time:

1. **Host docker socket removed.** The upstream compose's `/var/run/docker.sock` bind was
   stripped from `docker-compose.yml` AND `PENTAGI_DOCKER_SOCKET=/dev/null` set in `.env`.
   PentAGI therefore cannot drive your HOST Docker daemon (no host-fs mounts, no privileged
   host containers, no host escape via the daemon).
2. **Isolated nested daemon (DinD).** `docker-compose.override.yml` adds a `docker:dind`
   sidecar; `DOCKER_HOST=tcp://dind:2375` routes all worker containers INTO that nested
   daemon. Their blast radius is the dind container, not your machine.
3. **Nested daemon not exposed.** dind's 2375 is unpublished → unreachable from your host or
   LAN; only PentAGI on the compose network can use it. Nested images live in a named volume.
4. **No LAN exposure.** Every published port (UI :8443, db, scraper) is pinned to 127.0.0.1.
5. **Escalation + resource limits.** `no-new-privileges:true`, `pids_limit`, `mem_limit` on
   the PentAGI service.
6. **Secrets stay yours.** Only `${ENV}` placeholders are written; you paste your LLM key.
   Install is ROE-gated and the compose is security-scanned before it runs.

## Residual risk (be aware)
- The dind sidecar is `privileged: true` — a nested daemon requires it. A breakout from a
  TOOL container lands in the dind container, still isolated from your host (separate
  namespaces, no host mounts, no host socket) — but it is not zero. For maximum isolation
  run the whole stack in a throwaway VM, or give dind a gVisor/Kata runtime.
- Egress: dind needs internet to pull tool images, and PentAGI needs it for LLM APIs +
  targets. Keep the machine on a segmented network and only test ROE-listed targets.

To switch to the (less safe) host-socket mode, reinstall and answer "No" to the isolated
docker-in-docker prompt.
"""


def _orchestrator_dir(t: PentestTool) -> Path:
    return _pentest_dir() / "orchestrators" / t.id


def _orchestrator_install(t: PentestTool, osi: OSInfo) -> int:
    if not _require_scope():
        return 1
    if not _docker_bin():
        Log.err("docker (with the compose plugin) required for an orchestrator stack"); return 2
    Log.head(f"Install AI orchestrator: {t.name}")
    print(f"  {t.blurb}")
    Log.warn(t.isolation_note)
    if t.autonomous:
        Log.warn("AUTONOMOUS OFFENSIVE AGENT: it plans and EXECUTES actions against targets on its own.")
        if not _confirm("You accept full responsibility and will keep it to in-scope ROE targets?"):
            Log.warn("declined"); return 0
    Log.step(f"secrets: {t.secrets_note}")
    # isolation mode choice — default to the hardened isolated daemon
    isolated = True
    if sys.stdin.isatty() and not (ASSUME_YES or FORCE):
        isolated = _confirm("Use the HARDENED isolated docker-in-docker daemon (recommended; "
                            "answer No only if you deliberately want it on your host socket)?")
    folder = _orchestrator_dir(t)
    Log.info(f"stack folder: {folder}")
    if DRY_RUN:
        Log.step(f"[dry-run] mkdir -p {folder}")
    else:
        folder.mkdir(parents=True, exist_ok=True)
    # fetch + SCAN compose
    applied: list[str] = []
    if not DRY_RUN:
        compose = _fetch_url_text(t.compose_url)
        if compose is None:
            return 2
        if not NO_SCAN:
            rep = ScanReport(t.id, t.compose_url, "pentagi:" + str(abs(hash(compose)))[:8],
                             _scan_text("docker-compose.yml", compose), 0)
            if not security_gate(rep, "local"):
                Log.warn(f"{t.name} compose blocked by security gate"); return 1
        if not enforce_gate_text(compose, f"{t.id} compose ({t.compose_url})", tier="pentest"):
            Log.warn(f"{t.name} compose blocked by nemesis gate"); return 1
        # REWRITE the upstream compose for escape-resistance (not just env overrides):
        # strip the host docker-socket bind + pin published ports to 127.0.0.1.
        if isolated:
            compose, applied = _harden_pentagi_compose(compose)
            for c in applied:
                Log.ok(f"compose hardened: {c}")
        (folder / "docker-compose.yml").write_text(compose)
        # .env (placeholders only — never write real keys)
        envp = folder / ".env"
        if not envp.exists():
            env = _fetch_url_text(t.env_url) or ""
            # .env values interpolate into the (gated) compose — image tags,
            # DOCKER_HOST, ports — so the env body gets the same gate.
            if env.strip() and not enforce_gate_text(env, f"{t.id} env ({t.env_url})",
                                                     tier="pentest"):
                Log.warn(f"{t.name} env template blocked by nemesis gate"); return 1
            extra = ["", "# --- Prometheus hardening (do not expose beyond localhost) ---",
                     "PENTAGI_LISTEN_IP=127.0.0.1"]
            if isolated:
                extra += ["PENTAGI_DOCKER_SOCKET=/dev/null   # host socket NEUTRALIZED (belt + suspenders)",
                          "DOCKER_HOST=tcp://dind:2375        # use the isolated nested daemon"]
            envp.write_text(env + "\n".join(extra) + "\n")
            Log.ok("wrote .env (placeholders only — paste your own LLM key, never committed by Prometheus)")
        if isolated:
            (folder / "docker-compose.override.yml").write_text(_DIND_OVERRIDE)
            (folder / "HARDENING.md").write_text(_HARDENING_REPORT)
            Log.ok("isolated docker-in-docker override + HARDENING.md written — host docker socket NOT exposed")
        else:
            Log.warn("HOST-SOCKET MODE: PentAGI gets /var/run/docker.sock = root-equivalent on this host. Trusted machines only.")
    _write_app_marker(folder, {"tool": t.id, "kind": "orchestrator", "repo": t.repo,
                               "srcdir": str(folder), "compose_project": t.compose_project,
                               "port": t.port, "isolated": isolated, "hardened": applied})
    if isolated:
        Log.head("Hardening applied (full report in HARDENING.md)")
        for line in ("host docker socket bind REMOVED from the compose (+ /dev/null in .env) → no host-daemon access",
                     "tool containers spawn in an ISOLATED docker-in-docker daemon (DOCKER_HOST=tcp://dind:2375)",
                     "nested daemon port 2375 UNPUBLISHED → unreachable from host/LAN",
                     "all published ports pinned to 127.0.0.1 (no LAN exposure)",
                     "no-new-privileges + pids_limit + mem_limit on the PentAGI service",
                     "residual: the dind sidecar is privileged — a tool breakout stays inside dind, not your host (run in a VM / gVisor for more)"):
            Log.step(line)
    Log.warn(f"{t.name} needs your LLM key before first start — NOT auto-starting.")
    Log.step(f"1) edit {folder / '.env'} — set ≥1 LLM key (and DB creds if blank)")
    Log.step(f"2) start it: `pentest enable {t.id}`   ·   UI then on https://localhost:{t.port}")
    Log.step(f"manage: `pentest status|logs|disable|uninstall {t.id}`   ·   details: {folder / 'HARDENING.md'}")
    return 0


def _orchestrator_service(t: PentestTool, on: bool) -> int:
    if not _require_scope():
        return 1
    if not _docker_bin():
        Log.err("docker not found"); return 2
    folder = _orchestrator_dir(t)
    if not (folder / "docker-compose.yml").exists() and not DRY_RUN:
        Log.err(f"{t.name} not installed — `pentest install {t.id}` first"); return 2
    pref = ["docker", "compose", "-p", t.compose_project] if t.compose_project else ["docker", "compose"]
    Log.head(f"{'Enable (start)' if on else 'Disable (stop)'} {t.name}")
    if on:
        Log.warn("starting an AUTONOMOUS offensive agent — keep it to in-scope ROE targets.")
    rc = _run_in(pref + (["up", "-d"] if on else ["down"]), folder)
    if rc == 0 and on and t.port:
        Log.ok(f"{t.name} up → https://localhost:{t.port}")
    elif rc == 0:
        Log.ok(f"{t.name} stopped")
    return 0 if rc == 0 else 1


def _orchestrator_logs(t: PentestTool) -> int:
    if not _docker_bin():
        Log.err("docker not found"); return 2
    folder = _orchestrator_dir(t)
    pref = ["docker", "compose", "-p", t.compose_project] if t.compose_project else ["docker", "compose"]
    Log.head(f"{t.name} — last logs")
    return _run_in(pref + ["logs", "--tail", "80"], folder)


def _orchestrator_status(t: PentestTool) -> int:
    Log.head(f"{t.name} — status")
    folder = _orchestrator_dir(t)
    marker = _read_app_marker(folder)
    if not marker:
        Log.warn(f"not installed — `pentest install {t.id}`"); return 0
    print(f"  isolation: {'isolated docker-in-docker (host socket neutralized)' if marker.get('isolated') else 'HOST docker socket (advanced)'}")
    print(f"  folder: {folder}   ·   UI: https://localhost:{marker.get('port')}")
    if _docker_bin():
        pref = ["docker", "compose", "-p", t.compose_project] if t.compose_project else ["docker", "compose"]
        _run_in(pref + ["ps"], folder)
    Log.step(f"enable: `pentest enable {t.id}` · disable: `pentest disable {t.id}` · logs: `pentest logs {t.id}`")
    return 0


def _orchestrator_uninstall(t: PentestTool) -> int:
    if not _docker_bin():
        Log.err("docker not found"); return 2
    folder = _orchestrator_dir(t)
    pref = ["docker", "compose", "-p", t.compose_project] if t.compose_project else ["docker", "compose"]
    Log.head(f"Uninstall {t.name}")
    Log.warn(f"tears down the stack (`compose down -v`, drops its volumes/data) and deletes {folder}")
    if not _confirm(f"Remove {t.name} entirely?"):
        Log.warn("declined"); return 0
    if (folder / "docker-compose.yml").exists():
        _run_in(pref + ["down", "-v"], folder)
    _rmtree(folder)
    Log.ok(f"{t.name} removed")
    return 0


# ----------------------------------------------------------------------------
#  AI PENTEST AGENTS — host-side autonomous agents installed into an ISOLATED
#  workspace (uninstall = delete the folder), ROE-gated like the rest of the armory.
#
#  These are NOT wrapped in the per-tool armor for the SAME reason as PentAGI: each
#  one drives its OWN sandbox (Strix/Shannon/ptai/Hunter spawn their own Docker
#  worker or wrap a Kali box; Revelion is a daemon for a cloud platform). They need
#  a Docker daemon / host tools / LLM egress, so `--network none --cap-drop ALL`
#  would simply break them. The safest install we CAN give is therefore a dedicated,
#  self-contained workspace (venv / local node_modules / git-checkout / go-build),
#  ${ENV} key placeholders only, reversible enable/disable, and a clear disclosure.
# ----------------------------------------------------------------------------
def _pentagents_root() -> Path:
    return _pentest_dir() / "agents"


def _pentagent_dir(t: PentestTool) -> Path:
    return _pentagents_root() / t.id


def _pentagent_env_file(t: PentestTool) -> Path:
    return _pentagent_dir(t) / ".env"


def _pentagent_disabled_marker(t: PentestTool) -> Path:
    return _pentagent_dir(t) / ".prometheus_disabled"


def _pentagent_bindir(t: PentestTool) -> Optional[Path]:
    folder = _pentagent_dir(t)
    if t.install_kind in ("python-venv", "git-venv"):
        return folder / "venv" / ("Scripts" if os.name == "nt" else "bin")
    if t.install_kind == "node-npm":
        return folder / "node_modules" / ".bin"
    if t.install_kind == "go-build":
        return folder / "bin"
    return None


def _pentagent_workdir(t: PentestTool) -> Path:
    folder = _pentagent_dir(t)
    if t.install_kind in ("git-venv", "go-build", "git-manual"):
        base = folder / "src"
        return (base / t.subdir) if t.subdir else base
    return folder


def _pentagent_env_keys(t: PentestTool) -> list[str]:
    return sorted(set(re.findall(r"\$\{([A-Z0-9_]+)\}", t.secrets_note or "")))


def _pentagent_write_env(t: PentestTool) -> None:
    """Write ONLY ${ENV} placeholders — never a real key (user pastes their own)."""
    p = _pentagent_env_file(t)
    if DRY_RUN or p.exists():
        return
    lines = ["# Prometheus wrote ONLY placeholders — paste your own values; never commit this file.",
             f"# {t.name}: {t.secrets_note}", ""]
    lines += [f"{k}=" for k in _pentagent_env_keys(t)]
    p.write_text("\n".join(lines) + "\n")
    Log.ok("wrote .env (key placeholders only — Prometheus never writes real secrets)")


# ---- install (per install_kind) --------------------------------------------
def _pentagent_install_pyvenv(t: PentestTool, osi: OSInfo, folder: Path) -> int:
    venv = folder / "venv"
    Log.step(f"create isolated venv → {venv}")
    if not DRY_RUN:
        run([sys.executable, "-m", "venv", str(venv)], check=False)
    pip = str(_pentagent_bindir(t) / "pip")
    pkg = t.pypi or t.id
    Log.step(f"pip install {pkg}  (into the isolated venv)")
    if DRY_RUN:
        return 0
    run([pip, "install", "--upgrade", "pip"], check=False)
    rc = run([pip, "install", pkg], check=False).returncode
    if rc != 0:
        Log.err(f"pip install {pkg} failed (rc={rc})"); return 1
    return 0


def _pentagent_install_node(t: PentestTool, osi: OSInfo, folder: Path) -> int:
    npm = shutil.which("npm")
    if not npm:
        Log.err("Node.js/npm required (Node 18+). Install Node, then retry."); return 2
    Log.step(f"npm install {t.npm_pkg}  (local to the workspace — delete-folder uninstall)")
    if DRY_RUN:
        return 0
    _run_in([npm, "init", "-y"], folder)
    rc = _run_in([npm, "install", t.npm_pkg], folder)
    if rc != 0:
        Log.err(f"npm install {t.npm_pkg} failed (rc={rc})"); return 1
    return 0


def _pentagent_scan_src(t: PentestTool, src: Path) -> bool:
    if DRY_RUN or not src.exists():
        return True
    if not NO_SCAN:
        Log.step("security scan of the cloned source")
        rep = ScanReport(t.id, t.git_clone or t.repo, _git_identity(src), _walk_and_scan(src), 0)
        if not security_gate(rep, "local"):
            Log.warn(f"{t.name} source blocked by security gate"); return False
    # deep nemesis pass — offensive-security sources get the strict pentest policy
    if not enforce_gate(str(src), f"{t.id} ({t.git_clone or t.repo})", tier="pentest"):
        Log.warn(f"{t.name} source blocked by nemesis gate — inspect with: nemesis ui {src}")
        return False
    return True


def _pentagent_install_gitvenv(t: PentestTool, osi: OSInfo, folder: Path) -> int:
    git = shutil.which("git")
    if not git:
        Log.err("git not found"); return 2
    src = folder / "src"
    if not DRY_RUN and not (src.exists() and any(src.iterdir())):
        Log.step(f"git clone {t.git_clone} → src/")
        run([git, "clone", "--depth", "1", t.git_clone, str(src)])
    elif DRY_RUN:
        Log.step(f"[dry-run] git clone {t.git_clone} → src/")
    if not _pentagent_scan_src(t, src):
        return 1
    venv = folder / "venv"
    Log.step(f"create isolated venv → {venv}")
    if not DRY_RUN:
        run([sys.executable, "-m", "venv", str(venv)], check=False)
    pip = str(_pentagent_bindir(t) / "pip")
    req = _pentagent_workdir(t) / (t.requirements or "requirements.txt")
    Log.step(f"pip install -r {req}")
    if DRY_RUN:
        return 0
    run([pip, "install", "--upgrade", "pip"], check=False)
    if req.exists():
        rc = run([pip, "install", "-r", str(req)], check=False).returncode
        if rc != 0:
            Log.err(f"requirements install failed (rc={rc})"); return 1
    else:
        Log.warn(f"{req} not found — the clone layout may differ; check the repo README")
    return 0


def _pentagent_go_build(t: PentestTool, folder: Path) -> int:
    go = shutil.which("go")
    if not go:
        Log.err("Go toolchain required to build this daemon. Install Go, then retry."); return 2
    src = folder / "src"
    outbin = folder / "bin"
    Log.step("go build ./cmd/... → bin/")
    if DRY_RUN:
        return 0
    outbin.mkdir(parents=True, exist_ok=True)
    rc = _run_in([go, "build", "-o", str(outbin) + os.sep, "./cmd/..."], src)
    if rc != 0:
        Log.warn("`go build ./cmd/...` failed — retrying `go build ./...`")
        rc = _run_in([go, "build", "-o", str(outbin) + os.sep, "./..."], src)
    if rc != 0:
        Log.err(f"go build failed (rc={rc})"); return 1
    return 0


def _pentagent_install_go(t: PentestTool, osi: OSInfo, folder: Path) -> int:
    git = shutil.which("git")
    if not git:
        Log.err("git not found"); return 2
    src = folder / "src"
    if not DRY_RUN and not (src.exists() and any(src.iterdir())):
        Log.step(f"git clone {t.git_clone} → src/")
        run([git, "clone", "--depth", "1", t.git_clone, str(src)])
    elif DRY_RUN:
        Log.step(f"[dry-run] git clone {t.git_clone} → src/")
    if not _pentagent_scan_src(t, src):
        return 1
    return _pentagent_go_build(t, folder)


# Curated tools the bluetooth-awesome catalog links (surfaced on install/run so the
# user gets real pointers — these need radio hardware, so they're not armory tools).
_BT_AWESOME_TOOLS = [
    ("Btlejack", "https://github.com/virtualabs/btlejack", "BLE sniffing / jamming / hijacking (BBC Micro:Bit)"),
    ("Sniffle", "https://github.com/nccgroup/sniffle", "BLE5 sniffer (TI CC1352/26x2)"),
    ("InternalBlue", "https://github.com/seemoo-lab/internalblue", "Bluetooth firmware patching / experimentation"),
    ("BtleJuice", "https://github.com/DigitalSecurity/btlejuice", "BLE man-in-the-middle framework"),
    ("BlueZ", "http://www.bluez.org/", "official Linux Bluetooth stack (hcitool / gatttool / btmgmt)"),
]


def _pentagent_install_reference(t: PentestTool, osi: OSInfo, folder: Path) -> int:
    git = shutil.which("git")
    if not git:
        Log.err("git not found"); return 2
    src = folder / "src"
    if not DRY_RUN and not (src.exists() and any(src.iterdir())):
        Log.step(f"git clone {t.git_clone} → src/  (curated catalog, for offline reference)")
        run([git, "clone", "--depth", "1", t.git_clone, str(src)])
    elif DRY_RUN:
        Log.step(f"[dry-run] git clone {t.git_clone} → src/")
    if not _pentagent_scan_src(t, src):
        return 1
    Log.ok("curated Bluetooth-security catalog cloned for OFFLINE reading (CVEs, talks, tools).")
    Log.warn("This is a READING LIST, not a scanner/program — there is nothing to 'run'.")
    Log.step(f"open: {src / 'README.md'}")
    Log.step("real Bluetooth-testing tools it curates (need RADIO hardware + a non-airgapped host):")
    for name, url, desc in _BT_AWESOME_TOOLS:
        Log.step(f"  · {name} — {desc}  ({url})")
    return 0


def _pentagent_install_gitmanual(t: PentestTool, osi: OSInfo, folder: Path) -> int:
    git = shutil.which("git")
    if not git:
        Log.err("git not found"); return 2
    src = folder / "src"
    if not DRY_RUN and not (src.exists() and any(src.iterdir())):
        Log.step(f"git clone {t.git_clone} → src/  (educational workflow, no single CLI)")
        run([git, "clone", "--depth", "1", t.git_clone, str(src)])
    elif DRY_RUN:
        Log.step(f"[dry-run] git clone {t.git_clone} → src/")
    if not _pentagent_scan_src(t, src):
        return 1
    Log.step("MCP + editor workflow — follow the repo README to wire the MCP-Kali server + your editor.")
    return 0


_PENTAGENT_INSTALLERS = {
    "python-venv": _pentagent_install_pyvenv,
    "git-venv": _pentagent_install_gitvenv,
    "node-npm": _pentagent_install_node,
    "go-build": _pentagent_install_go,
    "git-manual": _pentagent_install_gitmanual,
    "reference": _pentagent_install_reference,
}


def _pentagent_install(t: PentestTool, osi: OSInfo) -> int:
    if t.install_kind != "reference" and not _require_scope():    # reading a catalog needs no ROE
        return 1
    if t.install_kind == "reference":
        Log.head(f"Install reference catalog: {t.name}  [reference]")
    else:
        Log.head(f"Install AI pentest agent: {t.name}  [{t.category}]")
    print(f"  {t.blurb}")
    if t.isolation_note:
        Log.warn(f"isolation: {t.isolation_note}")
    if t.account_required:
        Log.warn(f"{t.name} is a CLIENT for a COMMERCIAL cloud platform — it needs a paid/registered "
                 "account + token to do anything. This installs only the local daemon, not a self-contained tool.")
        if not _confirm("Proceed installing the cloud-client daemon anyway?"):
            Log.warn("declined"); return 0
    if t.dual_use:
        Log.warn("DUAL-USE offensive tooling — authorized, in-scope targets ONLY.")
    if t.autonomous:
        Log.warn("AUTONOMOUS agent: it plans AND executes against targets on its own. You are responsible.")
        if not _confirm(f"Confirm you are authorized to run {t.name} against your in-scope ROE targets?"):
            Log.warn("declined"); return 0
    if t.secrets_note:
        Log.step(f"secrets (you provide at runtime, NEVER written by Prometheus): {t.secrets_note}")
    if t.manages_docker and not _docker_bin():
        Log.warn(f"{t.name} drives its OWN Docker sandbox — Docker is not installed; install it before running.")
    folder = _pentagent_dir(t)
    Log.info(f"isolated workspace (uninstall = delete this folder): {folder}")
    if not _confirm(f"Install {t.name} into its own isolated workspace now?"):
        Log.warn("declined"); return 0
    if not DRY_RUN:
        folder.mkdir(parents=True, exist_ok=True)
    installer = _PENTAGENT_INSTALLERS.get(t.install_kind)
    if not installer:
        Log.err(f"unknown install_kind: {t.install_kind}"); return 2
    rc = installer(t, osi, folder)
    if rc != 0:
        return rc
    _pentagent_write_env(t)
    _write_app_marker(folder, {"tool": t.id, "kind": "agent", "install_kind": t.install_kind,
                               "repo": t.repo, "srcdir": str(folder), "run_cmd": t.run_cmd,
                               "account_required": t.account_required})
    Log.ok(f"{t.name} installed into an isolated workspace (enabled by default).")
    Log.step(f"1) edit {_pentagent_env_file(t)} — paste your key(s)/token")
    if t.install_kind == "git-manual":
        Log.step(f"2) follow the repo workflow: `pentest run {t.id}` prints the steps")
    else:
        Log.step(f"2) run: `pentest run {t.id} -- {t.run_cmd or '<args>'}`")
    Log.step(f"manage: `pentest status|update|disable|enable|uninstall {t.id}`")
    return 0


def _pentagent_load_env(t: PentestTool) -> dict:
    env = dict(os.environ)
    envf = _pentagent_env_file(t)
    if envf.exists():
        for line in envf.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if v.strip():
                    env[k.strip()] = v.strip()
    bindir = _pentagent_bindir(t)
    if bindir and bindir.exists():
        env["PATH"] = f"{bindir}{os.pathsep}{env.get('PATH', '')}"
    return env


def _pentagent_run(t: PentestTool, osi: OSInfo, tool_args: list[str], allow_net: bool) -> int:
    if t.install_kind != "reference" and not _require_scope():
        return 1
    folder = _pentagent_dir(t)
    if not _read_app_marker(folder) and not DRY_RUN:
        Log.err(f"{t.name} not installed — `pentest install {t.id}` first"); return 2
    if _pentagent_disabled_marker(t).exists():
        Log.err(f"{t.name} is DISABLED — `pentest enable {t.id}` first"); return 2
    if t.install_kind == "reference":
        Log.head(f"{t.name} — curated reference catalog (read-only, NOT a scanner)")
        Log.step(f"open the list: {_pentagent_workdir(t) / 'README.md'}")
        Log.step("real Bluetooth-testing tools it curates (need radio hardware + a non-airgapped host):")
        for name, url, desc in _BT_AWESOME_TOOLS:
            Log.step(f"  · {name} — {desc}  ({url})")
        return 0
    if t.install_kind == "git-manual":
        Log.head(f"{t.name} — guided manual workflow (not a single CLI)")
        for n in (t.entry or "").split("\n"):
            if n.strip():
                Log.step(n.strip())
        Log.step(f"cloned source: {_pentagent_workdir(t)}")
        return 0
    parts = list(tool_args) if tool_args else (t.run_cmd or t.id).split()
    if not parts:
        Log.err("nothing to run"); return 2
    bindir = _pentagent_bindir(t)
    if bindir and (bindir / parts[0]).exists():
        parts[0] = str(bindir / parts[0])
    Log.head(f"Run {t.name}: {' '.join(parts)}")
    if t.account_required:
        Log.warn(f"{t.name} needs a valid Revelion account/token in {_pentagent_env_file(t)} to do anything.")
    if t.manages_docker:
        Log.warn(f"{t.name} drives its OWN Docker sandbox for the target — that sandbox is the agent's, not Prometheus's armor.")
        if not _docker_bin():
            Log.warn("Docker not found — the agent likely needs it.")
    if t.needs_net:
        Log.warn("This agent reaches the network (LLM API + the target). In-scope ROE targets ONLY.")
    cwd = _pentagent_workdir(t)
    if DRY_RUN:
        Log.step(f"[dry-run] (cd {cwd}) {' '.join(parts)}"); return 0
    try:
        return _run_timed(parts, cwd=str(cwd), env=_pentagent_load_env(t), timeout=_RUN_TIMEOUT).returncode
    except FileNotFoundError:
        Log.err(f"launch failed ({parts[0]}) — is {t.name} installed correctly?"); return 127


def _pentagent_service(t: PentestTool, on: bool) -> int:
    folder = _pentagent_dir(t)
    if not _read_app_marker(folder) and not DRY_RUN:
        Log.err(f"{t.name} not installed — `pentest install {t.id}` first"); return 2
    mk = _pentagent_disabled_marker(t)
    Log.head(f"{'Enable' if on else 'Disable'} {t.name}")
    if on:
        if not DRY_RUN:
            mk.unlink(missing_ok=True)
        Log.ok(f"{t.name} ENABLED (runnable)")
    else:
        if not DRY_RUN:
            mk.write_text("disabled by prometheus\n")
        Log.ok(f"{t.name} DISABLED — install KEPT, blocked from running until `pentest enable {t.id}` (reversible, no deletion)")
    return 0


def _pentagent_status(t: PentestTool) -> int:
    folder = _pentagent_dir(t)
    Log.head(f"{t.name} — status")
    if not _read_app_marker(folder):
        Log.warn(f"not installed — `pentest install {t.id}`"); return 0
    enabled = not _pentagent_disabled_marker(t).exists()
    envf = _pentagent_env_file(t)
    print(f"  install kind: {t.install_kind}   ·   {'ENABLED' if enabled else 'DISABLED'}")
    print(f"  workspace: {folder}")
    print(f"  env file: {envf} ({'present' if envf.exists() else 'absent'})")
    if t.manages_docker:
        print(f"  docker (for its own sandbox): {'present' if _docker_bin() else 'NOT found'}")
    if t.account_required:
        Log.warn("commercial cloud client — requires a valid Revelion account/token to function")
    Log.step(f"run: `pentest run {t.id} -- {t.run_cmd or '<args>'}`  ·  update: `pentest update {t.id}`  ·  uninstall: `pentest uninstall {t.id}`")
    return 0


def _pentagent_update(t: PentestTool, osi: OSInfo) -> int:
    if t.install_kind != "reference" and not _require_scope():
        return 1
    folder = _pentagent_dir(t)
    if not _read_app_marker(folder) and not DRY_RUN:
        Log.err(f"{t.name} not installed — `pentest install {t.id}` first"); return 2
    Log.head(f"Update {t.name}")
    if t.install_kind == "python-venv":
        pip = str(_pentagent_bindir(t) / "pip")
        if DRY_RUN:
            Log.step(f"[dry-run] {pip} install --upgrade {t.pypi or t.id}"); return 0
        rc = run([pip, "install", "--upgrade", t.pypi or t.id], check=False).returncode
    elif t.install_kind == "node-npm":
        npm = shutil.which("npm")
        if not npm:
            Log.err("npm not found"); return 2
        rc = _run_in([npm, "install", t.npm_pkg], folder)
    elif t.install_kind in ("git-venv", "go-build", "git-manual", "reference"):
        git = shutil.which("git")
        if not git:
            Log.err("git not found"); return 2
        src = folder / "src"
        rc = _run_in([git, "pull", "--ff-only"], src)
        if rc == 0 and t.install_kind == "git-venv":
            pip = str(_pentagent_bindir(t) / "pip")
            req = _pentagent_workdir(t) / (t.requirements or "requirements.txt")
            if DRY_RUN:
                Log.step(f"[dry-run] {pip} install -r {req}")
            elif req.exists():
                rc = run([pip, "install", "-r", str(req)], check=False).returncode
        if rc == 0 and t.install_kind == "go-build":
            rc = _pentagent_go_build(t, folder)
    else:
        Log.err("update not supported for this install kind"); return 2
    if rc == 0:
        Log.ok(f"{t.name} updated")
    else:
        Log.err(f"update failed (rc={rc})")
    return 0 if rc == 0 else 1


def _pentagent_uninstall(t: PentestTool) -> int:
    folder = _pentagent_dir(t)
    Log.head(f"Uninstall {t.name}")
    Log.warn(f"uninstall = delete the isolated workspace {folder} (venv/clone/build + your local .env all go).")
    if not _confirm(f"Delete the {t.name} workspace entirely?"):
        Log.warn("declined"); return 0
    if folder.exists():
        _rmtree(folder)
    Log.ok(f"{t.name} removed (folder deleted)")
    return 0


def cmd_pentest(args, osi: OSInfo) -> int:
    action = getattr(args, "action", None) or "list"
    eng = _oci_engine()
    if action == "list":
        _print_pentest_tools(eng[0] if eng else None); return 0   # human-table READ (no JSON consumer)
    if action == "wizard":
        return _pentest_wizard(osi)
    if action == "scope":
        return cmd_pentest_scope(write=getattr(args, "init", False))
    if action == "runtimes" or (action == "status" and not getattr(args, "tool", None)):
        return _pentest_status(osi)
    if action == "build":
        return _pentest_build(osi, kali=getattr(args, "kali", False))
    if action == "destroy":
        return _pentest_destroy()
    # tool-scoped actions
    if not getattr(args, "tool", None):
        Log.err(f"usage: pentest {action} <tool-id>  (see `pentest list`)"); return 2
    t = pentest_tool_registry().get(args.tool)
    if not t:
        Log.err(f"unknown tool: {args.tool}. Try: pentest list"); return 2
    allow_net = getattr(args, "allow_net", False)
    # AI ORCHESTRATORS (PentAGI) are self-isolating compose stacks — NOT wrapped in
    # the per-tool armor (see the SECURITY DECISION note above). Route them separately.
    if t.kind == "orchestrator":
        if action == "install":
            return _orchestrator_install(t, osi)
        if action == "uninstall":
            return _orchestrator_uninstall(t)
        if action == "enable":
            return _orchestrator_service(t, True)
        if action == "disable":
            return _orchestrator_service(t, False)
        if action == "logs":
            return _orchestrator_logs(t)
        if action in ("status",):
            return _orchestrator_status(t)
        Log.err(f"{t.name} is an orchestrator — use install/enable/disable/logs/status/uninstall (not shell/run/build)."); return 2
    # AI PENTEST AGENTS (Strix/ptai/Shannon/Pluto/Hunter/Revelion/…) — host-side,
    # isolated-workspace installs that drive their own sandbox (see note above).
    if t.kind == "agent":
        if action == "install":
            return _pentagent_install(t, osi)
        if action == "uninstall":
            return _pentagent_uninstall(t)
        if action == "enable":
            return _pentagent_service(t, True)
        if action == "disable":
            return _pentagent_service(t, False)
        if action == "status":
            return _pentagent_status(t)
        if action == "update":
            return _pentagent_update(t, osi)
        if action == "run":
            ta = list(getattr(args, "args", None) or [])
            if ta and ta[0] == "--":
                ta = ta[1:]
            return _pentagent_run(t, osi, ta, allow_net)
        Log.err(f"{t.name} is a host agent — use install/run/update/enable/disable/status/uninstall (not {action})."); return 2
    if action in ("enable", "disable", "logs"):
        Log.err(f"{t.name} is a sandboxed tool — use install/shell/run/uninstall (enable/disable/logs are for orchestrators)."); return 2
    if action == "install":
        return _pentest_install(t, osi)
    if action == "uninstall":
        return _pentest_uninstall(t)
    if action == "shell":
        return _pentest_shell(t, osi, allow_net)
    if action == "run":
        ta = list(getattr(args, "args", None) or [])
        if ta and ta[0] == "--":                      # argparse REMAINDER keeps the separator
            ta = ta[1:]
        return _pentest_run(t, osi, ta, allow_net)
    Log.err(f"unknown action: {action}"); return 2


# ============================================================================
#  SECTION 6F — REPO VAULT  (7th functionality — offline versioned ZIP archive)
# ----------------------------------------------------------------------------
#  Download EVERY repo this script knows (plugins + model tools + apps + pentest)
#  as a ZIP and keep them, versioned, on local disk so you can roll back OFFLINE.
#
#  Tree (root folder is literally named "prometheus", placed wherever you pick):
#     <your-path>/prometheus/
#       <repo-id>/
#         <repo-id>-<version>.zip        # every downloaded version kept (history)
#         .prometheus_vault.json         # manifest: versions[], installed{}
#
#  Flags (top-level, primary interface):
#     --invoke       wizard: pick repos → download/refresh their ZIPs (re-pulls
#                    only when GitHub has a NEWER version; keeps old ones)
#     --invoke-all   skip the wizard → fetch the latest ZIP of EVERY repo (you
#                    only choose where the "prometheus" folder lives)
#     --rollback     pick a repo → roll back to a STORED (offline) version, or —
#                    if none stored and you're online — pick an older GitHub
#                    version; it's downloaded into the vault AND extracted/installed
# ============================================================================
@dataclass
class VaultRepo:
    id: str
    name: str
    source: str        # plugin | model | app | pentest
    owner: str
    repo: str
    url: str


def _vault_slug(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", (s or "").strip().lower()).strip("-._")
    return s or "repo"


def _gh_owner_repo(ref: Optional[str]) -> Optional[tuple[str, str]]:
    """Accept a full github URL OR a short 'owner/repo'. Return (owner, repo) or None."""
    if not ref:
        return None
    ref = ref.strip().rstrip("/")
    if ref.startswith("http"):
        m = re.match(r"https?://github\.com/([^/]+)/([^/]+)", ref)
        if not m:
            return None
        owner, repo = m.group(1), m.group(2)
    elif "github.com" not in ref and " " not in ref and ref.count("/") == 1:
        owner, repo = ref.split("/")
    else:
        return None
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not owner or not repo:
        return None
    return owner, repo


def _vault_all_repos() -> list[VaultRepo]:
    """Every GitHub repo referenced by the script, de-duplicated by owner/repo."""
    seen: dict[str, VaultRepo] = {}
    used_ids: set[str] = set()

    def add(rid: str, name: str, source: str, ref: Optional[str]) -> None:
        pr = _gh_owner_repo(ref)
        if not pr:
            return
        owner, repo = pr
        key = f"{owner}/{repo}".lower()
        if key in seen:
            return
        fid = _vault_slug(rid or repo)
        if fid in used_ids:                       # folder-name collision → disambiguate
            fid = _vault_slug(f"{owner}-{repo}")
        used_ids.add(fid)
        seen[key] = VaultRepo(id=fid, name=name or repo, source=source,
                              owner=owner, repo=repo, url=f"https://github.com/{owner}/{repo}")

    for p in PLUGINS:
        add(p.name, p.name, "plugin", p.repo or (f"{p.owner}/{p.name}" if p.owner else None))
    for t in MODEL_TOOLS:
        add(t.id, t.name, "model", t.repo)
    for t in REPO_TOOLS:
        add(t.id, t.name, "app", t.repo)
    for t in WORLDSIM_TOOLS:
        add(t.id, t.name, "worldsim", t.repo)
    for t in PENTEST_TOOLS:
        add(t.id, t.name, "pentest", t.repo)
    return list(seen.values())


# ---- GitHub metadata + download (stdlib only; works unauthenticated) --------
def _online() -> bool:
    """Can we reach GitHub at all?

    ANY HTTP response proves connectivity — including 403. This used to catch every exception
    and return False, so an exhausted anonymous API quota (GitHub answers 403 "API rate limit
    exceeded") made a fully-online machine report itself OFFLINE, and every vault operation
    quietly did nothing while reporting success. Verified against a local server answering 403:
    the old shape returned False.
    """
    try:
        urllib.request.urlopen("https://api.github.com", timeout=6)    # noqa: S310
        return True
    except urllib.error.HTTPError:
        return True            # we reached GitHub; it just refused this request
    except Exception:
        return False


def _gh_rate_limited(e: "urllib.error.HTTPError") -> bool:
    """Is this HTTPError GitHub's anonymous-quota refusal (403/429 + a zero remaining budget)?"""
    if e.code not in (403, 429):
        return False
    remaining = e.headers.get("X-RateLimit-Remaining") if e.headers else None
    if remaining == "0":
        return True
    try:
        return "rate limit" in (e.read().decode("utf-8", "replace") or "").lower()
    except Exception:  # noqa: BLE001
        return False


def _gh_api(path: str):
    """One GitHub API call. Returns the parsed body, or None when the resource is unavailable.

    A rate-limit refusal RAISES instead of returning None. It used to collapse into the same
    None as a 404, so the caller concluded "no version on record" and moved on: the command
    reported ok:true having checked nothing. Those are opposite facts — "there is no newer
    version" versus "I was not allowed to look" — and only one of them is safe to act on.
    `main()` turns the RuntimeError into a clean message and a proper --json envelope.
    """
    url = f"https://api.github.com/{path}"
    try:
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json", "User-Agent": "prometheus-vault"})
        with urllib.request.urlopen(req, timeout=20) as r:              # noqa: S310
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        if _gh_rate_limited(e):
            reset = (e.headers.get("X-RateLimit-Reset") if e.headers else None) or ""
            when = ""
            if reset.isdigit():
                when = f" (resets at {time.strftime('%H:%M', time.localtime(int(reset)))})"
            raise RuntimeError(
                "GitHub's anonymous API quota is exhausted" + when +
                " — cannot check versions. Wait for the reset, or set GITHUB_TOKEN."
            ) from e
        return None
    except Exception:
        return None


def _gh_latest_version(vr: VaultRepo) -> Optional[tuple[str, str, str]]:
    """Return (label, refname, kind) for the newest version. kind = tag|commit|branch.

    Preference: latest release → newest tag → default-branch HEAD commit. If the
    API is exhausted/offline, fall back to a branch ZIP (no API needed) so
    --invoke-all still grabs something.
    """
    rel = _gh_api(f"repos/{vr.owner}/{vr.repo}/releases/latest")
    if isinstance(rel, dict) and rel.get("tag_name"):
        return rel["tag_name"], rel["tag_name"], "tag"
    tags = _gh_api(f"repos/{vr.owner}/{vr.repo}/tags")
    if isinstance(tags, list) and tags and tags[0].get("name"):
        return tags[0]["name"], tags[0]["name"], "tag"
    info = _gh_api(f"repos/{vr.owner}/{vr.repo}")
    branch = info.get("default_branch", "main") if isinstance(info, dict) else "main"
    commit = _gh_api(f"repos/{vr.owner}/{vr.repo}/commits/{branch}")
    if isinstance(commit, dict) and commit.get("sha"):
        return commit["sha"][:12], commit["sha"], "commit"
    if info is None and commit is None:            # API gave us nothing (rate-limit/offline)
        return f"{branch}-{time.strftime('%Y%m%d')}", branch, "branch"
    return None


def _gh_list_versions(vr: VaultRepo) -> list[tuple[str, str, str]]:
    """All releases/tags newest-first, as (label, refname, kind='tag')."""
    out: list[tuple[str, str, str]] = []
    rels = _gh_api(f"repos/{vr.owner}/{vr.repo}/releases")
    if isinstance(rels, list):
        out += [(r["tag_name"], r["tag_name"], "tag") for r in rels if r.get("tag_name")]
    if not out:
        tags = _gh_api(f"repos/{vr.owner}/{vr.repo}/tags")
        if isinstance(tags, list):
            out += [(t["name"], t["name"], "tag") for t in tags if t.get("name")]
    return out


def _vault_zip_urls(vr: VaultRepo, refname: str, kind: str) -> list[str]:
    base = f"https://github.com/{vr.owner}/{vr.repo}/archive"
    if kind == "commit":
        return [f"{base}/{refname}.zip"]
    if kind == "branch":
        cands, urls = [], []
        for b in (refname, "main", "master"):
            if b in cands:
                continue
            cands.append(b)
            urls.append(f"{base}/refs/heads/{b}.zip")
        return urls
    return [f"{base}/refs/tags/{refname}.zip"]      # tag


def _download_file(url: str, dest: Path) -> bool:
    if DRY_RUN:
        Log.step(f"[dry-run] download {url} -> {dest.name}"); return True
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "prometheus-vault"})
        with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as f:   # noqa: S310
            shutil.copyfileobj(r, f)
        return True
    except Exception as e:
        Log.err(f"download failed: {url} ({e})")
        if dest.exists():
            dest.unlink(missing_ok=True)
        return False


# ---- vault location + manifests --------------------------------------------
def _vault_config_path() -> Path:
    return PROM_DIR / "vault.json"


def _vault_get_root() -> Optional[Path]:
    d = _read_json(_vault_config_path())
    r = d.get("root")
    return Path(r) if r else None


def _vault_set_root(root: Path) -> None:
    if DRY_RUN:
        return
    PROM_DIR.mkdir(parents=True, exist_ok=True)
    _vault_config_path().write_text(json.dumps({"root": str(root)}, indent=2))


def _vault_prompt_root() -> Optional[Path]:
    existing = _vault_get_root()
    if existing:
        Log.ok(f"vault root: {existing}")
        return existing
    default_parent = HOME
    if ASSUME_YES or DRY_RUN or not sys.stdin.isatty():
        root = default_parent / "prometheus"
    else:
        raw = input(f"  Parent folder to hold the 'prometheus' repo vault [{default_parent}]: ").strip()
        parent = Path(os.path.expanduser(raw)) if raw else default_parent
        root = parent if parent.name == "prometheus" else parent / "prometheus"
    if not DRY_RUN:
        root.mkdir(parents=True, exist_ok=True)
    _vault_set_root(root)
    Log.ok(f"vault root: {root}")
    return root


def _vault_repo_dir(root: Path, vr: VaultRepo) -> Path:
    return root / vr.id


def _vault_manifest_path(d: Path) -> Path:
    return d / ".prometheus_vault.json"


def _vault_read_manifest(d: Path) -> dict:
    return _read_json(_vault_manifest_path(d))


def _vault_write_manifest(d: Path, data: dict) -> None:
    if DRY_RUN:
        return
    d.mkdir(parents=True, exist_ok=True)
    _vault_manifest_path(d).write_text(json.dumps(data, indent=2))


def _vault_safe(v: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", v)


def _vault_zip_name(vr: VaultRepo, label: str) -> str:
    return f"{vr.id}-{_vault_safe(label)}.zip"


def _vault_local_versions(d: Path) -> list[dict]:
    return _vault_read_manifest(d).get("versions", [])


def _fmt_bytes(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024 or unit == "TB":
            return f"{f:.0f}{unit}" if unit == "B" else f"{f:.1f}{unit}"
        f /= 1024
    return f"{n}B"


def _vault_download_version(root: Path, vr: VaultRepo, label: str, refname: str, kind: str) -> bool:
    d = _vault_repo_dir(root, vr)
    dest = d / _vault_zip_name(vr, label)
    if dest.exists() and any(v.get("version") == label for v in _vault_local_versions(d)):
        Log.ok(f"{vr.name}: {label} already in vault"); return True
    if not DRY_RUN:
        d.mkdir(parents=True, exist_ok=True)
    Log.step(f"{vr.name}: downloading {label} ({kind})")
    ok = False
    for url in _vault_zip_urls(vr, refname, kind):
        if _download_file(url, dest):
            ok = True; break
    if not ok:
        Log.err(f"{vr.name}: could not download {label}"); return False
    # vet the stored ZIP (nemesis scans members in-stream); a blocked archive
    # never enters the vault.
    if not DRY_RUN and dest.exists():
        if not enforce_gate(str(dest), f"vault {vr.id} {label}"):
            dest.unlink(missing_ok=True)
            Log.err(f"{vr.name}: {label} blocked by nemesis gate — not stored")
            return False
    size = dest.stat().st_size if (not DRY_RUN and dest.exists()) else 0
    mani = _vault_read_manifest(d) or {}
    mani.update({"id": vr.id, "name": vr.name, "url": vr.url, "owner": vr.owner,
                 "repo": vr.repo, "source": vr.source})
    versions = mani.setdefault("versions", [])
    if not any(v.get("version") == label for v in versions):
        versions.append({"version": label, "ref": refname, "kind": kind, "file": dest.name,
                         "size": size, "downloaded_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    mani.setdefault("installed", {})
    _vault_write_manifest(d, mani)
    Log.ok(f"{vr.name}: stored {dest.name}" + (f" ({_human_size(dest)})" if (not DRY_RUN and dest.exists()) else " (dry-run)"))
    return True


def _vault_invoke_repo(root: Path, vr: VaultRepo, online: bool) -> dict:
    """Fetch/refresh ONE repo. Returns a result dict {repo, action, status, version, paths, error}
    with `status` from the fixed vocab downloaded|skipped|failed (CLI-048) so the JSON results[] and
    the human Log.* lines derive from ONE source. Every Log.* line is preserved (human output
    unchanged); under --json Log.STREAM is stderr, so these never touch the JSON stdout envelope."""
    d = _vault_repo_dir(root, vr)
    local = [v["version"] for v in _vault_local_versions(d)]
    res = {"repo": vr.id, "action": "invoke", "status": "skipped",
           "version": local[-1] if local else None, "paths": [], "error": None}
    if not online:
        if local:
            Log.ok(f"{vr.name}: offline — {len(local)} local version(s), latest {local[-1]}")
        else:
            Log.warn(f"{vr.name}: offline and nothing stored — skipped")
            res["error"] = "offline, nothing stored"
        return res
    latest = _gh_latest_version(vr)
    if not latest:
        Log.warn(f"{vr.name}: could not resolve a version (API/offline) — skipped")
        res["status"] = "failed"; res["error"] = "could not resolve a version"
        return res
    label, refname, kind = latest
    res["version"] = label
    if label in local:
        Log.ok(f"{vr.name}: up to date ({label})")
        return res
    if local:
        Log.step(f"{vr.name}: newer version {label} (have {local[-1]}) — fetching, keeping history")
    if _vault_download_version(root, vr, label, refname, kind):
        res["status"] = "downloaded"
        res["paths"] = [str(d / _vault_zip_name(vr, label))]
    else:
        res["status"] = "failed"; res["error"] = "download failed"
    return res


def _parse_index_selection(raw: str, items: list) -> list:
    """Parse '1,3,5-8' (1-based) into the matching items."""
    picked: list = []
    seen: set[int] = set()
    for chunk in re.split(r"[,\s]+", raw.strip()):
        if not chunk:
            continue
        if "-" in chunk:
            a, _, b = chunk.partition("-")
            if a.isdigit() and b.isdigit():
                for i in range(int(a), int(b) + 1):
                    if 1 <= i <= len(items) and i not in seen:
                        seen.add(i); picked.append(items[i - 1])
        elif chunk.isdigit():
            i = int(chunk)
            if 1 <= i <= len(items) and i not in seen:
                seen.add(i); picked.append(items[i - 1])
    return picked


def _vault_select(repos: list[VaultRepo], root: Path) -> list[VaultRepo]:
    if not sys.stdin.isatty():
        Log.warn("non-interactive terminal — use --invoke-all to fetch everything"); return []
    Log.head("Select repos to vault (download / refresh)")
    for i, vr in enumerate(repos, 1):
        local = [v["version"] for v in _vault_local_versions(_vault_repo_dir(root, vr))]
        loc = f"{len(local)} local (latest {local[-1]})" if local else "none local"
        print(f"  {i:>3}) [{vr.source[:4]:<4}] {vr.id:<22} {vr.name[:26]:<26} {loc}")
    raw = input("  numbers (e.g. 1,3,5-8) or 'all' > ").strip()
    if raw.lower() in ("all", "*"):
        return repos
    return _parse_index_selection(raw, repos)


def cmd_vault_invoke(all_repos: bool) -> int:
    Log.head("Repo Vault — versioned ZIP archive of every repo (7th functionality)")
    root = _vault_prompt_root()
    if root is None:
        return 1
    repos = _vault_all_repos()
    online = _online()
    Log.info(f"{len(repos)} repos known · network: {'online' if online else 'OFFLINE'} · vault: {root}")
    if all_repos:
        Log.step("--invoke-all: fetching the latest ZIP of EVERY repo")
        selected = repos
    else:
        selected = _vault_select(repos, root)
        if not selected:
            Log.warn("nothing selected"); return 0
    if not online:
        Log.warn("offline — only reporting what's already stored; new downloads need the internet.")
    for vr in selected:
        _vault_invoke_repo(root, vr, online)
    Log.ok(f"vault updated at {root}")
    _vault_print_tree(root)
    return 0


# ---- rollback (offline-first; network fallback) ----------------------------
def _vault_extract_zip(zp: Path, target: Path) -> None:
    import zipfile
    with zipfile.ZipFile(zp) as z:
        names = z.namelist()
        top = names[0].split("/")[0] if names else ""
        same_top = top and all(n.startswith(top + "/") or n == top for n in names)
        base = target.resolve()
        for m in z.infolist():
            rel = m.filename
            if same_top and (rel == top or rel.startswith(top + "/")):
                rel = rel[len(top) + 1:]
            if not rel:
                continue
            outp = target / rel
            # zip-slip containment: absolute member names and ../ traversal must
            # not escape the rollback target (structural guard, not just the gate)
            rp = outp.resolve()
            if rp != base and base not in rp.parents:
                Log.warn(f"skipping unsafe zip member: {m.filename!r}")
                continue
            if m.is_dir():
                outp.mkdir(parents=True, exist_ok=True)
            else:
                outp.parent.mkdir(parents=True, exist_ok=True)
                with z.open(m) as src, open(outp, "wb") as dst:
                    shutil.copyfileobj(src, dst)


def _vault_install_version(root: Path, vr: VaultRepo, d: Path, mani: dict,
                           label: str, kind: str, filename: Optional[str]) -> int:
    zp = d / (filename or _vault_zip_name(vr, label))
    if not zp.exists() and not DRY_RUN:
        Log.err(f"stored ZIP missing: {zp} — re-download with `--invoke {vr.id}`"); return 1
    prev = (mani.get("installed") or {}).get("path")
    default_target = Path(prev) if prev else (d / "current")
    if sys.stdin.isatty() and not (ASSUME_YES or DRY_RUN):
        raw = input(f"  extract/install target dir [{default_target}]: ").strip()
        target = Path(os.path.expanduser(raw)) if raw else default_target
    else:
        target = default_target
    Log.warn(f"rollback extracts {vr.name} {label} into {target} (existing contents backed up first).")
    if not _confirm(f"Roll {vr.name} back to {label} now?"):
        Log.warn("declined"); return 0
    if not DRY_RUN:
        # re-vet right before extraction (verdict cache makes a clean re-check
        # free; catches a ZIP tampered with while sitting in the vault)
        if not enforce_gate(str(zp), f"vault {vr.id} {label} (pre-extract)"):
            Log.err("extraction blocked by nemesis gate"); return 1
        if target.exists() and any(target.iterdir()):
            bak = target.parent / f"{target.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
            shutil.move(str(target), str(bak))
            Log.ok(f"backed up existing → {bak.name}")
        target.mkdir(parents=True, exist_ok=True)
        _vault_extract_zip(zp, target)
    mani = mani or {}
    mani.setdefault("id", vr.id)
    mani["installed"] = {"version": label, "path": str(target), "at": time.strftime("%Y-%m-%d %H:%M:%S")}
    _vault_write_manifest(d, mani)
    Log.ok(f"{vr.name} rolled back to {label} → {target}")
    Log.step("this restores the SOURCE tree. For a pip/compose/docker re-deploy, run the tool's own "
             "install on this extracted source (or `apps rollback`/`models rollback`).")
    return 0


def _vault_rollback_remote(root: Path, vr: VaultRepo, d: Path, mani: dict) -> int:
    versions = _gh_list_versions(vr)
    if not versions:
        Log.err(f"{vr.name}: GitHub exposes no releases/tags to roll back to"); return 1
    Log.head(f"{vr.name}: versions available on GitHub")
    for i, (label, _ref, _k) in enumerate(versions, 1):
        print(f"  {i:>3}) {label}")
    sel = input("  download + roll back to which? > ").strip()
    if not (sel.isdigit() and 1 <= int(sel) <= len(versions)):
        Log.warn("cancelled"); return 0
    label, refname, kind = versions[int(sel) - 1]
    if not _vault_download_version(root, vr, label, refname, kind):
        return 1
    mani = _vault_read_manifest(d)
    return _vault_install_version(root, vr, d, mani, label, kind, _vault_zip_name(vr, label))


def cmd_vault_rollback() -> int:
    Log.head("Repo Vault — roll a repo back to a stored or older version")
    root = _vault_get_root() or _vault_prompt_root()
    if root is None:
        return 1
    if not sys.stdin.isatty():
        Log.err("rollback needs an interactive terminal"); return 2
    repos = _vault_all_repos()
    by_id = {vr.id: vr for vr in repos}
    vaulted = [vr for vr in repos if _vault_local_versions(_vault_repo_dir(root, vr))]
    pool = vaulted or repos
    if vaulted:
        Log.info("repos with stored versions (offline-capable rollback):")
    else:
        Log.warn("no repos stored yet — listing all (rollback will need the internet to fetch a version):")
    for i, vr in enumerate(pool, 1):
        d = _vault_repo_dir(root, vr)
        mani = _vault_read_manifest(d)
        inst = (mani.get("installed") or {}).get("version") if mani else None
        local = _vault_local_versions(d)
        print(f"  {i:>3}) {vr.id:<22} installed:{inst or '—':<14} stored:{len(local)}")
    sel = input("  pick a repo (number or id) > ").strip()
    vr = pool[int(sel) - 1] if (sel.isdigit() and 1 <= int(sel) <= len(pool)) else by_id.get(_vault_slug(sel))
    if not vr:
        Log.err("no such repo"); return 2
    d = _vault_repo_dir(root, vr)
    mani = _vault_read_manifest(d)
    local = _vault_local_versions(d)
    online = _online()
    if local:
        Log.head(f"{vr.name}: stored versions (work OFFLINE)")
        for i, v in enumerate(local, 1):
            print(f"  {i:>3}) {v['version']}   ({v.get('kind')}, saved {v.get('downloaded_at', '?')})")
        if online and _confirm("also browse REMOTE GitHub versions (to fetch an older one not stored)?"):
            return _vault_rollback_remote(root, vr, d, mani)
        sel = input("  roll back to which stored version? > ").strip()
        if not (sel.isdigit() and 1 <= int(sel) <= len(local)):
            Log.warn("cancelled"); return 0
        chosen = local[int(sel) - 1]
        return _vault_install_version(root, vr, d, mani, chosen["version"], chosen.get("kind", "tag"), chosen.get("file"))
    if not online:
        Log.err(f"{vr.name}: nothing stored AND offline — cannot roll back. Connect to the internet, "
                f"or run `prometheus --invoke` for {vr.id} while online to build local history."); return 1
    Log.warn(f"{vr.name}: nothing stored locally — fetching the version list from GitHub")
    return _vault_rollback_remote(root, vr, d, mani)


def _vault_print_tree(root: Path) -> None:
    if DRY_RUN or not root.exists():
        return
    dirs = sorted([p for p in root.iterdir() if p.is_dir()])
    Log.head(f"Vault tree: {root}")
    total = 0
    shown = 0
    for d in dirs:
        zips = sorted(d.glob("*.zip"))
        if not zips:
            continue
        shown += 1
        print(f"  {d.name}/")
        for z in zips:
            total += z.stat().st_size
            print(f"      {z.name}  ({_human_size(z)})")
    Log.info(f"{shown} repo folder(s) populated · total {_fmt_bytes(total)}")


def _cmd_vault_invoke_json(all_repos: bool, args) -> int:
    """Non-interactive `vault invoke|invoke-all --json` (CLI-048). Dry-run is the DEFAULT — only
    `--yes` performs downloads. A missing vault root fails closed (never prompts / never guesses a
    default path). `--target <ids>` (comma-separated) narrows `invoke`; an unknown id → ok:false
    with the valid ids. ONE JSON object on stdout; all human/log text rides Log.STREAM=stderr."""
    action = "invoke-all" if all_repos else "invoke"
    root = _vault_get_root()
    if root is None:
        return emit_json({"command": "vault", "action": action, "ok": False,
                          "error": "vault root not configured", "_exit": 2})
    repos = _vault_all_repos()
    by_id = {vr.id: vr for vr in repos}
    target = getattr(args, "target", None)
    if target and not all_repos:
        want = [_vault_slug(t) for t in re.split(r"[,\s]+", target) if t.strip()]
        missing = [t for t in want if t not in by_id]
        if missing:
            return emit_json({"command": "vault", "action": action, "ok": False,
                              "error": f"unknown target(s): {', '.join(missing)}",
                              "valid_targets": sorted(by_id), "_exit": 2})
        selected = [by_id[t] for t in want]
    else:
        selected = repos
    online = _online()
    if not ASSUME_YES:
        planned = [{"repo": vr.id, "name": vr.name, "action": "invoke"} for vr in selected]
        return emit_json({"command": "vault", "action": action, "ok": True,
                          "dry_run": True, "yes": False, "planned": planned})
    results = [_vault_invoke_repo(root, vr, online) for vr in selected]
    errors = [{"repo": r["repo"], "error": r["error"]} for r in results if r["status"] == "failed"]
    ok = len(errors) == 0
    return emit_json({"command": "vault", "action": action, "ok": ok, "yes": True,
                      "root": str(root), "results": results, "errors": errors,
                      "_exit": 0 if ok else 2})


def _cmd_vault_rollback_json(args) -> int:
    """Non-interactive `vault rollback --json` (CLI-048). Requires `--target <id>`; validates it
    against the STORED repos (offline-capable rollback); unknown/unstored → ok:false + valid_targets,
    exit 2. Dry-run default (only `--yes` extracts, to the latest stored version). Fail-closed on a
    missing vault root — never the interactive version menu / path prompt (would hang a scripter)."""
    root = _vault_get_root()
    if root is None:
        return emit_json({"command": "vault", "action": "rollback", "ok": False,
                          "error": "vault root not configured", "_exit": 2})
    repos = _vault_all_repos()
    by_id = {vr.id: vr for vr in repos}
    stored = {vr.id: _vault_local_versions(_vault_repo_dir(root, vr)) for vr in repos}
    valid = sorted([rid for rid, vs in stored.items() if vs])
    target = getattr(args, "target", None)
    tid = _vault_slug(target) if target else None
    if not tid or tid not in by_id or not stored.get(tid):
        return emit_json({"command": "vault", "action": "rollback", "ok": False,
                          "error": ("rollback --json needs --target <id>" if not tid
                                    else f"unknown or unstored target: {target}"),
                          "valid_targets": valid, "_exit": 2})
    vr = by_id[tid]
    d = _vault_repo_dir(root, vr)
    local = _vault_local_versions(d)
    if not ASSUME_YES:
        return emit_json({"command": "vault", "action": "rollback", "ok": True,
                          "dry_run": True, "yes": False,
                          "planned": [{"repo": vr.id,
                                       "version": local[-1]["version"] if local else None,
                                       "stored_versions": [v["version"] for v in local]}]})
    chosen = local[-1]  # roll back to the latest stored version (non-interactive)
    rc = _vault_install_version(root, vr, d, _vault_read_manifest(d), chosen["version"],
                                chosen.get("kind", "tag"), chosen.get("file"))
    ok = rc == 0
    return emit_json({"command": "vault", "action": "rollback", "ok": ok, "yes": True,
                      "target": vr.id, "version": chosen["version"], "_exit": 0 if ok else 2})


def cmd_vault(args, osi: OSInfo) -> int:
    action = (getattr(args, "action", None) or "list").lower()
    # invoke / invoke-all / rollback are now scriptable over --json (CLI-048): dry-run by default,
    # `--yes` performs, `--target` selects — no input() is ever reachable under JSON_OUT.
    if JSON_OUT and action in ("invoke", "invoke-all", "invokeall"):
        return _cmd_vault_invoke_json(action != "invoke", args)
    if JSON_OUT and action == "rollback":
        return _cmd_vault_rollback_json(args)
    if action == "invoke":
        return cmd_vault_invoke(all_repos=False)
    if action in ("invoke-all", "invokeall"):
        return cmd_vault_invoke(all_repos=True)
    if action == "rollback":
        return cmd_vault_rollback()
    # list / status
    repos = _vault_all_repos()
    if JSON_OUT:
        root = _vault_get_root()
        out_repos = []
        for vr in repos:
            try:
                local = _vault_local_versions(_vault_repo_dir(root, vr)) if root else []
            except Exception:  # noqa: BLE001
                local = []
            out_repos.append({"id": getattr(vr, "id", None), "name": getattr(vr, "name", None),
                              "source": getattr(vr, "source", None),
                              "stored_versions": [v.get("version") for v in local],
                              "state": "stored" if local else "absent"})
        return emit_json({"command": "vault", "ok": True, "action": "status",
            "root": str(root) if root else None,
            "initialized": bool(root), "repos": out_repos,
            "summary": {"total": len(out_repos),
                        "stored": sum(1 for r in out_repos if r["state"] == "stored")}})
    Log.head("Repo Vault — status (7th functionality)")
    Log.info(f"{len(repos)} repos known across plugins / model-tools / apps / pentest")
    root = _vault_get_root()
    if not root:
        Log.warn("vault not initialized — run `prometheus --invoke` (wizard) or `--invoke-all` to choose its location")
        Log.step("layout: <your-path>/prometheus/<repo>/<repo>-<version>.zip  (+ .prometheus_vault.json)")
        Log.step("rollback later (even offline) with `prometheus --rollback`")
        return 0
    Log.ok(f"vault root: {root}")
    _vault_print_tree(root)
    Log.step("download/refresh: `prometheus --invoke` · everything: `--invoke-all` · roll back: `--rollback`")
    return 0


# ============================================================================
#  SECTION 7 — Subcommands
# ============================================================================
def _secure_looks_remote(raw: str) -> bool:
    """A target nemesis fetches itself: a git URL or an 'owner/repo' shorthand."""
    # A target that starts with '-' is never a legit remote — and classing it remote
    # would pass it RAW as the nemesis `gate` positional (option-injection). Let it fall
    # through to the path branch, where abspath() neutralizes the leading dash.
    if raw.startswith("-"):
        return False
    if "://" in raw:
        return True
    return bool(re.match(r"^[\w.-]+/[\w.-]+$", raw)) and not os.path.exists(raw)


_SECURE_LABELS = {
    "allow": ("✓ SAFE", "green", "No known threats. Safe to keep / run / install."),
    "warn": ("⚠ CAUTION", "yellow", "Review the findings before trusting this — proceed only if you trust the source."),
    "block": ("☠ DANGER", "red", "Threats found. Do NOT run or install. Quarantine / delete."),
    "error": ("✗ UNVERIFIED", "red", "Scan could not complete — treated as unsafe (fail-closed)."),
}


def cmd_secure(args, osi: "OSInfo") -> int:
    """Point nemesis at ANY file / archive / folder / repo (or your whole home dir
    with --full) and report threats. The user-facing 'scan anything for danger' verb —
    the same fail-closed nemesis engine the install gate uses."""
    raw = (args.target or "").strip()
    if getattr(args, "full", False):
        raw = str(HOME)
    if not raw:
        if JSON_OUT:
            return emit_json({"command": "secure", "ok": False,
                              "error": "give a TARGET (file/archive/folder/repo) or --full",
                              "_exit": 2})
        Log.err("secure: give a TARGET (file/archive/folder/repo) or --full to scan your home dir")
        return 2
    remote = _secure_looks_remote(raw)
    target = raw if remote else os.path.abspath(os.path.expanduser(raw))
    if not remote and not os.path.exists(target):
        if JSON_OUT:
            return emit_json({"command": "secure", "ok": False,
                              "error": f"path not found: {target}", "_exit": 2})
        Log.err(f"secure: path not found: {target}")
        return 2

    if not JSON_OUT:
        scope = "your HOME directory" if getattr(args, "full", False) else target
        Log.head(f"Security scan: {scope}")
        if getattr(args, "full", False) or (not remote and os.path.isdir(target)):
            Log.step("scanning a directory tree — this can take a while on large folders…")
    v = nemesis_gate(target)
    verdict = v.get("verdict", "error")
    if JSON_OUT:
        ok = verdict == "allow"
        return emit_json({"command": "secure", "ok": ok, "target": target,
                          "verdict": verdict, "risk_score": v.get("risk_score"),
                          "severity_counts": v.get("severity_counts"),
                          "safe_to": v.get("safe_to"),
                          "blocking_reasons": v.get("blocking_reasons"),
                          "top_findings": v.get("top_findings"),
                          "recommendation": v.get("recommendation"),
                          "_exit": 0 if ok else (3 if verdict == "block" else 1)})
    label, color, advice = _SECURE_LABELS.get(verdict, _SECURE_LABELS["error"])
    print()
    print(f"  {Log._c(label, color)}   risk {v.get('risk_score', '?')}/100   {target}")
    counts = v.get("severity_counts") or {}
    sev = "  ".join(f"{counts[s]} {s.lower()}" for s in
                    ("CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO")
                    if counts.get(s)) or "no findings"
    Log.step(sev)
    for f in (v.get("top_findings") or [])[:15]:
        loc = f.get("path", "?")
        if f.get("line"):
            loc += f":{f['line']}"
        print(f"    {Log._c(f.get('severity', '?'), color)}  {f.get('rule_id', '?')}  "
              f"{f.get('description', '')[:70]}")
        print(f"        {Log._c(loc, 'dim')}")
    for r in (v.get("blocking_reasons") or [])[:6]:
        Log.step(f"reason: {r}")
    Log.info(advice)
    if v.get("error"):
        Log.warn(f"scanner note: {v['error']}")
    return 0 if verdict == "allow" else (3 if verdict == "block" else 1)


def cmd_auto(args, osi: "OSInfo") -> int:
    """One command, full safe maintenance (the 'super-tool' automation):
      1. refresh nemesis threat feeds,
      2. audit + pin every installed source (quarantine dangerous drift, fail-closed),
      3. integrate nemesis-GREEN skills into the central prometheus_skills folder,
      4. [--defang] wipe non-official URLs from installed sources (keep official docs).
    Fail-soft per step — one failing step never aborts the rest. Human + JSON."""
    out: dict = {"command": "auto", "ok": True, "steps": {}}

    def _step(name: str, fn):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — record + continue (one step never kills the run)
            out["steps"][name] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            out["ok"] = False
            return None

    if not JSON_OUT:
        Log.head("Prometheus auto — full safe maintenance")

    pr = _step("feeds", prepare_nemesis)
    if pr is not None:
        out["steps"]["feeds"] = {"ok": pr.get("ok"), "ran": pr.get("ran"), "note": pr.get("note")}
    if not JSON_OUT:
        Log.step(f"1/3 threat feeds: {out['steps'].get('feeds', {}).get('note') or 'ready'}")

    # `audit_sources`/`defang_installed_sources` have no preview mode (they quarantine/re-pin/
    # rewrite files directly) — under --dry-run they are SKIPPED rather than run for real, so
    # a typed --dry-run can never silently perform one of these writes. `integrate_green_skills`
    # DOES support a real dry_run (below), so it still previews normally.
    if DRY_RUN:
        out["steps"]["audit"] = {"skipped": True,
                                 "note": "dry-run: audit quarantines/re-pins files with no preview mode"}
        if not JSON_OUT:
            Log.step(f"2/3 audit: {out['steps']['audit']['note']}")
    else:
        au = _step("audit", lambda: audit_sources(quarantine=True, quarantine_new=True))
        if au is not None:
            out["steps"]["audit"] = {k: len(au[k]) for k in
                                     ("new", "clean", "repinned", "quarantined", "missing")}
        if not JSON_OUT and au is not None:
            a = out["steps"]["audit"]
            Log.step(f"2/3 audit: {a['new']} new · {a['clean']} clean · {a['repinned']} re-pinned · "
                     f"{a['quarantined']} quarantined · {a['missing']} missing")

    ig = _step("integrate", lambda: integrate_green_skills(dry_run=DRY_RUN))
    if ig is not None:
        out["steps"]["integrate"] = {k: len(ig[k]) for k in
                                     ("integrated", "already", "skipped_unsafe", "errors")}
    if not JSON_OUT and ig is not None:
        i = out["steps"]["integrate"]
        Log.step(f"3/3 integrate: {i['integrated']} green skill(s) added · "
                 f"{i['already']} already · {i['skipped_unsafe']} unsafe skipped"
                 f"{' (dry-run — nothing copied)' if DRY_RUN else ''}")

    if getattr(args, "defang", False):
        if DRY_RUN:
            out["steps"]["defang"] = {"skipped": True,
                                      "note": "dry-run: defang rewrites files with no preview mode"}
            if not JSON_OUT:
                Log.step(f"defang: {out['steps']['defang']['note']}")
        else:
            d = _step("defang", lambda: defang_installed_sources(keep="trusted"))
            if d is not None:
                out["steps"]["defang"] = {"wiped": d["urls_neutralized"],
                                          "trusted_kept": d["urls_kept_trusted"]}
                if not JSON_OUT:
                    Log.step(f"defang: {d['urls_neutralized']} URL(s) wiped, "
                             f"{d['urls_kept_trusted']} official-doc URL(s) kept")

    # each scheduled run re-asserts its own schedule (keeps it healthy while it runs)
    try:
        _ensure_auto_schedule(osi)
    except Exception:  # noqa: BLE001
        pass
    if JSON_OUT:
        return emit_json(out)
    q = out["steps"].get("audit", {}).get("quarantined", 0)
    if q:
        Log.warn(f"{q} source(s) quarantined (reversible) — review: "
                 f"prometheus skills audit --list-quarantine")
    Log.ok("maintenance complete" if out["ok"] else "maintenance finished with step errors (see above)")
    return 0 if out["ok"] else 1


def _filter_hosts(detected: list[AIHost], wanted: Optional[list[str]]) -> list[AIHost]:
    if not wanted or "all" in wanted:        # --host all = every detected agent
        return detected
    want = set(wanted)
    return [h for h in detected if h.name in want]


def cmd_scan(args, osi: OSInfo) -> int:
    detected = detect_hosts()
    if JSON_OUT:
        return emit_json({"command": "scan", "ok": True,
            "os": {"family": osi.family, "pkg_manager": osi.pkg_manager},
            "agents": [{"name": h.name, "label": h.label, "kind": h.kind,
                        "present": h in detected, "where": h.where} for h in HOSTS]})
    Log.head(f"AI agents on this machine  (host OS: {osi.family})")
    for h in HOSTS:
        present = h in detected
        mark = Log._c("●", "green") if present else Log._c("○", "dim")
        print(f"  {mark} {h.name:<14} [{h.kind:<3}] {h.label:<32} {h.where}")
    Log.info(f"{len(detected)} agent(s) detected")
    return 0


def _tier_badge(p: Plugin) -> str:
    col = {"official": "green", "community": "cyan", "devtool": "blue"}.get(p.tier, "magenta")
    return Log._c(f"[{p.tier[:4]}]", col)


def _plugin_row(p: Plugin) -> str:
    """One-line catalog row for list / wizard."""
    star = f"★{p.stars}" if p.stars else "★—"
    scope = "claude-only" if p.claude_exclusive else "universal"
    lic = p.license or "—"
    return f"{_tier_badge(p)} {p.name:<22} {star:<8} {lic:<14} [{scope:<11}] {p.summary[:58]}"


def cmd_list(args, osi: OSInfo) -> int:
    detected = {h.name for h in detect_hosts()}
    if JSON_OUT:
        reg = host_registry()
        catalog = []
        for p in PLUGINS:
            targets = {}
            for hname, spec in p.targets.items():
                inst = None
                if hname in detected and hname in reg:
                    try:
                        inst = is_installed(p, reg[hname], spec)
                    except Exception:  # noqa: BLE001 — state read must not break listing
                        inst = None
                targets[hname] = {"method": spec.method, "installed": inst}
            catalog.append({
                "name": p.name, "tier": p.tier, "summary": p.summary, "repo": p.repo,
                "stars": p.stars, "license": p.license,
                "scope": "claude-only" if p.claude_exclusive else "universal",
                "supported_os": list(p.supported_os),
                "recommend_rank": p.recommend_rank, "targets": targets})
        return emit_json({"command": "list", "ok": True, "catalog": catalog,
                          "detected_agents": sorted(detected)})
    Log.head(f"Plugin registry  (detected agents: {', '.join(sorted(detected)) or 'none'})")
    if OFFICIAL_BUNDLE:
        Log.info("official bundle (anthropic, auto-trusted):")
    for p in PLUGINS:
        if p is EXTERNAL_PLUGINS[0] if EXTERNAL_PLUGINS else False:
            Log.info("external (ranked, scanned):")
        osok = "" if osi.family in p.supported_os else Log._c(" [unsupported OS]", "red")
        rank = f" #{p.recommend_rank}" if p.recommend_rank else ""
        print(f"  {_plugin_row(p)}{rank}{osok}")
        for hname, spec in p.targets.items():
            here = hname in detected
            inst = is_installed(p, host_registry()[hname], spec) if here else None
            if not here:
                state, col = "agent absent", "dim"
            elif inst is True:
                state, col = "installed", "green"
            elif inst is False:
                state, col = "missing", "yellow"
            else:
                state, col = "unknown", "magenta"
            print(f"      - {hname:<10} {Log._c(state, col)}")
    return 0


def cmd_info(args, osi: OSInfo) -> int:
    p = plugin_registry().get(args.name)
    if not p:
        if JSON_OUT:
            return emit_json({"command": "info", "ok": False,
                              "error": f"unknown plugin: {args.name}", "_exit": 2})
        Log.err(f"unknown plugin: {args.name}")
        return 2
    if JSON_OUT:
        targets = {}
        for hname, spec in p.targets.items():
            targets[hname] = {
                "method": spec.method,
                "marketplace_name": spec.marketplace_name,
                "marketplace_repo": spec.marketplace_repo,
                "mcp_name": spec.mcp_name,
                "repo_url": spec.repo_url, "dest": spec.dest,
                "universal_add": spec.universal_add or None,
                "shell_steps": spec.shell_steps or None}
        return emit_json({"command": "info", "ok": True, "plugin": {
            "name": p.name, "summary": p.summary, "tier": p.tier,
            "scope": "claude-only" if p.claude_exclusive else "universal",
            "repo": p.repo, "license": p.license, "stars": p.stars,
            "category": p.category, "recommend_rank": p.recommend_rank,
            "automation": p.automation, "security_note": p.security_note,
            "caveats": list(p.caveats), "post_install_note": p.post_install_note,
            "supported_os": list(p.supported_os), "targets": targets,
            "components": [{"name": c.name, "kind": c.kind, "desc": c.desc}
                           for c in p.components_for()]}})
    scope = "Claude-only" if p.claude_exclusive else "universal (multi-CLI)"
    Log.head(f"Plugin: {p.name}  {_tier_badge(p)}")
    print(f"  summary   : {p.summary}")
    print(f"  tier      : {p.tier}{'  (official bundle)' if p.bundle else ''}")
    print(f"  scope     : {scope}")
    if p.repo:
        meta = f"  repo      : {p.repo}"
        if p.stars:
            meta += f"  ★{p.stars}"
        if p.license:
            meta += f"  {p.license}"
        print(meta)
    if p.recommend_rank is not None:
        rg = f"  (redundancy group {p.redundancy_group})" if p.redundancy_group else ""
        print(f"  rank      : {p.recommend_rank}{rg}")
    print(f"  supported : {', '.join(p.supported_os)}")
    print(f"  targets   : {', '.join(p.hosts())}")
    if p.automation:
        print(f"  automation: {p.automation}")
    if p.security_note:
        print(f"  security  : {p.security_note}")
    for c in p.caveats:
        print(f"  {Log._c('!', 'yellow')} caveat  : {c}")
    if p.post_install_note:
        print(f"  {Log._c('>', 'cyan')} next    : {p.post_install_note}")
    for hname, spec in p.targets.items():
        print(f"  - {hname} via {spec.method}")
        if spec.method == "claude_plugin":
            ids = ", ".join(_claude_plugin_ids(spec))
            print(f"      marketplace: {spec.marketplace_repo}  id: {ids}  scope: {spec.scope}")
        if spec.method == "claude_marketplace":
            line = f"      marketplace: {spec.marketplace_repo}"
            if spec.secondary_marketplace_repo:
                line += f"  + {spec.secondary_marketplace_repo}"
            if spec.auto_available:
                line += "  (auto-available — managed by Claude Code)"
            print(line)
        if spec.method in ("git_clone", "git_clone_shell"):
            print(f"      repo: {spec.repo_url}  dest: {spec.dest}")
        if spec.method == "universal_skill":
            print(f"      install-everywhere: {' '.join(spec.universal_add)}")
        if spec.method in ("shell", "git_clone_shell", "shell_or_action"):
            for steps in spec.shell_steps.values():
                for c in steps:
                    print(f"      $ {' '.join(c)}")
                break
            if spec.repo_url:
                print(f"      repo: {spec.repo_url}  dest: {spec.dest}")
        if spec.prefetch_scan_urls:
            print(f"      fetch+scan installer: {', '.join(spec.prefetch_scan_urls)}")
        if spec.uninstall_cmd:
            print(f"      uninstall: $ {' '.join(spec.uninstall_cmd)}")
        elif spec.uninstall_steps:
            print(f"      uninstall: documented")
    return 0


def cmd_doctor(args, osi: OSInfo) -> int:
    # doctor's HUMAN text is captured by engine-bridge types/doctor.ts (the health pill) when
    # called WITHOUT --json. But the bridge contract is UNIVERSAL: under --json we MUST emit one
    # JSON object on stdout. Raw print() here previously wrote the human table to stdout even
    # under --json → the bridge saw non-JSON → `error (bad_json)`. Honor --json.
    detected = detect_hosts()
    ok = osi.family != "unsupported" and bool(detected)
    if JSON_OUT:
        emit_json(
            {
                "command": "doctor",
                "ok": ok,
                "os": {"raw": osi.raw, "family": osi.family},
                "pkg_manager": osi.pkg_manager or None,
                "python": platform.python_version(),
                "git": shutil.which("git"),
                "ai_agents": [h.name for h in detected],
            }
        )
        return 0 if ok else 2
    Log.head("Environment check")
    print(f"  OS            : {osi.raw} -> {osi.family}")
    print(f"  pkg manager   : {osi.pkg_manager or 'none found'}")
    print(f"  python        : {platform.python_version()}")
    print(f"  git           : {shutil.which('git') or 'NOT FOUND'}")
    print(f"  AI agents     : {', '.join(h.name for h in detected) or 'none detected'}")
    (Log.ok if ok else Log.warn)("ready" if ok else "no usable OS or no AI agents found")
    return 0 if ok else 2


def _match_hosts(p: Plugin, detected: list[AIHost]) -> list[AIHost]:
    """Detected agents this plugin targets. A "*" target = universal one-run
    install (the repo's own CLI fans out), so it runs once on the first agent."""
    if "*" in p.targets:
        return detected[:1] if detected else []
    return [h for h in detected if h.name in p.targets]


def _spec_for(p: Plugin, host: AIHost) -> InstallSpec:
    return p.targets.get(host.name) or p.targets["*"]


def _resolve_targets(name: str, reg: dict[str, Plugin]) -> Optional[list[Plugin]]:
    """Map a CLI name to a plugin list. None = unknown name."""
    if name in ("official-bundle", "official", "bundle"):
        return bundle_plugins()
    if name == "all":
        return list(PLUGINS)
    p = reg.get(name)
    return [p] if p else None


# ---- surgical sub-selection (install/uninstall just a few components) -------
def _csv(v: Optional[str]) -> list[str]:
    return [x for x in (v or "").replace(" ", "").split(",") if x] if v else []


def _short_id(pid: str) -> str:
    return pid.split("@", 1)[0]


def _parse_name_selection(name: str) -> tuple[str, list[str]]:
    """'plugin:a,b' -> ('plugin', ['a','b']); 'plugin' -> ('plugin', [])."""
    if ":" in name:
        base, sel = name.split(":", 1)
        return base, [s for s in sel.split(",") if s]
    return name, []


def _filter_ids(ids: list[str], only: list[str], skip: list[str]) -> list[str]:
    res = list(ids)
    if only:
        o = set(only)
        res = [i for i in res if i in o or _short_id(i) in o]
    if skip:
        s = set(skip)
        res = [i for i in res if not (i in s or _short_id(i) in s)]
    return res


def _apply_selection(p: Plugin, only: list[str], skip: list[str]) -> Plugin:
    """Clone p so its claude_plugin specs act on only the selected sub-plugin ids.
    No-op for single-unit / non-claude_plugin specs."""
    if not (only or skip):
        return p
    new_targets = {}
    for h, spec in p.targets.items():
        ids = _claude_plugin_ids(spec)
        if ids and spec.method == "claude_plugin":
            new_targets[h] = replace(spec, plugin_id=None, plugin_ids=_filter_ids(ids, only, skip))
        else:
            new_targets[h] = spec
    return replace(p, targets=new_targets)


def _select_targets(args, reg: dict[str, Plugin]) -> tuple[Optional[list[Plugin]], str]:
    """Resolve args.name (+ :sel + --only/--skip) to a possibly sub-selected list.
    Returns (targets|None, base_name)."""
    base, name_sel = _parse_name_selection(args.name)
    targets = _resolve_targets(base, reg)
    if targets is None:
        return None, base
    only = _csv(getattr(args, "only", None)) + name_sel
    skip = _csv(getattr(args, "skip", None))
    if only or skip:
        if base in ("all", "official-bundle", "official", "bundle"):
            Log.warn("--only/--skip / ':selection' apply to a single named plugin — ignored for bundle/all")
        else:
            targets = [_apply_selection(t, only, skip) for t in targets]
            for t in targets:
                ids = [i for s in t.targets.values() for i in _claude_plugin_ids(s)]
                if ids:
                    Log.info(f"{t.name}: selected {len(ids)} component(s): {', '.join(_short_id(i) for i in ids)}")
                elif only:
                    Log.warn(f"{t.name}: --only/--skip has no effect (not a multi-component plugin) — "
                             f"use `skills` for per-skill control")
    return targets, base


@dataclass
class InstallEvent:
    plugin: str
    agent: str             # agent name, or "(all detected via skills CLI)" for universal fan-out
    scope: str             # "claude-only" | "universal"
    result: str            # installed | already | blocked | failed | skipped
    method: str = ""


def _agent_label(p: Plugin, host: AIHost) -> str:
    return "(all detected via skills CLI)" if "*" in p.targets else host.name


def _run_installs(targets: list[Plugin], detected: list[AIHost], osi: OSInfo,
                  events: Optional[list] = None) -> int:
    failures = 0
    for p in targets:
        Log.head(f"Plugin: {p.name}  {_tier_badge(p)}")
        scope = "claude-only" if p.claude_exclusive else "universal"
        if osi.family not in p.supported_os:
            Log.warn(f"{p.name} unsupported on {osi.family} — skip")
            if events is not None:
                events.append(InstallEvent(p.name, "—", scope, "skipped"))
            continue
        matched = _match_hosts(p, detected)
        if not matched:
            Log.warn(f"{p.name}: no detected agent in target list ({', '.join(p.hosts())}) — skip")
            if events is not None:
                events.append(InstallEvent(p.name, "—", scope, "skipped"))
            continue
        for host in matched:
            spec = _spec_for(p, host)
            adapter = resolve_adapter(host, spec)
            agent = _agent_label(p, host)
            try:
                # pre-install security audit + gate (official bundle inherits auto-trust
                # only after a clean/approved scan; nothing installs unscanned unless --no-scan)
                if NO_SCAN:
                    Log.warn(f"SECURITY SCAN SKIPPED for {p.name}@{host.name} (--no-scan)")
                else:
                    Log.step(f"security scan: {p.name}@{host.name}")
                    report = scan_spec(p.name, spec)
                    if not security_gate(report, host.name, auto_trust=(p.tier == "official")):
                        Log.warn(f"{p.name} -> {host.name} aborted by security gate")
                        failures += 1
                        if events is not None:
                            events.append(InstallEvent(p.name, agent, scope, "blocked", spec.method))
                        continue
                # deep nemesis pass on the remote source for adapters that hand
                # a URL straight to an external CLI (marketplace/skill installs):
                # nemesis fetches the repo itself (hooks neutralized) and verdicts
                # it BEFORE `claude plugin ...`/`npx skills add` ever sees it. This
                # runs EVEN under --no-scan (that flag suppresses only the 5C regex
                # pre-scan). Shell/MCP methods have no gate target here — they are
                # self-gated INSIDE their adapter (_gate_shell_steps / _gate_mcp_descriptor),
                # also independent of --no-scan. Only --no-gate/--gate-mode (now typed-
                # confirmed) can turn enforce_gate into a pass-through.
                gate_targets = _gate_targets_for_spec(spec)
                # FAIL-CLOSED: a method that neither self-gates nor yields a gate target
                # has no nemesis coverage at all — refuse it, especially under --no-scan.
                if spec.method not in _SELF_GATING_METHODS and not gate_targets:
                    if NO_SCAN:
                        Log.err(f"{p.name}@{host.name}: method '{spec.method}' has NO nemesis "
                                f"gate and --no-scan is set — refusing (fail-closed)")
                        failures += 1
                        if events is not None:
                            events.append(InstallEvent(p.name, agent, scope, "blocked", spec.method))
                        continue
                    Log.warn(f"{p.name}@{host.name}: method '{spec.method}' relies on the regex "
                             f"pre-scan only (no deep nemesis target) — installing scanned")
                gate_ok = True
                for gt in gate_targets:
                    if not enforce_gate(gt, f"{p.name}@{host.name}"):
                        gate_ok = False
                        break
                if not gate_ok:
                    Log.warn(f"{p.name} -> {host.name} aborted by nemesis gate")
                    failures += 1
                    if events is not None:
                        events.append(InstallEvent(p.name, agent, scope, "blocked", spec.method))
                    continue
                changed = adapter(p, spec, host, osi)
                if changed:
                    Log.ok(f"{p.name} -> {host.name} installed")
                if events is not None:
                    events.append(InstallEvent(p.name, agent, scope,
                                               "installed" if changed else "already", spec.method))
            except Exception as e:  # noqa: BLE001 — keep going across (agent,plugin)
                Log.err(f"{p.name} -> {host.name}: {e}")
                failures += 1
                if events is not None:
                    events.append(InstallEvent(p.name, agent, scope, "failed", spec.method))
        if p.post_install_note:                  # required next step (e.g. priming)
            Log.warn(f"NEXT for {p.name}: {p.post_install_note}")
    return failures


def _print_install_map(events: list, requested_hosts: list[AIHost]) -> None:
    """End-of-run conceptual map: WHAT landed WHERE + Claude-only-vs-universal clarity,
    so the user knows exactly which agent each tool is in (no false 'it's everywhere')."""
    if not events:
        return
    Log.head("Install map — what landed where (this run)")
    # group by agent
    by_agent: dict[str, list[InstallEvent]] = {}
    for e in events:
        if e.result in ("installed", "already"):
            by_agent.setdefault(e.agent, []).append(e)
    mark = {"installed": Log._c("✓", "green"), "already": Log._c("=", "dim")}
    for agent in sorted(by_agent):
        print(f"  {Log._c(agent, 'bold')}:", file=Log.STREAM)
        for e in by_agent[agent]:
            print(f"    {mark.get(e.result, '?')} {e.plugin:<28} [{e.scope}] {e.method}",
                  file=Log.STREAM)
    # scope clarity — the disappointment guard
    seen = {}
    for e in events:
        seen.setdefault(e.plugin, e.scope)
    print(file=Log.STREAM)
    detected_names = {h.name for h in requested_hosts}
    for plugin, scope in seen.items():
        if scope == "claude-only":
            extra = detected_names - {"claude"}
            if extra:
                Log.warn(f"'{plugin}' is CLAUDE-ONLY — installed to claude only, NOT "
                         f"{', '.join(sorted(extra))} (Claude-exclusive plugin)")
            else:
                Log.step(f"'{plugin}' is CLAUDE-ONLY (lives only in Claude Code)")
        else:
            agents = sorted({e.agent for e in events if e.plugin == plugin and e.result in ("installed", "already")})
            if agents:
                Log.ok(f"'{plugin}' is universal — reached: {', '.join(agents)}")
    failed = [e for e in events if e.result in ("failed", "blocked")]
    if failed:
        Log.warn(f"{len(failed)} placement(s) failed/blocked: "
                 + ", ".join(f"{e.plugin}@{e.agent}({e.result})" for e in failed))


def _confirm_uninstall(p: Plugin, host: AIHost) -> bool:
    if DRY_RUN or ASSUME_YES or FORCE:
        return True
    if not sys.stdin.isatty():
        Log.err(f"non-interactive uninstall of {p.name}@{host.name} needs --yes")
        return False
    ans = input(f"    {Log._c('?', 'yellow')} Remove {p.name}@{host.name}? [y/N] ").strip().lower()
    return ans in ("y", "yes")


def _run_uninstalls(targets: list[Plugin], detected: list[AIHost], osi: OSInfo) -> list[dict]:
    """Execute every (plugin × matched-host) removal, returning a PER-ACTION result list (CLI-081)
    so the --json `phase:"executed"` envelope can report each removal's ok/fail independently. The
    human caller derives its failure count from this list."""
    actions: list[dict] = []
    for p in targets:
        Log.head(f"Uninstall: {p.name}  {_tier_badge(p)}")
        matched = _match_hosts(p, detected)
        if not matched:
            Log.warn(f"{p.name}: no detected agent in target list — skip")
            continue
        for host in matched:
            spec = _spec_for(p, host)
            if not _confirm_uninstall(p, host):
                Log.warn(f"{p.name} -> {host.name} skipped")
                actions.append({"plugin": p.name, "host": host.name, "ok": True, "skipped": True})
                continue
            try:
                changed = resolve_uninstaller(host, spec)(p, spec, host, osi)
                if changed:
                    Log.ok(f"{p.name} -> {host.name} uninstalled")
                actions.append({"plugin": p.name, "host": host.name, "ok": True,
                                "changed": bool(changed)})
            except Exception as e:  # noqa: BLE001
                Log.err(f"{p.name} -> {host.name}: {e}")
                actions.append({"plugin": p.name, "host": host.name, "ok": False, "error": str(e)})
    return actions


def cmd_install(args, osi: OSInfo) -> int:
    if osi.family == "unsupported":
        Log.err(f"unsupported OS: {osi.raw}. Only macOS/Linux.")
        return 2

    targets, base = _select_targets(args, plugin_registry())
    if targets is None:
        if JSON_OUT:
            return emit_json({"command": "install", "ok": False,
                              "error": f"unknown plugin: {base}", "_exit": 2})
        Log.err(f"unknown plugin: {base}. Try: list")
        return 2
    if not targets:
        if JSON_OUT:
            return emit_json({"command": "install", "ok": True, "results": {
                "install_events": [], "summary": {}},
                "message": "nothing to install (bundle empty)"})
        Log.warn("nothing to install (bundle empty — insert official plugins first)")
        return 0

    detected = _filter_hosts(detect_hosts(), args.host)
    if not detected:
        if JSON_OUT:
            return emit_json({"command": "install", "ok": False,
                              "error": "no target AI agents detected", "_exit": 2})
        Log.err("no target AI agents detected" + (f" matching --host {args.host}" if args.host else ""))
        return 2
    Log.info(f"target agents: {', '.join(h.name for h in detected)}")

    events: list = []
    failures = _run_installs(targets, detected, osi, events)
    if getattr(args, "arm", False):                  # P5.6 auto-arm (Claude)
        # Arm ONLY what actually installed.
        #
        # This looped over every requested target unconditionally, ignoring the `failures` the
        # line above had just counted. So a plugin the nemesis gate BLOCKED — or one that failed
        # outright, or was refused fail-closed for having no gate coverage — still had
        # `enabledPlugins[id] = true` and its marketplace written into ~/.claude/settings.json.
        # The scanner refused to put the code on disk and Prometheus then told Claude to load it
        # every session: a persistent instruction pointing at an artifact that was rejected, or
        # (worse) at a marketplace entry Claude may resolve and fetch on its own.
        # `skipped`/`already` are not failures — the first never ran, the second is present.
        installed_ok = {e.plugin for e in events if e.result in ("installed", "already")}
        refused = {e.plugin for e in events if e.result in ("blocked", "failed")}
        armed: list[str] = []
        for p in targets:
            if p.name not in installed_ok:
                if p.name in refused:
                    Log.warn(f"NOT auto-arming {p.name} — its install was refused "
                             f"(blocked/failed); settings.json is left untouched for it")
                continue
            for spec in p.targets.values():
                if spec.method == "claude_plugin":
                    if spec.marketplace_name and spec.marketplace_repo:
                        set_extra_marketplace(spec.marketplace_name, spec.marketplace_repo)
                    for pid in _claude_plugin_ids(spec):
                        set_enabled_plugin(pid, True)
                    armed.append(p.name)
        if armed:
            Log.ok(f"auto-armed: {', '.join(sorted(set(armed)))} — enabledPlugins + "
                   f"extraKnownMarketplaces written (skills self-fire each session)")
        else:
            Log.warn("auto-arm: nothing was armed (no target installed successfully)")
    if JSON_OUT:
        return emit_json(_install_events_json("install", args.name, events, detected,
                                              failures, dry_run=DRY_RUN))
    _print_install_map(events, detected)
    write_session_report(f"install {args.name}", events, detected)
    if failures:
        Log.err(f"{failures} install(s) failed")
        return 1
    Log.ok("all requested installs complete")
    return 0


def _install_events_json(command: str, name: str, events: list, detected: list,
                         failures: int, dry_run: bool) -> dict:
    """Shared JSON envelope for install/uninstall: per-(plugin,agent) events +
    a result tally. The nemesis gate decisions surface as 'blocked' events and
    on stderr; `audit` exposes the full verdict detail."""
    summary: dict = {}
    for ev in events:
        summary[ev.result] = summary.get(ev.result, 0) + 1
    env = {"command": command, "ok": failures == 0,
           "request": {"plugin": name, "dry_run": dry_run,
                       "target_agents": [h.name for h in detected]},
           "results": {
               "install_events": [{"plugin": ev.plugin, "agent": ev.agent,
                                   "scope": ev.scope, "method": ev.method,
                                   "result": ev.result} for ev in events],
               "summary": summary},
           "_exit": 1 if failures else 0}
    if _DANGER_OVERRIDES:
        # a nemesis BLOCK/error was force-installed via --force — flag it loudly so
        # an AI agent driving the plugin surfaces the danger to the user.
        env["forced_danger"] = list(_DANGER_OVERRIDES)
        env["ok"] = False        # never report a forced-dangerous install as clean
    return env


def _uninstall_foreign_claude(plugin_id: str) -> int:
    """Remove a discovered (non-registry) Claude plugin by id: `claude plugin
    uninstall <id>`. Also a foreign SKILL.md folder if the name matches."""
    if skill_state(plugin_id) != "absent":
        Log.head(f"Uninstall (foreign skill): {plugin_id}")
        # `and sys.stdin.isatty()` had the polarity backwards: with stdin NOT a tty the whole
        # confirmation was skipped and the rmtree below ran anyway. So
        # `prometheus uninstall <id> < /dev/null` — a shell script, a cron job, an agent that
        # pipes stdin — deleted the skill folder outright with no --yes and no prompt. The
        # `_confirm` helper twenty lines down is this file's own convention and gets it right:
        # non-interactive without an explicit flag is NO.
        if not _confirm(f"delete ~/.claude/skills/{plugin_id}?"):
            Log.warn("declined"); return 0
        d, _md, _dis = _skill_paths(plugin_id)
        if DRY_RUN:
            Log.step(f"[dry-run] rm -rf {d}")
        else:
            shutil.rmtree(d, ignore_errors=True)
        Log.ok(f"removed skill {plugin_id}")
        return 0
    cli = shutil.which("claude")
    if not cli:
        Log.err("claude CLI not found"); return 2
    if not claude_plugin_present(plugin_id) and "@" not in plugin_id:
        Log.err(f"unknown plugin/skill: {plugin_id}. Try: list / inventory / skills list")
        return 2
    Log.head(f"Uninstall (foreign): {plugin_id}")
    # same inverted guard as the skill branch above — a non-tty must not mean "yes".
    if not _confirm(f"Remove {plugin_id}?"):
        Log.warn("declined"); return 0
    run([cli, "plugin", "uninstall", plugin_id], check=False)
    Log.ok(f"requested removal of {plugin_id}")
    return 0


def _confirm(msg: str) -> bool:
    if ASSUME_YES or DRY_RUN or FORCE:
        return True
    if not sys.stdin.isatty():
        Log.err("non-interactive — use --yes"); return False
    return input(f"    {msg} [y/N] ").strip().lower() in ("y", "yes")


def _uninstall_foreign_gemini(name: str) -> int:
    cli = shutil.which("gemini")
    if not cli:
        Log.err("gemini CLI not found"); return 2
    if not gemini_ext_present(name):
        Log.err(f"gemini extension '{name}' not installed"); return 2
    Log.head(f"Uninstall (foreign, gemini): {name}")
    if not _confirm(f"Remove gemini extension {name}?"):
        Log.warn("declined"); return 0
    if DRY_RUN:
        Log.step(f"[dry-run] gemini extensions uninstall {name}")
    else:
        run([cli, "extensions", "uninstall", name], check=False)
    Log.ok(f"removed gemini extension {name}")
    return 0


def _uninstall_foreign_cursor(name: str) -> int:
    base = _cursor_rules_dir()
    Log.head(f"Uninstall (foreign, cursor rule): {name}")
    removed = False
    for cand in (base / f"{name}.mdc", base / f"{name}.mdc.disabled"):
        if cand.exists():
            if not _confirm(f"Delete {cand}?"):
                Log.warn("declined"); return 0
            if DRY_RUN:
                Log.step(f"[dry-run] rm {cand}")
            else:
                cand.unlink()
            removed = True
    if not removed:
        Log.warn(f"cursor rule '{name}' not in {base}")
    else:
        Log.ok(f"removed cursor rule {name}")
    return 0


def _uninstall_foreign_codex(name: str) -> int:
    Log.head(f"Uninstall (foreign, codex): {name}")
    if codex_prompt_state(name) != "absent":
        if not _confirm(f"Delete codex prompt {name}?"):
            Log.warn("declined"); return 0
        for cand in (CODEX_PROMPTS / f"{name}.md", CODEX_PROMPTS / f"{name}.md.disabled"):
            if cand.exists():
                if DRY_RUN:
                    Log.step(f"[dry-run] rm {cand}")
                else:
                    cand.unlink()
        Log.ok(f"removed codex prompt {name}")
        return 0
    if codex_mcp_present(name):
        if not _confirm(f"Remove codex MCP server {name}?"):
            Log.warn("declined"); return 0
        cli = _codex_cli()
        if cli and not DRY_RUN:
            run([cli, "mcp", "remove", name], check=False)
        elif DRY_RUN:
            Log.step(f"[dry-run] codex mcp remove {name}")
        else:
            _remove_codex_mcp_toml(name)
        Log.ok(f"removed codex MCP {name}")
        return 0
    Log.err(f"codex prompt/MCP '{name}' not found"); return 2


def _uninstall_foreign_agent_mcp(name: str, hostname: str) -> int:
    method = _HOST_MCP_METHOD[hostname]
    pathstr, key = _AGENT_MCP_CFG[method]
    if not _agent_mcp_present(method, name):
        Log.err(f"{hostname} MCP '{name}' not found in {pathstr}"); return 2
    Log.head(f"Uninstall (foreign, {hostname} MCP): {name}")
    if not _confirm(f"Remove {hostname} MCP server {name}?"):
        Log.warn("declined"); return 0
    _mcp_remove_json(_expand(pathstr), key, name)
    Log.ok(f"removed {hostname} MCP {name}")
    return 0


def cmd_uninstall(args, osi: OSInfo) -> int:
    # INTENTIONALLY un-gated: uninstall only REMOVES artifacts (deletes files / unwires MCP /
    # reverts config). Removal cannot arm the machine, so there is nothing for nemesis to vet —
    # gating it would only add friction to cleaning up a flagged install. (install / sync / repo
    # add — the paths that bring code IN — are all nemesis gate-first, Phase 0.)
    targets, base = _select_targets(args, plugin_registry())
    if targets is None and JSON_OUT:
        # foreign-id removal needs interactive routing; the JSON bridge handles
        # only registry plugins. Point the caller at the right path.
        return emit_json({"command": "uninstall", "ok": False,
            "error": f"'{base}' is not a registry plugin; foreign removal is not "
                     f"exposed over --json. Use the human CLI or `inventory`.",
            "_exit": 2})
    if targets is None:
        # FOREIGN id discovered by `inventory` — remove directly, routed by --host.
        hosts = set(args.host or [])
        if "gemini" in hosts or (not hosts and gemini_ext_present(base)):
            return _uninstall_foreign_gemini(base)
        if "cursor" in hosts or (not hosts and cursor_rule_state(base) != "absent"):
            return _uninstall_foreign_cursor(base)
        if "codex" in hosts or (not hosts and (codex_prompt_state(base) != "absent" or codex_mcp_present(base))):
            return _uninstall_foreign_codex(base)
        for hn in _HOST_MCP_METHOD:                  # P3: opencode/windsurf/zed/continue MCP
            if hn in hosts or (not hosts and _agent_mcp_present(_HOST_MCP_METHOD[hn], base)):
                return _uninstall_foreign_agent_mcp(base, hn)
        if "@" in base or claude_plugin_present(base) or skill_state(base) != "absent":
            return _uninstall_foreign_claude(base)
        Log.err(f"unknown plugin: {base}. Try: list / inventory")
        return 2
    if not targets:
        if JSON_OUT:
            return emit_json({"command": "uninstall", "ok": True,
                              "results": {"summary": {}}, "message": "nothing to uninstall"})
        Log.warn("nothing to uninstall")
        return 0

    detected = _filter_hosts(detect_hosts(), args.host)
    if not detected:
        if JSON_OUT:
            return emit_json({"command": "uninstall", "ok": False,
                              "error": "no target AI agents detected", "_exit": 2})
        Log.err("no target AI agents detected" + (f" matching --host {args.host}" if args.host else ""))
        return 2

    request = {"plugin": args.name, "dry_run": DRY_RUN,
               "target_agents": [h.name for h in detected], "plugins": [p.name for p in targets]}
    # CLI-081: --json is PLAN-then-EXECUTE. Without --yes → a plan envelope that mutates NOTHING;
    # with --yes → execute + a per-action `phase:"executed"` envelope. (Un-gated by design — removal
    # can't arm the machine; no nemesis gate added here.)
    if JSON_OUT and not getattr(args, "yes", False):
        plan = [{"kind": "remove-plugin", "target": p.name, "detail": f"remove from {h.name}"}
                for p in targets for h in _match_hosts(p, detected)]
        return emit_json({"command": "uninstall", "ok": True, "phase": "plan",
                          "actions": plan, "requires": ["--yes"], "request": request, "_exit": 0})

    actions = _run_uninstalls(targets, detected, osi)
    failures = sum(1 for a in actions if not a.get("ok"))
    if JSON_OUT:
        return emit_json({"command": "uninstall", "ok": failures == 0, "phase": "executed",
                          "request": request, "actions": actions,
                          "results": {"failures": failures}, "_exit": 1 if failures else 0})
    if failures:
        Log.err(f"{failures} uninstall(s) failed")
        return 1
    Log.ok("all requested uninstalls complete")
    return 0


def cmd_bundle(args, osi: OSInfo) -> int:
    """Install the official Anthropic bundle in one run (auto-trusted, still scanned)."""
    if osi.family == "unsupported":
        Log.err(f"unsupported OS: {osi.raw}. Only macOS/Linux.")
        return 2
    targets = bundle_plugins()
    if not targets:
        if JSON_OUT:
            return emit_json({"command": "bundle", "ok": True,
                "results": {"install_events": [], "summary": {}},
                "message": "official bundle is empty"})
        Log.warn("official bundle is empty (no official plugins inserted yet)")
        return 0
    detected = _filter_hosts(detect_hosts(), getattr(args, "host", None))
    if not detected:
        if JSON_OUT:
            return emit_json({"command": "bundle", "ok": False,
                              "error": "no target AI agents detected", "_exit": 2})
        Log.err("no target AI agents detected")
        return 2
    Log.info(f"official bundle: {', '.join(p.name for p in targets)}")
    events: list = []
    failures = _run_installs(targets, detected, osi, events)
    if JSON_OUT:
        return emit_json(_install_events_json("bundle", "official-bundle", events,
                                              detected, failures, dry_run=DRY_RUN))
    _print_install_map(events, detected)
    write_session_report("bundle", events, detected)
    if failures:
        Log.err(f"{failures} install(s) failed")
        return 1
    Log.ok("official bundle complete")
    return 0


def cmd_audit(args, osi: OSInfo) -> int:
    """C1 — scan plugin install artifacts, no install."""
    if args.revoke:
        n = revoke_trust(args.name)
        # Under --json this returned 0 with EMPTY stdout — no envelope at all, so a caller could
        # not tell a successful revoke from a no-op from a crash. `revoked` is reported plainly:
        # 0 is an honest answer (nothing was remembered for that name), not a failure.
        if JSON_OUT:
            return emit_json({"command": "audit", "ok": True, "action": "revoke",
                              "name": args.name, "revoked": n})
        Log.ok(f"revoked {n} trust entr{'y' if n == 1 else 'ies'} for {args.name}")
        return 0

    reg = plugin_registry()
    targets = list(PLUGINS) if args.name == "all" else ([reg[args.name]] if args.name in reg else [])
    if not targets:
        if JSON_OUT:
            return emit_json({"command": "audit", "ok": False,
                              "error": f"unknown plugin: {args.name}", "_exit": 2})
        Log.err(f"unknown plugin: {args.name}. Try: list")
        return 2

    worst = "clean"
    audited_urls: dict = {}            # url -> verdict, scanned once per run
    audits: list = []                  # JSON: per-(plugin,agent) audit records
    for p in targets:
        for hname, spec in p.targets.items():
            Log.head(f"Audit: {p.name}@{hname}")
            report = scan_spec(p.name, spec)
            if not JSON_OUT:
                print_report(report)
            if SEVERITY_ORDER.get(report.verdict, 0) > SEVERITY_ORDER.get(worst, 0):
                worst = report.verdict
            rec = {"agent": hname, "method": spec.method,
                   "scan_report": {
                       "verdict": report.verdict, "identity": report.identity,
                       "scanned_files": report.scanned_files,
                       "active_findings": [{"rule_id": f.rule.id, "severity": f.severity,
                                            "desc": getattr(f.rule, "desc", ""),
                                            "snippet": f.snippet, "context": f.context,
                                            "rel_path": f.rel_path, "line": f.line_no}
                                           for f in report.active],
                       "downgraded_count": len(report.downgraded)},
                   "nemesis_verdicts": []}
            # deep second opinion from nemesis — every method that names a remote
            # source gets one. NOTE: remote targets are never verdict-cached by
            # nemesis, so `audit all` re-fetches each repo — memoize per run.
            if GATE_MODE != "off":
                gate_urls = _gate_targets_for_spec(spec) or \
                    ([spec.repo_url] if getattr(spec, "repo_url", None) else [])
                for ru in gate_urls:
                    if ru in audited_urls:
                        v = audited_urls[ru]
                        Log.step(f"deep nemesis gate: {ru} (already scanned this run)")
                    else:
                        Log.step(f"deep nemesis gate: {ru}")
                        v = nemesis_gate(ru)
                        audited_urls[ru] = v
                        _gate_audit(f"audit:{p.name}", ru, v)
                    Log.info(f"nemesis: {v.get('verdict', '?').upper()} "
                             f"(risk {v.get('risk_score', '?')}/100) — {v.get('recommendation', '')}")
                    for r in (v.get("blocking_reasons") or [])[:5]:
                        Log.step(f"  • {r}")
                    rec["nemesis_verdicts"].append({
                        "source": ru, "verdict": v.get("verdict"),
                        "risk_score": v.get("risk_score"),
                        "recommendation": v.get("recommendation"),
                        "blocking_reasons": (v.get("blocking_reasons") or [])[:8]})
                    if v.get("verdict") == "block":
                        worst = "critical"
                    elif v.get("verdict") == "error":
                        # scanner failure ≠ malware: fail the audit, but say why
                        Log.warn(f"nemesis could not scan {ru} — treat as UNVERIFIED")
                        if SEVERITY_ORDER.get(worst, 0) < SEVERITY_ORDER.get("high", 0):
                            worst = "high"
                    elif v.get("verdict") == "warn":
                        c = v.get("severity_counts") or {}
                        floor = "high" if c.get("CRITICAL", 0) + c.get("HIGH", 0) > 0 else "medium"
                        if SEVERITY_ORDER.get(worst, 0) < SEVERITY_ORDER.get(floor, 0):
                            worst = floor
            audits.append(rec)
    if JSON_OUT:
        return emit_json({"command": "audit", "ok": worst in ("clean", "low"),
            "request": {"plugin": args.name}, "audits": audits,
            "worst_verdict": worst, "_exit": 0 if worst in ("clean", "low") else 1})
    Log.info(f"worst verdict: {worst}")
    return 0 if worst in ("clean", "low") else 1


# ============================================================================
#  Granular state control commands: status / enable / disable / skills
#  States a package can be in: absent → installed → enabled/disabled (whole) →
#  per-component enabled/muted/disabled → eradicated. All reversible.
# ============================================================================
def _component_state(comp: Component) -> str:
    if comp.kind == "subplugin":
        if not claude_plugin_present(comp.name):
            return "absent"
        en = plugin_enabled(comp.name)
        return "enabled" if en in (None, True) else "disabled"
    if comp.kind == "skill":
        return skill_state(comp.name)
    return "?"


def cmd_status(args, osi: OSInfo) -> int:
    reg = plugin_registry()
    base, _sel = _parse_name_selection(args.name)
    targets = list(PLUGINS) if base == "all" else ([reg[base]] if base in reg else [])
    if not targets:
        if JSON_OUT:
            return emit_json({"command": "status", "ok": False,
                              "error": f"unknown plugin: {base}", "_exit": 2})
        Log.err(f"unknown plugin: {base}. Try: list")
        return 2
    if JSON_OUT:
        hreg = host_registry()
        out_plugins = []
        for p in targets:
            agents = []
            for hname, spec in p.targets.items():
                inst = None
                if hname in hreg:
                    try:
                        inst = is_installed(p, hreg.get(hname), spec)
                    except Exception:  # noqa: BLE001
                        inst = None
                mk = None
                if spec.method in ("claude_plugin", "claude_marketplace") and spec.marketplace_name:
                    mk = claude_marketplace_present(spec.marketplace_name)
                agents.append({"name": hname, "method": spec.method,
                               "installed": inst, "marketplace_present": mk})
            comps = []
            for c in p.components_for():
                try:
                    st = _component_state(c)
                except Exception:  # noqa: BLE001
                    st = "unknown"
                comps.append({"name": c.name, "kind": c.kind, "state": st})
            out_plugins.append({"name": p.name, "tier": p.tier,
                                "agents": agents, "components": comps})
        # single-plugin requests return a flat `plugin`; `all` returns `plugins`
        if len(out_plugins) == 1:
            return emit_json({"command": "status", "ok": True, "plugin": out_plugins[0]})
        return emit_json({"command": "status", "ok": True, "plugins": out_plugins})
    for p in targets:
        Log.head(f"Status: {p.name}  {_tier_badge(p)}")
        for hname, spec in p.targets.items():
            inst = is_installed(p, host_registry().get(hname), spec) if hname in host_registry() else None
            mk = f"  marketplace {spec.marketplace_name}: " + \
                 ("present" if spec.marketplace_name and claude_marketplace_present(spec.marketplace_name) else "absent") \
                 if spec.method in ("claude_plugin", "claude_marketplace") else ""
            statestr = {True: "installed", False: "missing", None: "n/a"}[inst]
            print(f"  host {hname} ({spec.method}): {statestr}{mk}")
        comps = p.components_for()
        if comps:
            print("  components:")
            for c in comps:
                st = _component_state(c)
                col = {"enabled": "green", "installed": "green", "disabled": "yellow",
                       "muted": "cyan", "absent": "dim", "missing": "yellow"}.get(st, "magenta")
                print(f"    - {_short_id(c.name):<34} [{c.kind}] {Log._c(st, col)}")
        if p.installs_skills:
            Log.step("skill-based — use `skills list` to see/toggle the installed SKILL.md folders")
    return 0


def _enable_disable(args, osi: OSInfo, enabled: bool) -> int:
    verb = "enable" if enabled else "disable"
    reg = plugin_registry()
    base, name_sel = _parse_name_selection(args.name)
    hosts = set(getattr(args, "host", None) or [])
    p = reg.get(base)
    if not p:
        # P1: route a FOREIGN item to the right agent via --host.
        if "gemini" in hosts:
            st = set_gemini_extension(base, enabled)
            if st:
                Log.ok(f"gemini extension '{base}' -> {st}")
            return 0
        if "cursor" in hosts:
            st = set_cursor_rule(base, enabled)
            if st:
                Log.ok(f"cursor rule '{base}' -> {st}")
            return 0
        if "codex" in hosts:
            st = set_codex_prompt(base, enabled)
            if st:
                Log.ok(f"codex prompt '{base}' -> {st}")
            return 0
        if hosts & set(_HOST_MCP_METHOD):           # opencode/windsurf/zed/continue (MCP-only)
            Log.warn(f"{base}: MCP for {', '.join(hosts & set(_HOST_MCP_METHOD))} has no in-place disable — "
                     f"use `uninstall {base} --host <agent>` (re-`install` to restore)")
            return 0
        # default agent = Claude: foreign plugin id, then foreign skill folder.
        if "@" in base or claude_plugin_present(base):
            set_enabled_plugin(base, enabled)
            Log.ok(f"{base} -> {'enabled' if enabled else 'disabled'} (settings.json enabledPlugins)")
            Log.step("restart Claude Code or /reload-plugins to apply")
            return 0
        if skill_state(base) != "absent":
            ok = (enable_skill if enabled else disable_skill)(base)
            if ok:
                Log.ok(f"skill '{base}' -> {skill_state(base)}")
            return 0
        if gemini_ext_present(base):
            st = set_gemini_extension(base, enabled)
            if st:
                Log.ok(f"gemini extension '{base}' -> {st}")
            return 0
        if cursor_rule_state(base) != "absent":
            st = set_cursor_rule(base, enabled)
            if st:
                Log.ok(f"cursor rule '{base}' -> {st}")
            return 0
        if codex_prompt_state(base) != "absent":
            st = set_codex_prompt(base, enabled)
            if st:
                Log.ok(f"codex prompt '{base}' -> {st}")
            return 0
        Log.err(f"unknown plugin/skill: {base}. Try: list / inventory / skills list")
        return 2
    Log.head(f"{verb.capitalize()}: {p.name}")

    comp_kind = getattr(args, "component", None)
    short = base  # plugin short name for on-disk lookup (often == registry name)

    # on-disk feature toggles (hooks / mcp) — reversible rename
    if comp_kind in ("hooks", "mcp"):
        fn = set_plugin_hooks if comp_kind == "hooks" else set_plugin_mcp
        state = fn(short, enabled)
        if state:
            Log.ok(f"{p.name} {comp_kind} -> {state}")
        return 0

    # claude_plugin sub-ids via settings.json enabledPlugins (install stays)
    ids = [i for s in p.targets.values() for i in _claude_plugin_ids(s)]
    if ids:
        only = _csv(getattr(args, "only", None)) + name_sel
        sel = _filter_ids(ids, only, []) if only else ids
        if not sel:
            Log.warn("selection matched no components")
            return 0
        for pid in sel:
            set_enabled_plugin(pid, enabled)
            Log.ok(f"{_short_id(pid)} -> {'enabled' if enabled else 'disabled'} (settings.json enabledPlugins)")
        Log.step("restart Claude Code or /reload-plugins to apply")
        return 0

    # skill-based plugin: toggle a SKILL.md folder if its name matches
    if p.installs_skills:
        target_skill = name_sel[0] if name_sel else base
        if skill_state(target_skill) != "absent":
            ok = (enable_skill if enabled else disable_skill)(target_skill)
            if ok:
                Log.ok(f"skill '{target_skill}' -> {skill_state(target_skill)}")
            return 0
        Log.warn(f"{p.name} installs SKILL.md folders whose names aren't statically known — "
                 f"run `skills list`, then `skills {verb} <skill-name>`")
        return 0

    Log.warn(f"{p.name}: nothing to {verb} (method has no toggle surface). "
             f"Use install/uninstall instead.")
    return 0


def _enable_disable_json(args, osi: OSInfo, enabled: bool) -> int:
    """JSON wrapper: run the toggle (its human text goes to stderr), then report
    the resulting component states so the caller sees the new truth."""
    verb = "enable" if enabled else "disable"
    base, _sel = _parse_name_selection(args.name)
    p = plugin_registry().get(base)
    rc = _enable_disable(args, osi, enabled)
    items = []
    if p:
        for c in p.components_for():
            try:
                items.append({"name": c.name, "kind": c.kind, "state": _component_state(c)})
            except Exception:  # noqa: BLE001
                items.append({"name": c.name, "kind": c.kind, "state": "unknown"})
    return emit_json({"command": verb, "ok": rc == 0,
        "request": {"plugin": base, "component": getattr(args, "component", None)},
        "result": {"items": items}, "_exit": rc})


def cmd_enable(args, osi: OSInfo) -> int:
    if JSON_OUT:
        return _enable_disable_json(args, osi, enabled=True)
    return _enable_disable(args, osi, enabled=True)


def cmd_disable(args, osi: OSInfo) -> int:
    if JSON_OUT:
        return _enable_disable_json(args, osi, enabled=False)
    return _enable_disable(args, osi, enabled=False)


# ============================================================================
#  URL-injection safeguard — L5 content-pinning & TOCTOU lock (PHASE 2)
#
#  "Pin what you vet; vet what you use." At install/vet time we snapshot the EXACT
#  (whitespace-normalized) bytes of every installed external source the agent may
#  load or act on — SKILL.md / AGENTS.md bodies + MCP config JSONs across every
#  known host — and vendor a blessed copy. On EVERY startup + on demand we re-hash
#  and byte-compare: any drift is the MCPoison / rug-pull tell. Drift that re-gates
#  to BLOCK is QUARANTINED (gzip-moved to a signed vault, never erased) and the
#  blessed copy restored; benign drift is re-gated and re-pinned to a new baseline.
#  Cosmetic edits (whitespace / line-endings) are normalized out before hashing so
#  they never re-prompt (url_injection_safeguard.md §8 Q4).
# ============================================================================
# Computed from HOME (defined early) rather than PROM_DIR (defined later in the
# file) so these module-level constants resolve at import time; the value is
# identical to PROM_DIR / "…".
_PROM_CFG_DIR = PROM_DIR
_URL_PIN_DIR = _PROM_CFG_DIR / "url_pins"
_URL_PIN_MANIFEST = _URL_PIN_DIR / "pins.json"
_URL_PIN_LOCK = _URL_PIN_DIR / ".pins.lock"   # serialize pin manifest read-modify-write
_URL_PIN_BLESSED = _URL_PIN_DIR / "blessed"
_URL_QUARANTINE_DIR = _PROM_CFG_DIR / "url_quarantine"
_URL_PIN_KEY_FILE = _PROM_CFG_DIR / "pin.key"
_URL_PIN_STARTED = _PROM_CFG_DIR / ".pin_audit_last"   # throttle marker for startup hook
_URL_PIN_THROTTLE = 6 * 3600                       # startup auto-audit at most every 6h
_PIN_SOURCE_NAMES = ("SKILL.md", "SKILL.md.disabled", "AGENTS.md", "CLAUDE.md")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _write_json_atomic(path: Path, obj: dict) -> None:
    if DRY_RUN:
        Log.step(f"[dry-run] write {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique tmp per writer (pid+uuid): a shared "<name>.tmp" lets two concurrent
    # writers clobber each other's half-written file before the atomic replace.
    tmp = path.with_suffix(f"{path.suffix}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(obj, indent=2, default=str))
        tmp.replace(path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


@contextlib.contextmanager
def _file_lock(path: Path):
    """Best-effort exclusive advisory lock (POSIX flock) serializing a read-modify-
    write. No-op where fcntl is unavailable (Windows), under --dry-run, or if the
    lock file can't be opened — callers must tolerate a degraded (unlocked) run."""
    fh = None
    if fcntl is not None and not DRY_RUN:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fh = open(path, "w")
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        except OSError:
            if fh is not None:
                fh.close()
            fh = None
    try:
        yield
    finally:
        if fh is not None:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            fh.close()


def _pin_key() -> bytes:
    """Local HMAC key for signing quarantine manifests (tamper-evidence). Created
    once, 0600. Best-effort: a missing key just yields an unsigned manifest."""
    try:
        if _URL_PIN_KEY_FILE.exists():
            return bytes.fromhex(_URL_PIN_KEY_FILE.read_text().strip())
        if DRY_RUN:
            return b""
        PROM_DIR.mkdir(parents=True, exist_ok=True)
        key = os.urandom(32)
        _URL_PIN_KEY_FILE.write_text(key.hex())
        try:
            os.chmod(_URL_PIN_KEY_FILE, 0o600)
        except OSError:
            pass
        return key
    except OSError:
        return b""


def _sign_pin(obj: dict) -> str:
    key = _pin_key()
    if not key:
        return ""
    canon = json.dumps({k: v for k, v in obj.items() if k != "sig"},
                       sort_keys=True, default=str).encode()
    return hmac.new(key, canon, hashlib.sha256).hexdigest()


def _sri(data: bytes, alg: str = "sha384") -> str:
    """W3C Subresource-Integrity digest, e.g. 'sha384-<base64>'. sha384/512 per L5."""
    h = hashlib.new(alg, data).digest()
    return f"{alg}-{base64.b64encode(h).decode()}"


def _pin_normalize(data: bytes) -> bytes:
    """Normalize cosmetic noise before hashing so whitespace / line-ending edits do
    NOT read as content drift: CRLF/CR → LF, strip per-line trailing whitespace,
    drop trailing blank lines. Content changes still flip the hash."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return data  # binary-ish: hash raw
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.rstrip() for ln in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    return ("\n".join(lines) + "\n").encode("utf-8") if lines else b""


def _nemesis_urlscan(target: str) -> dict:
    """Run `nemesis urlscan` (L0) for the URLs a source could make an agent fetch.
    Best-effort: any failure yields an empty url list (the pin still records body
    drift, which is the primary TOCTOU signal)."""
    if GATE_MODE == "off" or not os.path.exists(NEMESIS_BIN):
        return {"urls": []}
    try:
        p = subprocess.run([sys.executable, NEMESIS_BIN, "urlscan", target, "--json"],
                           capture_output=True, text=True, timeout=120)
        return json.loads(p.stdout) if p.stdout.strip() else {"urls": []}
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError):
        return {"urls": []}


_TRUSTED_URLS_FILE = _PROM_CFG_DIR / "trusted_urls.json"


def _trusted_urls_add(source: str, kept: list) -> int:
    """Cross-reference vault (option C): record official-doc URLs spared/harvested from
    a source so prometheus can surface the canonical link WITHOUT it living in the
    installed artifact. Returns the number of newly-added URLs."""
    data = _read_json(_TRUSTED_URLS_FILE) or {}
    urls = data.get("urls", {})
    added = 0
    for k in kept:
        u = k.get("url")
        if not u:
            continue
        e = urls.get(u)
        if e:
            if source not in e["sources"]:
                e["sources"].append(source)
        else:
            urls[u] = {"host": k.get("host"), "sources": [source], "first_seen": _now_iso()}
            added += 1
    data.update({"schema": "prometheus.trusted_urls/1", "urls": urls,
                 "updated_at": _now_iso()})
    _write_json_atomic(_TRUSTED_URLS_FILE, data)
    return added


def trusted_urls_list() -> list[dict]:
    data = _read_json(_TRUSTED_URLS_FILE) or {}
    return [{"url": u, **meta} for u, meta in (data.get("urls", {}) or {}).items()]


def _nemesis_defang(target: str, mode: str = "star", scope: str = "urls",
                    keep: str = "none", dry_run: bool = False) -> dict:
    """Bridge to `nemesis defang` — wipe every URL from a file/tree so it is URL-inert
    (originals kept in *.nemesis.bak by nemesis). `keep='trusted'` spares official-doc
    URLs. Best-effort; fail-soft."""
    if GATE_MODE == "off" or not os.path.exists(NEMESIS_BIN):
        return {"changed": False, "error": "nemesis unavailable / gate off"}
    cmd = [sys.executable, NEMESIS_BIN, "defang", target, "--mode", mode,
           "--scope", scope, "--keep", keep, "--json", "--yes"]
    if dry_run:
        cmd.append("--dry-run")
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if not p.stdout.strip():
            # No JSON: a non-zero exit means defang FAILED — never report that as a clean
            # "no change" (which a caller would read as "already URL-inert").
            if p.returncode != 0:
                return {"changed": False,
                        "error": f"nemesis defang failed (exit {p.returncode}): {(p.stderr or '').strip()[:200]}"}
            return {"changed": False}
        out = json.loads(p.stdout)
        if p.returncode != 0 and not out.get("error"):
            out["error"] = f"nemesis defang exit {p.returncode}"
        return out
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError) as e:
        return {"changed": False, "error": str(e)}


def defang_installed_sources(mode: str = "star", scope: str = "urls",
                             keep: str = "trusted") -> dict:
    """Render installed external sources URL-inert. Three policies (url_injection_safeguard.md §11):
      keep="none"    → wipe ALL URLs (max inert).
      keep="trusted" → wipe all EXCEPT official-doc URLs (Anthropic/OpenAI/Google/Cursor/…),
                       which are re-verified offline each startup (cheap, no LLM).
      keep="vault"   → harvest official-doc URLs into the cross-ref vault, then wipe ALL
                       (artifact fully inert; canonical links preserved centrally).
    Re-pins the inert sources as the new blessed baseline afterward."""
    sources = _pin_iter_sources()
    report: list[dict] = []
    total = kept_total = vaulted = 0
    for s in sources:
        path = str(s["path"])
        if keep == "vault":
            dry = _nemesis_defang(path, mode=mode, scope=scope, keep="trusted", dry_run=True)
            harvested = [k for f in dry.get("files", []) for k in f.get("kept", [])]
            if harvested:
                vaulted += _trusted_urls_add(path, harvested)
            r = _nemesis_defang(path, mode=mode, scope=scope, keep="none")
        else:
            r = _nemesis_defang(path, mode=mode, scope=scope, keep=keep)
        n = r.get("urls_neutralized", 0) or 0
        kt = r.get("urls_kept_trusted", 0) or 0
        kept_total += kt
        if n:
            total += n
            report.append({"path": path, "kind": s["kind"], "urls_neutralized": n,
                           "kept_trusted": kt, "mode": mode})
        elif kt:
            report.append({"path": path, "kind": s["kind"], "urls_neutralized": 0,
                           "kept_trusted": kt})
        elif r.get("error"):
            report.append({"path": path, "error": r["error"]})
    if total:
        audit_sources(quarantine=False)   # re-baseline: inert version becomes the trusted pin
    return {"mode": mode, "scope": scope, "keep": keep,
            "sources_defanged": sum(1 for r in report if r.get("urls_neutralized")),
            "urls_neutralized": total, "urls_kept_trusted": kept_total,
            "urls_vaulted": vaulted, "report": report}


def _iter_skill_dirs() -> list[dict]:
    """Every skill FOLDER across all host skill dirs (a dir holding SKILL.md /
    AGENTS.md / CLAUDE.md), EXCLUDING the central prometheus_skills folder itself.
    De-duplicated by resolved path. Used by auto-integration."""
    seen: set[str] = set()
    out: list[dict] = []
    try:
        central = str(PROMETHEUS_SKILLS_DIR.resolve())
    except OSError:
        central = str(PROMETHEUS_SKILLS_DIR)
    for host in HOSTS:
        for sd in host.skills_dirs:
            base = Path(os.path.expanduser(sd))
            if not base.is_dir():
                continue
            for d in sorted(base.iterdir()):
                if not d.is_dir():
                    continue
                try:
                    rp = str(d.resolve())
                except OSError:
                    continue
                if rp in seen or rp == central or rp.startswith(central + os.sep):
                    continue
                if any((d / fn).exists() for fn in _PIN_SOURCE_NAMES):
                    seen.add(rp)
                    out.append({"name": d.name, "dir": d, "host": host.name})
    return out


def _dir_has_symlink(d: Path) -> bool:
    """True if the tree under `d` contains ANY symlink (does NOT follow them)."""
    try:
        for root, dirs, files in os.walk(d, followlinks=False):
            for name in dirs + files:
                if os.path.islink(os.path.join(root, name)):
                    return True
    except OSError:
        return True  # can't fully inspect → treat as unsafe (fail-closed)
    return False


def integrate_green_skills(dry_run: bool = False, limit: Optional[int] = None) -> dict:
    """Discover skills across EVERY detected agent and copy the nemesis-GREEN ones
    (verdict 'allow') into the central prometheus_skills folder. Fail-closed: a
    warn/block/error skill is NEVER integrated. Idempotent (skips already-present).
    `limit` caps how many NEW skills are gated this run (for the throttled startup
    hook) — the rest are deferred to a later run. Copies only; originals untouched."""
    res: dict = {"integrated": [], "skipped_unsafe": [], "already": [],
                 "errors": [], "deferred": 0}
    gated = 0
    for s in _iter_skill_dirs():
        name, src = s["name"], s["dir"]
        dest = PROMETHEUS_SKILLS_DIR / name
        if dest.exists():
            res["already"].append(name)
            continue
        if limit is not None and gated >= limit:
            res["deferred"] += 1
            continue
        gated += 1
        v = nemesis_gate(str(src)) if GATE_MODE != "off" else {"verdict": "unscanned"}
        verdict = v.get("verdict")
        if verdict != "allow":
            res["skipped_unsafe"].append({
                "name": name, "host": s["host"], "verdict": verdict,
                "reasons": (v.get("blocking_reasons") or [])[:4]})
            continue
        if dry_run:
            res["integrated"].append({"name": name, "host": s["host"],
                                      "verdict": verdict, "dry_run": True})
            continue
        # Refuse a skill dir containing a symlink: copytree(symlinks=False) would
        # DEREFERENCE it and copy the link TARGET's content (e.g. ~/.ssh/id_rsa) into
        # the central skills folder — an exfil/poison vector the nemesis scan of the
        # dir's own files may not have followed. copy with symlinks=True as well.
        if _dir_has_symlink(src):
            res["skipped_unsafe"].append({
                "name": name, "host": s["host"], "verdict": verdict,
                "reasons": ["skill dir contains a symlink — refused (would copy the link target)"]})
            continue
        try:
            PROMETHEUS_SKILLS_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, dest, symlinks=True)
            res["integrated"].append({"name": name, "host": s["host"],
                                      "verdict": verdict, "dest": str(dest)})
        except OSError as e:
            res["errors"].append({"name": name, "error": str(e)})
    # newly-integrated skills become pinned baselines (nemesis re-checks each startup)
    if res["integrated"] and not dry_run:
        audit_sources(quarantine=False)
    return res


def _pin_iter_sources() -> list[dict]:
    """Every installed external source whose bytes the agent may load/act on, across
    all known hosts: SKILL.md / AGENTS.md / CLAUDE.md bodies + MCP config JSONs.
    De-duplicated by resolved path."""
    seen: set[str] = set()
    out: list[dict] = []

    def _add(path: Path, kind: str) -> None:
        try:
            if not path.is_file():
                return
            rp = str(path.resolve())
        except OSError:
            return
        if rp in seen:
            return
        seen.add(rp)
        out.append({"path": path, "kind": kind})

    # the central prometheus_skills folder is always in scope (nemesis re-checks it)
    skill_dirs = [str(PROMETHEUS_SKILLS_DIR)]
    for host in HOSTS:
        skill_dirs.extend(host.skills_dirs)
    for sd in skill_dirs:
        base = Path(os.path.expanduser(sd))
        if not base.is_dir():
            continue
        _add(base / "AGENTS.md", "agents")
        _add(base / "CLAUDE.md", "agents")
        for d in sorted(base.iterdir()):
            if not d.is_dir():
                continue
            for fn in _PIN_SOURCE_NAMES:
                _add(d / fn, "skill")
    for host in HOSTS:
        for mc in host.mcp_configs:
            _add(Path(os.path.expanduser(mc)), "mcp")
    return out


def pin_source(path: Path, kind: str) -> dict:
    """Snapshot + vendor a blessed (normalized) copy and return a manifest record."""
    raw = path.read_bytes()
    norm = _pin_normalize(raw)
    nsha = hashlib.sha256(norm).hexdigest()
    if not DRY_RUN:
        _URL_PIN_BLESSED.mkdir(parents=True, exist_ok=True)
        bp = _URL_PIN_BLESSED / f"{nsha}.gz"
        if not bp.exists():
            bp.write_bytes(gzip.compress(norm))
    return {
        "path": str(path), "kind": kind,
        "sri": _sri(norm, "sha384"),
        "norm_sha256": nsha,
        "raw_sha256": hashlib.sha256(raw).hexdigest(),
        "blessed": f"blessed/{nsha}.gz",
        "size": len(raw),
        "pinned_at": _now_iso(),
    }


def _pin_diff(blessed_norm: bytes, current_norm: bytes, label: str) -> list[str]:
    a = blessed_norm.decode("utf-8", "replace").splitlines()
    b = current_norm.decode("utf-8", "replace").splitlines()
    return list(difflib.unified_diff(a, b, fromfile=f"{label} (blessed)",
                                     tofile=f"{label} (now)", lineterm="", n=2))[:60]


def _quarantine_and_restore(path: Path, rec: dict, verdict: dict) -> dict:
    """Reversible: gzip-move the drifted file into a signed vault (NEVER erased) and
    restore the blessed vendored copy in its place. Returns a vault descriptor."""
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    # uuid suffix: two quarantines of same-named files in the same second must not
    # collide into one vault dir (the second would overwrite the first's evidence).
    qdir = _URL_QUARANTINE_DIR / f"{ts}-{path.name}-{uuid.uuid4().hex[:8]}"
    restored = False
    if not DRY_RUN:
        qdir.mkdir(parents=True, exist_ok=True)
        (qdir / (path.name + ".gz")).write_bytes(gzip.compress(path.read_bytes()))
        bp = _URL_PIN_DIR / rec.get("blessed", "")
        if bp.exists():
            try:
                path.write_bytes(gzip.decompress(bp.read_bytes()))
                restored = True
            except OSError:
                restored = False
        # NEUTRALIZE when the blessed restore did not happen.
        #
        # Overwriting with the blessed copy is the ONLY thing that made the drifted file safe, so
        # a missing blessed blob (pruned, never synced) or a write that raises — a read-only file,
        # `chmod 444` — left BLOCK-verdict content fully in place and still loadable by the agent,
        # while the record was appended to `quarantined` and the startup hook announced
        # "were QUARANTINED (blessed copy restored)". The twin below, `_quarantine_new`, already
        # disables a dangerous first-seen source by renaming it out of the way; only one of the
        # two was hardened. Same remedy here, so "quarantined" means the same thing on both paths.
        if not restored:
            try:
                disabled = path.with_name(path.name + ".url-quarantined")
                path.rename(disabled)
                man_disabled = str(disabled)
            except OSError:
                man_disabled = ""  # could not disable either; the vault copy is still evidence
        else:
            man_disabled = ""
    man = {
        "schema": "prometheus.url_quarantine/1",
        "quarantined_at": _now_iso(),
        "original_path": str(path),
        "stored": str(qdir / (path.name + ".gz")),
        "verdict": verdict.get("verdict"),
        "risk_score": verdict.get("risk_score"),
        "blocking_reasons": (verdict.get("blocking_reasons") or [])[:8],
        "restored_blessed": restored,
        "blessed_sha256": rec.get("norm_sha256"),
        "reason": "content drift on a pinned source re-gated to a dangerous verdict",
    }
    # present only when the restore failed AND the file was renamed out of the way instead
    if not DRY_RUN and not restored and man_disabled:
        man["disabled_path"] = man_disabled
    man["mode"] = "drift-restore-blessed"
    man["sig"] = _sign_pin(man)
    if not DRY_RUN:
        _write_json_atomic(qdir / "manifest.json", man)
    # `neutralized` is what a caller should report on: TRUE means the dangerous bytes are no
    # longer where the agent loads them, whether that happened by restore or by rename.
    neutralized = restored or bool(not DRY_RUN and man_disabled)
    return {"original": str(path), "vault": str(qdir), "restored_blessed": restored,
            "neutralized": neutralized,
            **({"disabled_path": man_disabled} if (not DRY_RUN and man_disabled) else {}),
            "verdict": verdict.get("verdict")}


def _quarantine_new(path: Path, verdict: dict) -> dict:
    """A FIRST-SEEN source (no prior blessed copy) that gates dangerous: gzip-copy it
    into the signed vault (evidence, never erased) and reversibly DISABLE it in place
    by renaming → '<name>.url-quarantined' so the agent stops loading it."""
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    qdir = _URL_QUARANTINE_DIR / f"{ts}-{path.name}-new-{uuid.uuid4().hex[:8]}"
    disabled = path.with_name(path.name + ".url-quarantined")
    if not DRY_RUN:
        qdir.mkdir(parents=True, exist_ok=True)
        (qdir / (path.name + ".gz")).write_bytes(gzip.compress(path.read_bytes()))
        try:
            path.rename(disabled)
        except OSError:
            disabled = path  # could not disable; vault copy still kept
    man = {
        "schema": "prometheus.url_quarantine/1", "quarantined_at": _now_iso(),
        "original_path": str(path), "disabled_path": str(disabled),
        "stored": str(qdir / (path.name + ".gz")),
        "verdict": verdict.get("verdict"), "risk_score": verdict.get("risk_score"),
        "blocking_reasons": (verdict.get("blocking_reasons") or [])[:8],
        "mode": "first-seen-disable",
        "reason": "a first-seen installed source gated dangerous (no prior blessed copy)",
    }
    man["sig"] = _sign_pin(man)
    if not DRY_RUN:
        _write_json_atomic(qdir / "manifest.json", man)
    return {"original": str(path), "vault": str(qdir), "restored_blessed": False,
            "disabled_path": str(disabled), "verdict": verdict.get("verdict")}


def audit_sources(*, quarantine: bool = True, quarantine_new: bool = False,
                  gate_new: bool = True, progress=None) -> dict:
    """Walk every installed external source; baseline-pin first-seen ones (gating
    them), and on a pinned source detect content drift. Drift that re-gates to
    block/error is quarantined (fail-closed, reversible) + the blessed copy
    restored; benign drift is re-gated and re-pinned to a new baseline. When
    `quarantine_new` (the explicit audit command, not the silent startup hook), a
    FIRST-SEEN source that gates dangerous is reversibly disabled + vaulted too.
    Returns a structured summary. Pure-offline except the nemesis gate it runs.
    The read-modify-write of pins.json is serialized under an flock so a manual
    audit and the detached startup audit cannot lose each other's updates."""
    with _file_lock(_URL_PIN_LOCK):
        return _audit_sources_impl(quarantine=quarantine, quarantine_new=quarantine_new,
                                   gate_new=gate_new, progress=progress)


def _audit_sources_impl(*, quarantine: bool, quarantine_new: bool, gate_new: bool,
                        progress=None) -> dict:
    manifest = _read_json(_URL_PIN_MANIFEST)
    pins: dict = manifest.get("pins", {}) if isinstance(manifest, dict) else {}
    res: dict = {"new": [], "clean": [], "repinned": [], "quarantined": [],
                 "missing": [], "errors": [], "drift_review": []}
    cur_keys: set[str] = set()
    # Materialize the pinned-source list up front so `progress` can report [i/N] with a real N
    # (buckets fill during the loop, so N must be counted before it — CLI-042). `progress`, when
    # given, fires once per source with (i, n, path, status); a no-op default keeps every existing
    # caller (startup hook, `secure --full`) compiling and behaving unchanged.
    sources = list(_pin_iter_sources())
    n_sources = len(sources)

    def _emit(i: int, key: str, status: str) -> None:
        if progress:
            progress(i, n_sources, key, status)

    for i, s in enumerate(sources, 1):
        path, kind = s["path"], s["kind"]
        key = str(path.resolve())
        cur_keys.add(key)
        try:
            raw = path.read_bytes()
        except OSError as e:
            res["errors"].append({"path": key, "error": str(e)})
            _emit(i, key, "error")
            continue
        norm = _pin_normalize(raw)
        nsha = hashlib.sha256(norm).hexdigest()
        rec = pins.get(key)
        if rec is None:
            # Startup pins first-seen sources by hash WITHOUT gating each (fast); the
            # explicit `skills audit`/`integrate` does the per-source nemesis gate.
            if gate_new and GATE_MODE != "off":
                v = nemesis_gate(str(path))
            else:
                v = {"verdict": "unscanned"}
            verdict = v.get("verdict")
            if quarantine_new and verdict in ("block", "error"):
                q = _quarantine_new(path, v)
                q.update({"kind": kind, "first_seen": True,
                          "blocking_reasons": (v.get("blocking_reasons") or [])[:6]})
                res["quarantined"].append(q)
                _emit(i, key, "quarantined")
                continue   # do NOT pin a dangerous first-seen source as blessed
            newrec = pin_source(path, kind)
            newrec["last_verdict"] = verdict
            newrec["urls"] = _nemesis_urlscan(str(path)).get("urls", [])
            pins[key] = newrec
            res["new"].append({"path": key, "kind": kind, "verdict": verdict,
                               "urls": len(newrec["urls"])})
            _emit(i, key, "new")
            continue
        if nsha == rec.get("norm_sha256"):
            res["clean"].append(key)
            _emit(i, key, "clean")
            continue
        # DRIFT (content changed beyond cosmetic) — re-gate fail-closed.
        v = nemesis_gate(str(path)) if GATE_MODE != "off" else {"verdict": "error"}
        verdict = v.get("verdict", "error")
        bp = _URL_PIN_DIR / rec.get("blessed", "")
        blessed_norm = b""
        if bp.exists():
            try:
                blessed_norm = gzip.decompress(bp.read_bytes())
            except OSError:
                blessed_norm = b""
        diff = _pin_diff(blessed_norm, norm, path.name)
        if verdict in ("block", "error") and quarantine:
            q = _quarantine_and_restore(path, rec, v)
            q.update({"kind": kind, "diff": diff,
                      "blocking_reasons": (v.get("blocking_reasons") or [])[:6]})
            res["quarantined"].append(q)
            _emit(i, key, "quarantined")
            # keep the blessed pin as the source of truth (do NOT re-baseline)
        elif verdict == "allow":
            # CLEAN re-gate → accept the new baseline (re-pin), record the change.
            newrec = pin_source(path, kind)
            newrec["last_verdict"] = verdict
            newrec["urls"] = _nemesis_urlscan(str(path)).get("urls", [])
            pins[key] = newrec
            # ensure a drifted line is never reasonless: synthesize a reason from the diff
            # when a clean re-gate carries no blocking_reasons (CLI-042).
            reason = (v.get("blocking_reasons") or [
                f"content changed ({len([ln for ln in diff if ln[:1] in '+-'])} line(s))"
                if diff else "content changed from pinned baseline"])[0]
            res["repinned"].append({"path": key, "kind": kind, "verdict": verdict,
                                    "diff": diff, "reason": reason})
            _emit(i, key, "drifted")
        else:
            # WARN drift (or any non-allow that wasn't quarantined): do NOT auto-trust
            # changed content that trips a warn — keep the blessed baseline so the drift
            # keeps surfacing until the operator reviews it (never silently re-pin).
            res["drift_review"].append({"path": key, "kind": kind, "verdict": verdict,
                                        "diff": diff,
                                        "blocking_reasons": (v.get("blocking_reasons") or [])[:6]})
            _emit(i, key, "drifted")
    for key, rec in list(pins.items()):
        if key not in cur_keys and not Path(key).exists():
            res["missing"].append(key)
    _write_json_atomic(_URL_PIN_MANIFEST, {
        "schema": "prometheus.url_pins/1", "updated_at": _now_iso(), "pins": pins})
    return res


def _quarantine_list() -> list[dict]:
    out: list[dict] = []
    if not _URL_QUARANTINE_DIR.is_dir():
        return out
    for d in sorted(_URL_QUARANTINE_DIR.iterdir()):
        man = _read_json(d / "manifest.json")
        if man:
            man["_dir"] = str(d)
            out.append(man)
    return out


def _bounded_gunzip(gz: bytes, cap: int) -> "Optional[bytes]":
    """Decompress a gzip blob, ABORTING past `cap` bytes (gzip-bomb guard — the header
    carries no decompressed size, so we bound the streamed read ourselves). None on failure."""
    import io
    out = bytearray()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(gz)) as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                out += chunk
                if len(out) > cap:
                    return None
    except OSError:
        return None
    return bytes(out)


def _restore_quarantined(qdir: str) -> dict:
    """Re-instate a quarantined file — HARDENED (CLI-043). Verify the manifest HMAC
    (constant-time; missing key = REFUSE, fail-closed — NOT the legacy best-effort), decompress
    the stored blob to a 0600 temp beside the manifest's original_path (bounded, bomb-guarded),
    RE-GATE that temp with nemesis, and atomically release it ONLY on a fresh 'allow' verdict. The
    write target is the SIGNED manifest's original_path, NEVER a path from argv (restore is an
    arbitrary-file-write primitive). Returns a structured result for the human + --json paths."""
    d = Path(qdir)
    man = _read_json(d / "manifest.json")
    if not man:
        return {"ok": False, "error": f"no quarantine manifest at {qdir}", "hmac_ok": False}
    # HMAC verify BEFORE trusting any field — a valid sig means prometheus wrote it.
    expected = _sign_pin(man)
    got = str(man.get("sig", ""))
    if not expected:
        return {"ok": False, "hmac_ok": False,
                "error": "no pin key — cannot verify the manifest signature (fail-closed refuse)"}
    if not got or not hmac.compare_digest(expected, got):
        return {"ok": False, "hmac_ok": False,
                "error": "quarantine manifest signature INVALID — refusing restore (tamper-evident)"}
    stored = Path(man.get("stored", ""))
    orig = Path(man.get("original_path", ""))     # from the SIGNED manifest, not argv
    if not str(orig):
        return {"ok": False, "hmac_ok": True, "error": "manifest carries no original_path"}
    if not stored.exists():
        return {"ok": False, "hmac_ok": True, "error": f"stored copy missing: {stored}"}
    try:
        gz = stored.read_bytes()
    except OSError as e:
        return {"ok": False, "hmac_ok": True, "error": f"cannot read stored blob: {e}"}
    data = _bounded_gunzip(gz, max(4 * 1024 * 1024, len(gz) * 200))
    if data is None:
        return {"ok": False, "hmac_ok": True,
                "error": "stored blob failed to decompress / exceeded the size cap (bomb guard)"}
    if DRY_RUN:
        return {"ok": True, "hmac_ok": True, "original": str(orig), "verdict": "dry-run",
                "reasons": [], "dry_run": True}
    try:
        orig.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return {"ok": False, "hmac_ok": True, "error": f"cannot prepare target dir: {e}"}
    # 0600 temp in the SAME dir as original (same FS → atomic os.replace); fsync so nemesis
    # reads the full bytes; re-gate the TEMP path, never original_path.
    fd, tmp = tempfile.mkstemp(prefix=".restore-", dir=str(orig.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        v = nemesis_gate(tmp)
        verdict = v.get("verdict", "error")
        if verdict != "allow":
            reasons = [r for r in ((v.get("blocking_reasons") or []) + [v.get("error")]) if r][:4]
            return {"ok": False, "hmac_ok": True, "original": str(orig), "verdict": verdict,
                    "reasons": reasons,
                    "error": f"fresh re-gate verdict '{verdict}' — NOT released"}
        os.replace(tmp, orig)                     # atomic release ONLY on green
        tmp = None
        dis = man.get("disabled_path")
        if dis and dis != str(orig) and Path(dis).exists():
            try:
                Path(dis).unlink()
            except OSError:
                pass
        return {"ok": True, "hmac_ok": True, "original": str(orig), "verdict": "allow", "reasons": []}
    except OSError as e:
        return {"ok": False, "hmac_ok": True, "original": str(orig), "error": f"restore failed: {e}"}
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _maybe_startup_pin_audit(osi: "OSInfo", command: str) -> None:
    """EVERY-STARTUP re-scan of installed sources (url_injection_safeguard.md §5.2),
    throttled + non-interactive: quarantines any source whose content drifted into a
    BLOCK verdict (fail-closed, reversible) and prints a loud one-line notice. Skips
    in JSON / dry-run / gate-off, and for the audit command itself to avoid recursion."""
    if (JSON_OUT or DRY_RUN or GATE_MODE == "off"
            or command in ("skills", "quarantine", "schedule", "doctor", "describe",
                           "tutorial", "methods", "chat")):
        return
    try:
        if _URL_PIN_STARTED.exists():
            age = time.time() - _URL_PIN_STARTED.stat().st_mtime
            if age < _URL_PIN_THROTTLE:
                return
    except OSError:
        pass
    # Non-blocking startup lock: if another just-launched prometheus is already
    # running the startup audit, this one bows out instead of double-auditing and
    # spawning a second detached integrate.
    sfh = None
    if fcntl is not None:
        try:
            _URL_PIN_DIR.mkdir(parents=True, exist_ok=True)
            sfh = open(_URL_PIN_DIR / ".startup.lock", "w")
            fcntl.flock(sfh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            if sfh is not None:
                sfh.close()
            return  # another startup audit is in-flight
    res: dict = {}
    try:
        # Claim the throttle slot BEFORE the slow audit so a racing startup (or the
        # next launch) sees a fresh marker and throttles out.
        PROM_DIR.mkdir(parents=True, exist_ok=True)
        _URL_PIN_STARTED.write_text(_now_iso())
        # startup is fast: pin first-seen by hash (no per-source gate), gate only on drift
        res = audit_sources(quarantine=True, gate_new=False)
        # auto-integrate nemesis-green skills in the BACKGROUND (detached, silent) so the
        # foreground command stays instant — gating skills can take seconds each.
        if GATE_MODE != "off":
            try:
                subprocess.Popen(
                    [sys.executable, os.path.abspath(__file__), "skills", "integrate"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL, start_new_session=True)
            except OSError:
                pass  # background integration is best-effort
    except Exception:  # noqa: BLE001 — a startup convenience must never break a command
        return
    finally:
        if sfh is not None:
            try:
                fcntl.flock(sfh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            sfh.close()
    quarantined = res.get("quarantined", []) or []
    q, rp = len(quarantined), len(res.get("repinned", []))
    if q:
        # Say what actually happened per source rather than asserting the happy path. The message
        # claimed "(blessed copy restored)" unconditionally, so a restore that could not run —
        # a pruned blessed blob, a read-only file — was reported as a completed quarantine while
        # the dangerous bytes were still live. `neutralized` is true when the content is no longer
        # where the agent loads it, by restore OR by rename.
        live = [r for r in quarantined if isinstance(r, dict) and not r.get("neutralized")]
        Log.err(f"⚠ URL-injection watch: {q} installed source(s) drifted into a "
                f"DANGEROUS verdict and were QUARANTINED. "
                f"Review: prometheus skills audit --list-quarantine")
        if live:
            Log.err(f"  ‼ {len(live)} could NOT be neutralized and are STILL IN PLACE: "
                    + ", ".join(str(r.get("original", "?")) for r in live[:3]))
    elif rp:
        Log.warn(f"URL-injection watch: {rp} installed source(s) changed and were "
                 f"re-gated + re-pinned. Review: prometheus skills audit")


def _quar_hmac_ok(man: dict) -> bool:
    # _quarantine_list injects a "_dir" key that was NOT part of the signed payload — strip every
    # underscore-prefixed key before recomputing, else a valid manifest reads as tampered.
    clean = {k: v for k, v in man.items() if not k.startswith("_")}
    exp = _sign_pin(clean)
    return bool(exp) and hmac.compare_digest(exp, str(clean.get("sig", "")))


def cmd_quarantine(args, osi: "OSInfo") -> int:
    """Manage the URL-injection quarantine vault (CLI-043):
      quarantine list                 list vaulted items (newest first) with reason + verdict
      quarantine restore <vault-dir>  HMAC-verify + fresh nemesis re-gate → release only if green
      quarantine purge <dir> | --all  permanently delete vault entries behind a typed PURGE confirm
    --json emits ONLY via emit_json. `skills audit --list-quarantine/--restore` remain thin aliases."""
    action = getattr(args, "quar_action", None) or "list"
    if action == "list":
        entries = sorted(_quarantine_list(), key=lambda m: str(m.get("quarantined_at", "")),
                         reverse=True)
        if JSON_OUT:
            # `ok` is not optional: every consumer decides success with it, and this was the
            # one envelope in the command surface that omitted it.
            return emit_json({"command": "quarantine", "action": "list", "ok": True, "entries": [{
                "dir": e.get("_dir"), "original_path": e.get("original_path"),
                "verdict": e.get("verdict"), "reasons": (e.get("blocking_reasons") or [])[:4],
                "quarantined_at": e.get("quarantined_at"), "hmac_ok": _quar_hmac_ok(e),
            } for e in entries]})
        if not entries:
            Log.info("quarantine vault is empty")
            return 0
        Log.head(f"URL-injection quarantine vault ({_URL_QUARANTINE_DIR})")
        for e in entries:
            tamper = "" if _quar_hmac_ok(e) else "  [!! manifest UNVERIFIED]"
            Log.warn(f"  {e.get('quarantined_at')}  {e.get('original_path')}  "
                     f"[{e.get('verdict')}]{tamper}")
            for rs in (e.get("blocking_reasons") or [])[:3]:
                Log.step(f"    reason: {rs}")
            Log.step(f"    vault: {e.get('_dir')}   "
                     f"(restore: prometheus quarantine restore {e.get('_dir')})")
        return 0
    if action == "restore":
        target = getattr(args, "target", None)
        if not target:
            Log.err("usage: prometheus quarantine restore <vault-dir>")
            return 1
        r = _restore_quarantined(target)
        if JSON_OUT:
            return emit_json({"command": "quarantine", "action": "restore", "ok": r["ok"],
                              "result": r, "_exit": 0 if r["ok"] else 1})
        if r["ok"]:
            Log.ok(f"restored (re-gated allow) → {r.get('original')}")
            return 0
        Log.err(r.get("error", "restore refused"))
        for rs in r.get("reasons", []):
            Log.step(f"  reason: {rs}")
        if r.get("verdict") and r["verdict"] not in ("allow", "dry-run"):
            Log.step("  fix the content or leave it vaulted — restore only releases a green re-gate")
        return 1
    if action == "purge":
        return _cmd_quarantine_purge(args)
    Log.err(f"unknown quarantine action '{action}' — try list / restore / purge")
    return 1


def _cmd_quarantine_purge(args) -> int:
    all_ = getattr(args, "all", False)
    target = getattr(args, "target", None)
    if not all_ and not target:
        Log.err("usage: prometheus quarantine purge <vault-dir> | --all")
        return 1
    # Resolve every target under the vault root and REFUSE any path that escapes it — purge
    # rmtrees dirs, so `purge ../../x` must never reach outside _URL_QUARANTINE_DIR.
    vault_root = os.path.realpath(str(_URL_QUARANTINE_DIR))
    raw = [e["_dir"] for e in _quarantine_list() if e.get("_dir")] if all_ else [target]
    safe: list[str] = []
    for t in raw:
        rp = os.path.realpath(str(t))
        if rp != vault_root and rp.startswith(vault_root + os.sep):
            safe.append(rp)
        else:
            Log.err(f"refusing to purge a path outside the quarantine vault: {t}")
            return 1
    if not safe:
        if JSON_OUT:
            return emit_json({"command": "quarantine", "action": "purge", "ok": True,
                              "purged": [], "_exit": 0})
        Log.info("nothing to purge — vault is empty")
        return 0
    # Typed confirm: type PURGE exactly. --yes NEVER satisfies --all; non-TTY without the
    # typed token aborts (delete nothing). Only a single non-all purge may use --yes non-TTY.
    confirmed = False
    if sys.stdin.isatty() and sys.stdout.isatty() and not JSON_OUT:
        Log.warn(f"about to PERMANENTLY delete {len(safe)} vault entr(y/ies):")
        for s in safe:
            print(f"    {s}")
        confirmed = input("  type PURGE to confirm (anything else aborts): ").strip() == "PURGE"
    elif not all_ and getattr(args, "yes", False):
        confirmed = True
    if not confirmed:
        msg = "purge aborted — typed PURGE confirmation required (nothing deleted)"
        if JSON_OUT:
            return emit_json({"command": "quarantine", "action": "purge", "ok": False,
                              "error": msg, "purged": [], "_exit": 1})
        Log.err(msg)
        return 1
    if DRY_RUN:
        if JSON_OUT:
            return emit_json({"command": "quarantine", "action": "purge", "ok": True,
                              "dry_run": True, "purged": safe, "_exit": 0})
        Log.step(f"[dry-run] would purge {len(safe)} vault entr(y/ies)")
        return 0
    purged: list[str] = []
    for s in safe:
        try:
            shutil.rmtree(s)
            purged.append(s)
        except OSError as e:
            Log.err(f"purge failed for {s}: {e}")
    if JSON_OUT:
        return emit_json({"command": "quarantine", "action": "purge", "ok": True,
                          "purged": purged, "_exit": 0})
    Log.ok(f"purged {len(purged)} vault entr(y/ies) permanently")
    return 0


def cmd_skills_audit(args, osi: "OSInfo") -> int:
    """Re-scan + disinfect installed external sources (L5 TOCTOU lock): re-pin every
    SKILL.md / AGENTS.md / MCP config, quarantine drift that re-gates dangerous, and
    surface it with evidence. --restore re-instates a quarantined file; never silent."""
    if getattr(args, "list_quarantine", False):
        entries = _quarantine_list()
        if JSON_OUT:
            return emit_json({"command": "skills-audit", "ok": True,
                              "action": "list-quarantine", "quarantine": entries})
        if not entries:
            Log.info("URL-injection quarantine vault is empty")
            return 0
        Log.head(f"URL-injection quarantine vault ({_URL_QUARANTINE_DIR})")
        for e in entries:
            Log.warn(f"  {e.get('quarantined_at')}  {e.get('original_path')}  "
                     f"[{e.get('verdict')}]  → {e['_dir']}")
            Log.step(f"    restore: prometheus skills audit --restore {e['_dir']}")
        return 0
    if getattr(args, "restore", None):
        # thin alias of `quarantine restore` (same hardened HMAC-verify + re-gate path).
        r = _restore_quarantined(args.restore)
        ok = r["ok"]
        if JSON_OUT:
            return emit_json({"command": "skills-audit", "ok": ok, "action": "restore",
                              "target": args.restore, "result": r, "_exit": 0 if ok else 1})
        if ok:
            Log.ok(f"restored (re-gated allow) → {r.get('original')}")
        else:
            Log.err(r.get("error", "restore refused"))
            for rs in r.get("reasons", []):
                Log.step(f"  reason: {rs}")
        return 0 if ok else 1

    if getattr(args, "list_trusted_urls", False):
        urls = trusted_urls_list()
        if JSON_OUT:
            return emit_json({"command": "skills-audit", "ok": True,
                              "action": "list-trusted-urls", "trusted_urls": urls})
        if not urls:
            Log.info("trusted-URL cross-reference vault is empty")
            return 0
        Log.head(f"Trusted-URL cross-reference vault ({_TRUSTED_URLS_FILE})")
        for u in urls:
            Log.step(f"  {u['url']}  [{u.get('host')}]  ← {len(u.get('sources', []))} source(s)")
        return 0

    if getattr(args, "defang_urls", False):
        mode = getattr(args, "defang_mode", "star") or "star"
        scope = getattr(args, "defang_scope", "urls") or "urls"
        keep = getattr(args, "defang_keep", None)
        # interactive 3-way choice when the policy was not given on the CLI.
        # DEFAULT POLICY = "trusted" (keep official-doc URLs live, wipe everything
        # else) — they are re-verified offline every startup (cheap, no LLM).
        if keep is None:
            if JSON_OUT or not (sys.stdin.isatty() and sys.stdout.isatty()):
                keep = "trusted"
            else:
                Log.head("Sterilize URLs in installed sources")
                print("  Official AI-vendor doc/API URLs (Anthropic, OpenAI, Google, Cursor, …)\n"
                      "  are re-verified OFFLINE every startup — leaving them is cheap + safe.\n")
                print("    [t] trusted   — wipe all EXCEPT official-doc URLs (keep them live)  [DEFAULT]")
                print("    [v] vault     — wipe ALL, but save official-doc URLs to a cross-ref store")
                print("    [a] all       — wipe EVERY URL (max inert)")
                print("    [c] cancel")
                ans = input("  choose [T/v/a/c] (Enter = trusted): ").strip().lower()[:1]
                if ans == "c":
                    Log.warn("cancelled — nothing changed")
                    return 0
                keep = {"a": "none", "t": "trusted", "v": "vault", "": "trusted"}.get(ans, "trusted")
        d = defang_installed_sources(mode=mode, scope=scope, keep=keep)
        if JSON_OUT:
            return emit_json({"command": "skills-audit", "ok": True,
                              "action": "defang", "result": d})
        Log.head(f"URL defang — installed sources (policy: keep={d['keep']})")
        Log.step(f"mode={d['mode']} scope={d['scope']}  ·  {d['sources_defanged']} source(s), "
                 f"{d['urls_neutralized']} URL(s) wiped, {d['urls_kept_trusted']} trusted KEPT, "
                 f"{d['urls_vaulted']} vaulted (originals in *.nemesis.bak)")
        for r in d["report"]:
            if r.get("error"):
                Log.warn(f"  ! {r['path']}: {r['error']}")
            elif r.get("urls_neutralized"):
                Log.ok(f"  ✓ {r['path']}  ({r['urls_neutralized']} wiped"
                       + (f", {r['kept_trusted']} kept" if r.get('kept_trusted') else "") + ")")
            elif r.get("kept_trusted"):
                Log.info(f"  · {r['path']}  ({r['kept_trusted']} trusted URL(s) kept, none wiped)")
        if d["urls_neutralized"] or d["urls_kept_trusted"]:
            Log.ok("done — wiped URLs are inert; kept/vaulted official docs re-verified each startup")
        else:
            Log.info("no URLs found in installed sources")
        return 0

    quarantine = not getattr(args, "no_quarantine", False)
    if GATE_MODE == "off":
        Log.warn("nemesis gate is OFF — drift will be detected but not re-gated/quarantined")

    # --json envelope (documented): {command, ok, summary:{new,clean,drifted,quarantined,
    # missing,errors}, skills:[{path,status:new|clean|drifted|quarantined|missing|error,
    # verdict,reasons:[...],files:[...]}], _exit}. Progress prints go to STDERR and are FULLY
    # suppressed in JSON mode (only emit_json may touch stdout — the :7041 LIVE-parser constraint).
    def _progress(i, n, path, status):
        if not JSON_OUT:
            sys.stderr.write(f"  [{i}/{n}] scanning {path} … {status}\n")
            sys.stderr.flush()

    res = audit_sources(quarantine=quarantine, quarantine_new=quarantine, progress=_progress)

    skills: list[dict] = []
    for x in res["new"]:
        skills.append({"path": x["path"], "status": "new", "verdict": x.get("verdict"),
                       "reasons": [], "files": []})
    for k in res["clean"]:
        skills.append({"path": k, "status": "clean", "verdict": "allow", "reasons": [], "files": []})
    for r in res["repinned"]:
        skills.append({"path": r["path"], "status": "drifted", "verdict": r.get("verdict"),
                       "reasons": [r["reason"]] if r.get("reason") else [],
                       "files": (r.get("diff") or [])[:8]})
    for r in res["drift_review"]:
        skills.append({"path": r["path"], "status": "drifted", "verdict": r.get("verdict"),
                       "reasons": (r.get("blocking_reasons") or [])[:4],
                       "files": (r.get("diff") or [])[:8]})
    for q in res["quarantined"]:
        skills.append({"path": q.get("original", q.get("original_path", "")),
                       "status": "quarantined", "verdict": q.get("verdict"),
                       "reasons": (q.get("blocking_reasons") or [])[:4],
                       "files": (q.get("diff") or [])[:8]})
    for m in res["missing"]:
        skills.append({"path": m, "status": "missing", "verdict": None, "reasons": [], "files": []})
    for e in res["errors"]:
        skills.append({"path": e["path"], "status": "error", "verdict": None,
                       "reasons": [e.get("error", "")], "files": []})

    drifted_n = len(res["repinned"]) + len(res["drift_review"])
    summary = {"new": len(res["new"]), "clean": len(res["clean"]), "drifted": drifted_n,
               "quarantined": len(res["quarantined"]), "missing": len(res["missing"]),
               "errors": len(res["errors"])}
    # drift = ANY content change from the pinned baseline (re-pinned / warn-review / quarantined)
    # OR a read error → exit 1 so scripts detect tamper. The stricter exit lives in the CLI layer
    # ONLY; audit_sources (used by the startup hook + `secure --full`) keeps its own behavior.
    exit_code = 1 if (res["repinned"] or res["quarantined"] or res["errors"]
                      or res["drift_review"]) else 0
    ok = exit_code == 0

    if JSON_OUT:
        # The envelope contract is that an `ok:false` carries an `error` saying WHY. This one
        # emitted none, so every consumer that branches on `.ok` saw a failure with nothing to
        # report — and here `ok:false` does not even mean "the command failed", it means "drift
        # was detected", which is the scan working exactly as intended. Say that.
        detail = ", ".join(
            f"{n} {label}"
            for label, n in (
                ("re-pinned", len(res["repinned"])),
                ("awaiting review", len(res["drift_review"])),
                ("quarantined", len(res["quarantined"])),
                ("unreadable", len(res["errors"])),
            )
            if n
        )
        env = {"command": "skills-audit", "ok": ok, "summary": summary,
               "skills": skills, "_exit": exit_code}
        if not ok:
            env["error"] = (
                f"content drift detected in installed sources: {detail}. "
                "Run `prometheus skills audit` for the per-source detail."
            )
        return emit_json(env)

    Log.head("URL-injection source audit (L5 content-pinning)")
    total = sum(summary.values())
    Log.step(f"pinned {total}  ·  new {summary['new']}  clean {summary['clean']}  "
             f"drifted {summary['drifted']}  quarantined {summary['quarantined']}  "
             f"missing {summary['missing']}  errors {summary['errors']}")
    for x in res["new"]:
        Log.info(f"  pinned (first-seen): {x['path']}  [{x['verdict']}, {x['urls']} url(s)]")
    for r in res["repinned"]:
        Log.warn(f"  changed + re-pinned: {r['path']}  [{r['verdict']}]  — {r.get('reason', '')}")
        for ln in (r.get("diff") or [])[:8]:
            print(f"      {ln}")
    for r in res["drift_review"]:
        Log.warn(f"  drift (needs review): {r['path']}  [{r['verdict']}]"
                 + (f"  — {r['blocking_reasons'][0]}" if r.get("blocking_reasons") else ""))
        for ln in (r.get("diff") or [])[:8]:
            print(f"      {ln}")
    for q in res["quarantined"]:
        Log.err(f"  ☠ DRIFT → QUARANTINED: {q.get('original', q.get('original_path', ''))}  "
                f"[{q.get('verdict')}]")
        Log.step(f"    blessed copy restored: {q.get('restored_blessed')}  ·  vault: {q.get('vault')}")
        for reason in q.get("blocking_reasons", [])[:4]:
            Log.step(f"    reason: {reason}")
        for ln in (q.get("diff") or [])[:8]:
            print(f"      {ln}")
    for m in res["missing"]:
        Log.step(f"  pinned source no longer present: {m}")
    if exit_code == 1:
        if res["quarantined"]:
            Log.warn("dangerous drift was quarantined (reversible) — restore with "
                     "`prometheus skills audit --restore <vault>` after you trust it again")
        else:
            Log.warn("content drift detected against the pinned baseline — review the changes above")
        return 1
    Log.ok("all installed sources match their pinned baseline (or were re-gated clean)")
    return 0


# CLI-078: the startup auto-integrate runs fully detached with stdout→DEVNULL, so its result was
# invisible. Every real integrate run now persists its result here (atomically) so `skills integrate
# --status` can surface what the silent run did. The path is derived from PROMETHEUS_SKILLS_DIR so
# the detached start_new_session child and a foreground --status resolve the SAME file.
_INTEGRATE_STATUS_FILE = PROMETHEUS_SKILLS_DIR / ".last-integrate.json"


def _write_integrate_status(res: dict) -> None:
    """Persist the last integrate result atomically (temp-in-same-dir + fsync + os.replace, so a
    half-written file is never presented). Best-effort: a status-cache failure never fails the
    integration itself."""
    try:
        PROMETHEUS_SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                   "integrated": res.get("integrated", []),
                   "already": res.get("already", []),
                   "skipped_unsafe": res.get("skipped_unsafe", []),
                   "errors": res.get("errors", [])}
        fd, tmp = tempfile.mkstemp(dir=str(PROMETHEUS_SKILLS_DIR),
                                   prefix=".last-integrate-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, str(_INTEGRATE_STATUS_FILE))  # atomic within the same filesystem
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError:
        pass


def _read_integrate_status() -> Optional[dict]:
    """Read the last-integrate status cache, or None when it has never run OR the file is
    corrupt/partial (a concurrent half-written read). Never raises (a truncated/empty file raises
    JSONDecodeError → the 'no status' case, NOT a crash)."""
    try:
        with open(_INTEGRATE_STATUS_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, OSError):
        return None


def _render_integrate_result(res: dict) -> None:
    """Shared per-item rendering for a LIVE integrate run AND `--status` read-back (CLI-078) — one
    source of truth so a recorded status renders byte-identically to the run that produced it."""
    Log.step(f"integrated {len(res.get('integrated', []))} · already {len(res.get('already', []))} · "
             f"skipped-unsafe {len(res.get('skipped_unsafe', []))} · errors {len(res.get('errors', []))}")
    for i in res.get("integrated", []):
        Log.ok(f"  ✓ {i['name']}  (from {i['host']}, nemesis {i['verdict']})")
    for u in res.get("skipped_unsafe", []):
        Log.warn(f"  ✗ {u['name']} (from {u['host']}) — NOT integrated: nemesis {u['verdict']}"
                 + (f"  [{u['reasons'][0]}]" if u.get("reasons") else ""))
    for e in res.get("errors", []):
        Log.err(f"  ! {e['name']}: {e['error']}")


def _cmd_skills_integrate_status(args) -> int:
    """`skills integrate --status` (CLI-078): render the LAST run's result from the status cache,
    using the same helper a live run uses. A missing/corrupt cache is a clear 'never run yet',
    never a crash or a false-success."""
    data = _read_integrate_status()
    if data is None:
        if JSON_OUT:
            return emit_json({"command": "skills-integrate-status", "ok": True, "status": "never-run",
                              "central": str(PROMETHEUS_SKILLS_DIR), "_exit": 0})
        Log.info("no integration has run yet (no status recorded)")
        return 0
    if JSON_OUT:
        ok = not data.get("errors")
        return emit_json({"command": "skills-integrate-status", "ok": ok, "at": data.get("at"),
                          "central": str(PROMETHEUS_SKILLS_DIR), "result": data,
                          "_exit": 0 if ok else 1})
    Log.head(f"Last skills integrate  ·  {data.get('at', '?')}  →  {PROMETHEUS_SKILLS_DIR}")
    _render_integrate_result(data)
    return 0 if not data.get("errors") else 1


def cmd_skills_integrate(args, osi: "OSInfo") -> int:
    """Auto-integrate nemesis-GREEN skills from every detected agent into the central
    prometheus_skills folder (url_injection_safeguard.md / user request). Only skills
    that gate 'allow' are copied; the central folder is then re-checked every startup."""
    if getattr(args, "status", False):
        return _cmd_skills_integrate_status(args)
    res = integrate_green_skills(dry_run=getattr(args, "dry_run", False))
    # CLI-078: persist EVERY real run (foreground or the silent detached startup one) so --status can
    # surface it. A dry-run is a preview → keep the last REAL run's status instead of overwriting it.
    if not getattr(args, "dry_run", False):
        _write_integrate_status(res)
    if JSON_OUT:
        ok = not res["errors"]
        return emit_json({"command": "skills-integrate", "ok": ok,
                          "central": str(PROMETHEUS_SKILLS_DIR), "result": res,
                          "_exit": 0 if ok else 1})
    Log.head(f"Integrate nemesis-green skills → {PROMETHEUS_SKILLS_DIR}")
    _render_integrate_result(res)
    if res["integrated"]:
        Log.ok("green skills integrated — re-checked by nemesis at every startup")
    elif not res["already"]:
        Log.info("no integratable skills found")
    return 0 if not res["errors"] else 1


def cmd_skills(args, osi: OSInfo) -> int:
    """Direct control of installed SKILL.md folders under ~/.claude/skills/."""
    action = args.action
    if action == "audit":
        return cmd_skills_audit(args, osi)
    if action == "integrate":
        return cmd_skills_integrate(args, osi)
    if action == "list":
        skills = list_installed_skills()
        if JSON_OUT:
            return emit_json({"command": "skills", "ok": True, "action": "list",
                "skills_dir": str(CLAUDE_SKILLS_DIR),
                "skills": [{"name": s, "state": skill_state(s)} for s in skills]})
        if not skills:
            Log.info(f"no skills installed under {CLAUDE_SKILLS_DIR}")
            return 0
        Log.head(f"Installed skills  ({CLAUDE_SKILLS_DIR})")
        for s in skills:
            st = skill_state(s)
            col = {"enabled": "green", "muted": "cyan", "disabled": "yellow"}.get(st, "magenta")
            print(f"  {s:<36} {Log._c(st, col)}")
        return 0
    if not args.skill:
        # Under --json this printed a bare `FAIL …` line and NO envelope, so the CLI reported
        # "prometheus.py produced no JSON on stdout (crashed before emitting)" — the user was
        # shown an internal diagnostic about a crash that never happened, instead of "you left
        # out the skill name". Every --json path must emit exactly one JSON object.
        if JSON_OUT:
            return emit_json({"command": "skills", "ok": False, "action": action,
                "error": f"`skills {action}` needs a skill name", "hint": "skills list",
                "_exit": 1})
        Log.err(f"`skills {action}` needs a skill name (see `skills list`)")
        return 1
    fn = {"enable": enable_skill, "disable": disable_skill,
          "mute": mute_skill, "unmute": unmute_skill}[action]
    ok = fn(args.skill)
    if JSON_OUT:
        return emit_json({"command": "skills", "ok": bool(ok), "action": action,
            "skill": args.skill, "state": skill_state(args.skill),
            "_exit": 0 if ok else 1})
    if ok:
        Log.ok(f"skill '{args.skill}' -> {skill_state(args.skill)}")
        if action in ("disable", "enable", "mute", "unmute"):
            Log.step("hot-watched — takes effect within the running session")
    return 0 if ok else 1


def cmd_inventory(args, osi: OSInfo) -> int:
    """Re-scan every detected agent for ALL installed plugins/skills/MCP/extensions
    (registry-managed AND foreign), with state. Live — re-run to refresh."""
    detected = _filter_hosts(detect_hosts(), getattr(args, "host", None))
    if not detected:
        if JSON_OUT:
            return emit_json(
                {"command": "inventory", "ok": False, "error": "no target AI agents detected", "lines": []}
            )
        Log.err("no target AI agents detected")
        return 2

    # human-table READ; under --json emit a bridge-safe envelope (was raw text → bad_json).
    def _render() -> None:
        reg_ids = registry_plugin_ids()
        reg_names = registry_repo_names()
        totals = {"plugins": 0, "skills": 0, "mcp": 0, "extensions": 0}
        for host in detected:
            Log.head(f"Inventory: {host.label} ({host.name})")
            inv = inventory_host(host)
            if not any(inv.get(k) for k in ("plugins", "skills", "mcp", "extensions",
                                            "marketplaces", "rules", "commands")):
                Log.step("nothing found (or no known plugin/skill store for this agent)")
                continue
            if inv["marketplaces"]:
                print(f"  marketplaces: {', '.join(inv['marketplaces'])}")
            if inv["plugins"]:
                print("  plugins:")
                for pl in inv["plugins"]:
                    tag = "registry" if pl["id"] in reg_ids else "foreign"
                    tcol = "cyan" if tag == "registry" else "yellow"
                    st = "enabled" if pl["enabled"] else "disabled"
                    scol = "green" if pl["enabled"] else "yellow"
                    print(f"    - {pl['id']:<42} {Log._c(st, scol):<8} {Log._c('[' + tag + ']', tcol)}")
                totals["plugins"] += len(inv["plugins"])
            if inv["extensions"]:
                print("  extensions: " + ", ".join(inv["extensions"]))
                totals["extensions"] += len(inv["extensions"])
            if inv["skills"]:
                print("  skills:")
                for sk in inv["skills"]:
                    tag = "registry" if sk["name"].lower() in reg_names else "foreign"
                    col = {"enabled": "green", "muted": "cyan", "disabled": "yellow"}.get(sk["state"], "magenta")
                    print(f"    - {sk['name']:<42} {Log._c(sk['state'], col):<8} [{tag}]")
                totals["skills"] += len(inv["skills"])
            if inv["mcp"]:
                print("  MCP servers:")
                for m in inv["mcp"]:
                    print(f"    - {m['name']:<42} ({m['config']})")
                totals["mcp"] += len(inv["mcp"])
            for key, label in (("rules", "rules (Cursor .mdc)"), ("commands", "commands")):
                if inv.get(key):
                    print(f"  {label}:")
                    for r in inv[key]:
                        col = {"enabled": "green", "muted": "cyan", "disabled": "yellow"}.get(r["state"], "magenta")
                        print(f"    - {r['name']:<42} {Log._c(r['state'], col)}")
        Log.info(f"totals across agents: {totals['plugins']} plugins, {totals['skills']} skills, "
                 f"{totals['mcp']} MCP, {totals['extensions']} extensions")
        Log.step("manage: `disable <id>` / `enable <id>` / `uninstall <id>` (plugins by id), "
                 "`skills disable <name>` (skills)")

    return emit_table_json("inventory", _render, action="scan")


def cmd_sync(args, osi: OSInfo) -> int:
    """P4.2 — replicate an installed SKILL.md folder into other detected agents'
    skill dirs (cross-CLI portability). Fixes 'the skill is only in Claude'."""
    name = args.skill
    src_dir = CLAUDE_SKILLS_DIR / name
    if not src_dir.exists():
        if JSON_OUT:
            return emit_json({"command": "sync", "ok": False, "skill": name,
                              "error": f"skill '{name}' not found in {CLAUDE_SKILLS_DIR}", "_exit": 2})
        Log.err(f"skill '{name}' not found in {CLAUDE_SKILLS_DIR} — run `skills list` / `scaffold-skill`")
        return 2
    want = _csv(getattr(args, "to", None))
    placed: list[tuple[str, str]] = []
    # Re-vet the SOURCE skill before replicating it: a skill clean at install time could have
    # been tampered with on disk, and sync would otherwise fan that tree into every agent
    # unscanned. Gate once (the source is identical for all targets), fail-closed.
    if not DRY_RUN and not enforce_gate(str(src_dir), f"sync skill '{name}'"):
        if JSON_OUT:
            return emit_json({"command": "sync", "ok": False, "skill": name,
                              "error": "source skill blocked by nemesis gate", "_exit": 2})
        Log.err(f"skill '{name}' blocked by nemesis gate — NOT replicated to other agents")
        return 2
    Log.head(f"Sync skill '{name}' from Claude → other agents")
    for h in detect_hosts():
        if h.name == "claude":
            continue
        if want and "all" not in want and h.name not in want:
            continue
        if not h.skills_dirs:
            Log.step(f"{h.name}: no SKILL.md store (uses {h.mcp_key}/rules) — skipped")
            placed.append((h.name, "no-skill-store"))
            continue
        dest = _expand(h.skills_dirs[0]) / name
        if dest.exists() and not FORCE:
            Log.ok(f"{h.name}: already has '{name}' — skip")
            placed.append((h.name, "already"))
            continue
        if DRY_RUN:
            Log.step(f"[dry-run] copy {src_dir} -> {dest}")
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src_dir, dest, dirs_exist_ok=True)
        Log.ok(f"{h.name}: copied '{name}' -> {dest}")
        placed.append((h.name, "copied"))
    if JSON_OUT:
        return emit_json({"command": "sync", "ok": True, "skill": name, "source": "claude",
                          "dry_run": DRY_RUN,
                          "placed": [{"agent": a, "result": r} for a, r in placed]})
    Log.head(f"Sync map — '{name}' now present in:")
    print(f"  {Log._c('claude', 'bold')}  (source)")
    for agent, res in placed:
        col = "green" if res == "copied" else ("dim" if res == "already" else "yellow")
        print(f"  {Log._c(agent, 'bold')}  ({Log._c(res, col)})")
    if not placed:
        Log.warn("no target agents (none detected with a skills dir)")
    return 0


# ---- 3rd functionality: Local-Model Tools (install runners/kernels/apps) -----
def _print_model_tools() -> None:
    Log.head("Local-Model Tools — run models locally / in the cloud")
    cat_col = {"library": "cyan", "kernel": "blue", "local-app": "magenta"}
    for t in MODEL_TOOLS:
        tag = Log._c(f"[{t.category}]", cat_col.get(t.category, "yellow"))
        flags = []
        if t.prereq == "nvidia":
            flags.append(Log._c("needs NVIDIA GPU", "yellow"))
        if t.guided:
            flags.append(Log._c("guided/confirm-heavy", "yellow"))
        if t.install_kind == "kernel":
            flags.append(Log._c("7 install methods → embeds into a target engine env", "blue"))
        elif t.isolated:
            flags.append(Log._c("isolated on disk → you pick a folder (versioned + rollback)", "cyan"))
        elif t.install_kind == "python-venv":
            flags.append(Log._c("--path DIR → isolated venv + versioning", "dim"))
        print(f"  {tag} {Log._c(t.id, 'bold')} — {t.name}")
        print(f"      {t.blurb}")
        if flags:
            print(f"      {' · '.join(flags)}")
        print(f"      {Log._c('docs ' + t.docs + '  ·  ' + t.repo, 'dim')}")
    Log.step("install: `models install <id> [--path DIR]`   ·   "
             "versions: `models versions <id> --path DIR`   ·   rollback: `models rollback <id> --version N --path DIR`")


def _install_model_tool(t: ModelTool, osi: OSInfo, path: Optional[str] = None, method: Optional[str] = None,
                        target_python: Optional[str] = None, max_jobs: Optional[int] = None,
                        cuda: Optional[str] = None, fa_version: Optional[str] = None) -> int:
    Log.head(f"Install local-model tool: {t.name}  [{t.category}]")
    print(f"  {t.blurb}")
    # FlashAttention: special multi-method, env-targeted installer (method-aware prereq gating)
    if t.install_kind == "kernel":
        return _install_flashattention(t, osi, path, method, target_python, max_jobs, cuda, fa_version)
    if t.prereq == "nvidia" and not _has_nvidia():
        Log.err(f"{t.name} needs an NVIDIA GPU + CUDA — nvidia-smi/nvcc not found on this machine.")
        Log.step("on Apple Silicon / no-NVIDIA: use AirLLM (`models install airllm`) or Ollama / llama.cpp / MLX.")
        return 2
    for w in t.warnings:
        Log.warn(w)
    if t.security:
        Log.step(f"security: {t.security}")
    isolated = t.isolated or bool(path)
    if t.guided:
        if not _confirm(f"Install + RUN {t.name} (clone its repo + start its server)?"):
            Log.warn("declined"); return 0
        if not _confirm("It can read mail/calendar + run shell on your machine. Are you SURE?"):
            Log.warn("declined"); return 0
    elif not isolated and not (ASSUME_YES or DRY_RUN or FORCE):
        if not _confirm(f"Run the install for {t.name}?"):
            Log.warn("declined"); return 0
    # isolated tools: install into a separated, versioned on-disk workspace the user picks
    if isolated:
        base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
        if base is None:
            Log.warn("cancelled — no folder chosen"); return 0
        return _install_into_layout(t, osi, base)
    # guided apps: clone first + scan the payload
    if t.clone_url:
        git = shutil.which("git")
        if not git:
            Log.err("git not found"); return 2
        dest = Path(os.path.expanduser(t.dest or f"~/{t.id}"))
        if dest.exists():
            Log.ok(f"{dest} already present — skip clone")
        elif DRY_RUN:
            Log.step(f"[dry-run] git clone {t.clone_url} -> {dest}")
        else:
            Log.step(f"git clone {t.clone_url} -> {dest}")
            run([git, "clone", "--depth", "1", t.clone_url, str(dest)])
        if dest.exists() and not DRY_RUN:
            if not NO_SCAN:
                Log.step("security scan of the cloned app")
                rep = ScanReport(t.id, t.clone_url, _git_identity(dest), _walk_and_scan(dest), 0)
                if not security_gate(rep, "local"):
                    Log.warn(f"{t.name} aborted by security gate"); return 1
            if not enforce_gate(str(dest), f"{t.id} ({t.clone_url})"):
                Log.warn(f"{t.name} aborted by nemesis gate — blocked tree kept "
                         f"for inspection: nemesis ui {dest}")
                return 1
    steps = t.install_steps.get(osi.family) or t.install_steps.get("all") or []
    if steps and not NO_SCAN:                          # scan the literal install commands too
        text = "\n".join(" ".join(c) for c in steps)
        rep = ScanReport(t.id, "steps", "steps:" + str(abs(hash(text)))[:8], _scan_text("<model_tool>", text), 1)
        if not security_gate(rep, "local"):
            Log.warn(f"{t.name} aborted by security gate"); return 1
    for cmd in steps:
        Log.step(" ".join(cmd))
        run(cmd, check=False)
    Log.ok(f"{t.name} install complete")
    for n in t.post_notes:
        Log.step(n)
    return 0


def _model_isolated_root(t: ModelTool, path: Optional[str]) -> Optional[Path]:
    base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
    if base is None:
        return None
    return _resolve_tool_root(base, t.id)


def _uninstall_model_tool(t: ModelTool, path: Optional[str]) -> int:
    Log.head(f"Uninstall {t.name}")
    if t.install_kind == "kernel":                              # FlashAttention: pip-uninstall from the recorded env
        lay = ToolLayout(t.id, _resolve_tool_root(Path(os.path.expanduser(path)), t.id) if path else (PROM_DIR / "flashattention"))
        man = _read_tool_manifest(lay)
        py = man.get("target")
        if py and Path(py).exists():
            pip = str(Path(py).parent / "pip")
            if _confirm(f"pip-uninstall flash_attn from {py} ?"):
                run([pip, "uninstall", "-y", "flash_attn", "flash-attn"], check=False)
        else:
            Log.warn("no live target env recorded — skipping pip uninstall (kernel may already be gone)")
        if lay.root.exists() and _confirm(f"also delete the FlashAttention cache/workdir {lay.root} ?"):
            _rmtree(lay.root)
        Log.ok("FlashAttention uninstalled")
        return 0
    # isolated tools (airllm library / odysseus docker app): delete the whole tree
    root = _model_isolated_root(t, path)
    if root is None:
        Log.warn("cancelled"); return 0
    if not root.exists():
        Log.warn(f"nothing to remove at {root}"); return 0
    lay = ToolLayout(t.id, root)
    if t.install_kind == "docker" and lay.live.exists() and _docker_bin():
        Log.warn("bringing the docker stack down first (`docker compose down -v` — removes its volumes/data)")
        if _confirm(f"tear down {t.name}'s containers + volumes ?"):
            _run_in(["docker", "compose", "down", "-v"], lay.live)
    Log.warn(f"this DELETES the whole isolated folder: {root}  ({_human_size_dir(root)})")
    if not _confirm(f"Delete {root} (venv/engine snapshots/archives + all versions) ?"):
        Log.warn("declined"); return 0
    _rmtree(root)
    Log.ok(f"{t.name} removed — folder deleted. Nothing left on the system.")
    return 0


def _service_model_tool(t: ModelTool, path: Optional[str], on: bool) -> int:
    if t.install_kind != "docker":
        Log.info(f"{t.name} is a {t.category} ({t.install_kind}) — no running service to "
                 f"{'enable' if on else 'disable'}.")
        if t.install_kind == "python-venv":
            Log.step(f"it lives in its venv; remove it with `models uninstall {t.id}`")
        elif t.install_kind == "kernel":
            Log.step("it's a kernel embedded in a target env; rollback/uninstall control it, not enable/disable")
        return 0
    if not _docker_bin():
        Log.err("docker not found"); return 2
    root = _model_isolated_root(t, path)
    if root is None:
        Log.warn("cancelled"); return 0
    lay = ToolLayout(t.id, root)
    if not lay.live.exists():
        Log.err(f"no install at {lay.live} — run `models install {t.id}` first (or pass --path)"); return 2
    Log.head(f"{'Enable (start)' if on else 'Disable (stop)'} {t.name}")
    rc = _run_in(["docker", "compose", "up", "-d"] if on else ["docker", "compose", "stop"], lay.live)
    Log.ok(f"{t.name} {'started' if on else 'stopped (containers down; data + folder kept)'}") if rc == 0 \
        else Log.err(f"compose {'up' if on else 'stop'} failed (rc={rc})")
    return 0 if rc == 0 else 1


def _status_model_tool(t: ModelTool, path: Optional[str]) -> int:
    Log.head(f"{t.name} — status")
    if t.install_kind == "kernel":
        base = Path(os.path.expanduser(path)) if path else (PROM_DIR / "flashattention")
        return _fa_versions(t, base)
    root = _model_isolated_root(t, path)
    if root is None:
        Log.warn("cancelled"); return 0
    rc = _tool_versions(t, root.parent if root.name == t.id else root)
    if t.install_kind == "docker" and _docker_bin():
        lay = ToolLayout(t.id, root)
        if lay.live.exists():
            _run_in(["docker", "compose", "ps"], lay.live)
    return rc


def _update_model_tool(t: ModelTool, osi: OSInfo, path: Optional[str]) -> int:
    Log.head(f"Update {t.name}")
    if t.install_kind == "kernel":
        Log.info("FlashAttention is env-targeted/multi-method — re-run install to pick up a new version:")
        Log.step(f"`models install flashattention --method wheel --target-python <engine>/bin/python --fa-version <new>`")
        return 0
    if not (t.isolated or t.install_kind == "python-venv"):
        Log.err(f"{t.name} is not an updatable isolated tool"); return 2
    base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
    if base is None:
        Log.warn("cancelled"); return 0
    Log.info("creates a NEW version snapshot (old version preserved → `models rollback` if needed)")
    return _install_into_layout(t, osi, base)            # update == fresh versioned snapshot


def _ollama_models_dir() -> Path:
    return get_models_root() / "ollama"


def _ollama_env() -> dict:
    """os.environ + OLLAMA_MODELS pinned under the user's chosen models_root."""
    env = dict(os.environ)
    env["OLLAMA_MODELS"] = str(_ollama_models_dir())
    return env


def _resolve_ollama_tag(model: str) -> str:
    """Map an OPEN_MODELS id to its ollama tag; else treat the arg as a raw tag."""
    idx = _open_model_index()
    m = idx.get(model)
    return m.ollama if (m and m.ollama) else model


def _models_browse() -> int:
    """List open models that can run locally (ollama tags), for the model picker."""
    if JSON_OUT:
        return emit_json({"command": "models", "ok": True, "action": "browse",
                          "models": [{"id": m.id, "name": m.name, "params": m.params,
                                      "license": m.license, "ollama": m.ollama, "served": m.served,
                                      "note": m.note} for m in OPEN_MODELS]})
    Log.head("Open models — pick one to run locally (ollama)")
    for m in OPEN_MODELS:
        tag = m.ollama or "(served only — no local pull)"
        Log.info(f"{m.id:18s} {m.params:24s} {m.license:14s}  ollama: {tag}")
        if m.note:
            Log.step(m.note)
    Log.step("pull:  prometheus models pull <id|tag>   ·   run:  prometheus models run <id|tag>   ·   folder:  models config --show")
    Log.step("agentic chat with one:  prometheus chat --local <id|tag>")
    return 0


def _models_pull_run(action: str, model: Optional[str]) -> int:
    """`models pull/run <model>` via ollama, with OLLAMA_MODELS under models_root.

    Every error/exit path honours --json (machine channel) so the GUI/MCP bridge
    never receives raw human text. `run` execs into ollama (replaces the process),
    so under --json we return the resolved command instead of handing over a TTY."""
    if not model:
        if JSON_OUT:
            return emit_json({"command": "models", "ok": False, "action": action,
                              "error": f"usage: models {action} <model-id|ollama-tag>", "_exit": 2})
        Log.err(f"usage: models {action} <model-id|ollama-tag>   (see `models browse`)"); return 2
    tag = _resolve_ollama_tag(model)
    mdir = _ollama_models_dir()
    if DRY_RUN:
        if JSON_OUT:
            return emit_json({"command": "models", "ok": True, "action": action, "dry_run": True,
                              "argv": ["ollama", action, tag], "ollama_models": str(mdir)})
        Log.ok(f"[dry-run] OLLAMA_MODELS={mdir} ollama {action} {tag}"); return 0
    if not shutil.which("ollama"):
        if JSON_OUT:
            return emit_json({"command": "models", "ok": False, "action": action,
                              "error": "ollama not found",
                              "hint": "prometheus apps install ollama   (or: brew install ollama)", "_exit": 2})
        Log.err("ollama not found.")
        Log.step("install it first:  prometheus apps install ollama   (or: brew install ollama)")
        return 2
    env = _ollama_env()
    try:
        mdir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        if JSON_OUT:
            return emit_json({"command": "models", "ok": False, "action": action,
                              "error": f"cannot create models folder {mdir}: {e}", "_exit": 2})
        Log.err(f"cannot create models folder {mdir}: {e}"); return 2
    if JSON_OUT:
        # A JSON caller can't be handed an interactive/streaming terminal — return the command to run.
        return emit_json({"command": "models", "ok": True, "action": action,
                          "argv": ["ollama", action, "--", tag], "ollama_models": str(env["OLLAMA_MODELS"]),
                          "interactive": action == "run",
                          "note": "run this in a terminal — JSON mode does not stream/exec"})
    Log.info(f"{action} '{tag}'  (OLLAMA_MODELS={env['OLLAMA_MODELS']})")
    # "--" end-of-options: a tag starting with '-' must be a positional, never an ollama flag.
    if action == "pull":
        try:
            return _run_timed(["ollama", "pull", "--", tag], env=env, timeout=_RUN_TIMEOUT).returncode
        except OSError as e:
            Log.err(f"ollama pull failed: {e}"); return 2
    os.execvpe("ollama", ["ollama", "run", "--", tag], env)   # hand the terminal to ollama
    return 0


def _models_config(args) -> int:
    """Show or set the default local-models install folder (models_root)."""
    new = getattr(args, "set_root", None)
    if new is not None:   # "" must reach validation (empty path) — not be treated as "show"
        try:
            root = set_models_root(new)
        except RuntimeError as e:
            if JSON_OUT:
                return emit_json({"command": "models", "ok": False, "action": "config", "error": str(e), "_exit": 2})
            Log.err(str(e)); return 2
        if JSON_OUT:
            # `exists` is reported HONESTLY: under --dry-run the folder was not created, so
            # claiming True would be the same lie the mutation itself was. `dry_run` tells a
            # machine caller the setting was NOT persisted.
            return emit_json({"command": "models", "ok": True, "action": "config",
                              "models_root": str(root), "exists": root.exists(),
                              **({"dry_run": True} if DRY_RUN else {})})
        if DRY_RUN:
            Log.ok(f"[dry-run] models_root would be set: {root} (nothing written)")
            return 0
        Log.ok(f"models_root set: {root}")
        return 0
    root = get_models_root()
    if JSON_OUT:
        return emit_json({"command": "models", "ok": True, "action": "config", "models_root": str(root), "exists": root.exists()})
    Log.info(f"models_root: {root}  ({'exists' if root.exists() else 'created on first install'})")
    Log.step("change it:  prometheus models config --set-root /path/to/folder")
    return 0


def cmd_models(args, osi: OSInfo) -> int:
    action = getattr(args, "action", None) or "list"
    if action == "config":
        return _models_config(args)
    if action == "browse":
        return _models_browse()
    if action in ("pull", "run"):
        return _models_pull_run(action, getattr(args, "tool", None))
    if action == "list":
        # human-table READ; under --json emit a bridge-safe envelope (raw text → bad_json).
        return emit_table_json("models", _print_model_tools, action="list")
    valid = ("install", "uninstall", "update", "enable", "disable", "status", "versions", "rollback")
    if action not in valid:
        Log.err(f"usage: models [list | {' | '.join(valid)}] <id> [--path DIR] [--version N]"); return 2
    if not getattr(args, "tool", None):
        Log.err(f"usage: models {action} <id>  (see `models list`)"); return 2
    t = model_tool_registry().get(args.tool)
    if not t:
        Log.err(f"unknown tool: {args.tool}. Try: models list"); return 2
    path = getattr(args, "path", None)
    if action == "install":
        return _install_model_tool(t, osi, path,
                                   method=getattr(args, "method", None),
                                   target_python=getattr(args, "target_python", None),
                                   max_jobs=getattr(args, "max_jobs", None),
                                   cuda=getattr(args, "cuda", None),
                                   fa_version=getattr(args, "fa_version", None))
    if action == "uninstall":
        return _uninstall_model_tool(t, path)
    if action == "update":
        return _update_model_tool(t, osi, path)
    if action == "enable":
        return _service_model_tool(t, path, True)
    if action == "disable":
        return _service_model_tool(t, path, False)
    if action == "status":
        return _status_model_tool(t, path)
    # versions / rollback operate on the on-disk workspace
    if t.install_kind == "kernel":                          # FlashAttention: default cache dir if no --path
        base = Path(os.path.expanduser(path)) if path else (PROM_DIR / "flashattention")
        if action == "versions":
            return _fa_versions(t, base)
        return _rollback_tool(t, base, getattr(args, "version", None))   # FA version = release string
    if not t.isolated and t.install_kind != "python-venv":
        Log.err(f"{t.name} is not an isolated/versioned tool"); return 2
    base = Path(os.path.expanduser(path)) if path else _prompt_install_path(t.id)
    if base is None:
        Log.warn("cancelled — no folder chosen"); return 0
    if action == "versions":
        return _tool_versions(t, base)
    ver = getattr(args, "version", None)
    if ver is not None:
        try:
            ver = int(ver)
        except (TypeError, ValueError):
            Log.err(f"--version must be an integer for {t.name} (e.g. 1, 2). Got: {ver!r}"); return 2
    return _rollback_tool(t, base, ver)


# ============================================================================
#  SECTION 7B — P5 SUPER-SCAN CONTROL CENTER
#  One super-scan of the PC: every AI CLI (installed/absent/forgotten), where it
#  keeps its stuff, what's in it — then act globally or per-agent with full
#  clarity on which tools are Claude-only / agent-specific / universal.
# ============================================================================
SESSION_REPORT = PROM_DIR / "last-run.md"
PURGE_DIR = PROM_DIR / "purged"
STALE_DAYS = 120                                    # config untouched longer = "stale"

# --- user preferences (config.json) -----------------------------------------
# A single JSON file of durable user prefs (models install folder, chat
# defaults, ...). Corruption-safe: a broken file NEVER crashes Prometheus.
PROM_CONFIG = PROM_DIR / "config.json"
DEFAULT_MODELS_ROOT = HOME / ".prometheus" / "models"


def load_config() -> dict:
    """Read the prefs file. A missing/garbage file falls back to {} (never raises)."""
    try:
        if PROM_CONFIG.exists():
            data = json.loads(PROM_CONFIG.read_text())
            if isinstance(data, dict):
                return data
    except Exception:  # noqa: BLE001 — a bad config file must never crash the tool
        Log.warn(f"config unreadable ({PROM_CONFIG}); using defaults")
    return {}


def save_config(cfg: dict) -> bool:
    """Atomic write (tmp + os.replace): an interrupted save can't corrupt prefs.

    Returns True on success, False if the write failed — callers that promise
    persistence (e.g. `models config --set-root`) MUST surface a False so they
    never report ok:true for a save that silently didn't happen."""
    tmp = PROM_CONFIG.with_suffix(".json.tmp")
    try:
        PROM_DIR.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(cfg, indent=2, sort_keys=True))
        os.replace(tmp, PROM_CONFIG)
        return True
    except Exception as e:  # noqa: BLE001
        Log.warn(f"could not save config ({PROM_CONFIG}): {e}")
        try:
            tmp.unlink(missing_ok=True)   # don't leave a half-written .tmp orphan behind
        except OSError:
            pass
        return False


def get_models_root() -> Path:
    """Folder where local models/tools install. Override via `models config
    --set-root`; defaults to ~/.prometheus/models."""
    raw = load_config().get("models_root")
    if raw:
        try:
            return Path(os.path.expanduser(os.path.expandvars(str(raw)))).resolve()
        except Exception:  # noqa: BLE001
            Log.warn("configured models_root invalid; using default")
    return DEFAULT_MODELS_ROOT


def set_models_root(path: str) -> Path:
    """Validate + persist a new models_root; create it; return the resolved path.

    Raises RuntimeError (caught by callers → friendly message / JSON error, never a
    raw traceback) for: empty path, a path that exists but is a FILE (mkdir would
    throw FileExistsError), an uncreatable folder, or a config write that failed."""
    if not str(path).strip():
        raise RuntimeError("models_root path is empty")
    expanded = Path(os.path.expanduser(os.path.expandvars(str(path)))).resolve()
    if expanded.exists() and not expanded.is_dir():
        raise RuntimeError(f"{expanded} exists but is not a directory")
    # --dry-run means NOTHING on disk changes. Validation above still runs (a dry run that
    # reports success for a path it would have rejected is worthless), but the mkdir and the
    # config write below are exactly the two mutations the flag exists to withhold: without
    # this, `prometheus --dry-run models config --set-root DIR` CREATED DIR and PERSISTED the
    # new models_root, then reported ok — a dry run that silently repointed the user's model
    # library. Callers surface the dry-run state; see `_models_config`.
    if DRY_RUN:
        Log.step(f"[dry-run] would create {expanded} and set models_root")
        return expanded
    try:
        expanded.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise RuntimeError(f"cannot create models folder {expanded}: {e}") from e
    cfg = load_config()
    cfg["models_root"] = str(expanded)
    if not save_config(cfg):
        raise RuntimeError(f"could not persist config to {PROM_CONFIG} (check permissions)")
    return expanded

# Agents that can receive a universal SKILL.md drop (have a skills dir).
_SKILL_AGENTS = ("claude", "codex", "cursor", "gemini", "opencode")


def _expand_first(pattern: str) -> Optional[Path]:
    """Expand a path/glob hint to the first existing match."""
    expanded = os.path.expanduser(os.path.expandvars(pattern))
    if any(c in expanded for c in "*?["):
        hits = sorted(_glob(expanded))
        return Path(hits[0]) if hits else None
    p = Path(expanded)
    return p if p.exists() else None


def _agent_version(host: AIHost) -> Optional[str]:
    cli = host._resolved_cli or (shutil.which(host.cli_candidates[0]) if host.cli_candidates else None)
    if not cli:
        return None
    try:
        proc = subprocess.run([cli, "--version"], capture_output=True, text=True, timeout=5)
    except Exception:  # noqa: BLE001
        return None
    out = (proc.stdout or proc.stderr or "").strip().splitlines()
    return out[0][:32] if out else None


def _agent_config_dir(host: AIHost) -> Optional[Path]:
    for hint in host.home_hints:
        cand = _expand_first(hint)
        if cand:
            return cand
    return None


def _superscan() -> list[dict]:
    """Live snapshot of every known agent. Heart of the control center."""
    rows = []
    for h in HOSTS:
        present = h.detect()                        # populates h._resolved_cli
        binary = h._resolved_cli
        cfg = _agent_config_dir(h)
        mtime = cfg.stat().st_mtime if cfg else None
        inv = inventory_host(h) if (present or cfg) else {}
        counts = {k: len(inv.get(k, [])) for k in
                  ("plugins", "skills", "mcp", "extensions", "rules", "commands")}
        stale_days = int((time.time() - mtime) / 86400) if mtime else None
        rows.append({
            "name": h.name, "label": h.label, "kind": h.kind,
            "present": present, "binary": binary,
            "version": _agent_version(h) if binary else None,
            "config_dir": str(cfg) if cfg else None,
            "stale_days": stale_days,
            "forgotten": bool(cfg and not binary),   # config left behind, CLI gone
            "counts": counts,
            "total": sum(counts.values()),
        })
    return rows


def _prereq_health() -> dict:
    tools = {}
    for t in ("git", "node", "npx", "npm", "uv", "pip", "pip3", "brew", "go"):
        tools[t] = bool(shutil.which(t))
    return tools


def cmd_superscan(args, osi: OSInfo) -> int:
    rows = _superscan()
    if JSON_OUT:
        present = [r for r in rows if r["present"]]
        forgotten = [r for r in rows if r["forgotten"]]
        return emit_json({"command": "superscan", "ok": True,
            "os": {"family": osi.family, "pkg_manager": osi.pkg_manager},
            "agents": rows, "prereqs": _prereq_health(),
            "summary": {"active": len(present), "forgotten": len(forgotten),
                        "total": len(rows)}})
    Log.head(f"Super-Scan — AI agent CLIs on this machine  (OS: {osi.family})")
    for r in rows:
        if r["present"]:
            dot = Log._c("●", "green")
        elif r["forgotten"]:
            dot = Log._c("◐", "yellow")             # config exists, binary gone
        else:
            dot = Log._c("○", "dim")
        ver = f" {r['version']}" if r["version"] else ""
        flags = []
        if r["forgotten"]:
            flags.append(Log._c("FORGOTTEN (binary gone, config left)", "yellow"))
        elif r["stale_days"] is not None and r["stale_days"] > STALE_DAYS:
            flags.append(Log._c(f"stale {r['stale_days']}d", "yellow"))
        c = r["counts"]
        contents = (f"{c['plugins']}p {c['skills']}s {c['mcp']}m "
                    f"{c['extensions']}x {c['rules']}r {c['commands']}c") if r["total"] else "empty"
        print(f"  {dot} {r['name']:<14}{ver:<22} [{r['kind']:<3}] {contents}")
        loc = r["config_dir"] or "no config dir"
        print(f"        {Log._c(loc, 'dim')}  {'  '.join(flags)}")
    present = [r for r in rows if r["present"]]
    forgotten = [r for r in rows if r["forgotten"]]
    Log.info(f"{len(present)} active · {len(forgotten)} forgotten · {len(rows)} known")
    if forgotten:
        Log.step(f"forgotten: {', '.join(r['name'] for r in forgotten)} — purge with `purge <agent>`")
    health = _prereq_health()
    ok = [t for t, v in health.items() if v]
    miss = [t for t, v in health.items() if not v]
    print(f"  prereqs: {Log._c('have ' + ' '.join(ok), 'green')}"
          + (f"  {Log._c('missing ' + ' '.join(miss), 'yellow')}" if miss else ""))
    return 0


# ---- reach: where can each tool actually go? -------------------------------
def _plugin_reach(p: Plugin) -> dict[str, str]:
    """agent -> 'native' | 'sync' | '-' for this plugin."""
    out = {}
    universal_star = "*" in p.targets
    for a in _SKILL_AGENTS:
        if a in p.targets or universal_star:
            out[a] = "native"
        elif p.installs_skills and a in _SKILL_AGENTS:
            out[a] = "sync"                          # not native, but a SKILL.md can be copied in
        else:
            out[a] = "-"
    # non-skill agents only reachable if explicitly targeted
    for a in ("windsurf", "zed", "continue"):
        out[a] = "native" if (a in p.targets or universal_star) else "-"
    return out


def cmd_matrix(args, osi: OSInfo) -> int:
    agents = list(_SKILL_AGENTS) + ["windsurf", "zed", "continue"]
    if JSON_OUT:
        reach_rows = []
        for p in PLUGINS:
            reach = _plugin_reach(p)
            reach_rows.append({
                "plugin": p.name, "scope": "C" if p.claude_exclusive else "U",
                "native": [a for a in agents if reach.get(a) == "native"],
                "sync": [a for a in agents if reach.get(a) == "sync"],
                "unavailable": [a for a in agents if reach.get(a) == "-"]})
        return emit_json({"command": "matrix", "ok": True, "agents": agents,
                          "reach": reach_rows})
    Log.head("Reach matrix — which tool can go in which agent  (✓ native · ↔ via sync · – no)")
    hdr = "  " + f"{'plugin':<26}" + "".join(f"{a[:6]:>8}" for a in agents)
    print(Log._c(hdr, "bold"))
    glyph = {"native": "✓", "sync": "↔", "-": "–"}      # plain for grid alignment
    for p in PLUGINS:
        reach = _plugin_reach(p)
        scope = "C" if p.claude_exclusive else "U"
        row = f"  [{scope}] {p.name:<22}" + "".join(f"{glyph[reach[a]]:>8}" for a in agents)
        print(row)
    Log.step("[C]=Claude-only  [U]=universal.  ↔ = install on Claude then `sync <skill> --to <agent>`")
    return 0


_WHERE_DEST = {
    "claude_plugin": "~/.claude/plugins (+ enabledPlugins)",
    "claude_marketplace": "~/.claude/plugins/known_marketplaces.json",
    "universal_skill": "each agent's skills dir (npx skills add)",
    "gemini_extension": "~/.gemini/extensions/",
    "cursor_mcp": "~/.cursor/mcp.json", "cursor_rule": ".cursor/rules/",
    "codex_mcp": "~/.codex/config.toml [mcp_servers]", "codex_prompt": "~/.codex/prompts/",
    "opencode_mcp": "~/.config/opencode/opencode.json",
    "windsurf_mcp": "~/.codeium/windsurf/mcp_config.json",
    "zed_context_server": "~/.config/zed/settings.json", "continue_mcp": "~/.continue/config.json",
    "shell": "(repo installer)", "shell_or_action": "(CI action / slash)",
}


def _where_dest(spec: "InstallSpec") -> str:
    if spec.method in ("git_clone", "git_clone_shell"):
        return spec.dest or "(repo clone dir)"
    return _WHERE_DEST.get(spec.method, "(see info)")


def cmd_where(args, osi: OSInfo) -> int:
    """Tell the user WHERE a tool installs to, BEFORE installing (no wrong-agent hunting)."""
    p = plugin_registry().get(args.name)
    if not p:
        if JSON_OUT:
            return emit_json({"command": "where", "ok": False,
                              "error": f"unknown plugin: {args.name}", "_exit": 2})
        Log.err(f"unknown plugin: {args.name}. Try: list / matrix")
        return 2
    if JSON_OUT:
        return emit_json({"command": "where", "ok": True, "plugin": {
            "name": p.name,
            "scope": "claude-only" if p.claude_exclusive else "universal",
            "targets": [{
                "agent": "*" if hname == "*" else hname, "method": spec.method,
                "dest": _where_dest(spec), "mcp_name": spec.mcp_name,
                "repo_url": spec.repo_url,
                "universal_add": spec.universal_add or None}
                for hname, spec in p.targets.items()]}})
    scope = "CLAUDE-ONLY" if p.claude_exclusive else "universal (multi-CLI)"
    Log.head(f"Where does '{p.name}' go?   scope: {scope}")
    for hname, spec in p.targets.items():
        agent = "every detected agent (skills CLI fan-out)" if hname == "*" else hname
        dest = _where_dest(spec)
        print(f"  → {agent:<42} via {spec.method}  @ {dest}")
    if p.claude_exclusive:
        Log.warn(f"'{p.name}' is Claude-exclusive — it will NOT appear in Codex/Cursor/Gemini/etc.")
    else:
        sync_ok = [a for a in _SKILL_AGENTS if _plugin_reach(p).get(a) in ("native", "sync")]
        Log.ok(f"reaches (native or via sync): {', '.join(sync_ok)}")
    return 0


# ---- purge a forgotten agent (backup, then remove Prometheus-visible state) -
def _cmd_purge_json(args) -> int:
    """CLI-081: `purge --json` — PLAN by default (lists the backup + config removal, mutates
    NOTHING); execution requires --yes PLUS a matching `--confirm <agent>` typed token (mirrors the
    interactive double-confirm). A mismatched/absent token → ok:false, _exit 2, zero mutation."""
    host = host_registry().get(args.name)
    if not host:
        return emit_json({"command": "purge", "ok": False,
                          "error": f"unknown agent: {args.name}", "_exit": 2})
    cfg = _agent_config_dir(host)
    binary = shutil.which(host.cli_candidates[0]) if host.cli_candidates else None
    if not cfg:
        return emit_json({"command": "purge", "ok": True, "phase": "plan", "actions": [],
                          "message": f"no config dir found for {host.name} — nothing to purge",
                          "_exit": 0})
    actions = [{"kind": "backup", "target": host.name,
                "detail": f"tar {cfg} -> {PURGE_DIR}/{host.name}-<ts>.tgz"},
               {"kind": "remove-config", "target": host.name, "detail": str(cfg)}]
    if not getattr(args, "yes", False):
        env = {"command": "purge", "ok": True, "phase": "plan", "actions": actions,
               "requires": ["--yes", f"--confirm {host.name}"], "_exit": 0}
        if binary:
            env["warning"] = (f"{host.name} CLI is STILL INSTALLED ({binary}); purge removes only "
                              f"config/state, not the binary (pass --force to purge anyway)")
        return emit_json(env)
    # --- execute path: --yes given → require the typed-confirm token to match the agent name ---
    token = (getattr(args, "confirm", None) or "").strip().lower()
    if token != host.name.strip().lower():
        return emit_json({"command": "purge", "ok": False,
                          "error": f"--confirm must be '{host.name}' to purge over --json "
                                   f"(typed-confirm); got '{getattr(args, 'confirm', None)}'",
                          "_exit": 2})
    if binary and not FORCE:
        return emit_json({"command": "purge", "ok": False,
                          "error": f"{host.name} CLI still installed ({binary}); purge removes "
                                   f"config only — pass --force to proceed", "_exit": 2})
    if DRY_RUN:
        return emit_json({"command": "purge", "ok": True, "phase": "executed", "dry_run": True,
                          "actions": [{**a, "ok": True} for a in actions], "_exit": 0})
    try:
        PURGE_DIR.mkdir(parents=True, exist_ok=True)
        archive = PURGE_DIR / f"{host.name}-{int(time.time())}.tgz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(cfg, arcname=Path(cfg).name)
        shutil.rmtree(cfg, ignore_errors=True)
    except OSError as e:
        return emit_json({"command": "purge", "ok": False, "error": str(e), "_exit": 1})
    return emit_json({"command": "purge", "ok": True, "phase": "executed", "actions": [
        {"kind": "backup", "target": host.name, "detail": str(archive), "ok": True},
        {"kind": "remove-config", "target": host.name, "detail": str(cfg), "ok": True},
    ], "_exit": 0})


def cmd_purge(args, osi: OSInfo) -> int:
    if JSON_OUT:
        return _cmd_purge_json(args)
    host = host_registry().get(args.name)
    if not host:
        Log.err(f"unknown agent: {args.name}. Try: superscan")
        return 2
    cfg = _agent_config_dir(host)
    binary = shutil.which(host.cli_candidates[0]) if host.cli_candidates else None
    Log.head(f"Purge agent: {host.label} ({host.name})")
    if not cfg:
        Log.warn(f"no config dir found for {host.name} — nothing to purge")
        return 0
    if binary and not FORCE:
        Log.warn(f"{host.name} CLI is STILL INSTALLED ({binary}). Purge removes only its config/state, "
                 f"not the binary. Use --force to proceed anyway.")
        return 0
    Log.step(f"will back up + remove: {cfg}")
    Log.step("does NOT uninstall the CLI binary — remove that with your package manager (brew/npm/...)")
    if not _confirm(f"Back up and DELETE {cfg}?"):
        Log.warn("declined"); return 0
    if not _confirm("Are you SURE? this removes the agent's settings/skills/MCP wiring"):
        Log.warn("declined"); return 0
    if DRY_RUN:
        Log.step(f"[dry-run] tar {cfg} -> {PURGE_DIR}/{host.name}-<ts>.tgz ; rm -rf {cfg}")
        return 0
    PURGE_DIR.mkdir(parents=True, exist_ok=True)
    archive = PURGE_DIR / f"{host.name}-{int(time.time())}.tgz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(cfg, arcname=Path(cfg).name)
    Log.ok(f"backup -> {archive}")
    shutil.rmtree(cfg, ignore_errors=True)
    Log.ok(f"purged {host.name} config ({cfg}). Restore: tar xzf {archive}")
    return 0


# ---- session report (durable 'what is now where') --------------------------
def write_session_report(action: str, events: list, detected: list[AIHost]) -> None:
    if DRY_RUN:
        return
    try:
        PROM_DIR.mkdir(parents=True, exist_ok=True)
        lines = [f"# Prometheus run — {time.strftime('%Y-%m-%d %H:%M:%S')}",
                 f"\naction: {action}",
                 f"target agents: {', '.join(h.name for h in detected) or 'none'}\n",
                 "## Placement map"]
        by_agent: dict[str, list] = {}
        for e in events:
            if e.result in ("installed", "already"):
                by_agent.setdefault(e.agent, []).append(e)
        for agent in sorted(by_agent):
            lines.append(f"- **{agent}**: " + ", ".join(
                f"{e.plugin} ({e.scope}, {e.result})" for e in by_agent[agent]))
        claude_only = sorted({e.plugin for e in events if e.scope == "claude-only"})
        if claude_only:
            lines.append(f"\n> Claude-only (not in other agents): {', '.join(claude_only)}")
        SESSION_REPORT.write_text("\n".join(lines) + "\n")
    except Exception:  # noqa: BLE001 — reporting must never break a run
        pass


# --- auto-maintenance schedule: self-healing periodic `prometheus auto` ------
# A marker records that the user opted into the periodic routine so prometheus can
# RE-ASSERT it (reinstall if the launchd plist / cron line was purged) — this keeps
# the security re-check alive across long (30-day) sessions where the startup hook
# rarely fires. `schedule --auto-off` is the clean off-switch (clears the marker +
# removes the entry) so the self-heal is never a footgun.
_AUTO_SCHED_CFG = _PROM_CFG_DIR / "auto_schedule.json"


def _auto_sched_cmdline(defang: bool) -> str:
    # shlex.quote both paths — a space/quote in the python path or repo path would
    # otherwise break the `/bin/sh -c` arg (launchd) and the cron line.
    c = f"{shlex.quote(sys.executable)} {shlex.quote(os.path.abspath(__file__))} --json auto"
    return c + " --defang" if defang else c


def _auto_sched_plist(name: str) -> Path:
    return HOME / "Library" / "LaunchAgents" / f"com.prometheus.{name}.plist"


def _auto_schedule_present(osi: "OSInfo", name: str = "prometheus-auto") -> bool:
    """Is the auto-maintenance entry currently installed?"""
    if osi.family == "macos":
        return _auto_sched_plist(name).exists()
    try:
        out = _run_timed(["crontab", "-l"], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return f"{os.path.abspath(__file__)} --json auto" in out


def _install_auto_schedule(osi: "OSInfo", *, interval: int = 86400, defang: bool = False,
                           cron: str = "0 3 * * *", name: str = "prometheus-auto") -> dict:
    """Write the launchd plist (macOS, + (re)load) / cron line (Linux) for `prometheus
    auto`. NON-interactive (caller decided). Idempotent. Returns {ok, where}."""
    cmdline = _auto_sched_cmdline(defang)
    if DRY_RUN:
        return {"ok": True, "where": "dry-run"}
    try:
        if osi.family == "macos":
            plist = _auto_sched_plist(name)
            # XML-escape every interpolated value — a `&`/`<`/`>` in $HOME or the cmdline
            # would otherwise produce a malformed plist that launchctl silently rejects.
            log_path = _xml_escape(f"{HOME}/{name}.log")
            body = ("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
                    "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n"
                    f"  <key>Label</key><string>com.prometheus.{_xml_escape(name)}</string>\n"
                    "  <key>ProgramArguments</key><array>"
                    f"<string>/bin/sh</string><string>-c</string><string>{_xml_escape(cmdline)}</string></array>\n"
                    f"  <key>StartInterval</key><integer>{int(interval)}</integer>\n"
                    f"  <key>StandardOutPath</key><string>{log_path}</string>\n"
                    f"  <key>StandardErrorPath</key><string>{log_path}</string>\n"
                    "</dict></plist>\n")
            plist.parent.mkdir(parents=True, exist_ok=True)
            plist.write_text(body)
            _run_timed(["launchctl", "unload", str(plist)], capture_output=True, timeout=30)  # idempotent reload
            rc = _run_timed(["launchctl", "load", str(plist)], capture_output=True, text=True, timeout=30)
            return {"ok": rc.returncode == 0, "where": str(plist)}
        line = (f"{cron} cd {shlex.quote(str(HOME))} && {cmdline} "
                f">> {shlex.quote(f'{HOME}/{name}.log')} 2>&1")
        existing = _run_timed(["crontab", "-l"], capture_output=True, text=True, timeout=15).stdout
        if f"{os.path.abspath(__file__)} --json auto" in existing:
            return {"ok": True, "where": "crontab (already present)"}
        new = (existing.rstrip("\n") + "\n" + line + "\n") if existing.strip() else line + "\n"
        _run_timed(["crontab", "-"], input=new, text=True, timeout=30)
        return {"ok": True, "where": "crontab"}
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "where": f"error: {e}"}


def _remove_auto_schedule(osi: "OSInfo", name: str = "prometheus-auto") -> dict:
    """Remove the auto-maintenance entry (launchctl unload + rm plist / drop cron line)."""
    if DRY_RUN:
        return {"ok": True, "where": "dry-run"}
    try:
        if osi.family == "macos":
            plist = _auto_sched_plist(name)
            if plist.exists():
                _run_timed(["launchctl", "unload", str(plist)], capture_output=True, timeout=30)
                plist.unlink(missing_ok=True)
            return {"ok": True, "where": str(plist)}
        cp = _run_timed(["crontab", "-l"], capture_output=True, text=True, timeout=15)
        # A transient/failed `crontab -l` (lock, perms) must NOT be read as "empty" —
        # rewriting from [] would WIPE the user's entire crontab. Only "no crontab for…"
        # (returncode 1 + that stderr) is a genuine empty; anything else: leave untouched.
        if cp.returncode != 0 and "no crontab" not in cp.stderr.lower():
            return {"ok": False, "where": "could not read crontab — left untouched"}
        kept = [ln for ln in cp.stdout.splitlines()
                if f"{os.path.abspath(__file__)} --json auto" not in ln]
        if kept == cp.stdout.splitlines():
            return {"ok": True, "where": "crontab (no entry to remove)"}
        _run_timed(["crontab", "-"], input="\n".join(kept) + ("\n" if kept else ""), text=True, timeout=30)
        return {"ok": True, "where": "crontab"}
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "where": f"error: {e}"}


def _ensure_auto_schedule(osi: "OSInfo") -> None:
    """SELF-HEAL: if the user opted into the periodic routine and the entry was purged,
    silently reinstall it. Keeps the security re-check regular across long sessions.
    No-op unless the opt-in marker is enabled (so it only maintains what the user chose)."""
    if DRY_RUN:
        return
    try:
        m = _read_json(_AUTO_SCHED_CFG)
        if not m.get("enabled"):
            return
        name = m.get("name", "prometheus-auto")
        if _auto_schedule_present(osi, name):
            return
        r = _install_auto_schedule(osi, interval=int(m.get("interval", 86400)),
                                   defang=bool(m.get("defang", False)),
                                   cron=m.get("cron", "0 3 * * *"), name=name)
        if r.get("ok") and not JSON_OUT:
            Log.warn(f"prometheus: auto-maintenance schedule was missing — reinstalled "
                     f"({r['where']}). Stop it for good with: prometheus schedule --auto-off")
    except Exception:  # noqa: BLE001 — self-heal must never break a command
        return


def _cmd_schedule_json(args, osi: "OSInfo") -> int:
    """CLI-081: `schedule --json` — `--list` reports the present auto-schedule; create (--auto / TASK)
    and `--auto-off` are PLAN-by-default (mutate nothing) and EXECUTE only with --yes. The plan/exec
    envelopes carry the exact cmdline + platform install location + the persistence WARNING."""
    # --- --list: what auto-maintenance schedule is present now (no mutation) -----------------
    if getattr(args, "list", False):
        present = _auto_schedule_present(osi)
        cfg = _read_json(_AUTO_SCHED_CFG) if _AUTO_SCHED_CFG.exists() else {}
        return emit_json({"command": "schedule", "ok": True, "phase": "list",
                          "present": present, "config": cfg, "_exit": 0})

    warning = ("creates a SELF-HEALING PERSISTENCE entry that runs unattended on a schedule "
               "(reinstalled if purged; off-switch: `schedule --auto-off`)")

    # --- --auto-off: remove the auto-maintenance schedule -----------------------------------
    if getattr(args, "auto_off", False):
        name = (args.name or "prometheus-auto").replace(" ", "-")
        action = {"kind": "remove-schedule", "target": name,
                  "detail": ("launchd plist + unload" if osi.family == "macos" else "crontab line")}
        if not getattr(args, "yes", False):
            return emit_json({"command": "schedule", "ok": True, "phase": "plan",
                              "actions": [action], "requires": ["--yes"], "_exit": 0})
        r = _remove_auto_schedule(osi, name)
        if not DRY_RUN:
            _write_json_atomic(_AUTO_SCHED_CFG, {"enabled": False, "name": name,
                                                 "disabled_at": _now_iso()})
        return emit_json({"command": "schedule", "ok": bool(r.get("ok")), "phase": "executed",
                          "actions": [{**action, "ok": bool(r.get("ok")), "where": r.get("where")}],
                          "_exit": 0 if r.get("ok") else 1})

    # --- create: --auto maintenance routine, or a TASK watcher ------------------------------
    auto = getattr(args, "auto", False)
    if not auto and not args.task:
        return emit_json({"command": "schedule", "ok": False,
                          "error": "schedule needs a TASK, or --auto, or --auto-off (or --list)",
                          "_exit": 2})
    defang = bool(getattr(args, "defang", False))
    name = (args.name or ("prometheus-auto" if auto else "prometheus-watcher")).replace(" ", "-")
    interval = int(args.interval or (86400 if auto else 3600))
    cron = args.cron or ("0 3 * * *" if auto else "0 * * * *")
    cmdline = _auto_sched_cmdline(defang) if auto else \
        f'{shutil.which("claude") or "claude"} --bare -p {json.dumps(args.task)} --output-format json'
    where = (f"{_auto_sched_plist(name)} (every {interval}s) + launchctl load"
             if osi.family == "macos" else f"crontab line ({cron})")
    action = {"kind": "install-schedule", "target": name, "detail": where, "cmdline": cmdline}
    if not getattr(args, "yes", False):
        return emit_json({"command": "schedule", "ok": True, "phase": "plan", "actions": [action],
                          "requires": ["--yes"], "warning": warning, "_exit": 0})
    if not auto:
        # a bespoke TASK watcher install over --json is not wired (only the auto routine is); be honest.
        return emit_json({"command": "schedule", "ok": False,
                          "error": "over --json only `--auto` schedule install is supported; a bespoke "
                                   "TASK watcher must use the human CLI", "_exit": 2})
    r = _install_auto_schedule(osi, interval=interval, defang=defang, cron=cron, name=name)
    if not DRY_RUN:
        _write_json_atomic(_AUTO_SCHED_CFG, {"enabled": True, "name": name, "interval": interval,
                                             "defang": defang, "cron": cron, "installed_at": _now_iso()})
    return emit_json({"command": "schedule", "ok": bool(r.get("ok")), "phase": "executed",
                      "warning": warning,
                      "actions": [{**action, "ok": bool(r.get("ok")), "where": r.get("where")}],
                      "_exit": 0 if r.get("ok") else 1})


def cmd_schedule(args, osi: OSInfo) -> int:
    """Scaffold a scheduled headless watcher (`claude --bare -p`) OR the self-healing
    `prometheus auto` maintenance routine (--auto). Persistence → confirm-gated."""
    if JSON_OUT:
        return _cmd_schedule_json(args, osi)

    # --- off-switch: stop the self-healing auto-maintenance schedule -----------
    if getattr(args, "auto_off", False):
        name = (args.name or "prometheus-auto").replace(" ", "-")
        Log.head("Disable auto-maintenance schedule")
        r = _remove_auto_schedule(osi, name)
        if not DRY_RUN:
            _write_json_atomic(_AUTO_SCHED_CFG, {"enabled": False, "name": name,
                                                 "disabled_at": _now_iso()})
        Log.ok(f"auto-maintenance disabled + removed ({r.get('where')}); self-heal will not reinstall it")
        return 0 if r.get("ok") else 1

    auto = getattr(args, "auto", False)
    if auto:
        defang = bool(getattr(args, "defang", False))
        cmdline = _auto_sched_cmdline(defang)
        name = (args.name or "prometheus-auto").replace(" ", "-")
        interval = int(args.interval or 86400)        # daily
        cron = args.cron or "0 3 * * *"
        Log.head(f"Schedule auto-maintenance: {name}")
        Log.warn("this creates a SELF-HEALING PERSISTENCE entry that runs `prometheus auto` "
                 "UNATTENDED on a schedule (reinstalled if purged; off-switch: `schedule --auto-off`)")
        Log.step(f"command: {cmdline}")
        where = (str(_auto_sched_plist(name)) + f" (every {interval}s) + launchctl load"
                 if osi.family == "macos" else f"crontab line ({cron})")
        Log.step(f"would install: {where}")
        if not _confirm("Install the auto-maintenance schedule?"):
            Log.warn("declined"); return 0
        r = _install_auto_schedule(osi, interval=interval, defang=defang, cron=cron, name=name)
        if not DRY_RUN:
            _write_json_atomic(_AUTO_SCHED_CFG, {"enabled": True, "name": name,
                                                 "interval": interval, "defang": defang,
                                                 "cron": cron, "installed_at": _now_iso()})
        if r.get("ok"):
            Log.ok(f"auto-maintenance scheduled ({r.get('where')}) — runs `prometheus auto` "
                   f"and self-reinstalls if removed")
        else:
            Log.err(f"install failed: {r.get('where')}")
        return 0 if r.get("ok") else 1

    # --- classic headless watcher (claude --bare -p) --------------------------
    if not args.task:
        Log.err("schedule needs a TASK to run — or pass --auto for the prometheus "
                "auto-maintenance routine, or --auto-off to remove it")
        return 2
    cli = shutil.which("claude") or "claude"
    name = (args.name or "prometheus-watcher").replace(" ", "-")
    cmdline = f'{cli} --bare -p {json.dumps(args.task)} --output-format json'
    Log.head(f"Schedule watcher: {name}")
    Log.warn("this creates a PERSISTENCE entry that runs an agent UNATTENDED on a schedule")
    Log.step(f"command: {cmdline}")
    if osi.family == "macos":
        plist = _auto_sched_plist(name)
        interval = int(args.interval or 3600)
        body = ("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
                "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n"
                f"  <key>Label</key><string>com.prometheus.{name}</string>\n"
                "  <key>ProgramArguments</key><array>"
                f"<string>/bin/sh</string><string>-c</string><string>{cmdline}</string></array>\n"
                f"  <key>StartInterval</key><integer>{interval}</integer>\n"
                f"  <key>StandardOutPath</key><string>{HOME}/{name}.log</string>\n"
                "</dict></plist>\n")
        Log.step(f"would write {plist} (every {interval}s) + `launchctl load`")
        if not _confirm(f"Write launchd plist {plist.name}?"):
            Log.warn("declined"); return 0
        if DRY_RUN:
            Log.step(f"[dry-run] write {plist}")
        else:
            plist.parent.mkdir(parents=True, exist_ok=True)
            plist.write_text(body)
            Log.ok(f"wrote {plist}  — load: launchctl load {plist}")
    else:
        cron = f"{args.cron or '0 * * * *'} cd {Path.cwd()} && {cmdline} >> {HOME}/{name}.log 2>&1"
        Log.step("add this line to your crontab (`crontab -e`):")
        print(f"  {cron}")
        if _confirm("Append it to your crontab now?") and not DRY_RUN:
            existing = _run_timed(["crontab", "-l"], capture_output=True, text=True, timeout=15).stdout
            new = (existing.rstrip("\n") + "\n" + cron + "\n") if existing.strip() else cron + "\n"
            _run_timed(["crontab", "-"], input=new, text=True, timeout=30)
            Log.ok("appended to crontab")
    return 0


# ---- scaffold an auto-firing skill (frontend-design = the template shape) ---
#  The "user never worries" primitive: turn any repeated instruction into a
#  self-triggering SKILL.md dropped in ~/.claude/skills/<name>/ (auto-loaded,
#  hot-watched). A model-invocable skill with a SHARP `description` auto-fires
#  on matching prompts — no slash command. See dossier 06 / 02.
#  (CLAUDE_SKILLS_DIR is defined in SECTION 4B.)


def _skill_md(name: str, description: str, body: str,
              tools: Optional[str], manual: bool) -> str:
    lines = ["---", f"name: {name}", f"description: {description}"]
    if manual:
        lines.append("disable-model-invocation: true   # manual /name only (no auto-fire)")
    if tools:
        lines.append(f"allowed-tools: {tools}   # auto-granted (no permission prompts) while active")
    lines += ["---", "", body, ""]
    return "\n".join(lines)


def scaffold_auto_skill(name: str, description: str, body: str,
                        tools: Optional[str] = None, manual: bool = False,
                        skills_dir: Path = CLAUDE_SKILLS_DIR) -> Optional[Path]:
    """Write ~/.claude/skills/<name>/SKILL.md. Returns the path, or None if it
    exists and --force was not given."""
    dest = skills_dir / name / "SKILL.md"
    if dest.exists() and not FORCE:
        Log.warn(f"{dest} already exists — use --force to overwrite")
        return None
    content = _skill_md(name, description, body, tools, manual)
    if DRY_RUN:
        Log.step(f"[dry-run] write {dest}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content)
    return dest


def cmd_scaffold(args, osi: OSInfo) -> int:
    name = args.name.strip().replace(" ", "-").lower()
    if not name:
        Log.err("skill name required")
        return 2
    description = args.description or f"Use when <CLEAR trigger conditions for '{name}' — the sharper, the more reliably it auto-fires>."
    body = args.body or f"<the instructions Claude should follow whenever the '{name}' skill fires>"
    dest = scaffold_auto_skill(name, description, body, tools=args.tools, manual=args.manual)
    if not dest:
        return 1
    Log.ok(f"scaffolded {dest}")
    if args.manual:
        Log.step(f"manual skill — fire with /{name} (auto-invocation disabled)")
    else:
        Log.step("auto-armed + hot-watched — fires when a prompt matches the description")
        Log.step("sharpen the `description` (and add `when_to_use:`) to tune when it triggers")
    Log.step(f"universal: copy {dest.parent} into other agents' skills dirs for cross-CLI use")
    return 0


# ---- wizard (minimal terminal GUI) ----------------------------------------
def _parse_ints(s: str, n: int) -> list[int]:
    out: list[int] = []
    for part in s.replace(" ", "").split(","):
        if part.isdigit():
            k = int(part)
            if 1 <= k <= n and k not in out:
                out.append(k)
    return out


def _redundancy_warn(chosen: list[Plugin]) -> None:
    groups: dict[str, list[str]] = {}
    for p in chosen:
        if p.redundancy_group:
            groups.setdefault(p.redundancy_group, []).append(p.name)
    for g, names in groups.items():
        if len(names) > 1:
            Log.warn(f"redundancy {g}: picked {', '.join(names)} — usually install ONE")


def _wizard_browse_install(detected: list[AIHost], osi: OSInfo) -> None:
    if not EXTERNAL_PLUGINS:
        Log.warn("no external plugins inserted yet")
        return
    rows = sorted(EXTERNAL_PLUGINS,
                  key=lambda p: (p.recommend_rank if p.recommend_rank is not None else 999, p.name))
    Log.head("External plugins (ranked)")
    for i, p in enumerate(rows, 1):
        print(f"  {i:>2}) {_plugin_row(p)}")
    sel = input("  select numbers (e.g. 1,3) or 'all', blank=cancel: ").strip().lower()
    if not sel:
        return
    chosen = rows if sel == "all" else [rows[k - 1] for k in _parse_ints(sel, len(rows))]
    if not chosen:
        Log.warn("nothing selected")
        return
    _redundancy_warn(chosen)
    evs: list = []
    _run_installs(chosen, detected, osi, evs)
    _print_install_map(evs, detected)


def _wizard_uninstall(detected: list[AIHost], osi: OSInfo) -> None:
    installed: list[tuple[Plugin, AIHost]] = []
    for p in PLUGINS:
        for host in _match_hosts(p, detected):
            spec = _spec_for(p, host)
            if is_installed(p, host, spec):     # statically checkable methods only
                installed.append((p, host))
    if not installed:
        Log.warn("nothing detected as installed (some methods aren't statically checkable — "
                 "use `uninstall <name>` directly)")
        return
    Log.head("Installed (detected)")
    for i, (p, host) in enumerate(installed, 1):
        print(f"  {i:>2}) {p.name} @ {host.name}")
    sel = input("  select numbers to remove, blank=cancel: ").strip()
    if not sel:
        return
    for k in _parse_ints(sel, len(installed)):
        p, host = installed[k - 1]
        spec = _spec_for(p, host)
        if not _confirm_uninstall(p, host):
            continue
        try:
            if resolve_uninstaller(host, spec)(p, spec, host, osi):
                Log.ok(f"{p.name} -> {host.name} uninstalled")
        except Exception as e:  # noqa: BLE001
            Log.err(f"{p.name} -> {host.name}: {e}")


def _wizard_documented() -> None:
    if not DOCUMENTED_ONLY:
        Log.warn("no documented-only entries inserted yet")
        return
    Log.head("Documented-only (NOT installed by Prometheus)")
    for d in DOCUMENTED_ONLY:
        print(f"  • {d.get('id','?')} — {d.get('summary','')}")
        if d.get("why_excluded"):
            Log.step(f"why: {d['why_excluded']}")
        if d.get("doc_url"):
            Log.step(f"docs: {d['doc_url']}")
        for line in d.get("manual", []):
            print(f"      $ {line}")


def _ns(**kw):
    """Tiny argparse-Namespace shim for calling cmd_* from the wizard."""
    return type("A", (), kw)()


def _wizard_action_board(osi: OSInfo) -> None:
    """P5.3 — pick targets (all / per-agent), then install with reach clarity."""
    detected = detect_hosts()
    if not detected:
        Log.warn("no agents detected")
        return
    Log.head("Targets — where do you want to install?")
    for i, h in enumerate(detected, 1):
        print(f"  {i:>2}) {h.name:<14} {h.label}")
    sel = input("  'a' = ALL detected, or numbers (e.g. 1,3): ").strip().lower()
    if not sel:
        return
    chosen_hosts = detected if sel in ("a", "all") else [detected[k - 1] for k in _parse_ints(sel, len(detected))]
    if not chosen_hosts:
        Log.warn("no targets")
        return
    multi = len(chosen_hosts) > 1
    chosen_names = {h.name for h in chosen_hosts}
    rows = sorted(EXTERNAL_PLUGINS, key=lambda p: (p.recommend_rank if p.recommend_rank is not None else 999, p.name))
    Log.head(f"Catalog — reach vs your targets ({', '.join(sorted(chosen_names))})")
    for i, p in enumerate(rows, 1):
        if p.claude_exclusive:
            badge = Log._c("claude-only", "yellow") + (Log._c(" ⚠ won't reach others", "yellow") if multi else "")
        else:
            badge = Log._c("universal", "green")
        print(f"  {i:>2}) {p.name:<24} [{badge}] {p.summary[:42]}")
    sel2 = input("  select plugins (numbers / 'all'), blank=cancel: ").strip().lower()
    if not sel2:
        return
    chosen = rows if sel2 == "all" else [rows[k - 1] for k in _parse_ints(sel2, len(rows))]
    if not chosen:
        return
    _redundancy_warn(chosen)
    if multi and any(p.claude_exclusive for p in chosen):
        co = [p.name for p in chosen if p.claude_exclusive]
        Log.warn(f"heads-up: {', '.join(co)} are CLAUDE-ONLY — they will land in Claude only, not the other targets")
    events: list = []
    _run_installs(chosen, chosen_hosts, osi, events)
    _print_install_map(events, chosen_hosts)
    write_session_report("wizard action-board", events, chosen_hosts)


def _wizard_control_center(args, osi: OSInfo) -> None:
    """P5 landing: super-scan + global/per-agent actions."""
    while True:
        cmd_superscan(args, osi)
        print("  1) install (choose ALL agents or specific ones)")
        print("  2) purge a forgotten agent")
        print("  3) where is a tool? (before installing)")
        print("  4) reach matrix")
        print("  5) inventory (what's installed where)")
        print("  b) back")
        ch = input("  center> ").strip().lower()
        if ch in ("b", "back", "", "q"):
            return
        if ch == "1":
            _wizard_action_board(osi)
        elif ch == "2":
            forgotten = [r["name"] for r in _superscan() if r["forgotten"]]
            if not forgotten:
                Log.warn("no forgotten agents (config left behind with no CLI)")
                continue
            print("  forgotten: " + ", ".join(forgotten))
            nm = input("  agent to purge (blank=cancel): ").strip()
            if nm:
                cmd_purge(_ns(name=nm), osi)
        elif ch == "3":
            nm = input("  tool name: ").strip()
            if nm:
                cmd_where(_ns(name=nm), osi)
        elif ch == "4":
            cmd_matrix(args, osi)
        elif ch == "5":
            cmd_inventory(_ns(host=None), osi)
        else:
            Log.warn("pick 1-5 or b")


def _wizard_manage_skills() -> None:
    skills = list_installed_skills()
    if not skills:
        Log.warn(f"no skills installed under {CLAUDE_SKILLS_DIR}")
        return
    Log.head("Installed skills")
    for i, s in enumerate(skills, 1):
        st = skill_state(s)
        col = {"enabled": "green", "muted": "cyan", "disabled": "yellow"}.get(st, "magenta")
        print(f"  {i:>2}) {s:<34} {Log._c(st, col)}")
    sel = input("  number to toggle (blank=cancel): ").strip()
    ix = _parse_ints(sel, len(skills))
    if not ix:
        return
    name = skills[ix[0] - 1]
    act = input(f"  [{name}] action — (d)isable / (e)nable / (m)ute / (u)nmute: ").strip().lower()
    fn = {"d": disable_skill, "e": enable_skill, "m": mute_skill, "u": unmute_skill}.get(act[:1])
    if not fn:
        Log.warn("cancelled")
        return
    if fn(name):
        Log.ok(f"skill '{name}' -> {skill_state(name)}")


def _wizard_scaffold_skill(osi: OSInfo) -> None:
    Log.head("Scaffold an auto-firing skill")
    name = input("  skill name (kebab-case): ").strip()
    if not name:
        Log.warn("cancelled")
        return
    desc = input("  description (write as 'Use when …' — the trigger): ").strip()
    body = input("  instructions (what Claude does when it fires): ").strip()
    tools = input("  allowed-tools (optional, e.g. 'Read Edit', blank=none): ").strip() or None
    manual = input("  manual-only (no auto-fire)? [y/N]: ").strip().lower() in ("y", "yes")
    dest = scaffold_auto_skill(name.replace(" ", "-").lower(),
                               desc or f"Use when <trigger for {name}>.",
                               body or f"<instructions for {name}>", tools=tools, manual=manual)
    if dest:
        Log.ok(f"scaffolded {dest}  ({'manual /' + name if manual else 'auto-fires on matching prompts'})")


def cmd_wizard(args, osi: OSInfo) -> int:
    if JSON_OUT:
        return emit_json({"command": "wizard", "ok": False,
                          "error": "wizard is interactive; not available over --json (use scan/list/install/uninstall)", "_exit": 2})
    if not sys.stdin.isatty():
        Log.err("wizard needs an interactive terminal (use scan/list/install/uninstall instead)")
        return 2
    if osi.family == "unsupported":
        Log.err(f"unsupported OS: {osi.raw}. Only macOS/Linux.")
        return 2
    while True:
        detected = detect_hosts()
        Log.head("Prometheus install wizard")
        print(f"  agents detected: {', '.join(h.name for h in detected) or 'none'}")
        print(f"  0) ★ SUPER-SCAN control center (all agents + global/per-agent install)")
        print(f"  1) install official bundle  ({len(bundle_plugins())} anthropic, auto-trusted)")
        print(f"  2) browse + install external plugins  ({len(EXTERNAL_PLUGINS)} available)")
        print(f"  3) uninstall a plugin")
        print(f"  4) list / status")
        print(f"  5) documented-only / excluded  ({len(DOCUMENTED_ONLY)})")
        print(f"  6) scaffold an auto-firing skill  (~/.claude/skills/)")
        print(f"  7) manage installed skills (enable/disable/mute)")
        print(f"  8) inventory — what's installed across ALL agents (managed + foreign)")
        print(f"  9) sync a skill into other agents (cross-CLI portability)")
        print(f"  m) ★ LOCAL-MODEL TOOLS — run models locally/cloud (AirLLM · FlashAttention · Odysseus)")
        print(f"  a) ★ SELF-HOSTED APPS & REPOS — install/update/rollback/uninstall ({len(REPO_TOOLS)}: yt-dlp · ollama · n8n · penpot · plausible · bitwarden · …)")
        print(f"  w) ★ WORLD SIMULATION & UNDERSTANDING — agent-based world-model / forecasting engines ({len(WORLDSIM_TOOLS)}: MiroFish · …)")
        print(f"  l) ★ LOCAL-AI / BILLING-FREE audit + open-model catalog — run paid-API repos FREE ({sum(1 for a in AI_BILLING if a.patchable)} patchable of {len(AI_BILLING)}; {len(OPEN_MODELS)} open models incl. gpt-oss · qwen3 · Kimi K2 · DeepSeek)")
        print(f"  p) ★ PENTEST ARMORY — sandboxed offensive-sec tools + AIs ({len(PENTEST_TOOLS)}, AUTHORIZED ONLY, airgapped armor)")
        print(f"  q) quit")
        choice = input("  > ").strip().lower()
        if choice in ("q", "quit", "exit", ""):
            return 0
        if choice in ("0", "s"):
            _wizard_control_center(args, osi)
            continue
        if not detected and choice in ("1", "2", "3"):
            Log.warn("no AI agents detected — install one first")
            continue
        if choice == "1":
            t = bundle_plugins()
            if not t:
                Log.warn("official bundle empty — insert official plugins first")
            else:
                evs: list = []
                _run_installs(t, detected, osi, evs)
                _print_install_map(evs, detected)
        elif choice == "2":
            _wizard_browse_install(detected, osi)
        elif choice == "3":
            _wizard_uninstall(detected, osi)
        elif choice == "4":
            cmd_list(args, osi)
        elif choice == "5":
            _wizard_documented()
        elif choice == "6":
            _wizard_scaffold_skill(osi)
        elif choice == "7":
            _wizard_manage_skills()
        elif choice == "8":
            cmd_inventory(args, osi)
        elif choice == "9":
            sk = input("  skill name (in ~/.claude/skills/): ").strip()
            if sk:
                cmd_sync(type("A", (), {"skill": sk, "to": "all"})(), osi)
        elif choice == "m":
            _print_model_tools()
            tid = input("  install which tool? (id, blank=cancel): ").strip().lower()
            if tid:
                t = model_tool_registry().get(tid)
                if t:
                    _install_model_tool(t, osi)   # isolated tools prompt for a folder inside
                else:
                    Log.warn(f"unknown tool '{tid}'")
        elif choice == "a":
            _apps_wizard(osi)
        elif choice == "w":
            _worldsim_wizard(osi)
        elif choice == "l":
            _print_localai_audit()
            if input("  m) open-source model catalog (gpt-oss/qwen3/llama3 · Kimi K2/DeepSeek/GLM)  ·  ↵ back > ").strip().lower() == "m":
                _print_open_models()
                input("  ↵ to return to the wizard ")
        elif choice == "p":
            _pentest_wizard(osi)
        else:
            Log.warn("pick 1-9 / m / a / w / l / p / q")


# ============================================================================
#  SECTION 8 — CLI / help menu
# ============================================================================
EPILOG = """\
examples:
  %(prog)s wizard                interactive menu: bundle / browse / install / uninstall
  %(prog)s scan                  list AI agents detected on this PC
  %(prog)s superscan             ★ every agent: installed/absent/forgotten + counts + prereqs
  %(prog)s matrix                reach grid — which tool can go in which agent
  %(prog)s where document-skills which agent(s) a tool installs to (before installing)
  %(prog)s purge gemini          back up + remove a forgotten agent's config (not the binary)
  %(prog)s inventory             re-scan EVERY agent for all installed plugins/skills/MCP (managed + foreign)
  %(prog)s inventory --host claude     inventory one agent only
  %(prog)s list                  registry + per-agent install state
  %(prog)s bundle                install the official Anthropic bundle in one run
  %(prog)s install official-bundle           same as `bundle`
  %(prog)s install caveman       install into every supported detected agent
  %(prog)s install all           every plugin into every supported agent
  %(prog)s install caveman --host claude     restrict to one agent
  %(prog)s install superpowers --host all    into EVERY detected supported agent
  %(prog)s install knowledge-work-plugins:sales,finance    only those sub-plugins
  %(prog)s install financial-services --skip operations     all components except one
  %(prog)s sync my-skill --to gemini,cursor  copy a Claude skill into other agents
  %(prog)s sync my-skill --to all            replicate it everywhere it can go
  %(prog)s models                3rd functionality: list local-model tools (AirLLM/FlashAttention/Odysseus)
  %(prog)s models install airllm             run huge models on a small GPU → isolated venv, versioned (you pick a folder)
  %(prog)s models install flashattention     fast attention kernel — pick 1 of 7 methods (wheel/pypi/source/hopper/fa4/kernels/rocm)
  %(prog)s models install flashattention --method wheel --target-python /env/bin/python   prebuilt wheel into an engine env (no build)
  %(prog)s models install flashattention --method pypi --max-jobs 4    build from PyPI source (low-RAM)
  %(prog)s models install odysseus           self-hosted AI workspace → isolated, versioned (you pick a folder)
  %(prog)s models install odysseus --path /Volumes/AI    land it in /Volumes/AI/odysseus/ (no prompt)
  %(prog)s models versions odysseus --path /Volumes/AI   local version history (engine snapshots + zip archives)
  %(prog)s models rollback odysseus --version 1 --path /Volumes/AI   roll back offline to a stored version
  %(prog)s models uninstall airllm        delete the whole isolated tool folder (clean removal)
  %(prog)s apps                  4th functionality: self-hosted apps & repos — safest-method-first, full lifecycle
  %(prog)s apps wizard           guided menu: pick app → install/update/rollback/enable/disable/uninstall
  %(prog)s apps install yt-dlp               → isolated venv (uninstall = delete the folder)
  %(prog)s apps install ollama               → official Docker container + volume (safer than curl|sh)
  %(prog)s apps install penpot               → official docker-compose stack (fetched + scanned)
  %(prog)s apps update n8n                   pull the latest image + recreate (data kept)
  %(prog)s apps rollback ollama --version 0.5.4    redeploy a previous image tag
  %(prog)s apps rollback yt-dlp --version 1 --path DIR   roll an isolated pip tool to a stored version
  %(prog)s apps versions plausible           list versions/tags you can roll to
  %(prog)s apps installed        what's installed/running across all apps   ·   apps update-all
  %(prog)s apps disable n8n   /   apps enable n8n   stop/start a service (keep data)
  %(prog)s apps logs penpot  ·  apps restart penpot  ·  apps open penpot   manager shortcuts
  %(prog)s apps uninstall plausible          compose down -v + delete the folder
  %(prog)s localai               audit every AI repo: paid-API vs free-local + the exact recipe to run it FREE
  %(prog)s localai audit                     grouped table (PAID-API→patchable · scanner · hybrid · local · cloud)
  %(prog)s localai models                    catalog of OPEN-SOURCE models: local-free (gpt-oss/qwen3/llama3) + big open (Kimi K2/DeepSeek/Qwen3-235B/GLM-4.6)
  %(prog)s localai model kimi-k2             one open model: license, local fit, served model id + OpenAI-compatible endpoints
  %(prog)s localai show pentestgpt           one tool's billing + free-local recipe (Ollama base-URL + dummy key)
  %(prog)s localai endpoints                 OpenAI-compatible base-URLs: free local servers + open-weight model APIs
  %(prog)s pentest               5th functionality: AUTHORIZED pentest tools + AIs in a strongly-armored sandbox
  %(prog)s pentest scope --init              write the Rules-of-Engagement file (REQUIRED before anything runs)
  %(prog)s pentest build                     build the airgapped armored sandbox base (gVisor/Kata if present)
  %(prog)s pentest install nmap              build a tool into the sandbox (scanned first)
  %(prog)s pentest shell sqlmap              hardened, airgapped shell with the tool (engagement dir mounted rw)
  %(prog)s pentest --allow-net run nmap -- -sT -sV target   run with egress (in-scope ROE targets ONLY)
  %(prog)s pentest status        runtime/armor posture + ROE state   ·   pentest destroy   nuke all images
  %(prog)s status claude-for-legal      install + enabled/disabled state per component
  %(prog)s disable knowledge-work-plugins:legal     turn off one sub-plugin (keep installed)
  %(prog)s enable  knowledge-work-plugins:legal     re-arm it
  %(prog)s disable claude-mem --component hooks      turn off a plugin's hooks on disk
  %(prog)s skills list                  installed SKILL.md folders + state
  %(prog)s skills disable my-skill      reversibly turn a skill off (rename SKILL.md)
  %(prog)s skills mute my-skill         keep it, stop auto-fire (manual /name only)
  %(prog)s uninstall caveman     remove a plugin from detected agents
  %(prog)s uninstall knowledge-work-plugins:sales   remove just one sub-plugin
  %(prog)s uninstall all         remove every registered plugin
  %(prog)s info caveman          plugin details (tier, scope, automation, caveats)
  %(prog)s doctor                check prerequisites
  %(prog)s audit caveman         security-scan a plugin without installing
  %(prog)s audit all             scan every plugin
  %(prog)s audit caveman --revoke      clear remembered trust for a plugin
  %(prog)s scaffold-skill my-skill --description "Use when …"   auto-firing SKILL.md
  %(prog)s --dry-run install all       preview, change nothing
  %(prog)s --strict install caveman    block on medium+ findings

catalog: OFFICIAL BUNDLE (anthropic, auto-trusted, one-run) + EXTERNAL plugins
(ranked, opt-in, always scanned). Claude-only plugins install into claude only;
universal plugins install AND uninstall into every detected compatible agent
via each repo's own official mechanism.

security: every install is statically audited first. critical findings BLOCK
(override: --force-unsafe); high/medium prompt (auto: --yes); approved sources
are remembered. skip entirely with --no-scan (loud, discouraged).

global flags go BEFORE the subcommand (e.g. `%(prog)s --verbose install all`).
"""


# ============================================================================
#  SECTION 8B — UNIFIED CATALOG CARD  (describe / tutorial / methods)
#  Any installable id (plugin / model-tool / app / open-model / documented) →
#  a rich card + a deep tutorial + every install method. Powers the CLI verbs
#  and the GUI's [Install] [Remove] [Learn more] buttons (via --json).
# ============================================================================
def _dossier_dir() -> Path:
    """Where the rich dossiers live: `$PROMETHEUS_DOSSIER_DIR`, else beside the engine.

    The default is `<repo>/AI_SKILLS_WONDERLAND`, which is right for a checkout that still
    carries them. It is NOT right for every install: on this machine the whole directory was
    relocated (a repo-hygiene pass moved the docs to `~/ALPHA_local_only/PROMETHEUS/
    AI_SKILLS_WONDERLAND/`), leaving the engine pointed at a directory with zero `*.md` files —
    so `tutorial`, `methods` and `describe` answered "no tutorial/dossier found for '<id>'" for
    EVERY catalog id, which reads as "you typed the wrong id" rather than "the docs are not
    here". Measured: 6/6 real ids failed, and `DOSSIER_DIR.glob('*.md')` returned nothing.

    An env override is the honest fix — the engine cannot guess where someone moved them, and
    inventing dossiers to fill the gap would be worse than saying nothing.
    """
    override = os.environ.get("PROMETHEUS_DOSSIER_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parent / "AI_SKILLS_WONDERLAND"


DOSSIER_DIR = _dossier_dir()


def _catalog_index() -> dict[str, tuple[str, object]]:
    """id -> (kind, entry) across every registry. kind ∈ plugin|model_tool|app|model|documented."""
    idx: dict[str, tuple[str, object]] = {}
    for p in PLUGINS:
        idx.setdefault(p.name, ("plugin", p))
    for t in MODEL_TOOLS:
        idx.setdefault(t.id, ("model_tool", t))
    for t in REPO_TOOLS:
        idx.setdefault(t.id, ("app", t))
    for m in OPEN_MODELS:
        idx.setdefault(m.id, ("model", m))
    for d in DOCUMENTED_ONLY:
        idx.setdefault(d["id"], ("documented", d))
    return idx


def _dossier_for(idd: str, entry: object) -> Optional[Path]:
    """Resolve the markdown dossier for an entry: its `docs`/`dossier` field, else
    a fuzzy filename match in AI_SKILLS_WONDERLAND/.

    The result is ALWAYS confined to DOSSIER_DIR: a `docs`/`dossier` value
    containing `..` or an absolute path can never escape it (defence-in-depth so a
    poisoned/typo'd registry entry can't turn `tutorial`/`describe` into an
    arbitrary-file read). The fuzzy fallback only ever lists *.md inside the dir."""
    base = DOSSIER_DIR.resolve()
    name = getattr(entry, "docs", None)
    if isinstance(entry, dict):
        name = entry.get("dossier") or name
    if name:
        try:
            cand = (DOSSIER_DIR / name).resolve()
            cand.relative_to(base)           # ValueError if it escapes DOSSIER_DIR
            if cand.is_file():
                return cand
        except (ValueError, OSError):
            pass                             # traversal / bad path → fall through to fuzzy match
    if not DOSSIER_DIR.exists():
        return None
    key = idd.lower().replace("_", "-")
    hits = sorted(p for p in DOSSIER_DIR.glob("*.md") if key in p.name.lower())
    return hits[0] if hits else None


def _no_dossier_message(idd: str) -> str:
    """The dossier catalog (AI_SKILLS_WONDERLAND/) is the maintainer's own curated content and
    is not part of this repo — every id will hit this path on a fresh clone. Say THAT, rather
    than a per-id "not found" that reads like a typo or a missing single file."""
    absent = not DOSSIER_DIR.exists()
    empty = False
    if not absent:
        try:
            empty = next(DOSSIER_DIR.glob("*.md"), None) is None
        except OSError:
            empty = True
    if absent or empty:
        # A directory that exists but holds no *.md is the SAME situation as one that is not
        # there, and it is the commoner one: the catalog gets relocated (a repo-hygiene pass
        # moving docs out of the tree) and the engine keeps pointing at the empty shell. Saying
        # "not found for '<id>'" there reads as a typo; it is nothing to do with the id.
        where = "isn't part of this checkout (it's maintained separately)" if absent else (
            f"directory has no dossiers in it ({DOSSIER_DIR})"
        )
        return (
            f"no tutorial/dossier for '{idd}' — the dossier catalog {where}, so no id has one "
            "here. Point PROMETHEUS_DOSSIER_DIR at the directory if you keep them elsewhere. "
            "`describe`, `list` and installs all still work without it."
        )
    return f"no tutorial/dossier found for '{idd}'."


def _entry_field(entry: object, *names: str) -> str:
    for n in names:
        v = entry.get(n) if isinstance(entry, dict) else getattr(entry, n, None)
        if v:
            return str(v)
    return ""


def cmd_describe(args, osi: OSInfo) -> int:
    """Rich card for any catalog id (what / where / how / security / how to act)."""
    idd = getattr(args, "id", None)
    idx = _catalog_index()
    if not idd:
        if JSON_OUT:
            return emit_json({"command": "describe", "ok": False, "error": "missing id", "_exit": 2})
        Log.err("usage: describe <id>   (see `list`, `models list`, `apps list`)"); return 2
    if idd not in idx:
        if JSON_OUT:
            return emit_json({"command": "describe", "ok": False, "error": f"unknown id '{idd}'", "_exit": 2})
        Log.err(f"unknown id '{idd}'. Try `list` / `models list` / `apps list`."); return 2
    kind, e = idx[idd]
    if JSON_OUT:
        return emit_json({"command": "describe", "ok": True, "id": idd, "kind": kind,
                          "name": _entry_field(e, "name", "id") or idd,
                          "summary": _entry_field(e, "summary", "blurb", "what_it_is"),
                          "repo": _entry_field(e, "repo", "doc_url"),
                          "license": _entry_field(e, "license"),
                          "category": _entry_field(e, "category"),
                          "tier": _entry_field(e, "tier"),
                          "security": _entry_field(e, "security", "security_note", "why_excluded"),
                          "installable": kind != "documented",
                          "has_tutorial": bool(_dossier_for(idd, e))})
    name = _entry_field(e, "name", "id") or idd
    Log.head(f"{name}   [{kind}]")
    summ = _entry_field(e, "summary", "blurb", "what_it_is")
    if summ:
        print("  " + summ)
    for label, fields in (("repo", ("repo", "doc_url")), ("license", ("license",)),
                          ("category", ("category",)), ("tier", ("tier",))):
        val = _entry_field(e, *fields)
        if val:
            Log.step(f"{label}: {val}")
    sec = _entry_field(e, "security", "security_note", "why_excluded")
    if sec:
        Log.warn(f"security: {sec}")
    if kind == "documented":
        Log.info("documented-only — Prometheus does not install this (see the verdict in `tutorial`).")
    else:
        verb = {"plugin": "install", "model_tool": "models install", "app": "apps install"}.get(kind, "install")
        Log.ok(f"install:  prometheus {verb} {idd}        remove: prometheus {verb.replace('install','uninstall')} {idd}")
    if _dossier_for(idd, e):
        Log.step(f"learn more:  prometheus tutorial {idd}     ·     all install methods:  prometheus methods {idd}")
    return 0


def _read_dossier(path: Path) -> str:
    """Read a dossier's markdown, tolerating bytes that are not valid UTF-8.

    `path.read_text()` raised UnicodeDecodeError on a dossier containing a latin-1 accent, and
    `tutorial`/`methods` died with a raw decoder message (and, before the crash guard, "please
    report this bug"). A stray byte in a DOCUMENTATION file must not take the command down —
    the user wants to read the tutorial, and one mangled character is a far better outcome than
    no tutorial at all. `errors="replace"` marks the damage visibly rather than hiding it.
    """
    return path.read_text(encoding="utf-8", errors="replace")


def cmd_tutorial(args, osi: OSInfo) -> int:
    """Print the deep tutorial (the dossier markdown) — the 'Learn more' button."""
    idd = getattr(args, "id", None)
    if not idd:
        if JSON_OUT:
            return emit_json({"command": "tutorial", "ok": False, "error": "missing id", "_exit": 2})
        Log.err("usage: tutorial <id>"); return 2
    idx = _catalog_index()
    entry = idx.get(idd, (None, None))[1]
    path = _dossier_for(idd, entry) if entry is not None else _dossier_for(idd, {})
    if not path:
        if JSON_OUT:
            return emit_json({"command": "tutorial", "ok": False, "error": _no_dossier_message(idd), "_exit": 2})
        Log.err(_no_dossier_message(idd)); return 2
    text = _read_dossier(path)
    if JSON_OUT:
        return emit_json({"command": "tutorial", "ok": True, "id": idd, "text": text})
    print(text)
    return 0


def cmd_methods(args, osi: OSInfo) -> int:
    """List every install method documented for an id (from its dossier)."""
    idd = getattr(args, "id", None)
    if not idd:
        if JSON_OUT:
            return emit_json({"command": "methods", "ok": False, "error": "missing id", "_exit": 2})
        Log.err("usage: methods <id>"); return 2
    idx = _catalog_index()
    entry = idx.get(idd, (None, None))[1]
    path = _dossier_for(idd, entry) if entry is not None else _dossier_for(idd, {})
    if not path:
        if JSON_OUT:
            return emit_json({"command": "methods", "ok": False, "error": _no_dossier_message(idd), "_exit": 2})
        Log.err(_no_dossier_message(idd)); return 2
    text = _read_dossier(path)
    # slice the "## Install" section up to the next top-level "## "
    lines = text.splitlines()
    out, capture = [], False
    for ln in lines:
        if ln.startswith("## ") and ln.lower().startswith("## install"):
            capture = True; out.append(ln); continue
        if capture and ln.startswith("## "):
            break
        if capture:
            out.append(ln)
    section = "\n".join(out).strip()
    if JSON_OUT:
        return emit_json({"command": "methods", "ok": True, "id": idd, "section": section})
    if section:
        Log.head(f"{idd} — install methods")
        print(section)
    else:
        Log.info(f"no explicit install section in the dossier; see `tutorial {idd}`")
    return 0


# ============================================================================
#  SECTION 8C — HARDEN (defensive self-audit; localhost-only, read-only, advisory)
#  "Build your vault": Prometheus checks YOUR OWN machine's posture and tells you
#  how to improve it. Authorized-use-by-design — never scans third parties; for
#  deeper testing of assets you own, it points to the ROE-gated `pentest` armory.
# ============================================================================
# A listen address bound to one of these is reachable from off-box; anything else is not.
_WILDCARD_LISTEN_HOSTS = {"*", "0.0.0.0", "::", "[::]", "[::ffff:0.0.0.0]"}


def _listen_host(addr: str) -> str:
    """The host half of a `host:port` listen address, IPv6 brackets kept."""
    addr = addr.strip()
    if addr.startswith("["):
        end = addr.find("]")
        return addr[:end + 1] if end != -1 else addr
    return addr.rsplit(":", 1)[0] if ":" in addr else addr


def _public_listeners(out: str, tool: str) -> list:
    """Rows of `lsof -nP -iTCP -sTCP:LISTEN` / `ss -tlnp` whose LOCAL address is a wildcard.

    Only the local address may be inspected. `ss` prints a Peer Address:Port column that reads
    `0.0.0.0:*` (`*:*` on older iproute2) for EVERY IPv4 LISTEN socket, so a substring search over
    the whole line flags every loopback-bound service as public — while a genuinely public IPv6
    listener renders as `[::]:8080` and matches none of the IPv4 needles, so it is missed. Both
    directions are wrong, on a verb whose entire output is a security verdict.
    """
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if not parts:
            continue
        if tool == "ss":
            if parts[0].lower() in ("state", "netid"):      # column header
                continue
            if len(parts) < 4 or parts[0].upper() != "LISTEN":
                continue
            addr = parts[3]                                  # State Recv-Q Send-Q Local:Port …
        else:
            if "(LISTEN)" not in parts:
                continue
            i = parts.index("(LISTEN)")
            if i == 0:
                continue
            addr = parts[i - 1]
        if _listen_host(addr) in _WILDCARD_LISTEN_HOSTS:
            rows.append(line)
    return rows


def _sshd_directive(text: str, key: str) -> Optional[str]:
    """The EFFECTIVE value of an sshd_config keyword, or None when it is not set.

    The check used to be `"passwordauthentication yes" in text.lower()` over the whole file,
    which matches the COMMENTED-OUT default line every stock sshd_config ships:
    `#PasswordAuthentication yes`. On a machine with password auth disabled, `harden` reported
    "SSH allows password authentication" — a false alarm in a security tool, which is worse than
    silence because it teaches the user to discount the output. Measured against
    /etc/ssh/sshd_config line 64 (`#PasswordAuthentication yes`) on this machine.

    sshd_config is line-based: `#` starts a comment, and where a keyword is repeated the FIRST
    occurrence wins. Directives inside a `Match` block apply conditionally; this reads the global
    section only, which is the conservative reading for a coarse warning.
    """
    key = key.lower()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.replace("=", " ").split()
        if len(parts) < 2:
            continue
        if parts[0].lower() == "match":
            break  # stop at the first Match block: past here the settings are conditional
        if parts[0].lower() == key:
            return parts[1].lower()
    return None


def cmd_harden(args, osi: OSInfo) -> int:
    is_mac = sys.platform == "darwin"
    Log.head("Harden your vault — local security posture (read-only · THIS machine only)")
    Log.warn("AUTHORIZED-USE: this inspects only this machine. For network/web targets use `pentest` "
             "(sandboxed, ROE-gated) on assets you own.")
    findings: list[tuple[str, str, str]] = []   # (severity, message, fix)

    # 1) services listening on ALL interfaces
    try:
        if shutil.which("lsof"):
            tool = "lsof"
            out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], capture_output=True, text=True, timeout=12).stdout
        elif shutil.which("ss"):
            tool = "ss"
            out = subprocess.run(["ss", "-tlnp"], capture_output=True, text=True, timeout=12).stdout
        else:
            tool, out = "", ""
        public = _public_listeners(out, tool) if tool else []
        if public:
            findings.append(("warn", f"{len(public)} service(s) listening on ALL interfaces (0.0.0.0/*)",
                             "bind sensitive services to 127.0.0.1; expose only via a trusted reverse proxy / VPN (Tailscale, Cloudflare)"))
        else:
            findings.append(("ok", "no services bound to all interfaces (or none listening)", ""))
    except Exception as e:  # noqa: BLE001 — a failed check must never crash the audit
        findings.append(("info", f"port check skipped ({e})", ""))

    # 2) firewall state
    try:
        if is_mac:
            fw = subprocess.run(["/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"],
                                capture_output=True, text=True, timeout=8).stdout.lower()
            findings.append(("ok", "macOS application firewall is ON", "") if "enabled" in fw
                            else ("warn", "macOS application firewall appears OFF", "System Settings → Network → Firewall → On"))
        elif shutil.which("ufw"):
            fw = subprocess.run(["ufw", "status"], capture_output=True, text=True, timeout=8).stdout.lower()
            on = "active" in fw
            findings.append(("ok" if on else "warn", f"ufw {'active' if on else 'inactive'}",
                             "" if on else "enable (allow your needed ports first): sudo ufw enable"))
        else:
            findings.append(("info", "no firewall tool detected to query", ""))
    except Exception as e:  # noqa: BLE001
        findings.append(("info", f"firewall check skipped ({e})", ""))

    # 3) SSH server config (if present + readable)
    try:
        sshd = Path("/etc/ssh/sshd_config")
        if sshd.exists() and os.access(sshd, os.R_OK):
            text = sshd.read_text(errors="ignore")
            if _sshd_directive(text, "permitrootlogin") == "yes":
                findings.append(("warn", "SSH permits root login", "set `PermitRootLogin no` in /etc/ssh/sshd_config, then reload sshd"))
            if _sshd_directive(text, "passwordauthentication") == "yes":
                findings.append(("warn", "SSH allows password authentication", "use keys: `PasswordAuthentication no` (after adding your public key)"))
        else:
            findings.append(("info", "no readable sshd_config (SSH server likely off — good)", ""))
    except Exception as e:  # noqa: BLE001
        findings.append(("info", f"ssh check skipped ({e})", ""))

    # 4) disk encryption (macOS FileVault)
    try:
        if is_mac and shutil.which("fdesetup"):
            fv = subprocess.run(["fdesetup", "status"], capture_output=True, text=True, timeout=8).stdout.lower()
            on = "on" in fv
            findings.append(("ok" if on else "warn", f"FileVault {'ON' if on else 'OFF'}",
                             "" if on else "enable FileVault disk encryption (System Settings → Privacy & Security)"))
    except Exception as e:  # noqa: BLE001
        findings.append(("info", f"disk-encryption check skipped ({e})", ""))

    # 5) over-permissioned secret files in $HOME
    try:
        risky = []
        for rel in (".ssh/id_rsa", ".ssh/id_ed25519", ".aws/credentials", ".netrc", ".config/gh/hosts.yml"):
            f = HOME / rel
            if f.exists():
                mode = oct(f.stat().st_mode)[-3:]
                if mode[-1] in "1234567" or mode[-2] in "1234567":   # any group/other access
                    risky.append(f"{rel} ({mode})")
        if risky:
            findings.append(("warn", "group/other-accessible secret files: " + ", ".join(risky),
                             "tighten: `chmod 600 <file>` and `chmod 700 ~/.ssh`"))
        else:
            findings.append(("ok", "no obviously over-permissioned secret files in $HOME", ""))
    except Exception as e:  # noqa: BLE001
        findings.append(("info", f"secret-permission check skipped ({e})", ""))

    if JSON_OUT:
        return emit_json({"command": "harden", "ok": True,
                          "findings": [{"severity": s, "message": m, "fix": f} for s, m, f in findings],
                          "warnings": sum(1 for s, _, _ in findings if s == "warn")})
    sevmap = {"ok": Log.ok, "warn": Log.warn, "info": Log.info, "err": Log.err}
    warns = 0
    for sev, msg, fix in findings:
        sevmap.get(sev, Log.info)(msg)
        if fix:
            Log.step("fix: " + fix)
        if sev == "warn":
            warns += 1
    Log.head("Summary")
    if warns == 0:
        Log.ok("no obvious local weaknesses found — solid posture")
    else:
        Log.warn(f"{warns} item(s) to harden (see above)")
    Log.step("deeper AUTHORIZED testing: `prometheus pentest` (sandboxed, ROE-gated) · your own website: self-host web-check")
    Log.step("Prometheus is defensive-first — test only assets you own or are authorized to assess.")
    return 0


# ============================================================================
#  SECTION 9 — CHAT (agentic local · terminal-chat for paid CLIs)
#  Two modes, enforced in the engine:
#   * AGENTIC  — `chat --local <model>`: runs IN-APP against a local OpenAI-
#                compatible server (Ollama :11434 / LM Studio :1234). Free, safe
#                → runs as-is.
#   * TERMINAL — `chat --cli <service>`: paid/credentialed CLIs (claude/codex/
#                gemini/cursor/opencode) need a real terminal the user supervises.
#                We assemble a validated argv (NEVER a shell string), show a
#                PREVIEW (the "settings" the GUI would show), and only on `--open`
#                (the OPEN button) do we exec it — optionally wrapped in tmux
#                ("leave-PC"/detach). bypass-permissions + system-prompt injection
#                are typed-confirm gated.
# ============================================================================
# ============================================================================
#  SECTION 6H-bis — REASONING EFFORT (the `/think` ladder), Python side
#
#  The TypeScript hosts (CLI, Studio, VS Code) resolve a user-facing effort tier
#  — off < low < medium < high < max — against a capability table, because the
#  backends do not share a concept: OpenAI-compatible servers take a
#  `reasoning_effort` string, Ollama's native API a `think` field, Anthropic and
#  Gemini a token budget or their own enum, gpt-oss a literal line of English,
#  Qwen3 a trained-on token, and several models take nothing at all.
#
#  Sending the wrong one is not a no-op: it is a hard 400 on a GPT-4-class model
#  and a silent nothing on LM Studio. So Python must not guess either.
#
#  SINGLE SOURCE OF TRUTH. The table is authored once, in
#  studio/packages/core/src/ai/effort/rules.ts, and PUBLISHED to
#  studio/config/effort-capabilities.builtin.json by
#  studio/scripts/emit-effort-rules.mjs. This module reads that artifact; it does
#  not carry its own copy. A TS-side rule added without regenerating fails a test
#  on the TS side rather than silently leaving Python on a stale table.
#
#  Layering matches the TypeScript exactly: builtins, then ~/.prometheus/, then
#  the project's .prometheus/ — later wins a tie, because the resolver scores how
#  SPECIFIC each match is and a probe outranks any name guess.
# ============================================================================

EFFORT_TIERS = ("off", "low", "medium", "high", "max")
_EFFORT_RULES_FILENAME = "effort-capabilities.json"
_EFFORT_BUILTIN_ARTIFACT = (
    Path(__file__).resolve().parent / "studio" / "config" / "effort-capabilities.builtin.json"
)

# Graded prose for a model with no request-parameter knob. Mirrors
# packages/core/src/ai/effort/emulation.ts — the SAME words, so a tier means the
# same thing whichever surface asked for it. `off` is absent on purpose: the
# honest emulation of "do not deliberate" is silence, not a plea to think less.
_EFFORT_EMULATION = {
    "low": "Answer efficiently: keep your reasoning brief and give a direct response.",
    "medium": (
        "Think through the problem for a moment before answering, but keep the "
        "deliberation short."
    ),
    "high": (
        "Think carefully before you answer: consider edge cases, check your own "
        "reasoning, and only respond once you are confident it is correct. Do not "
        "shortcut this."
    ),
    "max": (
        "Reason through this as thoroughly as you can before answering: enumerate the "
        "alternatives, check your logic step by step, and only give your final answer "
        "once you have verified it. Do not rush to a conclusion."
    ),
}
# Mechanisms that already carry their own trained-on prompt text; never emulate on top.
_EFFORT_OWN_PROMPT = ("system-prompt-line", "prompt-soft-switch")


def _effort_read_rules(path: Path) -> tuple[list[dict], list[str]]:
    """Parse one layer. Returns (rules, notes). A missing file is not a problem.

    Fail-soft but never silent: a malformed override is reported, because a rule
    the user believes is in force but which was dropped is worse than no override."""
    if not path.exists():
        return [], []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return [], [f"{path}: not valid JSON — {e}"]
    # A file that declares no `rules` key declares NOTHING — an empty layer, not an error.
    # `parseEffortRules` draws that line (`list === undefined` returns no errors; only a
    # PRESENT-but-wrong-typed `rules` is refused) and this reported a spurious warning for the
    # same file, so `{"$comment": "..."}` was a clean config on one surface and a complaint on
    # the other.
    rules = raw.get("rules", _EFFORT_MISSING) if isinstance(raw, dict) else raw
    if rules is _EFFORT_MISSING or rules is None:
        return [], []
    if not isinstance(rules, list):
        return [], [f'{path}: expected "rules" to be an array']
    out, notes = [], []
    for i, r in enumerate(rules):
        err = _effort_validate_rule(r, i)
        if err:
            notes.append(f"{path}: {err}")
            continue
        out.append(r)
    return out, notes


# Every mechanism `_effort_build_patch` can actually build a patch for. A file naming
# anything else must be REFUSED, not accepted: an unknown mechanism falls through to
# `{"kind": "none"}`, so the tier reads as applied while nothing goes on the wire —
# the exact silent success this whole subsystem exists to prevent.
_EFFORT_MECHANISMS = (
    "effort-enum", "token-budget", "native-graded", "binary-toggle", "template-kwarg",
    "system-prompt-line", "prompt-soft-switch", "always-on", "none",
)
# Mechanisms whose patch is a BODY field: without `field` they silently emit nothing.
_EFFORT_NEEDS_FIELD = ("effort-enum", "native-graded", "binary-toggle", "token-budget")


def _effort_validate_rule(r, i: int) -> Optional[str]:
    """Validate ONE rule. Returns None when it is usable, else the reason it was refused.

    Deliberately the SAME strictness as `rule-store.ts`'s `parseRule`. Two parsers with
    different standards is worse than one: an override the TypeScript hosts reject but
    Python accepts means `/think high` means different things in Studio and in the Python
    CLI, on the same machine, with the same file."""
    at = f"rule[{i}]"
    if not isinstance(r, dict):
        return f"{at}: not an object"
    rid = r.get("id")
    if not isinstance(rid, str) or not rid.strip():
        return f'{at}: missing "id"'
    if not isinstance(r.get("match"), dict):
        return f'{at} ({rid}): missing "match" object'
    cap = r.get("cap")
    if not isinstance(cap, dict):
        return f'{at} ({rid}): missing "cap" object'

    mech = cap.get("mechanism")
    if not isinstance(mech, str) or mech not in _EFFORT_MECHANISMS:
        return f"{at} ({rid}): unknown mechanism {json.dumps(mech)}"

    sup = cap.get("supported")
    if not isinstance(sup, list) or not all(isinstance(t, str) for t in sup):
        return f"{at} ({rid}): supported must be an array of strings"
    for t in sup:
        if t not in EFFORT_TIERS:
            return f"{at} ({rid}): unknown tier {json.dumps(t)}"

    if mech in _EFFORT_NEEDS_FIELD and not isinstance(cap.get("field"), str):
        return f'{at} ({rid}): mechanism "{mech}" requires a "field"'
    if mech == "template-kwarg" and not isinstance(cap.get("kwarg"), str):
        return f'{at} ({rid}): mechanism "template-kwarg" requires a "kwarg"'

    # `.get(key, _MISSING)` rather than `.get(key)`: an explicit `"modelIdRegex": null`
    # is a MALFORMED rule, not an absent key. Collapsing the two made Python accept a rule
    # `rule-store.ts` refuses (`if (rx !== undefined)` there), and the accepted rule then
    # matched on runtime alone — one file, two readers, two meanings.
    prefix = r["match"].get("modelIdPrefix", _EFFORT_MISSING)
    if prefix is not _EFFORT_MISSING and not isinstance(prefix, str):
        # `str.startswith` coerces nothing but `_effort_matches` compares with `in`/startswith
        # on a value the file supplied; a non-string there matches by accident instead of being
        # refused, which is how a typo becomes a silent rule.
        return f"{at} ({rid}): modelIdPrefix must be a string"

    # Every SUPPORTED tier must actually produce a patch. The `field`/`kwarg` checks above catch
    # two shapes of this and no more: `effort-enum` with a field and no `enumMap`, `token-budget`
    # with no `budgetMap`, a `promptMap` covering half its own `supported` — each parses,
    # resolves, reports the tier as applied, and sends nothing. Asking the real patch builder is
    # the only check that cannot drift from what the builder does. Mirrors rule-store.ts.
    dead = [t for t in sup if _effort_build_patch(t, cap, None).get("kind") == "none"]
    if dead:
        return (f"{at} ({rid}): mechanism \"{mech}\" produces nothing for "
                + ", ".join(json.dumps(t) for t in dead)
                + " — the tier would report as applied while no setting reaches the model")

    rx = r["match"].get("modelIdRegex", _EFFORT_MISSING)
    if rx is not _EFFORT_MISSING:
        if not isinstance(rx, str):
            return f"{at} ({rid}): modelIdRegex must be a string"
        try:
            re.compile(_js_regex_to_py(rx), re.I)
        except re.error:
            return f"{at} ({rid}): modelIdRegex is not a valid regular expression"
    return None


_EFFORT_MISSING = object()  # sentinel: "key absent" is not "key present and null"

# JavaScript spells a named group `(?<name>…)`; Python spells it `(?P<name>…)`. Everything
# else these rules use (classes, alternation, lookahead, lookbehind) is identical in both.
# `(?<=` and `(?<!` are lookbehind in BOTH dialects and must NOT be rewritten, hence the
# `[A-Za-z_]` guard on the first character of the name.
_JS_NAMED_GROUP = re.compile(r"\(\?<(?=[A-Za-z_])")


def _js_regex_to_py(rx: str) -> str:
    """The rule table's regexes are JavaScript source; this is the ONE translation point.

    The overlap is near-total for the constructs these rules use, but it is NOT total, and
    the gap is not academic: overrides come from a user-written file that BOTH this reader
    and `rule-store.ts` parse. A construct one dialect compiles and the other rejects means
    the same file silently means two different things on two surfaces — the exact split this
    module exists to prevent. Named groups are the one mechanically translatable case; the
    rest (a unicode-property escape, an empty `[]` class) still raise, and raising is correct — a REPORTED
    refusal is fine, a silent divergence is not."""
    return _JS_NAMED_GROUP.sub("(?P<", rx)


def effort_rules(cwd: Optional[Path] = None) -> tuple[list[dict], list[str]]:
    """The effective table: builtins, then the user layer, then the project layer."""
    notes: list[str] = []
    rules, n = _effort_read_rules(_EFFORT_BUILTIN_ARTIFACT)
    notes += n
    if not rules:
        notes.append(
            f"{_EFFORT_BUILTIN_ARTIFACT.name} is missing or empty — "
            "run `node studio/scripts/emit-effort-rules.mjs`"
        )
    user, n = _effort_read_rules(HOME / ".prometheus" / _EFFORT_RULES_FILENAME)
    notes += n
    proj: list[dict] = []
    if os.environ.get("PROM_NO_PROJECT_CONFIG") != "1":
        d = (cwd or Path.cwd()).resolve()
        stop = HOME.resolve()
        user_path = (HOME / ".prometheus" / _EFFORT_RULES_FILENAME).resolve()
        while True:
            cand = d / ".prometheus" / _EFFORT_RULES_FILENAME
            # Running from $HOME itself makes the project candidate BE the user layer. Loading
            # it again duplicated every rule and every diagnostic — the same override reported
            # twice, and a `notes` list that made one malformed rule look like two.
            if cand.exists() and cand.resolve() != user_path:
                proj, n = _effort_read_rules(cand); notes += n; break
            if d == stop or d.parent == d:
                break
            d = d.parent
    return rules + user + proj, notes


def effort_runtime_from_base_url(base_url: str, locality: Optional[str] = None) -> str:
    """Classify an endpoint URL into a runtime. Ports are the reliable local signal.

    Never returns "ollama-native": port 11434 answers BOTH the /v1 shim and the
    native /api/chat, and they take different knobs, so guessing would put a
    top-level `think` on an OpenAI-shaped body.

    `locality` defaults to None, NOT to "local": the TypeScript twin treats an absent
    locality as "unknown", and defaulting differently here meant the two resolvers
    classified the same URL differently — a user override matching
    `runtime: "openai-compatible"` would fire on one surface and not the other."""
    u = base_url.lower()
    if "11434" in u:
        return "ollama"
    if "1234" in u:
        return "lmstudio"
    if "8080" in u:
        return "llamacpp"
    if "8000" in u:
        return "vllm"
    if "api.openai.com" in u:
        return "openai"
    if "anthropic.com" in u:
        return "anthropic"
    if "googleapis.com" in u or "generativelanguage" in u:
        return "gemini"
    return "openai-compatible" if locality == "local" else "unknown"


def _effort_specificity(m: dict) -> int:
    """More constraints = more specific; a PROBE outranks a name, because a model id
    is a guess and a probe is an answer. Mirrors rules.ts exactly."""
    n = 0
    if m.get("runtime"): n += 2
    if m.get("capability"): n += 8
    if m.get("capabilityAbsent"): n += 8
    if m.get("modelIdPrefix"): n += 3
    if m.get("modelIdRegex"): n += 3
    if m.get("locality"): n += 1
    return n


def _effort_matches(m: dict, model_id: str, runtime: Optional[str],
                    locality: Optional[str], probed: Optional[list]) -> bool:
    if m.get("runtime") and m["runtime"] != runtime:
        return False
    if m.get("locality") and m["locality"] != locality:
        return False
    if "capability" in m:
        if probed is None or m["capability"] not in probed:
            return False
    if "capabilityAbsent" in m:
        if probed is None or m["capabilityAbsent"] in probed:
            return False
    lid = model_id.lower()
    if m.get("modelIdPrefix") and not lid.startswith(str(m["modelIdPrefix"]).lower()):
        return False
    if m.get("modelIdRegex"):
        if not re.search(_js_regex_to_py(m["modelIdRegex"]), lid, re.I):
            return False
    return True


_EFFORT_UNKNOWN_CAP = {"mechanism": "none", "supported": [],
                       "note": "no reasoning control is known for this model"}


def effort_capability(model_id: str, runtime: Optional[str] = None,
                      locality: Optional[str] = None,
                      probed: Optional[list] = None,
                      rules: Optional[list[dict]] = None) -> tuple[Optional[dict], dict]:
    """Pick the winning rule. Highest specificity wins; a TIE goes to the LATER rule,
    which is what makes an appended user/workspace override an override."""
    table = rules if rules is not None else effort_rules()[0]
    best, best_score = None, -1
    for r in table:
        if not _effort_matches(r.get("match", {}), model_id, runtime, locality, probed):
            continue
        s = _effort_specificity(r["match"])
        if s >= best_score:
            best, best_score = r, s
    if best is None:
        return None, dict(_EFFORT_UNKNOWN_CAP)
    cap = dict(best["cap"])
    # Normalise `supported` into ladder order so the clamp below is predictable.
    cap["supported"] = [t for t in EFFORT_TIERS if t in cap.get("supported", [])]
    return best, cap


def _effort_nearest(want: str, supported: list[str]) -> Optional[str]:
    """Closest supported tier. Ties break DOWNWARD — silently spending more of the
    user's money (or their laptop's battery) is the worse surprise.

    EXCEPT across the off/on boundary. `off` is a MODE, not the bottom of the ladder:
    on a two-value switch (`["off", "medium"]` — Qwen3's `/think` vs `/no_think`) `low`
    is equidistant from both ends, and the plain downward tie-break resolved it to
    `off`, so asking for a LITTLE thinking turned thinking off entirely. Distance is
    the right metric among degrees of thinking and the wrong one across that line.
    Mirrors `nearestTier` in ai/effort/types.ts."""
    if not supported:
        return None
    if want in supported:
        return want
    pool = supported
    if want != "off" and any(t != "off" for t in supported):
        pool = [t for t in supported if t != "off"]
    target = EFFORT_TIERS.index(want)
    best, best_d = None, 1 << 30
    for t in pool:
        d = abs(EFFORT_TIERS.index(t) - target)
        if d < best_d:
            best, best_d = t, d
    return best


def effort_resolve(tier: str, cap: dict, max_tokens: Optional[int] = None,
                   force: bool = False) -> dict:
    """What `tier` actually means for this model.

    Returns {requested, applied, mechanism, patch, degraded, emulation}. `applied`
    is the tier IN FORCE by any route — a tier carried by prose has an empty patch
    and is still applied, because an instruction is in front of the model and the
    answer will differ. `applied: None` means genuinely nothing is happening."""
    if tier not in EFFORT_TIERS:
        # TypeScript makes this a compile error (`EffortTier` is a union); Python has no such
        # guard, and the forced path indexes a fixed vocabulary — so an out-of-ladder tier used
        # to raise KeyError out of a function whose entire contract is that it never throws at
        # a transport. Refuse cleanly instead.
        return {"requested": tier, "applied": None, "mechanism": cap.get("mechanism", "none"),
                "patch": {"kind": "none"},
                "degraded": {"reason": "no-capability",
                             "message": f"{tier!r} is not a reasoning-effort tier "
                                        f"(expected one of {', '.join(EFFORT_TIERS)})"},
                "emulation": None, "constraints": cap.get("constraints")}
    mech = cap.get("mechanism", "none")
    supported = cap.get("supported", [])
    note = cap.get("note")

    def _forced(why: str) -> dict:
        vocab = {"off": "none", "low": "low", "medium": "medium", "high": "high", "max": "max"}
        return {"requested": tier, "applied": tier, "mechanism": mech,
                "patch": {"kind": "body", "path": "reasoning_effort", "value": vocab[tier]},
                "degraded": {"reason": "forced",
                             "message": f"{why}; sent anyway because effort forcing is on — "
                                        "the provider may reject this request"},
                "emulation": None, "constraints": cap.get("constraints")}

    if mech == "always-on":
        if force:
            return _forced(note or "this model always reasons at a fixed depth")
        return {"requested": tier, "applied": None, "mechanism": mech,
                "patch": {"kind": "none"},
                "degraded": {"reason": "always-on",
                             "message": note or "this model always reasons at a fixed depth"},
                "emulation": None, "constraints": cap.get("constraints")}

    if mech == "none" or not supported:
        if force:
            return _forced(note or "this model has no reasoning control")
        emu = _EFFORT_EMULATION.get(tier)
        if emu:
            return {"requested": tier, "applied": tier, "mechanism": mech,
                    "patch": {"kind": "none"},
                    "degraded": {"reason": "emulated",
                                 "message": f"{note or 'this model has no reasoning control'}; "
                                            "using step-by-step prompting"},
                    "emulation": {"via": "prompt-cot", "text": emu},
                    "constraints": cap.get("constraints")}
        reason = "runtime-ignores" if (note and "ignores" in note) else "no-capability"
        return {"requested": tier, "applied": None, "mechanism": mech,
                "patch": {"kind": "none"},
                "degraded": {"reason": reason,
                             "message": note or "this model has no reasoning control"},
                "emulation": None, "constraints": cap.get("constraints")}

    applied = _effort_nearest(tier, supported)
    if applied is None:
        return {"requested": tier, "applied": None, "mechanism": mech,
                "patch": {"kind": "none"},
                "degraded": {"reason": "no-capability",
                             "message": note or "this model has no reasoning control"},
                "emulation": None, "constraints": cap.get("constraints")}

    degraded = None
    if applied != tier:
        degraded = {"reason": "tier-clamped",
                    "message": (f"{note}; {tier} served as {applied}" if note
                                else f"{tier} is not available on this model; served as {applied}")}

    patch = _effort_build_patch(applied, cap, max_tokens)
    if cap.get("optimistic") and degraded is None:
        degraded = {"reason": "runtime-ignores",
                    "message": note or "this runtime may ignore the setting depending on the model template"}
    emu = _EFFORT_EMULATION.get(tier) if cap.get("optimistic") else None
    return {"requested": tier, "applied": applied, "mechanism": mech, "patch": patch,
            "degraded": degraded,
            "emulation": {"via": "prompt-cot", "text": emu} if emu else None,
            "constraints": cap.get("constraints")}


def _effort_build_patch(tier: str, cap: dict, max_tokens: Optional[int]) -> dict:
    mech = cap.get("mechanism")
    field = cap.get("field")
    if mech in ("effort-enum", "native-graded"):
        if not field:
            return {"kind": "none"}
        if tier == "off" and cap.get("offValue") is not None:
            return {"kind": "body", "path": field, "value": cap["offValue"]}
        v = (cap.get("enumMap") or {}).get(tier)
        return {"kind": "none"} if v is None else {"kind": "body", "path": field, "value": v}
    if mech == "binary-toggle":
        if not field:
            return {"kind": "none"}
        on = cap["onValue"] if cap.get("onValue") is not None else True
        off = cap["offValue"] if cap.get("offValue") is not None else False
        return {"kind": "body", "path": field, "value": off if tier == "off" else on}
    if mech == "token-budget":
        if not field:
            return {"kind": "none"}
        b = cap.get("budgetBounds") or {}
        if tier == "off":
            dis = b.get("disableWith")
            return {"kind": "none"} if dis is None else {"kind": "body", "path": field, "value": dis}
        n = (cap.get("budgetMap") or {}).get(tier)
        if n is None:
            return {"kind": "none"}
        if b:
            n = min(max(n, b.get("min", n)), b.get("max", n))
        if (cap.get("constraints") or {}).get("budgetUnderMaxTokens") and max_tokens is not None:
            n = min(n, max(1, max_tokens - 1))
        return {"kind": "body", "path": field, "value": n}
    if mech == "template-kwarg":
        kw = cap.get("kwarg")
        return {"kind": "none"} if not kw else {"kind": "kwarg", "name": kw, "value": tier != "off"}
    if mech in ("system-prompt-line", "prompt-soft-switch"):
        text = (cap.get("promptMap") or {}).get(tier)
        if text is None:
            return {"kind": "none"}
        return {"kind": "prompt", "slot": cap.get("promptSlot") or "system-append", "text": text}
    return {"kind": "none"}


def _effort_set_path(obj: dict, path: str, value) -> None:
    """Set a dotted path, creating intermediate dicts but PRESERVING existing ones —
    `generationConfig.thinkingConfig.thinkingBudget` must not wipe a temperature
    already sitting in `generationConfig`."""
    parts = path.split(".")
    cur = obj
    for k in parts[:-1]:
        if not isinstance(cur.get(k), dict):
            cur[k] = {}
        cur = cur[k]
    cur[parts[-1]] = value


def effort_apply(body: dict, res: Optional[dict]) -> dict:
    """Apply a resolution's BODY/KWARG patch to an outgoing request. Returns a NEW dict.
    A prompt-shaped patch belongs to the message list — see `effort_apply_messages`."""
    if not res:
        return dict(body)
    out = dict(body)
    cons = res.get("constraints") or {}
    if cons.get("noTemperature"):
        out.pop("temperature", None)
    p = res.get("patch") or {}
    if p.get("kind") == "body":
        value = p["value"]
        if cons.get("budgetUnderMaxTokens") and isinstance(out.get("max_tokens"), int) \
                and isinstance(value, int):
            value = min(value, max(1, out["max_tokens"] - 1))
        _effort_set_path(out, p["path"], value)
    elif p.get("kind") == "kwarg":
        prev = out.get("chat_template_kwargs")
        out["chat_template_kwargs"] = {**(prev if isinstance(prev, dict) else {}),
                                       p["name"]: p["value"]}
    if cons.get("pinTemperature") is not None:
        out["temperature"] = cons["pinTemperature"]
    if cons.get("minMaxTokens") is not None:
        cur = out.get("max_tokens")
        if isinstance(cur, int) and 0 < cur < cons["minMaxTokens"]:
            out["max_tokens"] = cons["minMaxTokens"]
    return out


def effort_apply_messages(messages: list[dict], res: Optional[dict]) -> list[dict]:
    """Apply the PROMPT half: a trained-on literal (gpt-oss `Reasoning: high`, Qwen3
    `/think`) or the emulation nudge for a model with no parameter at all."""
    if not res:
        return list(messages)
    out = [dict(m) for m in messages]
    p = res.get("patch") or {}
    text, slot = None, "system-append"
    if p.get("kind") == "prompt":
        text, slot = p["text"], p.get("slot", "system-append")
    elif res.get("emulation") and res["mechanism"] not in _EFFORT_OWN_PROMPT:
        text = res["emulation"]["text"]
    if not text:
        return out
    if slot == "system-append":
        for m in out:
            if m.get("role") == "system":
                m["content"] = f"{m.get('content', '')}\n{text}".strip()
                return out
        out.insert(0, {"role": "system", "content": text})
        return out
    for m in reversed(out):
        if m.get("role") == "user":
            m["content"] = f"{m.get('content', '')} {text}".strip()
            return out
    return out


def _effort_split_reasoning(text: str, tag: Optional[str]) -> tuple[str, str]:
    """Split inline `<tag>…</tag>` deliberation out of a completion. Returns (visible, thinking).

    The Python twin of `ai/effort/reasoning-tag.ts`, minus the streaming state machine: this
    reader is non-streaming (`"stream": False`), so the whole body is in hand and a single pass
    is enough. The SEMANTICS are the ones that module fixed and must match it exactly —
    including the last rule, which is the non-obvious one:

      an UNTERMINATED open tag flushes as THINKING, not as text. A model cut off mid-thought
      was still thinking, and promoting a truncated deliberation to "the answer" is the exact
      failure this splits out.

    `reasoningTag` has been in the capability table since it was written and has been read by
    four TypeScript surfaces (backends.ts, agent-runtime.ts, ai-ipc.ts, the VS Code client) and
    by nothing here — so `prometheus chat --local` on an R1-style model printed paragraphs of
    deliberation as the answer, and in the REPL fed them back as assistant context every turn."""
    if not tag or not text:
        return text, ""
    open_t, close_t = f"<{tag}>", f"</{tag}>"
    visible, thinking, rest, inside = [], [], text, False
    while rest:
        needle = close_t if inside else open_t
        at = rest.find(needle)
        if at < 0:
            (thinking if inside else visible).append(rest)
            break
        (thinking if inside else visible).append(rest[:at])
        rest = rest[at + len(needle):]
        inside = not inside
    return "".join(visible), "".join(thinking)


def effort_probe_capabilities(base_url: str, model: str, timeout: float = 2.5) -> Optional[list]:
    """Ask an Ollama daemon what this model can do (`/api/show` -> `capabilities`).

    This is what makes the difference between `/think` working and reporting "not
    available": the probe-driven rules outrank every model-name guess, deliberately,
    because reasoning support is version-scoped (Gemma 2/3 cannot think, Gemma 4 can).

    LOCAL ONLY and bounded: a wedged runner that accepts the socket and never answers
    must not hang the caller. Returns None when the probe did not reach an Ollama."""
    import http.client, urllib.request, urllib.error
    root = base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3].rstrip("/")
    try:
        req = urllib.request.Request(
            root + "/api/show", data=json.dumps({"model": model}).encode(),
            method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read())
    except (urllib.error.URLError, http.client.HTTPException,
            OSError, ValueError, TimeoutError):
        # `http.client.HTTPException` is NOT an OSError — `IncompleteRead` and `BadStatusLine`
        # escaped every arm here and crashed the whole chat command from a best-effort probe.
        return None
    caps = payload.get("capabilities")
    if isinstance(caps, list):
        return [c for c in caps if isinstance(c, str)]
    return None


def _effort_json_block(requested: Optional[str], res: Optional[dict]) -> dict:
    """The `effort` key for a machine envelope, or {} when the user asked for nothing.

    Reports what ACTUALLY happened, not what was asked: `applied` is the tier in force by any
    route, `mechanism` says how, and `degraded` names the reason when those differ. A consumer
    that only ever saw the requested tier could not tell a working knob from an emulated one."""
    if not requested:
        return {}
    if not res:
        return {"effort": {"requested": requested, "applied": None, "mechanism": "none"}}
    d = res.get("degraded")
    return {"effort": {
        "requested": res["requested"],
        "applied": res["applied"],
        "mechanism": res["mechanism"],
        "wire": res["patch"].get("kind"),
        **({"degraded": {"reason": d["reason"], "message": d["message"]}} if d else {}),
        **({"emulated_via": res["emulation"]["via"]} if res.get("emulation") else {}),
    }}


def describe_effort(res: Optional[dict]) -> str:
    """One-line summary for `--json` and the human line. `not available` is a narrow
    claim: always-on, or `off` on a model that cannot reason at all."""
    if not res or res.get("applied") is None:
        return "not available"
    return res["applied"]


CHAT_LOCAL_ENDPOINTS = {
    "ollama":   "http://localhost:11434/v1",
    "lmstudio": "http://localhost:1234/v1",
}

# Per-CLI launch profile. ONLY real, documented flags (verified 2026-06). Each
# value is a list of argv tokens; "{x}" placeholders are substituted, never
# shell-interpolated. `headless_subcmd` = the CLI's non-interactive subcommand
# (codex exec / opencode run); else `headless_flag` (claude/gemini/cursor -p).
CHAT_CLIS: dict[str, dict] = {
    "claude": {
        "label": "Claude Code", "bin": ("claude",),
        "prompt_positional": True,
        "headless_flag": ["-p"], "model": ["--model", "{model}"], "add_dir": ["--add-dir", "{dir}"],
        "sys_append_file": ["--append-system-prompt-file", "{file}"],
        "sys_replace_file": ["--system-prompt-file", "{file}"],
        "bypass": ["--dangerously-skip-permissions"],
        "bypass_note": "bypassPermissions — Claude skips ALL write/exec confirmations (blocked under root/sudo).",
    },
    "codex": {
        "label": "OpenAI Codex CLI", "bin": ("codex",),
        "prompt_positional": True,
        "headless_subcmd": "exec", "model": ["-m", "{model}"],
        "bypass": ["-a", "never", "--sandbox", "danger-full-access"], "bypass_global": True,
        "sys_note": "Codex: put behavior in AGENTS.md or `--config experimental_instructions_file=<file>` (no append-system-prompt flag).",
        "bypass_note": "approval=never + sandbox=danger-full-access — Codex runs with NO approvals.",
    },
    "gemini": {
        "label": "Gemini CLI", "bin": ("gemini",),
        "headless_flag": ["-p"], "model": ["-m", "{model}"],
        "sys_env": "GEMINI_SYSTEM_MD",
        "bypass": ["--yolo"],
        "bypass_note": "--yolo — auto-approves ALL tool executions.",
    },
    "cursor": {
        "label": "Cursor Agent", "bin": ("cursor-agent", "cursor"),
        "prompt_positional": True,
        "headless_flag": ["-p"], "model": ["-m", "{model}"],
        "bypass": ["--force"],
        "sys_note": "Cursor: behavior via .cursor/rules (no append-system-prompt flag).",
        "bypass_note": "--force (yolo) — applies edits without confirmation.",
    },
    "opencode": {
        "label": "OpenCode", "bin": ("opencode",),
        "prompt_positional": True,
        "headless_subcmd": "run", "model": ["-m", "{model}"],
        "bypass": [],
        "sys_note": "OpenCode: behavior via opencode.json (set permission: allow; no single bypass flag).",
        "bypass_note": "OpenCode has no single bypass flag — set permission:allow in opencode.json.",
    },
}


def build_terminal_cmd(service: str, *, model: Optional[str] = None,
                       system_prompt_file: Optional[str] = None, replace_system: bool = False,
                       bypass: bool = False, prompt: Optional[str] = None,
                       cwd: Optional[str] = None) -> tuple[list[str], dict[str, str], list[str]]:
    """Assemble a validated argv for a terminal-chat CLI. Returns (argv, env_overrides, notes).

    Pure + injection-safe: every token is appended discretely (no shell string),
    so a prompt/model/path can never break out into another command.
    """
    spec = CHAT_CLIS.get(service)
    if not spec:
        raise RuntimeError(f"unknown chat CLI '{service}'. Choose: {', '.join(CHAT_CLIS)}")
    binary = next((b for b in spec["bin"] if shutil.which(b)), None)
    notes: list[str] = []
    if not binary:
        binary = spec["bin"][0]
        notes.append(f"'{binary}' not found on PATH — install it first (the command is still shown below)")
    argv: list[str] = [binary]
    env: dict[str, str] = {}

    # global (pre-subcommand) bypass tokens, e.g. codex -a never -s danger-full-access exec ...
    if bypass and spec.get("bypass_global"):
        argv += list(spec.get("bypass", []))
    # non-interactive subcommand (codex exec / opencode run) vs headless flag (claude/gemini/cursor -p)
    if prompt is not None:
        if spec.get("headless_subcmd"):
            argv.append(spec["headless_subcmd"])
        elif spec.get("headless_flag"):
            argv += list(spec["headless_flag"])
    # model — reject a leading-dash value: model ids never start with '-', and as a
    # flag VALUE (e.g. `-m -x`) a dash-leading token can be mis-parsed as another flag.
    if model and model.startswith("-"):
        raise RuntimeError(f"refusing model id that starts with '-' (option-injection guard): {model}")
    if model and spec.get("model"):
        argv += [t.replace("{model}", model) for t in spec["model"]]
    # post-subcommand bypass tokens (claude/gemini/cursor)
    if bypass and not spec.get("bypass_global"):
        if spec.get("bypass"):
            argv += list(spec["bypass"])
        else:
            notes.append(spec.get("bypass_note", "this CLI has no bypass flag"))
    # working dir
    if cwd and spec.get("add_dir"):
        argv += [t.replace("{dir}", cwd) for t in spec["add_dir"]]
    elif cwd:
        notes.append(f"{service} has no --add-dir; launch from {cwd} (cwd) instead")
    # system prompt
    if system_prompt_file:
        spf = os.path.abspath(os.path.expanduser(system_prompt_file))
        if replace_system and spec.get("sys_replace_file"):
            argv += [t.replace("{file}", spf) for t in spec["sys_replace_file"]]
        elif spec.get("sys_append_file"):
            argv += [t.replace("{file}", spf) for t in spec["sys_append_file"]]
        elif spec.get("sys_env"):
            env[spec["sys_env"]] = spf
            notes.append(f"system prompt via env {spec['sys_env']}={spf}")
        else:
            notes.append(spec.get("sys_note", "system-prompt injection not supported by this CLI"))
    # the prompt itself (last positional). CRITICAL: a prompt like
    # "--dangerously-skip-permissions" / "--yolo" must reach the child CLI as DATA, not
    # as a flag that silently enables a permission-bypass WITHOUT the typed-BYPASS gate.
    #   * positional-prompt CLIs (claude/codex/cursor/opencode) → a "--" end-of-options
    #     separator forces it to be the prompt operand.
    #   * value-flag CLIs (gemini -p VALUE) can't take "--" safely, and a dash-leading
    #     prompt can still smuggle a flag through the parser → reject it outright.
    if prompt is not None:
        if spec.get("prompt_positional"):
            argv.append("--")
        elif prompt.startswith("-"):
            raise RuntimeError(
                "refusing a prompt that starts with '-' for this CLI (option-injection "
                "guard); rephrase so it does not begin with a dash")
        argv.append(prompt)
    if bypass:
        notes.append("⚠ " + spec.get("bypass_note", "permissions bypassed"))
    return argv, env, notes


def _tmux_launch(session: str, argv: list[str], env: dict[str, str]) -> None:
    """Spawn argv detached inside a named tmux session ('let it run' / leave-PC),
    then attach. Uses shlex.join for a safe one-string command tmux re-parses."""
    import shlex
    prefix = "".join(f"{k}={shlex.quote(v)} " for k, v in env.items())
    cmdstr = prefix + shlex.join(argv)
    # create only if missing, then attach
    if _run_timed(["tmux", "has-session", "-t", session], capture_output=True, timeout=10).returncode != 0:
        _run_timed(["tmux", "new-session", "-d", "-s", session, cmdstr], check=True, timeout=30)
        Log.ok(f"tmux session '{session}' started (detached) — running: {cmdstr}")
    else:
        Log.info(f"tmux session '{session}' already exists — attaching")
    Log.step(f"detach with Ctrl-b d · reattach later: tmux attach -t {session}")
    os.execvp("tmux", ["tmux", "attach", "-t", session])


def _ensure_ollama_daemon() -> bool:
    """Start the ollama daemon if it's down so local chat can reach it. `brew install
    ollama` installs only the CLI; the background server must be running. Probe
    /api/version and, if unreachable, spawn `ollama serve` DETACHED (outlives this
    process) and wait briefly. Best-effort — returns whether the daemon is reachable."""
    root = CHAT_LOCAL_ENDPOINTS["ollama"].rsplit("/v1", 1)[0]

    def reachable(timeout: float = 1.0) -> bool:
        try:
            with urllib.request.urlopen(root + "/api/version", timeout=timeout) as r:  # noqa: S310
                return int(getattr(r, "status", 200)) < 500
        except Exception:  # noqa: BLE001 — any failure ⇒ not reachable
            return False

    if reachable():
        return True
    ollama = shutil.which("ollama")
    if not ollama:
        return False  # not installed → let ask() surface the graceful install hint
    kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
                    "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED | NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen([ollama, "serve"], **kwargs)  # noqa: S603 — fixed argv, no shell
    except OSError:
        return False
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if reachable(0.5):
            return True
        time.sleep(0.4)
    return False


def chat_local(model: str, prompt: Optional[str], runner: str = "ollama",
               effort: Optional[str] = None, force_effort: bool = False) -> int:
    """Agentic local chat: talk to a local OpenAI-compatible server (no cloud, no
    cost). One-shot if `prompt` given, else a small REPL. Fails gracefully if the
    runner isn't up."""
    import http.client, urllib.request, urllib.error
    base = CHAT_LOCAL_ENDPOINTS.get(runner)
    if not base:
        Log.err(f"unknown runner '{runner}'. Choose: {', '.join(CHAT_LOCAL_ENDPOINTS)}"); return 2
    url = base + "/chat/completions"
    if runner == "ollama":
        _ensure_ollama_daemon()  # best-effort: start the daemon if the user only has the CLI

    # ── the `/think` ladder ────────────────────────────────────────────────────
    # Resolve ONCE per session, not per turn: the capability is a property of the
    # endpoint, and the probe is a network round trip. `None` means the user asked
    # for nothing, and nothing is what goes on the wire.
    eff_res = None
    # Resolved whether or not a tier was asked for. The capability carries `reasoningTag` as
    # well as the knob, and an R1-style model wraps its thinking in `<think>` on EVERY turn —
    # tier or no tier — so gating this on `--effort` left the deliberation in the answer.
    # The Ollama PROBE stays gated: it is a network round-trip and only the knob needs it.
    rules, eff_notes = effort_rules()
    probed = effort_probe_capabilities(base, model) if (effort and runner == "ollama") else None
    _, cap = effort_capability(model, effort_runtime_from_base_url(base, "local"),
                               "local", probed, rules)
    reasoning_tag = cap.get("reasoningTag")
    if effort:
        for n in eff_notes:
            Log.warn(f"effort rules: {n}")
        eff_res = effort_resolve(effort, cap, force=force_effort)
        if not JSON_OUT:
            d = eff_res.get("degraded")
            if eff_res.get("applied") is None:
                Log.warn(f"think → {effort} (not available — {d['message'] if d else 'no reasoning control'})")
            elif d and d["reason"] == "emulated":
                Log.info(f"think → {eff_res['applied']} (emulated — {d['message']})")
            elif d:
                Log.info(f"think → {eff_res['applied']} ({d['message']})")
            else:
                Log.info(f"think → {eff_res['applied']}")

    # A one-slot box for out-of-band facts about the LAST turn: `ask` returns only the visible
    # answer, and the JSON envelope still needs the deliberation it split off.
    last: dict = {}

    def ask(msgs: list[dict]) -> Optional[str]:
        # The prompt half first (a trained-on literal, or the emulation nudge), then
        # the body half — so a knobless model still gets the tier, in words.
        sent = effort_apply_messages(msgs, eff_res) if eff_res else msgs
        payload = effort_apply({"model": model, "messages": sent, "stream": False}, eff_res)
        body = json.dumps(payload).encode()
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer local"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.loads(r.read())
            content = data["choices"][0]["message"]["content"]
            visible, thinking = _effort_split_reasoning(content, reasoning_tag)
            if thinking:
                last["thinking"] = thinking
                if not JSON_OUT:
                    Log.info(f"({len(thinking)} chars of <{reasoning_tag}> reasoning hidden — -v to show)")
                    Log.debug(thinking)
            return visible
        except urllib.error.HTTPError as e:
            # MUST precede the URLError arm: HTTPError SUBCLASSES URLError, so every HTTP status
            # from a perfectly reachable server was being reported as "cannot reach the server"
            # — with a "start it: ollama serve" hint — while the body that says what actually
            # went wrong (an unknown model, a rejected `reasoning_effort` value) was discarded.
            detail = ""
            try:
                raw = e.read().decode("utf-8", "replace")[:600]
                try:
                    err = json.loads(raw).get("error")
                    detail = err.get("message") if isinstance(err, dict) else str(err or "")
                except ValueError:
                    detail = raw.strip()
            except (OSError, AttributeError):
                pass
            Log.err(f"{runner} refused the request (HTTP {e.code}){': ' + detail if detail else ''}")
            if e.code == 404:
                Log.step(f"the server is up but does not know '{model}' — check the model name"
                         + (f" (`ollama pull {model}`)" if runner == "ollama" else ""))
            return None
        except urllib.error.URLError as e:
            Log.err(f"cannot reach the local {runner} server at {base} ({e.reason}).")
            if runner == "ollama":
                Log.step("start it: `apps install ollama` (or `ollama serve`), then `ollama pull " + model + "`")
            else:
                Log.step("open LM Studio → load a model → 'Start Server' (http://localhost:1234)")
            return None
        except (KeyError, IndexError, TypeError, ValueError, OSError,
                http.client.HTTPException) as e:  # noqa: BLE001 — never crash the chat
            # IndexError/TypeError guard an empty/malformed `choices` array (a server can
            # legitimately return `choices: []`), which would otherwise crash the turn.
            Log.err(f"unexpected response from {runner}: {e}"); return None

    if not JSON_OUT:
        Log.info(f"agentic chat — local model '{model}' via {runner} ({base}). $0, on-device.")
    if prompt is not None:
        out = ask([{"role": "user", "content": prompt}])
        if out is None:
            if JSON_OUT:
                return emit_json({"command": "chat", "ok": False, "mode": "local",
                                  "error": f"local {runner} server unreachable", "_exit": 1,
                                  **_effort_json_block(effort, eff_res)})
            return 1
        if JSON_OUT:
            # The human path prints ":: think → high (emulated — …)"; a machine consumer needs
            # the same fact or it cannot tell an applied tier from a clamped or emulated one.
            return emit_json({"command": "chat", "ok": True, "mode": "local",
                              "model": model, "runner": runner, "response": out,
                              # Removed from `response`, not destroyed: a consumer that wants the
                              # deliberation can still have it, and one that does not is no longer
                              # handed it as the answer.
                              **({"reasoning": last["thinking"]} if last.get("thinking") else {}),
                              **_effort_json_block(effort, eff_res)})
        print(out)
        return 0
    if JSON_OUT:
        return emit_json({"command": "chat", "ok": False, "mode": "local",
                          "error": "interactive REPL is not available over --json; pass a prompt", "_exit": 2})
    # REPL
    Log.step("type your message; empty line or Ctrl-D to quit")
    history: list[dict] = []
    while True:
        try:
            line = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print(); break
        if not line:
            break
        history.append({"role": "user", "content": line})
        out = ask(history)
        if out is None:
            return 1
        history.append({"role": "assistant", "content": out})
        print(f"\n{model}> {out}\n")
    return 0


def cmd_chat(args, osi: OSInfo) -> int:
    """Route to agentic (local) or terminal (paid CLI) chat, enforcing the rule."""
    prompt = " ".join(args.message).strip() if getattr(args, "message", None) else None
    if prompt == "":          # whitespace-only message == no prompt → interactive, not an empty `-p ""`
        prompt = None
    local = getattr(args, "local", None)
    cli = getattr(args, "cli", None)

    # rule: a paid/credentialed CLI cannot run as a free in-app agentic chat
    if local and local in CHAT_CLIS:
        if JSON_OUT:
            return emit_json({"command": "chat", "ok": False, "mode": "terminal",
                              "error": f"'{local}' is a paid CLI — use terminal chat (--cli {local})", "_exit": 2})
        Log.err(f"'{local}' is a paid/credentialed CLI, not a local model.")
        Log.step(f"use a terminal chat instead:  prometheus chat --cli {local} [--bypass] [--tmux] [--open]")
        return 2
    if local:
        return chat_local(local, prompt, runner=getattr(args, "runner", None) or "ollama",
                          effort=getattr(args, "effort", None),
                          force_effort=bool(getattr(args, "force_effort", False)))

    if not cli:
        if JSON_OUT:
            return emit_json({"command": "chat", "ok": True, "modes": ["local", "terminal"],
                              "clis": list(CHAT_CLIS), "runners": list(CHAT_LOCAL_ENDPOINTS)})
        Log.info("Prometheus chat — two modes:")
        Log.step("agentic (local, free):   prometheus chat --local <ollama-model> [--runner ollama|lmstudio] [\"prompt\"]")
        Log.step("terminal (paid CLI):     prometheus chat --cli <claude|codex|gemini|cursor|opencode> [--model M] [--system-prompt FILE] [--bypass] [--tmux [NAME]] [--open] [\"prompt\"]")
        Log.step("local models: `models list` / pull via `apps install ollama` then `ollama pull <m>` · default folder: `models config --show`")
        return 0

    # ---- terminal chat (paid CLI) ----
    # `--effort` is an AGENTIC-mode knob: a terminal chat hands the conversation to another
    # vendor's CLI, which owns its own reasoning settings and takes none of ours. Accepting the
    # flag and doing nothing with it is the silent no-op this subsystem exists to eliminate, so
    # say so rather than let the user believe a tier is in force.
    if getattr(args, "effort", None) or getattr(args, "force_effort", False):
        if JSON_OUT:
            return emit_json({"command": "chat", "ok": False, "mode": "terminal",
                              "error": "--effort/--force-effort apply to agentic mode only "
                                       f"(--local); '{cli}' owns its own reasoning settings",
                              "_exit": 2})
        Log.err(f"--effort applies to agentic mode only; '{cli}' owns its own reasoning settings.")
        Log.step(f"agentic:  prometheus chat --local <model> --effort <tier>   ·   "
                 f"terminal: prometheus chat --cli {cli}   (set effort inside that CLI)")
        return 2
    bypass = bool(getattr(args, "bypass", False))
    sysf = getattr(args, "system_prompt", None)
    argv, env, notes = build_terminal_cmd(
        cli, model=getattr(args, "model", None),
        system_prompt_file=sysf, replace_system=bool(getattr(args, "replace_system", False)),
        bypass=bypass, prompt=prompt, cwd=getattr(args, "cwd", None))
    spec = CHAT_CLIS[cli]
    use_tmux = getattr(args, "tmux", None) is not None
    session = (getattr(args, "tmux", None) or f"prom-{cli}") if use_tmux else None

    # JSON preview (the GUI parses this to render the settings preview before OPEN)
    if JSON_OUT:
        if getattr(args, "open", False):
            return emit_json({"command": "chat", "ok": False, "mode": "terminal",
                              "error": "launching a live terminal is interactive — not available over --json", "_exit": 2})
        return emit_json({"command": "chat", "ok": True, "mode": "terminal", "cli": cli,
                          "label": spec["label"], "argv": argv, "env": env, "notes": notes,
                          "bypass": bypass, "tmux": session, "interactive": prompt is None,
                          "model": getattr(args, "model", None),
                          "cwd": os.path.abspath(os.path.expanduser(getattr(args, "cwd", None) or "~"))})

    # PREVIEW (the GUI "settings" the user reviews before clicking OPEN)
    Log.head(f"Terminal chat — {spec['label']}")
    import shlex
    envstr = "".join(f"{k}={shlex.quote(v)} " for k, v in env.items())   # quote values so a spaced/metachar path reads as one arg
    Log.info("command:  " + envstr + shlex.join(argv))
    Log.step(f"model: {getattr(args,'model',None) or '(CLI default)'}  ·  mode: {'headless/one-shot' if prompt is not None else 'interactive'}"
             f"  ·  bypass: {'YES' if bypass else 'no'}  ·  tmux: {session or 'no'}")
    if sysf:
        Log.step(f"system prompt: {os.path.abspath(os.path.expanduser(sysf))} ({'replace' if getattr(args,'replace_system',False) else 'append'})")
    for n in notes:
        Log.warn(n)

    if not getattr(args, "open", False):
        Log.ok("preview only — add --open to launch (the OPEN button)")
        return 0

    # OPEN: gate dangerous toggles
    if bypass and not ASSUME_YES:
        Log.warn("BYPASS PERMISSIONS will let the agent act WITHOUT confirmations.")
        try:
            if input("type BYPASS to confirm: ").strip() != "BYPASS":
                Log.err("not confirmed — aborting"); return 2
        except (EOFError, KeyboardInterrupt):
            print(); return 2
    if sysf and not os.path.exists(os.path.expanduser(sysf)):
        Log.err(f"system-prompt file not found: {sysf}"); return 2
    if DRY_RUN:
        Log.ok("[dry-run] would launch the command above"); return 0
    if getattr(args, "cwd", None):
        try:
            os.chdir(os.path.expanduser(args.cwd))
        except OSError as e:
            Log.err(f"cannot cd to {args.cwd}: {e}"); return 2
    if use_tmux:
        if not shutil.which("tmux"):
            Log.err("tmux not found — install tmux or drop --tmux"); return 2
        _tmux_launch(session, argv, env)   # execs (attach)
        return 0
    Log.ok(f"launching {spec['label']} … (this terminal becomes the chat)")
    os.execvpe(argv[0], argv, {**os.environ, **env})
    return 0  # unreachable after execvpe


# Raw argv currently being parsed — lets the JSON-aware parser detect --json BEFORE
# args are fully parsed (argparse usage errors fire mid-parse, before main() reads JSON_OUT).
_PARSE_ARGV: Optional[list[str]] = None


class _JsonAwareParser(argparse.ArgumentParser):
    """An argparse parser whose usage errors (missing/invalid args, unknown
    subcommand) honour --json: emit ONE JSON error object to stdout + exit 2,
    instead of dumping human usage to stderr with NOTHING on the machine channel.
    Subparsers inherit this class automatically (add_subparsers' parser_class
    defaults to type(self)), so it covers every subcommand's required-arg errors."""

    def error(self, message: str):  # type: ignore[override]
        srcs = _PARSE_ARGV if _PARSE_ARGV is not None else sys.argv[1:]
        if "--json" in srcs:
            parts = self.prog.split()
            emit_json({"command": parts[-1] if len(parts) > 1 else "?",
                       "ok": False, "error": f"argument error: {message}", "_exit": 2})
            raise SystemExit(2)
        super().error(message)


def build_parser() -> argparse.ArgumentParser:
    parser = _JsonAwareParser(
        prog=f"{SCRIPT_NAME}.py",
        description="Prometheus — scan the PC for AI agents and install plugins into each.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {SCRIPT_VERSION}")
    parser.add_argument("--dry-run", action="store_true", help="print actions without changing anything")
    parser.add_argument("--verbose", action="store_true", help="echo shell commands and output")
    parser.add_argument("--force", action="store_true",
                        help="reinstall even if already present AND override a nemesis BLOCK "
                             "(dangerous code) behind a deep-red DANGER banner + typed confirmation")
    parser.add_argument("--no-color", action="store_true", help="disable colored output")
    parser.add_argument("--docs", action="store_true",
                        help="show ALL commands in detail; on a terminal, type to search/narrow "
                             "matching commands live (q to quit). Use with --json for a full dump.")
    parser.add_argument("--json", dest="json_out", action="store_true",
                        help="machine output: print ONE JSON object to stdout, route all "
                             "human/log text to stderr (for the MCP server + Ink TUI bridge)")
    # security gate flags
    parser.add_argument("--no-scan", action="store_true",
                        help="skip the built-in regex pre-install scan (discouraged). The deep "
                             "nemesis gate still runs — disable that with --no-gate/--gate-mode.")
    parser.add_argument("--yes", action="store_true", help="auto-approve non-critical findings (no prompt)")
    parser.add_argument("--strict", action="store_true", help="block install on medium-or-higher findings too")
    parser.add_argument("--force-unsafe", action="store_true", help="override a BLOCK on critical/strict findings")
    parser.add_argument("--gate-fresh", action="store_true",
                        help="bypass the nemesis verdict cache (always re-scan gated sources)")
    parser.add_argument("--show-info", action="store_true", help="also show context-suppressed (comment/doc/test/CI) matches")
    parser.add_argument("--no-gate", action="store_true",
                        help="disable the nemesis pre-install security gate for this run (same as PROMETHEUS_GATE=off)")
    parser.add_argument("--gate-mode", choices=["enforce", "warn", "off"], default=None,
                        help="nemesis gate behavior: enforce (block on threats), warn (log, proceed), off (skip)")
    # 7th functionality — Repo Vault (top-level flags, usable without a subcommand)
    parser.add_argument("--invoke", action="store_true",
                        help="7th functionality: Repo Vault WIZARD — pick repos to download as versioned ZIPs into your local 'prometheus' vault (re-pulls only when GitHub has a newer version)")
    parser.add_argument("--invoke-all", dest="invoke_all", action="store_true",
                        help="Repo Vault: skip the wizard, download the latest ZIP of EVERY repo (you only choose where the 'prometheus' folder lives)")
    parser.add_argument("--rollback", action="store_true",
                        help="Repo Vault: roll a repo back to a STORED (offline) or older GitHub version — downloads into the vault and extracts/installs it")

    sub = parser.add_subparsers(dest="command", metavar="<command>")
    p_vault = sub.add_parser("vault", help="7th functionality: offline versioned ZIP archive of every repo (invoke / invoke-all / rollback / status)")
    p_vault.add_argument("action", nargs="?",
                         choices=["list", "status", "invoke", "invoke-all", "rollback"], default="list")
    p_vault.add_argument("--target", metavar="ID",
                         help="--json: repo id(s) to invoke (comma-sep) or the rollback target")
    sub.add_parser("wizard", help="interactive terminal menu (install / uninstall / browse)")
    sub.add_parser("scan", help="detect AI agent CLIs installed on this machine")
    sub.add_parser("superscan", help="P5 super-scan: every agent installed/absent/forgotten + counts + prereqs")
    sub.add_parser("matrix", help="reach matrix — which tool can go in which agent (native/sync/no)")
    p_where = sub.add_parser("where", help="where does a tool install to? (scope + per-agent path, before installing)")
    p_where.add_argument("name", help="plugin name from `list`")
    p_purge = sub.add_parser("purge", help="back up + remove a forgotten agent's config/state (not the binary)")
    p_purge.add_argument("name", help="agent name from `superscan` (e.g. gemini)")
    p_purge.add_argument("--confirm", metavar="AGENT",
                         help="--json execute: typed-confirm token (must equal the agent name) required with --yes")
    p_sched = sub.add_parser("schedule", help="scaffold a scheduled headless watcher OR the prometheus "
                                              "auto-maintenance routine (cron/launchd) — persistence, confirm-gated")
    p_sched.add_argument("task", nargs="?", help="what the agent should do, e.g. 'run the GL reconciliation, "
                                                 "write report.md' (omit when using --auto)")
    p_sched.add_argument("--auto", action="store_true",
                         help="schedule `prometheus auto` (feeds + audit/pin + integrate green skills) "
                              "instead of a claude watcher — periodic SELF-HEALING security maintenance")
    p_sched.add_argument("--auto-off", dest="auto_off", action="store_true",
                         help="remove the auto-maintenance schedule + stop self-heal (the off-switch)")
    p_sched.add_argument("--list", action="store_true",
                         help="--json: report the present auto-maintenance schedule (no mutation)")
    p_sched.add_argument("--defang", action="store_true",
                         help="--auto only: also wipe non-official URLs each run (keep official docs)")
    p_sched.add_argument("--name", help="watcher name (default: prometheus-watcher / prometheus-auto)")
    p_sched.add_argument("--interval", type=int, help="macOS launchd StartInterval seconds "
                                                      "(default 3600; --auto default 86400 = daily)")
    p_sched.add_argument("--cron", help="Linux cron schedule (default '0 * * * *'; --auto default '0 3 * * *')")
    p_inv = sub.add_parser("inventory", help="re-scan every detected agent for ALL installed plugins/skills/MCP (managed + foreign)")
    p_inv.add_argument("--host", action="append", metavar="NAME", help="restrict to a detected agent (repeatable)")
    sub.add_parser("list", help="list registered plugins and per-agent state")
    sub.add_parser("doctor", help="check OS, agents, git, and paths")
    p_bndl = sub.add_parser("bundle", help="install the official Anthropic bundle in one run")
    p_bndl.add_argument("--host", action="append", metavar="NAME",
                        help="restrict to a detected agent (repeatable)")
    p_inst = sub.add_parser("install", help="install a plugin ('all' / 'official-bundle'); surgically with :sel / --only")
    p_inst.add_argument("name", help="plugin, 'all', 'official-bundle', or 'plugin:comp1,comp2' for a subset")
    p_inst.add_argument("--host", action="append", metavar="NAME",
                        help="restrict to a detected agent (repeatable): claude, codex, cursor, gemini")
    p_inst.add_argument("--only", metavar="LIST", help="install only these components (comma-sep sub-plugin ids)")
    p_inst.add_argument("--skip", metavar="LIST", help="install all components EXCEPT these (comma-sep)")
    p_inst.add_argument("--arm", action="store_true", help="auto-arm: write enabledPlugins + extraKnownMarketplaces so it self-fires")
    p_unin = sub.add_parser("uninstall", help="remove a plugin ('all' / 'official-bundle'); subset via :sel / --only")
    p_unin.add_argument("name", help="plugin, 'all', 'official-bundle', or 'plugin:comp1,comp2' for a subset")
    p_unin.add_argument("--host", action="append", metavar="NAME",
                        help="restrict to a detected agent (repeatable)")
    p_unin.add_argument("--only", metavar="LIST", help="remove only these components (comma-sep)")
    p_unin.add_argument("--skip", metavar="LIST", help="remove all components EXCEPT these (comma-sep)")
    p_stat = sub.add_parser("status", help="show install + enabled/disabled state of a plugin & its components")
    p_stat.add_argument("name", help="plugin name from `list`, or 'all'")
    p_en = sub.add_parser("enable", help="re-arm a disabled plugin/component (settings.json / on-disk)")
    p_en.add_argument("name", help="plugin, 'plugin:comp', or a foreign id (with --host gemini|cursor)")
    p_en.add_argument("--only", metavar="LIST", help="only these sub-plugin components (comma-sep)")
    p_en.add_argument("--component", choices=["hooks", "mcp"], help="toggle the plugin's on-disk hooks or MCP servers")
    p_en.add_argument("--host", action="append", metavar="NAME", help="target agent for a foreign item: gemini, cursor")
    p_dis = sub.add_parser("disable", help="turn off a plugin/component WITHOUT uninstalling (reversible)")
    p_dis.add_argument("name", help="plugin, 'plugin:comp', or a foreign id (with --host gemini|cursor)")
    p_dis.add_argument("--only", metavar="LIST", help="only these sub-plugin components (comma-sep)")
    p_dis.add_argument("--component", choices=["hooks", "mcp"], help="toggle the plugin's on-disk hooks or MCP servers")
    p_dis.add_argument("--host", action="append", metavar="NAME", help="target agent for a foreign item: gemini, cursor")
    p_sk = sub.add_parser("skills", help="list/enable/disable/mute installed SKILL.md folders (~/.claude/skills/); `audit` = re-scan + pin installed sources")
    p_sk.add_argument("action",
                      choices=["list", "enable", "disable", "mute", "unmute", "audit", "integrate"])
    p_sk.add_argument("skill", nargs="?", help="skill folder name (omit for `list`/`audit`/`integrate`)")
    p_sk.add_argument("--status", action="store_true",
                      help="integrate: show the LAST integration run's result (from the status "
                           "cache — what the silent startup run did) instead of running")
    p_sk.add_argument("--no-quarantine", action="store_true",
                      help="audit: detect + report drift but do not quarantine/restore")
    p_sk.add_argument("--restore", metavar="VAULT",
                      help="audit: re-instate a quarantined source from its vault dir")
    p_sk.add_argument("--list-quarantine", action="store_true",
                      help="audit: list the URL-injection quarantine vault")
    p_sk.add_argument("--defang-urls", action="store_true",
                      help="audit: WIPE every URL from all installed sources (URL-inert; "
                           "originals kept in *.nemesis.bak), then re-pin")
    p_sk.add_argument("--defang-mode", choices=["star", "remove"], default="star",
                      help="defang: star = replace URL chars with '*' (keep line); remove = drop line")
    p_sk.add_argument("--defang-scope", choices=["urls", "all"], default="urls",
                      help="defang: urls = http(s)+obfuscated; all = also IOC bare domains/IPs")
    p_sk.add_argument("--defang-keep", choices=["none", "trusted", "vault"],
                      help="defang policy (DEFAULT trusted): trusted=keep official-doc URLs live · "
                           "vault=wipe all but save official docs to the cross-ref store · "
                           "none=wipe all (omit on a TTY → interactive prompt, Enter=trusted)")
    p_sk.add_argument("--list-trusted-urls", action="store_true",
                      help="audit: show the trusted-URL cross-reference vault")
    # First-class quarantine vault management (CLI-043) — list / re-gated restore / typed-confirm purge.
    p_qz = sub.add_parser("quarantine",
                          help="manage the URL-injection quarantine vault: list / restore (HMAC-verify "
                               "+ fresh nemesis re-gate) / purge (typed PURGE confirm)")
    p_qz_sub = p_qz.add_subparsers(dest="quar_action")
    p_qz_sub.add_parser("list", help="list quarantined items (newest first) with reason + verdict")
    p_qz_restore = p_qz_sub.add_parser("restore",
                                       help="restore a vaulted item after HMAC verify + a fresh green re-gate")
    p_qz_restore.add_argument("target", help="the vault dir to restore")
    p_qz_purge = p_qz_sub.add_parser("purge",
                                     help="permanently delete vault entries (typed PURGE confirm)")
    p_qz_purge.add_argument("target", nargs="?", help="a single vault dir to purge")
    p_qz_purge.add_argument("--all", action="store_true", help="purge ALL vault entries")
    p_secure = sub.add_parser("secure",
                              help="scan ANY file/archive/folder/repo (or --full = your home dir) "
                                   "for threats with nemesis and report")
    p_secure.add_argument("target", nargs="?", default="",
                          help="file, archive, folder, git URL, or owner/repo")
    p_secure.add_argument("--full", action="store_true",
                          help="scan your entire home directory (slow on large trees)")
    p_auto = sub.add_parser("auto",
                            help="full safe maintenance in one go: refresh feeds + audit/pin sources "
                                 "(quarantine drift) + integrate nemesis-green skills")
    p_auto.add_argument("--defang", action="store_true",
                        help="also wipe non-official URLs from installed sources (keep official docs)")
    p_info = sub.add_parser("info", help="show details for one plugin")
    p_info.add_argument("name", help="plugin name from `list`")
    p_audit = sub.add_parser("audit", help="security-scan a plugin's install artifacts (no install)")
    p_audit.add_argument("name", help="plugin name from `list`, or 'all'")
    p_audit.add_argument("--revoke", action="store_true", help="clear remembered trust for this plugin")
    p_scaf = sub.add_parser("scaffold-skill", help="write an auto-firing SKILL.md into ~/.claude/skills/")
    p_scaf.add_argument("name", help="skill name (kebab-case → folder + command name)")
    p_scaf.add_argument("--description", help="the TRIGGER — write as 'Use when …' (sharper = more reliable auto-fire)")
    p_scaf.add_argument("--body", help="the instructions Claude follows when the skill fires")
    p_scaf.add_argument("--tools", help="allowed-tools auto-granted while active (e.g. 'Read Edit')")
    p_scaf.add_argument("--manual", action="store_true", help="disable model invocation (manual /name only)")
    p_sync = sub.add_parser("sync", help="replicate an installed SKILL.md into other agents (cross-CLI portability)")
    p_sync.add_argument("skill", help="skill folder name in ~/.claude/skills/")
    p_sync.add_argument("--to", metavar="LIST", help="target agents (comma-sep) or 'all' (default: all with a skills dir)")
    p_mod = sub.add_parser("models", help="3rd functionality: install local/cloud model-running tools (AirLLM, FlashAttention, Odysseus, ...)")
    p_mod.add_argument("action", nargs="?",
                       choices=["list", "install", "uninstall", "update", "enable", "disable", "status", "versions", "rollback", "config", "browse", "pull", "run"],
                       default="list")
    p_mod.add_argument("tool", nargs="?", help="tool id (airllm|flashattention|...) OR model id/ollama-tag for pull/run")
    p_mod.add_argument("--path", metavar="DIR", help="isolated tools: folder to install into (else you browse). '<tool>' becomes the root.")
    p_mod.add_argument("--set-root", metavar="DIR", dest="set_root", help="models config: set the default folder where local models/tools install (persisted)")
    p_mod.add_argument("--show", action="store_true", help="models config: show the current default models folder")
    p_mod.add_argument("--version", metavar="N", help="rollback: target version (int for airllm/odysseus; release string e.g. 2.8.3 for flashattention)")
    # FlashAttention (kernel) — variegated install:
    p_mod.add_argument("--method", choices=[m[0] for m in FA_METHODS],
                       help="flashattention install method: wheel|pypi|source|hopper|fa4|kernels|rocm (else you pick)")
    p_mod.add_argument("--target-python", metavar="PY", help="flashattention: python of the engine env to install INTO (must have torch). Else a fresh isolated venv.")
    p_mod.add_argument("--max-jobs", type=int, metavar="N", help="flashattention build: cap compile parallelism (MAX_JOBS) on low-RAM machines")
    p_mod.add_argument("--cuda", metavar="VER", help="flashattention: override CUDA tag (e.g. 12 / 13) for the wheel / fa4 extra")
    p_mod.add_argument("--fa-version", metavar="VER", help="flashattention prebuilt-wheel release version (default %(default)s)" , default=None)

    # 4th functionality — self-hosted apps & repos (full lifecycle manager)
    p_app = sub.add_parser("apps", help="4th functionality: install/manage self-hosted apps & repos (yt-dlp, ollama, n8n, penpot, plausible, bitwarden, ...) — safest-method-first, full lifecycle")
    p_app.add_argument("action", nargs="?",
                       choices=["list", "wizard", "installed", "install", "uninstall", "update", "update-all",
                                "enable", "disable", "restart", "status", "logs", "open", "versions", "rollback"],
                       default="list")
    p_app.add_argument("tool", nargs="?", help="app id (see `apps list`)")
    p_app.add_argument("--path", metavar="DIR", help="folder for the app (pip tools: isolated versioned tree; compose: stack folder). Default ~/.config/prometheus/apps.")
    p_app.add_argument("--version", metavar="N", help="rollback: target version (pip tools)")

    # 8th functionality — world simulation & understanding (agent-based world-model engines)
    p_ws = sub.add_parser("worldsim", help="8th functionality: install/manage agent-based World-Simulation & Understanding engines (MiroFish, ...) — docker-compose, safest-method-first, full lifecycle")
    p_ws.add_argument("action", nargs="?",
                      choices=["list", "wizard", "installed", "install", "uninstall", "update",
                               "enable", "disable", "restart", "status", "logs", "open", "versions", "rollback"],
                      default="list")
    p_ws.add_argument("tool", nargs="?", help="engine id (see `worldsim list`)")
    p_ws.add_argument("--path", metavar="DIR", help="folder for the engine stack. Default ~/.config/prometheus/worldsim/<id>.")
    p_ws.add_argument("--version", metavar="N", help="rollback: target tag/release")

    # local-AI / billing-free audit — which AI repos call paid APIs + how to run them FREE on a local model
    p_la = sub.add_parser("localai", help="audit every AI repo (paid-API vs free-local) + a catalog of OPEN-SOURCE models (gpt-oss/qwen3/llama3 local · Kimi K2/DeepSeek/GLM served) + the exact recipe to re-point a PAID API at a free/open OpenAI-compatible model")
    p_la.add_argument("action", nargs="?", choices=["audit", "list", "models", "endpoints", "show", "model"], default="audit")
    p_la.add_argument("tool", nargs="?", help="show: AI tool id (see `localai audit`)  ·  model: open-model id (see `localai models`)")

    # 9th functionality — CHAT: agentic local (free, on-device) OR terminal chat for paid CLIs
    p_chat = sub.add_parser("chat", help="9th functionality: agentic LOCAL chat (free) OR terminal chat for paid CLIs (claude/codex/gemini/cursor/opencode) — preview→OPEN, system-prompt, bypass, tmux")
    p_chat.add_argument("--local", metavar="MODEL", help="AGENTIC mode: run in-app against a local model (ollama tag / LM Studio model id)")
    p_chat.add_argument("--runner", choices=["ollama", "lmstudio"], help="local runner for --local (default: ollama)")
    p_chat.add_argument("--effort", choices=list(EFFORT_TIERS), metavar="TIER",
                        help="AGENTIC mode: reasoning effort — off|low|medium|high|max. "
                             "Translated per-backend (reasoning_effort, a token budget, a "
                             "trained-on prompt line); a model with no knob gets it as a "
                             "step-by-step instruction instead, and says so.")
    p_chat.add_argument("--force-effort", action="store_true", dest="force_effort",
                        help="AGENTIC mode: send the effort knob even where the capability "
                             "table says this model has none. Off by default — a forwarded "
                             "reasoning_effort is a hard 400 on some models.")
    p_chat.add_argument("--cli", choices=["claude", "codex", "gemini", "cursor", "opencode"], help="TERMINAL mode: which paid CLI to launch")
    p_chat.add_argument("--model", metavar="M", help="terminal mode: model id for the CLI")
    p_chat.add_argument("--system-prompt", metavar="FILE", dest="system_prompt", help="terminal mode: a system-prompt file to load (appended by default)")
    p_chat.add_argument("--replace-system", action="store_true", dest="replace_system", help="terminal mode: REPLACE the system prompt instead of appending")
    p_chat.add_argument("--bypass", action="store_true", help="terminal mode: bypass the CLI's permission prompts (typed-confirm gated)")
    p_chat.add_argument("--tmux", nargs="?", const="", metavar="NAME", help="terminal mode: wrap in a tmux session (detach / leave-PC); optional session NAME")
    p_chat.add_argument("--cwd", metavar="DIR", help="terminal mode: working directory for the session")
    p_chat.add_argument("--open", action="store_true", help="terminal mode: actually LAUNCH (omit = preview only — the OPEN button)")
    p_chat.add_argument("message", nargs="*", help="optional prompt for one-shot/headless; omit for an interactive session")

    # Catalog cards — describe / tutorial / methods (the Learn-more surface)
    p_desc = sub.add_parser("describe", help="rich card for any catalog id (what/where/how/security + install & remove commands)")
    p_desc.add_argument("id", nargs="?", help="catalog id (plugin / model-tool / app / open-model / documented)")
    p_tut = sub.add_parser("tutorial", help="print the deep tutorial (dossier) for an id — the 'Learn more' button")
    p_tut.add_argument("id", nargs="?", help="catalog id")
    p_meth = sub.add_parser("methods", help="list every install method documented for an id")
    p_meth.add_argument("id", nargs="?", help="catalog id")

    # Defensive self-audit — "build your vault" (localhost-only, read-only, advisory)
    sub.add_parser("harden", help="defensive self-audit of THIS machine (firewall/ports/ssh/encryption/secret perms) + hardening steps; points to `pentest` for authorized deeper testing")

    # 5th functionality — pentest armory (sandboxed offensive security, AUTHORIZED ONLY)
    p_pt = sub.add_parser("pentest", help="5th functionality: AUTHORIZED pentest tools + AIs, each run inside a strongly-armored sandbox (airgapped, ROE-gated)")
    p_pt.add_argument("action", nargs="?",
                      choices=["list", "wizard", "scope", "status", "runtimes", "build",
                               "install", "uninstall", "shell", "run", "destroy",
                               "enable", "disable", "logs", "update"],
                      default="list")
    p_pt.add_argument("tool", nargs="?", help="tool id (see `pentest list`)")
    p_pt.add_argument("--kali", action="store_true", help="build: use the Kali base image (heavier, more tools)")
    p_pt.add_argument("--allow-net", dest="allow_net", action="store_true",
                      help="shell/run: enable EGRESS for the session (in-scope ROE targets ONLY). Default = airgapped.")
    p_pt.add_argument("--init", action="store_true", help="scope: (re)write the ROE template")
    p_pt.add_argument("args", nargs=argparse.REMAINDER, help="run: everything after `--` is passed to the tool inside the sandbox")
    return parser


# ============================================================================
#  --docs : full command reference + interactive type-to-search (terminal)
# ============================================================================
def _docs_index(parser: argparse.ArgumentParser) -> list[dict]:
    """Extract every subcommand (+ its flags/positionals + help) from the argparse
    tree — the single source of truth, so --docs never drifts from the real CLI."""
    subaction = next((a for a in parser._actions
                      if isinstance(a, argparse._SubParsersAction)), None)
    if subaction is None:
        return []
    helps = {ca.dest: (ca.help or "") for ca in subaction._choices_actions}
    seen: set[str] = set()
    cmds: list[dict] = []
    for name, sp in subaction.choices.items():
        if name in seen:
            continue                                  # argparse aliases → once
        seen.add(name)
        args: list[dict] = []
        for act in sp._actions:
            if act.dest == "help":
                continue
            label = ", ".join(act.option_strings) if act.option_strings else f"<{act.dest}>"
            args.append({"name": label, "help": act.help or "",
                         "choices": list(act.choices) if act.choices else None})
        cmds.append({"command": name, "help": helps.get(name, ""), "args": args})
    return sorted(cmds, key=lambda c: c["command"])


def _docs_filter(cmds: list[dict], query: str) -> list[dict]:
    """Case-insensitive AND-of-tokens match over command name + help + arg names."""
    toks = query.lower().split()
    if not toks:
        return cmds
    out = []
    for c in cmds:
        hay = (c["command"] + " " + c["help"] + " "
               + " ".join(a["name"] + " " + a["help"] for a in c["args"])).lower()
        if all(t in hay for t in toks):
            out.append(c)
    return out


def _docs_print_all(cmds: list[dict]) -> None:
    print(Log._c(f"\n  Prometheus — {len(cmds)} commands\n", "bold"))
    for c in cmds:
        print(f"  {Log._c(c['command'], 'green')}  {c['help']}")
    print(Log._c("\n  Run `prometheus <command> --help` for full flags, or "
                 "`prometheus --docs` on a terminal to search.\n", "dim"))


def _docs_detail(c: dict) -> str:
    lines = [f"  {Log._c(c['command'], 'green')}  —  {c['help']}"]
    for a in c["args"]:
        ch = f"  {{{','.join(a['choices'])}}}" if a["choices"] else ""
        lines.append(f"      {Log._c(a['name'], 'cyan')}{ch}   {a['help']}")
    return "\n".join(lines)


def _docs_interactive(cmds: list[dict]) -> int:
    """Raw-mode type-to-search: each keystroke re-filters the command list live.
    Esc / Ctrl-C / Ctrl-D quit · Enter expands the matches' flags. Falls back to a
    line-based search if raw mode is unavailable."""
    try:
        import termios
        import tty
    except ImportError:
        return _docs_line_search(cmds)
    fd = sys.stdin.fileno()
    try:
        old = termios.tcgetattr(fd)
    except (termios.error, ValueError):
        return _docs_line_search(cmds)
    query = ""
    expand = False

    def redraw() -> None:
        m = _docs_filter(cmds, query)
        rows = ["\033[2J\033[H",
                Log._c("  Prometheus docs — type to search "
                       "(Enter = show flags · Esc = quit)", "bold"),
                f"  search: {Log._c(query or '…', 'cyan')}    "
                f"{Log._c(f'{len(m)} match(es)', 'dim')}", ""]
        for c in m[:18]:
            rows.append(_docs_detail(c) if expand else
                        f"  {Log._c(c['command'], 'green'):<24} {c['help'][:70]}")
        if len(m) > 18:
            rows.append(Log._c(f"  … +{len(m) - 18} more — refine the search", "dim"))
        sys.stdout.write("\r\n".join(rows) + "\r\n")
        sys.stdout.flush()

    try:
        tty.setraw(fd)
        redraw()
        while True:
            ch = sys.stdin.read(1)
            if not ch:
                break
            o = ord(ch)
            if o in (3, 4, 27):                      # Ctrl-C / Ctrl-D / Esc
                break
            if o in (10, 13):                        # Enter → toggle flag detail
                expand = not expand
            elif o in (8, 127):                      # Backspace
                query = query[:-1]
                expand = False
            elif 32 <= o < 127:
                query += ch
                expand = False
            redraw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stdout.write("\033[2J\033[H")
        sys.stdout.flush()
    return 0


def _docs_line_search(cmds: list[dict]) -> int:
    """Portable fallback: type a query + Enter to narrow; blank = all; 'q' = quit."""
    _docs_print_all(cmds)
    while True:
        try:
            q = input("  search commands (q to quit) > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if q.lower() in ("q", "quit", "exit"):
            return 0
        m = _docs_filter(cmds, q)
        if not m:
            print(Log._c("  no matches", "yellow"))
            continue
        for c in m:
            print(_docs_detail(c))


def _cmd_docs(parser: argparse.ArgumentParser) -> int:
    cmds = _docs_index(parser)
    if JSON_OUT:
        return emit_json({"command": "docs", "ok": True, "count": len(cmds),
                          "commands": cmds,
                          "note": "every prometheus subcommand + flags; "
                                  "run `prometheus --docs` on a terminal to search live"})
    if sys.stdin.isatty() and sys.stdout.isatty():
        return _docs_interactive(cmds)
    _docs_print_all(cmds)
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    global _PARSE_ARGV
    _PARSE_ARGV = list(argv) if argv is not None else sys.argv[1:]
    parser = build_parser()
    args = parser.parse_args(argv)

    global DRY_RUN, FORCE, NO_SCAN, ASSUME_YES, STRICT, FORCE_UNSAFE, SHOW_INFO, GATE_FRESH, JSON_OUT
    DRY_RUN = args.dry_run
    FORCE = args.force
    NO_SCAN = args.no_scan
    ASSUME_YES = args.yes
    STRICT = args.strict
    FORCE_UNSAFE = args.force_unsafe
    SHOW_INFO = args.show_info
    GATE_FRESH = getattr(args, "gate_fresh", False)
    JSON_OUT = getattr(args, "json_out", False)
    Log.VERBOSE = args.verbose
    if args.no_color:
        Log.USE_COLOR = False
    if JSON_OUT:
        # stdout is the machine channel — push every human/log line to stderr and
        # never colorize it. Each cmd_* emits exactly one JSON object via emit_json.
        Log.USE_COLOR = False
        Log.STREAM = sys.stderr

    global GATE_MODE
    # Disabling/weakening the gate (--no-gate, --gate-mode off|warn, OR a PROMETHEUS_GATE=off|warn
    # env at import — line ~2396) now requires the same explicit confirmation as --force; a refusal
    # KEEPS the gate enforcing (fail-closed). Routing the env-derived value through the same confirm
    # closes the last bypass: the gate can never be silently off, from any source.
    _req_mode = ("off" if getattr(args, "no_gate", False)
                 else getattr(args, "gate_mode", None)
                 or (GATE_MODE if GATE_MODE in ("off", "warn") else None))
    if _req_mode in ("off", "warn"):
        GATE_MODE = _req_mode if _confirm_gate_disable(_req_mode) else "enforce"
    elif _req_mode == "enforce":
        GATE_MODE = "enforce"

    # --docs: full command reference + interactive search (works without a subcommand)
    if getattr(args, "docs", False):
        return _cmd_docs(parser)

    # 7th functionality — Repo Vault top-level flags (work with or without a subcommand)
    if any(getattr(args, k, False) for k in ("invoke_all", "invoke", "rollback")):
        if JSON_OUT:
            # these are interactive (path prompts / version menus) and write to
            # stdout — not exposed over the machine channel (mirrors cmd_vault).
            return emit_json({"command": "vault", "ok": False,
                "error": "vault invoke/invoke-all/rollback is interactive; "
                         "only `vault` status is exposed over --json", "_exit": 2})
        if getattr(args, "invoke_all", False):
            return cmd_vault_invoke(all_repos=True)
        if getattr(args, "invoke", False):
            return cmd_vault_invoke(all_repos=False)
        return cmd_vault_rollback()

    if not args.command:
        parser.print_help()
        return 0

    osi = detect_os()
    # URL-injection L5: throttled every-startup re-pin of installed external sources
    # (quarantines content that drifted into a dangerous verdict; fail-closed +
    # reversible). Best-effort — never blocks the requested command.
    _maybe_startup_pin_audit(osi, args.command)
    # self-heal the opt-in auto-maintenance schedule on ANY command (cheap: only acts
    # if the user enabled it AND the launchd/cron entry was purged). Skip for the
    # schedule command itself (it manages the entry directly, incl. --auto-off).
    if args.command != "schedule":
        _ensure_auto_schedule(osi)
    dispatch = {
        "wizard": cmd_wizard,
        "scan": cmd_scan,
        "superscan": cmd_superscan,
        "matrix": cmd_matrix,
        "where": cmd_where,
        "purge": cmd_purge,
        "schedule": cmd_schedule,
        "inventory": cmd_inventory,
        "list": cmd_list,
        "info": cmd_info,
        "doctor": cmd_doctor,
        "bundle": cmd_bundle,
        "install": cmd_install,
        "uninstall": cmd_uninstall,
        "status": cmd_status,
        "enable": cmd_enable,
        "disable": cmd_disable,
        "skills": cmd_skills,
        "quarantine": cmd_quarantine,
        "secure": cmd_secure,
        "auto": cmd_auto,
        "audit": cmd_audit,
        "scaffold-skill": cmd_scaffold,
        "sync": cmd_sync,
        "models": cmd_models,
        "apps": cmd_apps,
        "worldsim": cmd_worldsim,
        "localai": cmd_localai,
        "chat": cmd_chat,
        "describe": cmd_describe,
        "tutorial": cmd_tutorial,
        "methods": cmd_methods,
        "harden": cmd_harden,
        "pentest": cmd_pentest,
        "vault": cmd_vault,
    }
    try:
        return dispatch[args.command](args, osi)
    except KeyboardInterrupt:
        Log.err("interrupted")
        return 2
    except RuntimeError as e:
        # A RuntimeError is the engine's "refuse cleanly" channel (e.g. no interactive terminal
        # to choose an install folder). Under --json it printed NOTHING to stdout, so the CLI
        # reported "prometheus.py produced no JSON on stdout (crashed before emitting)" — an
        # internal diagnostic about a crash that did not happen. Every --json path emits exactly
        # one JSON object; this one was missing.
        if JSON_OUT:
            return emit_json({"command": getattr(args, "command", "?"), "ok": False,
                              "error": str(e), "_exit": 2})
        Log.err(str(e))
        return 2
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — GLOBAL CRASH GUARD: never dump a raw traceback at the user
        # Any unhandled exception from a command handler is caught here so the CLI
        # always exits cleanly (friendly message + nonzero code) instead of crashing.
        if JSON_OUT:
            return emit_json({"command": getattr(args, "command", "?"), "ok": False,
                              "error": f"{type(e).__name__}: {e}", "_exit": 1})
        Log.err(f"unexpected error: {type(e).__name__}: {e}")
        try:
            import traceback
            PROM_DIR.mkdir(parents=True, exist_ok=True)
            (PROM_DIR / "last-crash.log").write_text(traceback.format_exc())
            Log.step(f"details written to {PROM_DIR / 'last-crash.log'}")
        except Exception:  # noqa: BLE001
            pass
        Log.step("Prometheus exited cleanly instead of crashing — please report this bug")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
