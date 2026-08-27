/**
 * main/spectacular-ipc.ts — the trusted side of the SPECTACULAR power-up seam.
 *
 * RELAY-ONLY (mirrors catalog-ipc.ts / metadata-ipc.ts): each handler delegates
 * to the engine-bridge PrometheusEngine FACADE (the only python3 spawner, C5) and
 * maps the typed envelope down to a renderer-safe plain-data shape. The renderer
 * reaches these over `window.prometheus.spectacular.*` / `folderOpen` only.
 *
 * Commands here are READ-ONLY or PREVIEW: describe / tutorial / methods / harden /
 * models config+browse / chat (agentic-local reply + terminal-chat PREVIEW). The
 * terminal preview returns the engine's injection-safe argv; the ACTUAL terminal
 * handoff is the user's (prometheus CLI / pty panel) — JS never launches a bypassed
 * agent here. No scoring, no allowlist, no verdict upgrade (the SPINE / C5).
 */

import { BrowserWindow, dialog, ipcMain } from "electron";

import { createPrometheusEngine } from "@prometheus/engine-bridge";

import {
  type FolderOpenResult,
  IPC,
  type SpectacularCard,
  type SpectacularChatLocal,
  type SpectacularChatPreview,
  type SpectacularChatPreviewOpts,
  type SpectacularHarden,
  type SpectacularMethods,
  type SpectacularModelsBrowse,
  type SpectacularModelsConfig,
  type SpectacularTutorial,
} from "../shared/ipc-contract.js";
import { guardOwnRepo } from "./cwd-guard.js";
import { grantWorkingSetRoot } from "./ide/path-guard.js";
import { cleanId, cleanPathToken, isSafeToken } from "./spectacular-validate.js";

function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

/** Read + VALIDATE a catalog id (charset-pinned, never a leading-dash flag).
 *  Returns undefined when the value is missing or option-injection-shaped. */
function idOf(arg: unknown): string | undefined {
  return cleanId(arg);
}

export function registerSpectacularIpcHandlers(): () => void {
  const engine = createPrometheusEngine();

  ipcMain.handle(IPC.spectacularDescribe, async (_evt, arg: unknown): Promise<SpectacularCard> => {
    const id = idOf(arg);
    if (!id) return { ok: false, error: "missing id" };
    try {
      const e = await engine.describe(id);
      const out: SpectacularCard = {
        ok: e.ok !== false,
        id: e.id,
        kind: e.kind,
        name: e.name,
        summary: e.summary,
        repo: e.repo,
        license: e.license,
        category: e.category,
        tier: e.tier,
        security: e.security,
        installable: e.installable,
        hasTutorial: e.has_tutorial,
      };
      if (typeof e.error === "string") out.error = e.error;
      return out;
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(
    IPC.spectacularTutorial,
    async (_evt, arg: unknown): Promise<SpectacularTutorial> => {
      const id = idOf(arg);
      if (!id) return { ok: false, error: "missing or invalid id" };
      try {
        const e = await engine.tutorial(id);
        const out: SpectacularTutorial = { ok: e.ok !== false, id: e.id, text: e.text };
        if (typeof e.error === "string") out.error = e.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.spectacularMethods,
    async (_evt, arg: unknown): Promise<SpectacularMethods> => {
      const id = idOf(arg);
      if (!id) return { ok: false, error: "missing or invalid id" };
      try {
        const e = await engine.methods(id);
        const out: SpectacularMethods = { ok: e.ok !== false, id: e.id, section: e.section };
        if (typeof e.error === "string") out.error = e.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  ipcMain.handle(IPC.spectacularHarden, async (): Promise<SpectacularHarden> => {
    try {
      const e = await engine.harden();
      const out: SpectacularHarden = {
        ok: e.ok !== false,
        findings: Array.isArray(e.findings) ? e.findings : [],
        warnings: typeof e.warnings === "number" ? e.warnings : 0,
      };
      if (typeof e.error === "string") out.error = e.error;
      return out;
    } catch (e) {
      return { ok: false, findings: [], warnings: 0, error: errString(e) };
    }
  });

  ipcMain.handle(
    IPC.spectacularChatLocal,
    async (_evt, arg: unknown): Promise<SpectacularChatLocal> => {
      const a = (arg ?? {}) as { model?: string; prompt?: string; runner?: string };
      if (!a.model || !a.prompt) return { ok: false, error: "model and prompt are required" };
      // model is `--local`'s value (a positional-ish token) — reject leading-dash so it
      // can't masquerade as a flag. runner has argparse `choices`, so it's safe as-is.
      // The free-form prompt may legitimately lead with `-`; commands.ts guards it via `--`.
      if (!isSafeToken(a.model)) return { ok: false, error: "invalid model id" };
      try {
        const e = await engine.chatLocal(a.model, a.prompt, a.runner);
        const out: SpectacularChatLocal = {
          ok: e.ok !== false,
          response: e.response,
          model: e.model,
          runner: e.runner,
        };
        if (typeof e.error === "string") out.error = e.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.spectacularChatPreview,
    async (_evt, arg: unknown): Promise<SpectacularChatPreview> => {
      const a = (arg ?? {}) as { cli?: string; opts?: SpectacularChatPreviewOpts };
      if (!a.cli) return { ok: false, error: "cli is required" };
      try {
        const e = await engine.chatPreview(a.cli, a.opts);
        if (e.ok === false) {
          return { ok: false, error: e.error ?? "chat preview failed" };
        }
        return {
          ok: true,
          cli: e.cli,
          label: e.label,
          argv: e.argv,
          env: e.env,
          notes: e.notes,
          bypass: e.bypass,
          tmux: e.tmux,
          interactive: e.interactive,
          model: e.model,
          cwd: e.cwd,
          ...(typeof e.error === "string" ? { error: e.error } : {}),
        };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.spectacularModelsConfig,
    async (_evt, arg: unknown): Promise<SpectacularModelsConfig> => {
      const rawRoot = (arg as { setRoot?: string } | undefined)?.setRoot;
      // setRoot becomes `--set-root <value>` — a leading-dash value would inject a flag.
      if (rawRoot !== undefined && cleanPathToken(rawRoot) === undefined) {
        return { ok: false, error: "invalid models root path" };
      }
      const setRoot = rawRoot;
      try {
        const e = await engine.modelsConfig(setRoot);
        const out: SpectacularModelsConfig = {
          ok: e.ok !== false,
          modelsRoot: e.models_root,
          exists: e.exists,
        };
        if (typeof e.error === "string") out.error = e.error;
        return out;
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  ipcMain.handle(IPC.spectacularModelsBrowse, async (): Promise<SpectacularModelsBrowse> => {
    try {
      const e = await engine.modelsBrowse();
      const out: SpectacularModelsBrowse = {
        ok: e.ok !== false,
        models: Array.isArray(e.models) ? e.models : [],
      };
      if (typeof e.error === "string") out.error = e.error;
      return out;
    } catch (e) {
      return { ok: false, models: [], error: errString(e) };
    }
  });

  // ── native folder picker (models-root chooser) ─────────────────────────────
  ipcMain.handle(IPC.folderOpen, async (evt, arg: unknown): Promise<FolderOpenResult> => {
    const t = (arg as { title?: unknown } | undefined)?.title;
    const title = typeof t === "string" ? t : "Select a folder";
    try {
      const res = await dialog.showOpenDialog({
        title,
        properties: ["openDirectory", "createDirectory"],
      });
      const picked = res.canceled || res.filePaths.length === 0 ? null : (res.filePaths[0] ?? null);
      // Prometheus Studio must never open a workspace inside Prometheus's OWN repo (see
      // cwd-guard.ts's own header for why) — redirected to the user's home directory instead,
      // exactly like the CLI's own equivalent guard. A NATIVE dialog (not just a returned
      // field) makes this unmissable regardless of whatever the renderer does immediately
      // after — `openFolder` navigates away from Home the instant this promise resolves, so a
      // renderer-only notice could easily never actually be seen.
      const guard = picked ? guardOwnRepo(picked) : undefined;
      const path = guard ? guard.cwd : picked;
      if (guard?.redirected) {
        const win = BrowserWindow.fromWebContents(evt.sender);
        const opts = {
          type: "warning" as const,
          title: "Can't open Prometheus's own repository",
          message: "Prometheus refuses to open a workspace inside its own source repository.",
          detail: `Chosen: ${guard.requestedCwd}\nOpened instead: ${path}`,
          buttons: ["OK"],
        };
        await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
      }
      /**
       * A directory the HUMAN just chose in the OS picker — the only thing that may widen the
       * agent's write scope.
       *
       * Recorded HERE rather than trusting the renderer to declare it, because this is the one
       * place in the process where the path provably came from the operating system's own file
       * chooser. `setWorkingSetRoots` then lets the renderer pick which granted directory is
       * the current workspace, and refuses anything outside them.
       */
      if (path) grantWorkingSetRoot(path);
      return {
        ok: true,
        path,
        canceled: res.canceled,
        ...(guard?.redirected ? { redirectedFromOwnRepo: guard.requestedCwd } : {}),
      };
    } catch {
      return { ok: false, path: null, canceled: true };
    }
  });

  return () => {
    for (const channel of [
      IPC.spectacularDescribe,
      IPC.spectacularTutorial,
      IPC.spectacularMethods,
      IPC.spectacularHarden,
      IPC.spectacularChatLocal,
      IPC.spectacularChatPreview,
      IPC.spectacularModelsConfig,
      IPC.spectacularModelsBrowse,
      IPC.folderOpen,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
