/**
 * lsp/servers.ts — the language → language-server registry map (file 07 §4.1).
 *
 * A static, framework-free map of `languageId` → which server to spawn, how, and
 * what init options to send. The INTERPRETER/SDK is resolved from the env-manager
 * (file 04) so the LSP analyzes against the RIGHT venv — that's the load-bearing
 * `initOptions(ws)` hook for pyright's `pythonPath`.
 *
 * This module decides nothing about spawning or safety (C5): the actual child
 * process is started in the MAIN process's `lsp-host.ts`, and an ON-DEMAND server
 * binary download (rust-analyzer/gopls/clangd, §4.1 track 2) is "code you are
 * about to run" → it routes through the engine nemesis gate, NOT through here.
 * This file only carries the static spec + the pure init-options builder.
 *
 * Node built-ins only.
 */

/* ------------------------------------------------------------------------- *
 * Workspace context the init-options builder needs (file 04 handoff)
 * ------------------------------------------------------------------------- */

/**
 * The minimal workspace context an init-options builder reads — the active venv
 * interpreter comes from the env-manager (file 04). We keep it structural (not a
 * hard import of env-store) so this map stays a leaf module the host injects into.
 */
export interface LspWorkspace {
  /** file:///abs/path workspace root. */
  rootUri: string;
  /** absolute path of the active interpreter/SDK (e.g. `.venv/bin/python`). */
  interpreterPath?: string;
  /** the env name/label (for logs / the status spine). */
  envName?: string;
}

/* ------------------------------------------------------------------------- *
 * Sourcing track (file 07 §4.1) — bundled vs gate-downloaded
 * ------------------------------------------------------------------------- */

/**
 * Where a server's binary comes from:
 *  - "bundled": ships pinned + signed in the notarized app (no download, no gate).
 *  - "on-demand": downloaded at first use → MUST be nemesis-gated like a plugin
 *    install (the host stages then calls runNemesis(['gate', <staged>]); §9).
 */
export type ServerSourcing = "bundled" | "on-demand";

/** A language-server spec — pure data + a pure init-options builder. */
export interface LspServerSpec {
  /** stable server id (the host keys live servers by `(id, rootUri)`). */
  id: string;
  /** the executable name (resolved on PATH or the bundled path by the host). */
  cmd: string;
  /** argv for stdio mode. */
  args: readonly string[];
  /** bundled (no gate) vs on-demand download (gate-before-run, §4.1). */
  sourcing: ServerSourcing;
  /**
   * Build the server-specific `initializationOptions` for a workspace. Pure: it
   * reads the injected interpreter path; it does NOT touch the filesystem. The
   * host sends the result in the LSP `initialize` request, and a later interpreter
   * change sends `didChangeConfiguration` (§4.1) without an app restart.
   */
  initOptions?: (ws: LspWorkspace) => unknown;
}

/* ------------------------------------------------------------------------- *
 * The registry (file 07 §4.1)
 * ------------------------------------------------------------------------- */

/**
 * The static language → server map. Python & TS/JS & JSON/YAML/Markdown are
 * BUNDLED (the 80% Python/TS user works offline, no gate); rust-analyzer & gopls
 * are ON-DEMAND downloads that route through the nemesis gate at first use.
 */
export const SERVERS: Readonly<Record<string, LspServerSpec>> = Object.freeze({
  python: {
    id: "pyright",
    cmd: "pyright-langserver",
    args: ["--stdio"],
    sourcing: "bundled",
    // Critical: tell pyright which interpreter — from the venv manager (file 04).
    initOptions: (ws: LspWorkspace) =>
      ws.interpreterPath ? { python: { pythonPath: ws.interpreterPath } } : {},
  },
  typescript: {
    id: "tsserver",
    cmd: "typescript-language-server",
    args: ["--stdio"],
    sourcing: "bundled",
  },
  javascript: {
    id: "tsserver",
    cmd: "typescript-language-server",
    args: ["--stdio"],
    sourcing: "bundled",
  },
  json: {
    id: "json-ls",
    cmd: "vscode-json-language-server",
    args: ["--stdio"],
    sourcing: "bundled",
  },
  yaml: {
    id: "yaml-ls",
    cmd: "yaml-language-server",
    args: ["--stdio"],
    sourcing: "bundled",
  },
  markdown: {
    id: "markdown-ls",
    cmd: "vscode-markdown-language-server",
    args: ["--stdio"],
    sourcing: "bundled",
  },
  rust: {
    id: "rust-analyzer",
    cmd: "rust-analyzer",
    args: [],
    sourcing: "on-demand",
  },
  go: {
    id: "gopls",
    cmd: "gopls",
    args: [],
    sourcing: "on-demand",
  },
});

/** The set of languageIds with a registered server. */
export function supportedLanguages(): string[] {
  return Object.keys(SERVERS);
}

/** Look up the server spec for a languageId (undefined if none). */
export function serverFor(languageId: string): LspServerSpec | undefined {
  return SERVERS[languageId];
}

/**
 * The server id for a languageId (the `(id, rootUri)` host key) — undefined if
 * the language has no server. tsserver intentionally backs BOTH ts and js, so
 * `serverIdFor('javascript') === serverIdFor('typescript')`.
 */
export function serverIdFor(languageId: string): string | undefined {
  return SERVERS[languageId]?.id;
}

/** Does this language's server require a gate-before-download (on-demand)? §4.1. */
export function requiresGateBeforeDownload(languageId: string): boolean {
  return SERVERS[languageId]?.sourcing === "on-demand";
}

/**
 * Build the `initializationOptions` for a (language, workspace) pair (pure). The
 * host puts this in the LSP `initialize` request. Returns `{}` when the server
 * declares no init options.
 */
export function initOptionsFor(languageId: string, ws: LspWorkspace): unknown {
  const spec = SERVERS[languageId];
  if (!spec?.initOptions) return {};
  return spec.initOptions(ws);
}
