/**
 * ai-ipc-rotation.test.ts — the endless free rotation through the desktop's real transport.
 *
 * `runAiStream` must (1) not ask for a key for the reserved rotation host, (2) send each attempt
 * to a real member with THAT member's key, (3) move on from a quota refusal before a byte reaches
 * the renderer, and (4) obey the security posture like any cloud endpoint. The member list comes from
 * an injected wizard — never the developer's real keychain or environment.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ai } from "@prometheus/core";

import type { AiStreamRequest } from "../shared/ipc-contract.js";
import { runAiStream } from "./ai-ipc.js";
import {
  createModelWizard,
  invalidateKeychainCache,
  setModelWizardForTest,
} from "./model-wizard.js";

const CLOUD_OK = { readAuthLevel: () => 7 } as const;
const POSTURE = {
  allowCloud: true,
  network: "allow",
  minGateMode: "off",
  allowForce: false,
} as never;

function sse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return { ok: true, status: 200, body, headers: { get: () => null } } as unknown as Response;
}
const refused = (status: number): Response =>
  ({
    ok: false,
    status,
    statusText: "no",
    body: null,
    text: async () => "quota",
    headers: { get: () => null },
  }) as unknown as Response;

function wizardWith(env: Record<string, string>) {
  invalidateKeychainCache();
  return createModelWizard({
    env,
    secretsStore: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    machine: () => ({ ramGb: 16, vramGb: 0, unified: true }),
    ollamaTags: async () => [],
    served: async () => [],
  });
}

const ROT: AiStreamRequest["endpoint"] = {
  id: ai.ROTATION_ENDPOINT_ID,
  baseUrl: ai.ROTATION_BASE_URL,
  model: ai.ROTATION_MODEL,
  locality: "cloud",
};

test("a quota refusal on one member is answered by the next, each with its own key", async () => {
  ai.resetRotation();
  setModelWizardForTest(wizardWith({ CEREBRAS_API_KEY: "csk", GROQ_API_KEY: "gsk" }));
  const seen: string[] = [];
  try {
    const r = await runAiStream(
      { runId: "r1", endpoint: ROT, messages: [{ role: "user", content: "hi" }] },
      undefined,
      (async (url: string, init: { headers: Record<string, string> }) => {
        const host = new URL(url).hostname;
        seen.push(`${host} ${init.headers.authorization ?? "-"}`);
        return host === "api.cerebras.ai" ? refused(429) : sse("hello from groq");
      }) as never,
      POSTURE,
      CLOUD_OK,
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, "hello from groq");
    // Both Cerebras models are tried (free quotas are per model), then Groq answers.
    assert.deepEqual(seen, [
      "api.cerebras.ai Bearer csk",
      "api.cerebras.ai Bearer csk",
      "api.groq.com Bearer gsk",
    ]);
  } finally {
    setModelWizardForTest(undefined);
    ai.resetRotation();
  }
});

test("with no keys at all, only the explicitly keyless tier is used — with NO credential", async () => {
  ai.resetRotation();
  setModelWizardForTest(wizardWith({}));
  const hosts: string[] = [];
  try {
    const r = await runAiStream(
      { runId: "r2", endpoint: ROT, messages: [{ role: "user", content: "hi" }] },
      undefined,
      (async (url: string, init: { headers: Record<string, string> }) => {
        hosts.push(`${new URL(url).hostname} ${init.headers.authorization ?? "-"}`);
        return sse("anon");
      }) as never,
      POSTURE,
      CLOUD_OK,
    );
    // With no keys at all, the only member is the explicitly keyless OVHcloud tier.
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(hosts, ["oai.endpoints.kepler.ai.cloud.ovh.net -"]);
  } finally {
    setModelWizardForTest(undefined);
    ai.resetRotation();
  }
});

test("the local-only posture refuses the rotation like any cloud endpoint", async () => {
  setModelWizardForTest(wizardWith({ GROQ_API_KEY: "gsk" }));
  let called = 0;
  try {
    const r = await runAiStream(
      { runId: "r3", endpoint: ROT, messages: [{ role: "user", content: "secret code" }] },
      undefined,
      (async () => {
        called += 1;
        return sse("x");
      }) as never,
      { allowCloud: false, network: "allow", minGateMode: "off", allowForce: false } as never,
      CLOUD_OK,
    );
    assert.equal(r.ok, false);
    assert.equal(called, 0);
  } finally {
    setModelWizardForTest(undefined);
  }
});
