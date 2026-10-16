# Security Policy

PROMETHEUS puts a fail-closed supply-chain gate (`nemesis`) and an AI agent capable of reading,
writing, and executing on your machine in the critical path. A vulnerability here has more reach
than an ordinary bug — please report it responsibly.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Email
**red-beard-phoenix@users.noreply.gitlab.com** with:

- A description of the vulnerability and its impact (what an attacker could do, and to whom).
- Steps to reproduce, or a proof-of-concept if you have one.
- The affected component: the engine (`prometheus.py`), the `nemesis` gate, Studio
  (`studio/apps/desktop`), the CLI (`studio/apps/cli`), the VS Code extension, or the MCP
  adapters (`prometheus_plugin/`).
- Whether you'd like credit in the eventual fix's release notes, and how to attribute it.

You should get an acknowledgment within **5 business days**. This is currently a single-maintainer
project — please be patient beyond that; a lack of an immediate reply is not a lack of attention.

## What counts as in-scope

- A way to make `nemesis` (or the engine's other gates: the authorization ladder, the
  confirm-before-mutate flow, the exec sandbox) **allow something it should have blocked** —
  a bypass of the fail-closed scan, a way to smuggle a malicious command past classification, a
  sandbox escape.
- A way for untrusted content (a fetched web page, an installed plugin's manifest, an MCP
  server's tool description) to influence the agent's behavior beyond what its own documented
  trust boundary allows (prompt injection that crosses into an actual tool call, not just
  "the model said something silly").
- Credential or secret exposure — a way the CLI/Studio/engine could leak an API key, a stored
  grant, or a keychain entry it shouldn't.
- Anything that runs a privileged command without a fresh approval of that exact command: a
  bypass of the privileged gate, a way to replay or reuse an approval, a difference between the
  command shown and the command that runs, or a password reaching Prometheus's own process,
  logs or transcripts.
- A genuine sandbox limitation being presented as stronger protection than it is — though many
  of these are already **documented on purpose** (see `packages/core/src/agent/system/host/exec-sandbox.ts`'s
  own header comment, and `studio/docs/security/THREAT_MODEL.md`, shown verbatim in the app's
  security pane) — check there first; an honestly-documented limitation isn't a new finding.

## Privileged commands (sudo)

Prometheus may run sudo, but never on its own authority. Every privileged command is shown to
the human verbatim and runs only after that human approves that exact command, every time. No
authorization level, flag, setting, agent or tool can pre-approve, remember or skip this
approval.

- One module is the only path to root (`studio/packages/core/src/agent/system/host/privileged-gate.ts`).
  `run_command` refuses every privileged command (sudo, doas, pkexec, su, run0, `machinectl
  shell` — also behind launchers, inside `sh -c`, in pipelines and chains). Where a kernel
  sandbox runs (Seatbelt on macOS, bubblewrap on Linux) it blocks setuid binaries as well; on
  Linux without bubblewrap that classification is the only barrier.
- The approval prompt shows the exact argv, the folder, who asked and why, and for a script its
  path, size, SHA-256 and first lines. **Approve once** or **Deny** — Deny is the default, and
  no answer in time is a deny. There is no "always". A catastrophic command also needs its
  target typed.
- The approval is bound to that argv, folder and script hash, and all three are re-checked
  immediately before the command runs.
- `--yes`, every authorization level up to A7, remembered grants, MCP clients and headless runs
  cannot approve; with no human attached the command is returned for a person to run.
- The password never passes through Prometheus: sudo reads it from the terminal, or a fixed
  askpass helper shows a native dialog and hands it straight to sudo. Sudoers is never touched.
- An interactive root program in a GUI (Studio's "Open disk space as administrator") runs only
  with the native dialog — never with a password typed into Prometheus's own window — on a
  pseudo-terminal relay (`pty_host.py`, running as you) that runs from its verified bytes. It is
  shown in its own window whose keys come only from the keyboard (main reads them from Electron's
  `before-input-event`; no page can send one), and keys pressed before it draws are dropped.
- Root runs exactly the approved script bytes: Python through a fixed loader that re-hashes the
  file as root and runs the bytes it hashed, shell scripts from their approved bytes passed
  inline, root-owned scripts as they are; anything else is refused.
- Every request is appended to `~/.prometheus/audit/sudo.log` (0600): requester, argv, folder,
  reason, script hash, decision, exit code — never the environment, output or password.

## What's out of scope

- Vulnerabilities that require the user to have already granted the agent a permission level
  that, by design, allows the behavior in question (e.g. reporting that A7 "run all" lets a
  command run — that's the documented contract of that level). **Privileged commands are the
  exception: no level covers them**, so a privileged command running without a fresh, specific
  human approval is in scope at any level.
- Denial-of-service against your own local instance.
- Issues purely in third-party dependencies — report those upstream; we'll pull in the fix once
  it's available (see [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for what's bundled).

## Supported versions

This project is pre-1.0 and under active development. Only the latest commit on the default
branch is supported — there is no backport policy for older versions yet.

## Disclosure

Please give us a reasonable window to land a fix before any public disclosure. We don't currently
run a bug-bounty program.
