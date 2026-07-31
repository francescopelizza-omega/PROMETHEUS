/**
 * ide/ai/endpoints.ts — PURE Model-Hub endpoint resolution (file 07 §7.5).
 *
 * Shared by every AI surface (the agent pane, Cmd-K inline edit, ghost-text inline
 * completions) so the privacy-critical "local vs cloud" classification + the endpoint
 * flattening live in ONE place instead of being re-derived (and subtly mis-classified)
 * per component. NO react / monaco / electron — unit-testable under node:test.
 *
 * Privacy (§7.5): only loopback / unix-socket / *.local count as "local"; everything
 * else (incl. a remote OpenAI-compatible host) is "cloud" so the `neverSendToCloud`
 * policy in streamChat actually fires. An unparseable URL is "cloud" (fail-safe).
 */

import type { ModelEndpointsResult } from "../../../shared/ipc-contract.js";
import type { RendererEndpoint } from "./ai-client.js";
import { fimFamilyOf } from "./fim-cache.js";

/** Classify an endpoint base URL as local (free/offline/private) or cloud. */
export function localityOf(baseUrl: string): "local" | "cloud" {
  try {
    const u = new URL(baseUrl);
    if (u.protocol === "unix:" || u.protocol === "file:") return "local";
    // URL.hostname wraps IPv6 in brackets ("[::1]") — strip them so loopback matches.
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return "local";
    if (h.endsWith(".local")) return "local";
    return "cloud";
  } catch {
    return "cloud";
  }
}

/** Flatten a Model Hub endpoints result → the renderer endpoint list (local first). */
export function toEndpoints(res: ModelEndpointsResult | undefined): RendererEndpoint[] {
  if (!res?.ok) return [];
  // guard: an ok result can omit local/openApi → .map would crash. Locality is derived
  // from the host (a hard-coded "local" once let the no-cloud guard be bypassed).
  const local: RendererEndpoint[] = (res.local ?? []).map((e) => ({
    id: e.name,
    baseUrl: e.baseUrl,
    locality: localityOf(e.baseUrl),
  }));
  const open: RendererEndpoint[] = (res.openApi ?? []).map((e) => ({
    id: e.name,
    baseUrl: e.baseUrl,
    locality: localityOf(e.baseUrl),
  }));
  return [...local, ...open];
}

/* ── APP-092: model-picker metadata (provider kind + capability badges + context) ──
 * The endpoints feed carries only {name, baseUrl}; the RICHER metadata (context window,
 * capability tags) lives in the open-models catalog reached via `models.search()`. This
 * derives a per-endpoint metadata badge set PURELY from the endpoint + an optional catalog
 * slice (matched by id/family from the endpoint's model name) — no hardcoded per-model table.
 */

/** The catalog fields the picker needs (a lite slice of engine-bridge's `Model`). */
export interface CatalogModelLite {
  id: string;
  family?: string;
  /** the model context window (catalog `context` → engine-bridge `contextLen`). */
  contextLen?: number;
  /** free-form capability tags (vision/multimodal/tool-use/agentic/coding/…). */
  tags?: string[];
}

export interface EndpointCapabilities {
  tools: boolean;
  vision: boolean;
  /** fill-in-the-middle (ghost-text) — a KNOWN FIM model family (fim-cache.fimFamilyOf). */
  fim: boolean;
}

export interface EndpointMeta {
  locality: "local" | "cloud";
  family?: string;
  contextWindow?: number;
  caps: EndpointCapabilities;
}

/** Best-effort match of an endpoint to a catalog model: exact id, else a family/substring hit
 *  on the endpoint's model name (the endpoints feed carries no catalog id, only a name). */
export function matchCatalog(
  ep: RendererEndpoint,
  catalog: readonly CatalogModelLite[],
): CatalogModelLite | undefined {
  const name = (ep.model ?? ep.id).toLowerCase();
  const exact = catalog.find((m) => m.id.toLowerCase() === name);
  if (exact) return exact;
  // a served name like "qwen2.5-coder:7b" → match a catalog id/family that is a substring.
  return catalog.find(
    (m) =>
      name.includes(m.id.toLowerCase()) ||
      (m.family ? name.includes(m.family.toLowerCase()) : false),
  );
}

const TOOL_TAGS = new Set(["tool-use", "tools", "agentic", "function-calling"]);
const VISION_TAGS = new Set(["vision", "multimodal", "image"]);

/** Derive the picker metadata for an endpoint from its locality + the matched catalog entry.
 *  Capabilities: tools/vision from catalog tags; FIM from the model family (fim-cache). With
 *  no catalog match, capabilities fall back to name heuristics so a badge still shows. */
export function endpointMeta(
  ep: RendererEndpoint,
  catalog: readonly CatalogModelLite[] = [],
): EndpointMeta {
  const model = matchCatalog(ep, catalog);
  const name = (ep.model ?? ep.id).toLowerCase();
  const tags = (model?.tags ?? []).map((t) => t.toLowerCase());
  const tools = tags.some((t) => TOOL_TAGS.has(t)) || name.includes("instruct");
  const vision = tags.some((t) => VISION_TAGS.has(t)) || /vl|vision|llava|multimodal/.test(name);
  const fim = fimFamilyOf(model?.id ?? ep.model ?? ep.id) !== null;
  const meta: EndpointMeta = {
    locality: ep.locality,
    caps: { tools, vision, fim },
  };
  if (model?.family) meta.family = model.family;
  if (typeof model?.contextLen === "number") meta.contextWindow = model.contextLen;
  return meta;
}

/** Human-readable context window ("32K", "128K", "1M") for the picker badge. */
export function formatContextWindow(n: number | undefined): string | undefined {
  if (!n || n <= 0) return undefined;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
