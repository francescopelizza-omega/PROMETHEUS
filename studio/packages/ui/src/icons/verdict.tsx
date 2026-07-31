/**
 * icons/verdict.tsx — the verdict glyphs as a labelled element (08 §2.5/§7).
 *
 * The verdict glyph carries meaning WITHOUT color (allow ✓ · warn ▲ · block ⛔ ·
 * error ⚠), so unlike flame/shield it is NOT aria-hidden — it gets role="img" +
 * an aria-label from the canonical VERDICT_LABEL (CLEAN/WARN/BLOCK/SCAN FAILED).
 */

import type { HTMLAttributes, ReactElement } from "react";
import { VERDICT_GLYPH, VERDICT_LABEL, type VerdictTier } from "../tokens.js";

export interface VerdictGlyphProps extends HTMLAttributes<HTMLSpanElement> {
  verdict: VerdictTier;
}

export function VerdictGlyph({ verdict, ...rest }: VerdictGlyphProps): ReactElement {
  return (
    <span role="img" aria-label={VERDICT_LABEL[verdict]} {...rest}>
      {VERDICT_GLYPH[verdict]}
    </span>
  );
}

export default VerdictGlyph;
