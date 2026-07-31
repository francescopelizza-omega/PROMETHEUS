/**
 * ext/context.ts — the ExtensionContext surface + its permission-bound factory (§5.2).
 *
 * The object injected into an extension's `activate(ctx)`. The capabilities are
 * CONSTRUCTED from the manifest (permissions.ts): `engine.run` rejects any subcommand
 * not granted; `secrets.get/store` reject any key not declared; `workspace.readFile`
 * rejects a path outside the fs.read allowlist. The raw backends are injected by the
 * host (the desktop main / utility process); this factory only wraps them with the
 * enforced gates — enforced at the boundary, not trusted.
 */
import type { McpServerConfig } from "../mcp/host/types.js";
import type { ExtCapabilities } from "./permissions.js";

export interface Disposable {
  dispose(): void;
}

export interface ExtCommandsApi {
  register(id: string, fn: (...args: unknown[]) => unknown): Disposable;
  execute(id: string, ...args: unknown[]): Promise<unknown>;
}

export interface ExtUiApi {
  showPanel(id: string): void;
  notify(level: "info" | "warn" | "error", msg: string): void;
}

export interface ExtWorkspaceApi {
  rootUri: string;
  readFile(path: string): Promise<Uint8Array>;
}

export interface ExtEngineApi {
  run(argv: string[]): Promise<unknown>;
}

export interface ExtMcpApi {
  listServers(): McpServerConfig[];
  callTool(ref: string, args: unknown): Promise<unknown>;
}

export interface ExtSecretsApi {
  get(key: string): Promise<string | undefined>;
  store(key: string, val: string): Promise<void>;
}

/** The capability object passed to `activate(ctx)` (§5.2). */
export interface ExtensionContext {
  commands: ExtCommandsApi;
  ui: ExtUiApi;
  workspace: ExtWorkspaceApi;
  engine: ExtEngineApi;
  mcp: ExtMcpApi;
  secrets: ExtSecretsApi;
  subscriptions: Disposable[];
}

/** The raw (un-gated) backends the host provides; the factory wraps the gated ones. */
export interface ExtensionBackends {
  commands: ExtCommandsApi;
  ui: ExtUiApi;
  workspace: ExtWorkspaceApi;
  engine: ExtEngineApi;
  mcp: ExtMcpApi;
  secrets: ExtSecretsApi;
}

/**
 * Build a permission-bound ExtensionContext. The engine / secrets / workspace
 * capabilities are wrapped so a disallowed call REJECTS before reaching the backend.
 */
export function createExtensionContext(
  backends: ExtensionBackends,
  caps: ExtCapabilities,
): ExtensionContext {
  const root = backends.workspace.rootUri;
  return {
    commands: backends.commands,
    ui: backends.ui,
    workspace: {
      rootUri: root,
      readFile: (path) => {
        if (!caps.fsReadAllowed(path, root)) {
          return Promise.reject(new Error(`fs read denied (not in permissions.fs.read): ${path}`));
        }
        return backends.workspace.readFile(path);
      },
    },
    engine: {
      run: (argv) => {
        const subcmd = argv[0] ?? "";
        if (!caps.engineAllowed(subcmd)) {
          return Promise.reject(
            new Error(`engine command denied (not in permissions.engine): ${subcmd}`),
          );
        }
        return backends.engine.run(argv);
      },
    },
    mcp: backends.mcp,
    secrets: {
      get: (key) => {
        if (!caps.secretAllowed(key)) {
          return Promise.reject(new Error(`secret denied (not in permissions.secrets): ${key}`));
        }
        return backends.secrets.get(key);
      },
      store: (key, val) => {
        if (!caps.secretAllowed(key)) {
          return Promise.reject(new Error(`secret denied (not in permissions.secrets): ${key}`));
        }
        return backends.secrets.store(key, val);
      },
    },
    subscriptions: [],
  };
}
