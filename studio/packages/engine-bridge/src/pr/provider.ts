// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * pr/provider.ts — the GitHub/GitLab pull/merge-request client (APP-085).
 *
 * PURE over an INJECTED `safeFetch` (the L6 SSRF-guarded proxy) — the ONLY way this
 * module touches the network. It never calls fetch/http directly, so a blocked / dead
 * sidecar is a visible `{ok:false}` error, NEVER a raw-fetch fallback. Every off-the-wire
 * array is guarded (the "reading 'filter'/'map'" panel-crash precedent). Both providers
 * normalize to ONE shape: a PR summary list, a detail (description + comments + a unified
 * diff string that feeds DiffView), and a post-comment op.
 *
 * The auth token is passed to safeFetch's env seam (`sidecar.env`) under a fixed var
 * name and referenced by header via `authHeader` — the token VALUE never enters argv.
 *
 * A PR's title/description/comments/diff are AUTHORED BY WHOEVER OPENED IT — an external
 * contributor, not the person using Prometheus — the exact class of content `web_fetch`/MCP
 * results/sub-agent reports are all now wrapped in an explicit untrusted-data frame for
 * elsewhere in this codebase. Today this data is consumed ONLY by the desktop's `GitPanel.tsx`
 * for human display, so `PrDetail`'s own fields stay exactly as they were — wrapping THOSE
 * would leak literal `<<...>>` markers into what a human reads in the UI. Instead,
 * `pullRequestAsUntrustedContext` below is a NEW, separate function a future prompt-consuming
 * feature ("review this PR") should reach for, so the fix exists before that feature does
 * rather than after. `safeFetch`'s own `verdict`/`ipi_signals` — already computed by the same
 * indirect-prompt-injection scan `web_fetch` uses, and previously read by `apiGet` only far
 * enough to decide `ok`/`error` — are now also preserved onto `PrDetail.suspicious`, so a signal
 * that already existed is surfaced instead of silently discarded.
 */

import type { IpiSignal, SafeFetchOptions, SafeFetchResult } from "../security/fetchproxy.js";

/** A git remote already resolved to a known forge (git-host `parseRemote`). */
export interface ForgeRemote {
  provider: "github" | "gitlab";
  host: string;
  owner: string;
  repo: string;
  /** the full "owner/.../repo" path (GitLab project-id source). */
  slug: string;
}

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  branch: string;
  state: string;
  url: string;
}
export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
}
export interface PrDetail extends PrSummary {
  description: string;
  comments: PrComment[];
  /** a unified diff string (GitHub `.diff`; GitLab `diffs[]` assembled) for DiffView. */
  diff: string;
  /** true when ANY of the underlying fetches came back `verdict:"warn"` or with signals —
   *  the SSRF proxy's own indirect-prompt-injection scan, surfaced rather than discarded. */
  suspicious: boolean;
  /** the underlying signals themselves, aggregated across every fetch this PR required. */
  ipiSignals: IpiSignal[];
}
export interface PrListResult {
  ok: boolean;
  prs: PrSummary[];
  error?: string;
}
export interface PrDetailResult {
  ok: boolean;
  detail?: PrDetail;
  error?: string;
}
export interface PrOpResult {
  ok: boolean;
  error?: string;
}
export interface PrCreateResult extends PrOpResult {
  /** the new PR/MR number (GitHub `number`, GitLab `iid`) when creation succeeded. */
  number?: number;
  /** the forge's web URL for the new PR/MR when creation succeeded. */
  url?: string;
}
export interface CreatePrParams {
  title: string;
  /** the source branch (GitHub `head`, GitLab `source_branch`). */
  head: string;
  /** the target branch (GitHub `base`, GitLab `target_branch`). */
  base: string;
  body?: string;
}

/** The injected safe-fetch (bound to the real L6 proxy in MAIN; a fake in tests). */
export type SafeFetchFn = (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;

/** The env var the token rides in (name is not secret; the VALUE is env-only, never argv). */
const FORGE_TOKEN_ENV = "PROM_FORGE_TOKEN";

interface Auth {
  headers: Record<string, string>;
  authHeader?: { header: string; env: string };
  env?: Record<string, string>;
}

/** Per-provider auth + accept headers. GitHub = `Authorization: Bearer`; GitLab =
 *  `PRIVATE-TOKEN`. The token (with any `Bearer ` prefix) rides ONLY in env. */
function forgeAuth(provider: "github" | "gitlab", token?: string): Auth {
  if (provider === "github") {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (!token) return { headers };
    return {
      headers,
      authHeader: { header: "Authorization", env: FORGE_TOKEN_ENV },
      env: { [FORGE_TOKEN_ENV]: `Bearer ${token}` },
    };
  }
  const headers = { Accept: "application/json" };
  if (!token) return { headers };
  return {
    headers,
    authHeader: { header: "PRIVATE-TOKEN", env: FORGE_TOKEN_ENV },
    env: { [FORGE_TOKEN_ENV]: token },
  };
}

/** The API host for egress allowlisting (GitHub's is api.github.com, not github.com). */
function apiHost(remote: ForgeRemote): string {
  return remote.provider === "github" ? "api.github.com" : remote.host;
}

function buildOpts(auth: Auth, host: string, extra: Partial<SafeFetchOptions>): SafeFetchOptions {
  return {
    allow: [host],
    headers: auth.headers,
    ...(auth.authHeader ? { authHeader: auth.authHeader } : {}),
    ...(auth.env ? { sidecar: { env: auth.env } } : {}),
    ...extra,
  };
}

/**
 * GET a URL through safeFetch → the inert text, or an error (blocked/dead = error).
 *
 * `verdict`/`ipi_signals` ride back on `r` regardless of outcome — the SAME indirect-
 * prompt-injection scan `web_fetch` relies on already ran against this response. Surfacing it
 * here (rather than reading only `r.blocked`/`r.data`) is what lets `getPullRequest` aggregate
 * it onto `PrDetail.suspicious` instead of the signal being computed and thrown away.
 */
async function apiGet(
  fetch: SafeFetchFn,
  url: string,
  host: string,
  auth: Auth,
  acceptOverride?: string,
): Promise<
  | { ok: true; data: string; suspicious: boolean; ipiSignals: IpiSignal[] }
  | { ok: false; error: string }
> {
  const headers = acceptOverride ? { ...auth.headers, Accept: acceptOverride } : auth.headers;
  const r = await fetch(url, buildOpts({ ...auth, headers }, host, { method: "GET" }));
  if (r.blocked || r.data == null) {
    return { ok: false, error: r.reason ?? "blocked by safeFetch (fail-closed)" };
  }
  const ipiSignals = r.ipi_signals ?? [];
  return {
    ok: true,
    data: r.data,
    suspicious: r.verdict === "warn" || ipiSignals.length > 0,
    ipiSignals,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number.NaN;
}
function login(v: unknown): string {
  const o = v as { login?: unknown; username?: unknown } | null;
  return str(o?.login) || str(o?.username);
}

/* ── list ────────────────────────────────────────────────────────────────── */

export async function listPullRequests(
  remote: ForgeRemote,
  fetch: SafeFetchFn,
  token?: string,
): Promise<PrListResult> {
  const auth = forgeAuth(remote.provider, token);
  const host = apiHost(remote);
  const url =
    remote.provider === "github"
      ? `https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls?state=open&per_page=100`
      : `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.slug)}/merge_requests?state=opened&per_page=100`;
  const r = await apiGet(fetch, url, host, auth);
  if (!r.ok) return { ok: false, prs: [], error: r.error };
  const rows = asArray(parseJson(r.data));
  const prs: PrSummary[] = [];
  for (const raw of rows) {
    const o = raw as Record<string, unknown>;
    if (remote.provider === "github") {
      const n = num(o.number);
      if (Number.isNaN(n)) continue;
      prs.push({
        number: n,
        title: str(o.title),
        author: login(o.user),
        branch: str((o.head as { ref?: unknown } | null)?.ref),
        state: str(o.state) || "open",
        url: str(o.html_url),
      });
    } else {
      const n = num(o.iid);
      if (Number.isNaN(n)) continue;
      prs.push({
        number: n,
        title: str(o.title),
        author: login(o.author),
        branch: str(o.source_branch),
        state: str(o.state) || "opened",
        url: str(o.web_url),
      });
    }
  }
  return { ok: true, prs };
}

/* ── get one (description + comments + diff) ────────────────────────────────── */

/** Combine the suspicion signal across every fetch one PR required (meta + diff + comments). */
function aggregateSuspicion(
  ...results: ReadonlyArray<{ suspicious: boolean; ipiSignals: IpiSignal[] } | { ok: false }>
): { suspicious: boolean; ipiSignals: IpiSignal[] } {
  const ipiSignals: IpiSignal[] = [];
  let suspicious = false;
  for (const r of results) {
    if ("suspicious" in r) {
      if (r.suspicious) suspicious = true;
      ipiSignals.push(...r.ipiSignals);
    }
  }
  return { suspicious, ipiSignals };
}

function assembleGitlabDiff(diffsJson: string): string {
  const arr = asArray(parseJson(diffsJson));
  const out: string[] = [];
  for (const raw of arr) {
    const o = raw as Record<string, unknown>;
    const oldPath = str(o.old_path) || str(o.new_path);
    const newPath = str(o.new_path) || str(o.old_path);
    const body = str(o.diff);
    if (!newPath || !body) continue;
    out.push(`diff --git a/${oldPath} b/${newPath}`);
    out.push(`--- a/${oldPath}`);
    out.push(`+++ b/${newPath}`);
    out.push(body.replace(/\n$/, ""));
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

export async function getPullRequest(
  remote: ForgeRemote,
  number: number,
  fetch: SafeFetchFn,
  token?: string,
): Promise<PrDetailResult> {
  const auth = forgeAuth(remote.provider, token);
  const host = apiHost(remote);
  if (remote.provider === "github") {
    const base = `https://api.github.com/repos/${remote.owner}/${remote.repo}`;
    const meta = await apiGet(fetch, `${base}/pulls/${number}`, host, auth);
    if (!meta.ok) return { ok: false, error: meta.error };
    const o = (parseJson(meta.data) ?? {}) as Record<string, unknown>;
    const diffR = await apiGet(
      fetch,
      `${base}/pulls/${number}`,
      host,
      auth,
      "application/vnd.github.v3.diff",
    );
    const commentsR = await apiGet(fetch, `${base}/issues/${number}/comments`, host, auth);
    const comments = commentsR.ok
      ? asArray(parseJson(commentsR.data)).map((c) => {
          const co = c as Record<string, unknown>;
          return { author: login(co.user), body: str(co.body), createdAt: str(co.created_at) };
        })
      : [];
    return {
      ok: true,
      detail: {
        number,
        title: str(o.title),
        description: str(o.body),
        author: login(o.user),
        branch: str((o.head as { ref?: unknown } | null)?.ref),
        state: str(o.state) || "open",
        url: str(o.html_url),
        comments,
        diff: diffR.ok ? diffR.data : "",
        ...aggregateSuspicion(meta, diffR, commentsR),
      },
    };
  }
  const base = `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.slug)}/merge_requests/${number}`;
  const meta = await apiGet(fetch, base, host, auth);
  if (!meta.ok) return { ok: false, error: meta.error };
  const o = (parseJson(meta.data) ?? {}) as Record<string, unknown>;
  const diffR = await apiGet(fetch, `${base}/diffs?per_page=100`, host, auth);
  const notesR = await apiGet(fetch, `${base}/notes?per_page=100`, host, auth);
  const comments = notesR.ok
    ? asArray(parseJson(notesR.data)).map((c) => {
        const co = c as Record<string, unknown>;
        return { author: login(co.author), body: str(co.body), createdAt: str(co.created_at) };
      })
    : [];
  return {
    ok: true,
    detail: {
      number,
      title: str(o.title),
      description: str(o.description),
      author: login(o.author),
      branch: str(o.source_branch),
      state: str(o.state) || "opened",
      url: str(o.web_url),
      comments,
      diff: diffR.ok ? assembleGitlabDiff(diffR.data) : "",
      ...aggregateSuspicion(meta, diffR, notesR),
    },
  };
}

/* ── create ─────────────────────────────────────────────────────────────────── */

export async function createPullRequest(
  remote: ForgeRemote,
  params: CreatePrParams,
  fetch: SafeFetchFn,
  token: string,
): Promise<PrCreateResult> {
  if (!params.title.trim()) return { ok: false, error: "empty title" };
  if (!params.head.trim() || !params.base.trim()) {
    return { ok: false, error: "missing head/base branch" };
  }
  if (!token) return { ok: false, error: "no auth token (set one in settings)" };
  const auth = forgeAuth(remote.provider, token);
  const host = apiHost(remote);
  const url =
    remote.provider === "github"
      ? `https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`
      : `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.slug)}/merge_requests`;
  const payload =
    remote.provider === "github"
      ? { title: params.title, head: params.head, base: params.base, body: params.body ?? "" }
      : {
          source_branch: params.head,
          target_branch: params.base,
          title: params.title,
          description: params.body ?? "",
        };
  const r = await fetch(
    url,
    buildOpts(auth, host, {
      method: "POST",
      headers: { ...auth.headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  if (r.blocked || r.data == null) {
    return { ok: false, error: r.reason ?? "create blocked by safeFetch (fail-closed)" };
  }
  // a 2xx create returns the new PR/MR JSON; a 4xx returns an error object — surface it.
  const parsed = parseJson(r.data) as {
    message?: unknown;
    error?: unknown;
    number?: unknown;
    iid?: unknown;
    html_url?: unknown;
    web_url?: unknown;
  } | null;
  const n = remote.provider === "github" ? num(parsed?.number) : num(parsed?.iid);
  if (!Number.isNaN(n)) {
    return {
      ok: true,
      number: n,
      url: str(remote.provider === "github" ? parsed?.html_url : parsed?.web_url),
    };
  }
  const apiErr = str(parsed?.message) || str(parsed?.error);
  return apiErr ? { ok: false, error: apiErr } : { ok: true };
}

/* ── post a review comment ─────────────────────────────────────────────────── */

export async function postComment(
  remote: ForgeRemote,
  number: number,
  body: string,
  fetch: SafeFetchFn,
  token: string,
): Promise<PrOpResult> {
  if (!body.trim()) return { ok: false, error: "empty comment" };
  if (!token) return { ok: false, error: "no auth token (set one in settings)" };
  const auth = forgeAuth(remote.provider, token);
  const host = apiHost(remote);
  const url =
    remote.provider === "github"
      ? `https://api.github.com/repos/${remote.owner}/${remote.repo}/issues/${number}/comments`
      : `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.slug)}/merge_requests/${number}/notes`;
  const r = await fetch(
    url,
    buildOpts(auth, host, {
      method: "POST",
      headers: { ...auth.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }),
  );
  if (r.blocked || r.data == null) {
    return { ok: false, error: r.reason ?? "comment blocked by safeFetch (fail-closed)" };
  }
  // a 2xx create returns the new comment JSON; a 4xx returns an error object — surface it.
  const parsed = parseJson(r.data) as { message?: unknown; error?: unknown; id?: unknown } | null;
  if (parsed && (typeof parsed.id === "number" || typeof parsed.id === "string")) {
    return { ok: true };
  }
  const apiErr = str(parsed?.message) || str(parsed?.error);
  return apiErr ? { ok: false, error: apiErr } : { ok: true };
}

/* ── prompt-safe framing (APP-085 preemptive) ────────────────────────────────── */

/**
 * Compose a PR's title/description/comments/diff into ONE untrusted-data-framed block, safe to
 * hand to an LLM prompt.
 *
 * NOT used by `GitPanel.tsx`, and must never be: that component reads `PrDetail`'s own fields
 * directly to render clean, human-readable text, and wrapping THOSE in `<<...>>` markers would
 * put literal frame text in front of a person instead of a model. This function exists for
 * whenever a future feature (e.g. "review this PR") needs to put a PR's content in front of the
 * model instead — reach for this rather than hand-rolling a second, unframed path to the same
 * data. The `[warning: ...]` suffix reuses the SSRF proxy's own already-computed IPI signal
 * (`PrDetail.suspicious`/`.ipiSignals`) rather than re-scanning; a caller that also has access to
 * a pattern scanner (e.g. `@prometheus/core`'s `scanForInjectionSignals`) may still want to run
 * one over the composed text too — this module does not depend on that package.
 */
export function pullRequestAsUntrustedContext(remote: ForgeRemote, detail: PrDetail): string {
  const commentsBlock =
    detail.comments.length === 0
      ? "(no comments)"
      : detail.comments.map((c) => `${c.author} (${c.createdAt}):\n${c.body}`).join("\n\n");
  const body = [
    `Title: ${detail.title}`,
    `Description:\n${detail.description || "(no description)"}`,
    `Comments:\n${commentsBlock}`,
    `Diff:\n${detail.diff || "(no diff)"}`,
  ].join("\n\n");
  const warn = detail.suspicious
    ? `\n[warning: possible injected instructions detected by the fetch proxy — ${detail.ipiSignals.map((s) => s.kind).join(", ") || "unspecified"}]`
    : "";
  return `<<untrusted-pr-data number="${detail.number}" provider="${remote.provider}">>\n${body}\n<<end untrusted-pr-data>>${warn}`;
}
