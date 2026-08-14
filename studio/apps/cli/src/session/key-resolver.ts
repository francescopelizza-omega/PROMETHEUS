/**
 * session/key-resolver.ts — the assignment that was missing.
 *
 * `SessionCtx.resolveKey` is declared on the context, threaded through three call sites, and
 * consumed correctly by the native tool transport:
 *
 *     if (endpoint.apiKeyRef) {
 *       if (!aux.resolveKey) { …"needs an API key but no key resolver was provided"… }
 *       headers.Authorization = `Bearer ${await aux.resolveKey(endpoint.apiKeyRef)}`;
 *     }
 *
 * There is even a test asserting a cloud key reaches the wire when a resolver is supplied. NO
 * HOST EVER SUPPLIED ONE. The readline host, the TUI host and the one-shot runner all build
 * their `SessionCtx` and stop before this field, so the branch above was unreachable and every
 * cloud endpoint would have gone out unauthenticated — if a cloud endpoint had been reachable
 * at all, which it was not (see `ai/cloud-endpoints.ts`).
 *
 * THE SECRET IS READ PER REQUEST AND NEVER CACHED. That is the whole reason the seam is a
 * function rather than a string: a resolved key held in a closure would sit in the heap for
 * the life of the session, survive into a core dump, and outlive the user revoking it. Reading
 * it at request time costs one keychain call per turn and is the difference between a
 * short-lived secret and a long-lived one.
 */
import { ai, secrets } from "@prometheus/core";

import { createCliSecretsStore } from "../secrets-backend.js";

/** What a resolver needs; injected so tests never touch a real keychain. */
export interface KeyResolverDeps {
  env?: Record<string, string | undefined>;
  /** read one secret. Defaults to the platform keychain store. */
  secretsGet?: (service: string, account: string) => Promise<string | undefined>;
}

/**
 * Build the `resolveKey` a session hands to the agent runtime.
 *
 * Understands both ref forms `ai/cloud-endpoints.ts` mints, and REFUSES anything else rather
 * than guessing — an unrecognised ref is a bug in the endpoint that produced it, and quietly
 * returning `""` would turn it into an opaque 401 from the provider three seconds later.
 */
export function createKeyResolver(deps: KeyResolverDeps = {}): (ref: string) => Promise<string> {
  const env = deps.env ?? process.env;
  let store: ReturnType<typeof createCliSecretsStore> | undefined;
  const get =
    deps.secretsGet ??
    ((service: string, account: string): Promise<string | undefined> => {
      // Built lazily: constructing the store on a platform with no keychain tool is fine, but
      // doing it for a session that only ever uses a local model is pointless work.
      store = store ?? createCliSecretsStore();
      return store.get(service, account);
    });

  return async (ref: string): Promise<string> => {
    const parsed = ai.parseKeyRef(ref);
    if (!parsed) throw new Error(`unrecognised api key reference "${ref}"`);
    if (parsed.kind === "env") {
      const val = env[parsed.envVar];
      if (!val) {
        throw new Error(
          `${parsed.envVar} is not set — export it, or run \`prometheus provider connect\``,
        );
      }
      return val;
    }
    const val = await get(secrets.SECRETS_SERVICE, parsed.account);
    if (!val) {
      throw new Error(
        `no key in the keychain for "${parsed.account}" — run \`prometheus provider connect\``,
      );
    }
    return val;
  };
}

/**
 * Whether the keychain holds a key for this provider — the probe `discoverCloudEndpoints`
 * takes, so a provider with no key is never offered as an endpoint that cannot answer.
 *
 * Synchronous by necessity (discovery is pure), so the caller pre-loads the set once at
 * session start. A key added mid-session is picked up on the next start, which is the same
 * behaviour `prometheus provider connect` already documents.
 */
export async function keychainProviders(
  ids: readonly string[],
  secretsGet?: (service: string, account: string) => Promise<string | undefined>,
): Promise<Set<string>> {
  const get = secretsGet ?? ((s: string, a: string) => createCliSecretsStore().get(s, a));
  const found = new Set<string>();
  for (const id of ids) {
    try {
      const v = await get(secrets.SECRETS_SERVICE, `provider:${id}`);
      if (v) found.add(id);
    } catch {
      // A platform with no keychain tool is a normal state, not an error: the user configures
      // providers through env vars instead, and those are discovered separately.
    }
  }
  return found;
}
