// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/EditorPane.tsx — the Monaco editor wrapper (file 07 §3.1).
 *
 * ONE Monaco editor instance per visible group; the ITextModel is SWAPPED on tab
 * switch (never one editor per tab — §3.1/§11 memory budget). Models are keyed by uri
 * and shared across split groups (Monaco shares the model). Preview tabs, the
 * large-file read-only guard (§3.1), multi-tab + split — all driven by the pure
 * tabs-reducer via useTabsStore. The fs read/write crosses the contextBridge
 * (window.prometheus.ide.fs*); the renderer never touches node:fs (C5).
 *
 * Monaco is loaded LAZILY (monaco-loader) so the build doesn't require it statically
 * and the initial bundle stays small (§12). Until it loads — or if it is unavailable
 * in this env — the pane shows a graceful read-only fallback (NEVER a crash, and we
 * NEVER claim an editing session ran that did not).
 *
 * Renderer-SANDBOXED (C5): react + monaco (lazy) + the pure stores + window.prometheus
 * only. NO node/electron/engine-bridge.
 */

// PURE core subpaths ONLY (like `@prometheus/core/rules` — the root barrel eagerly
// evaluates node:fs modules and would kill the sandboxed renderer, C5).
import { type SmartKeyResult, completeStatement, smartEnterEdit } from "@prometheus/core/editor";
import {
  type EditorConfigEntry,
  type ResolvedEditorConfig,
  applyEditorConfigTextRules,
  formatOnSaveEnabled,
  parseEditorConfig,
  resolveEditorConfig,
} from "@prometheus/core/format";
import { receiverExpression, toMonacoSnippet } from "@prometheus/core/templates";
import {
  DEFAULT_SCHEME_ID,
  Z,
  clampToViewport,
  monacoThemeFromSemantic,
  pellyMonacoTheme,
} from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { useTheme } from "../shell/ThemeProvider.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { FileStructurePopup } from "./FileStructurePopup.js";
import {
  RefactorHost,
  type RefactorOpenDetail,
  type RefactorTransform,
} from "./RefactorPreview.js";
import { InlineEdit } from "./ai/InlineEdit.js";
import { type RendererEndpoint, streamChat } from "./ai/ai-client.js";
import { useActiveEndpoint } from "./ai/endpoint-hook.js";
import { FimCache } from "./ai/fim-cache.js";
import { Markdown } from "./ai/markdown.js";
import { familyHasLigatures, resolveFontStack } from "./fonts/registry.js";
import { type FontConfig, useFontStore } from "./fonts/store.js";
import { loadMonaco } from "./monaco-loader.js";
import { NotebookContainer } from "./notebook/NotebookContainer.js";
import { blameByLine, buildInlineBlameDecoration } from "./state/blame-inline.js";
import { useBookmarksStore, wireBookmarkGutter } from "./state/bookmarks.js";
import {
  type Breakpoint,
  isLogpoint,
  useBreakpointStore,
  wireBreakpointGutter,
} from "./state/breakpoint-store.js";
import { useClipboardStore } from "./state/clipboard-store.js";
import { classifyCodeAction } from "./state/code-action-classify.js";
import { coverageEntryForPath, useCoverageStore } from "./state/coverage-store.js";
import type { Diagnostic } from "./state/diagnostics.js";
import { countDiagnostics } from "./state/diagnostics.js";
import { onVisionChange, useEditorVisionStore } from "./state/editor-vision-store.js";
import {
  type FoldRange,
  type LspFoldingRange,
  capSymbols,
  indentFoldingRanges,
  lspFoldingToRanges,
  refsLensTitle,
} from "./state/editor-vision.js";
import { useFormatStore } from "./state/format-store.js";
import { GENERATE_ACTIONS } from "./state/generate-actions.js";
import {
  GUTTER_GLYPH_MARGIN,
  gutterEventFromMouse,
  gutterRegistry,
} from "./state/gutter-decorations.js";
import { useInlineBlameStore } from "./state/inline-blame-store.js";
import { buildInlineValueDecorations } from "./state/inline-values.js";
import { detectLanguage, hasKnownLsp } from "./state/lang-detect.js";
import {
  type LspRange,
  type NormalizedSymbol,
  docToMarkdown,
  isSnippet,
  monacoCompletionKind,
  monacoSymbolKind,
  normalizeLocations,
  normalizeSymbols,
  normalizeTextEdits,
  toLspPosition,
  toLspRange,
} from "./state/lsp-convert.js";
import { type NavTarget, aggregateRelated, itemsToNavTargets } from "./state/nav-goto.js";
import { useNavStore } from "./state/nav-history.js";
import {
  type QuickDoc,
  buildDocstringStub,
  docCommentRanges,
  enclosingFunction,
  hoverToDoc,
  lspContentsToMarkdown,
  parseParamNames,
} from "./state/quick-doc.js";
import { matchFile } from "./state/search-preview.js";
import {
  useAiSessionStore,
  useDiagnosticsStore,
  useDirtyRecoveryStore,
  useTabsStore,
} from "./state/stores.js";
import { activeDoc, tabsOf } from "./state/tabs-reducer.js";
import { useTemplateStore } from "./state/template-store.js";
import { applyTextEdits, normalizeWorkspaceEdit } from "./state/text-edit-apply.js";
import { useUsagesStore } from "./state/usages-store.js";
import { type Usage, canonicalUri, mergeUsages, usagesFromLocations } from "./state/usages.js";
import { wireTestRunGutter } from "./test/test-run-store.js";

// type-only monaco namespace (erased at build; no runtime types dep).
type Monaco = typeof import("monaco-editor");
type IStandaloneCodeEditor = import("monaco-editor").editor.IStandaloneCodeEditor;
type ITextModel = import("monaco-editor").editor.ITextModel;
type MonacoSymbolKind = import("monaco-editor").languages.SymbolKind;
type MonacoCompletionKind = import("monaco-editor").languages.CompletionItemKind;
type MonacoDocumentSymbol = import("monaco-editor").languages.DocumentSymbol;
type MonacoInlayHint = import("monaco-editor").languages.InlayHint;
type MonacoInlayHintKind = import("monaco-editor").languages.InlayHintKind;
type MonacoCodeAction = import("monaco-editor").languages.CodeAction;
type MonacoWorkspaceEdit = import("monaco-editor").languages.WorkspaceEdit;

/** APP-078: the Monaco command id a command-only code action runs (→ workspace/executeCommand). */
const LSP_EXEC_COMMAND_ID = "prometheus.lsp.executeCommand";
type IMarkerData = import("monaco-editor").editor.IMarkerData;
type IRange = import("monaco-editor").IRange;

/** An LSP `textDocument/codeAction` response item (fields we consume). */
interface LspCodeAction {
  title?: unknown;
  kind?: unknown;
  isPreferred?: unknown;
  edit?: unknown;
  // a CodeAction.command is an LSP `Command` {title, command, arguments} (APP-078).
  command?: { title?: unknown; command?: string; arguments?: unknown[] };
}

/** An LSP `textDocument/references` location (APP-074 code-vision). */
interface LspLocation {
  uri: string;
  range: LspRange;
}

/** Monaco's `CodeLensProvider.onDidChange` type (IEvent<this>) — for the recompute-signal cast. */
type MonacoCodeLensOnDidChange = import("monaco-editor").languages.CodeLensProvider["onDidChange"];

/** An LSP `textDocument/inlayHint` response item (the fields we map to Monaco). */
interface LspInlayHint {
  position: { line: number; character: number };
  label: string | Array<{ value?: unknown }>;
  kind?: number;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

/**
 * Monaco font options for an editor font config (Settings → Fonts). Monaco's canvas
 * renderer can NOT resolve a CSS var(), so we pass the resolved literal family stack
 * from the registry. `lineHeight` in (0,8) is a Monaco multiplier of the font size.
 * Ligatures only enable when the chosen family actually supports them.
 */
function monacoFontOptions(cfg: FontConfig): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontLigatures: boolean;
} {
  return {
    fontFamily: resolveFontStack(cfg.familyId),
    fontSize: cfg.size,
    lineHeight: cfg.lineHeight,
    fontLigatures: cfg.ligatures && familyHasLigatures(cfg.familyId),
  };
}
/** The generated Monaco theme name we (re)define from the active design tokens. */
/** The ONE Monaco theme name every editor surface selects (the main editor, the git
 *  diff view). Exported so a second surface can never drift back to a stock theme. */
export const EDITOR_THEME = "prometheus";

/** Map the resolved app base → Monaco's theme base. */
function monacoBase(resolvedBase: string): "vs" | "vs-dark" | "hc-black" {
  if (resolvedBase === "light") return "vs";
  if (resolvedBase === "high-contrast") return "hc-black";
  return "vs-dark";
}

/** ide api accessor (typed via the contract; undefined-safe in non-electron tests). */
function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Monaco's URI form for a file:// path (canonical model key). */
function modelUri(monaco: Monaco, uri: string): import("monaco-editor").Uri {
  return monaco.Uri.parse(uri);
}

/** Ensure a shared ITextModel exists for `uri` (created once, reused across groups). */
function ensureModel(monaco: Monaco, uri: string, text: string, languageId: string): ITextModel {
  const mUri = modelUri(monaco, uri);
  const existing = monaco.editor.getModel(mUri);
  if (existing) return existing;
  return monaco.editor.createModel(text, languageId, mUri);
}

/** LSP textDocument sync state: uri → its server + version. MODULE-level so the
 *  once-registered Monaco hover/completion providers below can resolve the serverId for
 *  a model (a per-component ref couldn't be reached from a global provider). */
const lspDocs = new Map<string, { serverId: string; version: number }>();

/** The Monaco editor that last had focus — the Cmd-I inline-edit overlay (#11) targets
 *  it (so a split layout edits the pane the user was actually in). MODULE-level so the
 *  EditorPane-level InlineEditHost can reach it without threading a ref through groups. */
let activeEditor: IStandaloneCodeEditor | null = null;

/** Ghost-text (#4) config — module-level so the once-registered inline-completions
 *  provider reads the live endpoint + opt-in flag without re-registering. OFF by default. */
let ghostConfig: {
  endpoint: RendererEndpoint | null;
  neverSendToCloud: boolean;
  enabled: boolean;
} = { endpoint: null, neverSendToCloud: false, enabled: false };

/** APP-092: a prefix/suffix-keyed LRU of ghost-text completions — re-typing over an
 *  identical boundary replays the cached completion instead of a second backend call. It
 *  is DROPPED whole when the active file changes (a cross-file boundary collision would
 *  replay a wrong completion). Module-level to match the once-registered provider. */
const ghostCache = new FimCache(50);
let ghostCacheUri: string | null = null;

/** The last path segment (file base name), for the `$FILE_NAME$` macro. */
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

let templatesHydrated = false;
/** Load the persisted user templates ONCE at editor startup (APP-020) so completions see
 *  them even if the Settings ▸ Live Templates page was never opened. Idempotent + fail-soft
 *  (degrades to seeds-only when the settings IPC is absent). The Settings page re-hydrates
 *  on mount, and every edit write-through updates the same store, so the two never drift. */
function hydrateTemplatesOnce(): void {
  if (templatesHydrated) return;
  templatesHydrated = true;
  void useTemplateStore.getState().hydrate(useTabsStore.getState().workspaceRoot ?? undefined);
}

let templateCompletionsRegistered = false;
/** Register the live-template + postfix snippet completions ONCE (plan 08 / APP-020). For
 *  each LSP language:
 *   - LIVE templates — the MERGED (seed ◀ user) registry offered as Snippet completions on
 *     the current word; Monaco expands the `$1`/`${2:default}`/`$0` tabstops on accept.
 *   - POSTFIX templates — offered on the `.` trigger; each item's snippet carries the
 *     receiver (`$EXPR$`) and an `additionalTextEdits` DELETES the `receiver.` prefix, so
 *     `x.log` rewrites to `console.log(x)` (a plain insertText can only add, not delete
 *     already-typed text).
 *  Both read the LIVE template store at completion time (so a user's persisted/edited
 *  templates appear WITHOUT re-registering — the store is a module singleton) and run the
 *  `$NAME$` macro pass (toMonacoSnippet) before handing the body to Monaco. Contributes
 *  ALONGSIDE the LSP-bridged completions (Monaco merges providers). */
function registerTemplateCompletions(monaco: Monaco): void {
  if (templateCompletionsRegistered) return;
  templateCompletionsRegistered = true;

  /** Build the macro context for a model (fileName/clipboard/clock). The clock is a real
   *  `new Date()` here (renderer, not the pure core) — `$DATE$` resolves deterministically
   *  to ISO YYYY-MM-DD inside the pure engine. `$CLIPBOARD$` reads the renderer clipboard
   *  STORE's top entry only (never navigator.clipboard, never a shell). */
  const macroCtx = (model: ITextModel): { fileName: string; clipboard?: string; now: Date } => ({
    fileName: basename(model.uri.path),
    clipboard: useClipboardStore.getState().entries[0],
    now: new Date(),
  });

  for (const lang of LSP_LANGS) {
    // --- live abbreviations ---------------------------------------------------
    monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems: (model, position) => {
        const templates = useTemplateStore.getState().mergedFor("live", lang);
        if (templates.length === 0) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const ctx = macroCtx(model);
        return {
          suggestions: templates.map((t) => ({
            label: t.abbrev,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: toMonacoSnippet(t.body, ctx),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: t.description,
            detail: `template · ${t.description}`,
            range,
          })),
        };
      },
    });

    // --- postfix templates (trigger on `.`) -----------------------------------
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ["."],
      provideCompletionItems: (model, position) => {
        const templates = useTemplateStore.getState().mergedFor("postfix", lang);
        if (templates.length === 0) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        if (word.startColumn < 2) return { suggestions: [] };
        const line = model.getLineContent(position.lineNumber);
        // the `.` is the char immediately LEFT of the abbrev word (1-based col wordStart-1).
        if (line[word.startColumn - 2] !== ".") return { suggestions: [] };
        const receiver = receiverExpression(line.slice(0, word.startColumn - 2));
        if (!receiver) return { suggestions: [] };
        const receiverStartColumn = word.startColumn - 1 - receiver.length;
        const ctx = { ...macroCtx(model), receiver };
        const wordRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        // delete `receiver.` — the receiver run up to AND including the dot char.
        const deleteReceiver = {
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: receiverStartColumn,
            endColumn: word.startColumn, // covers [receiver … dot)
          },
          text: "",
        };
        return {
          suggestions: templates.map((t) => ({
            label: `.${t.abbrev}`,
            filterText: t.abbrev,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: toMonacoSnippet(t.body, ctx),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: `${t.description} — postfix on \`${receiver}\``,
            detail: `postfix · ${t.description}`,
            range: wordRange,
            additionalTextEdits: [deleteReceiver],
          })),
        };
      },
    });
  }
}

/** Surround the focused editor's active selection with a `surround` template (APP-020).
 *  Uses Monaco's `SnippetController2` so `$SELECTION$`→`${TM_SELECTED_TEXT}` wraps the
 *  selection and `$END$`→`$0` places the final caret. `abbrev` picks a specific template
 *  (from the palette picker); absent, the first surround template for the language is used.
 *  No-op with a notice when there is no selection or no surround template for the language. */
function surroundSelection(
  monaco: Monaco,
  editor: IStandaloneCodeEditor,
  flash: (m: string) => void,
  abbrev?: string,
): void {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel || sel.isEmpty()) {
    flash("Surround with: select some text first");
    return;
  }
  const lang = model.getLanguageId();
  const templates = useTemplateStore.getState().mergedFor("surround", lang);
  if (templates.length === 0) {
    flash(`Surround with: no templates for ${lang}`);
    return;
  }
  const t = (abbrev ? templates.find((x) => x.abbrev === abbrev) : undefined) ?? templates[0];
  if (!t) return;
  const controller = editor.getContribution("snippetController2") as unknown as {
    insert(template: string): void;
  } | null;
  if (!controller || typeof controller.insert !== "function") {
    flash("Surround with: snippet controller unavailable");
    return;
  }
  editor.focus();
  // toMonacoSnippet maps $SELECTION$→${TM_SELECTED_TEXT} + $END$→$0; SnippetController2
  // resolves ${TM_SELECTED_TEXT} from the CURRENT selection and replaces it.
  controller.insert(toMonacoSnippet(t.body));
}

/** Cap the grep-fallback candidate files + total rows so a huge tree never floods. */
const MAX_USAGE_FILES = 200;
const MAX_USAGE_ROWS = 1000;

/**
 * Find Usages (JetBrains Alt+F7 · APP-023). Takes the symbol under the caret and fans in
 * LSP `textDocument/references` (includeDeclaration, 0-based char START of the word) FIRST;
 * only when there is NO language server does it fall back to a whole-word grep (an empty
 * answer from a working server means the symbol is genuinely unused — grep would mislabel
 * the definition text a usage). Merges + dedupes via the pure `usages` module, attaches
 * excerpts, and drives the tool window through `useUsagesStore` + an `ide:open-usages` event.
 * All the transforms are pure (state/usages.ts); only the IPC lives here (C5).
 */
async function runFindUsages(
  editor: IStandaloneCodeEditor,
  flash: (m: string) => void,
): Promise<void> {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return;
  const word = model.getWordAtPosition(position);
  if (!word) {
    flash("Find Usages: no symbol under the caret");
    return;
  }
  const identifier = word.word;
  const uri = model.uri.toString();
  const root = useTabsStore.getState().workspaceRoot;
  useUsagesStore.getState().begin(identifier, uri);
  window.dispatchEvent(new CustomEvent("ide:open-usages"));

  const api = ide();
  // ── LSP references first (the file under the caret is open ⇒ didOpen already sent) ──
  let lspUsages: Usage[] = [];
  let serverAnswered = false;
  const doc = lspDocs.get(uri);
  if (api && doc && root) {
    const res = await api
      .lspRequest(doc.serverId, root, "textDocument/references", {
        textDocument: { uri },
        // 0-based line + the word's START column (not the mid-word click), so the server
        // resolves the symbol reliably.
        position: { line: position.lineNumber - 1, character: word.startColumn - 1 },
        context: { includeDeclaration: true },
      })
      .catch(() => undefined);
    if (res?.ok && Array.isArray(res.result)) {
      serverAnswered = true;
      lspUsages = usagesFromLocations(normalizeLocations(res.result));
    }
  }

  // ── grep fallback ONLY when no server answered (kept scrupulously honest, `grep` tag) ──
  const grepUsages: Usage[] = [];
  if (!serverAnswered && api && root) {
    const gr = await api
      .search({
        root,
        query: identifier,
        mode: "content",
        caseSensitive: true,
        maxResults: MAX_USAGE_FILES,
      })
      .catch(() => undefined);
    const paths = gr?.ok ? [...new Set(gr.matches.map((m) => m.path))] : [];
    for (const p of paths.slice(0, MAX_USAGE_FILES)) {
      if (grepUsages.length >= MAX_USAGE_ROWS) break;
      const fileUri = p.startsWith("file://") ? p : `file://${p}`;
      const read = await api.fsRead(fileUri).catch(() => undefined);
      if (!read?.ok || typeof read.text !== "string" || read.large) continue;
      // matchFile with wholeWord+matchCase = a real whole-word identifier match (so `foo`
      // never matches `foobar`) with exact columns + the line for the excerpt.
      const fm = matchFile(
        fileUri,
        read.text,
        { pattern: identifier, wholeWord: true, matchCase: true },
        "",
      );
      if (!fm) continue;
      for (const m of fm.matches) {
        if (grepUsages.length >= MAX_USAGE_ROWS) break;
        grepUsages.push({
          uri: canonicalUri(fileUri),
          line: m.line + 1,
          column: m.start + 1,
          source: "grep",
          excerpt: fm.lines[m.line] ?? "",
        });
      }
    }
  }

  // LSP passed FIRST so its authoritative tag wins any cross-source tie.
  const merged = mergeUsages(lspUsages, grepUsages);

  // ── attach excerpts to rows that lack one (LSP rows) — one fs read per unique file ──
  if (api) {
    const needByUri = new Map<string, Usage[]>();
    for (const u of merged) {
      if (u.excerpt === undefined) {
        const arr = needByUri.get(u.uri);
        if (arr) arr.push(u);
        else needByUri.set(u.uri, [u]);
      }
    }
    for (const [fileUri, rows] of needByUri) {
      const read = await api.fsRead(fileUri).catch(() => undefined);
      if (!read?.ok || typeof read.text !== "string") continue;
      const lines = read.text.split("\n");
      for (const r of rows) r.excerpt = lines[r.line - 1] ?? "";
    }
  }

  useUsagesStore.getState().setResults(identifier, uri, merged);
}

/* ── Go-to-super / Related-symbol (APP-075) ─────────────────────────────────── */

/** Resolve the caret's LSP context (serverId + root + 0-based position), or null. */
function caretLspCtx(editor: IStandaloneCodeEditor): {
  serverId: string;
  root: string;
  uri: string;
  position: { line: number; character: number };
} | null {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return null;
  const uri = model.uri.toString();
  const doc = lspDocs.get(uri);
  const root = useTabsStore.getState().workspaceRoot;
  if (!doc || !root) return null;
  return {
    serverId: doc.serverId,
    root,
    uri,
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  };
}

/** Navigate to targets: 0 → passive flash, 1 → jump, >1 → the Find-Usages tool window picker. */
function navigateTargets(
  targets: NavTarget[],
  label: string,
  originUri: string,
  flash: (m: string) => void,
): void {
  if (targets.length === 0) {
    flash(`${label}: none found`);
    return;
  }
  if (targets.length === 1) {
    const t = targets[0]!;
    // NavTarget.line is 0-based (LSP); navigateTo/reveal want 1-based.
    window.dispatchEvent(
      new CustomEvent("ide:navigate-location", {
        detail: { uri: t.uri, line: t.line + 1, column: t.column },
      }),
    );
    return;
  }
  useUsagesStore.getState().begin(label, originUri);
  useUsagesStore.getState().setResults(
    label,
    originUri,
    targets.map((t) => ({
      uri: t.uri,
      line: t.line + 1,
      column: t.column,
      source: "lsp" as const,
    })),
  );
  window.dispatchEvent(new CustomEvent("ide:open-usages"));
}

/** typeHierarchy supertypes at the caret (the base TYPE declaration(s)). */
async function fetchSupertypes(
  ctx: NonNullable<ReturnType<typeof caretLspCtx>>,
): Promise<unknown[]> {
  const api = ide();
  if (!api) return [];
  const prep = await api
    .lspRequest(ctx.serverId, ctx.root, "textDocument/prepareTypeHierarchy", {
      textDocument: { uri: ctx.uri },
      position: ctx.position,
    })
    .catch(() => undefined);
  const items = prep?.ok && Array.isArray(prep.result) ? prep.result : [];
  if (items.length === 0) return [];
  const sup = await api
    .lspRequest(ctx.serverId, ctx.root, "typeHierarchy/supertypes", { item: items[0] })
    .catch(() => undefined);
  return sup?.ok && Array.isArray(sup.result) ? sup.result : [];
}

/** Go to Super — jump to the base type declaration (a picker when multi-parent). */
async function runGoToSuper(
  editor: IStandaloneCodeEditor,
  flash: (m: string) => void,
): Promise<void> {
  const ctx = caretLspCtx(editor);
  if (!ctx) {
    flash("Go to Super: no language server / caret");
    return;
  }
  const supers = await fetchSupertypes(ctx);
  navigateTargets(itemsToNavTargets(supers, "super"), "Go to Super", ctx.uri, flash);
}

/** Related Symbol — implementation ∪ typeDefinition ∪ supertypes at the caret (deduped picker). */
async function runRelatedSymbol(
  editor: IStandaloneCodeEditor,
  flash: (m: string) => void,
): Promise<void> {
  const ctx = caretLspCtx(editor);
  if (!ctx) {
    flash("Related Symbol: no language server / caret");
    return;
  }
  const api = ide();
  const req = (method: string): Promise<unknown> =>
    api
      ? api
          .lspRequest(ctx.serverId, ctx.root, method, {
            textDocument: { uri: ctx.uri },
            position: ctx.position,
          })
          .then((r) => (r?.ok ? r.result : null))
          .catch(() => null)
      : Promise.resolve(null);
  // allSettled so one slow/failed provider never drops the others (each has a main-side timeout).
  const [impl, typeDef, supers] = await Promise.all([
    req("textDocument/implementation"),
    req("textDocument/typeDefinition"),
    fetchSupertypes(ctx),
  ]);
  const targets = aggregateRelated([
    { kind: "impl", items: impl },
    { kind: "type", items: typeDef },
    { kind: "super", items: supers },
  ]);
  navigateTargets(targets, "Related Symbol", ctx.uri, flash);
}

/* ── Refactor menu (APP-027) ────────────────────────────────────────────────── */

/** The six APP-026 transforms surfaced as editor actions (context menu + palette). */
const REFACTOR_ACTIONS: ReadonlyArray<{
  transform: RefactorTransform;
  label: string;
  order: number;
}> = [
  { transform: "rename", label: "Refactor: Rename Symbol…", order: 1 },
  { transform: "extract", label: "Refactor: Extract Method/Variable…", order: 2 },
  { transform: "inline", label: "Refactor: Inline Symbol", order: 3 },
  { transform: "move", label: "Refactor: Move to Module…", order: 4 },
  { transform: "changeSignature", label: "Refactor: Change Signature…", order: 5 },
  { transform: "safeDelete", label: "Refactor: Safe Delete", order: 6 },
];

/* ── Generate menu (APP-028) — labels/ids from the pure, tested action table ── */

/** Capture the editor's caret/selection context for a refactor transform and open the
 *  gated preview (RefactorHost listens on `ide:refactor-open`). The column sent is the
 *  START of the word under the caret — the reliable symbol anchor (mirrors
 *  runFindUsages). Guards (non-file uri, non-python, no symbol) render INLINE in the
 *  dialog rather than silently no-oping here. */
function openRefactorPreview(editor: IStandaloneCodeEditor, transform: RefactorTransform): void {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return;
  const sel = editor.getSelection();
  const wordInfo = model.getWordAtPosition(pos);
  const hasSelection = !!sel && !sel.isEmpty();
  const detail: RefactorOpenDetail = {
    transform,
    uri: model.uri.toString(),
    languageId: model.getLanguageId(),
    line: pos.lineNumber,
    col: wordInfo ? wordInfo.startColumn : pos.column,
    startLine: hasSelection && sel ? sel.startLineNumber : pos.lineNumber,
    endLine: hasSelection && sel ? sel.endLineNumber : pos.lineNumber,
    hasSelection,
    word: wordInfo?.word ?? "",
  };
  window.dispatchEvent(new CustomEvent("ide:refactor-open", { detail }));
}

let inlineCompletionsRegistered = false;
/** Register the AI ghost-text inline-completions provider ONCE (opt-in via ghostConfig).
 *  Debounced + cancellable; builds a prefix/suffix prompt and caps the suggestion short.
 *  No-ops entirely when disabled or no endpoint — zero model traffic by default. */
/** The Monaco inline-completion `{items}` shape for `insert` at the cursor (shared by the
 *  cache-hit fast path and the streamed path so the range is built identically). */
function ghostItems(insert: string, position: { lineNumber: number; column: number }) {
  return {
    items: [
      {
        insertText: insert,
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
      },
    ],
  };
}

/**
 * APP-092: the active editor's current selection (or the caret line when the selection is
 * empty) as `{uri, startLine, endLine, selectedText}` — the AgentPane's Cmd-L "attach
 * selection" reads this to build a `file:line` context chip. Returns null when no editor is
 * focused. Reads the module-level `activeEditor` (no ref threading).
 */
export function getActiveEditorSelection(): {
  uri: string;
  startLine: number;
  endLine: number;
  selectedText: string;
} | null {
  const editor = activeEditor;
  if (!editor) return null;
  const model = editor.getModel();
  if (!model) return null;
  const sel = editor.getSelection();
  if (!sel) return null;
  const empty = sel.isEmpty();
  const range = empty
    ? {
        startLineNumber: sel.startLineNumber,
        startColumn: 1,
        endLineNumber: sel.startLineNumber,
        endColumn: model.getLineMaxColumn(sel.startLineNumber),
      }
    : {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      };
  return {
    uri: model.uri.toString(),
    startLine: range.startLineNumber,
    endLine: range.endLineNumber,
    selectedText: model.getValueInRange(range),
  };
}

function registerInlineCompletions(monaco: Monaco): void {
  if (inlineCompletionsRegistered) return;
  inlineCompletionsRegistered = true;
  for (const lang of LSP_LANGS) {
    monaco.languages.registerInlineCompletionsProvider(lang, {
      provideInlineCompletions: async (model, position, _ctx, token) => {
        const cfg = ghostConfig;
        if (!cfg.enabled || !cfg.endpoint) return { items: [] };
        const offset = model.getOffsetAt(position);
        const full = model.getValue();
        const prefix = full.slice(Math.max(0, offset - 2000), offset);
        const suffix = full.slice(offset, offset + 500);
        if (!prefix.trim()) return { items: [] };
        // APP-092: drop the cache when the active file changes — a boundary collision across
        // files would otherwise replay a completion from the wrong file.
        const uri = model.uri.toString();
        if (uri !== ghostCacheUri) {
          ghostCache.clear();
          ghostCacheUri = uri;
        }
        // cache HIT: replay the identical-boundary completion with NO second backend call
        // (and no debounce) — the acceptance-criteria fast path.
        const cached = ghostCache.get(prefix, suffix);
        if (cached) return ghostItems(cached, position);
        // debounce: Monaco re-requests on every keystroke + cancels the prior token.
        await new Promise((r) => setTimeout(r, 400));
        if (token.isCancellationRequested) return { items: [] };
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        let acc = "";
        try {
          for await (const delta of streamChat(
            cfg.endpoint,
            [
              {
                role: "system",
                content:
                  "You are a code autocomplete engine. Continue the code at the cursor " +
                  "(marked ⟦CURSOR⟧). Output ONLY the raw text to insert — no explanation, " +
                  "no markdown fences.",
              },
              { role: "user", content: `${prefix}⟦CURSOR⟧${suffix}` },
            ],
            { neverSendToCloud: cfg.neverSendToCloud, signal: ac.signal },
          )) {
            if (token.isCancellationRequested) break;
            acc += delta;
            // keep ghost-text short: stop after ~3 lines or 160 chars.
            if (acc.length > 160 || acc.split("\n").length > 3) {
              ac.abort();
              break;
            }
          }
        } catch {
          return { items: [] };
        }
        const insert = acc
          .replace(/```[\w]*\n?/g, "")
          .replace(/```$/g, "")
          .trimEnd();
        if (!insert || token.isCancellationRequested) return { items: [] };
        // APP-092: cache the completion keyed on this boundary so a re-type replays it.
        ghostCache.set(prefix, suffix, insert);
        return ghostItems(insert, position);
      },
      freeInlineCompletions: () => {},
    });
  }
}

/** Languages we register LSP providers for (mirror lang-detect's known set). */
const LSP_LANGS = [
  "python",
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "json",
  "rust",
  "go",
  "cpp",
  "c",
];

// APP-098: the hover flattener now lives in state/quick-doc.ts (one flattener, reused by the
// Monaco hover provider AND the ⌘J Quick Doc host) — imported as `lspContentsToMarkdown`.

/** Register Monaco LSP providers ONCE per process (hover + completion), bridging to the
 *  MAIN-process language server over ide().lspRequest. */
let lspProvidersRegistered = false;
function registerLspProviders(monaco: Monaco): void {
  if (lspProvidersRegistered) return;
  lspProvidersRegistered = true;
  const ws = (): string | null => useTabsStore.getState().workspaceRoot;
  const mRange = (r: LspRange) =>
    new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  // resolve the server+root for a model, or null when it isn't LSP-tracked / no workspace.
  const reqCtx = (model: ITextModel): { serverId: string; root: string } | null => {
    const doc = lspDocs.get(model.uri.toString());
    const root = ws();
    return doc && root ? { serverId: doc.serverId, root } : null;
  };
  // one helper for every textDocument/* request (returns the raw `result`, or null).
  const lspReq = async (
    model: ITextModel,
    method: string,
    extra: Record<string, unknown>,
  ): Promise<unknown> => {
    const c = reqCtx(model);
    if (!c) return null;
    const res = await ide()?.lspRequest(c.serverId, c.root, method, {
      textDocument: { uri: model.uri.toString() },
      ...extra,
    });
    return res?.ok ? res.result : null;
  };
  const CIK = monaco.languages.CompletionItemKind as unknown as Record<string, number>;
  const SK = monaco.languages.SymbolKind as unknown as Record<string, number>;

  // APP-078: the command a COMMAND-ONLY code action runs → relay `workspace/executeCommand` to
  // the server (which then sends a `workspace/applyEdit` request back, handled by the applyEdit
  // relay). Registered ONCE; the arg carries the model uri + the LSP command + arguments.
  (
    monaco.editor as unknown as {
      registerCommand(id: string, fn: (a: unknown, p: unknown) => void): void;
    }
  ).registerCommand(LSP_EXEC_COMMAND_ID, (_accessor, payload) => {
    const p = payload as { uri?: string; command?: string; args?: unknown[] };
    if (!p?.uri || !p.command) return;
    const model = monaco.editor.getModel(monaco.Uri.parse(p.uri));
    if (!model) return;
    void lspReq(model, "workspace/executeCommand", { command: p.command, arguments: p.args ?? [] });
  });

  for (const lang of LSP_LANGS) {
    // hover ---------------------------------------------------------------------
    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position) => {
        const hover = (await lspReq(model, "textDocument/hover", {
          position: toLspPosition(position),
        })) as { contents?: unknown } | null;
        if (!hover?.contents) return null;
        const md = lspContentsToMarkdown(hover.contents);
        return md.length ? { contents: md.map((value) => ({ value })) } : null;
      },
    });

    // completion — now honors the server's kind / snippets / docs / sortText, and
    // declares a default trigger-char set (the forced kind=Text + no-snippet was lossy).
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: [".", ":", "(", '"', "'", "/", "@", "<", " "],
      provideCompletionItems: async (model, position) => {
        const result = (await lspReq(model, "textDocument/completion", {
          position: toLspPosition(position),
        })) as { items?: unknown[] } | unknown[] | null;
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const word = model.getWordUntilPosition(position);
        const wordRange = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        return {
          suggestions: (items as Array<Record<string, unknown>>).map((it) => {
            const te = it.textEdit as { range?: LspRange } | undefined;
            const range = te?.range ? mRange(te.range) : wordRange;
            const doc = docToMarkdown(it.documentation);
            return {
              label: String(it.label ?? ""),
              kind: monacoCompletionKind(CIK, it.kind) as MonacoCompletionKind,
              insertText: String(it.insertText ?? it.label ?? ""),
              ...(isSnippet(it.insertTextFormat)
                ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
                : {}),
              detail: typeof it.detail === "string" ? it.detail : undefined,
              documentation: doc ? { value: doc } : undefined,
              sortText: typeof it.sortText === "string" ? it.sortText : undefined,
              filterText: typeof it.filterText === "string" ? it.filterText : undefined,
              range,
            };
          }),
        };
      },
    });

    // go-to-definition ----------------------------------------------------------
    monaco.languages.registerDefinitionProvider(lang, {
      provideDefinition: async (model, position) => {
        const r = await lspReq(model, "textDocument/definition", {
          position: toLspPosition(position),
        });
        return normalizeLocations(r).map((l) => ({
          uri: monaco.Uri.parse(l.uri),
          range: mRange(l.range),
        }));
      },
    });

    // find-all-references -------------------------------------------------------
    monaco.languages.registerReferenceProvider(lang, {
      provideReferences: async (model, position, context) => {
        const r = await lspReq(model, "textDocument/references", {
          position: toLspPosition(position),
          context: { includeDeclaration: context.includeDeclaration },
        });
        return normalizeLocations(r).map((l) => ({
          uri: monaco.Uri.parse(l.uri),
          range: mRange(l.range),
        }));
      },
    });

    // go-to-implementation (⌃F12 / right-click · JetBrains ⌃⌥B) ------------------
    // Registering the provider lights up Monaco's built-in "Go to Implementations"
    // gesture + context-menu entry. Same transport/shape as go-to-definition.
    monaco.languages.registerImplementationProvider(lang, {
      provideImplementation: async (model, position) => {
        const r = await lspReq(model, "textDocument/implementation", {
          position: toLspPosition(position),
        });
        return normalizeLocations(r).map((l) => ({
          uri: monaco.Uri.parse(l.uri),
          range: mRange(l.range),
        }));
      },
    });

    // go-to-type-definition (⌘-click type · JetBrains ⌃⇧B) ----------------------
    monaco.languages.registerTypeDefinitionProvider(lang, {
      provideTypeDefinition: async (model, position) => {
        const r = await lspReq(model, "textDocument/typeDefinition", {
          position: toLspPosition(position),
        });
        return normalizeLocations(r).map((l) => ({
          uri: monaco.Uri.parse(l.uri),
          range: mRange(l.range),
        }));
      },
    });

    // inlay hints (inferred parameter names + types · PyCharm/Fleet parity) ------
    // `textDocument/inlayHint` returns per-visible-range hints; Monaco renders them
    // inline. LSP InlayHintKind (1=Type, 2=Parameter) matches Monaco's enum values.
    monaco.languages.registerInlayHintsProvider(lang, {
      provideInlayHints: async (model, range) => {
        // APP-074: honor the inlay-hints toggle (returns no hints when off; no dup provider).
        if (!useEditorVisionStore.getState().inlayHints) return { hints: [], dispose: () => {} };
        const r = await lspReq(model, "textDocument/inlayHint", {
          range: toLspRange({
            startLineNumber: range.startLineNumber,
            startColumn: range.startColumn,
            endLineNumber: range.endLineNumber,
            endColumn: range.endColumn,
          }),
        });
        const raw = Array.isArray(r) ? (r as LspInlayHint[]) : [];
        const hints = raw
          .filter((h) => h?.position && typeof h.position.line === "number")
          .map((h) => {
            const label =
              typeof h.label === "string"
                ? h.label
                : Array.isArray(h.label)
                  ? h.label.map((p) => ({ label: String(p?.value ?? "") }))
                  : "";
            const hint: MonacoInlayHint = {
              position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
              label,
              kind: h.kind === 1 || h.kind === 2 ? (h.kind as MonacoInlayHintKind) : undefined,
              paddingLeft: h.paddingLeft === true,
              paddingRight: h.paddingRight === true,
            };
            return hint;
          });
        return { hints, dispose: () => {} };
      },
    });

    // folding regions (APP-074) — LSP `textDocument/foldingRange` when the toggle is ON;
    // otherwise an indentation fallback so the language still folds.
    monaco.languages.registerFoldingRangeProvider(lang, {
      provideFoldingRanges: async (model) => {
        const FK = monaco.languages.FoldingRangeKind;
        const toMonaco = (rs: FoldRange[]) =>
          rs.map((r) => ({
            start: r.start,
            end: r.end,
            kind:
              r.kind === "comment"
                ? FK.Comment
                : r.kind === "imports"
                  ? FK.Imports
                  : r.kind === "region"
                    ? FK.Region
                    : undefined,
          }));
        if (!useEditorVisionStore.getState().folding) {
          return toMonaco(indentFoldingRanges(model.getLinesContent()));
        }
        const r = await lspReq(model, "textDocument/foldingRange", {});
        const lsp = Array.isArray(r) ? (r as LspFoldingRange[]) : [];
        const mapped = lspFoldingToRanges(lsp);
        // server returned nothing → indentation fallback (never a blank fold experience).
        return toMonaco(mapped.length > 0 ? mapped : indentFoldingRanges(model.getLinesContent()));
      },
    });

    // code-vision (APP-074) — a "N refs" lens above each top-level symbol (OFF by default,
    // one `references` request per symbol resolved LAZILY in the viewport, capped at 30).
    const lensEmitter = new monaco.Emitter<void>();
    onVisionChange(() => lensEmitter.fire()); // a toggle flip invalidates cached lenses
    monaco.languages.registerCodeLensProvider(lang, {
      // Monaco types onDidChange as IEvent<this>; the void emitter just signals "recompute".
      onDidChange: lensEmitter.event as unknown as MonacoCodeLensOnDidChange,
      provideCodeLenses: async (model) => {
        if (!useEditorVisionStore.getState().codeVision) return { lenses: [], dispose: () => {} };
        const r = await lspReq(model, "textDocument/documentSymbol", {});
        const top = capSymbols(normalizeSymbols(r)); // top-level only (cap the LSP fan-out)
        const lenses = top.map((s, i) => ({
          range: mRange(s.selectionRange),
          id: `prom-refs-${i}`,
        }));
        return { lenses, dispose: () => {} };
      },
      resolveCodeLens: async (model, lens) => {
        const pos = { line: lens.range.startLineNumber - 1, character: lens.range.startColumn - 1 };
        const refs = await lspReq(model, "textDocument/references", {
          position: pos,
          context: { includeDeclaration: false }, // true "usages" count (not defn+1)
        });
        const locs = Array.isArray(refs) ? (refs as LspLocation[]) : [];
        const monacoLocs = locs
          .filter((l) => l?.uri && l.range)
          .map((l) => ({ uri: monaco.Uri.parse(l.uri), range: mRange(l.range) }));
        lens.command = {
          id: "editor.action.showReferences",
          title: refsLensTitle(monacoLocs.length),
          arguments: [
            model.uri,
            { lineNumber: lens.range.startLineNumber, column: lens.range.startColumn },
            monacoLocs,
          ],
        };
        return lens;
      },
    });

    // code actions / quick-fixes / intentions (lightbulb · ⌘. ) -----------------
    // `textDocument/codeAction` returns quick-fixes + refactor.* actions. We surface
    // EDIT-carrying actions (the vast majority — add-import, remove-unused, extract via
    // edit) and convert their LSP WorkspaceEdit → a Monaco in-editor WorkspaceEdit so
    // Monaco applies them undoably. Pure-command actions (server executeCommand) are a
    // documented follow-up (needs a server→client applyEdit relay).
    const markerToLspDiag = (m: IMarkerData): Record<string, unknown> => ({
      range: {
        start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
        end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
      },
      message: m.message,
      // Monaco MarkerSeverity Hint1/Info2/Warning4/Error8 → LSP 4/3/2/1.
      severity: m.severity === 8 ? 1 : m.severity === 4 ? 2 : m.severity === 2 ? 3 : 4,
      ...(m.code !== undefined ? { code: typeof m.code === "object" ? m.code.value : m.code } : {}),
      ...(m.source ? { source: m.source } : {}),
    });
    monaco.languages.registerCodeActionProvider(
      lang,
      {
        provideCodeActions: async (model, range, context) => {
          const r = await lspReq(model, "textDocument/codeAction", {
            range: toLspRange({
              startLineNumber: range.startLineNumber,
              startColumn: range.startColumn,
              endLineNumber: range.endLineNumber,
              endColumn: range.endColumn,
            }),
            context: {
              diagnostics: (context.markers ?? []).map(markerToLspDiag),
              ...(context.only ? { only: [context.only] } : {}),
            },
          });
          const items = Array.isArray(r) ? (r as LspCodeAction[]) : [];
          const actions: MonacoCodeAction[] = [];
          const modelUri = model.uri.toString();
          for (const a of items) {
            if (!a || typeof a !== "object") continue;
            const title = String(a.title ?? a.command?.title ?? "code action");
            const kind = typeof a.kind === "string" ? a.kind : "quickfix";
            const run = classifyCodeAction(a);
            if (run.kind === "edit") {
              // edit-carrying action → a Monaco WorkspaceEdit Monaco applies undoably.
              const files = normalizeWorkspaceEdit(a.edit);
              const edits = files.flatMap((f) =>
                f.edits.map((e) => ({
                  resource: monaco.Uri.parse(f.uri),
                  textEdit: { range: mRange(e.range), text: e.newText },
                  versionId: undefined,
                })),
              );
              if (edits.length === 0) continue;
              const action: MonacoCodeAction = {
                title,
                kind,
                edit: { edits } as MonacoWorkspaceEdit,
              };
              if (a.isPreferred === true) action.isPreferred = true;
              actions.push(action);
            } else if (run.kind === "command") {
              // APP-078: COMMAND-ONLY action → workspace/executeCommand (server sends applyEdit
              // back, handled by the relay). No longer silently dropped.
              const action: MonacoCodeAction = {
                title,
                kind,
                command: {
                  id: LSP_EXEC_COMMAND_ID,
                  title,
                  arguments: [{ uri: modelUri, command: run.command, args: run.arguments }],
                },
              };
              if (a.isPreferred === true) action.isPreferred = true;
              actions.push(action);
            }
          }
          return { actions, dispose: () => {} };
        },
      },
      { providedCodeActionKinds: ["quickfix", "refactor", "source"] },
    );

    // document symbols (outline · breadcrumbs · ⌘⇧O) ----------------------------
    monaco.languages.registerDocumentSymbolProvider(lang, {
      provideDocumentSymbols: async (model) => {
        const r = await lspReq(model, "textDocument/documentSymbol", {});
        const toMon = (syms: NormalizedSymbol[]): MonacoDocumentSymbol[] =>
          syms.map((s) => ({
            name: s.name || "?",
            detail: s.detail,
            kind: monacoSymbolKind(SK, s.kind) as MonacoSymbolKind,
            tags: [],
            range: mRange(s.range),
            selectionRange: mRange(s.selectionRange),
            children: toMon(s.children),
          }));
        return toMon(normalizeSymbols(r));
      },
    });

    // signature help (parameter hints) ------------------------------------------
    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ["(", ","],
      provideSignatureHelp: async (model, position) => {
        const r = (await lspReq(model, "textDocument/signatureHelp", {
          position: toLspPosition(position),
        })) as {
          signatures?: Array<{
            label?: unknown;
            documentation?: unknown;
            parameters?: Array<{ label?: unknown; documentation?: unknown }>;
          }>;
          activeSignature?: number;
          activeParameter?: number;
        } | null;
        if (!r || !Array.isArray(r.signatures) || r.signatures.length === 0) return null;
        return {
          value: {
            signatures: r.signatures.map((s) => ({
              label: String(s.label ?? ""),
              documentation: { value: docToMarkdown(s.documentation) },
              parameters: (s.parameters ?? []).map((p) => ({
                label: typeof p.label === "string" ? p.label : "",
                documentation: { value: docToMarkdown(p.documentation) },
              })),
            })),
            activeSignature: r.activeSignature ?? 0,
            activeParameter: r.activeParameter ?? 0,
          },
          dispose: () => {},
        };
      },
    });

    // document + range formatting (⇧⌥F) -----------------------------------------
    monaco.languages.registerDocumentFormattingEditProvider(lang, {
      provideDocumentFormattingEdits: async (model, options) => {
        const r = await lspReq(model, "textDocument/formatting", {
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        });
        return normalizeTextEdits(r).map((e) => ({ range: mRange(e.range), text: e.newText }));
      },
    });
    monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
      provideDocumentRangeFormattingEdits: async (model, range, options) => {
        const r = await lspReq(model, "textDocument/rangeFormatting", {
          range: toLspRange(range),
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        });
        return normalizeTextEdits(r).map((e) => ({ range: mRange(e.range), text: e.newText }));
      },
    });

    // rename symbol (F2) — apply the server's WorkspaceEdit ourselves: open models via
    // pushEditOperations (undo-able), closed files via fsRead→apply→fsWrite (so a
    // cross-file rename actually reaches every file, not just the open ones). We apply
    // here + return an empty edit so Monaco doesn't double-apply.
    monaco.languages.registerRenameProvider(lang, {
      provideRenameEdits: async (model, position, newName) => {
        const r = await lspReq(model, "textDocument/rename", {
          position: toLspPosition(position),
          newName,
        });
        const files = normalizeWorkspaceEdit(r);
        if (files.length === 0) return { edits: [] };
        const api = ide();
        for (const f of files) {
          const m = monaco.editor.getModel(monaco.Uri.parse(f.uri));
          if (m) {
            m.pushEditOperations(
              null,
              f.edits.map((e) => ({ range: mRange(e.range), text: e.newText })),
              () => null,
            );
          } else if (api) {
            const read = await api.fsRead(f.uri);
            if (read?.ok && read.text !== undefined) {
              await api.fsWrite(f.uri, applyTextEdits(read.text, f.edits));
            }
          }
        }
        return { edits: [] }; // already applied above
      },
    });
  }
}

/**
 * Run a smart key (⇧⌘⏎ complete-statement, or smart-enter) at EVERY caret: one
 * pure-core edit per caret, applied in a single executeEdits (ONE undo unit), with
 * the resulting carets computed from the inverse ops (post-apply positions) so
 * multi-line insertions above don't invalidate the carets below (APP-018).
 */
function runSmartKey(
  monaco: Monaco,
  editor: IStandaloneCodeEditor,
  kind: "complete" | "enter",
): void {
  const model = editor.getModel();
  const sels = editor.getSelections();
  if (!model || !sels || sels.length === 0) return;
  const lang = model.getLanguageId();
  const seenLines = new Set<number>();
  const jobs: SmartKeyResult[] = [];
  for (const sel of sels) {
    const line = sel.positionLineNumber;
    if (kind === "complete") {
      // two carets on one line complete the same statement once, not twice.
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      jobs.push(completeStatement(model.getLineContent(line), line, lang));
    } else {
      jobs.push(
        smartEnterEdit({
          line: model.getLineContent(line),
          lineNumber: line,
          col: sel.positionColumn,
          lang,
        }),
      );
    }
  }
  if (jobs.length === 0) return;
  // ascending source order so the inverse ops line up index-for-index below.
  jobs.sort(
    (a, b) =>
      a.edit.range.startLine - b.edit.range.startLine ||
      a.edit.range.startCol - b.edit.range.startCol,
  );
  editor.executeEdits(
    "smart-keys",
    jobs.map((j) => ({
      range: new monaco.Range(
        j.edit.range.startLine,
        j.edit.range.startCol,
        j.edit.range.endLine,
        j.edit.range.endCol,
      ),
      text: j.edit.text,
      forceMoveMarkers: true,
    })),
    (inverse) =>
      inverse.map((op, i) => {
        const j = jobs[i];
        if (!j)
          return new monaco.Selection(op.range.startLineNumber, 1, op.range.startLineNumber, 1);
        // the caret is RELATIVE to the edit's start line; anchor it to where the
        // edit actually landed (ops above may have shifted it down).
        const line = op.range.startLineNumber + (j.caret.line - j.edit.range.startLine);
        return new monaco.Selection(line, j.caret.col, line, j.caret.col);
      }),
  );
  editor.focus();
}

/* ── format-on-save · EditorConfig · optimize-imports (APP-019) ───────────────── */

/** One `textDocument/*` LSP request for an OPEN uri (serverId from the lspDocs map). */
async function lspRequestForUri(
  uri: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const doc = lspDocs.get(uri);
  const root = useTabsStore.getState().workspaceRoot;
  if (!doc || !root) return null;
  const res = await ide()
    ?.lspRequest(doc.serverId, root, method, { textDocument: { uri }, ...params })
    .catch(() => undefined);
  return res?.ok ? res.result : null;
}

/** Resolve the effective `.editorconfig` for a file uri: walk parent dirs from the
 *  file's dir up to (and including) the workspace root via the path-guarded fs IPC,
 *  stopping at the first `root=true`. Returns {} on any failure (fail-soft). */
async function resolveEditorConfigForUri(uri: string): Promise<ResolvedEditorConfig> {
  const api = ide();
  const root = useTabsStore.getState().workspaceRoot;
  if (!api || !root || !uri.startsWith("file://")) return {};
  const absPath = uri.slice("file://".length);
  const chain: EditorConfigEntry[] = [];
  let dir = absPath.slice(0, absPath.lastIndexOf("/"));
  while (dir === root || dir.startsWith(`${root}/`)) {
    const r = await api.fsRead(`file://${dir}/.editorconfig`).catch(() => undefined);
    if (r?.ok && typeof r.text === "string") {
      const parsed = parseEditorConfig(r.text);
      chain.push({ dir, parsed });
      if (parsed.root) break;
    }
    if (dir === root) break;
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (parent === dir || parent === "") break;
    dir = parent;
  }
  try {
    return resolveEditorConfig(chain, absPath);
  } catch {
    return {};
  }
}

/** Apply an EditorConfig's indent + EOL to the editor on OPEN (Monaco owns indent on the
 *  MODEL; CR is unsupported → fall back to LF). */
function applyEditorConfigToModel(
  monaco: Monaco,
  model: ITextModel,
  cfg: ResolvedEditorConfig,
): void {
  const size = cfg.indentSize ?? cfg.tabWidth;
  const modelOpts: { insertSpaces?: boolean; tabSize?: number } = {};
  if (cfg.indentStyle) modelOpts.insertSpaces = cfg.indentStyle === "space";
  if (size !== undefined) modelOpts.tabSize = size;
  if (Object.keys(modelOpts).length > 0) model.updateOptions(modelOpts);
  if (cfg.endOfLine === "lf" || cfg.endOfLine === "cr") {
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
  } else if (cfg.endOfLine === "crlf") {
    model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
  }
}

/** Run Monaco's format-document (the registered LSP formatting provider) with a hard
 *  timeout — a hung/slow server must NEVER hold up the save (fail-open, APP-019). */
async function runFormatWithTimeout(editor: IStandaloneCodeEditor, ms: number): Promise<void> {
  const action = editor.getAction("editor.action.formatDocument");
  if (!action) return;
  await Promise.race([action.run(), new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

/**
 * Request LSP `source.organizeImports` for the focused editor + apply its WorkspaceEdit
 * via the tested applier (open models → undoable pushEditOperations; closed files →
 * fsRead+apply+fsWrite). An empty result / an action carrying only a `command` (no
 * client-appliable edit) is the honest "no-op with notice" path — NOT an error.
 * Returns true when an edit was applied. `flash` surfaces the notice.
 */
async function organizeImports(
  monaco: Monaco,
  editor: IStandaloneCodeEditor,
  flash: (msg: string) => void,
  quiet = false,
): Promise<boolean> {
  const model = editor.getModel();
  if (!model) return false;
  const uri = model.uri.toString();
  const full = model.getFullModelRange();
  const result = await lspRequestForUri(uri, "textDocument/codeAction", {
    range: toLspRange({
      startLineNumber: full.startLineNumber,
      startColumn: full.startColumn,
      endLineNumber: full.endLineNumber,
      endColumn: full.endColumn,
    }),
    context: { only: ["source.organizeImports"], diagnostics: [] },
  }).catch(() => null);
  const items = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
  const withEdit = items.find((a) => a && typeof a === "object" && a.edit);
  if (!withEdit) {
    if (!quiet) {
      flash(
        items.length > 0
          ? "organize imports needs an unsupported server command"
          : "no imports to organize",
      );
    }
    return false;
  }
  const files = normalizeWorkspaceEdit(withEdit.edit);
  if (files.length === 0) {
    if (!quiet) flash("no imports to organize");
    return false;
  }
  const api = ide();
  let applied = false;
  for (const f of files) {
    const m = monaco.editor.getModel(monaco.Uri.parse(f.uri));
    if (m) {
      m.pushEditOperations(
        null,
        f.edits.map((e) => ({
          range: new monaco.Range(
            e.range.start.line + 1,
            e.range.start.character + 1,
            e.range.end.line + 1,
            e.range.end.character + 1,
          ),
          text: e.newText,
        })),
        () => null,
      );
      applied = true;
    } else if (api) {
      const read = await api.fsRead(f.uri);
      if (read?.ok && read.text !== undefined) {
        await api.fsWrite(f.uri, applyTextEdits(read.text, f.edits));
        applied = true;
      }
    }
  }
  return applied;
}

/**
 * The Cmd-S save with format-on-save + EditorConfig transforms (APP-019). FAIL-OPEN
 * for the WRITE: any formatter error/timeout still writes the (unformatted) buffer, and
 * the EditorConfig trim/final-newline/EOL rules — which apply even when format-on-save
 * is off — are string transforms over the model's LF-normalized value re-applied as one
 * undo step (so what is written == what is shown). scratch: buffers never touch disk.
 */
async function saveBuffer(
  monaco: Monaco,
  editor: IStandaloneCodeEditor,
  markDirty: (uri: string, dirty: boolean) => void,
  flash: (msg: string) => void,
): Promise<void> {
  const model = editor.getModel();
  if (!model) return;
  const uri = model.uri.toString();
  if (uri.startsWith("scratch:")) {
    markDirty(uri, false);
    return;
  }
  const lang = model.getLanguageId();
  const store = useFormatStore.getState();
  const policy = store.policy();
  const langEnabled = policy.byLang?.[lang] !== false;
  let cfg: ResolvedEditorConfig = {};
  try {
    cfg = await resolveEditorConfigForUri(uri);
  } catch {
    cfg = {};
  }
  // 1) optimize-imports-on-save (its OWN toggle, independent of format-on-save) —
  //    timeout-guarded like the formatter so a slow codeAction never stalls the save.
  if (store.optimizeImportsOnSave && langEnabled) {
    try {
      await Promise.race([
        organizeImports(monaco, editor, flash, true),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      flash("organize imports failed — saved without it");
    }
  }
  // 2) format-on-save (LSP) — never lose the write on a formatter error/timeout.
  if (formatOnSaveEnabled(lang, policy)) {
    try {
      await runFormatWithTimeout(editor, 3000);
    } catch {
      flash("formatter failed — saved unformatted");
    }
  }
  // 3) EditorConfig save-time transforms (trim / final-newline / EOL). Monaco owns EOL
  //    via setEOL; trim + final-newline run over the LF-normalized value as one undo step.
  try {
    if (cfg.endOfLine === "crlf") model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    else if (cfg.endOfLine === "lf") model.setEOL(monaco.editor.EndOfLineSequence.LF);
    else if (cfg.endOfLine === "cr") {
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      flash("editorconfig end_of_line=cr is unsupported — using LF");
    }
    const lf = model.getValue(monaco.editor.EndOfLinePreference.LF);
    const transformed = applyEditorConfigTextRules(lf, {
      trimTrailingWhitespace: cfg.trimTrailingWhitespace,
      insertFinalNewline: cfg.insertFinalNewline,
    });
    if (transformed !== lf) {
      model.pushEditOperations(
        null,
        [{ range: model.getFullModelRange(), text: transformed }],
        () => null,
      );
    }
  } catch {
    /* editorconfig transform failed — write the buffer as-is (never lose the save). */
  }
  // 4) write. Snapshot the bytes + the model VERSION together, then only clear the dirty
  //    dot if the model hasn't changed since — a keystroke landing during the async write
  //    must not be masked by a stale "saved" (its edit is genuinely unwritten).
  const versionAtWrite = model.getVersionId();
  const bytes = model.getValue();
  const r = await ide()
    ?.fsWrite(uri, bytes)
    .catch(() => undefined);
  if (r?.ok) {
    if (!model.isDisposed() && model.getVersionId() === versionAtWrite) markDirty(uri, false);
    useDirtyRecoveryStore.getState().clear(uri); // APP-067: saved → drop the crash-recovery copy
  } else {
    flash("save failed");
  }
}

let breakpointGutterRegistered = false;
/** Register the `breakpoints` gutter provider ONCE (APP-012). The wiring itself
 *  (store→registry sync, click→toggle) is the pure `wireBreakpointGutter` in
 *  breakpoint-store.ts — this seam only supplies the monaco.Uri conversions, so
 *  decorations key by the SAME canonical model-uri string the glyph sync above
 *  reads back via decorationsForFile(model.uri.toString()). */
function registerBreakpointGutter(monaco: Monaco): void {
  if (breakpointGutterRegistered) return;
  breakpointGutterRegistered = true;
  wireBreakpointGutter(gutterRegistry, {
    pathToModelUri: (path) => monaco.Uri.file(path).toString(),
    modelUriToPath: (uri) => {
      const u = monaco.Uri.parse(uri);
      // scratch:/untitled: buffers can't hold breakpoints.
      return u.scheme === "file" ? u.fsPath : null;
    },
  });
}

let bookmarkGutterRegistered = false;
/** Register the `bookmarks` gutter provider ONCE (APP-061): a glyph on every bookmarked
 *  line of the active model. Bookmarks store the model-uri directly so no path conversion
 *  is needed — wireBookmarkGutter pushes/clears through the SAME shared registry. */
function registerBookmarkGutter(): void {
  if (bookmarkGutterRegistered) return;
  bookmarkGutterRegistered = true;
  wireBookmarkGutter(gutterRegistry);
}

let testRunGutterRegistered = false;
/** Register the `test-run` gutter provider ONCE (APP-014): run icons on the discovered
 *  case lines, click = run exactly that case's node id. Same injected-uri seam as the
 *  breakpoint wiring — the sync/click logic is the pure `wireTestRunGutter` in
 *  test/test-run-store.ts, so it stays node-testable without monaco. */
function registerTestRunGutter(monaco: Monaco): void {
  if (testRunGutterRegistered) return;
  testRunGutterRegistered = true;
  wireTestRunGutter(gutterRegistry, {
    pathToModelUri: (path) => monaco.Uri.file(path).toString(),
    modelUriToPath: (uri) => {
      const u = monaco.Uri.parse(uri);
      return u.scheme === "file" ? u.fsPath : null;
    },
  });
}

/** One editor group: a single Monaco editor that model-swaps on active-tab change. */
function EditorGroup({ group }: { group: number }): ReactElement {
  const tabs = useTabsStore((s) => s.tabs);
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const markDirty = useTabsStore((s) => s.markDirty);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // APP-083 inline blame: the mount effect owns the decorations collection + caret-line
  // application (stored in these refs); a component effect owns the per-file data fetch.
  const inlineBlameEnabled = useInlineBlameStore((s) => s.enabled);
  const blameColRef = useRef<import("monaco-editor").editor.IEditorDecorationsCollection | null>(
    null,
  );
  const blameMapRef = useRef<ReturnType<typeof blameByLine>>(new Map());
  const applyBlameLineRef = useRef<() => void>(() => {});
  // APP-086 coverage stripes: a gutter-margin decorations collection + its applier.
  const coverageReport = useCoverageStore((s) => s.report);
  const covColRef = useRef<import("monaco-editor").editor.IEditorDecorationsCollection | null>(
    null,
  );
  const applyCoverageRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [readError, setReadError] = useState<string | null>(null);
  // an ephemeral status line for format-on-save notices (fail-open messages,
  // organize-imports no-op) — auto-clears; there is no global toast bus (APP-019).
  const [formatStatus, setFormatStatus] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashRef = useRef<(msg: string) => void>(() => {});
  flashRef.current = (msg: string): void => {
    setFormatStatus(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFormatStatus(null), 2600);
  };
  // the active design tokens → a Monaco theme (Monaco can't read CSS vars).
  const { colors, resolvedBase, activeSchemeId } = useTheme();
  // handoff §1 "Editor scheme": the DEFAULT scheme paints the editor with the operator's
  // Pelly syntax palette. An explicitly-picked scheme keeps its OWN syntax colors — the
  // 41-scheme picker would be cosmetically broken if every entry rendered Pelly.
  const editorTheme = useCallback(
    (c: typeof colors, rb: typeof resolvedBase, schemeId: string | null): unknown =>
      schemeId && schemeId !== DEFAULT_SCHEME_ID
        ? monacoThemeFromSemantic(c, monacoBase(rb))
        : pellyMonacoTheme(c, monacoBase(rb)),
    [],
  );
  const themeRef = useRef({ colors, resolvedBase, activeSchemeId });
  themeRef.current = { colors, resolvedBase, activeSchemeId };
  // the user's editor font (Settings → Fonts). Read via a ref for the one-time create
  // (so the mount effect doesn't re-run on a font change); a dedicated effect below
  // live-applies changes via editor.updateOptions.
  const editorFont = useFontStore((s) => s.editor);
  const editorFontRef = useRef(editorFont);
  editorFontRef.current = editorFont;
  // (LSP doc-sync state is the module-level `lspDocs` map above.)
  // per-uri debounce timers — a single shared timer coalesced split-group edits and
  // dropped one model's didChange (last uri won).
  const lspChangeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // APP-011: the ONE gutter decorations collection this editor owns (set in the mount
  // effect) + its clear/sync hooks for the model-swap effect, and the registry
  // unsubscribe for unmount (mouse listeners die with editor.dispose(); this doesn't).
  const glyphsRef = useRef<{ clear(): void; sync(): void } | null>(null);
  const glyphUnsubRef = useRef<(() => void) | null>(null);
  // window listeners registered inside the async mount IIFE (they close over the live
  // editor) — collected here so unmount removes them even mid-flight (APP-018).
  const windowCleanups = useRef<Array<() => void>>([]);
  // diagnostics → Monaco markers (squiggles): the store had them but the editor gutter
  // stayed blank because setModelMarkers was never called.
  const diagByUri = useDiagnosticsStore((s) => s.byUri);

  const active = activeDoc(tabs, group);
  // APP-045: a `.ipynb` tab renders the live NotebookView overlay instead of Monaco
  // (the tab bar stays; switching tabs swaps Monaco back in).
  const isNotebook = !!active && active.uri.endsWith(".ipynb");

  // mount the single Monaco editor for this group (once Monaco loads).
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const monaco = await loadMonaco();
      if (disposed) return;
      if (!monaco || !hostRef.current) {
        setStatus("unavailable");
        return;
      }
      monacoRef.current = monaco;
      registerLspProviders(monaco); // hover + completion bridged to the LSP server (once)
      registerTemplateCompletions(monaco); // live + postfix snippet completions (APP-020)
      hydrateTemplatesOnce(); // load persisted user templates so completions see them (APP-020)
      registerInlineCompletions(monaco); // AI ghost-text (#4) — opt-in, no-op until enabled
      registerBreakpointGutter(monaco); // breakpoint glyphs + gutter toggle (APP-012, once)
      registerTestRunGutter(monaco); // per-test run icons on discovered lines (APP-014, once)
      registerBookmarkGutter(); // bookmark glyphs (APP-061, once)
      // define a theme from the ACTIVE tokens so the editor matches the app (light /
      // dark / high-contrast) instead of being hardcoded to vs-dark.
      const { colors: c, resolvedBase: rb, activeSchemeId: sid } = themeRef.current;
      monaco.editor.defineTheme(
        EDITOR_THEME,
        editorTheme(c, rb, sid) as Parameters<typeof monaco.editor.defineTheme>[1],
      );
      const editor = monaco.editor.create(hostRef.current, {
        automaticLayout: true,
        minimap: { enabled: true },
        stickyScroll: { enabled: true },
        // the glyph margin the gutter-decoration layer renders into (APP-011) — without
        // it the margin has zero width and clicks never hit GUTTER_GLYPH_MARGIN.
        glyphMargin: true,
        // built-in modern-editor polish (leap #14) — all Monaco-native (MIT), config only.
        // OFF (handoff §1): bracket-pair colorization paints bracket characters by NESTING
        // DEPTH and overrides the tokenizer, which would erase the Pelly per-character
        // brace (#6591ff) / bracket (#18ff00) colors. The indent guides stay on.
        bracketPairColorization: { enabled: false },
        guides: { bracketPairs: true, indentation: true },
        cursorSmoothCaretAnimation: "on",
        smoothScrolling: true,
        renderLineHighlight: "all",
        scrollBeyondLastLine: false,
        multiCursorModifier: "alt",
        inlineSuggest: { enabled: true }, // surface AI ghost-text (#4) when opted in

        ...monacoFontOptions(editorFontRef.current),
        theme: EDITOR_THEME,
        readOnly: false,
      });
      editorRef.current = editor;
      // track the focused editor so the Cmd-I inline-edit overlay (#11) targets this pane.
      activeEditor = editor;
      editor.onDidFocusEditorText(() => {
        activeEditor = editor;
      });
      // gutter-decoration layer (APP-011): ONE decorations collection owned by this
      // editor, re-synced from the shared registry. Glyphs bind to the MODEL — the
      // model-swap effect clears before a swap + re-syncs after, so file A's glyphs
      // never bleed into file B.
      const glyphs = editor.createDecorationsCollection();
      const syncGlyphs = (): void => {
        const model = editor.getModel();
        if (!model) {
          glyphs.clear();
          return;
        }
        glyphs.set(
          gutterRegistry.decorationsForFile(model.uri.toString()).map((v) => ({
            range: new monaco.Range(v.line, 1, v.line, 1),
            options: {
              glyphMarginClassName: v.glyphClassName,
              glyphMarginHoverMessage: v.hoverMessages.map((value) => ({ value })),
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          })),
        );
      };
      glyphsRef.current = { clear: (): void => glyphs.clear(), sync: syncGlyphs };
      glyphUnsubRef.current = gutterRegistry.subscribe(syncGlyphs);
      // glyph-margin clicks/hovers → the registry's subscribers (APP-012 breakpoints,
      // run icons…) — filtered to GUTTER_GLYPH_MARGIN, hover deduped by line inside
      // the registry (onMouseMove fires per-pixel). Disposed with the editor.
      editor.onMouseDown((e) => {
        const model = editor.getModel();
        const uri = model?.uri.toString();
        if (!model || !uri) return;
        // right-click on the glyph margin → open the breakpoint condition/hit/log editor
        // (APP-079); left-click keeps the plain toggle path below. File buffers only.
        if (
          e.event.rightButton &&
          e.target.type === GUTTER_GLYPH_MARGIN &&
          e.target.position &&
          model.uri.scheme === "file"
        ) {
          e.event.preventDefault();
          e.event.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("ide:edit-breakpoint", {
              detail: {
                path: model.uri.fsPath,
                line: e.target.position.lineNumber,
                x: e.event.browserEvent.clientX,
                y: e.event.browserEvent.clientY,
              },
            }),
          );
          return;
        }
        const ev = gutterEventFromMouse(e, uri, gutterRegistry.getState());
        if (ev) gutterRegistry.emitClick(ev);
      });
      editor.onMouseMove((e) => {
        const uri = editor.getModel()?.uri.toString();
        if (!uri) return;
        const ev = gutterEventFromMouse(e, uri, gutterRegistry.getState());
        if (ev) gutterRegistry.emitHover(ev);
        else gutterRegistry.clearHover(); // left the glyph margin — a re-hover re-emits
      });
      editor.onMouseLeave(() => gutterRegistry.clearHover());
      // dirty tracking: a content change flips the doc dirty (and pins a preview tab),
      // and (debounced) syncs the new text to the LSP server so diagnostics stay live.
      editor.onDidChangeModelContent((e) => {
        const model = editor.getModel();
        if (!model) return;
        const uri = model.uri.toString();
        markDirty(uri, true);
        // APP-067: capture the unsaved buffer for crash recovery (byte-capped in the store;
        // the store's write is debounced so this is cheap per keystroke). Cleared on save.
        useDirtyRecoveryStore.getState().record(uri, model.getValue());
        // APP-061: keep persisted bookmark line numbers in sync with edits. Each change
        // shifts bookmarks below it by (added − removed) lines; a bookmark on a deleted line
        // clamps (never vanishes). Monaco's own decorations already track live; this keeps
        // the STORE (the source of truth for the Bookmarks window + persistence) aligned.
        const bm = useBookmarksStore.getState();
        for (const c of e.changes) {
          const removed = c.range.endLineNumber - c.range.startLineNumber;
          const added = (c.text.match(/\n/g) ?? []).length;
          if (added !== removed) bm.shift(uri, c.range.startLineNumber, added - removed);
        }
        // remember the last edit location (⌘⇧⌫ jumps back to it — plan 05).
        const pos = editor.getPosition();
        if (pos) {
          useNavStore.getState().setLastEdit({ uri, line: pos.lineNumber, column: pos.column });
        }
        const doc = lspDocs.get(uri);
        const wsRoot = useTabsStore.getState().workspaceRoot;
        if (doc && wsRoot) {
          const prev = lspChangeTimers.current.get(uri);
          if (prev) clearTimeout(prev);
          lspChangeTimers.current.set(
            uri,
            setTimeout(() => {
              lspChangeTimers.current.delete(uri);
              // the tab may have closed within the debounce window — the model is then
              // disposed and model.getValue() throws "Model is disposed!". Guard it.
              if (model.isDisposed()) return;
              doc.version += 1;
              ide()?.lspDidChange(doc.serverId, wsRoot, uri, model.getValue(), doc.version);
            }, 300),
          );
        }
      });
      // Cmd/Ctrl-S → persist the buffer through the format-on-save + EditorConfig path
      // (APP-019). Routed via an `ide:save` event so the SAME save path serves the
      // keybinding, a future palette "Save", and the render-check harness. saveBuffer is
      // fail-open: a formatter error/timeout still writes; scratch: buffers stay in-memory.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        window.dispatchEvent(new CustomEvent("ide:save"));
      });
      // APP-061: ⌘/Ctrl-F3 toggles a bookmark on the caret line of the focused editor.
      editor.addAction({
        id: "prometheus.bookmark.toggle",
        label: "Toggle Bookmark",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F3],
        contextMenuGroupId: "navigation",
        run: (ed) => {
          const model = ed.getModel();
          const pos = ed.getPosition();
          if (!model || !pos) return;
          useBookmarksStore.getState().toggle(model.uri.toString(), pos.lineNumber);
        },
      });
      const onSave = (): void => {
        if (activeEditor === editor) {
          void saveBuffer(monaco, editor, markDirty, (m) => flashRef.current(m));
        }
      };
      window.addEventListener("ide:save", onSave);
      windowCleanups.current.push(() => window.removeEventListener("ide:save", onSave));
      // APP-063: a Local History revert wrote new content to disk — reload the open model so
      // the editor reflects the reverted file (not just the disk). Only reloads if THIS editor
      // hosts that uri and it isn't dirty (never clobber unsaved edits).
      const onReloadFile = (e: Event): void => {
        const uri = (e as CustomEvent<{ uri?: string }>).detail?.uri;
        const model = editor.getModel();
        if (!uri || !model || model.uri.toString() !== uri) return;
        /**
         * The dirty check the comment above already promised.
         *
         * It said "Only reloads if THIS editor hosts that uri and it isn't dirty (never clobber
         * unsaved edits)" — and only the uri half was implemented. A Local History revert (or
         * anything else dispatching `ide:reload-file`) called `setValue` over a buffer with
         * unsaved edits and then `markDirty(uri, false)`, so the work was destroyed AND the tab
         * was marked clean, removing the last cue that anything had been lost.
         *
         * Read through `getState()` rather than the render-time `tabs`: this listener is
         * registered once per editor and would otherwise close over a stale snapshot.
         */
        if (useTabsStore.getState().tabs.docs.some((d) => d.uri === uri && d.dirty)) return;
        void ide()
          ?.fsRead(uri)
          .then((r) => {
            if (r?.ok && typeof r.text === "string" && !model.isDisposed()) {
              model.setValue(r.text);
              markDirty(uri, false);
            }
          });
      };
      window.addEventListener("ide:reload-file", onReloadFile);
      windowCleanups.current.push(() =>
        window.removeEventListener("ide:reload-file", onReloadFile),
      );
      // Cmd/Ctrl-I → open the AI inline-edit overlay over this editor (#11). The overlay
      // is hosted at the EditorPane level; it reads the focused editor + its selection.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
        activeEditor = editor;
        window.dispatchEvent(new CustomEvent("ide:inline-edit"));
      });
      // APP-092: Cmd/Ctrl-L "attach selection" → the AgentPane composer reads the active
      // selection (getActiveEditorSelection) and adds a removable file:line context chip.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => {
        activeEditor = editor;
        window.dispatchEvent(new CustomEvent("ide:attach-selection"));
      });
      // APP-097: ⌘F12 "File Structure" → open the filter-as-you-type symbol popup over the
      // focused editor. The FileStructureHost (EditorPane level) reads the focused editor,
      // fetches documentSymbol, and restores focus here on close. Fires only when the editor
      // has focus (Monaco command context) — no clash with the shell keydown handlers.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12, () => {
        activeEditor = editor;
        window.dispatchEvent(new CustomEvent("ide:file-structure"));
      });
      // APP-098: ⌘J "Quick Doc" → the QuickDocHost runs textDocument/hover at the caret and
      // pins a formatted, sanitized popup (Esc closes + restores focus here).
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => {
        activeEditor = editor;
        window.dispatchEvent(new CustomEvent("ide:quick-doc"));
      });
      // clipboard history (⌘⇧V): capture copy/cut of the editor's selection(s) into
      // the renderer-local ring. Multi-caret copies join every non-empty selection
      // top-to-bottom (Monaco's own multi-cursor copy joins with newlines); all-empty
      // carets copy the primary caret's whole line — matching Monaco's copy behaviour.
      // DOM copy/cut bubble up from Monaco's hidden textarea.
      const captureClip = (): void => {
        const model = editor.getModel();
        const sels = editor.getSelections();
        if (!model || !sels || sels.length === 0) return;
        const nonEmpty = sels.filter((s) => !s.isEmpty());
        const text =
          nonEmpty.length === 0
            ? `${model.getLineContent(sels[0]?.startLineNumber ?? 1)}\n`
            : nonEmpty.map((s) => model.getValueInRange(s)).join("\n");
        useClipboardStore.getState().push(text);
      };
      const dom = editor.getDomNode();
      dom?.addEventListener("copy", captureClip);
      dom?.addEventListener("cut", captureClip);
      // ── smart keys + column-selection mode (APP-018 · plan file 01) ──────────
      // ⇧⌘⏎ complete-statement (JetBrains "Complete Current Statement"); the pure
      // math is @prometheus/core editor/smart-keys — Monaco only applies the edits.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () =>
        runSmartKey(monaco, editor, "complete"),
      );
      // ⌘⇧8 column-selection MODE toggle (JetBrains chord). Monaco treats
      // `columnSelection` as a mode: every selection gesture becomes columnar; the
      // transient ⇧⌥⌘-arrows / ⌥⇧-drag box selection works regardless.
      let columnMode = false;
      const toggleColumnMode = (): void => {
        columnMode = !columnMode;
        editor.updateOptions({ columnSelection: columnMode });
      };
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Digit8,
        toggleColumnMode,
      );
      // palette dispatches (routes/editor.tsx runCommand) — act on the FOCUSED editor
      // only, so a split layout doesn't run the command once per group.
      const onCompleteStatement = (): void => {
        if (activeEditor === editor) runSmartKey(monaco, editor, "complete");
      };
      const onSmartEnter = (): void => {
        if (activeEditor === editor) runSmartKey(monaco, editor, "enter");
      };
      const onToggleColumn = (): void => {
        if (activeEditor === editor) toggleColumnMode();
      };
      window.addEventListener("ide:complete-statement", onCompleteStatement);
      window.addEventListener("ide:smart-enter", onSmartEnter);
      window.addEventListener("ide:toggle-column-selection", onToggleColumn);
      // Optimize Imports (⌥⇧O · VS Code parity; ⌘⇧O is taken by File Structure). Runs the
      // LSP source.organizeImports on the focused editor (APP-019).
      const onOrganize = (): void => {
        if (activeEditor === editor)
          void organizeImports(monaco, editor, (m) => flashRef.current(m));
      };
      editor.addCommand(
        monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyO,
        () => void organizeImports(monaco, editor, (m) => flashRef.current(m)),
      );
      window.addEventListener("ide:organize-imports", onOrganize);
      // Surround With (⌘⌥T · JetBrains "Surround With") — wrap the selection with a surround
      // template via Monaco's SnippetController2 (APP-020). The palette picker dispatches
      // `ide:surround-with` with a chosen `{abbrev}`; the chord uses the first template.
      const onSurround = (e: Event): void => {
        if (activeEditor !== editor) return;
        const abbrev = (e as CustomEvent<{ abbrev?: string }>).detail?.abbrev;
        surroundSelection(monaco, editor, (m) => flashRef.current(m), abbrev);
      };
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyT, () =>
        surroundSelection(monaco, editor, (m) => flashRef.current(m)),
      );
      window.addEventListener("ide:surround-with", onSurround);
      // Find Usages (⌥F7 · JetBrains Alt+F7 · APP-023) — fan LSP references + grep fallback
      // on the caret symbol into the SearchPanel usages tool window. Palette dispatches
      // `ide:find-usages`; the chord runs it on the focused editor.
      const onFindUsages = (): void => {
        if (activeEditor === editor) void runFindUsages(editor, (m) => flashRef.current(m));
      };
      editor.addCommand(
        monaco.KeyMod.Alt | monaco.KeyCode.F7,
        () => void runFindUsages(editor, (m) => flashRef.current(m)),
      );
      window.addEventListener("ide:find-usages", onFindUsages);
      // Refactor menu (APP-027): the six rope transforms in Monaco's built-in context
      // menu (python-only via precondition) — each opens the GATED Refactor Preview
      // (nothing touches disk until the user applies).
      for (const a of REFACTOR_ACTIONS) {
        editor.addAction({
          id: `prometheus.refactor.${a.transform}`,
          label: a.label,
          contextMenuGroupId: "1_modification",
          contextMenuOrder: 10 + a.order,
          precondition: "editorLangId == 'python'",
          run: () => openRefactorPreview(editor, a.transform),
        });
      }
      // Generate menu (APP-028): AST-derived member generators (gen-* sidecar verbs,
      // python-only) + the core new-file/copyright templates — all through the SAME
      // gated preview as the refactors (WorkspaceEdit in, Apply-only writes).
      GENERATE_ACTIONS.forEach((a, i) => {
        editor.addAction({
          id: `prometheus.${a.commandId}`,
          label: a.label,
          contextMenuGroupId: "1_modification",
          contextMenuOrder: 20 + i,
          ...(a.pythonOnly ? { precondition: "editorLangId == 'python'" } : {}),
          run: () => openRefactorPreview(editor, a.transform),
        });
      });
      // palette bus: routes/editor.tsx dispatches `ide:refactor` {transform} for both
      // refactor.* and generate.* ids; the FOCUSED editor captures its caret context
      // and opens the preview.
      const onRefactor = (e: Event): void => {
        if (activeEditor !== editor) return;
        const t = (e as CustomEvent<{ transform?: RefactorTransform }>).detail?.transform;
        if (typeof t === "string") openRefactorPreview(editor, t);
      };
      window.addEventListener("ide:refactor", onRefactor);
      // debugger inline values (APP-031): DebugPanel publishes the selected frame's
      // locals for its stopped line; a decorations COLLECTION renders them as
      // after-content injected text. The collection is bound to the editor (not the
      // model), so a tab's model swap must re-apply/clear BY URI — values never
      // leak onto the wrong file. `{clear:true}` (continue/step/terminate) empties it.
      const inlineValues = editor.createDecorationsCollection([]);
      let lastInline: {
        uri: string;
        line: number;
        pairs: Array<{ name: string; value: string }>;
      } | null = null;
      const applyInlineValues = (): void => {
        const model = editor.getModel();
        if (
          !lastInline ||
          !model ||
          model.uri.toString() !== lastInline.uri ||
          lastInline.line > model.getLineCount()
        ) {
          inlineValues.clear();
          return;
        }
        inlineValues.set(
          buildInlineValueDecorations(
            lastInline.line,
            model.getLineMaxColumn(lastInline.line),
            lastInline.pairs,
          ),
        );
      };
      const onInlineValues = (e: Event): void => {
        const d = (
          e as CustomEvent<{
            clear?: boolean;
            uri?: string;
            line?: number;
            pairs?: Array<{ name: string; value: string }>;
          }>
        ).detail;
        lastInline =
          d && d.clear !== true && typeof d.uri === "string" && typeof d.line === "number"
            ? { uri: d.uri, line: d.line, pairs: Array.isArray(d.pairs) ? d.pairs : [] }
            : null;
        applyInlineValues();
      };
      window.addEventListener("ide:inline-values", onInlineValues);
      editor.onDidChangeModel(applyInlineValues);

      // APP-083: current-line inline blame (opt-in, persisted). A decorations collection
      // bound to the editor; the blame map is fetched per active FILE and re-applied for
      // the caret line. Cleared on any edit (line numbers shift) + re-fetched on save /
      // file switch / toggle. A truncated porcelain stream never crashes (blameByLine guards).
      const blameCol = editor.createDecorationsCollection([]);
      blameColRef.current = blameCol;
      const applyBlameLine = (): void => {
        const model = editor.getModel();
        const pos = editor.getPosition();
        if (!model || !pos || !useInlineBlameStore.getState().enabled) {
          blameCol.clear();
          return;
        }
        blameCol.set(
          buildInlineBlameDecoration(
            blameMapRef.current.get(pos.lineNumber),
            model.getLineMaxColumn(pos.lineNumber),
            Date.now(),
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          ) as Parameters<typeof blameCol.set>[0],
        );
      };
      applyBlameLineRef.current = applyBlameLine;
      editor.onDidChangeCursorPosition(() => applyBlameLine());

      // APP-086: covered/uncovered gutter stripes for the active file (token colors via
      // the .prom-cov-* classes). Cleared on edit (line numbers shift → stale); re-applied
      // on file switch + when a new coverage report lands (the component effect below).
      const covCol = editor.createDecorationsCollection([]);
      covColRef.current = covCol;
      const applyCoverage = (): void => {
        const model = editor.getModel();
        if (!model || model.uri.scheme !== "file") {
          covCol.clear();
          return;
        }
        const entry = coverageEntryForPath(useCoverageStore.getState().report, model.uri.fsPath);
        if (!entry) {
          covCol.clear();
          return;
        }
        const lineCount = model.getLineCount();
        const decos = [
          ...entry.lines.map((l) => ({ line: l, cls: "prom-cov-covered" })),
          ...entry.missed.map((l) => ({ line: l, cls: "prom-cov-missed" })),
        ]
          .filter((d) => d.line >= 1 && d.line <= lineCount)
          .map((d) => ({
            range: new monaco.Range(d.line, 1, d.line, 1),
            options: {
              linesDecorationsClassName: d.cls,
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          }));
        covCol.set(decos);
      };
      applyCoverageRef.current = applyCoverage;
      editor.onDidChangeModel(() => applyCoverage());
      editor.onDidChangeModelContent(() => covCol.clear()); // line shift → stale stripes
      windowCleanups.current.push(() => {
        covColRef.current = null;
      });

      // APP-098: reader-mode — a per-pane, view-only toggle that italicizes doc-comment blocks
      // (JSDoc / python docstrings). Decoration-ONLY (inlineClassName) so the model text is
      // never touched → ⌘S saves byte-identical content. Toggled by `ide:toggle-reader-mode`
      // for the focused editor; re-applied on model swap + content edit while ON.
      const readerCol = editor.createDecorationsCollection([]);
      let readerOn = false;
      const applyReader = (): void => {
        const model = editor.getModel();
        if (!model || !readerOn) {
          readerCol.clear();
          return;
        }
        const ranges = docCommentRanges(model.getLinesContent(), model.getLanguageId());
        readerCol.set(
          ranges.map((r) => ({
            range: new monaco.Range(
              r.startLine + 1,
              1,
              r.endLine + 1,
              model.getLineMaxColumn(r.endLine + 1),
            ),
            options: {
              inlineClassName: "prom-reader-doc",
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          })),
        );
      };
      const onToggleReader = (): void => {
        if (editor !== activeEditor) return;
        readerOn = !readerOn;
        applyReader();
      };
      window.addEventListener("ide:toggle-reader-mode", onToggleReader);
      windowCleanups.current.push(() =>
        window.removeEventListener("ide:toggle-reader-mode", onToggleReader),
      );
      editor.onDidChangeModel(() => applyReader());
      editor.onDidChangeModelContent(() => {
        if (readerOn) applyReader();
      });

      // APP-098: docstring stub (⌘-palette `docs.generateStub`) → resolve the enclosing function
      // via documentSymbol and insert an idiomatic stub as ONE undoable edit. Python goes on the
      // line AFTER the def (body-indented +1); JSDoc goes BEFORE the def at the def's indent.
      const onGenDocstring = (): void => {
        if (editor !== activeEditor) return;
        void (async () => {
          const model = editor.getModel();
          const pos = editor.getPosition();
          if (!model || !pos) return;
          const uri = model.uri.toString();
          const lang = model.getLanguageId();
          const syms = normalizeSymbols(
            await lspRequestForUri(uri, "textDocument/documentSymbol", {}),
          );
          const fn = enclosingFunction(syms, pos.lineNumber - 1, Math.max(0, pos.column - 1));
          if (!fn) return;
          const defLine = fn.selectionRange.start.line + 1; // 1-based def line
          const sigSource = fn.detail || model.getLineContent(defLine);
          const params = parseParamNames(sigSource, lang);
          const stub = buildDocstringStub({
            languageId: lang,
            name: fn.name,
            params,
            returns: true,
          });
          if (stub === null) return;
          const defText = model.getLineContent(defLine);
          const indent = defText.slice(0, defText.length - defText.trimStart().length);
          if (lang === "python") {
            const body = `${indent}    `; // one level in from the def
            const text = `${stub
              .split("\n")
              .map((l) => (l ? body + l : l))
              .join("\n")}\n`;
            const col = model.getLineMaxColumn(defLine);
            editor.executeEdits("docstring-stub", [
              {
                range: new monaco.Range(defLine, col, defLine, col),
                text: `\n${text.replace(/\n$/, "")}`,
                forceMoveMarkers: true,
              },
            ]);
          } else {
            const text = `${stub
              .split("\n")
              .map((l) => indent + l)
              .join("\n")}\n`;
            editor.executeEdits("docstring-stub", [
              { range: new monaco.Range(defLine, 1, defLine, 1), text, forceMoveMarkers: true },
            ]);
          }
          editor.focus();
        })();
      };
      window.addEventListener("ide:generate-docstring", onGenDocstring);
      windowCleanups.current.push(() =>
        window.removeEventListener("ide:generate-docstring", onGenDocstring),
      );

      // re-apply the (same-file) blame to the new model when the editor swaps models
      // (open/restore attaches the file model after the initial empty one).
      editor.onDidChangeModel(() => applyBlameLine());
      // a buffer edit shifts every line below it → the blame is stale; clear the map until
      // the next save re-fetches (never leave annotations pointing at the wrong commit).
      editor.onDidChangeModelContent(() => {
        blameMapRef.current = new Map();
        blameCol.clear();
      });
      // click the trailing annotation (past the line's content end) → open commit detail.
      editor.onMouseUp((e) => {
        if (!useInlineBlameStore.getState().enabled) return;
        const model = editor.getModel();
        const pos = e.target.position;
        if (!model || !pos) return;
        const entry = blameMapRef.current.get(pos.lineNumber);
        if (!entry) return;
        if (
          e.target.type === monaco.editor.MouseTargetType.CONTENT_EMPTY ||
          pos.column >= model.getLineMaxColumn(pos.lineNumber)
        ) {
          window.dispatchEvent(new CustomEvent("ide:show-commit", { detail: { sha: entry.hash } }));
        }
      });
      windowCleanups.current.push(() => {
        blameColRef.current = null;
      });

      windowCleanups.current.push(() => {
        window.removeEventListener("ide:complete-statement", onCompleteStatement);
        window.removeEventListener("ide:smart-enter", onSmartEnter);
        window.removeEventListener("ide:toggle-column-selection", onToggleColumn);
        window.removeEventListener("ide:organize-imports", onOrganize);
        window.removeEventListener("ide:surround-with", onSurround);
        window.removeEventListener("ide:find-usages", onFindUsages);
        window.removeEventListener("ide:refactor", onRefactor);
        window.removeEventListener("ide:inline-values", onInlineValues);
      });
      // caret → breadcrumbs: emit this group's 1-based cursor so the Breadcrumbs bar can
      // compute the containing-symbol trail (filtered by group; no store churn).
      editor.onDidChangeCursorPosition((e) => {
        window.dispatchEvent(
          new CustomEvent("ide:cursor-position", {
            detail: {
              group,
              uri: editor.getModel()?.uri.toString(),
              line: e.position.lineNumber,
              column: e.position.column,
            },
          }),
        );
      });
      setStatus("ready");
    })();
    return () => {
      disposed = true;
      for (const t of lspChangeTimers.current.values()) clearTimeout(t);
      lspChangeTimers.current.clear();
      // Dispose ONLY this group's editor. Do NOT didClose/clear the module-level lspDocs
      // here: it is shared across split groups, so unmounting one split would tear down
      // the other live split's LSP buffers (leap #16c). LSP didClose now happens per-uri
      // in EditorPane's close effect, when a uri truly leaves every group.
      if (activeEditor === editorRef.current) activeEditor = null;
      // the gutter registry subscription outlives editor.dispose() — drop it here.
      glyphUnsubRef.current?.();
      glyphUnsubRef.current = null;
      glyphsRef.current = null;
      for (const off of windowCleanups.current) off();
      windowCleanups.current = [];
      if (flashTimer.current) clearTimeout(flashTimer.current);
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [markDirty, group]);

  // APP-083: fetch inline blame for the ACTIVE file whenever the file / toggle changes,
  // plus on save. Keyed on the active TAB uri (file://), NOT the editor's model uri (which
  // may carry an inmemory scheme) — the annotation is applied by line number regardless.
  useEffect(() => {
    const col = blameColRef.current;
    if (!col || status !== "ready") return;
    let alive = true;
    const fetchBlame = async (): Promise<void> => {
      col.clear();
      blameMapRef.current = new Map();
      const uri = active?.uri;
      if (!inlineBlameEnabled || !uri || !uri.startsWith("file://")) {
        applyBlameLineRef.current();
        return;
      }
      const root = useTabsStore.getState().workspaceRoot;
      if (!root) return;
      const abs = uri.slice("file://".length);
      const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
      const r = await ide()
        ?.gitBlame(root, rel)
        .catch(() => undefined);
      if (!alive || !r?.ok) return;
      blameMapRef.current = blameByLine(r.entries);
      applyBlameLineRef.current();
    };
    void fetchBlame();
    const onSave = (): void => {
      setTimeout(() => void fetchBlame(), 200);
    };
    window.addEventListener("ide:save", onSave);
    return () => {
      alive = false;
      window.removeEventListener("ide:save", onSave);
    };
  }, [active?.uri, inlineBlameEnabled, status]);

  // APP-086: re-apply coverage stripes when the active file changes or a new report lands.
  // `active?.uri` + `coverageReport` are deliberate TRIGGER deps (the body reads neither, it
  // re-runs the ref) — re-applying on a file switch / new report is the whole point.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger deps (see above).
  useEffect(() => {
    if (status !== "ready" || !covColRef.current) return;
    applyCoverageRef.current();
  }, [active?.uri, coverageReport, status]);

  // re-theme the live editor when the app theme changes (mirrors Terminal's xterm
  // re-theme) — re-define from the new tokens + re-select.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    monaco.editor.defineTheme(
      EDITOR_THEME,
      editorTheme(colors, resolvedBase, activeSchemeId) as Parameters<
        typeof monaco.editor.defineTheme
      >[1],
    );
    monaco.editor.setTheme(EDITOR_THEME);
  }, [colors, resolvedBase, activeSchemeId, editorTheme]);

  // live-apply the editor font when the user changes it (Settings → Fonts) — PyCharm
  // applies font changes instantly. updateOptions is per-instance (unlike the global
  // theme define/setTheme above), so each mounted group updates its own editor.
  useEffect(() => {
    editorRef.current?.updateOptions(monacoFontOptions(editorFont));
  }, [editorFont]);

  // render the LSP diagnostics as Monaco markers (inline squiggles + gutter) for every
  // open model. Keying via monaco.Uri.parse canonicalizes the diagnostic uri so it
  // matches the model even when the server emits a percent-encoded form.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const sev = (s: Diagnostic["severity"]): number => {
      switch (s) {
        case 1:
          return monaco.MarkerSeverity.Error;
        case 2:
          return monaco.MarkerSeverity.Warning;
        case 3:
          return monaco.MarkerSeverity.Info;
        default:
          return monaco.MarkerSeverity.Hint;
      }
    };
    for (const [uri, diags] of Object.entries(diagByUri)) {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (!model) continue;
      monaco.editor.setModelMarkers(
        model,
        "lsp",
        diags.map((d) => ({
          startLineNumber: d.range.start.line + 1, // LSP is 0-based, Monaco 1-based
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
          message: d.message,
          severity: sev(d.severity),
          ...(d.source ? { source: d.source } : {}),
        })),
      );
    }
  }, [diagByUri]);

  // run a Monaco editor action by id (e.g. editor.action.formatDocument) when the
  // command palette dispatches `ide:editor-action` — the palette can't reach this
  // editor instance directly, so it goes through a window event. Only the FOCUSED
  // group runs it (every group listens; without the guard a split layout ran the
  // action once per pane). Trigger-only core commands (cursorUndo, the
  // cursorColumnSelect* family) have no IEditorAction — fall through to trigger().
  useEffect(() => {
    const onAction = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      const ed = editorRef.current;
      if (!ed || typeof id !== "string") return;
      if (activeEditor && activeEditor !== ed) return;
      const action = ed.getAction(id);
      if (action) void action.run();
      else ed.trigger("palette", id, null);
    };
    window.addEventListener("ide:editor-action", onAction);
    return () => window.removeEventListener("ide:editor-action", onAction);
  }, []);

  // APP-075: Go-to-super / Related-symbol — run the LSP-at-caret flow on the FOCUSED editor.
  useEffect(() => {
    const ed = editorRef.current;
    const flash = (m: string): void => flashRef.current(m);
    const onSuper = (): void => {
      if (ed && (!activeEditor || activeEditor === ed)) void runGoToSuper(ed, flash);
    };
    const onRelated = (): void => {
      if (ed && (!activeEditor || activeEditor === ed)) void runRelatedSymbol(ed, flash);
    };
    window.addEventListener("ide:go-to-super", onSuper);
    window.addEventListener("ide:related-symbol", onRelated);
    return () => {
      window.removeEventListener("ide:go-to-super", onSuper);
      window.removeEventListener("ide:related-symbol", onRelated);
    };
  }, []);

  // APP-078: a server→client workspace/applyEdit relayed here — apply the WorkspaceEdit (open
  // models undoably via pushEditOperations; closed files via fsRead+apply+fsWrite), then ACK so
  // the server's request settles. Fail-closed: any error → applied:false (never a dangling id).
  useEffect(() => {
    const onApply = (e: Event): void => {
      const d = (
        e as CustomEvent<{
          serverId: string;
          workspaceRoot: string;
          requestId: number | string;
          params: unknown;
        }>
      ).detail;
      const api = ide();
      if (!d || !api) return;
      void (async () => {
        let applied = false;
        try {
          const edit = (d.params as { edit?: unknown } | undefined)?.edit;
          const files = normalizeWorkspaceEdit(edit);
          const monaco = files.length > 0 ? await loadMonaco() : null;
          if (files.length > 0 && monaco) {
            for (const f of files) {
              const model = monaco.editor.getModel(monaco.Uri.parse(f.uri));
              if (model && !model.isDisposed()) {
                model.pushEditOperations(
                  null,
                  f.edits.map((ed) => ({
                    range: new monaco.Range(
                      ed.range.start.line + 1,
                      ed.range.start.character + 1,
                      ed.range.end.line + 1,
                      ed.range.end.character + 1,
                    ),
                    text: ed.newText,
                  })),
                  () => null,
                );
              } else {
                const read = await api.fsRead(f.uri).catch(() => undefined);
                if (read?.ok && typeof read.text === "string") {
                  await api
                    .fsWrite(f.uri, applyTextEdits(read.text, f.edits))
                    .catch(() => undefined);
                }
              }
            }
            applied = true;
          }
        } catch {
          applied = false;
        }
        await api
          .lspApplyEditResult(d.serverId, d.workspaceRoot, d.requestId, applied)
          .catch(() => {});
      })();
    };
    window.addEventListener("ide:apply-workspace-edit", onApply);
    return () => window.removeEventListener("ide:apply-workspace-edit", onApply);
  }, []);

  // reveal a 1-based line/column in the focused editor (Outline / breadcrumbs jump).
  useEffect(() => {
    const onReveal = (e: Event): void => {
      const d = (e as CustomEvent<{ line?: number; column?: number }>).detail;
      const ed = activeEditor;
      if (!ed || !d || typeof d.line !== "number") return;
      ed.revealLineInCenter(d.line);
      ed.setPosition({ lineNumber: d.line, column: typeof d.column === "number" ? d.column : 1 });
      ed.focus();
    };
    window.addEventListener("ide:reveal-position", onReveal);
    return () => window.removeEventListener("ide:reveal-position", onReveal);
  }, []);

  // paste-from-history (⌘⇧V): insert a chosen ring entry at EVERY caret of the
  // focused editor (one edit per selection in a single undo step — pasting via the
  // DOM would only hit the primary caret). The pasted entry then floats back to the
  // top of the ring (push dedupes), so repeated ⌘⇧V cycles naturally.
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      const ed = activeEditor;
      if (ed !== editorRef.current) return; // only the focused group inserts
      const sels = ed?.getSelections();
      if (!ed || !sels || sels.length === 0 || typeof text !== "string") return;
      ed.executeEdits(
        "clipboard-history",
        sels.map((range) => ({ range, text, forceMoveMarkers: true })),
      );
      useClipboardStore.getState().push(text);
      ed.focus();
    };
    window.addEventListener("ide:insert-text", onInsert);
    return () => window.removeEventListener("ide:insert-text", onInsert);
  }, []);

  // model-swap on active-tab change: load text via the fs host, set the model + lang.
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor || !active) return;
    // a notebook tab is handled by the NotebookContainer overlay — do NOT create a
    // Monaco model for it (a Cmd-S would otherwise clobber the .ipynb with raw JSON).
    if (isNotebook) {
      setReadError(null);
      editor.setModel(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const api = ide();
      const existing = monaco.editor.getModel(modelUri(monaco, active.uri));
      let model = existing ?? null;
      // APP-067: a buffer captured before a crash, consumed once on the first open of its uri.
      const recovered = existing
        ? undefined
        : useDirtyRecoveryStore.getState().recovered(active.uri);
      if (!model && active.uri.startsWith("scratch:")) {
        // scratch buffer: a throwaway in-memory model (no fs read/write, no LSP). If unsaved
        // scratch content was recovered, restore it MODIFIED (APP-067).
        setReadError(null);
        model = ensureModel(monaco, active.uri, recovered ?? "", active.languageId || "plaintext");
        if (typeof recovered === "string") markDirty(active.uri, true);
      } else if (!model) {
        const res = await api?.fsRead(active.uri);
        if (cancelled) return;
        if (!res || !res.ok || res.text === undefined) {
          if (typeof recovered === "string") {
            // APP-067: the file vanished while closed but we have unsaved work — reopen it as
            // a MODIFIED buffer with the recovered content (a manual save re-creates the file;
            // we NEVER auto-write it back). Beats erroring and losing typed work.
            setReadError(null);
            const lang = active.languageId || detectLanguage(active.uri);
            model = ensureModel(monaco, active.uri, recovered, lang);
            markDirty(active.uri, true);
          } else {
            // Read FAILED. Do NOT create an editable empty model — with Cmd-S wired, a
            // subsequent save would clobber the real file with "". Surface the error and
            // leave the editor model-less (a re-select retries the read).
            setReadError(res?.error ?? "could not read file");
            glyphsRef.current?.clear(); // release glyphs on the outgoing model (APP-011)
            editor.setModel(null);
            return;
          }
        } else {
          setReadError(null);
          const lang = active.languageId || detectLanguage(active.uri);
          // recovered unsaved edits win over the on-disk bytes (open MODIFIED); consumed once.
          if (typeof recovered === "string" && recovered !== res.text) {
            model = ensureModel(monaco, active.uri, recovered, lang);
            markDirty(active.uri, true);
          } else {
            model = ensureModel(monaco, active.uri, res.text, lang);
          }
        }
      } else {
        setReadError(null);
      }
      if (cancelled || !model) return;
      // glyphs bind to the MODEL: clear while the OLD model is still attached, swap,
      // then re-sync for the new file (APP-011) — else file A's glyphs bleed into B.
      glyphsRef.current?.clear();
      editor.setModel(model);
      glyphsRef.current?.sync();
      // emit the caret so the Breadcrumbs bar refreshes on a tab switch to an already-
      // loaded model (onDidChangeCursorPosition may not fire when the position is kept).
      const pos = editor.getPosition();
      window.dispatchEvent(
        new CustomEvent("ide:cursor-position", {
          detail: { group, uri: active.uri, line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 },
        }),
      );
      // large-file guard (§3.1): read-only, the model-swap already skipped LSP.
      editor.updateOptions({ readOnly: active.large });
      // apply the file's `.editorconfig` indent + EOL to the model on OPEN (APP-019) —
      // fail-soft; scratch:/large buffers are skipped (no config walk, no LSP). A setEOL
      // that changes the EOL fires onDidChangeModelContent → a SPURIOUS dirty dot on a
      // freshly-opened file the user never edited; clear it back if the open didn't
      // otherwise dirty the buffer (a still-clean tab stays clean).
      if (!active.large && !active.uri.startsWith("scratch:")) {
        const openUri = active.uri;
        void resolveEditorConfigForUri(openUri)
          .then((cfg) => {
            if (cancelled || Object.keys(cfg).length === 0 || editor.getModel() !== model) return;
            const wasDirty = tabsOf(useTabsStore.getState().tabs, group).some(
              (t) => t.uri === openUri && t.dirty,
            );
            applyEditorConfigToModel(monaco, model, cfg);
            if (!wasDirty) markDirty(openUri, false);
          })
          .catch(() => {});
      }
      // ensure the LSP server exists for a known language (the editor proxies LSP, §4),
      // then OPEN the document on it (textDocument/didOpen) so the server has a buffer
      // to analyze — this is what makes diagnostics + hover + completion actually work.
      if (
        !active.large &&
        workspaceRoot &&
        hasKnownLsp(active.languageId) &&
        !active.uri.startsWith("scratch:")
      ) {
        const lang = active.languageId || detectLanguage(active.uri);
        const ens = await api?.lspEnsure(lang, workspaceRoot);
        if (!cancelled && ens?.ok && ens.serverId && !lspDocs.has(active.uri)) {
          lspDocs.set(active.uri, { serverId: ens.serverId, version: 1 });
          api?.lspDidOpen(ens.serverId, workspaceRoot, active.uri, lang, model.getValue(), 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, workspaceRoot, group, markDirty, isNotebook]);

  return (
    <div style={{ position: "relative", height: "100%", minHeight: 0 }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} aria-label="editor" />
      {isNotebook && active && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: Z.raise,
            background: "var(--bg-app)",
            overflow: "auto",
          }}
        >
          <NotebookContainer uri={active.uri} />
        </div>
      )}
      {formatStatus && (
        // biome-ignore lint/a11y/useSemanticElements: role=status is the correct aria-live region for a transient toast; no dedicated semantic element exists
        <div
          role="status"
          style={{
            position: "absolute",
            bottom: 8,
            right: 12,
            zIndex: Z.raise,
            padding: "3px 10px",
            borderRadius: "var(--radius-sm, 4px)",
            background: "var(--bg-surface-2)",
            border: "1px solid var(--border-strong)",
            color: "var(--text-secondary)",
            fontSize: "0.72rem",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          {formatStatus}
        </div>
      )}
      {status !== "ready" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-secondary)",
            fontSize: "0.85rem",
            background: "var(--bg-surface)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            padding: 16,
            textAlign: "center",
          }}
        >
          {status === "loading"
            ? "Loading editor…"
            : active
              ? `Monaco unavailable — ${active.name} shown read-only via fs host.`
              : "No file open."}
        </div>
      )}
      {status === "ready" && readError && (
        <div
          role="alert"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--danger)",
            fontSize: "0.85rem",
            background: "var(--bg-surface)",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            padding: 16,
            textAlign: "center",
          }}
        >
          Could not open {active?.name ?? "file"}: {readError}
        </div>
      )}
    </div>
  );
}

/** A single group's tab bar (multi-tab, preview = italic, dirty dot, close). */
function TabBar({ group }: { group: number }): ReactElement {
  const tabs = useTabsStore((s) => s.tabs);
  const activate = useTabsStore((s) => s.activate);
  const close = useTabsStore((s) => s.close);
  const split = useTabsStore((s) => s.split);
  const groupTabs = tabsOf(tabs, group);
  const active = activeDoc(tabs, group);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        flex: "none",
        // §2.4: the strip sits on --bg-surface; the ACTIVE tab drops to the editor's own
        // ground (--bg-inset) so the tab reads as continuous with the code below it.
        borderBottom: "1px solid var(--border-header)",
        background: "var(--bg-surface)",
      }}
    >
      <div
        role="tablist"
        aria-label={`editor group ${group}`}
        style={{ display: "flex", gap: 2, flex: 1, minWidth: 0, overflowX: "auto" }}
      >
        {groupTabs.map((t) => {
          const isActive = active?.uri === t.uri;
          return (
            <div
              key={t.uri}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => activate(t.uri)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") activate(t.uri);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                cursor: "pointer",
                // §2.4: mono 12px tabs — a filename is code, not prose.
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontStyle: t.preview ? "italic" : "normal",
                color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                background: isActive ? "var(--bg-inset)" : "transparent",
                borderTop: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
                borderRight: "1px solid var(--border-header)",
                whiteSpace: "nowrap",
              }}
            >
              <span>{t.name}</span>
              {t.dirty && (
                <span aria-label="unsaved" style={{ color: "var(--accent)" }}>
                  ●
                </span>
              )}
              <button
                type="button"
                aria-label={`close ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // guard an unsaved buffer (leap #16a) — close() drops dirty edits silently.
                  if (
                    t.dirty &&
                    !window.confirm(`${t.name} has unsaved changes. Close without saving?`)
                  )
                    return;
                  /**
                   * Discarding a buffer must drop its CRASH-RECOVERY copy too.
                   *
                   * The APP-067 record is written on every keystroke and cleared on exactly one
                   * condition: a successful save. So "Close without saving" left it behind, and
                   * reopening the file preferred that text over the bytes on disk and marked the
                   * tab dirty — the edit the user explicitly threw away came back, shadowing the
                   * real file, and a Cmd-S then wrote it. It survived a restart too, because the
                   * blob is persisted to localStorage.
                   *
                   * Only when the uri is leaving the LAST group: with a split still showing the
                   * file, the buffer is still open and its recovery copy still earns its keep.
                   */
                  const lastRow = tabs.docs.filter((d) => d.uri === t.uri).length <= 1;
                  if (lastRow) useDirtyRecoveryStore.getState().clear(t.uri);
                  // pass the GROUP: a split shares the uri across panes, so closing by uri
                  // alone would take the other pane's tab with it.
                  close(t.uri, t.group);
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {/* §2.4: the problems / checks counters live to the RIGHT of the tab strip — the
          same diagnostics store the StatusBar and the Problems panel read, so the three
          can never disagree. "checks" is the count of diagnostics-free open files. */}
      <TabStripCounters />
      {groupTabs.length > 0 && (
        <button
          type="button"
          aria-label="Split editor right"
          title="Split editor right"
          onClick={() => split()}
          style={{
            flexShrink: 0,
            background: "transparent",
            border: "none",
            borderLeft: "1px solid var(--border-header)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "0.95rem",
            padding: "0 10px",
          }}
        >
          ◫
        </button>
      )}
    </div>
  );
}

/** The right-of-tabs diagnostics readout (§2.4): `⚠ n` warnings + `✓ n` clean files. */
function TabStripCounters(): ReactElement | null {
  const byUri = useDiagnosticsStore((s) => s.byUri);
  const docs = useTabsStore((s) => s.tabs.docs);
  const counts = countDiagnostics(byUri);
  const problems = counts.errors + counts.warnings;
  const clean = docs.filter((d) => (byUri[d.uri]?.length ?? 0) === 0).length;
  if (problems === 0 && clean === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexShrink: 0,
        paddingInline: 12,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      {problems > 0 && (
        <span style={{ color: counts.errors > 0 ? "var(--danger)" : "var(--warn)" }}>
          ⚠ {problems}
        </span>
      )}
      {clean > 0 && <span style={{ color: "var(--ok)" }}>✓ {clean}</span>}
    </div>
  );
}

/** Hosts the ⌘J Quick Doc popup (APP-098): on `ide:quick-doc`, run textDocument/hover at the
 *  caret, structure it via `hoverToDoc`, and pin a formatted, SANITIZED popup (rendered through
 *  the <Markdown> escape path — never dangerouslySetInnerHTML). Esc/backdrop close + restore
 *  focus to the editor; doc links open only via an allowlisted host through the main scheme
 *  gate (window.open → openExternalSafe), blocked hosts are inert copy-only. */
function QuickDocHost(): ReactElement | null {
  const [state, setState] = useState<{ editor: IStandaloneCodeEditor; doc: QuickDoc } | null>(null);

  useEffect(() => {
    const onOpen = async (): Promise<void> => {
      const editor = activeEditor;
      const model = editor?.getModel();
      const pos = editor?.getPosition();
      if (!editor || !model || !pos) return;
      const hover = (await lspRequestForUri(model.uri.toString(), "textDocument/hover", {
        position: toLspPosition(pos),
      })) as { contents?: unknown } | null;
      const doc = hoverToDoc(hover?.contents ?? null);
      if (!doc) return; // no docs at the caret → no popup
      setState({ editor, doc });
    };
    const handler = (): void => void onOpen();
    window.addEventListener("ide:quick-doc", handler);
    return () => window.removeEventListener("ide:quick-doc", handler);
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        const ed = state.editor;
        setState(null);
        ed.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  if (!state) return null;
  const { doc, editor } = state;
  const close = (): void => {
    setState(null);
    editor.focus();
  };
  const body = [doc.signature ? `\`\`\`\n${doc.signature}\n\`\`\`` : "", doc.markdown]
    .filter(Boolean)
    .join("\n\n");

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is click-to-dismiss; Esc is handled by the window keydown listener above.
    <div
      onClick={close}
      style={{ position: "absolute", inset: 0, zIndex: Z.raise }}
      role="presentation"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a role="dialog" div matches the other EditorPane overlay hosts; a native <dialog> needs showModal() plumbing. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: onClick only stops backdrop dismiss; Esc closes via the window keydown listener. */}
      <div
        role="dialog"
        aria-label="Quick Documentation"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 36,
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(620px, 82%)",
          maxHeight: "60%",
          overflow: "auto",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          boxShadow: "var(--elevation-e3)",
          padding: 10,
          fontSize: "0.82rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 6,
            color: "var(--text-secondary)",
            fontSize: "0.7rem",
          }}
        >
          <span>Quick Documentation</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            aria-label="close quick doc"
            onClick={close}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            ✕ Esc
          </button>
        </div>
        <Markdown source={body || "_No documentation._"} />
        {doc.links.length > 0 && (
          <div
            style={{
              marginTop: 8,
              paddingTop: 6,
              borderTop: "1px solid var(--border-subtle)",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {doc.links.map((l) =>
              l.allowed ? (
                <button
                  key={l.url}
                  type="button"
                  onClick={() => window.open(l.url, "_blank", "noopener")}
                  title={l.url}
                  style={{
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontSize: "0.74rem",
                    padding: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                    whiteSpace: "nowrap",
                  }}
                >
                  ↗ {l.url}
                </button>
              ) : (
                <div
                  key={l.url}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.74rem" }}
                >
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                      whiteSpace: "nowrap",
                    }}
                    title={`${l.url} (host not allowlisted — copy to open manually)`}
                  >
                    {l.url}
                  </span>
                  <button
                    type="button"
                    aria-label="copy link"
                    onClick={() => void navigator.clipboard?.writeText(l.url)}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 4,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontSize: "0.66rem",
                      padding: "0 5px",
                    }}
                  >
                    copy
                  </button>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Hosts the ⌘F12 File Structure popup (APP-097): on `ide:file-structure`, fetch the focused
 *  editor file's documentSymbol tree, open the filter/jump popup, reveal the chosen member,
 *  and restore focus to the editor on close. */
function FileStructureHost(): ReactElement | null {
  const [state, setState] = useState<{
    editor: IStandaloneCodeEditor;
    symbols: NormalizedSymbol[];
  } | null>(null);

  useEffect(() => {
    const onOpen = async (): Promise<void> => {
      const editor = activeEditor;
      const uri = editor?.getModel()?.uri.toString();
      if (!editor || !uri) return;
      const raw = await lspRequestForUri(uri, "textDocument/documentSymbol", {});
      setState({ editor, symbols: normalizeSymbols(raw) });
    };
    const handler = (): void => void onOpen();
    window.addEventListener("ide:file-structure", handler);
    return () => window.removeEventListener("ide:file-structure", handler);
  }, []);

  if (!state) return null;
  return (
    <FileStructurePopup
      symbols={state.symbols}
      onSelect={(sym) =>
        window.dispatchEvent(
          new CustomEvent("ide:reveal-position", {
            detail: {
              line: sym.selectionRange.start.line + 1,
              column: sym.selectionRange.start.character + 1,
            },
          }),
        )
      }
      onClose={() => {
        const ed = state.editor;
        setState(null);
        ed.focus(); // restore focus to Monaco (APP-100 a11y: restore-on-close)
      }}
    />
  );
}

/** Hosts the Cmd-I inline-edit overlay (#11): on `ide:inline-edit`, capture the focused
 *  editor's selection (or current line) + a surrounding context window, stream a
 *  replacement via the AI client, and apply it as ONE undo step via executeEdits. */
function InlineEditHost(): ReactElement | null {
  const { active, neverSendToCloud } = useActiveEndpoint();
  const [req, setReq] = useState<{
    editor: IStandaloneCodeEditor;
    range: IRange;
    selection: string;
    context: string;
    languageId: string;
  } | null>(null);

  useEffect(() => {
    const onOpen = (): void => {
      const editor = activeEditor;
      const model = editor?.getModel();
      if (!editor || !model) return;
      const sel = editor.getSelection();
      // a non-empty selection is the target; an empty caret operates on the whole line.
      const range: IRange =
        sel && !sel.isEmpty()
          ? {
              startLineNumber: sel.startLineNumber,
              startColumn: sel.startColumn,
              endLineNumber: sel.endLineNumber,
              endColumn: sel.endColumn,
            }
          : (() => {
              const line = sel?.startLineNumber ?? editor.getPosition()?.lineNumber ?? 1;
              return {
                startLineNumber: line,
                startColumn: 1,
                endLineNumber: line,
                endColumn: model.getLineMaxColumn(line),
              };
            })();
      const selection = model.getValueInRange(range);
      const ctxStart = Math.max(1, range.startLineNumber - 30);
      const ctxEnd = Math.min(model.getLineCount(), range.endLineNumber + 30);
      const context = model.getValueInRange({
        startLineNumber: ctxStart,
        startColumn: 1,
        endLineNumber: ctxEnd,
        endColumn: model.getLineMaxColumn(ctxEnd),
      });
      setReq({ editor, range, selection, context, languageId: model.getLanguageId() });
    };
    window.addEventListener("ide:inline-edit", onOpen);
    return () => window.removeEventListener("ide:inline-edit", onOpen);
  }, []);

  if (!req) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 36,
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(560px, 80%)",
        zIndex: Z.raise,
      }}
    >
      <InlineEdit
        selection={req.selection}
        context={req.context}
        languageId={req.languageId}
        endpoint={active}
        neverSendToCloud={neverSendToCloud}
        onAccept={(replacement) => {
          // one undo step; the buffer is persisted via Cmd-S like any normal edit (§7.1).
          req.editor.executeEdits("inline-edit", [{ range: req.range, text: replacement }]);
          req.editor.focus();
          setReq(null);
        }}
        onClose={() => setReq(null)}
      />
    </div>
  );
}

/** The full editor surface: every split group, each with a tab bar + one Monaco. */
/** APP-079: the editor-side breakpoint predicate editor. A right-click on a glyph-
 *  margin line dispatches `ide:edit-breakpoint`; this floating panel edits that line's
 *  condition / hit count / log message into the shared store (setting a predicate on a
 *  bare line CREATES the breakpoint). One instance, mounted at the EditorPane root. */
function bpEditInput(
  label: string,
  placeholder: string,
  initial: string,
  onApply: (v: string) => void,
): ReactElement {
  return (
    <input
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={label}
      onBlur={(e) => onApply(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{
        background: "var(--bg-surface-2)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        padding: "3px 6px",
        fontSize: "0.72rem",
        fontFamily: "var(--font-mono, monospace)",
        width: 260,
      }}
    />
  );
}

function BreakpointEditHost(): ReactElement | null {
  const [edit, setEdit] = useState<{ path: string; line: number; x: number; y: number } | null>(
    null,
  );
  const byPath = useBreakpointStore((s) => s.byPath);
  useEffect(() => {
    const onEdit = (e: Event): void => {
      const d = (e as CustomEvent).detail as
        | { path?: unknown; line?: unknown; x?: unknown; y?: unknown }
        | undefined;
      if (!d || typeof d.path !== "string" || typeof d.line !== "number") return;
      setEdit({
        path: d.path,
        line: d.line,
        x: typeof d.x === "number" ? d.x : 120,
        y: typeof d.y === "number" ? d.y : 120,
      });
    };
    window.addEventListener("ide:edit-breakpoint", onEdit);
    return () => window.removeEventListener("ide:edit-breakpoint", onEdit);
  }, []);
  if (!edit) return null;
  const bp: Breakpoint | undefined = (byPath[edit.path] ?? []).find((b) => b.line === edit.line);
  const close = (): void => setEdit(null);
  const set = (patch: { condition?: string; hitCondition?: string; logMessage?: string }): void =>
    useBreakpointStore.getState().update(edit.path, edit.line, patch);
  // clamp within the viewport so the panel never renders off-screen.
  const { x: left, y: top } = clampToViewport(edit.x, edit.y, 300, 220);
  return (
    // full-screen click-away/Escape backdrop (presentation) — the same modal pattern
    // ClipboardHistory/CommandPalette use; the panel floats at the right-clicked line.
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
      style={{ position: "fixed", inset: 0, zIndex: Z.dropdown, background: "transparent" }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: role=dialog on a div matches the CommandPalette modal; we manage focus/escape ourselves rather than use <dialog> */}
      <div
        role="dialog"
        aria-label={`breakpoint ${edit.path}:${edit.line}`}
        style={{
          position: "fixed",
          left,
          top,
          zIndex: Z.dropdown,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: 10,
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 6,
          boxShadow: "var(--elevation-e2, 0 8px 24px rgba(0,0,0,0.4))",
        }}
      >
        <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
          Breakpoint · line {edit.line}
          {bp && isLogpoint(bp) ? " · logpoint" : ""}
        </div>
        {bpEditInput("breakpoint condition", "condition — e.g. x > 3", bp?.condition ?? "", (v) =>
          set({ condition: v }),
        )}
        {bpEditInput(
          "breakpoint hit count",
          "hit count — e.g. 5, >5, %2",
          bp?.hitCondition ?? "",
          (v) => set({ hitCondition: v }),
        )}
        {bpEditInput(
          "breakpoint log message",
          "log message — {expr} (logpoint, no pause)",
          bp?.logMessage ?? "",
          (v) => set({ logMessage: v }),
        )}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {bp && (
            <button
              type="button"
              onClick={() => {
                useBreakpointStore.getState().remove(edit.path, edit.line);
                close();
              }}
              style={{
                background: "transparent",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                color: "var(--danger)",
                cursor: "pointer",
                fontSize: "0.7rem",
                padding: "2px 8px",
              }}
            >
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={close}
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "0.7rem",
              padding: "2px 8px",
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditorPane(): ReactElement {
  const tabs = useTabsStore((s) => s.tabs);
  const diagClear = useDiagnosticsStore((s) => s.clear);
  // keep the module-level ghost-text config in sync with the active endpoint + opt-in (#4).
  const { active, neverSendToCloud } = useActiveEndpoint();
  const ghostText = useAiSessionStore((s) => s.ghostText);
  useEffect(() => {
    ghostConfig = { endpoint: active, neverSendToCloud, enabled: ghostText };
  }, [active, neverSendToCloud, ghostText]);
  // hydrate the format-on-save policy cache from the settings store (APP-019) so the
  // Cmd-S handler can read it synchronously; re-hydrate when the workspace changes.
  const formatWorkspaceRoot = useTabsStore((s) => s.workspaceRoot);
  useEffect(() => {
    void useFormatStore.getState().hydrate(formatWorkspaceRoot ?? undefined);
  }, [formatWorkspaceRoot]);
  const prevUrisRef = useRef<Set<string>>(new Set());
  const groups = [...new Set(tabs.docs.map((d) => d.group))].sort((a, b) => a - b);
  const view = groups.length === 0 ? [0] : groups;

  // tab-close cleanup: when a uri leaves ALL groups, dispose its Monaco model (memory
  // leak — close() only ran the pure reducer) and clear its diagnostics (stale Problems
  // rows for a closed file). A uri still open in another split group is kept.
  useEffect(() => {
    const openUris = new Set(tabs.docs.map((d) => d.uri));
    const closed = [...prevUrisRef.current].filter((u) => !openUris.has(u));
    prevUrisRef.current = openUris;
    if (closed.length === 0) return;
    void (async () => {
      const monaco = await loadMonaco();
      const wsRoot = useTabsStore.getState().workspaceRoot;
      for (const uri of closed) {
        diagClear(uri);
        monaco?.editor.getModel(monaco.Uri.parse(uri))?.dispose();
        // a uri that left EVERY group is truly closed → release the LSP server's buffer
        // (textDocument/didClose) and drop our tracking (leap #16c — moved here from the
        // per-group unmount so a split collapse no longer kills the other split's docs).
        const doc = lspDocs.get(uri);
        if (doc && wsRoot) ide()?.lspDidClose(doc.serverId, wsRoot, uri);
        lspDocs.delete(uri);
      }
    })();
  }, [tabs.docs, diagClear]);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, position: "relative" }}>
      <InlineEditHost />
      <RefactorHost />
      <BreakpointEditHost />
      <FileStructureHost />
      <QuickDocHost />
      {view.map((g) => (
        <div
          key={g}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid var(--border-subtle)",
          }}
        >
          <TabBar group={g} />
          <Breadcrumbs group={g} />
          <div style={{ flex: 1, minHeight: 0 }}>
            <EditorGroup group={g} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default EditorPane;
