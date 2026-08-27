/**
 * model-discovery.ts — which model this endpoint actually serves.
 *
 * Split out of `extension.ts` because that module imports `vscode`, which does not exist outside
 * the extension host — so nothing in it can be unit-tested. This rule can be, and it needs to be:
 * the shipped default used to be the literal `prometheus-local`, a model no Modelfile, install
 * step or any other artifact in this repo ever creates, so a user who installed the .vsix and
 * typed one word got `HTTP 404 … model 'prometheus-local' not found` on their very first message.
 * Verified against a real Ollama.
 *
 * Substituting a different hardcoded tag would fail the same way on a machine that does not
 * happen to have it. The id is DISCOVERED instead.
 */

/** How long to wait for the model list before giving up and reporting "no model". */
export const MODEL_PROBE_TIMEOUT_MS = 4_000;

/**
 * Ask an OpenAI-compatible endpoint which models it serves; return the first id.
 *
 * `undefined` when the endpoint cannot be reached, answers badly, or serves none. NEVER throws:
 * an unreachable endpoint must produce an actionable message, not an activation failure.
 */
export async function firstServedModel(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs: number = MODEL_PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) return undefined;
    for (const row of data) {
      const id = (row as { id?: unknown })?.id;
      if (typeof id === "string" && id.trim()) return id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
