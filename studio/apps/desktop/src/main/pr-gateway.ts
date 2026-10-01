// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/pr-gateway.ts — the MAIN-side glue for gated PR review (APP-085).
 *
 * Resolves the workspace's `origin` → a known forge (git-host `remoteUrl` + PURE
 * `parseRemote`), reads the forge auth token from an injected SecretsStore (the token
 * NEVER leaves MAIN — it rides to the sidecar via env inside the provider client), and
 * drives the engine-bridge PR client over the REAL L6 safeFetch. Electron-free (all deps
 * injected) so it stays node:test-able; ide-ipc injects it and the renderer sees only
 * plain result data (no token, no raw fetch).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { secrets } from "@prometheus/core";
import {
  type ForgeRemote,
  type PrDetailResult,
  type PrListResult,
  type PrOpResult,
  type SafeFetchFn,
  getPullRequest,
  listPullRequests,
  postComment,
} from "@prometheus/engine-bridge";

import { type GitHost, parseRemote } from "./ide/git-host.js";

export interface PrStatus {
  provider?: "github" | "gitlab";
  host?: string;
  slug?: string;
  hasToken: boolean;
}

/** The narrow surface ide-ipc drives (a fake is injected in tests). */
export interface PrGateway {
  status(root: string): Promise<PrStatus>;
  list(root: string): Promise<PrListResult>;
  get(root: string, number: number): Promise<PrDetailResult>;
  comment(root: string, number: number, body: string): Promise<PrOpResult>;
  setToken(root: string, token: string): Promise<PrOpResult>;
}

export interface PrGatewayDeps {
  git: GitHost;
  secrets: secrets.SecretsStore;
  /** the REAL L6 safeFetch (bound in MAIN); the ONLY network path. */
  fetch: SafeFetchFn;
}

const UNSUPPORTED = "the origin remote is not a supported forge (GitHub/GitLab)";

export function createPrGateway(deps: PrGatewayDeps): PrGateway {
  const account = (r: ForgeRemote): string => `pr:${r.host}`;
  const resolve = async (root: string): Promise<ForgeRemote | undefined> => {
    const url = await deps.git.remoteUrl(root);
    return url ? parseRemote(url) : undefined;
  };
  const readToken = async (r: ForgeRemote): Promise<string | undefined> =>
    (await deps.secrets.get(secrets.SECRETS_SERVICE, account(r))) || undefined;

  return {
    async status(root) {
      const r = await resolve(root);
      if (!r) return { hasToken: false };
      return { provider: r.provider, host: r.host, slug: r.slug, hasToken: !!(await readToken(r)) };
    },
    async list(root) {
      const r = await resolve(root);
      if (!r) return { ok: false, prs: [], error: UNSUPPORTED };
      return listPullRequests(r, deps.fetch, await readToken(r));
    },
    async get(root, number) {
      const r = await resolve(root);
      if (!r) return { ok: false, error: UNSUPPORTED };
      return getPullRequest(r, number, deps.fetch, await readToken(r));
    },
    async comment(root, number, body) {
      const r = await resolve(root);
      if (!r) return { ok: false, error: UNSUPPORTED };
      const token = await readToken(r);
      if (!token) return { ok: false, error: "no auth token — add one in settings first" };
      return postComment(r, number, body, deps.fetch, token);
    },
    async setToken(root, token) {
      const r = await resolve(root);
      if (!r) return { ok: false, error: UNSUPPORTED };
      await deps.secrets.set(secrets.SECRETS_SERVICE, account(r), token);
      return { ok: true };
    },
  };
}

/**
 * A persistent SecretsStore backed by the OS keychain (Electron safeStorage, adapted to
 * core's string SafeStorageBackend) + an encrypted JSON file. When encryption is NOT
 * available it falls back to the in-memory store — a token is NEVER written to disk in
 * plaintext.
 */
export function createTokenSecretsStore(
  backend: secrets.SafeStorageBackend,
  filePath: string,
): secrets.SecretsStore {
  if (!backend.isAvailable()) return new secrets.InMemorySecretsStore();
  const key = (service: string, account: string): string => `${service}\x00${account}`;
  const load = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const save = (map: Record<string, string>): void => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(map), { mode: 0o600 });
    } catch {
      /* persistence is best-effort; the value stays for this session in `map` */
    }
  };
  return {
    async set(service, account, secret) {
      const map = load();
      map[key(service, account)] = backend.encryptString(secret);
      save(map);
    },
    async get(service, account) {
      const enc = load()[key(service, account)];
      if (enc === undefined) return undefined;
      try {
        return backend.decryptString(enc);
      } catch {
        return undefined;
      }
    },
    async delete(service, account) {
      const map = load();
      delete map[key(service, account)];
      save(map);
    },
  };
}
