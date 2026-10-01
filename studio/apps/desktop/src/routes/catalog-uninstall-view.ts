// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/catalog-uninstall-view.ts — PURE flow logic for the GUI uninstall path
 * (APP-006). JSX-free so node:test pins the confirm-gates-mutation contract:
 * dry-run first → typed-confirm → commit; an ok:false envelope surfaces inline
 * and NEVER refetches optimistically — the row leaves only after a real commit
 * succeeds and the post-invalidation refetch confirms it.
 */

/** The typed-confirm target: set only by a SUCCESSFUL dry-run preview. */
export interface UninstallPending {
  name: string;
  /** the engine's removal plan (summary/message), shown in the confirm dialog. */
  plan: string | null;
}

export interface UninstallStep {
  pending: UninstallPending | null;
  error: { name: string; error: string } | null;
  /** true ONLY after a real (dryRun:false) commit resolved ok — the sole refetch path. */
  refetch: boolean;
}

/** The envelope slice both uninstall surfaces share ({ok, error} + optional plan).
 *  `summary` is a Record on the catalog surface and `message` a string — both are
 *  coerced defensively (partial IPC payloads are the known crash pattern). */
export interface UninstallEnvelope {
  ok: boolean;
  summary?: unknown;
  message?: unknown;
  error?: string;
}

const PLAN_MAX_CHARS = 400;

function planText(res: UninstallEnvelope): string | null {
  const raw =
    typeof res.message === "string" && res.message
      ? res.message
      : res.summary !== null && res.summary !== undefined
        ? typeof res.summary === "string"
          ? res.summary
          : safeJson(res.summary)
        : null;
  if (!raw) return null;
  return raw.length > PLAN_MAX_CHARS ? `${raw.slice(0, PLAN_MAX_CHARS)}…` : raw;
}

function safeJson(v: unknown): string | null {
  try {
    return JSON.stringify(v) ?? null;
  } catch {
    return null;
  }
}

/** Fold an uninstall envelope into the next UI step. */
export function uninstallStep(
  vars: { name: string; dryRun: boolean },
  res: UninstallEnvelope | null | undefined,
): UninstallStep {
  if (!res || res.ok !== true) {
    // an engine refusal resolves the promise (ok:false is NOT a rejection) —
    // surface it inline; never open the confirm, never refetch.
    return {
      pending: null,
      error: {
        name: vars.name,
        error: res?.error ?? (vars.dryRun ? "uninstall preview failed" : "uninstall failed"),
      },
      refetch: false,
    };
  }
  if (vars.dryRun) {
    // clean preview → arm the typed-confirm with the engine's plan.
    return {
      pending: { name: vars.name, plan: planText(res) },
      error: null,
      refetch: false,
    };
  }
  // real commit succeeded → clear + refetch (the ONLY row-removal path).
  return { pending: null, error: null, refetch: true };
}

/** An IPC-level rejection (bridge absent / handler threw) — inline error, no refetch. */
export function uninstallFailure(name: string, e: unknown): UninstallStep {
  return {
    pending: null,
    error: { name, error: e instanceof Error ? e.message : String(e) },
    refetch: false,
  };
}
