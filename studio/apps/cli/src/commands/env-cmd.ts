/**
 * commands/env-cmd.ts — the FULL `prometheus env …` surface over the envmgr.py sidecar
 * (C7), at parity with the GUI Environments panel (file 04). Reads run straight;
 * mutations PREVIEW first and EXECUTE on `--yes` (sidecar runs the REAL nemesis
 * gate on the gated verbs — clone/import/pkg-install/cuda-torch — C5).
 *
 *   env list                      every env (venv/conda/system)            [read]
 *   env info   <env>              packages installed in an env             [read]
 *   env doctor <env>             interpreter/pip/CUDA health               [read]
 *   env use    <env>             resolve activation (interpreter + vars)   [read]
 *   env export <env> [--to F]    requirements.txt / conda yaml             [read]
 *   env create <name> [--python V] [--conda]                              [mutate]
 *   env clone  <from> <to>                                          [mutate/gated]
 *   env delete <env>                                                      [mutate]
 *   env import --file F --name N [--python V]                      [mutate/gated]
 *   env add    <env> <spec...>   pip install (gated)                [mutate/gated]
 *   env remove <env> <pkg...> [--keep-pin]   uninstall / disable-keep      [mutate]
 *   env update <env> <spec...>   pip update (gated)                 [mutate/gated]
 *   env upgrade <env> [pkg...]   bulk upgrade (gated)               [mutate/gated]
 *   env enable  <env> <pkg>      re-arm a disabled package                 [mutate]
 *   env disable <env> <pkg>      reversible package disable                [mutate]
 *   env cuda [info|torch <env>|install]   GPU/CUDA info + gated torch wheel
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, kv, table } from "../render.js";
import { runEnv } from "./env.js";
import {
  type SidecarDeps,
  defaultSidecarDeps,
  execArgv,
  flagSet,
  flagStr,
  forceBlocked,
  renderMutation,
  runMutation,
  runRead,
  usageError,
  wantsExecute,
} from "./sidecar-cmd.js";
import { flaggedSpecs } from "./squat-guard.js";

const SCRIPT = "envmgr.py" as const;

/** Resolve the env subverb (["env","create"] → "create"); bare `env` → "list". */
function sub(ctx: CliContext): string {
  return ctx.args.command[1] ?? "list";
}

/** `--conda`/`--kind conda` → conda; default venv. */
function createArgv(name: string, ctx: CliContext): string[] {
  const argv = ["env.create", name];
  const kind = flagStr(ctx, "kind");
  if (flagSet(ctx, "conda") || kind === "conda") argv.push("--conda");
  const python = flagStr(ctx, "python");
  if (python) argv.push("--python", python);
  return argv;
}

export async function runEnvCommand(
  ctx: CliContext,
  deps: SidecarDeps = defaultSidecarDeps,
): Promise<CommandOutcome> {
  const verb = sub(ctx);
  const pos = ctx.args.positionals;

  switch (verb) {
    case "list":
      // the rich env-list renderer already lives in env.ts (read-only).
      return runEnv(ctx);

    case "info": {
      const env = pos[0];
      if (!env) return usageError("env info", "<env>");
      return runRead(ctx, {
        command: "env info",
        script: SCRIPT,
        argv: ["pkg.list", env],
        deps,
        render: (e) => renderPackages(env, e),
      });
    }

    case "doctor": {
      const env = pos[0];
      if (!env) return usageError("env doctor", "<env>");
      return runRead(ctx, {
        command: "env doctor",
        script: SCRIPT,
        argv: ["env.doctor", env],
        deps,
        render: (e) => renderDoctor(env, e),
      });
    }

    case "use": {
      const env = pos[0];
      if (!env) return usageError("env use", "<env>");
      return runRead(ctx, {
        command: "env use",
        script: SCRIPT,
        argv: ["env.use", env],
        deps,
        render: (e) => ({
          text: `${c.green("✓")} active env → ${c.bold(env)}${
            typeof e.python === "string" ? `\n  ${kv("python", c.dim(e.python))}` : ""
          }`,
          exitCode: 0,
        }),
      });
    }

    case "export": {
      const env = pos[0];
      if (!env) return usageError("env export", "<env>");
      const argv = ["env.export", env];
      const to = flagStr(ctx, "to");
      if (to) argv.push("--to", to);
      return runRead(ctx, {
        command: "env export",
        script: SCRIPT,
        argv,
        deps,
        render: (e) => renderExport(env, e),
      });
    }

    case "create": {
      const name = pos[0];
      if (!name) return usageError("env create", "<name> [--python V] [--conda] [--template <id>]");
      const template = flagStr(ctx, "template");
      if (template) return runCreateWithTemplate(ctx, name, template, deps);
      return runMutation(ctx, {
        command: "env create",
        script: SCRIPT,
        base: createArgv(name, ctx),
        note: `create ${flagSet(ctx, "conda") ? "conda" : "venv"} env '${name}'`,
        deps,
      });
    }

    case "templates": {
      return runRead(ctx, {
        command: "env templates",
        script: SCRIPT,
        argv: ["template.list"],
        deps,
        render: (e) => renderTemplates(e),
      });
    }

    case "template": {
      // `env template <id> --env <env>` — batched GATED install of a template's
      // package set into an existing env (the GUI "apply template" action).
      const id = pos[0];
      const env = flagStr(ctx, "env");
      if (!id || !env) return usageError("env template", "<id> --env <env>");
      return runMutation(ctx, {
        command: "env template",
        script: SCRIPT,
        base: ["template.commit", "--template", id, "--env", env],
        note: `apply template '${id}' into env '${env}' (batched nemesis-gated install)`,
        deps,
      });
    }

    case "clone": {
      const [from, to] = pos;
      if (!from || !to) return usageError("env clone", "<from> <to>");
      return runMutation(ctx, {
        command: "env clone",
        script: SCRIPT,
        base: ["env.clone", from, to],
        note: `freeze '${from}' → gated reinstall into '${to}'`,
        deps,
      });
    }

    case "delete": {
      const env = pos[0];
      if (!env) return usageError("env delete", "<env>");
      return runMutation(ctx, {
        command: "env delete",
        script: SCRIPT,
        base: ["env.delete", env],
        note: `delete env '${env}'`,
        deps,
      });
    }

    case "import": {
      const file = flagStr(ctx, "file");
      const name = flagStr(ctx, "name");
      if (!file || !name) return usageError("env import", "--file <req.txt> --name <env>");
      const base = ["env.import", "--file", file, "--name", name];
      const python = flagStr(ctx, "python");
      if (python) base.push("--python", python);
      return runMutation(ctx, {
        command: "env import",
        script: SCRIPT,
        base,
        note: `create env '${name}' from ${file} (gated reinstall)`,
        deps,
      });
    }

    case "add": {
      const [env, ...specs] = pos;
      if (!env || specs.length === 0) return usageError("env add", "<env> <spec...>");
      // pre-install typosquat / slopsquat heuristic (advisory — the engine still gates).
      const flagged = flaggedSpecs(specs);
      const warnTag = flagged.length ? ` — ${c.yellow(`⚠ ${flagged.length} name warning(s)`)}` : "";
      const note = `pip install ${specs.join(" ")} → '${env}' (gated)${warnTag}`;
      const out = await runMutation(ctx, {
        command: "env add",
        script: SCRIPT,
        base: ["pkg.install", env, ...specs],
        note,
        deps,
      });
      if (flagged.length === 0) return out;
      const banner = flagged
        .map((f) => `⚠ ${f.name}: ${f.reason}${f.nearest ? ` (did you mean '${f.nearest}'?)` : ""}`)
        .join("\n");
      if (ctx.json && out.json && typeof out.json === "object") {
        return { ...out, json: { ...(out.json ?? { ok: true }), squat_warnings: flagged } };
      }
      return { ...out, text: `${c.yellow(banner)}\n${out.text ?? ""}`.trimEnd() };
    }

    case "remove": {
      const [env, ...pkgs] = pos;
      if (!env || pkgs.length === 0) return usageError("env remove", "<env> <pkg...> [--keep-pin]");
      const keepPin = flagSet(ctx, "keep-pin");
      return runMutation(ctx, {
        command: "env remove",
        script: SCRIPT,
        base: [keepPin ? "pkg.remove" : "pkg.uninstall", env, ...pkgs],
        note: `${keepPin ? "remove (keep pin)" : "uninstall"} ${pkgs.join(" ")} from '${env}'`,
        deps,
      });
    }

    case "update": {
      const [env, ...specs] = pos;
      if (!env || specs.length === 0) return usageError("env update", "<env> <spec...>");
      return runMutation(ctx, {
        command: "env update",
        script: SCRIPT,
        base: ["pkg.update", env, ...specs],
        note: `pip update ${specs.join(" ")} in '${env}' (gated)`,
        deps,
      });
    }

    case "upgrade": {
      const [env, ...pkgs] = pos;
      if (!env) return usageError("env upgrade", "<env> [pkg...]");
      return runMutation(ctx, {
        command: "env upgrade",
        script: SCRIPT,
        base: ["pkg.upgrade", env, ...pkgs],
        note: pkgs.length
          ? `upgrade ${pkgs.join(" ")} in '${env}'`
          : `upgrade ALL outdated in '${env}'`,
        deps,
      });
    }

    case "enable": {
      const [env, pkg] = pos;
      if (!env || !pkg) return usageError("env enable", "<env> <pkg>");
      return runMutation(ctx, {
        command: "env enable",
        script: SCRIPT,
        base: ["pkg.enable", env, pkg],
        note: `re-arm '${pkg}' in '${env}'`,
        deps,
      });
    }

    case "disable": {
      const [env, pkg] = pos;
      if (!env || !pkg) return usageError("env disable", "<env> <pkg>");
      return runMutation(ctx, {
        command: "env disable",
        script: SCRIPT,
        base: ["pkg.disable", env, pkg],
        note: `disable '${pkg}' in '${env}' (reversible)`,
        deps,
      });
    }

    case "cuda":
      return runCuda(ctx, deps);

    default:
      return {
        text: `prometheus env ${verb}: unknown env verb.\n  ${c.dim("try:")} list · info · doctor · use · export · create · clone · delete · import ·\n       add · remove · update · upgrade · enable · disable · cuda · templates · template`,
        json: { ok: false, error: "unknown-verb", command: `env ${verb}` },
        exitCode: 2,
      };
  }
}

/**
 * `env create <name> --template <id>` — the GUI "create from template" flow. The
 * envmgr `env.create` verb does NOT apply templates, so the CLI CHAINS create then
 * the batched gated `template.commit` (both --confirm/--force gated). PREVIEW shows
 * both steps; on --yes it runs create, and only on success applies the template.
 */
async function runCreateWithTemplate(
  ctx: CliContext,
  name: string,
  template: string,
  deps: SidecarDeps,
): Promise<CommandOutcome> {
  const createBase = createArgv(name, ctx);
  const commitBase = ["template.commit", "--template", template, "--env", name];
  const blocked = forceBlocked(ctx, "env create");
  if (blocked) return blocked;
  if (!wantsExecute(ctx)) {
    return {
      text:
        `${c.bold("prometheus env create")}  ${c.dim("(preview — nothing changed)")}\n` +
        `  ${c.cyan("would")}  create ${flagSet(ctx, "conda") ? "conda" : "venv"} env '${name}', then apply template '${template}' (gated)\n` +
        `  ${c.dim("plan")}   ${c.dim(`${SCRIPT} ${createBase.join(" ")} --confirm`)}\n` +
        `         ${c.dim(`${SCRIPT} ${commitBase.join(" ")} --confirm`)}\n` +
        `  ${c.dim("re-run with")} ${c.bold("--yes")} ${c.dim("to execute")}`,
      json: { ok: true, status: "preview", command: "env create", steps: [createBase, commitBase] },
      exitCode: 0,
    };
  }
  const created = await deps.runSidecar(SCRIPT, execArgv(ctx, createBase, true));
  if (created.ok === false) return renderMutation(ctx, "env create", created);
  const committed = await deps.runSidecar(SCRIPT, execArgv(ctx, commitBase, true));
  return renderMutation(ctx, "env template", committed);
}

/** `env templates` — the built-in + on-disk reproducible env recipes (template.list). */
function renderTemplates(e: Record<string, unknown>): CommandOutcome {
  const rows = Array.isArray(e.templates) ? (e.templates as Record<string, unknown>[]) : [];
  const lines = [heading(`Env templates  ${c.dim(`(${rows.length})`)}`), ""];
  if (rows.length === 0) {
    lines.push(c.dim("No templates."));
    return { text: lines.join("\n"), exitCode: 0 };
  }
  const trows = rows.map((r) => {
    const pkgs = Array.isArray(r.packages) ? (r.packages as unknown[]).length : 0;
    return [
      c.bold(String(r.id ?? "—")),
      String(r.label ?? ""),
      c.dim(String(r.python ?? "")),
      c.dim(`${pkgs} pkg${pkgs === 1 ? "" : "s"}`),
    ];
  });
  lines.push(
    table(
      [{ header: "ID" }, { header: "LABEL" }, { header: "PYTHON" }, { header: "PACKAGES" }],
      trows,
    ),
  );
  lines.push("");
  lines.push(
    c.dim(
      "apply one with: prometheus env template <id> --env <env>  ·  or `prometheus env create <name> --template <id>`",
    ),
  );
  return { text: lines.join("\n"), exitCode: 0 };
}

/** `env cuda [info | torch <env> | install]` — three-level via positional[0]. */
async function runCuda(ctx: CliContext, deps: SidecarDeps): Promise<CommandOutcome> {
  const action = ctx.args.positionals[0] ?? "info";
  if (action === "info") {
    return runRead(ctx, {
      command: "env cuda info",
      script: SCRIPT,
      argv: ["cuda.info"],
      deps,
      render: (e) => renderCudaInfo(e),
    });
  }
  if (action === "torch") {
    const env = ctx.args.positionals[1];
    if (!env) return usageError("env cuda torch", "<env> [--index URL]");
    const base = ["cuda.torch", "--env", env];
    const index = flagStr(ctx, "index");
    if (index) base.push("--index", index);
    return runMutation(ctx, {
      command: "env cuda torch",
      script: SCRIPT,
      base,
      note: `install the CUDA/CPU-matched torch wheel into '${env}' (gated)`,
      deps,
    });
  }
  if (action === "install") {
    const base = ["cuda.install"];
    const toolkit = flagStr(ctx, "toolkit");
    if (toolkit) base.push("--toolkit", toolkit);
    return runMutation(ctx, {
      command: "env cuda install",
      script: SCRIPT,
      base,
      note: "install the CUDA toolkit (OS-specific; gated installer)",
      deps,
    });
  }
  return usageError("env cuda", "[info | torch <env> | install]");
}

/* ----------------------------- read renderers ----------------------------- */

interface PkgRow {
  name?: string;
  version?: string;
  disabled?: boolean;
}

function renderPackages(env: string, e: Record<string, unknown>): CommandOutcome {
  const pkgs = Array.isArray(e.packages) ? (e.packages as PkgRow[]) : [];
  const lines = [heading(`Packages  ${c.dim(`(${pkgs.length})`)}  ${c.dim(env)}`), ""];
  if (pkgs.length === 0) {
    lines.push(c.dim("No packages."));
    return { text: lines.join("\n"), exitCode: 0 };
  }
  const rows = pkgs.map((p) => [
    p.name ?? "—",
    c.dim(p.version ?? "—"),
    p.disabled ? c.yellow("disabled") : c.green("on"),
  ]);
  lines.push(table([{ header: "NAME" }, { header: "VERSION" }, { header: "STATE" }], rows));
  return { text: lines.join("\n"), exitCode: 0 };
}

function renderDoctor(env: string, e: Record<string, unknown>): CommandOutcome {
  const health = typeof e.health === "string" ? e.health : "unknown";
  const badge =
    health === "ok" ? c.green(health) : health === "warn" ? c.yellow(health) : c.red(health);
  const lines = [heading(`Env doctor  ${c.dim(env)}`), "", kv("health", badge)];
  const checks =
    e.checks && typeof e.checks === "object" ? (e.checks as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(checks)) lines.push(kv(k, c.dim(String(v))));
  return { text: lines.join("\n"), exitCode: 0 };
}

function renderExport(env: string, e: Record<string, unknown>): CommandOutcome {
  const reqs = Array.isArray(e.requirements) ? e.requirements.map(String) : [];
  const fmt = typeof e.format === "string" ? e.format : "requirements";
  const lines = [heading(`Export  ${c.dim(`${env} · ${fmt}`)}`), ""];
  if (reqs.length === 0) lines.push(c.dim("No requirements resolved."));
  else for (const r of reqs) lines.push(`  ${r}`);
  return { text: lines.join("\n"), exitCode: 0 };
}

function renderCudaInfo(e: Record<string, unknown>): CommandOutcome {
  const lines = [heading("CUDA / GPU"), ""];
  lines.push(kv("nvidia-smi", e.nvidia_smi ? c.green("present") : c.dim("absent")));
  lines.push(kv("nvcc", e.nvcc ? c.green("present") : c.dim("absent")));
  if (typeof e.gpu === "string") lines.push(kv("gpu", e.gpu));
  if (typeof e.cuda_version === "string") lines.push(kv("cuda", c.dim(e.cuda_version)));
  return { text: lines.join("\n"), exitCode: 0 };
}
