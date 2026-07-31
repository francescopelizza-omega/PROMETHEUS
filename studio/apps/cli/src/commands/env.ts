/**
 * commands/env.ts — `prom env [list]`: list Python environments via the
 * envmgr.py sidecar (C7, C9 conda first-class). One JSON object on stdout.
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, table } from "../render.js";
import { runSidecar } from "../sidecar.js";

interface EnvRow {
  name: string;
  path: string;
  kind?: "venv" | "conda" | "system";
  python_version?: string | null;
  packages_count?: number | null;
}

function kindBadge(kind: string | undefined): string {
  switch (kind) {
    case "venv":
      return c.green("venv");
    case "conda":
      return c.blue("conda");
    case "system":
      return c.dim("system");
    default:
      return c.dim(kind ?? "—");
  }
}

export async function runEnv(ctx: CliContext): Promise<CommandOutcome> {
  const env = await runSidecar("envmgr.py", ["env.list"]);

  if (ctx.json) {
    return { json: env, exitCode: env.ok === false ? 2 : 0 };
  }
  if (env.ok === false) {
    return { text: c.red(`env list failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  const environments = Array.isArray(env.environments) ? (env.environments as EnvRow[]) : [];
  const condaAvailable = env.conda_available === true;

  const rows = environments.map((e) => [
    e.name,
    kindBadge(e.kind),
    e.python_version ? c.dim(e.python_version) : c.dim("—"),
    e.packages_count === null || e.packages_count === undefined
      ? c.dim("—")
      : String(e.packages_count),
    c.dim(e.path),
  ]);

  const lines: string[] = [];
  lines.push(
    heading(
      `Environments  ${c.dim(`(${environments.length})`)}  ${
        condaAvailable ? c.blue("conda available") : c.dim("conda not found")
      }`,
    ),
  );
  lines.push("");
  lines.push(
    table(
      [
        { header: "NAME" },
        { header: "KIND" },
        { header: "PYTHON" },
        { header: "PKGS", align: "right" },
        { header: "PATH" },
      ],
      rows,
    ),
  );
  if (environments.length === 0) {
    lines.push("");
    lines.push(c.dim("No environments found."));
  }

  return { text: lines.join("\n"), exitCode: 0 };
}
