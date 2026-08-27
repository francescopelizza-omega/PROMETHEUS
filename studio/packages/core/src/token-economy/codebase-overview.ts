/**
 * token-economy/codebase-overview.ts — "meet your codebase" (roadmap point 6): turn the
 * already-built, already-tested repo map (`repo-map.ts`'s `walkRepo`/`RepoMap`) into a friendly,
 * HUMAN-facing summary, instead of the map's only existing use — silently grounding the agent's
 * context (CLI-053). The walk/render primitives are not duplicated here, only interpreted
 * differently: same file tree, a different reader.
 *
 * PURE: takes an already-built `RepoMap` (the caller owns the walk + the fs adapter, exactly
 * like `renderRepoMap` does) — no fs, no host-specific I/O, so both the CLI and desktop can
 * share this exact reading of a repo without either re-deriving it.
 *
 * Stack detection is DELIBERATELY marker-file presence only (package.json, Cargo.toml, …) at the
 * repo ROOT, never a parse of file contents — content-based detection (e.g. reading
 * package.json's own fields) would need the file's bytes, which `RepoEntry` does not carry (only
 * `path` + extracted `symbols`), and root-marker presence is already a strong, simple signal a
 * human recognizes instantly.
 */
import type { RepoMap } from "./repo-map.js";

/** One root-level marker file (or file-extension pattern) that identifies a stack. */
interface StackMarker {
  label: string;
  /** exact root-level filenames that identify this stack. */
  files?: readonly string[];
  /** root-level filename SUFFIXES (e.g. ".csproj") that identify this stack. */
  suffixes?: readonly string[];
}

/** Ordered so a repo with multiple markers reports its stacks in a stable, sensible order. */
const STACK_MARKERS: readonly StackMarker[] = Object.freeze([
  { label: "Node.js / JavaScript", files: ["package.json"] },
  { label: "TypeScript", files: ["tsconfig.json"] },
  { label: "Rust", files: ["Cargo.toml"] },
  { label: "Python", files: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"] },
  { label: "Go", files: ["go.mod"] },
  { label: "Java / JVM", files: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { label: "Ruby", files: ["Gemfile"] },
  { label: "PHP", files: ["composer.json"] },
  { label: ".NET / C#", suffixes: [".csproj", ".sln"] },
]);

/** A recognized "this is where you'd naturally start reading" filename, most common first. */
const README_RE = /^readme(\.[a-z0-9]+)?$/i;

export interface OverviewCount {
  key: string;
  count: number;
}

export interface CodebaseOverview {
  fileCount: number;
  /** true when the underlying walk hit its file cap — this is a PARTIAL picture, said honestly. */
  truncated: boolean;
  /** file extensions by how many files carry them, most common first (no extension ⇒ "(none)"). */
  topExtensions: OverviewCount[];
  /** top-level directories by how many files live under them ("(root)" for top-level files). */
  topDirs: OverviewCount[];
  /** every stack this repo shows a root-level marker for — may be empty, may have several. */
  detectedStacks: string[];
  /** a root-level README's path, if one exists. */
  readmePath?: string;
  /** a handful of exported/top-level symbol names, sampled from the largest files — a taste of
   *  what the codebase actually DOES, not just what's in it. Empty when nothing was extracted
   *  (e.g. a repo of only binary/oversized/unrecognized-extension files). */
  sampleSymbols: string[];
}

function topN(counts: Map<string, number>, n: number): OverviewCount[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function topLevelDirOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

function extensionOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash ? path.slice(lastDot + 1).toLowerCase() : "(none)";
}

/** Summarize an already-built `RepoMap` for a human meeting this codebase for the first time. */
export function summarizeCodebase(map: RepoMap): CodebaseOverview {
  const extCounts = new Map<string, number>();
  const dirCounts = new Map<string, number>();
  const rootNames = new Set<string>();
  let readmePath: string | undefined;

  for (const entry of map.entries) {
    extCounts.set(extensionOf(entry.path), (extCounts.get(extensionOf(entry.path)) ?? 0) + 1);
    const dir = topLevelDirOf(entry.path);
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    if (dir === "(root)") {
      rootNames.add(entry.path);
      if (!readmePath && README_RE.test(entry.path)) readmePath = entry.path;
    }
  }

  const detectedStacks: string[] = [];
  for (const marker of STACK_MARKERS) {
    const hit =
      (marker.files?.some((f) => rootNames.has(f)) ?? false) ||
      (marker.suffixes?.some((suf) => [...rootNames].some((n) => n.endsWith(suf))) ?? false);
    if (hit) detectedStacks.push(marker.label);
  }

  // A handful of symbols from the files that actually HAVE any, biggest symbol lists first — a
  // file with 20 exports is more likely to be a real entry point than one with a single helper.
  const sampleSymbols = [...map.entries]
    .filter((e) => e.symbols.length > 0)
    .sort((a, b) => b.symbols.length - a.symbols.length)
    .slice(0, 5)
    .flatMap((e) => e.symbols.slice(0, 3))
    .slice(0, 12);

  return {
    fileCount: map.fileCount,
    truncated: map.truncated,
    topExtensions: topN(extCounts, 8),
    topDirs: topN(dirCounts, 8),
    detectedStacks,
    ...(readmePath ? { readmePath } : {}),
    sampleSymbols,
  };
}

/** Render a `CodebaseOverview` as friendly, human-readable text — no markup, safe for a plain
 *  terminal or a plain `<pre>`. */
export function renderCodebaseOverview(o: CodebaseOverview): string {
  const lines: string[] = [];
  const truncNote = o.truncated
    ? " (showing a sample — this repo is larger than the scan cap)"
    : "";
  lines.push(`${o.fileCount.toLocaleString()} files${truncNote}`);

  if (o.detectedStacks.length > 0) {
    lines.push(`Looks like: ${o.detectedStacks.join(", ")}`);
  }

  if (o.topDirs.length > 0) {
    lines.push(
      "",
      "Where the code lives:",
      ...o.topDirs.map(
        (d) => `  ${d.key}/  — ${d.count.toLocaleString()} file${d.count === 1 ? "" : "s"}`,
      ),
    );
  }

  if (o.topExtensions.length > 0) {
    lines.push(
      "",
      "Mostly written in:",
      `  ${o.topExtensions.map((e) => `.${e.key} (${e.count})`).join("  ·  ")}`,
    );
  }

  if (o.sampleSymbols.length > 0) {
    lines.push("", "A few things it defines:", `  ${o.sampleSymbols.join(", ")}`);
  }

  if (o.readmePath) {
    lines.push("", `Start here: ${o.readmePath}`);
  }

  return lines.join("\n");
}
