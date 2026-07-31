/**
 * ide/state/diagnostics.ts — the PURE LSP-diagnostics aggregate (file 07 §3.3/§11).
 *
 * `Problems.tsx` aggregates LSP diagnostics across every open file; the status spine
 * shows the error/warning totals. LSP `publishDiagnostics` arrives per-uri over the
 * `ide:event` feed (channel "lsp.diagnostics"); this module folds those pushes into
 * a per-uri map and projects the flat, sorted Problems list + the badge counts. It
 * is debounced (250 ms, §11) IN THE COMPONENT — the math here is pure + immediate.
 *
 * Framework-free — NO monaco / react — and works over the LSP wire shape (a subset
 * of the protocol) so it is testable in isolation. Node built-ins only.
 */

/** LSP DiagnosticSeverity (1=Error 2=Warning 3=Information 4=Hint). */
export type DiagnosticSeverity = 1 | 2 | 3 | 4;

/** A 0-based position (LSP shape). */
export interface DiagPosition {
  line: number;
  character: number;
}

/** One LSP diagnostic (the subset Problems renders). */
export interface Diagnostic {
  range: { start: DiagPosition; end: DiagPosition };
  message: string;
  severity?: DiagnosticSeverity;
  source?: string;
  code?: string | number;
}

/** The per-uri diagnostics map (the store's diagnostics slice). */
export type DiagnosticsByUri = Record<string, Diagnostic[]>;

/** A flattened Problems-list row (one diagnostic + its file). */
export interface ProblemRow {
  uri: string;
  /** display basename for the row (precomputed). */
  name: string;
  line: number; // 0-based
  character: number; // 0-based
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  /** the rule code (with `source`, forms the inspection id for profile overrides). */
  code?: string | number;
}

/** The error/warning/info/hint tallies (the Problems header + status spine). */
export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  total: number;
}

/** Replace one uri's diagnostics (LSP publishDiagnostics is authoritative per-uri). */
export function setDiagnostics(
  state: DiagnosticsByUri,
  uri: string,
  diagnostics: Diagnostic[],
): DiagnosticsByUri {
  if (diagnostics.length === 0) {
    if (!(uri in state)) return state;
    const next = { ...state };
    delete next[uri];
    return next;
  }
  return { ...state, [uri]: diagnostics };
}

/** Drop a uri's diagnostics entirely (file closed). */
export function clearDiagnostics(state: DiagnosticsByUri, uri: string): DiagnosticsByUri {
  if (!(uri in state)) return state;
  const next = { ...state };
  delete next[uri];
  return next;
}

/** Default an absent severity to Error (LSP says absent ⇒ implementation-defined; we fail loud). */
function sev(d: Diagnostic): DiagnosticSeverity {
  return d.severity ?? 1;
}

const SCHEME = "file://";

function basename(uri: string): string {
  const noScheme = uri.startsWith(SCHEME) ? uri.slice(SCHEME.length) : uri;
  const idx = Math.max(noScheme.lastIndexOf("/"), noScheme.lastIndexOf("\\"));
  return idx === -1 ? noScheme : noScheme.slice(idx + 1);
}

/**
 * Project the per-uri map into the flat Problems list, sorted by uri, then line, then
 * column (the §11 virtualized list order). Errors and warnings interleave by position
 * within a file (VS Code orders by location, not severity). Pure + deterministic.
 */
export function toProblemRows(state: DiagnosticsByUri): ProblemRow[] {
  const rows: ProblemRow[] = [];
  for (const uri of Object.keys(state).sort()) {
    const name = basename(uri);
    for (const d of state[uri] ?? []) {
      rows.push({
        uri,
        name,
        line: d.range.start.line,
        character: d.range.start.character,
        message: d.message,
        severity: sev(d),
        ...(d.source ? { source: d.source } : {}),
        ...(d.code !== undefined ? { code: d.code } : {}),
      });
    }
  }
  rows.sort((a, b) => a.uri.localeCompare(b.uri) || a.line - b.line || a.character - b.character);
  return rows;
}

/** Tally severities across all open files (the badge + status spine). */
export function countDiagnostics(state: DiagnosticsByUri): DiagnosticCounts {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let hints = 0;
  for (const list of Object.values(state)) {
    for (const d of list) {
      switch (sev(d)) {
        case 1:
          errors++;
          break;
        case 2:
          warnings++;
          break;
        case 3:
          infos++;
          break;
        default:
          hints++;
      }
    }
  }
  return { errors, warnings, infos, hints, total: errors + warnings + infos + hints };
}

/** A short status-spine label like "3 ⚠ · 1 ✖" (empty when clean). */
export function diagnosticsSummary(counts: DiagnosticCounts): string {
  const parts: string[] = [];
  if (counts.errors > 0) parts.push(`${counts.errors} ✖`);
  if (counts.warnings > 0) parts.push(`${counts.warnings} ⚠`);
  return parts.join(" · ");
}
