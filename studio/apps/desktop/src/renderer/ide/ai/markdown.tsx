/**
 * ide/ai/markdown.tsx — a MINIMAL, safe markdown renderer for assistant turns (#12).
 *
 * Assistant replies were rendered as raw whitespace-pre text — fine for plain prose but
 * ugly for the code the agent emits. This renders the common subset (fenced code blocks
 * with a copy button, inline `code`, **bold**) as REACT ELEMENTS — never via
 * dangerouslySetInnerHTML, so model output can't inject markup (React escapes all text).
 * No markdown dependency: a 50KB lib + an HTML sanitizer would be overkill for chat.
 *
 * The block parser is PURE (node:test-ed); the component is the thin view.
 *
 * Renderer-SANDBOXED (C5): react only.
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";

import { parseBlocks } from "./markdown-parse.js";

const CODE_SPAN: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  background: "var(--bg-inset)",
  borderRadius: 3,
  padding: "0 3px",
  fontSize: "0.9em",
  overflowWrap: "break-word", // an inline `path/like/this` must not widen the bubble
};

/** Render inline `code` + **bold** within a text run (everything else is escaped text). */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split("`").forEach((part, ci) => {
    if (ci % 2 === 1) {
      out.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: positionally-derived, stable per render
        <code key={`c${ci}`} style={CODE_SPAN}>
          {part}
        </code>,
      );
      return;
    }
    part.split("**").forEach((seg, bi) => {
      if (!seg) return;
      out.push(
        bi % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positionally-derived, stable per render
          <strong key={`b${ci}-${bi}`}>{seg}</strong>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positionally-derived, stable per render
          <span key={`t${ci}-${bi}`}>{seg}</span>
        ),
      );
    });
  });
  return out;
}

function CodeBlock({ text }: { text: string }): ReactElement {
  return (
    <div style={{ position: "relative", margin: "4px 0" }}>
      <pre
        style={{
          margin: 0,
          // A top band, not a right gutter, reserves room for the ⧉ copy button (~18px tall at
          // top:4). A <pre> never wraps and a scroll box clips at its PADDING edge, so a right
          // gutter only protected first lines that already fit: any longer line (most of them in
          // the 330px rail) still painted straight under the button. Nothing is drawn above
          // the first line at any scroll position.
          padding: "24px 8px 8px 8px",
          overflow: "auto",
          background: "var(--bg-inset)",
          borderRadius: "var(--radius-md, 6px)",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "0.72rem",
        }}
      >
        <code>{text}</code>
      </pre>
      <button
        type="button"
        aria-label="copy code"
        title="Copy code"
        onClick={() => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(text).catch(() => {});
          }
        }}
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          background: "var(--bg-surface-2)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm, 4px)",
          color: "var(--text-secondary)",
          cursor: "pointer",
          fontSize: "0.7rem",
          padding: "1px 5px",
        }}
      >
        ⧉
      </button>
    </div>
  );
}

/** Render a markdown string as safe React elements (code fences + inline code + bold). */
export function Markdown({ source }: { source: string }): ReactElement {
  const blocks = parseBlocks(source);
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "code" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positionally stable per render
          <CodeBlock key={`blk${i}`} text={b.text} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positionally stable per render
          <div key={`blk${i}`} style={{ whiteSpace: "pre-wrap", overflowWrap: "break-word" }}>
            {renderInline(b.text)}
          </div>
        ),
      )}
    </>
  );
}

/**
 * Render text VERBATIM as a single code block — no markdown parsing, no inline `code`, no
 * bold. For content that is DATA rather than prose: a file printed by `/cat`.
 */
export function Verbatim({ text }: { text: string }): ReactElement {
  return <CodeBlock text={text} />;
}

export default Markdown;
