/**
 * hooks/useDensity.ts — flip <html data-density> (08 §2.4). React-only, no node.
 *
 * comfortable (LM-Studio calm) ↔ compact (Cursor density). Writes the attribute via
 * the pure applyDensity() and persists the choice to localStorage (fail-soft).
 */

import { useCallback, useEffect, useState } from "react";
import { applyDensity } from "../theme.js";
import type { DensityMode } from "../tokens.js";

const KEY = "prometheus.density";

function load(initial: DensityMode): DensityMode {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === "comfortable" || v === "compact" ? v : initial;
  } catch {
    return initial;
  }
}

/** Active density + a setter that applies + persists it. */
export function useDensity(initial: DensityMode = "comfortable"): {
  density: DensityMode;
  setDensity(mode: DensityMode): void;
} {
  const [density, setState] = useState<DensityMode>(() => load(initial));

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  const setDensity = useCallback((mode: DensityMode): void => {
    setState(mode);
    try {
      globalThis.localStorage?.setItem(KEY, mode);
    } catch {
      /* private mode / quota — density won't persist this session. */
    }
  }, []);

  return { density, setDensity };
}
