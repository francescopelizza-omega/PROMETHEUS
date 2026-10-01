// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/vault.ts — the `vault` (status) envelope (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json vault` @ 0.15.0):
 *   {"command":"vault","ok":true,"action":"status",
 *    "root":str|null,"initialized":bool,
 *    "repos":[{"id","name","source":"plugin",
 *              "stored_versions":[..],"state":"absent"}]}
 * (invoke/rollback are interactive and not driven through --json here.)
 */
import type { EnvelopeBase } from "./envelope.js";

/** One repo the offline Repo Vault tracks. */
export interface VaultRepo {
  id: string;
  name: string;
  /** provenance of the repo entry, e.g. "plugin". */
  source: string;
  /** locally-stored version ids, empty when nothing is cached. */
  stored_versions: string[];
  /** "absent" | "stored" | … vault storage state. */
  state: string;
}

export type VaultEnvelope = EnvelopeBase<{
  command: "vault";
  /** the vault sub-action; "status" for a bare `vault`. */
  action: string;
  /** the vault root path, or null when not initialised. */
  root: string | null;
  initialized: boolean;
  repos: VaultRepo[];
}>;
