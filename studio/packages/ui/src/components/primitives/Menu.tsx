/**
 * Menu.tsx — DropdownMenu + ContextMenu (file 08 §3.1).
 *
 * One menu model behind two triggers: DropdownMenu opens below a button (click /
 * Down-arrow), ContextMenu opens at the pointer on right-click. Both render a
 * `role="menu"` with `role="menuitem"` rows, full arrow-key roving + Enter/Space +
 * Esc (menuKeyHandler), and outside-click dismissal (useDismiss). @radix-ui/react-
 * dropdown-menu / -context-menu are DECLARED in package.json and swap in 1:1.
 */

import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { menuKeyHandler, useDismiss } from "./overlay.js";
import { fs, FOCUS_RING, rad, sp, v } from "./styles.js";

/** A single menu entry (a separator carries no `onSelect`). */
export interface MenuItem {
  id: string;
  label: ReactNode;
  /** A leading glyph/icon. */
  icon?: ReactNode;
  /** Right-aligned shortcut hint, e.g. "⌘K". */
  shortcut?: string;
  /** `danger` tints the row --danger (destructive). */
  destructive?: boolean;
  disabled?: boolean;
  /** A non-selectable visual separator. */
  separator?: boolean;
  onSelect?: () => void;
}

function MenuList({
  items,
  onClose,
  listRef,
}: {
  items: MenuItem[];
  onClose: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}): ReactNode {
  const selectable = items.filter((i) => !i.separator && !i.disabled);
  // start on the first selectable row so the menu opens with a visible highlight and
  // Enter activates immediately (was -1 → first Enter did nothing, no focus shown).
  const [active, setActive] = useState(0);

  // index map: visual index → selectable index (for arrow roving by selectable).
  function activate(selIdx: number): void {
    const item = selectable[selIdx];
    if (item) {
      item.onSelect?.();
      onClose();
    }
  }

  useEffect(() => {
    listRef.current?.focus();
  }, [listRef]);

  return (
    <div
      ref={listRef}
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => menuKeyHandler(e, selectable.length, active, setActive, activate, onClose)}
      style={{
        minWidth: "180px",
        background: v("bg-surface-2"),
        border: `1px solid ${v("border-strong")}`,
        borderRadius: rad("lg"),
        boxShadow: "0 8px 24px rgba(0,0,0,.35)",
        padding: sp(2),
        outline: "none",
        fontFamily: v("font-ui"),
        fontSize: fs("body"),
      }}
    >
      {items.map((item) => {
        if (item.separator) {
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: WAI-ARIA menu `separator` is a non-focusable structural role (no tabindex by spec).
            <div
              key={item.id}
              role="separator"
              style={{ height: "1px", background: v("border-subtle"), margin: `${sp(2)} 0` }}
            />
          );
        }
        const selIdx = selectable.indexOf(item);
        const isActive = selIdx === active;
        const color = item.destructive ? v("danger") : v("text-primary");
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            aria-disabled={item.disabled || undefined}
            onMouseEnter={() => setActive(selIdx)}
            onClick={() => {
              if (!item.disabled) {
                item.onSelect?.();
                onClose();
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: sp(3),
              width: "100%",
              textAlign: "left",
              paddingInline: sp(3),
              paddingBlock: sp(2),
              border: "none",
              borderRadius: rad("sm"),
              background: isActive
                ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                : "transparent",
              color,
              cursor: item.disabled ? "not-allowed" : "pointer",
              opacity: item.disabled ? 0.5 : 1,
              fontFamily: "inherit",
              fontSize: "inherit",
            }}
          >
            {item.icon != null && (
              <span aria-hidden="true" style={{ display: "inline-flex", width: "1.1em" }}>
                {item.icon}
              </span>
            )}
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.shortcut != null && (
              <span
                aria-hidden="true"
                style={{
                  color: v("text-secondary"),
                  fontFamily: v("font-mono"),
                  fontSize: fs("small"),
                }}
              >
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── DropdownMenu ────────────────────────────────────────────────────────────── */

export interface DropdownMenuProps {
  trigger: ReactElement;
  items: MenuItem[];
  align?: "start" | "end";
  className?: string;
}

export function DropdownMenu({
  trigger,
  items,
  align = "start",
  className,
}: DropdownMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDismiss(listRef, triggerRef, open, () => setOpen(false));

  const triggerEl = cloneElement(
    trigger as ReactElement<Record<string, unknown>>,
    {
      ref: triggerRef,
      "aria-haspopup": "menu",
      "aria-expanded": open,
      onClick: (e: unknown) => {
        (trigger.props as { onClick?: (e: unknown) => void }).onClick?.(e);
        setOpen((o) => !o);
      },
      // keyboard-open parity: ArrowDown / Enter / Space open the menu (was click-only).
      onKeyDown: (e: React.KeyboardEvent) => {
        (trigger.props as { onKeyDown?: (e: React.KeyboardEvent) => void }).onKeyDown?.(e);
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
        }
      },
    } as Record<string, unknown>,
  );

  return (
    <span style={{ position: "relative", display: "inline-flex" }} className={className}>
      {triggerEl}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            [align === "end" ? "right" : "left"]: 0,
            zIndex: 950,
          }}
        >
          <MenuList items={items} onClose={() => setOpen(false)} listRef={listRef} />
        </div>
      )}
    </span>
  );
}

/* ── ContextMenu ─────────────────────────────────────────────────────────────── */

export interface ContextMenuProps {
  items: MenuItem[];
  /** The area whose right-click opens the menu. */
  children: ReactNode;
  className?: string;
}

export function ContextMenu({ items, children, className }: ContextMenuProps): ReactNode {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDismiss(listRef, triggerRef, pos != null, () => setPos(null));

  return (
    <div
      ref={triggerRef as React.RefObject<HTMLDivElement>}
      className={className}
      onContextMenu={(e) => {
        e.preventDefault();
        // clamp to the viewport so a right-click near the right/bottom edge doesn't
        // render the menu partly off-screen and unclickable (no collision flip here).
        const MENU_W = 200;
        const MENU_H = 40 + items.length * 32;
        const vw = typeof window !== "undefined" ? window.innerWidth : e.clientX + MENU_W;
        const vh = typeof window !== "undefined" ? window.innerHeight : e.clientY + MENU_H;
        setPos({
          x: Math.max(4, Math.min(e.clientX, vw - MENU_W)),
          y: Math.max(4, Math.min(e.clientY, vh - MENU_H)),
        });
      }}
      style={{ display: "contents" }}
    >
      {children}
      {pos != null && (
        <div
          style={{
            position: "fixed",
            top: pos.y,
            left: pos.x,
            zIndex: 1300,
          }}
          onFocus={(e) => {
            e.currentTarget.style.boxShadow = FOCUS_RING;
          }}
        >
          <MenuList items={items} onClose={() => setPos(null)} listRef={listRef} />
        </div>
      )}
    </div>
  );
}

export default DropdownMenu;
