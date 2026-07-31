/**
 * Input.tsx / Textarea.tsx — text-entry primitives (file 08 §3.1).
 *
 * Token-styled inset fields with a tokenized focus ring (08 §7). `invalid` switches
 * the border to --danger (paired with an aria-invalid + a glyph at the call site, so
 * color is never the sole signal). `mono` flips to the mono font for paths/ids/cmds.
 */

import {
  type CSSProperties,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
} from "react";
import { type VariantProps, cva } from "../util/cva.js";
import { fs, HOVER_TRANSITION, controlSurface, focusRingHandlers, sp, v } from "./styles.js";

export const inputVariants = cva(
  "prom-input w-full rounded-md bg-bg-inset text-text-primary border border-border-strong transition",
  {
    variants: {
      invalid: { true: "border-danger", false: "" },
      mono: { true: "font-mono", false: "font-ui" },
      size: { sm: "h-7 text-small", md: "text-body" },
    },
    defaultVariants: { invalid: false, mono: false, size: "md" },
  },
);

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">,
    Pick<VariantProps<typeof inputVariants>, "size"> {
  invalid?: boolean;
  mono?: boolean;
}

function fieldStyle(invalid: boolean, mono: boolean): CSSProperties {
  return {
    ...controlSurface(),
    width: "100%",
    paddingInline: sp(4),
    paddingBlock: sp(3),
    border: `1px solid ${invalid ? v("danger") : v("border-strong")}`,
    fontFamily: mono ? v("font-mono") : v("font-ui"),
    transition: HOVER_TRANSITION,
    outline: "none",
  };
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, mono = false, size = "md", className, style, ...rest },
  ref,
) {
  const ring = focusRingHandlers();
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      data-invalid={invalid || undefined}
      className={inputVariants({ invalid, mono, size, className })}
      style={{
        ...fieldStyle(invalid, mono),
        height: size === "sm" ? "28px" : "var(--row-h, 36px)",
        fontSize: size === "sm" ? fs("small") : fs("body"),
        ...style,
      }}
      onFocus={(e) => {
        ring.onFocus(e);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        ring.onBlur(e);
        rest.onBlur?.(e);
      }}
      {...rest}
    />
  );
});

export const textareaVariants = cva(
  "prom-textarea w-full rounded-md bg-bg-inset text-text-primary border border-border-strong transition",
  {
    variants: {
      invalid: { true: "border-danger", false: "" },
      mono: { true: "font-mono", false: "font-ui" },
    },
    defaultVariants: { invalid: false, mono: false },
  },
);

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, mono = false, rows = 4, className, style, ...rest },
  ref,
) {
  const ring = focusRingHandlers();
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      data-invalid={invalid || undefined}
      className={textareaVariants({ invalid, mono, className })}
      style={{
        ...fieldStyle(invalid, mono),
        minHeight: "calc(var(--row-h, 36px) * 2)",
        lineHeight: 1.5,
        resize: "vertical",
        ...style,
      }}
      onFocus={(e) => {
        ring.onFocus(e);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        ring.onBlur(e);
        rest.onBlur?.(e);
      }}
      {...rest}
    />
  );
});

export default Input;
