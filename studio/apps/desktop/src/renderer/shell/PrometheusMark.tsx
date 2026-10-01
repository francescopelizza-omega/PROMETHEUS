// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/PrometheusMark.tsx — the official brand mark (HANDOFF_2 §8.2).
 *
 * The pixel-art human Prometheus, not a flame glyph and not an emoji. ONE component so
 * every brand surface (TopBar, onboarding, About) shows the same artwork at the same
 * fidelity — the previous state was a hand-rolled SVG flame in one place and nothing
 * anywhere else.
 *
 * Two things matter for pixel art and both are easy to lose:
 *   - `imageRendering: "pixelated"` — without it the browser bilinear-filters the 182×206
 *     master down to 19px and the whole thing turns to mush.
 *   - the asset is IMPORTED (electron-vite fingerprints and inlines/copies it), never a
 *     runtime file path. A path would resolve differently in dev vs the packaged app —
 *     which is exactly how the icon went missing before (B6.7).
 *
 * The master is genuinely transparent (handoff_3 §6 replaced the artwork), so the mark
 * composites onto whatever surface it sits on rather than carrying its own dark tile.
 */

import type { CSSProperties, ReactElement } from "react";

import markUrl from "../assets/prometheus-mark.png";

/**
 * The mark's aspect ratio — height is derived, never guessed.
 *
 * 169×190 is the master TRIMMED to its alpha bounding box, which is what
 * `scripts/build-app-icon.mjs` emits (handoff_3 §6). It was 182×206 while the master
 * carried a baked-in opaque background; that padding is gone with the background, so this
 * constant has to move with it or the mark renders letterboxed inside its own box.
 */
const ASPECT = 169 / 190;

export interface PrometheusMarkProps {
  /** rendered height in px. §8.2 specifies ~21px for the TopBar. Default 21. */
  height?: number;
  /**
   * Accessible name. Pass `""` wherever the wordmark "Prometheus" is already rendered
   * beside the mark — otherwise a screen reader announces the brand twice in a row.
   */
  alt?: string;
  className?: string;
  style?: CSSProperties;
}

export function PrometheusMark({
  height = 21,
  alt = "Prometheus",
  className,
  style,
}: PrometheusMarkProps): ReactElement {
  return (
    <img
      src={markUrl}
      alt={alt}
      className={className}
      width={Math.round(height * ASPECT)}
      height={height}
      style={{
        width: Math.round(height * ASPECT),
        height,
        imageRendering: "pixelated",
        display: "block",
        flex: "none",
        ...style,
      }}
    />
  );
}

export default PrometheusMark;
