#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * echo-argv-engine.mjs — a deterministic stand-in for `python3 prometheus.py` that
 * ECHOES the exact argv it received back in the JSON envelope, so the lifecycle/catalog
 * argv-BUILDER tests can assert the contract WITHOUT spawning the real engine or changing
 * any state:
 *   - GLOBAL flags (--dry-run/--yes/--strict/--force) come BEFORE the subcommand (C2),
 *   - --host is repeatable, --only/--skip/--arm/--component land after the subcommand,
 *   - the run layer prepends "--json --no-color" which we strip from the echo.
 *
 * Invoked as the "pythonBin": the bridge runs `spawn(pythonBin, [prometheusPy, ...args])`,
 * so argv[2] is the prometheus.py path (the fixture itself, ignored) and argv[3:] is
 * "--json --no-color <globalFlags...> <subcmd> ...". We echo argv[3:] (minus the two
 * leading global render flags) as `argvEcho`, and the first non-flag token as `command`.
 */
const args = process.argv.slice(2); // [prometheusPyPath, "--json", "--no-color", ...]
const afterPath = args.slice(1); // drop the prometheus.py path
// drop the two render flags the bridge always prepends.
let rest = afterPath;
if (rest[0] === "--json") rest = rest.slice(1);
if (rest[0] === "--no-color") rest = rest.slice(1);

const positionals = rest.filter((a) => !a.startsWith("-"));
const subcmd = positionals[0] ?? "unknown";

process.stderr.write(`echo-argv-engine: ${rest.join(" ")}\n`);

const envelope = {
  command: subcmd,
  ok: true,
  argvEcho: rest, // the EXACT argv the builder produced (after the render flags)
  _exit: 0,
};
process.stdout.write(`${JSON.stringify(envelope)}\n`);
process.exit(0);
