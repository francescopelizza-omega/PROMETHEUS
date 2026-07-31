/**
 * commands/metadata-cmd.ts — `prom metadata …` over the metadata.py sidecar
 * (C7 / file 0C), at parity with the GUI Metadata privacy panel. Read/strip/edit/
 * normalize the metadata of ONE user-selected file. Mutations are copy-then-replace
 * (the original is never lost on failure) and PREVIEW first — the sidecar returns a
 * plan unless `--confirm`, which prom adds only on `--yes` (typed intent). Nothing
 * here decides safety; this is local privacy hygiene on a file the user names.
 *
 *   metadata inspect   <file>                          read all fields       [read]
 *   metadata scrub     <file>                          strip all metadata  [mutate]
 *   metadata edit      <file> --field <G:Tag> --value <v>   set one field   [mutate]
 *   metadata timestomp <file> --mtime <epoch> [--atime <epoch>]             [mutate]
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, kv, table } from "../render.js";
import {
  type SidecarDeps,
  defaultSidecarDeps,
  flagStr,
  runMutation,
  runRead,
  usageError,
} from "./sidecar-cmd.js";

const SCRIPT = "metadata.py" as const;

function sub(ctx: CliContext): string {
  return ctx.args.command[1] ?? "inspect";
}

export async function runMetadataCommand(
  ctx: CliContext,
  deps: SidecarDeps = defaultSidecarDeps,
): Promise<CommandOutcome> {
  const verb = sub(ctx);
  const file = ctx.args.positionals[0];

  switch (verb) {
    case "inspect": {
      if (!file) return usageError("metadata inspect", "<file>");
      return runRead(ctx, {
        command: "metadata inspect",
        script: SCRIPT,
        argv: ["inspect", "--uri", file],
        deps,
        render: (e) => renderInspect(file, e),
      });
    }

    case "scrub": {
      if (!file) return usageError("metadata scrub", "<file>");
      return runMutation(ctx, {
        command: "metadata scrub",
        script: SCRIPT,
        base: ["scrub", "--uri", file],
        note: `strip ALL metadata from ${file} (copy-then-replace; original safe)`,
        deps,
      });
    }

    case "edit": {
      if (!file) return usageError("metadata edit", "<file> --field <G:Tag> --value <v>");
      const field = flagStr(ctx, "field");
      const value = flagStr(ctx, "value");
      if (!field || value === undefined) {
        return usageError("metadata edit", "<file> --field <G:Tag> --value <v>");
      }
      return runMutation(ctx, {
        command: "metadata edit",
        script: SCRIPT,
        base: ["edit", "--uri", file, "--field", field, "--value", value],
        note: `set ${field} = "${value}" on ${file} (needs exiftool)`,
        deps,
      });
    }

    case "timestomp": {
      if (!file)
        return usageError("metadata timestomp", "<file> --mtime <epoch> [--atime <epoch>]");
      const mtime = flagStr(ctx, "mtime");
      if (!mtime)
        return usageError("metadata timestomp", "<file> --mtime <epoch> [--atime <epoch>]");
      const base = ["timestomp", "--uri", file, "--mtime", mtime];
      const atime = flagStr(ctx, "atime");
      if (atime) base.push("--atime", atime);
      return runMutation(ctx, {
        command: "metadata timestomp",
        script: SCRIPT,
        base,
        note: `normalize timestamps of ${file} → mtime=${mtime}${atime ? ` atime=${atime}` : ""}`,
        deps,
      });
    }

    default:
      return {
        text:
          `prom metadata ${verb}: unknown metadata verb.\n` +
          `  ${c.dim("try:")} inspect · scrub · edit · timestomp`,
        json: { ok: false, error: "unknown-verb", command: `metadata ${verb}` },
        exitCode: 2,
      };
  }
}

/* ----------------------------- read renderer ------------------------------ */

interface MetaField {
  key?: string;
  tag?: string;
  value?: unknown;
  privacy?: boolean;
  sensitive?: boolean;
}

function renderInspect(file: string, e: Record<string, unknown>): CommandOutcome {
  const fields: MetaField[] = Array.isArray(e.fields)
    ? (e.fields as MetaField[])
    : Array.isArray(e.metadata)
      ? (e.metadata as MetaField[])
      : [];
  const lines = [heading(`Metadata  ${c.dim(file)}`), ""];
  if (typeof e.type === "string") lines.push(kv("type", c.dim(e.type)));
  if (fields.length === 0) {
    // Some inspectors return a flat map under `data`/`raw`; render that as kv.
    const flat =
      e.data && typeof e.data === "object"
        ? (e.data as Record<string, unknown>)
        : (e as Record<string, unknown>);
    const entries = Object.entries(flat).filter(
      ([k]) => !["ok", "command", "_exit", "type", "uri"].includes(k),
    );
    if (entries.length === 0) {
      lines.push(c.dim("No metadata fields."));
      return { text: lines.join("\n"), exitCode: 0 };
    }
    lines.push("");
    for (const [k, v] of entries) lines.push(kv(k, c.dim(String(v))));
    return { text: lines.join("\n"), exitCode: 0 };
  }
  const privacyCount = fields.filter((f) => f.privacy || f.sensitive).length;
  if (privacyCount > 0) {
    lines.push(c.yellow(`⚠ ${privacyCount} privacy-sensitive field${privacyCount > 1 ? "s" : ""}`));
    lines.push("");
  }
  const rows = fields.map((f) => [
    (f.privacy || f.sensitive ? c.yellow("⚠ ") : "  ") + (f.key ?? f.tag ?? "—"),
    c.dim(String(f.value ?? "")),
  ]);
  lines.push(table([{ header: "FIELD" }, { header: "VALUE" }], rows));
  return { text: lines.join("\n"), exitCode: 0 };
}
