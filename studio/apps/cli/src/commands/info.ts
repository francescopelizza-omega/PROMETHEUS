// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/info.ts — `prometheus info <name>`: details for one registry plugin.
 *
 * Renders the engine's `info` envelope (plugin{}). The engine returns ok:false /
 * "unknown plugin" for a bad name — we surface that with exit 2.
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, kv } from "../render.js";

interface PluginInfo {
  name?: string;
  summary?: string;
  tier?: string;
  scope?: string;
  repo?: string;
  license?: string;
  stars?: number;
  category?: string;
  recommend_rank?: number;
  supported_os?: string[];
  caveats?: string[];
  security_note?: string;
  targets?: Record<string, unknown>;
}

export async function runInfo(ctx: CliContext): Promise<CommandOutcome> {
  const name = ctx.args.positionals[0];
  if (!name) {
    return {
      text: c.red("usage: prometheus info <plugin-name>"),
      // A missing positional is the BAD-ARGS class → 1 (CLI-084). It exited 2, which is the
      // security-block signal `$? -eq 2` is meant to detect; see `usageError`.
      json: { ok: false, error: "missing-argument", command: "info", usage: "<plugin-name>" },
      exitCode: 1,
    };
  }

  const env = await ctx.client.info(name);

  if (ctx.json) {
    return { json: env, exitCode: env.ok === false ? 2 : 0 };
  }
  if (env.ok === false) {
    return {
      text: c.red(`info failed: ${env.error ?? `unknown plugin: ${name}`}`),
      exitCode: 2,
    };
  }

  const p = (env.plugin ?? {}) as PluginInfo;
  const lines: string[] = [];
  lines.push(heading(p.name ?? name));
  if (p.summary) lines.push(c.dim(p.summary));
  lines.push("");
  if (p.tier) lines.push(kv("tier", p.tier));
  if (p.scope) lines.push(kv("scope", p.scope));
  if (p.repo) lines.push(kv("repo", p.repo));
  if (p.license) lines.push(kv("license", p.license));
  if (p.stars !== undefined) lines.push(kv("stars", `★${p.stars}`));
  if (p.category) lines.push(kv("category", p.category));
  if (Array.isArray(p.supported_os) && p.supported_os.length) {
    lines.push(kv("os", p.supported_os.join(", ")));
  }
  if (p.targets && typeof p.targets === "object") {
    lines.push(kv("targets", Object.keys(p.targets).join(", ") || "—"));
  }
  if (p.security_note) {
    lines.push("");
    lines.push(kv(c.yellow("security"), p.security_note));
  }
  if (Array.isArray(p.caveats) && p.caveats.length) {
    lines.push("");
    lines.push(c.bold("caveats"));
    for (const cav of p.caveats) lines.push(`  ${c.dim("•")} ${cav}`);
  }

  return { text: lines.join("\n"), exitCode: 0 };
}
