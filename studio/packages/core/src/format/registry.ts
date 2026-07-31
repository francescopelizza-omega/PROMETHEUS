/**
 * format/registry.ts — formatter presets + format-on-save policy (file 14 §3.5).
 *
 * Shipped formatter presets (the opencode set: prettier/biome/ruff/gofmt/rustfmt/shfmt),
 * format-on-save + format-after-AI-edit, and a custom-formatter config (`$FILE`). PURE,
 * settings-data (like 12's provider matrix): an ext→formatter map + the policy + the
 * argv builder. Each formatter is an EXECUTED command → the caller registers it with the
 * nemesis gate (C12) like External Tools / File Watchers; this only builds the argv.
 */

/** A formatter preset (command template; `$FILE` is the target). */
export interface FormatterPreset {
  id: string;
  /** the binary to run (resolved on PATH / in the env by the caller). */
  command: string;
  /** argv template; the literal "$FILE" is replaced with the target path. */
  args: string[];
  /** file extensions this formatter handles (no dot). */
  exts: string[];
  /** true ⇒ the formatter reads stdin + writes stdout (no in-place file write). */
  stdin?: boolean;
}

/** The shipped opencode formatter set (§3.5). */
export const BUILTIN_FORMATTERS: readonly FormatterPreset[] = Object.freeze([
  {
    id: "prettier",
    command: "prettier",
    args: ["--write", "$FILE"],
    exts: ["js", "jsx", "ts", "tsx", "json", "css", "scss", "html", "md", "yaml", "yml"],
  },
  {
    id: "biome",
    command: "biome",
    args: ["format", "--write", "$FILE"],
    exts: ["js", "jsx", "ts", "tsx", "json", "jsonc"],
  },
  { id: "ruff", command: "ruff", args: ["format", "$FILE"], exts: ["py", "pyi"] },
  { id: "gofmt", command: "gofmt", args: ["-w", "$FILE"], exts: ["go"] },
  { id: "rustfmt", command: "rustfmt", args: ["$FILE"], exts: ["rs"] },
  { id: "shfmt", command: "shfmt", args: ["-w", "$FILE"], exts: ["sh", "bash"] },
]);

/** Normalize a filename/ext to a bare lowercase extension. */
export function extOf(fileOrExt: string): string {
  const base = fileOrExt.split("/").pop() ?? fileOrExt;
  const dot = base.lastIndexOf(".");
  return (dot === -1 ? base : base.slice(dot + 1)).toLowerCase();
}

/** Find the FIRST builtin formatter that handles an extension. */
export function formatterForExt(
  ext: string,
  presets: readonly FormatterPreset[] = BUILTIN_FORMATTERS,
): FormatterPreset | undefined {
  const e = extOf(ext);
  return presets.find((p) => p.exts.includes(e));
}

/** The format-on-save / after-edit policy + per-ext overrides (§3.5; settings-data). */
export interface FormatPolicy {
  onSave: boolean;
  afterAiEdit: boolean;
  /** override the formatter id for specific extensions ("ts" → "biome"). */
  byExt?: Record<string, string>;
  /** extensions explicitly disabled from formatting. */
  disabledExts?: string[];
  /** per-LANGUAGE enable flags (langId → enabled). A `false` suppresses format-on-save
   *  for that language only; a missing/`true` entry leaves it enabled (APP-019). */
  byLang?: Record<string, boolean>;
  /** run LSP `source.organizeImports` before the format-on-save write (APP-019). */
  optimizeImportsOnSave?: boolean;
}

/** The default policy (off until the user opts in — no surprise reformatting). */
export const DEFAULT_FORMAT_POLICY: FormatPolicy = { onSave: false, afterAiEdit: true };

/** Is a language enabled for format-on-save under this policy? A per-language `false`
 *  flag suppresses it; the language is enabled otherwise (APP-019 — the LSP-format gate,
 *  independent of whether an external `resolveFormatter` preset exists for the ext). */
export function formatOnSaveEnabled(
  langId: string,
  policy: FormatPolicy = DEFAULT_FORMAT_POLICY,
): boolean {
  return policy.onSave === true && policy.byLang?.[langId] !== false;
}

/** Resolve the formatter for a file under a policy (override → default; honors disable). */
export function resolveFormatter(
  fileOrExt: string,
  policy: FormatPolicy = DEFAULT_FORMAT_POLICY,
  presets: readonly FormatterPreset[] = BUILTIN_FORMATTERS,
): FormatterPreset | undefined {
  const e = extOf(fileOrExt);
  if (policy.disabledExts?.includes(e)) return undefined;
  const overrideId = policy.byExt?.[e];
  if (overrideId) return presets.find((p) => p.id === overrideId);
  return formatterForExt(e, presets);
}

/** Whether to format on save for this file with an EXTERNAL formatter preset (§3.5).
 *  `lang`, when given, is gated by the per-language flags (APP-019) BEFORE the
 *  external-preset lookup — a per-language `false` suppresses it regardless of preset. */
export function shouldFormatOnSave(
  fileOrExt: string,
  policy: FormatPolicy = DEFAULT_FORMAT_POLICY,
  lang?: string,
): boolean {
  if (lang !== undefined && policy.byLang?.[lang] === false) return false;
  return policy.onSave && resolveFormatter(fileOrExt, policy) !== undefined;
}

/** Whether to format after an accepted AI edit (§3.5 — runs on trusted local files). */
export function shouldFormatAfterEdit(
  fileOrExt: string,
  policy: FormatPolicy = DEFAULT_FORMAT_POLICY,
): boolean {
  return policy.afterAiEdit && resolveFormatter(fileOrExt, policy) !== undefined;
}

/** Build the concrete argv for a formatter against a file ($FILE substituted). */
export function buildFormatArgv(preset: FormatterPreset, file: string): string[] {
  return [
    preset.command,
    ...preset.args.map((a) => (a === "$FILE" ? file : a.replaceAll("$FILE", file))),
  ];
}
