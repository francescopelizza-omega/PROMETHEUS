# Security docs

This directory holds the user-facing security stance for Prometheus Studio.

## THREAT_MODEL.md — the honest threat model

[`THREAT_MODEL.md`](./THREAT_MODEL.md) is the canonical, honest threat model. It is
shown **verbatim in the in-app security / about pane** — the `ThreatModel` view in
the security UI renders this file directly (no GUI-authored copy that could drift
from it). Anyone touching the security UI should point that pane at
`docs/security/THREAT_MODEL.md` and render it as inert text, the same way every
engine-sourced string is rendered (no `dangerouslySetInnerHTML`, no raw-HTML
markdown, ANSI stripped).

It states, in the engine's own framing:

- nemesis is **heuristic static analysis + signatures + SCA, not a sandbox**; a
  clean verdict means *no known threats found*, not *safe to run*.
- Studio's green state reads **"SAFE — no known threats found"**, never **"Safe"**.
- **Fail-closed everywhere** — scanner missing / DB empty / crash / timeout /
  unparseable output ⇒ verdict `error` ⇒ treated as **BLOCK**. No green state is
  ever rendered from a failed scan.
- **In-archive non-remediability** and **blind spots** (encrypted / unscannable
  members) are surfaced explicitly, never hidden.
- **Defense in depth, not a guarantee** — the exact phrase used in the pane.
- **Signed verdicts give integrity, not protection** against a same-uid attacker
  who can read `gate.key`.

## How the rest of the security surface is laid out

The threat-model text is the *honest framing*; the machinery that earns it lives
in the bridge and is rendered (never re-decided) by the UI:

- **`@prometheus/engine-bridge`** — the only package allowed to spawn
  `python3` / `nemesis`. `gate(target)` returns the lightweight C3
  `SecurityVerdict` that `core` / `cli` / the install path consume; the rich
  `nemesis.verdict/1` view (severity counts, findings-by-class, blocking reasons,
  provenance, signed HMAC, policy, host) is the source for the security UI.
- **GOLDEN RULE (C5):** JavaScript never decides "safe"; it renders a verdict the
  Python engine computed. No severity scoring, allowlist, regex, or heuristic in
  the TypeScript codebase.
- **Renderer fence:** the renderer is sandboxed (`contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`) and imports only `window.prometheus.*`
  + types — never `node:*` / `electron` / `engine-bridge`. A malicious model card,
  README, or finding `snippet` is treated as untrusted text.

The architecture, milestones, and per-screen UX live in the maintainer's internal spec set
(not part of this repo).
