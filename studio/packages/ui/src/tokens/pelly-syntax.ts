/**
 * tokens/pelly-syntax.ts — the user's "Pelly Colors" PyCharm scheme (Pelly_Colors_copy.icls,
 * Darcula parent), mapped to the TUI's syntax-highlight roles. This file lives under `tokens/`,
 * the ONE sanctioned home for raw hex (§6 no-raw-hex guard skips it), so palette.ts can source
 * these exact colors without inventing hex in the renderer.
 *
 * Each entry is the token FOREGROUND + font style from the .icls. The terminal renders these in
 * 24-bit truecolor; palette.ts falls back to the role's ramp/ANSI-16 mapping on lesser terminals.
 */

/** One syntax token's Pelly styling: foreground hex + optional bold / italic. */
export interface PellySynStyle {
  fg: string;
  bold?: boolean;
  italic?: boolean;
}

/** Syntax role → Pelly color. Keys match the TUI palette's `syn*` roles (palette.ts). */
export const PELLY_SYNTAX: Record<string, PellySynStyle> = {
  synKeyword: { fg: "#ffff00", bold: true }, // DEFAULT_KEYWORD
  synString: { fg: "#518fff", bold: true }, // DEFAULT_STRING
  synDoc: { fg: "#96ec2e", bold: true, italic: true }, // DEFAULT_DOC_COMMENT (docstrings)
  synNumber: { fg: "#00ff00", bold: true }, // DEFAULT_NUMBER
  synComment: { fg: "#007ce1", bold: true }, // DEFAULT_LINE_COMMENT
  synFunc: { fg: "#e636ff", bold: true }, // DEFAULT_FUNCTION_DECLARATION
  synClass: { fg: "#dd00ff", bold: true }, // DEFAULT_CLASS_NAME
  synType: { fg: "#86fc04", bold: true }, // DEFAULT_CLASS_REFERENCE
  synBuiltin: { fg: "#ff0000" }, // PY.BUILTIN_NAME
  synSelf: { fg: "#dc00ff" }, // PY.SELF_PARAMETER
  synOperator: { fg: "#81ff00", bold: true }, // DEFAULT_OPERATION_SIGN
  synParen: { fg: "#ffff00", bold: true }, // DEFAULT_PARENTHS
  synBracket: { fg: "#18ff00", bold: true }, // DEFAULT_BRACKETS
  synBrace: { fg: "#6591ff", bold: true }, // DEFAULT_BRACES
  synComma: { fg: "#e7ff00", bold: true }, // DEFAULT_COMMA
  synDot: { fg: "#ff8e00", bold: true }, // DEFAULT_DOT
  synDecorator: { fg: "#bbb529", bold: true }, // DEFAULT_METADATA
  synConstant: { fg: "#be61ff", bold: true, italic: true }, // DEFAULT_CONSTANT
  synKwarg: { fg: "#e56030" }, // PY.KEYWORD_ARGUMENT
  synPunct: { fg: "#ffff00", bold: true }, // fallback punctuation → parens color
  synProperty: { fg: "#518fff", bold: true }, // json/toml keys → string blue
  synRegex: { fg: "#ff8e00" }, // DEFAULT_DOT hue (no dedicated regex token)

  // ── non-code OUTPUT roles (Pelly-aligned, so the whole stream is vivid, not just code) ──
  reasoning: { fg: "#b58cff" }, // the ✻ thinking prose — soft violet, readable
  thinkMark: { fg: "#e636ff", bold: true }, // the ✻ thinking marker
  mdHeading: { fg: "#dd00ff", bold: true }, // ## headings
  mdBold: { fg: "#ffff00", bold: true }, // **bold**
  mdBullet: { fg: "#86fc04", bold: true }, // - list bullets
  mdNumber: { fg: "#3cf5ee", bold: true }, // 1. numbered markers
  mdCode: { fg: "#518fff" }, // `inline code` + links
  mdQuote: { fg: "#007ce1", italic: true }, // > blockquotes
  toolAction: { fg: "#e636ff", bold: true }, // ● tool action lines
  stSend: { fg: "#3cf5ee" }, // → sending
  stResp: { fg: "#86fc04" }, // ▼ responding / generating
  stWait: { fg: "#ff8e00" }, // ⏳ waiting
  stRound: { fg: "#be61ff" }, // continuing round N
  stErr: { fg: "#ff0000" }, // ✗ timeout / error / blocked

  // ── surgical edit card (diff) ──
  diffAdd: { fg: "#86fc04" }, // + added line
  diffDel: { fg: "#ff0000" }, // − removed line
  diffGutter: { fg: "#5a626b" }, // old·new line-number gutter
  diffLoc: { fg: "#00b7d4" }, // @@ hunk location header
};

/** Background tints for the WORD-LEVEL changed span inside a modified diff line. */
export const PELLY_SPAN_BG: Record<"add" | "del", string> = {
  add: "#2b5c10",
  del: "#611010",
};

/* ────────────────────────────────────────────────────────────────────────────
 * The MONACO scope map (Prometheus Studio handoff §1 "Editor scheme").
 *
 * PELLY_SYNTAX above is keyed by the TUI's own role names and is consumed by
 * apps/cli/src/tui/palette.ts — it is API, and nothing here mutates it. This block is
 * the SEPARATE, additive mapping onto the scope names Monaco's Monarch grammars
 * actually emit, because those are the only names a `defineTheme` rule can match:
 * there is no TextMate/semantic-token bridge in this app, so `entity.name.function`
 * and friends would be dead rules.
 *
 * Two of the handoff's roles cannot be honoured separately under stock Monarch, and
 * saying so is better than shipping a rule that never fires:
 *   - "comma #e7ff00" and "dot/operator #ff8e00" both tokenize as plain `delimiter`
 *     in the TS and Python grammars. `delimiter` takes the dot/operator color (by far
 *     the more frequent glyph); commas inherit it.
 *   - A Python docstring is tokenized as `string`, not `comment.doc`, so the italic
 *     doc-comment color reaches JS/TS jsdoc only.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Monarch scope → Pelly style (handoff §1). Keys are Monaco token names, not TextMate. */
export const PELLY_MONACO_SYNTAX: Record<string, PellySynStyle> = {
  // keyword #ffff00 bold
  keyword: { fg: "#ffff00", bold: true },
  "keyword.flow": { fg: "#ffff00", bold: true },
  // class name #dd00ff — TS `[A-Z]\w*` only; Python class names are plain identifiers
  "type.identifier": { fg: "#dd00ff", bold: true },
  type: { fg: "#dd00ff", bold: true },
  // function decl #e636ff — Monarch has no callee token, so this rides `tag`
  // (decorators) and any grammar that does emit `function`
  function: { fg: "#e636ff", bold: true },
  tag: { fg: "#e636ff", bold: true },
  // constant #be61ff bold — numeric literals (the prototype paints ALL_CAPS the same,
  // but Monarch cannot distinguish them from other identifiers)
  number: { fg: "#be61ff", bold: true },
  "number.hex": { fg: "#be61ff", bold: true },
  "number.float": { fg: "#be61ff", bold: true },
  constant: { fg: "#be61ff", bold: true },
  // string #7ec46a — the handoff brightens Darcula's #6a8759
  string: { fg: "#7ec46a" },
  "string.escape": { fg: "#ff8e00" },
  // comments: plain #007ce1-family stays the Pelly comment; the DOC comment is the
  // handoff's #96ec2e italic
  comment: { fg: "#007ce1" },
  "comment.doc": { fg: "#96ec2e", italic: true },
  // dot / operator #ff8e00 (also carries commas — see the note above)
  delimiter: { fg: "#ff8e00" },
  // braces #6591ff · brackets #18ff00. Monarch maps these per-language: Python sends
  // `{}`→curly and `[]`→bracket; TypeScript sends `{}`→bracket and `[]`→square. Both
  // spellings are listed for each shape so the color follows the CHARACTER, not the
  // grammar that happened to tokenize it.
  "delimiter.curly": { fg: "#6591ff", bold: true },
  "delimiter.parenthesis": { fg: "#6591ff", bold: true },
  "delimiter.bracket": { fg: "#18ff00", bold: true },
  "delimiter.square": { fg: "#18ff00", bold: true },
  "delimiter.angle": { fg: "#6591ff", bold: true },
  // default text #dce8f7
  identifier: { fg: "#dce8f7" },
  variable: { fg: "#dce8f7" },
};

/** The editor-chrome colors §1 names that are NOT semantic tokens. */
export const PELLY_EDITOR_COLORS = {
  /** default text — `editor.foreground`. */
  foreground: "#dce8f7",
  /** the gutter — `editorLineNumber.foreground`. */
  lineNumber: "#31486b",
  /** the active gutter line, a step brighter so the caret's row is findable. */
  lineNumberActive: "#5f7899",
  /**
   * the current-line wash — `editor.lineHighlightBackground`. The handoff writes it as
   * `rgba(53,199,238,.05)`; Monaco parses this block with `Color.fromHex`, which returns
   * OPAQUE RED for anything that is not hex. It must be 8-digit hex: 0.05 × 255 ≈ 0x0d.
   */
  currentLine: "#35c7ee0d",
  /** kill the border vs-dark would otherwise draw around the current line. */
  currentLineBorder: "#00000000",
} as const;
