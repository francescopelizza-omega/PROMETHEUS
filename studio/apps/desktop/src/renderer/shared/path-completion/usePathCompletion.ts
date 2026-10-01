// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/shared/path-completion/usePathCompletion.ts — the "@"-path completion hook for
 * ANY plain text input/textarea (not just AgentPane's composer). Reuses:
 *   - ide/ai/mention.ts's `detectActiveMention` for the caret-anchored "@" trigger (only
 *     bare FILE mentions are acted on here — AgentPane keeps its own richer sym:/folder:/
 *     docs: system separately);
 *   - @prometheus/ui's `useAnchoredLayer` for positioning the dropdown above the input,
 *     the SAME mechanism AgentPane's own mention/slash/model pickers already use;
 *   - `window.prometheus.pathCompletion` (main-process IPC) for the actual directory
 *     listing + fuzzy/frecency ranking — the renderer is sandboxed and cannot readdir.
 *
 * A consuming component wires `moveActive`/`accept`/`close` into its OWN onKeyDown (exactly
 * how AgentPane's existing pickers are wired today) — this hook does not attach any DOM
 * listeners itself, keeping it a plain, composable piece of state.
 */
import { type AnchoredLayerBox, useAnchoredLayer } from "@prometheus/ui";
import { type RefObject, useEffect, useRef, useState } from "react";

import type { PathCompletionEntryView } from "../../../shared/ipc-contract.js";
import { detectActiveMention } from "../../ide/ai/mention.js";
import { acceptMention, resolveMentionDir, splitMentionQuery } from "./logic.js";

export interface UsePathCompletionOptions {
  /** relative "@fragments" resolve against this (typically the open workspace root, or
   *  the dir a settings field's path is relative to). */
  baseDir: string;
  /** required for the opt-in frecency boost + recording a use; omit when no workspace is
   *  open — completion still works, just without memory. */
  workspaceRoot?: string;
  /** the LIVE "Tools ▸ Path Completion" setting value — the caller already reads this via
   *  the normal settings API for the Settings UI; this hook just honors it. */
  frecencyEnabled: boolean;
}

export interface UsePathCompletionResult {
  /** true while a "@"-mention is active under the caret AND has candidates to show. */
  active: boolean;
  items: PathCompletionEntryView[];
  activeIndex: number;
  /** viewport-space box (from useAnchoredLayer) to render the dropdown at; null until
   *  measured or while closed — skip rendering on null (avoids a 0,0-corner flash). */
  box: AnchoredLayerBox | null;
  moveActive: (delta: number) => void;
  /** Accept an entry (defaults to the highlighted one). Splices the text via `onAccept`,
   *  and — for a FILE (not an intermediate directory step) with frecency on — fires the
   *  record-use call. Returns false when there was nothing to accept. */
  accept: (index?: number) => boolean;
  close: () => void;
}

const DROPDOWN_HEIGHT_PX = 220;

/**
 * @param inputRef the text input/textarea the mention lives in (for anchoring the dropdown).
 * @param value the input's current full text.
 * @param caret the input's current caret (`selectionStart`), UTF-16 code units.
 * @param onAccept called with the SPLICED text + the caret to restore after an accept.
 */
export function usePathCompletion(
  inputRef: RefObject<HTMLElement | null>,
  value: string,
  caret: number,
  onAccept: (nextText: string, nextCaret: number) => void,
  opts: UsePathCompletionOptions,
): UsePathCompletionResult {
  const [items, setItems] = useState<PathCompletionEntryView[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // the resolved trigger this items[] answers to — re-derived from `value`/`caret` below,
  // but ALSO needed at accept-time (splice math), so it's kept in state rather than only
  // a local variable inside the effect.
  const [trigger, setTrigger] = useState<{
    start: number;
    token: string;
    dirPart: string;
    dirPath: string;
  } | null>(null);
  // guards against an out-of-order IPC response (fast typing) clobbering a newer one.
  const requestSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    const active = detectActiveMention(value, caret);
    if (!active || active.kind !== "file") {
      setTrigger(null);
      setItems([]);
      return;
    }
    const { dirPart, frag } = splitMentionQuery(active.query);
    const dirPath = resolveMentionDir(dirPart, opts.baseDir);
    setTrigger({ start: active.start, token: active.token, dirPart, dirPath });
    // Clear stale items THE MOMENT the trigger advances (e.g. dirPath just got deeper) —
    // `active` (trigger !== null && items.length > 0) then reads false until the new
    // response lands, so `accept()` can never pair a NEW trigger/dirPath with an OLD
    // directory's items (a real race: typing "@src" then "/" before the first request even
    // resolves used to let Tab splice a sibling-directory entry into the new, deeper path).
    setItems([]);

    const seq = ++requestSeq.current;
    window.prometheus.pathCompletion
      .list(dirPath, frag, opts.workspaceRoot, opts.frecencyEnabled)
      .then((res) => {
        if (!alive || seq !== requestSeq.current) return; // unmounted, or superseded by a newer keystroke
        setItems(res.ok ? (res.entries ?? []) : []);
        setActiveIndex((i) =>
          res.ok && (res.entries?.length ?? 0) > 0 ? Math.min(i, res.entries!.length - 1) : 0,
        );
      })
      .catch(() => {
        if (alive && seq === requestSeq.current) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [value, caret, opts.baseDir, opts.workspaceRoot, opts.frecencyEnabled]);

  const active = trigger !== null && items.length > 0;
  const box = useAnchoredLayer(inputRef, active, {
    width: "anchor",
    height: DROPDOWN_HEIGHT_PX,
    placement: "above",
  });

  const moveActive = (delta: number): void => {
    if (items.length === 0) return;
    const n = items.length;
    setActiveIndex((i) => (((i + delta) % n) + n) % n);
  };

  const accept = (index: number = activeIndex): boolean => {
    const entry = items[index];
    if (!entry || !trigger) return false;
    const result = acceptMention(
      value,
      { start: trigger.start, token: trigger.token },
      trigger.dirPart,
      trigger.dirPath,
      entry.name,
      entry.isDir,
    );
    onAccept(result.text, result.caret);
    setTrigger(null);
    setItems([]);
    if (result.acceptedPath && opts.frecencyEnabled && opts.workspaceRoot) {
      // fire-and-forget — a lost frecency sample is not worth blocking or surfacing.
      void window.prometheus.pathCompletion.recordUse(opts.workspaceRoot, result.acceptedPath);
    }
    return true;
  };

  const close = (): void => {
    setTrigger(null);
    setItems([]);
  };

  return { active, items, activeIndex, box, moveActive, accept, close };
}
