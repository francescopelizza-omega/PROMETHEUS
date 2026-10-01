// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/search.ts — `web_search`, behind a provider seam, with no fabrication.
 *
 * `web_fetch(url)` could already fetch a page the model already knew about. There was no way
 * to FIND one, so any task needing current information dead-ended.
 *
 * Two facts about this repo's network layer decided the design, and both are worth stating
 * because they rule out the obvious approach:
 *
 *  1. **HTML search results are impossible here.** Every request goes through the fail-closed
 *     L6 proxy, whose stripper deletes all markup — including links (`fetchproxy.py`
 *     `_Stripper`). A scraped SERP would arrive as a wall of prose with every URL removed,
 *     which is worse than nothing: the model would cite results it cannot link to.
 *  2. **Non-HTML bodies pass through untouched.** So a provider that returns JSON works today,
 *     through the same proxy, with no second network path and no new trust boundary.
 *
 * Hence: providers return JSON, and the seam is data-only so a real ranked-SERP provider
 * (Brave, Tavily, SerpAPI) drops in the moment someone configures a key.
 *
 * THE RULE: when no provider is configured the tool FAILS AND SAYS SO, telling the model how
 * to configure one. It never returns an empty list that reads like "the web has nothing", and
 * it never invents results. A search tool that quietly returns plausible nonsense is the most
 * damaging tool an agent can have, because every downstream claim inherits the fabrication.
 *
 * PURE: URL building and response shaping only. The caller performs the fetch through
 * `safeFetch`, exactly as `web_fetch` does.
 */

import type { ToolDef } from "./tools.js";

/** One result. `url` may be empty for a provider that returns an abstract with no link. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * One provider's HTTP request, as data.
 *
 * A single `request()` rather than the `url()` + `headers()` pair it replaces, because a POST
 * provider (Tavily) needs a method and a body, and two half-methods that must agree is the
 * shape that drifts. The key is conspicuously absent: see `auth`.
 */
export interface SearchRequest {
  url: string;
  method?: "GET" | "POST";
  /** NON-SECRET headers only. These ride argv (base64'd) and are visible in `ps`. */
  headers?: Record<string, string>;
  /** POST body, already JSON-encoded. Also rides argv — never put a key here. */
  body?: string;
  /**
   * The header the API key rides in.
   *
   * The VALUE is deliberately not here. The dispatcher hands the key to the sidecar through
   * the ENVIRONMENT (`SEARCH_KEY_ENV`), consumed once at spawn, so it never appears in argv
   * where `ps` would show it to every user on the machine. `scheme` prefixes the key for
   * providers that want `Authorization: Bearer <key>`.
   */
  auth?: { header: string; scheme?: string };
}

/** How a provider is reached, and how its body is read. */
export interface SearchProvider {
  id: string;
  /** shown to the user and to the model, so neither mistakes an abstract for a ranked SERP. */
  label: string;
  /**
   * The environment variable holding this provider's API key. Absent ⇒ keyless.
   * The host reads it; this module never touches the environment.
   */
  keyEnv?: string;
  /** Build the request for a query. */
  request(query: string, limit: number): SearchRequest;
  /** Shape the JSON body into results. Must never invent — an unreadable body yields []. */
  parse(body: unknown, limit: number): SearchResult[];
}

/**
 * The env var the resolved key is handed to the fetch sidecar under.
 *
 * One name for every provider: the sidecar is told which HEADER to put it in, so the variable
 * name carries no information a leak could use, and there is only one name to audit.
 */
export const SEARCH_KEY_ENV = "PROMETHEUS_SEARCH_KEY";

/** True when this provider cannot run without a key. */
export function needsKey(provider: SearchProvider): boolean {
  return typeof provider.keyEnv === "string" && provider.keyEnv.length > 0;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

/**
 * DuckDuckGo's Instant Answer API — the keyless default.
 *
 * Chosen because it is the only thing that works with NO configuration on a fresh machine,
 * and it returns JSON so the L6 stripper leaves it alone. Its label says exactly what it is:
 * an abstract plus related topics, NOT a ranked list of the web's best matches. Presenting it
 * as a search engine would be the same fabrication this module exists to avoid, one level up.
 */
export const DDG_INSTANT: SearchProvider = {
  id: "ddg-instant",
  label: "DuckDuckGo Instant Answer (abstracts and related topics — not a ranked result list)",
  request: (query) => ({
    url: `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&t=prometheus`,
    headers: { Accept: "application/json" },
  }),
  parse(body, limit) {
    if (!isRecord(body)) return [];
    const out: SearchResult[] = [];
    const abstract = str(body.AbstractText) || str(body.Abstract);
    if (abstract) {
      out.push({
        title: str(body.Heading) || "Abstract",
        url: str(body.AbstractURL),
        snippet: abstract,
      });
    }
    const walk = (topics: unknown): void => {
      if (!Array.isArray(topics)) return;
      for (const t of topics) {
        if (out.length >= limit) return;
        if (!isRecord(t)) continue;
        if (Array.isArray(t.Topics)) {
          walk(t.Topics);
          continue;
        }
        const text = str(t.Text);
        if (!text) continue;
        out.push({ title: text.split(" - ")[0] ?? text, url: str(t.FirstURL), snippet: text });
      }
    };
    walk(body.RelatedTopics);
    return out.slice(0, limit);
  },
};

/**
 * Brave Search — a real ranked web index, keyed.
 *
 * This is the provider the live run proved was needed: DDG Instant answers "TypeScript" with a
 * Wikipedia abstract and answers an ordinary how-do-I question with nothing at all, because it
 * is an entity endpoint, not an index. Brave returns ranked pages with titles, URLs and
 * descriptions, as JSON — so it passes the L6 stripper untouched, exactly like DDG.
 */
export const BRAVE: SearchProvider = {
  id: "brave",
  label: "Brave Search (ranked web results)",
  keyEnv: "BRAVE_SEARCH_API_KEY",
  request: (query, limit) => ({
    url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    headers: { Accept: "application/json" },
    auth: { header: "X-Subscription-Token" },
  }),
  parse(body, limit) {
    if (!isRecord(body)) return [];
    const web = isRecord(body.web) ? body.web : undefined;
    const rows = Array.isArray(web?.results) ? web.results : [];
    const out: SearchResult[] = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!isRecord(row)) continue;
      const title = str(row.title);
      const url = str(row.url);
      if (!title && !url) continue;
      out.push({ title: title || url, url, snippet: str(row.description) });
    }
    return out;
  },
};

/**
 * Tavily — a search API built for agents, keyed. POST, hence the `request()` seam.
 *
 * Its `content` field is an extracted passage rather than a snippet, which is what makes it
 * worth having alongside Brave: the model often needs the answer, not the link.
 */
export const TAVILY: SearchProvider = {
  id: "tavily",
  label: "Tavily (ranked web results with extracted passages)",
  keyEnv: "TAVILY_API_KEY",
  request: (query, limit) => ({
    url: "https://api.tavily.com/search",
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    // The key is NOT in this body — Tavily also accepts it as a bearer header, which is the
    // only form that keeps it out of argv.
    body: JSON.stringify({ query, max_results: limit, search_depth: "basic" }),
    auth: { header: "Authorization", scheme: "Bearer" },
  }),
  parse(body, limit) {
    if (!isRecord(body)) return [];
    const out: SearchResult[] = [];
    // A direct answer, when Tavily produced one, leads — it is the thing that was asked for.
    const answer = str(body.answer);
    if (answer) out.push({ title: "Answer", url: "", snippet: answer });
    const rows = Array.isArray(body.results) ? body.results : [];
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!isRecord(row)) continue;
      const url = str(row.url);
      const title = str(row.title) || url;
      if (!title) continue;
      out.push({ title, url, snippet: str(row.content) });
    }
    return out.slice(0, limit);
  },
};

/** Everything shipped. A keyed provider is selectable only once its key exists. */
export const SEARCH_PROVIDERS: readonly SearchProvider[] = Object.freeze([
  DDG_INSTANT,
  BRAVE,
  TAVILY,
]);

export function findProvider(id: string | undefined): SearchProvider | undefined {
  return SEARCH_PROVIDERS.find((p) => p.id === id);
}

/** What `selectProvider` decided, and why. Exactly one of `provider` / `error` is set. */
export interface ProviderChoice {
  provider?: SearchProvider;
  /** a substitution the caller MUST show — never let a swap happen silently. */
  note?: string;
  /** a configuration error: nothing ran, and the caller says so. */
  error?: string;
}

/**
 * Pick the provider to use, given what the host configured and which keys exist.
 *
 * Two different failures, deliberately treated differently:
 *
 *  - An UNKNOWN id is a config error — a typo in `brave`. Refuse, so it gets fixed. Silently
 *    searching a different index than the one named is how a user comes to trust results that
 *    did not come from where they think.
 *  - A KNOWN provider with no key is the ordinary state of a fresh machine. Degrade to the
 *    keyless default and SAY SO in the output, so the substitution is visible to both the
 *    model and the human.
 *
 * With nothing configured, a keyed provider whose key IS present wins: a machine that set
 * BRAVE_SEARCH_API_KEY asked for ranked results and should not have to ask twice.
 */
export function selectProvider(
  configuredId: string | undefined,
  hasKey: (envName: string) => boolean,
): ProviderChoice {
  if (configuredId) {
    const chosen = findProvider(configuredId);
    if (!chosen) {
      const known = SEARCH_PROVIDERS.map((p) => p.id).join(", ");
      return { error: `unknown search provider "${configuredId}" — configured ones are: ${known}` };
    }
    if (needsKey(chosen) && !hasKey(chosen.keyEnv ?? "")) {
      return {
        provider: DDG_INSTANT,
        note: `${chosen.id} is configured but ${chosen.keyEnv} is not set — used ${DDG_INSTANT.id} instead`,
      };
    }
    return { provider: chosen };
  }
  for (const p of SEARCH_PROVIDERS) {
    if (needsKey(p) && hasKey(p.keyEnv ?? "")) return { provider: p };
  }
  return { provider: DDG_INSTANT };
}

/** The default when the host expressed no preference. */
export function defaultProvider(): SearchProvider {
  return DDG_INSTANT;
}

/** Clamp the requested result count to something a prompt can afford. */
export const MAX_RESULTS = 10;
export function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 5;
  return Math.min(Math.max(n, 1), MAX_RESULTS);
}

/**
 * Render results for the model.
 *
 * An empty list says NO RESULTS explicitly and names the provider. "the search returned
 * nothing" and "the search never ran" must not look the same in a transcript, because the
 * model's next move differs completely.
 */
export function renderResults(
  provider: SearchProvider,
  query: string,
  results: readonly SearchResult[],
  note?: string,
): string {
  // The note is on the FIRST line, above the results, because it changes how they should be
  // read: "you asked for Brave and got abstracts" is not a footnote.
  const head = `[${provider.label}] query: ${query}${note ? `\n(note: ${note})` : ""}`;
  if (results.length === 0) {
    return `${head}\nNO RESULTS. This provider found nothing for that query — it is not a ranked web index, so try web_fetch on a known URL, or rephrase.`;
  }
  const body = results
    .map((r, i) => `${i + 1}. ${r.title}${r.url ? `\n   ${r.url}` : ""}\n   ${r.snippet}`)
    .join("\n");
  return `${head}\n${body}`;
}

/** What the model is told when nothing is configured — actionable, never a fake empty list. */
export const NO_PROVIDER_MESSAGE =
  "web_search has no provider configured on this machine, so no search was performed. " +
  "Do NOT guess at results. Either use web_fetch on a URL you already know, or tell the user " +
  "to configure a search provider.";

export const WEB_SEARCH_TOOL: ToolDef = {
  name: "web_search",
  title: "Search the web",
  description:
    "Search the web for a query and get back titles, URLs and snippets. Use it to FIND a " +
    "page; use web_fetch to read one you already have a URL for. Results come from the " +
    "configured provider only — if none is configured this fails and says so; never guess.",
  schema: {
    query: { type: "string", required: true, description: "what to search for" },
    limit: { type: "number", description: `how many results (1-${MAX_RESULTS}, default 5)` },
  },
  // openWorldHint ⇒ always confirmed, exactly like web_fetch: it reaches the network and the
  // human should see what is about to be sent off the machine.
  annotations: { openWorldHint: true, readOnlyHint: true },
  toArgv: () => {
    throw new Error("web_search is served by the host runtime, not by prometheus.py");
  },
};
