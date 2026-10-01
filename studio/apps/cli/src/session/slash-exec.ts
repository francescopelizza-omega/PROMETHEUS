// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/slash-exec.ts — execute a REPL slash command inside the live session (P4).
 *
 * The unified single-window session host (`session/host.ts`) reads a line from
 * node:readline, asks `repl.parseSlash` to classify it, and — when it's a slash —
 * hands the `(name, rest)` here. This module is the slash ROUTER: it maps each
 * known slash to one of four behaviours and returns a `SlashResult` the host acts
 * on (mutate tuning + redraw footer, switch the active pane + redraw it, run a
 * verb through the parity registry, or signal a host-level control like quit/clear).
 *
 * Everything routes through the REAL core `repl` brain (the SAME slash registry the
 * GUI/Ink view binds): `repl.SLASH_COMMANDS`, `repl.TUNING_SLASHES`,
 * `repl.tuneFromSlash`, `repl.PANE_CYCLE`, `repl.footerLine`. Nothing here decides
 * "safe" (C5) — verb slashes delegate to `execVerb`, which routes the engine's
 * nemesis verdict verbatim; tuning slashes only adjust the live AgentTuning, never
 * bypass the gate. Crash-safe: a throw anywhere becomes a friendly `error` result,
 * never a raw stack — the host keeps the loop alive.
 *
 * NOTE on the brief: the brief's slash names `/security /health /logs /chat
 * /agentic /terminal /tmux /metadata /mcp /agent` are NOT in the real
 * `repl.SLASH_COMMANDS` registry (verified against repl/slash.ts). To stay
 * STRUCTURAL (no drift from the core brain) we route the REAL registry slashes:
 * tuning (model/system/tools/gate/dry-run/verbosity/profile/yes), pane
 * (scan/superscan/matrix/doctor/env/model/repo/app/worldsim/vault/skills), action
 * (help/secure/install/uninstall/clear/save/resume/cwd/quit). Any unknown name —
 * including those extra brief aliases — falls to the friendly "unknown command"
 * branch, so adding them later is a one-line registry change with zero churn here.
 */
// The `repl` brain is consumed as a namespace (the SAME barrel the Ink view binds):
// `repl.SLASH_COMMANDS` / `repl.tuneFromSlash` / `repl.footerLine` (values) and
// `repl.PaneId` / `repl.ReplState` (types). PaneId/ReplState are NOT flat exports of
// @prometheus/core — they live under this namespace — so we qualify them as repl.*.
import { repl } from "@prometheus/core";

import type { CommandOutcome } from "../context.js";
import { c } from "../render.js";

/** The active-pane id type, sourced from the core repl brain (not a flat export). */
type PaneId = repl.PaneId;

/* ------------------------------------------------------------------------- *
 * Shared session context (defined HERE — first session/ file — and re-used by
 * the sibling units host.ts / command-exec.ts / pane-render.ts). Kept minimal:
 * the engine client lives on `tuning`'s home (the host) and is reached only via
 * the injected `execVerb`; `renderPane` is injected so this router never imports
 * the pane-render projector directly (decoupled + independently testable).
 * ------------------------------------------------------------------------- */

/**
 * The mutable session brain the host owns. Slash-exec reads `state` (for the
 * footer + active pane) and asks the host to apply tuning patches / pane switches
 * via the returned SlashResult — it never mutates `state` in place itself, so the
 * host stays the single point of truth (pairs with the pure `repl.reduce`).
 */
export interface SessionCtx {
  /** the live REPL state (transcript + tuning + activePane + cwd + history). */
  readonly state: repl.ReplState;
  /** global --json flag: when true the host emits machine envelopes, not pretty text. */
  readonly json: boolean;
  /** write a line of human output (host wires this to stdout; tests capture it). */
  readonly write: (text: string) => void;
  /** ask the human a yes/no (typed-confirm lives downstream in execVerb; here it's UX). */
  readonly confirm?: (message: string) => boolean | Promise<boolean>;
  /**
   * Run a verb through the parity registry (sibling command-exec.ts owns the real
   * impl). Optional so a host wiring up incrementally still structurally satisfies
   * SessionCtx — when absent, a verb slash returns a friendly "not wired" outcome
   * rather than crashing the loop.
   */
  readonly execVerb?: (tokens: string[], ctx: SessionCtx) => Promise<CommandOutcome>;
  /**
   * Render a pane (sibling pane-render.ts owns the real impl; injected to decouple).
   * Optional for the same incremental-wiring reason — absent → a placeholder line.
   */
  readonly renderPane?: (paneId: PaneId, ctx: SessionCtx) => string;
}

/* ------------------------------------------------------------------------- *
 * The result the host acts on. A discriminated union so the host can pattern-
 * match: apply a tuning patch, switch the pane, print text, or run a control.
 * ------------------------------------------------------------------------- */

/**
 * A host-level control a slash can request. `profile` hot-swaps the whole tuning
 * profile (the host re-resolves AgentTuning from the named seed), so it is a host
 * concern rather than a single-field tuning patch.
 */
export type SlashControl = "clear" | "quit" | "save" | "resume" | "cwd" | "profile";

export type SlashResult =
  | {
      /** a §3.1 tuning slash: host applies the patch then redraws the footer. */
      kind: "tune";
      patch: Partial<repl.ReplState["tuning"]>;
      /** the refreshed footer text (already rendered against the NEW tuning). */
      footer: string;
      /** optional human echo line. */
      text?: string;
    }
  | {
      /** a pane slash: host sets activePane then redraws (text already rendered). */
      kind: "pane";
      pane: PaneId;
      text: string;
    }
  | {
      /** a verb slash: already executed via execVerb; carry the outcome through. */
      kind: "verb";
      outcome: CommandOutcome;
    }
  | {
      /** a host-level control (clear/quit/save/resume/cwd); host owns the action. */
      kind: "control";
      control: SlashControl;
      /** the remainder after the slash name (e.g. the dir for /cwd, file for /save). */
      rest: string;
      text?: string;
    }
  | {
      /** unknown slash or a friendly error — host prints `text` and continues. */
      kind: "error";
      text: string;
    };

/* ------------------------------------------------------------------------- *
 * Slash → pane mapping. The pane slashes whose name IS already a PaneId pass
 * through 1:1 (scan/matrix/env/model/repo/app/worldsim/vault/skills); the two
 * that differ (superscan→scan view, doctor→a health/system view rendered by the
 * pane projector under "scan") are mapped explicitly. `secure` is NOT a pane —
 * it's a verb (the nemesis gate), so it lives in the action set below.
 * ------------------------------------------------------------------------- */

const PANE_SLASH: Readonly<Record<string, PaneId>> = Object.freeze({
  scan: "scan",
  superscan: "scan",
  matrix: "matrix",
  doctor: "scan", // health/doctor view; pane-render dispatches the doctor projector
  env: "env",
  model: "model", // /model with no arg is a pane; /model <id> is tuning (handled first)
  repo: "repo",
  app: "app",
  worldsim: "worldsim",
  vault: "vault",
  skills: "skills",
});

/**
 * Action slashes that map to a parity-registry VERB id (run via execVerb). The
 * slash NAME and the CommandSpec ID differ for the nemesis gate: the slash is
 * `/secure` but the registry verb is `gate` (verified against commands.ts —
 * `secure` is not a CommandSpec id). Mapping name→id keeps the session on the SAME
 * run() the GUI/CLI use (structural parity, C5). Unmapped names fall through.
 */
const VERB_SLASH: Readonly<Record<string, string>> = Object.freeze({
  secure: "gate",
  install: "install",
  uninstall: "uninstall",
});

/** Host-level control slashes — the host owns transcript/lifecycle, not us. */
const CONTROL_SLASH: ReadonlySet<SlashControl> = new Set<SlashControl>([
  "clear",
  "quit",
  "save",
  "resume",
  "cwd",
]);

/* ------------------------------------------------------------------------- *
 * The router.
 * ------------------------------------------------------------------------- */

/**
 * Execute a slash command. `name` is the slash without its leading "/", `rest`
 * is the trimmed remainder (both as produced by `repl.parseSlash`). Returns a
 * `SlashResult` the host applies. NEVER throws: any failure (including a thrown
 * execVerb) is caught and returned as a friendly `error` result so the session
 * loop survives (crash-free invariant).
 */
export async function execSlash(name: string, rest: string, ctx: SessionCtx): Promise<SlashResult> {
  try {
    // /help — render the command palette (CLI-surface verbs + slash list).
    if (name === "help") {
      return { kind: "verb", outcome: helpOutcome() };
    }

    // Unknown slash → friendly line, loop continues.
    if (!repl.knownSlash(name)) {
      return unknown(name);
    }

    // /profile is a tuning slash in the registry, but it hot-swaps the WHOLE
    // profile (re-resolving AgentTuning from the named seed), not a single field —
    // a host concern. `tuneFromSlash` returns null for it, so surface it as a
    // control BEFORE the generic tuning block and let the host re-resolve.
    if (name === "profile") {
      if (!rest.trim()) return usageHint("profile");
      return {
        kind: "control",
        control: "profile",
        rest: rest.trim(),
        text: c.dim(`profile → ${rest.trim()}`),
      };
    }

    // §3.1 tuning slashes (model/system/tools/gate/dry-run/verbosity/yes).
    // `/model <id>` is tuning; `/model` alone is a pane (handled below) — so we
    // only treat a tuning slash as tuning when it actually yields a patch.
    if (repl.TUNING_SLASHES.has(name)) {
      const patch = repl.tuneFromSlash(name, rest, ctx.state.tuning);
      if (patch) {
        const nextTuning = { ...ctx.state.tuning, ...patch };
        return {
          kind: "tune",
          patch,
          footer: repl.footerLine(nextTuning),
          text: tuneEcho(name, rest),
        };
      }
      // A tuning slash with no/invalid value: /model alone → fall to the pane
      // branch; /tools list → a view action; others → a friendly usage hint.
      if (name === "model") {
        return paneResult("model", ctx);
      }
      if (name === "tools" && rest.trim() === "list") {
        return { kind: "verb", outcome: toolsListOutcome(ctx) };
      }
      return usageHint(name);
    }

    // Pane slashes — switch the active pane and render it (pre-rendered text so
    // the host just prints + records activePane).
    const pane = PANE_SLASH[name];
    if (pane) {
      return paneResult(pane, ctx);
    }

    // Verb slashes — run through the parity registry (engine verdict verbatim, C5).
    const verbId = VERB_SLASH[name];
    if (verbId) {
      if (!ctx.execVerb) {
        return { kind: "error", text: c.yellow(`/${name}: verb execution not wired yet`) };
      }
      const tokens = [verbId, ...splitArgs(rest)];
      const outcome = await ctx.execVerb(tokens, ctx);
      return { kind: "verb", outcome };
    }

    // Host-level controls.
    if (CONTROL_SLASH.has(name as SlashControl)) {
      return {
        kind: "control",
        control: name as SlashControl,
        rest,
        text: controlEcho(name as SlashControl, rest),
      };
    }

    // Known to the registry but unmapped here (defensive) — treat as unknown so
    // the host never silently no-ops.
    return unknown(name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", text: c.red(`/${name}: ${message}`) };
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers (pure, render-only — no engine calls here; verbs go through execVerb).
 * ------------------------------------------------------------------------- */

/** Build a pane SlashResult, rendering via the injected projector (crash-safe). */
function paneResult(pane: PaneId, ctx: SessionCtx): SlashResult {
  let text: string;
  if (!ctx.renderPane) {
    text = c.dim(`(${pane} pane)`);
    return { kind: "pane", pane, text };
  }
  try {
    text = ctx.renderPane(pane, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    text = c.red(`(${pane} pane unavailable: ${message})`);
  }
  return { kind: "pane", pane, text };
}

/** A one-line human echo confirming a tuning change (the host also redraws footer). */
function tuneEcho(name: string, rest: string): string {
  const v = rest.trim();
  switch (name) {
    case "model":
      return c.dim(`model → ${v}`);
    case "system":
      return c.dim("system prompt updated");
    case "tools":
      return c.dim(`tools → ${v}`);
    case "gate":
      return c.dim(`gate → ${v}`);
    case "dry-run":
      return c.dim(`dry-run → ${v}`);
    case "verbosity":
      return c.dim(`verbosity → ${v}`);
    case "yes":
      return c.dim(`auto-approve → ${v}`);
    default:
      return c.dim(`${name} updated`);
  }
}

/** A one-line echo for a host control (the host performs the real action). */
function controlEcho(control: SlashControl, rest: string): string {
  switch (control) {
    case "clear":
      return c.dim("transcript cleared");
    case "quit":
      return c.dim("bye");
    case "save":
      return c.dim(`saving${rest ? ` → ${rest}` : ""}…`);
    case "resume":
      return c.dim(`resuming${rest ? ` ${rest}` : ""}…`);
    case "cwd":
      return c.dim(`cwd → ${rest || "(unchanged)"}`);
    case "profile":
      return c.dim(`profile → ${rest || "(default)"}`);
    default:
      return "";
  }
}

/** Friendly "unknown command" result. */
function unknown(name: string): SlashResult {
  return {
    kind: "error",
    text: `${c.red(`unknown command: /${name}`)} — try ${c.cyan("/help")} for the palette`,
  };
}

/** A usage hint for a tuning slash that got no/invalid value. */
function usageHint(name: string): SlashResult {
  const spec = repl.getSlash(name);
  const arg = spec?.arg ? ` ${spec.arg}` : "";
  return {
    kind: "error",
    text: `${c.yellow(`usage: /${name}${arg}`)}${spec?.description ? c.dim(` — ${spec.description}`) : ""}`,
  };
}

/**
 * /help — render the slash palette (the SAME registry the GUI/Ink view shows).
 * Pure text; no engine call (so it works offline + never blocks the loop). When
 * --json is on, the host channel decides; here we return text + a machine list.
 */
function helpOutcome(): CommandOutcome {
  const rows = repl.SLASH_COMMANDS.map((s) => {
    const left = `/${s.name}${s.arg ? ` ${s.arg}` : ""}`;
    return `  ${c.cyan(padName(left))}  ${c.dim(s.description)}`;
  });
  const header = c.bold("commands");
  const text = [header, ...rows].join("\n");
  return {
    text,
    json: {
      ok: true,
      command: "help",
      slashes: repl.SLASH_COMMANDS.map((s) => ({
        name: s.name,
        arg: s.arg ?? null,
        description: s.description,
        tuning: s.tuning ?? false,
      })),
    },
    exitCode: 0,
  };
}

/** /tools list — show the tool-policy view (read-only; no engine call). */
function toolsListOutcome(ctx: SessionCtx): CommandOutcome {
  const t = ctx.state.tuning.tools;
  const lines = [
    c.bold("tools"),
    `  ${c.dim("enabled:")} ${t.enabled ? c.green("on") : c.gray("off")}`,
    `  ${c.dim("allow:")} ${t.allow.length ? t.allow.join(", ") : c.dim("(default set)")}`,
    `  ${c.dim("deny:")} ${t.deny.length ? t.deny.join(", ") : c.dim("(none)")}`,
  ];
  return {
    text: lines.join("\n"),
    json: { ok: true, command: "tools", tools: t },
    exitCode: 0,
  };
}

/** Pad the slash-name column to a stable width for the /help palette. */
function padName(s: string): string {
  const width = 20;
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Split a slash remainder into argv tokens for execVerb. Simple whitespace split
 * (quoting is the host/shell's job upstream); empty rest → no tokens.
 */
function splitArgs(rest: string): string[] {
  const t = rest.trim();
  return t.length === 0 ? [] : t.split(/\s+/);
}
