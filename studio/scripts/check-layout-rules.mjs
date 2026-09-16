/**
 * scripts/check-layout-rules.mjs — HANDOFF_2 §9 "Layout rules, codified".
 *
 * §9's exact framing is "stop rediscovering them". A rule that lives only in a handoff
 * document gets re-broken by the next person who has not read it, so each of these is a
 * build failure instead of a note:
 *
 *   1. NO `overflow-wrap: anywhere` (and no `overflowWrap: "anywhere"`). Use `break-word`.
 *      `anywhere` also changes min-content sizing, so it silently collapses flex siblings
 *      — the break-in-the-middle-of-a-word look is only the visible half of the bug.
 *   2. NO fixed-px pane heights on the panes §9 names. Panels flex or size to the
 *      viewport; a hardcoded height wastes a tall window and clips a short one.
 *   3. NO ellipsis without a shrink floor. `overflow:hidden` + `text-overflow:ellipsis` do
 *      NOTHING to a flex/grid item until it is allowed to shrink: an item's floor is its
 *      min-content width, so an "ellipsised" label holds its row open at full width and pushes
 *      the cost onto its siblings — which is how "Open Folder" ended up wrapping onto two lines
 *      inside its own button. `minWidth: 0` is a no-op on a plain block box, so requiring it
 *      next to every ellipsis costs nothing and closes the whole family.
 *   4. NO bare numeric z-index. There is ONE ladder (packages/ui/src/tokens/layers.ts):
 *      base / raise / dropdown / palette / modal / toast. Sixteen ad-hoc values is how a
 *      force-override dialog ends up underneath a command palette.
 *
 * Escape hatch: `// layout-allow: <reason>` on the offending line. It requires a reason,
 * because "I needed it" is not one.
 *
 * Run: node scripts/check-layout-rules.mjs   (wired into `pnpm lint` + `pnpm test`).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Source roots the layout rules govern (the same surfaces the token guard scans). */
const SCAN = ["packages/ui/src", "apps/desktop/src/renderer", "apps/desktop/src/routes"];
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release", ".git", "coverage"]);
const SKIP_FILE = /\.(test|spec)\.(ts|tsx)$|\.d\.ts$|(^|\/)layers\.ts$/;
const SOURCE = /\.(ts|tsx|css)$/;

const ALLOW = /\/\/\s*layout-allow:\s*\S/;

/** Rule 1 — `anywhere` in either CSS or JSX style-object form. */
const ANYWHERE = /overflow-wrap:\s*anywhere|overflowWrap:\s*["']anywhere["']/;

/**
 * Rule 2 — a fixed-px pane height.
 *
 * Scoped to DEFINITE `height:` only, at pane scale (>= 120px). Two deliberate exclusions:
 *   - small fixed heights (a 28px row, a 6px meter, a 34px button) are component geometry,
 *     not panes;
 *   - `maxHeight` is NOT policed. A cap on a scrolling popover/list is a good pattern, not
 *     the bug §9 is describing — the bug is a pane COMMITTING to a size, which wastes a
 *     tall window and clips a short one. Policing every capped dropdown would train people
 *     to sprinkle the escape hatch, and a lint rule everyone silences is worse than none.
 * The three cases §9 names (Git diff 280, chat 320, BottomPanel 220) are all covered:
 * the first two were definite heights on panes, the third is a resizable default.
 */
const PANE_HEIGHT = /(?<!max)(?<!Max)\bheight:\s*["']?(\d{3,})(?:px)?["']?\s*[,;]/i;
const PANE_MIN_PX = 120;

/** Rule 3 — `text-overflow: ellipsis` needs a `minWidth: 0` in the SAME style object. */
const ELLIPSIS = /textOverflow:\s*["']ellipsis["']|text-overflow:\s*ellipsis/;
/** How far around an ellipsis line to look for the floor (one style object). */
const ELLIPSIS_WINDOW = 16;
const MIN_WIDTH_0 = /minWidth:\s*0|min-width:\s*0/;

/** Rule 4 — a bare numeric z-index. Must be a `Z.<rung>` from the shared ladder. */
const BARE_Z = /zIndex:\s*\d|z-index:\s*\d/;

function collect(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collect(join(dir, e.name), acc);
    } else if (SOURCE.test(e.name) && !SKIP_FILE.test(e.name)) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

const files = SCAN.flatMap((s) => collect(join(ROOT, s), []));
const violations = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (ALLOW.test(line)) return;
    if (ANYWHERE.test(line)) {
      violations.push(
        `${rel}:${i + 1}  overflow-wrap:anywhere  →  use break-word  |${line.trim()}`,
      );
    }
    if (BARE_Z.test(line)) {
      violations.push(
        `${rel}:${i + 1}  bare z-index  →  use Z.<rung> (tokens/layers.ts)  |${line.trim()}`,
      );
    }
    const m = PANE_HEIGHT.exec(line);
    if (m && Number(m[1]) >= PANE_MIN_PX) {
      violations.push(
        `${rel}:${i + 1}  fixed ${m[1]}px pane height  →  flex or vh  |${line.trim()}`,
      );
    }
    if (ELLIPSIS.test(line)) {
      // Look at the enclosing style OBJECT, not the one line: the floor is a sibling property
      // and which side of `textOverflow` it is written on is nobody's business.
      const near = lines.slice(Math.max(0, i - ELLIPSIS_WINDOW), i + ELLIPSIS_WINDOW).join("\n");
      if (!MIN_WIDTH_0.test(near)) {
        violations.push(
          `${rel}:${i + 1}  ellipsis with no shrink floor  →  add minWidth: 0  |${line.trim()}`,
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`✗ layout-rules: ${violations.length} violation(s) of HANDOFF_2 §9:`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nRules: (1) long strings wrap with overflow-wrap:break-word, NEVER `anywhere`." +
      "\n       (2) panes flex or size to the viewport — no fixed-px pane heights." +
      "\n       (3) text-overflow:ellipsis needs minWidth:0 — a flex item cannot shrink without it." +
      "\n       (4) z-index comes from the Z ladder, never a bare number." +
      "\nIf a case is genuinely legitimate, annotate the line: `// layout-allow: <reason>`.",
  );
  process.exit(1);
}

console.log(`✓ layout-rules: ${files.length} files scanned, §9 layout rules hold.`);
