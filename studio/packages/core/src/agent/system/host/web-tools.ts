// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import type { ToolOutcome } from "../../loop.js";
import { defangFrameMarkers } from "../../protocol/frame-body.js";
/**
 * agent/system/host/web-tools.ts — `web_fetch` and `web_search`, in ONE place.
 *
 * Both were implemented in `apps/cli` only, so the desktop agent had no way to reach the network
 * at all: it could not read a URL the user pasted, and it could not look anything up. That is a
 * particularly bad gap for a GUI, where pasting a link is the most natural thing a user does.
 *
 * WHY THIS IS A HOST MODULE RATHER THAN PURE CORE. Every request goes through the fail-closed L6
 * `safeFetch` proxy — the sidecar that does the SSRF check, the nemesis re-scan, the byte cap and
 * the HTML stripping. That is node-only, so the renderer can never call it directly; the desktop
 * reaches this through main over IPC, exactly as it reaches the system tools.
 *
 * THE FRAMING IS SECURITY, NOT FORMATTING. Fetched bytes are attacker-controlled, and the
 * redirect target doubly so (a hostile server chooses `Location`). The content is wrapped in an
 * explicit untrusted-data frame, and the characters that could break OUT of that frame are
 * stripped from the source URL — otherwise the page could forge its own delimiter and present
 * itself to the model as trusted context.
 *
 * FAIL-CLOSED, in this order: a throwing/wedged sidecar, a `blocked` result, a `block` verdict,
 * or a missing body all refuse with NO content. A `warn` is not a block: the content comes back
 * with the warning attached, because hiding it would be a different lie.
 */
import type { SearchProvider } from "../../search.js";
import {
  NO_PROVIDER_MESSAGE,
  SEARCH_KEY_ENV,
  clampLimit,
  renderResults,
  selectProvider,
} from "../../search.js";

/** ~200 KiB is what a turn can afford to spend on one page. */
export const WEB_FETCH_MAX_BYTES = 200 * 1024;
export const WEB_FETCH_TIMEOUT_SEC = 20;

/** The shape `safeFetch` returns (structurally declared so core takes no engine-bridge dep). */
export type SafeFetchLike = (
  url: string,
  opts: {
    maxBytes?: number;
    timeoutSec?: number;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    authHeader?: { header: string; env: string };
    sidecar?: { env?: Record<string, string> };
  },
) => Promise<{
  data?: unknown;
  blocked?: boolean;
  verdict?: string;
  reason?: string;
  error?: string;
  final_url?: string;
  provenance?: unknown;
}>;

/** Cap a string to `maxBytes` UTF-8 bytes on a codepoint boundary (never a half-cut glyph). */
export function capUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { text: s, truncated: false };
  const sliced = Buffer.from(s, "utf8").subarray(0, maxBytes);
  let text = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  if (text.endsWith("�")) text = text.slice(0, -1);
  return { text, truncated: true };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `web_fetch` — read ONE url through the L6 proxy, framed as untrusted data. */
export async function webFetchTool(
  args: Record<string, unknown>,
  safeFetch: SafeFetchLike,
): Promise<ToolOutcome> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) return { ok: false, summary: "web_fetch: no url given" };
  let res: Awaited<ReturnType<SafeFetchLike>>;
  try {
    res = await safeFetch(url, {
      maxBytes: WEB_FETCH_MAX_BYTES,
      timeoutSec: WEB_FETCH_TIMEOUT_SEC,
    });
  } catch (err) {
    return { ok: false, summary: `web_fetch blocked (fail-closed): ${errText(err)}` };
  }
  if (!res || res.blocked === true || res.verdict === "block" || typeof res.data !== "string") {
    const reason = (res && (res.reason ?? res.error)) || "blocked (fail-closed)";
    return { ok: false, summary: `web_fetch blocked: ${reason}`, verdict: { verdict: "block" } };
  }
  const { text, truncated } = capUtf8(res.data, WEB_FETCH_MAX_BYTES);
  const note = truncated ? `\n[truncated at ${WEB_FETCH_MAX_BYTES} bytes]` : "";
  const warn =
    res.verdict === "warn" ? `\n[warning: ${res.reason ?? "flagged as suspicious"}]` : "";
  // The redirect target is attacker-controlled. Strip what could break out of the frame.
  const src = (res.final_url || url).replace(/[<>"\r\n]/g, "");
  return {
    ok: true,
    summary: `<<untrusted-web-data source="${src}">>\n${defangFrameMarkers(`${text}${note}`)}\n<<end untrusted-web-data>>${warn}`,
    data: {
      url,
      final_url: res.final_url,
      verdict: res.verdict,
      provenance: res.provenance,
      datamark: true,
    },
    ...(res.verdict === "warn" ? { verdict: { verdict: "warn" as const } } : {}),
  };
}

/** `web_search` — a JSON provider through the same proxy; never invents a result. */
export async function webSearchTool(
  args: Record<string, unknown>,
  safeFetch: SafeFetchLike,
  opts: WebToolOptions = {},
): Promise<ToolOutcome> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { ok: false, summary: "web_search: no query given" };
  const env = opts.env ?? {};
  const hasKey = (name: string): boolean => (env[name] ?? "").trim().length > 0;
  const choice = selectProvider(opts.providerId, hasKey);
  const provider: SearchProvider | undefined = choice.provider;
  if (!provider) {
    return {
      ok: false,
      summary: `${choice.error ?? "no search provider"}. ${NO_PROVIDER_MESSAGE}`,
    };
  }
  const limit = clampLimit(args.limit);
  const req = provider.request(query, limit);
  // The key rides the ENVIRONMENT, consumed once at spawn — never argv, which `ps` shows.
  const key = provider.keyEnv ? (env[provider.keyEnv] ?? "").trim() : "";
  const auth =
    req.auth && key
      ? {
          authHeader: { header: req.auth.header, env: SEARCH_KEY_ENV },
          sidecar: {
            env: { [SEARCH_KEY_ENV]: req.auth.scheme ? `${req.auth.scheme} ${key}` : key },
          },
        }
      : {};
  let res: Awaited<ReturnType<SafeFetchLike>>;
  try {
    res = await safeFetch(req.url, {
      maxBytes: WEB_FETCH_MAX_BYTES,
      timeoutSec: WEB_FETCH_TIMEOUT_SEC,
      ...(req.method ? { method: req.method } : {}),
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...auth,
    });
  } catch (err) {
    return { ok: false, summary: `web_search blocked (fail-closed): ${errText(err)}` };
  }
  if (!res || res.blocked === true || res.verdict === "block" || typeof res.data !== "string") {
    const reason = (res && (res.reason ?? res.error)) || "blocked (fail-closed)";
    return { ok: false, summary: `web_search blocked: ${reason}`, verdict: { verdict: "block" } };
  }
  let body: unknown;
  try {
    body = JSON.parse(res.data);
  } catch {
    // Guessing at results from prose is the one thing this tool must never do.
    return {
      ok: false,
      summary: `web_search: ${provider.id} returned a body that was not JSON — no results, and none invented.`,
    };
  }
  return {
    ok: true,
    summary: renderResults(provider, query, provider.parse(body, limit), choice.note),
  };
}

/** What a host may inject to gate egress before a request is ever built. */
export interface WebToolOptions {
  providerId?: string;
  env?: Record<string, string | undefined>;
  /**
   * The active network policy, consulted BEFORE any request.
   *
   * Injected rather than imported so this module keeps no settings dependency, and OPTIONAL
   * because a host with no settings layer (the CLI) has no policy to apply. When a host does
   * supply one, `defaultNetwork` finally means something for the web tools: it was declared,
   * shown in the UI, and read by nothing but the model endpoint.
   */
  egress?: () => { allowed: boolean; reason?: string };
}

/**
 * Dispatch a web tool by name, or null when it is not one.
 *
 * The egress check runs FIRST, for both tools, before a URL is parsed or a provider chosen —
 * a policy that only applies once a request is half-built is a policy with a hole in it.
 */
export function runWebTool(
  name: string,
  args: Record<string, unknown>,
  safeFetch: SafeFetchLike,
  opts: WebToolOptions = {},
): Promise<ToolOutcome> | null {
  if (name !== "web_fetch" && name !== "web_search") return null;
  const gate = opts.egress?.();
  if (gate && !gate.allowed) {
    return Promise.resolve({
      ok: false,
      summary: `${name} refused: ${gate.reason ?? "network access is not permitted"}`,
    });
  }
  if (name === "web_fetch") return webFetchTool(args, safeFetch);
  return webSearchTool(args, safeFetch, opts);
}
