/**
 * commands/refactor-cmd.ts — `prom refactor <structure|imports|callgraph> <file>`
 * over the refactor.py sidecar (CLI-009). Read-only AST analyses: a structure
 * tree, an import list, and the intra-module call graph. runSidecar is the sole
 * gateway (C5/C7); `--json` emits the envelope unmodified. Distinct from the
 * `/refactor` prompt macro — these verbs never touch disk.
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c } from "../render.js";
import { type SidecarDeps, defaultSidecarDeps } from "./sidecar-cmd.js";

const VERBS = ["structure", "imports", "callgraph"] as const;

interface StructNode {
  kind?: string;
  name?: string;
  line?: number;
  args?: string[];
  bases?: string[];
  members?: StructNode[];
}
interface ImportRow {
  module?: string;
  name?: string;
  as?: string | null;
  line?: number;
}
interface Edge {
  from?: string;
  to?: string;
}

function renderStructure(nodes: StructNode[], indent: string, lines: string[]): void {
  for (const n of nodes) {
    if (n.kind === "class") {
      const bases = n.bases?.length ? `(${n.bases.join(", ")})` : "";
      lines.push(`${indent}${c.cyan("class")} ${n.name}${bases} ${c.dim(`:${n.line}`)}`);
      if (Array.isArray(n.members)) renderStructure(n.members, `${indent}  `, lines);
    } else {
      const args = `(${(n.args ?? []).join(", ")})`;
      lines.push(`${indent}${c.green("def")} ${n.name}${args} ${c.dim(`:${n.line}`)}`);
    }
  }
}

export async function runRefactor(
  ctx: CliContext,
  deps: SidecarDeps = defaultSidecarDeps,
): Promise<CommandOutcome> {
  const verb = ctx.args.command[1];
  // validate the VERB before the path so a bad verb never spawns python.
  if (verb !== "structure" && verb !== "imports" && verb !== "callgraph") {
    return {
      text: `prom refactor: unknown verb ${verb ? `"${verb}"` : "(none)"} — valid: ${VERBS.join(", ")}`,
      json: { ok: false, error: "unknown-verb", valid: VERBS },
      exitCode: 2,
    };
  }
  const file = ctx.args.positionals[0] ?? ".";
  if (file.startsWith("-")) {
    return {
      text: `prom refactor ${verb}: refusing option-shaped path: ${file}`,
      json: { ok: false, error: "bad-path", path: file },
      exitCode: 2,
    };
  }

  const env = await deps.runSidecar("refactor.py", [verb, "--file", file]);
  if (ctx.json) return { json: env, exitCode: env.ok === false ? 2 : 0 };
  if (env.ok === false) {
    return { text: c.red(`refactor ${verb} failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  const lines: string[] = [];
  if (verb === "structure") {
    const tree = Array.isArray(env.structure) ? (env.structure as StructNode[]) : [];
    lines.push(c.bold(`structure ${c.dim(file)}`));
    renderStructure(tree, "  ", lines);
    if (tree.length === 0) lines.push(c.dim("  (no classes/functions)"));
  } else if (verb === "imports") {
    const imports = Array.isArray(env.imports) ? (env.imports as ImportRow[]) : [];
    lines.push(c.bold(`imports ${c.dim(`(${imports.length})`)}`));
    for (const imp of imports) {
      const as = imp.as ? ` as ${imp.as}` : "";
      const stmt = imp.name
        ? `from ${imp.module} import ${imp.name}${as}`
        : `import ${imp.module}${as}`;
      lines.push(`  ${c.dim(String(imp.line ?? "?"))}  ${stmt}`);
    }
    if (imports.length === 0) lines.push(c.dim("  (no imports)"));
  } else {
    const edges = Array.isArray(env.edges) ? (env.edges as Edge[]) : [];
    const byCaller = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!e.from || !e.to) continue;
      (byCaller.get(e.from) ?? byCaller.set(e.from, new Set()).get(e.from))?.add(e.to);
    }
    lines.push(c.bold(`callgraph ${c.dim(`(${edges.length} edges)`)}`));
    for (const [from, tos] of byCaller) {
      lines.push(`  ${c.cyan(from)} ${c.dim("→")} ${[...tos].join(", ")}`);
    }
    if (byCaller.size === 0) lines.push(c.dim("  (no intra-module calls)"));
  }
  return { text: lines.join("\n"), exitCode: 0 };
}
