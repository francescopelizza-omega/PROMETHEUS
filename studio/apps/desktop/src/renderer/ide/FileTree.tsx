/**
 * ide/FileTree.tsx — the file explorer (file 07 §2/§3).
 *
 * A lazily-expanded tree over window.prometheus.ide.fsTree (the MAIN process owns the
 * fs; the renderer never touches node:fs, C5). Each dir loads its children on expand
 * (`fs:tree` is lazy by contract). The flattened visible rows are windowed (only the
 * rows in view are rendered) so a huge tree never blows the DOM — the §11
 * "virtualized lists" budget. Single-click opens a preview tab; double-click pins it
 * (the §3.1 preview-tab rule, enforced by the tabs store).
 *
 * Renderer-SANDBOXED (C5): react + the tabs store + window.prometheus only.
 */

import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Z, clampToViewport, useFocusTrap } from "@prometheus/ui";
import type { IdeTreeNode } from "../../shared/ipc-contract.js";
import { detectLanguage } from "./state/lang-detect.js";
import { useTabsStore } from "./state/stores.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** A loaded tree node + its expand state + children (lazy). */
interface TreeEntry {
  node: IdeTreeNode;
  depth: number;
  expanded: boolean;
  /** children loaded on first expand (undefined = not yet loaded). */
  children?: TreeEntry[];
}

const ROW_HEIGHT = 22;
const OVERSCAN = 8;

/** Drop a `file://` scheme prefix → a bare fs path (module-level = stable identity for hooks). */
const stripScheme = (p: string): string => (p.startsWith("file://") ? p.slice(7) : p);

function toEntry(node: IdeTreeNode, depth: number): TreeEntry {
  return { node, depth, expanded: false };
}

/** Flatten the visible rows (expanded dirs contribute their loaded children). */
function flatten(entries: TreeEntry[], out: TreeEntry[]): TreeEntry[] {
  for (const e of entries) {
    out.push(e);
    if (e.node.kind === "dir" && e.expanded && e.children) flatten(e.children, out);
  }
  return out;
}

export function FileTree({ root }: { root: string }): ReactElement {
  const [roots, setRoots] = useState<TreeEntry[]>([]);
  // a live ref to the current tree so the (async) fs-watch reload can read + preserve
  // the user's expansion state without re-subscribing on every expand.
  const rootsRef = useRef<TreeEntry[]>([]);
  rootsRef.current = roots;
  // toggleDir mutates entries IN PLACE (same `roots` ref) then bumps this tick; the
  // visible memo must depend on the tick or it returns the stale pre-expand flatten
  // (the tree would never expand/collapse).
  const [renderTick, forceRender] = useState(0);
  const open = useTabsStore((s) => s.open);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  // right-click context menu + the name-input popover for CRUD (leap #8). Electron blocks
  // window.prompt, so New/Rename use an inline controlled input; Delete uses window.confirm.
  const [menu, setMenu] = useState<{ x: number; y: number; node: IdeTreeNode } | null>(null);
  const [namePopover, setNamePopover] = useState<{
    mode: "newFile" | "newFolder" | "rename";
    dir: string;
    original?: string;
    value: string;
  } | null>(null);
  const [crudError, setCrudError] = useState<string | null>(null);
  // The context menu and the name popover are real overlays, so they get the house overlay
  // contract (§9.2) rather than a hand-rolled one. What was here before: an `onKeyDown` on a
  // `role="presentation"` backdrop that has no tabIndex and is therefore never focused — so
  // it could never BE the keydown target, and nothing bubbled to it either. Escape was dead
  // on both. useFocusTrap listens on the document in CAPTURE, which no focus accident can
  // defeat, moves focus into the surface, and restores it to the tree row on close.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const namePopoverRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeNamePopover = useCallback(() => setNamePopover(null), []);
  useFocusTrap(menuRef, menu !== null, closeMenu);
  // the name popover autofocuses its own text input, and Tab inside it should reach the
  // Cancel/OK buttons normally — so no initial focus from the trap, no Tab deferral.
  useFocusTrap(namePopoverRef, namePopover !== null, closeNamePopover);

  // load the root listing.
  useEffect(() => {
    let alive = true;
    setLoadState("loading");
    void (async () => {
      try {
        const nodes = (await ide()?.fsTree(root)) ?? [];
        if (alive) {
          setRoots(nodes.map((n) => toEntry(n, 0)));
          setLoadState("ready");
        }
      } catch {
        if (alive) setLoadState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [root]);

  // Live refresh on external/agent file changes (#8): re-fetch the tree while PRESERVING
  // the user's expansion — a collapsed dir drops its (possibly stale) children so a later
  // expand re-fetches; an expanded dir is re-fetched recursively. Total + never throws.
  const reload = useCallback(async (): Promise<void> => {
    const refetch = async (
      dir: string,
      depth: number,
      prev: TreeEntry[] | undefined,
    ): Promise<TreeEntry[]> => {
      let nodes: IdeTreeNode[];
      try {
        nodes = (await ide()?.fsTree(dir)) ?? [];
      } catch {
        return prev ?? [];
      }
      const prevByPath = new Map((prev ?? []).map((e) => [e.node.path, e]));
      const out: TreeEntry[] = [];
      for (const n of nodes) {
        const old = prevByPath.get(n.path);
        if (n.kind === "dir" && old?.expanded) {
          out.push({
            node: n,
            depth,
            expanded: true,
            children: await refetch(n.path, depth + 1, old.children),
          });
        } else {
          out.push({ node: n, depth, expanded: false });
        }
      }
      return out;
    };
    const next = await refetch(root, 0, rootsRef.current);
    setRoots(next);
    forceRender((t) => t + 1);
  }, [root]);

  // subscribe to the MAIN fs-watcher for this root + reload (debounced) on a change.
  useEffect(() => {
    const api = ide();
    if (!api) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void api.fsWatch(root);
    const unsub = api.onEvent((ev) => {
      if (ev.channel === "fs.change" && ev.root === root) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (alive) void reload();
        }, 200);
      }
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unsub();
      void api.fsUnwatch(root);
    };
  }, [root, reload]);

  // Recompute the visible rows every render (cheap): toggleDir mutates entries in
  // place and bumps renderTick to re-render, so a memo keyed on `roots` would return
  // the stale pre-expand flatten. `renderTick` is read here only to tie the recompute
  // to the toggle.
  void renderTick;
  const visible = flatten(roots, []);

  const toggleDir = useCallback(async (entry: TreeEntry): Promise<void> => {
    if (entry.node.kind !== "dir") return;
    if (!entry.expanded && !entry.children) {
      try {
        const children = (await ide()?.fsTree(entry.node.path)) ?? [];
        entry.children = children.map((n) => toEntry(n, entry.depth + 1));
      } catch {
        entry.children = []; // a failed listing → show the dir as empty, never throw
      }
    }
    entry.expanded = !entry.expanded;
    forceRender((n) => n + 1);
  }, []);

  const openFile = useCallback(
    (node: IdeTreeNode, pin: boolean): void => {
      const uri = node.path.startsWith("file://") ? node.path : `file://${node.path}`;
      open(uri, { name: node.name, languageId: detectLanguage(node.path), preview: !pin });
    },
    [open],
  );

  // ── CRUD (leap #8) ──────────────────────────────────────────────────────────
  const dirOf = (p: string): string => p.replace(/[/\\][^/\\]+$/, "") || p;

  // the directory a "new" action targets: the node itself if a dir, else its parent.
  const targetDir = (node: IdeTreeNode): string =>
    node.kind === "dir" ? stripScheme(node.path) : dirOf(stripScheme(node.path));

  const submitName = useCallback(async (): Promise<void> => {
    const np = namePopover;
    if (!np) return;
    const name = np.value.trim();
    if (!name || /[/\\]/.test(name)) {
      setCrudError("name must not be empty or contain a path separator");
      return;
    }
    const api = ide();
    if (!api) return;
    const target = `${np.dir.replace(/[/\\]$/, "")}/${name}`;
    let r: { ok: boolean; error?: string } | undefined;
    if (np.mode === "newFile") r = await api.fsCreateFile(target);
    else if (np.mode === "newFolder") r = await api.fsMkdir(target);
    else if (np.original) r = await api.fsRename(np.original, target);
    if (r && r.ok === false) {
      setCrudError(r.error ?? "operation failed");
      return;
    }
    setNamePopover(null);
    setCrudError(null);
    void reload(); // fs-watch also fires, but reload immediately for snappy feedback
  }, [namePopover, reload]);

  const onDelete = useCallback(
    async (node: IdeTreeNode): Promise<void> => {
      setMenu(null);
      if (!window.confirm(`Delete ${node.name}? This cannot be undone.`)) return;
      const r = await ide()?.fsDelete(stripScheme(node.path));
      if (r && r.ok === false) setCrudError(r.error ?? "delete failed");
      else void reload();
    },
    [reload],
  );

  // windowing math (§11 virtualization).
  const total = visible.length;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const slice = visible.slice(startIdx, endIdx);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewport(el.clientHeight || 600);
  }, []);

  const placeholder =
    loadState === "loading"
      ? "Loading…"
      : loadState === "error"
        ? "Could not read this folder."
        : total === 0
          ? "Empty folder."
          : null;

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      style={{ overflow: "auto", height: "100%", fontSize: "0.8rem" }}
      aria-label="file explorer"
    >
      {placeholder && (
        <div style={{ padding: 8, color: "var(--text-secondary)" }}>{placeholder}</div>
      )}
      <div style={{ height: total * ROW_HEIGHT, position: "relative" }}>
        {slice.map((entry, i) => {
          const idx = startIdx + i;
          const { node, depth } = entry;
          const isDir = node.kind === "dir";
          return (
            <button
              type="button"
              key={node.path}
              aria-expanded={isDir ? entry.expanded : undefined}
              onClick={() => (isDir ? void toggleDir(entry) : openFile(node, false))}
              onDoubleClick={() => (isDir ? undefined : openFile(node, true))}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, node });
              }}
              style={{
                position: "absolute",
                top: idx * ROW_HEIGHT,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                display: "flex",
                alignItems: "center",
                gap: 4,
                paddingLeft: 6 + depth * 12,
                cursor: "pointer",
                color: "var(--text-primary)",
                whiteSpace: "nowrap",
                background: "transparent",
                border: "none",
                font: "inherit",
                textAlign: "left",
              }}
            >
              <span aria-hidden="true" style={{ width: "1em", color: "var(--text-secondary)" }}>
                {isDir ? (entry.expanded ? "▾" : "▸") : "·"}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                {node.name}
              </span>
            </button>
          );
        })}
      </div>

      {menu && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is Escape,
              owned by useFocusTrap on the document in capture. The onKeyDown this rule
              asks for is what USED to be here, on a never-focused presentation div —
              it satisfied the lint and did nothing. */}
          <div
            role="presentation"
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
            // A context menu is dismissed by clicking away — that is the DROPDOWN rung. At
            // Z.modal this click-away backdrop sat above the ⌘K palette and swallowed its clicks.
            style={{ position: "fixed", inset: 0, zIndex: Z.dropdown }}
          />
          <div
            role="menu"
            ref={menuRef}
            style={{
              position: "fixed",
              // Clamp, or a right-click near the bottom/right edge paints the menu — and
              // its destructive `Delete` item — off-window where it cannot be reached.
              // MENU_H over-estimates the four rows on purpose: erring large only pushes
              // the menu further inside the viewport, which is the safe direction.
              ...(({ x, y }) => ({ left: x, top: y }))(clampToViewport(menu.x, menu.y, 170, 128)),
              zIndex: Z.dropdown,
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-md, 6px)",
              boxShadow: "var(--elevation-e2, 0 8px 24px rgba(0,0,0,.35))",
              padding: 4,
              minWidth: 150,
              fontSize: "0.78rem",
            }}
          >
            <MenuItem
              label="New File"
              onClick={() => {
                setNamePopover({ mode: "newFile", dir: targetDir(menu.node), value: "" });
                setMenu(null);
                setCrudError(null);
              }}
            />
            <MenuItem
              label="New Folder"
              onClick={() => {
                setNamePopover({ mode: "newFolder", dir: targetDir(menu.node), value: "" });
                setMenu(null);
                setCrudError(null);
              }}
            />
            <MenuItem
              label="Rename"
              onClick={() => {
                const p = stripScheme(menu.node.path);
                setNamePopover({
                  mode: "rename",
                  dir: dirOf(p),
                  original: p,
                  value: menu.node.name,
                });
                setMenu(null);
                setCrudError(null);
              }}
            />
            <MenuItem label="Delete" danger onClick={() => void onDelete(menu.node)} />
          </div>
        </>
      )}

      {namePopover && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is Escape,
              owned by useFocusTrap on the document in capture. The onKeyDown this rule
              asks for is what USED to be here, on a never-focused presentation div —
              it satisfied the lint and did nothing. */}
          <div
            role="presentation"
            onClick={closeNamePopover}
            style={{ position: "fixed", inset: 0, zIndex: Z.modal, background: "rgba(0,0,0,.3)" }}
          />
          <div
            ref={namePopoverRef}
            role="dialog"
            aria-modal="true"
            aria-label={namePopover.mode === "rename" ? "Rename" : "New name"}
            style={{
              position: "fixed",
              top: "30%",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: Z.modal,
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-md, 6px)",
              padding: 12,
              width: 300,
              fontSize: "0.8rem",
            }}
          >
            <div style={{ marginBottom: 6, color: "var(--text-secondary)" }}>
              {namePopover.mode === "newFile"
                ? "New file name"
                : namePopover.mode === "newFolder"
                  ? "New folder name"
                  : "Rename to"}
            </div>
            <input
              // biome-ignore lint/a11y/noAutofocus: a name prompt should grab focus immediately
              autoFocus
              value={namePopover.value}
              onChange={(e) => setNamePopover((s) => (s ? { ...s, value: e.target.value } : s))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitName();
                else if (e.key === "Escape") setNamePopover(null);
              }}
              aria-label="name"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "5px 7px",
                background: "var(--bg-inset)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                fontFamily: "var(--font-mono, monospace)",
              }}
            />
            {crudError && (
              <div style={{ color: "var(--danger)", marginTop: 6, fontSize: "0.72rem" }}>
                {crudError}
              </div>
            )}
            <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setNamePopover(null)} style={popBtn(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => void submitName()} style={popBtn(true)}>
                OK
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One context-menu row. */
function MenuItem({
  label,
  onClick,
  danger,
}: { label: string; onClick: () => void; danger?: boolean }): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "4px 8px",
        background: "transparent",
        border: "none",
        borderRadius: "var(--radius-sm, 4px)",
        color: danger ? "var(--danger)" : "var(--text-primary)",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      {label}
    </button>
  );
}

function popBtn(primary: boolean): CSSProperties {
  return {
    padding: "3px 10px",
    borderRadius: "var(--radius-md, 6px)",
    border: primary ? "none" : "1px solid var(--border-subtle)",
    background: primary ? "var(--accent)" : "transparent",
    // `--on-accent` is the computed label colour for the `--accent` FILL (tokens/contrast.ts `onFill`).
    // The old `--brand-fg` here was WHITE on the dark scheme over a saturated light fill (~2:1),
    // and a plain `--bg-app` would be near-white over the same fill on the LIGHT scheme.
    color: primary ? "var(--on-accent)" : "var(--text-secondary)",
    cursor: "pointer",
    fontSize: "0.78rem",
  };
}

export default FileTree;
