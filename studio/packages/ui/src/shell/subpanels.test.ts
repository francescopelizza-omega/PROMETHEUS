/**
 * shell/subpanels.test.ts — the rail's lower half.
 *
 * These live here, beside the data, and import it directly. The previous version of the
 * duplicate-icon check lived in `shell.test.ts` holding a HAND-WRITTEN copy of the editor's icon
 * list, which is exactly why two entries could ship drawing the same glyph without anything
 * failing: the real array grew a duplicate and the test was reading a different list.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIVITY_ICON_NAMES } from "./icon-names.js";
import {
  EDITOR_SUBPANELS,
  SUBPANELS,
  defaultSubPanel,
  hasSubPanels,
  isSubPanel,
  resolveSubPanel,
  subPanelsFor,
} from "./subpanels.js";

test("the editor rail has the entries we think it has", () => {
  assert.ok(EDITOR_SUBPANELS.length >= 10, `only ${EDITOR_SUBPANELS.length} tool panels`);
});

test("NO TWO rail entries share an icon", () => {
  // An icon-only rail is a by-shape index. A repeated shape means one of the two entries can
  // only be found by hovering every button in turn — the whole affordance, gone.
  const byIcon = new Map<string, string[]>();
  for (const e of EDITOR_SUBPANELS) byIcon.set(e.icon, [...(byIcon.get(e.icon) ?? []), e.label]);
  assert.deepEqual(
    [...byIcon]
      .filter(([, labels]) => labels.length > 1)
      .map(([icon, labels]) => `${icon} → ${labels.join(" + ")}`),
    [],
    "two tool panels draw the same glyph",
  );
});

test("every rail icon has real geometry — a typo renders a blank button, not an error", () => {
  // `ActivityIcon` falls back to a plain dot for an unknown name, silently.
  const known = new Set<string>(ACTIVITY_ICON_NAMES);
  for (const e of EDITOR_SUBPANELS) {
    assert.ok(known.has(e.icon), `tool panel "${e.label}" uses unknown icon "${e.icon}"`);
  }
});

test("every rail entry has a distinct id and a non-empty label", () => {
  const ids = EDITOR_SUBPANELS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(", ")}`);
  for (const e of EDITOR_SUBPANELS) assert.ok(e.label.trim().length > 0, `${e.id} has no label`);
});

test("only the editor has a lower rail — a divider must never mean nothing", () => {
  assert.equal(hasSubPanels("editor"), true);
  for (const a of ["home", "catalog", "models", "security", "workspace", "chat"] as const) {
    assert.equal(hasSubPanels(a), false, `${a} unexpectedly grew tool panels`);
    assert.deepEqual(subPanelsFor(a), []);
    assert.equal(defaultSubPanel(a), undefined);
  }
  assert.deepEqual(Object.keys(SUBPANELS), ["editor"]);
});

test("resolveSubPanel falls back when a persisted id names a panel that is gone", () => {
  // An operator who quit on "Coverage" after that panel was renamed would otherwise reopen to a
  // rail with nothing selected and a blank side pane.
  assert.equal(resolveSubPanel("editor", "coverage"), "coverage");
  assert.equal(resolveSubPanel("editor", "a-panel-we-deleted"), "explorer");
  assert.equal(resolveSubPanel("editor", undefined), "explorer");
  assert.equal(resolveSubPanel("home", "explorer"), undefined, "an activity with no panels");
});

test("isSubPanel is scoped to the activity", () => {
  assert.equal(isSubPanel("editor", "git"), true);
  assert.equal(isSubPanel("home", "git"), false);
});

test("the panel list is frozen — a route must not mutate the shared rail", () => {
  assert.throws(() => {
    (EDITOR_SUBPANELS as unknown as { push: (x: unknown) => void }).push({ id: "x" });
  });
});
