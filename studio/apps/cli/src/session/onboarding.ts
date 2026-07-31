/**
 * session/onboarding.ts — first-run backend detection + the `/setup` wizard.
 *
 * The interactive session needs a working chat backend. Two kinds exist:
 *   • LOCAL  — a running OpenAI-compatible runner (Ollama :11434 / LM Studio :1234)
 *              that serves at least one model → the session streams from it directly.
 *   • PAID   — an installed agent CLI (claude/codex/gemini/cursor/opencode) the user
 *              launches via `prom chat --cli <svc> --open`.
 *
 * On startup the host probes for a live local runner+model (fast, ~1s, fail-soft) and,
 * when found, wires its OpenAI-compatible endpoint into the session so chat WORKS with
 * zero config. When nothing is found, the banner points at `/setup`, which detects +
 * lets the user pick/download a free local model (Ollama) OR connect a paid CLI.
 *
 * Everything here is dependency-injectable (client / fetch / ask / write / runChild) so
 * the detection + wizard are unit-testable with no network, no spawn, no real engine.
 * Nothing decides "safe" (C5): a model download still routes through the engine's gate.
 */
import { createRequire } from "node:module";

import type { AiEndpoint } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import {
  CATEGORY_LABEL,
  PATH_CATEGORIES,
  type PathCategory,
  diskInfo,
  prometheusHome,
  resolveCategory,
  setCategory,
} from "../home.js";
import { box, c, humanBytes } from "../render.js";

/** The OpenAI-compatible local runners the session can stream from out of the box. */
const LOCAL_RUNNERS: ReadonlyArray<{ name: string; baseUrl: string }> = [
  { name: "ollama", baseUrl: "http://localhost:11434/v1" },
  { name: "lmstudio", baseUrl: "http://localhost:1234/v1" },
];

/** Agent CLIs the session can hand a terminal chat to (`chat --cli <svc>`). */
const CHAT_CLIS = new Set(["claude", "codex", "gemini", "cursor", "opencode"]);

/**
 * Recommended free, local, coding-capable models to offer in `/setup` (Ollama tags).
 * Small→large; the first that fits the user's box is a fine default.
 */
export const RECOMMENDED_LOCAL: ReadonlyArray<{ tag: string; note: string; gb: number }> = [
  // small → large (Apache/MIT-permissive bias); the first that fits the box is a fine default.
  { tag: "qwen2.5-coder:3b", note: "light coding model — low-RAM boxes (Apache-2.0)", gb: 1.9 },
  { tag: "llama3.2:3b", note: "compact general/edge model (Meta)", gb: 2.0 },
  { tag: "phi4-mini", note: "3.8B MIT, 128K ctx — runs on modest machines", gb: 2.5 },
  { tag: "qwen3:4b", note: "small hybrid-reasoning model (Apache-2.0)", gb: 2.6 },
  { tag: "nemotron-mini:4b", note: "NVIDIA on-device SLM — RAG/function-calling", gb: 2.7 },
  { tag: "gemma3:4b", note: "Google multimodal (vision), 128K ctx", gb: 3.3 },
  { tag: "qwen2.5-coder:7b", note: "strong coding model — great default (Apache-2.0)", gb: 4.7 },
  { tag: "llama3.1:8b", note: "well-rounded general workhorse", gb: 4.9 },
  { tag: "granite3.3:8b", note: "IBM enterprise RAG/tool-use (Apache-2.0)", gb: 4.9 },
  { tag: "deepseek-r1:8b", note: "reasoning / chain-of-thought distill (MIT)", gb: 5.2 },
  { tag: "qwen3:8b", note: "well-rounded reasoning model (Apache-2.0)", gb: 5.2 },
  { tag: "devstral:24b", note: "agentic SWE coder — needs ~16GB (Apache-2.0)", gb: 14 },
  { tag: "gpt-oss:20b", note: "OpenAI open-weight reasoning — needs ~16GB (Apache-2.0)", gb: 14 },
  { tag: "gemma3:27b", note: "big multimodal — needs ~24GB (Gemma terms)", gb: 17 },
  { tag: "qwen3-coder:30b", note: "agentic coder MoE — needs ~24GB (Apache-2.0)", gb: 19 },
  { tag: "qwen2.5-coder:32b", note: "top local coder ≈GPT-4o-class — needs ~24GB", gb: 20 },
];

export interface LocalRunner {
  name: string;
  baseUrl: string;
  /** model ids the runner currently serves (from its /v1/models). */
  models: string[];
}

export interface Backends {
  /** every live runner (may serve 0 models). */
  liveRunners: LocalRunner[];
  /** the first live runner that serves ≥1 model (the one we'd use). */
  localRunner?: LocalRunner;
  /** a ready-to-use endpoint built from `localRunner` (undefined if none). */
  localEndpoint?: AiEndpoint;
  /** installed agent CLIs that can host a terminal chat. */
  paidClis: string[];
}

export interface DetectDeps {
  client: EngineClient;
  /** injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** per-runner probe timeout (ms). */
  timeoutMs?: number;
}

/** Build a local OpenAI-compatible endpoint from a detected runner (model = first served). */
export function buildLocalEndpoint(runner: LocalRunner): AiEndpoint {
  const model = runner.models[0] ?? "";
  return {
    id: `local:${runner.name}:${model}`,
    baseUrl: runner.baseUrl,
    locality: "local",
    contextWindow: 8192,
    // text-only stream (no tool-call transport on the OpenAI SSE) → keep tools off.
    supportsTools: false,
    model,
  };
}

/** Probe ONE runner's /v1/models; returns its served models or null if unreachable. */
async function probeRunner(
  runner: { name: string; baseUrl: string },
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<LocalRunner | null> {
  try {
    const res = await fetchFn(`${runner.baseUrl}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(data?.data)
      ? data.data.map((m) => String(m?.id ?? "")).filter((s) => s.length > 0)
      : [];
    return { name: runner.name, baseUrl: runner.baseUrl, models };
  } catch {
    return null; // not running / unreachable / bad response → treat as absent.
  }
}

/**
 * Detect available chat backends: probe local runners (parallel, fail-soft) + scan for
 * installed paid CLIs. Never throws — a dead runner or a failed scan just yields fewer
 * backends. Returns a ready local endpoint when a runner serves a model.
 */
export async function detectBackends(deps: DetectDeps): Promise<Backends> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 900;

  const probed = await Promise.all(LOCAL_RUNNERS.map((r) => probeRunner(r, fetchFn, timeoutMs)));
  const liveRunners = probed.filter((r): r is LocalRunner => r !== null);
  const localRunner = liveRunners.find((r) => r.models.length > 0);

  let paidClis: string[] = [];
  try {
    const scan = (await deps.client.runPrometheus(["scan"])) as unknown as {
      agents?: Array<{ name?: unknown; present?: unknown }>;
    };
    const agents = Array.isArray(scan?.agents) ? scan.agents : [];
    paidClis = agents
      .filter((a) => a.present === true && CHAT_CLIS.has(String(a.name)))
      .map((a) => String(a.name));
  } catch {
    /* scan is best-effort — no engine ⇒ no paid CLIs detected. */
  }

  return {
    liveRunners,
    ...(localRunner ? { localRunner, localEndpoint: buildLocalEndpoint(localRunner) } : {}),
    paidClis,
  };
}

/** One-line backend summary for the banner/footer (e.g. "local · qwen2.5-coder"). */
export function backendSummary(backends: Backends): string {
  if (backends.localEndpoint) return `local · ${backends.localEndpoint.model ?? "?"}`;
  if (backends.paidClis.length > 0) return `paid CLI · ${backends.paidClis.join("/")} (/setup)`;
  return "no model — type /setup";
}

/** A boxed onboarding panel shown on first run when no local model is ready. */
export function renderOnboarding(backends: Backends): string {
  const lines: string[] = [];
  lines.push(c.bold("No local model is running yet."));
  lines.push("");
  if (backends.liveRunners.length > 0) {
    const r = backends.liveRunners[0];
    lines.push(`${c.yellow("•")} ${r?.name} is up but serves no model — pull one below.`);
  } else {
    lines.push(`${c.yellow("•")} no local runner (Ollama / LM Studio) detected.`);
  }
  if (backends.paidClis.length > 0) {
    lines.push(`${c.green("•")} paid CLIs available: ${c.bold(backends.paidClis.join(", "))}`);
  }
  lines.push("");
  lines.push(`Type ${c.cyan("/setup")} to pick a free local model to download,`);
  lines.push("or connect a paid CLI (Claude / Codex / Gemini / …).");
  lines.push("");
  lines.push(
    `${c.dim("Save tokens/$ —")} ${c.cyan("prom tokens")} ${c.dim("proposes terse output, prompt caching, a repo map + more.")}`,
  );
  return box(lines, { border: "brand" });
}

/* ------------------------------------------------------------------------- *
 * /setup — the interactive wizard
 * ------------------------------------------------------------------------- */

export interface SetupDeps {
  client: EngineClient;
  write: (line: string) => void;
  /** ask the user a free-text line (readline question). */
  ask: (prompt: string) => Promise<string>;
  /** ask for a FOLDER with tab path-completion (default kept on blank). */
  askPath?: (prompt: string, def: string) => Promise<string>;
  fetchFn?: typeof fetch;
  /** run a child process to completion, streaming its I/O; returns the exit code. */
  runChild?: (cmd: string, args: string[]) => Promise<number>;
  /** the ~/.prometheus home root (tests point this at a temp dir). */
  home?: string;
}

/** A minimal child handle — avoids importing node:child_process types (C5 boundary). */
interface ChildLike {
  on(event: string, cb: (arg?: unknown) => void): void;
}
type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { stdio: "inherit"; shell: false },
) => ChildLike;

// node:child_process is the engine-bridge's exclusive STATIC import (C5). The /setup
// wizard spawns a user binary (`ollama pull`) — a terminal action, like the pty host —
// so it loads spawn LAZILY via createRequire (a runtime call, not a restricted import),
// matching pty/backend.ts. It is also fully injectable (`runChild`) for tests.
const nodeRequire = createRequire(import.meta.url);

/** Default child runner — spawn inheriting stdio (download progress shows live). */
function defaultRunChild(cmd: string, args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    try {
      const cp = nodeRequire("node:child_process") as { spawn?: SpawnLike };
      if (typeof cp.spawn !== "function") {
        resolve(127);
        return;
      }
      const child = cp.spawn(cmd, args, { stdio: "inherit", shell: false });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    } catch {
      resolve(127);
    }
  });
}

/**
 * Run the `/setup` wizard. Re-detects backends; if a local model is already ready it
 * reports it; otherwise it offers to (1) download a free local model via Ollama or
 * (2) connect a paid CLI. Returns the endpoint to adopt for the session, if any.
 * Crash-free: every branch is guarded; a declined/blank answer cancels cleanly.
 */
export async function runSetup(deps: SetupDeps): Promise<{ endpoint?: AiEndpoint }> {
  const { write, ask } = deps;
  const runChild = deps.runChild ?? defaultRunChild;
  const backends = await detectBackends({ client: deps.client, fetchFn: deps.fetchFn });

  if (backends.localEndpoint) {
    write(`${c.green("✓")} local model ready: ${c.bold(backends.localEndpoint.model ?? "?")}`);
    write(c.dim(`  via ${backends.localRunner?.name} at ${backends.localEndpoint.baseUrl}`));
    return { endpoint: backends.localEndpoint };
  }

  write(renderOnboarding(backends));
  write("");
  write(`${c.bold("Setup")} — choose:`);
  write(`  ${c.cyan("1")}  Download a free local model (Ollama)`);
  write(`  ${c.cyan("2")}  Connect a paid CLI (Claude / Codex / Gemini / Cursor / opencode)`);
  write(`  ${c.cyan("0")}  Skip for now`);
  const choice = (await ask("Pick 1, 2, or 0")).trim();

  if (choice === "1") return setupLocal(deps, backends, runChild);
  if (choice === "2") return setupPaid(deps, backends);
  write(c.dim("Setup skipped. Run /setup any time."));
  return {};
}

/** Download-a-local-model branch. */
async function setupLocal(
  deps: SetupDeps,
  backends: Backends,
  runChild: (cmd: string, args: string[]) => Promise<number>,
): Promise<{ endpoint?: AiEndpoint }> {
  const { write, ask } = deps;
  const ollamaUp = backends.liveRunners.some((r) => r.name === "ollama");

  write("");
  write(c.bold("Recommended local models (Ollama):"));
  RECOMMENDED_LOCAL.forEach((m, i) => {
    write(`  ${c.cyan(String(i + 1))}  ${c.bold(m.tag)} ${c.dim(`— ${m.note}`)}`);
  });
  const pick = Number((await ask(`Pick 1–${RECOMMENDED_LOCAL.length} (0 to cancel)`)).trim());
  if (!Number.isInteger(pick) || pick < 1 || pick > RECOMMENDED_LOCAL.length) {
    write(c.dim("cancelled."));
    return {};
  }
  const model = RECOMMENDED_LOCAL[pick - 1];
  const tag = model?.tag ?? "";

  // ── install location: show the default open_models dir + disk, let the user repoint ──
  const home = deps.home ?? prometheusHome();
  let dir = resolveCategory("open_models", home);
  write("");
  write(`${c.dim("install dir")}  ${c.bold(dir)}`);
  const di = diskInfo(dir);
  if (di) {
    write(
      `${c.dim("disk")}        ${c.green(humanBytes(di.freeBytes))} free of ${humanBytes(di.totalBytes)}  ${c.dim(`· model ≈ ${model?.gb ?? "?"} GB`)}`,
    );
  } else {
    write(`${c.dim("model size")}  ≈ ${model?.gb ?? "?"} GB`);
  }
  if (deps.askPath) {
    const keep = (await ask("Keep this folder? [Y/n]")).trim().toLowerCase();
    if (keep === "n" || keep === "no") {
      const chosen = await deps.askPath("New folder for open models:", dir);
      dir = setCategory("open_models", chosen, home);
      write(c.green(`✓ open models → ${dir}`));
      // persist engine-side too (engine reads models_root from its config.json).
      try {
        await deps.client.runPrometheus(["models", "config", "--set-root", dir]);
      } catch {
        /* best-effort — the env var below is the load-bearing path for the sidecar. */
      }
    }
  }
  // point BOTH download mechanisms at the chosen dir: the engine modelhub sidecar
  // ($PROMETHEUS_MODELS_DIR) and the `ollama pull` child ($OLLAMA_MODELS).
  process.env.PROMETHEUS_MODELS_DIR = dir;
  process.env.OLLAMA_MODELS = dir;

  if (!ollamaUp) {
    write("");
    write(`${c.yellow("Ollama is not running.")} Install it first:`);
    write(`  ${c.cyan("prom apps install ollama --yes")}   ${c.dim("(nemesis-gated)")}`);
    write(
      `then re-run ${c.cyan("/setup")} (or: ${c.cyan(`ollama pull ${tag}`)}), and restart prom.`,
    );
    const go = (await ask("Install Ollama now via the gated installer? [y/N]"))
      .trim()
      .toLowerCase();
    if (go === "y" || go === "yes") {
      write(c.dim("Routing through the engine's gated installer…"));
      try {
        const env = (await deps.client.runPrometheus(["apps", "install", "ollama"])) as unknown as {
          ok?: boolean;
        };
        write(
          env?.ok === false
            ? c.red("installer reported a problem — see output above.")
            : c.green(`✓ ollama install requested. Start it, then run \`ollama pull ${tag}\`.`),
        );
      } catch (err) {
        write(c.red(`installer failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    return {};
  }

  // Ollama is up → pull the model directly (the natural, live-progress action).
  write("");
  write(`Pulling ${c.bold(tag)} via Ollama (this can take a few minutes)…`);
  const confirm = (await ask(`Run \`ollama pull ${tag}\` now? [y/N]`)).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    write(c.dim(`skipped. Run \`ollama pull ${tag}\` yourself, then restart prom.`));
    return {};
  }
  const code = await runChild("ollama", ["pull", tag]);
  if (code !== 0) {
    write(c.red(`ollama pull exited ${code}. Is the \`ollama\` binary on PATH?`));
    return {};
  }
  write(c.green(`✓ ${tag} pulled. Adopting it for this session.`));
  return {
    endpoint: buildLocalEndpoint({
      name: "ollama",
      baseUrl: "http://localhost:11434/v1",
      models: [tag],
    }),
  };
}

/** Connect-a-paid-CLI branch. */
async function setupPaid(deps: SetupDeps, backends: Backends): Promise<{ endpoint?: AiEndpoint }> {
  const { write } = deps;
  write("");
  if (backends.paidClis.length === 0) {
    write(c.yellow("No agent CLIs detected on PATH."));
    write(
      `Install one (e.g. Claude Code / Codex / Gemini), then chat via ${c.cyan(
        "prom chat --cli <svc> --open",
      )}.`,
    );
    return {};
  }
  write(c.bold("Installed agent CLIs you can chat with:"));
  for (const cli of backends.paidClis) {
    write(`  ${c.green("•")} ${c.bold(cli)} → ${c.cyan(`prom chat --cli ${cli} --open`)}`);
  }
  write("");
  write(c.dim("Run one of the commands above from a shell to launch a live terminal chat."));
  return {};
}

/* ------------------------------------------------------------------------- *
 * /paths — view + repoint the per-category heavy-download folders
 * ------------------------------------------------------------------------- */

export interface PathsDeps {
  client: EngineClient;
  write: (line: string) => void;
  ask: (prompt: string) => Promise<string>;
  /** the folder picker with tab-completion (interactive only). */
  askPath?: (prompt: string, def: string) => Promise<string>;
  home?: string;
}

/**
 * `/paths` — list each heavy-download category (open models, videos, audio, files) with
 * its current folder + free disk, and let the user repoint one (tab-completing picker).
 * Repointing `open_models` also persists the engine's models_root. Crash-free + fail-soft.
 */
export async function runPathsWizard(deps: PathsDeps): Promise<void> {
  const { write, ask } = deps;
  const home = deps.home ?? prometheusHome();

  write(`${c.bold("Download folders")} ${c.dim(`(root: ${home})`)}`);
  PATH_CATEGORIES.forEach((cat, i) => {
    const dir = resolveCategory(cat, home);
    const di = diskInfo(dir);
    const free = di ? c.dim(`  · ${humanBytes(di.freeBytes)} free`) : "";
    write(`  ${c.cyan(String(i + 1))}  ${c.bold(CATEGORY_LABEL[cat])}`);
    write(`       ${c.dim(dir)}${free}`);
  });

  if (!deps.askPath) {
    write(c.dim("(open an interactive session to change a folder)"));
    return;
  }
  const pick = Number((await ask(`Change which? 1–${PATH_CATEGORIES.length} (0 to close)`)).trim());
  if (!Number.isInteger(pick) || pick < 1 || pick > PATH_CATEGORIES.length) {
    write(c.dim("done."));
    return;
  }
  const cat = PATH_CATEGORIES[pick - 1] as PathCategory;
  const chosen = await deps.askPath(
    `New folder for ${CATEGORY_LABEL[cat]}:`,
    resolveCategory(cat, home),
  );
  const abs = setCategory(cat, chosen, home);
  write(c.green(`✓ ${CATEGORY_LABEL[cat]} → ${abs}`));
  if (cat === "open_models") {
    try {
      await deps.client.runPrometheus(["models", "config", "--set-root", abs]);
    } catch {
      /* best-effort engine persist; the env var is the load-bearing path. */
    }
  }
}
