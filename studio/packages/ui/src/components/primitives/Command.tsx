/**
 * Command.tsx — the ⌘K command palette primitive (file 08 §3.1 / §4.2 / §4.3).
 *
 * "Activity rail = where am I; ⌘K = what do I do" (08 §4.2). This is the generic
 * surface: a filter Input + a ranked `role="listbox"` of commands, grouped, with a
 * verdict-gated badge slot per item (08 §4.3 "Verdict-gated actions show an inline
 * badge before they run"). The renderer feeds it from the core editor command-
 * registry; the items here are display rows it maps to. cmdk is DECLARED in
 * package.json and swaps in 1:1.
 *
 * Pure ranking via `filterItems`; full keyboard: ↑/↓ move, ↵ run, Esc closes (§4.3).
 */

import { type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { Z } from "../../tokens/layers.js";
import { Input } from "./Input.js";
import { filterItems } from "./filter.js";
import { useFocusTrap } from "./overlay.js";
import { fs, rad, sp, v } from "./styles.js";

/** One palette row — a command or a "go to" entity (08 §4.3). */
export interface CommandItem {
  id: string;
  label: string;
  /** Optional group header (e.g. "Commands", "Go to", "Models"). */
  group?: string;
  /** A leading glyph/icon. */
  icon?: ReactNode;
  /** A right-aligned hint (shortcut, scope, or a verdict badge node — §4.3). */
  trailing?: ReactNode;
  keywords?: string;
  disabled?: boolean;
  onRun?: () => void;
}

export interface CommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
  placeholder?: string;
  emptyLabel?: string;
  className?: string;
}

export function Command({
  open,
  onOpenChange,
  items,
  placeholder = "Type a command or search…",
  emptyLabel = "No results.",
  className,
}: CommandProps): ReactNode {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  useFocusTrap(panelRef, open, () => onOpenChange(false));

  const ranked = useMemo(
    () => filterItems(query, items, (i) => `${i.label} ${i.keywords ?? ""}`),
    [query, items],
  );
  const runnable = ranked.filter((i) => !i.disabled);

  if (!open) return null;

  function run(idx: number): void {
    const item = runnable[idx];
    if (item && !item.disabled) {
      item.onRun?.();
      onOpenChange(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => (runnable.length === 0 ? 0 : (a + 1) % runnable.length));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => (runnable.length === 0 ? 0 : (a - 1 + runnable.length) % runnable.length));
        break;
      case "Enter":
        e.preventDefault();
        run(active);
        break;
      default:
        break;
    }
  }

  // group rows for headers while keeping the flat active-index over `runnable`.
  let runIdx = -1;
  let lastGroup: string | undefined;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z.palette,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: aria-hidden decorative scrim; keyboard dismissal is Esc (focus-trapped on the palette dialog). */}
      <div
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)" }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className={className}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "640px",
          background: v("bg-surface-2"),
          border: `1px solid ${v("border-strong")}`,
          borderRadius: rad("xl"),
          boxShadow: "0 16px 48px rgba(0,0,0,.5)",
          overflow: "hidden",
          fontFamily: v("font-ui"),
        }}
      >
        <div style={{ padding: sp(4), borderBottom: `1px solid ${v("border-subtle")}` }}>
          <Input
            aria-label="Command palette filter"
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            placeholder={placeholder}
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a command palette is the WAI-ARIA combobox+listbox pattern (cmdk); rich option rows can't be a native <select>. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays on the filter input; options are roved via aria-activedescendant semantics (tabIndex={-1}). */}
        <div
          role="listbox"
          id={listboxId}
          tabIndex={-1}
          style={{ maxHeight: "50vh", overflowY: "auto", padding: sp(2) }}
        >
          {ranked.length === 0 ? (
            <div style={{ padding: sp(4), color: v("text-secondary"), fontSize: fs("small") }}>
              {emptyLabel}
            </div>
          ) : (
            ranked.map((item) => {
              const isRunnable = !item.disabled;
              if (isRunnable) runIdx += 1;
              const thisRunIdx = isRunnable ? runIdx : -1;
              const isActive = thisRunIdx === active;
              const showHeader = item.group != null && item.group !== lastGroup;
              lastGroup = item.group ?? lastGroup;
              return (
                <div key={item.id}>
                  {showHeader && (
                    <div
                      style={{
                        paddingInline: sp(3),
                        paddingBlock: sp(2),
                        color: v("text-secondary"),
                        fontSize: fs("small"),
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}
                    >
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    disabled={item.disabled}
                    onMouseEnter={() => isRunnable && setActive(thisRunIdx)}
                    onClick={() => isRunnable && run(thisRunIdx)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: sp(3),
                      width: "100%",
                      textAlign: "left",
                      border: "none",
                      borderRadius: rad("md"),
                      paddingInline: sp(3),
                      paddingBlock: sp(3),
                      background: isActive
                        ? "color-mix(in srgb, var(--accent) 16%, transparent)"
                        : "transparent",
                      color: item.disabled ? v("text-disabled") : v("text-primary"),
                      cursor: item.disabled ? "not-allowed" : "pointer",
                      fontFamily: "inherit",
                      fontSize: fs("body"),
                    }}
                  >
                    {item.icon != null && (
                      <span
                        aria-hidden="true"
                        style={{
                          display: "inline-flex",
                          width: "1.2em",
                          color: v("text-secondary"),
                        }}
                      >
                        {item.icon}
                      </span>
                    )}
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {item.trailing != null && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: sp(2) }}>
                        {item.trailing}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default Command;
