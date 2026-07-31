/**
 * ide/RecentLocations.tsx — the Recent Locations popup (JetBrains "Recent Locations"
 * ⌘⇧E · VS Code "Go Back in Editor Locations" list; plan file 05).
 *
 * A modal list of the navigation stack (useNavStore.entries), most-recent-first. Type to
 * filter by path, ↑/↓ to move, Enter to jump — opens the file (tabs store) + reveals the
 * line. Reuses the same stack that powers Back/Forward (nav-history.ts) — no new state.
 *
 * Renderer-SANDBOXED (C5): react + the pure stores + window.prometheus (via tabs open).
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import { detectLanguage } from "./state/lang-detect.js";
import { type NavLoc, useNavStore } from "./state/nav-history.js";
import { useTabsStore } from "./state/stores.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Lines of context each side of the entry's line in the preview excerpt. */
const PREVIEW_CONTEXT = 5;

function basename(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

/** A path relative to the workspace root, scheme-stripped, for the row subtitle. */
function relPath(uri: string, root: string): string {
  return uri.replace(/^file:\/\//, "").replace(`${root}/`, "");
}

/** Open the file (preview tab) then reveal the 1-based line — same as the symbol jumps. */
function jump(loc: NavLoc): void {
  useTabsStore
    .getState()
    .open(loc.uri, { name: basename(loc.uri), languageId: detectLanguage(loc.uri), preview: true });
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("ide:reveal-position", { detail: { line: loc.line, column: loc.column } }),
    );
  }, 160);
}

export function RecentLocations({
  root,
  onClose,
}: {
  root: string;
  onClose: () => void;
}): ReactElement {
  const entries = useNavStore((s) => s.entries);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // most-recent-first; filter by path substring.
  const rows = useMemo(() => {
    const recent = [...entries].reverse();
    const q = query.trim().toLowerCase();
    return q ? recent.filter((e) => e.uri.toLowerCase().includes(q)) : recent;
  }, [entries, query]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const choose = (loc: NavLoc | undefined): void => {
    if (loc) jump(loc);
    onClose();
  };

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 1100,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: 60,
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: role=dialog on a div matches the CommandPalette modal; focus/escape managed here rather than via <dialog> */}
      <div
        role="dialog"
        aria-label="recent locations"
        style={{
          width: "min(820px, 94vw)",
          background: "var(--bg-surface-2, #16161b)",
          border: "1px solid var(--border-subtle, #232329)",
          borderRadius: "var(--radius-md, 8px)",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(rows[active]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="Recent locations — filter by path…"
          aria-label="recent locations query"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--border-subtle, #232329)",
            color: "var(--text-primary, #e7e7ea)",
            fontSize: "0.9rem",
            outline: "none",
          }}
        />
        <div style={{ display: "flex", minHeight: 0 }}>
          <div
            style={{
              width: "46%",
              minWidth: 240,
              maxHeight: 360,
              overflow: "auto",
              borderRight: "1px solid var(--border-subtle, #232329)",
            }}
          >
            {rows.length === 0 && (
              <p
                style={{
                  padding: 12,
                  color: "var(--text-secondary, #9a9aa3)",
                  fontSize: "0.82rem",
                }}
              >
                {entries.length === 0 ? "No recent locations yet." : "No matches."}
              </p>
            )}
            {rows.map((loc, i) => (
              <button
                key={`${loc.uri}:${loc.line}:${i}`}
                type="button"
                aria-current={i === active ? "true" : undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(loc)}
                title={`${relPath(loc.uri, root)}:${loc.line}`}
                style={{
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  padding: "6px 12px",
                  cursor: "pointer",
                  background: i === active ? "var(--bg-surface-2, #1d1d24)" : "transparent",
                  display: "flex",
                  flexDirection: "column",
                  font: "inherit",
                }}
              >
                <span style={{ fontSize: "0.85rem", color: "var(--text-primary, #e7e7ea)" }}>
                  {basename(loc.uri)}
                  <span style={{ color: "var(--text-secondary, #9a9aa3)" }}> :{loc.line}</span>
                </span>
                <span
                  style={{
                    fontSize: "0.72rem",
                    color: "var(--text-secondary, #9a9aa3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {relPath(loc.uri, root)}
                </span>
              </button>
            ))}
          </div>
          <RecentPreview loc={rows[active]} root={root} />
        </div>
      </div>
    </div>
  );
}

/** The right-pane preview of the active entry: a few lines of the file around the recorded
 *  line, target line highlighted. Reads via the path-guarded fs seam (one file per selection
 *  change — never a Monaco instance per row; the stack can hold NAV_CAP entries). */
function RecentPreview({ loc, root }: { loc: NavLoc | undefined; root: string }): ReactElement {
  const [text, setText] = useState<string | null>(null);
  const uri = loc?.uri;

  useEffect(() => {
    if (!uri) {
      setText(null);
      return;
    }
    let alive = true;
    void (async () => {
      const r = await ide()
        ?.fsRead(uri)
        .catch(() => undefined);
      if (alive) setText(r?.ok && typeof r.text === "string" ? r.text : null);
    })();
    return () => {
      alive = false;
    };
  }, [uri]);

  const excerpt = useMemo(() => {
    if (text === null || !loc) return null;
    const lines = text.split("\n");
    const target = Math.max(0, Math.min(loc.line - 1, lines.length - 1)); // loc.line is 1-based
    const from = Math.max(0, target - PREVIEW_CONTEXT);
    const to = Math.min(lines.length, target + PREVIEW_CONTEXT + 1);
    return { lines: lines.slice(from, to), from, target };
  }, [text, loc]);

  const shell = (children: ReactElement | string): ReactElement => (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        maxHeight: 360,
        overflow: "auto",
        padding: "8px 4px",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "0.75rem",
        lineHeight: 1.5,
        color: "var(--text-primary, #e7e7ea)",
        background: "var(--bg-surface-1, #101014)",
      }}
    >
      {children}
    </div>
  );

  if (!loc) return shell("No selection.");
  if (text === null) return shell("Loading…");
  if (!excerpt) return shell(relPath(uri ?? "", root));

  return shell(
    <>
      <div
        style={{
          color: "var(--text-secondary, #9a9aa3)",
          padding: "0 8px 6px",
          borderBottom: "1px solid var(--border-subtle, #232329)",
          marginBottom: 4,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {relPath(uri ?? "", root)}:{loc.line}
      </div>
      {excerpt.lines.map((lineText, i) => {
        const lineNo = excerpt.from + i;
        const isTarget = lineNo === excerpt.target;
        return (
          <div
            key={lineNo}
            style={{
              display: "flex",
              gap: 8,
              padding: "0 8px",
              background: isTarget ? "var(--bg-inset, #0c0c10)" : "transparent",
              borderLeft: isTarget ? "2px solid var(--accent, #6d5ef0)" : "2px solid transparent",
            }}
          >
            <span
              style={{
                color: "var(--text-tertiary, #6a6a73)",
                width: 34,
                textAlign: "right",
                flexShrink: 0,
                userSelect: "none",
              }}
            >
              {lineNo + 1}
            </span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre", overflow: "hidden" }}>
              {lineText}
            </span>
          </div>
        );
      })}
    </>,
  );
}

export default RecentLocations;
