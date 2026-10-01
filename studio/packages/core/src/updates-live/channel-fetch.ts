// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/channel-fetch.ts — ask one `LatestChannel` what the newest version is.
 *
 * `fetch.ts` covers the two channels the old five-row table used. This covers all seven, and
 * exists mainly to preserve one distinction that the old shape could not express:
 *
 *   **"nothing newer" and "could not look" are different answers.**
 *
 * Every previous version of this collapsed both to `null`, which `check.ts` then turned into
 * `updateAvailable: false`, which `formatUpdateReport` printed as "up to date". A rate-limited
 * GitHub, an offline laptop and a genuinely current tool were indistinguishable — and two of
 * those three were reassurance the user had not earned. `ChannelAnswer` keeps them apart, and
 * the report renders the third case as "could not check".
 *
 * Fail-soft, never throws, hard timeout on every request.
 */
import * as u from "../updates/index.js";

const DEFAULT_TIMEOUT_MS = 4000;

/** What a channel said. */
export type ChannelAnswer =
  /** the newest version it publishes. */
  | { kind: "version"; version: string; channel: string }
  /** a vendor endpoint that answers the question directly rather than with a number. */
  | { kind: "newer"; url: string; channel: string }
  | { kind: "current"; channel: string }
  /** we could not find out. NOT the same as "current" — the report must say so. */
  | { kind: "unknown"; channel: string; why: string };

export interface FetchDeps {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function get(
  url: string,
  deps: FetchDeps,
  headers?: Record<string, string>,
): Promise<{ status: number; text: string } | null> {
  const f = deps.fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await f(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", ...headers },
    });
    // 204 carries no body and is meaningful on its own (ollama's delta endpoint).
    const text = res.status === 204 ? "" : await res.text();
    return { status: res.status, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A short label for the channel, so the report can say WHERE a number came from. */
export function channelLabel(c: u.LatestChannel): string {
  switch (c.kind) {
    case "npm":
      return `npm:${c.pkg}`;
    case "brew-formula":
      return `brew formula:${c.name}`;
    case "brew-cask":
      return `brew cask:${c.token}`;
    case "pypi":
      return `pypi:${c.pkg}`;
    case "github":
      return `github:${c.repo}`;
    case "vendor-delta":
      return "vendor";
    default:
      return "none";
  }
}

/**
 * Ask ONE channel.
 *
 * `installed` is required by `vendor-delta`, which answers "is there something newer than this"
 * rather than "what is the newest" — asking it without a version is meaningless, so it returns
 * `unknown` rather than guessing.
 */
export async function askChannel(
  channel: u.LatestChannel,
  installed: string | null,
  deps: FetchDeps = {},
): Promise<ChannelAnswer> {
  const label = channelLabel(channel);
  if (channel.kind === "none") return { kind: "unknown", channel: label, why: channel.why };

  if (channel.kind === "vendor-delta") {
    if (!installed) {
      return { kind: "unknown", channel: label, why: "needs the installed version to ask" };
    }
    const url = u.vendorDeltaUrl(channel, {
      os: process.platform === "darwin" ? "darwin" : process.platform,
      arch: process.arch,
      version: installed,
    });
    if (!url)
      return { kind: "unknown", channel: label, why: "version not in a form the vendor accepts" };
    const r = await get(url, deps);
    if (!r) return { kind: "unknown", channel: label, why: "unreachable" };
    const verdict = u.parseVendorDelta(r.status, r.text);
    if (verdict === "current") return { kind: "current", channel: label };
    if (verdict === null) return { kind: "unknown", channel: label, why: `HTTP ${r.status}` };
    return { kind: "newer", url: verdict.url, channel: label };
  }

  const url = u.latestUrl(channel);
  if (!url) return { kind: "unknown", channel: label, why: "no endpoint" };
  const r = await get(
    url,
    deps,
    channel.kind === "github" ? { "x-github-api-version": "2022-11-28" } : undefined,
  );
  if (!r) return { kind: "unknown", channel: label, why: "unreachable" };
  if (r.status === 403 || r.status === 429) {
    /**
     * GitHub's unauthenticated limit is 60 requests/hour and has been measured exhausted inside a
     * single working session. Reporting that as "up to date" is the exact failure this type
     * exists to prevent, so it is named explicitly rather than folded into a generic failure.
     */
    return { kind: "unknown", channel: label, why: "rate-limited" };
  }
  if (r.status < 200 || r.status >= 300)
    return { kind: "unknown", channel: label, why: `HTTP ${r.status}` };
  let json: unknown;
  try {
    json = JSON.parse(r.text);
  } catch {
    return { kind: "unknown", channel: label, why: "unparseable response" };
  }
  const v = u.parseLatest(channel, json);
  return v
    ? { kind: "version", version: v, channel: label }
    : { kind: "unknown", channel: label, why: "no version in response" };
}

/**
 * Walk a tool's channels in preference order, PREFERRING the one that matches how it was
 * installed.
 *
 * The reordering is the point. Homebrew packages `gemini-cli` as a formula and its version trails
 * npm badly — 0.46.0 against 0.61.0, measured. Comparing a brew install against the npm number
 * produces a real gap with no usable remedy: `npm install -g` lands a second launcher that brew's
 * own symlink shadows, which is the user's original complaint, manufactured by the update
 * checker. A brew install is judged against brew, because brew is what will actually install the
 * next version of it.
 */
export async function askLatest(
  tool: u.ToolCheck,
  owner: u.InstallOwner | undefined,
  installed: string | null,
  deps: FetchDeps = {},
): Promise<ChannelAnswer> {
  /**
   * EXCLUDE before reordering. Preference alone was not enough: a channel that is wrong for this
   * install still answered when the preferred one did not, and the caller has no way to tell a
   * comparison against the wrong artifact from a comparison against the right one. See
   * `LatestChannel.onlyOwners` for the LM Studio measurement that forced this.
   */
  const usable = tool.latest.filter(
    (c) => !c.onlyOwners || (owner && c.onlyOwners.includes(owner)),
  );
  const preferred =
    owner === "brew-formula" ? "brew-formula" : owner === "brew-cask" ? "brew-cask" : null;
  const ordered = preferred
    ? [...usable].sort((a, b) => Number(b.kind === preferred) - Number(a.kind === preferred))
    : usable;

  let firstFailure: ChannelAnswer | null = null;
  for (const c of ordered) {
    const ans = await askChannel(c, installed, deps);
    if (ans.kind !== "unknown") return ans;
    firstFailure ??= ans;
  }
  return firstFailure ?? { kind: "unknown", channel: "none", why: "no channel" };
}

/** The newest release of the Prometheus project itself — GitLab, not GitHub. */
export async function fetchGitlabLatest(
  repo: string,
  deps: FetchDeps = {},
): Promise<string | null> {
  return (await fetchGitlabRelease(repo, deps)).version;
}

/**
 * The same lookup, keeping the REASON when there is no version.
 *
 * `null` answered three different questions with one value: "nothing is published", "the project
 * is private", and "the network is down". The report then printed "could not check for updates"
 * for all three — which for this repo is actively misleading, because nothing failed.
 *
 * Measured, read-only and unauthenticated:
 *   GET /api/v4/projects/red-beard-phoenix%2FPROMETHEUS/releases/permalink/latest
 *     → 404  {"message":"404 Project Not Found"}
 *
 * The URL encoding is correct (`encodeURIComponent` gives GitLab's documented `%2F` project-path
 * form) and the bare project endpoint answers identically. GitLab returns 404 rather than 403 for
 * a private project so that an unauthenticated caller cannot confirm it exists — so a 404 here is
 * a definitive answer about visibility, not a failure. `git ls-remote` against the same repo
 * succeeds, because that path is authenticated.
 */
export async function fetchGitlabRelease(
  repo: string,
  deps: FetchDeps = {},
): Promise<{ version: string | null; why?: string }> {
  const r = await get(u.gitlabLatestUrl(repo), deps);
  if (!r) return { version: null, why: "the release feed could not be reached" };
  if (r.status === 404) {
    return {
      version: null,
      why: "no public release feed — the project is private or has no releases, so there is nothing to compare against",
    };
  }
  if (r.status < 200 || r.status >= 300) {
    return { version: null, why: `the release feed answered HTTP ${r.status}` };
  }
  try {
    const v = u.latestFromGitlab(JSON.parse(r.text));
    return v ? { version: v } : { version: null, why: "the release feed named no version" };
  } catch {
    return { version: null, why: "the release feed was not readable JSON" };
  }
}
