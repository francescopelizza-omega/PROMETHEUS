// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * env-ref.ts — turning the Environments panel's row id into something the sidecar knows.
 *
 * Split out of `env-ipc.ts` because that module imports `electron`, so nothing in it can be
 * unit-tested. This rule needs to be: it is the whole reason the Environments tab was
 * non-functional.
 */

/**
 * Translate a renderer-facing env id to the sidecar's identifier using a known id→name map.
 *
 * `null` means "not answerable from this map" — the caller refreshes and asks again. Split out of
 * the registrar so the rule is testable without a sidecar: `env:list` hands the renderer rows
 * whose `id` is `env_<hash>` (a djb2 of the path, minted by engine-bridge purely as a React key)
 * while the envmgr sidecar resolves environments by NAME, and every handler passed the id
 * straight through. Measured on real environments: `env:doctor {id:"env_1t4gemz"}` → ok:false
 * "environment not found", `{id:"skytronix"}` → ok:true; `pkg:list` with the id → `{ok:true,
 * packages:[]}`, a SUCCESS with no rows, so the package table rendered empty and nothing
 * signalled an error.
 */
export function resolveEnvRefWith(
  byId: ReadonlyMap<string, string>,
  idOrName: string,
): string | null {
  if (!idOrName.startsWith("env_")) return idOrName; // already a name or a path
  return byId.get(idOrName) ?? null;
}
