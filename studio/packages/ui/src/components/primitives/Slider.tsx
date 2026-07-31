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
  { value, min = 0, max = 100, step = 1, onValueChange, className, style, disabled, ...rest },
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
      onFocus={(e) => {
        e.currentTarget.style.boxShadow = FOCUS_RING;
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow = "none";
      }}
      {...rest}
    />
  );
});

export default Slider;
