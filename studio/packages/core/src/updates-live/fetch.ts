// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/fetch.ts — the network seams for update checks (global fetch, fail-soft).
 *
 * Reads the npm registry `/latest` document + the GitHub `releases/latest` document to learn
 * a tool's newest version. Uses the runtime's global `fetch` (no node:net import → no C5
 * concern) with a hard timeout, and NEVER throws — an offline/blocked/slow check returns null
 * so the report still renders (the update command is always shown regardless).
 */
import * as u from "../updates/index.js";

const DEFAULT_TIMEOUT_MS = 4000;

/** fetch JSON with a timeout; null on any failure (offline, non-200, parse error, timeout). */
async function getJson(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", ...headers },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Latest published version of an npm package (`.version`), or null. */
export async function fetchNpmLatest(
  pkg: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  // The `/latest` dist-tag document is small + cache-friendly.
  const json = await getJson(`https://registry.npmjs.org/${pkg}/latest`, timeoutMs);
  return u.latestFromNpm(json);
}

/** Latest release tag of a GitHub repo (`owner/repo` → `.tag_name`), or null. */
export async function fetchGithubLatest(
  repo: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  const json = await getJson(`https://api.github.com/repos/${repo}/releases/latest`, timeoutMs, {
    "x-github-api-version": "2022-11-28",
  });
  return u.latestFromGithub(json);
}

/** The locally-served Ollama models (GET /api/tags), or [] if Ollama isn't running. */
export async function fetchOllamaTags(
  baseUrl = "http://localhost:11434",
  timeoutMs = 1500,
): Promise<u.OllamaModel[]> {
  const json = await getJson(`${baseUrl}/api/tags`, timeoutMs);
  if (!json || typeof json !== "object") return [];
  const models = (json as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: u.OllamaModel[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const name = (m as { name?: unknown }).name;
    const digest = (m as { digest?: unknown }).digest;
    if (typeof name !== "string" || typeof digest !== "string") continue;
    const size = (m as { size?: unknown }).size;
    const modifiedAt = (m as { modified_at?: unknown }).modified_at;
    out.push({
      name,
      digest,
      ...(typeof size === "number" ? { size } : {}),
      ...(typeof modifiedAt === "string" ? { modifiedAt } : {}),
    });
  }
  return out;
}
