// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/settings-bundle.ts — the PURE git-sync settings bundle + STRUCTURAL redaction (APP-095).
 *
 * A shareable snapshot of a user's Studio settings (keymap + custom themes + MCP connector
 * configs) for the git-backed sync. Redaction is STRUCTURAL, not a regex scrub (the directive):
 * a connector's secrets live ONLY in `transport.env` (stdio API keys) / `transport.headers`
 * (http bearer tokens), and this builder simply NEVER copies those fields into the bundle — an
 * allow-listed rebuild, so a token value can never reach the committed bytes. Pure (no electron/
 * git/fs) so `settings-sync-ipc.ts` does the IO and this stays node:test-able.
 */
import type { mcpHost } from "@prometheus/core";

type McpServerConfig = mcpHost.McpServerConfig;

export const SETTINGS_BUNDLE_VERSION = 1;

/** A connector with EVERY secret-bearing field (transport.env / transport.headers) omitted. */
export interface RedactedConnector {
  id: string;
  label: string;
  transport: {
    kind: "stdio" | "http";
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
  };
  enabled: boolean;
  scope: string;
  source: string;
  autoApprove: string[];
}

/** The keymap slice a bundle carries (base preset id + the user override layer). */
export interface KeymapSlice {
  base: string;
  overrides: unknown[];
}

/** The whole exported settings bundle (the committed file). */
export interface SettingsBundle {
  version: number;
  keymap: KeymapSlice;
  /** custom (imported/authored) color schemes — no secrets by construction. */
  themes: unknown[];
  connectors: RedactedConnector[];
}

/** Strip credentials that ride in a URL — userinfo (`user:token@`) + secret-looking query
 *  params — so a bearer/api-key embedded in the endpoint doesn't survive into the shared,
 *  git-pushed bundle (the env/headers drop doesn't cover these). Unparseable → left verbatim. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    const SECRET_PARAM =
      /^(api[_-]?key|access[_-]?token|token|secret|password|passwd|auth|key|sig|signature)$/i;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Rebuild a connector with ONLY its non-secret fields — `transport.env` (stdio) and
 * `transport.headers` (http) are STRUCTURALLY DROPPED (never read into the result), so no
 * API key / bearer token can survive into the bundle; the http `url` is credential-stripped.
 */
export function redactConnector(cfg: McpServerConfig): RedactedConnector {
  const t = cfg.transport;
  const transport: RedactedConnector["transport"] =
    t.kind === "stdio"
      ? {
          kind: "stdio",
          command: t.command,
          args: [...t.args],
          ...(t.cwd ? { cwd: t.cwd } : {}),
          // t.env is deliberately NOT copied — that is where stdio secrets live.
        }
      : {
          kind: "http",
          url: redactUrl(t.url),
          // t.headers is deliberately NOT copied — that is where http bearer tokens live.
        };
  return {
    id: cfg.id,
    label: cfg.label,
    transport,
    enabled: cfg.enabled,
    scope: cfg.scope,
    source: cfg.source,
    autoApprove: [...cfg.autoApprove],
  };
}

/** Assemble the bundle from the renderer's keymap/themes + the (full) connector configs,
 *  redacting every connector on the way in. */
export function buildSettingsBundle(input: {
  keymap: KeymapSlice;
  themes: unknown[];
  connectors: readonly McpServerConfig[];
}): SettingsBundle {
  return {
    version: SETTINGS_BUNDLE_VERSION,
    keymap: { base: input.keymap.base, overrides: [...input.keymap.overrides] },
    themes: [...input.themes],
    connectors: input.connectors.map(redactConnector),
  };
}

/** Serialize a bundle to a DETERMINISTIC JSON string (stable key order for a clean git diff). */
export function serializeBundle(bundle: SettingsBundle): string {
  return JSON.stringify(
    {
      version: bundle.version,
      keymap: { base: bundle.keymap.base, overrides: bundle.keymap.overrides },
      themes: bundle.themes,
      connectors: bundle.connectors,
    },
    null,
    2,
  );
}

/**
 * Parse + VALIDATE a pulled bundle (fail-closed). A poisoned repo must never silently rewrite
 * the keymap/connectors, so the shape is checked before the renderer is even offered it to
 * apply (and the renderer applies only after an explicit confirm). Returns the bundle or an
 * `{ error }` (callers narrow on `"error" in x`).
 */
export function validateSettingsBundle(json: string): SettingsBundle | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { error: "not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "expected a settings bundle object" };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== "number") return { error: "missing version" };
  const km = o.keymap as Record<string, unknown> | undefined;
  if (!km || typeof km.base !== "string" || !Array.isArray(km.overrides)) {
    return { error: "invalid keymap slice" };
  }
  if (!Array.isArray(o.themes)) return { error: "invalid themes" };
  if (!Array.isArray(o.connectors)) return { error: "invalid connectors" };
  return {
    version: o.version,
    keymap: { base: km.base, overrides: km.overrides },
    themes: o.themes,
    connectors: o.connectors as RedactedConnector[],
  };
}
