/**
 * path-completion/index.ts — shared fuzzy path-fragment scoring + frecency ranking for
 * the "@"-triggered path completion feature (CLI composer + desktop "@"-mention pickers
 * and any other text field that adopts it).
 *
 * Framework-free (no node/react/electron/DOM imports) so it is safe to import from the
 * sandboxed Electron renderer as well as the CLI and the desktop main process — mirrors
 * the `@prometheus/core/keymap`-style narrow-subpath convention. Directory listing and
 * on-disk persistence are HOST-specific (node:fs for the CLI; an IPC round-trip to main
 * for the desktop renderer) and deliberately live outside this module: everything here
 * is pure data in, data out, and unit-testable without touching a filesystem.
 *
 * The fuzzy scorer below is the same optimal-alignment subsequence algorithm already
 * proven in `apps/desktop/src/renderer/ide/state/fuzzy.ts` (the command-palette/quick-open
 * matcher) — ported here rather than duplicated-and-diverged, so path completion and
 * quick-open rank things the same way. Its word-boundary set already includes `/`, which
 * is exactly the character that matters for ranking path fragments.
 */

export interface FuzzyMatch {
  /** Higher is a better match. */
  score: number;
  /** Indices into `candidate` that matched, ascending (for highlighting). */
  positions: number[];
}

const WORD_BOUNDARY = new Set(["/", "\\", ".", "_", "-", " ", ":"]);

function isBoundary(candidate: string, i: number): boolean {
  return i === 0 || WORD_BOUNDARY.has(candidate[i - 1] ?? "");
}

function matchReward(
  query: string,
  candidate: string,
  qi: number,
  i: number,
  contiguous: boolean,
): number {
  let pts = 1; // base
  if (contiguous) pts += 6; // continues a contiguous run (fzf-style; dominates)
  if (isBoundary(candidate, i)) pts += 4; // start of a path segment / word
  if (i === 0 && qi === 0) pts += 8; // prefix of the whole candidate
  if (candidate[i] === query[qi]) pts += 1; // case-exact
  return pts;
}

/**
 * Score one candidate (a single path segment, e.g. a directory entry's basename) against
 * a query fragment: case-insensitive subsequence match via an OPTIMAL alignment (a small
 * O(n·m) DP), not a greedy earliest-match — so a contiguous, word-aligned run ("runner"
 * inside "test_runner.py") beats a scattered earliest-char match, and a clean prefix beats
 * a separator-spread one. Returns null when `query` is not a subsequence of `candidate` —
 * this is what makes matching "fragmented" rather than a rigid `startsWith` prefix check.
 *
 * Operates on UTF-16 code units: correct for ASCII/BMP text (the common case for file
 * names). Both current callers only ever hand this a query built from an ASCII trigger
 * token, so an astral character (a surrogate PAIR — an emoji, a rare CJK extension char)
 * never reaches it today; a future caller passing one through could align a code unit
 * across two unrelated characters that happen to share a surrogate half.
 */
export function scoreFragment(query: string, candidate: string): FuzzyMatch | null {
  if (query === "") return { score: 0, positions: [] };
  // Case-insensitive PER-CHARACTER comparison, never a whole-string .toLowerCase(): some
  // characters lowercase to MORE code units than they started with (e.g. Turkish İ U+0130
  // → "i" + a combining dot, 2 units), which would silently shift `c`'s indices out of
  // sync with `candidate`'s — and `positions` is documented (and used by callers) as
  // indices into the ORIGINAL candidate for highlighting, so they must never drift.
  const q = query;
  const c = candidate;
  const n = q.length;
  const m = c.length;
  if (n > m) return null;
  const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  const NEG = Number.NEGATIVE_INFINITY;
  const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(NEG));
  const back: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1));

  for (let i = 0; i < m; i++) {
    if (eq(c[i]!, q[0]!)) best[0]![i] = matchReward(query, candidate, 0, i, false);
  }
  for (let qi = 1; qi < n; qi++) {
    for (let i = qi; i < m; i++) {
      if (!eq(c[i]!, q[qi]!)) continue;
      let bestPrev = NEG;
      let bestPrevIdx = -1;
      for (let p = qi - 1; p < i; p++) {
        const prevScore = best[qi - 1]![p]!;
        if (prevScore === NEG) continue;
        const contiguous = p === i - 1;
        const gapPenalty = contiguous ? 0 : Math.min(i - p - 1, 3);
        const cand = prevScore + matchReward(query, candidate, qi, i, contiguous) - gapPenalty;
        if (cand > bestPrev) {
          bestPrev = cand;
          bestPrevIdx = p;
        }
      }
      best[qi]![i] = bestPrev;
      back[qi]![i] = bestPrevIdx;
    }
  }

  let endIdx = -1;
  let endScore = NEG;
  for (let i = n - 1; i < m; i++) {
    const s = best[n - 1]![i]!;
    if (s > endScore) {
      endScore = s;
      endIdx = i;
    }
  }
  if (endIdx === -1 || endScore === NEG) return null;

  const positions: number[] = new Array<number>(n);
  let qi = n - 1;
  let i = endIdx;
  while (qi >= 0) {
    positions[qi] = i;
    i = back[qi]![i]!;
    qi--;
  }

  // shorter candidates that fully matched rank slightly higher (tighter match).
  const score = endScore + Math.max(0, 10 - (candidate.length - query.length) * 0.1);
  return { score, positions };
}

/* ── directory-entry ranking (fuzzy + optional frecency nudge) ───────────────────── */

export interface PathEntry {
  /** Basename only — the caller resolves the full path. */
  name: string;
  isDir: boolean;
}

export interface RankedEntry extends PathEntry {
  score: number;
  positions: number[];
  /** How much of `score` came from frecency (0 when frecency is off/unknown for this entry). */
  frecencyBoost: number;
}

/**
 * How much a raw frecency score (see `frecencyScore` below) can nudge the fuzzy rank.
 * Sized relative to `scoreFragment`'s scale (each matched char is worth up to ~20 points)
 * so a frequently-used entry can win a close tie or a weak match, but a strong fuzzy match
 * against what you actually TYPED still wins over a stale habit — frecency assists, it
 * never overrides.
 */
const FRECENCY_BONUS_WEIGHT = 14;

function normalizedBoost(rawScore: number, maxRawScore: number): number {
  if (maxRawScore <= 0) return 0;
  return (rawScore / maxRawScore) * FRECENCY_BONUS_WEIGHT;
}

/**
 * Rank one directory's entries against a query fragment.
 *
 * With a BLANK query (the user just typed "@" or "@some/dir/" with nothing after the
 * final slash yet) there is no fuzzy signal to rank on, so frecency — if any entries here
 * have a recorded score — becomes the primary sort key: this is the "suggest even faster"
 * behavior, surfacing your habitual picks the instant the trigger fires. Directories sort
 * before files at equal frecency (you're usually navigating, not naming a leaf file).
 *
 * With a non-blank query, every entry is fuzzy-scored (non-matches dropped) and a bounded
 * frecency bonus is added so frequently-used entries rank a little higher without letting
 * frecency alone beat a much better textual match.
 */
export function rankEntries(
  query: string,
  entries: readonly PathEntry[],
  frecencyByName: ReadonlyMap<string, number> = new Map(),
): RankedEntry[] {
  const q = query.trim();
  const maxRaw = frecencyByName.size > 0 ? Math.max(0, ...frecencyByName.values()) : 0;

  if (q === "") {
    return [...entries]
      .map((e) => {
        const boost = normalizedBoost(frecencyByName.get(e.name) ?? 0, maxRaw);
        return { ...e, score: boost, positions: [] as number[], frecencyBoost: boost };
      })
      .sort(
        (a, b) =>
          b.frecencyBoost - a.frecencyBoost ||
          (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1),
      );
  }

  const scored: RankedEntry[] = [];
  for (const e of entries) {
    const m = scoreFragment(q, e.name);
    if (!m) continue;
    const boost = normalizedBoost(frecencyByName.get(e.name) ?? 0, maxRaw);
    scored.push({ ...e, score: m.score + boost, positions: m.positions, frecencyBoost: boost });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}

/* ── frecency store (pure; persistence is the caller's job) ──────────────────────── */

export interface FrecencyEntry {
  /** Resolved absolute path. */
  path: string;
  count: number;
  lastUsedMs: number;
}

export interface FrecencyStore {
  entries: FrecencyEntry[];
}

export const EMPTY_FRECENCY_STORE: FrecencyStore = Object.freeze({ entries: [] });

/** At most this many paths are remembered per project — the least-frecent is evicted. */
export const MAX_FRECENCY_ENTRIES = 20;

/** Half-life of the recency decay: a path used once 2 weeks ago and never since has about
 *  half the weight of one used just now, so habits genuinely shift as work moves on. */
const HALF_LIFE_DAYS = 14;

/** count × exp-decay(age) — frequent AND recent beats either alone. */
export function frecencyScore(entry: FrecencyEntry, nowMs: number): number {
  // defensive: a non-finite count/lastUsedMs (e.g. a hand-built entry that skipped
  // parseFrecencyStore's own validation) must score as "no signal", never NaN/Infinity —
  // rankEntries' shared `maxRaw` would otherwise let ONE bad entry poison every other
  // entry's boost in the same directory listing via `Math.max(0, ...values)`.
  if (!Number.isFinite(entry.count) || !Number.isFinite(entry.lastUsedMs)) return 0;
  const ageDays = Math.max(0, (nowMs - entry.lastUsedMs) / 86_400_000);
  const decay = 2 ** (-ageDays / HALF_LIFE_DAYS);
  return entry.count * decay;
}

/**
 * Record a use of `path` at `nowMs`. Immutable — returns the next store. When the store
 * would exceed `MAX_FRECENCY_ENTRIES`, the single lowest-frecency-score entry is evicted
 * (not an arbitrary/oldest one), so the remembered set always tracks current habits.
 */
export function recordPathUse(
  store: FrecencyStore,
  path: string,
  nowMs: number,
  maxEntries: number = MAX_FRECENCY_ENTRIES,
): FrecencyStore {
  const existing = store.entries.find((e) => e.path === path);
  let next: FrecencyEntry[] = existing
    ? store.entries.map((e) =>
        e.path === path ? { ...e, count: e.count + 1, lastUsedMs: nowMs } : e,
      )
    : [...store.entries, { path, count: 1, lastUsedMs: nowMs }];

  if (next.length > maxEntries) {
    next = [...next]
      .sort((a, b) => frecencyScore(b, nowMs) - frecencyScore(a, nowMs))
      .slice(0, maxEntries);
  }
  return { entries: next };
}

/** The top remembered paths, most-frecent first — the "suggest instantly on @" list. */
export function topFrecencyPaths(
  store: FrecencyStore,
  nowMs: number,
  limit: number = MAX_FRECENCY_ENTRIES,
): FrecencyEntry[] {
  return [...store.entries]
    .sort((a, b) => frecencyScore(b, nowMs) - frecencyScore(a, nowMs))
    .slice(0, limit);
}

/** A lenient parse for a persisted store: a missing/corrupt value yields an empty store
 *  rather than throwing (mirrors the repo's fail-soft settings/history-store convention). */
export function parseFrecencyStore(value: unknown): FrecencyStore {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { entries?: unknown }).entries)
  ) {
    return { entries: [] };
  }
  const entries: FrecencyEntry[] = [];
  for (const raw of (value as { entries: unknown[] }).entries) {
    const count = (raw as FrecencyEntry | undefined)?.count;
    const lastUsedMs = (raw as FrecencyEntry | undefined)?.lastUsedMs;
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as FrecencyEntry).path === "string" &&
      // finite + non-negative: a hand-corrupted file could otherwise inject Infinity/NaN,
      // which frecencyScore would turn into NaN and — via rankEntries' shared maxRaw —
      // poison every OTHER entry's boost in the same directory listing, not just this one.
      typeof count === "number" &&
      Number.isFinite(count) &&
      count >= 0 &&
      typeof lastUsedMs === "number" &&
      Number.isFinite(lastUsedMs) &&
      lastUsedMs >= 0
    ) {
      entries.push({ path: (raw as FrecencyEntry).path, count, lastUsedMs });
    }
  }
  return { entries };
}

/** Build the `frecencyByName` lookup `rankEntries` wants, scoped to one directory: only
 *  entries whose resolved path's parent is exactly `dirPath` contribute (a project-wide
 *  favorite from a DIFFERENT directory must not bleed into this listing's ranking). */
// both separators recognized (not just "/"): a resolved absolute path is backslash-only on
// Windows, and node:path's `join`/`resolve` never produce a forward slash there — matching
// "/" alone would make this return an empty map, silently, on every Windows install.
const lastSeparator = (p: string): number => Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));

export function frecencyForDirectory(
  store: FrecencyStore,
  dirPath: string,
  nowMs: number,
): Map<string, number> {
  const normalized = /[/\\]$/.test(dirPath) ? dirPath.slice(0, -1) : dirPath;
  const out = new Map<string, number>();
  for (const e of store.entries) {
    const sep = lastSeparator(e.path);
    if (sep < 0) continue;
    const parent = e.path.slice(0, sep);
    if (parent !== normalized) continue;
    out.set(e.path.slice(sep + 1), frecencyScore(e, nowMs));
  }
  return out;
}
