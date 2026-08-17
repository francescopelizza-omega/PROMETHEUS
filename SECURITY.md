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
- A genuine sandbox limitation being presented as stronger protection than it is — though many
  of these are already **documented on purpose** (see `packages/core/src/agent/system/host/exec-sandbox.ts`'s
  own header comment, and `studio/docs/security/THREAT_MODEL.md`, shown verbatim in the app's
  security pane) — check there first; an honestly-documented limitation isn't a new finding.

## What's out of scope

- Vulnerabilities that require the user to have already granted the agent a permission level
  that, by design, allows the behavior in question (e.g. reporting that A7 "run all" lets a
  command run — that's the documented contract of that level).
- Denial-of-service against your own local instance.
- Issues purely in third-party dependencies — report those upstream; we'll pull in the fix once
  it's available (see [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for what's bundled).

## Supported versions

This project is pre-1.0 and under active development. Only the latest commit on the default
branch is supported — there is no backport policy for older versions yet.

## Disclosure

Please give us a reasonable window to land a fix before any public disclosure. We don't currently
run a bug-bounty program.
