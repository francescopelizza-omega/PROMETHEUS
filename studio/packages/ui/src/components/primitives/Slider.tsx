// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * Slider.tsx — a single-thumb range slider (file 08 §3.1).
 *
 * Native `<input type=range>` underneath (keyboard + SR for free; arrow keys, Home/
 * End, page step). A token-styled track + brand fill. @radix-ui/react-slider is
 * DECLARED in package.json and swaps in for multi-thumb later; the native control is
 * fully accessible today. Controlled: the host owns `value`.
 */

import { type InputHTMLAttributes, forwardRef } from "react";
import { FOCUS_RING, rad, v } from "./styles.js";

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (value: number) => void;
  "aria-label": string;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  {
    value,
    min = 0,
    max = 100,
    step = 1,
    onValueChange,
    className,
    style,
    disabled,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      className={className}
      onChange={(e) => onValueChange?.(Number(e.currentTarget.value))}
      style={{
        appearance: "none",
        width: "100%",
        height: "6px",
        borderRadius: rad("full"),
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        // brand fill up to the value, neutral track after — tokenized gradient.
        background: `linear-gradient(to right, ${v("brand")} 0%, ${v("brand")} ${pct}%, ${v("border-strong")} ${pct}%, ${v("border-strong")} 100%)`,
        outline: "none",
        ...style,
      }}
      // `{...rest}` FIRST. Spread last, a caller's own onFocus/onBlur silently replaced
      // the composed prop and the tokenized focus ring stopped being drawn on that
      // control. Spreading first lets the handlers below win; they chain the caller's,
      // destructured out of `rest` so the spread cannot reintroduce it.
      {...rest}
      onFocus={(e) => {
        e.currentTarget.style.boxShadow = FOCUS_RING;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow = "none";
        onBlur?.(e);
      }}
    />
  );
});

export default Slider;
