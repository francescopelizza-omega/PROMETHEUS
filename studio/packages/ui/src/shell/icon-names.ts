/**
 * shell/icon-names.ts — the CANONICAL activity-icon name set (file 08 §4.1 / APP-071).
 *
 * Pure data (NO JSX) so it is node:test-able: the run-tests dev-register strips TS types but
 * does NOT transform JSX, so a test that imported `icons.tsx` (module-level SVG JSX) would fail
 * to parse. `PATHS` in icons.tsx is typed `Record<ActivityIconName, ReactNode>`, so a name here
 * WITHOUT geometry — or geometry WITHOUT a name — is a TYPE error, not a silent blank rail button
 * (ActivityIcon falls back to a dot when a name is missing). This is the single source of truth
 * for "which icons exist".
 */

/** Every activity-icon name that has geometry in icons.tsx PATHS. */
export const ACTIVITY_ICON_NAMES = [
  // shell rail (file 08 §4.1)
  "Home",
  "Code2",
  "LayoutGrid",
  "MessageSquare",
  "Boxes",
  "Container",
  "ShieldCheck",
  "GitBranch",
  "BookOpen",
  "Puzzle",
  "Activity",
  "Settings",
  // editor inner rail + open buttons (APP-071)
  "Files",
  "Search",
  "Bug",
  "FlaskConical",
  "ListChecks",
  "ListTree",
  "CallHierarchy",
  "TypeHierarchy",
  // Method Hierarchy and Coverage each had NO icon of their own and borrowed a neighbour's:
  // Method Hierarchy drew `CallHierarchy` and Coverage drew `FlaskConical`, so the editor's
  // icon rail showed the same glyph twice in two different places. An icon rail is a
  // by-shape index — two entries with one shape means one of them can only be found by
  // hovering every button, which is the whole affordance gone.
  "MethodHierarchy",
  "Coverage",
  "History",
  "FileText",
  "FolderOpen",
] as const;

export type ActivityIconName = (typeof ACTIVITY_ICON_NAMES)[number];

const NAME_SET: ReadonlySet<string> = new Set(ACTIVITY_ICON_NAMES);

/** Whether a custom icon exists for `name` (else ActivityIcon renders a fallback dot). */
export function hasActivityIcon(name: string): boolean {
  return NAME_SET.has(name);
}
