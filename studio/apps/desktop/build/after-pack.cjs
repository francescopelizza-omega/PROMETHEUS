/**
 * build/after-pack.cjs — electron-builder afterPack hook (file 10 §2 / APP-068).
 *
 * node-pty's `spawn-helper` (macOS/Linux) is exec'd by `pty.fork` on every terminal
 * spawn. electron-builder STRIPS the executable bit while packing the asar, so even though
 * the binary is asarUnpack'd it lands under `app.asar.unpacked/` with mode 0644 → the first
 * terminal spawn fails ("posix_spawnp failed." → "No terminal backend") in the PACKAGED app.
 * The `postinstall` fix-pty-helper runs PRE-package (against node_modules), so it can't help
 * the unpacked copy — this hook re-chmods 0755 INSIDE the packaged output, per OS pack.
 *
 * Windows has no spawn-helper → clean no-op. Node built-ins only; never throws (a failure
 * here must not abort the whole package — it logs loudly instead).
 */
const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

/** The unpacked node-pty package roots inside a packed app output (per OS layout). */
function ptyRoots(appOutDir, platformName) {
  const unpacked =
    platformName === "darwin"
      ? // the .app bundle name varies; scan any *.app for its Resources.
        readdirSync(appOutDir)
          .filter((n) => n.endsWith(".app"))
          .map((app) => join(appOutDir, app, "Contents", "Resources", "app.asar.unpacked"))
      : [join(appOutDir, "resources", "app.asar.unpacked")];
  return unpacked.map((b) => join(b, "node_modules", "node-pty"));
}

/** chmod +x a `spawn-helper` directly under `dir` (if present). Returns 0/1. */
function fixUnder(dir) {
  const helper = join(dir, "spawn-helper");
  if (!existsSync(helper)) return 0;
  try {
    chmodSync(helper, 0o755);
    return 1;
  } catch (e) {
    console.warn(`after-pack: could not chmod ${helper}: ${e.message}`);
    return 0;
  }
}

/** Fix every spawn-helper a node-pty root ships: build/Release + each prebuilds/<platform>. */
function fixPtyRoot(root) {
  let fixed = fixUnder(join(root, "build", "Release"));
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
  return fixed;
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName === "win32") return; // no spawn-helper on Windows
  let fixed = 0;
  for (const root of ptyRoots(appOutDir, electronPlatformName)) {
    if (existsSync(root)) fixed += fixPtyRoot(root);
  }
  if (fixed > 0) {
    console.log(`after-pack: restored exec bit on ${fixed} node-pty spawn-helper(s).`);
  } else {
    // Not fatal — but loud, so a silently-broken terminal in the packaged app is noticed.
    console.warn("after-pack: no node-pty spawn-helper found to chmod (terminal may break).");
  }
};
