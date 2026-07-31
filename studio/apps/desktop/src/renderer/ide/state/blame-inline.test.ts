/**
 * blame-inline.test.ts — the PURE inline-blame decoration builder (APP-083).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { IdeGitBlameEntry } from "../../../shared/ipc-contract.js";
import {
  INLINE_BLAME_CLASS,
  blameByLine,
  buildInlineBlameDecoration,
  inlineBlameHover,
  inlineBlameText,
  isUncommitted,
  relativeDate,
} from "./blame-inline.js";

const NOW = Date.UTC(2026, 0, 16, 12, 0, 0); // fixed "now" for deterministic relatives

function entry(over: Partial<IdeGitBlameEntry> = {}): IdeGitBlameEntry {
  return {
    line: 1,
    hash: "a".repeat(40),
    author: "Ada",
    date: "2026-01-13",
    summary: "fix the widget",
    epoch: Math.floor(NOW / 1000) - 3 * 86400, // 3 days ago
    ...over,
  };
}

test("isUncommitted: all-zero sha (any length) or missing → true", () => {
  assert.equal(isUncommitted("0".repeat(40)), true);
  assert.equal(isUncommitted("0000000"), true);
  assert.equal(isUncommitted(undefined), true);
  assert.equal(isUncommitted("a".repeat(40)), false);
});

test("relativeDate: buckets from epoch vs now", () => {
  const now = NOW;
  const sec = Math.floor(now / 1000);
  assert.equal(relativeDate(sec - 10, now), "just now");
  assert.equal(relativeDate(sec - 5 * 60, now), "5m ago");
  assert.equal(relativeDate(sec - 3 * 3600, now), "3h ago");
  assert.equal(relativeDate(sec - 4 * 86400, now), "4d ago");
  assert.equal(relativeDate(sec - 45 * 86400, now), "1mo ago");
  // the 360–364-day gap used to fall through to "0y ago"; it must read as months.
  assert.equal(relativeDate(sec - 362 * 86400, now), "12mo ago");
  assert.equal(relativeDate(sec - 364 * 86400, now), "12mo ago");
  assert.equal(relativeDate(sec - 365 * 86400, now), "1y ago");
  assert.equal(relativeDate(sec - 400 * 86400, now), "1y ago");
  assert.equal(relativeDate(0, now), ""); // no epoch → no relative
});

test("blameByLine: indexes by line; drops uncommitted + malformed rows", () => {
  const map = blameByLine([
    entry({ line: 1 }),
    entry({ line: 2, hash: "0".repeat(40) }), // uncommitted → dropped
    { line: 3 } as unknown as IdeGitBlameEntry, // malformed (no hash) → dropped
    entry({ line: 4 }),
  ]);
  assert.deepEqual([...map.keys()], [1, 4]);
  assert.equal(blameByLine(undefined).size, 0);
});

test("inlineBlameText: author, relative date, short sha", () => {
  assert.equal(inlineBlameText(entry(), NOW), "Ada, 3d ago • aaaaaaaa");
  // missing fields default rather than throw
  assert.equal(
    inlineBlameText({ line: 1, hash: "", author: "", date: "", summary: "", epoch: 0 }, NOW),
    "Unknown",
  );
});

test("inlineBlameHover: full sha, author, ISO date, summary", () => {
  const h = inlineBlameHover(entry());
  assert.match(h, /`a{40}`/);
  assert.match(h, /\*\*Ada\*\*/);
  assert.match(h, /2026-01-13/);
  assert.match(h, /fix the widget/);
});

test("buildInlineBlameDecoration: current line after-content + hover; [] when nothing", () => {
  const decos = buildInlineBlameDecoration(entry({ line: 7 }), 20, NOW, 1);
  assert.equal(decos.length, 1);
  const d = decos[0]!;
  assert.equal(d.range.startLineNumber, 7);
  assert.equal(d.range.startColumn, 20);
  assert.equal(d.options.after.inlineClassName, INLINE_BLAME_CLASS);
  assert.match(d.options.after.content, /Ada, 3d ago • aaaaaaaa/);
  assert.match(d.options.hoverMessage.value, /a{40}/);
  assert.equal(d.options.stickiness, 1);
  // uncommitted / no entry / invalid line → no decoration
  assert.deepEqual(buildInlineBlameDecoration(entry({ hash: "0".repeat(40) }), 20, NOW, 1), []);
  assert.deepEqual(buildInlineBlameDecoration(undefined, 20, NOW, 1), []);
  assert.deepEqual(buildInlineBlameDecoration(entry({ line: 0 }), 20, NOW, 1), []);
});
