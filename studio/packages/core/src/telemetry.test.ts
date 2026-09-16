/**
 * telemetry.test.ts — local-first + opt-in + scrub (file 10 §8).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { configDir } from "./cli-profiles/paths.js";

import { createTelemetry, eventsLogPath, scrub } from "./telemetry.js";

test("eventsLogPath → ~/.prometheus/config/events.jsonl (the ONE config root)", () => {
  // Asserted through configDir, NOT by re-spelling the root: the literal is what let this
  // path silently stay behind in the old tree while its own test kept passing.
  assert.equal(eventsLogPath("/home/u"), join(configDir("/home/u"), "events.jsonl"));
  assert.equal(eventsLogPath("/home/u"), "/home/u/.prometheus/config/events.jsonl");
});

test("scrub: $HOME paths → ~, URLs → [url], sensitive keys → [redacted]", () => {
  const out = scrub(
    {
      type: "install",
      repo: "github.com/acme/secret",
      file: "/home/u/proj/main.py",
      note: "see https://evil.example/x for details",
      count: 3,
    },
    "/home/u",
  );
  assert.equal(out.type, "install");
  assert.equal(out.repo, "[redacted]"); // sensitive key name
  assert.equal(out.file, "~/proj/main.py"); // non-sensitive key → $HOME collapsed in the value
  assert.equal(out.note, "see [url] for details"); // URL stripped from free text
  assert.equal(out.count, 3); // non-strings pass through
});

test("scrub: a path value (non-sensitive key) has $HOME collapsed", () => {
  const out = scrub({ type: "open", location: "/home/u/work/x.ts" }, "/home/u");
  assert.equal(out.location, "~/work/x.ts");
});

test("createTelemetry: ALWAYS appends locally; uploads ONLY when enabled", () => {
  const appended: string[] = [];
  const uploaded: unknown[] = [];
  // OFF (default): no upload, still logged locally
  const off = createTelemetry({
    enabled: () => false,
    append: (l) => appended.push(l),
    now: () => "2026-06-19T00:00:00.000Z",
    upload: (e) => uploaded.push(e),
  });
  off.record({ type: "gate.block", repo: "github.com/x/y" });
  assert.equal(appended.length, 1);
  assert.equal(uploaded.length, 0);
  const rec = JSON.parse(appended[0] as string);
  assert.equal(rec.type, "gate.block");
  assert.equal(rec.at, "2026-06-19T00:00:00.000Z");
  assert.equal(rec.repo, "github.com/x/y"); // LOCAL log is unscrubbed (user's own data)

  // ON (opted in): scrubbed upload happens
  const on = createTelemetry({
    enabled: () => true,
    append: (l) => appended.push(l),
    now: () => "t",
    upload: (e) => uploaded.push(e),
  });
  on.record({ type: "install", repo: "github.com/x/y" });
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploaded[0], { type: "install", repo: "[redacted]" }); // scrubbed
});
