/**
 * shell/rightrail-view.ts — PURE display helpers for the RightRail Inspector (APP-001).
 *
 * Split out of RightRail.tsx (JSX can't be imported by the node:test runner's native
 * TS type-stripping — no JSX transform is wired for node:test) so this stays unit
 * testable, matching the settings-view.ts / lsp-convert.ts convention.
 */

const INSPECTOR_MAX_CHARS = 20_000;

/**
 * Stringify the Inspector payload defensively: a serialization cycle/getter-throw
 * never crashes the shell (the payload wraps opaque IPC/engine-store data, not
 * guaranteed acyclic), and a huge payload is capped rather than freezing the pane.
 */
export function safeInspectorJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "null";
  } catch (e) {
    return `<failed to serialize: ${e instanceof Error ? e.message : String(e)}>`;
  }
  return text.length > INSPECTOR_MAX_CHARS
    ? `${text.slice(0, INSPECTOR_MAX_CHARS)}\n… truncated (${text.length} chars total)`
    : text;
}
