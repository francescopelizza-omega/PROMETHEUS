/**
 * responsive.test.ts — §2's collapse order, which had no implementation at all.
 *
 * handoff §2: "Min window 1100×680. Collapse order below 1100px: chat rail → tray, file
 * tree → overlay." An audit of the whole shell found no `matchMedia`, no breakpoint and no
 * width listener anywhere — the only `window.innerWidth` reads were drag-resize max caps,
 * which bound a pane being dragged and never flip a panel into another mode.
 *
 * The subtle half is the LAST test: a width-driven collapse must never write the user's
 * preference. That is the same request-vs-applied split the authorisation level and the
 * effort tier both use, and for the same reason — a clamp that persists itself silently
 * becomes a preference the user never chose.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SHELL_MIN_WIDTH,
  TREE_OVERLAY_WIDTH,
  clearOverrideIfRoomy,
  openRail,
  railCollapsed,
  railCollapsedNow,
  shellCollapse,
  toggleRail,
} from "./responsive.js";

const HERE = dirname(fileURLToPath(import.meta.url));

test("at or above the §2 minimum nothing collapses", () => {
  for (const w of [SHELL_MIN_WIDTH, 1280, 1920, 3440]) {
    assert.deepEqual(shellCollapse(w), { rail: "open", tree: "inline", narrow: false }, `${w}px`);
  }
});

test("the RAIL goes first — one pixel under the minimum", () => {
  const c = shellCollapse(SHELL_MIN_WIDTH - 1);
  assert.equal(c.rail, "tray");
  assert.equal(c.tree, "inline", "the tree must not go at the same time — order is the spec");
  assert.equal(c.narrow, true);
});

test("the TREE goes second, and only once traying the rail was not enough", () => {
  assert.ok(TREE_OVERLAY_WIDTH < SHELL_MIN_WIDTH, "the second step must be the narrower one");
  const c = shellCollapse(TREE_OVERLAY_WIDTH - 1);
  assert.equal(c.rail, "tray");
  assert.equal(c.tree, "overlay");
});

test("an unknown width resolves ROOMY — we do not collapse on ignorance", () => {
  for (const w of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(shellCollapse(w), { rail: "open", tree: "inline", narrow: false }, `${w}`);
  }
});

test("railCollapsed unions the user's choice with the narrow tray, never replacing it", () => {
  // wide: the user's own choice, both ways
  assert.equal(railCollapsed(false, 1440), false);
  assert.equal(railCollapsed(true, 1440), true, "a wide window must not re-open a closed rail");
  // narrow: trayed regardless
  assert.equal(railCollapsed(false, 900), true);
  assert.equal(railCollapsed(true, 900), true);
  // …and widening restores exactly what they chose — the proof that nothing was written
  assert.equal(railCollapsed(false, 1440), false, "the narrow pass must not have persisted");
});

test("DRIFT GUARD: App renders the EFFECTIVE rail state, and persists the user's", () => {
  const app = readFileSync(join(HERE, "..", "App.tsx"), "utf8");
  assert.match(app, /const railIsCollapsed = railCollapsedNow\(railState, viewportWidth\)/);
  assert.match(app, /collapsed=\{railIsCollapsed\}/, "RightRail reads the raw preference again");
  assert.match(app, /aiOpen=\{!railIsCollapsed\}/, "the ActivityBar badge disagrees with the rail");
  // the persisted blob must still carry the USER's value, not the resolved one
  assert.match(app, /saveLayout\(\{[\s\S]*?\n\s*rightCollapsed,/);
  assert.doesNotMatch(
    app,
    /saveLayout\(\{[\s\S]*?rightCollapsed: railIsCollapsed/,
    "a resize would silently rewrite the user's rail preference",
  );
});

test("DRIFT GUARD: the editor's file tree actually floats when narrow", () => {
  const editor = readFileSync(join(HERE, "..", "..", "routes", "editor.tsx"), "utf8");
  assert.match(editor, /position: treeOverlay \? "absolute" : "relative"/);
  // …and the aside needs a containing block, or `absolute` anchors to the VIEWPORT and the
  // tree floats over the whole window instead of over the editor.
  //
  // Assert the containing block itself, not whatever comment happens to follow it. The first
  // version of this line matched `position: "relative" … {/* activity bar`, so it broke the day
  // the activity bar moved out of this route — reporting a layout regression that had not
  // happened, about a rule that still held.
  const root = editor.slice(0, editor.indexOf("<ResizeHandle"));
  assert.match(
    root,
    /display: "flex",\s*\n\s*height: "100%",[\s\S]*?position: "relative",/,
    "the editor root lost the `position: relative` the overlaid tree anchors to",
  );
});

test("DRIFT GUARD: treeOverlay reaches the LIVE editor mount, not the dead switch", () => {
  /**
   * This guard exists because the first version of it did not, and the fix shipped into
   * dead code. `renderActivity` has an `EditorRoute` case, but App renders
   * `activity === "editor" ? null : …` — the editor is mounted separately in a keep-alive
   * block so its Monaco state survives navigation. Passing the prop to the switch alone
   * satisfied a naive "does the string appear in App.tsx" grep and changed nothing.
   */
  const app = readFileSync(join(HERE, "..", "App.tsx"), "utf8");
  const liveMount =
    /editorEverVisited &&[\s\S]*?<EditorRoute[\s\S]*?treeOverlay=\{collapse\.tree === "overlay"\}[\s\S]*?\/>/;
  assert.match(app, liveMount, "the keep-alive EditorRoute mount does not receive treeOverlay");
});

/* ── the shield's ARMED probe must reach the StatusBar too, not only Home ───────── */

test("DRIFT GUARD: the status-bar shield asks whether the scanner is PRESENT", () => {
  // Home's gate chip was fixed first. The status bar renders the same shield in the one
  // piece of chrome that is never off screen, and it had the same defect: a null verdict
  // falls to deriveShield's benign `clean`, so nemesis missing painted GREEN.
  const bar = readFileSync(join(HERE, "StatusBar.tsx"), "utf8");
  assert.match(bar, /deriveShield\(verdict, \{ dbStale, \.\.\.\(armed === undefined/);
  assert.match(bar, /shield\.state === "unarmed"\s*\?\s*"block"/, "unarmed must not tint benign");
  const app = readFileSync(join(HERE, "..", "App.tsx"), "utf8");
  assert.match(app, /armed: engineHealth\.nemesisPresent === true/);
});

/* -- section 2-j needs an escape hatch, or four controls are inert below 1100px -- */

test("below the breakpoint the rail trays by default, and a toggle OPENS it", () => {
  const trayed = { userCollapsed: false, narrowOverride: false };
  assert.equal(railCollapsedNow(trayed, 900), true, "default is trayed");
  const opened = toggleRail(trayed, 900);
  assert.deepEqual(opened, { userCollapsed: false, narrowOverride: true });
  assert.equal(railCollapsedNow(opened, 900), false, "the toggle must have a visible effect");
});

test("a toggle closes an overridden rail again", () => {
  const opened = { userCollapsed: false, narrowOverride: true };
  const closed = toggleRail(opened, 900);
  assert.deepEqual(closed, { userCollapsed: true, narrowOverride: false });
  assert.equal(railCollapsedNow(closed, 900), true);
});

test("opening on a WIDE window grants no standing exemption", () => {
  // otherwise a rail opened at 1400px would refuse to tray when the window is narrowed,
  // and section 2-j's default would never apply again.
  const opened = toggleRail({ userCollapsed: true, narrowOverride: false }, 1400);
  assert.equal(opened.narrowOverride, false);
  assert.equal(railCollapsedNow(opened, 900), true, "narrowing must still tray it");
});

test("widening retires the override so the next narrow episode trays again", () => {
  const overridden = { userCollapsed: false, narrowOverride: true };
  assert.deepEqual(clearOverrideIfRoomy(overridden, 1400), {
    userCollapsed: false,
    narrowOverride: false,
  });
  // …and while still narrow it is left alone
  assert.deepEqual(clearOverrideIfRoomy(overridden, 900), overridden);
});

test("openRail forces the rail open at any width", () => {
  // Home's ask bar hands the agent a prompt; the tray does not RENDER the agent, so the
  // seed event used to land on a listener that did not exist and the prompt vanished.
  assert.equal(railCollapsedNow(openRail(900), 900), false);
  assert.equal(railCollapsedNow(openRail(1400), 1400), false);
});

test("DRIFT GUARD: every rail toggle goes through the hatch, and open-agent forces it", () => {
  const app = readFileSync(join(HERE, "..", "App.tsx"), "utf8");
  assert.doesNotMatch(
    app,
    /setRightCollapsed\(\(v\) => !v\)/,
    "a raw toggle is back - it would be inert below 1100px",
  );
  assert.match(app, /toggleRightRail: \(\) => toggleRail\(\)/);
  assert.match(app, /onToggleAI=\{\(\) => toggleRail\(\)\}/);
  assert.match(app, /onToggle=\{\(\) => toggleRail\(\)\}/);
  // the ask-bar path must FORCE open, not merely un-collapse
  assert.match(app, /const onOpenAgent[\s\S]{0,200}forceOpenRail\(\)/);
});
