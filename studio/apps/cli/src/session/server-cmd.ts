// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/server-cmd.ts — `/server`: choose the DEFAULT LOCAL MODEL SERVER.
 *
 * Ollama is the default; LM Studio, llama.cpp or vLLM can be picked instead. In the TUI a bare
 * `/server` opens a two-column picker (server name left; its state and what it is for right);
 * in the line-mode host it prints the same list and asks for a number. `/server <id>` saves the
 * choice (the shared settings.json the app reads too) and, when that server is serving a model
 * right now, switches this session to it.
 *
 * What the default changes is defined once, in `@prometheus/core`'s `ai/default-server.ts`.
 */
import { ai } from "@prometheus/core";

import { c } from "../render.js";
import type { ListOverlayItem } from "../tui/list-overlay.js";
import type { SlashCtx } from "./slash-registry.js";

export interface ServerRow {
  id: ai.DefaultServerId;
  name: string;
  /** "serving 2 models" · "running" · "installed" · "not installed" · "unknown" */
  state: string;
  /** the models it serves right now (for adopting one). */
  models: string[];
  current: boolean;
  lines: readonly [string, string];
}

/** How to bring each server up when it is the default but not running. */
const START_HINT: Record<ai.DefaultServerId, string> = {
  ollama: "start it with `ollama serve` (or open the Ollama app)",
  lmstudio: "start it with `lms server start` (or open LM Studio)",
  llamacpp: "prepare a model for it with `/models use local:<id>@llamacpp`",
  mlx: "prepare a model for it with `/models use local:<id>@mlx` (Apple Silicon)",
  vllm: "start it with `vllm serve <model>` (Prometheus adopts it on port 8000)",
};

/** Every server with what this machine says about it right now. */
export async function serverRows(ctx: SlashCtx): Promise<ServerRow[]> {
  const current = ctx.defaultServerSetting?.get() ?? ai.DEFAULT_SERVER;
  const pctx = await ctx.models?.context().catch(() => undefined);
  return ai.DEFAULT_SERVER_IDS.map((id) => {
    const info = ai.DEFAULT_SERVER_INFO[id];
    const models = (pctx?.served ?? []).filter((s) => s.runner === id).map((s) => s.model);
    const installed =
      id === "ollama"
        ? pctx?.ollamaInstalled
        : id === "vllm"
          ? undefined
          : pctx?.runtimeInstalled?.[id];
    const running =
      models.length > 0 ||
      (id === "ollama"
        ? pctx?.ollamaServing === true
        : id !== "vllm" && pctx?.runtimeServing?.[id] === true);
    const state =
      models.length > 0
        ? `serving ${models.length} model${models.length === 1 ? "" : "s"}`
        : running
          ? "running"
          : installed === true
            ? "installed"
            : installed === false
              ? "not installed"
              : pctx
                ? "not running"
                : "unknown";
    return { id, name: info.name, state, models, current: id === current, lines: info.lines };
  });
}

/** The TUI picker's items: name on the left; state + purpose, then the second line, right. */
export function serverOverlayItems(rows: readonly ServerRow[]): ListOverlayItem[] {
  return rows.map((r) => ({
    label: r.name,
    columns: [`${r.state} — ${r.lines[0]}`, r.lines[1]] as const,
    submitText: `/server ${r.id}`,
    ...(r.current ? { current: true } : {}),
  }));
}

/** `/server [id]`. */
export async function runServer(rest: string, ctx: SlashCtx): Promise<void> {
  const setting = ctx.defaultServerSetting;
  if (!setting) {
    ctx.write(c.dim("this surface has no default-server setting"));
    return;
  }
  let want = rest.trim().toLowerCase();
  const aliases: Record<string, ai.DefaultServerId> = {
    "lm-studio": "lmstudio",
    "llama.cpp": "llamacpp",
    "llama-cpp": "llamacpp",
    "llama-server": "llamacpp",
    "mlx-lm": "mlx",
    mlx_lm: "mlx",
  };
  want = aliases[want] ?? want;
  const rows = await serverRows(ctx);
  if (!want) {
    ctx.write(
      `${c.bold("Default local server")}${c.dim(" — used to start and adopt local models (Ollama unless you pick another)")}`,
    );
    const leftW = Math.max(...rows.map((r) => r.name.length));
    for (const [i, r] of rows.entries()) {
      const mark = r.current ? c.green("  ← current") : "";
      ctx.write(`  ${i + 1}) ${c.bold(r.name.padEnd(leftW))}   ${r.state} — ${r.lines[0]}${mark}`);
      ctx.write(`     ${" ".repeat(leftW)}   ${c.dim(r.lines[1])}`);
    }
    const ans = (await ctx.ask("pick a number (Enter keeps the current one): ")).trim();
    if (!ans) return;
    const n = Number.parseInt(ans, 10);
    const pick = rows[n - 1];
    if (!pick || String(n) !== ans) {
      ctx.write(c.red(`/server: "${ans}" is not one of the listed numbers`));
      return;
    }
    want = pick.id;
  }
  if (!ai.isDefaultServerId(want)) {
    ctx.write(
      c.red(`/server: unknown server "${want}" — one of ${ai.DEFAULT_SERVER_IDS.join(", ")}`),
    );
    return;
  }
  if (!setting.set(want)) {
    ctx.write(c.red("/server: the setting could not be saved"));
    return;
  }
  const row = rows.find((r) => r.id === want);
  const name = ai.DEFAULT_SERVER_INFO[want].name;
  ctx.write(c.green(`✓ default local server → ${name}`));
  // Serving a model right now: switch this session to it (the preferred server wins).
  const model = row?.models[0];
  if (model && ctx.models) {
    const r = await ctx.models.adopt({ section: "served", runner: want, model });
    ctx.write(
      r.ok
        ? c.green(`✓ chat now uses ${model} on ${name}`)
        : c.yellow(`saved, but switching failed: ${r.reason}`),
    );
    return;
  }
  ctx.write(
    c.dim(
      `  ${name} is ${row?.state ?? "not running"} — ${START_HINT[want]}. New local picks (/models) are prepared for it.`,
    ),
  );
}
