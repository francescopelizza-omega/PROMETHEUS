/**
 * session/remote-hosts-store.ts — load and save the declared remote model servers.
 *
 * Persisted as a JSON STRING under the flat key `models.remoteHosts`, for the same reason the
 * external-tool defaults are flat: `saveSettings` in `home.ts` is a shallow
 * `{...loadSettings(), ...patch}` that rewrites the whole file, so a nested object written from
 * the terminal would silently drop its siblings.
 *
 * Every read is fail-soft. A corrupt or hand-edited value yields an EMPTY list, never a throw
 * and never a partial one — and an empty list is the safe outcome here, because the list is an
 * allowlist: losing it costs access, not safety.
 */
import { ai } from "@prometheus/core";

import { loadSettings, saveSettings } from "../home.js";

const KEY = "models.remoteHosts";

/** Parse the stored value. Anything unexpected is an empty list. */
export function parseRemoteHosts(raw: unknown): ai.RemoteHost[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ai.RemoteHost[] = [];
    for (const row of parsed) {
      const r = row as Record<string, unknown>;
      if (typeof r?.host !== "string" || typeof r?.baseUrl !== "string") continue;
      if (!r.host.trim() || !r.baseUrl.trim()) continue;
      out.push({
        host: ai.normalizeHost(r.host),
        baseUrl: r.baseUrl,
        ...(typeof r.label === "string" && r.label ? { label: r.label } : {}),
        ...(typeof r.totalMemoryBytes === "number" && r.totalMemoryBytes > 0
          ? { totalMemoryBytes: r.totalMemoryBytes }
          : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** The declared hosts. */
export function loadRemoteHosts(home?: string): ai.RemoteHost[] {
  return parseRemoteHosts((loadSettings(home) as Record<string, unknown>)[KEY]);
}

/** Replace the list. */
export function saveRemoteHosts(hosts: readonly ai.RemoteHost[], home?: string): void {
  saveSettings({ [KEY]: JSON.stringify(hosts) }, home);
}

/** Add or replace one host, matched on its normalised name. */
export function upsertRemoteHost(
  entry: ai.RemoteHost,
  hosts: readonly ai.RemoteHost[],
): ai.RemoteHost[] {
  const key = ai.normalizeHost(entry.host);
  return [...hosts.filter((h) => ai.normalizeHost(h.host) !== key), { ...entry, host: key }];
}

/** Remove one host. Returns the new list and whether anything was removed. */
export function removeRemoteHost(
  host: string,
  hosts: readonly ai.RemoteHost[],
): { hosts: ai.RemoteHost[]; removed: boolean } {
  const key = ai.normalizeHost(host);
  const next = hosts.filter((h) => ai.normalizeHost(h.host) !== key);
  return { hosts: next, removed: next.length !== hosts.length };
}

/**
 * Build a `RemoteHost` from a URL the user typed.
 *
 * `--ram <GB>` is optional but strongly wanted: without it the runner's API can say what is
 * loaded on that box but not how much room is left, so the fit check has nothing to subtract
 * from. `warnings()` says exactly that.
 */
export function parseRemoteArgs(
  rest: string,
): { ok: true; entry: ai.RemoteHost } | { ok: false; error: string } {
  const toks = rest.trim().split(/\s+/).filter(Boolean);
  let url = "";
  let ramGb: number | undefined;
  let label: string | undefined;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t === "--ram") {
      const n = Number(toks[++i]);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "--ram needs a size in GB" };
      ramGb = n;
    } else if (t === "--label") {
      label = toks[++i];
      if (!label) return { ok: false, error: "--label needs a value" };
    } else if (t.startsWith("-")) {
      return { ok: false, error: `unknown option ${t}` };
    } else if (!url) {
      url = t;
    } else {
      return { ok: false, error: "one URL at a time" };
    }
  }
  if (!url) return { ok: false, error: "usage: /remote add <url> [--ram GB] [--label name]" };
  // A bare host is a URL the user meant; assume the ollama default rather than making them
  // spell out a scheme and a port they already know.
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}:11434/v1`;
  const host = ai.hostOf(full);
  if (!host) return { ok: false, error: `${url} is not a usable address` };
  return {
    ok: true,
    entry: {
      host,
      baseUrl: full,
      ...(label ? { label } : {}),
      ...(ramGb ? { totalMemoryBytes: Math.round(ramGb * 1024 ** 3) } : {}),
    },
  };
}
