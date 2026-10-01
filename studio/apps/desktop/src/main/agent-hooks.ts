// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/agent-hooks.ts — the desktop's half of the lifecycle HOOKS (`core/agent/hooks.ts`).
 *
 * OWNED BY MAIN, on purpose, exactly like `budget-gate.ts`: the renderer is C5-sandboxed and
 * cannot spawn a process at all, and even if it could, "which shell commands may run" is not a
 * decision to delegate to the surface that renders untrusted model output.
 *
 * So the split is:
 *   main      holds the effective `hooks` list (republished on every settings change), and is
 *             the ONLY thing that spawns. It refuses any command that is not verbatim one of
 *             the user's configured commands for that event — the renderer cannot invent one.
 *   renderer  asks for the list, then proxies each run over `agent:hookRun`, so core's loop
 *             sees the same `hooks` + `hookRunner` pair both CLI hosts give it.
 *
 * `effective.hooks` (the pre-merged settings value `registerSettingsIpcHandlers` resolves) must
 * NEVER be used here: `layerSettings` treats arrays as scalars that wholesale-replace, so a
 * workspace `.prometheus/settings.json` could otherwise swap in arbitrary shell commands with no
 * scan and no confirmation — the exact gap `hooks-trust.ts`'s `resolveEffectiveHooks` closes on
 * the CLI. `setHookSettings` takes the two RAW layers instead and vets them the same way.
 *
 * Fail-soft: no settings published, or none configured ⇒ an empty list, and the renderer never
 * builds a runner at all.
 */
import { agent as coreAgent, type settings as coreSettings } from "@prometheus/core";
import {
  createHookRunner,
  prometheusHome,
  resolveEffectiveHooks,
} from "@prometheus/core/agent-system-host";

type HookSpec = coreAgent.HookSpec;
type HookEvent = coreAgent.HookEvent;
type HookOutcome = coreAgent.HookOutcome;

/** The effective, VETTED hooks — only ever assigned the resolved output of `resolveEffectiveHooks`. */
let configured: HookSpec[] = [];
/** Guards against a stale, slow resolution overwriting a newer one (two rapid settings changes). */
let resolveSeq = 0;
/**
 * Prompts declined THIS RUN, keyed by `${cwd}\x00${prompt}` — never persisted to disk.
 *
 * `onEffective` (unlike the CLI's once-per-session hook load) fires on every settings read AND
 * write, so an unrelated settings change (toggling a theme) while sitting in a project with an
 * un-trusted novel hook would otherwise re-show the SAME dialog every single time. An accepted
 * prompt already skips re-asking via the on-disk trust grant (`resolveEffectiveHooks` itself);
 * this is the missing half for a decline, which is deliberately NOT persisted to disk (declining
 * must stay revisitable next launch, never become a permanent, invisible block).
 */
const declinedThisRun = new Map<string, boolean>();
/**
 * Confirms IN FLIGHT right now, keyed the same way as `declinedThisRun`.
 *
 * `onEffective` firing twice in quick succession for the SAME still-undecided novel set (two
 * windows on one workspace, or an unrelated settings write landing while a dialog is still up)
 * would otherwise spawn a SECOND native dialog before the first resolves — and because only
 * `resolveSeq` orders the final `configured` write (not the confirm calls themselves), whichever
 * dialog the human answers LAST wins, so declining the one they're looking at could be silently
 * overridden by an answer to a stale duplicate. Concurrent callers for the same key share this
 * ONE in-flight promise instead, so exactly one dialog shows and exactly one decision is made.
 */
const inFlightConfirms = new Map<string, Promise<boolean>>();

export interface SetHookSettingsOptions {
  /** the open workspace's root, if any — keys the per-workspace trust grant and audit trail. */
  cwd?: string;
  /** asks the human once per workspace before a NOVEL hook joins the effective set. */
  confirm: (prompt: string) => Promise<boolean>;
  /** defaults to the shared `prometheusHome()` so a grant made here is honored by the CLI too. */
  home?: string;
  /** called once per hook the scan or the trust gate dropped, for a UI notice. */
  onRefusal?: (refusal: { event: HookEvent; command: string; reason: string }) => void;
  /** test seam: overrides the real nemesis scan (`resolveEffectiveHooks`'s own `gate` option). */
  gate?: Parameters<typeof resolveEffectiveHooks>[0]["gate"];
}

/**
 * Vet and publish the effective hooks for a workspace. Called from the SAME `onEffective` that
 * publishes the security posture and the budget windows, so editing a hook takes effect on the
 * next turn rather than on the next app launch.
 *
 * ASYNC (a nemesis scan and, for a brand-new novel hook, a human confirmation both take real
 * time) — the returned promise is meant to be fire-and-forget from `onEffective`'s existing
 * synchronous contract (a caller that wants to await it, like a test, still can). This is safe
 * specifically because `configured` is only ever assigned the RESOLVED, vetted result — never
 * the raw workspace array — so nothing can run before it has been scanned/confirmed; the window
 * between "settings changed" and "vetting finished" simply means the PREVIOUS vetted set (or
 * none, on first load) stays in force a little longer.
 */
export function setHookSettings(
  global: coreSettings.Settings | undefined,
  workspace: Record<string, unknown> | undefined,
  opts: SetHookSettingsOptions,
): Promise<void> {
  const mySeq = ++resolveSeq;
  const cwd = opts.cwd ?? "";
  const globalHooks = coreAgent.validateHooks(global?.hooks);
  const workspaceHooks =
    workspace !== undefined && Object.hasOwn(workspace, "hooks")
      ? coreAgent.validateHooks(workspace.hooks)
      : undefined;
  const confirm = async (prompt: string): Promise<boolean> => {
    const key = `${cwd}\u0000${prompt}`;
    if (declinedThisRun.has(key)) return false;
    const existing = inFlightConfirms.get(key);
    if (existing) return existing;
    const pending = (async () => {
      try {
        const granted = await opts.confirm(prompt);
        if (!granted) declinedThisRun.set(key, false);
        return granted;
      } finally {
        inFlightConfirms.delete(key);
      }
    })();
    inFlightConfirms.set(key, pending);
    return pending;
  };
  return resolveEffectiveHooks({
    home: opts.home ?? prometheusHome(),
    cwd,
    globalHooks,
    workspaceHooks,
    confirm,
    ...(opts.gate ? { gate: opts.gate } : {}),
  })
    .then((resolved) => {
      if (mySeq !== resolveSeq) return; // superseded by a newer settings change
      configured = resolved.hooks;
      for (const r of resolved.refused) opts.onRefusal?.(r);
    })
    .catch(() => {
      /* fail-soft: keep whatever was configured before rather than widen on a scan/confirm error */
    });
}

/** The configured hooks (the renderer reads this to build its `tuning.hooks`). */
export function listHooks(): HookSpec[] {
  return configured.map((h) => ({ ...h }));
}

/** Test seam: reset the module singleton between suites. */
export function resetHookSettings(): void {
  configured = [];
  resolveSeq += 1;
  declinedThisRun.clear();
  inFlightConfirms.clear();
}

/**
 * Run ONE configured hook command.
 *
 * FAIL-CLOSED ON IDENTITY: `command` must match, byte for byte, a command the user configured
 * for that same `event`. Without this check the channel would be a general-purpose "run this
 * shell string" IPC reachable from the renderer, which is the single worst thing a hooks
 * feature could accidentally ship.
 *
 * Never throws: every failure comes back as a `HookOutcome` carrying `error`, which core's
 * `runPreToolUseHooks` reads as "no hook fired" rather than as a deny.
 */
export async function runConfiguredHook(
  req: { event: HookEvent; command: string; stdin?: string; timeoutMs?: number },
  opts: { cwd?: string; runner?: coreAgent.HookRunner } = {},
): Promise<HookOutcome> {
  const known = configured.some((h) => h.event === req.event && h.command === req.command);
  if (!known) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "",
      error: `agent:hookRun refused: no ${req.event} hook is configured with that command`,
    };
  }
  const runner = opts.runner ?? createHookRunner({ ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  try {
    return await runner({
      event: req.event,
      command: req.command,
      stdin: typeof req.stdin === "string" ? req.stdin : "",
      timeoutMs:
        typeof req.timeoutMs === "number" && Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
          ? req.timeoutMs
          : coreAgent.DEFAULT_HOOK_TIMEOUT_MS,
    });
  } catch (e) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
