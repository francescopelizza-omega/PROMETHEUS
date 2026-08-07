/**
 * shell/venv-label.ts — PURE "active venv" status-bar fact (APP-009).
 *
 * Projects the already-fetched envList envelope (qk.envs — the same read the
 * Environments route and Home share; no new IPC) into the StatusBar's venv label,
 * e.g. "py3.12 (prometheus)". JSX-free (the -view.ts convention) for node:test.
 */

import type { EnvelopeResult } from "../../shared/ipc-contract.js";

/** The active env's label, or undefined (fact hidden gracefully). Partial rows
 *  never throw — the known "reading 'filter'" IPC crash pattern is guarded. */
export function venvStatusLabel(res: EnvelopeResult | null | undefined): string | undefined {
  if (!res || res.ok !== true || !res.data) return undefined;
  const envs = (res.data as Record<string, unknown>).envs;
  if (!Array.isArray(envs)) return undefined;
  const active = envs.find(
    (e): e is Record<string, unknown> =>
      !!e && typeof e === "object" && (e as Record<string, unknown>).active === true,
  );
  if (!active) return undefined;
  const name =
    typeof active.name === "string" && active.name
      ? active.name
      : typeof active.id === "string" && active.id
        ? active.id
        : undefined;
  const version =
    typeof active.pythonVersion === "string" && active.pythonVersion
      ? `py${active.pythonVersion}`
      : undefined;
  if (version && name) return `${version} (${name})`;
  return version ?? name;
}
