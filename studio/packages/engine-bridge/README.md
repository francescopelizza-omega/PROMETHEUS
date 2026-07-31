# @prometheus/engine-bridge

The **only** path from JavaScript to the Python engine. Wraps:

- `python3 ../../prometheus.py --json <cmd>` — one JSON object on stdout, logs on stderr (existing contract,
  also used by `../../prometheus_plugin/`).
- `../../nemesis ...` — the security health gate.

Exposes a typed async API (`scan`, `install`, `audit`, `models`, `apps`, `vault`, …) + streaming for
long-running ops. Owns sidecar lifecycle/health and the request/response/error types.

**Rule:** no security decision is made in JS — verdicts come from `nemesis`/`prometheus.py`.

Spec → [`02-monorepo-tech-stack-bridge.md`](../../../MDS/the_real_prometheus/02-monorepo-tech-stack-bridge.md),
[`03-security-core-nemesis-gui.md`](../../../MDS/the_real_prometheus/03-security-core-nemesis-gui.md).
