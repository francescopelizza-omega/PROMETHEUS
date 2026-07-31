/**
 * tui/markdown.ts — a minimal, STATEFUL ANSI markdown renderer for agent replies
 * (CLI-020). Hand-rolled (no marked/chalk/ink deps); all color routes through the
 * palette `painter()` so `caps="none"` yields plain text (zero escapes).
 *
 * Fed one COMPLETED line at a time (session-bridge splits the stream on \n), so a
 * fence toggles only when its whole line lands. State: an open code fence (char +
 * length + language). `flush()` closes an unterminated fence at turn end; `reset()`
 * clears state so one renderer serves one assistant turn without bleeding fence state.
 */
import {
  CODE_STATE,
  type HlState,
  detectLanguage,
  highlightLine,
  isHighlightable,
} from "./highlight.js";
import { type ColorCaps, painter } from "./palette.js";
import { stringWidth } from "./width.js";

export interface MarkdownRenderer {
  /** render one completed line → zero or more output lines. */
  feedLine: (line: string) => string[];
  /** close an unterminated fence at turn end; returns the closing rule(s). */
  flush: () => string[];
  /** clear fence/state for the next turn. */
  reset: () => void;
}

interface FenceState {
  char: "`" | "~";
  len: number;
  /** the raw info-string (shown as the box label). */
  lang: string;
  /** the canonical highlight language ("plain" when we have no grammar). */
  hlLang: string;
  /** carried lexer state so block comments / templates / triple-strings span fenced lines. */
  hl: HlState;
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/**
 * Inline styling: `` `code` `` (tinted) and `**bold**`, tokenized LEFT-TO-RIGHT so a
 * code span is consumed whole (markers inside it stay literal) and adjacent markers
 * pair correctly. Unmatched markers pass through as plain text.
 */
function inline(text: string, p: ReturnType<typeof painter>): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        out += p.command(text.slice(i, end + 1)); // keep the backticks, tint the span
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        out += p.bold(text.slice(i + 2, end), "plain");
        i = end + 2;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

export function createMarkdownRenderer(caps: ColorCaps, width: number): MarkdownRenderer {
  const p = painter(caps);
  const boxW = Math.max(8, width);
  let fence: FenceState | null = null;

  const closeRule = (): string => p.muted(`╰${"─".repeat(Math.min(boxW - 1, 40))}`);

  const feedLine = (line: string): string[] => {
    if (fence) {
      const m = FENCE_CLOSE.exec(line);
      if (m && (m[1] as string)[0] === fence.char && (m[1] as string).length >= fence.len) {
        fence = null;
        return [closeRule()];
      }
      // fenced content: NEVER re-wrapped / markdown-parsed — byte-preserved. Syntax-highlighted
      // per-token when we have a grammar (state carried across lines); flat tint otherwise.
      if (isHighlightable(fence.hlLang)) {
        const { text, state } = highlightLine(line, fence.hlLang, fence.hl, caps);
        fence.hl = state;
        return [`${p.muted("│")} ${text}`];
      }
      return [`${p.muted("│")} ${p.command(line)}`];
    }

    const open = FENCE_OPEN.exec(line);
    if (open) {
      const marker = open[1] as string;
      const rawLang = open[2] ?? "";
      fence = {
        char: marker[0] as "`" | "~",
        len: marker.length,
        lang: rawLang,
        hlLang: detectLanguage(rawLang),
        hl: CODE_STATE,
      };
      const label = fence.lang ? ` ${fence.lang} ` : "─";
      const dash = "─".repeat(Math.max(1, Math.min(boxW - 4 - stringWidth(label), 36)));
      return [p.muted(`╭─${p.accent(label)}${dash}`)];
    }

    const h = HEADING.exec(line);
    if (h) {
      return [p.bold((h[2] as string).trim(), "heading")];
    }

    const li = LIST.exec(line);
    if (li) {
      const indent = Math.floor((li[1] as string).length / 2); // 2-space steps
      const marker = /^\d+\./.test(li[2] as string) ? (li[2] as string) : "•"; // keep author's number
      return [`${"  ".repeat(indent)}${p.accent(marker)} ${inline(li[3] as string, p)}`];
    }

    // ordinary prose (tables / blockquotes / links / unknown all pass through inline).
    return [inline(line, p)];
  };

  return {
    feedLine,
    flush: () => {
      if (!fence) return [];
      fence = null;
      return [closeRule()];
    },
    reset: () => {
      fence = null;
    },
  };
}
