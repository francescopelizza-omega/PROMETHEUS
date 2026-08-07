/**
 * ai/slash.ts — PURE slash-command detection + filtering for the AgentPane composer (APP-092).
 *
 * Typing `/` at the START of the composer opens a filterable command popup fed by the shell
 * command registry (mirrors the prometheus TUI `/` autocomplete). This owns the caret math + the
 * fuzzy filter — no react/registry import, so it is node:test-able. The AgentPane feeds it the
 * registry rows and executes the picked command via its `onRunCommand` prop.
 */

/** A command row the popup renders (a subset of the shell registry's palette row). */
export interface SlashCommand {
  id: string;
  title: string;
  category?: string;
}

/**
 * The active slash query, or null when the composer is not in a slash command. A slash
 * command occupies the WHOLE composer: the text must start with `/` and the command token
 * must not yet be terminated by a space/newline (after which the text is a normal message,
 * e.g. a path like `/etc/hosts` pasted mid-sentence never triggers because it has spaces or
 * isn't at position 0). Returns "" immediately after a lone `/`.
 */
export function activeSlashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  if (rest.includes(" ") || rest.includes("\n")) return null;
  return rest;
}

/**
 * Filter + rank the command rows for `query` (case-insensitive). An empty query returns the
 * first `limit` rows (the full menu). A title/id prefix ranks above a mere substring hit.
 */
export function filterSlashCommands(
  rows: readonly SlashCommand[],
  query: string,
  limit = 12,
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice(0, limit);
  const scored = rows
    .map((r) => {
      const title = r.title.toLowerCase();
      const id = r.id.toLowerCase();
      let score = -1;
      if (title.startsWith(q) || id.startsWith(q)) score = 3;
      else if (title.includes(q) || id.includes(q)) score = 1;
      return { r, score };
    })
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score || a.r.title.localeCompare(b.r.title));
  return scored.slice(0, limit).map((s) => s.r);
}

/** Clamp the active highlight index into the match list (wrapping). */
export function clampSlashIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}
