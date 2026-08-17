/**
 * session/history-store.ts — the `/recall` session-history store.
 *
 * Records one line per interactive session under ~/.prometheus/sessions/index.jsonl:
 * a session id, a timestamp, the cwd, and a short DESCRIPTOR — the first 15 words of the
 * first prompt given, hard-chunked — so `/recall` can show a picker of past sessions with a
 * recognizable one-line summary. Pure descriptor/format helpers + fail-soft fs (a read-only
 * home just means no history, never a crash).
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface SessionRecord {
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** the first 15 words of the opening prompt (hard-chunked). */
  descriptor: string;
  cwd: string;
  /**
   * How the session was run. Absent ⇒ interactive, so every index line written before this
   * field existed stays valid.
   *
   * Headless runs are recorded — a CI run that cannot be audited or resumed is the one that
   * most needs to be — but they are kept OUT of the `/recall` picker, which a thousand
   * `prometheus -p` invocations would otherwise bury.
   */
  kind?: "headless";
}

/** First 15 words of a prompt, hard-chunked + whitespace-collapsed (the `/recall` summary). */
export function descriptorOf(prompt: string, words = 15): string {
  const toks = prompt.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (toks.length === 0) return "(empty prompt)";
  const head = toks.slice(0, words).join(" ");
  return toks.length > words ? `${head}…` : head;
}

function indexPath(home: string): string {
  return join(home, "sessions", "index.jsonl");
}

/** Append a session record (best-effort; a write failure is swallowed). */
export function recordSession(home: string, rec: SessionRecord): void {
  try {
    mkdirSync(join(home, "sessions"), { recursive: true });
    appendFileSync(indexPath(home), `${JSON.stringify(rec)}\n`);
  } catch {
    /* a read-only home just means no recall history */
  }
}

/**
 * Sessions a human started, for the `/recall` picker.
 *
 * A separate FILTER rather than a filtering `listSessions`: `deleteSession` rewrites
 * index.jsonl from `listSessions(home, 100000)`, so hiding records inside the reader would
 * silently erase every headless record on the next delete.
 */
export function interactiveSessions(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((r) => r.kind !== "headless");
}

/** All recorded sessions, NEWEST FIRST. Unreadable/garbage lines are skipped. */
export function listSessions(home: string, limit = 50): SessionRecord[] {
  let text: string;
  try {
    text = readFileSync(indexPath(home), "utf8");
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s) as SessionRecord;
      if (r && typeof r.id === "string") out.push(r);
    } catch {
      /* skip a corrupt line */
    }
  }
  return out.reverse().slice(0, limit);
}

/* ── per-session TURN transcripts (CLI-012) ───────────────────────────────── *
 * A separate `<home>/sessions/<id>.jsonl` per session (index.jsonl stays metadata-
 * only + byte-frozen for /recall). Append-only, one event per line, fail-soft.
 * ─────────────────────────────────────────────────────────────────────────── */

/** One persisted transcript line: a user/assistant/tool event with an ISO `ts`. */
export type TurnLine = Record<string, unknown> & { ts?: string };

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
// Windows silently strips trailing dot/space and reserves these device names; an
// ALLOWLIST (not blocklist) is the only safe guard against `..`, NUL, CON, etc.
const RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "LPT1",
  "LPT2",
  "LPT3",
]);

/** Validate a sessionId as a safe FILENAME (allowlist); null if it could escape. */
export function safeSessionId(id: string): string | null {
  if (!SAFE_ID.test(id)) return null;
  if (RESERVED.has(id.toUpperCase())) return null;
  return id;
}

function sessionsDir(home: string): string {
  return join(home, "sessions");
}
function sessionFile(home: string, id: string): string {
  return join(sessionsDir(home), `${id}.jsonl`);
}

/**
 * Append transcript events for a session (best-effort, fail-soft). Each event is
 * written as ONE `JSON.stringify(...)+"\n"` in a single appendFileSync call (POSIX
 * O_APPEND is atomic only up to PIPE_BUF, so never split a line across writes).
 */
export function appendTurnEvents(
  home: string,
  sessionId: string,
  events: readonly TurnLine[],
  now: () => string = () => new Date().toISOString(),
): void {
  const id = safeSessionId(sessionId);
  if (!id || events.length === 0) return;
  try {
    mkdirSync(sessionsDir(home), { recursive: true });
    const file = sessionFile(home, id);
    for (const ev of events) {
      appendFileSync(file, `${JSON.stringify({ ts: now(), ...ev })}\n`);
    }
  } catch {
    /* read-only / full disk → no transcript, never a crash (mirrors recordSession) */
  }
}

/* ── CLI-082: structured transcript export ─────────────────────────────────────── */

/** One exported turn (a user message, or an assistant turn with its tool activity). */
export interface ExportTurn {
  role: string;
  text: string;
  /** ISO-8601 UTC timestamp (from the persisted turn's `ts`), when known. */
  at?: string;
  /** tool calls the assistant made this turn (name + args), when any. */
  toolCalls?: Array<{ name: string; args?: unknown }>;
  /** nemesis gate verdicts recorded this turn, when any. */
  verdict?: Array<{ tool: string; verdict: string; riskScore?: number }>;
}

/** The structured export document (`{sessionId, exportedAt, turns}`). */
export interface SessionExportDoc {
  sessionId: string;
  exportedAt: string;
  turns: ExportTurn[];
}

/**
 * CLI-082: project CLI-012's persisted per-turn JSONL (already-serialized plain data — no live
 * object graph, so JSON.stringify can't hit a circular ref) into a structured export document.
 * A user line becomes its own turn; a run of AgentEvents collapses into ONE assistant turn whose
 * `text` is the concatenated text deltas, with tool calls + verdicts folded in. PURE; timestamps
 * are each event's own ISO `ts`. An empty session yields `turns: []` (never `[null]` / a crash).
 */
export function buildSessionExport(
  sessionId: string,
  turns: readonly TurnLine[],
  exportedAt: string,
): SessionExportDoc {
  const out: ExportTurn[] = [];
  let asst: ExportTurn | null = null;
  const flush = (): void => {
    if (asst) {
      out.push(asst);
      asst = null;
    }
  };
  for (const t of turns) {
    const at = typeof t.ts === "string" ? t.ts : undefined;
    if (t.role === "user") {
      flush();
      out.push({ role: "user", text: String(t.text ?? ""), ...(at ? { at } : {}) });
      continue;
    }
    const kind = String((t as { kind?: unknown }).kind ?? "");
    if (!asst) asst = { role: "assistant", text: "", ...(at ? { at } : {}) };
    if (kind === "text") {
      asst.text += String(t.text ?? "");
    } else if (kind === "tool_use") {
      const call = (t as { call?: { name?: unknown; args?: unknown } }).call;
      asst.toolCalls ??= [];
      asst.toolCalls.push({
        name: String(call?.name ?? ""),
        ...(call && "args" in call ? { args: call.args } : {}),
      });
    } else if (kind === "verdict") {
      const r = t as { tool?: unknown; verdict?: unknown; riskScore?: unknown };
      asst.verdict ??= [];
      asst.verdict.push({
        tool: String(r.tool ?? ""),
        verdict: String(r.verdict ?? ""),
        ...(typeof r.riskScore === "number" ? { riskScore: r.riskScore } : {}),
      });
    }
    // tool_result / blocked / done carry no export-shape text of their own (the result summary
    // already rode into the assistant transcript upstream); intentionally not folded here.
  }
  flush();
  return { sessionId, exportedAt, turns: out };
}

/** Load a session's ordered transcript events; missing file → []; corrupt lines skipped. */
export function loadTurns(home: string, sessionId: string): TurnLine[] {
  const id = safeSessionId(sessionId);
  if (!id) return [];
  let text: string;
  try {
    text = readFileSync(sessionFile(home, id), "utf8");
  } catch {
    return [];
  }
  const out: TurnLine[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === "object" && !Array.isArray(o)) out.push(o as TurnLine);
    } catch {
      /* skip a corrupt / truncated (crash-mid-write) line, keep the rest */
    }
  }
  return out;
}

/* ── per-session token accounting (CLI-029) ──────────────────────────────────── */

/** One completed turn's token accounting — the single source of truth for cost surfaces. */
export interface AccountingRecord {
  model: string;
  endpointId: string;
  promptTokens: number;
  completionTokens: number;
  /** true when the counts are a chars/4 estimate (server sent no usage) — a spend FLOOR. */
  estimated: boolean;
  /** ISO timestamp of the turn. */
  atIso: string;
  /**
   * Prompt-cache tokens for this turn (CLI-090), normalized across providers. OPTIONAL — absent
   * when the provider's usage payload carried no cache field (unmeasurable), so the report can say
   * "not available for this provider" instead of a misleading 0. A present `0` = measured, no hit.
   */
  cacheRead?: number;
  cacheCreate?: number;
}

function acctFile(home: string, id: string): string {
  return join(sessionsDir(home), `${id}.acct.jsonl`);
}

/**
 * Append one turn's accounting record (best-effort, fail-soft; own file per session so it
 * never mixes with the transcript). One `JSON.stringify+"\n"` per append — a mid-stream
 * crash leaves a readable (possibly short) log, never a corrupt whole-array rewrite.
 */
export function appendAccounting(home: string, sessionId: string, rec: AccountingRecord): void {
  const id = safeSessionId(sessionId);
  if (!id) return;
  try {
    mkdirSync(sessionsDir(home), { recursive: true });
    appendFileSync(acctFile(home, id), `${JSON.stringify(rec)}\n`);
  } catch {
    /* read-only / full disk → no accounting, never a crash (mirrors appendTurnEvents) */
  }
}

/**
 * Read one accounting file, distinguishing ABSENT from UNREADABLE.
 *
 * The difference is the whole point. `checkBudgetGate` documents itself as failing closed on an
 * unreadable store — but with a reader that swallows every error and returns `[]`, an unreadable
 * or deleted file read as "$0 spent", so the cap silently stopped enforcing. That is a cap
 * BYPASS wearing the costume of a safe default: `rm` the file and the ceiling is gone.
 *
 * A missing file is the normal first run and yields `[]`. Anything else — EACCES, EISDIR, an I/O
 * error — THROWS, so the caller that promised to fail closed can keep that promise.
 */
function readAcctFile(path: string): AccountingRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // never written yet
    throw e;
  }
  return parseAcctLines(text);
}

/**
 * Every accounting record from TODAY, across every session in this home.
 *
 * `daily_usd` was a session cap wearing a different name: the gate read only the CURRENT
 * session's file, and a fresh sessionId is minted on every launch, so the "daily" window reset
 * to $0 on restart and a user could spend N x the daily cap by quitting and reopening. The day
 * filter itself lives in `evaluateBudgets`; this supplies the records it needs to filter.
 *
 * Cost is bounded by mtime: a session file whose last write was before local midnight cannot
 * contain a record from today, so it is never opened. Fail-soft per file — one unreadable
 * session's history must not make the whole store unreadable — but see `readAccounting` for the
 * current session, where unreadable IS fatal.
 */
export function readAccountingSince(home: string, sinceMs: number): AccountingRecord[] {
  const dir = sessionsDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no sessions dir yet — nothing has ever been spent
  }
  const out: AccountingRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".acct.jsonl")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < sinceMs) continue; // cannot hold a record from today
      out.push(...parseAcctLines(readFileSync(path, "utf8")));
    } catch {
      /* a single unreadable/vanished session file is skipped, not fatal for the whole window */
    }
  }
  return out;
}

/** Load a session's accounting records in order; missing file → []; corrupt lines skipped. */
export function readAccounting(home: string, sessionId: string): AccountingRecord[] {
  const id = safeSessionId(sessionId);
  if (!id) return [];
  return readAcctFile(acctFile(home, id));
}

/** Parse accounting JSONL: one record per line, corrupt lines skipped, order preserved. */
function parseAcctLines(text: string): AccountingRecord[] {
  const out: AccountingRecord[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as Partial<AccountingRecord>;
      if (
        o &&
        typeof o.model === "string" &&
        typeof o.promptTokens === "number" &&
        typeof o.completionTokens === "number"
      ) {
        out.push({
          model: o.model,
          endpointId: typeof o.endpointId === "string" ? o.endpointId : "",
          promptTokens: o.promptTokens,
          completionTokens: o.completionTokens,
          estimated: o.estimated === true,
          atIso: typeof o.atIso === "string" ? o.atIso : "",
          // cache counters (CLI-090) — only carried when the persisted record had them (a finite
          // number); absent field stays undefined so "unmeasurable" ≠ "measured 0".
          ...(typeof o.cacheRead === "number" && Number.isFinite(o.cacheRead)
            ? { cacheRead: o.cacheRead }
            : {}),
          ...(typeof o.cacheCreate === "number" && Number.isFinite(o.cacheCreate)
            ? { cacheCreate: o.cacheCreate }
            : {}),
        });
      }
    } catch {
      /* skip a corrupt / truncated line, keep the rest */
    }
  }
  return out;
}

/**
 * The most-recently-written session's id by `*.acct.jsonl` mtime (CLI-090), or null when no
 * session has any accounting yet. `prometheus tokens report` reads exactly THIS ONE session so the
 * report is per-session (each REPL run writes a fresh acct file) — never a cross-session sum.
 * Fail-soft: an unreadable dir ⇒ null.
 */
export function latestAccountingSession(home: string): string | null {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(home));
  } catch {
    return null;
  }
  let bestId: string | null = null;
  let bestMtime = -1;
  for (const name of names) {
    if (!name.endsWith(".acct.jsonl")) continue;
    const id = name.slice(0, -".acct.jsonl".length);
    if (!safeSessionId(id)) continue;
    let mtime: number;
    try {
      mtime = statSync(join(sessionsDir(home), name)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestId = id;
    }
  }
  return bestId;
}

export interface AccountingBucket {
  promptTokens: number;
  completionTokens: number;
  turns: number;
  /** true when ANY record in the bucket was estimated (the total is a floor). */
  estimated: boolean;
}

export interface AccountingTotals {
  byModel: Record<string, AccountingBucket>;
  byDay: Record<string, AccountingBucket>;
  total: AccountingBucket;
}

/** Aggregate accounting records into per-model, per-day, and grand totals (pure). */
export function aggregateAccounting(records: readonly AccountingRecord[]): AccountingTotals {
  const empty = (): AccountingBucket => ({
    promptTokens: 0,
    completionTokens: 0,
    turns: 0,
    estimated: false,
  });
  const add = (b: AccountingBucket, r: AccountingRecord): void => {
    b.promptTokens += r.promptTokens;
    b.completionTokens += r.completionTokens;
    b.turns += 1;
    if (r.estimated) b.estimated = true;
  };
  const byModel: Record<string, AccountingBucket> = {};
  const byDay: Record<string, AccountingBucket> = {};
  const total = empty();
  for (const r of records) {
    const mb = byModel[r.model] ?? empty();
    byModel[r.model] = mb;
    add(mb, r);
    const day = r.atIso.slice(0, 10) || "unknown";
    const db = byDay[day] ?? empty();
    byDay[day] = db;
    add(db, r);
    add(total, r);
  }
  return { byModel, byDay, total };
}

export interface RotateOptions {
  /** total-bytes cap over the per-session transcript files. */
  maxBytes: number;
  /** the live session — never deleted (unlinking mid-append loses data/EBUSY). */
  liveId?: string;
  /** injected dir listing / stat / remove for tests. */
  listDir?: (dir: string) => string[];
  statFn?: (path: string) => { size: number; mtimeMs: number };
  rmFn?: (path: string) => void;
  /** injected clock, so the age policy is testable without touching mtimes. */
  now?: number;
  /** override the 30-day age policy (tests). */
  maxAgeMs?: number;
  /** override the index record cap (tests). */
  maxIndexRecords?: number;
  /** injected index writer (tests). */
  writeFn?: (path: string, body: string) => void;
}

/** Total-bytes cap over the whole session store — transcripts AND accounting. */
export const SESSION_STORE_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB
/** A session untouched this long is pruned even when the store is under the byte cap. */
export const SESSION_STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Hard cap on index.jsonl records — `/recall` and `sessions list` read the file whole. */
export const SESSION_INDEX_MAX_RECORDS = 1000;

const ACCT_SUFFIX = ".acct.jsonl";

/** Every file the store owns for one session. A new artifact added HERE reaches all three arms. */
function sessionArtifactPaths(home: string, id: string): string[] {
  return [sessionFile(home, id), acctFile(home, id)];
}

/** The session a store filename belongs to, or null when it is not session-owned. */
export function sessionIdOfFile(name: string): { id: string; kind: "transcript" | "acct" } | null {
  if (name === "index.jsonl" || !name.endsWith(".jsonl")) return null;
  const acct = name.endsWith(ACCT_SUFFIX);
  const id = name.slice(0, -(acct ? ACCT_SUFFIX.length : ".jsonl".length));
  return safeSessionId(id) ? { id, kind: acct ? "acct" : "transcript" } : null;
}

/** Local midnight — the floor `checkBudgetGate` measures the daily spend cap against. */
export function startOfLocalDayMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Apply the session-store RETENTION POLICY. (Named `rotateSessions` for its callers.)
 *
 * It used to rotate transcripts only, and deliberately filtered `*.acct.jsonl` OUT — the
 * reasoning being that accounting files are tiny and that including them would let rotation
 * delete the live session's accounting. The first half was an assumption and the second is a
 * bug in the live-guard, not a reason to exempt a whole class of file. So accounting was
 * completely unbounded, and worst exactly where it grows fastest: every `prometheus -p` mints
 * a fresh session id, writes an `<id>.acct.jsonl`, records no index entry — so
 * `sessions delete` can never reach it — and never rotated at all. One file leaked per CI run,
 * forever. `index.jsonl` had the mirror problem: pruned only by an explicit delete, so it grew
 * a line per launch and `/recall` offered sessions whose transcripts rotation had already
 * removed.
 *
 * THE POLICY, in one place:
 *   - the unit of retention is a SESSION — all files named `<id>.*` — never a lone file;
 *   - a session is pruned when it is older than `maxAgeMs`, or when the store exceeds
 *     `maxBytes` and it is among the oldest;
 *   - NEVER pruned: `index.jsonl`; any file of the LIVE session; and any `*.acct.jsonl`
 *     written at or after the current budget floor (local midnight) — that file IS the
 *     evidence `checkBudgetGate` reads for the daily cap, so deleting it would silently
 *     re-open the spend limit;
 *   - `index.jsonl` is pruned in the same pass: records for fully-pruned sessions are dropped
 *     and the file is capped at `SESSION_INDEX_MAX_RECORDS`, newest kept.
 */
export function rotateSessions(home: string, opts: RotateOptions): void {
  const dir = sessionsDir(home);
  const list = opts.listDir ?? ((d: string) => readdirSync(d));
  const stat = opts.statFn ?? ((p: string) => statSync(p));
  const rm = opts.rmFn ?? ((p: string) => rmSync(p));
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? SESSION_STORE_MAX_AGE_MS;
  const dayFloor = startOfLocalDayMs(now);
  let names: string[];
  try {
    names = list(dir);
  } catch {
    return;
  }

  /** Every session in the store, with its total size and most recent mtime. */
  const sessions = new Map<
    string,
    { size: number; mtimeMs: number; protectedAcct: boolean; files: string[] }
  >();
  for (const name of names) {
    const owned = sessionIdOfFile(name);
    if (!owned) continue;
    let st: { size: number; mtimeMs: number };
    try {
      st = stat(join(dir, name));
    } catch {
      continue;
    }
    const cur = sessions.get(owned.id) ?? {
      size: 0,
      mtimeMs: 0,
      protectedAcct: false,
      files: [],
    };
    cur.size += st.size;
    cur.mtimeMs = Math.max(cur.mtimeMs, st.mtimeMs);
    // Today's accounting is the daily cap's evidence — pruning it re-opens the cap. The
    // protection is on the FILE, not the session: the transcript is the bulk and can still go.
    if (owned.kind === "acct" && st.mtimeMs >= dayFloor) cur.protectedAcct = true;
    else cur.files.push(name);
    sessions.set(owned.id, cur);
  }

  const prunable = [...sessions.entries()]
    .filter(([id, s]) => id !== opts.liveId && s.files.length > 0)
    .sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);

  const pruned = new Set<string>();
  // Only files the listing actually reported are removed — a session is a set of artifacts,
  // but there is no reason to issue an unlink for one that is not there.
  const drop = (id: string): void => {
    for (const name of sessions.get(id)?.files ?? []) {
      try {
        rm(join(dir, name));
      } catch {
        /* already gone, or un-removable — keep going */
      }
    }
    // A session whose ONLY remaining artifact was protected is not fully gone, so its index
    // record stays — `/recall` would otherwise stop offering a session that still has data.
    if (!sessions.get(id)?.protectedAcct) pruned.add(id);
  };

  // Age first: an old session is pruned whatever the store's total size.
  for (const [id, s] of prunable) {
    if (now - s.mtimeMs > maxAgeMs) drop(id);
  }

  // Then size, oldest-first, over what survived.
  let total = [...sessions.entries()]
    .filter(([id]) => !pruned.has(id))
    .reduce((a, [, s]) => a + s.size, 0);
  for (const [id, s] of prunable) {
    if (total <= opts.maxBytes) break;
    if (pruned.has(id)) continue;
    drop(id);
    total -= s.size;
  }

  pruneIndex(home, pruned, opts);
}

/** Drop index records for pruned sessions and cap the file's length. Best-effort. */
function pruneIndex(home: string, pruned: ReadonlySet<string>, opts: RotateOptions): void {
  const max = opts.maxIndexRecords ?? SESSION_INDEX_MAX_RECORDS;
  try {
    const all = listSessions(home, 1_000_000);
    const kept = all.filter((r) => !pruned.has(r.id)).slice(0, max);
    if (kept.length === all.length) return; // nothing to do — do not rewrite for nothing
    const write = opts.writeFn ?? ((p: string, body: string) => writeFileSync(p, body));
    write(
      indexPath(home),
      kept.length
        ? `${kept
            .map((r) => JSON.stringify(r))
            .reverse()
            .join("\n")}\n`
        : "",
    );
  } catch {
    /* read-only home — the transcripts are still gone, which is the load-bearing half */
  }
}

/* ── session browser: resolve / search / fork / delete (CLI-014) ───────────── */

/** Resolve a short-id or full-id (prefix) to a single session id; error on 0 or ≥2. */
export function resolveSessionId(home: string, needle: string): { id: string } | { error: string } {
  const ids = listSessions(home, 100000).map((r) => r.id);
  // exact full-id match wins (so a full id that also prefixes another still resolves).
  if (ids.includes(needle)) return { id: needle };
  const matches = [...new Set(ids.filter((id) => id.startsWith(needle)))];
  if (matches.length === 0) return { error: `no session matching "${needle}"` };
  if (matches.length > 1) {
    return { error: `ambiguous "${needle}" → ${matches.map((i) => i.slice(0, 8)).join(", ")}` };
  }
  return { id: matches[0] as string };
}

const SEARCH_KEYS = new Set(["text", "summary", "reason"]);

/** Sessions whose descriptor OR transcript text contains `query` (case-insensitive). */
export function searchSessions(home: string, query: string): SessionRecord[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: SessionRecord[] = [];
  for (const r of listSessions(home, 100000)) {
    if (r.descriptor.toLowerCase().includes(q)) {
      out.push(r);
      continue;
    }
    // short-circuit on the first matching turn's content field.
    const hit = loadTurns(home, r.id).some((t) =>
      Object.entries(t).some(
        ([k, v]) => SEARCH_KEYS.has(k) && typeof v === "string" && v.toLowerCase().includes(q),
      ),
    );
    if (hit) out.push(r);
  }
  return out;
}

/** Copy a session's transcript + a fresh index record under a NEW id (independent copy). */
export function forkSession(
  home: string,
  needle: string,
  mkId: () => string = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  now: () => string = () => new Date().toISOString(),
): { newId: string } | { error: string } {
  const r = resolveSessionId(home, needle);
  if ("error" in r) return r;
  const rec = listSessions(home, 100000).find((x) => x.id === r.id);
  if (!rec) return { error: `no such session: ${needle}` };
  const newId = mkId();
  try {
    mkdirSync(sessionsDir(home), { recursive: true });
    // read+write (NOT hardlink) so appending to the fork never mutates the source.
    let body = "";
    try {
      body = readFileSync(sessionFile(home, r.id), "utf8");
    } catch {
      body = "";
    }
    writeFileSync(sessionFile(home, newId), body);
    recordSession(home, { ...rec, id: newId, ts: now() });
    return { newId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete a session: remove its transcript file + its index.jsonl record. Best-effort. */
export function deleteSession(home: string, id: string): boolean {
  const clean = safeSessionId(id);
  if (!clean) return false;
  let removed = false;
  // EXPLICIT delete is user intent: it removes everything the store owns for this session.
  // It used to unlink only `<id>.jsonl`, so the accounting file survived — and kept ranking in
  // `latestAccountingSession`, so `prometheus tokens report` still reported a session the user
  // had deleted.
  for (const path of sessionArtifactPaths(home, clean)) {
    try {
      rmSync(path);
      removed = true;
    } catch {
      /* no such artifact (a metadata-only session) — still prune the index below */
    }
  }
  try {
    // rewrite index.jsonl WITHOUT the record (oldest-first append order restored).
    const kept = listSessions(home, 100000)
      .filter((r) => r.id !== clean)
      .reverse();
    writeFileSync(
      indexPath(home),
      kept.length ? `${kept.map((r) => JSON.stringify(r)).join("\n")}\n` : "",
    );
    removed = true;
  } catch {
    /* read-only home — nothing to prune */
  }
  return removed;
}

/** Render the picker list: "  N) <id>  <ts>  — <descriptor>". Pure (caller colors it). */
export function formatPicker(records: readonly SessionRecord[]): string {
  if (records.length === 0) return "No past sessions recorded yet.";
  const lines = ["Recall a session:"];
  records.forEach((r, i) => {
    const when = r.ts.replace("T", " ").slice(0, 16);
    lines.push(`  ${String(i + 1).padStart(2)}) ${r.id.slice(0, 8)}  ${when}  — ${r.descriptor}`);
  });
  lines.push("Pick a number (or Enter to cancel).");
  return lines.join("\n");
}
