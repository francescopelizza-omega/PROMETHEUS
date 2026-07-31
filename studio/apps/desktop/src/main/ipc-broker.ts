/**
 * main/ipc-broker.ts — a typed channel→handler registry, DECOUPLED from ipcMain
 * (file 01 §5, the IPC layer). NO electron import.
 *
 * Electron's `ipcMain.handle(channel, listener)` is the production transport, but
 * binding handlers DIRECTLY to it makes the routing logic untestable without
 * Electron. This broker holds the SAME map (channel → async handler) as a plain
 * Node object so node:test can dispatch through it directly. main/index.ts then
 * binds the broker onto `ipcMain.handle` with a one-line adapter.
 *
 * Each handler receives the renderer's plain-data args and returns a Promise of
 * a renderer-safe response. The broker enforces two invariants the renderer can
 * never violate:
 *   1. an UNKNOWN channel is REJECTED (no silent undefined) — a typo or a
 *      malicious renderer cannot reach an unregistered capability;
 *   2. a handler that THROWS is converted to a rejected promise carrying a short
 *      message, never an unhandled crash in the MAIN process.
 *
 * It knows nothing about WHAT a handler does (engine-bridge / core / sidecar) —
 * those are wired in main/index.ts. This keeps the broker pure + unit-testable.
 *
 * Node built-ins only (none needed at runtime).
 */

/** A single channel handler: plain args in, a Promise of plain data out. */
export type IpcHandler = (...args: unknown[]) => Promise<unknown> | unknown;

/** Thrown/rejected when a channel has no registered handler (fail-closed routing). */
export class UnknownChannelError extends Error {
  readonly channel: string;
  constructor(channel: string) {
    super(`no handler registered for channel: ${channel}`);
    this.name = "UnknownChannelError";
    this.channel = channel;
  }
}

/**
 * The decoupled IPC broker. Register handlers by channel name, then `dispatch`
 * (tests) or `bind` onto ipcMain (main/index.ts).
 */
export class IpcBroker {
  private readonly handlers = new Map<string, IpcHandler>();

  /** Register a handler for a channel. Re-registering a channel throws (no silent overwrite). */
  register(channel: string, handler: IpcHandler): this {
    if (this.handlers.has(channel)) {
      throw new Error(`channel already registered: ${channel}`);
    }
    this.handlers.set(channel, handler);
    return this;
  }

  /** True if a channel has a handler. */
  has(channel: string): boolean {
    return this.handlers.has(channel);
  }

  /** Every registered channel name (for binding + introspection). */
  channels(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Dispatch to a channel's handler. Rejects with UnknownChannelError for an
   * unregistered channel; otherwise awaits the handler and normalises a thrown
   * value into a rejected Promise carrying a short message (never a raw crash).
   */
  async dispatch(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new UnknownChannelError(channel);
    }
    try {
      return await handler(...args);
    } catch (e) {
      throw e instanceof Error ? e : new Error(typeof e === "string" ? e : "handler failed");
    }
  }

  /**
   * Bind every registered channel onto an ipcMain-like object. The adapter strips
   * Electron's leading `IpcMainInvokeEvent` (handlers take only renderer args) and
   * routes through `dispatch` so the unknown-channel + error-normalising
   * invariants hold in production too. Returns a disposer that removes them.
   *
   * Typed against a minimal IpcMainLike so this file needs NO electron import;
   * main/index.ts passes the real `ipcMain`.
   */
  bind(ipcMain: IpcMainLike): () => void {
    for (const channel of this.handlers.keys()) {
      ipcMain.handle(channel, (_event: unknown, ...args: unknown[]) =>
        this.dispatch(channel, ...args),
      );
    }
    return () => {
      for (const channel of this.handlers.keys()) ipcMain.removeHandler(channel);
    };
  }
}

/** The slice of Electron's ipcMain the broker binds onto (no electron import). */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
  removeHandler(channel: string): void;
}
