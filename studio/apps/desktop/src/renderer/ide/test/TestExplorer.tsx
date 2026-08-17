/**
 * TestExplorer.tsx — the Test tool window (file 14 §3.19, mounted+run-wired APP-014).
 *
 * The container (default export, mounted for the `test` activity) AST-discovers tests
 * via the testmgr sidecar (`window.prometheus.ide.testDiscover`, never executes target
 * code) into the shared test-run store, and wires Run all / per-node ▶ / Rerun-failed
 * to the APP-013 run seam (`runTests` — re-entry-guarded, event-streamed). Clicking a
 * node (or a failure message) opens its file and reveals the test's line. The panel
 * itself (`TestExplorerPanel`) stays presentational + controlled: a pass/fail/skip
 * tree with token-colored status glyphs, a filter, a stat header, run actions.
 * Coverage gutters live in the editor. No raw hex (C5 sandbox — no core import).
 */
import { Button, Panel } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import { pathToFileUri } from "../state/breakpoint-store.js";
import { detectLanguage } from "../state/lang-detect.js";
import { useTabsStore } from "../state/stores.js";
import { absTestPath, runTests, useTestRunStore } from "./test-run-store.js";
import {
  type TestNodeView,
  applyStates,
  computeStats,
  failedCaseIds,
  filterTests,
  statLine,
  statusGlyph,
} from "./test-view.js";

export interface TestExplorerPanelProps {
  roots: readonly TestNodeView[];
  selectedId?: string;
  /** a run is live — run affordances disable (re-entry is a no-op, never parallel). */
  running?: boolean;
  /** run-LEVEL failure (pytest missing, timeout, …) surfaced above the tree. */
  lastError?: string | null;
  /** discover/refresh the tree (re-runs testmgr discover). */
  onRefresh?: () => void;
  /** run specific node ids (empty = run all). */
  onRun?: (ids: string[]) => void;
  /** rerun ONLY the previous run's failed case ids (the rerun-failed verb). */
  onRerunFailed?: (failedIds: string[]) => void;
  onSelect?: (id: string) => void;
}

const STATE_ROLE: Record<string, string> = {
  pass: "ok",
  fail: "danger",
  error: "danger",
  skip: "text-secondary",
  running: "accent",
  pending: "text-secondary",
};

function Node({
  node,
  depth,
  selectedId,
  running,
  onSelect,
  onRun,
}: {
  node: TestNodeView;
  depth: number;
  selectedId?: string;
  running?: boolean;
  onSelect?: (id: string) => void;
  onRun?: (ids: string[]) => void;
}): ReactElement {
  const role = STATE_ROLE[node.state ?? "pending"] ?? "text-secondary";
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2, 4px)",
          paddingLeft: `calc(var(--space-2, 4px) + ${depth * 14}px)`,
          background: node.id === selectedId ? "var(--bg-inset)" : "transparent",
          fontSize: "var(--text-small-size, 0.8125rem)",
        }}
      >
        <span aria-hidden="true" style={{ color: `var(--${role})`, width: "1ch" }}>
          {statusGlyph(node.state)}
        </span>
        <button
          type="button"
          onClick={() => onSelect?.(node.id)}
          style={{
            flex: 1,
            textAlign: "left",
            background: "transparent",
            border: "none",
            color: "var(--text-primary)",
            cursor: "pointer",
            fontFamily: "var(--font-ui)",
          }}
        >
          {node.label}
        </button>
        <button
          type="button"
          aria-label={`Run ${node.label}`}
          disabled={running}
          onClick={() => onRun?.([node.id])}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: running ? "default" : "pointer",
            opacity: running ? 0.4 : 1,
          }}
        >
          ▶
        </button>
      </div>
      {node.message && (node.state === "fail" || node.state === "error") && (
        <button
          type="button"
          onClick={() => onSelect?.(node.id)}
          title="Jump to test source"
          style={{
            textAlign: "left",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--danger)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            fontFamily: "var(--font-ui)",
            paddingLeft: `calc(var(--space-4, 12px) + ${depth * 14}px)`,
            whiteSpace: "pre-wrap",
            overflowWrap: "break-word",
          }}
        >
          {node.message}
        </button>
      )}
      {(node.children ?? []).map((c) => (
        <Node
          key={c.id}
          node={c}
          depth={depth + 1}
          selectedId={selectedId}
          running={running}
          onSelect={onSelect}
          onRun={onRun}
        />
      ))}
    </>
  );
}

/** The §3.19 Test Explorer panel (presentational; the container below feeds it). */
export function TestExplorerPanel({
  roots,
  selectedId,
  running,
  lastError,
  onRefresh,
  onRun,
  onRerunFailed,
  onSelect,
}: TestExplorerPanelProps): ReactElement {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => filterTests(roots, filter), [roots, filter]);
  const stats = useMemo(() => computeStats(roots), [roots]);
  const failed = useMemo(() => failedCaseIds(roots), [roots]);

  return (
    <Panel title="Tests" elevation="e1">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3, 6px)",
          marginBottom: "var(--space-2, 4px)",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{ fontSize: "var(--text-small-size, 0.8125rem)", color: "var(--text-secondary)" }}
        >
          {running ? "⧖ running…" : statLine(stats)}
        </span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          placeholder="filter tests…"
          aria-label="Filter tests"
          style={{
            flex: 1,
            minWidth: 120,
            background: "var(--bg-inset)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "var(--space-1, 2px) var(--space-2, 4px)",
          }}
        />
        <Button
          variant="secondary"
          disabled={running || roots.length === 0}
          onClick={() => onRun?.([])}
        >
          {running ? "Running…" : "Run all"}
        </Button>
        <Button
          variant="secondary"
          disabled={running || failed.length === 0}
          onClick={() => onRerunFailed?.(failed)}
        >
          Rerun failed ({failed.length})
        </Button>
        {onRefresh && (
          <Button variant="ghost" disabled={running} onClick={onRefresh}>
            ⟲
          </Button>
        )}
      </div>
      {lastError && (
        <div
          role="alert"
          style={{
            color: "var(--danger)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            marginBottom: "var(--space-2, 4px)",
            whiteSpace: "pre-wrap",
            overflowWrap: "break-word",
          }}
        >
          {lastError}
        </div>
      )}
      <div
        role="tree"
        style={{ display: "flex", flexDirection: "column", gap: 1, fontFamily: "var(--font-ui)" }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              color: "var(--text-secondary)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              padding: "var(--space-3, 6px)",
            }}
          >
            no tests {filter ? `match “${filter}”` : "discovered"}
          </div>
        ) : (
          filtered.map((n) => (
            <Node
              key={n.id}
              node={n}
              depth={0}
              selectedId={selectedId}
              running={running}
              onSelect={onSelect}
              onRun={onRun}
            />
          ))
        )}
      </div>
    </Panel>
  );
}

/* ── the container (mounted for `activity === "test"`) ───────────────────────────*/

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Find a node by id in the tree (depth-first). */
function findNode(nodes: readonly TestNodeView[], id: string): TestNodeView | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const child = n.children && findNode(n.children, id);
    if (child) return child;
  }
  return undefined;
}

/** The Test activity: discovery into the shared run store + live run wiring. */
export function TestExplorer({ root }: { root: string }): ReactElement {
  const roots = useTestRunStore((s) => s.roots);
  const states = useTestRunStore((s) => s.states);
  const messages = useTestRunStore((s) => s.messages);
  const output = useTestRunStore((s) => s.output);
  const sites = useTestRunStore((s) => s.sites);
  const running = useTestRunStore((s) => s.running);
  const lastError = useTestRunStore((s) => s.lastError);
  const discoveredRoot = useTestRunStore((s) => s.root);
  const setDiscovered = useTestRunStore((s) => s.setDiscovered);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const open = useTabsStore((s) => s.open);

  const discover = useCallback(async (): Promise<void> => {
    setStatus("loading");
    try {
      const r = await ide()?.testDiscover(root);
      if (r?.ok) {
        // the testmgr tree is field-identical to TestNodeView (id/kind/label/file/line/
        // children); node→file/line for the gutter + failure jumps reads from THIS tree.
        setDiscovered(r.root ?? root, r.roots as TestNodeView[]);
        setStatus("ready");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }, [root, setDiscovered]);

  useEffect(() => {
    void discover();
  }, [discover]);

  // fold the live per-case states/messages onto the raw discover tree (parents
  // re-aggregate from child states on every fold — order-independent).
  const applied = useMemo(() => {
    const st = new Map(Object.entries(states));
    const ms = new Map(Object.entries(messages));
    return roots.map((n) => applyStates(n, st, ms));
  }, [roots, states, messages]);

  const onSelect = useCallback(
    (id: string): void => {
      setSelectedId(id);
      const node = findNode(applied, id);
      // APP-040: prefer the FAILING traceback file:line; fall back to the test's AST line.
      const site = sites[id];
      const file = site?.file ?? node?.file;
      const line = site?.line ?? node?.line;
      if (!file || !discoveredRoot) return;
      const abs = absTestPath(discoveredRoot, file);
      open(pathToFileUri(abs), {
        name: abs.split(/[/\\]/).pop() ?? abs,
        languageId: detectLanguage(abs),
        preview: true,
      });
      // reveal after the async model swap settles (the DebugPanel jump pattern);
      // testmgr lines are 1-based and Monaco reveal is 1-based too.
      if (typeof line === "number") {
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("ide:reveal-position", { detail: { line, column: 1 } }),
          );
        }, 160);
      }
    },
    [applied, sites, discoveredRoot, open],
  );

  if (status === "error") {
    return (
      <div
        style={{
          padding: "var(--space-3, 8px)",
          color: "var(--text-secondary)",
          fontSize: "var(--text-small-size, 0.8125rem)",
        }}
      >
        No tests discovered (the testmgr sidecar needs python3 + a project with test_*.py /
        *_test.py files).
      </div>
    );
  }

  const selectedOutput = selectedId ? output[selectedId] : undefined;
  return (
    <>
      <TestExplorerPanel
        roots={applied}
        selectedId={selectedId}
        running={running}
        lastError={lastError}
        onRefresh={() => void discover()}
        onRun={(ids) => void runTests(ids)}
        onRerunFailed={(failedIds) => void runTests(failedIds, { rerun: true })}
        onSelect={onSelect}
      />
      {selectedOutput && selectedOutput.length > 0 && (
        <div
          style={{
            marginTop: "var(--space-2, 4px)",
            borderTop: "1px solid var(--border-strong)",
            maxHeight: 200,
            overflow: "auto",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-small-size, 0.8125rem)",
              color: "var(--text-secondary)",
              padding: "var(--space-2, 4px)",
            }}
          >
            output · {selectedId}
          </div>
          <pre
            style={{
              margin: 0,
              padding: "0 var(--space-3, 6px) var(--space-2, 4px)",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word",
              color: "var(--text-primary)",
            }}
          >
            {selectedOutput.join("\n")}
          </pre>
        </div>
      )}
    </>
  );
}

export default TestExplorer;
