/**
 * ide/state/debug-inspect.ts — PURE inspection math for the DebugPanel (APP-030).
 *
 * Everything the watches / Evaluate-expression / variables-tree features need that
 * is NOT React lives here so it is node:test-able with a fake dapRequest: guarded
 * DAP body parsing (adapters return partial bodies — the app's #1 crash class),
 * the per-stop lazy-children cache (a `variablesReference` is only valid until the
 * next `stopped`; adapters recycle ids, so the WHOLE cache drops on stop/frame
 * switch), fetch-once semantics (in-flight dedup — `variables` fires at most once
 * per node per stop), watch evaluation with per-expression error isolation, and
 * the frame-scoped `evaluate` argument builder (frameId omitted when null — some
 * adapters reject `frameId: undefined`).
 *
 * Renderer-SANDBOXED (C5): types + Map/Set only; the IPC fn is INJECTED.
 */

/** The generic `ide.dapRequest` surface this module consumes (injected). */
export type DapRequestFn = (
  command: string,
  args?: unknown,
) => Promise<{ ok: boolean; body?: unknown; error?: string }>;

/** One DAP variable row (a node of the tree; ref > 0 ⇒ expandable). */
export interface DapVar {
  name: string;
  value: string;
  type: string | null;
  variablesReference: number;
}

/** One DAP scope (a collapsed tree root; `expensive` scopes stay collapsed). */
export interface DapScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

/** Cycles/depth stay bounded: nesting deeper than this renders as a leaf. */
export const MAX_EXPAND_DEPTH = 8;

/** One DAP thread row. DAP carries NO per-thread state — stopped/running is
 *  inferred locally from `stopped`/`continued` events (applyStopped/-Continued). */
export interface DapThread {
  id: number;
  name: string;
}

/** Guarded `threads` body parse — partial/absent bodies degrade to []. */
export function parseThreads(body: unknown): DapThread[] {
  const rows = (body as { threads?: unknown[] })?.threads;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({ id: Number(t.id ?? 0), name: String(t.name ?? `thread ${t.id ?? "?"}`) }));
}

/** One call-stack frame. `path` is null when the adapter sent no usable
 *  `source.path` (in-memory frame with only a sourceReference) — such a frame
 *  must NOT navigate; it still selects for scopes/variables via its id. */
export interface DapFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  path: string | null;
}

/** Guarded `stackTrace` body parse, keeping source.path + column (1-based, as
 *  debugpy/Monaco both speak — never blindly re-based). */
export function parseFrames(body: unknown): DapFrame[] {
  const rows = (body as { stackFrames?: unknown[] })?.stackFrames;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => {
      const source = (f.source ?? {}) as Record<string, unknown>;
      const path = typeof source.path === "string" && source.path !== "" ? source.path : null;
      return {
        id: Number(f.id ?? 0),
        name: String(f.name ?? "?"),
        line: Number(f.line ?? 0),
        column: Number(f.column ?? 1),
        path,
      };
    });
}

/** Fold a `stopped` event into the locally tracked stopped-thread set:
 *  `allThreadsStopped:true` marks every known id; `threadId` is OPTIONAL. */
export function applyStopped(
  prev: ReadonlySet<number>,
  body: unknown,
  allIds: readonly number[],
): Set<number> {
  const b = (body ?? {}) as { threadId?: unknown; allThreadsStopped?: unknown };
  const next = new Set(prev);
  if (b.allThreadsStopped === true) for (const id of allIds) next.add(id);
  if (typeof b.threadId === "number") next.add(b.threadId);
  return next;
}

/** Fold a `continued` event: `allThreadsContinued` DEFAULTS TO TRUE when omitted
 *  (everything clears); only an explicit false is a single-thread resume. */
export function applyContinued(prev: ReadonlySet<number>, body: unknown): Set<number> {
  const b = (body ?? {}) as { threadId?: unknown; allThreadsContinued?: unknown };
  if (b.allThreadsContinued !== false) return new Set();
  const next = new Set(prev);
  if (typeof b.threadId === "number") next.delete(b.threadId);
  return next;
}

/** The stop's context thread: the event's threadId when present (it is optional —
 *  an allThreadsStopped stop may omit it), else the first known thread. */
export function pickStoppedThread(body: unknown, threads: readonly DapThread[]): number | null {
  const tid = (body as { threadId?: unknown })?.threadId;
  if (typeof tid === "number") return tid;
  return threads[0]?.id ?? null;
}

/** Guarded `scopes` body parse — partial/absent bodies degrade to []. */
export function parseScopes(body: unknown): DapScope[] {
  const rows = (body as { scopes?: unknown[] })?.scopes;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      name: String(s.name ?? "?"),
      variablesReference: Number(s.variablesReference ?? 0),
      expensive: s.expensive === true,
    }));
}

/** Guarded `variables` body parse — partial/absent bodies degrade to []. */
export function parseVariables(body: unknown): DapVar[] {
  const rows = (body as { variables?: unknown[] })?.variables;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => ({
      name: String(v.name ?? ""),
      value: String(v.value ?? ""),
      type: typeof v.type === "string" ? v.type : null,
      variablesReference: Number(v.variablesReference ?? 0),
    }));
}

/** The coerced `setVariable` response (APP-080): the adapter-ECHOED new value + type,
 *  and the (possibly new) variablesReference. A `variablesReference` > 0 means the new
 *  value is itself expandable and REPLACES the old child ref — refresh from THIS, never
 *  a blind scope re-fetch, or a struct edit desyncs the tree. `null` fields ⇒ the
 *  adapter omitted them (leave the row's prior value/type/ref untouched). */
export interface SetVariableResult {
  value: string | null;
  type: string | null;
  variablesReference: number | null;
}

/** Guarded parse of a `setVariable` response body (partial/absent bodies degrade to nulls). */
export function parseSetVariableResult(body: unknown): SetVariableResult {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    value: typeof b.value === "string" ? b.value : null,
    type: typeof b.type === "string" ? b.type : null,
    variablesReference: typeof b.variablesReference === "number" ? b.variablesReference : null,
  };
}

/**
 * The per-stop children cache. A NEW cache is created on every `stopped` and on
 * every frame switch (`stopSeq` identifies it) — variablesReference ids from an
 * older stop silently resolve to wrong/empty children, so nothing survives.
 */
export interface VarCache {
  readonly stopSeq: number;
  /** ref → fetched children (settled). */
  readonly children: Map<number, DapVar[]>;
  /** ref → in-flight fetch (dedup: concurrent expands share ONE request). */
  readonly inflight: Map<number, Promise<DapVar[]>>;
}

export function freshCache(stopSeq: number): VarCache {
  return { stopSeq, children: new Map(), inflight: new Map() };
}

/**
 * Lazily fetch a node's children EXACTLY ONCE per cache: settled results and
 * in-flight requests are both reused; ref 0 (a leaf) never issues a request.
 * A failed request resolves to [] and is cached (no retry storm on a dead ref).
 */
export function fetchChildren(
  cache: VarCache,
  request: DapRequestFn,
  ref: number,
): Promise<DapVar[]> {
  if (ref <= 0) return Promise.resolve([]);
  const settled = cache.children.get(ref);
  if (settled !== undefined) return Promise.resolve(settled);
  const inflight = cache.inflight.get(ref);
  if (inflight !== undefined) return inflight;
  const p = request("variables", { variablesReference: ref })
    .then((r) => (r.ok ? parseVariables(r.body) : []))
    .catch(() => [] as DapVar[])
    .then((vars) => {
      cache.children.set(ref, vars);
      cache.inflight.delete(ref);
      return vars;
    });
  cache.inflight.set(ref, p);
  return p;
}

/** True when a node may expand: a real reference, within the depth bound, and
 *  not already an ancestor (cyclic object graphs re-use references). */
export function expandable(ref: number, depth: number, ancestorRefs: readonly number[]): boolean {
  return ref > 0 && depth < MAX_EXPAND_DEPTH && !ancestorRefs.includes(ref);
}

/** `evaluate` args with frameId OMITTED when null — never `frameId: undefined`. */
export function buildEvalArgs(
  expression: string,
  frameId: number | null,
  context: "watch" | "repl",
): Record<string, unknown> {
  return { expression, context, ...(frameId !== null ? { frameId } : {}) };
}

/** One evaluated watch row: the printable result or the inline error string. */
export interface WatchResult {
  value: string;
  error: boolean;
  /** > 0 ⇒ the result itself expands through the variables tree. */
  variablesReference: number;
}

function toWatchResult(r: { ok: boolean; body?: unknown; error?: string }): WatchResult {
  const body = r.body as { result?: unknown; variablesReference?: unknown } | undefined;
  if (r.ok && body?.result !== undefined) {
    return {
      value: String(body.result),
      error: false,
      variablesReference: Number(body.variablesReference ?? 0),
    };
  }
  return { value: r.error ?? "not available", error: true, variablesReference: 0 };
}

/**
 * Evaluate every watch against the SELECTED frame (`context:"watch"` — side-effect
 * free, re-run each stop). Sequential, and a failing/throwing expression records
 * its error inline WITHOUT aborting the siblings.
 */
export async function evalWatches(
  request: DapRequestFn,
  exprs: readonly string[],
  frameId: number | null,
): Promise<Record<string, WatchResult>> {
  const out: Record<string, WatchResult> = {};
  for (const expr of exprs) {
    try {
      out[expr] = toWatchResult(await request("evaluate", buildEvalArgs(expr, frameId, "watch")));
    } catch (e) {
      out[expr] = {
        value: e instanceof Error ? e.message : "evaluate failed",
        error: true,
        variablesReference: 0,
      };
    }
  }
  return out;
}

/** One-shot Evaluate box (`context:"repl"` — statements/side effects allowed). */
export async function evalExpression(
  request: DapRequestFn,
  expr: string,
  frameId: number | null,
): Promise<WatchResult> {
  try {
    return toWatchResult(await request("evaluate", buildEvalArgs(expr, frameId, "repl")));
  } catch (e) {
    return {
      value: e instanceof Error ? e.message : "evaluate failed",
      error: true,
      variablesReference: 0,
    };
  }
}
