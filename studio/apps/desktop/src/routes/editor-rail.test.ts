/**
 * routes/editor-rail.test.ts — the seam between the shell's rail and the editor's panels.
 *
 * The buttons now live in the shell (`renderer/shell/ActivityBar.tsx`, driven by
 * `@prometheus/ui` shell/subpanels.ts) and the panel bodies live here. Two halves of one
 * feature, in two packages, joined by a plain string id that crosses the boundary untyped.
 *
 * Nothing but this file connects them. Rename an id on either side and you get a rail button
 * that highlights and shows an empty pane — no type error, no crash, no test failure. So the
 * ids are checked against each other, from source, in both directions.
 *
 * (The rail's own invariants — distinct icons, real geometry, the lookup helpers — live beside
 * the data in `packages/ui/src/shell/subpanels.test.ts`.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const UI_SUBPANELS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "ui",
  "src",
  "shell",
  "subpanels.ts",
);

/** The rail's ids, read from the shared declaration. */
function railIds(): string[] {
  const src = readFileSync(UI_SUBPANELS, "utf8");
  const start = src.indexOf("export const EDITOR_SUBPANELS");
  assert.notEqual(start, -1, "EDITOR_SUBPANELS moved — this guard needs updating");
  const body = src.slice(start, src.indexOf("]);", start));
  const ids = [...body.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1] as string);
  assert.ok(ids.length >= 10, `only parsed ${ids.length} rail ids — the pattern rotted`);
  return ids;
}

function editorSrc(): string {
  return readFileSync(join(import.meta.dirname, "editor.tsx"), "utf8");
}

test("the ROUTE renders a body for every id the RAIL can select", () => {
  const editor = editorSrc();
  for (const id of railIds()) {
    assert.ok(
      editor.includes(`activity === "${id}"`),
      `the rail can select "${id}" but editor.tsx renders nothing for it`,
    );
  }
});

test("the route's Activity union covers every rail id", () => {
  const editor = editorSrc();
  // Anchor on the DECLARATION at column 0 and stop at its terminating `;`. Slicing to the
  // next `type BottomTab` looked right and was not: that string also occurs in an import alias
  // ABOVE this declaration, so the slice ran backwards and matched nothing at all — a guard
  // that passes vacuously is worse than no guard.
  const start = editor.indexOf("\ntype Activity =");
  assert.notEqual(start, -1, "the Activity union moved — this guard needs updating");
  const union = editor.slice(start, editor.indexOf(";", start));
  for (const id of railIds()) {
    assert.ok(union.includes(`"${id}"`), `the Activity union is missing "${id}"`);
  }
});

test("the route no longer paints a SECOND icon rail of its own", () => {
  // The whole point of the fusion: one column, not two. A route that re-grew its own strip
  // would put the two columns back without changing anything the other guards look at.
  const editor = editorSrc();
  assert.doesNotMatch(editor, /aria-label="activity bar"/i, "the editor re-grew its own rail");
  assert.doesNotMatch(editor, /ACTIVITY\.map\(/, "the editor re-grew its own rail list");
});

test("the editor is CONTROLLED by the shell, and still stands alone without it", () => {
  const editor = editorSrc();
  assert.match(editor, /subPanel\?: string;/, "the route lost its controlled prop");
  assert.match(editor, /onSubPanel\?:/, "the route lost its change callback");
  // …and the uncontrolled fallback, so the route still works with no props (tests, isolation).
  assert.match(editor, /useState<Activity>\("explorer"\)/, "the uncontrolled fallback is gone");
});
