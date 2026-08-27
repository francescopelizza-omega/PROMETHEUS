/**
 * model-discovery.test.ts — the extension must not ship a model id that nothing creates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { firstServedModel } from "./model-discovery.js";

/** A `fetch` that answers one canned response. */
function fakeFetch(res: {
  ok?: boolean;
  json?: unknown;
  throws?: boolean;
}): typeof globalThis.fetch {
  return (async () => {
    if (res.throws) throw new Error("ECONNREFUSED");
    return {
      ok: res.ok ?? true,
      json: async () => res.json,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

test("the first model the endpoint actually serves is discovered", async () => {
  /**
   * `prometheus.model` used to default to the literal `prometheus-local`. Nothing in this repo
   * creates a model by that name — no Modelfile, no install step — so a user who installed the
   * .vsix and typed one word got `HTTP 404 … model 'prometheus-local' not found` on their very
   * first message. Confirmed against a real Ollama, and confirmed fixed the same way: with the
   * shipped defaults the extension now discovers a served model and the turn completes.
   *
   * A different hardcoded tag would be equally absent on someone else's machine, so the id has
   * to be discovered rather than guessed.
   */
  const served = await firstServedModel(
    "http://localhost:11434/v1",
    fakeFetch({ json: { data: [{ id: "qwen3.6:latest" }, { id: "gemma4:12b" }] } }),
  );
  assert.equal(served, "qwen3.6:latest");

  // a trailing slash on the base URL must not produce `//models`
  let seen = "";
  await firstServedModel("http://localhost:11434/v1/", (async (u: string) => {
    seen = String(u);
    return { ok: true, json: async () => ({ data: [{ id: "m" }] }) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch);
  assert.equal(seen, "http://localhost:11434/v1/models");
});

test("an endpoint that cannot answer yields nothing — never a throw, never a guess", async () => {
  /**
   * Activation must not fail because a runner is not up: the caller turns `undefined` into a
   * message naming the setting and the URL, which is the whole point of not guessing.
   */
  assert.equal(await firstServedModel("http://x/v1", fakeFetch({ throws: true })), undefined);
  assert.equal(await firstServedModel("http://x/v1", fakeFetch({ ok: false })), undefined);
  assert.equal(await firstServedModel("http://x/v1", fakeFetch({ json: {} })), undefined);
  assert.equal(await firstServedModel("http://x/v1", fakeFetch({ json: { data: [] } })), undefined);
  assert.equal(
    await firstServedModel("http://x/v1", fakeFetch({ json: { data: [{ id: "" }, { id: 7 }] } })),
    undefined,
  );
  // a body that is not JSON at all
  assert.equal(
    await firstServedModel(
      "http://x/v1",
      (async () =>
        ({
          ok: true,
          json: async () => {
            throw new Error("not json");
          },
        }) as unknown as Response) as unknown as typeof globalThis.fetch,
    ),
    undefined,
  );
});

test("the shipped default model setting is EMPTY, not a phantom id", async () => {
  /**
   * The declared default is what real VS Code serves when the user has set nothing, so this is
   * the value that actually shipped — the `??` fallbacks in extension.ts were nearly dead code.
   * Pinned here because the whole fix is worthless if someone re-introduces a literal.
   */
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
  };
  const model = pkg.contributes.configuration.properties["prometheus.model"];
  assert.equal(model?.default, "", "a hardcoded model id is absent on someone else's machine");
});
