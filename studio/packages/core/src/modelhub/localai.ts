/**
 * modelhub/localai.ts — a PURE typed view over the engine's `localai` v1 JSON envelope
 * (CLI-026). Core never spawns python (that is engine-bridge, C5): this module only takes
 * an already-parsed envelope object and narrows it to typed structures + validates the
 * schema, so both the desktop and the CLI can consume the engine's localai data safely.
 *
 * The schema mirrors prometheus.py `_localai_envelope` (version 1). Unknown/newer versions
 * are surfaced (never silently dropped) so a caller can decide to degrade rather than trust
 * a partially-understood payload.
 */

/** The envelope schema version this typed view was written against. */
export const LOCALAI_ENVELOPE_VERSION = 1;

export type LocalaiAction = "audit" | "models" | "endpoints" | "model" | "show";

export interface LocalaiToolRow {
  tool: string;
  name: string;
  track: string;
  mode: string;
  patchable: boolean;
  recipe: string;
  note: string;
}

export interface LocalaiModelRow {
  id: string;
  name: string;
  license: string;
  params: string;
  local: string;
  ollama: string;
  served: string;
  endpoints: string[];
  note: string;
}

/** The common envelope frame every `localai <sub> --json` shares. */
export interface LocalaiEnvelope {
  command: "localai";
  version: number;
  action: LocalaiAction | string;
  ok: boolean;
  error?: string;
  /** audit */
  tools?: LocalaiToolRow[];
  local_endpoints?: Record<string, string>;
  summary?: { total: number; paid: number; patchable: number };
  /** models */
  models?: LocalaiModelRow[];
  open_endpoints?: Record<string, string>;
  /** endpoints */
  local?: Record<string, string>;
  open?: Record<string, string>;
  host_ollama?: string;
  /** model <id> */
  model?: LocalaiModelRow;
  /** show <tool> */
  tool?: LocalaiToolRow;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/**
 * Narrow an arbitrary parsed object to a `LocalaiEnvelope`, or null when it is not a
 * localai envelope at all (missing command/version). A version newer than
 * `LOCALAI_ENVELOPE_VERSION` still parses (best-effort) — the caller can compare versions.
 */
export function parseLocalaiEnvelope(obj: unknown): LocalaiEnvelope | null {
  if (!isRecord(obj)) return null;
  if (obj.command !== "localai" || typeof obj.version !== "number") return null;
  if (typeof obj.action !== "string") return null;
  return obj as unknown as LocalaiEnvelope;
}

/** True when the envelope's version exceeds what this typed view understands. */
export function isNewerLocalaiEnvelope(env: LocalaiEnvelope): boolean {
  return env.version > LOCALAI_ENVELOPE_VERSION;
}
