#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * fake-kernel.mjs — a deterministic stand-in for `python3 kernel.py serve`, used by
 * kernel-sidecar.test.ts so the bridge's NDJSON line-reader + fail-closed + dispose
 * logic can be tested WITHOUT jupyter_client/ipykernel on the box.
 *
 * Spawned as the "pythonBin": the bridge runs `spawn(node, [thisFile, "serve", ...])`.
 * It mimics kernel.py's serve protocol: emits `ready` at start, reads one JSON request
 * per stdin line, and writes NDJSON events. Special code markers drive edge cases:
 *   - code containing "HANG"  → emit NO terminal `done` (an in-flight cell)
 *   - code containing "NOISE" → print a non-JSON banner line to stdout (must be ignored)
 *   - otherwise                → a `stream` chunk echoing the code, then `done{ok}`.
 */
import readline from "node:readline";

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let count = 0;
emit({ event: "ready", kernel: "python3", execution_count: 1 });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try {
    req = JSON.parse(s);
  } catch {
    return;
  }
  const { op, id, code, name } = req;
  if (op === "shutdown") {
    process.exit(0);
  } else if (op === "interrupt") {
    // A running cell would abort; the fake just acknowledges via a status event.
    emit({ event: "status", id: id ?? null, execution_state: "interrupted" });
  } else if (op === "restart") {
    count = 0;
    emit({ event: "ready", kernel: "python3", execution_count: 1 });
  } else if (op === "vars") {
    emit({ event: "vars", variables: [{ name: "x", type: "int", repr: "1" }] });
  } else if (op === "inspect") {
    emit({ event: "inspect", name: name ?? "", found: true, type: "int", repr: "1" });
  } else if (op === "execute") {
    if (typeof code === "string" && code.includes("NOISE")) {
      process.stdout.write("this is not json — a kernel banner line\n");
    }
    emit({ event: "stream", id: id ?? null, name: "stdout", text: String(code ?? "") });
    if (typeof code === "string" && code.includes("HANG")) return; // never finishes
    count += 1;
    emit({ event: "done", id: id ?? null, status: "ok", execution_count: count });
  }
});

rl.on("close", () => process.exit(0));
