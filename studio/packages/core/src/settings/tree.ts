/**
 * settings/tree.ts — the PyCharm-parity Settings tree (file 13 §2.1/§2.7).
 *
 * The §2.1 tree shape as DATA, generated over 09's settings schema. Each `SettingsNode`
 * carries `ownerFile` provenance (which design doc owns the behavior — traceability) and
 * a `control` kind the generated UI renders. Search filters the tree (JetBrains-style).
 * The Settings UI is a tree of these nodes; the value persists at `schemaKey` through
 * 09's layering (defaults ◀ global ◀ profile ◀ workspace). Pure data + pure helpers.
 */

/** The control a settings node renders as (§2.7). */
export type SettingsControl =
  | "page"
  | "toggle"
  | "select"
  | "number"
  | "text"
  | "color"
  | "keymap"
  | "custom";

/** Layering scope where a value is stored (09 §7.1). */
export type SettingsScope = "global" | "profile" | "workspace";

/** One row in the §2.1 tree (UI generation, §2.7). */
export interface SettingsNode {
  id: string; // 'keymap' | 'editor.font' | 'tools.terminal' | 'appearance'
  title: string;
  category: string; // top-level group ('Editor', 'Tools', …)
  ownerFile: string; // provenance — the doc that owns the behavior ('07'|'08'|'13'|…)
  control: SettingsControl;
  schemaKey?: string; // path into 09's settings schema (where the value persists)
  scope: SettingsScope;
  children?: SettingsNode[];
  searchTerms?: string[]; // power the Settings search box
}

function node(
  id: string,
  title: string,
  category: string,
  ownerFile: string,
  control: SettingsControl,
  over: Partial<SettingsNode> = {},
): SettingsNode {
  return { id, title, category, ownerFile, control, scope: "global", ...over };
}

/** The languages that get a per-language format-on-save flag (APP-019). Mirrors the
 *  LSP-tracked set the editor formats through; each is a `format.lang.<id>` toggle. */
export const FORMAT_LANGS: readonly { id: string; label: string }[] = Object.freeze([
  { id: "python", label: "Python" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
]);

/** The per-language format-on-save toggle nodes, built OUTSIDE the frozen SETTINGS_TREE
 *  literal (an inline `.map()` spread with template-literal args inside the big frozen
 *  literal tripped the electron-vite main-chunk transpiler). */
const FORMAT_LANG_NODES: SettingsNode[] = FORMAT_LANGS.map((l) =>
  node(`format.lang.${l.id}`, `Format on Save: ${l.label}`, "Editor", "29", "toggle", {
    schemaKey: `format.lang.${l.id}`,
    searchTerms: ["format on save", l.label.toLowerCase(), l.id],
  }),
);

/** The §2.1 Settings tree (mirrors JetBrains, mapped to Studio + owner provenance). */
export const SETTINGS_TREE: readonly SettingsNode[] = Object.freeze([
  node("appearance-behavior", "Appearance & Behavior", "root", "13", "page", {
    children: [
      node("appearance", "Appearance", "Appearance & Behavior", "13", "page", {
        schemaKey: "theme",
        searchTerms: ["theme", "scheme", "color", "dark", "light", "density"],
      }),
      node("menus-toolbars", "Menus & Toolbars", "Appearance & Behavior", "08", "custom", {
        searchTerms: ["activity bar", "panel tabs", "status bar"],
      }),
      node("system-settings", "System Settings", "Appearance & Behavior", "09", "page", {
        searchTerms: ["startup", "reopen", "safe-write", "updates"],
      }),
      node("notifications", "Notifications", "Appearance & Behavior", "08", "toggle", {
        searchTerms: ["toast", "do not disturb", "mute"],
      }),
      node("settings-sync", "Settings Sync", "Appearance & Behavior", "09", "page", {
        schemaKey: "profileId",
        searchTerms: ["profile", "sync", "export", "import"],
      }),
    ],
  }),
  node("keymap", "Keymap", "root", "13", "keymap", {
    schemaKey: "keymap",
    searchTerms: ["shortcut", "keybinding", "pycharm", "vscode", "vim", "conflict"],
  }),
  node("editor", "Editor", "root", "07", "page", {
    children: [
      node("editor.general", "General", "Editor", "07", "page", {
        searchTerms: ["caret", "scroll", "soft-wrap", "minimap"],
      }),
      node("editor.font", "Font", "Editor", "08", "page", {
        schemaKey: "editor.font",
        searchTerms: ["family", "size", "ligatures", "JetBrains Mono"],
      }),
      node("editor.colorScheme", "Color Scheme", "Editor", "13", "color", {
        searchTerms: ["syntax", "textmate", "tokens"],
      }),
      node("editor.codeStyle", "Code Style", "Editor", "07", "page", {
        searchTerms: ["formatter", "black", "ruff", "prettier", "format on save", "editorconfig"],
        children: [
          node("format.onSave", "Format on Save", "Editor", "29", "toggle", {
            schemaKey: "format.onSave",
            searchTerms: ["format on save", "prettier", "ruff", "reformat"],
          }),
          node(
            "format.optimizeImportsOnSave",
            "Optimize Imports on Save",
            "Editor",
            "29",
            "toggle",
            {
              schemaKey: "format.optimizeImportsOnSave",
              // NB: keep every term PLURAL ("imports") — a singular "import" preceded by a space
              // is a false-positive for electron-vite's esm-shim import regex, which then
              // splices the CJS shim into this string and breaks the main build.
              searchTerms: ["organize imports", "optimize imports", "unused imports"],
            },
          ),
          ...FORMAT_LANG_NODES,
        ],
      }),
      node("editor.inspections", "Inspections", "Editor", "07", "page", {
        searchTerms: ["lint", "diagnostic", "severity", "nemesis"],
      }),
      node("editor.fileTypes", "File Types & Associations", "Editor", "07", "page", {
        searchTerms: ["glob", "language", "large file"],
      }),
      node("editor.fileWatchers", "File Watchers", "Editor", "13", "page", {
        searchTerms: ["watch", "on save", "transpile", "codegen"],
      }),
      node("editor.snippets", "Live Templates / Snippets", "Editor", "07", "page", {
        // APP-020: the persisted user templates array. `schemaKey` makes the settings IPC
        // accept get/set/reset for this key (findNodeBySchemaKey gate); the structured
        // array is edited on the dedicated Settings ▸ Live Templates page, not inline —
        // the "All Settings" tree renders it read-only (non-editable control + JSON view).
        schemaKey: "templates.user",
        searchTerms: ["snippet", "abbreviation", "live template", "postfix", "surround"],
      }),
      node("editor.todo", "TODO", "Editor", "13", "page", {
        // APP-096: the configurable marker patterns array. `schemaKey` makes the settings IPC
        // accept get/set/reset for this key (findNodeBySchemaKey gate); the patterns are edited
        // inline in the TODO tool window, so the tree renders this read-only (JSON view).
        schemaKey: "todoPatterns",
        searchTerms: ["todo", "fixme", "xxx", "hack", "ripgrep", "marker", "nocommit"],
      }),
    ],
  }),
  node("build-exec-deploy", "Build, Execution, Deployment", "root", "07", "page", {
    children: [
      node(
        "run.configurations",
        "Run/Debug Configurations",
        "Build, Execution, Deployment",
        "07",
        "page",
        { searchTerms: ["dap", "launch", "pytest", "run-gate"] },
      ),
      node(
        "python.interpreter",
        "Python Interpreter / Environments",
        "Build, Execution, Deployment",
        "04",
        "page",
        { searchTerms: ["venv", "conda", "interpreter"] },
      ),
      node("console", "Console", "Build, Execution, Deployment", "13", "page", {
        searchTerms: ["terminal", "ai preset", "prometheus chat"],
      }),
      node("services", "Docker / Services", "Build, Execution, Deployment", "05", "page", {
        searchTerms: ["model server", "worldsim", "services"],
      }),
    ],
  }),
  node("languages-frameworks", "Languages & Frameworks", "root", "07", "page", {
    searchTerms: ["lsp", "pyright", "strict"],
  }),
  node("tools", "Tools", "root", "13", "page", {
    children: [
      node("tools.terminal", "Terminal", "Tools", "13", "page", {
        schemaKey: "terminal",
        searchTerms: ["profile", "ai preset", "shell", "venv"],
      }),
      node("tools.httpClient", "HTTP Client", "Tools", "13", "page", {
        searchTerms: [".http", "request", "response"],
      }),
      node("tools.externalTools", "External Tools", "Tools", "13", "page", {
        searchTerms: ["command", "menu"],
      }),
      node("tools.diffMerge", "Diff & Merge", "Tools", "07", "page", {
        searchTerms: ["diff", "3-way", "merge"],
      }),
      node("tools.network", "Server Certificates / Proxy", "Tools", "09", "page", {
        searchTerms: ["proxy", "certificate", "downloads"],
      }),
    ],
  }),
  node("version-control", "Version Control", "root", "07", "page", {
    searchTerms: ["git", "commit", "ai message", "ignore"],
  }),
  node("ai-agents", "AI & Agents", "root", "11", "page", {
    searchTerms: ["model routing", "agent tuning", "gate mode", "privacy", "providers"],
  }),
  node("security", "Security (nemesis)", "root", "03", "select", {
    schemaKey: "gateStrict",
    searchTerms: ["gate", "enforce", "warn", "force", "db refresh", "nemesis"],
  }),
  node("plugins", "Plugins", "root", "09", "page", {
    searchTerms: ["marketplace", "extension", "promext"],
  }),
  node("advanced", "Advanced", "root", "09", "custom", {
    searchTerms: ["settings.json", "registry", "flags", "raw"],
  }),
]);

/** Walk the tree depth-first (parents before children). */
export function flattenTree(nodes: readonly SettingsNode[] = SETTINGS_TREE): SettingsNode[] {
  const out: SettingsNode[] = [];
  const visit = (n: SettingsNode) => {
    out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** Find a node by id anywhere in the tree. */
export function findNode(
  id: string,
  nodes: readonly SettingsNode[] = SETTINGS_TREE,
): SettingsNode | undefined {
  return flattenTree(nodes).find((n) => n.id === id);
}

/** Find the node whose `schemaKey` matches (a node's persisted-value identity, distinct
 *  from its tree `id`) — the settings IPC keys get/set/reset by schemaKey, not id. */
export function findNodeBySchemaKey(
  schemaKey: string,
  nodes: readonly SettingsNode[] = SETTINGS_TREE,
): SettingsNode | undefined {
  return flattenTree(nodes).find((n) => n.schemaKey === schemaKey);
}

/** Which raw layer (if any) last set a key — the provenance badge the Settings UI shows
 *  beside each leaf's effective value (§2.1: "layer badge + ownerFile shown"). */
export type SettingsLayerName = "default" | "global" | "profile" | "workspace" | "unset";

/** One resolved (value, provenance) row for a schemaKey-bearing node. */
export interface SettingsValueRow {
  schemaKey: string;
  value: unknown;
  layer: SettingsLayerName;
}

/**
 * Resolve a schemaKey's effective value + which layer produced it, given the already
 * layerSettings()-merged `effective` object and the RAW (unmerged) global/profile/
 * workspace layers (provenance needs to see each layer individually — the merged
 * object alone can't tell you which layer a value came from).
 */
export function resolveProvenance(
  schemaKey: string,
  effective: Record<string, unknown>,
  raw: {
    global?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    workspace?: Record<string, unknown>;
  } = {},
): SettingsValueRow {
  const layer: SettingsLayerName =
    raw.workspace && schemaKey in raw.workspace
      ? "workspace"
      : raw.profile && schemaKey in raw.profile
        ? "profile"
        : raw.global && schemaKey in raw.global
          ? "global"
          : schemaKey in effective
            ? "default"
            : "unset";
  return { schemaKey, value: effective[schemaKey], layer };
}

/** Enumerate every schemaKey-bearing node in the tree as a resolved provenance row
 *  (the `settings:list` IPC handler's core: one call gets every leaf's effective
 *  value + layer badge in tree order). */
export function resolveRows(
  effective: Record<string, unknown>,
  raw: {
    global?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    workspace?: Record<string, unknown>;
  } = {},
  nodes: readonly SettingsNode[] = SETTINGS_TREE,
): SettingsValueRow[] {
  return flattenTree(nodes)
    .filter((n): n is SettingsNode & { schemaKey: string } => n.schemaKey !== undefined)
    .map((n) => resolveProvenance(n.schemaKey, effective, raw));
}

/** Pure `set`: produce the NEXT layer object with `key` overridden to `value` (immutable —
 *  the caller persists the result; this never touches disk). */
export function setInLayer(
  layer: Record<string, unknown> | undefined,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return { ...(layer ?? {}), [key]: value };
}

/** Pure `reset`: produce the NEXT layer object with `key`'s override removed, so the
 *  effective value falls back down the layer chain (immutable, no disk access). */
export function resetInLayer(
  layer: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  if (!layer) return {};
  const next = { ...layer };
  delete next[key];
  return next;
}

/** The breadcrumb path (root → … → node) for a node id. */
export function nodePath(
  id: string,
  nodes: readonly SettingsNode[] = SETTINGS_TREE,
): SettingsNode[] {
  const path: SettingsNode[] = [];
  const visit = (n: SettingsNode, trail: SettingsNode[]): boolean => {
    const next = [...trail, n];
    if (n.id === id) {
      path.push(...next);
      return true;
    }
    return (n.children ?? []).some((c) => visit(c, next));
  };
  for (const n of nodes) if (visit(n, [])) break;
  return path;
}

/**
 * Filter the tree to nodes matching `query` (JetBrains-style search). A node matches on
 * its title, category, id, or searchTerms (case-insensitive substring). Returns the flat
 * list of matching leaf-or-branch nodes, ranked title-match first.
 */
export function searchSettings(
  query: string,
  nodes: readonly SettingsNode[] = SETTINGS_TREE,
): SettingsNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hay = (n: SettingsNode) =>
    [n.title, n.category, n.id, ...(n.searchTerms ?? [])].join(" ").toLowerCase();
  const matches = flattenTree(nodes).filter((n) => hay(n).includes(q));
  return matches.sort((a, b) => {
    const at = a.title.toLowerCase().includes(q) ? 0 : 1;
    const bt = b.title.toLowerCase().includes(q) ? 0 : 1;
    return at - bt || a.title.localeCompare(b.title);
  });
}

/**
 * The file-13 contributions to a 09 Profile sync bundle (§2.7): the active keymap, the
 * terminal profiles/AI presets, the active color scheme + referenced customs, and the
 * tool-window layout. Provenance for the Settings Sync UI; the Profile type is 09's.
 */
export const PROFILE_CONTRIBUTIONS: readonly string[] = Object.freeze([
  "keymap",
  "terminal",
  "theme",
  "toolWindowLayout",
]);
