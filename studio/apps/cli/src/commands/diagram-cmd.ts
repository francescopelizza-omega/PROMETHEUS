// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/diagram-cmd.ts — `prometheus diagram <uml|deps> <path>` over the diagram.py
 * sidecar (CLI-008). A read-only AST walk → a Mermaid (+ Graphviz DOT) diagram
 * string; this renders it to stdout, a terse `--summary`, or a `--out <file>`
 * artifact. `--json` emits the sidecar envelope unmodified. The CLI never spawns
 * python directly — runSidecar is the sole gateway (C5/C7).
 */
import { existsSync, writeFileSync } from "node:fs";

import type { CliContext, CommandOutcome } from "../context.js";
import { c } from "../render.js";
import { type SidecarDeps, defaultSidecarDeps, flagSet, flagStr } from "./sidecar-cmd.js";

const VERBS = ["uml", "deps"] as const;
const SUMMARY_LINES = 8;

function badPath(verb: string, p: string): CommandOutcome {
  return {
    text: `prometheus diagram ${verb}: refusing option-shaped path: ${p}`,
    json: { ok: false, error: "bad-path", path: p },
    exitCode: 2,
  };
}

export async function runDiagram(
  ctx: CliContext,
  deps: SidecarDeps = defaultSidecarDeps,
): Promise<CommandOutcome> {
  // `unmatchedSub` (parse.ts) distinguishes "a second word WAS typed but didn't match
  // uml/deps" from "nothing was typed" — without it, a typo (command[1] is undefined for a
  // TWO_WORD mismatch) rendered as "unknown verb (none)" instead of naming the actual typo.
  const verb = ctx.args.unmatchedSub ?? ctx.args.command[1];
  if (verb !== "uml" && verb !== "deps") {
    return {
      text: `prometheus diagram: unknown verb ${verb ? `"${verb}"` : "(none)"} — valid: ${VERBS.join(", ")}`,
      json: { ok: false, error: "unknown-verb", verb: verb ?? null, valid: VERBS },
      exitCode: 1,
    };
  }
  const path = ctx.args.positionals[0] ?? ".";
  // option-injection guard BEFORE any spawn (so `--help` as a path can't reach python).
  if (path.startsWith("-")) return badPath(verb, path);

  const env = await deps.runSidecar("diagram.py", [verb, "--path", path]);
  if (env.ok === false) {
    return ctx.json
      ? { json: env, exitCode: 2 }
      : { text: c.red(`diagram ${verb} failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  const mermaid = typeof env.mermaid === "string" ? env.mermaid : "";
  const count =
    verb === "uml"
      ? `${env.classCount ?? 0} classes`
      : `${env.moduleCount ?? 0} modules${
          Array.isArray(env.cycles) && env.cycles.length > 0
            ? ` · ${env.cycles.length} cycle(s)`
            : ""
        }`;

  /**
   * `--out <file>`: write the artifact (mermaid), fenced only for a .md target.
   *
   * Handled BEFORE the `--json` early return, not after it. `--json` used to return the
   * envelope straight from the sidecar and never reach this block, so
   * `--json diagram deps <path> --out f.md` wrote NO file and still reported `ok:true` —
   * while the identical command without `--json` wrote it. `--out` is a side effect the caller
   * asked for; the output format decides how to REPORT it, never whether it happens.
   */
  const out = flagStr(ctx, "out");
  if (out !== undefined) {
    if (out.startsWith("-")) return badPath(verb, out);
    if (existsSync(out) && !ctx.args.force) {
      return {
        text: `prometheus diagram: ${out} exists — re-run with ${c.bold("--force")} to overwrite`,
        json: { ok: false, error: "exists", path: out },
        exitCode: 2,
      };
    }
    const body = out.endsWith(".md") ? `\`\`\`mermaid\n${mermaid}\n\`\`\`\n` : `${mermaid}\n`;
    try {
      writeFileSync(out, body);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return ctx.json
        ? { json: { ok: false, error: "write-failed", path: out, detail }, exitCode: 2 }
        : { text: c.red(`diagram: write failed: ${detail}`), exitCode: 2 };
    }
    return {
      text: `${c.green("✓")} wrote ${verb} diagram (${count}) → ${out}`,
      json: { ...env, out, written: true },
      exitCode: 0,
    };
  }
  if (ctx.json) return { json: env, exitCode: 0 };

  // --summary: terse pane view (counts + first lines) for the /diagram TUI slash.
  if (flagSet(ctx, "summary")) {
    const head = mermaid.split("\n").slice(0, SUMMARY_LINES).join("\n");
    const more = mermaid.split("\n").length > SUMMARY_LINES ? c.dim("\n  …") : "";
    return {
      text: `${c.bold(`diagram ${verb}`)} ${c.dim(`(${count})`)}\n${head}${more}\n${c.dim(
        "use --out <file> for the full diagram",
      )}`,
      exitCode: 0,
    };
  }

  // default: the full mermaid to stdout (starts byte-one with the mermaid header),
  // then a one-line summary.
  return { text: `${mermaid}\n${c.dim(count)}`, exitCode: 0 };
}
