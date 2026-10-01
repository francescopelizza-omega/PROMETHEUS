// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tmux/tmux.ts — the injection-safe tmux command builder + runner (P6 core).
 *
 * This is the JS mirror of the engine's `_tmux_launch` (prometheus.py): it builds
 * a named, DETACHED tmux session, optionally splits it into extra windows/panes,
 * lays them out, then ATTACHES. Two invariants carry over verbatim from the engine:
 *
 *   1. INJECTION-SAFE: a window's command is a list of discrete tokens. We shlex-
 *      quote each token (mirroring Python's `shlex.quote`) and join them into the
 *      ONE command string tmux re-parses — so a path with a space or a `$(...)` in
 *      a previewed argv can NEVER break out into the shell tmux spawns. We NEVER
 *      hand-build a raw shell string; the engine already returned a safe argv.
 *   2. IDEMPOTENT: `tmux has-session -t NAME` short-circuits creation. If the
 *      session already exists we attach to it instead of re-creating windows.
 *
 * Everything that touches the machine — the `tmux` binary lookup and the spawn —
 * lives behind an INJECTED seam (`TmuxDeps`) so the pure builder
 * (`buildTmuxCommands`) and the gates (`tmuxAvailable` / `tmuxEnabled`) unit-test
 * without ever spawning tmux. `runTmux` is crash-free: a missing binary or a spawn
 * failure renders a friendly line and returns a nonzero code; it never throws and
 * always restores the terminal on the way out.
 *
 * Color flows ONLY through ../render.ts (c.* helpers, which source their SGR codes
 * from @prometheus/ui/tokens) — no raw hex, no bespoke ANSI.
 */
import { createRequire } from "node:module";
import type { ChatTerminalEnvelope } from "@prometheus/engine-bridge";

import type { ParsedArgs } from "../parse.js";
import { c } from "../render.js";

// ── injected seams ───────────────────────────────────────────────────────── //

/** Result of running one tmux invocation through the injected runner. */
export interface TmuxRunResult {
  /** process exit code (0 = success); a failed spawn surfaces as nonzero. */
  status: number;
  /** captured stderr (used to surface a friendly failure line). */
  stderr?: string;
}

/**
 * The machine-touching seam. Defaults (resolved lazily, only when a method is
 * actually called) wrap `node:child_process` + `process.env.PATH`. Tests inject a
 * scripted fake so NOTHING spawns.
 */
export interface TmuxDeps {
  /** look a binary up on PATH; returns its path or null. Used by `tmuxAvailable`. */
  lookupBin?: (bin: string) => string | null;
  /** run ONE tmux invocation (argv WITHOUT the leading "tmux"); capture status/stderr. */
  run?: (argv: string[]) => TmuxRunResult;
  /** ATTACH to a session (the foreground, inherited-stdio invocation). */
  attach?: (session: string) => TmuxRunResult;
  /** env source for the PATH lookup (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** restore the terminal (raw-mode → cooked) on every exit path. */
  restoreTty?: () => void;
  /** output sink (defaults to process.stdout.write). */
  write?: (line: string) => void;
}

// ── the tmux session spec ────────────────────────────────────────────────── //

/** One window inside the tmux session (the first is the session's main window). */
export interface TmuxWindow {
  /** the window name (tmux `-n NAME`), e.g. "main" / "chat" / "health". */
  name: string;
  /** the discrete argv to run in this window (injection-safe; quoted by the builder). */
  argv: string[];
  /** optional per-window env overrides (prefixed as `K=V ` before the command). */
  env?: Record<string, string>;
  /** optional cwd for the window (tmux `-c DIR`). */
  cwd?: string;
}

/** The full tmux launch spec passed to `buildTmuxCommands` + `runTmux`. */
export interface TmuxSpec {
  /** the tmux session name (the `-t` / `-s` target; the has-session guard key). */
  session: string;
  /** windows to span; windows[0] is the main window created with `new-session`. */
  windows: TmuxWindow[];
  /** tmux layout to apply once windows exist ("tiled" by default; null = leave). */
  layout?: "tiled" | "even-horizontal" | "even-vertical" | "main-vertical" | null;
}

// ── shlex-safe quoting (mirror of Python's shlex.quote / shlex.join) ──────── //

// Characters that are safe UNQUOTED in a POSIX shell — anything else forces quoting.
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a single token the way Python's `shlex.quote` does: empty → '', a token of
 * only-safe chars passes through, otherwise wrap in single quotes and escape any
 * embedded single quote as `'"'"'`. This is what makes a previewed argv token
 * injection-safe inside the one command string tmux re-parses.
 */
export function shlexQuote(token: string): string {
  if (token === "") return "''";
  if (SAFE_TOKEN.test(token)) return token;
  return `'${token.replace(/'/g, `'"'"'`)}'`;
}

/** Join an argv into a single shell-safe string (mirror of Python's shlex.join). */
export function shlexJoin(argv: string[]): string {
  return argv.map(shlexQuote).join(" ");
}

/**
 * Build the ONE command string tmux runs for a window: an env prefix (each value
 * shlex-quoted, mirroring the engine's `f"{k}={shlex.quote(v)} "`) followed by the
 * shlex-joined argv. Pure — no spawning, deterministic key order preserved.
 */
export function windowCommand(win: TmuxWindow): string {
  const prefix = Object.entries(win.env ?? {})
    .map(([k, v]) => `${k}=${shlexQuote(v)} `)
    .join("");
  return prefix + shlexJoin(win.argv);
}

// ── pure builder ─────────────────────────────────────────────────────────── //

/**
 * Build the injection-safe tmux command list for a spec. Each entry is one tmux
 * invocation as a discrete argv (WITHOUT the leading "tmux" — the runner adds it),
 * already shell-safe (no shell ever sees these as a string). The shape mirrors the
 * engine's `_tmux_launch`, extended for multiple windows:
 *
 *   [ ["has-session","-t",NAME] ]                         ← idempotent guard (run first)
 *   [ ["new-session","-d","-s",NAME,"-n",main,cmd], ... ] ← created only if guard fails
 *   [ ["new-window","-t",NAME,"-n",w2,cmd], ... ]
 *   [ ["select-layout","-t",NAME,layout] ]                ← if a layout is set
 *   [ ["select-window","-t",NAME":"main] ]                ← focus the main window
 *
 * NOTE: this returns the CREATE plan (guard + create). `runTmux` runs the guard
 * first and SKIPS the create steps when the session already exists, then attaches.
 * Callers wanting just the create steps can drop the first (has-session) entry.
 */
export function buildTmuxCommands(spec: TmuxSpec): string[][] {
  const { session, windows } = spec;
  const out: string[][] = [];

  // 1) idempotent guard — checked first; create steps are conditional on it failing.
  out.push(["has-session", "-t", session]);

  const main = windows[0];
  if (main === undefined) return out; // nothing to create — guard-only.

  // 2) the main window: a detached new-session running the main command.
  const newSession = ["new-session", "-d", "-s", session, "-n", main.name];
  if (main.cwd !== undefined) newSession.push("-c", main.cwd);
  newSession.push(windowCommand(main));
  out.push(newSession);

  // 3) any extra windows.
  for (let i = 1; i < windows.length; i++) {
    const win = windows[i];
    if (win === undefined) continue;
    const newWindow = ["new-window", "-t", session, "-n", win.name];
    if (win.cwd !== undefined) newWindow.push("-c", win.cwd);
    newWindow.push(windowCommand(win));
    out.push(newWindow);
  }

  // 4) optional layout (default "tiled" when >1 window; explicit null leaves it).
  const layout = spec.layout === undefined ? (windows.length > 1 ? "tiled" : null) : spec.layout;
  if (layout !== null) out.push(["select-layout", "-t", session, layout]);

  // 5) focus the main window so the user lands there on attach.
  out.push(["select-window", "-t", `${session}:${main.name}`]);

  return out;
}

// ── gates (pure, no spawning) ────────────────────────────────────────────── //

/**
 * Look `tmux` up on PATH (via the injected lookup, else a lazy node:child_process
 * default). Pure-ish: it only probes the binary, never launches a session. Returns
 * false (never throws) when the lookup itself fails.
 */
export function tmuxAvailable(deps?: TmuxDeps): boolean {
  const lookup = deps?.lookupBin ?? defaultLookupBin(deps?.env);
  try {
    return lookup("tmux") !== null;
  } catch {
    return false;
  }
}

/**
 * Are we running INSIDE a live tmux session right now? (tmux sets $TMUX to the server
 * socket path when a client is attached.) This is what triggers orchestrator mode — the
 * session can fan subagents into panes of the CURRENT session, not a new one.
 */
export function insideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.TMUX === "string" && env.TMUX.length > 0;
}

/**
 * Did the user OPT IN to tmux? True iff any of:
 *   - the `--tmux` flag is present (`--tmux` alone OR `--tmux NAME`),
 *   - `PROMETHEUS_TMUX=1` in the environment,
 *   - the `terminal.tmux` setting is truthy (passed through `deps.settingTmux`).
 * Flag/env only — this is intent, NOT availability (see `tmuxAvailable`).
 */
export function tmuxEnabled(
  parsed: ParsedArgs,
  deps?: { env?: Record<string, string | undefined>; settingTmux?: boolean },
): boolean {
  if (parsed.flags.tmux !== undefined) return true;
  const env = deps?.env ?? process.env;
  if (env.PROMETHEUS_TMUX === "1") return true;
  if (deps?.settingTmux === true) return true;
  return false;
}

/**
 * Resolve the tmux session NAME from the parsed flags: `--tmux NAME` → "NAME",
 * a bare `--tmux` (true) → the fallback. Used to seed a TmuxSpec.session.
 */
export function tmuxSessionName(parsed: ParsedArgs, fallback = "prometheus"): string {
  const v = parsed.flags.tmux;
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

// ── runner (crash-free, behind the injected seam) ─────────────────────────── //

/**
 * Execute a tmux spec: run the idempotent guard, CREATE the windows only when the
 * session is new, apply the layout, then ATTACH. Crash-free — a missing binary or
 * a spawn failure renders a friendly line and returns a nonzero code; the terminal
 * is restored on EVERY exit path (success, miss, error). Returns the attach exit
 * code (or a nonzero on any pre-attach failure).
 */
export async function runTmux(spec: TmuxSpec, deps?: TmuxDeps): Promise<number> {
  const write = deps?.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const restore = deps?.restoreTty ?? (() => {});

  try {
    if (!tmuxAvailable(deps)) {
      write(c.yellow("tmux not found on PATH — falling back to a single window."));
      return 2;
    }

    const run = deps?.run ?? defaultRun(deps?.env);
    const attach = deps?.attach ?? defaultAttach(deps?.env);

    const plan = buildTmuxCommands(spec);
    const [guard, ...createSteps] = plan;

    // 1) idempotent guard: 0 = session exists → attach only; nonzero → create.
    const exists = guard !== undefined && run(guard).status === 0;
    if (exists) {
      write(c.dim(`tmux session '${spec.session}' already exists — attaching.`));
    } else {
      for (const step of createSteps) {
        const res = run(step);
        if (res.status !== 0) {
          const why = res.stderr?.trim();
          write(c.red(`tmux ${step[0]} failed${why ? `: ${why}` : ""}.`));
          return res.status === 0 ? 1 : res.status;
        }
      }
      write(c.dim(`tmux session '${spec.session}' started (detached) — detach with Ctrl-b d.`));
    }

    // 2) attach (foreground; blocks until the user detaches/exits).
    const att = attach(spec.session);
    return att.status;
  } catch (err) {
    write(c.red(`tmux launch failed: ${errMessage(err)}`));
    return 1;
  } finally {
    // ALWAYS restore the terminal — raw-mode must never leak past tmux.
    try {
      restore();
    } catch {
      /* restore must never itself crash the exit path */
    }
  }
}

/**
 * Wrap a single terminal-chat ChatTerminalEnvelope in a one-window tmux session and
 * run it (the `chat --cli <svc> --tmux` path). The engine already returned the
 * injection-safe `argv` + `env` + `cwd`; we only assemble the session around them.
 * The session name comes from the envelope's `tmux` field (a bare `--tmux` yields
 * `null` → the default name). Crash-free + tty-restoring via `runTmux`.
 */
export async function runTmuxFromEnvelope(
  env: ChatTerminalEnvelope,
  deps?: TmuxDeps,
): Promise<number> {
  const session = env.tmux && env.tmux.length > 0 ? env.tmux : "prometheus-chat";
  const spec: TmuxSpec = {
    session,
    windows: [
      {
        name: env.cli || "chat",
        argv: env.argv,
        ...(env.env && Object.keys(env.env).length > 0 ? { env: env.env } : {}),
        ...(env.cwd ? { cwd: env.cwd } : {}),
      },
    ],
  };
  return runTmux(spec, deps);
}

// ── lazy defaults (node:child_process — only resolved when actually used) ──── //

/** PATH separator + executable extensions for the running platform. */
function pathParts(env: Record<string, string | undefined>): {
  dirs: string[];
  exts: string[];
} {
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const path = env.PATH ?? env.Path ?? "";
  const exts = isWin ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return { dirs: path.split(sep).filter(Boolean), exts };
}

/** Default binary lookup: probe each PATH dir for the bin (+ Windows extensions). */
function defaultLookupBin(
  env: Record<string, string | undefined> = process.env,
): (bin: string) => string | null {
  return (bin: string): string | null => {
    // Lazy-require so importing this module never touches fs.
    let fs: { existsSync(p: string): boolean } | undefined;
    let pathMod: { join(...p: string[]): string } | undefined;
    try {
      const nodeRequire = moduleRequire();
      fs = nodeRequire("node:fs") as typeof fs;
      pathMod = nodeRequire("node:path") as typeof pathMod;
    } catch {
      return null;
    }
    if (!fs || !pathMod) return null;
    const { dirs, exts } = pathParts(env);
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = pathMod.join(dir, bin + ext);
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          /* unreadable dir — skip */
        }
      }
    }
    return null;
  };
}

/** Default scripted runner: a captured (non-attach) tmux invocation. */
function defaultRun(
  env: Record<string, string | undefined> = process.env,
): (argv: string[]) => TmuxRunResult {
  return (argv: string[]): TmuxRunResult => {
    const cp = lazyChildProcess();
    if (!cp) return { status: 127, stderr: "child_process unavailable" };
    try {
      const res = cp.spawnSync("tmux", argv, {
        env: env as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      if (res.error) return { status: 127, stderr: String(res.error.message ?? res.error) };
      return {
        status: res.status ?? 0,
        stderr: typeof res.stderr === "string" ? res.stderr : undefined,
      };
    } catch (err) {
      return { status: 127, stderr: errMessage(err) };
    }
  };
}

/** Default attach: a foreground, inherited-stdio `tmux attach -t NAME`. */
function defaultAttach(
  env: Record<string, string | undefined> = process.env,
): (session: string) => TmuxRunResult {
  return (session: string): TmuxRunResult => {
    const cp = lazyChildProcess();
    if (!cp) return { status: 127, stderr: "child_process unavailable" };
    try {
      const res = cp.spawnSync("tmux", ["attach", "-t", session], {
        env: env as NodeJS.ProcessEnv,
        stdio: "inherit",
      });
      if (res.error) return { status: 127, stderr: String(res.error.message ?? res.error) };
      return { status: res.status ?? 0 };
    } catch (err) {
      return { status: 127, stderr: errMessage(err) };
    }
  };
}

interface ChildProcessLike {
  spawnSync(
    cmd: string,
    args: string[],
    opts: Record<string, unknown>,
  ): { status: number | null; stderr?: string | Buffer; error?: Error };
}

/**
 * Lazy-require node:child_process; returns null if unavailable (never throws).
 *
 * `globalThis.require` is undefined in this package — it is `"type": "module"` and the
 * published bundle is `--format=esm`, and `require` is never a global even under CommonJS.
 * Reading it therefore returned null on every call, so `tmuxAvailable()` was hard-wired to
 * false: `--tmux` degraded silently and `chat --cli X --tmux` reported "tmux not found on
 * PATH" on machines where tmux was installed and on PATH. `createRequire` keeps the load
 * lazy (importing this module still touches nothing) while actually working.
 */
function lazyChildProcess(): ChildProcessLike | null {
  try {
    return moduleRequire()("node:child_process") as ChildProcessLike;
  } catch {
    return null;
  }
}

/** The ESM-safe `require` used for every lazy load in this module. Built once, on demand. */
let cachedRequire: ((m: string) => unknown) | undefined;
function moduleRequire(): (m: string) => unknown {
  const ambient = (globalThis as { require?: unknown }).require;
  if (typeof ambient === "function") return ambient as (m: string) => unknown;
  cachedRequire ??= createRequire(import.meta.url) as unknown as (m: string) => unknown;
  return cachedRequire;
}

/** Coerce any thrown value into a single-line message (never throws). */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
