// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * editor/templates.ts — new-file + copyright-header templates (APP-028, MDS parity 07).
 *
 * PURE string builders for the editor's Generate menu: `fileTemplate(kind, vars)`
 * seeds a new file and `copyrightHeader(style, vars)` renders a comment-style-aware
 * header for insertion at the top of an existing file. Both are plain functions of
 * their inputs (NO fs/electron/monaco — safe for the C5 renderer via the
 * `@prometheus/core/editor` subpath) and both flow through the SAME WorkspaceEdit →
 * preview → apply path as every other generator: nothing here writes anything.
 *
 * Substitution: `{year}`, `{owner}` and `{filename}` tokens are replaced from
 * `vars`; a token whose var is absent falls back ({year} → the current year,
 * {owner} → "", {filename} → "untitled"). Unknown `{...}` sequences pass through
 * verbatim (they may be real content, e.g. Python f-string braces).
 */

/** The supported template/comment dialects (monaco languageIds map via
 *  `templateKindForLanguage`). */
export type TemplateKind = "python" | "typescript" | "plain";

/** `{token}` substitution values. `year` accepts a number for convenience. */
export interface TemplateVars {
  year?: string | number;
  owner?: string;
  filename?: string;
}

/** The kinds surfaced by pickers, in display order. */
export const TEMPLATE_KINDS: readonly TemplateKind[] = ["python", "typescript", "plain"];

/** monaco/LSP languageId → template dialect (unknown ids degrade to "plain"). */
export function templateKindForLanguage(languageId: string | undefined): TemplateKind {
  switch (languageId) {
    case "python":
      return "python";
    case "typescript":
    case "javascript":
    case "typescriptreact":
    case "javascriptreact":
      return "typescript";
    default:
      return "plain";
  }
}

function substitute(text: string, vars: TemplateVars): string {
  const year = vars.year !== undefined ? String(vars.year) : String(new Date().getFullYear());
  const owner = vars.owner ?? "";
  const filename = vars.filename ?? "untitled";
  // token-by-token (no re-scan): an owner containing "{filename}" stays literal.
  return text.replace(/\{(year|owner|filename)\}/g, (_m, key: string) =>
    key === "year" ? year : key === "owner" ? owner : filename,
  );
}

const FILE_TEMPLATES: Record<TemplateKind, string> = {
  python:
    '"""{filename} — TODO: describe."""\n' +
    "\n\n" +
    "def main() -> None:\n" +
    "    pass\n" +
    "\n\n" +
    'if __name__ == "__main__":\n' +
    "    main()\n",
  typescript: "/**\n * {filename} — TODO: describe.\n */\n\nexport {};\n",
  plain: "{filename}\n",
};

/** The full starting content for a NEW file of `kind` (delivered to the user as a
 *  WorkspaceEdit insert at 0:0 through the refactor preview — never written here). */
export function fileTemplate(kind: TemplateKind, vars: TemplateVars = {}): string {
  return substitute(FILE_TEMPLATES[kind] ?? FILE_TEMPLATES.plain, vars);
}

const COPYRIGHT_BODY = "Copyright (c) {year} {owner}. All rights reserved.";

const COPYRIGHT_HEADERS: Record<TemplateKind, string> = {
  python: `# ${COPYRIGHT_BODY}\n`,
  typescript: `/*\n * ${COPYRIGHT_BODY}\n */\n`,
  plain: `${COPYRIGHT_BODY}\n`,
};

/** A comment-style-aware copyright header line/block (trailing newline included, so
 *  inserting at line 0 char 0 never glues onto the first code line). */
export function copyrightHeader(style: TemplateKind, vars: TemplateVars = {}): string {
  return substitute(COPYRIGHT_HEADERS[style] ?? COPYRIGHT_HEADERS.plain, vars);
}

/**
 * The 0-based line where a header belongs in `text`: after a `#!` shebang (and a
 * following coding cookie for Python), else 0. Pure — the caller turns this into a
 * WorkspaceEdit position.
 */
export function headerInsertLine(text: string, style: TemplateKind): number {
  const lines = text.split("\n");
  let line = 0;
  if (lines[0]?.startsWith("#!")) line = 1;
  if (style === "python" && line < lines.length && /^#.*coding[:=]/.test(lines[line] ?? "")) {
    line += 1;
  }
  return line;
}
