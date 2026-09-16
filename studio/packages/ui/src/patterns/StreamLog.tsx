/**
 * StreamLog.tsx — the sidecar stderr JSON-lines tail (08 §3.2 / §2.5). Monospace,
 * auto-scroll, severity-tinted lines, with a "copy as text" affordance. Long engine
 * ops stream REAL JSON-lines progress here (never a fake spinner, 08 §2.5).
 *
 * Binds `StreamLogLine[]` (mirror of a sidecar stderr JSON-line) via a TYPE-ONLY
 * import (C5). The renderer feeds the tailed lines straight in.
 *
 * GOLDEN RULE (C5): every line's `text` is rendered INERT (run through `inert()` —
 * ANSI + control stripped) as a React TEXT child, NEVER via dangerouslySetInnerHTML.
 * The line tint is a pure projection of the engine's `level` (color + a level glyph,
 * never color alone). Auto-scroll pins to the newest line unless the user scrolls up.
 */

import { type ReactElement, useEffect, useRef } from "react";
import type { StreamLogLine } from "./types.js";
import { inert, streamLevelVar } from "./util.js";

export interface StreamLogProps {
  lines: readonly StreamLogLine[];
  /** Auto-scroll to the newest line when it arrives (default true). */
  autoScroll?: boolean;
  /** Max height before the tail scrolls (px or CSS length). */
  maxHeight?: string | number;
  /** Show the "copy as text" affordance (default true). */
  showCopy?: boolean;
  className?: string;
}

/** A short glyph per log level (carries the level WITHOUT color, 08 §7). */
function levelGlyph(level: StreamLogLine["level"]): string {
  switch (level) {
    case "error":
      return "✗";
    case "warn":
      return "▲";
    case "success":
      return "✓";
    case "info":
      return "·";
    default:
      return " "; // debug / undefined
  }
}

/** Flatten the visible lines to plain text (the "copy as text" payload). */
function asText(lines: readonly StreamLogLine[]): string {
  return lines.map((l) => inert(l.text)).join("\n");
}

export function StreamLog({
  lines,
  autoScroll = true,
  maxHeight = 240,
  showCopy = true,
  className,
}: StreamLogProps): ReactElement {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Track whether the user is pinned to the bottom (so we don't yank them up).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on every new line; `lines.length` is the intended trigger.
  useEffect(() => {
    if (autoScroll && pinnedRef.current) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [lines.length, autoScroll]);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md, 6px)",
        background: "var(--bg-inset)",
        overflow: "hidden",
        fontFamily: "var(--font-mono)",
      }}
    >
      {showCopy && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "var(--space-2, 4px)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <button
            type="button"
            onClick={() => {
              const text = asText(lines);
              navigator?.clipboard?.writeText?.(text);
            }}
            style={{
              background: "transparent",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-sm, 4px)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontFamily: "var(--font-ui)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              paddingInline: "var(--space-3, 6px)",
              paddingBlock: "var(--space-1, 2px)",
            }}
          >
            Copy as text
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Stream log"
        style={{
          overflow: "auto",
          maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight,
          padding: "var(--space-3, 6px)",
          fontSize: "var(--text-code-size, 0.78125rem)",
          lineHeight: 1.5,
        }}
      >
        {lines.map((line) => {
          const color = streamLevelVar(line.level);
          return (
            <div
              key={line.id}
              data-level={line.level ?? "debug"}
              style={{
                display: "flex",
                gap: "var(--space-3, 6px)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {line.at != null && (
                <span style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
                  {inert(line.at)}
                </span>
              )}
              <span aria-hidden="true" style={{ color, flexShrink: 0, width: "1ch" }}>
                {levelGlyph(line.level)}
              </span>
              <span style={{ color }}>{inert(line.text)}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

export default StreamLog;
