/**
 * Tabs.tsx + Accordion.tsx — disclosure primitives (file 08 §3.1).
 *
 * Tabs: a `role="tablist"` with arrow-key roving (Left/Right/Home/End) + the
 * active tab's `aria-selected`; the active indicator is a brand underline (color is
 * paired with selected state + bold, never alone). Accordion: `aria-expanded`
 * sections, single or multiple open. @radix-ui/react-tabs / -accordion are DECLARED
 * in package.json and swap in 1:1. Both controlled.
 */

import { type KeyboardEvent, type ReactNode, useId } from "react";
import { fs, rad, sp, v } from "./styles.js";

/* ── Tabs (pure roving helper is exported for tests) ─────────────────────────── */

/** Compute the next active tab index for an arrow/Home/End key (pure, testable). */
export function nextTabIndex(key: string, current: number, count: number): number {
  if (count === 0) return -1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}

export interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  "aria-label"?: string;
  className?: string;
}

export function Tabs({
  items,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  className,
}: TabsProps): ReactNode {
  const baseId = useId();
  const activeIndex = items.findIndex((t) => t.id === value);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const first = nextTabIndex(e.key, activeIndex, items.length);
    if (first === activeIndex || first < 0) return;
    e.preventDefault();
    // KEEP GOING past a disabled tab instead of stopping on it. The old code moved one step
    // and then simply did nothing if that tab was disabled, so a disabled tab was a wall:
    // every arrow press from its neighbour was swallowed and the tabs beyond it could not be
    // reached by keyboard at all. `nextTabIndex` is left alone — Segmented.tsx imports it and
    // depends on its wrap arithmetic — so the skipping is done here, bounded by items.length
    // so an all-disabled list terminates instead of spinning.
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "Home";
    let ni = first;
    for (let n = 0; n < items.length; n++) {
      const t = items[ni];
      if (t && !t.disabled) {
        onValueChange(t.id);
        return;
      }
      ni = forward ? (ni + 1) % items.length : (ni - 1 + items.length) % items.length;
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={className}
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: sp(1),
        borderBottom: `1px solid ${v("border-subtle")}`,
      }}
    >
      {items.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${baseId}-${tab.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => !tab.disabled && onValueChange(tab.id)}
            style={{
              appearance: "none",
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${selected ? v("brand") : "transparent"}`,
              color: selected ? v("text-primary") : v("text-secondary"),
              cursor: tab.disabled ? "not-allowed" : "pointer",
              opacity: tab.disabled ? 0.5 : 1,
              fontFamily: v("font-ui"),
              fontSize: fs("body"),
              fontWeight: selected ? 600 : 500,
              paddingInline: sp(4),
              paddingBlock: sp(3),
              outline: "none",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Accordion ───────────────────────────────────────────────────────────────── */

export interface AccordionItem {
  id: string;
  trigger: ReactNode;
  content: ReactNode;
}

export interface AccordionProps {
  items: AccordionItem[];
  /** The set of currently-open item ids (controlled). */
  open: string[];
  onOpenChange: (open: string[]) => void;
  /** Allow only one section open at a time (default false = multiple). */
  single?: boolean;
  className?: string;
}

export function Accordion({
  items,
  open,
  onOpenChange,
  single = false,
  className,
}: AccordionProps): ReactNode {
  const baseId = useId();
  function toggle(id: string): void {
    const isOpen = open.includes(id);
    if (single) {
      onOpenChange(isOpen ? [] : [id]);
    } else {
      onOpenChange(isOpen ? open.filter((x) => x !== id) : [...open, id]);
    }
  }
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column" }}>
      {items.map((item) => {
        const isOpen = open.includes(item.id);
        const triggerId = `${baseId}-${item.id}-trigger`;
        const panelId = `${baseId}-${item.id}-panel`;
        return (
          <div key={item.id} style={{ borderBottom: `1px solid ${v("border-subtle")}` }}>
            <h3 style={{ margin: 0 }}>
              <button
                type="button"
                id={triggerId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(item.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: sp(3),
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  color: v("text-primary"),
                  cursor: "pointer",
                  fontFamily: v("font-ui"),
                  fontSize: fs("body"),
                  fontWeight: 600,
                  paddingBlock: sp(4),
                  outline: "none",
                }}
              >
                <span aria-hidden="true" style={{ color: v("text-secondary"), width: "1em" }}>
                  {isOpen ? "▾" : "▸"}
                </span>
                <span style={{ flex: 1 }}>{item.trigger}</span>
              </button>
            </h3>
            {isOpen && (
              <div
                id={panelId}
                role="region"
                aria-labelledby={triggerId}
                style={{
                  paddingBottom: sp(4),
                  paddingLeft: sp(8),
                  color: v("text-secondary"),
                  fontFamily: v("font-ui"),
                  fontSize: fs("small"),
                }}
              >
                {item.content}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default Tabs;
