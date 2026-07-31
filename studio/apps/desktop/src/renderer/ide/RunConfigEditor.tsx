/**
 * ide/RunConfigEditor.tsx — the Run/Debug configuration editor form (APP-033).
 *
 * Create / edit / duplicate / delete launch.json configurations from a form
 * instead of hand-writing JSONC. ALL mutation math is the PURE run-config.ts
 * helpers (upsertConfig/duplicateConfig/deleteConfig, buildRawConfig round-trips
 * unknown fields); this component only owns form state and calls `onPersist`
 * with the mutated list — the OWNER (DebugPanel) does the path-guarded
 * fsWrite + reload, so there is exactly one disk path and one parsed truth.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the pure state module.
 */

import { Button, Panel } from "@prometheus/ui";
import { type ReactElement, useState } from "react";

import {
  type ConfigFields,
  type RunConfig,
  deleteConfig,
  duplicateConfig,
  upsertConfig,
} from "./state/run-config.js";

export interface RunConfigEditorProps {
  /** the EDITABLE configs (from .vscode/launch.json only — .prometheus ones are read-only). */
  configs: RunConfig[];
  /** the picker's currently selected config name (prefills Edit/Duplicate/Delete). */
  selectedName: string | null;
  /** persist the mutated list to .vscode/launch.json; true = saved (form closes). */
  onPersist(next: RunConfig[]): Promise<boolean>;
}

type Template = "python-program" | "python-module" | "node";

interface FormState {
  prevName: string | null; // null = creating
  name: string;
  template: Template;
  target: string; // program path or module name (per template)
  argsText: string; // one arg per line — each line stays ONE argv token
  envRows: Array<{ k: string; v: string }>;
  cwd: string;
  python: string;
}

const secondary = "var(--text-secondary, #9a9aa3)";
const mono = "var(--font-mono, ui-monospace, monospace)";

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  background: "var(--bg-surface-2, #16161b)",
  color: "var(--text-primary, #e7e7ea)",
  border: "1px solid var(--border-subtle, #2a2a33)",
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: "0.72rem",
  fontFamily: mono,
};

/** cfg → form (template inferred from type + program/module). */
function toForm(cfg: RunConfig): FormState {
  const template: Template =
    cfg.type === "node" ? "node" : cfg.module !== undefined ? "python-module" : "python-program";
  return {
    prevName: cfg.name,
    name: cfg.name,
    template,
    target: cfg.module ?? cfg.program ?? "",
    argsText: (cfg.args ?? []).join("\n"),
    envRows: Object.entries(cfg.env ?? {}).map(([k, v]) => ({ k, v })),
    cwd: cfg.cwd ?? "",
    python: typeof cfg.raw.python === "string" ? cfg.raw.python : "",
  };
}

function emptyForm(): FormState {
  return {
    prevName: null,
    name: "",
    template: "python-program",
    target: "",
    argsText: "",
    envRows: [],
    cwd: "",
    python: "",
  };
}

/** form → the pure ConfigFields (canonical type: debugpy for python, node for node). */
function toFields(f: FormState): ConfigFields {
  const args = f.argsText
    .split("\n")
    .map((a) => a.trim())
    .filter((a) => a !== "");
  const env: Record<string, string> = {};
  for (const row of f.envRows) {
    if (row.k.trim() !== "") env[row.k.trim()] = row.v;
  }
  return {
    name: f.name.trim(),
    type: f.template === "node" ? "node" : "debugpy",
    request: "launch",
    ...(f.template === "python-module"
      ? { module: f.target.trim() }
      : { program: f.target.trim() }),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(f.cwd.trim() !== "" ? { cwd: f.cwd.trim() } : {}),
    ...(f.python.trim() !== "" ? { python: f.python.trim() } : {}),
  };
}

export function RunConfigEditor({
  configs,
  selectedName,
  onPersist,
}: RunConfigEditorProps): ReactElement {
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = configs.find((c) => c.name === selectedName);
  const editable = selected !== undefined && selected.type !== "compound";

  const persist = async (next: RunConfig[] | string): Promise<void> => {
    if (typeof next === "string") {
      setError(next);
      return;
    }
    setSaving(true);
    const ok = await onPersist(next);
    setSaving(false);
    if (ok) {
      setForm(null);
      setError(null);
    } else {
      setError("could not write .vscode/launch.json");
    }
  };

  // a div wrapper (not <label>): the control is a dynamic child biome can't
  // statically pair, and every input carries its own aria-label already.
  const field = (label: string, node: ReactElement): ReactElement => (
    <div style={{ display: "block", marginBottom: 6, fontSize: "0.72rem", color: secondary }}>
      <span style={{ display: "block", marginBottom: 2 }}>{label}</span>
      {node}
    </div>
  );

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setForm(emptyForm());
            setError(null);
          }}
        >
          ＋ New config
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!editable}
          title={editable ? undefined : "select a .vscode/launch.json config first"}
          onClick={() => {
            if (selected) {
              setForm(toForm(selected));
              setError(null);
            }
          }}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!selected}
          onClick={() => {
            if (selectedName) void persist(duplicateConfig(configs, selectedName));
          }}
        >
          Duplicate
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!selected}
          onClick={() => {
            if (selectedName) void persist(deleteConfig(configs, selectedName));
          }}
        >
          Delete
        </Button>
      </div>
      {error && !form && (
        <p
          role="alert"
          style={{ margin: "4px 0 0", color: "var(--danger, #ef5a5a)", fontSize: "0.72rem" }}
        >
          {error}
        </p>
      )}
      {form && (
        <Panel
          title={form.prevName ? `Edit: ${form.prevName}` : "New configuration"}
          elevation="e1"
        >
          <form
            aria-label="run configuration editor"
            onSubmit={(e) => {
              e.preventDefault();
              void persist(upsertConfig(configs, toFields(form), form.prevName ?? undefined));
            }}
          >
            {field(
              "Name",
              <input
                style={inputStyle}
                value={form.name}
                aria-label="config name"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />,
            )}
            {field(
              "Template",
              <select
                style={{ ...inputStyle, width: "auto" }}
                value={form.template}
                aria-label="config template"
                onChange={(e) => setForm({ ...form, template: e.target.value as Template })}
              >
                <option value="python-program">python: program (debugpy)</option>
                <option value="python-module">python: module (debugpy)</option>
                <option value="node">node: program</option>
              </select>,
            )}
            {field(
              form.template === "python-module" ? "Module (python -m …)" : "Program (file path)",
              <input
                style={inputStyle}
                value={form.target}
                aria-label="config target"
                placeholder={
                  form.template === "python-module" ? "pkg.tool" : "${workspaceFolder}/main.py"
                }
                onChange={(e) => setForm({ ...form, target: e.target.value })}
              />,
            )}
            {field(
              "Arguments (one per line — each line stays a single argv token)",
              <textarea
                style={{ ...inputStyle, minHeight: 40 }}
                value={form.argsText}
                aria-label="config args"
                onChange={(e) => setForm({ ...form, argsText: e.target.value })}
              />,
            )}
            <div style={{ marginBottom: 6, fontSize: "0.72rem", color: secondary }}>
              <span style={{ display: "block", marginBottom: 2 }}>Environment</span>
              {form.envRows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional editors
                <div key={i} style={{ display: "flex", gap: 4, marginBottom: 2 }}>
                  <input
                    style={{ ...inputStyle, width: 130 }}
                    value={row.k}
                    aria-label={`env key ${i}`}
                    placeholder="KEY"
                    onChange={(e) => {
                      const envRows = form.envRows.map((r, j) =>
                        j === i ? { ...r, k: e.target.value } : r,
                      );
                      setForm({ ...form, envRows });
                    }}
                  />
                  <input
                    style={{ ...inputStyle, flex: 1 }}
                    value={row.v}
                    aria-label={`env value ${i}`}
                    placeholder="value"
                    onChange={(e) => {
                      const envRows = form.envRows.map((r, j) =>
                        j === i ? { ...r, v: e.target.value } : r,
                      );
                      setForm({ ...form, envRows });
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`remove env row ${i}`}
                    onClick={() =>
                      setForm({ ...form, envRows: form.envRows.filter((_, j) => j !== i) })
                    }
                    style={{
                      background: "transparent",
                      border: "none",
                      color: secondary,
                      cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => setForm({ ...form, envRows: [...form.envRows, { k: "", v: "" }] })}
              >
                ＋ env var
              </Button>
            </div>
            {field(
              "Working directory (empty = workspace root)",
              <input
                style={inputStyle}
                value={form.cwd}
                aria-label="config cwd"
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
              />,
            )}
            {form.template !== "node" &&
              field(
                "Python interpreter (debugpy's `python` key; empty = default)",
                <input
                  style={inputStyle}
                  value={form.python}
                  aria-label="config interpreter"
                  placeholder="${workspaceFolder}/.venv/bin/python"
                  onChange={(e) => setForm({ ...form, python: e.target.value })}
                />,
              )}
            <p style={{ margin: "0 0 6px", fontSize: "0.68rem", color: secondary }}>
              Saving rewrites .vscode/launch.json as plain JSON — JSONC comments are not preserved.
              Configs you didn't edit round-trip untouched.
            </p>
            {error && (
              <p
                role="alert"
                style={{ margin: "0 0 6px", color: "var(--danger, #ef5a5a)", fontSize: "0.72rem" }}
              >
                {error}
              </p>
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <Button size="sm" variant="ghost" type="button" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </div>
  );
}

export default RunConfigEditor;
