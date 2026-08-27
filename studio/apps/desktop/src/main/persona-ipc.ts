/**
 * main/persona-ipc.ts — the `persona:*` ipcMain handlers for Persona Sharing (roadmap point 3,
 * RELAY-ONLY, mirrors schedule-ipc.ts): lists the shared persona catalog (`~/.prometheus/agents`
 * USER, `<repo>/.prometheus/agents` PROJECT, `~/.prometheus/agents/imported` IMPORTED) for the
 * desktop Settings panel, exports one persona's raw markdown, imports a pasted-or-picked persona,
 * and removes an imported one — via persona-store.ts's already-hardened read/write.
 *
 * UNLIKE model-health/schedule (one global, Electron-`userData`-owned file, its path resolved
 * ONCE by the caller and passed in as a plain constant), persona discovery depends on the
 * CURRENTLY OPEN workspace root — PROJECT-scope personas are found by `discoverProjectAgentsDir`
 * walking UP from that root — and the open workspace can change across the app's lifetime (folder
 * switches, or no folder open at all). So `workspaceRoot` here is a GETTER, called FRESH on every
 * request rather than captured once at registration time. `listPersonaFiles`/`exportPersonaMarkdown`
 * take a non-optional `root: string`, so an unopened workspace falls back to `process.cwd()` —
 * there is simply no project-scope directory to find in that case, which is exactly what
 * `discoverProjectAgentsDir` already reports (fail-soft: none found ⇒ USER/IMPORTED only).
 *
 * `home` is deliberately left at persona-store.ts's own default (`prometheusHome()`) on every
 * call here — production always wants the real shared `~/.prometheus` catalog; only tests inject
 * a different home, and they do it via `$PROMETHEUS_HOME` (see persona-ipc.test.ts), never by
 * threading a parameter through this IPC layer.
 *
 * `PersonaFileInfo.path` is a real absolute filesystem path and must never cross the sandbox
 * boundary to the renderer, so `personaList` strips it down to the plain `PersonaFileView` shape
 * (name/scope/description only) before returning.
 *
 * `personaImportPath` is the one handler that touches the filesystem beyond persona-store.ts's
 * own write: it reads the file's content in MAIN (the renderer is sandboxed and only has the
 * path, handed to it by the existing native `fileOpen` picker — it cannot read the file itself).
 * The same 65536-byte size cap persona-store.ts enforces on the raw import text is checked here
 * too, via `statSync`, BEFORE the full content is ever read into memory — and only ever from a
 * LOCAL path the user explicitly chose: a relative path, or anything that even looks like it
 * starts with a URL scheme, is refused outright (this mirrors a supply-chain lesson — arbitrary
 * fetch of untrusted config from a URL — already fixed twice elsewhere in this codebase). A read
 * failure (ENOENT, permission) becomes a clean `{ok:false, error}`, never a thrown exception.
 *
 * Every handler wraps its store call in try/catch → {ok:false, error: String(e)}, mirroring
 * schedule-ipc.ts's `errString` helper exactly.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import { ipcMain } from "electron";

import {
  IPC,
  type PersonaExportResult,
  type PersonaFileView,
  type PersonaImportResult,
  type PersonaListResult,
  type PersonaRemoveResult,
} from "../shared/ipc-contract.js";
import {
  exportPersonaMarkdown,
  importPersonaMarkdown,
  listPersonaFiles,
  removeImportedPersona,
} from "./persona-store.js";

/** Disk-fill guard mirrored from persona-store.ts's own `MAX_IMPORT_BYTES`: checked here too, via
 *  `statSync`, so `personaImportPath` never even reads an oversized file into memory before
 *  persona-store.ts would reject it anyway. */
const MAX_IMPORT_BYTES = 65536;

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Whether `path` (already known to be `isAbsolute()`) is something OTHER than a genuine local
 * absolute file path — a URL, or a network share — and must be refused. Exported (pure, no fs)
 * so both the handler and its tests can exercise the exact same check regardless of which OS
 * they run on: `isAbsolute()` for a Windows drive-letter path is only ever `true` on an actual
 * win32 host, but this string-only check behaves identically everywhere.
 *
 * The scheme regex requires the "://" every real URL scheme has (`https://`, `ftp://`, …) — NOT
 * just "letter(s) then a colon", which a Windows drive letter ("C:\Users\...") also matches; a
 * looser check used to reject every absolute Windows path outright, not just URLs. A Windows UNC
 * path (`\\server\share\...`) is `isAbsolute() === true` and matches no URL scheme, but names a
 * NETWORK location exactly like a URL does — rejected explicitly for the same reason.
 */
export function isRemoteLookingPath(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^\\\\|^\/\/[^/]/.test(path);
}

/** A non-empty string field, or undefined — the same defensive narrowing shape schedule-ipc.ts
 *  and model-health-ipc.ts use inline. */
function strField(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Map a store result (which always carries a `{ok:false, error}` shape on rejection) onto the
 *  wire `PersonaImportResult`. */
function toImportResult(res: ReturnType<typeof importPersonaMarkdown>): PersonaImportResult {
  return res.ok
    ? { ok: true, name: res.name, replaced: res.replaced }
    : { ok: false, error: res.error };
}

/**
 * Register the `persona:*` handlers.
 *
 * `workspaceRoot` is a GETTER — called fresh on every request, never captured once at
 * registration time, because the open workspace can change across the app's lifetime and
 * PROJECT-scope personas are discovered relative to it. Returns a disposer (mirrors sibling IPC
 * modules).
 */
export function registerPersonaIpcHandlers(workspaceRoot: () => string | undefined): () => void {
  const currentRoot = (): string => workspaceRoot() ?? process.cwd();

  ipcMain.handle(IPC.personaList, async (_e): Promise<PersonaListResult> => {
    try {
      const personas: PersonaFileView[] = listPersonaFiles(currentRoot()).map((p) => ({
        name: p.name,
        scope: p.scope,
        description: p.description,
      }));
      return { ok: true, personas };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.personaExport, async (_e, arg: unknown): Promise<PersonaExportResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const name = strField(a, "name");
    if (!name) {
      return { ok: false, error: "name is required" };
    }
    try {
      const found = exportPersonaMarkdown(name, currentRoot());
      if (!found) {
        return { ok: false, error: `no persona named "${name}" was found` };
      }
      return { ok: true, markdown: found.markdown, scope: found.scope };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.personaImportText, async (_e, arg: unknown): Promise<PersonaImportResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const suggestedName = strField(a, "suggestedName");
    const markdown = strField(a, "markdown");
    if (!suggestedName || !markdown) {
      return { ok: false, error: "suggestedName and markdown are required" };
    }
    try {
      return toImportResult(importPersonaMarkdown(suggestedName, markdown));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.personaImportPath, async (_e, arg: unknown): Promise<PersonaImportResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const path = strField(a, "path");
    if (!path) {
      return { ok: false, error: "path is required" };
    }
    // Import only ever reads a LOCAL file path the user explicitly chose — never a network
    // location. See `isRemoteLookingPath`'s own doc for why the URL-scheme check requires "://"
    // rather than just "letter(s) then a colon" (which a Windows drive letter also matches).
    if (!isAbsolute(path) || isRemoteLookingPath(path)) {
      return { ok: false, error: "path must be an absolute local file path" };
    }
    try {
      let size: number;
      try {
        const stat = statSync(path);
        if (!stat.isFile()) {
          return { ok: false, error: `"${path}" is not a file` };
        }
        size = stat.size;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
      if (size > MAX_IMPORT_BYTES) {
        return {
          ok: false,
          error: `persona is too large to import (max ${MAX_IMPORT_BYTES} bytes)`,
        };
      }
      let markdown: string;
      try {
        markdown = readFileSync(path, "utf8");
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
      const suggestedName = basename(path, ".md");
      return toImportResult(importPersonaMarkdown(suggestedName, markdown));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.personaRemove, async (_e, arg: unknown): Promise<PersonaRemoveResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const name = strField(a, "name");
    if (!name) {
      return { ok: false, error: "name is required" };
    }
    try {
      const res = removeImportedPersona(name);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  return () => {
    for (const channel of [
      IPC.personaList,
      IPC.personaExport,
      IPC.personaImportText,
      IPC.personaImportPath,
      IPC.personaRemove,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
