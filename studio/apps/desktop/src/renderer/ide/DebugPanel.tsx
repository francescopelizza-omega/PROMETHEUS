/**
 * ide/DebugPanel.tsx — the debugging surface over DAP (file 07 §5).
 *
 * Breakpoints / call stack / variables / watch, driven over window.prometheus.ide.dap*
 * (the DAP adapter is a child process in MAIN — debugpy/js-debug; the renderer never
 * spawns it, C5). The FIRST Run/Debug of a workspace triggers the engine RUN-GATE
 * (§5.2): the launch routes through window.prometheus.ide.gate FIRST, and on warn/block
 * the file-03 VerdictSheet is shown — the editor never decides "safe" (C5). No debug
 * adapter is installed in this env, so a real session cannot run; the panel composes
 * the gate-before-launch flow correctly and surfaces the verdict, never faking a session.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the stores + window.prometheus.
 */

import { Button, Panel } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type {
  IdeDapCapabilities,
  IdeDapDetectAdapterResult,
  IdeDapLaunchPlan,
  IdeGateResult,
} from "../../shared/ipc-contract.js";
import { RunConfigEditor } from "./RunConfigEditor.js";
import {
  type Breakpoint,
  allBreakpoints,
  breakpointDetail,
  dapAffectedPaths,
  dapLaunchPlan,
  isConditional,
  isLogpoint,
  pathToFileUri,
  toDapSourceBreakpoints,
  useBreakpointStore,
} from "./state/breakpoint-store.js";
import {
  type DapFrame,
  type DapRequestFn,
  type DapScope,
  type DapThread,
  type DapVar,
  type VarCache,
  type WatchResult,
  applyContinued,
  applyStopped,
  evalExpression,
  evalWatches,
  expandable,
  fetchChildren,
  freshCache,
  parseFrames,
  parseScopes,
  parseSetVariableResult,
  parseThreads,
  pickStoppedThread,
} from "./state/debug-inspect.js";
import { useExceptionFilterStore } from "./state/exception-breakpoints.js";
import { detectLanguage } from "./state/lang-detect.js";
import {
  type ImportCandidate,
  type RunConfig,
  debugTypeAndPython,
  dedupeConfigsByName,
  mergeImportCandidates,
  parseJetBrainsRunConfig,
  parseLaunchJson,
  serializeLaunchJson,
} from "./state/run-config.js";
import { useRunSessionStore } from "./state/run-session-store.js";
import { useTabsStore } from "./state/stores.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** UX mirror of the host's loopback classifier (APP-080): decides whether an attach
 *  needs the typed-confirm sheet. Literal loopback only — a hostname is never resolved
 *  (that's the host's fail-closed security gate; this is only the "show the sheet?" hint). */
function isLoopbackHostUi(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

/** A launch request is a REMOTE attach when it dials a non-loopback `connect` host. */
function isRemoteAttachRequest(req: Record<string, unknown>): boolean {
  if (req.request !== "attach") return false;
  const c = req.connect as { host?: unknown } | undefined;
  return typeof c?.host === "string" && !isLoopbackHostUi(c.host);
}

/** Open a breakpoint's file (preview tab) and reveal its 1-based line — the same
 *  open+reveal path every navigating panel uses (the model swap is async; reveal
 *  after it settles, a re-click retries). */
function jumpToBreakpoint(bp: Breakpoint): void {
  const uri = pathToFileUri(bp.path);
  useTabsStore
    .getState()
    .open(uri, { name: basename(bp.path), languageId: detectLanguage(uri), preview: true });
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("ide:reveal-position", { detail: { line: bp.line, column: 1 } }),
    );
  }, 160);
}

/** Navigate the editor to a call-stack frame's source (APP-031). A frame without
 *  a usable source.path (in-memory / sourceReference-only) never navigates. */
function jumpToFrame(f: DapFrame): void {
  if (!f.path) return;
  const uri = pathToFileUri(f.path);
  useTabsStore
    .getState()
    .open(uri, { name: basename(f.path), languageId: detectLanguage(uri), preview: true });
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("ide:reveal-position", { detail: { line: f.line, column: f.column } }),
    );
  }, 160);
}

/** Publish/clear the editor's inline-value decorations (EditorPane listens). */
function publishInlineValues(
  detail: { uri: string; line: number; pairs: Array<{ name: string; value: string }> } | null,
): void {
  window.dispatchEvent(new CustomEvent("ide:inline-values", { detail: detail ?? { clear: true } }));
}

/**
 * Send the REPLACE-ALL DAP `setBreakpoints` for ONE source over the generic
 * dapRequest seam, then fold the adapter's verdicts back into the store
 * (verified flags + adjusted lines, correlated by index). Best-effort: a dead
 * adapter must not wedge the store — the next launch replays everything anyway.
 */
async function sendSetBreakpoints(sessionId: string, path: string): Promise<void> {
  const api = ide();
  if (!api) return;
  const bps = toDapSourceBreakpoints(useBreakpointStore.getState().byPath, path);
  try {
    const r = await api.dapRequest(sessionId, "setBreakpoints", {
      source: { path },
      breakpoints: bps,
    });
    if (r.ok) {
      const body = r.body as { breakpoints?: unknown[] } | undefined;
      useBreakpointStore.getState().applyDapResponse(
        path,
        bps.map((b) => b.line),
        body?.breakpoints ?? [],
      );
    }
  } catch {
    /* adapter gone / request timed out — breakpoints stay local */
  }
}

/* APP-012/079 DAP breakpoint sync — a MODULE-level singleton, deliberately OUTSIDE
 * the React lifecycle so gutter toggles reach every live session even while the
 * DebugPanel is unmounted (the user switched activity panels). Wired on the first
 * DebugPanel render, never unwired (one listener for the app's life).
 *
 * The LAUNCH-TIME config phase (initialized → setBreakpoints → configurationDone) is
 * NOT here: the HOST owns it (APP-079) — the renderer hands it the plan at launch and
 * the host sequences the strict ordering unraceably. This listener only (1) tracks
 * which sessions are live (so live edits target the right one), and (2) folds the
 * host's launch-time setBreakpoints responses back into the store (verified flags). */
let dapSyncWired = false;
/** live sessionId → the workspace root it initialized under (a later workspace
 *  switch restores a DIFFERENT project's breakpoints — those must never be sent
 *  to this session, which still debugs the old root's code). */
const liveDapSessions = new Map<string, string | null>();

function ensureBreakpointDapSync(): void {
  if (dapSyncWired) return;
  const api = ide();
  if (!api) return; // no bridge (headless tests) — retried on the next render
  dapSyncWired = true;

  api.onEvent((ev) => {
    if (ev.channel === "dap.setbreakpoints") {
      // the HOST's launch-time setBreakpoints response — fold verified flags +
      // adapter-adjusted lines back into the store (host-owned send, APP-079).
      useBreakpointStore.getState().applyDapResponse(ev.path, ev.sentLines, ev.breakpoints);
      return;
    }
    if (ev.channel === "dap.state") {
      // prune crashed/terminated sessions the event channel might not cover.
      const st = ev.status as { sessionId?: unknown; state?: unknown };
      if (
        typeof st.sessionId === "string" &&
        (st.state === "terminated" || st.state === "failed")
      ) {
        liveDapSessions.delete(st.sessionId);
      }
      return;
    }
    if (ev.channel !== "dap.event") return;
    if (ev.event === "terminated" || ev.event === "exited") {
      liveDapSessions.delete(ev.sessionId);
      return;
    }
    if (ev.event !== "initialized") return;
    // the host now sequences the config phase; the renderer only records the session
    // as live (keyed to its workspace root) so post-init edits target the right one.
    liveDapSessions.set(ev.sessionId, useTabsStore.getState().workspaceRoot);
  });

  // live sync: any store change resends the REPLACE-ALL setBreakpoints for each
  // affected source — including `[]` when a source empties out. Verified-flag
  // fold-backs don't surface as affected paths, so a response never re-triggers
  // a send (an adapter line-adjustment does, once, and converges).
  let prev = useBreakpointStore.getState().byPath;
  useBreakpointStore.subscribe((s) => {
    const affected = dapAffectedPaths(prev, s.byPath);
    prev = s.byPath;
    if (affected.length === 0 || liveDapSessions.size === 0) return;
    const root = useTabsStore.getState().workspaceRoot;
    for (const [sid, sessionRoot] of liveDapSessions) {
      if (sessionRoot !== root) continue; // another workspace's set — never cross-send
      for (const path of affected) void sendSetBreakpoints(sid, path);
    }
  });
}

/* ── the lazily expandable variables tree (APP-030) ──────────────────────────
 * One node = one DAP variable (or a scope root). Children are fetched via the
 * injected request fn AT MOST ONCE per node per stop: the per-stop VarCache
 * dedups settled + in-flight fetches, and the whole tree remounts (key =
 * cache.stopSeq) on stop/frame switch so no stale reference id survives. */
function TreeNode({
  label,
  value,
  typeStr,
  refId,
  depth,
  ancestors,
  parentRef,
  canSetVariable,
  request,
  cache,
}: {
  label: string;
  value: string;
  typeStr: string | null;
  refId: number;
  depth: number;
  ancestors: readonly number[];
  /** the CONTAINER's variablesReference (0 for a scope/evaluate root) — the target of
   *  `setVariable` for THIS row's name (APP-080). */
  parentRef: number;
  /** the adapter advertises supportsSetVariable (APP-080) — gates the inline editor. */
  canSetVariable: boolean;
  request: DapRequestFn;
  cache: VarCache;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<DapVar[] | null>(null);
  // the row's live value/type/ref: seeded from props, OVERWRITTEN from the setVariable
  // response so the tree shows the adapter-echoed value without a blind scope re-fetch.
  const [curValue, setCurValue] = useState(value);
  const [curType, setCurType] = useState(typeStr);
  const [curRef, setCurRef] = useState(refId);
  const [editing, setEditing] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const canExpand = expandable(curRef, depth, ancestors);
  // a settable row: a real variable inside a container on a supportsSetVariable adapter.
  // scope roots + the evaluate root (parentRef 0) are never editable.
  const editable = canSetVariable && parentRef > 0;
  const toggle = (): void => {
    if (!canExpand) return;
    const next = !open;
    setOpen(next);
    if (next && kids === null) {
      void fetchChildren(cache, request, curRef).then(setKids);
    }
  };
  const submitEdit = async (raw: string): Promise<void> => {
    const r = await request("setVariable", {
      variablesReference: parentRef,
      name: label,
      value: raw,
    });
    if (!r.ok) {
      // surface the adapter's DAP error verbatim; the row's value stays unchanged.
      setEditErr(r.error ?? "unable to set value");
      return;
    }
    const parsed = parseSetVariableResult(r.body);
    setEditing(false);
    setEditErr(null);
    if (parsed.value !== null) setCurValue(parsed.value);
    if (parsed.type !== null) setCurType(parsed.type);
    if (parsed.variablesReference !== null) {
      // the new value is a different container — drop the stale expansion + children.
      setCurRef(parsed.variablesReference);
      setKids(null);
      setOpen(false);
    }
  };
  const mono = { fontSize: "0.72rem", fontFamily: "var(--font-mono, monospace)" } as const;
  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      <div style={{ ...mono, display: "flex", gap: 4, alignItems: "center", padding: "1px 0" }}>
        <button
          type="button"
          onClick={toggle}
          disabled={!canExpand}
          aria-label={`variable ${label}`}
          aria-expanded={canExpand ? open : undefined}
          style={{
            ...mono,
            display: "flex",
            gap: 4,
            flex: "0 1 auto",
            minWidth: 0,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: canExpand ? "pointer" : "default",
            textAlign: "left",
            color: "var(--text-primary)",
          }}
        >
          <span style={{ width: 10, color: "var(--text-secondary)" }}>
            {canExpand ? (open ? "▾" : "▸") : ""}
          </span>
          <span style={{ color: "var(--accent)" }}>{label}</span>
        </button>
        {editing ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the inline value editor is user-invoked
            autoFocus
            defaultValue={curValue}
            aria-label={`set value of ${label}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitEdit((e.target as HTMLInputElement).value);
              else if (e.key === "Escape") {
                setEditing(false);
                setEditErr(null);
              }
            }}
            // blur CANCELS (never an accidental set) — a committed edit goes through Enter.
            onBlur={() => setEditing(false)}
            style={inputStyle}
          />
        ) : (
          <>
            {curValue !== "" && (
              <span
                onDoubleClick={
                  editable
                    ? () => {
                        setEditErr(null);
                        setEditing(true);
                      }
                    : undefined
                }
                title={editable ? "double-click to set value" : undefined}
                style={{
                  color: "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                  whiteSpace: "nowrap",
                  cursor: editable ? "text" : "default",
                }}
              >
                = {curValue}
              </span>
            )}
            {curType && <span style={{ color: "var(--text-secondary)" }}>{curType}</span>}
          </>
        )}
      </div>
      {editErr && (
        <p role="alert" style={{ ...mono, margin: "0 0 0 22px", color: "var(--danger)" }}>
          {editErr}
        </p>
      )}
      {open &&
        (kids === null ? (
          <p style={{ ...mono, margin: "0 0 0 22px", color: "var(--text-secondary)" }}>loading…</p>
        ) : kids.length === 0 ? (
          <p style={{ ...mono, margin: "0 0 0 22px", color: "var(--text-secondary)" }}>(empty)</p>
        ) : (
          kids.map((k, i) => (
            <TreeNode
              key={`${k.name}:${i}`}
              label={k.name}
              value={k.value}
              typeStr={k.type}
              refId={k.variablesReference}
              depth={depth + 1}
              ancestors={[...ancestors, curRef]}
              parentRef={curRef}
              canSetVariable={canSetVariable}
              request={request}
              cache={cache}
            />
          ))
        ))}
    </div>
  );
}

/** Map a launch.json config → the dapLaunch request (schema-allowed fields only),
 *  substituting ${workspaceFolder}. Null cfg → the default Python launch. */
function buildLaunchRequest(
  cfg: Record<string, unknown> | null,
  root: string,
): Record<string, unknown> {
  const sub = (v: unknown): unknown =>
    typeof v === "string" ? v.replaceAll("${workspaceFolder}", root) : v;
  if (!cfg) return { type: "python", request: "launch", name: "debug", workspaceRoot: root };
  const rawType = typeof cfg.type === "string" ? cfg.type : "python";
  const out: Record<string, unknown> = {
    type: rawType === "debugpy" ? "python" : rawType,
    request: cfg.request === "attach" ? "attach" : "launch",
    name: typeof cfg.name === "string" ? cfg.name : "debug",
    workspaceRoot: root,
  };
  for (const k of ["program", "module", "cwd", "python"] as const) {
    if (typeof cfg[k] === "string") out[k] = sub(cfg[k]);
  }
  for (const k of ["args", "runtimeArgs"] as const) {
    if (Array.isArray(cfg[k])) out[k] = (cfg[k] as unknown[]).map(sub);
  }
  if (typeof cfg.console === "string") out.console = cfg.console;
  // preserve a remote/attach socket target (APP-080) so a launch.json `attach` config
  // — or the Attach… form — reaches the socket transport (${workspaceFolder}-substituted).
  if (cfg.connect && typeof cfg.connect === "object" && !Array.isArray(cfg.connect)) {
    const c = cfg.connect as { host?: unknown; port?: unknown };
    const host = typeof c.host === "string" ? (sub(c.host) as string) : undefined;
    const port = typeof c.port === "number" ? c.port : Number(c.port);
    if (host && Number.isInteger(port)) out.connect = { host, port };
  }
  return out;
}

const inputStyle = {
  flex: 1,
  background: "var(--bg-surface-2)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: "0.7rem",
  fontFamily: "var(--font-mono, monospace)",
} as const;

/** One breakpoint row (APP-079): enable checkbox, kind glyph, path:line, its
 *  condition/hit/log annotation, and an inline predicate editor (✎) that patches
 *  the shared store — the same fields the editor gutter's right-click editor sets. */
function BreakpointRow({
  bp,
  logpointsSupported,
}: {
  bp: Breakpoint;
  logpointsSupported: boolean;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const detail = breakpointDetail(bp);
  const kind = isLogpoint(bp) ? "◆" : isConditional(bp) ? "◈" : "●";
  const set = (patch: {
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
  }): void => useBreakpointStore.getState().update(bp.path, bp.line, patch);
  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={bp.enabled}
          aria-label={`enable breakpoint ${basename(bp.path)}:${bp.line}`}
          onChange={(e) =>
            useBreakpointStore.getState().setEnabled(bp.path, bp.line, e.target.checked)
          }
        />
        <span
          aria-hidden="true"
          title={isLogpoint(bp) ? "logpoint" : isConditional(bp) ? "conditional" : "breakpoint"}
          style={{ color: isLogpoint(bp) ? "var(--accent)" : "var(--danger)" }}
        >
          {kind}
        </span>
        <button
          type="button"
          title={`${bp.path}:${bp.line}`}
          onClick={() => jumpToBreakpoint(bp)}
          style={{
            flex: 1,
            // the ellipsis on the basename span below is a no-op until EVERY level of the flex
            // chain is allowed to shrink: a flex item floors at min-content width.
            minWidth: 0,
            display: "flex",
            gap: 2,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textAlign: "left",
            fontSize: "0.72rem",
            fontFamily: "var(--font-mono, monospace)",
            color: bp.enabled ? "var(--text-primary)" : "var(--text-secondary)",
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
              whiteSpace: "nowrap",
            }}
          >
            {basename(bp.path)}
          </span>
          <span style={{ color: "var(--text-secondary)" }}>:{bp.line}</span>
        </button>
        {bp.enabled && bp.verified === false && (
          <span title="not verified by the debug adapter" style={{ color: "var(--warn)" }}>
            ?
          </span>
        )}
        <button
          type="button"
          aria-label={`edit breakpoint ${basename(bp.path)}:${bp.line}`}
          aria-pressed={editing}
          title="Condition / hit count / log message"
          onClick={() => setEditing((v) => !v)}
          style={{
            background: "transparent",
            border: "none",
            color: editing ? "var(--accent)" : "var(--text-secondary)",
            cursor: "pointer",
            fontSize: "0.72rem",
          }}
        >
          ✎
        </button>
        <button
          type="button"
          aria-label={`remove breakpoint ${basename(bp.path)}:${bp.line}`}
          onClick={() => useBreakpointStore.getState().remove(bp.path, bp.line)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: "0.72rem",
          }}
        >
          ✕
        </button>
      </div>
      {!editing && detail && (
        <div
          style={{
            marginLeft: 24,
            fontSize: "0.68rem",
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--text-secondary)",
          }}
        >
          {detail}
        </div>
      )}
      {editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, margin: "2px 0 4px 24px" }}>
          <input
            defaultValue={bp.condition ?? ""}
            placeholder="condition — e.g. x > 3"
            aria-label={`condition for ${basename(bp.path)}:${bp.line}`}
            onBlur={(e) => set({ condition: e.target.value })}
            style={inputStyle}
          />
          <input
            defaultValue={bp.hitCondition ?? ""}
            placeholder="hit count — e.g. 5, >5, %2"
            aria-label={`hit count for ${basename(bp.path)}:${bp.line}`}
            onBlur={(e) => set({ hitCondition: e.target.value })}
            style={inputStyle}
          />
          <input
            defaultValue={bp.logMessage ?? ""}
            placeholder="log message — {expr} (logpoint, no pause)"
            aria-label={`log message for ${basename(bp.path)}:${bp.line}`}
            onBlur={(e) => set({ logMessage: e.target.value })}
            style={inputStyle}
          />
          {isLogpoint(bp) && !logpointsSupported && (
            <span style={{ fontSize: "0.66rem", color: "var(--warn)" }}>
              this adapter doesn't support logpoints — it will stop instead of logging
            </span>
          )}
        </div>
      )}
    </li>
  );
}

export function DebugPanel(): ReactElement {
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  // the breakpoint map (APP-012) — shared with the editor gutter; the list below
  // mirrors it and enabling/removing here updates the glyphs (same store).
  const breakpointMap = useBreakpointStore((s) => s.byPath);
  const [gate, setGate] = useState<IdeGateResult | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "gating" | "blocked" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  // stopped-state inspection (call stack + scopes/variables tree, APP-030) — ALL of
  // it keys off the user-SELECTED stack frame and refetches on stop + frame switch.
  const [paused, setPaused] = useState(false);
  // threads (APP-031): the list from the `threads` request; stopped/running is
  // inferred LOCALLY from stopped/continued events (DAP has no per-thread state).
  const [threads, setThreads] = useState<DapThread[]>([]);
  const [stoppedIds, setStoppedIds] = useState<ReadonlySet<number>>(new Set());
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const selectedThreadRef = useRef<number | null>(null);
  selectedThreadRef.current = selectedThreadId;
  // stale-response guard: rapid steps supersede in-flight stackTrace/scopes —
  // any response tagged with an older seq is dropped, never painted.
  const inspectSeqRef = useRef(0);
  const [frames, setFrames] = useState<DapFrame[]>([]);
  const [scopes, setScopes] = useState<DapScope[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  // the per-stop lazy-children cache — recreated on every stop/frame switch, so a
  // recycled variablesReference can never resolve against an old stop's ids.
  const cacheRef = useRef<VarCache>(freshCache(0));
  const stopSeqRef = useRef(0);
  // watch expressions: evaluated against the SELECTED frame via DAP `evaluate`.
  const [watchExprs, setWatchExprs] = useState<string[]>([]);
  const [watchInput, setWatchInput] = useState("");
  const [watchResults, setWatchResults] = useState<Record<string, WatchResult>>({});
  // one-shot Evaluate-expression box (context:"repl", selected frame).
  const [evalInput, setEvalInput] = useState("");
  const [evalResult, setEvalResult] = useState<{ expr: string; r: WatchResult } | null>(null);
  // run/debug configurations from .vscode/launch.json + .prometheus/launch.json.
  const [configs, setConfigs] = useState<RunConfig[]>([]);
  // the EDITABLE subset (from .vscode/launch.json — the config editor's scope;
  // .prometheus/launch.json entries stay read-only in the picker).
  const [vsConfigs, setVsConfigs] = useState<RunConfig[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  // plain Run (APP-032/034): the SHARED run-session store — the toolbar and the
  // ⌘⇧R picker drive the same session this panel renders.
  const runId = useRunSessionStore((s) => s.runId);
  const runOutput = useRunSessionStore((s) => s.output);
  const runExit = useRunSessionStore((s) => s.exit);
  const runError = useRunSessionStore((s) => s.error);
  const runGateVerdict = useRunSessionStore((s) => s.gate);
  // adapter presence (APP-029) — a REAL probe, checked whenever the selected config's
  // debug type/interpreter changes, so "no debug adapter" never dead-ends silently.
  const [adapterStatus, setAdapterStatus] = useState<IdeDapDetectAdapterResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installNeedsConfirm, setInstallNeedsConfirm] = useState(false);
  // the launched adapter's DAP capabilities (APP-079) — drives the exception-filter
  // toggles + the logpoint-unsupported warning; known only after a live launch.
  const [capabilities, setCapabilities] = useState<IdeDapCapabilities | null>(null);
  // the armed exception-breakpoint filter ids (shared module store: survives unmount,
  // seeded from the adapter defaults once, re-sent on every toggle during a session).
  const exceptionEnabled = useExceptionFilterStore((s) => s.enabled);
  // set-value (APP-080): the editable variables tree lights up only when the adapter
  // advertises supportsSetVariable.
  const canSetVar = capabilities?.supportsSetVariable === true;
  // Attach… form (APP-080): adapter type + host:port → a remote/attach DebugConfig.
  const [showAttach, setShowAttach] = useState(false);
  const [attachType, setAttachType] = useState("python");
  const [attachHost, setAttachHost] = useState("127.0.0.1");
  const [attachPort, setAttachPort] = useState("5678");
  // the typed-confirm sheet for a REMOTE (non-loopback) attach — declining never launches.
  const [pendingRemoteAttach, setPendingRemoteAttach] = useState<Record<string, unknown> | null>(
    null,
  );
  const [confirmText, setConfirmText] = useState("");
  // run-config import (APP-081): the discovered foreign configs (.vscode / .idea);
  // null = the import panel is closed. Confirming writes the checked names into
  // .prometheus/launch.json (the native store) through the path-guarded fs seam.
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[] | null>(null);
  const [importSelected, setImportSelected] = useState<ReadonlySet<string>>(new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  /** (Re)load run configs — one PURE parser for the picker, Run, debug AND the
   *  config editor; .vscode entries are the editable subset (APP-033). */
  const loadConfigs = useCallback(async (): Promise<void> => {
    const api = ide();
    if (!api || !workspaceRoot) return;
    const byFile: RunConfig[][] = [];
    for (const rel of [".vscode/launch.json", ".prometheus/launch.json"]) {
      const r = await api.fsRead(`file://${workspaceRoot}/${rel}`).catch(() => undefined);
      byFile.push(r?.ok && typeof r.text === "string" ? parseLaunchJson(r.text) : []);
    }
    setVsConfigs(byFile[0] ?? []);
    // keep-first de-dup: an imported config also present in .vscode must not
    // double-list (the name is the picker's identity + the option key).
    setConfigs(dedupeConfigsByName([...(byFile[0] ?? []), ...(byFile[1] ?? [])]));
    await useRunSessionStore.getState().loadTasks(workspaceRoot); // before-launch source (APP-035)
  }, [workspaceRoot]);

  // load run configs on workspace-root change (JSONC-tolerant; the picker replaces the
  // single hardcoded {python,launch} default).
  useEffect(() => {
    setConfigs([]);
    setVsConfigs([]);
    setSelectedIdx(0);
    void loadConfigs();
  }, [loadConfigs]);

  /** Persist the editor's mutated list to .vscode/launch.json (path-guarded fs
   *  IPC), then re-read through the SAME loader so every consumer sees one truth. */
  const persistConfigs = useCallback(
    async (next: RunConfig[]): Promise<boolean> => {
      const api = ide();
      if (!api || !workspaceRoot) return false;
      await api.fsMkdir(`${workspaceRoot}/.vscode`).catch(() => undefined);
      const w = await api
        .fsWrite(`file://${workspaceRoot}/.vscode/launch.json`, serializeLaunchJson(next))
        .catch(() => undefined);
      if (!w?.ok) return false;
      await loadConfigs();
      return true;
    },
    [workspaceRoot, loadConfigs],
  );

  /** Discover importable foreign run configs (APP-081): `.vscode/launch.json` +
   *  `.idea/runConfigurations/*.xml`, listed + read through the SAME path-guarded
   *  fs IPC this panel already uses; parsed by the PURE model and de-duped
   *  against the native store (`mergeImportCandidates`). */
  const discoverImports = useCallback(async (): Promise<void> => {
    const api = ide();
    if (!api || !workspaceRoot) return;
    setImportError(null);
    const readCfgs = async (rel: string): Promise<RunConfig[]> => {
      const r = await api.fsRead(`file://${workspaceRoot}/${rel}`).catch(() => undefined);
      return r?.ok && typeof r.text === "string" ? parseLaunchJson(r.text) : [];
    };
    const [vs, native] = await Promise.all([
      readCfgs(".vscode/launch.json"),
      readCfgs(".prometheus/launch.json"),
    ]);
    const jb: RunConfig[] = [];
    const nodes = await api.fsTree(`${workspaceRoot}/.idea/runConfigurations`).catch(() => []);
    for (const node of nodes) {
      if (node.kind !== "file" || !node.name.endsWith(".xml")) continue;
      const r = await api.fsRead(`file://${node.path}`).catch(() => undefined);
      if (r?.ok && typeof r.text === "string") {
        const cfg = parseJetBrainsRunConfig(r.text);
        if (cfg) jb.push(cfg);
      }
    }
    const candidates = mergeImportCandidates(vs, jb, new Set(native.map((c) => c.name)));
    setImportCandidates(candidates);
    setImportSelected(new Set(candidates.map((c) => c.config.name)));
  }, [workspaceRoot]);

  /** Write the checked candidates into `.prometheus/launch.json` (read-merge-write,
   *  keep-first on a name overlap), then reload through the ONE loader. */
  const confirmImport = useCallback(async (): Promise<void> => {
    const api = ide();
    if (!api || !workspaceRoot || !importCandidates) return;
    const picked = importCandidates.filter((c) => importSelected.has(c.config.name));
    if (picked.length === 0) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const r = await api
        .fsRead(`file://${workspaceRoot}/.prometheus/launch.json`)
        .catch(() => undefined);
      const native = r?.ok && typeof r.text === "string" ? parseLaunchJson(r.text) : [];
      const next = dedupeConfigsByName([...native, ...picked.map((c) => c.config)]);
      await api.fsMkdir(`${workspaceRoot}/.prometheus`).catch(() => undefined);
      const w = await api
        .fsWrite(`file://${workspaceRoot}/.prometheus/launch.json`, serializeLaunchJson(next))
        .catch(() => undefined);
      if (!w?.ok) {
        setImportError(w?.error ?? "could not write .prometheus/launch.json");
        return;
      }
      setImportCandidates(null);
      await loadConfigs();
    } finally {
      setImportBusy(false);
    }
  }, [workspaceRoot, importCandidates, importSelected, loadConfigs]);

  /** Re-probe the currently selected config's debug adapter (APP-029) — a real check,
   *  never a guess; drives the install affordance below. */
  const checkAdapter = useCallback(async () => {
    const api = ide();
    if (!api) return;
    const { type, python } = debugTypeAndPython(configs[selectedIdx]?.raw ?? null);
    const r = await api.dapDetectAdapter(type, python);
    setAdapterStatus(r);
  }, [configs, selectedIdx]);

  // check adapter presence whenever the selected config (→ debug type/interpreter)
  // changes, so the install affordance is visible BEFORE the user even tries to launch.
  useEffect(() => {
    void checkAdapter();
  }, [checkAdapter]);

  /** Install the adapter dependency for the selected config's debug type (nemesis-gated,
   *  C5 — MAIN stages the download and gates it; this only renders the outcome). */
  const doInstall = useCallback(
    async (confirm = false) => {
      const api = ide();
      if (!api) return;
      const { type, python } = debugTypeAndPython(configs[selectedIdx]?.raw ?? null);
      setInstalling(true);
      setInstallError(null);
      setInstallNeedsConfirm(false);
      try {
        const r = await api.dapInstallAdapter(type, { pythonPath: python, confirm });
        if (r.needsConfirm) {
          setInstallNeedsConfirm(true);
          setInstallError(r.error ?? "nemesis found warnings — confirm to proceed");
        } else if (!r.ok) {
          setInstallError(r.error ?? "install failed");
        } else {
          await checkAdapter(); // flip the panel to launch-ready on success
        }
      } finally {
        setInstalling(false);
      }
    },
    [configs, selectedIdx, checkAdapter],
  );

  /** The injected-request seam for a session: everything below (scopes, variables,
   *  watches, evaluate) flows through the ONE generic dapRequest pass-through. */
  const requestFor = useCallback(
    (sid: string): DapRequestFn =>
      async (command, args) => {
        const api = ide();
        if (!api) return { ok: false, error: "no ide bridge" };
        return api.dapRequest(sid, command, args);
      },
    [],
  );

  /** Bind inspection to a frame: NEW cache (drops every stale variablesReference),
   *  fetch that frame's scopes, then publish the frame's locals as inline values
   *  beside its active line. `seq` drops superseded responses (rapid steps). */
  const loadFrame = useCallback(
    async (sid: string, frame: DapFrame, seq: number) => {
      stopSeqRef.current += 1;
      cacheRef.current = freshCache(stopSeqRef.current);
      setSelectedFrameId(frame.id);
      setEvalResult(null);
      try {
        const req = requestFor(sid);
        const sc = await req("scopes", { frameId: frame.id });
        if (inspectSeqRef.current !== seq) return;
        const scopeRows = sc.ok ? parseScopes(sc.body) : [];
        setScopes(scopeRows);
        // inline values (APP-031): the selected frame's first cheap scope, beside
        // the frame's line — shares the tree's per-stop cache (still fetch-once).
        if (frame.path === null) {
          publishInlineValues(null);
          return;
        }
        const cheap = scopeRows.find((s) => !s.expensive);
        const vars = cheap
          ? await fetchChildren(cacheRef.current, req, cheap.variablesReference)
          : [];
        if (inspectSeqRef.current !== seq) return;
        publishInlineValues({
          uri: pathToFileUri(frame.path),
          line: frame.line,
          pairs: vars.map((v) => ({ name: v.name, value: v.value })),
        });
      } catch {
        if (inspectSeqRef.current === seq) setScopes([]);
      }
    },
    [requestFor],
  );

  /** Pull a thread's call stack; inspection defaults to its TOP frame. */
  const loadStack = useCallback(
    async (sid: string, tid: number, seq: number) => {
      const api = ide();
      if (!api) return;
      try {
        const st = await api.dapRequest(sid, "stackTrace", { threadId: tid });
        if (inspectSeqRef.current !== seq) return; // superseded by a newer stop/step
        const frameRows = parseFrames(st.body);
        setFrames(frameRows);
        const top = frameRows[0];
        if (top) await loadFrame(sid, top, seq);
      } catch {
        /* inspection is best-effort */
      }
    },
    [loadFrame],
  );

  /** On a `stopped` event: list threads, fold the stopped set, pick the context
   *  thread (event threadId is OPTIONAL), and load its stack. */
  const onStopped = useCallback(
    async (sid: string, body: unknown) => {
      const api = ide();
      if (!api) return;
      const seq = ++inspectSeqRef.current;
      let ths: DapThread[] = [];
      try {
        const tr = await api.dapRequest(sid, "threads", {});
        ths = tr.ok ? parseThreads(tr.body) : [];
      } catch {
        /* threads listing is best-effort */
      }
      if (inspectSeqRef.current !== seq) return;
      setThreads(ths);
      setStoppedIds((prev) =>
        applyStopped(
          prev,
          body,
          ths.map((t) => t.id),
        ),
      );
      const tid = pickStoppedThread(body, ths);
      setSelectedThreadId(tid);
      if (tid !== null) await loadStack(sid, tid, seq);
    },
    [loadStack],
  );

  /** Re-evaluate every watch against the SELECTED frame (per-row error isolation). */
  const refreshWatches = useCallback(async () => {
    if (!sessionId || !paused || watchExprs.length === 0) return;
    setWatchResults(await evalWatches(requestFor(sessionId), watchExprs, selectedFrameId));
  }, [sessionId, paused, watchExprs, selectedFrameId, requestFor]);

  /** One-shot Evaluate (context:"repl") — the result may expand through the tree. */
  const runEvaluate = useCallback(async () => {
    const expr = evalInput.trim();
    if (!expr || !sessionId) return;
    const r = await evalExpression(requestFor(sessionId), expr, selectedFrameId);
    setEvalResult({ expr, r });
  }, [evalInput, sessionId, selectedFrameId, requestFor]);

  const addWatch = useCallback(() => {
    const e = watchInput.trim();
    if (!e) return;
    setWatchExprs((xs) => (xs.includes(e) ? xs : [...xs, e]));
    setWatchInput("");
  }, [watchInput]);

  const removeWatch = useCallback((expr: string) => {
    setWatchExprs((xs) => xs.filter((x) => x !== expr));
    setWatchResults((r) => {
      const n = { ...r };
      delete n[expr];
      return n;
    });
  }, []);

  /** Step/continue/pause control → dapRequest; the next `stopped` event refreshes state. */
  const dapControl = useCallback(
    async (command: "continue" | "next" | "stepIn" | "stepOut" | "pause") => {
      // step verbs drive the SELECTED thread (APP-031), never a stale last-stop id
      if (!sessionId || selectedThreadId === null) return;
      inspectSeqRef.current += 1; // supersede any in-flight stackTrace/scopes
      setPaused(false);
      setFrames([]);
      setScopes([]);
      setSelectedFrameId(null);
      setEvalResult(null);
      publishInlineValues(null);
      await ide()?.dapRequest(sessionId, command, { threadId: selectedThreadId });
    },
    [sessionId, selectedThreadId],
  );

  /** Arm/disarm an exception-breakpoint filter (APP-079). During a live session,
   *  re-send the FULL surviving filter set — omitting the request would leave the
   *  adapter's prior filters active, and `{ filters: [] }` clears them all. */
  const toggleException = useCallback(
    (id: string, on: boolean) => {
      useExceptionFilterStore.getState().toggle(id, on);
      if (sessionId) {
        void ide()?.dapRequest(sessionId, "setExceptionBreakpoints", {
          filters: useExceptionFilterStore.getState().enabled,
        });
      }
    },
    [sessionId],
  );

  /** Gate the workspace (§5.2) then launch a DAP session (launch OR attach). Shared by the
   *  config-picker Debug, the Attach… form, and the confirmed-remote path. `allowRemote`
   *  rides ONLY after the typed-confirm sheet (APP-080); the host re-checks it fail-closed. */
  const launchWith = useCallback(
    async (launchReq: Record<string, unknown>, allowRemote = false) => {
      if (!workspaceRoot) return;
      const api = ide();
      if (!api) {
        setStatus("error");
        setError("no ide bridge");
        return;
      }
      setStatus("gating");
      setError(null);
      // 1) the REAL engine run-gate (fail-closed): a missing/timed-out scanner blocks — kept
      // for BOTH launch and attach (attach also runs the debuggee's code).
      const verdict = await api.gate({ workspaceRoot });
      setGate(verdict);
      if (!verdict.mayLaunch) {
        // warn → modal "Run anyway?" (VerdictSheet in App); block/error → refuse + Gate Log.
        setStatus("blocked");
        return;
      }
      // 2) launch/attach the DAP session (no adapter in this env → ok:false honest).
      try {
        // the launch-time config plan (APP-079): every source's breakpoints (with
        // condition/hitCondition/logMessage) + the armed exception filters. The host
        // sequences initialized→setBreakpoints→setExceptionBreakpoints→configurationDone.
        const plan: IdeDapLaunchPlan = {
          sources: dapLaunchPlan(useBreakpointStore.getState().byPath),
          exceptionFilters: useExceptionFilterStore.getState().enabled,
        };
        const launched = await api.dapLaunch(
          launchReq,
          plan,
          allowRemote ? { allowRemote: true } : undefined,
        );
        if (launched.ok && launched.sessionId) {
          setSessionId(launched.sessionId);
          useRunSessionStore.getState().setDapSession(launched.sessionId);
          if (launched.capabilities) {
            setCapabilities(launched.capabilities);
            // arm the adapter's default exception filters the first time we see them.
            if (launched.capabilities.exceptionBreakpointFilters) {
              useExceptionFilterStore
                .getState()
                .seed(launched.capabilities.exceptionBreakpointFilters);
            }
          }
          setStatus("running");
        } else {
          setStatus("error");
          setError(launched.error ?? "no debug adapter available");
          void checkAdapter(); // APP-029: explain WHY — never a silent dead end
        }
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
        void checkAdapter();
      }
    },
    [workspaceRoot, checkAdapter],
  );

  /** Run/Debug the SELECTED config. A remote (non-loopback) `attach` config routes through
   *  the typed-confirm sheet before any socket opens (APP-080); everything else launches. */
  const startDebug = useCallback(async () => {
    if (!workspaceRoot) return;
    const req = buildLaunchRequest(configs[selectedIdx]?.raw ?? null, workspaceRoot);
    if (isRemoteAttachRequest(req)) {
      setPendingRemoteAttach(req);
      setConfirmText("");
      return;
    }
    await launchWith(req);
  }, [workspaceRoot, configs, selectedIdx, launchWith]);

  /** Attach… form → an attach DebugConfig. Loopback attaches launch straight through the
   *  gate; a remote host shows the typed-confirm sheet first (APP-080). */
  const submitAttach = useCallback(() => {
    if (!workspaceRoot) return;
    const host = attachHost.trim();
    const port = Number(attachPort);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      setStatus("error");
      setError("attach needs a host and a port in 1–65535");
      return;
    }
    const req: Record<string, unknown> = {
      type: attachType,
      request: "attach",
      name: `attach ${host}:${port}`,
      connect: { host, port },
      workspaceRoot,
    };
    setShowAttach(false);
    if (isRemoteAttachRequest(req)) {
      setPendingRemoteAttach(req);
      setConfirmText("");
      return;
    }
    void launchWith(req);
  }, [workspaceRoot, attachType, attachHost, attachPort, launchWith]);

  /** Proceed with a remote attach only after the user re-typed the target host (APP-080). */
  const confirmRemoteAttach = useCallback(() => {
    if (!pendingRemoteAttach) return;
    const req = pendingRemoteAttach;
    setPendingRemoteAttach(null);
    setConfirmText("");
    void launchWith(req, true);
  }, [pendingRemoteAttach, launchWith]);

  const cancelRemoteAttach = useCallback(() => {
    setPendingRemoteAttach(null);
    setConfirmText("");
  }, []);

  /** Plain Run (no debugger, APP-032/034): the SHARED store runs the selected
   *  config through the gated engine; output/exit land in the store this panel
   *  renders. The toolbar + picker call the SAME store — one flow, one truth. */
  const startRun = useCallback(async () => {
    if (!workspaceRoot) return;
    const cfg = configs[selectedIdx];
    if (!cfg) return;
    // before-launch tasks + compound members run through the one gated path (APP-035).
    await useRunSessionStore.getState().startByName(cfg.name, configs, workspaceRoot);
  }, [workspaceRoot, configs, selectedIdx]);

  const killRun = useCallback(async () => {
    await useRunSessionStore.getState().kill();
  }, []);

  const stop = useCallback(async () => {
    if (sessionId) await ide()?.dapTerminate(sessionId);
    inspectSeqRef.current += 1;
    useRunSessionStore.getState().setDapSession(null);
    setSessionId(null);
    setStatus("idle");
    setThreads([]);
    setStoppedIds(new Set());
    setSelectedThreadId(null);
    publishInlineValues(null);
  }, [sessionId]);

  // route the adapter's DAP events: `stopped` → pull stack+vars; `continued` → clear
  // the paused inspection; `terminated`/`exited` → end the session (no stuck "running").
  useEffect(() => {
    if (!sessionId) return;
    const api = ide();
    if (!api) return;
    const unsub = api.onEvent((ev) => {
      if (ev.channel !== "dap.event" || ev.sessionId !== sessionId) return;
      if (ev.event === "stopped") {
        setPaused(true);
        void onStopped(sessionId, ev.body);
      } else if (ev.event === "continued") {
        // allThreadsContinued defaults TRUE when omitted; an explicit false only
        // resumes one thread — the panel's context clears only when ITS thread ran.
        const b = (ev.body ?? {}) as { threadId?: unknown; allThreadsContinued?: unknown };
        setStoppedIds((prev) => applyContinued(prev, ev.body));
        const all = b.allThreadsContinued !== false;
        if (all || b.threadId === selectedThreadRef.current) {
          inspectSeqRef.current += 1;
          setPaused(false);
          setFrames([]);
          setScopes([]);
          setSelectedFrameId(null);
          setEvalResult(null);
          publishInlineValues(null);
        }
      } else if (ev.event === "terminated" || ev.event === "exited") {
        inspectSeqRef.current += 1;
        useRunSessionStore.getState().setDapSession(null);
        setSessionId(null);
        setStatus("idle");
        setPaused(false);
        setSelectedThreadId(null);
        setThreads([]);
        setStoppedIds(new Set());
        setFrames([]);
        setScopes([]);
        setSelectedFrameId(null);
        setEvalResult(null);
        publishInlineValues(null);
      }
    });
    return unsub;
  }, [sessionId, onStopped]);

  // APP-012: wire the module-level DAP breakpoint sync (initialized→replay→
  // configurationDone + live store→setBreakpoints). Idempotent; survives unmount.
  useEffect(() => {
    ensureBreakpointDapSync();
  }, []);

  // Run toolbar bus (APP-034): Debug/Stop route through the IDENTICAL gated
  // flow as the panel buttons — one gate→dapLaunch path, never a divergent copy.
  useEffect(() => {
    const onDebugStart = (): void => {
      if (!sessionId) void startDebug();
    };
    const onDebugStop = (): void => {
      if (sessionId) void stop();
    };
    window.addEventListener("ide:debug-start", onDebugStart);
    window.addEventListener("ide:debug-stop", onDebugStop);
    return () => {
      window.removeEventListener("ide:debug-start", onDebugStart);
      window.removeEventListener("ide:debug-stop", onDebugStop);
    };
  }, [sessionId, startDebug, stop]);

  // re-evaluate ALL watches on every stop, frame switch, or expression-list change;
  // clear the values while running (an expression has no value off a stopped frame).
  useEffect(() => {
    if (paused && sessionId && watchExprs.length > 0) {
      void refreshWatches();
    } else if (!paused) {
      setWatchResults({});
    }
  }, [paused, sessionId, watchExprs, refreshWatches]);

  // the pending remote-attach target (APP-080) — the typed-confirm sheet echoes host:port.
  const pendingConnect = pendingRemoteAttach?.connect as
    | { host?: string; port?: number }
    | undefined;
  const pendingHost = typeof pendingConnect?.host === "string" ? pendingConnect.host : "";
  const pendingPort = typeof pendingConnect?.port === "number" ? pendingConnect.port : "";

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="debug"
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
        {configs.length > 0 && (
          <select
            value={selectedIdx}
            onChange={(e) => setSelectedIdx(Number(e.target.value))}
            aria-label="run configuration"
            title="Run/Debug configuration (launch.json)"
            style={{
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              padding: "2px 4px",
              fontSize: "0.76rem",
              maxWidth: 160,
            }}
          >
            {configs.map((c, i) => (
              <option key={c.name} value={i}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {(configs[selectedIdx]?.unsupported?.length ?? 0) > 0 && (
          <span
            role="img"
            aria-label="configuration has unsupported fields"
            title={`unsupported fields skipped on import: ${(
              configs[selectedIdx]?.unsupported ?? []
            ).join(", ")}`}
            style={{ color: "var(--warn)", cursor: "help" }}
          >
            ⚠
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!workspaceRoot}
          aria-pressed={importCandidates !== null}
          onClick={() => {
            if (importCandidates) setImportCandidates(null);
            else void discoverImports();
          }}
          title="Import run configurations from .vscode/launch.json or JetBrains .idea/runConfigurations"
        >
          ⇪ Import…
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!workspaceRoot || status === "gating"}
          onClick={() => void startDebug()}
        >
          {status === "gating" ? "Gating…" : "▸ Start Debugging (F5)"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!workspaceRoot || runId !== null}
          onClick={() => void startRun()}
          title="Run the selected configuration without the debugger (gated + resource-guarded)"
        >
          ▶ Run
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!workspaceRoot}
          aria-pressed={showAttach}
          onClick={() => setShowAttach((v) => !v)}
          title="Attach the debugger to an already-running process (local or remote host:port)"
        >
          ⚯ Attach…
        </Button>
        {runId && (
          <Button size="sm" variant="ghost" onClick={() => void killRun()}>
            ■ Stop Run
          </Button>
        )}
        {sessionId && (
          <Button size="sm" variant="ghost" onClick={() => void stop()}>
            ■ Stop
          </Button>
        )}
      </div>

      {importCandidates && (
        <Panel title="Import run configurations" elevation="e1">
          {importCandidates.length === 0 ? (
            <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.74rem" }}>
              No foreign run configurations found (.vscode/launch.json,
              .idea/runConfigurations/*.xml) — or everything is already imported.
            </p>
          ) : (
            <>
              <ul style={{ listStyle: "none", margin: "0 0 6px", padding: 0 }}>
                {importCandidates.map((c) => (
                  <li
                    key={c.config.name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: "0.72rem",
                      fontFamily: "var(--font-mono, monospace)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={importSelected.has(c.config.name)}
                      aria-label={`import ${c.config.name}`}
                      onChange={(e) =>
                        setImportSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(c.config.name);
                          else next.delete(c.config.name);
                          return next;
                        })
                      }
                    />
                    <span
                      style={{
                        color: "var(--text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.config.name}
                    </span>
                    <span style={{ color: "var(--text-secondary)" }}>{c.config.type}</span>
                    <span
                      style={{
                        marginLeft: "auto",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: 3,
                        padding: "0 4px",
                        fontSize: "0.64rem",
                        color: c.source === "vscode" ? "var(--accent)" : "var(--warn)",
                      }}
                    >
                      {c.source === "vscode" ? "vscode" : ".idea"}
                    </span>
                    {(c.config.unsupported?.length ?? 0) > 0 && (
                      <span
                        role="img"
                        aria-label={`${c.config.name} has unsupported fields`}
                        title={`not imported: ${(c.config.unsupported ?? []).join(", ")}`}
                        style={{ color: "var(--warn)", cursor: "help" }}
                      >
                        ⚠
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={importBusy || importSelected.size === 0}
                  onClick={() => void confirmImport()}
                >
                  {importBusy
                    ? "Importing…"
                    : `Import ${importSelected.size} into .prometheus/launch.json`}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setImportCandidates(null)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
          {importError && (
            <p
              role="alert"
              style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: "0.72rem" }}
            >
              {importError}
            </p>
          )}
        </Panel>
      )}

      {showAttach && (
        <Panel title="Attach to a running process" elevation="e1">
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={attachType}
              onChange={(e) => setAttachType(e.target.value)}
              aria-label="attach adapter type"
              style={{
                background: "var(--bg-surface-2)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                padding: "2px 4px",
                fontSize: "0.72rem",
              }}
            >
              <option value="python">python</option>
              <option value="node">node</option>
              <option value="rust">rust</option>
            </select>
            <input
              value={attachHost}
              onChange={(e) => setAttachHost(e.target.value)}
              placeholder="host — 127.0.0.1"
              aria-label="attach host"
              style={{ ...inputStyle, flex: "1 1 120px" }}
            />
            <input
              value={attachPort}
              onChange={(e) => setAttachPort(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAttach();
              }}
              placeholder="port — 5678"
              inputMode="numeric"
              aria-label="attach port"
              style={{ ...inputStyle, flex: "0 0 80px" }}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!workspaceRoot}
              onClick={() => submitAttach()}
            >
              Attach
            </Button>
          </div>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: "0.68rem",
              color: "var(--text-secondary)",
            }}
          >
            The debuggee must already be listening (e.g.{" "}
            <code>python -m debugpy --listen 5678 --wait-for-client app.py</code>). A non-loopback
            host asks for confirmation first.
          </p>
        </Panel>
      )}

      {pendingRemoteAttach && (
        <Panel title="Confirm remote debug attach" elevation="e2">
          <p role="alert" style={{ margin: "0 0 6px", color: "var(--warn)", fontSize: "0.74rem" }}>
            Attaching to{" "}
            <strong>
              {pendingHost}:{pendingPort}
            </strong>{" "}
            executes code on / through a REMOTE host. Type the host below to confirm.
          </p>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && confirmText.trim() === pendingHost) confirmRemoteAttach();
              }}
              placeholder={`type "${pendingHost}"`}
              aria-label="confirm remote host"
              style={{ ...inputStyle, flex: "1 1 120px" }}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={confirmText.trim() !== pendingHost}
              onClick={() => confirmRemoteAttach()}
            >
              Attach to {pendingHost}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => cancelRemoteAttach()}>
              Cancel
            </Button>
          </div>
        </Panel>
      )}

      <RunConfigEditor
        configs={vsConfigs}
        selectedName={configs[selectedIdx]?.name ?? null}
        onPersist={persistConfigs}
      />

      {(runId || runOutput !== "" || runExit || runError) && (
        <Panel title="Run output" elevation="e1">
          {runError && (
            <p
              role="alert"
              style={{ margin: "0 0 4px", color: "var(--danger)", fontSize: "0.72rem" }}
            >
              {runError}
            </p>
          )}
          {(runOutput !== "" || runId) && (
            <pre
              aria-label="run output"
              style={{
                margin: 0,
                maxHeight: 160,
                overflow: "auto",
                fontSize: "0.7rem",
                fontFamily: "var(--font-mono, monospace)",
                whiteSpace: "pre-wrap",
                color: "var(--text-primary)",
              }}
            >
              {runOutput || "running…"}
            </pre>
          )}
          {runExit && (
            <p
              style={{
                margin: "4px 0 0",
                fontSize: "0.72rem",
                color: runExit.killed
                  ? "var(--warn)"
                  : runExit.exitCode === 0
                    ? "var(--ok)"
                    : "var(--danger)",
              }}
            >
              {runExit.killed ? "stopped by user" : `exited with code ${runExit.exitCode}`}
            </p>
          )}
        </Panel>
      )}

      {sessionId && (
        <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
          <Button
            size="sm"
            variant="ghost"
            disabled={!paused}
            onClick={() => void dapControl("continue")}
            title="Continue"
          >
            ▶ Continue
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!paused}
            onClick={() => void dapControl("next")}
            title="Step Over"
          >
            ↷ Over
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!paused}
            onClick={() => void dapControl("stepIn")}
            title="Step In"
          >
            ↳ In
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!paused}
            onClick={() => void dapControl("stepOut")}
            title="Step Out"
          >
            ↰ Out
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={paused}
            onClick={() => void dapControl("pause")}
            title="Pause"
          >
            ⏸ Pause
          </Button>
        </div>
      )}

      {(gate ?? runGateVerdict) && (status === "blocked" || runGateVerdict) && (
        <Panel title="Run gate" elevation="e1">
          <p style={{ margin: 0, color: "var(--danger)" }}>
            {(gate ?? runGateVerdict)?.decision === "warn"
              ? "Findings — review before running."
              : "Blocked by nemesis."}{" "}
            · {(gate ?? runGateVerdict)?.findingsCount ?? 0} finding(s)
            {(gate ?? runGateVerdict)?.verdict ? ` · ${(gate ?? runGateVerdict)?.verdict}` : ""}
          </p>
          <p
            style={{
              margin: "4px 0 0",
              color: "var(--text-secondary)",
              fontSize: "0.72rem",
            }}
          >
            {(gate ?? runGateVerdict)?.reason}
          </p>
        </Panel>
      )}

      {adapterStatus && !adapterStatus.available && (
        <Panel title="Debug adapter" elevation="e1">
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.78rem" }}>
            {adapterStatus.detail}
          </p>
          {adapterStatus.type === "python" ? (
            <>
              <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={installing}
                  onClick={() => void doInstall(false)}
                >
                  {installing ? "Installing…" : "Install debugpy"}
                </Button>
                {installError && !installNeedsConfirm && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={installing}
                    onClick={() => void doInstall(false)}
                  >
                    Retry
                  </Button>
                )}
              </div>
              {installNeedsConfirm && (
                <div style={{ marginTop: 6 }}>
                  <p style={{ margin: 0, color: "var(--warn)", fontSize: "0.72rem" }}>
                    {installError}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={installing}
                    onClick={() => void doInstall(true)}
                  >
                    Install anyway
                  </Button>
                </div>
              )}
              {installError && !installNeedsConfirm && (
                <p
                  style={{
                    margin: "4px 0 0",
                    color: "var(--danger)",
                    fontSize: "0.72rem",
                  }}
                >
                  {installError}
                </p>
              )}
            </>
          ) : (
            <p
              style={{
                margin: "4px 0 0",
                color: "var(--text-secondary)",
                fontSize: "0.72rem",
              }}
            >
              Automatic install isn't available for "{adapterStatus.type}" yet — install its adapter
              manually, then retry.
            </p>
          )}
        </Panel>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      <section style={{ marginTop: 8 }}>
        <h4 style={{ margin: "0 0 4px", color: "var(--text-secondary)", fontWeight: 600 }}>
          THREADS
        </h4>
        {threads.length > 0 ? (
          <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0 }}>
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  aria-label={`select thread ${t.name}`}
                  aria-pressed={t.id === selectedThreadId}
                  onClick={() => {
                    // switching thread context: step verbs target it; a stopped
                    // thread's stack loads immediately (running threads have none).
                    setSelectedThreadId(t.id);
                    if (sessionId && stoppedIds.has(t.id)) {
                      const seq = ++inspectSeqRef.current;
                      void loadStack(sessionId, t.id, seq);
                    }
                  }}
                  style={{
                    display: "flex",
                    gap: 4,
                    width: "100%",
                    background: t.id === selectedThreadId ? "var(--bg-surface-2)" : "transparent",
                    border: "none",
                    borderRadius: 3,
                    padding: "1px 4px",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "0.72rem",
                    fontFamily: "var(--font-mono, monospace)",
                    color: "var(--text-primary)",
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      color: stoppedIds.has(t.id) ? "var(--warn)" : "var(--ok)",
                    }}
                  >
                    {stoppedIds.has(t.id) ? "⏸" : "▶"}
                  </span>
                  {t.name}
                  <span style={{ color: "var(--text-secondary)" }}>#{t.id}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: "0 0 8px", color: "var(--text-secondary)" }}>—</p>
        )}
        <h4 style={{ margin: "0 0 4px", color: "var(--text-secondary)", fontWeight: 600 }}>
          CALL STACK
        </h4>
        {frames.length > 0 ? (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {frames.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  aria-label={`select frame ${f.name}`}
                  aria-pressed={f.id === selectedFrameId}
                  title={f.path ? `${f.path}:${f.line}` : "no source file (in-memory frame)"}
                  onClick={() => {
                    // frame switch: ALL inspection (scopes/variables/watches/
                    // evaluate) rebinds to this frame — new cache, refetch — and
                    // the editor navigates to the frame's source line (APP-031;
                    // frames without a source.path select but never navigate).
                    if (sessionId && f.id !== selectedFrameId) {
                      const seq = ++inspectSeqRef.current;
                      void loadFrame(sessionId, f, seq);
                    }
                    jumpToFrame(f);
                  }}
                  style={{
                    display: "flex",
                    gap: 4,
                    width: "100%",
                    background: f.id === selectedFrameId ? "var(--bg-surface-2)" : "transparent",
                    border: "none",
                    borderRadius: 3,
                    padding: "1px 4px",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "0.72rem",
                    fontFamily: "var(--font-mono, monospace)",
                    color: "var(--text-primary)",
                  }}
                >
                  <span style={{ width: 10, color: "var(--accent)" }}>
                    {f.id === selectedFrameId ? "▸" : ""}
                  </span>
                  {f.name} <span style={{ color: "var(--text-secondary)" }}>:{f.line}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: 0, color: "var(--text-secondary)" }}>
            {paused ? "paused" : status === "running" ? "running…" : "Not paused."}
          </p>
        )}
        <h4 style={{ margin: "8px 0 4px", color: "var(--text-secondary)", fontWeight: 600 }}>
          VARIABLES
        </h4>
        {scopes.length > 0 && sessionId ? (
          // key = stopSeq: the whole tree remounts on stop/frame switch, dropping
          // every expansion + cached child of the previous (recycled) references.
          <div key={cacheRef.current.stopSeq}>
            {scopes.map((sc) => (
              <TreeNode
                key={sc.name}
                label={sc.name}
                value=""
                typeStr={sc.expensive ? "(expensive — expand to load)" : null}
                refId={sc.variablesReference}
                depth={0}
                ancestors={[]}
                parentRef={0}
                canSetVariable={canSetVar}
                request={requestFor(sessionId)}
                cache={cacheRef.current}
              />
            ))}
          </div>
        ) : (
          <p style={{ margin: 0, color: "var(--text-secondary)" }}>—</p>
        )}
        <h4
          style={{
            margin: "8px 0 4px",
            color: "var(--text-secondary)",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          WATCH
          {watchExprs.length > 0 && (
            <button
              type="button"
              aria-label="refresh watches"
              title="Re-evaluate all watches against the selected frame"
              disabled={!paused}
              onClick={() => void refreshWatches()}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                cursor: paused ? "pointer" : "default",
                fontSize: "0.72rem",
                padding: 0,
              }}
            >
              ⟳
            </button>
          )}
        </h4>
        <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
          <input
            value={watchInput}
            onChange={(e) => setWatchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addWatch();
            }}
            placeholder="add expression…"
            aria-label="add watch expression"
            style={{
              flex: 1,
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              padding: "2px 6px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-mono, monospace)",
            }}
          />
          <button
            type="button"
            onClick={addWatch}
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "0.72rem",
              padding: "2px 8px",
            }}
          >
            ＋
          </button>
        </div>
        {watchExprs.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-secondary)" }}>—</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {watchExprs.map((expr) => (
              <li
                key={expr}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: "0.72rem",
                  fontFamily: "var(--font-mono, monospace)",
                }}
              >
                <span style={{ color: "var(--accent)" }}>{expr}</span>
                <span
                  style={{
                    flex: 1,
                    color: watchResults[expr]?.error ? "var(--danger)" : "var(--text-secondary)",
                  }}
                >
                  {" = "}
                  {paused ? (watchResults[expr]?.value ?? "…") : "—"}
                </span>
                <button
                  type="button"
                  aria-label={`remove watch ${expr}`}
                  onClick={() => removeWatch(expr)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.72rem",
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <h4 style={{ margin: "8px 0 4px", color: "var(--text-secondary)", fontWeight: 600 }}>
          EVALUATE
        </h4>
        <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
          <input
            value={evalInput}
            onChange={(e) => setEvalInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runEvaluate();
            }}
            disabled={!paused || !sessionId}
            placeholder={paused ? "evaluate expression…" : "pause to evaluate"}
            aria-label="evaluate expression"
            style={{
              flex: 1,
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              padding: "2px 6px",
              fontSize: "0.72rem",
              fontFamily: "var(--font-mono, monospace)",
            }}
          />
          <button
            type="button"
            aria-label="run evaluate"
            disabled={!paused || !sessionId}
            onClick={() => void runEvaluate()}
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "0.72rem",
              padding: "2px 8px",
            }}
          >
            ⏎
          </button>
        </div>
        {evalResult &&
          sessionId &&
          (evalResult.r.error ? (
            <p
              role="alert"
              style={{
                margin: 0,
                fontSize: "0.72rem",
                fontFamily: "var(--font-mono, monospace)",
                color: "var(--danger)",
              }}
            >
              {evalResult.expr} → {evalResult.r.value}
            </p>
          ) : (
            // the result's own variablesReference expands through the SAME tree
            <TreeNode
              key={`eval:${cacheRef.current.stopSeq}:${evalResult.expr}`}
              label={evalResult.expr}
              value={evalResult.r.value}
              typeStr={null}
              refId={evalResult.r.variablesReference}
              depth={0}
              ancestors={[]}
              parentRef={0}
              canSetVariable={canSetVar}
              request={requestFor(sessionId)}
              cache={cacheRef.current}
            />
          ))}
        {(capabilities?.exceptionBreakpointFilters?.length ?? 0) > 0 && (
          <>
            <h4
              style={{
                margin: "8px 0 4px",
                color: "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              EXCEPTIONS
            </h4>
            <ul style={{ listStyle: "none", margin: "0 0 4px", padding: 0 }}>
              {capabilities?.exceptionBreakpointFilters?.map((f) => (
                <li
                  key={f.filter}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: "0.72rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={exceptionEnabled.includes(f.filter)}
                    aria-label={`exception filter ${f.label}`}
                    onChange={(e) => toggleException(f.filter, e.target.checked)}
                  />
                  <span title={f.description ?? f.label} style={{ color: "var(--text-primary)" }}>
                    {f.label}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <h4 style={{ margin: "8px 0 4px", color: "var(--text-secondary)", fontWeight: 600 }}>
          BREAKPOINTS
        </h4>
        {allBreakpoints(breakpointMap).length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-secondary)" }}>
            Click the editor gutter to add one; right-click a glyph for a condition or logpoint.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {allBreakpoints(breakpointMap).map((bp) => (
              <BreakpointRow
                key={bp.id}
                bp={bp}
                logpointsSupported={capabilities?.supportsLogPoints !== false}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default DebugPanel;
