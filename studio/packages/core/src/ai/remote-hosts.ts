// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/remote-hosts.ts — self-hosted model servers on another machine you own.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────────────────────
 *
 * A GPU box on the LAN at `http://gpu-box.lan:11434/v1` is, today, unreachable. `localityOfUrl`
 * classifies every non-loopback, non-`*.local` host as `"cloud"`, so a machine standing three
 * feet away is treated as a third-party API provider: refused under the local-only profile,
 * refused by "never send to cloud", and its `/api/show` and `/models` probes hard-refused. There
 * is no way to say "that one is mine".
 *
 * ── WHY NOT A THIRD LOCALITY ────────────────────────────────────────────────────────────────
 *
 * The obvious fix — `EndpointLocality = "local" | "cloud" | "remote"` — touches roughly two
 * hundred sites and every exhaustive check over the union, including the egress posture, which
 * is security-relevant. A change that large to a privacy decision, to add a feature, is the
 * wrong trade. Instead the locality union is untouched and a declared host is resolved to
 * `"local"` for the EGRESS question only, because that is precisely what the user asserted:
 * this is my own runner, not a third party.
 *
 * ── WHAT IS AND IS NOT ASSERTED ─────────────────────────────────────────────────────────────
 *
 * DEFAULT DENY. A host is trusted only after it is declared, by hand, in settings. Nothing is
 * inferred from a private IP range — "it is on 192.168/16 so it must be mine" is exactly the
 * assumption that makes a coffee-shop network dangerous, and it is not made here.
 *
 * The declaration says "this endpoint is my own model server". It does NOT say the network in
 * between is private: plain HTTP to a LAN host is still plain HTTP, and `warnings()` says so.
 *
 * ── MEMORY IS ASKED OF THE RIGHT MACHINE ────────────────────────────────────────────────────
 *
 * Admission (`ai/model-admission.ts`) is already host-parameterised: it takes a budget carrying
 * the host it describes, and `session/model-admission-host.ts` derives that host from the
 * endpoint's own URL. So a model served from a declared remote host is weighed against THAT
 * machine's memory and THAT machine's resident servers, with no local RAM involved.
 *
 * ── AND MEASURED, NOT DECLARED, WHEN SSH IS AVAILABLE ───────────────────────────────────────
 *
 * `totalMemoryBytes` was the first answer to "how big is that box?", and it is a weak one: the
 * user types a number once and it is thereafter believed forever, including after they add RAM,
 * after someone else fills the GPU, and after the box is rebooted into a different machine
 * entirely. `ssh` replaces it with a measurement — `ai/remote-probe.ts` reads the remote
 * kernel's own figures, the same ones the local probe reads, plus the VRAM that is the real
 * constraint on a discrete-GPU machine. The declaration stays as the fallback for a host that
 * has no SSH access.
 */
import type { RemoteHardware, SshTarget } from "@prometheus/engine-bridge";

/** A model server the user has declared to be their own. */
export interface RemoteHost {
  /** hostname or IP, lowercased, no port — the identity the allowlist matches on. */
  host: string;
  /** the base URL to talk to, e.g. "http://gpu-box.lan:11434/v1". */
  baseUrl: string;
  /** optional human label for pickers. */
  label?: string;
  /**
   * Total RAM of that machine, in bytes, when the user has told us.
   *
   * A model runner's HTTP API reports what is RESIDENT, never how much the box has — so without
   * this the admission check knows what is loaded but not what is left. Declaring it turns a
   * remote fit check from "cannot say" into the same arithmetic the local one uses.
   *
   * Superseded by `hardware` once an SSH probe has run: a measurement beats a declaration, and
   * unlike a declaration it notices when someone adds a stick of RAM or fills the GPU.
   */
  totalMemoryBytes?: number;
  /**
   * How to reach the machine itself, as opposed to its model server.
   *
   * This is what turns a remote host from an opaque HTTP endpoint into a machine Prometheus can
   * actually reason about: RAM, free RAM, GPUs, VRAM, disk, whether a runner is even installed.
   * Without it the fit check runs on a number the user typed once; with it, on the same kernel
   * metrics the local check uses.
   */
  ssh?: SshTarget;
  /**
   * Reach the runner through an SSH tunnel rather than over the network.
   *
   * When set, the runner's port on the REMOTE machine is forwarded to loopback here, so the
   * remote runner never has to listen on anything but its own 127.0.0.1. Prompts and replies
   * travel inside SSH. `remotePort` is the port the runner listens on over there — the local
   * port is chosen at connect time and never needs configuring.
   */
  tunnel?: { remotePort: number };
  /** the last hardware probe, cached so a picker can show a machine without waiting on SSH. */
  hardware?: RemoteHardware;
  /** when that probe ran, ISO. Shown, because a stale reading should look stale. */
  hardwareAt?: string;
}

/**
 * Normalise a host for comparison: lowercase, no brackets, no port, no trailing dot.
 *
 * The port is stripped only from a NAME or an IPv4 literal. A bare IPv6 address is all colons,
 * so a blanket `:\d+$` turns `::1` into `:` — which then matches nothing and silently untrusts
 * a declared loopback host.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  // "[::1]:11434" or "[::1]" — the brackets delimit the address, so the port is unambiguous.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (bracketed?.[1]) return bracketed[1].replace(/\.$/, "");
  // A bare IPv6 literal has several colons and never carries a port in this position.
  if ((h.match(/:/g)?.length ?? 0) <= 1) h = h.replace(/:\d+$/, "");
  return h.replace(/\.$/, "");
}

/** The hostname inside a URL, normalised. `null` when the URL is unparseable. */
export function hostOf(baseUrl: string): string | null {
  try {
    return normalizeHost(new URL(baseUrl).hostname);
  } catch {
    return null;
  }
}

/** Is this URL one of the declared self-hosted runners? */
export function isDeclaredRemoteHost(
  baseUrl: string,
  hosts: readonly RemoteHost[] | undefined,
): boolean {
  if (!hosts || hosts.length === 0) return false;
  const h = hostOf(baseUrl);
  if (!h) return false;
  return hosts.some((r) => normalizeHost(r.host) === h);
}

/** The declared host record for a URL, if any. */
export function findRemoteHost(
  baseUrl: string,
  hosts: readonly RemoteHost[] | undefined,
): RemoteHost | undefined {
  const h = hostOf(baseUrl);
  if (!h) return undefined;
  return hosts?.find((r) => normalizeHost(r.host) === h);
}

/**
 * Locality for the EGRESS decision, with the allowlist taken into account.
 *
 * Identical to the historical `localityOfUrl` in every case except one: a host the user
 * declared as their own resolves to `"local"`. Loopback stays local, everything undeclared
 * stays `"cloud"` — the default is unchanged, so a user who never touches this feature sees
 * exactly the behaviour they saw before.
 */
export function localityWithRemotes(
  baseUrl: string,
  hosts?: readonly RemoteHost[],
): "local" | "cloud" {
  try {
    const u = new URL(baseUrl);
    if (u.protocol === "unix:" || u.protocol === "file:") return "local";
    const h = normalizeHost(u.hostname);
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return "local";
    if (/^127\./.test(h)) return "local";
    if (h.endsWith(".local")) return "local";
    if (isDeclaredRemoteHost(baseUrl, hosts)) return "local";
    return "cloud";
  } catch {
    return "cloud";
  }
}

/** Is this a private/link-local address? Used ONLY to phrase a warning, never to grant trust. */
export function isPrivateAddress(host: string): boolean {
  const h = normalizeHost(host);
  return (
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^fc[0-9a-f]{2}:/i.test(h) ||
    /^fd[0-9a-f]{2}:/i.test(h) ||
    /^fe80:/i.test(h) ||
    h.endsWith(".lan") ||
    h.endsWith(".home") ||
    h.endsWith(".internal")
  );
}

/**
 * What the user should know before declaring a host, in their own terms.
 *
 * Returned rather than printed so each surface renders it its own way, and phrased as facts
 * rather than a scare: the point is an informed choice, not a discouraged one.
 */
export function warnings(entry: RemoteHost): string[] {
  const out: string[] = [];
  let url: URL | undefined;
  try {
    url = new URL(entry.baseUrl);
  } catch {
    out.push(`${entry.baseUrl} is not a valid URL`);
    return out;
  }
  /**
   * A tunnelled host is not exposed and not in the clear, so neither warning applies to it.
   *
   * This is the case worth steering people towards: the traffic is inside SSH, and the remote
   * runner can stay bound to its own loopback instead of listening on the network with no
   * authentication at all — which is what `http://gpu-box.lan:11434` requires.
   */
  const tunnelled = entry.tunnel !== undefined && entry.ssh !== undefined;
  if (url.protocol === "http:" && !tunnelled) {
    out.push(
      "prompts and replies will cross the network in plain text — anyone on the path can read them",
    );
    if (entry.ssh) {
      out.push("  (--tunnel would carry them inside ssh instead, and needs no open port there)");
    }
  }
  if (!isPrivateAddress(entry.host) && url.protocol === "http:" && !tunnelled) {
    out.push(
      `${entry.host} is not a private address, so this traffic may leave your network entirely`,
    );
  }
  if (entry.totalMemoryBytes === undefined && !entry.ssh) {
    out.push(
      "no memory size declared and no ssh access — Prometheus can see what is loaded there but not how much room is left, so it cannot refuse a model that will not fit",
    );
    out.push("  (--ssh <user@host> measures it instead of taking your word for it)");
  }
  return out;
}

/**
 * The settings key the declared remote hosts live under.
 *
 * Flat, and a JSON STRING rather than a nested object, because `saveSettings` is a shallow
 * `{...loadSettings(), ...patch}` that rewrites the whole file — a nested object written from
 * one surface would silently drop its siblings written by the other.
 */
export const REMOTE_HOSTS_KEY = "models.remoteHosts";

/**
 * Parse the stored `models.remoteHosts` value into the entries LOCALITY cares about.
 *
 * Lives in core because both surfaces must read the same store the same way. It did not, and
 * the consequence was concrete: a GPU box declared with the terminal's `/remote add` was
 * `locality: "local"` in the CLI and `"cloud"` in Studio, so under a local-only posture the
 * IDE refused the very endpoint the terminal was happily using. `apps/cli/src/session/
 * remote-hosts-store.ts` keeps the richer parse (it also validates the SSH target, which needs
 * engine-bridge); this is the subset every surface can agree on.
 *
 * FAIL-SOFT, and the direction matters: a corrupt or hand-edited value yields an EMPTY list,
 * never a throw and never a partial one. The list is an ALLOWLIST, so losing it costs access,
 * not safety — an unparseable entry must never become a host treated as local.
 */
export function parseRemoteHostsSetting(raw: unknown): RemoteHost[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RemoteHost[] = [];
    for (const row of parsed) {
      const r = row as Record<string, unknown>;
      if (typeof r?.host !== "string" || typeof r?.baseUrl !== "string") continue;
      if (!r.host.trim() || !r.baseUrl.trim()) continue;
      out.push({
        host: normalizeHost(r.host),
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
