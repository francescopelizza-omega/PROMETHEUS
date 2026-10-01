// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { cliProfiles } from "@prometheus/core";
/**
 * commands/sidecar-cmd.ts — shared scaffolding for the §2 sidecar-backed verbs
 * (env / model / repo / metadata) that drive the Python helpers (C7) the GUI's
 * env-/model-/repo-/metadata-IPC use. ONE consistent UX so every mutating verb
 * behaves identically and is crash-/never-force-safe:
 *
 *   READ verbs   → always run the sidecar, render.
 *   MUTATE verbs → PREVIEW by default (print the plan, touch NOTHING), and only
 *                  EXECUTE when the human passes `--yes` (or `--force`). This
 *                  mirrors the GUI's plan→confirm→execute flow (file 06/0C) in a
 *                  one-shot CLI: the engine/sidecar still runs the REAL nemesis
 *                  gate on execute (C5) — prometheus never pre-judges "safe".
 *
 * NEVER-FORCE / GATE-FIRST (§4): `--force` overrides a nemesis BLOCK, so under the
 * non-interactive `ci` profile it is hard-blocked (no human to type the confirm)
 * unless PROM_ALLOW_FORCE=1 — identical to generic.ts. Everything is dependency-
 * injectable (`SidecarDeps`) so the whole surface is unit-testable without spawning
 * python: tests pass a fake runSidecar; the default is the real bridge runner (C5).
 */
import {
  type LaunchGuardSample,
  type ServeHostApi,
  createServeHost,
  probeSystemCommand,
  sampleLaunchGuard,
} from "@prometheus/engine-bridge";
import type { CliContext, CommandOutcome } from "../context.js";
import { c } from "../render.js";
import { type SidecarEnvelope, runSidecar } from "../sidecar.js";

/** The sidecar runner, injectable so commands are testable without a real spawn. */
export interface SidecarDeps {
  runSidecar: typeof runSidecar;
  /** 90% CPU/RAM launch-guard sampler (CLI-021); injected in tests, default = real probe. */
  launchGuard?: () => Promise<LaunchGuardSample>;
  /** CLI-owned model-runner supervisor (CLI-022); injected in tests, default = real serve-host. */
  serveHost?: ServeHostApi;
  /** is a host binary present? (CLI-027 ollama auto-install); default = `<bin> --version` probe. */
  probeRunner?: (bin: string) => Promise<boolean>;
  /** interactive install consent (CLI-027); default = a TTY y/N prompt, non-TTY/EOF = decline. */
  confirmRunnerInstall?: () => Promise<boolean>;
}

/** Default binary-present probe: `<bin> --version` returns output ⇒ installed (C5 probe seam). */
async function defaultProbeRunner(bin: string): Promise<boolean> {
  return (await probeSystemCommand(bin, ["--version"])) !== null;
}

/**
 * A one-shot y/N confirm on the controlling TTY (default N). Non-TTY or EOF ⇒ decline
 * (fail-closed) — never hangs waiting for input that will not come. Prompt goes to stderr
 * so it never pollutes a piped stdout.
 */
export function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  process.stderr.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const finish = (val: boolean): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      try {
        stdin.pause();
      } catch {
        /* already paused */
      }
      resolve(val);
    };
    const onData = (d: Buffer): void => finish(/^y(es)?$/i.test(d.toString().trim()));
    const onEnd = (): void => finish(false); // EOF ⇒ decline
    try {
      stdin.resume();
    } catch {
      resolve(false);
      return;
    }
    stdin.once("data", onData);
    stdin.once("end", onEnd);
  });
}

/** The real bridge runner (C5 — the SOLE child_process owner lives in engine-bridge). */
export const defaultSidecarDeps: SidecarDeps = {
  runSidecar,
  launchGuard: sampleLaunchGuard,
  serveHost: createServeHost(),
  probeRunner: defaultProbeRunner,
  confirmRunnerInstall: () => promptYesNo("install ollama now?"),
};

/** A captured flag's string value (a boolean/`true` flag → undefined). */
export function flagStr(ctx: CliContext, key: string): string | undefined {
  const v = ctx.args.flags[key];
  return typeof v === "string" ? v : undefined;
}

/** Is a flag present (string value OR bare boolean)? */
export function flagSet(ctx: CliContext, key: string): boolean {
  return ctx.args.flags[key] !== undefined;
}

/**
 * Is this invocation a PREVIEW because the user asked for one?
 *
 * Exported so the gates that do NOT funnel through `wantsExecute` consult the same predicate.
 * Two of them OR a typed confirm past it — `model rm <id> --confirm <id>` and
 * `sessions delete <id> --confirm <id>` — and a one-line fix inside `wantsExecute` would have
 * left both executing under `--dry-run`. Measured: `sessions delete <id> --confirm <id>
 * --dry-run` really removed the session. Each caller keeps its OWN confirm rules; all that is
 * shared is the question "did they ask for a preview".
 */
export function isPreviewRun(ctx: CliContext): boolean {
  return ctx.args.dryRun === true;
}

/**
 * `--yes` / `--force` mean "I've seen the plan — execute it" (else preview).
 *
 * `--dry-run` OUTRANKS both. It is a declared global boolean, documented in `--help` and
 * forwarded to the engine for every registry-routed verb, so a user who types it is asking
 * to see the plan — and used to get the mutation instead: `--dry-run --yes env delete <name>`
 * really removed the environment and reported `executed: true`. Preview is expressed by NOT
 * passing the sidecar's `--confirm` plan→run toggle, i.e. through this one predicate, so
 * every confirm-gated verb (env, model, secure, the generic sidecar router) is covered by
 * the same decision rather than by a second preview path that can drift from it.
 */
export function wantsExecute(ctx: CliContext): boolean {
  if (isPreviewRun(ctx)) return false;
  return ctx.args.yes === true || ctx.args.force === true;
}

/**
 * Hard-block a forced mutation under the non-interactive `ci` profile (§4): there
 * is no human at the keyboard to type the confirmation, so `--force` (a nemesis
 * BLOCK override) is refused unless PROM_ALLOW_FORCE=1. Returns a blocked outcome
 * (caller returns it verbatim) or undefined when cleared to proceed.
 */
export function forceBlocked(ctx: CliContext, command: string): CommandOutcome | undefined {
  // Must be EXACTLY "1" (the documented value) — a bare presence check would let PROM_ALLOW_FORCE=0
  // or =false (intended to DISABLE the override) fail OPEN and allow the forced nemesis-block bypass.
  // Through the shared predicate now: this site was hardened and its two twins were not.
  if (ctx.args.force && ctx.args.profile === "ci" && !cliProfiles.forceOverrideAllowed()) {
    const reason =
      `--force is blocked under the 'ci' profile. Set PROM_ALLOW_FORCE=1 to override ` +
      "(there is no human to type the confirmation).";
    return {
      text: `prometheus ${command}: ${reason}`,
      json: { ok: false, error: "force-blocked", command },
      exitCode: 2,
    };
  }
  return undefined;
}

/**
 * Append a sidecar's execute markers. `useConfirm` controls the `--confirm` plan→run
 * toggle (envmgr/metadata HAVE it; modelhub/repo do NOT — for them calling IS running,
 * so they pass `useConfirm:false`). `--force` (nemesis BLOCK override) rides when set.
 */
export function execArgv(ctx: CliContext, base: string[], useConfirm = true): string[] {
  const out = [...base];
  if (useConfirm) out.push("--confirm");
  if (ctx.args.force) out.push("--force");
  return out;
}

/**
 * A usage error for a missing required positional — exit 1, never a silent 0.
 *
 * ONE, not two. `context.ts`'s CLI-084 table is the single reference: `1` is "generic command
 * failure (bad args, not-found, …)" and `2` is a fail-closed SECURITY/ENGINE block, "load-bearing
 * for CI (`$? -eq 2` detects a security block)". This helper hard-coded 2, so a plain typo was
 * indistinguishable from a nemesis BLOCK — while the SAME mistake caught one layer earlier by
 * core's command-registry validation (`commands.ts`: `invalid arguments for "<id>"`) came back as
 * 1 through `outcomeFromError`. Measured: `prometheus --json info` exited 2 and
 * `prometheus --json where` exited 1, for the identical class of user error.
 *
 * The table's own words settle which one moved: "a command hand-rolling its own error→code
 * mapping is a divergence to fix".
 */
export function usageError(command: string, usage: string): CommandOutcome {
  return {
    text: `prometheus ${command}: missing argument.\n  ${c.dim("usage:")} prometheus ${command} ${usage}`,
    json: { ok: false, error: "missing-argument", command, usage },
    exitCode: 1,
  };
}

/**
 * The PREVIEW outcome for a mutating verb (default when no --yes/--force): shows the
 * exact sidecar plan, changes nothing, exits 0. The `note` is a one-line human
 * description of what executing WOULD do.
 */
export function previewOutcome(
  command: string,
  script: string,
  argv: string[],
  note: string,
): CommandOutcome {
  const plan = `${script} ${argv.join(" ")}`;
  return {
    text:
      `${c.bold(`prometheus ${command}`)}  ${c.dim("(preview — nothing changed)")}\n` +
      `  ${c.cyan("would")}  ${note}\n` +
      `  ${c.dim("plan")}   ${c.dim(plan)}\n` +
      `  ${c.dim("re-run with")} ${c.bold("--yes")} ${c.dim("to execute")} ${c.dim("(or --force to override a BLOCK).")}`,
    json: { ok: true, status: "preview", command, script, argv },
    exitCode: 0,
  };
}

/**
 * A script-agnostic PREVIEW outcome for a non-sidecar mutating action (e.g. the
 * security remediation verbs that call engine-bridge functions, not runSidecar).
 * Shows what executing WOULD do; changes nothing; exits 0.
 */
export function previewAction(command: string, note: string): CommandOutcome {
  return {
    text:
      `${c.bold(`prometheus ${command}`)}  ${c.dim("(preview — nothing changed)")}\n` +
      `  ${c.cyan("would")}  ${note}\n` +
      `  ${c.dim("re-run with")} ${c.bold("--yes")} ${c.dim("to execute")} ${c.dim("(or --force to override a BLOCK).")}`,
    json: { ok: true, status: "preview", command },
    exitCode: 0,
  };
}

/**
 * Generic success/failure renderer for a mutation's executed sidecar envelope.
 * `--json` emits the raw envelope; text mode renders a one-line ok / red error.
 * A gated BLOCK rides through as `ok:false` (a value, not a throw) → exit 2 (C5).
 */
export function renderMutation(
  ctx: CliContext,
  command: string,
  env: SidecarEnvelope,
): CommandOutcome {
  if (ctx.json) return { json: env, exitCode: env.ok === false ? 2 : 0 };
  if (env.ok === false) {
    const blocked = typeof env.blocked === "boolean" ? env.blocked : false;
    const reason =
      typeof env.error === "string"
        ? env.error
        : typeof env.message === "string"
          ? env.message
          : "engine returned ok:false";
    const tag = blocked ? c.red("BLOCKED") : c.red("failed");
    const quarantined =
      typeof env.quarantined === "string" ? `\n  ${c.dim("quarantined:")} ${env.quarantined}` : "";
    return { text: `prometheus ${command}: ${tag} — ${reason}${quarantined}`, exitCode: 2 };
  }
  return { text: `${c.green("✓")} ${command}`, exitCode: 0 };
}

/**
 * Run a mutating sidecar verb through the canonical gate→preview→execute flow.
 * Returns the PREVIEW (default), a force-block, or the rendered executed result.
 * `renderOk` lets a caller render a rich success (else the generic one-liner).
 */
export async function runMutation(
  ctx: CliContext,
  opts: {
    command: string;
    script: Parameters<typeof runSidecar>[0];
    base: string[];
    note: string;
    deps: SidecarDeps;
    /** does this sidecar use the `--confirm` plan→run toggle? envmgr/metadata yes; modelhub/repo no. */
    confirm?: boolean;
    renderOk?: (env: SidecarEnvelope) => CommandOutcome;
  },
): Promise<CommandOutcome> {
  const { command, script, base, note, deps, renderOk } = opts;
  const useConfirm = opts.confirm ?? true;
  const blocked = forceBlocked(ctx, command);
  if (blocked) return blocked;
  if (!wantsExecute(ctx)) {
    return previewOutcome(command, script, useConfirm ? [...base, "--confirm"] : [...base], note);
  }
  const env = await deps.runSidecar(script, execArgv(ctx, base, useConfirm));
  if (env.ok !== false && renderOk && !ctx.json) return renderOk(env);
  return renderMutation(ctx, command, env);
}

/**
 * Run a READ-only sidecar verb and hand the envelope to a custom renderer (text
 * mode) or emit it raw (`--json`). A failed read renders a red one-liner + exit 2.
 */
export async function runRead(
  ctx: CliContext,
  opts: {
    command: string;
    script: Parameters<typeof runSidecar>[0];
    argv: string[];
    deps: SidecarDeps;
    render: (env: SidecarEnvelope) => CommandOutcome;
  },
): Promise<CommandOutcome> {
  const { command, script, argv, deps, render } = opts;
  const env = await deps.runSidecar(script, argv);
  if (env.ok === false) {
    return ctx.json
      ? { json: env, exitCode: 2 }
      : { text: c.red(`${command} failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }
  // `render()` runs for BOTH surfaces (not just text): some renderers (model card/browse)
  // apply their own filtering/derived fields (--limit, --free, a computed url, ...) and set
  // their own `json` to match — returning the raw envelope under `--json` unconditionally
  // used to make those options a text-only illusion. Renderers that don't set `json` fall
  // back to the raw envelope, exactly as before.
  const outcome = render(env);
  return ctx.json ? { json: outcome.json ?? env, exitCode: outcome.exitCode ?? 0 } : outcome;
}
