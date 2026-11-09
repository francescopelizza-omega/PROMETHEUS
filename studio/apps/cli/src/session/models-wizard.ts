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
import type { GatedFailure, ModelsHost } from "./models-host.js";
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

/** The browser layer a `/models` step opens on — from the RESOLVED step, so every alias
 *  (`endless`, `rotate`, `spin`) lands where its readline twin does, and `all` widens only the
 *  local list (`/models free all` used to open "All local models"). */
export function browserLayerFor(
  step: ai.WizardStepId | "servers",
  showAll: boolean,
): string | undefined {
  switch (step) {
    case "local":
      return showAll ? "local" : "fits";
    case "free":
    case "cloud":
      return "free";
    case "paid":
      return "paid";
    case "rotation":
      return "rotation";
    case "servers":
      return "servers";
    default:
      return undefined;
  }
}

export type ModelsArgs =
  | { kind: "runtimes"; install?: string }
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
  if (head === "runtimes" || head === "runners" || head === "engines") {
    return toks[1]?.toLowerCase() === "install" && toks[2]
      ? { kind: "runtimes", install: toks[2].toLowerCase() }
      : { kind: "runtimes" };
  }
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
  columns?: readonly [string, string];
  current?: boolean;
  disabled?: string;
}[] {
  return step.rows.map((r) => {
    // Rows that carry a two-line blurb render in the two-column picker: the model name alone in
    // the left column, its two description lines on the right; the size/fit line and any notes
    // go to the detail pane under the list for the highlighted row.
    const twoLine = r.lines.length >= 2;
    return {
      label: r.label,
      detail: r.detail,
      body: twoLine ? [r.detail, ...r.lines.slice(2)] : r.lines,
      submitText: rowCommand(r),
      ...(twoLine ? { columns: [r.lines[0] ?? "", r.lines[1] ?? ""] as const } : {}),
      ...(r.current ? { current: true } : {}),
      ...(r.disabled ? { disabled: r.disabled } : {}),
    };
  });
}

const BADGE: Record<ai.RowBadge, string> = {
  ready: c.green("ready"),
  installed: c.green("installed"),
  "needs-install": c.cyan("download"),
  "needs-key": c.yellow("needs key"),
  keyless: c.green("no key needed"),
  "needs-offload": c.yellow("needs offload runtime"),
  slow: c.yellow("very slow here"),
  tight: c.yellow("tight fit"),
  "too-big": c.red("too big"),
};

/** The numbered rendering the readline host prints. Disabled rows get no number.
 *
 * Same two-column shape as the TUI picker: the model name alone in the left column (its
 * second line left empty) and the two description lines in the right column, then the
 * size/fit line and any notes underneath, dimmed. */
export function renderStep(step: ai.WizardStep): { text: string; pickable: ai.WizardRow[] } {
  const out: string[] = [c.bold(step.title)];
  for (const l of step.intro) out.push(c.dim(`  ${l}`));
  out.push("");
  const pickable: ai.WizardRow[] = [];
  const leftW = Math.min(34, Math.max(8, ...step.rows.map((r) => [...r.label].length)));
  const pad = (s: string): string => {
    const cut = [...s].length > leftW ? `${[...s].slice(0, leftW - 1).join("")}…` : s;
    return cut + " ".repeat(Math.max(0, leftW - [...cut].length));
  };
  for (const r of step.rows) {
    const badge = r.badge ? ` [${BADGE[r.badge]}]` : "";
    const cur = r.current ? c.green(" ← current") : "";
    const [d1, d2, ...rest] = r.lines.length >= 2 ? r.lines : [r.detail, "", ...r.lines];
    if (r.disabled) {
      out.push(`      ${c.dim(pad(r.label))}   ${c.dim(d1 ?? "")}`);
      out.push(`      ${" ".repeat(leftW)}   ${c.dim(r.disabled)}`);
      continue;
    }
    pickable.push(r);
    const num = c.cyan(String(pickable.length).padStart(2));
    out.push(`  ${num}  ${c.bold(pad(r.label))}   ${d1 ?? ""}`);
    out.push(`      ${" ".repeat(leftW)}   ${d2 ?? ""}`);
    const extra = [r.lines.length >= 2 ? r.detail : "", ...rest].filter(Boolean);
    if (extra.length || badge || cur) {
      out.push(`      ${" ".repeat(leftW)}   ${c.dim(extra.join(" · "))}${badge}${cur}`);
    }
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
  "  /models runtimes        local runtimes + agents: installed? how to install",
  "  /models runtimes install <id>   install one through its official package channel",
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
  if (args.kind === "runtimes") {
    await runRuntimes(args.install, ctx, host);
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

/**
 * A nemesis WARN: show what it found, then accept only a TYPED confirmation — the model's own
 * name. A stray Enter or "y" refuses; a BLOCK never reaches here (it is not `needsConfirm`).
 */
async function confirmWarn(ctx: SlashCtx, name: string, r: GatedFailure): Promise<boolean> {
  ctx.write(c.yellow(`⚠ nemesis WARN: ${r.reason}`));
  for (const f of r.findings ?? []) ctx.write(c.dim(`  · ${f}`));
  const ans = (await ctx.ask(`type ${name} to use it anyway (Enter refuses): `)).trim();
  if (ans === name) return true;
  ctx.write(c.dim("refused — nothing is used."));
  return false;
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
  // depth 1: a blocked alternative reports why, but never offers alternatives of its own
  await runUse(`local:${pick.id}`, ctx, host, 1);
}

/**
 * `/models runtimes` — every local runtime and local-model agent Prometheus knows, two-column
 * like the model picker, with whether it is installed here and how it would be installed.
 * `/models runtimes install <id>` installs one through its official package channel after an
 * explicit yes; a vendor script is only ever SHOWN.
 */
export async function runRuntimes(
  installId: string | undefined,
  ctx: SlashCtx,
  host: ModelsHost,
): Promise<void> {
  const rows = [
    ...ai.runtimes.RUNTIMES.map((r) => ({
      id: r.id,
      name: r.name,
      summary: r.summary,
      tier: r.tier as string,
      notes: r.notes,
    })),
    ...ai.runtimes.AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      summary: a.summary,
      tier: "agent",
      notes: [] as readonly string[],
    })),
  ];
  const byId = new Map<
    string,
    { installed: string | null; auto: string | null; manual?: string | null }
  >();
  for (const r of (await host.runtimeStatus?.().catch(() => [])) ?? []) byId.set(r.id, r);
  if (installId) {
    const row = rows.find((r) => r.id === installId);
    if (!row) {
      ctx.write(c.red(`unknown runtime "${installId}" — see /models runtimes`));
      return;
    }
    if (!host.installRuntime) {
      ctx.write(c.red("this surface cannot install runtimes"));
      return;
    }
    const s = byId.get(installId);
    if (s?.installed) {
      ctx.write(c.green(`✓ ${row.name} is already installed (${s.installed})`));
      return;
    }
    if (s?.auto) ctx.write(c.dim(`official channel: ${s.auto}`));
    if (!(await ctx.confirm(`Install ${row.name}${s?.auto ? ` (${s.auto})` : ""}?`))) {
      ctx.write(c.dim("(cancelled)"));
      return;
    }
    const r = await host.installRuntime(installId, (l) => ctx.write(c.dim(l)));
    if (r.ok) ctx.write(c.green(`✓ ${row.name} installed`));
    else {
      ctx.write(c.red(`✗ ${r.reason}`));
      if (r.manual) ctx.write(`  run it yourself after reading it:  ${c.bold(r.manual)}`);
    }
    return;
  }
  const leftW = Math.min(30, Math.max(...rows.map((r) => r.name.length)));
  ctx.write(c.bold("Local runtimes and agents"));
  ctx.write(
    c.dim("  install one: /models runtimes install <id>  (official package channels only)"),
  );
  ctx.write("");
  for (const r of rows) {
    const s = byId.get(r.id);
    const state = s?.installed
      ? c.green("installed")
      : s?.auto
        ? c.cyan(`installable · ${s.auto}`)
        : s?.manual
          ? c.yellow("manual install")
          : c.dim(r.tier === "adopt" || r.tier === "detect" ? "used when running" : "—");
    ctx.write(`  ${c.bold(r.name.padEnd(leftW))}   ${r.summary}`);
    ctx.write(
      `  ${c.dim(`[${r.id}]`.padEnd(leftW))}   ${state}${r.notes[0] ? c.dim(` · ${r.notes[0]}`) : ""}`,
    );
    const launch = LOCAL_AGENT_LAUNCH[r.id];
    if (launch) ctx.write(`  ${" ".repeat(leftW)}   ${c.dim(`run on a local model: ${launch}`)}`);
  }
}

/**
 * How each local-model agent is launched against a model this machine serves: the engine's
 * `chat --cli`, which wires the agent per run through env/argv only (nothing written to its own
 * config). `--runner` picks the local server (ollama by default; lmstudio, llamacpp, vllm).
 */
const LOCAL_AGENT_LAUNCH: Readonly<Record<string, string>> = {
  opencode: "prometheus chat --cli opencode --model <model> --open",
  // Hermes has no per-run endpoint flags: point it at the server once (`hermes model` →
  // Custom endpoint), then launch it; the engine prints the exact base URL
  hermes:
    "hermes model (once: Custom endpoint) · then prometheus chat --cli hermes --model <model> --open",
  aider: "prometheus chat --cli aider --model <model> [--runner …] --open",
  goose: "prometheus chat --cli goose --model <model> [--runner …] --open",
};

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
  // The runtime is chosen PER MODEL by the planner (an Ollama build → Ollama; none → LM Studio
  // when installed, else llama.cpp; an MLX-only build → MLX-LM / LM Studio on Apple Silicon),
  // so there is no "which server?" question any more: the plan says which one and why.
  const plan = ai.preparePlan(ref, pctx);
  if (plan.runtime && ref.section === "local") {
    const name = ai.SERVE_RUNTIME_NAMES[plan.runtime];
    ctx.write(c.dim(`runs on ${name}${plan.runtimeReason ? ` — ${plan.runtimeReason}` : ""}`));
    if (plan.switchDefault) {
      ctx.write(
        c.dim(
          `your default server moves from ${ai.DEFAULT_SERVER_INFO[plan.switchDefault.from].name} to ${ai.DEFAULT_SERVER_INFO[plan.switchDefault.to].name} once this model is ready`,
        ),
      );
    }
  }
  for (const w of plan.warnings) ctx.write(c.yellow(`⚠ ${w}`));
  if (plan.blocked) {
    ctx.write(c.red(`✗ ${plan.blocked}`));
    if (plan.insist?.length) {
      ctx.write(c.bold("Run it anyway, streaming it from disk (you will be asked to confirm):"));
      for (const i of plan.insist) {
        ctx.write(`  ${c.cyan(`/models use ${i.ref}`)}  ${c.dim(`${i.name} — ${i.speed}`)}`);
      }
    }
    if (depth === 0) await offerAlternatives(ctx, host, plan.alternatives);
    return;
  }
  let model: string | undefined;
  let freshLive: string[] | undefined;
  /** the library path of a GGUF admitted earlier in this plan (fetch-gguf → import-ollama). */
  let admittedPath: string | undefined;
  /** the admitted directory of a snapshot (fetch-snapshot → serve-mlx / serve-stream). */
  let admittedDir: string | undefined;
  for (const action of plan.actions) {
    switch (action.kind) {
      case "install-runner": {
        ctx.write("Ollama runs local models and is not installed on this machine.");
        if (
          !(await ctx.confirm("Install Ollama now through Prometheus's nemesis-gated installer?"))
        ) {
          ctx.write(c.dim("skipped — install it later with `/models runtimes install ollama`."));
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
        let r = await host.pull(action.tag, (line) => ctx.write(c.dim(line)));
        if (!r.ok && r.needsConfirm) {
          if (await confirmWarn(ctx, action.tag, r)) {
            r = await host.pull(action.tag, (line) => ctx.write(c.dim(line)), { force: true });
          } else {
            // the pulled model sits in Ollama's store: left there, the next pick sees it as
            // installed, skips the pull (and its scan) and adopts it
            const d = await host.discardOllama?.(action.tag);
            if (d?.ok) ctx.write(c.dim(`${action.tag} removed from Ollama.`));
            return;
          }
        }
        if (!r.ok) {
          ctx.write(c.red(`✗ download failed: ${r.reason ?? "unknown"}`));
          return;
        }
        ctx.write(c.green(`✓ ${action.tag} downloaded`));
        break;
      }
      case "fetch-gguf": {
        if (!host.fetchGguf) {
          ctx.write(c.red("✗ this surface cannot download GGUF models — use the CLI or the app"));
          return;
        }
        ctx.write(
          c.dim(
            `${action.repo} · ${action.file}${action.quant ? ` (${action.quant})` : ""} — from Hugging Face`,
          ),
        );
        if (
          !(await ctx.confirm(
            `Download about ${action.sizeGb} GB? It is checked against Hugging Face's sha256 and scanned by nemesis before it is used.`,
          ))
        ) {
          ctx.write(c.dim("skipped — nothing downloaded."));
          return;
        }
        const show = (line: string): void => ctx.write(c.dim(line));
        // `place`: the admitted file ends up in the serving runtime's own folder
        const place = { place: action.place };
        let r = await host.fetchGguf(action.id, action.repo, action.file, show, place);
        if (!r.ok && r.needsConfirm && (await confirmWarn(ctx, action.id, r))) {
          r = await host.fetchGguf(action.id, action.repo, action.file, show, {
            ...place,
            force: true,
          });
        }
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        admittedPath = r.path;
        ctx.write(c.green("✓ downloaded, verified and admitted by nemesis"));
        break;
      }
      case "import-ollama": {
        if (!host.importToOllama || !admittedPath) {
          ctx.write(c.red("✗ nothing admitted to import"));
          return;
        }
        const r = await host.importToOllama(action.id, admittedPath);
        if (!r.ok) {
          ctx.write(c.red(`✗ Ollama import failed: ${r.reason}`));
          return;
        }
        model = r.tag;
        ctx.write(c.green(`✓ served by Ollama as ${r.tag}`));
        break;
      }
      case "install-runtime": {
        if (!host.installRuntime) {
          ctx.write(c.red(`✗ install ${action.runtime} yourself, then retry`));
          return;
        }
        const how: Record<string, string> = {
          llamacpp: "llama.cpp through Homebrew",
          lmstudio: "LM Studio through Homebrew (cask, checksum-verified)",
          mlx: "MLX-LM through Homebrew",
          airllm:
            "AirLLM into Prometheus's own Python environment (wheels downloaded, scanned by nemesis, then installed)",
          colibri:
            "colibri from its pinned source commit (scanned by nemesis, then built on this machine)",
        };
        if (!(await ctx.confirm(`Install ${how[action.runtime] ?? action.runtime}?`))) {
          ctx.write(c.dim("skipped — nothing installed."));
          return;
        }
        const show = (l: string): void => ctx.write(c.dim(l));
        let r = await host.installRuntime(action.runtime, show);
        if (!r.ok && r.needsConfirm) {
          // the WARN is about the RUNTIME being installed, so its name is what is typed — the
          // model id was typed a moment earlier for a different decision (run it anyway)
          const name = action.runtime;
          if (
            await confirmWarn(ctx, name, {
              ok: false,
              reason: r.reason,
              ...(r.findings ? { findings: r.findings } : {}),
            })
          ) {
            r = await host.installRuntime(action.runtime, show, { acceptWarn: true });
          } else return;
        }
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          if (r.manual) ctx.write(`  run it yourself after reading it:  ${c.bold(r.manual)}`);
          return;
        }
        ctx.write(c.green(`✓ ${ai.SERVE_RUNTIME_NAMES[action.runtime]} installed`));
        break;
      }
      case "confirm-insist": {
        // The user asked for a model this machine cannot hold in RAM. Say exactly what that
        // costs, then require the model's name typed — Enter (or anything else) refuses.
        ctx.write(
          c.bold(
            `${action.label} needs about ${Math.ceil(action.needGb)} GB of RAM; this machine has ${action.ramGb} GB.`,
          ),
        );
        ctx.write(`  ${action.runtimeName} can run it by streaming its weights from disk.`);
        ctx.write(`  ${c.yellow(`Speed: ${action.speed}`)}`);
        if (!action.interactive) {
          ctx.write(
            c.yellow(
              "  Too slow for interactive agent turns: expect each answer to take many minutes.",
            ),
          );
        }
        const ans = (await ctx.ask(`type ${action.id} to run it anyway (Enter cancels): `)).trim();
        if (ans !== action.id) {
          ctx.write(c.dim("cancelled — nothing installed or downloaded."));
          await offerAlternatives(ctx, host, plan.alternatives);
          return;
        }
        break;
      }
      case "fetch-snapshot": {
        if (!host.fetchSnapshot) {
          ctx.write(c.red("✗ this surface cannot download model snapshots — use the terminal"));
          return;
        }
        ctx.write(c.dim(`${action.repo} — weights, config and tokenizer only, from Hugging Face`));
        if (
          !(await ctx.confirm(
            `Download about ${action.sizeGb ?? "?"} GB? Every file is checked against Hugging Face's sha256 and scanned by nemesis before it is used.`,
          ))
        ) {
          ctx.write(c.dim("skipped — nothing downloaded."));
          return;
        }
        const show = (line: string): void => ctx.write(c.dim(line));
        const place = { place: action.place };
        let r = await host.fetchSnapshot(action.id, action.repo, action.include, show, place);
        if (!r.ok && r.needsConfirm && (await confirmWarn(ctx, action.id, r))) {
          r = await host.fetchSnapshot(action.id, action.repo, action.include, show, {
            ...place,
            force: true,
          });
        }
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        admittedDir = r.path;
        ctx.write(c.green("✓ downloaded, verified and admitted by nemesis"));
        break;
      }
      case "serve-mlx": {
        if (!host.serveMlx || !admittedDir) {
          ctx.write(c.red("✗ nothing admitted to serve"));
          return;
        }
        ctx.write(c.dim("starting MLX-LM on the admitted model (offline)…"));
        const r = await host.serveMlx(action.id, admittedDir);
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        model = r.model;
        ctx.write(c.green(`✓ MLX-LM is serving ${action.id}`));
        break;
      }
      case "serve-stream": {
        if (!host.serveStream || !admittedDir) {
          ctx.write(c.red("✗ nothing admitted to serve"));
          return;
        }
        ctx.write(
          c.dim(
            "starting AirLLM on the admitted model (offline; the first start splits it into layers)…",
          ),
        );
        const r = await host.serveStream(action.id, admittedDir);
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        ctx.write(c.green(`✓ AirLLM is serving ${action.id}`));
        break;
      }
      case "serve-colibri": {
        if (!host.serveColibri || !admittedPath) {
          ctx.write(c.red("✗ nothing admitted to serve"));
          return;
        }
        ctx.write(
          c.dim("importing the admitted GGUF into colibri (read in place) and starting it…"),
        );
        const r = await host.serveColibri(action.id, admittedPath, action.ctx);
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        ctx.write(c.green(`✓ colibri is serving ${action.id}`));
        break;
      }
      case "serve-gguf": {
        if (!host.serveGguf || !admittedPath) {
          ctx.write(c.red("✗ nothing admitted to serve"));
          return;
        }
        ctx.write(
          c.dim(
            `starting llama-server on the admitted file (offline, ${action.ctx} tokens${action.stream ? ", weights paged from disk" : ""})…`,
          ),
        );
        const known = ai.findLocalModel(action.id);
        const r = await host.serveGguf(action.id, admittedPath, action.ctx, {
          ...(action.stream ? { stream: true } : {}),
          ...(known && (known.activeB !== undefined || known.tags.includes("moe"))
            ? { moe: true }
            : {}),
        });
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        ctx.write(c.green(`✓ llama.cpp is serving ${action.id}`));
        break;
      }
      case "link-lmstudio": {
        const what = action.format === "mlx" ? admittedDir : admittedPath;
        if (!host.linkLmstudio || !what) {
          ctx.write(c.red("✗ nothing admitted to link"));
          return;
        }
        const r = await host.linkLmstudio(action.id, what, action.format ?? "gguf");
        if (!r.ok) {
          ctx.write(c.red(`✗ LM Studio link failed: ${r.reason}`));
          return;
        }
        break;
      }
      case "start-runtime": {
        if (!host.startLmstudio) {
          ctx.write(c.red("✗ start LM Studio's server yourself, then retry"));
          return;
        }
        ctx.write(c.dim("starting LM Studio's server…"));
        const r = await host.startLmstudio(ref.section === "local" ? ref.id : "");
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        model = r.model;
        break;
      }
      case "install-offload": {
        // legacy step (colibri is now installed and served by the plan itself)
        ctx.write(c.dim(`${action.runtime.name}: ${action.runtime.mechanism}`));
        await offerAlternatives(ctx, host, plan.alternatives);
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
        // a local pick is adopted on the runtime the PLAN chose (the ref may name none)
        const served: ai.WizardRef =
          ref.section === "local" && !ref.runtime && plan.runtime && plan.runtime !== "ollama"
            ? { ...ref, runtime: plan.runtime }
            : ref;
        // Fail CLOSED on Ollama picks: whatever path put the tag on disk (this run's pull, an
        // earlier pull whose scan errored, a plain `ollama pull`), it is adopted only once
        // nemesis vouches for the blobs now. A ledger hit makes this free on repeat picks.
        if (
          served.section === "local" &&
          (!served.runtime || served.runtime === "ollama") &&
          host.verifyOllama
        ) {
          const entry = ai.findLocalModel(served.id);
          if (entry) {
            const v = await host.verifyOllama(ai.localOllamaTag(entry));
            if (!v.ok) {
              ctx.write(
                c.red(
                  `✗ not adopted: ${v.reason}${v.needsConfirm ? " — run /models use again to review the warning" : ""}`,
                ),
              );
              return;
            }
          }
        }
        const r = await host.adopt(served, model);
        if (!r.ok) {
          ctx.write(c.red(`✗ ${r.reason}`));
          return;
        }
        host.saveChoice(
          model && (ref.section === "free" || ref.section === "paid")
            ? ai.formatRef({ ...ref, model })
            : ai.formatRef(served),
        );
        ctx.write(c.green(`✓ model → ${r.label}`));
        if (plan.switchDefault && ctx.defaultServerSetting) {
          const next = ai.defaultServerAfterPick(
            ctx.defaultServerSetting.get(),
            plan.switchDefault.to,
          );
          if (next.changed && ctx.defaultServerSetting.set(next.next)) {
            ctx.write(
              c.dim(
                `default server → ${ai.DEFAULT_SERVER_INFO[next.next].name} (this model needs it; /server changes it back)`,
              ),
            );
          }
        }
        return;
      }
    }
  }
}
