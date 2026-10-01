#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * build-sea.mjs — build a self-contained `prometheus` binary via Node Single Executable Application (SEA).
 * (CLI-099 / plan 11 §8 M7.)
 *
 * Pipeline:
 *   1. esbuild-bundle src/bin.ts → ONE CommonJS blob (SEA runs the injected blob as CJS). ESM
 *      `import.meta.url` is shimmed to a valid `file://` URL (a bundled module's path-walks then
 *      fall through to the env/PATH engine lanes — correct for a relocatable binary). node-pty +
 *      the optional Ink view stay `--external` (native / dynamic-import-only, unbundlable).
 *   2. `node --experimental-sea-config` → the prep blob.
 *   3. copy the running `node` → release/prometheus(-<platform>); on macOS strip its signature FIRST.
 *   4. postject-inject the blob (macOS needs `--macho-segment-name NODE_SEA`); re-sign on macOS
 *      (`codesign --sign -`) or AMFI SIGKILLs the binary.
 *   5. print a size report (blob + final binary — expect ~node-sized, ≈110–120 MB).
 *
 * Usage: node scripts/build-sea.mjs [--platform=darwin-arm64|linux-x64]  (default: the host)
 * Output: apps/cli/release/  (gitignored). Build-time only — esbuild + postject are devDependencies.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");
const REL = join(CLI, "release");
const SEA = join(REL, "sea");

/** The exact fuse sentinel Node ships (do not change) — postject targets it. */
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const host = `${process.platform}-${process.arch}`;
const argPlatform = (process.argv.find((a) => a.startsWith("--platform=")) ?? "").split("=")[1];
// SEA injects the blob into a COPY of the running `node`, so it CANNOT cross-compile — a
// `--platform` that differs from the host would silently produce a host binary under the wrong
// name. Reject it: run this on the matching host (per-OS CI matrix) instead.
if (argPlatform && argPlatform !== host) {
  console.error(
    `[sea] cannot cross-compile: --platform=${argPlatform} but the host is ${host}. SEA copies the host node binary — build each target on its own OS/arch (CI matrix).`,
  );
  process.exit(1);
}
const target = host;
const isMac = process.platform === "darwin";
const version = JSON.parse(readFileSync(join(CLI, "package.json"), "utf8")).version;

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", cwd: CLI, ...opts });
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

async function main() {
  mkdirSync(SEA, { recursive: true });
  const blobEntry = join(SEA, "prometheus.cjs");
  const prepBlob = join(SEA, "prom-prep.blob");
  const binName = target.startsWith("win") ? "prometheus.exe" : `prometheus-${target}`;
  const binOut = join(REL, binName);

  // 1) esbuild → CJS blob. import.meta.url shimmed to a valid file:// URL via banner + define.
  console.log(`[sea] bundling src/bin.ts → ${blobEntry} (cjs)`);
  const esbuild = require("esbuild");
  await esbuild.build({
    entryPoints: [join(CLI, "src", "bin.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: blobEntry,
    external: ["chalk", "ink", "ink-select-input", "ink-spinner", "react", "yargs", "node-pty"],
    // The version is BAKED IN. A SEA has no package.json on disk, so `resolvePromVersion`'s
    // walk-up finds nothing and `prometheus --version` printed 0.0.0 in every packaged build.
    define: {
      "import.meta.url": "__SEA_IMPORT_META_URL__",
      __PROM_CLI_VERSION__: JSON.stringify(version),
    },
    banner: {
      js: 'const __SEA_IMPORT_META_URL__ = require("url").pathToFileURL(__filename).href;',
    },
    logLevel: "warning",
  });

  // 2) generate the SEA prep blob (disable the per-run experimental warning inside the blob).
  const seaConfig = join(SEA, "sea-config.json");
  const config = {
    main: blobEntry,
    output: prepBlob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  require("node:fs").writeFileSync(seaConfig, `${JSON.stringify(config, null, 2)}\n`);
  console.log("[sea] node --experimental-sea-config");
  sh(process.execPath, ["--experimental-sea-config", seaConfig]);

  // 3) copy the host node binary; strip its macOS signature BEFORE injection.
  console.log(`[sea] copy ${process.execPath} → ${binOut}`);
  copyFileSync(process.execPath, binOut);
  chmodSync(binOut, 0o755);
  if (isMac) {
    try {
      sh("codesign", ["--remove-signature", binOut]);
    } catch {
      /* an already-unsigned node is fine */
    }
  }

  // 4) inject the blob (macOS Mach-O needs the segment name); re-sign on macOS.
  const postject = require.resolve("postject/dist/cli.js");
  const injectArgs = [postject, binOut, "NODE_SEA_BLOB", prepBlob, "--sentinel-fuse", FUSE];
  if (isMac) injectArgs.push("--macho-segment-name", "NODE_SEA");
  console.log("[sea] postject inject NODE_SEA_BLOB");
  sh(process.execPath, injectArgs);
  if (isMac) sh("codesign", ["--sign", "-", binOut]);

  // 5) size report (deliverable 5) — node-sized, not a small standalone.
  console.log("\n[sea] size report");
  console.log(`  target        ${target}`);
  console.log(`  version       ${version}`);
  console.log(`  bundle blob   ${mb(statSync(blobEntry).size)}`);
  console.log(`  prep blob     ${mb(statSync(prepBlob).size)}`);
  console.log(`  final binary  ${mb(statSync(binOut).size)}   → ${binOut}`);
}

main().catch((e) => {
  console.error(`[sea] build failed: ${e?.message ?? e}`);
  rmSync(SEA, { recursive: true, force: true });
  process.exit(1);
});
