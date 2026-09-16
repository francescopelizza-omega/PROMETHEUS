/**
 * session/model-activity-store.ts — the ONE global "when was a local model last used"
 * timestamp, mirroring model-health-store.ts's on-disk conventions (global, not
 * per-project; fail-soft; injectable fs).
 *
 * SHARED with the desktop's own copy of this file (main/model-activity-store.ts) and the
 * VS Code extension's, the same way model-health-store-path.ts shares
 * `<home>/state/model-health.json` across surfaces — same path, same shape, so the
 * ollama-idle-shutdown watchdog (packages/engine-bridge/src/ollama-watchdog.ts) sees a
 * request from ANY surface as evidence Ollama is still in use, not just the one that
 * happened to start it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { prometheusHome } from "../home.js";

/** The fs surface this store needs (injected in tests). */
export interface ModelActivityFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string) => void;
}

const defaultFs: ModelActivityFs = {
  existsSync,
  readFileSync: (p) => readFileSync(p, "utf8"),
  writeFileSync: (p, data) => writeFileSync(p, data),
  mkdirSync: (p) => mkdirSync(p, { recursive: true }),
};

export interface ModelActivity {
  /** epoch ms of the last successful request to ANY local endpoint, from ANY surface. */
  lastActiveAt: number;
}

/** `<home>/state/model-activity.json` — the exact path every surface writes/reads. */
export function modelActivityPath(home: string = prometheusHome()): string {
  return join(home, "state", "model-activity.json");
}

/** Read the shared activity record (fail-soft → `{ lastActiveAt: 0 }`; never throws). */
export function readModelActivity(
  home: string = prometheusHome(),
  fs: ModelActivityFs = defaultFs,
): ModelActivity {
  try {
    const raw = JSON.parse(fs.readFileSync(modelActivityPath(home))) as unknown;
    const at =
      raw && typeof raw === "object" ? (raw as { lastActiveAt?: unknown }).lastActiveAt : undefined;
    return { lastActiveAt: typeof at === "number" && Number.isFinite(at) ? at : 0 };
  } catch {
    return { lastActiveAt: 0 };
  }
}

/**
 * Record "a local model was just used, right now". Never throws — a missed tick only
 * makes the watchdog stop Ollama a little earlier than it strictly needed to, which is
 * the safe direction to fail in (never the opposite: stopping it mid-use).
 */
export function touchModelActivity(
  home: string = prometheusHome(),
  fs: ModelActivityFs = defaultFs,
  now: () => number = Date.now,
): void {
  try {
    const file = modelActivityPath(home);
    fs.mkdirSync(dirname(file));
    fs.writeFileSync(file, `${JSON.stringify({ lastActiveAt: now() } satisfies ModelActivity)}\n`);
  } catch {
    /* best-effort — see docstring above. */
  }
}
