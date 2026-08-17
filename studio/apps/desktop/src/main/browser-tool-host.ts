/**
 * main/browser-tool-host.ts — the Electron half of `browser_navigate` / `browser_screenshot` /
 * `browser_extract_text` (core's host-generic gate lives in
 * `@prometheus/core/agent-system-host`'s `browser-tools.ts`; this file is the `BrowserHostDeps`
 * it dispatches into).
 *
 * A SEPARATE, ISOLATED SESSION — never the human's tab. `browser-view.ts` (the renderer's
 * privacy-browsing model) is a human-facing surface with its own tabs and its own Tor-routed
 * session; this is a DIFFERENT, dedicated webContents the agent alone drives, on a partition
 * (`agent-browser-tool`, no `persist:` prefix — in-memory, gone on quit) that shares no
 * cookies, storage or history with anything the human has open. An agent that could screenshot
 * whatever tab a human happens to have open would be a session-leak tool wearing a browsing
 * tool's name.
 *
 * OFFSCREEN ON PURPOSE. `offscreen: true` is what lets `capturePage()` return real pixels for a
 * window that is never shown — no monitor, no dock icon, nothing the user sees appear.
 *
 * THE RESIDUAL-NAVIGATION GUARD. Core's `runBrowserTool` preflights the URL the AGENT asked
 * for through the same SSRF/nemesis proxy `web_fetch` uses, but that preflight cannot see what
 * happens after Chromium starts loading: a redirect chooses its own target, and a page could
 * try to move itself once loaded. Two listeners close that gap for the lifetime of this
 * webContents (not just during one `navigate()` call):
 *   - `will-navigate` (any PAGE/script-initiated navigation — a link, `location.href=`, a
 *     meta-refresh) is refused unconditionally. There is no click/type tool, so the only
 *     legitimate way this tab ever moves is our own `loadURL` call below; anything else is the
 *     page trying to drive itself somewhere the agent did not ask to go.
 *   - `will-redirect` (a network-level hop the ORIGINAL request follows) is re-validated
 *     against the SSRF host-check (`safeFetchCheck` — cheap, no bytes) before being allowed, so
 *     a benign starting URL cannot redirect its way to an internal address. This re-check is
 *     SSRF/host-class only, not a second full nemesis content scan — an accepted, stated
 *     narrowing versus the richer preflight the original URL got.
 */
import { BrowserWindow, session } from "electron";

import type { BrowserHostDeps } from "@prometheus/core/agent-system-host";
import { safeFetchCheck } from "@prometheus/engine-bridge";

const PARTITION = "agent-browser-tool";
const NAV_TIMEOUT_MS = 25_000;
/** Generous — the shared `capUtf8` byte-cap in core does the real, byte-accurate trim. */
const EXTRACT_MAX_CHARS = 500_000;
const NO_PAGE = "no page loaded — call browser_navigate first";

const SAFE_SCHEME = /^https?:\/\//i;

function isSafeScheme(url: string): boolean {
  return SAFE_SCHEME.test(url);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cheap SSRF/host-class re-check for a redirect hop (no bytes fetched). Fail-closed. */
async function hostAllowed(url: string): Promise<boolean> {
  if (!isSafeScheme(url)) return false;
  try {
    const check = await safeFetchCheck(url);
    return check.safe === true;
  } catch {
    return false;
  }
}

let win: BrowserWindow | null = null;

function getWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  const w = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: session.fromPartition(PARTITION),
      offscreen: true,
    },
  });
  const contents = w.webContents;

  contents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  contents.on("will-redirect", (event, url) => {
    event.preventDefault();
    void hostAllowed(url).then((ok) => {
      if (ok && !w.isDestroyed()) contents.loadURL(url).catch(() => {});
    });
  });

  win = w;
  return w;
}

/** Point the dedicated tab at a URL. Callers gate the SSRF/nemesis preflight BEFORE this. */
async function navigate(
  url: string,
): Promise<{ ok: boolean; finalUrl?: string; title?: string; reason?: string }> {
  if (!isSafeScheme(url)) return { ok: false, reason: "only http/https URLs may be loaded" };
  const contents = getWindow().webContents;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: {
      ok: boolean;
      finalUrl?: string;
      title?: string;
      reason?: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.off("did-finish-load", onFinish);
      contents.off("did-fail-load", onFail);
      resolve(result);
    };
    const onFinish = (): void => {
      finish({ ok: true, finalUrl: contents.getURL(), title: contents.getTitle() });
    };
    const onFail = (
      _e: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      // A sub-resource (an image, an ad, a tracker) failing is not a NAVIGATION failure.
      if (!isMainFrame) return;
      finish({ ok: false, reason: `${errorDescription} (${errorCode}) loading ${validatedUrl}` });
    };
    contents.once("did-finish-load", onFinish);
    contents.on("did-fail-load", onFail);
    // `finish` closes over `timer` but cannot run before this line (both listeners are
    // async-only), so declaring it const here — after `finish`, before `loadURL` — is safe.
    const timer = setTimeout(
      () => finish({ ok: false, reason: "navigation timed out" }),
      NAV_TIMEOUT_MS,
    );
    contents.loadURL(url).catch((err) => finish({ ok: false, reason: errText(err) }));
  });
}

async function screenshot(): Promise<{
  ok: boolean;
  pngBase64?: string;
  width?: number;
  height?: number;
  url?: string;
  reason?: string;
}> {
  if (!win || win.isDestroyed()) return { ok: false, reason: NO_PAGE };
  const contents = win.webContents;
  const url = contents.getURL();
  if (!url || url === "about:blank") return { ok: false, reason: NO_PAGE };
  try {
    const image = await contents.capturePage();
    const { width, height } = image.getSize();
    return { ok: true, pngBase64: image.toPNG().toString("base64"), width, height, url };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

async function extractText(): Promise<{
  ok: boolean;
  text?: string;
  url?: string;
  reason?: string;
}> {
  if (!win || win.isDestroyed()) return { ok: false, reason: NO_PAGE };
  const contents = win.webContents;
  const url = contents.getURL();
  if (!url || url === "about:blank") return { ok: false, reason: NO_PAGE };
  try {
    // `true` (userGesture) avoids Electron's "no gesture" throttling on some page scripts;
    // the executed string is a FIXED literal — never built from agent/model input, so there
    // is no injection surface here despite running JS in a loaded (untrusted) page.
    const raw: unknown = await contents.executeJavaScript(
      "document.body ? document.body.innerText : ''",
      true,
    );
    const text = typeof raw === "string" ? raw.slice(0, EXTRACT_MAX_CHARS) : "";
    return { ok: true, text, url };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

/** The seam `runBrowserTool` (core) dispatches into. */
export const browserToolHostDeps: BrowserHostDeps = { navigate, screenshot, extractText };

/** Tear down the agent's browser tab. Called at app quit — nothing outlives the process. */
export function destroyAgentBrowser(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

/** Test/diagnostic seam only: whether the agent browser window currently exists. */
export function hasAgentBrowserWindow(): boolean {
  return win !== null && !win.isDestroyed();
}
