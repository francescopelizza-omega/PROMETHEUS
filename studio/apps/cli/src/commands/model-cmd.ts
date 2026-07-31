/**
 * commands/model-cmd.ts — the FULL `prom model …` surface over the modelhub.py
 * sidecar (C7 / file 05), at parity with the GUI Model Hub. Discovery + fit + the
 * GATED download; serve/stop/status drive a CLI-OWNED runner supervisor
 * (engine-bridge serve-host, CLI-022) that records only the pids it spawns — the
 * desktop C8 ServerSupervisor still exclusively owns GUI-launched servers.
 *
 *   model hw                      host CPU/RAM/GPU + usable-weight budget    [read]
 *   model list                    locally-present model files               [read]
 *   model search <q> [--source hf|ollama] [--modality M] [--free] [--limit N][read]
 *   model fit [id] [--params N] [--modality M] [--ctx N]                     [read]
 *   model endpoints               LIVE local + open-weight endpoints         [read]
 *   model repoint <tool> --base-url URL    env diff to re-point a tool       [read]
 *   model serve <id> [--quant Q] [--runner R] [--port N] [--yes] build+start [mutate]
 *   model status | ps             liveness-verified live CLI servers         [read]
 *   model pull <id> [--quant Q] [--source S] [--license L]        [mutate/gated]
 *   model remove <id> [--quant Q]                                       [mutate]
 *   model stop <profileId> [--yes]   SIGTERM→SIGKILL the CLI-recorded runner  [mutate]
 */
import { readFileSync } from "node:fs";

import { stretch } from "@prometheus/core";

import {
  type ServeLiveStatus,
  type ServeSpec,
  launchGuardVerdict,
} from "@prometheus/engine-bridge";
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, humanBytes, kv, table } from "../render.js";
import { runModelHw, runModelList } from "./model.js";
import {
  type SidecarDeps,
  defaultSidecarDeps,
  execArgv,
  flagSet,
  flagStr,
  forceBlocked,
  previewOutcome,
  renderMutation,
  runMutation,
  runRead,
  usageError,
  wantsExecute,
} from "./sidecar-cmd.js";

const SCRIPT = "modelhub.py" as const;

function sub(ctx: CliContext): string {
  return ctx.args.command[1] ?? "list";
}

/**
 * Read a flag that the sidecar wants as a JSON string (`--hw`, `--sha256`): an
 * inline JSON value OR `@path` to a JSON file. Returns the JSON string (passed
 * through verbatim) or undefined when absent. A bad @file/JSON returns undefined
 * so the sidecar validates — the CLI never pre-judges.
 */
function readJsonFlag(ctx: CliContext, key: string): string | undefined {
  const v = flagStr(ctx, key);
  if (!v) return undefined;
  if (v.startsWith("@")) {
    try {
      return readFileSync(v.slice(1), "utf8");
    } catch {
      return undefined;
    }
  }
  return v;
}

/** Find the catalog row whose id matches (or the first row) in a model.search envelope. */
function pickRow(env: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  const rows = Array.isArray(env.results) ? (env.results as Record<string, unknown>[]) : [];
  return rows.find((r) => String(r.id ?? "") === id) ?? rows[0];
}

interface FeasibilityMachine {
  ramGb: number;
  vramGb: number;
  unified: boolean;
}

/**
 * The ONE shared feasibility result (CLI-024) — consumed by BOTH `pull` (advisory,
 * ignores non-ok) and `info` (renders every kind). Discriminated so a probe failure
 * is distinct from a model with no compute-demand data; NEVER throws.
 *   ok           — verdict computed against this machine.
 *   no-resource  — the catalog row has no `resource` block (can't assess).
 *   probe-failed — model.search or hw.scan failed / returned nothing usable.
 */
type FeasibilityResult =
  | {
      kind: "ok";
      verdict: ReturnType<typeof stretch.assessFeasibility>;
      machine: FeasibilityMachine;
    }
  | { kind: "no-resource" }
  | { kind: "probe-failed" };

/**
 * Assemble the model's compute-demand (catalog `resource`) + THIS machine (hw.scan) and
 * run `stretch.assessFeasibility`. Binary-GB VRAM conversion (`/1024**3`) matches how
 * open-models.json `gpu_min_vram_gb` was generated. Never throws — errors collapse to a
 * `probe-failed` result so the caller decides whether to surface or swallow them.
 */
/** Pure: derive the machine descriptor from an hw.scan envelope, or null when unusable. */
function machineFromHw(hw: Record<string, unknown>): FeasibilityMachine | null {
  const ramGb = typeof hw.ram_gb === "number" ? hw.ram_gb : 0;
  if (hw.ok === false || !ramGb) return null;
  const gpus = Array.isArray(hw.gpus) ? (hw.gpus as Record<string, unknown>[]) : [];
  // binary-GB VRAM (/1024**3) matches how open-models.json gpu_min_vram_gb was generated.
  const vramGb = gpus.reduce((mx, g) => {
    const b = typeof g.vram_bytes === "number" ? g.vram_bytes / 1024 ** 3 : 0;
    return Math.max(mx, b);
  }, 0);
  return { ramGb, vramGb, unified: hw.unified_memory === true };
}

/** Pure: assess one catalog row against a machine, or null when the row has no resource block. */
function verdictForRow(
  row: Record<string, unknown>,
  m: FeasibilityMachine,
): ReturnType<typeof stretch.assessFeasibility> | null {
  const res = row.resource as ModelResource | undefined;
  if (!res || typeof res.min_ram_gb !== "number") return null;
  const activeB = typeof row.active_params_b === "number" ? row.active_params_b : undefined;
  return stretch.assessFeasibility(
    {
      q4Gb: typeof res.q4_gb === "number" ? res.q4_gb : 0,
      minRamGb: res.min_ram_gb,
      isMoe: activeB !== undefined,
      ...(activeB !== undefined ? { activeB } : {}),
      needsOffload: res.needs_offload === true,
    },
    m,
  );
}

async function computeFeasibility(id: string, deps: SidecarDeps): Promise<FeasibilityResult> {
  let cat: Record<string, unknown>;
  try {
    cat = await deps.runSidecar(SCRIPT, ["model.search", id]);
  } catch {
    return { kind: "probe-failed" };
  }
  const row = pickRow(cat, id);
  const res = row?.resource as ModelResource | undefined;
  if (!res || typeof res.min_ram_gb !== "number") return { kind: "no-resource" };
  let hw: Record<string, unknown>;
  try {
    hw = await deps.runSidecar(SCRIPT, ["hw.scan"]);
  } catch {
    return { kind: "probe-failed" };
  }
  const machine = machineFromHw(hw);
  if (!machine) return { kind: "probe-failed" };
  const verdict = verdictForRow(row as Record<string, unknown>, machine);
  if (!verdict) return { kind: "no-resource" };
  return { kind: "ok", verdict, machine };
}

/** Fuzzy relevance score (integer band, stable) for a catalog row vs a query (CLI-025). */
export function scoreModelRow(query: string, row: Record<string, unknown>): number {
  const q = query.trim().toLowerCase();
  if (!q) return 10; // no query → neutral (browse-all keeps catalog order via id tiebreak)
  const id = String(row.id ?? "").toLowerCase();
  const family = String(row.family ?? "").toLowerCase();
  const name = String(row.name ?? "").toLowerCase();
  const desc = String(row.description ?? "").toLowerCase();
  const tags = Array.isArray(row.tags) ? row.tags.map(String).join(" ").toLowerCase() : "";
  // split on the separators inside ollama-tag ids (`qwen2.5-coder:7b`) so "qwen" prefixes.
  const idTokens = id.split(/[\s:\-_/.]+/).filter(Boolean);
  if (id === q) return 100;
  if (id.startsWith(q) || idTokens.some((t) => t.startsWith(q))) return 80;
  if (family === q || family.startsWith(q)) return 60;
  if (name.includes(q)) return 40;
  if (tags.includes(q)) return 30;
  if (desc.includes(q)) return 20;
  return 0;
}

/** Rank rows by score desc, id asc (deterministic tiebreak); drops score-0 rows when querying. */
export function rankModels(
  query: string,
  rows: Record<string, unknown>[],
): { row: Record<string, unknown>; score: number }[] {
  const scored = rows.map((row) => ({ row, score: scoreModelRow(query, row) }));
  const kept = query.trim() ? scored.filter((s) => s.score > 0) : scored;
  return kept.sort(
    (a, b) => b.score - a.score || String(a.row.id ?? "").localeCompare(String(b.row.id ?? "")),
  );
}

/**
 * PRE-FLIGHT feasibility: before a `model pull`, compare the model's precomputed
 * compute-demand against THIS machine and, if it won't fit comfortably, surface the
 * AirLLM/offload escalation chain + a smaller-model nudge. Advisory only — never blocks
 * the download (any non-ok feasibility is swallowed). Returns a colored warning block,
 * or null when it fits / is unassessable / in --json mode.
 */
async function preflightFeasibility(
  ctx: CliContext,
  id: string,
  deps: SidecarDeps,
): Promise<string | null> {
  if (ctx.json) return null; // json mode surfaces the verdict in the envelope, not as prose
  const f = await computeFeasibility(id, deps);
  if (f.kind !== "ok" || f.verdict.tier === "fits") return null;
  return feasibilityWarning(f.verdict, f.machine, id);
}

/** The shared colored warning block (verdict headline + ≤3 techniques + smaller-model nudge). */
function feasibilityWarning(
  v: ReturnType<typeof stretch.assessFeasibility>,
  m: FeasibilityMachine,
  id: string,
): string {
  const tint = v.tier === "tight" ? c.yellow : c.red;
  const lines = [
    tint(
      `⚠ feasibility (${m.ramGb}GB RAM${m.vramGb >= 1 ? ` · ${Math.round(m.vramGb)}GB GPU` : ""}): ${v.headline}`,
    ),
  ];
  for (const s of v.suggestions.slice(0, 3)) {
    lines.push(`  ${c.cyan(s.technique.name)} — ${c.dim(s.rationale)}`);
  }
  if (v.suggestSmaller) {
    lines.push(
      c.dim(
        `  smaller model: prom model browse --free   ·   size your context: prom model fit ${id}`,
      ),
    );
  }
  return lines.join("\n");
}

/**
 * Extract a runnable ServeSpec from the sidecar `serve` envelope (its pure `profile`).
 * Returns null when the profile has no concrete runner argv (e.g. a `<gguf>` placeholder).
 */
function serveSpecFrom(env: Record<string, unknown>): ServeSpec | null {
  const p =
    env.profile && typeof env.profile === "object"
      ? (env.profile as Record<string, unknown>)
      : null;
  if (!p) return null;
  const argv = Array.isArray(p.argv) ? (p.argv as unknown[]).map(String) : [];
  if (!argv.length || argv.some((a) => a.includes("<") && a.includes(">"))) return null;
  const endpoint =
    p.endpoint && typeof p.endpoint === "object" ? (p.endpoint as Record<string, unknown>) : {};
  const port = typeof endpoint.port === "number" ? endpoint.port : Number(endpoint.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  return {
    profileId: String(p.id ?? p.model_id ?? "profile"),
    model: String(p.model_id ?? p.id ?? "model"),
    runner: String(p.runner ?? "runner"),
    port,
    argv,
    ...(typeof endpoint.base_url === "string" ? { baseUrl: endpoint.base_url } : {}),
  };
}

const OLLAMA_MANUAL =
  "install ollama: macOS `brew install ollama` · Linux `curl -fsSL https://ollama.com/install.sh | sh` · else https://ollama.com/download";

/**
 * Offer an OS-aware ollama install when the runner binary is absent (CLI-027). Reuses
 * the engine's install-runner seam (engine-bridge is the sole spawner — the CLI never
 * runs brew/curl). Fail-closed consent: `--yes` proceeds non-interactively, else a TTY
 * y/N (default N); non-TTY/EOF/decline exits 0 with the manual command. On confirm it
 * installs (launch-guarded), re-probes to VERIFY, then retries the original action.
 */
async function offerRunnerInstall(
  ctx: CliContext,
  deps: SidecarDeps,
  retry: { base: string[]; command: string } | null,
): Promise<CommandOutcome> {
  const notice = c.yellow("ollama is not installed — it downloads AND serves local models.");
  const confirm = deps.confirmRunnerInstall ?? defaultSidecarDeps.confirmRunnerInstall;
  const proceed = wantsExecute(ctx) || (confirm ? await confirm() : false);
  if (!proceed) {
    return {
      text: `${notice}\n  ${c.dim(OLLAMA_MANUAL)}`,
      json: { ok: false, error: "runner-missing", installable: true, declined: true },
      exitCode: 0, // declining is a valid choice, not a failure
    };
  }
  // the 90% launch guard applies to the install spawn too (never bypassed on this path).
  try {
    const verdict = launchGuardVerdict(
      await (deps.launchGuard ?? defaultSidecarDeps.launchGuard!)(),
    );
    if (!verdict.ok) {
      return {
        text: c.red(`ollama install refused — ${verdict.reason}. Free resources and retry.`),
        json: { ok: false, error: "launch-guard", reason: verdict.reason },
        exitCode: 2,
      };
    }
  } catch {
    /* a probe failure must not block a legitimate install */
  }
  const inst = await deps.runSidecar(SCRIPT, ["install-runner", "--runner", "ollama"]);
  if (inst.ok === false) {
    const hint = typeof inst.install === "string" ? inst.install : OLLAMA_MANUAL;
    if (inst.manual === true) {
      // unautomatable (Windows / no Homebrew): print instructions, attempt NOTHING (exit 0).
      return {
        text: `${c.yellow("automatic ollama install isn't available here")}\n  ${c.dim(hint)}`,
        json: inst,
        exitCode: 0,
      };
    }
    return {
      text: c.red(`ollama install failed: ${inst.error ?? "unknown"}\n  ${c.dim(hint)}`),
      json: inst,
      exitCode: 2,
    };
  }
  // POST-INSTALL VERIFY: the binary must actually be on PATH now (no false "installed").
  const probe = deps.probeRunner ?? defaultSidecarDeps.probeRunner!;
  if (!(await probe("ollama"))) {
    return {
      text: c.red(
        "ollama install ran but the binary is still not on PATH — see https://ollama.com/download",
      ),
      json: { ok: false, error: "verify-failed", installed: false },
      exitCode: 2,
    };
  }
  if (!retry) {
    return {
      text: `${c.green("✓")} ollama installed — re-run your command to continue.`,
      json: { ok: true, installed: true },
      exitCode: 0,
    };
  }
  // retry the original action now that the runner exists.
  const out = await deps.runSidecar(SCRIPT, execArgv(ctx, retry.base, false));
  if (ctx.json) return { json: out, exitCode: out.ok === false ? 2 : 0 };
  if (out.ok === false) {
    let t = c.red(`${retry.command}: ${out.error ?? "failed after install"}`);
    if (/ollama|daemon|serve/i.test(t))
      t += `\n${c.dim("try: prom doctor · prom model install-runner")}`;
    return { text: t, exitCode: 2 };
  }
  return { text: `${c.green("✓")} ollama installed · ${retry.command} complete`, exitCode: 0 };
}

export async function runModelCommand(
  ctx: CliContext,
  deps: SidecarDeps = defaultSidecarDeps,
): Promise<CommandOutcome> {
  const verb = sub(ctx);
  const pos = ctx.args.positionals;

  switch (verb) {
    case "hw":
      return runModelHw(ctx);
    case "list":
    case "library":
      // `library` is the GUI "My Models" tab — same local inventory (+ Ollama index
      // the sidecar folds in). `--modality` filters the rendered rows where present.
      return runModelList(ctx);

    case "info": {
      const id = pos[0];
      if (!id) return usageError("model info", "<id>");
      const cat = await deps.runSidecar(SCRIPT, ["model.search", id]);
      const row = pickRow(cat, id) as (ModelRow & Record<string, unknown>) | undefined;
      if (!row) {
        // unknown catalog id (no rows) → exit 2 (CLI-024), pointing at search.
        if (ctx.json) {
          return { json: { ok: false, refused: true, hint: "model search", id }, exitCode: 2 };
        }
        return {
          text: c.red(
            `prom model info ${id}: not in the bundled open catalog — try \`prom model search ${id}\``,
          ),
          exitCode: 2,
        };
      }
      const feas = await computeFeasibility(id, deps);
      if (ctx.json) return { json: { ...infoJsonCard(row, feas), ok: true }, exitCode: 0 };
      return renderInfo(cat, id, feas);
    }

    case "browse": {
      // The GUI "Discover" tab over the bundled open-models catalog (the 140-model
      // download set). model.search with no query returns the whole catalog.
      const free = flagSet(ctx, "free") || flagSet(ctx, "free-only");
      const modality = flagStr(ctx, "modality") ?? flagStr(ctx, "family");
      const argv = ["model.search"];
      if (modality) argv.push("--family", modality);
      const limit = Number(flagStr(ctx, "limit"));
      return runRead(ctx, {
        command: "model browse",
        script: SCRIPT,
        argv,
        deps,
        render: (e) => renderSearch(e, { free, limit: Number.isFinite(limit) ? limit : undefined }),
      });
    }

    case "card": {
      const id = pos[0];
      if (!id) return usageError("model card", "<id> [--open]");
      return runRead(ctx, {
        command: "model card",
        script: SCRIPT,
        argv: ["model.search", id],
        deps,
        render: (e) => renderCard(e, id, flagSet(ctx, "open")),
      });
    }

    case "search": {
      const q = pos[0] ?? "";
      const argv = ["model.search"];
      if (q) argv.push(q);
      const modality = flagStr(ctx, "modality") ?? flagStr(ctx, "family");
      if (modality) argv.push("--family", modality);
      const source = flagStr(ctx, "source");
      if (source) argv.push("--source", source);
      const license = flagStr(ctx, "license");
      if (license) argv.push("--license", license);
      const env = await deps.runSidecar(SCRIPT, argv);
      if (env.ok === false) {
        if (ctx.json) return { json: env, exitCode: 2 };
        return { text: c.red(`model search: ${env.error ?? "catalog unavailable"}`), exitCode: 2 };
      }
      const rows = Array.isArray(env.results) ? (env.results as Record<string, unknown>[]) : [];

      // --fits: fetch hw.scan EXACTLY once, then assess each row against that one machine.
      const fits = flagSet(ctx, "fits");
      let machine: FeasibilityMachine | null = null;
      if (fits) {
        try {
          machine = machineFromHw(await deps.runSidecar(SCRIPT, ["hw.scan"]));
        } catch {
          machine = null; // probe failed → every row becomes "unknown fit" (kept, honest)
        }
      }
      const ranked = rankModels(q, rows).map(({ row, score }) => {
        const v = machine ? verdictForRow(row, machine) : null;
        return { row, score, fitTier: v ? v.tier : undefined };
      });
      // --fits keeps fits/tight + resource-less "unknown" rows; drops stretch/no-go.
      const shown = fits
        ? ranked.filter(
            (r) => r.fitTier === undefined || r.fitTier === "fits" || r.fitTier === "tight",
          )
        : ranked;
      const limit = Number(flagStr(ctx, "limit"));
      const capped = Number.isFinite(limit) && limit > 0 ? shown.slice(0, limit) : shown;

      if (ctx.json) {
        return {
          json: {
            ok: true,
            query: q || null,
            count: capped.length,
            results: capped.map(({ row, score, fitTier }) => ({
              id: row.id ?? null,
              family: row.family ?? null,
              params_b: typeof row.params_b === "number" ? row.params_b : null,
              context: typeof row.context === "number" ? row.context : null,
              license: row.license ?? null,
              score,
              ...(fitTier ? { fit_tier: fitTier } : {}),
            })),
          },
          exitCode: 0,
        };
      }
      return renderSearchTable(capped, fits);
    }

    case "fit": {
      const argv = ["fit"];
      const id = pos[0];
      if (id) argv.push("--id", id);
      const params = flagStr(ctx, "params");
      if (params) argv.push("--params", params);
      const modality = flagStr(ctx, "modality") ?? flagStr(ctx, "family");
      if (modality) argv.push("--family", modality);
      const ctxLen = flagStr(ctx, "ctx");
      if (ctxLen) argv.push("--ctx", ctxLen);
      const hw = readJsonFlag(ctx, "hw");
      if (hw) argv.push("--hw", hw);
      return runRead(ctx, {
        command: "model fit",
        script: SCRIPT,
        argv,
        deps,
        render: (e) => renderFit(e),
      });
    }

    case "endpoints":
      return runRead(ctx, {
        command: "model endpoints",
        script: SCRIPT,
        argv: ["endpoints"],
        deps,
        render: (e) => renderEndpoints(e),
      });

    case "repoint": {
      const tool = pos[0];
      const baseUrl = flagStr(ctx, "base-url") ?? flagStr(ctx, "baseUrl");
      if (!tool || !baseUrl) return usageError("model repoint", "<tool> --base-url <url>");
      return runRead(ctx, {
        command: "model repoint",
        script: SCRIPT,
        argv: ["repoint", "--tool", tool, "--base-url", baseUrl],
        deps,
        render: (e) => renderRepoint(e),
      });
    }

    case "serve": {
      const id = pos[0];
      if (!id) return usageError("model serve", "<id> [--quant Q] [--runner R] [--port N] [--yes]");
      if (id.startsWith("-")) {
        return { text: c.red(`model serve: refusing option-shaped id: ${id}`), exitCode: 2 };
      }
      const argv = ["serve", "--id", id];
      const quant = flagStr(ctx, "quant");
      if (quant) argv.push("--quant", quant);
      const runner = flagStr(ctx, "runner");
      if (runner) argv.push("--runner", runner);
      // CLI-027: an ollama-runner serve needs the runner present — offer to install it.
      if (runner === "ollama") {
        const probe = deps.probeRunner ?? defaultSidecarDeps.probeRunner!;
        if (!(await probe("ollama"))) return offerRunnerInstall(ctx, deps, null);
      }
      const port = flagStr(ctx, "port");
      if (port) argv.push("--port", port);
      const gguf = flagStr(ctx, "gguf");
      if (gguf) argv.push("--gguf", gguf);
      const ctxLen = flagStr(ctx, "ctx");
      if (ctxLen) argv.push("--ctx", ctxLen);
      if (flagSet(ctx, "autostart")) argv.push("--autostart");

      // 1) ALWAYS build the (pure) ServeProfile via the sidecar first.
      const env = await deps.runSidecar(SCRIPT, argv);
      if (env.ok === false) {
        if (ctx.json) return { json: env, exitCode: 2 };
        return {
          text: c.red(`model serve: ${env.error ?? "could not build serve profile"}`),
          exitCode: 2,
        };
      }
      // 2) PREVIEW by default (build only, spawn nothing) — mirrors the GUI plan step.
      if (!wantsExecute(ctx)) {
        if (ctx.json) return { json: { ...env, status: "profile-built" }, exitCode: 0 };
        const out = renderServe(env);
        out.text = `${out.text ?? ""}\n  ${c.dim("re-run with")} ${c.bold("--yes")} ${c.dim("to start the runner locally.")}`;
        return out;
      }
      // 3) EXECUTE: spawn the runner via the CLI serve-host and record its pid.
      const spec = serveSpecFrom(env);
      if (!spec) {
        return {
          text: c.red("model serve: the sidecar returned no runnable argv for this profile"),
          json: { ok: false, error: "no-argv" },
          exitCode: 2,
        };
      }
      const serveHost = deps.serveHost ?? defaultSidecarDeps.serveHost;
      if (!serveHost) return { text: c.red("model serve: no serve-host available"), exitCode: 2 };
      const res = await serveHost.start(spec);
      if (!res.ok) {
        return {
          text: c.red(`model serve: ${res.error}`),
          json: { ok: false, error: "serve-start", reason: res.error },
          exitCode: 2,
        };
      }
      const r = res.record;
      return {
        text:
          `${c.green("✓")} serving ${c.bold(r.model)} ${c.dim(`(${r.runner})`)}\n` +
          `  ${kv("profile", r.profileId)}\n  ${kv("port", String(r.port))}\n` +
          `  ${kv("pid", String(r.pid))}${r.baseUrl ? `\n  ${kv("endpoint", r.baseUrl)}` : ""}\n` +
          `  ${c.dim("stop with")} ${c.bold(`prom model stop ${r.profileId} --yes`)}`,
        json: { ok: true, status: "serving", server: r },
        exitCode: 0,
      };
    }

    case "status":
    case "ps": {
      const serveHost = deps.serveHost ?? defaultSidecarDeps.serveHost;
      const servers = serveHost ? await serveHost.status() : [];
      if (ctx.json) return { json: { ok: true, servers }, exitCode: 0 };
      return renderServeStatus(servers);
    }

    case "pull": {
      const id = pos[0];
      if (!id) return usageError("model pull", "<id> [--quant Q] [--source hf|ollama|url]");
      if (id.startsWith("-")) {
        return { text: c.red(`model pull: refusing option-shaped id: ${id}`), exitCode: 2 };
      }
      const source = flagStr(ctx, "source");
      // route (CLI-021): a bare `family:tag` (no "/" nor URL) → the real ollama `pull`
      // verb (v_pull); an `org/repo` HF id or a URL → the HF-staged `download` verb.
      const useOllama =
        source === "ollama" ||
        (source !== "hf" && source !== "url" && !id.includes("/") && !/^https?:/i.test(id));
      const verb = useOllama ? "pull" : "download";
      const base = [verb, "--id", id];
      const quant = flagStr(ctx, "quant");
      if (quant && !useOllama) base.push("--quant", quant);
      if (source && !useOllama) base.push("--source", source);
      const tag = flagStr(ctx, "tag");
      if (tag && useOllama) base.push("--tag", tag);
      const license = flagStr(ctx, "license");
      if (license && !useOllama) base.push("--license", license);
      const staged = flagStr(ctx, "staged");
      if (staged && !useOllama) base.push("--staged", staged);
      const sha256 = readJsonFlag(ctx, "sha256");
      if (sha256 && !useOllama) base.push("--sha256", sha256);

      // CLI-027: an ollama-routed pull needs the runner present. If it is missing, offer
      // an OS-aware install (confirm/decline/install/verify/retry) instead of dead-ending.
      if (useOllama) {
        const probe = deps.probeRunner ?? defaultSidecarDeps.probeRunner!;
        if (!(await probe("ollama"))) {
          return offerRunnerInstall(ctx, deps, { base, command: "model pull" });
        }
      }

      // PRE-FLIGHT: warn (don't block) if this model won't fit the machine + suggest offload.
      // Text mode → a colored warning block; --json → the structured verdict in the envelope.
      const feas = await preflightFeasibility(ctx, id, deps);
      const feasJson = ctx.json ? await computeFeasibility(id, deps) : null;

      // 90% CPU/RAM launch guard (CLI-021): sampled IMMEDIATELY before spawn, only when
      // actually executing (--yes), so a queued pull can't cross the ceiling mid-prompt.
      if (wantsExecute(ctx)) {
        try {
          const sample = await (deps.launchGuard ?? defaultSidecarDeps.launchGuard!)();
          const verdict = launchGuardVerdict(sample);
          if (!verdict.ok) {
            return {
              text: c.red(`model pull: refused — ${verdict.reason}. Free resources and retry.`),
              json: { ok: false, error: "launch-guard", reason: verdict.reason },
              exitCode: 2,
            };
          }
        } catch {
          /* a probe failure must not block a legitimate pull — proceed (fail-open probe) */
        }
      }

      const out = await runMutation(ctx, {
        command: "model pull",
        script: SCRIPT,
        base,
        note: `${verb} ${id}${quant && !useOllama ? ` (${quant})` : ""} → ${useOllama ? "ollama pull" : "stage"} → nemesis gate → admit | quarantine`,
        deps,
        confirm: false, // modelhub download/pull have no --confirm: calling IS running (gated)
      });
      // honest daemon-absent guidance when the ollama path fails.
      if (
        out.exitCode !== 0 &&
        typeof out.text === "string" &&
        /ollama|daemon|serve/i.test(out.text)
      ) {
        out.text += `\n${c.dim("try: prom doctor · prom model install-runner")}`;
      }
      if (feas && typeof out.text === "string" && out.exitCode === 0) {
        out.text = `${feas}\n\n${out.text}`;
      }
      // --json: fold the feasibility verdict into the envelope (deliverable 2).
      if (feasJson && feasJson.kind === "ok" && out.json && typeof out.json === "object") {
        (out.json as Record<string, unknown>).feasibility = {
          tier: feasJson.verdict.tier,
          headline: feasJson.verdict.headline,
          ramGb: feasJson.machine.ramGb,
          vramGb: Math.round(feasJson.machine.vramGb),
        };
      }
      return out;
    }

    case "remove":
    case "rm": {
      const id = pos[0];
      if (!id) return usageError("model rm", "<id> [--quant Q] --confirm <id> | --yes");
      if (id.startsWith("-")) {
        return { text: c.red(`model rm: refusing option-shaped id: ${id}`), exitCode: 2 };
      }
      // TYPED confirm (scriptable, matches sessions-cmd): `--yes` bypasses; otherwise the
      // id must be echoed back exactly via `--confirm <id>`. Wrong/empty/absent → refuse
      // (exit 2) and NEVER call the sidecar — non-TTY never blocks on a prompt.
      const confirmed = wantsExecute(ctx) || flagStr(ctx, "confirm") === id;
      if (!confirmed) {
        return {
          text: `to delete ${c.bold(id)}, re-run with ${c.bold(`--confirm ${id}`)} (type the id back) or ${c.bold("--yes")}`,
          json: { ok: false, error: "confirm-required", need: id },
          exitCode: 2,
        };
      }
      const blocked = forceBlocked(ctx, "model rm");
      if (blocked) return blocked;
      const base = ["remove", "--id", id];
      const quant = flagStr(ctx, "quant");
      if (quant) base.push("--quant", quant);
      // confirmed → calling the sidecar IS the deletion (no --confirm toggle). `--force`
      // rides to override the serve-profile refusal (server-side gate, unchanged).
      const env = await deps.runSidecar(SCRIPT, execArgv(ctx, base, false));
      if (ctx.json) return { json: env, exitCode: env.ok === false ? 2 : 0 };
      if (env.ok === false) return renderMutation(ctx, "model rm", env);
      const freed = typeof env.freed_bytes === "number" ? env.freed_bytes : 0;
      const n = typeof env.removed_count === "number" ? env.removed_count : 0;
      return {
        text: `${c.green("✓")} removed ${id} ${c.dim(`· freed ${humanBytes(freed)} · ${n} file${n === 1 ? "" : "s"}`)}`,
        exitCode: 0,
      };
    }

    case "prune": {
      // Dangling-blob GC. `--dry-run` is a READ (lists candidates, deletes nothing) so it
      // runs immediately; a real prune is a mutation → preview-by-default, `--yes` executes.
      if (flagSet(ctx, "dry-run")) {
        return runRead(ctx, {
          command: "model prune",
          script: SCRIPT,
          argv: ["prune", "--dry-run"],
          deps,
          render: (e) => renderPrune(e, true),
        });
      }
      return runMutation(ctx, {
        command: "model prune",
        script: SCRIPT,
        base: ["prune"],
        note: "delete dangling blobs (unreferenced by any manifest or serve profile)",
        deps,
        confirm: false, // modelhub prune has no --confirm: calling IS running
        renderOk: (e) => renderPrune(e, false),
      });
    }

    case "stop": {
      const profileId = pos[0];
      if (!profileId) return usageError("model stop", "<profileId>");
      // PREVIEW by default: show the plan (kill the CLI-recorded pid + mark the profile
      // stopped in serve-profiles.json), touch nothing.
      if (!wantsExecute(ctx)) {
        return previewOutcome(
          "model stop",
          SCRIPT,
          ["unserve", "--profile", profileId],
          `SIGTERM the CLI-recorded runner for '${profileId}' (if any) + mark its serve profile stopped`,
        );
      }
      // EXECUTE: (1) kill ONLY a pid the CLI itself recorded (never the GUI C8
      // supervisor's), self-healing a dead/stale pid; then (2) keep serve-profiles.json
      // truthful via the sidecar `unserve`.
      const serveHost = deps.serveHost ?? defaultSidecarDeps.serveHost;
      const killed = serveHost
        ? await serveHost.stop(profileId)
        : { ok: true, found: false as boolean };
      const env = await deps.runSidecar(
        SCRIPT,
        execArgv(ctx, ["unserve", "--profile", profileId], false),
      );
      if (ctx.json) {
        return {
          json: { ok: env.ok !== false, killed, unserve: env },
          exitCode: env.ok === false ? 2 : 0,
        };
      }
      if (env.ok === false) {
        return { text: c.red(`model stop: ${env.error ?? "unserve failed"}`), exitCode: 2 };
      }
      const note = !killed.found
        ? c.dim("(no CLI-recorded runner — profile marked stopped)")
        : killed.wasStale
          ? c.dim("(stale pid cleaned up)")
          : killed.killed
            ? c.dim("(SIGKILL after grace)")
            : c.dim("(SIGTERM)");
      return { text: `${c.green("✓")} model stop ${profileId} ${note}`, exitCode: 0 };
    }
    case "tools":
      return {
        text: `prom model tools: model-RUNNING tools (AirLLM/FlashAttention/…) live under ${c.bold("prom models")}.\n  ${c.dim("try:")} prom models list`,
        json: { ok: true, status: "pointer", see: "models" },
        exitCode: 0,
      };

    default:
      return {
        text:
          `prom model ${verb}: unknown model verb.\n` +
          `  ${c.dim("try:")} hw · list · library · search · browse · info · card · fit · pull · rm · prune · serve · status · stop · endpoints · repoint`,
        json: { ok: false, error: "unknown-verb", command: `model ${verb}` },
        exitCode: 2,
      };
  }
}

/* ----------------------------- read renderers ----------------------------- */

interface ModelRow {
  id?: string;
  name?: string;
  description?: string;
  params?: string;
  params_b?: number;
  context?: number;
  tags?: string[];
  license?: string;
  open_weight?: boolean;
  openWeight?: boolean;
  source?: string;
  resource?: ModelResource;
}

/** The precomputed compute-demand block (open-models.json `resource`, §model-resource). */
interface ModelResource {
  q4_gb?: number;
  kv_8k_gb?: number;
  kv_native_gb?: number;
  min_ram_gb?: number;
  rec_ram_gb?: number;
  gpu_min_vram_gb?: number;
  cpu_ok?: boolean;
  tier?: string;
  needs_offload?: boolean;
  label?: string;
}

/** Tint a resource label by tier: small=green, heavy=yellow, server/offload=red. */
function resourceLine(res: ModelResource | undefined): string | undefined {
  if (!res?.label) return undefined;
  const tier = res.tier ?? "";
  const tint =
    res.needs_offload || tier === "server"
      ? c.red
      : tier === "heavy" || tier === "workstation"
        ? c.yellow
        : c.green;
  const mark =
    res.needs_offload || tier === "server"
      ? "▲"
      : tier === "heavy" || tier === "workstation"
        ? "●"
        : "●";
  return `${tint(mark)} ${c.dim(res.label)}`;
}

function renderSearch(
  e: Record<string, unknown>,
  opts: { free: boolean; limit?: number },
): CommandOutcome {
  let rows = Array.isArray(e.results) ? (e.results as ModelRow[]) : [];
  if (opts.free) {
    rows = rows.filter((r) => {
      const lic = (r.license ?? "").toLowerCase();
      // The bundled open-models rows carry no open_weight field (they ARE all
      // open-weight) — default true so `--free` filters by PERMISSIVE LICENSE.
      const open = r.openWeight ?? r.open_weight ?? true;
      return open && /apache|mit|bsd|llama|gemma|qwen|mpl|openrail/.test(lic);
    });
  }
  if (typeof opts.limit === "number" && opts.limit >= 0) rows = rows.slice(0, opts.limit);
  const lines = [heading(`Models  ${c.dim(`(${rows.length})`)}`), ""];
  if (rows.length === 0) {
    lines.push(c.dim("No matches."));
    return { text: lines.join("\n"), exitCode: 0 };
  }
  // One block per model: id + a meta line, then the one-line description so a user
  // picks by WHAT THE MODEL DOES (conscious choice), not by web fame.
  for (const r of rows) {
    const id = r.id ?? r.name ?? "—";
    const size = r.params ?? (typeof r.params_b === "number" ? `${r.params_b}B` : "");
    const ctx = typeof r.context === "number" ? `${Math.round(r.context / 1000)}K ctx` : "";
    const meta = [size, r.license, ctx, r.source].filter(Boolean).join(" · ");
    lines.push(`${c.bold(id)}${meta ? `  ${c.dim(meta)}` : ""}`);
    if (r.description) lines.push(`  ${c.dim(r.description)}`);
    const rl = resourceLine(r.resource);
    if (rl) lines.push(`  ${rl}`);
  }
  return { text: lines.join("\n"), exitCode: 0 };
}

/** Ranked RESULT TABLE for `model search` (ID · FAMILY · SIZE · CTX · LICENSE · FIT). */
function renderSearchTable(
  ranked: { row: Record<string, unknown>; score: number; fitTier?: string }[],
  fits: boolean,
): CommandOutcome {
  if (ranked.length === 0) {
    return { text: c.dim("no matches — try `prom model browse`"), exitCode: 0 };
  }
  const fitTint = (t?: string): string => {
    if (!t) return c.dim("?"); // unknown fit (no resource data) — never fabricated
    if (t === "fits") return c.green(t);
    if (t === "tight") return c.yellow(t);
    return c.red(t);
  };
  const rows = ranked.map(({ row, fitTier }) => {
    const size =
      typeof row.params === "string" && row.params
        ? row.params
        : typeof row.params_b === "number"
          ? `${row.params_b}B`
          : "-"; // null params (tag-only rows) render "-", never "nullB"
    const ctxCol = typeof row.context === "number" ? `${Math.round(row.context / 1000)}K` : "-";
    return [
      String(row.id ?? "-"),
      String(row.family ?? "-"),
      size,
      ctxCol,
      c.dim(String(row.license ?? "-")),
      fits || fitTier ? fitTint(fitTier) : c.dim("—"),
    ];
  });
  return {
    text: table(
      [
        { header: "ID" },
        { header: "FAMILY" },
        { header: "SIZE" },
        { header: "CTX" },
        { header: "LICENSE" },
        { header: "FIT" },
      ],
      rows,
    ),
    exitCode: 0,
  };
}

function renderInfo(
  e: Record<string, unknown>,
  id: string,
  feas: FeasibilityResult,
): CommandOutcome {
  const r = pickRow(e, id) as (ModelRow & Record<string, unknown>) | undefined;
  if (!r) {
    // caller already guards unknown ids (exit 2); this is defensive only.
    return {
      text: c.red(`prom model info ${id}: not in the bundled open catalog`),
      exitCode: 2,
    };
  }
  const lines = [heading(String(r.name ?? r.id ?? id)), ""];
  lines.push(kv("id", c.dim(String(r.id ?? id))));
  if (typeof r.family === "string") lines.push(kv("family", c.dim(r.family)));
  const size = r.params ?? (typeof r.params_b === "number" ? `${r.params_b}B` : "");
  if (size) lines.push(kv("params", String(size)));
  if (typeof r.context === "number")
    lines.push(kv("context", `${r.context.toLocaleString("en-US")} tokens`));
  if (r.license) lines.push(kv("license", String(r.license)));
  if (typeof r.ollama === "string" && r.ollama)
    lines.push(kv("ollama", c.cyan(`ollama pull ${r.ollama}`)));
  if (typeof r.repo === "string" && r.repo)
    lines.push(kv("repo", c.dim(`https://huggingface.co/${r.repo}`)));
  const quants = Array.isArray(r.quants) ? r.quants.map(String) : [];
  if (quants.length) lines.push(kv("quants", c.dim(quants.join(" · "))));
  const tags = Array.isArray(r.tags) ? r.tags.map(String) : [];
  if (tags.length) lines.push(kv("tags", c.dim(tags.join(" · "))));
  if (r.description) {
    lines.push("");
    lines.push(c.dim(String(r.description)));
  }
  // The compute-demand block — "can my machine run this?" at a glance (Q4_K_M).
  const res = r.resource as ModelResource | undefined;
  if (res) {
    lines.push("");
    lines.push(c.bold("Compute demand  ") + (resourceLine(res) ?? ""));
    if (typeof res.q4_gb === "number") lines.push(kv("weights (Q4)", `${res.q4_gb} GB`));
    if (typeof res.kv_native_gb === "number")
      lines.push(kv("KV @ full ctx", `${res.kv_native_gb} GB`));
    if (typeof res.min_ram_gb === "number")
      lines.push(kv("min RAM", `${res.min_ram_gb} GB (short context)`));
    if (typeof res.rec_ram_gb === "number")
      lines.push(kv("rec RAM", `${res.rec_ram_gb} GB (full context)`));
    if (typeof res.gpu_min_vram_gb === "number")
      lines.push(kv("min GPU VRAM", `${res.gpu_min_vram_gb} GB`));
    lines.push(kv("CPU-only", res.cpu_ok ? c.green("usable") : c.yellow("slow / GPU advised")));
    if (res.needs_offload) {
      lines.push(
        kv(
          "offload",
          c.red("won't fit even 128GB at Q4 — needs AirLLM / MoE expert-offload / a served API"),
        ),
      );
    }
  }
  // The machine-specific verdict (CLI-024): THIS box vs the model's demand.
  lines.push("");
  lines.push(c.bold("Feasibility (this machine)"));
  if (feas.kind === "ok") {
    const { verdict: v, machine: m } = feas;
    const tint = v.tier === "fits" ? c.green : v.tier === "tight" ? c.yellow : c.red;
    const gpu = m.vramGb >= 1 ? ` · ${Math.round(m.vramGb)}GB GPU` : "";
    const uni = m.unified ? " · unified" : "";
    lines.push(
      `  ${kv("verdict", `${tint(v.tier.toUpperCase())} — ${m.ramGb}GB RAM${gpu}${uni}`)}`,
    );
    lines.push(`  ${c.dim(v.headline)}`);
    if (v.tier !== "fits") {
      for (const s of v.suggestions.slice(0, 3)) {
        lines.push(`  ${c.cyan(s.technique.name)} — ${c.dim(s.rationale)}`);
      }
      if (v.suggestSmaller) {
        lines.push(c.dim("  smaller model: prom model browse --free"));
      }
    }
  } else if (feas.kind === "no-resource") {
    lines.push(c.dim("  no compute-demand data for this model"));
  } else {
    lines.push(c.dim("  machine probe unavailable"));
  }
  return { text: lines.join("\n"), exitCode: 0 };
}

/** The structured `--json` card for `model info` (feasibility is null unless kind==="ok"). */
function infoJsonCard(
  row: ModelRow & Record<string, unknown>,
  feas: FeasibilityResult,
): Record<string, unknown> {
  const model = {
    id: row.id ?? null,
    family: row.family ?? null,
    params_b: typeof row.params_b === "number" ? row.params_b : null,
    context: typeof row.context === "number" ? row.context : null,
    license: row.license ?? null,
    quants: Array.isArray(row.quants) ? row.quants.map(String) : [],
    repo: typeof row.repo === "string" ? row.repo : null,
    ollama: typeof row.ollama === "string" ? row.ollama : null,
    resource: (row.resource as ModelResource | undefined) ?? null,
  };
  const feasibility =
    feas.kind === "ok"
      ? {
          tier: feas.verdict.tier,
          headline: feas.verdict.headline,
          suggestions: feas.verdict.suggestions.slice(0, 3).map((s) => ({
            id: s.technique.id,
            name: s.technique.name,
            rationale: s.rationale,
          })),
          machine: {
            ram_gb: feas.machine.ramGb,
            vram_gb: Math.round(feas.machine.vramGb),
            unified: feas.machine.unified,
          },
        }
      : null;
  return { ok: true, model, feasibility };
}

function renderCard(e: Record<string, unknown>, id: string, open: boolean): CommandOutcome {
  const r = pickRow(e, id);
  const repo = r && typeof r.repo === "string" ? r.repo : "";
  if (!repo) {
    return {
      text: `prom model card ${id}: ${c.dim("no HuggingFace repo on record for this id.")}`,
      json: { ok: false, id, url: null },
      exitCode: 0,
    };
  }
  const url = `https://huggingface.co/${repo}`;
  // C5: the CLI never spawns (only engine-bridge may). We print the clickable URL —
  // most terminals make it openable; `--open` just adds the explicit hint.
  return {
    text: `${c.bold(String(r?.name ?? id))}\n  ${c.cyan(url)}${open ? `\n  ${c.dim("⌘/ctrl-click to open, or paste into your browser")}` : ""}`,
    json: { ok: true, id, url },
    exitCode: 0,
  };
}

function renderFit(e: Record<string, unknown>): CommandOutcome {
  const lines = [heading("Fit score"), ""];
  if (typeof e.recommended === "string") lines.push(kv("recommended", c.green(e.recommended)));
  const ranked = Array.isArray(e.ranked) ? (e.ranked as Record<string, unknown>[]) : [];
  if (ranked.length) {
    lines.push("");
    const rows = ranked.map((r) => [
      String(r.quant ?? r.name ?? "—"),
      c.dim(String(r.verdict ?? "—")),
      c.dim(typeof r.reason === "string" ? r.reason : ""),
    ]);
    lines.push(table([{ header: "QUANT" }, { header: "VERDICT" }, { header: "REASON" }], rows));
  }
  const reasons = Array.isArray(e.reasons) ? e.reasons.map(String) : [];
  for (const r of reasons) lines.push(c.dim(`  · ${r}`));
  return { text: lines.join("\n"), exitCode: 0 };
}

function renderEndpoints(e: Record<string, unknown>): CommandOutcome {
  const local = Array.isArray(e.local) ? (e.local as Record<string, unknown>[]) : [];
  const open = Array.isArray(e.open_api) ? (e.open_api as Record<string, unknown>[]) : [];
  const lines = [heading("Endpoints"), ""];
  const fmt = (arr: Record<string, unknown>[]): void => {
    for (const r of arr) lines.push(kv(String(r.name ?? "—"), c.dim(String(r.base_url ?? ""))));
  };
  lines.push(c.bold("local"));
  if (local.length) fmt(local);
  else lines.push(c.dim("  none"));
  lines.push("");
  lines.push(c.bold("open-weight APIs"));
  if (open.length) fmt(open);
  else lines.push(c.dim("  none"));
  return { text: lines.join("\n"), exitCode: 0 };
}

function renderRepoint(e: Record<string, unknown>): CommandOutcome {
  const lines = [heading(`Repoint  ${c.dim(String(e.tool ?? ""))}`), ""];
  if (typeof e.base_url === "string") lines.push(kv("base-url", e.base_url));
  const proposed =
    e.proposed_env && typeof e.proposed_env === "object"
      ? (e.proposed_env as Record<string, string>)
      : {};
  if (Object.keys(proposed).length) {
    lines.push("");
    lines.push(c.bold("proposed env"));
    for (const [k, v] of Object.entries(proposed)) lines.push(kv(k, c.dim(v)));
  }
  return { text: lines.join("\n"), exitCode: 0 };
}

function renderServe(e: Record<string, unknown>): CommandOutcome {
  const p =
    e.profile && typeof e.profile === "object" ? (e.profile as Record<string, unknown>) : {};
  const endpoint =
    p.endpoint && typeof p.endpoint === "object" ? (p.endpoint as Record<string, unknown>) : {};
  const lines = [heading("Serve profile"), c.dim("(built — not started)"), ""];
  if (typeof p.id === "string") lines.push(kv("id", p.id));
  if (typeof p.runner === "string") lines.push(kv("runner", p.runner));
  if (typeof endpoint.port === "number") lines.push(kv("port", String(endpoint.port)));
  if (typeof endpoint.base_url === "string") lines.push(kv("endpoint", endpoint.base_url));
  if (typeof p.status === "string") lines.push(kv("status", c.yellow(p.status)));
  return { text: lines.join("\n"), exitCode: 0 };
}

/** Render a `model prune` result: "freed 3.2 GB · 4 blobs" (or "would free …" in --dry-run). */
function renderPrune(e: Record<string, unknown>, dryRun: boolean): CommandOutcome {
  const freed = typeof e.freed_bytes === "number" ? e.freed_bytes : 0;
  const n = typeof e.removed_count === "number" ? e.removed_count : 0;
  if (n === 0) return { text: c.dim("no dangling blobs — library is clean"), exitCode: 0 };
  const verb = dryRun ? c.yellow("would free") : `${c.green("✓")} freed`;
  return {
    text: `${verb} ${humanBytes(freed)} ${c.dim(`· ${n} blob${n === 1 ? "" : "s"}`)}${dryRun ? c.dim(" (dry run — nothing deleted)") : ""}`,
    exitCode: 0,
  };
}

/** Render the live-server table for `model status`/`ps` (liveness-verified rows). */
function renderServeStatus(servers: ServeLiveStatus[]): CommandOutcome {
  if (!servers.length) {
    return { text: c.dim("no CLI-served models running"), exitCode: 0 };
  }
  const rows = servers.map((s) => [
    s.profileId,
    s.model,
    s.runner,
    String(s.port),
    String(s.pid),
    `${s.uptimeSec}s`,
  ]);
  return {
    text: table(
      [
        { header: "profile" },
        { header: "model" },
        { header: "runner" },
        { header: "port" },
        { header: "pid" },
        { header: "uptime" },
      ],
      rows,
    ),
    exitCode: 0,
  };
}
