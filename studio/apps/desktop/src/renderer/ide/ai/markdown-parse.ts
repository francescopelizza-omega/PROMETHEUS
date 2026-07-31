/**
 * ide/ai/markdown-parse.ts — the PURE markdown block parser (#12).
 *
 * Kept JSX-free (separate from markdown.tsx) so it is importable by node:test (the
 * runner's type-stripper can't parse JSX). Splits markdown into fenced-code + text
 * blocks; the .tsx component renders these as safe React elements.
 */

/** A parsed markdown block: a fenced code block or a run of text. */
export interface MdBlock {
  type: "code" | "text";
  lang?: string;
  text: string;
}

/**
 * Split markdown into fenced-code (```lang … ```) and text blocks. An unterminated
 * fence runs to end-of-input (rendered as code). PURE + total.
 */
export function parseBlocks(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.split("\n");
  let textBuf: string[] = [];
  const flush = (): void => {
    if (textBuf.length) {
      blocks.push({ type: "text", text: textBuf.join("\n") });
      textBuf = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // opener: ``` then the FIRST info-string token as the language (`c++`, `objective-c`,
    // `js title="x"` → `js`). The old `(\w*)\s*$` rejected any non-word/extra-token info string,
    // which mis-rendered the whole block as literal text + spawned a spurious empty code block.
    const fence = line.match(/^```([^\s`]*)/);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // step past the closing fence (or past end for an unterminated block)
      blocks.push({ type: "code", text: code.join("\n"), ...(fence[1] ? { lang: fence[1] } : {}) });
    } else {
      textBuf.push(line);
      i++;
    }
  }
  flush();
  return blocks;
}
