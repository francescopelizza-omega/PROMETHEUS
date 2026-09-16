/**
 * TemplatesPage.tsx — Settings ▸ Live Templates (APP-020).
 *
 * The live/postfix/surround template editor: a list of every template (seed vs user badge),
 * an editor form (abbrev · description · kind · languages · body) with a live macro-expansion
 * PREVIEW, and create/edit/delete for user templates. Seeds are READ-ONLY but OVERRIDABLE —
 * "Override" seeds the form with the built-in so the saved user template shadows it on
 * (abbrev, language). Every change WRITES THROUGH the template-store to the APP-017 keyed
 * settings IPC (global layer), so it persists across restart; the editor's completion +
 * surround providers read the same store. No raw hex — design tokens only.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + @prometheus/core/templates (pure) +
 * the template-store only.
 */
import {
  type LiveTemplateDef,
  type LiveTemplateKind,
  previewExpand,
  validateLiveTemplate,
} from "@prometheus/core/templates";
import { Panel } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useEffect, useMemo, useState } from "react";

import { useTabsStore } from "../ide/state/stores.js";
import { templateKey, useTemplateStore } from "../ide/state/template-store.js";
import {
  POSTFIX_TEMPLATES,
  SURROUND_TEMPLATES,
  seedTemplatesForKind,
} from "../ide/state/templates.js";

const KINDS: readonly LiveTemplateKind[] = ["live", "postfix", "surround"];
const KIND_LABEL: Record<LiveTemplateKind, string> = {
  live: "Live",
  postfix: "Postfix",
  surround: "Surround",
};

/** The languages a template can target (mirrors the editor's LSP-tracked set). */
const TEMPLATE_LANGS: readonly { id: string; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "javascriptreact", label: "JSX" },
  { id: "typescriptreact", label: "TSX" },
  { id: "json", label: "JSON" },
  { id: "rust", label: "Rust" },
  { id: "go", label: "Go" },
  { id: "cpp", label: "C++" },
  { id: "c", label: "C" },
];

/** Every seed template (all three kinds) as a flat LiveTemplateDef[] for the list. */
const SEED_TEMPLATES: readonly LiveTemplateDef[] = [
  ...seedTemplatesForKind("live"),
  ...POSTFIX_TEMPLATES,
  ...SURROUND_TEMPLATES,
];

interface Draft {
  abbrev: string;
  description: string;
  kind: LiveTemplateKind;
  languages: string[];
  body: string;
}

const EMPTY_DRAFT: Draft = {
  abbrev: "",
  description: "",
  kind: "live",
  languages: ["typescript"],
  body: "$END$",
};

const label = (langs: string[]): string =>
  langs.map((l) => TEMPLATE_LANGS.find((t) => t.id === l)?.label ?? l).join(", ");

export function TemplatesPage(): ReactElement {
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot) ?? undefined;
  const user = useTemplateStore((s) => s.user);
  const upsert = useTemplateStore((s) => s.upsert);
  const remove = useTemplateStore((s) => s.remove);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /** the user template currently being edited (so a key-changing edit replaces, not clones). */
  const [editingOriginal, setEditingOriginal] = useState<LiveTemplateDef | null>(null);
  const [filterKind, setFilterKind] = useState<LiveTemplateKind | "all">("all");

  // hydrate from settings on mount (idempotent) so the list reflects persisted templates.
  useEffect(() => {
    void useTemplateStore.getState().hydrate(workspaceRoot);
  }, [workspaceRoot]);

  const errors = useMemo(
    () => validateLiveTemplate({ ...draft, abbrev: draft.abbrev.trim() }),
    [draft],
  );
  const preview = useMemo(
    () => previewExpand(draft.body, { selection: "selection", receiver: "expr", now: new Date() }),
    [draft.body],
  );

  /** the set of (kind, language, abbrev) a user template overrides — for the seed badge. */
  const overridden = useMemo(() => new Set(user.map(templateKey)), [user]);

  const resetForm = (): void => {
    setDraft(EMPTY_DRAFT);
    setEditingOriginal(null);
  };

  const save = async (): Promise<void> => {
    const def: LiveTemplateDef = {
      abbrev: draft.abbrev.trim(),
      description: draft.description.trim(),
      body: draft.body,
      languages: draft.languages,
      kind: draft.kind,
    };
    if (validateLiveTemplate(def).length > 0) return;
    // an edit that changed identity (abbrev/lang/kind) removes the original first.
    if (editingOriginal && templateKey(editingOriginal) !== templateKey(def)) {
      await remove(editingOriginal, workspaceRoot);
    }
    await upsert(def, workspaceRoot);
    resetForm();
  };

  const editUser = (t: LiveTemplateDef): void => {
    setDraft({
      abbrev: t.abbrev,
      description: t.description,
      kind: t.kind,
      languages: [...t.languages],
      body: t.body,
    });
    setEditingOriginal(t);
  };

  /** Seed override: load the seed into the form as a NEW user template (no original to
   *  replace) so saving shadows the built-in on (abbrev, language). */
  const overrideSeed = (t: LiveTemplateDef): void => {
    setDraft({
      abbrev: t.abbrev,
      description: t.description,
      kind: t.kind,
      languages: [...t.languages],
      body: t.body,
    });
    setEditingOriginal(null);
  };

  const toggleLang = (id: string): void => {
    setDraft((d) => ({
      ...d,
      languages: d.languages.includes(id)
        ? d.languages.filter((l) => l !== id)
        : [...d.languages, id],
    }));
  };

  const shown = (t: LiveTemplateDef): boolean => filterKind === "all" || t.kind === filterKind;

  return (
    <div style={{ display: "flex", gap: "var(--space-6, 12px)", minHeight: 0 }}>
      {/* -------- left: the template list -------- */}
      <div style={{ width: 300, flexShrink: 0 }}>
        <Panel title="Templates" elevation="e1">
          <div
            style={{
              display: "flex",
              gap: "var(--space-1, 2px)",
              marginBottom: "var(--space-3, 6px)",
            }}
          >
            {(["all", ...KINDS] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={filterKind === k}
                onClick={() => setFilterKind(k)}
                style={chip(filterKind === k)}
              >
                {k === "all" ? "All" : KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <ul
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 1,
              listStyle: "none",
              margin: 0,
              padding: 0,
            }}
          >
            {user.filter(shown).map((t) => (
              <li key={`u-${templateKey(t)}`} style={rowStyle}>
                <Badge kind="user" />
                <TemplateLabel t={t} />
                <button
                  type="button"
                  style={linkBtn}
                  onClick={() => editUser(t)}
                  aria-label={`edit ${t.abbrev}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  style={linkBtn}
                  onClick={() => void remove(t, workspaceRoot)}
                  aria-label={`delete ${t.abbrev}`}
                >
                  Delete
                </button>
              </li>
            ))}
            {SEED_TEMPLATES.filter(shown).map((t, i) => {
              const isOverridden = overridden.has(templateKey(t));
              return (
                <li key={`s-${templateKey(t)}-${i}`} style={rowStyle}>
                  <Badge kind="seed" />
                  <TemplateLabel t={t} dim={isOverridden} />
                  {isOverridden && <span style={overrideNote}>overridden</span>}
                  <button
                    type="button"
                    style={linkBtn}
                    onClick={() => overrideSeed(t)}
                    aria-label={`override ${t.abbrev}`}
                  >
                    Override
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      {/* -------- right: the editor form + preview -------- */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Panel title={editingOriginal ? "Edit template" : "New template"} elevation="e1">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
            <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
              <Field label="Abbreviation">
                <input
                  value={draft.abbrev}
                  onChange={(e) => setDraft({ ...draft, abbrev: e.currentTarget.value })}
                  aria-label="abbreviation"
                  placeholder="log"
                  style={inputStyle}
                />
              </Field>
              <Field label="Kind">
                <select
                  value={draft.kind}
                  onChange={(e) =>
                    setDraft({ ...draft, kind: e.currentTarget.value as LiveTemplateKind })
                  }
                  aria-label="kind"
                  style={inputStyle}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Description">
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })}
                aria-label="description"
                placeholder="console.log()"
                style={inputStyle}
              />
            </Field>
            <Field label="Languages">
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2, 4px)" }}>
                {TEMPLATE_LANGS.map((l) => (
                  <label key={l.id} style={langChip(draft.languages.includes(l.id))}>
                    <input
                      type="checkbox"
                      checked={draft.languages.includes(l.id)}
                      onChange={() => toggleLang(l.id)}
                      aria-label={`language ${l.id}`}
                      style={{ marginRight: 4 }}
                    />
                    {l.label}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Body">
              <textarea
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.currentTarget.value })}
                aria-label="body"
                rows={6}
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
              />
            </Field>
            <p style={hintStyle}>
              Monaco tabstops <code>$1</code> <code>{"${2:default}"}</code> <code>$0</code> + macros{" "}
              <code>$SELECTION$</code> <code>$END$</code> <code>$EXPR$</code>{" "}
              <code>$FILE_NAME$</code> <code>$DATE$</code> <code>$CLIPBOARD$</code>. Postfix uses{" "}
              <code>$EXPR$</code> for the receiver; surround uses <code>$SELECTION$</code>.
            </p>

            <div>
              <div style={fieldLabelStyle}>Preview</div>
              <pre aria-label="preview" style={previewStyle}>
                {preview || " "}
              </pre>
            </div>

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
                disabled={errors.length > 0}
                onClick={() => void save()}
                style={primaryBtn}
              >
                {editingOriginal ? "Save changes" : "Create template"}
              </button>
              <button type="button" onClick={resetForm} style={secondaryBtn}>
                Clear
              </button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function TemplateLabel({ t, dim }: { t: LiveTemplateDef; dim?: boolean }): ReactElement {
  return (
    <span
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: dim ? "var(--text-secondary)" : "var(--text-primary)",
        textDecoration: dim ? "line-through" : "none",
      }}
      title={`${t.abbrev} · ${KIND_LABEL[t.kind]} · ${label(t.languages)}`}
    >
      <code style={{ fontFamily: "var(--font-mono)" }}>
        {t.kind === "postfix" ? `.${t.abbrev}` : t.abbrev}
      </code>{" "}
      <span style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
        {label(t.languages)}
      </span>
    </span>
  );
}

function Badge({ kind }: { kind: "seed" | "user" }): ReactElement {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.62rem",
        textTransform: "uppercase",
        padding: "0 var(--space-1, 2px)",
        borderRadius: "var(--radius-sm, 4px)",
        border: "1px solid var(--border-strong)",
        color: kind === "user" ? "var(--accent)" : "var(--text-secondary)",
        flexShrink: 0,
      }}
    >
      {kind}
    </span>
  );
}

// A labelled field wrapper. A plain <div> (not <label>): each control carries its own
// `aria-label`, so a wrapping <label> would trip biome's noLabelWithoutControl (children
// are opaque here) without adding a11y value.
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
  padding: "var(--space-1, 2px) var(--space-2, 4px)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const previewStyle: CSSProperties = {
  margin: 0,
  background: "var(--bg-inset)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
  color: "var(--text-primary)",
  whiteSpace: "pre-wrap",
  minHeight: "1.5rem",
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.7rem",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
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

const overrideNote: CSSProperties = {
  fontSize: "0.62rem",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)",
  flexShrink: 0,
};

function chip(active: boolean): CSSProperties {
  return {
    padding: "var(--space-1, 2px) var(--space-2, 4px)",
    background: active ? "var(--bg-inset)" : "transparent",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-sm, 4px)",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    cursor: "pointer",
    fontSize: "0.72rem",
    fontFamily: "var(--font-ui)",
  };
}

function langChip(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "0 var(--space-2, 4px)",
    background: active ? "var(--bg-inset)" : "transparent",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-sm, 4px)",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    cursor: "pointer",
    fontSize: "0.72rem",
    fontFamily: "var(--font-ui)",
  };
}

const primaryBtn: CSSProperties = {
  background: "var(--accent)",
  color: "var(--bg-app)",
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

export default TemplatesPage;
