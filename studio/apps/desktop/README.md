# @prometheus/desktop

The Electron 33 desktop shell for Prometheus Studio (C10: Electron 33 / Node 20 / React 19 / TS 5.7).

## Process model (C5)

- **main** (`src/main/`) — the ONLY privileged process. Creates a hardened
  `BrowserWindow` (`contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`,
  preload). It is the sole importer of `@prometheus/engine-bridge` + `@prometheus/core`,
  owns the one `ServerSupervisor` (C8), and registers the typed `ipcMain` handlers.
- **preload** (`src/preload/index.ts`) — runs in the isolated world; exposes a
  small frozen `window.prometheus` API via `contextBridge`. Each method is a thin
  `ipcRenderer.invoke(<channel>)`. No `node:*` / engine access leaks to the renderer.
- **renderer** (`src/renderer/`) — the sandboxed React 19 view. Reaches the engine
  ONLY through `window.prometheus.*`. Imports just React + `@prometheus/ui`.

## The IPC seam

`src/shared/ipc-contract.ts` is the single source of truth for every channel name
and request/response shape, shared by main + preload + renderer (`window.d.ts`).
All payloads are plain, structured-clone-safe data — never a live `EngineClient`,
`ChildProcess`, or node handle.

## Golden rule (C5)

JS never decides "safe". `gate(target)` renders whatever verdict the engine-bridge
nemesis runner produced (fail-closed: missing/timeout/unparseable scanner ⇒
`verdict:"error"` ⇒ BLOCK). The fail-closed mappers live in `src/main/verdict-map.ts`
(unit-tested in `verdict-map.test.ts`).

## Sidecars (C7/C8)

`prometheus.py` has no `sidecar` verb — the NEW one-shot sidecars (`envmgr.py`,
`modelhub.py`) are standalone Python programs the MAIN process runs via
`src/main/sidecar.ts` (shell:false, last-to-first JSON recovery, fail-closed
timeout). Long-lived servers are supervised by the `ServerSupervisor`, not here.

## Build

`electron.vite.config.ts` defines the main/preload/renderer targets. The renderer
target gets ONLY the `@prometheus/ui` alias — engine-bridge/core are absent there
by construction (C5). `electron`, `electron-vite`, `vite`, `@vitejs/plugin-react`,
`react`, `react-dom`, `zustand` are declared in package.json but are NOT installed
this pass; the sources are production-shaped and build once the toolchain lands.

```
pnpm --filter @prometheus/desktop dev     # electron-vite dev (HMR)
pnpm --filter @prometheus/desktop build   # electron-vite build
```

Vision, architecture, and IDE-core design rationale live in the maintainer's internal spec set
(not part of this repo).
