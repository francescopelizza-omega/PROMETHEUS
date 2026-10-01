#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * fake-engine.mjs — a deterministic stand-in for `python3 prometheus.py` used by
 * the sidecar tests (mutation-queue serialization + cancelAll). It mimics the
 * contract just enough:
 *   - reads argv AFTER the leading "--json --no-color" the bridge prepends,
 *   - appends a START line to $FAKE_ENGINE_LOG, sleeps $FAKE_ENGINE_SLEEP_MS,
 *     appends an END line, then prints ONE JSON envelope on stdout and exits 0.
 *   - human/log noise goes to stderr (so onStderr has something to chew on).
 *
 * Invoked as the "pythonBin": the sidecar runs `spawn(pythonBin, [prometheusPy,
 * ...args])`, so argv[2] is the prometheus.py path (ignored) and argv[3:] is
 * "--json --no-color <subcmd> ...". We echo the subcommand back as `command`.
 *
 * The START/END bracketing in the shared log file lets a test assert that two
 * serialized mutations did NOT interleave: a clean run looks like
 *   START a / END a / START b / END b   (never START a / START b / ...).
 */
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2); // [prometheusPyPath, "--json", "--no-color", ...globalFlags, subcmd, ...]
const rest = args.slice(1); // drop the prometheus.py path
// The subcommand is the FIRST non-flag token (after --json/--no-color AND any
// global flags like --dry-run/--yes/--strict/--force the bridge puts up front).
const positionals = rest.filter((a) => !a.startsWith("-"));
const subcmd = positionals[0] ?? "unknown";
// a stable per-call tag: the next positional (e.g. the plugin name), else subcmd.
const tag = positionals[1] ?? subcmd;

const log = process.env.FAKE_ENGINE_LOG;
const sleepMs = Number(process.env.FAKE_ENGINE_SLEEP_MS ?? "60");

if (log) appendFileSync(log, `START ${tag}\n`);
process.stderr.write(`fake-engine: running ${subcmd} ${tag}\n`);

setTimeout(() => {
  if (log) appendFileSync(log, `END ${tag}\n`);
  // ONE JSON object on stdout, terminated by \n (the contract).
  const envelope = {
    command: subcmd,
    ok: true,
    request: { plugin: tag, dry_run: true, target_agents: ["claude"] },
    results: { install_events: [], summary: {} },
    _exit: 0,
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  process.exit(0);
}, sleepMs);
