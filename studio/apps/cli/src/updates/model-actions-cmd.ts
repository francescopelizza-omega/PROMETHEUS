// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { existsSync, readdirSync } from "node:fs";
/**
 * updates/model-actions-cmd.ts — `/updates pull|rm`: the two actions that change the machine.
 *
 * ── WHY THESE LIVE ON `/updates` AND NOT ON A `/models` COMMAND ─────────────────────────────
 *
 * `models` is a real engine verb (`prometheus models`), and `slash-registry.ts:1886` records the
 * rule that came from it: "two commands answering to one word is how a user runs the wrong one."
 * `/model` is already taken too — it is an alias of `/worker` and means "switch the active
 * model", which is a different job from "download a newer build of one".
 *
 * `/updates` already owns the question these answer. It lists what is stale and the exact command
 * for each; these make the two model commands runnable in place.
 *
 * ── WHAT IS DIFFERENT ABOUT ACTUALLY RUNNING SOMETHING ──────────────────────────────────────
 *
 * Everything else in `updates/` proposes. These two act, so each carries three gates the report
 * does not need:
 *
 *  1. **The authorisation ladder.** A pull is an INSTALL (network + tens of GB written); a
 *     removal is DESTRUCTIVE. Refused BEFORE the user is asked anything, so a low-authorisation
 *     session cannot be talked into a confirmation it was never allowed to reach.
 *  2. **An explicit confirmation**, with the real numbers in it. For the removal it is a TYPED
 *     confirmation — the user retypes the tag — because "y" is muscle memory and this is not
 *     reversible.
 *  3. **A recomputation at the moment of acting.** The report may be up to six hours old; disk,
 *     residency and the upstream digest can all have moved since.
 *
 * Nothing is ever run from the startup notice or from the report itself. `AUTO_INSTALL=false`
 * is about Prometheus never swapping its OWN binary, but the ethos behind it — no change to the
 * user's machine that the user did not ask for, in that moment — applies here too.
 */
import { updates as u } from "@prometheus/core";

import type { RepoFormats } from "@prometheus/core/updates-live";
import {
  detectRepoFormats,
  fetchOllamaVersion,
  loadedModels,
  pullModel,
  readAllLocalManifests,
  readLocalManifest,
  removeModel,
  which,
} from "@prometheus/core/updates-live";

import { c } from "../render.js";

export interface ModelActionDeps {
  write: (line: string) => void;
  /** yes/no. The removal path uses `ask` instead — see `runRemove`. */
  confirm: (prompt: string) => Promise<boolean>;
  ask: (prompt: string) => Promise<string>;
  /** the session's 0–7 authorisation level. */
  getAuthLevel: () => number;
  /** test seams. */
  pull?: typeof pullModel;
  remove?: typeof removeModel;
  loaded?: typeof loadedModels;
  localManifest?: typeof readLocalManifest;
  allManifests?: typeof readAllLocalManifests;
  now?: () => number;
}

/** Human bytes, one decimal, so a 22.6 GB download does not read as "23 GB". */
export function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * Refuse below a rung, and say what the rung is FOR rather than quoting a number at the user.
 *
 * Returns "" when allowed. The refusal names the level so it is actionable — a message that says
 * only "not permitted" leaves the user with no next step.
 */
export function authRefusal(level: number, need: number, what: string): string {
  if (level >= need) return "";
  return `${what} needs authorisation A${need}; this session is at A${level}. Raise it with /authorisation ${need} if you want to.`;
}

/* ─────────────────────────────── pull ─────────────────────────────── */

/** `/updates pull <tag>` — download the build a tag now points at, with live progress. */
export async function runPull(tag: string, deps: ModelActionDeps): Promise<boolean> {
  const write = deps.write;
  if (tag.trim() === "") {
    write(c.red("usage: /updates pull <model:tag>"));
    return false;
  }
  // The gate comes BEFORE the question. Asking first and refusing after teaches a user that the
  // confirmation is theatre.
  const refusal = authRefusal(deps.getAuthLevel(), u.AUTH_INSTALL, "Downloading a model");
  if (refusal) {
    write(c.red(refusal));
    return false;
  }

  /**
   * Say what is about to happen, including the part that surprises people: pulling a tag you
   * already have is NOT a no-op. ollama re-resolves the manifest and, if the tag has moved,
   * downloads the new layers — so an "I already have this" pull can still spend 22 GB.
   */
  write(c.dim(`Pulling ${tag} from the ollama registry. This re-resolves the tag, so it may`));
  write(c.dim("download a new build even if the model is already installed."));
  if (!(await deps.confirm(`Download ${tag} now? [y/N]`))) {
    write(c.dim("(cancelled)"));
    return false;
  }

  const tracker = new u.PullProgressTracker();
  let lastLine = "";
  let lastAt = 0;
  const now = deps.now ?? (() => Date.now());
  const pull = deps.pull ?? pullModel;

  const res = await pull(tag, {
    onEvent: (e) => {
      tracker.apply(e);
      /**
       * Throttled to ~4 Hz and deduplicated.
       *
       * ollama emits a progress line per layer per tick; forwarding every one floods a readline
       * host with thousands of lines and makes the TUI repaint continuously for the length of a
       * 22 GB download.
       */
      const t = now();
      if (t - lastAt < 250) return;
      const s = tracker.snapshot();
      const pct = s.fraction !== undefined ? ` ${Math.round(s.fraction * 100)}%` : "";
      const of = s.total !== undefined ? ` of ${gb(s.total)}` : "";
      const line = `  ${s.phase}${pct}${s.completed > 0 ? `  (${gb(s.completed)}${of})` : ""}`;
      if (line === lastLine) return;
      lastLine = line;
      lastAt = t;
      write(c.dim(line));
    },
  });

  if (res.aborted) {
    // A cancelled pull resumes from its partial file, so this is not a failure to apologise for.
    write(c.dim("(cancelled — a later pull resumes where this one stopped)"));
    return false;
  }
  if (!res.ok) {
    write(c.red(`pull failed: ${res.error}`));
    return false;
  }
  write(c.green(`✓ ${tag} pulled.`));
  write(c.dim("  /model to make it the active one."));
  return true;
}

/* ─────────────────────────────── remove ─────────────────────────────── */

/**
 * `/updates rm <tag>` — delete a model from disk, once the saving has been proven real.
 *
 * The whole point of the ceremony here is that the obvious version of this feature lies. "Free
 * up space by deleting the old model" is, for a same-tag update, a no-op dressed as a saving:
 * ollama already released those layers during the pull. And for a cross-tag removal the victim's
 * own size is the wrong number, because two tags of a family share layers.
 */
export async function runRemove(tag: string, deps: ModelActionDeps): Promise<boolean> {
  const write = deps.write;
  if (tag.trim() === "") {
    write(c.red("usage: /updates rm <model:tag>"));
    return false;
  }
  const refusal = authRefusal(deps.getAuthLevel(), u.AUTH_DESTRUCTIVE, "Deleting a model");
  if (refusal) {
    write(c.red(refusal));
    return false;
  }

  const readOne = deps.localManifest ?? readLocalManifest;
  const readAll = deps.allManifests ?? readAllLocalManifests;
  const loadedFn = deps.loaded ?? loadedModels;

  const victimLayers = readOne(tag);
  if (!victimLayers) {
    write(c.red(`${tag} is not installed, or its manifest could not be read.`));
    return false;
  }
  /**
   * Recomputed NOW, not taken from the report. Residency especially: the report may be six hours
   * old and the model may have been loaded a minute ago.
   */
  const loaded = await loadedFn();
  const survivors = readAll()
    .filter((m) => m.tag !== tag)
    .map((m) => m.layers);

  const action = u.removalAction({ victim: tag, victimLayers, survivorLayers: survivors, loaded });
  if (action.blocked) {
    // A refusal that explains itself. "Frees nothing" and "is loaded" are different problems and
    // the user can act on the second one.
    write(c.yellow(`Not removing ${tag}: ${action.blocked}`));
    return false;
  }

  write(c.bold(`Remove ${tag}`));
  write(`  frees ${gb(action.freesBytes ?? 0)} — layers no other installed model references.`);
  if (survivors.length > 0) {
    write(c.dim(`  ${survivors.length} other model(s) stay installed; shared layers are kept.`));
  }
  write(c.red("  This cannot be undone. Re-downloading means fetching it again."));

  /**
   * A TYPED confirmation, not a y/N.
   *
   * `y` is muscle memory, and this is the one irreversible thing in the whole feature. The same
   * pattern is already used for branch removal (slash-registry.ts:1010), for the same reason.
   */
  const typed = (await deps.ask(`type "${tag}" to confirm removal: `)).trim();
  if (typed !== tag) {
    write(c.dim("(cancelled)"));
    return false;
  }

  const res = await (deps.remove ?? removeModel)(tag);
  if (!res.ok) {
    write(c.red(`remove failed: ${res.error}`));
    return false;
  }
  write(c.green(`✓ ${tag} removed — ${gb(action.freesBytes ?? 0)} freed.`));
  return true;
}

/* ─────────────────────────────── dispatch ─────────────────────────────── */

/** The subcommands `/updates` accepts. `""` means "print the report", the existing behaviour. */
export type UpdatesSubcommand =
  | { kind: "report" }
  | { kind: "pull"; tag: string }
  | { kind: "remove"; tag: string }
  | { kind: "catalog"; query: string }
  | { kind: "convert"; rest: string }
  /** `/updates fix [subject]` — the repair for an install conflict. */
  | { kind: "fix"; subject: string }
  | { kind: "usage"; message: string };

/**
 * Parse `/updates <rest>`.
 *
 * Unknown words are NOT silently treated as the report: `/updates pul qwen` is a typo the user
 * should hear about, and running the full sweep instead would look like it worked.
 */
export function parseSubcommand(rest: string): UpdatesSubcommand {
  const trimmed = rest.trim();
  if (trimmed === "") return { kind: "report" };
  const [verb = "", ...restArgs] = trimmed.split(/\s+/);
  const tag = restArgs.join(" ").trim();
  const v = verb.toLowerCase();
  if (v === "pull") return { kind: "pull", tag };
  if (v === "rm" || v === "remove") return { kind: "remove", tag };
  if (v === "catalog" || v === "browse" || v === "search") return { kind: "catalog", query: tag };
  if (v === "convert") return { kind: "convert", rest: tag };
  if (v === "fix" || v === "repair") return { kind: "fix", subject: tag };
  // `--json` and friends belong to the report and must keep working.
  if (v.startsWith("-")) return { kind: "report" };
  return {
    kind: "usage",
    message: `unknown: /updates ${verb}\n  /updates                 the full report\n  /updates fix [tool]      how to clear an install conflict for good\n  /updates catalog [q]     browse installable models\n  /updates pull <tag>      download a model (A${u.AUTH_INSTALL})\n  /updates rm <tag>        delete a model (A${u.AUTH_DESTRUCTIVE})\n  /updates convert <ref>   how to get a model into an engine that runs it`,
  };
}

/* ─────────────────────────────── browse ─────────────────────────────── */

/** One catalogue row, prepared for display by either host. */
export interface BrowseRow {
  entry: u.CatalogEntry;
  /** the one-line summary the list shows. */
  line: string;
  /** the detail lines shown for the highlighted row (TUI) or under it (readline). */
  body: string[];
  /** set when the model cannot run here — the row is shown but not offered. */
  blocked?: string;
  /** the command that installs it, or null when there is no automatic route. */
  command: string | null;
}

/**
 * Turn catalogue entries into display rows, with the fit verdict attached.
 *
 * The verdict is computed HERE rather than in the renderer so both hosts and the GUI agree about
 * which models this machine can run — and so a model that cannot run is still SHOWN. Hiding it
 * invites "why isn't X in the list?"; showing it with the reason answers the question before it
 * is asked.
 */
export function browseRows(
  entries: readonly u.CatalogEntry[],
  budget: u.FitBudget,
  installed: readonly string[] = [],
): BrowseRow[] {
  return entries.map((entry) => {
    const fit = u.fitOf(entry, budget);
    const command = u.installCommand(entry);
    const here = entry.installed || installed.includes(entry.name);
    const size = entry.sizeBytes !== undefined ? gb(entry.sizeBytes) : "size unknown";
    const mark = here ? "installed" : fit.verdict === "too-big" ? "too big" : fit.verdict;
    const body: string[] = [
      [
        size,
        entry.parameters ?? "",
        entry.contextTokens ? `${Math.round(entry.contextTokens / 1024)}K ctx` : "",
        entry.license ?? "licence unknown",
      ]
        .filter((s) => s !== "")
        .join(" · "),
    ];
    if (entry.summary) body.push(entry.summary);
    if (fit.verdict === "tight") {
      body.push(`fits, but only ${gb(fit.spareBytes)} to spare once loaded`);
    }
    if (fit.verdict === "unknown") {
      // Said out loud: the source published no size, so no promise is being made either way.
      body.push("this source publishes no size, so whether it fits here is unknown");
    }
    if (command) body.push(command);

    return {
      entry,
      line: `${size.padStart(11)}  ${mark.padEnd(9)}  ${entry.name}`,
      body,
      ...(fit.verdict === "too-big"
        ? {
            blocked: `needs ${gb(fit.needBytes)}; this machine can offer ${gb(fit.needBytes - fit.shortBytes)}`,
          }
        : {}),
      command,
    };
  });
}

/**
 * `/updates catalog [query]` — browse installable models, printed.
 *
 * The printed form works on every surface; the TUI additionally opens an arrow-nav overlay over
 * the same rows (see `app.ts`). Both end at the same place: a `/updates pull <tag>` line, which
 * is the phase-4 command with its own confirmation and authorisation gate. Nothing here installs
 * anything.
 */
export async function runCatalog(
  query: string,
  deps: ModelActionDeps & {
    search: (q: string) => Promise<{ entries: u.CatalogEntry[]; error: string }>;
    budget: u.FitBudget;
    installed?: readonly string[];
  },
): Promise<BrowseRow[]> {
  const { write } = deps;
  write(
    c.dim(
      `Searching HuggingFace for installable GGUF models${query ? ` matching "${query}"` : ""}…`,
    ),
  );
  const res = await deps.search(query);
  if (res.error) {
    // An error is never rendered as an empty catalogue — "nothing matched" and "the source was
    // unreachable" are different answers and only one is the user's query's fault.
    write(c.red(`catalogue unavailable: ${res.error}`));
    return [];
  }
  const rows = browseRows(
    u.sortCatalog(res.entries, "relevance", deps.budget),
    deps.budget,
    deps.installed ?? [],
  );
  if (rows.length === 0) {
    write(c.yellow(query ? `nothing matched "${query}".` : "the catalogue returned nothing."));
    return rows;
  }
  write(c.bold(`${rows.length} models · sorted by what this machine can run`));
  for (const r of rows) {
    write(r.blocked ? c.dim(r.line) : r.line);
    write(c.dim(`      ${r.body[0] ?? ""}`));
    if (r.blocked) write(c.yellow(`      ${r.blocked}`));
    else if (r.command) write(c.cyan(`      /updates pull ${installTag(r.entry)}`));
  }
  write(c.dim("Pick one with:  /updates pull <tag>"));
  return rows;
}

/**
 * The tag `/updates pull` should be given for a catalogue row.
 *
 * `hf.co/<repo>` is ollama's own officially supported form for a HuggingFace GGUF repo, so the
 * browser hands the pull command a tag the daemon already understands — no conversion, no
 * scraping, and the same code path as pulling any other model.
 */
export function installTag(entry: u.CatalogEntry): string {
  switch (entry.route.kind) {
    case "ollama-tag":
      return entry.route.tag;
    case "ollama-hf":
      return `hf.co/${entry.route.repo}${entry.route.quant ? `:${entry.route.quant}` : ""}`;
    default:
      return entry.name;
  }
}

/* ─────────────────────────────── convert ─────────────────────────────── */

/**
 * Classify a local path by what is actually in it.
 *
 * A `.gguf` file is unambiguous. A DIRECTORY is the interesting case: HuggingFace checkouts hold
 * `.safetensors`, and an MLX export holds its own layout — reading the directory beats trusting
 * the name, because a folder called `my-model-gguf` full of safetensors is a real thing.
 */
export function classifyLocalPath(
  path: string,
  deps: { exists?: (p: string) => boolean; readDir?: (p: string) => string[] } = {},
): u.ModelFormat {
  const exists = deps.exists ?? existsSync;
  const readDir = deps.readDir ?? ((p: string) => readdirSync(p));
  if (!exists(path)) return "unknown";
  if (path.toLowerCase().endsWith(".gguf")) return "gguf";
  let entries: string[];
  try {
    entries = readDir(path);
  } catch {
    return "unknown";
  }
  const lower = entries.map((e) => e.toLowerCase());
  if (lower.some((e) => e.endsWith(".gguf"))) return "gguf";
  if (lower.some((e) => e.endsWith(".safetensors"))) return "safetensors";
  // MLX exports carry a `config.json` beside `.npz`/`.safetensors` shards plus a tokenizer; the
  // reliable marker without opening files is the weights index MLX writes.
  if (lower.includes("model.safetensors.index.json") || lower.includes("weights.npz")) return "mlx";
  return "unknown";
}

/**
 * `/updates convert <repo-or-path> [quant]` — how to get a model into an engine that runs it.
 *
 * Prints a plan or a refusal. NOTHING is executed: a conversion is an hour of someone's machine
 * and several GB of Python, and the commands are theirs to run when they have read what they
 * cost. That also keeps this out of the authorisation ladder entirely — it writes nothing.
 */
export async function runConvert(
  rest: string,
  deps: ModelActionDeps & {
    detectFormats?: (repo: string) => Promise<RepoFormats>;
    ollamaVersion?: () => Promise<string | undefined>;
    has?: (bin: string) => boolean;
    platform?: NodeJS.Platform;
    arch?: string;
  },
): Promise<u.ConversionPlan | null> {
  const { write } = deps;
  const [target = "", quant] = rest.trim().split(/\s+/);
  if (target === "") {
    write(c.red("usage: /updates convert <hf-repo|path> [quantisation]"));
    write(c.dim("  e.g.  /updates convert bartowski/Qwen2.5-Coder-7B-Instruct-GGUF Q4_K_M"));
    return null;
  }

  /**
   * The environment is read ONCE and handed to the planner, which is pure. That split is what
   * makes "would this work on a Linux box without llama.cpp?" a unit test rather than a guess.
   */
  const has = deps.has ?? ((bin: string) => which(bin));
  const env: u.ConversionEnv = {
    /**
     * Every binary any branch of the planner can ask about. A prerequisite the planner names but
     * the probe never looked for reports as MISSING — so an already-installed tool would be
     * listed as a blocker, which is how a user is sent to reinstall something they have.
     */
    has: {
      "convert_hf_to_gguf.py": has("convert_hf_to_gguf.py"),
      "llama-quantize": has("llama-quantize"),
      lms: has("lms"),
      hf: has("hf"),
    },
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    ...(await (deps.ollamaVersion ?? fetchOllamaVersion)().then((v) =>
      v ? { ollamaVersion: v } : {},
    )),
  };

  const isPath = target.startsWith(".") || target.startsWith("/") || target.startsWith("~");
  let req: u.ConversionRequest;
  if (isPath) {
    req = {
      from: classifyLocalPath(target),
      to: "ollama",
      path: target,
      ...(quant ? { quant } : {}),
    };
  } else {
    write(c.dim(`Looking at ${target} on HuggingFace…`));
    const formats = await (deps.detectFormats ?? detectRepoFormats)(target);
    if (formats.error) {
      // Unreachable is not "contains nothing"; proposing a conversion off a failed lookup would
      // send someone down the expensive path for a repo that may need none.
      write(c.red(`could not inspect ${target}: ${formats.error}`));
      return null;
    }
    const from: u.ModelFormat = formats.mlx
      ? "mlx"
      : formats.gguf
        ? "gguf"
        : formats.safetensors
          ? "safetensors"
          : "unknown";
    req = {
      from,
      to: "ollama",
      repo: target,
      ggufPublished: formats.gguf,
      ...(quant ? { quant } : {}),
    };
  }

  const plan = u.planConversion(req, env);
  renderPlan(plan, deps.write);
  return plan;
}

/** Print a plan the way a person reads it: what it costs, then what to run. */
function renderPlan(plan: u.ConversionPlan, write: (line: string) => void): void {
  if (plan.kind === "refused") {
    write(c.yellow(`Not possible: ${plan.why}`));
    if (plan.alternative) write(c.dim(`  ${plan.alternative}`));
    return;
  }
  if (plan.kind === "direct") {
    write(c.green(`No conversion needed — ${plan.why}`));
    for (const s of plan.steps) {
      write(c.cyan(`  ${s.command}`));
      write(c.dim(`      ${s.what}`));
    }
    return;
  }

  const missing = u.missingPrerequisites(plan);
  if (plan.warning) {
    write(c.yellow(`⚠ ${plan.warning}`));
  }
  if (missing.length > 0) {
    // The blockers come FIRST and together. Interleaving them with the steps invites someone to
    // start at step one and discover the prerequisite three commands in.
    write(c.bold(`First, ${missing.length} prerequisite${missing.length > 1 ? "s" : ""}:`));
    for (const p of missing) {
      write(`  • ${p.id} — ${p.why}`);
      write(c.cyan(`      ${p.install}`));
      if (p.note) write(c.yellow(`      ${p.note}`));
    }
  }
  write(c.bold(missing.length > 0 ? "Then:" : "Steps:"));
  for (const s of plan.steps) {
    write(c.cyan(`  ${s.command}`));
    write(c.dim(`      ${s.what}`));
  }
  write(c.dim("Prometheus prints these; it does not run them."));
}
