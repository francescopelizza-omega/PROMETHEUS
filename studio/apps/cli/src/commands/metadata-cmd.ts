// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/metadata-cmd.ts — `prometheus metadata …` over the metadata.py sidecar
 * (C7 / file 0C), at parity with the GUI Metadata privacy panel. Read/strip/edit/
 * normalize the metadata of ONE user-selected file. Mutations are copy-then-replace
 * (the original is never lost on failure) and PREVIEW first — the sidecar returns a
 * plan unless `--confirm`, which prometheus adds only on `--yes` (typed intent). Nothing
 * here decides safety; this is local privacy hygiene on a file the user names.
 *
 *   metadata inspect   <file>                          read all fields       [read]
 *   metadata scrub     <file>                          strip all metadata  [mutate]
 *   metadata edit      <file> --field <G:Tag> --value <v>   set one field   [mutate]
 *   metadata timestomp <file> --mtime <epoch> [--atime <epoch>]             [mutate]
 */
import { isSensitiveMetadataKey } from "@prometheus/core/metadata";

import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, kv, table } from "../render.js";
import { renderEnvelope } from "../render/envelope-view.js";
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
  // see secure-cmd.ts's identical fix: `unmatchedSub` (parse.ts) distinguishes "a second word
  // was typed but didn't match" from "no second word at all" — without it, a typo like
  // `/metadata inspct foo.jpg` silently defaulted to "inspect" and used "inspct" itself (the
  // typo) as the FILE argument, never touching "foo.jpg" and never reporting an unknown action.
  return ctx.args.unmatchedSub ?? ctx.args.command[1] ?? "inspect";
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
          `prometheus metadata ${verb}: unknown metadata verb.\n` +
          `  ${c.dim("try:")} inspect · scrub · edit · timestomp`,
        json: { ok: false, error: "unknown-verb", command: `metadata ${verb}` },
        exitCode: 1,
      };
  }
}

/* ----------------------------- read renderer ------------------------------ */

/**
 * Render `metadata inspect` — the PRIVACY surface, so every tag has to be visible.
 *
 * This used to look for `e.fields` / `e.metadata` as ARRAYS and, finding neither, fall through
 * to a flat key/value loop that did `String(v)` on each value. The sidecar
 * (`studio/python/sidecar/metadata.py`'s `_inspect_payload`) always returns `fs`, `tags` and
 * `tools` as OBJECT MAPS and never emits `fields`/`metadata` at all — so the array branch was
 * unreachable dead code and EVERY run printed `fs: [object Object]`, `tags: [object Object]`,
 * `tools: [object Object]`. It even announced `tagCount: 20` and then showed none of the 20.
 * Measured on a PNG: all 20 EXIF tags hidden, which is exactly the case that matters — a user
 * checking a photo for GPS, camera and author data before deciding whether to scrub it.
 *
 * `renderEnvelope` is the CLI's own generic projector, written for this bug class ("commands
 * printed one word while their envelope carried the whole answer"); it recurses into plain
 * objects, so fs/tags/tools each render as a labelled block. The privacy flag on top comes from
 * core's shared `isSensitiveMetadataKey`, the same rule the desktop metadata panel uses — the
 * two surfaces were disagreeing about what the user was even looking at.
 */
function renderInspect(file: string, e: Record<string, unknown>): CommandOutcome {
  const tags = e.tags && typeof e.tags === "object" ? (e.tags as Record<string, unknown>) : {};
  const sensitive = Object.keys(tags).filter((k) => isSensitiveMetadataKey(k));
  const title = `Metadata  ${c.dim(file)}`;
  // `renderEnvelope` writes its own heading, so this must NOT add a second one.
  const warning =
    sensitive.length > 0
      ? c.yellow(
          `⚠ ${sensitive.length} privacy-sensitive tag${sensitive.length > 1 ? "s" : ""}: ${sensitive.join(", ")}`,
        )
      : "";
  const body = renderEnvelope(title, e as never);
  if (!body) {
    return {
      text: [heading(title), "", warning || c.dim("No metadata fields.")]
        .filter(Boolean)
        .join("\n"),
      exitCode: 0,
    };
  }
  return { text: warning ? `${warning}\n\n${body}` : body, exitCode: 0 };
}
