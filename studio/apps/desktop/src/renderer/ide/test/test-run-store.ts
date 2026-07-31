/**
 * ide/test/test-run-store.ts — the Test Explorer RUN state + gutter provider (APP-014).
 *
 * One Zustand slice shared by the TestExplorer panel AND the editor gutter run icons:
 * the discovered tree (testmgr AST scan), per-case live states/messages folded from the
 * streamed `ide:test.event` feed, and the run orchestration (`runTests`) over the
 * APP-013 preload seam (`testRun` / `testRerunFailed` / `onTestEvent`).
 *
 * Event keying: `onTestEvent` is a GLOBAL stream with no run id, so each run subscribes
 * for ITS OWN lifetime only — the listener attaches right before the run IPC and
 * detaches before the result settles the store, and the `running` guard makes a second
 * run impossible while one is live (no cancel IPC exists; re-entry is a no-op, never a
 * parallel pytest interleaving two JSON-lines streams into one channel). A stale run's
 * late events therefore can never repaint a newer tree.
 *
 * Renderer-SANDBOXED (C5): zustand + the pure local view helpers + plain contract
 * types. NO monaco / electron / node:* — the gutter wiring takes the monaco.Uri
 * conversions injected (breakpoint-store convention), so everything here stays
 * node:test-able against the real APP-011 registry.
 */

import { create } from "zustand";

import type {
  IdeTestEvent,
  IdeTestFramework,
  IdeTestRunResult,
} from "../../../shared/ipc-contract.js";
import type { GutterDecorationInput, GutterRegistry } from "../state/gutter-decorations.js";
import type { TestNodeView, TestState } from "./test-view.js";

/** The APP-011 provider id owning the run icons. */
export const TEST_RUN_PROVIDER = "test-run";

/** Glyph precedence: HIGHER than breakpoints (10) — a breakpoint set on a test's
 *  line wins the visible glyph AND the click, so what you see is what a click does. */
export const TEST_RUN_GLYPH_ORDER = 20;

/* ── pure run-state reducers (node:test-tested beside this file) ─────────────────*/

/** Case-state and failure-message maps, folded event by event. */
export interface RunMaps {
  states: Record<string, TestState>;
  messages: Record<string, string>;
  /** per-test captured output (APP-040) — failures carry the traceback + any stdout. */
  output: Record<string, string[]>;
  /** per-test failing source location (APP-040) — the nearest in-workspace frame. */
  sites: Record<string, { file: string; line: number }>;
}

/** Depth-first walk collecting every `case` id under the given node ids
 *  (a file/class id expands to its leaf cases; a case id is itself). */
export function caseIdsUnder(roots: readonly TestNodeView[], ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const out: string[] = [];
  const collect = (n: TestNodeView): void => {
    if (n.kind === "case") out.push(n.id);
    for (const c of n.children ?? []) collect(c);
  };
  const visit = (n: TestNodeView): void => {
    if (wanted.has(n.id)) {
      collect(n);
      return;
    }
    for (const c of n.children ?? []) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}

/** The ids a run actually sends: the selection as-is, or (run-all, `[]`) the root
 *  node ids — the ide:test.run schema refuses an empty id list by design. */
export function runTargetIds(roots: readonly TestNodeView[], ids: readonly string[]): string[] {
  return ids.length > 0 ? [...ids] : roots.map((r) => r.id);
}

/** The framework a node id targets — the documented discriminator, never a guess:
 *  testmgr discover ids are pytest-shaped (`rel/path.py::Class::test`); dotted
 *  unittest ids carry no `::` / path separator / `.py`. */
export function frameworkForId(id: string): IdeTestFramework {
  return id.includes("::") || id.includes("/") || id.endsWith(".py") ? "pytest" : "unittest";
}

/** Mark the targeted cases `running`, clearing their stale failure messages. */
export function markRunning(maps: RunMaps, caseIds: readonly string[]): RunMaps {
  const states = { ...maps.states };
  const messages = { ...maps.messages };
  const output = { ...maps.output };
  const sites = { ...maps.sites };
  for (const id of caseIds) {
    states[id] = "running";
    delete messages[id];
    delete output[id];
    delete sites[id];
  }
  return { states, messages, output, sites };
}

/** Fold one streamed per-test event in. Idempotent for duplicate events — the state
 *  is SET, never counted, and parents re-fold from child states at render time
 *  (test-view applyStates), so a replayed event cannot double-count. */
export function foldEvent(maps: RunMaps, ev: IdeTestEvent): RunMaps {
  const states = { ...maps.states, [ev.id]: ev.status };
  const messages = { ...maps.messages };
  if (ev.message) messages[ev.id] = ev.message;
  else delete messages[ev.id];
  // APP-040: the follow-up failure update carries output/file:line — merge (SET when
  // present, never clear), so a later status-only event can't wipe them.
  const output = { ...maps.output };
  if (ev.output && ev.output.length > 0) output[ev.id] = ev.output;
  const sites = { ...maps.sites };
  if (ev.file && typeof ev.line === "number") sites[ev.id] = { file: ev.file, line: ev.line };
  return { states, messages, output, sites };
}

/** Settle a finished run: cases still `running` never reported (collection error,
 *  early exit) — back to `pending`, never a fake verdict. */
export function settleRun(states: Record<string, TestState>): Record<string, TestState> {
  const out: Record<string, TestState> = {};
  for (const [id, s] of Object.entries(states)) out[id] = s === "running" ? "pending" : s;
  return out;
}

/** Settle a CRASHED run (the process died mid-stream): cases still `running` will
 *  never report → synthesize `fail` (APP-040), distinct from a clean early exit. */
export function settleCrashed(states: Record<string, TestState>): Record<string, TestState> {
  const out: Record<string, TestState> = {};
  for (const [id, s] of Object.entries(states)) out[id] = s === "running" ? "fail" : s;
  return out;
}

/* ── discover-tree projections (node id → file/line comes from HERE, never a
      second renderer discovery pass) ──────────────────────────────────────────────*/

/** One runnable case with a known source line (the gutter's unit). */
export interface CaseSite {
  id: string;
  line: number;
  label: string;
}

/** Every located case, keyed by the discover tree's (relative) file path. */
export function casesByFile(roots: readonly TestNodeView[]): Map<string, CaseSite[]> {
  const out = new Map<string, CaseSite[]>();
  const visit = (n: TestNodeView): void => {
    if (n.kind === "case" && typeof n.line === "number") {
      const list = out.get(n.file);
      const site = { id: n.id, line: n.line, label: n.label };
      if (list) list.push(site);
      else out.set(n.file, [site]);
    }
    for (const c of n.children ?? []) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}

/** Absolute path for a discover-tree file (testmgr emits root-relative paths). */
export function absTestPath(root: string, file: string): string {
  return file.startsWith("/") ? file : `${root.replace(/\/+$/, "")}/${file}`;
}

/** Root-relative discover path for an absolute file (null when outside the root). */
export function relTestPath(root: string, path: string): string | null {
  const base = root.replace(/\/+$/, "");
  if (path === base) return null;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/** The token-colored glyph class for a case's last status (idle = runnable ▶). */
export function glyphClassFor(state: TestState | undefined): string {
  switch (state) {
    case "pass":
      return "test-run-glyph-pass";
    case "fail":
    case "error":
      return "test-run-glyph-fail";
    case "running":
      return "test-run-glyph-running";
    case "skip":
      return "test-run-glyph-skip";
    default:
      return "test-run-glyph";
  }
}

/** One file's gutter decorations (first case wins a shared line — Monaco shows ONE). */
export function testGutterDecorations(
  cases: readonly CaseSite[],
  maps: Pick<RunMaps, "states" | "messages">,
): GutterDecorationInput[] {
  const seen = new Set<number>();
  const out: GutterDecorationInput[] = [];
  for (const c of cases) {
    if (seen.has(c.line)) continue;
    seen.add(c.line);
    const state = maps.states[c.id];
    const message = maps.messages[c.id];
    out.push({
      line: c.line,
      glyphClassName: glyphClassFor(state),
      hoverMessage: `Run ${c.label}${state ? ` — ${state}` : ""}${message ? `\n\n${message}` : ""}`,
      order: TEST_RUN_GLYPH_ORDER,
    });
  }
  return out;
}

/* ── the zustand slice ───────────────────────────────────────────────────────────*/

export interface TestRunStore {
  /** ABSOLUTE discover root (testmgr echoes it; node files are relative to it). */
  root: string | null;
  /** the raw discover tree — states/messages are applied at render time. */
  roots: TestNodeView[];
  states: Record<string, TestState>;
  messages: Record<string, string>;
  /** per-test captured output (APP-040) — the detail pane reads it by selected id. */
  output: Record<string, string[]>;
  /** per-test failing source location (APP-040) — the failure jump target. */
  sites: Record<string, { file: string; line: number }>;
  running: boolean;
  /** run-LEVEL failure (pytest missing, timeout, …) — per-case failures live in maps. */
  lastError: string | null;
  setDiscovered(root: string, roots: TestNodeView[]): void;
  begin(caseIds: string[]): void;
  applyEvent(ev: IdeTestEvent): void;
  finishOk(): void;
  /** the run crashed mid-stream: still-`running` cases → `fail`, keep what streamed. */
  finishCrashed(error: string): void;
  /** a gate/spawn failure BEFORE any event repaints NOTHING: restore the pre-run maps. */
  restore(snapshot: RunMaps, error: string): void;
}

/** Build an isolated store (tests); the app shares the `useTestRunStore` singleton. */
export function createTestRunStore(): ReturnType<typeof buildStore> {
  return buildStore();
}

function buildStore() {
  return create<TestRunStore>((set) => ({
    root: null,
    roots: [],
    states: {},
    messages: {},
    output: {},
    sites: {},
    running: false,
    lastError: null,
    setDiscovered: (root, roots): void => set({ root, roots }),
    begin: (caseIds): void =>
      set((s) => ({
        ...markRunning(
          { states: s.states, messages: s.messages, output: s.output, sites: s.sites },
          caseIds,
        ),
        running: true,
        lastError: null,
      })),
    applyEvent: (ev): void =>
      set((s) =>
        foldEvent({ states: s.states, messages: s.messages, output: s.output, sites: s.sites }, ev),
      ),
    finishOk: (): void => set((s) => ({ states: settleRun(s.states), running: false })),
    finishCrashed: (error): void =>
      set((s) => ({ states: settleCrashed(s.states), running: false, lastError: error })),
    restore: (snapshot, error): void =>
      set({
        states: snapshot.states,
        messages: snapshot.messages,
        output: snapshot.output,
        sites: snapshot.sites,
        running: false,
        lastError: error,
      }),
  }));
}

/** The app-wide run store the panel, the gutter wiring, and `runTests` share. */
export const useTestRunStore = buildStore();

/* ── run orchestration (the ONLY caller of the APP-013 run seam) ─────────────────*/

/** The slice of window.prometheus.ide a run needs (injected in tests). */
export interface TestRunIde {
  testRun(root: string, framework: IdeTestFramework, ids: string[]): Promise<IdeTestRunResult>;
  testRerunFailed(
    root: string,
    framework: IdeTestFramework,
    failedIds: string[],
  ): Promise<IdeTestRunResult>;
  onTestEvent(listener: (event: IdeTestEvent) => void): () => void;
}

function realIde(): TestRunIde | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/**
 * Run the given node ids (`[]` = run all roots; `rerun` sends them over the
 * rerun-failed verb verbatim). Re-entry while a run is live is a NO-OP (returns
 * null) — there is no cancel IPC, and a parallel run would interleave two event
 * streams on one channel. Events subscribe for this run's lifetime only.
 */
export async function runTests(
  ids: string[],
  opts: { rerun?: boolean } = {},
  store: Pick<typeof useTestRunStore, "getState"> = useTestRunStore,
  ide: TestRunIde | undefined = realIde(),
): Promise<IdeTestRunResult | null> {
  const s = store.getState();
  if (s.running || !s.root || !ide) return null;
  const targets = opts.rerun ? [...ids] : runTargetIds(s.roots, ids);
  if (targets.length === 0) return null;
  const framework = frameworkForId(targets[0] ?? "");
  const snapshot: RunMaps = {
    states: s.states,
    messages: s.messages,
    output: s.output,
    sites: s.sites,
  };
  s.begin(caseIdsUnder(s.roots, targets));
  let sawEvent = false;
  const unsubscribe = ide.onTestEvent((ev) => {
    sawEvent = true;
    store.getState().applyEvent(ev);
  });
  let result: IdeTestRunResult;
  try {
    result = opts.rerun
      ? await ide.testRerunFailed(s.root, framework, targets)
      : await ide.testRun(s.root, framework, targets);
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    unsubscribe();
  }
  if (result?.ok) store.getState().finishOk();
  // crashed mid-stream (events arrived, then a non-envelope failure) → keep the streamed
  // states + synthesize fail for the stragglers; a pre-event refusal repaints nothing.
  else if (sawEvent) store.getState().finishCrashed(result?.error ?? "test run crashed");
  else store.getState().restore(snapshot, result?.error ?? "test run failed");
  return result;
}

/* ── the APP-011 gutter provider wiring ──────────────────────────────────────────*/

/** The uri seam EditorPane injects (this module never imports monaco). */
export interface TestGutterUris {
  /** canonical model-uri string for an absolute path (monaco.Uri.file(p).toString()). */
  pathToModelUri(path: string): string;
  /** absolute fs path for a model uri, or null for a non-file scheme. */
  modelUriToPath(uri: string): string | null;
}

/**
 * Wire the `test-run` provider onto the APP-011 layer: discover/state changes REPLACE
 * the provider's per-file decoration set (sweeping files that emptied out), and a
 * glyph-margin click on a line THIS provider won runs exactly that case's node id.
 * Clicks another provider won (e.g. a breakpoint on the same line) are ignored —
 * the visible glyph and the click action stay in agreement. Returns an unwire fn
 * (tests; the app wires once for life).
 */
export function wireTestRunGutter(
  registry: Pick<GutterRegistry, "register" | "replaceForProvider" | "onGutterClick">,
  uris: TestGutterUris,
  store: Pick<typeof useTestRunStore, "getState" | "subscribe"> = useTestRunStore,
  run: (ids: string[]) => void = (ids) => void runTests(ids),
): () => void {
  registry.register(TEST_RUN_PROVIDER);
  let decorated = new Set<string>();
  const sync = (): void => {
    const { root, roots, states, messages } = store.getState();
    const next = new Set<string>();
    if (root) {
      for (const [file, cases] of casesByFile(roots)) {
        const uri = uris.pathToModelUri(absTestPath(root, file));
        next.add(uri);
        registry.replaceForProvider(
          TEST_RUN_PROVIDER,
          uri,
          testGutterDecorations(cases, { states, messages }),
        );
      }
    }
    for (const uri of decorated) {
      if (!next.has(uri)) registry.replaceForProvider(TEST_RUN_PROVIDER, uri, []);
    }
    decorated = next;
  };
  const unsubStore = store.subscribe(sync);
  sync();
  const unsubClick = registry.onGutterClick((e) => {
    if (e.providerId !== TEST_RUN_PROVIDER) return; // not our glyph (or none) on this line
    const path = uris.modelUriToPath(e.path);
    const { root, roots } = store.getState();
    if (path === null || !root) return;
    const rel = relTestPath(root, path);
    if (rel === null) return;
    const hit = casesByFile(roots)
      .get(rel)
      ?.find((c) => c.line === e.line);
    if (hit) run([hit.id]);
  });
  return () => {
    unsubStore();
    unsubClick();
  };
}
