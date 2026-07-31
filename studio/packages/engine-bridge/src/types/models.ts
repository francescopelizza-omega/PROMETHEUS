/**
 * types/models.ts — typed envelopes for `models config` + `models browse`.
 *
 * Both share command "models" (with many other actions install/uninstall/...), so
 * they are NOT in the discriminated union — facade methods return the precise type.
 *
 * GROUND TRUTH:
 *   `models config --show`  → {"command":"models","ok":true,"action":"config",
 *                              "models_root":"/Users/.../.prometheus/models","exists":false}
 *   `models browse`         → {"command":"models","ok":true,"action":"browse","models":[...]}
 */
import type { EnvelopeBase } from "./envelope.js";

export type ModelsConfigEnvelope = EnvelopeBase<{
  command: "models";
  action: "config";
  /** the default folder where local models/tools install. */
  models_root: string;
  exists: boolean;
}>;

/** One open model in the local-run catalog (the model picker). */
export interface OpenModelRow {
  id: string;
  name: string;
  params: string;
  license: string;
  /** ollama tag for a local pull, or "" when served-only. */
  ollama: string;
  served: string;
  note: string;
}

export type ModelsBrowseEnvelope = EnvelopeBase<{
  command: "models";
  action: "browse";
  models: OpenModelRow[];
}>;
