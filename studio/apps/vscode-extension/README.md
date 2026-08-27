# Prometheus for VS Code

Prometheus's agent as a sidebar chat panel, driving the **real** `@prometheus/core` agent loop
over your open VS Code workspace.

This is a genuine MVP, not parity with Claude Code's extension. What it does, it does for real:
the loop is core's, the gating is core's, and every file operation goes through VS Code's own
APIs so edits appear as ordinary, undoable editor changes.

## Architecture

The extension implements the three seams `runAgentTurn` asks for and injects nothing else:

| Seam | Implementation | File |
| --- | --- | --- |
| `LLMClient` | OpenAI-compatible endpoint via core's `createAiClient`, TEXT tool transport | `src/llm.ts` |
| `ToolRunner` | pure dispatch over a `WorkspaceIo` interface | `src/tool-runner.ts` |
| `confirm` | a native VS Code modal dialog | `src/chat-view.ts` |

`src/session.ts` drives `runAgentTurn` and translates its events onto the webview. There is no
loop, no tool broker and no permission logic in this package — all of it is inherited from
`@prometheus/core`, which is the point.

### File IO goes through VS Code, never `node:fs`

`src/workspace-io.ts` is the only module that touches the filesystem, and it uses
`vscode.workspace.fs` for reads and a single `vscode.WorkspaceEdit` + `vscode.workspace.applyEdit`
for every mutation. Three reasons, each of which is a real bug avoided:

1. **`node:fs` writes are invisible to VS Code.** Writing a file the user has open with unsaved
   changes is silently discarded on their next save — the editor's buffer wins. `applyEdit`
   mutates the buffer, so open and closed files behave identically. There is a test for exactly
   this (`propose_edit edits the OPEN, DIRTY buffer`).
2. **`applyEdit` lands on the undo stack.** One `WorkspaceEdit` is one undo entry, which is why
   `applyMutations` takes an array — an `apply_patch` over ten files is one Ctrl+Z, not ten.
3. **`workspace.fs` honours FileSystemProviders.** On Remote-SSH, dev containers, WSL or a
   virtual workspace, the files are not on the extension host's disk at all. `node:fs` reads the
   wrong machine there; it does not merely read it slower.

### The permission surface

Gated tool calls raise `vscode.window.showWarningMessage(..., { modal: true })` with
Allow/Deny. Chosen over a webview modal because the webview is **destroyed** whenever the user
collapses the sidebar or switches activity-bar container — a confirm rendered there would
sometimes never appear, and the turn would hang on a dialog nobody could see. Dismissing the
dialog is a deny, matching core's confirm-default-deny.

Reads auto-approve at `prometheus.authLevel` 1; anything carrying `destructiveHint`
(`write_file`, `propose_edit`, `apply_patch`, `delete_file`, `move_file`) reaches a human at
every level, including 0. That is core's annotation broker, not a rule this package invents.

### Cancelling a turn

`prometheus.cancel` (Command Palette) and the sidebar's Cancel button (shown only while a turn
is running) both call the same `ChatSession.cancel()`, which trips an `AbortController` minted
fresh per turn. Core's `runAgentTurn` checks it before every round and before every tool call
(`packages/core/src/agent/loop.ts`'s `AgentTurnDeps.signal`) — the same mechanism the CLI's ESC
and the desktop's stop button already use — so a cancel takes effect at the next check point
rather than needing a kill signal to a child process (this host has no `run_command` tool to
kill in the first place).

### Why the webview UI is hand-written

`apps/desktop`'s `AgentPane.tsx` is ~2700 lines of React bound to `@prometheus/ui`, Monaco, the
DiffReview change-set store and — structurally — the Electron preload bridge, a synchronous
request/response IPC surface. A VS Code webview is a sandboxed iframe whose only channel is
async `postMessage` under a strict CSP. Porting would have meant rebuilding the bridge as a
promise-multiplexer over `postMessage`, vendoring the UI package and Monaco, and deleting the
panes with no VS Code analogue. The chat surface itself — transcript, composer, busy state —
is ~120 lines written against VS Code's own theme variables, so it looks native in every theme.
Nothing correctness-bearing lives in the webview.

## Development

```sh
pnpm run build          # esbuild → out/extension.cjs (CJS; core is ESM-only)
pnpm run typecheck
pnpm run test:vscode    # downloads a throwaway VS Code and runs the integration suite
pnpm run package        # → prometheus-vscode-0.1.0.vsix
```

`src/session.ts` has no `vscode` import of its own, so its logic (currently: mid-turn
cancellation) also has a fast, plain `node:test` companion that needs no VS Code download:

```sh
node --import ./src/test/register.mjs --test src/session.test.ts
```

`test:vscode` needs no VS Code installed: `@vscode/test-electron` downloads its own pinned build
into `.vscode-test/` (cached after the first run) and never touches your real VS Code profile.

## Scoped out (deliberately, with reasons)

- **Native `tools:[…]` transport.** Core's reusable `createAiClient` has no `tools` field; the
  native path lives in `apps/cli`'s `toolTurn`, which is application code, not a library.
  Copying it here would fork a tool-call transport — the exact drift the desktop pane was
  rebuilt to end. The right fix is lifting `toolTurn` into core for all three hosts. Until then
  this uses core's TEXT transport (`ToolCallScanner` + tool preamble), which is core's own
  protocol and works on the widest set of endpoints.
- **`run_command`, git tools, `web_fetch`/`web_search`, browser tools, MCP, `spawn_agent`,
  `question`, and the `prometheus_*` engine verbs.** Each needs a process host, a fail-closed
  network proxy, or the engine. A tool that is advertised but cannot execute teaches the model
  to keep proposing it, so they are not in the allow-list at all.
- **`remember: "session"` grants.** The confirm result carries the field, but core reads it in
  `withRememberedGrants`, which is not wired here — so the dialog offers only Allow/Deny rather
  than an affordance that would not stick.
- **Multi-root workspaces.** Scoped to the first folder. Guessing which root a bare relative
  path belongs to means sometimes editing the wrong project.
- **Checkpoints, diff-review staging, session persistence.** Edits apply straight to the buffer
  and are reviewed with VS Code's own undo and SCM gutter, rather than a second review surface.
