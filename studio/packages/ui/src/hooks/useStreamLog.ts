// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * hooks/useStreamLog.ts — a JSON-lines tail buffer for <StreamLog> (08 §3.2/§3).
 *
 * The sidecar streams stderr JSON-lines (file 02); this hook keeps a bounded,
 * severity-tinted line buffer + an auto-scroll flag the StreamLog component reads.
 * React-only (no node) — the HOST feeds parsed StreamLogLine records via append().
 */

import { useCallback, useRef, useState } from "react";
import type { StreamLogLine } from "../patterns/types.js";

export interface UseStreamLogResult {
  lines: StreamLogLine[];
  /** append one parsed line (drops the oldest past `max`). */
  append(line: StreamLogLine): void;
  /** append a batch (a flush of buffered lines). */
  appendMany(batch: readonly StreamLogLine[]): void;
  clear(): void;
  /** whether the view should pin to the newest line (toggled by the component). */
  autoScroll: boolean;
  setAutoScroll(on: boolean): void;
}

/** Tail a JSON-lines stream into a bounded buffer (default 1000 lines). */
export function useStreamLog(max = 1000): UseStreamLogResult {
  const [lines, setLines] = useState<StreamLogLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const cap = useRef(max);
  cap.current = max;

  const append = useCallback((line: StreamLogLine): void => {
    setLines((prev) => {
      const next = prev.length >= cap.current ? prev.slice(prev.length - cap.current + 1) : prev;
      return [...next, line];
    });
  }, []);

  const appendMany = useCallback((batch: readonly StreamLogLine[]): void => {
    if (batch.length === 0) return;
    setLines((prev) => {
      const merged = [...prev, ...batch];
      return merged.length > cap.current ? merged.slice(merged.length - cap.current) : merged;
    });
  }, []);

  const clear = useCallback((): void => setLines([]), []);

  return { lines, append, appendMany, clear, autoScroll, setAutoScroll };
}
