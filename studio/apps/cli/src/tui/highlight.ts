// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tui/highlight.ts — a PURE, stateful, line-fed syntax highlighter (WRAPPER Subsystem 2).
 *
 * Turns the markdown renderer's already-parsed-but-discarded `fence.lang` into per-token
 * color, so reading a model's code reply is far clearer. Prism-style ordered rules per
 * language; a char-fallback guarantees join(tokens.text) === line (byte-preservation — the
 * load-bearing invariant of the whole wrapper). Multiline constructs (block comments,
 * template/backtick and Python triple-quoted strings) survive across streamed lines via a
 * carried `HlState`, exactly as markdown.ts already carries its fence state.
 *
 * DEGRADES: caps='none' returns the line UNCHANGED (zero escape bytes — piped/NO_COLOR stays
 * clean). Every token role resolves through the SAME token-sourced palette (no raw hex), so the
 * TUI never invents a brand color. An unknown language is not highlighted here — markdown.ts
 * keeps its historical flat tint for those, so we are never worse than before.
 */
import { type ColorCaps, type Role, paint } from "./palette.js";

/** One highlighted span. `role` is a palette Role; "plain" text is left uncolored. */
export interface Token {
  role: Role;
  text: string;
}

/** Carried lexer state for constructs that span lines. `code` = nothing open. */
export interface HlState {
  mode: "code" | "block" | "template" | "triple";
  /** the closing delimiter to scan for when a multiline mode is open. */
  delim: string;
  /** the role a multiline string carries (so a triple-quoted DOCSTRING stays synDoc across lines). */
  role?: Role;
}

export const CODE_STATE: HlState = Object.freeze({ mode: "code", delim: "" });

interface LangSpec {
  lineComments: string[];
  block?: [string, string];
  /** single-line string quote chars. */
  quotes: string[];
  /** JS-style backtick template (multiline). */
  template?: string;
  /** Python triple-quote openers (multiline). */
  triples?: string[];
  /** `$` variable sigil (bash). */
  varSigil?: string;
  keywords: Set<string>;
  builtins: Set<string>;
  types?: Set<string>;
  /** language keys precede this char (json `:` / toml `=`) → paint the preceding string/ident as a property. */
  keyTerminator?: string;
  /** exact identifiers that get a fixed role regardless of position (Python `self` → synSelf). */
  specialIdents?: Record<string, Role>;
  /** a decorator/annotation sigil (`@` in Python/TS) — `@name` paints as synDecorator. */
  decoratorSigil?: string;
  /** ALL_CAPS identifiers are constants (synConstant) — the near-universal convention. */
  constantsUpper?: boolean;
  /** keywords after which the next identifier NAMES a class (Python/JS `class`). */
  classAfter?: Set<string>;
  /** keywords after which the next identifier NAMES a function (Python `def`, JS `function`). */
  funcAfter?: Set<string>;
}

const set = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS: LangSpec = {
  lineComments: ["//"],
  block: ["/*", "*/"],
  quotes: ['"', "'"],
  template: "`",
  keywords: set(
    "const let var function return if else for while do switch case break continue new class extends super this typeof instanceof in of await async yield throw try catch finally import export from default delete void as interface type enum implements public private protected readonly static get set namespace declare abstract keyof infer satisfies",
  ),
  builtins: set(
    "console Math JSON Object Array String Number Boolean Promise Symbol Map Set WeakMap WeakSet Date RegExp Error Proxy Reflect require module process globalThis window document undefined NaN Infinity true false null",
  ),
  types: set(
    "string number boolean any unknown never void object bigint symbol Record Partial Readonly",
  ),
};

const PY: LangSpec = {
  lineComments: ["#"],
  quotes: ['"', "'"],
  triples: ['"""', "'''"],
  keywords: set(
    "def class return if elif else for while break continue pass import from as with try except finally raise yield lambda global nonlocal assert del in is not and or async await match case",
  ),
  builtins: set(
    "print len range int str float list dict set tuple bool type object super isinstance issubclass enumerate zip map filter open input sum min max abs round pow divmod sorted reversed None True False __init__ ValueError TypeError KeyError IndexError Exception",
  ),
  specialIdents: { self: "synSelf", cls: "synSelf" },
  decoratorSigil: "@",
  constantsUpper: true,
  classAfter: set("class"),
  funcAfter: set("def"),
};

const BASH: LangSpec = {
  lineComments: ["#"],
  quotes: ['"', "'"],
  varSigil: "$",
  keywords: set(
    "if then else elif fi for while do done case esac function in select until return local export readonly declare set unset shift source",
  ),
  builtins: set(
    "echo cd ls cat grep sed awk cp mv rm mkdir rmdir touch chmod chown curl wget git printf read test exit",
  ),
};

const JSON_SPEC: LangSpec = {
  lineComments: [],
  quotes: ['"'],
  keywords: set("true false null"),
  builtins: set(""),
  keyTerminator: ":",
};

const TOML: LangSpec = {
  lineComments: ["#"],
  quotes: ['"', "'"],
  keywords: set("true false"),
  builtins: set(""),
  keyTerminator: "=",
};

const C_LIKE: LangSpec = {
  lineComments: ["//"],
  block: ["/*", "*/"],
  quotes: ['"', "'"],
  keywords: set(
    "if else for while do switch case break continue return struct class enum union typedef const static void int char float double long short unsigned signed public private protected new delete namespace using template typename this true false null nullptr fn let mut pub impl match trait use mod where async await move",
  ),
  builtins: set(
    "printf malloc free sizeof std vec String Vec Option Result Some None Ok Err println",
  ),
};

const GRAMMARS: Record<string, LangSpec> = {
  js: JS,
  ts: JS,
  tsx: JS,
  python: PY,
  bash: BASH,
  json: JSON_SPEC,
  toml: TOML,
  c: C_LIKE,
};

const ALIASES: Record<string, string> = {
  javascript: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  py: "python",
  python: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",
  console: "bash",
  json: "json",
  jsonc: "json",
  json5: "json",
  toml: "toml",
  ini: "toml",
  c: "c",
  h: "c",
  "c++": "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  rust: "c",
  rs: "c",
  go: "c",
  golang: "c",
  java: "c",
};

/**
 * Canonicalize a fence info-string / filename hint to a highlightable language id, or "plain"
 * when we have no grammar. Fail-closed: an unknown or empty lang is "plain" (markdown.ts then
 * keeps its flat tint), never a throw.
 */
export function detectLanguage(hint: string | undefined): string {
  if (!hint) return "plain";
  const h = hint.trim().toLowerCase().replace(/^\./, "");
  const first = h.split(/[\s:]/)[0] ?? h;
  return ALIASES[first] ?? (GRAMMARS[first] ? first : "plain");
}

/** Is this a language we can tokenize? */
export function isHighlightable(langId: string): boolean {
  return langId in GRAMMARS;
}

const IDENT = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d[\d_]*\.?\d*([eE][+-]?\d+)?|\.\d+)/;
const WS = /^[ \t]+/;
// `.` is pulled OUT of the operator run so attribute dots paint as synDot (Pelly #ff8e00).
const OPERATOR = /^[-+*/%=<>!&|^~?:]+/;
const DOT = /^\.+/;
const CONST_RX = /^[A-Z][A-Z0-9_]*$/;
/** each bracket family + comma get their own Pelly hue; `;` and the rest stay generic synPunct. */
const PUNCT_ROLE: Record<string, Role> = {
  "(": "synParen",
  ")": "synParen",
  "[": "synBracket",
  "]": "synBracket",
  "{": "synBrace",
  "}": "synBrace",
  ",": "synComma",
  ";": "synPunct",
};

const modeRole = (s: HlState): Role => s.role ?? (s.mode === "block" ? "synComment" : "synString");

/** Peek: the next non-space char at or after `i` (or "" at EOL). */
function peekNonSpace(line: string, i: number): string {
  let j = i;
  while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
  return line[j] ?? "";
}

/** Scan a single-line quoted string from `rest[0]`; returns the whole span incl. close, or to EOL. */
function scanString(rest: string, quote: string): number {
  let i = 1;
  while (i < rest.length) {
    const c = rest[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return rest.length; // unterminated on this line — consume to EOL, no state carry (single-line quote)
}

/**
 * Tokenize ONE line for `langId`, threading `state` across lines. Guarantees the concatenation
 * of the returned tokens' text equals `line` exactly. Unknown lang ⇒ one plain token.
 */
export function tokenizeLine(
  line: string,
  langId: string,
  state: HlState = CODE_STATE,
): { tokens: Token[]; state: HlState } {
  const spec = GRAMMARS[langId];
  if (!spec) return { tokens: [{ role: "plain", text: line }], state: CODE_STATE };
  const tokens: Token[] = [];
  let i = 0;
  let cur = state;
  // the last keyword/identifier seen (skipping whitespace/punct) — lets `class X`/`def f`
  // name the following identifier as a class / function (Pelly magenta hues).
  let prevWord = "";

  // resume an open multiline construct
  if (cur.mode !== "code") {
    const idx = line.indexOf(cur.delim);
    if (idx === -1) {
      if (line.length > 0) tokens.push({ role: modeRole(cur), text: line });
      return { tokens, state: cur };
    }
    const end = idx + cur.delim.length;
    tokens.push({ role: modeRole(cur), text: line.slice(0, end) });
    i = end;
    cur = CODE_STATE;
  }

  while (i < line.length) {
    const rest = line.slice(i);
    const push = (role: Role, len: number): void => {
      tokens.push({ role, text: rest.slice(0, len) });
      i += len;
    };

    // whitespace
    const ws = WS.exec(rest);
    if (ws) {
      push("plain", ws[0].length);
      continue;
    }
    // line comment → to EOL
    const lc = spec.lineComments.find((c) => rest.startsWith(c));
    if (lc) {
      push("synComment", rest.length);
      continue;
    }
    // block comment (may open a multiline mode)
    if (spec.block && rest.startsWith(spec.block[0])) {
      const close = rest.indexOf(spec.block[1], spec.block[0].length);
      if (close === -1) {
        tokens.push({ role: "synComment", text: rest });
        return { tokens, state: { mode: "block", delim: spec.block[1] } };
      }
      push("synComment", close + spec.block[1].length);
      continue;
    }
    // python triple-quote (multiline). A triple that OPENS the statement (only whitespace before
    // it on the line) is a DOCSTRING → synDoc (Pelly green italic); otherwise a normal string.
    const triple = spec.triples?.find((t) => rest.startsWith(t));
    if (triple) {
      const atStmtStart = tokens.every((t) => t.text.trim() === "");
      const tRole: Role = atStmtStart ? "synDoc" : "synString";
      const close = rest.indexOf(triple, triple.length);
      if (close === -1) {
        tokens.push({ role: tRole, text: rest });
        return { tokens, state: { mode: "triple", delim: triple, role: tRole } };
      }
      push(tRole, close + triple.length);
      continue;
    }
    // js template (multiline)
    if (spec.template && rest[0] === spec.template) {
      const len = scanString(rest, spec.template);
      if (len === rest.length && rest.indexOf(spec.template, 1) === -1) {
        tokens.push({ role: "synString", text: rest });
        return { tokens, state: { mode: "template", delim: spec.template } };
      }
      push("synString", len);
      continue;
    }
    // single-line string (json/toml key detection: a string before the key-terminator is a property)
    if (spec.quotes.includes(rest[0] as string)) {
      const len = scanString(rest, rest[0] as string);
      const role: Role =
        spec.keyTerminator && peekNonSpace(line, i + len) === spec.keyTerminator
          ? "synProperty"
          : "synString";
      push(role, len);
      continue;
    }
    // bash variable
    if (spec.varSigil && rest[0] === spec.varSigil) {
      const m =
        /^\$\{[^}]*\}/.exec(rest) ?? /^\$[A-Za-z_]\w*/.exec(rest) ?? /^\$[0-9@*#?$!]/.exec(rest);
      if (m) {
        push("synBuiltin", m[0].length);
        continue;
      }
    }
    // decorator / annotation: `@name` (Python/TS) → synDecorator (Pelly olive).
    if (spec.decoratorSigil && rest[0] === spec.decoratorSigil) {
      const dm = /^@[\w.]*/.exec(rest);
      if (dm && dm[0].length > 1) {
        push("synDecorator", dm[0].length);
        prevWord = "";
        continue;
      }
    }
    // number
    const num = NUMBER.exec(rest);
    if (num && num[0].length > 0) {
      push("synNumber", num[0].length);
      prevWord = "";
      continue;
    }
    // identifier / keyword / builtin / type / self / constant / class · function name / key
    const id = IDENT.exec(rest);
    if (id) {
      const w = id[0];
      let role: Role = "plain";
      if (spec.keywords.has(w)) role = "synKeyword";
      else if (spec.specialIdents?.[w]) role = spec.specialIdents[w] as Role;
      else if (spec.builtins.has(w)) role = "synBuiltin";
      else if (spec.types?.has(w)) role = "synType";
      else if (spec.classAfter?.has(prevWord))
        role = "synClass"; // `class Foo`
      else if (spec.funcAfter?.has(prevWord))
        role = "synFunc"; // `def foo`
      else if (spec.constantsUpper && w.length > 1 && CONST_RX.test(w)) role = "synConstant";
      else {
        const nxt = peekNonSpace(line, i + w.length);
        if (nxt === "(") role = "synFunc";
        else if (spec.keyTerminator && nxt === spec.keyTerminator) role = "synProperty";
      }
      push(role, w.length);
      prevWord = w;
      continue;
    }
    // attribute dot(s) `.` → synDot (Pelly orange); floats like `.5` were taken by NUMBER above.
    const dot = DOT.exec(rest);
    if (dot) {
      push("synDot", dot[0].length);
      continue;
    }
    // operators
    const op = OPERATOR.exec(rest);
    if (op) {
      push("synOperator", op[0].length);
      prevWord = "";
      continue;
    }
    // brackets / comma / semicolon — each family its own Pelly hue.
    const punctRole = PUNCT_ROLE[rest[0] as string];
    if (punctRole) {
      push(punctRole, 1);
      prevWord = "";
      continue;
    }
    // fallback: one char, uncolored (guarantees join === line, never throws)
    push("plain", 1);
  }
  return { tokens, state: cur };
}

/**
 * Highlight one line → a painted string + the carried state. caps='none' is a pure identity
 * (zero escapes). If tokenization ever fails the join===line invariant, fall back to the raw
 * line (never corrupt bytes). Whitespace and "plain" tokens are emitted uncolored.
 */
export function highlightLine(
  line: string,
  langId: string,
  state: HlState,
  caps: ColorCaps,
): { text: string; state: HlState } {
  if (caps === "none" || !isHighlightable(langId)) return { text: line, state };
  const { tokens, state: next } = tokenizeLine(line, langId, state);
  if (tokens.map((t) => t.text).join("") !== line) return { text: line, state: CODE_STATE };
  const text = tokens
    .map((t) => (t.role === "plain" || t.text.trim() === "" ? t.text : paint(t.text, t.role, caps)))
    .join("");
  return { text, state: next };
}
