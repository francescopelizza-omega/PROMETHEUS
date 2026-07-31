/**
 * render/model-picker.ts — P3 ANSI projector for the open-model "picker" list,
 * built from `models browse` (ModelsBrowseEnvelope.models: OpenModelRow[]).
 *
 * This is PURE presentation over data the engine-bridge already produced (C5):
 * it never re-scores, fetches, or decides anything about safety/fit — it only
 * formats the OpenModelRow rows the picker shows. Color flows exclusively through
 * the §8.1 render helpers (`c.*`, never raw hex), and column widths use the
 * ANSI-safe `table()` so colored cells still align.
 *
 * DATA NOTE: the real OpenModelRow shape is
 *   { id, name, params, license, ollama, served, note }.
 * There is no separate "quant" or byte-"size" field on the engine row, so the
 * picker surfaces the honest columns it does have:
 *   - PARAMS   → the size/footprint proxy ("7B", "70B", …)
 *   - RUN      → how you run it locally: a local `ollama pull <tag>` ("local")
 *                vs a served-only endpoint ("served"); this is the "fit" hint.
 *   - LICENSE  → the model license.
 * The detailed `note` / `served` URL render in the per-row card, not the list.
 */
import type { OpenModelRow } from "@prometheus/engine-bridge";

import { c, heading, kv, sym, table } from "../render.js";

/** Options for the model-picker projector. */
export interface ModelPickerOpts {
  /** 0-based index of the currently-highlighted row (interactive picker). */
  selected?: number;
  /** Optional title above the table (default "Open models"). */
  title?: string;
}

/** How a model is run locally — drives the colored RUN badge ("fit" hint). */
type RunKind = "local" | "served" | "none";

/** Classify an OpenModelRow by how it can be run on this host. */
function runKind(m: OpenModelRow): RunKind {
  if (m.ollama.trim() !== "") return "local";
  if (m.served.trim() !== "") return "served";
  return "none";
}

/** A colored RUN badge: local pull (ok ●), served endpoint (info ▲), or none. */
function runBadge(kind: RunKind): string {
  switch (kind) {
    case "local":
      return `${sym.ok()} ${c.green("local")}`;
    case "served":
      return `${sym.warn()} ${c.yellow("served")}`;
    case "none":
      return `${sym.off()} ${c.dim("—")}`;
  }
}

/**
 * Render the open-model picker list to a multi-line string.
 *
 * Columns: a selection caret, NAME, PARAMS (size proxy), RUN (local/served fit
 * hint), and LICENSE. The selected row's name is highlighted. Returns the full
 * block (heading + table) with no trailing newline; `opts.selected` is clamped
 * and out-of-range / empty input renders a quiet "No models." line.
 */
export function renderModelPicker(models: OpenModelRow[], opts: ModelPickerOpts = {}): string {
  const title = opts.title ?? "Open models";
  const lines: string[] = [];
  lines.push(heading(`${title}  ${c.dim(`(${models.length})`)}`));

  if (models.length === 0) {
    lines.push("");
    lines.push(c.dim("No models."));
    return lines.join("\n");
  }

  // Clamp the selection into range so an interactive caller can never overshoot.
  const selected =
    opts.selected === undefined ? -1 : Math.max(0, Math.min(opts.selected, models.length - 1));

  lines.push("");
  const rows = models.map((m, i) => {
    const caret = i === selected ? c.cyan("›") : " ";
    const name = i === selected ? c.bold(m.name) : m.name;
    return [caret, name, c.dim(m.params || "—"), runBadge(runKind(m)), c.dim(m.license || "—")];
  });

  lines.push(
    table(
      [
        { header: "" },
        { header: "NAME" },
        { header: "PARAMS" },
        { header: "RUN" },
        { header: "LICENSE" },
      ],
      rows,
    ),
  );
  return lines.join("\n");
}

/**
 * Render a single model as a detail card (used when one row is opened from the
 * picker). Surfaces the `served` URL and the free-text `note` the list omits.
 */
export function renderModelCard(model: OpenModelRow): string {
  const lines: string[] = [];
  lines.push(heading(model.name));
  lines.push(kv("id", c.dim(model.id)));
  lines.push(kv("params", model.params || "—"));
  lines.push(kv("license", model.license || "—"));

  const kind = runKind(model);
  lines.push(kv("run", runBadge(kind)));
  if (model.ollama.trim() !== "") {
    lines.push(kv("ollama", c.cyan(`ollama pull ${model.ollama}`)));
  }
  if (model.served.trim() !== "") {
    lines.push(kv("served", c.dim(model.served)));
  }
  if (model.note.trim() !== "") {
    lines.push("");
    lines.push(c.dim(model.note));
  }
  return lines.join("\n");
}
