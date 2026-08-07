// core exposes the REPL brain as a NAMESPACE (`export * as repl`), so PaneId /
// ReplState / footerLine live under `repl.*` — not as flat top-level exports.
import { repl } from "@prometheus/core";
/**
 * session/pane-render.ts — the P4 pane router (PURE string output).
 *
 * The interactive single-window session shows ONE pane at a time (the Ctrl+G
 * cycle: transcript ↔ catalog ↔ env ↔ model ↔ repo, plus the deep panes vault /
 * audit / matrix / skills / scan). This module is the single dispatch point that
 * turns a (paneId, model) pair into the multi-line string the host writes.
 *
 * It owns NO data of its own and decides NOTHING about safety: it forwards each
 * pane's payload to the matching P3 projector in ../render/* (the same projectors
 * the one-shot CLI prints), and renders the chat/transcript pane itself from the
 * repl ReplState + footerLine. Everything is pure — given the same model it always
 * returns the same string, so it is trivially testable with no engine, no TTY.
 *
 * Crash-safety: a pane with no payload (or a pane that has no dedicated projector
 * yet) renders a quiet placeholder line instead of throwing, so a session turn can
 * never crash because the active pane has nothing to show.
 */
import type {
  CatalogEntry,
  HardenFinding,
  MatrixEnvelope,
  OpenModelRow,
  SecurityVerdict,
} from "@prometheus/engine-bridge";

import { c, heading, sym } from "../render.js";
import { type ItemCard, renderCatalogList, renderItemCard } from "../render/catalog-view.js";
import { renderHardenFindings } from "../render/harden-view.js";
import { renderModelPicker } from "../render/model-picker.js";
import { renderReachMatrix } from "../render/reach-matrix.js";
import { renderVerdictSheet } from "../render/verdict-sheet.js";

// ---- pane model ------------------------------------------------------------ //

/**
 * The payload a single pane renders. A discriminated union keyed by `pane` so the
 * dispatch is exhaustive and type-safe: each branch carries exactly the engine
 * shape its projector consumes. `transcript` carries the live ReplState (the chat
 * pane is rendered here, not by a ../render/* projector).
 *
 * Panes without a dedicated P3 projector this wave (env/repo/app/worldsim) use the
 * generic `text` model so the session can still show them without crashing.
 */
export type PaneModel =
  | { pane: "transcript"; state: repl.ReplState }
  | { pane: "catalog"; items: CatalogEntry[]; focus?: ItemCard }
  | { pane: "model"; models: OpenModelRow[] }
  | { pane: "matrix"; matrix: MatrixEnvelope }
  | { pane: "audit"; verdict: SecurityVerdict }
  | { pane: "scan"; verdict: SecurityVerdict }
  | { pane: "vault"; findings: HardenFinding[] }
  | { pane: "skills"; verdict: SecurityVerdict }
  | { pane: "env"; text?: string }
  | { pane: "repo"; text?: string }
  | { pane: "app"; text?: string }
  | { pane: "worldsim"; text?: string };

export interface RenderPaneOptions {
  /** Session-host width hint (forward-compat; not yet forwarded into projectors). */
  width?: number;
  /** Suppress the pane title line (the host may draw its own chrome). */
  noTitle?: boolean;
}

// Human title for each pane id (the §3 single-window header).
const PANE_TITLES: Record<repl.PaneId, string> = {
  transcript: "Chat",
  catalog: "Catalog",
  env: "Environment",
  model: "Models",
  repo: "Repository",
  app: "Apps",
  worldsim: "World Sim",
  vault: "Vault",
  audit: "Audit",
  matrix: "Reach Matrix",
  skills: "Skills",
  scan: "Scan",
};

/** The pane title line ("== Catalog =="-ish, but quiet), or "" when suppressed. */
function paneTitle(paneId: repl.PaneId, opts: RenderPaneOptions): string {
  if (opts.noTitle) return "";
  const label = PANE_TITLES[paneId] ?? paneId;
  return heading(`${sym.bullet()} ${label}`);
}

// ---- dispatch -------------------------------------------------------------- //

/**
 * Render one pane to a multi-line string (no trailing newline).
 *
 * Dispatches by `model.pane` to the matching P3 projector; renders the chat pane
 * (transcript + footer) directly. If `paneId` and `model.pane` disagree, the
 * MODEL wins (it carries the actual data) — paneId is only used for the title.
 */
export function renderPane(
  paneId: repl.PaneId,
  model: PaneModel,
  opts: RenderPaneOptions = {},
): string {
  const title = paneTitle(paneId, opts);
  const body = renderBody(model);
  return title ? `${title}\n${body}` : body;
}

// Projectors are called with NO opts: the fixed cross-unit contract only pins
// `(payload, opts?)` with an OPTIONAL opts, so we stay decoupled from whatever
// option shape each ../render/* projector chooses. `RenderPaneOptions.width` is a
// session-host chrome hint kept for forward-compat, not forwarded into projectors.
function renderBody(model: PaneModel): string {
  switch (model.pane) {
    case "transcript":
      return renderTranscript(model.state);
    case "catalog":
      // A focused entry shows its full card; otherwise the scannable list.
      return model.focus ? renderItemCard(model.focus) : renderCatalogList(model.items);
    case "model":
      return renderModelPicker(model.models);
    case "matrix":
      return renderReachMatrix(model.matrix);
    case "audit":
    case "scan":
    case "skills":
      // All three are SecurityVerdict panes — same sheet projector.
      return renderVerdictSheet(model.verdict);
    case "vault":
      return renderHardenFindings(model.findings);
    case "env":
    case "repo":
    case "app":
    case "worldsim":
      return renderPlaceholder(model.pane, model.text);
    default:
      // Exhaustiveness guard: a new pane added to the union without a branch is a
      // type error here, but at runtime we still degrade gracefully.
      return renderPlaceholder((model as { pane: repl.PaneId }).pane, undefined);
  }
}

// ---- chat / transcript pane ------------------------------------------------ //

/** Color a transcript speaker label by role. */
function speaker(role: repl.ReplState["transcript"][number]["role"]): string {
  switch (role) {
    case "you":
      return c.role("you", "accent");
    case "prometheus":
      return c.role("prometheus", "brand");
    default:
      return c.dim("system");
  }
}

/**
 * Render the chat pane: the transcript lines followed by the §3.1 tuning footer.
 * An empty transcript shows a gentle prompt instead of a blank pane.
 */
function renderTranscript(state: repl.ReplState): string {
  const out: string[] = [];
  if (state.transcript.length === 0) {
    out.push(c.dim("No messages yet — type a prompt to start, or /help for commands."));
  } else {
    for (const msg of state.transcript) {
      // Prefix only the first physical line; continuation lines align under it.
      const lines = msg.text.split("\n");
      const head = lines[0] ?? "";
      out.push(`${speaker(msg.role)} ${head}`);
      for (const cont of lines.slice(1)) out.push(`     ${cont}`);
    }
  }
  out.push("");
  out.push(c.dim(repl.footerLine(state.tuning)));
  return out.join("\n");
}

// ---- placeholder ----------------------------------------------------------- //

/** A quiet line for panes that have no dedicated projector this wave. */
function renderPlaceholder(pane: repl.PaneId, text: string | undefined): string {
  if (text?.trim()) return text;
  const label = PANE_TITLES[pane] ?? pane;
  return c.dim(`${label} — nothing to show yet. Run the matching command to populate this pane.`);
}
