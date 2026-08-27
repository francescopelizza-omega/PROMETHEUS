/**
 * dirty-recovery-discard.test.ts — an explicitly DISCARDED buffer must not resurrect.
 *
 * The APP-067 crash-recovery record is written on every keystroke and was cleared on exactly one
 * condition: a successful save. So "Close without saving" left it behind, reopening the file
 * preferred that text over the bytes on disk and marked the tab dirty, and a Cmd-S then wrote
 * the edit the user had explicitly thrown away. It survived a restart too — the blob is
 * persisted to localStorage.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the close path clears the recovery copy when the last tab row for a uri goes", () => {
  /**
   * A source guard, deliberately: the discard happens in a React click handler that cannot be
   * driven headlessly, and the defect is precisely that ONE call was missing from it. The
   * `lastRow` condition matters as much as the clear — with a split still showing the file the
   * buffer is still open, and dropping its recovery copy there would re-introduce the data loss
   * from the other direction.
   */
  const src = readFileSync(new URL("../EditorPane.tsx", import.meta.url), "utf8");
  const closeHandler = src.slice(
    src.indexOf("has unsaved changes. Close without saving?"),
    src.indexOf("close(t.uri, t.group);"),
  );
  assert.ok(
    closeHandler.includes("useDirtyRecoveryStore.getState().clear(t.uri)"),
    "discarding a buffer must drop its crash-recovery copy",
  );
  assert.ok(
    closeHandler.includes("lastRow"),
    "…but only when the uri is leaving its LAST group — a split still has the buffer open",
  );
});

test("recovered() is documented as a pure lookup, not a consuming read", () => {
  // The old comment said "consumed once on restore", which nothing implemented — that wording
  // is why the missing `clear` on discard looked already handled.
  const src = readFileSync(new URL("./stores.ts", import.meta.url), "utf8");
  const iface = src.slice(
    src.indexOf("export interface DirtyRecoveryStore"),
    src.indexOf("export const useDirtyRecoveryStore"),
  );
  // (the corrected comment QUOTES the old wording while explaining it, so assert the new
  //  contract is stated rather than that the old phrase is absent)
  assert.ok(iface.includes("pure LOOKUP"), "recovered() must be documented as non-consuming");
  assert.ok(iface.includes("does not consume the record"), "…explicitly");
  assert.ok(iface.includes("DISCARD"), "the clear contract must name the discard path");
});
