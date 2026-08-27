/**
 * ide/RefactorPreview.tsx — the universal GATED Refactor Preview (APP-027).
 *
 * One consistent, cancellable preview dialog for EVERY APP-026 transform
 * (rename/extract/inline/move/changeSignature/safeDelete). EditorPane captures the
 * caret/selection context and dispatches `ide:refactor-open`; this host gathers the
 * transform's parameters, invokes `window.prometheus.ide.refactor.<t>`, and shows the
 * returned WorkspaceEdit as a file→edit tree with per-file include checkboxes.
 * NOTHING touches disk until Apply: excluded files are never fsRead/fsWrite'n at all
 * (byte-identity by omission), Cancel and an ok:false IPC result yield zero writes,
 * and an error renders INLINE in the dialog (the reviewed edit is never lost to a
 * vanishing toast).
 *
 * Apply goes through the ONE tested edit engine: fsRead → applyTextEdits (original,
 * unsorted per-file edit arrays — the applier owns splice order) → fsWrite, per
 * INCLUDED file only. Untouched regions pass through verbatim, so the file's existing
 * EOL style survives. An open Monaco model for a written uri is refreshed in place
 * via a full-range pushEditOperations (keeps the cursor sane; the undo stack keeps
 * the swap as one step) and its tab is marked clean.
 *
 * Renderer-SANDBOXED (C5): react + window.prometheus + the pure preview state in
 * state/text-edit-apply.ts + the lazy monaco-loader. No node/electron/engine-bridge.
 */

import { type TemplateKind, templateKindForLanguage } from "@prometheus/core/editor";
import { Button, Panel } from "@prometheus/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";

import { Z } from "@prometheus/ui";
import { StreamPausedError, streamChat } from "./ai/ai-client.js";
import { toEndpoints } from "./ai/endpoints.js";
import { loadMonaco } from "./monaco-loader.js";
import {
  type GenerateTransform,
  type TemplateTransform,
  aiGenMessages,
  aiMemberEdit,
  copyrightEditFor,
  newFileEdit,
  newFileTarget,
  offersAiFallback,
  parseAttrsList,
} from "./state/generate-actions.js";
import { useTabsStore } from "./state/stores.js";
import {
  type PreviewFileNode,
  type RefactorPreviewModel,
  type WorkspaceFileEdit,
  allPreviewUris,
  applyTextEdits,
  buildPreview,
  normalizeWorkspaceEdit,
  selectedEdits,
  togglePreviewUri,
} from "./state/text-edit-apply.js";

/** The APP-026 rope transforms + the APP-028 Generate surface (preload method
 *  names for the IPC-backed ones; the two template transforms are local). */
export type RefactorTransform =
  | "rename"
  | "extract"
  | "inline"
  | "move"
  | "changeSignature"
  | "safeDelete"
  | GenerateTransform
  | TemplateTransform;

/** refactor.py-backed generators (python-only; may offer the local-AI fallback). */
const GENERATE: ReadonlySet<string> = new Set([
  "genInit",
  "genRepr",
  "genEq",
  "genDataclass",
  "genProperty",
  "genOverride",
  "genDelegate",
  "genDocstring",
]);

/** core-template transforms — built locally from @prometheus/core/editor, no sidecar. */
const TEMPLATES: ReadonlySet<string> = new Set(["newFileTemplate", "copyrightHeader"]);

/** Caret/selection context captured by EditorPane when a refactor action fires. */
export interface RefactorOpenDetail {
  transform: RefactorTransform;
  /** the focused model's uri (file:// for real files; scratch: is refused here). */
  uri: string;
  languageId: string;
  /** 1-based caret, column pinned to the START of the word under the caret. */
  line: number;
  col: number;
  /** 1-based selection line span (both = caret line when the selection is empty). */
  startLine: number;
  endLine: number;
  hasSelection: boolean;
  /** the identifier under the caret ("" when none). */
  word: string;
}

const TRANSFORM_TITLES: Record<RefactorTransform, string> = {
  rename: "Rename Symbol",
  extract: "Extract Method/Variable",
  inline: "Inline Symbol",
  move: "Move to Module",
  changeSignature: "Change Signature",
  safeDelete: "Safe Delete",
  genInit: "Generate __init__",
  genRepr: "Generate __repr__",
  genEq: "Generate __eq__",
  genDataclass: "Convert to @dataclass",
  genProperty: "Generate Property",
  genOverride: "Override Method",
  genDelegate: "Delegate Method",
  genDocstring: "Generate Docstring",
  newFileTemplate: "New File from Template",
  copyrightHeader: "Insert Copyright Header",
};

/** safe-delete refusal rows (usages-remain) surfaced inline. */
interface UsageRow {
  uri: string;
  line: number;
}

/** ide api accessor (undefined-safe in non-electron tests). */
function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** file:// uri → fs path (display + root-containment checks); fail-soft. */
function uriToPath(uri: string): string {
  const stripped = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

/** The rope project root for a target: the workspace root when the file is under it. */
function rootFor(uri: string): string | undefined {
  const root = useTabsStore.getState().workspaceRoot;
  const path = uriToPath(uri);
  return root && (path === root || path.startsWith(`${root}/`)) ? root : undefined;
}

/** Parse a comma-separated original-0-based index list ("" → [] — a sole-param
 *  removal legitimately leaves nothing to order, APP-026). null = invalid input. */
export function parseIndexList(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const out: number[] = [];
  for (const part of trimmed.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 0) return null;
    out.push(n);
  }
  return out;
}

/* ── presentational dialog ──────────────────────────────────────────────────── */

/** Everything the dialog renders — kept prop-driven so the offscreen render check
 *  can drive the REAL component with a fixture WorkspaceEdit. */
export interface RefactorPreviewDialogProps {
  title: string;
  /** params stage: transform-specific inputs; preview stage: the edit tree. */
  stage: "params" | "loading" | "preview" | "applying";
  transform: RefactorTransform;
  word: string;
  preview: RefactorPreviewModel | null;
  included: ReadonlySet<string>;
  error: string | null;
  usages: UsageRow[];
  /** offer "Generate with local AI" beside the error (AST-insufficient codes). */
  aiOffer: boolean;
  onToggleFile(uri: string): void;
  onSubmitParams(params: Record<string, string>): void;
  onApply(): void;
  onCancel(): void;
  onAiFallback(): void;
}

const mono = "var(--font-mono, ui-monospace, monospace)";
const secondary = "var(--text-secondary)";
const primaryText = "var(--text-primary)";
const hairline = "1px solid var(--border-subtle)";

/** One labelled text input of the params form. */
function ParamInput({
  label,
  name,
  defaultValue,
  placeholder,
  autoFocus,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  autoFocus?: boolean;
}): ReactElement {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => ref.current?.select());
  }, [autoFocus]);
  return (
    <label style={{ display: "block", marginBottom: 8, fontSize: "0.78rem", color: secondary }}>
      <span style={{ display: "block", marginBottom: 3 }}>{label}</span>
      <input
        ref={ref}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "6px 8px",
          background: "var(--bg-inset)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-sm, 4px)",
          color: primaryText,
          fontFamily: mono,
          fontSize: "0.8rem",
          outline: "none",
        }}
      />
    </label>
  );
}

/** The transform-specific parameter inputs (uncontrolled; read out on submit). */
function ParamsForm({
  transform,
  word,
  onSubmit,
  onCancel,
}: {
  transform: RefactorTransform;
  word: string;
  onSubmit(params: Record<string, string>): void;
  onCancel(): void;
}): ReactElement {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const params: Record<string, string> = {};
        for (const [k, v] of data.entries()) {
          if (typeof v === "string") params[k] = v;
        }
        onSubmit(params);
      }}
    >
      {transform === "rename" && (
        <ParamInput label="New name" name="newName" defaultValue={word} autoFocus />
      )}
      {transform === "extract" && (
        <>
          <ParamInput label="Name" name="name" placeholder="extracted_name" autoFocus />
          <label
            style={{ display: "block", marginBottom: 8, fontSize: "0.78rem", color: secondary }}
          >
            <span style={{ display: "block", marginBottom: 3 }}>Kind</span>
            <select
              name="kind"
              defaultValue="method"
              style={{
                padding: "5px 8px",
                background: "var(--bg-inset)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-sm, 4px)",
                color: primaryText,
                fontSize: "0.8rem",
              }}
            >
              <option value="method">method</option>
              <option value="variable">variable</option>
            </select>
          </label>
        </>
      )}
      {transform === "move" && (
        <>
          <ParamInput label="Symbol (top-level def/class)" name="symbol" defaultValue={word} />
          <ParamInput
            label="Destination module (existing .py; absolute or workspace-relative)"
            name="dest"
            placeholder="pkg/target.py"
            autoFocus
          />
        </>
      )}
      {transform === "changeSignature" && (
        <>
          <ParamInput
            label="New parameter order — comma-separated ORIGINAL 0-based indices (empty = none)"
            name="order"
            placeholder="1, 0, 2"
            autoFocus
          />
          <ParamInput label="Remove parameter — ORIGINAL 0-based index (optional)" name="remove" />
        </>
      )}
      {(transform === "genInit" || transform === "genRepr" || transform === "genEq") && (
        <ParamInput
          label="Attributes — comma-separated (empty = derive from the class)"
          name="attrs"
          placeholder="x, y, tag"
          autoFocus
        />
      )}
      {transform === "genProperty" && (
        <ParamInput
          label="Attribute (backing field, e.g. _speed or speed)"
          name="attr"
          defaultValue={word}
          autoFocus
        />
      )}
      {transform === "genOverride" && (
        <ParamInput label="Base method to override" name="method" defaultValue={word} autoFocus />
      )}
      {transform === "genDelegate" && (
        <>
          <ParamInput label="Delegate to field (self.<field>)" name="attr" autoFocus />
          <ParamInput label="Method to delegate" name="method" defaultValue={word} />
        </>
      )}
      {transform === "newFileTemplate" && (
        <>
          <ParamInput
            label="File name (workspace-relative)"
            name="filename"
            placeholder="pkg/new_module.py"
            autoFocus
          />
          <label
            style={{ display: "block", marginBottom: 8, fontSize: "0.78rem", color: secondary }}
          >
            <span style={{ display: "block", marginBottom: 3 }}>Template</span>
            <select
              name="kind"
              defaultValue="python"
              style={{
                padding: "5px 8px",
                background: "var(--bg-inset)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-sm, 4px)",
                color: primaryText,
                fontSize: "0.8rem",
              }}
            >
              <option value="python">python</option>
              <option value="typescript">typescript</option>
              <option value="plain">plain</option>
            </select>
          </label>
        </>
      )}
      {transform === "copyrightHeader" && (
        <>
          <ParamInput label="Owner" name="owner" placeholder="Your Company" autoFocus />
          <ParamInput
            label="Year (empty = current year)"
            name="year"
            placeholder={String(new Date().getFullYear())}
          />
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm">
          Preview
        </Button>
      </div>
    </form>
  );
}

/** One file node: include checkbox + path + its edit rows with old→new snippets. */
function FileNode({
  node,
  included,
  disabled,
  onToggle,
}: {
  node: PreviewFileNode;
  included: boolean;
  disabled: boolean;
  onToggle(): void;
}): ReactElement {
  return (
    <div style={{ borderBottom: hairline, padding: "6px 0" }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: disabled ? "default" : "pointer",
          fontSize: "0.8rem",
          color: primaryText,
        }}
      >
        <input
          type="checkbox"
          checked={included}
          disabled={disabled}
          onChange={onToggle}
          aria-label={`include ${node.path}`}
          style={{ accentColor: "var(--accent)" }}
        />
        <span style={{ fontFamily: mono, overflowWrap: "break-word" }}>{node.path}</span>
        <span style={{ color: secondary, fontSize: "0.72rem", whiteSpace: "nowrap" }}>
          {node.editCount} edit{node.editCount === 1 ? "" : "s"}
        </span>
      </label>
      <div style={{ paddingLeft: 24, opacity: included ? 1 : 0.45 }}>
        {node.edits.map((e, i) => (
          <div
            key={`${e.startLine}:${e.startCol}:${i}`}
            style={{ margin: "5px 0", fontFamily: mono, fontSize: "0.74rem" }}
          >
            <div style={{ color: secondary }}>
              L{e.startLine}:{e.startCol}–L{e.endLine}:{e.endCol}
              {e.oldText !== undefined && (
                <>
                  {"  "}
                  <span style={{ color: "var(--danger)" }}>
                    {e.oldText === "" ? "∅" : e.oldText.split("\n")[0]}
                  </span>
                  {" → "}
                  <span style={{ color: "var(--ok)" }}>
                    {e.newText === "" ? "∅" : e.newText.split("\n")[0]}
                  </span>
                </>
              )}
            </div>
            {(e.before.length > 0 || e.oldText === undefined) && (
              <pre
                style={{
                  margin: "3px 0 0",
                  padding: "4px 6px",
                  background: "var(--bg-inset)",
                  border: hairline,
                  borderRadius: "var(--radius-sm, 4px)",
                  overflowX: "auto",
                  lineHeight: 1.45,
                }}
              >
                {e.before.map((l, j) => (
                  <div key={`b${j}:${l}`} style={{ color: "var(--danger)" }}>
                    - {l}
                  </div>
                ))}
                {e.after.map((l, j) => (
                  <div key={`a${j}:${l}`} style={{ color: "var(--ok)" }}>
                    + {l}
                  </div>
                ))}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The dialog itself — pure props in, callbacks out (offscreen-render testable). */
export function RefactorPreviewDialog(props: RefactorPreviewDialogProps): ReactElement {
  const { stage, preview, included, error, usages } = props;
  const busy = stage === "loading" || stage === "applying";
  const selectedCount = preview
    ? preview.files.reduce((n, f) => n + (included.has(f.uri) ? 1 : 0), 0)
    : 0;
  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) props.onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) props.onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: Z.palette,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: 60,
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: role=dialog on a div matches the CommandPalette/ClipboardHistory modal convention; escape/backdrop handled locally */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        style={{ width: "min(760px, 94vw)", maxHeight: "80vh", display: "flex" }}
      >
        <Panel
          title={props.title}
          raised
          elevation="e3"
          actions={
            <span style={{ color: secondary, fontSize: "0.72rem" }}>
              {stage === "preview" && preview
                ? `${selectedCount}/${preview.files.length} file${preview.files.length === 1 ? "" : "s"} selected`
                : null}
            </span>
          }
        >
          <div style={{ maxHeight: "58vh", overflow: "auto" }}>
            {stage === "params" && (
              <ParamsForm
                transform={props.transform}
                word={props.word}
                onSubmit={props.onSubmitParams}
                onCancel={props.onCancel}
              />
            )}
            {stage === "loading" && (
              <p style={{ color: secondary, fontSize: "0.8rem", margin: 0 }}>
                Computing refactoring…
              </p>
            )}
            {(stage === "preview" || stage === "applying") &&
              preview?.files.map((f) => (
                <FileNode
                  key={f.uri}
                  node={f}
                  included={included.has(f.uri)}
                  disabled={stage === "applying"}
                  onToggle={() => props.onToggleFile(f.uri)}
                />
              ))}
            {error && (
              <div
                role="alert"
                style={{
                  marginTop: 8,
                  padding: "6px 8px",
                  border: "1px solid var(--danger)",
                  borderRadius: "var(--radius-sm, 4px)",
                  color: "var(--danger)",
                  fontSize: "0.78rem",
                  fontFamily: mono,
                  overflowWrap: "break-word",
                }}
              >
                {error}
                {usages.length > 0 && (
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {usages.slice(0, 20).map((u) => (
                      <li key={`${u.uri}:${u.line}`}>
                        {uriToPath(u.uri)}:{u.line}
                      </li>
                    ))}
                    {usages.length > 20 && <li>… {usages.length - 20} more</li>}
                  </ul>
                )}
                {props.aiOffer && (
                  <div style={{ marginTop: 8 }}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={props.onAiFallback}
                    >
                      Generate with local AI
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
          {stage !== "params" && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 10,
                paddingTop: 8,
                borderTop: hairline,
              }}
            >
              <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={stage !== "preview" || selectedCount === 0}
                onClick={props.onApply}
              >
                {stage === "applying" ? "Applying…" : "Apply"}
              </Button>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ── event-driven host (mounted once by EditorPane) ─────────────────────────── */

interface HostState {
  detail: RefactorOpenDetail;
  stage: "params" | "loading" | "preview" | "applying";
  preview: RefactorPreviewModel | null;
  included: Set<string>;
  error: string | null;
  usages: UsageRow[];
  /** the "Generate with local AI" offer is live (AST-insufficient sidecar code). */
  aiOffer: boolean;
  /** a uri the preview may CREATE (new-file template): apply treats a failed
   *  read of exactly this uri as empty existing text instead of an error. */
  createUri: string | null;
}

/** Transforms that need no user parameters — they invoke straight away. */
const PARAMLESS: ReadonlySet<RefactorTransform> = new Set([
  "inline",
  "safeDelete",
  "genDataclass",
  "genDocstring",
]);

type IdeApi = NonNullable<ReturnType<typeof ide>>;
/** The ide:refactor result shape (derived from the preload contract). */
type RefactorIpcResult = Awaited<ReturnType<IdeApi["refactor"]["rename"]>>;

/** Build the IPC request for a transform from the captured context + form params.
 *  Returns a string on user-input validation failure (rendered inline). */
function buildRequest(
  d: RefactorOpenDetail,
  params: Record<string, string>,
): { call: (api: IdeApi) => Promise<RefactorIpcResult> } | string {
  const root = rootFor(d.uri);
  const base = { file: d.uri, ...(root !== undefined ? { root } : {}) };
  switch (d.transform) {
    case "rename": {
      const newName = (params.newName ?? "").trim();
      if (newName === "") return "new name must not be empty";
      return { call: (api) => api.refactor.rename({ ...base, line: d.line, col: d.col, newName }) };
    }
    case "extract": {
      const name = (params.name ?? "").trim();
      if (name === "") return "name must not be empty";
      const kind = params.kind === "variable" ? "variable" : "method";
      return {
        call: (api) =>
          api.refactor.extract({ ...base, startLine: d.startLine, endLine: d.endLine, name, kind }),
      };
    }
    case "inline":
      return { call: (api) => api.refactor.inline({ ...base, line: d.line, col: d.col }) };
    case "move": {
      const symbol = (params.symbol ?? "").trim();
      const destRaw = (params.dest ?? "").trim();
      if (symbol === "") return "symbol must not be empty";
      if (destRaw === "") return "destination module must not be empty";
      const root2 = rootFor(d.uri);
      const dest = destRaw.startsWith("/") || root2 === undefined ? destRaw : `${root2}/${destRaw}`;
      return { call: (api) => api.refactor.move({ ...base, symbol, dest }) };
    }
    case "changeSignature": {
      const order = parseIndexList(params.order ?? "");
      if (order === null) return "order must be comma-separated non-negative integers";
      const removeRaw = (params.remove ?? "").trim();
      const remove = removeRaw === "" ? undefined : Number(removeRaw);
      if (remove !== undefined && (!Number.isInteger(remove) || remove < 0)) {
        return "remove must be a non-negative integer";
      }
      return {
        call: (api) =>
          api.refactor.changeSignature({
            ...base,
            line: d.line,
            col: d.col,
            order,
            ...(remove !== undefined ? { remove } : {}),
          }),
      };
    }
    case "safeDelete":
      return { call: (api) => api.refactor.safeDelete({ ...base, line: d.line, col: d.col }) };
    // gen-* generators (APP-028): single-file, keyed on the caret LINE — no root.
    case "genInit":
    case "genRepr":
    case "genEq": {
      const attrs = parseAttrsList(params.attrs ?? "");
      if (attrs === null) return "attributes must be comma-separated Python identifiers";
      const req = { file: d.uri, line: d.line, ...(attrs !== undefined ? { attrs } : {}) };
      const method = d.transform; // narrowed to genInit | genRepr | genEq here
      return { call: (api) => api.refactor[method](req) };
    }
    case "genDataclass":
      return { call: (api) => api.refactor.genDataclass({ file: d.uri, line: d.line }) };
    case "genDocstring":
      return { call: (api) => api.refactor.genDocstring({ file: d.uri, line: d.line }) };
    case "genProperty": {
      const attr = (params.attr ?? "").trim();
      if (attr === "") return "attribute must not be empty";
      return { call: (api) => api.refactor.genProperty({ file: d.uri, line: d.line, attr }) };
    }
    case "genOverride": {
      const method = (params.method ?? "").trim();
      if (method === "") return "method must not be empty";
      return { call: (api) => api.refactor.genOverride({ file: d.uri, line: d.line, method }) };
    }
    case "genDelegate": {
      const attr = (params.attr ?? "").trim();
      const method = (params.method ?? "").trim();
      if (attr === "") return "field must not be empty";
      if (method === "") return "method must not be empty";
      return {
        call: (api) => api.refactor.genDelegate({ file: d.uri, line: d.line, attr, method }),
      };
    }
    case "newFileTemplate":
    case "copyrightHeader":
      // handled locally by invokeTemplate() — never reaches the IPC builder
      return "template transforms do not use the refactor IPC";
  }
}

/**
 * Hosts the preview dialog: listens for `ide:refactor-open` (dispatched by
 * EditorPane's context-menu actions and the palette bus), runs params → invoke →
 * preview → apply. All IPC lives here (C5); the tree/state math is pure.
 */
export function RefactorHost(): ReactElement | null {
  const [st, setSt] = useState<HostState | null>(null);
  // the live state for async continuations (invoke/apply outlive a render).
  const stRef = useRef<HostState | null>(null);
  stRef.current = st;

  useEffect(() => {
    const onOpen = (e: Event): void => {
      const d = (e as CustomEvent<RefactorOpenDetail>).detail;
      if (!d || typeof d !== "object" || typeof d.transform !== "string") return;
      const fresh: HostState = {
        detail: d,
        stage: "params",
        preview: null,
        included: new Set(),
        error: null,
        usages: [],
        aiOffer: false,
        createUri: null,
      };
      // guards — surfaced INLINE in the dialog, not a vanishing toast.
      const isGen = GENERATE.has(d.transform);
      const isTpl = TEMPLATES.has(d.transform);
      if (d.transform !== "newFileTemplate" && !d.uri.startsWith("file://")) {
        setSt({ ...fresh, error: "this action needs a saved file:// document" });
        return;
      }
      if (!isTpl && d.languageId !== "python") {
        setSt({
          ...fresh,
          error: isGen
            ? "code generation is Python-only (AST sidecar)"
            : "structural refactors are Python-only (rope engine)",
        });
        return;
      }
      // gen verbs anchor on the caret LINE (inside the class/def), not a symbol
      if (!isGen && !isTpl && d.transform !== "extract" && d.word === "") {
        setSt({ ...fresh, error: "place the caret on a symbol first" });
        return;
      }
      if (d.transform === "extract" && !d.hasSelection) {
        setSt({ ...fresh, error: "select the lines to extract first" });
        return;
      }
      // sync the ref BEFORE the async invoke: a paramless transform's IPC can resolve
      // before React commits `fresh`, and invoke()'s "still mine" guard reads stRef —
      // a stale ref (null after a prior Cancel) would abort the open spuriously.
      stRef.current = fresh;
      setSt(fresh);
      if (PARAMLESS.has(d.transform)) void invoke(fresh, {});
    };
    window.addEventListener("ide:refactor-open", onOpen);
    return () => window.removeEventListener("ide:refactor-open", onOpen);
  }, []);

  /** params → IPC → normalized WorkspaceEdit → preview tree (reads for snippets). */
  async function invoke(current: HostState, params: Record<string, string>): Promise<void> {
    const api = ide();
    if (!api) {
      setSt({ ...current, error: "ide api unavailable" });
      return;
    }
    if (TEMPLATES.has(current.detail.transform)) {
      return invokeTemplate(current, params, api);
    }
    const req = buildRequest(current.detail, params);
    if (typeof req === "string") {
      setSt({ ...current, stage: "params", error: req });
      return;
    }
    setSt({ ...current, stage: "loading", error: null, usages: [], aiOffer: false });
    const res: RefactorIpcResult = await req.call(api).catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : "refactor ipc failed",
    }));
    if (stRef.current?.detail !== current.detail) return; // dialog was closed/reopened
    if (!res.ok) {
      setSt({
        ...current,
        stage: "params",
        error: res.error ?? "the refactor engine refused the transform",
        usages: Array.isArray(res.usages) ? res.usages : [],
        // AST could not derive the member (dynamic attrs, base outside the module…)
        // → offer the EXPLICIT local-AI path; never a silent skip (deliverable 5).
        aiOffer: GENERATE.has(current.detail.transform) && offersAiFallback(res.code),
      });
      return;
    }
    const files = normalizeWorkspaceEdit(res.edit);
    if (files.length === 0) {
      setSt({ ...current, stage: "params", error: "the transform produced no edits" });
      return;
    }
    await presentPreview(current, files, api);
  }

  /** Shared tail: read each file ONCE for snippets, build + show the tree. */
  async function presentPreview(
    current: HostState,
    files: WorkspaceFileEdit[],
    api: IdeApi,
    createUri: string | null = null,
  ): Promise<void> {
    const texts: Record<string, string | undefined> = {};
    for (const f of files) {
      if (f.uri === createUri) {
        texts[f.uri] = ""; // the file does not exist yet — preview against empty
        continue;
      }
      const read = await api.fsRead(f.uri).catch(() => undefined);
      texts[f.uri] = read?.ok && typeof read.text === "string" ? read.text : undefined;
    }
    if (stRef.current?.detail !== current.detail) return;
    const preview = buildPreview(files, texts);
    setSt({
      ...current,
      stage: "preview",
      preview,
      included: allPreviewUris(preview),
      error: null,
      usages: [],
      aiOffer: false,
      createUri,
    });
  }

  /** Core-template transforms (APP-028): the edit is built LOCALLY from the pure
   *  @prometheus/core/editor templates and flows through the SAME preview/apply
   *  path — nothing is written here. */
  async function invokeTemplate(
    current: HostState,
    params: Record<string, string>,
    api: IdeApi,
  ): Promise<void> {
    const d = current.detail;
    if (d.transform === "newFileTemplate") {
      const root = useTabsStore.getState().workspaceRoot;
      if (!root) {
        setSt({ ...current, stage: "params", error: "open a workspace folder first" });
        return;
      }
      const target = newFileTarget(root, params.filename ?? "");
      if (typeof target === "string") {
        setSt({ ...current, stage: "params", error: target });
        return;
      }
      setSt({ ...current, stage: "loading", error: null });
      const existing = await api.fsRead(target.uri).catch(() => undefined);
      if (stRef.current?.detail !== current.detail) return;
      if (existing?.ok) {
        setSt({
          ...current,
          stage: "params",
          error: `${uriToPath(target.uri)} already exists — pick another name`,
        });
        return;
      }
      const kind: TemplateKind =
        params.kind === "typescript" || params.kind === "plain" ? params.kind : "python";
      const filename = (params.filename ?? "").trim().split(/[\\/]/).pop() ?? "untitled";
      const edit = newFileEdit(target.uri, kind, { filename });
      await presentPreview(current, normalizeWorkspaceEdit(edit), api, target.uri);
      return;
    }
    // copyrightHeader — insert into the CURRENT file at the style-aware line.
    setSt({ ...current, stage: "loading", error: null });
    const read = await api.fsRead(d.uri).catch(() => undefined);
    if (stRef.current?.detail !== current.detail) return;
    if (!read?.ok || typeof read.text !== "string") {
      setSt({ ...current, stage: "params", error: `could not read ${uriToPath(d.uri)}` });
      return;
    }
    const style = templateKindForLanguage(d.languageId);
    const year = (params.year ?? "").trim();
    const edit = copyrightEditFor(d.uri, read.text, style, {
      owner: (params.owner ?? "").trim(),
      ...(year !== "" ? { year } : {}),
    });
    if (edit === null) {
      setSt({ ...current, stage: "params", error: "a copyright header is already present" });
      return;
    }
    await presentPreview(current, normalizeWorkspaceEdit(edit), api);
  }

  /** The EXPLICIT local-AI fallback (deliverable 5): local/agentic-local endpoints
   *  ONLY (cloud is refused up-front), and the model's member lands in the SAME
   *  preview as a WorkspaceEdit proposal — never auto-applied. */
  async function aiFallback(current: HostState): Promise<void> {
    const api = ide();
    if (!api) return;
    const d = current.detail;
    setSt({ ...current, stage: "loading", error: null, aiOffer: false });
    const eps = toEndpoints(
      await (typeof window !== "undefined"
        ? window.prometheus?.models?.endpoints().catch(() => undefined)
        : undefined),
    ).filter((e) => e.locality === "local");
    if (stRef.current?.detail !== current.detail) return;
    const local = eps[0];
    if (!local) {
      setSt({
        ...current,
        stage: "params",
        aiOffer: true,
        error:
          "no local AI endpoint available — serve a model from the Model Hub, then retry " +
          "(cloud endpoints are never used for code generation)",
      });
      return;
    }
    const read = await api.fsRead(d.uri).catch(() => undefined);
    const text = read?.ok && typeof read.text === "string" ? read.text : "";
    const lines = text.split("\n");
    const context = lines.slice(Math.max(0, d.line - 120), d.line + 40).join("\n");
    let out = "";
    try {
      const messages = aiGenMessages(
        TRANSFORM_TITLES[d.transform] ?? d.transform,
        d.languageId,
        context,
      );
      // neverSendToCloud pinned true: even a misclassified endpoint is refused.
      for await (const delta of streamChat(local, messages, { neverSendToCloud: true })) {
        out += delta;
      }
    } catch (err) {
      if (stRef.current?.detail !== current.detail) return;
      // A pause (idle watchdog), not a failure — if the model had already produced SOME code
      // before going quiet, `out` holds real, reviewable content and falls through to the
      // normal preview below rather than being discarded for a from-scratch retry.
      if (!(err instanceof StreamPausedError) || out.trim() === "") {
        setSt({
          ...current,
          stage: "params",
          aiOffer: true,
          error:
            err instanceof StreamPausedError
              ? "the model went idle — paused before producing any code (nothing lost). Retry."
              : `local AI generation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    if (stRef.current?.detail !== current.detail) return;
    if (out.trim() === "") {
      setSt({
        ...current,
        stage: "params",
        aiOffer: true,
        error: "the local model returned no code — retry or write the member manually",
      });
      return;
    }
    await presentPreview(current, normalizeWorkspaceEdit(aiMemberEdit(d.uri, d.line, out)), api);
  }

  /** Apply the ACCEPTED files only: fsRead → applyTextEdits → fsWrite, then refresh
   *  any open Monaco model in place. Excluded files are never touched. */
  async function apply(current: HostState): Promise<void> {
    const api = ide();
    if (!api || !current.preview) return;
    const accepted: WorkspaceFileEdit[] = selectedEdits(current.preview, current.included);
    setSt({ ...current, stage: "applying", error: null });
    const written: Array<{ uri: string; text: string }> = [];
    for (const f of accepted) {
      const read = await api.fsRead(f.uri).catch(() => undefined);
      let base = read?.ok && typeof read.text === "string" ? read.text : null;
      // the new-file template's target legitimately does not exist yet — apply
      // against empty text (fsWrite creates it); any OTHER failed read is an error.
      if (base === null && f.uri === current.createUri) base = "";
      if (base === null) {
        setSt({
          ...current,
          stage: "preview",
          error: `applied ${written.length}/${accepted.length} — read failed for ${uriToPath(f.uri)}${read && !read.ok && read.error ? `: ${read.error}` : ""}`,
        });
        await refreshOpenModels(written);
        return;
      }
      const next = applyTextEdits(base, f.edits);
      const w = await api.fsWrite(f.uri, next).catch(() => undefined);
      if (!w?.ok) {
        setSt({
          ...current,
          stage: "preview",
          error: `applied ${written.length}/${accepted.length} — write failed for ${uriToPath(f.uri)}${w?.error ? `: ${w.error}` : ""}`,
        });
        await refreshOpenModels(written);
        return;
      }
      written.push({ uri: f.uri, text: next });
    }
    await refreshOpenModels(written);
    setSt(null); // success — close
  }

  /** Swap the new disk text into any open Monaco model (full-range edit, cursor
   *  clamped by Monaco) and clear the tab's dirty dot — disk and buffer now agree. */
  async function refreshOpenModels(written: Array<{ uri: string; text: string }>): Promise<void> {
    if (written.length === 0) return;
    const monaco = await loadMonaco();
    if (!monaco) return;
    const markDirty = useTabsStore.getState().markDirty;
    for (const w of written) {
      const model = monaco.editor.getModel(monaco.Uri.parse(w.uri));
      if (!model || model.isDisposed() || model.getValue() === w.text) continue;
      model.pushEditOperations(
        null,
        [{ range: model.getFullModelRange(), text: w.text }],
        () => null,
      );
      markDirty(w.uri, false);
    }
  }

  if (!st) return null;
  return (
    <RefactorPreviewDialog
      title={`Refactor: ${TRANSFORM_TITLES[st.detail.transform] ?? st.detail.transform}`}
      stage={st.stage}
      transform={st.detail.transform}
      word={st.detail.word}
      preview={st.preview}
      included={st.included}
      error={st.error}
      usages={st.usages}
      aiOffer={st.aiOffer}
      onToggleFile={(uri) => {
        setSt((s) => (s ? { ...s, included: togglePreviewUri(s.included, uri) } : s));
      }}
      onSubmitParams={(params) => {
        const s = stRef.current;
        if (s) void invoke(s, params);
      }}
      onApply={() => {
        const s = stRef.current;
        if (s && s.stage === "preview") void apply(s);
      }}
      onCancel={() => setSt(null)}
      onAiFallback={() => {
        const s = stRef.current;
        if (s) void aiFallback(s);
      }}
    />
  );
}

export default RefactorHost;
