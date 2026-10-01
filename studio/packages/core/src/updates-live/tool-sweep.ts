// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/tool-sweep.ts — resolve every tool in `TOOL_CHECKS` and ask the right channel.
 *
 * The piece that was missing. `tool-registry.ts` has carried `updateCommandsFor(tool, platform,
 * installedVia)` since it was written — the only function in the repo that ties an update command
 * to how a tool was actually installed — and NOTHING ever computed `installedVia`. Every caller
 * passed `undefined`, which returns every candidate command for the platform, so PROMETHEUS
 * offered `brew upgrade …` beside `npm install -g …` with no idea which one was the user's.
 *
 * This computes it, from the realpath of every copy on PATH, and then:
 *
 *   • asks the channel that MATCHES the install (a brew install is judged against brew, because
 *     brew is what will actually deliver its next version — measured: brew's `gemini-cli` is
 *     0.46.0 while npm's is 0.61.0, and the npm command cannot help a brew install);
 *   • offers only the commands that target the copy on PATH;
 *   • keeps every withheld command WITH its reason, because the user will otherwise find it in
 *     `brew outdated` and run it unwarned.
 */
import * as u from "../updates/index.js";

import { type ChannelAnswer, type FetchDeps, askLatest } from "./channel-fetch.js";
import { type ResolveDeps, resolveToolCheck } from "./resolve.js";

/** How many tools may be in flight at once. Courtesy, not throughput — see the note below. */
export const TOOL_CONCURRENCY = 4;

export interface ToolSweepDeps extends FetchDeps, ResolveDeps {
  /** test seam: replace the whole per-tool resolution. */
  resolve?: (tool: u.ToolCheck) => u.ToolResolution;
  /** test seam: replace the whole per-tool channel query. */
  ask?: (
    tool: u.ToolCheck,
    owner: u.InstallOwner | undefined,
    installed: string | null,
  ) => Promise<ChannelAnswer>;
  /** skip tools that are not installed (default true) — an absent optional tool is not news. */
  includeAbsent?: boolean;
}

/** Turn a channel answer into the report's tri-state. */
function verdict(
  ans: ChannelAnswer,
  current: string | null,
): { latest: string | null; updateAvailable: boolean | null; source: string } {
  switch (ans.kind) {
    case "version": {
      /**
       * `isNewer` is strict and returns false for an unparseable pair — which would read as "up
       * to date". So the comparison is made explicitly, and a pair that cannot be compared
       * becomes `null`, not `false`.
       */
      const cmp = current === null ? null : u.compareVersions(ans.version, current);
      return {
        latest: ans.version,
        updateAvailable: cmp === null ? null : cmp > 0,
        source: ans.channel,
      };
    }
    case "newer":
      // A vendor endpoint that answers the question directly; there is no version to show.
      return { latest: null, updateAvailable: true, source: ans.channel };
    case "current":
      return { latest: current, updateAvailable: false, source: ans.channel };
    default:
      return { latest: null, updateAvailable: null, source: `${ans.channel}: ${ans.why}` };
  }
}

/** Run `jobs` with at most `limit` in flight, preserving input order. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  run: (i: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await run(items[i] as T);
      }
    }),
  );
  return out;
}

/** Resolve and check every tool PROMETHEUS knows about. Never throws. */
export async function sweepTools(
  tools: readonly u.ToolCheck[],
  deps: ToolSweepDeps = {},
): Promise<u.ToolUpdateStatus[]> {
  const platform = deps.platform ?? process.platform;
  const resolve = deps.resolve ?? ((t: u.ToolCheck) => resolveToolCheck(t, deps));

  /**
   * Resolution is synchronous filesystem work and is done for EVERY tool up front, before any
   * network call. That ordering matters: the resolved owner is what selects the channel, so a
   * network request made before it would be asking the wrong source.
   */
  const resolved = tools.map((t) => ({ tool: t, res: resolve(t) }));

  return pooled(resolved, TOOL_CONCURRENCY, async ({ tool, res }): Promise<u.ToolUpdateStatus> => {
    const installed = res.state !== "absent";
    const winner = res.winner;
    const current = winner?.version ?? null;

    const base = {
      id: tool.id,
      label: tool.label,
      role: tool.role,
      installed,
      state: res.state,
      copies: res.copies,
      current,
      /**
       * Carried through, because `check.ts` rebuilds a `ToolResolution` from this row to run the
       * conflict cross-check — and a field missing here is a conflict kind that can never fire.
       * `resolveTool` has already paid for the version comparison; dropping the answer meant
       * `shadowed-newer` was dead code in every surface.
       */
      ...(res.newerShadow ? { newerShadow: res.newerShadow } : {}),
      ...(tool.note ? { note: tool.note } : {}),
    };

    if (!installed) {
      return { ...base, latest: null, updateAvailable: null, offer: [], withheld: [] };
    }

    const ans = deps.ask
      ? await deps.ask(tool, winner?.owner, current)
      : await askLatest(tool, winner?.owner, current, deps);
    const v = verdict(ans, current);

    const candidates = u.updateCommandsFor(tool, platform);
    const { offer, withheld } = u.partitionCommands(res, candidates);
    /**
     * When the table has nothing that fits, synthesise from the install itself.
     *
     * A virtualenv's upgrade command contains the venv's own path and cannot be tabulated;
     * measured, `hf` lives in ~/.hf-cli/venv, which pipx has never heard of, so the table's
     * `pipx upgrade huggingface-hub` would error. Without this the row would carry NO command at
     * all, which is a silent gap rather than a wrong answer — but still a gap.
     */
    const effective =
      offer.length > 0
        ? offer
        : winner
          ? [
              u.fallbackCommandFor(
                winner,
                u.packageIdFor(
                  tool,
                  winner.owner === "python-venv" || winner.owner === "pipx" ? "pypi" : "npm",
                ),
              ),
            ].filter((c): c is u.UpdateCommand => c !== null)
          : [];

    return {
      ...base,
      latest: v.latest,
      updateAvailable: v.updateAvailable,
      source: v.source,
      offer: effective,
      withheld: withheld.map((w) => ({ command: w.command.command, reason: w.reason })),
    };
  });
}

/**
 * Bridge the new sweep back to the legacy `clis` section.
 *
 * `sources.ts` is re-exported from the published core barrel and `updates.test.ts` asserts its
 * rows, so it is not deleted here — but it must not be a SECOND source of truth either, or the
 * two sections of one report can disagree about the same tool. The legacy rows are derived from
 * the new ones, so there is one answer.
 */
export function legacyCliRows(tools: readonly u.ToolUpdateStatus[]): u.CliUpdateStatus[] {
  const out: u.CliUpdateStatus[] = [];
  for (const service of u.UPDATE_SERVICES) {
    const t = tools.find((x) => x.id === service);
    const src = u.updateSourceFor(service);
    if (!t || !src) continue;
    out.push({
      service,
      installed: t.installed,
      current: t.current,
      latest: t.latest,
      // The legacy field is a boolean and cannot carry "unknown"; `null` becomes `false` here
      // ONLY because the new `tools` section states it properly alongside.
      updateAvailable: t.updateAvailable === true,
      command: t.offer[0]?.command || src.selfUpdate,
      ...(t.note ? { note: t.note } : {}),
    });
  }
  return out;
}
