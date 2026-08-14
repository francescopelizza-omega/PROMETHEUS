/**
 * provider.test.ts — the GitHub/GitLab PR client over an INJECTED safeFetch fake.
 * Asserts URL/method/auth shaping, guarded parsing, and blocked-fetch → visible error.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SafeFetchOptions, SafeFetchResult } from "../security/fetchproxy.js";
import {
  type ForgeRemote,
  type SafeFetchFn,
  createPullRequest,
  getPullRequest,
  listPullRequests,
  postComment,
} from "./provider.js";

const GH: ForgeRemote = {
  provider: "github",
  host: "github.com",
  owner: "octo",
  repo: "demo",
  slug: "octo/demo",
};
const GL: ForgeRemote = {
  provider: "gitlab",
  host: "gitlab.com",
  owner: "grp/sub",
  repo: "demo",
  slug: "grp/sub/demo",
};

/** A recording fake: route URL → response text (or blocked), capturing every call. */
function fakeFetch(routes: (url: string) => { data?: string | null; blocked?: boolean }): {
  fetch: SafeFetchFn;
  calls: Array<{ url: string; opts?: SafeFetchOptions }>;
} {
  const calls: Array<{ url: string; opts?: SafeFetchOptions }> = [];
  const fetch: SafeFetchFn = async (url, opts) => {
    calls.push({ url, opts });
    const r = routes(url);
    return {
      ok: true,
      command: "fetch",
      url,
      final_url: url,
      blocked: r.blocked ?? false,
      verdict: r.blocked ? "block" : "allow",
      data: r.blocked ? null : (r.data ?? ""),
      provenance: {
        source_url: url,
        final_url: url,
        fetched_at: "",
        classification: "untrusted-web-data",
        executable: false,
        blocked: r.blocked ?? false,
        contains_injection_signals: false,
        instruction_to_agent: "",
      },
    } as SafeFetchResult;
  };
  return { fetch, calls };
}

test("listPullRequests (GitHub): url/allow/auth shaping + guarded parse", async () => {
  const body = JSON.stringify([
    {
      number: 7,
      title: "Fix",
      user: { login: "ada" },
      head: { ref: "fix" },
      state: "open",
      html_url: "u7",
    },
    { title: "no-number-skip" }, // malformed → dropped, not a crash
  ]);
  const { fetch, calls } = fakeFetch((u) =>
    u.includes("/pulls?state=open") ? { data: body } : {},
  );
  const r = await listPullRequests(GH, fetch, "tok123");
  assert.equal(r.ok, true);
  assert.equal(r.prs.length, 1);
  assert.deepEqual(r.prs[0], {
    number: 7,
    title: "Fix",
    author: "ada",
    branch: "fix",
    state: "open",
    url: "u7",
  });
  // egress allowlist = api.github.com; Bearer token via env (never in the URL/opts headers)
  const call = calls[0]!;
  assert.match(call.url, /^https:\/\/api\.github\.com\/repos\/octo\/demo\/pulls/);
  assert.deepEqual(call.opts?.allow, ["api.github.com"]);
  assert.equal(call.opts?.authHeader?.header, "Authorization");
  assert.equal(call.opts?.sidecar?.env?.PROM_FORGE_TOKEN, "Bearer tok123");
  assert.equal(call.opts?.method, "GET");
});

test("listPullRequests: empty array off the wire → ok with no prs (no crash)", async () => {
  const { fetch } = fakeFetch(() => ({ data: "[]" }));
  const r = await listPullRequests(GH, fetch);
  assert.deepEqual(r, { ok: true, prs: [] });
});

test("getPullRequest (GitHub): description + comments + diff via Accept override", async () => {
  const meta = JSON.stringify({
    number: 3,
    title: "T",
    body: "desc",
    user: { login: "ada" },
    head: { ref: "b" },
    state: "open",
    html_url: "u",
  });
  const diff = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
  const comments = JSON.stringify([{ user: { login: "bob" }, body: "LGTM", created_at: "2026" }]);
  const seenAccepts: string[] = [];
  const { fetch, calls } = fakeFetch((u) => {
    if (u.endsWith("/issues/3/comments")) return { data: comments };
    return { data: meta }; // both /pulls/3 calls hit here; Accept differs
  });
  // capture the diff-Accept by inspecting opts after the call
  const r = await getPullRequest(GH, 3, fetch, "tok");
  for (const c of calls) seenAccepts.push(c.opts?.headers?.Accept ?? "");
  assert.equal(r.ok, true);
  assert.equal(r.detail?.description, "desc");
  assert.equal(r.detail?.comments.length, 1);
  assert.equal(r.detail?.comments[0]?.author, "bob");
  // one of the /pulls/3 calls used the diff media type
  assert.ok(seenAccepts.includes("application/vnd.github.v3.diff"));
});

test("getPullRequest (GitLab): iid URL, PRIVATE-TOKEN, assembled diff", async () => {
  const meta = JSON.stringify({
    iid: 5,
    title: "MR",
    description: "d",
    author: { username: "cara" },
    source_branch: "feat",
    state: "opened",
    web_url: "w",
  });
  const diffs = JSON.stringify([
    { old_path: "a.py", new_path: "a.py", diff: "@@ -1 +1 @@\n-x\n+y\n" },
  ]);
  const { fetch, calls } = fakeFetch((u) => {
    if (u.includes("/diffs")) return { data: diffs };
    if (u.includes("/notes")) return { data: "[]" };
    return { data: meta };
  });
  const r = await getPullRequest(GL, 5, fetch, "glpat");
  assert.equal(r.ok, true);
  assert.equal(r.detail?.author, "cara");
  assert.match(r.detail?.diff ?? "", /diff --git a\/a\.py b\/a\.py/);
  assert.match(r.detail?.diff ?? "", /@@ -1 \+1 @@/);
  // gitlab: project id is the url-encoded slug; PRIVATE-TOKEN auth
  assert.match(calls[0]!.url, /projects\/grp%2Fsub%2Fdemo\/merge_requests\/5/);
  assert.equal(calls[0]!.opts?.authHeader?.header, "PRIVATE-TOKEN");
  assert.equal(calls[0]!.opts?.sidecar?.env?.PROM_FORGE_TOKEN, "glpat");
});

test("postComment (GitHub): POST issues/comments with JSON body; token required", async () => {
  const { fetch, calls } = fakeFetch(() => ({ data: JSON.stringify({ id: 99 }) }));
  const r = await postComment(GH, 4, "nice work", fetch, "tok");
  assert.equal(r.ok, true);
  const call = calls[0]!;
  assert.match(call.url, /\/issues\/4\/comments$/);
  assert.equal(call.opts?.method, "POST");
  assert.equal(call.opts?.body, JSON.stringify({ body: "nice work" }));
  assert.equal(call.opts?.headers?.["Content-Type"], "application/json");
  // guards
  assert.equal((await postComment(GH, 4, "  ", fetch, "tok")).ok, false); // empty
  assert.equal((await postComment(GH, 4, "x", fetch, "")).ok, false); // no token
});

test("createPullRequest (GitHub): POST pulls with head/base/title/body; token required", async () => {
  const { fetch, calls } = fakeFetch(() => ({
    data: JSON.stringify({ number: 42, html_url: "https://github.com/octo/demo/pull/42" }),
  }));
  const r = await createPullRequest(
    GH,
    { title: "Add thing", head: "feature", base: "main", body: "why" },
    fetch,
    "tok",
  );
  assert.equal(r.ok, true);
  assert.equal(r.number, 42);
  assert.equal(r.url, "https://github.com/octo/demo/pull/42");
  const call = calls[0]!;
  assert.match(call.url, /^https:\/\/api\.github\.com\/repos\/octo\/demo\/pulls$/);
  assert.equal(call.opts?.method, "POST");
  assert.deepEqual(JSON.parse(call.opts?.body as string), {
    title: "Add thing",
    head: "feature",
    base: "main",
    body: "why",
  });
  assert.equal(call.opts?.headers?.["Content-Type"], "application/json");
  assert.equal(call.opts?.authHeader?.header, "Authorization");
  assert.equal(call.opts?.sidecar?.env?.PROM_FORGE_TOKEN, "Bearer tok");
  // guards
  assert.equal(
    (await createPullRequest(GH, { title: "  ", head: "f", base: "main" }, fetch, "tok")).ok,
    false,
  ); // empty title
  assert.equal(
    (await createPullRequest(GH, { title: "t", head: "", base: "main" }, fetch, "tok")).ok,
    false,
  ); // missing head
  assert.equal(
    (await createPullRequest(GH, { title: "t", head: "f", base: "main" }, fetch, "")).ok,
    false,
  ); // no token
});

test("createPullRequest (GitLab): POST merge_requests with source/target branch, PRIVATE-TOKEN", async () => {
  const { fetch, calls } = fakeFetch(() => ({
    data: JSON.stringify({ iid: 9, web_url: "https://gitlab.com/grp/sub/demo/-/merge_requests/9" }),
  }));
  const r = await createPullRequest(
    GL,
    { title: "MR title", head: "feat", base: "main", body: "desc" },
    fetch,
    "glpat",
  );
  assert.equal(r.ok, true);
  assert.equal(r.number, 9);
  assert.equal(r.url, "https://gitlab.com/grp/sub/demo/-/merge_requests/9");
  const call = calls[0]!;
  assert.match(call.url, /projects\/grp%2Fsub%2Fdemo\/merge_requests$/);
  assert.deepEqual(JSON.parse(call.opts?.body as string), {
    source_branch: "feat",
    target_branch: "main",
    title: "MR title",
    description: "desc",
  });
  assert.equal(call.opts?.authHeader?.header, "PRIVATE-TOKEN");
  assert.equal(call.opts?.sidecar?.env?.PROM_FORGE_TOKEN, "glpat");
});

test("createPullRequest surfaces a forge API error message (4xx body)", async () => {
  const { fetch } = fakeFetch(() => ({
    data: JSON.stringify({ message: "Validation Failed" }),
  }));
  const r = await createPullRequest(GH, { title: "t", head: "f", base: "main" }, fetch, "badtok");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Validation Failed/);
});

test("createPullRequest: a blocked / dead safeFetch surfaces a visible error", async () => {
  const { fetch } = fakeFetch(() => ({ blocked: true }));
  const r = await createPullRequest(GH, { title: "t", head: "f", base: "main" }, fetch, "tok");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /blocked|fail-closed/i);
});

test("a blocked / dead safeFetch surfaces a visible error, never empty success", async () => {
  const { fetch } = fakeFetch(() => ({ blocked: true }));
  const list = await listPullRequests(GH, fetch, "t");
  assert.equal(list.ok, false);
  assert.match(list.error ?? "", /blocked|fail-closed/i);
  const get = await getPullRequest(GH, 1, fetch, "t");
  assert.equal(get.ok, false);
  const post = await postComment(GH, 1, "hi", fetch, "t");
  assert.equal(post.ok, false);
});

test("postComment surfaces a forge API error message (4xx body)", async () => {
  const { fetch } = fakeFetch(() => ({ data: JSON.stringify({ message: "Bad credentials" }) }));
  const r = await postComment(GH, 1, "hi", fetch, "badtok");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Bad credentials/);
});
