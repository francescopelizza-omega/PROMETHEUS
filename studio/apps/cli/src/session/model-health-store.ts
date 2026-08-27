/**
 * session/model-health-store.ts — the ONE global on-disk record of every endpoint's health
 * (transport, breaker, context window), as last observed by any turn in any project.
 *
 * Unlike path-frecency-store.ts (this file's sibling and model), model health is NOT
 * per-project: there is a single store for the whole Prometheus install, keyed by
 * `endpointId`. The scoring/merge logic lives in @prometheus/core's ai/model-health —
 * this file is only the on-disk I/O, mirroring path-frecency-store.ts's fail-soft,
 * injected-fs conventions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  type EndpointHealthRecord,
  type ModelHealthStore,
  mergeHealthRecord,
} from "@prometheus/core";

import { prometheusHome } from "../home.js";

/** The fs surface this store needs (injected in tests). */
export interface ModelHealthFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string) => void;
}

const defaultFs: ModelHealthFs = {
  existsSync,
  readFileSync: (p) => readFileSync(p, "utf8"),
  writeFileSync: (p, data) => writeFileSync(p, data),
  mkdirSync: (p) => mkdirSync(p, { recursive: true }),
};

function storeFile(home: string): string {
  return join(home, "state", "model-health.json");
}

/** Load the global model-health store (fail-soft → {}; never throws). */
export function loadModelHealth(
  home: string = prometheusHome(),
  fs: ModelHealthFs = defaultFs,
): ModelHealthStore {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(home))) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ModelHealthStore) : {};
  } catch {
    return {};
  }
}

/** Persist the global model-health store. Never throws — a failed write costs one lost
 *  health sample, not a crash mid-session. */
export function saveModelHealth(
  store: ModelHealthStore,
  home: string = prometheusHome(),
  fs: ModelHealthFs = defaultFs,
): void {
  try {
    fs.mkdirSync(dirname(storeFile(home)));
    fs.writeFileSync(storeFile(home), `${JSON.stringify(store, null, 2)}\n`);
  } catch {
    /* best-effort — a lost health sample is not worth surfacing to the user. */
  }
}

/** Record one endpoint's health, persisting + returning the resulting store. */
export function recordEndpointHealth(
  record: EndpointHealthRecord,
  home: string = prometheusHome(),
  fs: ModelHealthFs = defaultFs,
): ModelHealthStore {
  const next = mergeHealthRecord(loadModelHealth(home, fs), record);
  saveModelHealth(next, home, fs);
  return next;
}
