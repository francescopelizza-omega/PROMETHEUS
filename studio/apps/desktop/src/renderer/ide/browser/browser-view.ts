/**
 * browser-view.ts — PURE tab/URL/onion model for the in-app Browser (privacy browsing).
 *
 * The tab-list + per-tab history reducer, URL normalization/validation, and the
 * .onion→Tor policy — dependency-free + node:test-tested (no DOM, no electron). The
 * actual page rendering is an Electron <webview>/WebContentsView in a partitioned,
 * sandboxed session; the Tor engine routes that session through a SOCKS proxy so
 * .onion resolves inside the tab. Renderer-sandboxed (C5): nothing privileged here.
 */

/** The engine an in-app tab renders through. */
export type TabEngine = "default" | "tor";

/** One browser tab (history is a back/forward stack). */
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  engine: TabEngine;
  loading: boolean;
  history: string[];
  historyIndex: number;
}

export interface BrowserState {
  tabs: BrowserTab[];
  activeId: string | null;
}

export function initialBrowserState(): BrowserState {
  return { tabs: [], activeId: null };
}

/** Privacy-friendly defaults. */
export const DEFAULT_HOME = "https://duckduckgo.com";
const SEARCH_PREFIX = "https://duckduckgo.com/?q=";

/* ── URL handling ──────────────────────────────────────────────────────────── */

/** A schemes-allow list — only http(s) (+ .onion over http/https). Never file:/js:/data:. */
const ALLOWED_SCHEME = /^https?:\/\//i;
const DANGEROUS_SCHEME = /^(javascript|data|file|vbscript|blob):/i;

/** True when a host is a Tor hidden service (…\.onion). */
export function isOnion(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".onion");
  } catch {
    return /^[a-z2-7]{16,56}\.onion(\/|$|:)/i.test(url.replace(ALLOWED_SCHEME, ""));
  }
}

function looksLikeHost(s: string): boolean {
  // a token with a dot + no spaces (example.com, sub.host.io, x.onion), or localhost
  return (/^[^\s]+\.[^\s]+$/.test(s) && !s.includes(" ")) || /^localhost(:\d+)?(\/|$)/.test(s);
}

/**
 * Normalize an address-bar input into a navigable URL: keep valid http(s) URLs, add
 * https:// to a bare host, otherwise treat it as a search query. Dangerous schemes
 * (javascript:/data:/file:) are turned into a SEARCH (never navigated).
 */
export function normalizeUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return DEFAULT_HOME;
  if (DANGEROUS_SCHEME.test(raw)) return SEARCH_PREFIX + encodeURIComponent(raw);
  if (ALLOWED_SCHEME.test(raw)) return raw;
  if (looksLikeHost(raw)) return `https://${raw}`;
  return SEARCH_PREFIX + encodeURIComponent(raw);
}

/** Whether a URL is safe to load in a tab (post-normalize: only http(s)). */
export function isLoadable(url: string): boolean {
  return ALLOWED_SCHEME.test(url) && !DANGEROUS_SCHEME.test(url);
}

/** The onion→Tor policy: a .onion URL may only load in a `tor` tab. */
export function onionPolicy(url: string, engine: TabEngine): { ok: boolean; reason?: string } {
  if (isOnion(url) && engine !== "tor") {
    return { ok: false, reason: "this is a .onion address — open it in a Tor tab" };
  }
  return { ok: true };
}

/* ── tab reducer ───────────────────────────────────────────────────────────── */

export type BrowserAction =
  | { type: "open"; id: string; url?: string; engine?: TabEngine }
  | { type: "close"; id: string }
  | { type: "activate"; id: string }
  | { type: "navigate"; id: string; url: string }
  | { type: "title"; id: string; title: string }
  | { type: "loading"; id: string; loading: boolean }
  | { type: "back"; id: string }
  | { type: "forward"; id: string };

function newTab(id: string, url: string, engine: TabEngine): BrowserTab {
  return { id, title: "New tab", url, engine, loading: false, history: [url], historyIndex: 0 };
}

export function canGoBack(tab: BrowserTab): boolean {
  return tab.historyIndex > 0;
}
export function canGoForward(tab: BrowserTab): boolean {
  return tab.historyIndex < tab.history.length - 1;
}

/** The pure browser reducer (immutable). */
export function browserReducer(state: BrowserState, action: BrowserAction): BrowserState {
  const map = (fn: (t: BrowserTab) => BrowserTab): BrowserState => ({
    ...state,
    tabs: state.tabs.map((t) => (t.id === (action as { id: string }).id ? fn(t) : t)),
  });
  switch (action.type) {
    case "open": {
      const url = normalizeUrl(action.url ?? DEFAULT_HOME);
      const tab = newTab(action.id, url, action.engine ?? "default");
      return { tabs: [...state.tabs, tab], activeId: action.id };
    }
    case "close": {
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      const activeId =
        state.activeId === action.id ? (tabs[tabs.length - 1]?.id ?? null) : state.activeId;
      return { tabs, activeId };
    }
    case "activate":
      return state.tabs.some((t) => t.id === action.id) ? { ...state, activeId: action.id } : state;
    case "navigate": {
      const url = normalizeUrl(action.url);
      return map((t) => {
        // truncate any forward history, push the new url
        const history = [...t.history.slice(0, t.historyIndex + 1), url];
        return { ...t, url, history, historyIndex: history.length - 1, loading: true };
      });
    }
    case "title":
      return map((t) => ({ ...t, title: action.title || t.title }));
    case "loading":
      return map((t) => ({ ...t, loading: action.loading }));
    case "back":
      return map((t) =>
        canGoBack(t)
          ? {
              ...t,
              historyIndex: t.historyIndex - 1,
              url: t.history[t.historyIndex - 1] as string,
              loading: true,
            }
          : t,
      );
    case "forward":
      return map((t) =>
        canGoForward(t)
          ? {
              ...t,
              historyIndex: t.historyIndex + 1,
              url: t.history[t.historyIndex + 1] as string,
              loading: true,
            }
          : t,
      );
  }
}

/** The active tab, or null. */
export function activeTab(state: BrowserState): BrowserTab | null {
  return state.tabs.find((t) => t.id === state.activeId) ?? null;
}

/** A short tab label (host or title), for the tab strip. */
export function tabLabel(tab: BrowserTab): string {
  if (tab.title && tab.title !== "New tab") return tab.title;
  try {
    return new URL(tab.url).hostname || "New tab";
  } catch {
    return "New tab";
  }
}
