/**
 * telemetry.ts — local-first, opt-in, auditable telemetry (file 10 §8).
 *
 * A security IDE's telemetry posture is a feature, not an afterthought:
 *   - OFF by default. Nothing leaves the machine until the user opts in (§8.1).
 *   - LOCAL audit log always: every event is appended to a user-readable JSONL on
 *     disk (~/.config/prometheus-studio/events.jsonl), never auto-sent (§8.2).
 *   - If (and only if) opted in, a SCRUBBED copy is queued for upload — `scrub`
 *     strips $HOME paths, repo URLs, and sensitive-named fields. PII budget = 0 (§8.3).
 *
 * Pure + injectable: `enabled`/`append`/`now`/`upload` are deps so this unit-tests
 * with a fake sink (no real fs, no real clock). The desktop wires the real sinks.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface StudioEvent {
  /** event name, e.g. "install", "gate.block", "model.download". */
  type: string;
  [key: string]: unknown;
}

export interface StudioEventRecord extends StudioEvent {
  at: string; // ISO timestamp
}

/** The on-disk, user-readable, never-auto-sent event log path (§8.2). */
export function eventsLogPath(home: string = homedir()): string {
  return join(home, ".config", "prometheus-studio", "events.jsonl");
}

/** Field names whose values are redacted wholesale before any upload (§8.3). */
const SENSITIVE_KEY = /(repo|url|path|model|stdout|stderr|token|secret|key|email)/i;
const URL_RE = /\bhttps?:\/\/\S+/gi;

function scrubString(s: string, home: string): string {
  return s.split(home).join("~").replace(URL_RE, "[url]");
}

/**
 * Strip identifying data from an event for upload (§8.3). $HOME paths → "~", URLs →
 * "[url]", and any sensitive-named field → "[redacted]". `type` is always kept. Pure;
 * does not mutate the input.
 */
export function scrub(evt: StudioEvent, home: string = homedir()): StudioEvent {
  const out: StudioEvent = { type: evt.type };
  for (const [key, value] of Object.entries(evt)) {
    if (key === "type") continue;
    if (SENSITIVE_KEY.test(key)) {
      out[key] = "[redacted]";
    } else if (typeof value === "string") {
      out[key] = scrubString(value, home);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface TelemetryDeps {
  /** is upload opted-in? default implementations return false (OFF). */
  enabled(): boolean;
  /** append one JSONL line to the LOCAL log (always called). */
  append(line: string): void;
  /** current ISO timestamp. */
  now(): string;
  /** queue a SCRUBBED event for upload — called ONLY when enabled() is true. */
  upload?(scrubbed: StudioEvent): void;
}

export interface Telemetry {
  /** record an event: always local; scrubbed-upload only if opted in. */
  record(evt: StudioEvent): void;
}

/** Build a telemetry recorder over injected sinks (§8). */
export function createTelemetry(deps: TelemetryDeps): Telemetry {
  return {
    record(evt: StudioEvent): void {
      const record: StudioEventRecord = { ...evt, at: deps.now() };
      deps.append(JSON.stringify(record)); // ALWAYS local (§8.2)
      if (deps.enabled() && deps.upload) deps.upload(scrub(evt)); // only if opted in (§8.1/§8.3)
    },
  };
}
