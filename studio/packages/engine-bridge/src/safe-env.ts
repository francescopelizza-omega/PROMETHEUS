// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * safe-env.ts — the curated child environment for every engine/sidecar/nemesis spawn.
 *
 * The engine-bridge is the ONLY JS process that spawns python3 / nemesis (C5). Passing
 * the parent's `process.env` wholesale lets a hijack variable present in the parent
 * environment (a dynamic-linker preload, a Python import-path / startup hook) run
 * attacker code INSIDE the security subprocess BEFORE the gate logic ever executes —
 * defeating the fail-closed scanner from the outside. We strip that class of variables
 * with a denylist (preserving everything else, so legitimately-needed vars like HF_TOKEN
 * / PATH / HOME still pass through).
 */

/** Exact env var names that can hijack what a child interpreter loads/executes. */
const STRIP_EXACT = new Set([
  // dynamic linker preload / search-path hijacks (glibc + musl)
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  // Python import-path / startup-code hijacks
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONEXECUTABLE",
  "PYTHONUSERBASE",
  "PYTHONBREAKPOINT",
  "PYTHONCASEOK",
  // Node loader hijacks (the .mjs sidecar runners + any node child)
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  // shell startup-file hooks (defensive even with shell:false)
  "BASH_ENV",
  "ENV",
]);

/** Prefixes whose every variable is a linker/loader hijack (macOS dyld family). */
const STRIP_PREFIX = ["DYLD_"];

/**
 * Build a curated env for a child process: the parent env minus the hijack-class variables
 * above, plus any explicit `extra` overrides — which are filtered by the SAME denylist.
 *
 * `extra` used to be applied last with no filtering, which re-admitted exactly what the loop
 * above had just stripped. That mattered because one caller's `extra` is not trusted: the
 * desktop's `ide:kernel.start` passes the RENDERER's env straight through
 * (ide-ipc → kernelHost.start → spawnKernelSidecar → `safeChildEnv(opts.env)`), and the renderer
 * is the process these guards exist to survive (C5). A compromised renderer could set
 * LD_PRELOAD, DYLD_INSERT_LIBRARIES, PYTHONPATH or PYTHONSTARTUP on a long-lived python3 that
 * MAIN spawns, loading attacker-controlled code into it.
 *
 * Filtering here rather than at that one call site is deliberate: this function is the single
 * place that knows the denylist, and a caller that has to remember to pre-filter is a caller
 * that will eventually forget. A refused key is dropped silently — `extra` is a request, not a
 * command, and every legitimate in-repo use (MPLBACKEND, PYTHONUNBUFFERED) is unaffected.
 */
/**
 * Is this env var name one of the hijack class — a variable that changes what a child
 * interpreter LOADS or EXECUTES before its own code runs?
 *
 * Exported because the denylist had been copied, badly, into surfaces that do their own env
 * filtering. `apps/desktop/src/main/ide/run-host.ts` and its renderer twin each carried seven
 * names and called it a "mirror" of this list; this list has fifteen plus the whole `DYLD_`
 * family. The ten they were missing include `BASH_ENV` and `ENV` (shell startup hooks),
 * `PYTHONSTARTUP` and `PYTHONPATH` (import/startup hijacks), `LD_AUDIT`, and every `DYLD_*`
 * beyond the two spelled out — `DYLD_FRAMEWORK_PATH` and `DYLD_FALLBACK_LIBRARY_PATH` passed
 * straight through.
 *
 * A security denylist is exactly the wrong thing to keep two of: the copy does not fail when it
 * falls behind, it just quietly permits more. One predicate, imported.
 *
 * Note this does NOT include `PATH`. Stripping it would break every child here, which needs to
 * find its interpreter. A caller filtering USER-SUPPLIED overrides (as opposed to the inherited
 * parent env) should refuse `PATH` as well, on top of this.
 */
export function isHijackEnvKey(name: string): boolean {
  const k = name.toUpperCase();
  return STRIP_EXACT.has(k) || STRIP_PREFIX.some((p) => k.startsWith(p));
}

export function safeChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (STRIP_EXACT.has(k)) continue;
    if (STRIP_PREFIX.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue;
      // the SAME denylist the inherited env goes through — see the note above
      if (STRIP_EXACT.has(k)) continue;
      if (STRIP_PREFIX.some((p) => k.startsWith(p))) continue;
      out[k] = v;
    }
  }
  return out;
}
