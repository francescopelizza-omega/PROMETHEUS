// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * Select.tsx + Combobox.tsx — choice primitives (file 08 §3.1).
 *
 * Select: a `role="listbox"` opened from a button trigger, arrow-key roving, Enter
 * to choose, Esc to close (the §5.3 interpreter / manager pickers). Combobox: a
 * filterable Select (an Input + the `filterItems` subsequence ranker). @radix-ui/
 * react-select + a downshift/cmdk combobox are DECLARED in package.json and swap in
 * 1:1; these render + are keyboard-operable today.
 */

import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Z } from "../../tokens/layers.js";
import { Input } from "./Input.js";
import { useAnchoredLayer } from "./anchor.js";
import { filterItems } from "./filter.js";
import { menuKeyHandler, useDismiss } from "./overlay.js";
import { fs, FOCUS_RING, rad, sp, v } from "./styles.js";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** A plain-text key the Combobox filters on (defaults to value). */
  text?: string;
  disabled?: boolean;
}

function OptionList({
  options,
  active,
  setActive,
  onChoose,
  value,
  listboxId,
}: {
  options: SelectOption[];
  active: number;
  setActive: (i: number) => void;
  onChoose: (v: string) => void;
  value?: string;
  listboxId: string;
}): ReactNode {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a custom listbox of rich option rows cannot be a native <select> (it renders nodes/glyphs); this is the WAI-ARIA listbox pattern Radix/cmdk use.
    // biome-ignore lint/a11y/useFocusableInteractive: the listbox container is programmatically focus-managed via roving option buttons; it carries tabIndex={-1}.
    <div
      role="listbox"
      id={listboxId}
      tabIndex={-1}
      style={{
        maxHeight: "260px",
        overflowY: "auto",
        background: v("bg-surface-2"),
        border: `1px solid ${v("border-strong")}`,
        borderRadius: rad("md"),
        boxShadow: "0 8px 24px rgba(0,0,0,.35)",
        padding: sp(1),
      }}
    >
      {options.length === 0 ? (
        <div style={{ padding: sp(3), color: v("text-secondary"), fontSize: fs("small") }}>
          No matches.
        </div>
      ) : (
        options.map((opt, idx) => {
          const selected = opt.value === value;
          const isActive = idx === active;
          return (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={selected}
              disabled={opt.disabled}
              onMouseEnter={() => setActive(idx)}
              onClick={() => !opt.disabled && onChoose(opt.value)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: sp(2),
                width: "100%",
                textAlign: "left",
                border: "none",
                borderRadius: rad("sm"),
                paddingInline: sp(3),
                paddingBlock: sp(2),
                background: isActive
                  ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                  : "transparent",
                color: v("text-primary"),
                cursor: opt.disabled ? "not-allowed" : "pointer",
                opacity: opt.disabled ? 0.5 : 1,
                fontFamily: v("font-ui"),
                fontSize: fs("body"),
              }}
            >
              <span aria-hidden="true" style={{ width: "1em", color: v("accent") }}>
                {selected ? "✓" : ""}
              </span>
              <span style={{ flex: 1 }}>{opt.label}</span>
            </button>
          );
        })
      )}
    </div>
  );
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  "aria-label": string;
  disabled?: boolean;
  className?: string;
}

export function Select({
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  "aria-label": ariaLabel,
  disabled,
  className,
}: SelectProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  useDismiss(layerRef, triggerRef, open, () => setOpen(false));
  /**
   * The option list is PORTALED to `document.body`, not absolutely positioned in the field.
   *
   * `position: absolute` keeps it inside every ancestor's clipping box, and this control is
   * used inside panels that scroll or hide their overflow — the settings panes, the chat
   * composer, the model pickers. The list was cut off at the panel edge, so the options a
   * user most needs to reach (the ones at the bottom of a long list) could not be seen at
   * all, and near the viewport bottom it opened off-screen entirely.
   *
   * `useAnchoredLayer` measures the trigger and clamps the layer into the viewport.
   * `layerRef` stays on the portaled node so `useDismiss` still recognises clicks inside it
   * as "not outside" — without that, opening the list would immediately close it.
   */
  const box = useAnchoredLayer(triggerRef, open, {
    width: "anchor",
    height: 260, // layout-allow: the layer's expected height for viewport clamping, not a pane
    placement: "below",
  });

  const selected = options.find((o) => o.value === value);
  const enabled = options.filter((o) => !o.disabled);

  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    menuKeyHandler(
      e,
      enabled.length,
      active,
      setActive,
      (i) => {
        const opt = enabled[i];
        if (opt) {
          onValueChange(opt.value);
          setOpen(false);
        }
      },
      () => setOpen(false),
    );
  }

  return (
    <div className={className} style={{ position: "relative" }} onKeyDown={onKey}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: sp(3),
          width: "100%",
          height: "var(--row-h, 36px)",
          paddingInline: sp(4),
          background: v("bg-inset"),
          border: `1px solid ${v("border-strong")}`,
          borderRadius: rad("md"),
          color: selected ? v("text-primary") : v("text-secondary"),
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          fontFamily: v("font-ui"),
          fontSize: fs("body"),
          outline: "none",
        }}
        onFocus={(e) => {
          e.currentTarget.style.boxShadow = FOCUS_RING;
        }}
        onBlur={(e) => {
          e.currentTarget.style.boxShadow = "none";
        }}
      >
        <span>{selected?.label ?? placeholder}</span>
        <span aria-hidden="true" style={{ color: v("text-secondary") }}>
          ▾
        </span>
      </button>
      {open &&
        box &&
        createPortal(
          <div
            ref={layerRef}
            style={{
              position: "fixed",
              left: box.left,
              top: box.top,
              width: box.width,
              zIndex: Z.dropdown,
            }}
          >
            {/* `active` indexes the ENABLED subset (keyboard movement skips disabled rows),
              while OptionList renders the FULL list — so with any disabled option present the
              highlight landed on the wrong row. Map at this boundary only: Combobox shares
              OptionList and its indices are already in the full space. `enabled` holds the
              same object references as `options`, so indexOf is exact. */}
            <OptionList
              options={options}
              active={active >= 0 ? options.indexOf(enabled[active] as SelectOption) : -1}
              setActive={(i) => setActive(enabled.indexOf(options[i] as SelectOption))}
              value={value}
              listboxId={listboxId}
              onChoose={(v2) => {
                onValueChange(v2);
                setOpen(false);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ── Combobox — a filterable Select ──────────────────────────────────────────── */

export interface ComboboxProps {
  options: SelectOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  "aria-label": string;
  className?: string;
}

export function Combobox({
  options,
  value,
  onValueChange,
  placeholder = "Search…",
  "aria-label": ariaLabel,
  className,
}: ComboboxProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  useDismiss(layerRef, inputRef, open, () => setOpen(false));
  // Portaled for the same reason as Select above — see that comment.
  const box = useAnchoredLayer(inputRef, open, {
    width: "anchor",
    height: 260, // layout-allow: the layer's expected height for viewport clamping, not a pane
    placement: "below",
  });

  const filtered = useMemo(
    () => filterItems(query, options, (o) => o.text ?? o.value).filter((o) => !o.disabled),
    [query, options],
  );

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (!open) setOpen(true);
    menuKeyHandler(
      e,
      filtered.length,
      active,
      setActive,
      (i) => {
        const opt = filtered[i];
        if (opt) {
          onValueChange(opt.value);
          setQuery("");
          setOpen(false);
        }
      },
      () => setOpen(false),
    );
  }

  return (
    <div className={className} style={{ position: "relative" }}>
      <Input
        ref={inputRef}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open &&
        box &&
        createPortal(
          <div
            ref={layerRef}
            style={{
              position: "fixed",
              left: box.left,
              top: box.top,
              width: box.width,
              zIndex: Z.dropdown,
            }}
          >
            <OptionList
              options={filtered}
              active={active}
              setActive={setActive}
              value={value}
              listboxId={listboxId}
              onChoose={(v2) => {
                onValueChange(v2);
                setQuery("");
                setOpen(false);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

export default Select;
