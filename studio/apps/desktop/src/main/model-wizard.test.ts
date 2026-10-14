/**
 * model-wizard.test.ts — the desktop picker's main-process logic, every seam injected.
 *
 * No electron, keychain, network or Ollama. The properties that matter: a key is verified
 * before it is stored and never returned; a vanished model id comes back with the live list;
 * the remembered pick is the CLI's file; the rotation's members are computed here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { FetchLike } from "@prometheus/core";

import { createModelWizard, invalidateKeychainCache } from "./model-wizard.js";

function make(opts: { fetch?: FetchLike; env?: Record<string, string> } = {}) {
  invalidateKeychainCache();
  const stored = new Map<string, string>();
  const home = mkdtempSync(join(tmpdir(), "model-wizard-"));
  const w = createModelWizard({
    env: opts.env ?? {},
    home,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    secretsStore: {
      set: async (_s, a, v) => {
        stored.set(a, v);
      },
      get: async (_s, a) => stored.get(a),
      delete: async (_s, a) => {
        stored.delete(a);
      },
    },
    machine: () => ({ ramGb: 36, vramGb: 0, unified: true }),
    ollamaTags: async () => [],
    served: async () => [],
  });
  return { w, stored, home };
}

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  body: null,
  text: async () => JSON.stringify(body),
});

test("step: any unknown step id falls back to root; rows come from core", async () => {
  const { w } = make();
  const r = await w.step({ step: "nonsense" });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.step.id, "root");
  const cloud = await w.step({ step: "cloud" });
  assert.deepEqual(cloud.ok && cloud.step.rows.map((x) => x.next), ["free", "paid", "rotation"]);
});

test("setKey: refused key → nothing stored; accepted key → stored, never returned", async () => {
  const bad = make({ fetch: async () => res(401, {}) });
  const r1 = await bad.w.setKey({ providerId: "groq", key: "gsk_bad" });
  assert.equal(r1.ok, false);
  assert.equal(bad.stored.size, 0);

  const good = make({ fetch: async () => res(200, { data: [{ id: "llama-3.3-70b-versatile" }] }) });
  const r2 = await good.w.setKey({ providerId: "groq", key: " gsk_good " });
  assert.equal(r2.ok, true);
  assert.equal(good.stored.get("provider:groq"), "gsk_good");
  assert.ok(!JSON.stringify(r2).includes("gsk_good"), "the key never travels back to the renderer");
});

test("setKey: malformed requests are refused at the seam", async () => {
  const { w } = make();
  assert.equal((await w.setKey({ providerId: 1, key: "x" })).ok, false);
  assert.equal((await w.setKey({ providerId: "nope", key: "x" })).ok, false);
  assert.equal((await w.setKey({ providerId: "groq", key: "   " })).ok, false);
  assert.equal((await w.setKey(undefined)).ok, false);
});

test("choose: a renamed model is used; a vanished one is refused WITH the live list", async () => {
  const live = {
    data: [{ id: "moonshotai/kimi-k2-instruct-0905" }, { id: "llama-3.3-70b-versatile" }],
  };
  const { w, home } = make({ fetch: async () => res(200, live), env: { GROQ_API_KEY: "gsk_env" } });
  const renamed = await w.choose({ ref: "free:groq:moonshotai/kimi-k2-instruct" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.ok && renamed.endpoint?.model, "moonshotai/kimi-k2-instruct-0905");
  assert.equal(renamed.ok && renamed.endpoint?.locality, "cloud");
  const saved = JSON.parse(readFileSync(join(home, "model-choice.json"), "utf8"));
  assert.equal(
    saved.ref,
    "free:groq:moonshotai/kimi-k2-instruct-0905",
    "the CLI's file, the live id",
  );

  const gone = await w.choose({ ref: "free:groq:openai/gpt-oss-120b" });
  assert.equal(gone.ok, false);
  assert.deepEqual(!gone.ok && gone.live, [
    "moonshotai/kimi-k2-instruct-0905",
    "llama-3.3-70b-versatile",
  ]);

  const explicit = await w.choose({
    ref: "free:groq:openai/gpt-oss-120b",
    model: "llama-3.3-70b-versatile",
  });
  assert.equal(explicit.ok && explicit.endpoint?.model, "llama-3.3-70b-versatile");
});

test("choose: a cloud pick without a key is refused; a local pick is just remembered", async () => {
  const { w, home } = make({ fetch: async () => res(200, { data: [] }) });
  const r = await w.choose({ ref: "paid:anthropic:claude-sonnet-5-5" });
  assert.equal(r.ok, false);
  const l = await w.choose({ ref: "local:qwen3-8b" });
  assert.equal(l.ok, true);
  assert.equal(
    JSON.parse(readFileSync(join(home, "model-choice.json"), "utf8")).ref,
    "local:qwen3-8b",
  );
});

test("endpoints: keyed providers; the spinner only after it was picked; never a key", async () => {
  const { w } = make({
    env: { NVIDIA_API_KEY: "nvapi-secret" },
    fetch: async () => res(200, { data: [] }),
  });
  const r = await w.endpoints();
  assert.equal(r.ok, true);
  const ids = r.ok ? r.endpoints.map((e) => e.id) : [];
  assert.ok(ids.some((id) => id.startsWith("cloud:nvidia:")));
  assert.ok(!ids.includes("cloud:rotation:free"), "not offered before the picker explained it");
  assert.ok(!JSON.stringify(r).includes("nvapi-secret"));
  await w.choose({ ref: "rotation" });
  const r2 = await w.endpoints();
  assert.ok(r2.ok && r2.endpoints.some((e) => e.id === "cloud:rotation:free"));
});

test("choose: an explicit model must be on the live list; junk ids refused at the seam", async () => {
  const { w } = make({
    env: { GROQ_API_KEY: "g" },
    fetch: async () => res(200, { data: [{ id: "a" }] }),
  });
  assert.equal((await w.choose({ ref: "free:groq:x", model: "not served" })).ok, false);
  assert.equal((await w.choose({ ref: "free:groq:x", model: "b" })).ok, false);
  assert.equal((await w.choose({ ref: "free:groq:x", model: "a" })).ok, true);
});

test("rotationForMain: members come from env/keychain here, keys resolve by ref", async () => {
  const { w } = make({ env: { CEREBRAS_API_KEY: "csk" } });
  const r = await w.rotationForMain();
  assert.equal(r.members[0]?.providerId, "cerebras", "highest-priority keyed member first");
  assert.equal(await r.resolveKey("env:CEREBRAS_API_KEY"), "csk");
  assert.equal(await r.resolveKey("garbage"), "");
});
