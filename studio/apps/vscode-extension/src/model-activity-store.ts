/**
 * model-activity-store.ts — this extension's half of the ONE shared "when was a local model
 * last used" file, mirroring apps/desktop/src/main/model-activity-store.ts and
 * apps/cli/src/session/model-activity-store.ts exactly: the CLI's location IS the shared file
 * (`$PROMETHEUS_HOME/state/model-activity.json`), no separate app-private copy.
 *
 * Read by packages/engine-bridge/src/ollama-watchdog-entry.ts's idle-shutdown loop.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { prometheusHome } from "@prometheus/core/agent-system-host";

/** Record "a local model was just used, right now". Never throws — see the CLI sibling's doc
 *  for why a missed tick is the safe direction to fail in. */
export function touchModelActivity(): void {
  try {
    const file = join(prometheusHome(), "state", "model-activity.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ lastActiveAt: Date.now() })}\n`);
  } catch {
    /* best-effort */
  }
}
