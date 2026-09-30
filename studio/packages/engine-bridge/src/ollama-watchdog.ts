/**
 * ollama-watchdog.ts — spawn (or skip, if one is already alive) the detached idle-shutdown
 * watchdog for a Prometheus-managed `ollama serve`.
 *
 * The actual poll loop lives in ollama-watchdog-entry.ts and is run as a SEPARATE `node`
 * process (detached + unref'd, the same pattern `startModelServer` uses to spawn Ollama
 * itself) — never imported — so the 15-minute idle timer survives the CLI/desktop/VS Code
 * window that triggered the start being closed. This file is the only thing other modules
 * import; it owns the one `spawn()` call (C5/SPINE: engine-bridge is the sole child_process
 * owner) and resolves the entry script's path relative to ITS OWN compiled location
 * (`import.meta.url`), so the caller never needs to know where this package's dist lives.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

import { safeChildEnv } from "./safe-env.js";

/**
 * Candidate basenames for the entry, in preference order.
 *
 * The entry is spawned BY PATH and never `import`ed, so no bundler has a reason to emit it —
 * every surface has to name it as an explicit extra build input, and they do not agree on the
 * extension. The desktop (`out/main/`) and CLI (`dist/`) bundles are ESM inside a
 * `type: module` package, so `.js` is ESM there. The VS Code extension bundle is CJS, so its
 * sibling is emitted as an unambiguous `.mjs`. And under this repo's test loader / a bare
 * source-tree run, only the `.ts` exists. Probing the list beats making any one surface's
 * layout the silent contract.
 */
const ENTRY_NAMES = [
  "ollama-watchdog-entry.js",
  "ollama-watchdog-entry.mjs",
  "ollama-watchdog-entry.ts",
] as const;

/**
 * The compiled watchdog entry script, next to this module's own bundle output.
 *
 * This is the PREFERRED name only; `resolveEntry` below is what the spawn actually uses, and
 * it probes for a file that is really there. Kept exported and `.js`-shaped because that is
 * the shipped layout and what callers/tests reason about.
 */
export function watchdogEntryPath(): string {
  return unpackedPath(fileURLToPath(new URL(`./${ENTRY_NAMES[0]}`, import.meta.url)));
}

/**
 * Map a path inside `app.asar` onto its `app.asar.unpacked` twin.
 *
 * A child process cannot exec a file inside the archive — Electron's asar shim only patches
 * `fs` inside the host process, not the kernel's view. electron-builder's `asarUnpack` puts a
 * real copy next door; this points at it. A no-op everywhere that is not a packaged app.
 */
function unpackedPath(p: string): string {
  return p.includes(`${sep}app.asar${sep}`)
    ? p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
    : p;
}

/** A TypeScript entry needs Node's type stripper — `engines.node >= 22.6` already guarantees it. */
function nodeFlagsFor(entry: string): readonly string[] {
  return entry.endsWith(".ts") ? ["--experimental-strip-types"] : [];
}

/**
 * The entry script to run, or `undefined` when none of the candidates is on disk.
 *
 * Returning `undefined` rather than a hopeful path matters: the spawn below is
 * `stdio: "ignore"` and fire-and-forget, so `node <path that is not there>` exits
 * ERR_MODULE_NOT_FOUND into `/dev/null` and is indistinguishable from a healthy detached
 * watchdog. That is how this subsystem came to be absent from every shipped build without
 * anyone noticing. `PROMETHEUS_WATCHDOG_ENTRY` overrides the search for a packaging layout we
 * have not met yet.
 */
function resolveEntry(): { entry: string; flags: readonly string[] } | undefined {
  const override = process.env.PROMETHEUS_WATCHDOG_ENTRY?.trim();
  if (override) {
    return existsSync(override) ? { entry: override, flags: nodeFlagsFor(override) } : undefined;
  }
  for (const name of ENTRY_NAMES) {
    const p = unpackedPath(fileURLToPath(new URL(`./${name}`, import.meta.url)));
    if (existsSync(p)) return { entry: p, flags: nodeFlagsFor(p) };
  }
  return undefined;
}

export interface SpawnWatchdogOptions {
  /** minutes/ms of no local-model activity before the watchdog stops the runner. */
  idleMs?: number;
  port?: number;
  processMatch?: string;
  /**
   * The canonical LOCAL_RUNNERS id (e.g. "ollama", "lmstudio") — used ONLY for the shared
   * eviction-log's `runnerId` field, so `findRecentEviction`'s correlation (keyed by
   * `runnerForBaseUrl(...).id`) actually matches. Defaults to `processMatch` when omitted,
   * which is correct for Ollama (its processMatch IS its id) but would be WRONG for any runner
   * whose process/display name differs from its LOCAL_RUNNERS id — pass this explicitly for
   * every runner other than Ollama.
   */
  runnerId?: string;
  /** human-readable name for the eviction reason/notification text. Defaults to `processMatch`. */
  displayName?: string;
  /**
   * Graceful stop argv, preferred over signalling whatever process is found listening on
   * `port` — see `LocalRunnerSpec.stop`'s doc for why this matters. Undefined ⇒ the existing
   * SIGTERM→SIGKILL escalation on the port's listener (correct for a real standalone daemon
   * like `ollama serve`).
   */
  stopCmd?: readonly string[];
}

const DEFAULT_IDLE_MS = 15 * 60 * 1000;

/**
 * Spawn the watchdog, detached + unref'd. Safe to call every time Prometheus starts Ollama —
 * the entry script's own pidfile lock (ollama-watchdog-entry.ts's `acquireLock`) makes a
 * second spawn a harmless no-op that exits immediately rather than racing the first.
 *
 * Fire-and-forget by design: a watchdog that fails to start just means Ollama keeps running
 * until stopped by hand, never a crash on the caller's turn.
 */
export function spawnWatchdogIfNeeded(opts: SpawnWatchdogOptions = {}): void {
  const resolved = resolveEntry();
  // Nothing to run. Declining is strictly better than spawning against a missing path, which
  // this call site cannot observe failing — see resolveEntry's doc.
  if (!resolved) return;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const processMatch = opts.processMatch ?? "ollama";
  const args = [
    ...resolved.flags,
    resolved.entry,
    "--idle-ms",
    String(idleMs),
    "--port",
    String(opts.port ?? 11434),
    "--process-match",
    processMatch,
    "--runner-id",
    opts.runnerId ?? processMatch,
    "--display-name",
    opts.displayName ?? processMatch,
    ...(opts.stopCmd && opts.stopCmd.length > 0
      ? ["--stop-cmd", JSON.stringify(opts.stopCmd)]
      : []),
  ];
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      // `process.execPath` is the Node binary only when THIS process is Node. In the desktop's
      // Electron MAIN process it is the Studio app binary, so spawning it with a script
      // argument launches a SECOND Studio — which `app.requestSingleInstanceLock()` answers by
      // un-minimizing and focus-stealing the user's window before the copy quits. The watchdog
      // then never exists, so neither the idle stop NOR the critical-RAM active eviction (the
      // black-screen-freeze guard this whole subsystem exists for) ever runs.
      //
      // ELECTRON_RUN_AS_NODE=1 is the only thing that makes an Electron binary execute an argv
      // script as plain Node. It is meaningless to a real Node binary, so it is set only when
      // we can see we are under Electron — that keeps the CLI's spawn byte-identical to the one
      // surface that already worked on purpose. The VS Code extension host has been surviving
      // on inheriting this same variable from its own environment, by accident.
      env: safeChildEnv(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : undefined),
      windowsHide: true,
    });
    child.on("error", () => {
      /* best-effort — see docstring */
    });
    child.unref();
  } catch {
    /* best-effort — see docstring */
  }
}
