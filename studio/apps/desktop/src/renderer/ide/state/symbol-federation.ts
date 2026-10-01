// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/symbol-federation.ts — PURE merge/dedupe for Cmd-T workspace-symbol federation
 * across every live LSP server (APP-077). DOM/monaco-free so it is node:test-able; the palette
 * fans `workspace/symbol` out, tags each batch with the owning server's language, and merges here.
 */

/** One federated workspace symbol — a `WsSymbol` plus the owning server's language tag. */
export interface FedSymbol {
  name: string;
  container: string;
  uri: string;
  line: number;
  character: number;
  /** the languageId of the server that reported it (the row's badge). */
  lang: string;
}

/**
 * Canonicalize a symbol uri for the dedup key: decode percent-encoding + lower-case a Windows
 * drive letter (`file:///C%3A/` and `file:///c:/` from two servers must collapse to one).
 */
export function normalizeSymbolUri(uri: string): string {
  let u = uri;
  try {
    u = decodeURIComponent(uri);
  } catch {
    /* keep raw on a bad-encoding uri */
  }
  return u.replace(
    /^(file:\/\/\/)([a-zA-Z]):/i,
    (_m, p: string, d: string) => `${p}${d.toLowerCase()}:`,
  );
}

/**
 * The dedup key: normalized uri + name + container, plus the line ONLY when a real range is
 * present (a resolve-deferred WorkspaceSymbol has line 0 — keying on 0 would wrongly separate
 * it from the resolved copy). Two servers reporting the same declaration collapse to one row.
 */
export function symbolKey(s: FedSymbol): string {
  const base = `${normalizeSymbolUri(s.uri)}|${s.name}|${s.container}`;
  return s.line > 0 ? `${base}|${s.line}` : base;
}

/**
 * Merge per-server symbol batches into one deduped list. Input order is preserved (seed the
 * per-server batches in `list()` order for reproducible tie-breaking); the FIRST occurrence of a
 * key wins (server-list order = priority). The palette's fuzzy scorer ranks the merged list after.
 */
export function mergeFederatedSymbols(
  batches: readonly { lang: string; symbols: readonly Omit<FedSymbol, "lang">[] }[],
): FedSymbol[] {
  const seen = new Set<string>();
  const out: FedSymbol[] = [];
  for (const batch of batches) {
    for (const s of batch.symbols) {
      const fed: FedSymbol = { ...s, lang: batch.lang };
      const key = symbolKey(fed);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fed);
    }
  }
  return out;
}
