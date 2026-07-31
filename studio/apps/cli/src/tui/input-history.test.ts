/**
 * input-history.test.ts — cross-restart composer history persistence (CLI-062): JSONL round-trip,
 * adjacent dedupe, 1000-cap, the secret filter, and fail-soft on a bad/read-only file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendInputHistory,
  inputHistoryPath,
  isSecretLike,
  loadInputHistory,
} from "./input-history.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "prom-inhist-")), "input-history.jsonl");
}

test("append then load round-trips oldest→newest incl. multi-line entries (CLI-062)", () => {
  const f = tmpFile();
  try {
    appendInputHistory(f, "first");
    appendInputHistory(f, "second");
    appendInputHistory(f, "multi\nline\nentry"); // \n must round-trip via JSON encoding
    assert.deepEqual(loadInputHistory(f), ["first", "second", "multi\nline\nentry"]);
  } finally {
    rmSync(join(f, ".."), { recursive: true, force: true });
  }
});

test("adjacent identical submissions are stored once (CLI-062)", () => {
  const f = tmpFile();
  try {
    appendInputHistory(f, "same");
    appendInputHistory(f, "same"); // adjacent dup → skipped
    appendInputHistory(f, "other");
    appendInputHistory(f, "same"); // non-adjacent → allowed
    assert.deepEqual(loadInputHistory(f), ["same", "other", "same"]);
  } finally {
    rmSync(join(f, ".."), { recursive: true, force: true });
  }
});

test("isSecretLike catches keys/tokens/PEM/base64; a secret line is never written (CLI-062)", () => {
  assert.ok(isSecretLike("my key is sk-abc123def456ghi789jkl012"));
  assert.ok(isSecretLike("export GITHUB_TOKEN=ghp_0123456789abcdef0123456789abcdef0123"));
  assert.ok(isSecretLike("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(isSecretLike("Authorization: Bearer eyJhbGciOiJI"));
  assert.ok(isSecretLike("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.ok(isSecretLike("api_key = zzzzyyyyxxxx"));
  assert.ok(!isSecretLike("scan the repo for bugs"));
  assert.ok(!isSecretLike("git commit -m 'fix'"));

  const f = tmpFile();
  try {
    appendInputHistory(f, "safe line");
    appendInputHistory(f, "token sk-abcdefghij0123456789klmnop"); // secret → not persisted
    assert.deepEqual(loadInputHistory(f), ["safe line"]);
  } finally {
    rmSync(join(f, ".."), { recursive: true, force: true });
  }
});

test("1001st entry drops the oldest; file never exceeds 1000 lines (CLI-062)", () => {
  const f = tmpFile();
  try {
    for (let i = 0; i < 1001; i++) appendInputHistory(f, `entry-${i}`);
    const loaded = loadInputHistory(f);
    assert.equal(loaded.length, 1000);
    assert.equal(loaded[0], "entry-1"); // entry-0 dropped
    assert.equal(loaded.at(-1), "entry-1000");
    const lines = readFileSync(f, "utf8").trim().split("\n");
    assert.equal(lines.length, 1000);
  } finally {
    rmSync(join(f, ".."), { recursive: true, force: true });
  }
});

test("corrupt/missing file → empty history, never throws (CLI-062)", () => {
  assert.deepEqual(loadInputHistory("/no/such/file.jsonl"), []);
  const f = tmpFile();
  try {
    writeFileSync(f, 'not json\n"valid line"\n{bad\n"another"\n');
    assert.deepEqual(loadInputHistory(f), ["valid line", "another"]); // corrupt lines skipped
    // an oversized legacy file is truncated to the newest cap on read.
    const many = Array.from({ length: 1500 }, (_, i) => JSON.stringify(`x${i}`)).join("\n");
    writeFileSync(f, `${many}\n`);
    assert.equal(loadInputHistory(f).length, 1000);
  } finally {
    rmSync(join(f, ".."), { recursive: true, force: true });
  }
});

test("inputHistoryPath is under the prometheus home (CLI-062)", () => {
  assert.equal(inputHistoryPath("/home/.prometheus"), "/home/.prometheus/input-history.jsonl");
});
