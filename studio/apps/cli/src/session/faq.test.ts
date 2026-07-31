/**
 * faq.test.ts — the /faq knowledge base: topic listing, keyword matching, no-match
 * fallback, and coverage of every major functionality area.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { setColorEnabled } from "../render.js";
import { FAQ_DB, renderFaq } from "./faq.js";

setColorEnabled(false);

test("/faq with no query lists every topic", () => {
  const out = renderFaq("");
  assert.match(out, /FAQ/);
  for (const e of FAQ_DB) assert.ok(out.includes(e.topic), `topic ${e.topic} not listed`);
});

test("/faq matches by keyword → the right answer", () => {
  assert.match(renderFaq("ollama local model"), /local model/i);
  assert.match(renderFaq("is this repo safe"), /nemesis|verdict|gate/i);
  assert.match(renderFaq("no colors"), /FORCE_COLOR/);
  assert.match(renderFaq("where are files stored"), /\.prometheus/);
  assert.match(renderFaq("youtube download"), /yt-dlp|downloads/i);
});

test("/faq matches an exact topic slug strongly", () => {
  assert.match(renderFaq("tmux"), /subagent|orchestrator/i);
  assert.match(renderFaq("paths"), /\.prometheus|repoint/i);
});

test("/faq no-match yields a helpful fallback (not a crash)", () => {
  assert.match(renderFaq("zzqqxx nonsense"), /No FAQ match/);
});

test("FAQ covers the core functionality areas", () => {
  const topics = new Set(FAQ_DB.map((e) => e.topic));
  for (const must of [
    "start",
    "model-local",
    "model-paid",
    "security",
    "install",
    "env",
    "repo",
    "privacy",
    "paths",
    "tmux",
  ]) {
    assert.ok(topics.has(must), `FAQ missing a '${must}' entry`);
  }
  assert.ok(FAQ_DB.length >= 18);
});
