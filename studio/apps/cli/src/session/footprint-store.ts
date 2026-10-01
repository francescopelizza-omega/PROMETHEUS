// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/footprint-store.ts — where the memory ledger lives, and how it is filled.
 *
 * The arithmetic is in `core/src/ai/footprint-ledger.ts`; this is the disk and the harvesting.
 *
 * ── ITS OWN FILE, NOT settings.json ─────────────────────────────────────────────────────────
 *
 * `saveSettings` is a shallow `{...loadSettings(), ...patch}` that rewrites the whole file, so a
 * store that appends rows on every model load would be rewriting the user's settings on every
 * model load — and any bug in this code would take their configuration with it. A cache belongs
 * beside the other derived state, under `state/`, where deleting it costs nothing but a
 * re-measurement.
 *
 * ── HARVESTING COSTS NOTHING ────────────────────────────────────────────────────────────────
 *
 * The most valuable observations are already on disk. ollama logs the exact size of every KV
 * cache it has ever allocated, with the cell count that sized it, for every load going back to
 * whenever the log rotated. Reading that turns a cold machine's FIRST admission decision from a
 * prediction into a recollection — no model loaded, no memory spent, no waiting.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ai } from "@prometheus/core";

import { ensureHomeTree, prometheusHome } from "../home.js";

/** Rows live under `state/`, with the other derived data. */
export function ledgerFile(home: string = prometheusHome()): string {
  return join(home, "state", "model-footprints.json");
}

/** Read the ledger. Fail-soft: a corrupt file is an empty ledger, never a crash. */
export function loadLedger(home: string = prometheusHome()): ai.FootprintObservation[] {
  try {
    return ai.parseObservations(readFileSync(ledgerFile(home), "utf8"));
  } catch {
    return [];
  }
}

/** Write the ledger. Never throws — losing a cache must not end a session. */
export function saveLedger(
  rows: readonly ai.FootprintObservation[],
  home: string = prometheusHome(),
): void {
  try {
    ensureHomeTree(home);
    writeFileSync(ledgerFile(home), `${JSON.stringify(rows, null, 2)}\n`);
  } catch {
    /* a read-only home, a full disk — the ledger is an optimisation, not a requirement */
  }
}

/** Add one observation and persist. Returns the new ledger. */
export function remember(
  obs: ai.FootprintObservation,
  home: string = prometheusHome(),
): ai.FootprintObservation[] {
  const next = ai.recordObservation(obs, loadLedger(home));
  saveLedger(next, home);
  return next;
}

/* ── harvesting ollama's own log ────────────────────────────────────────────────────────────*/

/** Where ollama keeps its server log, per platform. */
export function ollamaLogPaths(home: string = homedir()): string[] {
  const mac = join(home, ".ollama", "logs", "server.log");
  const macApp = join(home, "Library", "Logs", "Ollama", "server.log");
  const linux = join(home, ".ollama", "logs", "server.log");
  return [...new Set([mac, macApp, linux])];
}

/**
 * The tail of a log file, without reading the whole thing.
 *
 * ollama's `server.log` runs to tens of megabytes on a machine that has been loading models for
 * months. Reading it whole to find the last few allocations would cost more memory than the
 * estimate it produces is trying to save — which would be a joke at this module's expense.
 */
export function readTail(path: string, maxBytes = 2 * 1024 * 1024): string | null {
  try {
    const size = statSync(path).size;
    if (size <= maxBytes) return readFileSync(path, "utf8");
    const buf = Buffer.alloc(maxBytes);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, maxBytes, size - maxBytes);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf8");
    // The first line is almost certainly cut in half; drop it rather than mis-parse it.
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : text;
  } catch {
    return null;
  }
}

/**
 * Read every ollama log we can find and fold what it says into the ledger.
 *
 * Only records that carry BOTH a KV size and the cell count are usable — without the context a
 * reading cannot be re-scaled, and re-scaling is the entire point. Records whose model could not
 * be identified are skipped here (they are still returned by the parser for anyone who wants to
 * show them) because a ledger row without a model is a row nothing can ever match.
 *
 * Returns how many observations were added, so a caller can say so or stay quiet.
 */
export function harvestOllamaLog(opts: { home?: string; userHome?: string } = {}): {
  added: number;
  scanned: number;
} {
  const home = opts.home ?? prometheusHome();
  let ledger = loadLedger(home);
  const before = ledger.length;
  let scanned = 0;

  for (const path of ollamaLogPaths(opts.userHome)) {
    if (!existsSync(path)) continue;
    const text = readTail(path);
    if (!text) continue;
    scanned++;
    const records = ai.latestPerModel(ai.parseOllamaLog(text));
    for (const r of records) {
      if (!r.model || r.kvBytes === undefined || r.contextTokens === undefined) continue;
      ledger = ai.recordObservation(
        {
          model: r.model,
          contextTokens: r.contextTokens,
          // NO `totalBytes`. The log reports the cache and the tensor buffers exactly and their
          // sum with the runner's own overhead not at all — writing `weights + kv` here would
          // later be subtracted back to an overhead of exactly zero and called a measurement.
          kvBytes: r.kvBytes,
          ...(r.weightsBytes !== undefined ? { weightsBytes: r.weightsBytes } : {}),
          ...(isKvType(r.kvType) ? { kvType: r.kvType } : {}),
          // The log has no timestamp this parser reads, and dating it "now" would make an old
          // reading look fresh. `statSync` on the file is the closest honest answer available.
          observedAt: fileTime(path),
          via: "server-log",
        },
        ledger,
      );
    }
  }
  if (ledger.length !== before) saveLedger(ledger, home);
  return { added: ledger.length - before, scanned };
}

function isKvType(s: string | undefined): s is ai.KvCacheType {
  return s === "f16" || s === "q8_0" || s === "q4_0";
}

function fileTime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}
