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
