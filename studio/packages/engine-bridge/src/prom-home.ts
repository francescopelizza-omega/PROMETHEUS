/**
 * prom-home.ts — engine-bridge's LOCAL twin of core's canonical Prometheus-home resolver.
 *
 * It must stay behaviourally identical to `packages/core/src/agent/system/host/home.ts`.
 * engine-bridge cannot import core (core depends on THIS package), and `ollama-watchdog-entry.ts`
 * runs as a bare `node <path>` with no bundler and deliberately no core in its graph — so the
 * duplication is structural, not laziness. What is NOT acceptable is the two disagreeing: three
 * separate copies of `process.env.PROMETHEUS_HOME?.trim() || join(homedir(), ".prometheus")`
 * lived in start-lock.ts, eviction-log.ts and ollama-watchdog-entry.ts, none of which expanded a
 * leading `~` or made a relative value absolute. Every other surface (the CLI, the desktop, the
 * VS Code extension) writes `<home>/state/model-activity.json` through core's resolver, so a
 * `PROMETHEUS_HOME=~/sandbox` split the start lock, the eviction log and the activity file across
 * two different directories — one literally named `~`.
 *
 * Deliberately copies core's `agent/system/host/home.ts`, NOT `cli-profiles/paths.ts`'s twin:
 * the two differ on a bare `~foo`, which paths.ts maps to `<home>/foo` while the canonical
 * resolver leaves alone. This file follows the canonical one.
 *
 * Node built-ins only — nothing else may be imported here.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** The canonical Prometheus home root: $PROMETHEUS_HOME, else `~/.prometheus`. */
export function prometheusHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PROMETHEUS_HOME?.trim();
  return override ? resolve(expandTilde(override)) : join(homedir(), ".prometheus");
}

/**
 * Normalise an EXPLICIT home value (a `--prom-home` option, or `$PROMETHEUS_HOME`) the same way
 * `prometheusHome` does — tilde expanded, made absolute — while preserving "absent means absent".
 *
 * `prometheusHome()` defaults to `~/.prometheus`, which is wrong for the engine-resolution lane:
 * there, no home means "fall through to the sibling checkout / PATH", not "look in ~/.prometheus".
 */
export function expandHomeValue(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? resolve(expandTilde(v)) : undefined;
}
