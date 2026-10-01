// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/keymap.ts — `prometheus keymap list [--preset <id>]`: the file-13 §2.2 keymap
 * presets + conflict report the GUI Settings keymap editor renders, headlessly.
 *
 * Read-only over pure core (`settings.BUILTIN_KEYMAPS` / `resolveBindings` /
 * `detectConflicts`). The interactive rebinding stays in the GUI; the CLI surfaces
 * the presets, their bindings, and any (keys, when) conflicts — useful for CI /
 * dotfile authoring. No engine call, no gating.
 */
import { settings } from "@prometheus/core";

import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, table } from "../render.js";

export function runKeymap(ctx: CliContext): CommandOutcome {
  // `unmatchedSub` (parse.ts) distinguishes "a second word WAS typed but didn't match
  // list" from "nothing was typed" — without it, `keymap lsit` (a typo) silently defaulted
  // to `list` instead of ever reaching the "unknown verb" branch below.
  const action = ctx.args.unmatchedSub ?? ctx.args.command[1] ?? "list";
  if (action !== "list") {
    return {
      text: `prometheus keymap ${action}: unknown verb.\n  ${c.dim("try:")} keymap list [--preset <id>]`,
      json: { ok: false, error: "unknown-verb", command: `keymap ${action}` },
      exitCode: 1,
    };
  }

  const presetId =
    (typeof ctx.args.flags.preset === "string" ? ctx.args.flags.preset : undefined) ??
    ctx.args.positionals[0];

  // --preset <id>: dump that keymap's bindings + conflict report.
  if (presetId) {
    const km = settings.getKeymap(presetId);
    if (!km) {
      const ids = settings.BUILTIN_KEYMAPS.map((k) => k.id).join(", ");
      return {
        text: c.red(`keymap '${presetId}' not found. Built-ins: ${ids}`),
        json: { ok: false, error: "not-found", id: presetId },
        exitCode: 2,
      };
    }
    const bindings = settings.resolveBindings(km);
    const conflicts = settings.detectConflicts(bindings);
    if (ctx.json) {
      return { json: { ok: true, keymap: km.id, bindings, conflicts }, exitCode: 0 };
    }
    const lines = [heading(`Keymap  ${c.bold(km.label)} ${c.dim(`(${km.id})`)}`), ""];
    lines.push(
      table(
        [{ header: "KEYS" }, { header: "COMMAND" }, { header: "WHEN" }],
        bindings.map((b) => [c.cyan(b.keys), b.command, c.dim(b.when ?? "")]),
      ),
    );
    if (conflicts.length) {
      lines.push("");
      lines.push(c.yellow(`⚠ ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`));
      for (const cf of conflicts) {
        lines.push(`  ${c.red(cf.keys)} → ${cf.commands.join(c.dim(" / "))}`);
      }
    } else {
      lines.push("");
      lines.push(c.dim("no conflicts"));
    }
    return { text: lines.join("\n"), exitCode: 0 };
  }

  // bare list: the built-in presets + binding counts, default marked.
  const maps = settings.BUILTIN_KEYMAPS;
  if (ctx.json) {
    return {
      json: {
        ok: true,
        default: settings.DEFAULT_KEYMAP_ID,
        keymaps: maps.map((k) => ({ id: k.id, label: k.label, bindings: k.bindings.length })),
      },
      exitCode: 0,
    };
  }
  const lines = [heading(`Keymaps  ${c.dim(`(${maps.length})`)}`), ""];
  lines.push(
    table(
      [{ header: "ID" }, { header: "LABEL" }, { header: "BINDINGS" }, { header: "" }],
      maps.map((k) => [
        c.bold(k.id),
        k.label,
        c.dim(String(k.bindings.length)),
        k.id === settings.DEFAULT_KEYMAP_ID ? c.green("default") : "",
      ]),
    ),
  );
  lines.push("");
  lines.push(c.dim("inspect one with: prometheus keymap list --preset <id>"));
  return { text: lines.join("\n"), exitCode: 0 };
}
