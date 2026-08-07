/**
 * commands/scan.ts — `prometheus scan`: detect installed AI agents/CLIs/IDEs.
 *
 * Renders the engine's `scan` envelope (agents[]) as a table. Pure rendering of
 * what the engine reported (C5) — the CLI decides nothing about the host.
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, sym, table } from "../render.js";

interface ScanAgent {
  name: string;
  label?: string;
  kind?: string;
  present?: boolean;
  where?: string;
}

export async function runScan(ctx: CliContext): Promise<CommandOutcome> {
  const env = await ctx.client.scan();

  if (ctx.json) {
    return { json: env, exitCode: env.ok === false ? 2 : 0 };
  }

  if (env.ok === false) {
    return { text: c.red(`scan failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  const agents = Array.isArray(env.agents) ? (env.agents as ScanAgent[]) : [];
  const os = env.os as { family?: string; pkg_manager?: string } | undefined;

  const present = agents.filter((a) => a.present);
  const absent = agents.filter((a) => !a.present);

  const rows = agents
    // present first, then by label
    .slice()
    .sort((a, b) => {
      if (!!a.present !== !!b.present) return a.present ? -1 : 1;
      return (a.label ?? a.name).localeCompare(b.label ?? b.name);
    })
    .map((a) => [
      a.present ? sym.ok() : sym.off(),
      a.label ?? a.name,
      c.dim(a.kind ?? "—"),
      a.present ? (a.where ?? "") : c.dim("not found"),
    ]);

  const lines: string[] = [];
  const osLabel = os?.family
    ? `${os.family}${os.pkg_manager ? ` · ${os.pkg_manager}` : ""}`
    : "host";
  lines.push(
    heading(
      `Detected agents  ${c.dim(`(${present.length}/${agents.length} present · ${osLabel})`)}`,
    ),
  );
  lines.push("");
  lines.push(
    table([{ header: "" }, { header: "AGENT" }, { header: "KIND" }, { header: "WHERE" }], rows),
  );
  if (absent.length === agents.length) {
    lines.push("");
    lines.push(c.dim("No agents detected on this host."));
  }

  return { text: lines.join("\n"), exitCode: 0 };
}
