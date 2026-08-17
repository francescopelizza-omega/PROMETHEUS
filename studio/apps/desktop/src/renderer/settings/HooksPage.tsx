/**
 * HooksPage.tsx — Settings ▸ Lifecycle Hooks.
 *
 * Before this page, the `hooks` key (packages/core/src/agent/hooks.ts — PreToolUse /
 * PostToolUse / SessionStart shell commands) had no `settings:get`/`settings:set` reach from
 * the tree (`findNodeBySchemaKey` didn't know it) and no UI at all: hand-editing
 * `<userData>/settings.json` or `<repo>/.prometheus/settings.json` was the only way in.
 *
 * List + add/edit/remove hooks at BOTH scopes hooks-config.ts actually loads from — Global
 * (`~/.prometheus/config/settings.json`) and Workspace (`<repo>/.prometheus/settings.json`) —
 * each shown separately with its own provenance, because the loader's array-REPLACE rule
 * (§7.1: arrays don't merge across layers) means a workspace that sets `hooks` at all — even to
 * `[]` — silently ignores every Global hook while that workspace is open. Getting that wrong in
 * the UI (e.g. showing one merged list) would misrepresent what actually runs, so the banner
 * and per-scope empty-states say so explicitly.
 *
 * Validation is PROACTIVE (`hooks-panel.ts`): a malformed row is fail-soft DROPPED by the
 * loader, but silently losing what the user just typed is a UI bug, not a feature, so Save is
 * disabled with a named reason instead.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the pure `@prometheus/core/agent-hooks`
 * subpath (via hooks-panel.ts) + window.prometheus.settings only.
 */
import { Panel } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useCallback, useEffect, useState } from "react";

import {
  EMPTY_HOOK_DRAFT,
  HOOK_EVENTS,
  type HookDraft,
  type HookSpec,
  draftToHookSpec,
  hookSpecToDraft,
  matcherLabel,
  removeHook,
  upsertHook,
  validateHookDraft,
} from "./hooks-panel.js";
import { rawAtScope } from "./settings-scope.js";
import { type SettingsNodeView, flattenNodes } from "./settings-view.js";

export interface HooksPageProps {
  /** the active project root, if any — required to read/write the Workspace scope. */
  workspaceRoot?: string;
}

/** Which persisted scope a row lives in (mirrors `SettingsUiScope`, restricted to writable ones). */
type HookScope = "user" | "project";
const SCOPE_LABEL: Record<HookScope, string> = { user: "Global", project: "Workspace" };
const SCOPE_WRITE: Record<HookScope, "global" | "workspace"> = {
  user: "global",
  project: "workspace",
};

function findHooksNode(nodes: readonly SettingsNodeView[]): SettingsNodeView | undefined {
  return flattenNodes(nodes).find((n) => n.schemaKey === "hooks");
}

function rowsAt(node: SettingsNodeView | undefined, scope: HookScope): HookSpec[] {
  const raw = node ? rawAtScope(node, scope) : { set: false, value: undefined };
  return Array.isArray(raw.value) ? (raw.value as HookSpec[]) : [];
}

export function HooksPage({ workspaceRoot }: HooksPageProps): ReactElement {
  const [nodes, setNodes] = useState<SettingsNodeView[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<HookDraft>(EMPTY_HOOK_DRAFT);
  const [editing, setEditing] = useState<{ scope: HookScope; index: number } | null>(null);
  const [newScope, setNewScope] = useState<HookScope>("user");

  const reload = useCallback(async () => {
    const res = await window.prometheus?.settings?.list(workspaceRoot);
    if (!res?.ok) {
      setError(res?.error ?? "settings IPC unavailable");
      return;
    }
    setError(undefined);
    setNodes(res.nodes ?? []);
  }, [workspaceRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const hooksNode = nodes ? findHooksNode(nodes) : undefined;
  const globalRaw = hooksNode ? rawAtScope(hooksNode, "user") : { set: false, value: undefined };
  const workspaceRaw = hooksNode
    ? rawAtScope(hooksNode, "project")
    : { set: false, value: undefined };
  const globalRows = rowsAt(hooksNode, "user");
  const workspaceRows = rowsAt(hooksNode, "project");
  // which scope actually fires right now (§7.1: arrays replace, so it's one or the other).
  const activeScope: HookScope | "none" =
    hooksNode?.layer === "workspace" ? "project" : hooksNode?.layer === "global" ? "user" : "none";

  const resetForm = (): void => {
    setDraft(EMPTY_HOOK_DRAFT);
    setEditing(null);
    setNewScope("user");
  };

  const errors = validateHookDraft(draft);

  const persist = async (scope: HookScope, rows: HookSpec[]): Promise<void> => {
    setPending(true);
    try {
      const res = await window.prometheus?.settings?.set(
        "hooks",
        rows,
        SCOPE_WRITE[scope],
        workspaceRoot,
      );
      if (res && !res.ok) setError(res.error ?? "save failed");
      else {
        setError(undefined);
        await reload();
      }
    } finally {
      setPending(false);
    }
  };

  const save = async (): Promise<void> => {
    if (errors.length > 0) return;
    const spec = draftToHookSpec(draft);
    const scope = editing ? editing.scope : newScope;
    const rows = scope === "user" ? globalRows : workspaceRows;
    const next = upsertHook(
      rows,
      spec,
      editing && editing.scope === scope ? editing.index : undefined,
    );
    await persist(scope, next);
    resetForm();
  };

  const editAt = (scope: HookScope, index: number, spec: HookSpec): void => {
    setDraft(hookSpecToDraft(spec));
    setEditing({ scope, index });
  };

  const removeAt = async (scope: HookScope, index: number): Promise<void> => {
    const rows = scope === "user" ? globalRows : workspaceRows;
    await persist(scope, removeHook(rows, index));
    if (editing?.scope === scope && editing.index === index) resetForm();
  };

  /** Drop the Workspace file's `hooks` override entirely, so Global hooks apply again here. */
  const clearWorkspaceOverride = async (): Promise<void> => {
    if (!workspaceRoot) return;
    setPending(true);
    try {
      const res = await window.prometheus?.settings?.reset("hooks", "workspace", workspaceRoot);
      if (res && !res.ok) setError(res.error ?? "reset failed");
      else {
        setError(undefined);
        await reload();
      }
    } finally {
      setPending(false);
    }
  };

  if (error) {
    return (
      <Panel title="Lifecycle Hooks" elevation="e1">
        <div style={{ color: "var(--danger)", padding: "var(--space-4, 8px)" }}>{error}</div>
      </Panel>
    );
  }
  if (!nodes) {
    return (
      <Panel title="Lifecycle Hooks" elevation="e1">
        <div style={{ color: "var(--text-secondary)", padding: "var(--space-4, 8px)" }}>
          loading…
        </div>
      </Panel>
    );
  }

  return (
    <div style={{ display: "flex", gap: "var(--space-6, 12px)", minHeight: 0 }}>
      {/* -------- left: the two scope lists -------- */}
      <div
        style={{
          width: 380,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4, 8px)",
        }}
      >
        <p style={hintStyle}>
          A hook is a shell command bound to <code>PreToolUse</code>, <code>PostToolUse</code>, or{" "}
          <code>SessionStart</code>. <strong>Arrays replace, they don't merge</strong>: if the
          Workspace file sets <code>hooks</code> at all — even to an empty list — its list runs
          INSTEAD of Global's, not alongside it. Currently active for this workspace:{" "}
          <strong style={{ color: "var(--text-primary)" }}>
            {activeScope === "none" ? "none configured" : SCOPE_LABEL[activeScope]}
          </strong>
          .
        </p>

        <HookScopeList
          scope="user"
          rows={globalRows}
          active={activeScope === "user"}
          editing={editing}
          pending={pending}
          onEdit={(i, s) => editAt("user", i, s)}
          onRemove={(i) => void removeAt("user", i)}
        />

        {workspaceRoot ? (
          <HookScopeList
            scope="project"
            rows={workspaceRows}
            active={activeScope === "project"}
            editing={editing}
            pending={pending}
            onEdit={(i, s) => editAt("project", i, s)}
            onRemove={(i) => void removeAt("project", i)}
            footer={
              workspaceRaw.set ? (
                <button
                  type="button"
                  style={linkBtn}
                  disabled={pending}
                  onClick={() => void clearWorkspaceOverride()}
                >
                  Remove workspace override (fall back to Global)
                </button>
              ) : (
                <span style={mutedNote}>
                  This workspace's settings.json does not set <code>hooks</code> — Global's list
                  applies here.
                </span>
              )
            }
          />
        ) : (
          <Panel title="Workspace" elevation="e1">
            <div style={mutedNote}>Open a project folder to view/edit its workspace hooks.</div>
          </Panel>
        )}
      </div>

      {/* -------- right: the editor form -------- */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Panel
          title={editing ? `Edit hook (${SCOPE_LABEL[editing.scope]})` : "New hook"}
          elevation="e1"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
            <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
              <Field label="Event">
                <select
                  value={draft.event}
                  onChange={(e) => setDraft({ ...draft, event: e.currentTarget.value })}
                  aria-label="event"
                  style={inputStyle}
                >
                  {HOOK_EVENTS.map((ev) => (
                    <option key={ev} value={ev}>
                      {ev}
                    </option>
                  ))}
                </select>
              </Field>
              {!editing && (
                <Field label="Save to">
                  <select
                    value={newScope}
                    onChange={(e) => setNewScope(e.currentTarget.value as HookScope)}
                    aria-label="save to scope"
                    style={inputStyle}
                    disabled={!workspaceRoot}
                  >
                    <option value="user">Global</option>
                    <option value="project" disabled={!workspaceRoot}>
                      Workspace{!workspaceRoot ? " (open a folder)" : ""}
                    </option>
                  </select>
                </Field>
              )}
            </div>
            <Field label="Matcher (glob on the tool name — blank or * matches every tool)">
              <input
                value={draft.matcher}
                onChange={(e) => setDraft({ ...draft, matcher: e.currentTarget.value })}
                aria-label="matcher"
                placeholder="write_file, mcp__*, *"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <Field label="Command">
              <input
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.currentTarget.value })}
                aria-label="command"
                placeholder="./guard.sh"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <p style={hintStyle}>
              stdin carries the event's JSON payload. PreToolUse: a nonzero exit DENIES the call.
              PostToolUse: fire-and-forget, cannot block or fail the turn. SessionStart: stdout is
              folded into the thread as context.
            </p>

            {errors.length > 0 && (
              <ul
                aria-label="validation errors"
                style={{ margin: 0, paddingLeft: "var(--space-5, 10px)", color: "var(--danger)" }}
              >
                {errors.map((e) => (
                  <li key={e} style={{ fontSize: "0.75rem" }}>
                    {e}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ display: "flex", gap: "var(--space-2, 4px)" }}>
              <button
                type="button"
                disabled={errors.length > 0 || pending}
                onClick={() => void save()}
                style={primaryBtn}
              >
                {editing ? "Save changes" : "Add hook"}
              </button>
              <button type="button" onClick={resetForm} style={secondaryBtn} disabled={pending}>
                Clear
              </button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function HookScopeList({
  scope,
  rows,
  active,
  editing,
  pending,
  onEdit,
  onRemove,
  footer,
}: {
  scope: HookScope;
  rows: HookSpec[];
  active: boolean;
  editing: { scope: HookScope; index: number } | null;
  pending: boolean;
  onEdit: (index: number, spec: HookSpec) => void;
  onRemove: (index: number) => void;
  footer?: ReactElement;
}): ReactElement {
  return (
    <Panel title={`${SCOPE_LABEL[scope]}${active ? " · active" : ""}`} elevation="e1">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1, 2px)" }}>
        {rows.length === 0 && <div style={mutedNote}>No hooks configured.</div>}
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((spec, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; index IS the identity used for edit/remove.
              key={`${scope}-${i}`}
              style={rowStyle}
            >
              <span style={eventBadge}>{spec.event}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                  {spec.command}
                </code>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.68rem" }}>
                  matches: {matcherLabel(spec)}
                </div>
              </span>
              <button
                type="button"
                style={linkBtn}
                disabled={pending}
                onClick={() => onEdit(i, spec)}
                aria-label={`edit ${scope} hook ${i}`}
              >
                {editing?.scope === scope && editing.index === i ? "Editing…" : "Edit"}
              </button>
              <button
                type="button"
                style={linkBtn}
                disabled={pending}
                onClick={() => onRemove(i)}
                aria-label={`delete ${scope} hook ${i}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        {footer}
      </div>
    </Panel>
  );
}

function Field({ label: l, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
      <span style={fieldLabelStyle}>{l}</span>
      {children}
    </div>
  );
}

const fieldLabelStyle: CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-ui)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg-inset)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px)",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2, 4px)",
  padding: "var(--space-2, 4px)",
  fontSize: "var(--text-small-size, 0.8125rem)",
  borderBottom: "1px solid var(--border-subtle, var(--border-strong))",
};

const eventBadge: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.62rem",
  textTransform: "uppercase",
  padding: "0 var(--space-1, 2px)",
  borderRadius: "var(--radius-sm, 4px)",
  border: "1px solid var(--border-strong)",
  color: "var(--accent)",
  flexShrink: 0,
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.72rem",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const mutedNote: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-secondary)",
  padding: "var(--space-1, 2px) 0",
};

const linkBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--accent)",
  cursor: "pointer",
  fontSize: "0.72rem",
  fontFamily: "var(--font-ui)",
  padding: "0 var(--space-1, 2px)",
  flexShrink: 0,
};

const primaryBtn: CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-fg, var(--bg-base))",
  border: "none",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const secondaryBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

export default HooksPage;
