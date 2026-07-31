# csv-lens — reference `.promext` extension

A minimal, real Prometheus Studio extension used as the **e2e fixture** for the
extension install + nemesis gate tests (file 10) and as a worked example of the
file 09 §5 extension API.

It exercises every part of the manifest:

- `ui.panels` — a sandboxed webview panel (`dist/panel.js`, postMessage RPC only).
- `contributes.commands` + `keybindings` — `csvLens.open` (⌘⇧C).
- `contributes.agents` — a drop-in `AgentDef` (`agents/cleaner.agent.json`).
- `contributes.configuration` — `csvLens.maxRows`.
- `permissions` — **declared, enforced, surfaced at install**: read the workspace,
  no writes, no network, only the read-only `list`/`info` engine commands, no secrets,
  no shell. The `ExtensionContext` built from this manifest physically cannot do more.

Package it (`.promext` = a zip of this folder). Install routes through
`nemesis gate <repo|staging-dir>` before the declared permissions are shown for
approval — nothing about extension trust bypasses nemesis (file 09 §5.3).
