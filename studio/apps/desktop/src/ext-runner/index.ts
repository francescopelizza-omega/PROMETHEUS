// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ext-runner/index.ts — the EXTENSION utility-process ENTRYPOINT (APP-059, file 09 §5.2).
 *
 * Forked by main (utilityProcess.fork, exactly like worker.js). Extensions run HERE — never
 * in main or the renderer. A THIN transport (mirrors worker/index.ts): it binds to whichever
 * message channel is present (Electron `parentPort` OR node fork `process.send` for tests),
 * loads an installed extension's main module, and calls its `ActivateFn` with a
 * PERMISSION-BOUND ExtensionContext. The context's backends are reverse-RPC proxies: every
 * capability call posts a host-rpc frame to main (which gates it via dispatchWebviewRpc) and
 * awaits the reply.
 *
 * WHAT THE PERMISSION MODEL ACTUALLY BOUNDS — read this before trusting it.
 *
 * `buildCapabilities(manifest.permissions)` gates the ExtensionContext API and nothing else.
 * This is a full Node process: the module loaded by `await import(req.mainPath)` below can
 * `import("node:child_process")`, `node:fs` or `node:net` directly and never touch a single
 * proxy. The declared permissions are therefore a description of what an extension says it
 * needs through the SUPPORTED API — not a confinement of what its code can do.
 *
 * This header used to assert the opposite — that the process is stripped of ambient authority
 * altogether — which is simply false, and is the more dangerous half: a reader who believes it
 * will treat an unreviewed `.promext` as sandboxed. It is not. Forking into a separate process buys ISOLATION FROM MAIN
 * AND THE RENDERER (a crash or a hang here cannot take the window with it, and the extension
 * cannot reach Electron APIs) — that is the property this file genuinely provides.
 *
 * The load-bearing control on untrusted extension code is therefore INSTALL-TIME: the
 * `.promext` is nemesis-gated before it is ever unpacked into the extensions directory
 * (`main/ext-host.ts` → `isBlocked`), which is why that gate must stay fail-closed. Treat an
 * extension as code you are choosing to RUN, not as code that is boxed in.
 *
 * Imports only @prometheus/core (pure) + node built-ins — no electron.
 */
import { ext as coreExt } from "@prometheus/core";

// the ext types live under core's `ext` namespace (`export * as ext`) — alias for brevity.
type ActivateFn = coreExt.ActivateFn;
type Disposable = coreExt.Disposable;
type ExtensionBackends = coreExt.ExtensionBackends;
type ExtensionManifest = coreExt.ExtensionManifest;
type WebviewMessage = coreExt.WebviewMessage;

interface ExtRunnerRequest {
  reqId: string;
  op: "activate" | "deactivate";
  id: string;
  mainPath?: string;
  manifest?: ExtensionManifest;
}
interface ExtRunnerResponse {
  reqId: string;
  ok: boolean;
  error?: string;
}

/** Electron utilityProcess parentPort (postMessage/on("message")). */
interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  start?(): void;
}
type ProcWithPort = NodeJS.Process & { parentPort?: ParentPortLike };

/** Bind the transport: returns a poster + registers an inbound handler. */
function bindTransport(onMessage: (m: unknown) => void): (msg: unknown) => void {
  const proc = process as ProcWithPort;
  const port = proc.parentPort;
  if (port && typeof port.postMessage === "function") {
    port.on("message", (e) => onMessage(e.data));
    port.start?.();
    return (msg) => port.postMessage(msg);
  }
  if (typeof process.send === "function") {
    process.on("message", (m) => onMessage(m));
    return (msg) => {
      process.send?.(msg);
    };
  }
  return () => {
    /* no parent — standalone */
  };
}

// ── reverse-RPC to the host (each capability call is gated main-side) ───────── //
let rpcSeq = 0;
const rpcPending = new Map<string, (msg: WebviewMessage) => void>();
let post: (msg: unknown) => void = () => {};

/** Call a host capability over reverse-RPC; resolves with its result or throws its error. */
function hostCall(extId: string, method: string, params: unknown): Promise<unknown> {
  const rpcId = `r${++rpcSeq}`;
  const msg: WebviewMessage = { type: method, id: rpcId, payload: params };
  return new Promise<unknown>((resolve, reject) => {
    rpcPending.set(rpcId, (reply) => {
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.payload);
    });
    post({ hostRpc: true, rpcId, extId, msg });
  });
}

/** Build reverse-RPC backends for an extension (every method proxies to the gated host). */
function proxyBackends(extId: string): ExtensionBackends {
  const call = (m: string, p: unknown): Promise<unknown> => hostCall(extId, m, p);
  return {
    commands: {
      register: () => ({ dispose: () => {} }),
      execute: (id, ...args) => call("commands.execute", { id, args }),
    },
    ui: {
      showPanel: (id) => void call("ui.showPanel", { id }),
      notify: (level, msg) => void call("ui.notify", { level, msg }),
    },
    workspace: {
      rootUri: "",
      readFile: (path) => call("workspace.readFile", { path }) as Promise<Uint8Array>,
    },
    engine: { run: (argv) => call("engine.run", { argv }) },
    mcp: {
      listServers: () => [],
      callTool: (ref, args) => call("mcp.callTool", { ref, args }),
    },
    secrets: {
      get: (key) => call("secrets.get", { key }) as Promise<string | undefined>,
      store: (key, val) => call("secrets.store", { key, val }) as Promise<void>,
    },
  };
}

/** Active extensions in THIS process: their disposables (for deactivate). */
const activated = new Map<string, Disposable[]>();

async function activate(req: ExtRunnerRequest): Promise<void> {
  if (!req.mainPath || !req.manifest) throw new Error("activate requires mainPath + manifest");
  const caps = coreExt.buildCapabilities(req.manifest.permissions);
  const ctx = coreExt.createExtensionContext(proxyBackends(req.id), caps);
  // dynamic import of the extension's main module (its default/`activate` export).
  const mod = (await import(req.mainPath)) as { activate?: ActivateFn; default?: ActivateFn };
  const fn = mod.activate ?? mod.default;
  if (typeof fn !== "function") throw new Error(`extension ${req.id} has no activate() export`);
  await fn(ctx);
  activated.set(req.id, ctx.subscriptions);
}

function deactivate(id: string): void {
  const subs = activated.get(id);
  if (subs) {
    for (const s of subs) {
      try {
        s.dispose();
      } catch {
        /* a bad dispose must not block the rest */
      }
    }
    activated.delete(id);
  }
}

async function handle(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object") return;
  // a host-rpc reply for one of OUR outbound capability calls?
  const rep = raw as { hostRpcReply?: unknown; rpcId?: unknown; msg?: WebviewMessage };
  if (rep.hostRpcReply === true && typeof rep.rpcId === "string") {
    const cb = rpcPending.get(rep.rpcId);
    if (cb && rep.msg) {
      rpcPending.delete(rep.rpcId);
      cb(rep.msg);
    }
    return;
  }
  const req = raw as ExtRunnerRequest;
  if (typeof req.reqId !== "string" || (req.op !== "activate" && req.op !== "deactivate")) return;
  const reply = (res: Omit<ExtRunnerResponse, "reqId">): void => post({ reqId: req.reqId, ...res });
  try {
    if (req.op === "activate") await activate(req);
    else deactivate(req.id);
    reply({ ok: true });
  } catch (e) {
    reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

post = bindTransport((m) => void handle(m));
