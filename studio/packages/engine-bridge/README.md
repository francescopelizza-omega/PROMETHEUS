# @prometheus/engine-bridge

The **only** path from JavaScript to the Python engine. Wraps:

- `python3 ../../prometheus.py --json <cmd>` — one JSON object on stdout, logs on stderr (existing contract,
  also used by `../../prometheus_plugin/`).
- `../../nemesis ...` — the security health gate.

Exposes a typed async API (`scan`, `install`, `audit`, `models`, `apps`, `vault`, …) + streaming for
long-running ops. Owns sidecar lifecycle/health and the request/response/error types.

**Rule:** no security decision is made in JS — verdicts come from `nemesis`/`prometheus.py`.

Monorepo/tech-stack and security-architecture rationale live in the maintainer's internal spec
set (not part of this repo).
