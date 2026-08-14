/**
 * shell/CommandPalette.tsx — the ⌘K universal accelerator (file 08 §4.2/§4.3).
 *
 * The single command surface (Cursor's core habit): searches COMMANDS (the core
 * editor command-registry ids, re-stated via the IDE palette's PALETTE_COMMANDS —
 * the renderer can't import core's runtime, C5) PLUS the activity-rail GO-TO nav
 * (Home/Editor/Catalog/Model Hub/…). Filtering + ranking is the shared PURE
 * filterPalette() (fuzzy subsequence) from @prometheus/ui (also drives the prometheus
 * TUI palette, §8). Verdict-gated actions can carry a pinned inline verdict — a
 * cosmetic badge before they run; the engine still decides (C5).
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the IDE palette source only.
 */

import {
  ACTIVITIES,
  type ActivityId,
  type PaletteItem,
  VerdictBadge,
  type VerdictTier,
  Z,
  filterPalette,
} from "@prometheus/ui";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import { commandPaletteRows } from "../commands/registry.js";
import { useFocusTrap } from "./a11y.js";

export interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  /** navigate to an activity route (the §4.3 "Go to" section). */
  onNavigate(id: ActivityId): void;
  /** dispatch a command id (the shell wires the body; mirrors file 07). */
  onRunCommand(id: string): void;
}

/** Map a §4.3 pinned verdict to a renderable VerdictBadge tier (scanning → none). */
function pinnedTier(verdict: PaletteItem["verdict"]): VerdictTier | null {
  switch (verdict) {
    case "allow":
    case "warn":
    case "block":
    case "error":
      return verdict;
    default:
      return null; // "scanning" or undefined → no badge yet
  }
}

/** Build the full palette item list: nav go-to + the registry commands (§4.3, leap #1). */
function buildItems(): PaletteItem[] {
  const nav: PaletteItem[] = ACTIVITIES.map((a) => ({
    id: `go.${a.id}`,
    title: `Go to ${a.label}`,
    kind: "command",
    subtitle: a.label,
    keybind: "",
  }));
  const commands: PaletteItem[] = commandPaletteRows().map((c) => ({
    id: c.id,
    title: c.title,
    kind: "command",
    subtitle: c.category,
    keybind: c.keybind,
  }));
  return [...nav, ...commands];
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
  onRunCommand,
}: CommandPaletteProps): ReactElement | null {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(buildItems, []);
  const ranked = useMemo(() => filterPalette(items, query), [items, query]);
  // APP-100: this aria-modal dialog needs the same focus trap + restore the ide palette has —
  // else Esc drops focus to <body> instead of the opener, and Tab escapes behind the modal.
  useFocusTrap(dialogRef, open, onClose, {
    deferTabToTextFields: true,
    skipInitialFocus: true,
  });

  // focus the input + reset state on open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // keep the active row in range as results change (clamp BOTH ends — never leave -1).
  useEffect(() => {
    setActive((a) => Math.max(0, Math.min(a, ranked.length - 1)));
  }, [ranked.length]);

  if (!open) return null;

  const run = (item: PaletteItem): void => {
    if (item.id.startsWith("go.")) {
      onNavigate(item.id.slice(3) as ActivityId);
    } else {
      onRunCommand(item.id);
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(a + 1, ranked.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = ranked[active]?.item;
      if (item) run(item);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
        background: "rgba(0,0,0,.45)",
        zIndex: Z.modal,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(640px, 92vw)",
          background: "var(--bg-surface-2)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-xl, 14px)",
          boxShadow: "var(--elevation-e2, 0 8px 24px rgba(0,0,0,.35))",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command or jump to a screen…"
          aria-label="Command palette query"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "var(--space-8, 16px)",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--border-subtle)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
            fontSize: "1rem",
            outline: "none",
          }}
        />
        <div
          role="listbox"
          tabIndex={-1}
          aria-label="Palette results"
          style={{
            listStyle: "none",
            margin: 0,
            padding: "var(--space-2, 4px)",
            maxHeight: "min(50vh, 420px)",
            overflow: "auto",
          }}
        >
          {ranked.length === 0 && (
            <div
              style={{
                padding: "var(--space-6, 12px)",
                color: "var(--text-secondary)",
                fontSize: "0.875rem",
              }}
            >
              No matching commands.
            </div>
          )}
          {ranked.map((r, i) => {
            const tier = pinnedTier(r.item.verdict);
            const isActive = i === active;
            return (
              <div key={r.item.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(r.item)}
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    gap: "var(--space-4, 8px)",
                    padding: "8px 10px",
                    background: isActive ? "var(--bg-app)" : "transparent",
                    border: "none",
                    borderRadius: "var(--radius-md, 6px)",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ flex: 1, fontSize: "0.9rem" }}>{r.item.title}</span>
                  {r.item.subtitle && (
                    <span
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--text-secondary)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {r.item.subtitle}
                    </span>
                  )}
                  {r.item.keybind && (
                    <kbd
                      style={{
                        fontSize: "0.72rem",
                        color: "var(--text-secondary)",
                        fontFamily: "var(--font-mono)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius-sm, 4px)",
                        padding: "1px 5px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.item.keybind}
                    </kbd>
                  )}
                  {tier && <VerdictBadge verdict={tier} compact />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
