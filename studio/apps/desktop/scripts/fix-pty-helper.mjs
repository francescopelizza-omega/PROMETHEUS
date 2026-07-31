/**
 * scripts/fix-pty-helper.mjs — restore the executable bit on node-pty's
 * `spawn-helper` binary (wired as `postinstall`).
 *
 * node-pty ships a prebuilt `spawn-helper` (macOS/Linux) that its `pty.fork`
 * execs via posix_spawn on every terminal spawn. pnpm's content-addressed store
 * can extract it WITHOUT the executable bit — the first spawn then fails with
 * "posix_spawnp failed." and the integrated terminal reports "No terminal
 * backend" even though node-pty is installed and loads fine. We chmod every
 * spawn-helper node-pty ships back to 0o755 so the shell can be exec'd.
 *
 * Idempotent + non-fatal: a missing node-pty (not installed this pass, or
 * Windows which has no spawn-helper) is a clean no-op. Node built-ins only.
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Resolve node-pty's package root, or null when it is not installed. */
function ptyRoot() {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

/** chmod +x a `spawn-helper` directly under `dir` (if present). Returns 0/1. */
function fixUnder(dir) {
  const helper = join(dir, "spawn-helper");
  if (!existsSync(helper)) return 0;
  try {
    chmodSync(helper, 0o755);
    return 1;
  } catch {
    return 0;
  }
}

const root = ptyRoot();
if (root) {
  let fixed = 0;
  // build/Release (node-gyp build) + every prebuilds/<platform> dir (prebuildify).
  fixed += fixUnder(join(root, "build", "Release"));
  const pre = join(root, "prebuilds");
  if (existsSync(pre)) {
    for (const entry of readdirSync(pre)) {
      const d = join(pre, entry);
      try {
        if (statSync(d).isDirectory()) fixed += fixUnder(d);
      } catch {
        /* skip an unreadable prebuild dir */
      }
    }
  }
  if (fixed > 0) console.log(`fix-pty-helper: chmod +x ${fixed} spawn-helper binary(ies)`);
}
