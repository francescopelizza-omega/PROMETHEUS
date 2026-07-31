/**
 * templates/live.ts — the PURE live/postfix/surround template engine (APP-020).
 *
 * This is a DIFFERENT domain from the project-scaffold `templates/index.ts`
 * (BUILTIN_TEMPLATES, the init-package wizard rows) that shares this directory — it is the
 * JetBrains-style Live Templates / VS Code snippets engine consumed by the editor's Monaco
 * completion providers and the Settings template editor (plan file 08 / APP-020).
 *
 * It is exported both from `templates/index.ts` (so the node/CLI barrel sees it) AND under
 * the `@prometheus/core/templates` package subpath, which maps to THIS file directly — the
 * renderer imports the subpath (never the scaffold barrel, which statically pulls 6 JSON
 * files and the node-evaluated env-store type chain, C5).
 *
 * NAME/SYNTAX collision safety (the core trap):
 *   - JetBrains-style `$NAME$` macros (delimited BOTH sides) vs Monaco snippet tabstops
 *     `$1` / `${2:default}` / `$0` / `${1|a,b|}`. A single-pass `/\$([A-Z_][A-Z0-9_]*)\$/g`
 *     expansion touches ONLY `$UPPER_SNAKE$` — a Monaco `${2:default}` never matches (the
 *     `${` prefix has no leading letter after `$`, and its trailing `}` is not a `$`), so
 *     seed bodies carrying Monaco placeholders survive the macro pass untouched.
 *   - Template bodies are USER DATA, never code: expansion is pure string substitution —
 *     no eval, no shell. `$CLIPBOARD$` is filled by the caller from the renderer clipboard
 *     STORE only (never `navigator.clipboard`, never a shell).
 */

/** A live template's kind — a plain abbreviation expansion, a postfix `.abbrev` rewrite,
 *  or a selection-surrounding wrap. */
export type LiveTemplateKind = "live" | "postfix" | "surround";

/** The valid kinds as a set, for validation. */
export const LIVE_TEMPLATE_KINDS: readonly LiveTemplateKind[] = ["live", "postfix", "surround"];

/** One editable/persisted live template. Superset of the renderer seed `LiveTemplate`
 *  (adds `kind`); a seed without a kind is implicitly `"live"`. */
export interface LiveTemplateDef {
  /** the abbreviation the user types (for postfix, the part AFTER the dot). */
  abbrev: string;
  description: string;
  /** the body — mixes Monaco snippet tabstops (`$1`/`${2:default}`/`$0`) with `$NAME$`
   *  macros this engine expands. */
  body: string;
  /** language ids this template applies to (Monaco/LSP ids). */
  languages: string[];
  kind: LiveTemplateKind;
}

/** The `$NAME$` macros the engine understands. Unknown `$NAME$` tokens are left INTACT
 *  (they are the user's data, not ours to drop). */
export const MACRO_NAMES = ["SELECTION", "END", "FILE_NAME", "DATE", "CLIPBOARD", "EXPR"] as const;
export type MacroName = (typeof MACRO_NAMES)[number];

/** Matches a `$UPPER_SNAKE$` macro. Anchored on a leading uppercase/underscore right after
 *  the first `$`, so Monaco `${…}` (brace after `$`) and `$1` (digit, no trailing `$`) can
 *  never match — the two syntaxes are provably disjoint. */
const MACRO_RE = /\$([A-Z_][A-Z0-9_]*)\$/g;

/**
 * Single-pass `$NAME$` expansion. A macro present in `macros` is replaced with its value
 * (an explicit `undefined` maps to `""`); an ABSENT macro is left verbatim. The replacement
 * text is inserted as-is and NEVER re-scanned, so a value that itself contains `$…$`
 * (e.g. Monaco's `${TM_SELECTED_TEXT}`) does not trigger a second expansion.
 */
export function expandMacros(body: string, macros: Partial<Record<string, string>>): string {
  return body.replace(MACRO_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(macros, name) ? (macros[name] ?? "") : whole,
  );
}

/** Deterministic ISO `YYYY-MM-DD` (no locale/timezone drift). The clock is INJECTED so the
 *  pure engine never calls `new Date()` itself — tests pass a fixed instant. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Context for expanding a template for real insertion / preview. */
export interface MacroContext {
  /** the active selection text (surround) — maps `$SELECTION$`. */
  selection?: string;
  /** the receiver expression left of the dot (postfix) — maps `$EXPR$`. */
  receiver?: string;
  /** current file's base name — maps `$FILE_NAME$`. */
  fileName?: string;
  /** the renderer clipboard store's top entry — maps `$CLIPBOARD$`. */
  clipboard?: string;
  /** injected clock for `$DATE$` (absent → the macro is left intact). */
  now?: Date;
}

/**
 * Expand a body for handing to Monaco's `SnippetController2.insert` — maps the JetBrains
 * macros onto Monaco's variables/tabstops while leaving `$1`/`${2:default}`/`$0` untouched:
 *   `$END$`      → `$0`                   (Monaco's final caret)
 *   `$SELECTION$`→ `${TM_SELECTED_TEXT}`  (Monaco's selected-text variable, for surround)
 *   `$EXPR$`     → the literal receiver   (postfix — the actual buffer text)
 *   `$FILE_NAME$`,`$DATE$`,`$CLIPBOARD$` → their literal values when supplied.
 * A macro whose value isn't supplied is left intact (so `$DATE$` without a clock stays a
 * literal rather than becoming an empty string mid-template).
 */
export function toMonacoSnippet(body: string, ctx: MacroContext = {}): string {
  const macros: Record<string, string> = { END: "$0", SELECTION: "${TM_SELECTED_TEXT}" };
  if (ctx.receiver !== undefined) macros.EXPR = ctx.receiver;
  if (ctx.fileName !== undefined) macros.FILE_NAME = ctx.fileName;
  if (ctx.clipboard !== undefined) macros.CLIPBOARD = ctx.clipboard;
  if (ctx.now !== undefined) macros.DATE = isoDate(ctx.now);
  return expandMacros(body, macros);
}

/**
 * Reduce Monaco snippet placeholders to plain text for a READ-ONLY preview (never for
 * insertion): `${2:default}`→`default`, `${1|a,b|}`→`a`, `${3}`→"", `$1`/`$0`→"".
 */
export function stripMonacoPlaceholders(body: string): string {
  return body
    .replace(/\$\{\d+:([^}]*)\}/g, "$1") // ${2:default} → default
    .replace(/\$\{\d+\|([^,|}]*)[^}]*\}/g, "$1") // ${1|a,b|} → a
    .replace(/\$\{\d+\}/g, "") // ${3} → ""
    .replace(/\$\d+/g, ""); // $1 / $0 → ""
}

/**
 * Expand a body to sample literals for the Settings editor's live preview: macros get
 * illustrative values (or the caller-supplied ctx), then Monaco tabstops collapse to their
 * defaults. Output is human-readable, NOT a valid snippet.
 */
export function previewExpand(body: string, ctx: MacroContext = {}): string {
  const macros: Record<string, string> = {
    SELECTION: ctx.selection ?? "selection",
    END: "",
    FILE_NAME: ctx.fileName ?? "Example.ts",
    DATE: ctx.now ? isoDate(ctx.now) : "1970-01-01",
    CLIPBOARD: ctx.clipboard ?? "clipboard",
    EXPR: ctx.receiver ?? "expr",
  };
  return stripMonacoPlaceholders(expandMacros(body, macros));
}

/**
 * Validate a (possibly partial) template. Returns a list of human-readable problems; an
 * empty list means valid. Abbrev must be non-empty and whitespace-free (it is a completion
 * trigger); body non-empty; ≥1 language; kind one of the three.
 */
export function validateLiveTemplate(t: Partial<LiveTemplateDef>): string[] {
  const errs: string[] = [];
  if (!t.abbrev || t.abbrev.trim().length === 0) {
    errs.push("abbreviation is required");
  } else if (/\s/.test(t.abbrev)) {
    errs.push("abbreviation must not contain whitespace");
  }
  if (!t.body || t.body.length === 0) errs.push("body is required");
  if (!t.languages || t.languages.length === 0) errs.push("at least one language is required");
  if (!t.kind || !LIVE_TEMPLATE_KINDS.includes(t.kind)) {
    errs.push("kind must be live, postfix, or surround");
  }
  return errs;
}

/** Narrow an unknown/partial value to a valid LiveTemplateDef. */
export function isValidLiveTemplate(t: Partial<LiveTemplateDef>): t is LiveTemplateDef {
  return validateLiveTemplate(t).length === 0;
}

/**
 * Sanitize an arbitrary parsed value (e.g. from persisted settings) into a clean
 * LiveTemplateDef[] — drops any entry that fails validation, never throws. Used when
 * hydrating user templates from the settings store, whose value is untyped JSON.
 */
export function sanitizeUserTemplates(value: unknown): LiveTemplateDef[] {
  if (!Array.isArray(value)) return [];
  const out: LiveTemplateDef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const t: Partial<LiveTemplateDef> = {
      abbrev: typeof o.abbrev === "string" ? o.abbrev : undefined,
      description: typeof o.description === "string" ? o.description : "",
      body: typeof o.body === "string" ? o.body : undefined,
      languages: Array.isArray(o.languages)
        ? o.languages.filter((l): l is string => typeof l === "string")
        : undefined,
      kind: o.kind as LiveTemplateKind,
    };
    if (isValidLiveTemplate(t)) out.push(t);
  }
  return out;
}

/**
 * Derive the receiver expression immediately LEFT of a postfix trigger dot, parser-free.
 * `linePrefix` is the line text to the left of the dot (the dot itself excluded). Scans
 * right-to-left, balancing `()`/`[]` so call/index chains are captured whole, stopping at
 * the first whitespace / operator / `;` / `{` at bracket-depth 0. A leading string literal
 * is consumed as one token. Returns "" when there is no receiver.
 *
 * Conservative by design (the plan forbids a parser dep): it captures `foo.bar(a,b).baz`,
 * `arr[i]`, `"str"`, a bare `x`, and stops before `=`/whitespace so `foo = bar` → `bar`.
 */
export function receiverExpression(linePrefix: string): string {
  const end = linePrefix.length;
  let i = end - 1;
  let depth = 0;
  while (i >= 0) {
    const ch = linePrefix[i] as string;
    if (ch === ")" || ch === "]") {
      depth++;
      i--;
      continue;
    }
    if (ch === "(" || ch === "[") {
      if (depth === 0) break; // an unbalanced opener bounds the receiver on the left
      depth--;
      i--;
      continue;
    }
    if (depth > 0) {
      i--;
      continue; // inside a balanced bracket group — consume everything
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      // consume a string literal back to its (unescaped) opening quote
      let j = i - 1;
      while (j >= 0) {
        if (linePrefix[j] === ch && linePrefix[j - 1] !== "\\") break;
        j--;
      }
      i = j - 1;
      continue;
    }
    if (/[A-Za-z0-9_$.]/.test(ch)) {
      i--;
      continue; // identifier / member-access char
    }
    break; // whitespace / operator / ; / { at depth 0 — receiver starts after here
  }
  return linePrefix.slice(i + 1, end);
}
