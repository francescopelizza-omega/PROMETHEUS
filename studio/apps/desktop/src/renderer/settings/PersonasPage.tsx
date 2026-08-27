/**
 * PersonasPage.tsx — Settings ▸ Personas.
 *
 * Lets a user see every persona available to `spawn_agent` (their own, any project-scope ones,
 * and imported/shared ones), export one of their OWN personas as plain text to share, and
 * import a persona either from a local .md file (the native picker → a PATH, since the
 * renderer is sandboxed and can't read the file itself — see `fileOpen`'s own doc) or from
 * pasted markdown text.
 *
 * THE SAFETY STORY THIS PAGE EXISTS TO TELL (packages/core/src/agent/agent-files.ts's header
 * is the full version): importing a persona from someone else can only ever NARROW what it's
 * allowed to do — never widen it. It can never choose a model, never gain a tool the parent
 * didn't already have, and it always runs read-only, no matter what the file's own frontmatter
 * claims. That's why the ONLY destructive action offered per row is "Remove" on an
 * imported-scope row — never on the user's own or a project's persona, which this page has no
 * business deleting.
 *
 * Matches ModelHealthPage.tsx/HooksPage.tsx's conventions: `Panel`/`StatusPill` from
 * "@prometheus/ui", plain inline `CSSProperties`, `var(--...)` tokens, explicit
 * loading/error/empty states. Like those pages, there is no `.test.tsx` sibling anywhere in
 * this app (the node:test runner's dev-resolver can't transform JSX) — the pure logic this page
 * needs tested lives in persona-view.ts instead.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the local `usePersonas` hook +
 * `persona-view.ts`'s pure helpers + `window.prometheus.fileOpen` + the standard,
 * unprivileged `navigator.clipboard` API only.
 */
import { EmptyState, Panel, StatusPill } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useState } from "react";

import { usePersonas } from "../shared/persona/usePersonas.js";
import {
  type PersonaScope,
  scopeLabel,
  scopePillStatus,
  suggestedImportName,
} from "./persona-view.js";

const SCOPE_TITLE: Record<PersonaScope, string> = {
  user: "Your own persona file — fully trusted, exactly as written.",
  project:
    "Came bundled with this project's repository. Always read-only, can never pick a model, " +
    "and any tool list it declares can only narrow what a sub-agent may do — never widen it.",
  imported:
    "Imported — shared by another user, not written by you. Always read-only, can never pick " +
    "a model, and any tool list it declares can only narrow what a sub-agent may do — never " +
    "widen it, no matter what the file itself asks for.",
};

export function PersonasPage(): ReactElement {
  const { personas, loading, error, refresh, exportOne, importText, importPath, remove } =
    usePersonas();

  const [exportName, setExportName] = useState<string | undefined>(undefined);
  const [exportMarkdown, setExportMarkdown] = useState<string | undefined>(undefined);
  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const [pasteName, setPasteName] = useState("");
  const [pasteMarkdown, setPasteMarkdown] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | undefined>(undefined);

  const [removeBusy, setRemoveBusy] = useState<string | undefined>(undefined);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);

  const handleExport = async (name: string): Promise<void> => {
    setExportName(name);
    setExportError(undefined);
    setExportMarkdown(undefined);
    setCopyStatus("idle");
    const markdown = await exportOne(name);
    if (markdown === undefined) setExportError(`Could not export "${name}".`);
    else setExportMarkdown(markdown);
  };

  const handleCopy = async (): Promise<void> => {
    if (exportMarkdown === undefined) return;
    try {
      await navigator.clipboard.writeText(exportMarkdown);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  const handleChooseFile = async (): Promise<void> => {
    const res = await globalThis.window?.prometheus?.fileOpen({
      title: "Choose a persona markdown file",
    });
    if (!res || res.canceled || !res.path) return;
    setImportBusy(true);
    setImportError(undefined);
    const result = await importPath(res.path);
    setImportBusy(false);
    if (!result.ok) setImportError(result.error ?? "Import failed.");
  };

  const handlePasteImport = async (): Promise<void> => {
    setImportBusy(true);
    setImportError(undefined);
    const result = await importText(pasteName, pasteMarkdown);
    setImportBusy(false);
    if (!result.ok) {
      setImportError(result.error ?? "Import failed.");
      return;
    }
    setPasteName("");
    setPasteMarkdown("");
  };

  const handleRemove = async (name: string): Promise<void> => {
    setRemoveBusy(name);
    setRemoveError(undefined);
    const ok = await remove(name);
    setRemoveBusy(undefined);
    if (!ok) setRemoveError(`Could not remove "${name}".`);
  };

  const pasteNameTrimmed = pasteName.trim();
  const pasteNameInvalid = pasteNameTrimmed !== "" && suggestedImportName(pasteName) === null;

  return (
    <Panel
      title="Personas"
      elevation="e1"
      actions={
        <button type="button" style={refreshBtn} onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6, 12px)" }}>
        <p style={hintStyle}>
          Personas customize a spawned sub-agent's role and focus. Sharing exports your OWN persona
          as plain text for someone else to import; anything YOU import is always read-only and can
          never choose a model or gain new tools, no matter what the file asks for — importing a
          persona from someone else can only narrow what it's allowed to do, never widen it.
        </p>

        {error && <div style={{ color: "var(--danger)" }}>{error}</div>}

        {!error && loading && personas.length === 0 && (
          <div style={{ color: "var(--text-secondary)" }}>loading…</div>
        )}

        {!error && !loading && personas.length === 0 && (
          <EmptyState
            title="No personas yet"
            hint="Add a persona under ~/.prometheus/agents, or import one someone shared with you — either will show up here."
          />
        )}

        {personas.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Scope</th>
                  <th style={thStyle}>Description</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {personas.map((p) => (
                  <tr key={p.name} style={rowStyle}>
                    <td style={tdStyle}>
                      <code style={{ fontFamily: "var(--font-mono)" }}>{p.name}</code>
                    </td>
                    <td style={tdStyle}>
                      <StatusPill
                        status={scopePillStatus(p.scope)}
                        label={scopeLabel(p.scope)}
                        title={SCOPE_TITLE[p.scope]}
                      />
                    </td>
                    <td style={tdStyle}>{p.description}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
                        {p.scope === "user" && (
                          <button
                            type="button"
                            style={linkBtn}
                            onClick={() => void handleExport(p.name)}
                          >
                            Export
                          </button>
                        )}
                        {p.scope === "imported" && (
                          <button
                            type="button"
                            style={linkBtn}
                            disabled={removeBusy === p.name}
                            onClick={() => void handleRemove(p.name)}
                            aria-label={`remove imported persona ${p.name}`}
                          >
                            {removeBusy === p.name ? "Removing…" : "Remove"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {removeError && <div style={{ color: "var(--danger)" }}>{removeError}</div>}

        {exportName && (
          <Panel title={`Export "${exportName}"`} elevation="e0">
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
              {exportError && <div style={{ color: "var(--danger)" }}>{exportError}</div>}
              {exportMarkdown !== undefined && (
                <>
                  <p style={hintStyle}>
                    This is your own persona's raw markdown — copy it and send it to whoever you're
                    sharing it with. Whatever they import from it will run read-only on their end,
                    no matter what it says.
                  </p>
                  <textarea
                    readOnly
                    value={exportMarkdown}
                    aria-label={`exported markdown for ${exportName}`}
                    style={{
                      ...inputStyle,
                      fontFamily: "var(--font-mono)",
                      minHeight: 220,
                      resize: "vertical",
                    }}
                  />
                  <div
                    style={{ display: "flex", alignItems: "center", gap: "var(--space-3, 6px)" }}
                  >
                    <button type="button" style={primaryBtn} onClick={() => void handleCopy()}>
                      Copy to clipboard
                    </button>
                    {copyStatus === "copied" && (
                      <span style={{ color: "var(--ok)", fontSize: "0.75rem" }}>Copied.</span>
                    )}
                    {copyStatus === "failed" && (
                      <span style={{ color: "var(--danger)", fontSize: "0.75rem" }}>
                        Couldn't copy automatically — select the text above and copy it manually.
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </Panel>
        )}

        <Panel title="Import a persona" elevation="e0">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
            <p style={hintStyle}>
              Import from a file someone sent you, or paste the markdown directly. Either way, what
              lands here is always read-only, can't pick its own model, and can only narrow the
              tools a sub-agent using it is allowed to touch.
            </p>

            {importError && <div style={{ color: "var(--danger)" }}>{importError}</div>}

            <div>
              <button
                type="button"
                style={secondaryBtn}
                disabled={importBusy}
                onClick={() => void handleChooseFile()}
              >
                Choose file…
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}>
              <span style={fieldLabelStyle}>Or paste markdown</span>
              <input
                value={pasteName}
                onChange={(e) => setPasteName(e.currentTarget.value)}
                placeholder="suggested name (lowercase letters, numbers, - or _)"
                aria-label="import name"
                style={inputStyle}
              />
              {pasteNameInvalid && (
                <span style={{ color: "var(--danger)", fontSize: "0.72rem" }}>
                  This name will be rejected — use lowercase letters, numbers, "-" or "_", up to 32
                  characters.
                </span>
              )}
              <textarea
                value={pasteMarkdown}
                onChange={(e) => setPasteMarkdown(e.currentTarget.value)}
                placeholder={"---\nmode: explore\ndescription: ...\n---\n\npersona body…"}
                aria-label="persona markdown"
                style={{
                  ...inputStyle,
                  fontFamily: "var(--font-mono)",
                  minHeight: 160,
                  resize: "vertical",
                }}
              />
              <div>
                <button
                  type="button"
                  style={primaryBtn}
                  disabled={importBusy || pasteNameTrimmed === "" || pasteMarkdown.trim() === ""}
                  onClick={() => void handlePasteImport()}
                >
                  {importBusy ? "Importing…" : "Import"}
                </button>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </Panel>
  );
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8125rem",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  color: "var(--text-secondary)",
  fontWeight: 500,
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  borderBottom: "1px solid var(--border-strong)",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  borderBottom: "1px solid var(--border-subtle, var(--border-strong))",
  verticalAlign: "middle",
};

const rowStyle: CSSProperties = {
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const refreshBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "0.75rem",
};

const linkBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--accent)",
  cursor: "pointer",
  fontSize: "0.75rem",
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
  color: "var(--text-primary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
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

const fieldLabelStyle: CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-ui)",
};

export default PersonasPage;
