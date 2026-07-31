# Prometheus Studio

Security-first, AI-everything IDE — the desktop GUI + `prom` CLI built on top of the existing
Python engine (`../prometheus.py` + `../nemesis`).

> **The M1 walking skeleton is in place and passes.** `packages/engine-bridge` (the only JS→engine
> gateway), `packages/core`, and the `prom` CLI are implemented + tested; `apps/desktop` and
> `packages/ui` are source-only (the Electron runtime is not yet installed). The full design lives in
> [`../MDS/the_real_prometheus/`](../MDS/the_real_prometheus/) (11 plan files).
>
> **Start here:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the living keystone (process model, system
> diagram, file→responsibility table, IPC channels, implemented-vs-source-only) — and
> [`docs/pillars.md`](./docs/pillars.md), the one-page pillars card.

## Trinity

| Layer | What | Lives in |
|-------|------|----------|
| **Engine** | `prometheus.py` (~10.6k lines) + `nemesis` security gate. Source of truth for scan/install/security/lifecycle. Unchanged `--json` contract. | repo root |
| **Studio** | Electron + React + TS + Monaco desktop IDE. | `apps/desktop` |
| **`prom`** | Node terminal CLI/TUI, full GUI parity. | `apps/cli` |

## Monorepo layout

```
studio/
  apps/
    desktop/          Electron desktop IDE (main + renderer)
    cli/              prom — Node terminal CLI/TUI
  packages/
    engine-bridge/    typed TS client over prometheus.py --json + nemesis (the ONLY JS→engine gateway)
    core/             shared domain types & logic (GUI + CLI)
    ui/               design system — React components (shadcn/Radix + Tailwind)
  python/
    sidecar/          thin wrapper / contract docs around prometheus.py + nemesis
```

## Golden rule

**JS never reimplements security.** Every scan / install / lifecycle action routes through
`nemesis` and `prometheus.py` via `packages/engine-bridge`. See
[`../MDS/the_real_prometheus/03-security-core-nemesis-gui.md`](../MDS/the_real_prometheus/03-security-core-nemesis-gui.md).

## Getting started (once implemented)

```bash
cd studio
pnpm install
pnpm dev          # turbo: launches desktop + watches packages
pnpm --filter @prometheus/cli build && node apps/cli/dist/bin.js   # prom CLI
```

Requires Node ≥ 20 (`.nvmrc`), pnpm, and Python 3 with `prometheus.py` + `nemesis` at the repo root
(`PROMETHEUS_PY` / `NEMESIS_BIN` env vars override the paths).
