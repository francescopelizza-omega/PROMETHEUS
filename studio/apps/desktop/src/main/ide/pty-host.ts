/**
 * main/ide/pty-host.ts — integrated-terminal PTYs (file 07 §6.1).
 *
 * `pty-host` spawns shells via node-pty (xterm.js renders them in the renderer).
 * Multiple named, splittable terminals; the renderer NEVER spawns a child (C5) —
 * it drives this host over the `pty:*` IPC channel (spawn/write/resize/kill) and
 * receives output over a `pty:data` push.
 *
 * THE LOAD-BEARING BEHAVIOUR is venv INHERITANCE (file 07 §6.1 / file 04): a new
 * terminal inherits the active env so `(.venv) $ python …` / `pip install …` use
 * the project env without a manual `activate`. We build the child environment by:
 *   - cwd = the workspace root,
 *   - PATH = prepend `<venv>/bin` (POSIX) or `<venv>\Scripts` (Windows),
 *   - VIRTUAL_ENV = the venv root,
 *   - drop PYTHONHOME (a stale value breaks a venv interpreter).
 * This is the pure `buildVenvEnv` below — fully testable without a real shell.
 *
 * DECOUPLED FROM node-pty (honest env limit): node-pty is a NATIVE addon and is
 * NOT installed here (it is `external` in the electron-vite build + declared in
 * package.json `dependencies`). So the backend is an INTERFACE (`PtyBackend`) with
 * TWO impls: a thin node-pty adapter (`nodePtyBackend`, lazy-required so a missing
 * addon never crashes import) and a FAKE backend the tests drive round-trip. The
 * host logic + the env construction are exercised now against the fake.
 *
 * SECURITY NOTE (file 07 §6.1): the interactive terminal is intentionally the
 * user's UNRESTRICTED shell — we do NOT sandbox keystrokes. The AI agent NEVER
 * types into it silently; agent shell commands go through the separate
 * confirm-gated task runner (file 07 §7.3), not this interactive PTY.
 *
 * Node built-ins only: node:events + node:module. node-pty is required lazily
 * (never at import).
 */

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { homedir } from "node:os";

/* ------------------------------------------------------------------------- *
 * The PtyBackend interface (node-pty impl + fake impl)
 * ------------------------------------------------------------------------- */

/** Options to spawn one pty (resolved cwd/env already include the venv). */
export interface PtySpawnOptions {
  shell: string;
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

/** A live pty process the backend returns (node-pty's IPty subset we use). */
export interface PtyProcess {
  pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}

/**
 * The pty backend the host spawns through (injectable). The real impl wraps
 * node-pty; the fake impl drives the host in tests without the native addon.
 */
export interface PtyBackend {
  spawn(opts: PtySpawnOptions): PtyProcess;
}

/**
 * A synchronous `require` that works in BOTH a CJS and an ESM main bundle.
 *
 * electron-vite builds the desktop MAIN process as ESM (the package is
 * `type: module` and only the preload is force-emitted to `.cjs`). An ESM bundle
 * has NO `require` binding and `globalThis.require` is `undefined` — so the old
 * `globalThis.require("node-pty")` ALWAYS threw "requires a CommonJS require",
 * every spawn failed, and the integrated terminal reported "No terminal backend"
 * even though node-pty was installed. We derive a real synchronous require from
 * `import.meta.url` instead (falling back to a global/CJS `require` when present,
 * e.g. the node:test runner). node-pty is N-API so it loads under Node AND
 * Electron without an electron-rebuild.
 */
function resolveNodeRequire(): (m: string) => unknown {
  const g = (globalThis as { require?: (m: string) => unknown }).require;
  if (typeof g === "function") return g;
  return createRequire(import.meta.url);
}

/**
 * The node-pty backend (real). node-pty is a native addon + an `external` in the
 * build; it is required LAZILY — constructing this backend never throws at import,
 * only when an actual spawn is attempted without the addon present. The MAIN
 * process wires this in production (file 07 §1). A failure here is caught by the
 * IPC layer and surfaced as a graceful "no terminal backend" notice.
 */
export function nodePtyBackend(): PtyBackend {
  return {
    spawn(opts: PtySpawnOptions): PtyProcess {
      // Lazy require so a missing native addon does not break module import / tests.
      const req = resolveNodeRequire();
      const pty = req("node-pty") as {
        spawn(
          shell: string,
          args: string[],
          o: {
            cwd: string;
            env: Record<string, string>;
            cols: number;
            rows: number;
            name?: string;
          },
        ): {
          pid: number;
          write(d: string): void;
          resize(c: number, r: number): void;
          onData(cb: (d: string) => void): void;
          onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
          kill(s?: string): void;
        };
      };
      const proc = pty.spawn(opts.shell, opts.args ?? [], {
        // APP-073: an empty cwd (no workspace folder open) spawns the shell in the user's HOME,
        // never the Electron process cwd (the app-bundle dir in a packaged build).
        cwd: opts.cwd || homedir(),
        env: opts.env,
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        name: "xterm-color",
      });
      return {
        pid: proc.pid,
        write: (d) => proc.write(d),
        resize: (c, r) => proc.resize(c, r),
        onData: (cb) => proc.onData(cb),
        onExit: (cb) => proc.onExit(cb),
        kill: (s) => proc.kill(s),
      };
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Venv-inheritance env construction (pure, the §6.1 load-bearing bit)
 * ------------------------------------------------------------------------- */

/** The active env the terminal should inherit (from the env-store, file 04). */
export interface ActiveVenv {
  /** the venv root (e.g. `/proj/.venv`). */
  root: string;
  /** the platform: drives `bin` vs `Scripts` + the PATH separator. */
  platform?: "win32" | "posix";
}

/**
 * Build the child env for a terminal that inherits the active venv (file 07 §6.1).
 * Pure: given a base env (process.env snapshot) + the active venv (or none) it
 * returns the env to pass to the backend. With NO venv it returns the base env
 * unchanged. With a venv it:
 *   - prepends `<root>/bin` (posix) or `<root>\Scripts` (win) to PATH,
 *   - sets VIRTUAL_ENV = root,
 *   - removes PYTHONHOME (a stale value breaks the venv interpreter).
 * Deterministic — the same inputs always yield the same env.
 */
export function buildVenvEnv(
  baseEnv: Readonly<Record<string, string>>,
  venv: ActiveVenv | null | undefined,
): Record<string, string> {
  if (!venv || !venv.root) return { ...baseEnv };
  const isWin = venv.platform === "win32";
  const sep = isWin ? ";" : ":";
  const binDir = isWin ? `${venv.root}\\Scripts` : `${venv.root}/bin`;
  const pathKey = isWin ? findPathKey(baseEnv) : "PATH";
  const current = baseEnv[pathKey] ?? "";
  // Rebuild WITHOUT PYTHONHOME (a stale value would override the venv's site) —
  // a fresh object rather than `delete` so the result is clean + lint-friendly.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (k === "PYTHONHOME") continue;
    env[k] = v;
  }
  env[pathKey] = current ? `${binDir}${sep}${current}` : binDir;
  env.VIRTUAL_ENV = venv.root;
  return env;
}

/** Windows env keys are case-insensitive; find the existing PATH-ish key (default "Path"). */
function findPathKey(env: Readonly<Record<string, string>>): string {
  for (const k of Object.keys(env)) if (k.toLowerCase() === "path") return k;
  return "Path";
}

/** A snapshot of process.env as a plain Record (the default terminal base env). */
export function processEnvSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof process !== "undefined" && process.env) {
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * The host
 * ------------------------------------------------------------------------- */

/** A serialisable snapshot of one terminal. */
export interface PtyStatus {
  ptyId: string;
  cwd: string;
  shell: string;
  alive: boolean;
  /** whether this terminal inherited a venv (for the `(.venv)` status chip). */
  venvRoot?: string;
  exitCode?: number;
}

export interface PtyHostEvents {
  /** a chunk of terminal output (→ xterm.js). */
  data: [{ ptyId: string; data: string }];
  /** the terminal exited. */
  exit: [{ ptyId: string; exitCode: number }];
}

/** Options the renderer passes to spawn a terminal (no spawnable command, C5). */
export interface PtySpawnRequest {
  /** workspace root → cwd (and the venv lookup key). */
  cwd: string;
  /** the shell to run (default: $SHELL / cmd.exe). The renderer may NOT pass argv-with-injection; the host runs the bare shell. */
  shell?: string;
  cols?: number;
  rows?: number;
  /** the active venv to inherit (resolved by the IPC layer from the env-store). */
  venv?: ActiveVenv | null;
  /** extra env overrides (merged AFTER the venv env — e.g. TERM). */
  env?: Record<string, string>;
}

export interface PtyHostOptions {
  backend: PtyBackend;
  /** the base env each terminal starts from (default: process.env snapshot). */
  baseEnv?: Record<string, string>;
  /** the default shell when a request omits one. Default $SHELL or /bin/bash. */
  defaultShell?: string;
  /** id minter (injectable). Default a counter. */
  mintId?: () => string;
}

interface Terminal {
  ptyId: string;
  cwd: string;
  shell: string;
  proc: PtyProcess;
  alive: boolean;
  venvRoot?: string;
  exitCode?: number;
}

/** The PTY host: spawns/owns terminals, builds the venv env, relays I/O. */
export class PtyHost extends EventEmitter {
  private readonly backend: PtyBackend;
  private readonly baseEnv: Record<string, string>;
  private readonly defaultShell: string;
  private readonly mintId: () => string;
  private readonly terminals = new Map<string, Terminal>();
  private idCounter = 0;
  private disposed = false;

  constructor(opts: PtyHostOptions) {
    super();
    this.backend = opts.backend;
    this.baseEnv = opts.baseEnv ?? processEnvSnapshot();
    this.defaultShell =
      opts.defaultShell ??
      (this.baseEnv.SHELL || (this.baseEnv.ComSpec ?? this.baseEnv.COMSPEC) || "/bin/bash");
    this.mintId = opts.mintId ?? (() => `pty-${++this.idCounter}`);
  }

  override on<K extends keyof PtyHostEvents>(
    event: K,
    listener: (...args: PtyHostEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof PtyHostEvents>(event: K, ...args: PtyHostEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Spawn a terminal that inherits the active venv (file 07 §6.1). Returns its
   * ptyId; output arrives on the `data` event. The child env is built by
   * `buildVenvEnv` from the host base env + the request's venv, then merged with
   * any explicit `env` overrides.
   */
  spawn(req: PtySpawnRequest): { ptyId: string } {
    if (this.disposed) throw new Error("PtyHost disposed");
    const ptyId = this.mintId();
    const shell = req.shell ?? this.defaultShell;
    const env = { ...buildVenvEnv(this.baseEnv, req.venv), ...(req.env ?? {}) };

    const proc = this.backend.spawn({
      shell,
      cwd: req.cwd,
      env,
      ...(req.cols !== undefined ? { cols: req.cols } : {}),
      ...(req.rows !== undefined ? { rows: req.rows } : {}),
    });

    const term: Terminal = {
      ptyId,
      cwd: req.cwd,
      shell,
      proc,
      alive: true,
      ...(req.venv?.root ? { venvRoot: req.venv.root } : {}),
    };
    this.terminals.set(ptyId, term);

    proc.onData((data) => this.emit("data", { ptyId, data }));
    proc.onExit((e) => {
      term.alive = false;
      term.exitCode = e.exitCode;
      this.emit("exit", { ptyId, exitCode: e.exitCode });
      this.terminals.delete(ptyId);
    });

    return { ptyId };
  }

  /** Write user keystrokes / pasted text to a terminal (xterm.js → pty). */
  write(ptyId: string, data: string): void {
    const term = this.terminals.get(ptyId);
    if (!term || !term.alive) return;
    term.proc.write(data);
  }

  /** Resize a terminal (xterm.js fit-addon → pty cols/rows). */
  resize(ptyId: string, cols: number, rows: number): void {
    const term = this.terminals.get(ptyId);
    if (!term || !term.alive) return;
    term.proc.resize(cols, rows);
  }

  /** Kill a terminal (the user closed the tab). */
  kill(ptyId: string, signal?: string): void {
    const term = this.terminals.get(ptyId);
    if (!term) return;
    try {
      term.proc.kill(signal);
    } catch {
      /* already dead */
    }
    term.alive = false;
    this.terminals.delete(ptyId);
  }

  /** A serialisable snapshot of one terminal (or undefined). */
  status(ptyId: string): PtyStatus | undefined {
    const t = this.terminals.get(ptyId);
    return t ? this.toStatus(t) : undefined;
  }

  /** Snapshot of every live terminal. */
  list(): PtyStatus[] {
    return [...this.terminals.values()].map((t) => this.toStatus(t));
  }

  /** Kill every terminal (app shutdown). */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.terminals.keys()]) this.kill(id);
  }

  private toStatus(t: Terminal): PtyStatus {
    return {
      ptyId: t.ptyId,
      cwd: t.cwd,
      shell: t.shell,
      alive: t.alive,
      ...(t.venvRoot ? { venvRoot: t.venvRoot } : {}),
      ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    };
  }
}
