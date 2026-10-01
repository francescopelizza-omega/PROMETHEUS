// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import type { ToolOutcome } from "../../loop.js";
import {
  type SafeFetchLike,
  WEB_FETCH_MAX_BYTES,
  type WebToolOptions,
  capUtf8,
} from "./web-tools.js";

/**
 * agent/system/host/browser-tools.ts — `browser_navigate` / `browser_screenshot` /
 * `browser_extract_text`: a SCOPED MVP, not full computer-use.
 *
 * THE SCOPE, STATED PLAINLY. There is no click/type/scroll dispatch here. `browser_navigate`
 * drives the agent's own isolated browser tab to a URL; `browser_screenshot` and
 * `browser_extract_text` report what loaded. That is the whole surface. Interacting with
 * arbitrary page UI is a materially bigger trust boundary (a hostile page steers the agent's
 * next click) and is out of scope for this pass — see `agent/browser.ts`'s header.
 *
 * WHY THIS MODULE TAKES `deps` RATHER THAN OWNING A BROWSER. Same reason `web-tools.ts` takes
 * a `SafeFetchLike` instead of importing the sidecar runner directly: Electron's
 * BrowserWindow/webContents API is main-process-only, and this file is imported by a
 * C5-sandboxed renderer's dispatch guard too (via `isHostDispatchTool`). The actual
 * webContents lifecycle lives in `apps/desktop/src/main/browser-tool-host.ts`; this module is
 * the host-generic safety gate + dispatch, injected with whatever implements `BrowserHostDeps`.
 *
 * THE SAFETY GATE FOR `browser_navigate` IS THE SAME ONE `web_fetch` USES. Before the host is
 * ever told to point a real page-load at a URL, this runs the URL through the identical
 * fail-closed `safeFetch` L6 proxy `web_fetch` uses (SSRF/DNS-pin/IP-denylist + the L1 nemesis
 * IOC re-check + indirect-prompt-injection scan on the first bytes). A `block` verdict refuses
 * the navigation outright — the webview never loads the page at all. This is defence in depth,
 * not a complete substitute for host-side redirect gating: the preflight validates the
 * ORIGINAL url; `browser-tool-host.ts` is responsible for re-validating each network redirect
 * hop and refusing any page-initiated (script) navigation, because Chromium's own navigation
 * does not run through this same node-side proxy.
 *
 * `browser_screenshot` / `browser_extract_text` take no URL and touch no network themselves —
 * they read whatever the agent's browser tab already has loaded, which was already gated at
 * `browser_navigate` time. They are NOT a way to peek at the human's own browsing (the host's
 * browser session is a separate, isolated partition — see the host module).
 *
 * `browser_extract_text`'s result is framed as untrusted web DATA, identically to `web_fetch` —
 * a page's visible text is exactly as capable of carrying an injected instruction as a fetched
 * body is. `browser_screenshot`'s image is surfaced through `data`, not through `summary`: the
 * agent LOOP's message pipeline (`ThreadMessage.content: string`) is text-only in this pass, so
 * there is no vision round-trip back to the model yet — the pixels are proof of work for the
 * HOST/human to render (or for a future multimodal wiring), not something this pass claims the
 * model can see. That is a real, stated limitation, not an oversight.
 */

/** ~2 KiB is enough to run the SSRF/nemesis/IPI pipeline without downloading a real page. */
export const BROWSER_PREFLIGHT_MAX_BYTES = 2 * 1024;
export const BROWSER_PREFLIGHT_TIMEOUT_SEC = 10;

export interface BrowserNavigateResult {
  ok: boolean;
  finalUrl?: string;
  title?: string;
  reason?: string;
}

export interface BrowserScreenshotResult {
  ok: boolean;
  /** base64-encoded PNG bytes. */
  pngBase64?: string;
  width?: number;
  height?: number;
  url?: string;
  reason?: string;
}

export interface BrowserExtractResult {
  ok: boolean;
  text?: string;
  url?: string;
  reason?: string;
}

/** What a host injects to actually drive its browser. Electron-shaped, Electron-free type. */
export interface BrowserHostDeps {
  navigate(url: string): Promise<BrowserNavigateResult>;
  screenshot(): Promise<BrowserScreenshotResult>;
  extractText(): Promise<BrowserExtractResult>;
}

const NAV_SCHEME = /^https?:\/\//i;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `browser_navigate` — preflight through the L6 proxy, then hand off to the host's browser. */
async function browserNavigateTool(
  args: Record<string, unknown>,
  deps: BrowserHostDeps,
  safeFetch: SafeFetchLike,
): Promise<ToolOutcome> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return { ok: false, summary: "browser_navigate: no url given" };
  if (!NAV_SCHEME.test(url)) {
    return {
      ok: false,
      summary: `browser_navigate refused: only http/https URLs may be loaded (got "${url}")`,
      verdict: { verdict: "block" },
    };
  }

  let pre: Awaited<ReturnType<SafeFetchLike>>;
  try {
    pre = await safeFetch(url, {
      maxBytes: BROWSER_PREFLIGHT_MAX_BYTES,
      timeoutSec: BROWSER_PREFLIGHT_TIMEOUT_SEC,
    });
  } catch (err) {
    return {
      ok: false,
      summary: `browser_navigate blocked (fail-closed): ${errText(err)}`,
      verdict: { verdict: "block" },
    };
  }
  if (!pre || pre.blocked === true || pre.verdict === "block") {
    const reason = (pre && (pre.reason ?? pre.error)) || "blocked (fail-closed)";
    return {
      ok: false,
      summary: `browser_navigate blocked: ${reason}`,
      verdict: { verdict: "block" },
    };
  }
  const warn = pre.verdict === "warn" ? ` [warning: ${pre.reason ?? "flagged as suspicious"}]` : "";

  let nav: BrowserNavigateResult;
  try {
    nav = await deps.navigate(url);
  } catch (err) {
    return { ok: false, summary: `browser_navigate failed: ${errText(err)}` };
  }
  if (!nav.ok) {
    return { ok: false, summary: `browser_navigate failed: ${nav.reason ?? "unknown error"}` };
  }
  const title = nav.title ? ` — "${nav.title}"` : "";
  return {
    ok: true,
    summary: `navigated to ${nav.finalUrl ?? url}${title}${warn}`,
    data: { url, finalUrl: nav.finalUrl, title: nav.title },
    ...(pre.verdict === "warn" ? { verdict: { verdict: "warn" as const } } : {}),
  };
}

/** `browser_screenshot` — capture the agent's own tab; the image rides `data`, not `summary`. */
async function browserScreenshotTool(deps: BrowserHostDeps): Promise<ToolOutcome> {
  let res: BrowserScreenshotResult;
  try {
    res = await deps.screenshot();
  } catch (err) {
    return { ok: false, summary: `browser_screenshot failed: ${errText(err)}` };
  }
  if (!res.ok || !res.pngBase64) {
    return {
      ok: false,
      summary: `browser_screenshot: ${res.reason ?? "no page loaded — call browser_navigate first"}`,
    };
  }
  return {
    ok: true,
    summary: `screenshot captured (${res.width ?? "?"}x${res.height ?? "?"}) of ${res.url ?? "the current page"}`,
    data: {
      mimeType: "image/png",
      imageBase64: res.pngBase64,
      width: res.width,
      height: res.height,
      url: res.url,
    },
  };
}

/** `browser_extract_text` — the page's innerText, framed as untrusted data like `web_fetch`. */
async function browserExtractTextTool(deps: BrowserHostDeps): Promise<ToolOutcome> {
  let res: BrowserExtractResult;
  try {
    res = await deps.extractText();
  } catch (err) {
    return { ok: false, summary: `browser_extract_text failed: ${errText(err)}` };
  }
  if (!res.ok || typeof res.text !== "string") {
    return {
      ok: false,
      summary: `browser_extract_text: ${res.reason ?? "no page loaded — call browser_navigate first"}`,
    };
  }
  const { text, truncated } = capUtf8(res.text, WEB_FETCH_MAX_BYTES);
  const note = truncated ? `\n[truncated at ${WEB_FETCH_MAX_BYTES} bytes]` : "";
  const src = (res.url ?? "").replace(/[<>"\r\n]/g, "");
  return {
    ok: true,
    summary: `<<untrusted-web-data source="${src}">>\n${text}${note}\n<<end untrusted-web-data>>`,
    data: { url: res.url, datamark: true },
  };
}

const BROWSER_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_screenshot",
  "browser_extract_text",
]);

/**
 * Dispatch a browser tool by name, or null when it is not one.
 *
 * The egress check runs FIRST, exactly as `runWebTool` does — a browser session IS a network
 * feature, so `defaultNetwork:"none"` refuses all three tools before a URL is even parsed or a
 * webContents touched.
 */
export function runBrowserTool(
  name: string,
  args: Record<string, unknown>,
  deps: BrowserHostDeps,
  safeFetch: SafeFetchLike,
  opts: WebToolOptions = {},
): Promise<ToolOutcome> | null {
  if (!BROWSER_TOOL_NAMES.has(name)) return null;
  const gate = opts.egress?.();
  if (gate && !gate.allowed) {
    return Promise.resolve({
      ok: false,
      summary: `${name} refused: ${gate.reason ?? "network access is not permitted"}`,
    });
  }
  if (name === "browser_navigate") return browserNavigateTool(args, deps, safeFetch);
  if (name === "browser_screenshot") return browserScreenshotTool(deps);
  return browserExtractTextTool(deps);
}
