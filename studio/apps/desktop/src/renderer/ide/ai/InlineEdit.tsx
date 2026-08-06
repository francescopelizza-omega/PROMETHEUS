/**
 * ide/ai/InlineEdit.tsx — the Cmd-K inline-edit overlay (file 07 §7.1).
 *
 * Cmd/Ctrl-K over a selection opens this overlay: an instruction input → the AI
 * client streams a proposed replacement → it renders as an inline diff the user can
 * accept (applies via Monaco executeEdits, one undo step) or reject (discards). The
 * STREAM is the renderer thin AI client (ai-client) against a Model Hub endpoint;
 * nothing is written to disk until the buffer is saved like any normal edit (§7.1).
 *
 * This env has no served model, so a real stream cannot run here — the overlay
 * DEGRADES to an honest "no endpoint" notice and we never fake a suggestion. The
 * accept/reject + streaming wiring is correct + decoupled; the math (diff) reuses the
 * pure changeset path via the parent's DiffReview when multi-hunk.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + ai-client + window.prometheus.
 */

import { Button } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RendererEndpoint } from "./ai-client.js";
import { buildInlineEditMessages, streamChat } from "./ai-client.js";
import { diffStats, lineDiff } from "./inline-diff.js";

export interface InlineEditProps {
  /** the selected text to transform (or current line/block). */
  selection: string;
  /** a window of surrounding context for the prompt. */
  context?: string;
  languageId?: string;
  /** the active Model Hub endpoint, or null when none is served. */
  endpoint: RendererEndpoint | null;
  neverSendToCloud: boolean;
  /** accept the streamed replacement (parent applies via Monaco executeEdits). */
  onAccept(replacement: string): void;
  onClose(): void;
}

export function InlineEdit(props: InlineEditProps): ReactElement {
  const { selection, context, languageId, endpoint, neverSendToCloud, onAccept, onClose } = props;
  const [instruction, setInstruction] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // the in-flight stream's aborter — cancelled on unmount and before each new run so
  // a streaming request never outlives the overlay (no setState-after-unmount, no
  // orphaned network stream to the model endpoint).
  const abortRef = useRef<AbortController | null>(null);

  // focus the instruction input on mount (without the flagged autoFocus attribute).
  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const run = useCallback(async () => {
    if (!endpoint || !instruction.trim() || busy) return;
    abortRef.current?.abort(); // cancel any prior in-flight stream
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setStreaming("");
    setError(null);
    try {
      const messages = buildInlineEditMessages({ instruction, selection, context, languageId });
      let acc = "";
      for await (const delta of streamChat(endpoint, messages, {
        neverSendToCloud,
        signal: ac.signal,
      })) {
        if (ac.signal.aborted) break;
        acc += delta;
        setStreaming(acc);
      }
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      // clear busy UNLESS a newer run superseded this one (then it owns the flag).
      // Keying on abort left busy stuck "…" when the stream was aborted but the overlay
      // stayed mounted with no follow-up run.
      if (abortRef.current === ac) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }, [endpoint, instruction, busy, selection, context, languageId, neverSendToCloud]);

  return (
    <div
      role="dialog"
      aria-label="inline edit"
      tabIndex={-1}
      // Escape on the CONTAINER (not the input, which is disabled with no endpoint → never
      // gets the key) so the overlay is always dismissable, incl. the no-model degrade state.
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{
        border: "1px solid var(--accent, #6d5ef0)",
        borderRadius: "var(--radius-md, 6px)",
        background: "var(--bg-surface-2, #16161b)",
        padding: 8,
        fontSize: "0.8rem",
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder={endpoint ? 'e.g. "add retry with backoff"' : "no model endpoint served"}
          aria-label="inline edit instruction"
          disabled={!endpoint || busy}
          style={{
            flex: 1,
            padding: "6px 8px",
            borderRadius: "var(--radius-md, 6px)",
            border: "1px solid var(--border-subtle, #232329)",
            background: "var(--bg-inset, #0b0b0e)",
            color: "var(--text-primary, #e7e7ea)",
            fontFamily: "var(--font-ui, system-ui)",
          }}
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={!endpoint || busy || !instruction.trim()}
        >
          {busy ? "…" : "Cmd-K"}
        </Button>
        {/* always-visible close — the reject button only renders while streaming, so without
            this the no-endpoint / pre-first-token overlay had NO dismiss control. */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="close inline edit"
          onClick={onClose}
        >
          ✕
        </Button>
      </form>

      {error && <p style={{ color: "var(--danger, #ef5a5a)", margin: "6px 0 0" }}>{error}</p>}

      {streaming && (
        <div style={{ marginTop: 6 }}>
          {/* APP-092: a before/after line diff (selection → proposal) so the user reviews the
              exact change before Accept applies it via Monaco executeEdits; Reject discards. */}
          <DiffView before={selection} after={streaming} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => {
                onAccept(streaming);
                onClose();
              }}
            >
              ⏎ accept
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              ✗ reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The before/after line diff (APP-092): del lines tinted danger, add lines ok, context muted.
 *  While the proposal is still streaming this simply re-renders as `after` grows. */
function DiffView({ before, after }: { before: string; after: string }): ReactElement {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  return (
    <div style={{ marginTop: 2 }}>
      <div
        style={{ fontSize: "0.66rem", color: "var(--text-secondary, #9a9aa3)", marginBottom: 2 }}
      >
        <span style={{ color: "var(--ok, #36c46a)" }}>+{stats.added}</span>{" "}
        <span style={{ color: "var(--danger, #ef5a5a)" }}>−{stats.removed}</span> proposed
      </div>
      <div
        aria-label="inline edit diff"
        style={{
          margin: 0,
          maxHeight: 200,
          overflow: "auto",
          background: "var(--bg-inset, #0b0b0e)",
          borderRadius: 4,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "0.72rem",
        }}
      >
        {lines.map((l, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id; index is their position
            key={i}
            style={{
              display: "flex",
              gap: 6,
              padding: "0 6px",
              whiteSpace: "pre-wrap",
              color:
                l.type === "add"
                  ? "var(--ok, #36c46a)"
                  : l.type === "del"
                    ? "var(--danger, #ef5a5a)"
                    : "var(--text-secondary, #9a9aa3)",
              background:
                l.type === "add"
                  ? "color-mix(in srgb, var(--ok) 12%, transparent)"
                  : l.type === "del"
                    ? "color-mix(in srgb, var(--danger) 12%, transparent)"
                    : "transparent",
            }}
          >
            <span aria-hidden="true" style={{ userSelect: "none", opacity: 0.7 }}>
              {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
            </span>
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default InlineEdit;
