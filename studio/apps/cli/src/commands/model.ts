/**
 * commands/model.ts — `prom model hw` / `prom model list` via modelhub.py (C7).
 *   model hw   -> hw.scan: host CPU/RAM/GPU + usable-weight budget for fit.
 *   model list -> model.list: locally-present model files.
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, humanBytes, kv, table } from "../render.js";
import { runSidecar } from "../sidecar.js";

interface Gpu {
  name?: string;
  vendor?: string;
  vram_mb?: number | null;
  vram_bytes?: number | null;
  unified_memory?: boolean;
}

interface LocalModelRow {
  name: string;
  path: string;
  format?: string;
  size_bytes?: number;
  size_gb?: number;
  quant?: string;
}

export async function runModelHw(ctx: CliContext): Promise<CommandOutcome> {
  const argv = ["hw.scan"];
  if (ctx.args.flags.rescan === true || ctx.args.flags.rescan === "true") argv.push("--rescan");
  const env = await runSidecar("modelhub.py", argv);
  if (ctx.json) return { json: env, exitCode: env.ok === false ? 2 : 0 };
  if (env.ok === false) {
    return { text: c.red(`hw.scan failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  const cpu = env.cpu as { model?: string; logical?: number; physical?: number } | undefined;
  const gpus = Array.isArray(env.gpus) ? (env.gpus as Gpu[]) : [];
  const lines: string[] = [];

  lines.push(heading("Hardware"));
  lines.push("");
  lines.push(kv("os / arch", `${env.os ?? "?"} · ${env.arch ?? "?"}`));
  if (cpu) {
    lines.push(kv("cpu", `${cpu.model ?? "?"} (${cpu.physical ?? "?"}c / ${cpu.logical ?? "?"}t)`));
  }
  lines.push(
    kv(
      "ram",
      `${typeof env.ram_gb === "number" ? env.ram_gb.toFixed(0) : "?"} GB${
        env.unified_memory === true ? c.dim("  (unified)") : ""
      }`,
    ),
  );
  lines.push(
    kv(
      "usable weight budget",
      `${c.green(`${typeof env.usable_weight_gb === "number" ? env.usable_weight_gb.toFixed(1) : "?"} GB`)} ${c.dim(`(${env.usable_basis ?? "unknown"})`)}`,
    ),
  );

  if (gpus.length) {
    lines.push("");
    lines.push(c.bold(`gpu${gpus.length > 1 ? `s (${gpus.length})` : ""}`));
    const rows = gpus.map((g) => [
      g.name ?? "?",
      c.dim(g.vendor ?? "—"),
      g.vram_bytes ? humanBytes(g.vram_bytes) : g.unified_memory ? c.dim("unified") : c.dim("—"),
    ]);
    lines.push(table([{ header: "NAME" }, { header: "VENDOR" }, { header: "VRAM" }], rows));
  }

  return { text: lines.join("\n"), exitCode: 0 };
}

export async function runModelList(ctx: CliContext): Promise<CommandOutcome> {
  const env = await runSidecar("modelhub.py", ["model.list"]);
  if (ctx.json) return { json: env, exitCode: env.ok === false ? 2 : 0 };
  if (env.ok === false) {
    return { text: c.red(`model.list failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  const models = Array.isArray(env.models) ? (env.models as LocalModelRow[]) : [];
  const root = typeof env.root === "string" ? env.root : "—";
  const lines: string[] = [];
  lines.push(heading(`Local models  ${c.dim(`(${models.length})`)}`));
  lines.push(kv("root", c.dim(root)));
  lines.push("");

  if (models.length === 0) {
    lines.push(
      c.dim(env.exists === false ? "Model cache does not exist yet." : "No local models."),
    );
    return { text: lines.join("\n"), exitCode: 0 };
  }

  const rows = models.map((m) => [
    m.name,
    c.dim(m.format ?? "—"),
    c.dim(m.quant ?? "—"),
    m.size_bytes !== undefined ? humanBytes(m.size_bytes) : c.dim("—"),
    c.dim(m.path),
  ]);
  lines.push(
    table(
      [
        { header: "NAME" },
        { header: "FORMAT" },
        { header: "QUANT" },
        { header: "SIZE", align: "right" },
        { header: "PATH" },
      ],
      rows,
    ),
  );
  return { text: lines.join("\n"), exitCode: 0 };
}
