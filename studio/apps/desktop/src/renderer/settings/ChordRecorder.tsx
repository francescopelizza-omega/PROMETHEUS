/**
 * ChordRecorder.tsx — the inline key-capture recorder for the Keymap editor (APP-057).
 *
 * On mount it installs a CAPTURE-PHASE window keydown listener that preventDefault +
 * stopImmediatePropagation on every key, so the pressed chord NEVER reaches the app's own
 * (bubble-phase) `handleChord` — recording ⌘S must not save the file, ⌘K must not open the
 * palette (the plan gotcha). The next committable keydown becomes the pending chord (via the
 * pure `chordFromEvent`); bare Esc cancels; a bare Enter with a pending chord (or the ✓
 * button) confirms. Controlled + tokens only; the translation logic is unit-tested in
 * keymap-capture.test.ts (this thin DOM wrapper is a repo-boundary component).
 *
 * Renderer-SANDBOXED (C5): react + settings-view + keymap-capture only.
 */
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from "react";

import { type CapturePlatform, chordFromEvent, isCancelKey } from "./keymap-capture.js";
import { formatKeys } from "./settings-view.js";

export interface ChordRecorderProps {
  /** platform for modifier folding (defaults to a navigator sniff). */
  platform?: CapturePlatform;
  /** commit the captured chord (a normalized keys string, e.g. "mod+shift+k"). */
  onCommit: (keys: string) => void;
  /** abandon recording (Esc / ✕ / a bare Enter with nothing captured). */
  onCancel: () => void;
}

function detectCapturePlatform(): CapturePlatform {
  if (typeof navigator === "undefined") return "mac";
  return /mac/i.test(navigator.platform || navigator.userAgent) ? "mac" : "other";
}

const pill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2, 4px)",
  padding: "var(--space-1, 2px) var(--space-2, 4px)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius-sm, 4px)",
  background: "var(--bg-inset)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-small-size, 0.8125rem)",
  color: "var(--text-primary)",
};

const iconBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: "0.8rem",
  lineHeight: 1,
  padding: 0,
};

export function ChordRecorder({ platform, onCommit, onCancel }: ChordRecorderProps): ReactElement {
  const [pending, setPending] = useState<string | null>(null);
  const plat = platform ?? detectCapturePlatform();
  // refs keep the capture listener stable (installed once) while reading fresh callbacks.
  const pendingRef = useRef<string | null>(null);
  const onCommitRef = useRef(onCommit);
  const onCancelRef = useRef(onCancel);
  onCommitRef.current = onCommit;
  onCancelRef.current = onCancel;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // swallow the key BEFORE the app's bubble-phase matcher can act on it.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (isCancelKey(e)) {
        onCancelRef.current();
        return;
      }
      // a bare Enter confirms an already-captured chord (you can't bind lone Enter here).
      if (
        e.key === "Enter" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        pendingRef.current
      ) {
        onCommitRef.current(pendingRef.current);
        return;
      }
      const chord = chordFromEvent(e, plat);
      if (chord) {
        pendingRef.current = chord;
        setPending(chord);
      }
    };
    window.addEventListener("keydown", handler, true); // capture phase
    return () => window.removeEventListener("keydown", handler, true);
  }, [plat]);

  return (
    <output style={pill} aria-live="polite" aria-label="Recording shortcut">
      <span style={{ color: pending ? "var(--text-primary)" : "var(--text-secondary)" }}>
        {pending ? formatKeys(pending) : "press keys…"}
      </span>
      <button
        type="button"
        aria-label="Confirm shortcut"
        title="Confirm"
        disabled={!pending}
        onClick={() => pending && onCommit(pending)}
        style={{ ...iconBtn, color: pending ? "var(--ok)" : "var(--text-secondary)" }}
      >
        ✓
      </button>
      <button
        type="button"
        aria-label="Cancel recording"
        title="Cancel (Esc)"
        onClick={onCancel}
        style={{ ...iconBtn, color: "var(--text-secondary)" }}
      >
        ✕
      </button>
    </output>
  );
}

export default ChordRecorder;
