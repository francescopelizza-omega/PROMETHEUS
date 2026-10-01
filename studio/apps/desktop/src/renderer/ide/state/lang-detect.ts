// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/lang-detect.ts — the PURE file→languageId detector (file 07 §3.1).
 *
 * The tabs store records each doc's `languageId` (Monaco's model language + the LSP
 * server key). This maps a path/uri to that id by extension (and a few well-known
 * filenames). Framework-free — NO monaco / react — so it is testable and reused by
 * both EditorPane (Monaco `setModelLanguage`) and the LSP-ensure call (the server
 * registry in core keys off the same id). Node built-ins only.
 */

/** Extension → Monaco/LSP languageId. Lowercased, no leading dot. */
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  toml: "toml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  css: "css",
  html: "html",
  htm: "html",
  txt: "plaintext",
};

/** Well-known basenames with no/odd extension. */
const NAME_LANG: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  "requirements.txt": "pip-requirements",
};

/** The basename of a path/uri (strips dirs + a file:// scheme). */
export function baseName(pathOrUri: string): string {
  const noScheme = pathOrUri.startsWith("file://") ? pathOrUri.slice("file://".length) : pathOrUri;
  const cleaned = noScheme.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

/** The lowercased extension WITHOUT the dot ("" when none). */
export function extOf(pathOrUri: string): string {
  const name = baseName(pathOrUri);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return ""; // no ext, or a dotfile like ".gitignore"
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Detect the languageId for a path/uri (file 07 §3.1). Checks the exact basename
 * first (Dockerfile/requirements.txt), then the extension, then falls back to
 * "plaintext". Total + deterministic.
 */
export function detectLanguage(pathOrUri: string): string {
  const name = baseName(pathOrUri);
  if (NAME_LANG[name]) return NAME_LANG[name];
  const ext = extOf(pathOrUri);
  return EXT_LANG[ext] ?? "plaintext";
}

/** Whether a languageId has a bundled/known LSP server (file 07 §4.1 — pyright/tsserver). */
export function hasKnownLsp(languageId: string): boolean {
  return languageId === "python" || languageId === "typescript" || languageId === "javascript";
}
