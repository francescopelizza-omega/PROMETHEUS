/**
 * ide/state/templates.ts — the live-templates registry (JetBrains Live Templates ·
 * VS Code snippets parity; plan file 08 / APP-020).
 *
 * A seeded set of expandable code templates keyed by abbreviation, across three kinds:
 * plain `live` abbreviations (LIVE_TEMPLATES), `postfix` `.abbrev` rewrites
 * (POSTFIX_TEMPLATES), and selection-surrounding `surround` wraps (SURROUND_TEMPLATES).
 * EditorPane registers Monaco completion providers that offer the MERGED registry
 * (`mergedTemplatesForLang` — seed layered under user templates) as snippet completions;
 * Monaco expands the `$1`/`${2:default}`/`$0` tabstops on accept. The `$NAME$` macro pass
 * (from @prometheus/core/templates) runs BEFORE Monaco, leaving those tabstops untouched.
 *
 * Keeping the registry PURE (no react/monaco) makes it node:test-able and reusable by the
 * prom CLI `/snippets` surface later. User templates persist via the APP-017 settings IPC
 * (template-store.ts) and layer over the seeds via the kind-scoped `mergeTemplates`.
 */

import type { LiveTemplateDef, LiveTemplateKind } from "@prometheus/core/templates";

export type { LiveTemplateDef, LiveTemplateKind } from "@prometheus/core/templates";

export interface LiveTemplate {
  /** the abbreviation the user types (then Ctrl-Space / Tab to expand). */
  abbrev: string;
  description: string;
  /** Monaco snippet syntax — `$1`, `${2:default}`, `$0` (final caret). */
  body: string;
  /** language ids this template applies to (must match Monaco/LSP_LANGS ids). */
  languages: string[];
}

const PY = ["python"];
const JS = ["javascript", "typescript", "javascriptreact", "typescriptreact"];

/** The built-in templates. Ordered roughly by frequency within a language. */
export const LIVE_TEMPLATES: readonly LiveTemplate[] = [
  // --- Python -------------------------------------------------------------------
  {
    abbrev: "main",
    description: 'if __name__ == "__main__" guard',
    body: 'if __name__ == "__main__":\n    ${1:main()}$0',
    languages: PY,
  },
  {
    abbrev: "def",
    description: "function definition",
    body: "def ${1:name}(${2:args}):\n    ${3:pass}$0",
    languages: PY,
  },
  {
    abbrev: "class",
    description: "class with __init__",
    body: "class ${1:Name}:\n    def __init__(self${2:, args}):\n        ${3:pass}$0",
    languages: PY,
  },
  {
    abbrev: "for",
    description: "for loop",
    body: "for ${1:item} in ${2:iterable}:\n    ${3:pass}$0",
    languages: PY,
  },
  {
    abbrev: "try",
    description: "try/except",
    body: "try:\n    ${1:pass}\nexcept ${2:Exception} as ${3:exc}:\n    ${4:raise}$0",
    languages: PY,
  },
  {
    abbrev: "with",
    description: "with context manager",
    body: "with ${1:ctx} as ${2:handle}:\n    ${3:pass}$0",
    languages: PY,
  },
  {
    abbrev: "pdb",
    description: "drop into the debugger",
    body: "import pdb; pdb.set_trace()$0",
    languages: PY,
  },
  { abbrev: "pr", description: "print()", body: "print(${1})$0", languages: PY },
  // --- JavaScript / TypeScript --------------------------------------------------
  { abbrev: "log", description: "console.log()", body: "console.log(${1})$0", languages: JS },
  {
    abbrev: "fn",
    description: "function declaration",
    body: "function ${1:name}(${2}) {\n\t${3}\n}$0",
    languages: JS,
  },
  {
    abbrev: "afn",
    description: "arrow function const",
    body: "const ${1:name} = (${2}) => {\n\t${3}\n}$0",
    languages: JS,
  },
  {
    abbrev: "forof",
    description: "for…of loop",
    body: "for (const ${1:item} of ${2:iterable}) {\n\t${3}\n}$0",
    languages: JS,
  },
  {
    abbrev: "try",
    description: "try/catch",
    body: "try {\n\t${1}\n} catch (${2:err}) {\n\t${3}\n}$0",
    languages: JS,
  },
  {
    abbrev: "iife",
    description: "immediately-invoked arrow",
    body: "(() => {\n\t${1}\n})()$0",
    languages: JS,
  },
];

/** Templates that apply to a language id (empty for unknown languages). */
export function templatesForLang(
  lang: string,
  all: readonly LiveTemplate[] = LIVE_TEMPLATES,
): LiveTemplate[] {
  return all.filter((t) => t.languages.includes(lang));
}

/**
 * Merge user templates over the seed: a user template with the same (abbrev, language)
 * overrides the built-in — case-sensitively and PER-LANGUAGE (a user `log`/typescript does
 * NOT shadow a seed `log`/python). Returns a fresh array; inputs are untouched. Generic
 * over any `{abbrev, languages}` shape so it merges both `LiveTemplate` (seed) and the
 * richer `LiveTemplateDef` (user, carrying `kind`); callers merge one KIND's array at a
 * time, so the (abbrev, language) key never collapses a live and a postfix template.
 */
export function mergeTemplates<T extends { abbrev: string; languages: string[] }>(
  seed: readonly T[],
  custom: readonly T[],
): T[] {
  const overridden = new Set<string>();
  for (const c of custom) for (const l of c.languages) overridden.add(`${l}::${c.abbrev}`);
  // Subtract only the colliding (abbrev, language) PAIRS — a user override for ONE language must
  // not delete a multi-language seed for its other languages (a `log`/typescript override used
  // to silently drop the built-in `log` for javascript/jsx/tsx too).
  const keep: T[] = [];
  for (const s of seed) {
    const remaining = s.languages.filter((l) => !overridden.has(`${l}::${s.abbrev}`));
    if (remaining.length === s.languages.length) keep.push(s);
    else if (remaining.length > 0) keep.push({ ...s, languages: remaining });
    // remaining.length === 0 → every language overridden → drop the seed entirely.
  }
  return [...keep, ...custom];
}

// --- postfix + surround seeds (APP-020) --------------------------------------
// Postfix templates trigger on a `.` after an expression; `$EXPR$` is the receiver the
// completion rewrites (`x.log` → `console.log(x)`). Surround templates wrap the active
// selection via `$SELECTION$`. Both carry Monaco tabstops ($1/${2:d}/$0) AND `$NAME$`
// macros — the engine expands the macros, Monaco the tabstops. Abbrevs are unique within
// a (kind, language) but freely overlap the `live` seed (separate kind-scoped registries).

/** The built-in POSTFIX templates (`.abbrev` after an expression). */
export const POSTFIX_TEMPLATES: readonly LiveTemplateDef[] = [
  // --- Python ---
  {
    abbrev: "print",
    description: "print(expr)",
    body: "print($EXPR$)$END$",
    languages: PY,
    kind: "postfix",
  },
  {
    abbrev: "len",
    description: "len(expr)",
    body: "len($EXPR$)$END$",
    languages: PY,
    kind: "postfix",
  },
  {
    abbrev: "not",
    description: "not expr",
    body: "not $EXPR$$END$",
    languages: PY,
    kind: "postfix",
  },
  {
    abbrev: "if",
    description: "if expr:",
    body: "if $EXPR$:\n    $END$",
    languages: PY,
    kind: "postfix",
  },
  {
    abbrev: "for",
    description: "for x in expr:",
    body: "for ${1:x} in $EXPR$:\n    $END$",
    languages: PY,
    kind: "postfix",
  },
  {
    abbrev: "return",
    description: "return expr",
    body: "return $EXPR$$END$",
    languages: PY,
    kind: "postfix",
  },
  // --- JavaScript / TypeScript ---
  {
    abbrev: "log",
    description: "console.log(expr)",
    body: "console.log($EXPR$)$END$",
    languages: JS,
    kind: "postfix",
  },
  { abbrev: "not", description: "!expr", body: "!$EXPR$$END$", languages: JS, kind: "postfix" },
  {
    abbrev: "await",
    description: "await expr",
    body: "await $EXPR$$END$",
    languages: JS,
    kind: "postfix",
  },
  {
    abbrev: "return",
    description: "return expr",
    body: "return $EXPR$$END$",
    languages: JS,
    kind: "postfix",
  },
  {
    abbrev: "if",
    description: "if (expr) { }",
    body: "if ($EXPR$) {\n\t$END$\n}",
    languages: JS,
    kind: "postfix",
  },
  {
    abbrev: "for",
    description: "for (…of expr)",
    body: "for (const ${1:item} of $EXPR$) {\n\t$END$\n}",
    languages: JS,
    kind: "postfix",
  },
];

/** The built-in SURROUND templates (wrap the active selection via `$SELECTION$`). */
export const SURROUND_TEMPLATES: readonly LiveTemplateDef[] = [
  // --- Python ---
  {
    abbrev: "try",
    description: "wrap in try/except",
    body: "try:\n    $SELECTION$\nexcept ${1:Exception}:\n    $END$",
    languages: PY,
    kind: "surround",
  },
  {
    abbrev: "if",
    description: "wrap in if",
    body: "if ${1:cond}:\n    $SELECTION$$END$",
    languages: PY,
    kind: "surround",
  },
  {
    abbrev: "with",
    description: "wrap in with",
    body: "with ${1:ctx}:\n    $SELECTION$$END$",
    languages: PY,
    kind: "surround",
  },
  // --- JavaScript / TypeScript ---
  {
    abbrev: "try",
    description: "wrap in try/catch",
    body: "try {\n\t$SELECTION$\n} catch (${1:err}) {\n\t$END$\n}",
    languages: JS,
    kind: "surround",
  },
  {
    abbrev: "if",
    description: "wrap in if",
    body: "if (${1:cond}) {\n\t$SELECTION$\n}$END$",
    languages: JS,
    kind: "surround",
  },
  {
    abbrev: "forEach",
    description: "wrap in forEach",
    body: "${1:arr}.forEach((${2:item}) => {\n\t$SELECTION$\n})$END$",
    languages: JS,
    kind: "surround",
  },
];

/** The seed templates for a kind as `LiveTemplateDef[]` — the `live` seed is derived from
 *  LIVE_TEMPLATES (shape-preserved; `kind:"live"` added at the boundary, never mutated). */
export function seedTemplatesForKind(kind: LiveTemplateKind): LiveTemplateDef[] {
  if (kind === "postfix") return [...POSTFIX_TEMPLATES];
  if (kind === "surround") return [...SURROUND_TEMPLATES];
  return LIVE_TEMPLATES.map((t) => ({ ...t, kind: "live" as const }));
}

/**
 * THE runtime registry path: seed templates of `kind` layered UNDER the user templates of
 * that kind (user overrides a seed on (abbrev, language) via `mergeTemplates`), then filtered
 * to `lang`. This is what the editor's completion/surround providers consume.
 */
export function mergedTemplatesForLang(
  kind: LiveTemplateKind,
  lang: string,
  user: readonly LiveTemplateDef[],
): LiveTemplateDef[] {
  const seed = seedTemplatesForKind(kind);
  const userOfKind = user.filter((t) => t.kind === kind);
  return mergeTemplates(seed, userOfKind).filter((t) => t.languages.includes(lang));
}
