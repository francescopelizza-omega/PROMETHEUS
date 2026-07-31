/**
 * ide/state/generate-actions.ts — PURE state math for the editor Generate menu
 * (APP-028).
 *
 * Everything the Generate flow needs that is NOT React/IPC lives here so it is
 * node:test-able without a DOM: the gen-transform metadata (one entry per
 * refactor.py `gen-*` verb + the two core-template actions), attrs parsing, the
 * local-AI fallback plumbing (fence stripping, the WorkspaceEdit-shaped proposal —
 * the fallback NEVER writes; its result flows into the same APP-027 preview), and
 * the template edits (new-file / copyright-header as WorkspaceEdits at line
 * positions, applied by the preview's applier — never here).
 *
 * Renderer-SANDBOXED (C5): imports only the PURE `@prometheus/core/editor` subpath.
 */

import {
  type TemplateKind,
  type TemplateVars,
  copyrightHeader,
  fileTemplate,
  headerInsertLine,
} from "@prometheus/core/editor";

/** The Generate surface: refactor.py gen verbs + the two core-template actions. */
export type GenerateTransform =
  | "genInit"
  | "genRepr"
  | "genEq"
  | "genDataclass"
  | "genProperty"
  | "genOverride"
  | "genDelegate"
  | "genDocstring";

export type TemplateTransform = "newFileTemplate" | "copyrightHeader";

/** One Generate action: menu label + palette id + which params form it needs. */
export interface GenerateAction {
  transform: GenerateTransform | TemplateTransform;
  /** palette/registry command id (routes/editor.tsx dispatches by this). */
  commandId: string;
  label: string;
  /** gen verbs are Python-only (AST sidecar); templates work for any language. */
  pythonOnly: boolean;
}

export const GENERATE_ACTIONS: readonly GenerateAction[] = [
  {
    transform: "genInit",
    commandId: "generate.init",
    label: "Generate: __init__…",
    pythonOnly: true,
  },
  {
    transform: "genRepr",
    commandId: "generate.repr",
    label: "Generate: __repr__…",
    pythonOnly: true,
  },
  { transform: "genEq", commandId: "generate.eq", label: "Generate: __eq__…", pythonOnly: true },
  {
    transform: "genDataclass",
    commandId: "generate.dataclass",
    label: "Generate: Convert to @dataclass",
    pythonOnly: true,
  },
  {
    transform: "genProperty",
    commandId: "generate.property",
    label: "Generate: Property + Setter…",
    pythonOnly: true,
  },
  {
    transform: "genOverride",
    commandId: "generate.override",
    label: "Generate: Override Method…",
    pythonOnly: true,
  },
  {
    transform: "genDelegate",
    commandId: "generate.delegate",
    label: "Generate: Delegate Method…",
    pythonOnly: true,
  },
  {
    transform: "genDocstring",
    commandId: "generate.docstring",
    label: "Generate: Docstring Stub",
    pythonOnly: true,
  },
  {
    transform: "newFileTemplate",
    commandId: "generate.newFile",
    label: "Generate: New File from Template…",
    pythonOnly: false,
  },
  {
    transform: "copyrightHeader",
    commandId: "generate.copyright",
    label: "Generate: Insert Copyright Header…",
    pythonOnly: false,
  },
];

/** commandId → transform (routes/editor.tsx dispatch table). */
export const GENERATE_TRANSFORM_BY_ID: Readonly<Record<string, string>> = Object.fromEntries(
  GENERATE_ACTIONS.map((a) => [a.commandId, a.transform]),
);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse the optional attrs input: "" → undefined (derive from the class), a
 *  comma-separated identifier list → string[], anything else → null (invalid). */
export function parseAttrsList(raw: string): string[] | undefined | null {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const attrs = trimmed
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
  if (attrs.length === 0) return undefined;
  return attrs.every((a) => IDENT.test(a)) ? attrs : null;
}

/** Sidecar failure codes where "Generate with local AI" is a sensible next step
 *  (AST could not derive the member — e.g. dynamic attrs for __repr__). */
export function offersAiFallback(code: string | undefined): boolean {
  return code === "no-fields" || code === "not-found" || code === "unsupported";
}

/** Strip a single ```lang fenced block (models love wrapping code in fences). */
export function stripCodeFences(text: string): string {
  const t = text.trim();
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  return (m?.[1] ?? t).replace(/\s+$/, "");
}

/** A WorkspaceEdit-shaped edit (the preview's normalizeWorkspaceEdit input). */
interface WorkspaceEditShape {
  changes: Record<
    string,
    Array<{
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      newText: string;
    }>
  >;
}

function insertAt(uri: string, line0: number, newText: string): WorkspaceEditShape {
  const pos = { line: line0, character: 0 };
  return { changes: { [uri]: [{ range: { start: { ...pos }, end: { ...pos } }, newText }] } };
}

/**
 * The local-AI fallback PROPOSAL: insert the generated member below the caret's
 * 1-based line as a WorkspaceEdit. It lands in the APP-027 preview exactly like a
 * sidecar edit — reviewed, includable, cancellable; NEVER auto-applied.
 */
export function aiMemberEdit(uri: string, caretLine1: number, member: string): WorkspaceEditShape {
  const body = stripCodeFences(member);
  return insertAt(uri, Math.max(0, caretLine1), `${body}\n`);
}

/** The chat messages for the local-AI generator (kept pure for tests). */
export function aiGenMessages(
  label: string,
  languageId: string,
  context: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "You generate a single class member for insertion into existing source code. " +
        "Reply with ONLY the raw code for the member — no prose, no markdown fences, " +
        "indented to sit inside the class shown.",
    },
    {
      role: "user",
      content: `Task: ${label}\nLanguage: ${languageId}\n\nSource context:\n${context}`,
    },
  ];
}

/** Validate a workspace-relative new-file path → its file:// uri, or an error
 *  string (traversal/absolute/empty refused — the fs IPC path guard is the real
 *  wall; this keeps honest mistakes in the dialog). */
export function newFileTarget(workspaceRoot: string, filename: string): { uri: string } | string {
  const name = filename.trim();
  if (name === "") return "file name must not be empty";
  if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) {
    return "file name must be workspace-relative";
  }
  if (name.split(/[\\/]/).some((seg) => seg === "..")) {
    return "file name must not contain '..'";
  }
  const root = workspaceRoot.endsWith("/") ? workspaceRoot.slice(0, -1) : workspaceRoot;
  return { uri: `file://${root}/${name.replace(/\\/g, "/")}` };
}

/** New-file template as a WorkspaceEdit: the full content inserted at 0:0 of the
 *  (not-yet-existing) target uri. The applier treats the missing file as "". */
export function newFileEdit(
  uri: string,
  kind: TemplateKind,
  vars: TemplateVars,
): WorkspaceEditShape {
  return insertAt(uri, 0, fileTemplate(kind, vars));
}

/** True when the file already carries a copyright header near the top. */
export function hasCopyrightHeader(text: string): boolean {
  return text
    .split("\n")
    .slice(0, 10)
    .some((l) => /copyright\s*(\(c\)|©)/i.test(l));
}

/** Copyright header as a WorkspaceEdit at the comment-style-aware insert line
 *  (after shebang/coding cookie). null when a header is already present. */
export function copyrightEditFor(
  uri: string,
  text: string,
  style: TemplateKind,
  vars: TemplateVars,
): WorkspaceEditShape | null {
  if (hasCopyrightHeader(text)) return null;
  return insertAt(uri, headerInsertLine(text, style), copyrightHeader(style, vars));
}
