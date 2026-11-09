// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/** main/browser-local-host.ts — the subresource host check for the agent browser. PURE. */

/**
 * Is this host a loopback / private / link-local address (or a name for one)?
 *
 * The preflight vets the URL the AGENT asked for; it never sees what the PAGE then requests.
 * A page's own `fetch("http://127.0.0.1:11434/api/generate")` loads a 23 GB model (CLAUDE.md
 * §2.3), and `fetch("http://192.168.1.1/…")` reaches the router. Literal addresses and the
 * well-known local names are refused for every subresource. DNS rebinding to a private address
 * is not caught here — the main-frame URL still went through `safeFetchCheck`.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) return true;
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (h.includes(":")) {
    return (
      h === "::" ||
      h === "::1" ||
      h.startsWith("fe80:") ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("::ffff:")
    );
  }
  return false;
}
