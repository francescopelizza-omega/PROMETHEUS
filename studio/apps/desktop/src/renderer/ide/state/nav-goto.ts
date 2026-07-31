/**
 * ide/state/nav-goto.ts — PURE LSP→navigation mapping for the Go-to family (APP-075).
 *
 * Go-to-super (typeHierarchy supertypes) + related-symbol (implementation ∪ typeDefinition ∪
 * supertypes) reduce to mapping LSP `Location`/`LocationLink`/`TypeHierarchyItem` shapes into a
 * flat, DEDUPED list of navigable targets. DOM/monaco-free so it is node:test-able; EditorPane
 * feeds raw `lspRequest` results in and navigates the chosen `NavTarget`.
 */

/** A resolved navigation target (0-based line, 1-based column — matches useNavStore). */
export interface NavTarget {
  uri: string;
  line: number;
  column: number;
  /** picker label, kind-prefixed (e.g. "super: Base", "impl: Foo"). */
  label: string;
}

/** Normalize a uri for dedup — decode percent-encoding (servers differ on `file:///C%3A/…`). */
export function normalizeUri(uri: string): string {
  try {
    return decodeURIComponent(uri).replace(/\/+$/, "");
  } catch {
    return uri;
  }
}

interface LspPos {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPos;
  end?: LspPos;
}

/**
 * Map ONE LSP result item — a `Location`, a `LocationLink`, or a `TypeHierarchyItem` — into a
 * `NavTarget`. Handles all three shapes (LocationLink uses `targetUri`/`targetSelectionRange`;
 * the others use `uri` + `selectionRange`||`range`). Returns null for an unrecognizable item.
 */
export function itemToNavTarget(item: unknown, kind: string): NavTarget | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const uri =
    typeof o.targetUri === "string" ? o.targetUri : typeof o.uri === "string" ? o.uri : null;
  if (!uri) return null;
  const range = (o.targetSelectionRange ?? o.selectionRange ?? o.targetRange ?? o.range) as
    | LspRange
    | undefined;
  const start = range?.start;
  if (!start || typeof start.line !== "number" || typeof start.character !== "number") return null;
  const name = typeof o.name === "string" ? o.name : uri.split(/[/\\]/).pop() || uri;
  return { uri, line: start.line, column: start.character + 1, label: `${kind}: ${name}` };
}

/** Map an array of same-kind LSP items → NavTargets (drops malformed). */
export function itemsToNavTargets(items: unknown, kind: string): NavTarget[] {
  if (!Array.isArray(items)) return [];
  const out: NavTarget[] = [];
  for (const it of items) {
    const t = itemToNavTarget(it, kind);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Aggregate multiple kinded LSP result sets (implementation / typeDefinition / supertypes)
 * into one deduped picker list. Dedup key = normalized uri + line + column (NOT uri alone —
 * providers commonly return the same location); the FIRST kind to yield a location wins its label.
 */
export function aggregateRelated(
  sources: readonly { kind: string; items: unknown }[],
): NavTarget[] {
  const seen = new Set<string>();
  const out: NavTarget[] = [];
  for (const s of sources) {
    for (const t of itemsToNavTargets(s.items, s.kind)) {
      const key = `${normalizeUri(t.uri)}:${t.line}:${t.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}
