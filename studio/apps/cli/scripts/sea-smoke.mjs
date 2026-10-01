#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * sea-smoke.mjs — prove the SEA `prometheus` binary works WITHOUT node_modules / a repo checkout (CLI-099).
 *
 * Runs the built binary from a throwaway temp cwd for `help`, `--version`, and `gate <fixture>`, and
 * asserts:
 *   - help + --version exit 0 (stderr is ignored — Node emits an ExperimentalWarning through SEA);
 *   - `gate <fixture>` returns a VALID nemesis tier exit (0/10/20/2) AND the SAME code the dev CLI
 *     returns for the same fixture+env — parity with an npm install (acceptance §2).
 *
 * Assumes `build-sea.mjs` has produced apps/cli/release/prom-<host>. Exits non-zero on any mismatch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..");
const target = `${process.platform}-${process.arch}`;
// mirror build-sea.mjs's output naming: Windows → prometheus.exe, else prom-<os>-<arch>.
const bin = join(CLI, "release", target.startsWith("win") ? "prometheus.exe" : `prom-${target}`);

if (!existsSync(bin)) {
  console.error(`[smoke] binary not found: ${bin} — run \`node scripts/build-sea.mjs\` first`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "prom-sea-smoke-")); // a dir with NO node_modules
const fixture = join(tmp, "fixture.txt");
writeFileSync(fixture, "print('hello from a benign fixture')\n");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

// run the binary from the temp cwd (proves no node_modules dependency).
const runBin = (args) => spawnSync(bin, args, { cwd: tmp, encoding: "utf8" });
// the dev CLI reference (same brains an npm install ships), for the gate-parity comparison.
const runDev = (args) =>
  spawnSync(
    process.execPath,
    ["--import", join(CLI, "dev-register.mjs"), join(CLI, "src", "bin.ts"), ...args],
    {
      cwd: tmp,
      encoding: "utf8",
    },
  );

try {
  const help = runBin(["help"]);
  check("prometheus help exits 0 (no node_modules)", help.status === 0, `exit ${help.status}`);
  check("prometheus help prints usage", /USAGE|prometheus /.test(help.stdout ?? ""));

  const ver = runBin(["--version"]);
  check("prometheus --version exits 0", ver.status === 0, `exit ${ver.status}`);
  check(
    "prometheus --version prints a version",
    /prometheus \d|prometheus \S/.test(ver.stdout ?? ""),
  );

  // gate parity: the binary and the dev CLI must agree on the tier exit code for the same input+env.
  const VALID_TIERS = new Set([0, 10, 20, 2]);
  const gBin = runBin(["gate", fixture]);
  const gDev = runDev(["gate", fixture]);
  check(
    "prometheus gate returns a valid nemesis tier exit",
    VALID_TIERS.has(gBin.status ?? -1),
    `exit ${gBin.status}`,
  );
  check(
    "prometheus gate exit matches the dev/npm CLI (parity)",
    gBin.status === gDev.status,
    `binary ${gBin.status} vs dev ${gDev.status}`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n[smoke] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\n[smoke] all checks passed — the SEA binary behaves like an npm install");
