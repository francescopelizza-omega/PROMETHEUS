/**
 * workspace-io.ts — the ONE seam between the agent's file tools and the editor's filesystem.
 *
 * THE DESIGN DECISION THIS FILE EXISTS FOR
 * ----------------------------------------
 * The extension must not touch `node:fs`. Every read goes through `vscode.workspace.fs` and
 * every mutation goes through a single `vscode.WorkspaceEdit` handed to
 * `vscode.workspace.applyEdit`. That is not stylistic:
 *
 *   - **`node:fs` writes are invisible to VS Code.** A raw `writeFileSync` over a file the
 *     user has open in a dirty editor is silently discarded the moment they hit save — the
 *     editor's in-memory buffer wins. The agent would report success and the change would
 *     evaporate. `applyEdit` mutates the BUFFER, so an open file and a closed file behave the
 *     same way.
 *   - **`applyEdit` lands on the undo stack.** One `WorkspaceEdit` is one undo entry, so a
 *     ten-file refactor is undone by one Ctrl+Z instead of ten (or, with raw fs, zero). This
 *     is why `applyEdits` takes an ARRAY and applies it as ONE edit rather than looping.
 *   - **`workspace.fs` honours FileSystemProviders.** Remote-SSH, dev containers, WSL and
 *     virtual filesystems are all real VS Code deployments where the workspace is not on the
 *     extension host's local disk at all. `node:fs` reads the wrong machine there; it does not
 *     merely read it slower.
 *
 * SHAPE: the same discipline as the desktop pane's `core-agent.ts` — the tool DISPATCH
 * (`tool-runner.ts`) is pure and talks to this INTERFACE, and only `createVsCodeWorkspaceIo`
 * below imports `vscode`. That is what lets the dispatch be unit-tested against an in-memory
 * `WorkspaceIo` while the shipped path is entirely VS Code's own APIs.
 */

import * as vscode from "vscode";

/** An entry as the agent's `list_dir` wants to see it. */
export interface DirEntry {
  name: string;
  kind: "file" | "directory" | "other";
}

/**
 * A mutation, expressed declaratively so the whole batch can become ONE `WorkspaceEdit`.
 *
 * Declarative rather than a set of `do it now` methods for exactly one reason: `apply_patch`
 * edits N files and must be a single undo entry. A method-per-mutation interface cannot
 * express that — each call would apply separately.
 */
export type FileMutation =
  | { kind: "replace"; path: string; spans: { oldText: string; newText: string }[] }
  | { kind: "create"; path: string; content: string; overwrite: boolean }
  | { kind: "delete"; path: string; recursive: boolean }
  | { kind: "rename"; from: string; to: string; overwrite: boolean }
  | { kind: "mkdir"; path: string };

export interface WorkspaceIo {
  /** Absolute path of the workspace root, or undefined when no folder is open. */
  rootPath(): string | undefined;
  /** UTF-8 read. Rejects when missing. */
  readFile(rel: string): Promise<string>;
  stat(rel: string): Promise<{ kind: "file" | "directory" | "other"; size: number } | null>;
  readDirectory(rel: string): Promise<DirEntry[]>;
  /** Workspace-relative paths matching a glob, capped. */
  findFiles(glob: string, maxResults: number): Promise<string[]>;
  /** Apply the whole batch as ONE undoable workspace edit. Resolves false if VS Code refused. */
  applyMutations(muts: readonly FileMutation[]): Promise<{ ok: boolean; error?: string }>;
}

/* ── path containment ────────────────────────────────────────────────────────*/

/**
 * Normalize a model-supplied path to workspace-relative form, or null if it escapes.
 *
 * Absolute paths are REJECTED rather than relativized. A model emits `/src/index.ts` meaning
 * "src/index.ts inside the project" constantly, and silently rewriting it is how an agent ends
 * up editing a same-named file in the wrong tree. Dot segments resolve BEFORE the containment
 * test so `a/../../etc/passwd` is caught rather than normalized into `etc/passwd` afterwards.
 *
 * This is a LEXICAL guard only; it is the first of two. `resolve()` below re-joins against the
 * root Uri, so even a path that slipped through cannot address anything outside it.
 */
export function normalizeWorkspaceRelPath(p: string): string | null {
  if (!p || p.startsWith("file://") || p.startsWith("~")) return null;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p)) return null;
  const out: string[] = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.length === 0 ? null : out.join("/");
}

/* ── the VS Code implementation ──────────────────────────────────────────────*/

const enc = new TextEncoder();
const dec = new TextDecoder();

function kindOf(t: vscode.FileType): "file" | "directory" | "other" {
  if ((t & vscode.FileType.Directory) !== 0) return "directory";
  if ((t & vscode.FileType.File) !== 0) return "file";
  return "other";
}

/**
 * The real IO, backed entirely by `vscode.workspace.*`.
 *
 * `folder` is captured once at construction. Multi-root workspaces are SCOPED TO THE FIRST
 * FOLDER — see the extension README's "scoped out" list. Guessing which root a bare relative
 * path belongs to is a real ambiguity, and picking wrong means editing the wrong project.
 */
export function createVsCodeWorkspaceIo(folder: vscode.WorkspaceFolder): WorkspaceIo {
  const root = folder.uri;

  const resolve = (rel: string): vscode.Uri => vscode.Uri.joinPath(root, rel);

  return {
    rootPath: () => root.fsPath,

    async readFile(rel) {
      const bytes = await vscode.workspace.fs.readFile(resolve(rel));
      return dec.decode(bytes);
    },

    async stat(rel) {
      try {
        const s = await vscode.workspace.fs.stat(resolve(rel));
        return { kind: kindOf(s.type), size: s.size };
      } catch {
        return null;
      }
    },

    async readDirectory(rel) {
      const entries = await vscode.workspace.fs.readDirectory(resolve(rel));
      return entries.map(([name, type]) => ({ name, kind: kindOf(type) }));
    },

    async findFiles(glob, maxResults) {
      // Scoped with a RelativePattern so the search cannot wander outside the folder, and
      // excluding node_modules by default because an unfiltered `**/*` in a real repo returns
      // tens of thousands of vendored files and buries whatever the model was looking for.
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, glob),
        "**/node_modules/**",
        maxResults,
      );
      return uris.map((u) => relativeTo(root, u)).filter((p): p is string => p !== null);
    },

    async applyMutations(muts) {
      const edit = new vscode.WorkspaceEdit();
      // `mkdir` has no WorkspaceEdit representation (VS Code models directories only
      // implicitly, via the files inside them), so it is collected and run through
      // `fs.createDirectory` AFTER the edit. Creating an empty directory destroys nothing, so
      // it being outside the undo entry costs nothing either.
      const mkdirs: vscode.Uri[] = [];

      for (const m of muts) {
        switch (m.kind) {
          case "replace": {
            const uri = resolve(m.path);
            // Opening the document is what makes this a real TEXT edit: `positionAt` maps the
            // exact-match offset to a Position, and the edit then applies to the open buffer if
            // the user has the file open. Reading bytes and rewriting the whole file instead
            // would clobber unsaved changes and produce a whole-file diff for a two-line hunk.
            const doc = await vscode.workspace.openTextDocument(uri);
            const text = doc.getText();
            // Offsets are computed against ONE immutable snapshot and applied together, so a
            // hunk's position is never shifted by an earlier hunk in the same call.
            let cursor = 0;
            for (const span of m.spans) {
              const at = text.indexOf(span.oldText, cursor);
              if (at === -1) {
                return {
                  ok: false,
                  error: `no exact match in ${m.path} for: ${preview(span.oldText)}`,
                };
              }
              if (text.indexOf(span.oldText, at + 1) !== -1 && span.oldText.trim().length < 40) {
                return {
                  ok: false,
                  error: `the pre-image for ${m.path} matches more than one place — include more surrounding context: ${preview(span.oldText)}`,
                };
              }
              edit.replace(
                uri,
                new vscode.Range(doc.positionAt(at), doc.positionAt(at + span.oldText.length)),
                span.newText,
              );
              cursor = at + span.oldText.length;
            }
            break;
          }
          case "create": {
            const uri = resolve(m.path);
            // `ignoreIfExists` + a follow-up full replace is how an OVERWRITE stays one undo
            // step. `overwrite: true` on createFile discards the old content outside the undo
            // stack in some VS Code versions, so the content is written as a text edit instead.
            edit.createFile(uri, { ignoreIfExists: true, contents: enc.encode("") });
            /**
             * The replace range must come from the BUFFER when one exists, not from disk.
             *
             * This read the file with `vscode.workspace.fs.readFile` and built `fullRange` from
             * those bytes, then applied the edit to the open TEXT DOCUMENT. For a file the user
             * has open with unsaved changes the two disagree, so the range covered only as much
             * text as the on-disk version had, and the tail of their buffer survived: the file
             * became `<new content><leftover of the dirty buffer>` while the tool reported
             * `ok: true`. The reverse case was worse — unreadable on disk but open in the editor
             * gave `fullRange("")`, an empty range, so the new content was INSERTED ahead of the
             * old rather than replacing it.
             *
             * The sibling `case "replace"` above already opens the document for exactly this
             * reason, and its header says reading bytes instead "would clobber unsaved changes".
             * An open document cannot be opened here unconditionally, though: a brand-new file
             * has no document yet and `createFile` is still only QUEUED on the edit, so the
             * already-open list is consulted and disk is used only when there is no buffer.
             */
            const open = vscode.workspace.textDocuments.find(
              (d) => d.uri.toString() === uri.toString(),
            );
            const range = open
              ? open.validateRange(new vscode.Range(0, 0, open.lineCount, Number.MAX_SAFE_INTEGER))
              : fullRange((await readIfPresent(uri)) ?? "");
            edit.replace(uri, range, m.content);
            break;
          }
          case "delete":
            edit.deleteFile(resolve(m.path), {
              recursive: m.recursive,
              ignoreIfNotExists: false,
            });
            break;
          case "rename":
            edit.renameFile(resolve(m.from), resolve(m.to), { overwrite: m.overwrite });
            break;
          case "mkdir":
            mkdirs.push(resolve(m.path));
            break;
        }
      }

      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) return { ok: false, error: "VS Code refused the workspace edit" };
      for (const dir of mkdirs) await vscode.workspace.fs.createDirectory(dir);
      return { ok: true };
    },
  };
}

/** A full-document Range for `text`, without needing the document open. */
function fullRange(text: string): vscode.Range {
  const lines = text.split("\n");
  const last = lines.length - 1;
  return new vscode.Range(0, 0, last, (lines[last] ?? "").length);
}

async function readIfPresent(uri: vscode.Uri): Promise<string | null> {
  try {
    return dec.decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return null;
  }
}

/** Workspace-relative form of `uri`, or null when it is not under `root`. */
function relativeTo(root: vscode.Uri, uri: vscode.Uri): string | null {
  const base = root.path.endsWith("/") ? root.path : `${root.path}/`;
  return uri.path.startsWith(base) ? uri.path.slice(base.length) : null;
}

function preview(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
}
