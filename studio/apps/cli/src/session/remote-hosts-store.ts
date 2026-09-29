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
import { parseSshDestination, validateSshTarget } from "@prometheus/engine-bridge";

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
        ...parseSshPart(r.ssh),
        ...parseTunnelPart(r.tunnel),
        // The cached hardware probe is DATA, not configuration: it is re-read from the machine
        // whenever it is used and is kept only so a picker can show a box without waiting on
        // ssh. It is passed through unvalidated beyond its shape for that reason.
        ...(r.hardware && typeof r.hardware === "object"
          ? { hardware: r.hardware as ai.RemoteHardware }
          : {}),
        ...(typeof r.hardwareAt === "string" && r.hardwareAt ? { hardwareAt: r.hardwareAt } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Re-validate a stored SSH target on the way back in.
 *
 * The settings file is a plain JSON file the user can edit, and an `ssh` block from it becomes
 * argv for a spawn. `validateSshTarget` is the same gate a freshly typed host goes through — a
 * hand-edited `"host": "-oProxyCommand=sh"` must fail here exactly as it would there. Trusting
 * stored data because it is stored is how a config file becomes a code-execution vector.
 */
function parseSshPart(raw: unknown): { ssh?: ai.SshTarget } {
  if (!raw || typeof raw !== "object") return {};
  const s = raw as Record<string, unknown>;
  if (typeof s.host !== "string") return {};
  const v = validateSshTarget({
    host: s.host,
    ...(typeof s.user === "string" ? { user: s.user } : {}),
    ...(typeof s.port === "number" ? { port: s.port } : {}),
    ...(typeof s.identityFile === "string" ? { identityFile: s.identityFile } : {}),
    ...(s.acceptNewHostKey === true ? { acceptNewHostKey: true } : {}),
  });
  return v.ok ? { ssh: v.target } : {};
}

function parseTunnelPart(raw: unknown): { tunnel?: { remotePort: number } } {
  if (!raw || typeof raw !== "object") return {};
  const t = raw as Record<string, unknown>;
  const p = t.remotePort;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) return {};
  return { tunnel: { remotePort: p } };
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
export const REMOTE_ADD_USAGE =
  "usage: /remote add <url|host> [--ssh [user@]host[:port]] [--identity <key>] [--tunnel [port]] [--ram GB] [--label name] [--trust-new]";

export function parseRemoteArgs(
  rest: string,
): { ok: true; entry: ai.RemoteHost } | { ok: false; error: string } {
  const toks = rest.trim().split(/\s+/).filter(Boolean);
  let url = "";
  let ramGb: number | undefined;
  let label: string | undefined;
  let sshSpec: string | undefined;
  let identity: string | undefined;
  let trustNew = false;
  let tunnelPort: number | undefined;
  let wantsTunnel = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as string;
    if (t === "--ram") {
      const n = Number(toks[++i]);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "--ram needs a size in GB" };
      ramGb = n;
    } else if (t === "--label") {
      label = toks[++i];
      if (!label) return { ok: false, error: "--label needs a value" };
    } else if (t === "--ssh") {
      // `--ssh` with no value means "the same host as the URL, with ssh's own defaults".
      const next = toks[i + 1];
      if (next && !next.startsWith("--")) {
        sshSpec = next;
        i++;
      } else {
        sshSpec = "";
      }
    } else if (t === "--identity" || t === "-i") {
      identity = toks[++i];
      if (!identity) return { ok: false, error: "--identity needs a path to a private key" };
    } else if (t === "--trust-new") {
      trustNew = true;
    } else if (t === "--tunnel") {
      wantsTunnel = true;
      const next = toks[i + 1];
      if (next && /^\d+$/.test(next)) {
        tunnelPort = Number(next);
        i++;
      }
    } else if (t.startsWith("-")) {
      return { ok: false, error: `unknown option ${t}` };
    } else if (!url) {
      url = t;
    } else {
      return { ok: false, error: "one URL at a time" };
    }
  }
  if (!url) return { ok: false, error: REMOTE_ADD_USAGE };
  // A bare host is a URL the user meant; assume the ollama default rather than making them
  // spell out a scheme and a port they already know.
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}:11434/v1`;
  const host = ai.hostOf(full);
  if (!host) return { ok: false, error: `${url} is not a usable address` };

  let ssh: ai.SshTarget | undefined;
  if (sshSpec !== undefined) {
    // An empty `--ssh` inherits the host from the URL, which is what the user almost always
    // means and saves them typing the same name twice.
    const parsed = sshSpec ? parseSshDestination(sshSpec) : validateSshTarget({ host });
    if (!parsed.ok) return { ok: false, error: `--ssh: ${parsed.error}` };
    ssh = {
      ...parsed.target,
      ...(identity ? { identityFile: identity } : {}),
      ...(trustNew ? { acceptNewHostKey: true } : {}),
    };
    const revalidated = validateSshTarget(ssh);
    if (!revalidated.ok) return { ok: false, error: `--ssh: ${revalidated.error}` };
    ssh = revalidated.target;
  } else if (identity || trustNew) {
    return { ok: false, error: "--identity and --trust-new only make sense with --ssh" };
  }

  if (wantsTunnel && !ssh) {
    return {
      ok: false,
      error: "--tunnel needs --ssh: the tunnel is carried inside the ssh connection",
    };
  }
  /**
   * The remote port to forward.
   *
   * Defaults to the port in the URL the user gave, because that is the port they have already
   * said the runner listens on — asking for it twice would be asking them to repeat themselves
   * and then punishing a mismatch.
   */
  const urlPort = portOf(full);
  const remotePort = tunnelPort ?? urlPort ?? 11434;

  return {
    ok: true,
    entry: {
      host,
      baseUrl: full,
      ...(label ? { label } : {}),
      ...(ramGb ? { totalMemoryBytes: Math.round(ramGb * 1024 ** 3) } : {}),
      ...(ssh ? { ssh } : {}),
      ...(wantsTunnel ? { tunnel: { remotePort } } : {}),
    },
  };
}

/** The explicit port in a URL, or null when it relies on the scheme's default. */
export function portOf(url: string): number | null {
  try {
    const p = new URL(url).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}
