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
 * Fail-soft: no settings published, or none configured ⇒ an empty list, and the renderer never
 * builds a runner at all.
 */
import { agent as coreAgent, type settings as coreSettings } from "@prometheus/core";
import { createHookRunner } from "@prometheus/core/agent-system-host";

type HookSpec = coreAgent.HookSpec;
type HookEvent = coreAgent.HookEvent;
type HookOutcome = coreAgent.HookOutcome;

/** The effective hooks, republished by `registerSettingsIpcHandlers`' `onEffective`. */
let configured: HookSpec[] = [];

/**
 * Publish the effective settings' hooks. Called from the SAME `onEffective` that publishes the
 * security posture and the budget windows, so editing a hook takes effect on the next turn
 * rather than on the next app launch.
 */
export function setHookSettings(effective: coreSettings.Settings | undefined): void {
  configured = coreAgent.validateHooks(effective?.hooks);
}

/** The configured hooks (the renderer reads this to build its `tuning.hooks`). */
export function listHooks(): HookSpec[] {
  return configured.map((h) => ({ ...h }));
}

/** Test seam: reset the module singleton between suites. */
export function resetHookSettings(): void {
  configured = [];
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
