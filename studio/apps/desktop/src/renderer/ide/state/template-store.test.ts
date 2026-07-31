/**
 * template-store.test.ts — node:test for the renderer template-store (APP-020).
 *
 * Pins: hydrate/upsert/remove against a STUBBED in-memory settings IPC (proving the
 * persistence round-trip — a template written by one "session" is read back by a fresh
 * hydrate), templateKey identity (edit-replaces vs create), the merged registry the editor
 * consumes, and fail-soft behaviour when window.prometheus is absent (cache-only).
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { LiveTemplateDef } from "@prometheus/core/templates";

import { TEMPLATES_SETTINGS_KEY, templateKey, useTemplateStore } from "./template-store.js";

/** A minimal in-memory `window.prometheus.settings` that JSON-round-trips the value (so a
 *  `$`/backtick/newline body must survive) — mirrors the main settings-store JSON layer. */
function installFakeSettings(): { layer: Record<string, unknown> } {
  const layer: Record<string, unknown> = {};
  const settings = {
    get: async (key: string) =>
      key in layer
        ? {
            ok: true as const,
            value: JSON.parse(JSON.stringify(layer[key])),
            layer: "global" as const,
          }
        : { ok: true as const, value: undefined, layer: "unset" as const },
    set: async (key: string, value: unknown) => {
      layer[key] = JSON.parse(JSON.stringify(value));
      return { ok: true as const };
    },
    list: async () => ({ ok: true as const, nodes: [] }),
    reset: async () => ({ ok: true as const }),
  };
  (globalThis as { window?: unknown }).window = { prometheus: { settings } };
  return { layer };
}

afterEach(() => {
  useTemplateStore.setState({ user: [], hydrated: false });
  (globalThis as { window?: unknown }).window = undefined;
});

const LOG_TS: LiveTemplateDef = {
  abbrev: "log",
  description: "custom",
  body: "console.debug(`$${1:v}`)$0",
  languages: ["typescript"],
  kind: "live",
};

test("templateKey distinguishes kind + languages + abbrev", () => {
  assert.notEqual(templateKey(LOG_TS), templateKey({ ...LOG_TS, kind: "postfix" }));
  assert.notEqual(templateKey(LOG_TS), templateKey({ ...LOG_TS, languages: ["python"] }));
  // language order does not matter (sorted)
  assert.equal(
    templateKey({ ...LOG_TS, languages: ["typescript", "javascript"] }),
    templateKey({ ...LOG_TS, languages: ["javascript", "typescript"] }),
  );
});

test("upsert persists through the settings IPC and a fresh hydrate reads it back", async () => {
  installFakeSettings();
  await useTemplateStore.getState().upsert(LOG_TS);
  assert.equal(useTemplateStore.getState().user.length, 1);

  // simulate a restart: clear the cache, hydrate from the (persisted) layer
  useTemplateStore.setState({ user: [], hydrated: false });
  await useTemplateStore.getState().hydrate();
  const user = useTemplateStore.getState().user;
  assert.equal(user.length, 1);
  assert.equal(user[0]?.abbrev, "log");
  assert.equal(user[0]?.body, "console.debug(`$${1:v}`)$0"); // `$`/backtick body survived JSON
});

test("upsert with a colliding templateKey REPLACES (edit), a distinct one ADDS (create)", async () => {
  installFakeSettings();
  const store = useTemplateStore.getState();
  await store.upsert(LOG_TS);
  await store.upsert({ ...LOG_TS, body: "console.warn($1)$0" }); // same key → replace
  assert.equal(useTemplateStore.getState().user.length, 1);
  assert.equal(useTemplateStore.getState().user[0]?.body, "console.warn($1)$0");
  await store.upsert({ ...LOG_TS, kind: "postfix" }); // distinct kind → add
  assert.equal(useTemplateStore.getState().user.length, 2);
});

test("remove drops the entry and write-through empties the persisted layer", async () => {
  const { layer } = installFakeSettings();
  await useTemplateStore.getState().upsert(LOG_TS);
  await useTemplateStore.getState().remove(LOG_TS);
  assert.equal(useTemplateStore.getState().user.length, 0);
  assert.deepEqual(layer[TEMPLATES_SETTINGS_KEY], []);
});

test("mergedFor layers the user template over the seed (user overrides on abbrev+language)", async () => {
  installFakeSettings();
  await useTemplateStore.getState().upsert(LOG_TS);
  const merged = useTemplateStore.getState().mergedFor("live", "typescript");
  const logs = merged.filter((t) => t.abbrev === "log");
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.body, "console.debug(`$${1:v}`)$0");
});

test("hydrate is fail-soft when window.prometheus is absent (cache-only)", async () => {
  (globalThis as { window?: unknown }).window = undefined;
  await useTemplateStore.getState().hydrate();
  assert.equal(useTemplateStore.getState().hydrated, true);
  assert.equal(useTemplateStore.getState().user.length, 0);
});

test("hydrate drops a malformed persisted row (sanitizeUserTemplates)", async () => {
  const { layer } = installFakeSettings();
  layer[TEMPLATES_SETTINGS_KEY] = [
    LOG_TS,
    { abbrev: "", body: "x", languages: [], kind: "live" }, // invalid → dropped
  ];
  await useTemplateStore.getState().hydrate();
  assert.equal(useTemplateStore.getState().user.length, 1);
  assert.equal(useTemplateStore.getState().user[0]?.abbrev, "log");
});
