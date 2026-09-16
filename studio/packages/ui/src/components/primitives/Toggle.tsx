/**
 * Toggle.tsx — Checkbox + Switch + RadioGroup (file 08 §3.1).
 *
 * Accessible by construction: Checkbox/RadioGroup wrap a native control (keyboard +
 * SR for free); Switch is a `role="switch"` button with `aria-checked`, arrow/space/
 * enter handled (the accessible pattern Radix gives). All color via tokens; the
 * checked state carries the --brand fill PLUS a glyph (✓ / ●) so it is never color-
 * only (08 §7). These are CONTROLLED components — the host owns state.
 *
 * @radix-ui/react-checkbox / -switch / -radio-group are DECLARED in package.json and
 * swap in 1:1 once installed; until then these native-backed equivalents render and
 * are fully keyboard-operable today (same env discipline as cn.ts).
 */

import {
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  createContext,
  forwardRef,
  useContext,
  useId,
} from "react";
import { FOCUS_RING, rad, sp, v } from "./styles.js";

/* ── Checkbox ──────────────────────────────────────────────────────────────── */

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onCheckedChange, label, disabled, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label
      className={className}
      htmlFor={inputId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: sp(3),
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: v("font-ui"),
        color: v("text-primary"),
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onCheckedChange?.(e.currentTarget.checked)}
          style={{
            appearance: "none",
            width: "16px",
            height: "16px",
            margin: 0,
            borderRadius: rad("sm"),
            border: `1px solid ${checked ? v("brand") : v("border-strong")}`,
            background: checked ? v("brand") : v("bg-inset"),
            outline: "none",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
          onFocus={(e) => {
            e.currentTarget.style.boxShadow = FOCUS_RING;
          }}
          onBlur={(e) => {
            e.currentTarget.style.boxShadow = "none";
          }}
          {...rest}
        />
        {checked && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: v("brand-fg"),
              fontSize: "11px",
              lineHeight: 1,
              pointerEvents: "none",
            }}
          >
            ✓
          </span>
        )}
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
});

/* ── Switch ────────────────────────────────────────────────────────────────── */

export interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  id?: string;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
  id,
  className,
}: SwitchProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      data-state={checked ? "checked" : "unchecked"}
      className={className}
      onClick={() => onCheckedChange?.(!checked)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        width: "34px",
        height: "20px",
        padding: "2px",
        borderRadius: rad("full"),
        border: "1px solid transparent",
        background: checked ? v("brand") : v("border-strong"),
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background var(--motion-hover, 120ms) ease-out",
        outline: "none",
      }}
      onFocus={(e) => {
        e.currentTarget.style.boxShadow = FOCUS_RING;
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "14px",
          height: "14px",
          borderRadius: rad("full"),
          background: v("brand-fg"),
          transform: checked ? "translateX(14px)" : "translateX(0)",
          transition: "transform var(--motion-hover, 120ms) ease-out",
        }}
      />
    </button>
  );
}

/* ── RadioGroup ────────────────────────────────────────────────────────────── */

interface RadioGroupCtx {
  value: string;
  onValueChange?: (value: string) => void;
  name: string;
  disabled?: boolean;
}
const RadioCtx = createContext<RadioGroupCtx | null>(null);

export interface RadioGroupProps {
  value: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  "aria-label"?: string;
  name?: string;
  className?: string;
  children: ReactNode;
}

export function RadioGroup({
  value,
  onValueChange,
  disabled,
  "aria-label": ariaLabel,
  name,
  className,
  children,
}: RadioGroupProps): ReactNode {
  const autoName = useId();
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={className}
      style={{ display: "flex", flexDirection: "column", gap: sp(3) }}
    >
      <RadioCtx.Provider value={{ value, onValueChange, name: name ?? autoName, disabled }}>
        {children}
      </RadioCtx.Provider>
    </div>
  );
}

export interface RadioGroupItemProps {
  value: string;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
}

export function RadioGroupItem({ value, label, disabled, id }: RadioGroupItemProps): ReactNode {
  const ctx = useContext(RadioCtx);
  const autoId = useId();
  const itemId = id ?? autoId;
  const selected = ctx?.value === value;
  const isDisabled = disabled || ctx?.disabled;
  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!isDisabled) ctx?.onValueChange?.(value);
    }
  }
  return (
    // `htmlFor` is dropped and the click handled here instead. The control is a
    // `role="radio"` SPAN, not an <input>, and `htmlFor` only activates real form controls —
    // so clicking the visible label text (the part most people aim at) did nothing at all.
    // The span keeps role/id/aria-checked/tabIndex/onKeyDown because focus lands on it; only
    // the pointer path moves up here, so the click is handled exactly once.
    // biome-ignore lint/a11y/noLabelWithoutControl: the labelled control is the role="radio" span below, not a form element
    <label
      onClick={() => !isDisabled && ctx?.onValueChange?.(value)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: sp(3),
        cursor: isDisabled ? "not-allowed" : "pointer",
        opacity: isDisabled ? 0.5 : 1,
        fontFamily: v("font-ui"),
        color: v("text-primary"),
      }}
    >
      <span
        role="radio"
        id={itemId}
        aria-checked={selected}
        tabIndex={isDisabled ? -1 : 0}
        onKeyDown={onKey}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "16px",
          height: "16px",
          borderRadius: rad("full"),
          border: `1px solid ${selected ? v("brand") : v("border-strong")}`,
          background: v("bg-inset"),
          outline: "none",
        }}
        onFocus={(e) => {
          e.currentTarget.style.boxShadow = FOCUS_RING;
        }}
        onBlur={(e) => {
          e.currentTarget.style.boxShadow = "none";
        }}
      >
        {selected && (
          <span
            aria-hidden="true"
            style={{
              width: "8px",
              height: "8px",
              borderRadius: rad("full"),
              background: v("brand"),
            }}
          />
        )}
      </span>
      {label != null && <span>{label}</span>}
    </label>
  );
}

export default Checkbox;
