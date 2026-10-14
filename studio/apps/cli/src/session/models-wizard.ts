// SPDX-License-Identifier: MIT
// Copyright 2026 Francesco Pelizza
/**
 * session/models-wizard.ts — `/models`, the guided model picker.
 *
 *   /models                 Local (always free) or Cloud?
 *   /models cloud           Free cloud · Paid cloud · Endless free rotation
 *   /models local [all]     models for THIS machine, each with its fit verdict
 *   /models free | paid     cloud models, each with its key status
 *   /models spinner         the endless free spinner: members, and providers that could join it
 *   /models use <ref>       prepare (install Ollama / pull / key / offload runtime) and switch
 *   /models current         what is active, and the rotation's live state
 *
 * `/models` used to be the engine verb for model-running TOOLS (AirLLM, FlashAttention …). Every
 * one of those sub-commands still works — `/models install airllm`, `/models list`,
 * `/models status` … are handed to the engine unchanged, and `/models tools` is the old bare
 * listing — so nothing anyone typed before stops working.
 *
 * The readline host runs this file's numbered flow. The TUI opens the SAME steps as arrow-key
 * overlays (`tui/app.ts`), whose rows resubmit `/models <step>` or `/models use <ref>` back into
 * this file — so the two hosts share every decision and differ only in how a list is drawn.
 */
import { ai, orchestration } from "@prometheus/core";

import { c } from "../render.js";
import type { ModelsHost } from "./models-host.js";
import type { SlashCtx } from "./slash-registry.js";

/** The engine's own `models` actions — passed through untouched. */
const ENGINE_ACTIONS = new Set([
  "list",
  "install",
  "uninstall",
  "update",
  "enable",
  "disable",
  "status",
  "versions",
  "rollback",
  "config",
  "browse",
  "pull",
  "run",
]);

const STEP_WORDS: Record<string, ai.WizardStepId> = {
  local: "local",
  cloud: "cloud",
  free: "free",
  paid: "paid",
  rotation: "rotation",
  rotate: "rotation",
  endless: "rotation",
  spinner: "rotation",
  spin: "rotation",
};

export type ModelsArgs =
  | { kind: "step"; step: ai.WizardStepId; showAll: boolean }
  | { kind: "use"; ref: string }
  | { kind: "current" }
  | { kind: "engine"; args: string[] }
  | { kind: "help" };

export function parseModelsArgs(rest: string): ModelsArgs {
  const toks = rest.trim().split(/\s+/).filter(Boolean);
  const head = (toks[0] ?? "").toLowerCase();
  if (!head) return { kind: "step", step: "root", showAll: false };
  if (head === "tools") return { kind: "engine", args: ["list", ...toks.slice(1)] };
  if (ENGINE_ACTIONS.has(head)) return { kind: "engine", args: toks };
  if (head === "use" || head === "pick") return { kind: "use", ref: toks.slice(1).join(" ") };
  if (head === "current" || head === "now") return { kind: "current" };
  if (head === "help" || head === "?") return { kind: "help" };
  const step = STEP_WORDS[head];
  if (step) return { kind: "step", step, showAll: toks[1]?.toLowerCase() === "all" };
  // `/models qwen3:8b` — a bare ref is a pick.
  if (ai.parseRef(toks.join(" "))) return { kind: "use", ref: toks.join(" ") };
  return { kind: "help" };
}

export async function buildStep(
  host: ModelsHost,
  step: ai.WizardStepId,
  showAll = false,
): Promise<ai.WizardStep> {
  const ctx = await host.context();
  return ai.wizardStep(step, { ...ctx, ...(showAll ? { showAll: true } : {}) });
}

/** What picking a row runs (the TUI resubmits it; readline runs it in place). */
export function rowCommand(row: ai.WizardRow): string {
  if (row.next) return `/models ${row.next}`;
  if (row.ref) return `/models use ${row.ref}`;
  return "";
}

/** One overlay item per row, in the TUI's `ListOverlayItem` shape. */
export function overlayItems(step: ai.WizardStep): {
  label: string;
  detail: string;
  body: readonly string[];
  submitText: string;
  current?: boolean;
  disabled?: string;
}[] {
  return step.rows.map((r) => ({
    label: r.label,
    detail: r.detail,
    body: r.lines,
    submitText: rowCommand(r),
    ...(r.current ? { current: true } : {}),
    ...(r.disabled ? { disabled: r.disabled } : {}),
  }));
}

const BADGE: Record<ai.RowBadge, string> = {
  ready: c.green("ready"),
  installed: c.green("installed"),
  "needs-install": c.cyan("download"),
  "needs-key": c.yellow("needs key"),
  keyless: c.green("no key needed"),
  "needs-offload": c.yellow("needs offload runtime"),
  slow: c.yellow("very slow here"),
  "too-big": c.red("too big"),
};

/** The numbered rendering the readline host prints. Disabled rows get no number. */
export function renderStep(step: ai.WizardStep): { text: string; pickable: ai.WizardRow[] } {
  const out: string[] = [c.bold(step.title)];
  for (const l of step.intro) out.push(c.dim(`  ${l}`));
  out.push("");
  const pickable: ai.WizardRow[] = [];
  for (const r of step.rows) {
    const badge = r.badge ? `  [${BADGE[r.badge]}]` : "";
    const cur = r.current ? c.green("  ← current") : "";
    if (r.disabled) {
      out.push(`     ${c.dim(r.label)}  ${c.dim(r.detail)}`);
      continue;
    }
    pickable.push(r);
    out.push(`  ${c.cyan(String(pickable.length).padStart(2))}  ${c.bold(r.label)}${badge}${cur}`);
    out.push(`      ${c.dim(r.detail)}`);
    for (const l of r.lines) out.push(`      ${l}`);
  }
  return { text: out.join("\n"), pickable };
}

const HELP = [
  c.bold("/models — pick and prepare a model"),
  "  /models                 local or cloud?",
  "  /models local [all]     models for this machine (fit-checked)",
  "  /models cloud           free · paid · endless free spinner",
  "  /models free | paid     cloud models with key status",
  "  /models spinner         the endless free spinner (rotates across free LLM APIs)",
  "  /models use <ref>       prepare + switch (e.g. local:qwen3-8b, free:groq:openai/gpt-oss-120b, rotation)",
  "  /models current         what is active now",
  c.dim("  model-running tools (AirLLM, FlashAttention …): /models tools · /models install <tool>"),
].join("\n");

export async function runModelsCommand(rest: string, ctx: SlashCtx): Promise<void> {
  const args = parseModelsArgs(rest);
  if (args.kind === "engine") {
    await ctx.runVerb(["models", ...args.args]);
    return;
  }
  if (args.kind === "help") {
    ctx.write(HELP);
    return;
  }
  const host = ctx.models;
  if (!host) {
    ctx.write(c.dim("the guided model picker isn't available on this surface — try /model."));
    return;
  }
  if (args.kind === "current") {
    await showCurrent(ctx, host);
    return;
  }
  if (args.kind === "use") {
    await runUse(args.ref, ctx, host);
    return;
  }
  // Navigate step to step in place: a pick of a "next" row opens that step; a pick of a ref
  // prepares and adopts it.
  let step = args.step;
  let showAll = args.showAll;
  for (let guard = 0; guard < 8; guard += 1) {
    const built = await buildStep(host, step, showAll);
    const { text, pickable } = renderStep(built);
    ctx.write(text);
    if (pickable.length === 0) return;
    const ans = (await ctx.ask("pick a number, or Enter to cancel: ")).trim();
    if (!ans) {
      ctx.write(c.dim("(cancelled)"));
      return;
    }
    const n = Number(ans);
    const row = Number.isInteger(n) && n >= 1 && n <= pickable.length ? pickable[n - 1] : undefined;
    if (!row) {
      ctx.write(c.red(`"${ans}" is not one of the numbers above`));
      return;
    }
    if (row.next) {
      step = row.next;
      showAll = false;
      continue;
    }
    if (row.ref) await runUse(row.ref, ctx, host);
    return;
  }
}

async function showCurrent(ctx: SlashCtx, host: ModelsHost): Promise<void> {
  const pctx = await host.context();
  ctx.write(`${c.bold("active:")} ${pctx.activeId ?? c.dim("(none)")}`);
  if (pctx.activeId === ai.ROTATION_ENDPOINT_ID) {
    for (const s of ai.rotationStatus(host.rotationMembers())) {
      const st = s.ready
        ? c.green("ready")
        : c.yellow(`cooling ${Math.ceil((s.coolingForMs ?? 0) / 60_000)} min`);
      ctx.write(
        `  ${s.serving ? c.green("▶") : " "} ${s.member.label}  ${st}${s.lastReason ? c.dim(`  (${s.lastReason})`) : ""}`,
      );
    }
  }
}

/** Ask for one of `items` by number; undefined on cancel or a bad answer. */
async function pickFrom<T>(
  ctx: SlashCtx,
  items: readonly T[],
  show: (t: T) => string,
): Promise<T | undefined> {
  items.forEach((t, i) => ctx.write(`  ${c.cyan(String(i + 1).padStart(2))}  ${show(t)}`));
  const ans = (await ctx.ask("pick a number, or Enter to cancel: ")).trim();
  const n = Number(ans);
  return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : undefined;
}

async function offerAlternatives(
  ctx: SlashCtx,
  host: ModelsHost,
  alts: readonly ai.LocalModelEntry[] | undefined,
): Promise<void> {
  if (!alts || alts.length === 0) {
    ctx.write(
      c.dim("No catalogued local model fits this machine — the free cloud runs them: /models free"),
    );
    return;
  }
  ctx.write(c.bold("Models that DO run on this machine:"));
  const pick = await pickFrom(
    ctx,
    alts,
    (m) => `${c.bold(m.label)}  ${c.dim(`${m.q4Gb} GB · ${m.blurb.strengths}`)}`,
  );
  if (!pick) {
    ctx.write(c.dim("(cancelled)"));
    return;
  }
  await runUse(`local:${pick.id}`, ctx, host);
}

/** Prepare a pick (with consent for every install/download) and switch the session to it. */
export async function runUse(
  refStr: string,
  ctx: SlashCtx,
  host: ModelsHost,
  depth = 0,
): Promise<void> {
  const ref =
    ai.parseRef(refStr) ??
    (ai.findLocalModel(refStr) ? ai.parseRef(`local:${ai.findLocalModel(refStr)?.id}`) : null);
  if (!ref) {
    ctx.write(c.red(`"${refStr}" is not a model ref — see /models help`));
    return;
  }
  const pctx = await host.context();
  const plan = ai.preparePlan(ref, pctx);
  for (const w of plan.warnings) ctx.write(c.yellow(`⚠ ${w}`));
  if (plan.blocked) {
    ctx.write(c.red(`✗ ${plan.blocked}`));
    if (depth === 0) await offerAlternatives(ctx, host, plan.alternatives);
    return;
  }
  let model: string | undefined;
  let freshLive: string[] | undefined;
  for (const action of plan.actions) {
    switch (action.kind) {
      case "install-runner": {
        ctx.write("Ollama runs local models and is not installed on this machine.");
        if (
          !(await ctx.confirm("Install Ollama now through Prometheus's nemesis-gated installer?"))
        ) {
          ctx.write(c.dim("skipped — install it later with `prometheus apps install ollama`."));
          return;
        }
        const r = await host.installOllama();
        if (!r.ok) {
          ctx.write(c.red(`✗ Ollama install failed: ${r.reason ?? "unknown"}`));
          return;
        }
        ctx.write(c.green("✓ Ollama installed"));
        const s = await host.startOllama();
        if (!s.ok) {
          ctx.write(
            c.red(
              `✗ Ollama did not start: ${s.reason ?? "unknown"} — start it, then /models again`,
            ),
          );
          return;
        }
        break;
      }
      case "start-runner": {
        ctx.write(c.dim("starting Ollama…"));
        const s = await host.startOllama();
        if (!s.ok) {
          ctx.write(c.red(`✗ Ollama did not start: ${s.reason ?? "unknown"}`));
          return;
        }
        break;
      }
      case "pull": {
        if (
          !(await ctx.confirm(`Download ${action.tag} (about ${action.sizeGb} GB) through Ollama?`))
        ) {
          ctx.write(c.dim("skipped — nothing downloaded."));
          return;
        }
        const r = await host.pull(action.tag, (line) => ctx.write(c.dim(line)));
        if (!r.ok) {
          ctx.write(c.red(`✗ download failed: ${r.reason ?? "unknown"}`));
          return;
        }
        ctx.write(c.green(`✓ ${action.tag} downloaded`));
        break;
      }
      case "install-offload": {
        const rt = action.plan.runtime;
        ctx.write(c.bold(`${action.model.label} needs ${rt.name} on this machine.`));
        ctx.write(`  ${rt.mechanism}`);
        ctx.write(`  ${c.yellow(`Speed: ${rt.speed}`)}`);
        if (!action.plan.interactive) {
          ctx.write(
            c.yellow(
              `  ${rt.name} can run it for offline jobs, but not as this chat session's model.`,
            ),
          );
        }
        const want = await ctx.confirm(
          rt.installCommand
            ? `Install ${rt.name} now (${rt.installCommand}, nemesis-gated)?`
            : `Show the steps to set up ${rt.name}?`,
        );
        if (!want) {
          ctx.write(c.dim(`skipped ${rt.name}.`));
          await offerAlternatives(ctx, host, plan.alternatives);
          return;
        }
        if (rt.installCommand) {
          await ctx.runVerb(rt.installCommand.split(/\s+/).slice(1));
        } else {
          ctx.write(
            c.dim(
              `${rt.name} is a native engine fetched from GitHub — Prometheus scans it before anything runs:`,
            ),
          );
          for (const s of rt.manualSteps ?? []) ctx.write(`  ${c.cyan(s)}`);
          if (action.model.colibri)
            ctx.write(c.dim(`  model id for start-here.sh: ${action.model.colibri}`));
          ctx.write(
            c.dim(
              `Once it is serving on ${rt.serveUrl ?? "its port"}, run /models local — it appears under "serving now".`,
            ),
          );
        }
        if (!action.plan.interactive) await offerAlternatives(ctx, host, plan.alternatives);
        return;
      }
      case "set-key": {
        const p = orchestration.apiProviderFor(action.providerId);
        const label = p?.label ?? action.providerId;
        ctx.write(c.bold(`${label} needs an API key.`));
        if (action.signupUrl) ctx.write(`  Get a free one here: ${c.cyan(action.signupUrl)}`);
        ctx.write(c.dim(`  (or export ${action.envVars.join(" / ")} before starting Prometheus)`));
        if (!ctx.askSecret) {
          ctx.write(
            `Store it with ${c.cyan(`prometheus provider connect ${action.providerId}`)} in a terminal, then run /models again.`,
          );
          return;
        }
        const key = await ctx.askSecret(`Paste your ${label} key (hidden; Enter to cancel):`);
        if (!key.trim()) {
          ctx.write(c.dim("(cancelled — nothing stored)"));
          return;
        }
        const r = await host.connectKey(action.providerId, key);
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        freshLive = r.live;
        ctx.write(c.green(`✓ ${label} key verified and stored in your OS keychain (never a file)`));
        break;
      }
      case "adopt": {
        if (ref.section === "rotation") {
          const members = host.rotationMembers();
          ctx.write(c.bold("The spinner will use, in order:"));
          for (const m of members)
            ctx.write(`  · ${m.label}${m.apiKeyRef ? "" : c.dim(" (no key)")}`);
          if (
            !(await ctx.confirm("Send prompts to these free providers, switching on quota limits?"))
          ) {
            ctx.write(c.dim("(cancelled)"));
            return;
          }
        }
        if (ref.section === "free" || ref.section === "paid") {
          const live = freshLive ?? (await host.liveModels(ref.providerId));
          const m = ai.matchLiveModel(ref.model, live);
          if (m.kind === "renamed") {
            ctx.write(c.dim(`${ref.model} is served as ${m.model} now — using that.`));
            model = m.model;
          } else if (m.kind === "missing") {
            ctx.write(c.yellow(`${ref.model} is not in the provider's live model list any more.`));
            const near = live.slice(0, 12);
            const pick = near.length > 0 ? await pickFrom(ctx, near, (x) => x) : undefined;
            if (!pick) {
              ctx.write(c.dim("(cancelled)"));
              return;
            }
            model = pick;
          }
        }
        const r = await host.adopt(ref, model);
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        host.saveChoice(
          model && (ref.section === "free" || ref.section === "paid")
            ? ai.formatRef({ ...ref, model })
            : ai.formatRef(ref),
        );
        ctx.write(c.green(`✓ model → ${r.label}`));
        return;
      }
    }
  }
}
