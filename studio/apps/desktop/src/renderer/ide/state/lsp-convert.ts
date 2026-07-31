/**
 * ide/state/lsp-convert.ts — PURE LSP↔Monaco translation helpers (file 07 §4, leap #3).
 *
 * The editor proxies a real language server over the generic `ide.lspRequest` IPC. The
 * server speaks LSP (0-based positions, its own SymbolKind/CompletionItemKind enums,
 * Location | LocationLink | DocumentSymbol | SymbolInformation shapes); Monaco speaks
 * its own. These converters do the fiddly mapping with NO monaco/react import (the
 * enum *targets* are injected so they stay unit-testable under node:test) — EditorPane
 * wraps the results in monaco.Range/monaco.Uri. Total + defensive: a malformed server
 * payload yields an empty/None result, never a throw (the renderer decides nothing).
 */

/** An LSP position (0-based line + character). */
export interface LspPosition {
  line: number;
  character: number;
}
/** An LSP range. */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Monaco 1-based position → LSP 0-based position. */
export function toLspPosition(p: { lineNumber: number; column: number }): LspPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

/** Monaco 1-based selection → LSP 0-based range. */
export function toLspRange(r: {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}): LspRange {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  };
}

/* ── enum name tables (LSP kind number → name; Monaco enums are keyed by these names) ─ */

/** LSP CompletionItemKind (1-based) → name. The names match Monaco's enum keys. */
export const LSP_COMPLETION_KIND_NAMES: readonly string[] = [
  "Text",
  "Method",
  "Function",
  "Constructor",
  "Field",
  "Variable",
  "Class",
  "Interface",
  "Module",
  "Property",
  "Unit",
  "Value",
  "Enum",
  "Keyword",
  "Snippet",
  "Color",
  "File",
  "Reference",
  "Folder",
  "EnumMember",
  "Constant",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
];

/** LSP SymbolKind (1-based) → name. The names match Monaco's SymbolKind enum keys. */
export const LSP_SYMBOL_KIND_NAMES: readonly string[] = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
];

/** Resolve an LSP CompletionItemKind to a Monaco enum value (falls back to Text). */
export function monacoCompletionKind(enumObj: Record<string, number>, lspKind: unknown): number {
  const name =
    typeof lspKind === "number" && lspKind >= 1 && lspKind <= LSP_COMPLETION_KIND_NAMES.length
      ? LSP_COMPLETION_KIND_NAMES[lspKind - 1]
      : undefined;
  if (name && enumObj[name] !== undefined) return enumObj[name];
  return enumObj.Text ?? 0;
}

/** Resolve an LSP SymbolKind to a Monaco enum value (falls back to Variable). */
export function monacoSymbolKind(enumObj: Record<string, number>, lspKind: unknown): number {
  const name =
    typeof lspKind === "number" && lspKind >= 1 && lspKind <= LSP_SYMBOL_KIND_NAMES.length
      ? LSP_SYMBOL_KIND_NAMES[lspKind - 1]
      : undefined;
  if (name && enumObj[name] !== undefined) return enumObj[name];
  return enumObj.Variable ?? 0;
}

/** Whether an LSP completion item's insertTextFormat is Snippet (2). */
export function isSnippet(insertTextFormat: unknown): boolean {
  return insertTextFormat === 2;
}

/* ── shape normalizers (defensive — accept the union forms, drop the malformed) ───── */

/** A normalized location: a target uri + the (LSP) range to reveal. */
export interface NormalizedLocation {
  uri: string;
  range: LspRange;
}

function isLspRange(r: unknown): r is LspRange {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  const pos = (p: unknown): boolean =>
    !!p && typeof p === "object" && typeof (p as LspPosition).line === "number";
  return pos(o.start) && pos(o.end);
}

/**
 * Normalize the result of textDocument/definition|references|declaration|implementation:
 * Location | Location[] | LocationLink | LocationLink[] | null → NormalizedLocation[].
 */
export function normalizeLocations(result: unknown): NormalizedLocation[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  const out: NormalizedLocation[] = [];
  for (const loc of arr) {
    if (!loc || typeof loc !== "object") continue;
    const o = loc as Record<string, unknown>;
    // LocationLink: targetUri + targetSelectionRange/targetRange. Location: uri + range.
    const uri = (o.targetUri ?? o.uri) as unknown;
    const range = (o.targetSelectionRange ?? o.targetRange ?? o.range) as unknown;
    if (typeof uri === "string" && isLspRange(range)) out.push({ uri, range });
  }
  return out;
}

/** A normalized text edit (an LSP range + the replacement text). */
export interface NormalizedTextEdit {
  range: LspRange;
  newText: string;
}

/** Normalize a textDocument/formatting|rangeFormatting result (TextEdit[] | null). */
export function normalizeTextEdits(result: unknown): NormalizedTextEdit[] {
  if (!Array.isArray(result)) return [];
  const out: NormalizedTextEdit[] = [];
  for (const e of result) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (isLspRange(o.range)) out.push({ range: o.range, newText: String(o.newText ?? "") });
  }
  return out;
}

/** A normalized document symbol (hierarchical; flat SymbolInformation is lifted to this). */
export interface NormalizedSymbol {
  name: string;
  detail: string;
  kind: unknown;
  range: LspRange;
  selectionRange: LspRange;
  children: NormalizedSymbol[];
}

/**
 * Normalize a textDocument/documentSymbol result. Accepts the hierarchical
 * DocumentSymbol[] (range/selectionRange/children) AND the flat SymbolInformation[]
 * (location.range, containerName). Anything malformed is dropped.
 */
export function normalizeSymbols(result: unknown): NormalizedSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: NormalizedSymbol[] = [];
  for (const s of result) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (isLspRange(o.range) && isLspRange(o.selectionRange)) {
      // hierarchical DocumentSymbol
      out.push({
        name: String(o.name ?? ""),
        detail: typeof o.detail === "string" ? o.detail : "",
        kind: o.kind,
        range: o.range,
        selectionRange: o.selectionRange,
        children: normalizeSymbols(o.children),
      });
    } else {
      // flat SymbolInformation → lift location.range to both ranges
      const loc = o.location as Record<string, unknown> | undefined;
      if (loc && isLspRange(loc.range)) {
        out.push({
          name: String(o.name ?? ""),
          detail: typeof o.containerName === "string" ? o.containerName : "",
          kind: o.kind,
          range: loc.range,
          selectionRange: loc.range,
          children: [],
        });
      }
    }
  }
  return out;
}

/** Flatten an LSP documentation/markup field to a Markdown string ("" when empty). */
export function docToMarkdown(documentation: unknown): string {
  if (typeof documentation === "string") return documentation;
  if (documentation && typeof documentation === "object") {
    const v = (documentation as { value?: unknown }).value;
    if (typeof v === "string") return v;
  }
  return "";
}
