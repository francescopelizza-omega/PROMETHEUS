/**
 * pty/live-terminal.ts — LAUNCH the engine's previewed terminal argv as a live,
 * interactive child (P5). This is the `chat --cli <svc> --open` in-session path:
 * the engine-bridge already returned the injection-safe `argv` + `env` + `cwd` in a
 * `ChatTerminalEnvelope` (C5 — JS NEVER hand-builds a terminal argv); we spawn THAT
 * spec exactly, wire raw-mode keystroke forwarding both ways, and stream the child's
 * output to stdout until it exits.
 *
 * NEVER-FORCE / GATE-FIRST: when `env.bypass` is set the engine has flagged a
 * permission override (e.g. --dangerously-skip-permissions). We DO NOT decide it is
 * safe — we render the engine's notes verbatim and require a TYPED confirm BEFORE the
 * child is ever spawned. A mismatch / decline returns WITHOUT launching (exit 2); the
 * engine's nemesis verdict is the only authority on danger.
 *
 * CRASH-FREE + TTY-RESTORE ON EVERY PATH: a spawn failure, a backend that lacks the
 * native pty addon, a write error, or a signal NEVER crashes the caller. stdin is put
 * in raw mode only after a successful spawn and is ALWAYS restored to cooked mode (and
 * every listener detached) via a single idempotent `restore()` in a `finally` — so the
 * terminal is never left raw, and no raw stack ever reaches the user.
 *
 * SPAWNING IS BEHIND AN INJECTED SEAM: the pty backend (`resolvePtyBackend()` — lazy
 * node-pty else child_process fallback), the stdin/stdout TTY handles, the typed-confirm
 * prompt, the output sink, and the signal registrar are all injectable. The PURE bits
 * (env merge, note rendering, the bypass phrase/prompt) are exported + unit-tested with
 * NO spawn. The tests drive a FAKE backend round-trip (data → stdout, keystroke → child,
 * exit → return code) with no real pty/tmux/engine.
 *
 * Node built-ins only. Color exclusively via render.ts (no raw hex).
 */
import type { ChatTerminalEnvelope } from "@prometheus/engine-bridge";

import { c } from "../render.js";
import { type PtyBackend, type PtyProcess, resolvePtyBackend } from "./backend.js";

/* ------------------------------------------------------------------------- *
 * Pure builders (NO spawn — unit-tested directly)
 * ------------------------------------------------------------------------- */

/** The exact phrase the human must type to clear an engine-flagged bypass launch. */
export const BYPASS_CONFIRM_PHRASE = "BYPASS";

/** A minimal TTY-ish stream we read keystrokes from (stdin) — the bits we touch. */
export interface LiveInputStream {
  readonly isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** A minimal TTY-ish stream we relay child output to (stdout) — the bits we touch. */
export interface LiveOutputStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(data: string): unknown;
}

/** A handle to a process-signal subscription so we can tear it down on exit. */
export interface SignalRegistrar {
  on(signal: "SIGWINCH", listener: () => void): unknown;
  off?(signal: "SIGWINCH", listener: () => void): unknown;
  removeListener?(signal: "SIGWINCH", listener: () => void): unknown;
}

/**
 * The injectable seams for a live launch. ALL default to the real process I/O +
 * the resolved pty backend; tests pass fakes so nothing real is spawned.
 */
export interface LiveTerminalDeps {
  /** the pty backend (default: resolvePtyBackend() — lazy node-pty / child_process). */
  backend?: PtyBackend;
  /** keystroke source (default: process.stdin). */
  stdin?: LiveInputStream;
  /** child-output sink (default: process.stdout). */
  stdout?: LiveOutputStream;
  /** the base env the child inherits BEFORE the envelope overrides (default: process.env). */
  baseEnv?: Record<string, string | undefined>;
  /** SIGWINCH source for resize propagation (default: process). */
  signals?: SignalRegistrar;
  /** write a friendly human line (notes / errors) — default: stdout.write + "\n". */
  write?: (line: string) => void;
  /**
   * typed-confirm for an engine-flagged bypass: the human must type `phrase` exactly.
   * Default: deny (false) — a non-interactive host can NEVER satisfy a never-force gate.
   */
  confirm?: (prompt: string, phrase: string) => Promise<boolean>;
}

/**
 * Merge the child env: the base env (process.env snapshot) with the envelope's
 * overrides applied LAST (the engine's env wins, e.g. GEMINI_SYSTEM_MD). Pure +
 * deterministic; undefined base values are dropped so the result is a clean
 * `Record<string,string>` ready for the backend.
 */
export function mergeLaunchEnv(
  envelope: Pick<ChatTerminalEnvelope, "env">,
  baseEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (typeof v === "string") out[k] = v;
  for (const [k, v] of Object.entries(envelope.env ?? {})) out[k] = v;
  return out;
}

/**
 * Render the engine's advisory notes for an about-to-launch terminal, verbatim
 * (we decide nothing — C5). Returns the lines to print (label header + each note
 * + the bypass warning when flagged). Pure; no I/O.
 */
export function renderLaunchNotes(envelope: ChatTerminalEnvelope): string[] {
  const lines: string[] = [];
  lines.push(`${c.bold("launch")} ${c.cyan(envelope.label)} ${c.dim(`(${envelope.cli})`)}`);
  for (const note of envelope.notes ?? []) lines.push(`  ${c.dim("•")} ${note}`);
  if (envelope.bypass) {
    lines.push(
      `  ${c.role("⚠", "danger")} ${c.yellow(
        "this launch BYPASSES the engine permission gate — type the phrase to proceed.",
      )}`,
    );
  }
  return lines;
}

/** The typed-confirm prompt shown before a bypass launch (pure string). */
export function bypassConfirmPrompt(envelope: ChatTerminalEnvelope): string {
  return (
    `'${envelope.label}' will launch with permission bypass, overriding the engine's gate.\n` +
    `Type ${BYPASS_CONFIRM_PHRASE} to proceed`
  );
}

/* ------------------------------------------------------------------------- *
 * Launch (spawn behind the injected backend seam)
 * ------------------------------------------------------------------------- */

/**
 * Launch the engine's previewed terminal argv as a live child and stream I/O until
 * it exits. Returns the child's exit code (or 128+signal). NEVER throws.
 *
 * Flow:
 *   1. if `env.bypass` → render notes, typed-confirm; deny/mismatch ⇒ return 2 (no launch).
 *   2. spawn `argv[0]` + rest via the backend in `env.cwd` with the merged env.
 *   3. raw-mode stdin; forward keystrokes → child; stream child output → stdout;
 *      propagate SIGWINCH → child.resize.
 *   4. on exit/error/signal ALWAYS restore stdin to cooked mode + detach every listener
 *      (single idempotent `restore()` in finally) and return the exit code.
 */
export async function runLiveTerminal(
  env: ChatTerminalEnvelope,
  deps: LiveTerminalDeps = {},
): Promise<number> {
  const stdout: LiveOutputStream = deps.stdout ?? (process.stdout as unknown as LiveOutputStream);
  const write = deps.write ?? ((line: string) => void stdout.write(`${line}\n`));

  // The engine may have already failed to build a launch (ok:false) — surface + bail.
  if (env.ok === false) {
    write(`launch refused: ${c.red(env.error ?? "engine declined to build the terminal")}`);
    return env._exit ?? 2;
  }
  if (!Array.isArray(env.argv) || env.argv.length === 0) {
    write(`launch refused: ${c.red("the engine returned no argv to run")}`);
    return 2;
  }

  // ── never-force gate: render notes + typed-confirm BEFORE any spawn ──────────
  for (const line of renderLaunchNotes(env)) write(line);
  if (env.bypass) {
    const confirm = deps.confirm ?? (async () => false);
    let ok = false;
    try {
      ok = await confirm(bypassConfirmPrompt(env), BYPASS_CONFIRM_PHRASE);
    } catch {
      ok = false; // a thrown prompt is a denial — never a launch
    }
    if (!ok) {
      write(c.yellow("bypass not confirmed — terminal not launched."));
      return 2;
    }
  }

  const backend = deps.backend ?? resolvePtyBackend();
  const stdin: LiveInputStream = deps.stdin ?? (process.stdin as unknown as LiveInputStream);
  const signals: SignalRegistrar = deps.signals ?? (process as unknown as SignalRegistrar);
  const baseEnv = deps.baseEnv ?? process.env;

  const childEnv = mergeLaunchEnv(env, baseEnv);
  const [shell, ...args] = env.argv;
  const cols = typeof stdout.columns === "number" ? stdout.columns : 80;
  const rows = typeof stdout.rows === "number" ? stdout.rows : 24;

  // ── spawn (the ONLY real side effect; a failure is friendly, not a crash) ────
  let proc: PtyProcess;
  try {
    proc = backend.spawn({
      shell: shell as string,
      args,
      cwd: env.cwd,
      env: childEnv,
      cols,
      rows,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    write(`failed to launch ${c.cyan(env.label)}: ${c.red(msg)}`);
    // A missing node-pty addon is the common case — hint the graceful path.
    if (/node-pty|native addon|require/i.test(msg)) {
      write(c.dim("  (a live terminal needs node-pty; preview-only still works without it)"));
    }
    return 1;
  }

  // ── wire the interactive bridge; restore() is the single teardown for every path ─
  const onStdin = (chunk: Buffer | string): void => {
    try {
      proc.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    } catch {
      /* child already gone — keystroke is harmless to drop */
    }
  };
  const onResize = (): void => {
    try {
      const w = typeof stdout.columns === "number" ? stdout.columns : cols;
      const h = typeof stdout.rows === "number" ? stdout.rows : rows;
      proc.resize(w, h);
    } catch {
      /* resize is best-effort (child_process fallback is a no-op) */
    }
  };

  const wasRaw = stdin.isRaw === true;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    // Detach our listeners FIRST so nothing fires mid-teardown.
    detach(stdin, "data", onStdin);
    detachSignal(signals, "SIGWINCH", onResize);
    // Return stdin to cooked mode (only if we touched it + it is a TTY).
    if (stdin.isTTY === true && typeof stdin.setRawMode === "function" && !wasRaw) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* best-effort — never throw from teardown */
      }
    }
    try {
      stdin.pause?.();
    } catch {
      /* ignore */
    }
  };

  try {
    // Raw mode + resume so single keystrokes reach the child (only on a real TTY).
    if (stdin.isTTY === true && typeof stdin.setRawMode === "function" && !wasRaw) {
      try {
        stdin.setRawMode(true);
      } catch {
        /* a refused raw-mode degrades to line-buffered input — still usable */
      }
    }
    try {
      stdin.resume?.();
    } catch {
      /* ignore */
    }

    stdin.on("data", onStdin);
    proc.onData((data) => {
      try {
        stdout.write(data);
      } catch {
        /* a broken stdout pipe must not crash the bridge */
      }
    });
    signals.on("SIGWINCH", onResize);

    // Resolve with the child's exit code (or 128+signal). Any wiring throw above is
    // caught by the outer try → restore + friendly return; the promise never rejects.
    const code = await new Promise<number>((resolve) => {
      proc.onExit(({ exitCode, signal }) => {
        if (typeof signal === "number" && signal > 0) {
          resolve(128 + signal);
        } else {
          resolve(typeof exitCode === "number" ? exitCode : 0);
        }
      });
    });
    return code;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    write(`live terminal error: ${c.red(msg)}`);
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
    // an EXCEPTION on this path (spawn/raw-mode failure) is a hard error — return a
    // clear nonzero code, not a signal-derived one (the child never ran to be signalled).
    return 1;
  } finally {
    restore();
  }
}

/* ------------------------------------------------------------------------- *
 * Tiny listener-detach helpers (handle the off/removeListener variance)
 * ------------------------------------------------------------------------- */

function detach(
  stream: LiveInputStream,
  event: "data",
  listener: (chunk: Buffer | string) => void,
): void {
  try {
    if (typeof stream.off === "function") stream.off(event, listener);
    else if (typeof stream.removeListener === "function") stream.removeListener(event, listener);
  } catch {
    /* best-effort */
  }
}

function detachSignal(reg: SignalRegistrar, signal: "SIGWINCH", listener: () => void): void {
  try {
    if (typeof reg.off === "function") reg.off(signal, listener);
    else if (typeof reg.removeListener === "function") reg.removeListener(signal, listener);
  } catch {
    /* best-effort */
  }
}
