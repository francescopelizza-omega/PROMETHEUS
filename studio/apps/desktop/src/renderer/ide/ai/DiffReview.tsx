// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/ai/DiffReview.tsx — the AI ChangeSet accept/reject UI (file 07 §7.4).
 *
 * The heart of "AI edits apply safely": a model proposal is NEVER applied directly.
 * It is a ChangeSet — files → hunks, each independently accept/reject-able — rendered
 * as a tree. The SELECTION MATH is the pure diff-review-state module (node:test-ed);
 * this component is the thin view + the Apply action. **Apply** writes the accepted
 * hunks through window.prometheus.ide.fsWrite in one batch and FLAGS AI-authored NEW
 * files for the next run-gate (§5.2) — AI code is untrusted-until-gated, like cloned
 * code. JS decides nothing about safety; the gate verdict is the engine's (C5).
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the pure selection state +
 * window.prometheus only.
 */

import { Button, Panel, PermissionCard } from "@prometheus/ui";
import { type ReactElement, useMemo, useState } from "react";
import {
  type PermissionQueues,
  answerHeadFor,
  clearFor,
  headFor,
  raiseFor,
} from "./permission-queue.js";

import { authLevelVar, useAuthorisationStore } from "../../stores/authorisation.js";
import { useTabsStore } from "../state/stores.js";
import {
  type PendingWrite,
  grant,
  isInsideRoots,
  needsPermission,
  toPath,
} from "./permission-gate.js";

import {
  type DiffSelection,
  type ReviewChangeSet,
  type ReviewFile,
  acceptAll,
  acceptFile,
  acceptedOf,
  applyReviewFile,
  buildApplyPlan,
  changeSetTriState,
  fileTriState,
  rejectAll,
  rejectFile,
  verifyHunksAgainstBase,
} from "../state/diff-review-state.js";
import { enqueueGateUris } from "../state/gate-queue.js";
import { useAiSessionStore } from "../state/stores.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

function basename(uri: string): string {
  const s = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

/** One file node: tri-state header + its hunks (green add / red remove diff).
 *  `locked` freezes every control while an Apply for this session is in flight —
 *  a mid-apply toggle would silently diverge from the plan already being written. */
function FileNode({ file, locked }: { file: ReviewFile; locked: boolean }): ReactElement {
  const selection = useAiSessionStore((s) => s.sessions[s.activeId]?.selection ?? {});
  const toggle = useAiSessionStore((s) => s.toggleHunk);
  const setSelection = useAiSessionStore((s) => s.setSelection);
  const accepted = acceptedOf(selection, file.uri);
  const tri = fileTriState(file, selection);

  return (
    <div style={{ marginBottom: 8 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 600,
          fontSize: "0.8rem",
          cursor: file.hunks.length > 0 && !locked ? "pointer" : "default",
          color: "var(--text-primary)",
        }}
      >
        <input
          type="checkbox"
          checked={tri === "all"}
          disabled={locked || file.hunks.length === 0}
          // `indeterminate` is NOT a React-controlled attribute — set it imperatively.
          ref={(el) => {
            if (el) el.indeterminate = tri === "partial";
          }}
          onChange={() =>
            setSelection(tri === "all" ? rejectFile(selection, file) : acceptFile(selection, file))
          }
          aria-label={`accept all hunks in ${basename(file.uri)}`}
        />
        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{basename(file.uri)}</span>
        {file.isNew && <span style={{ color: "var(--ok)" }}>new</span>}
        {file.isDelete && <span style={{ color: "var(--danger)" }}>delete</span>}
        {file.hunks.length === 0 && (
          <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>no changes</span>
        )}
      </label>
      {file.hunks.map((h) => {
        const on = accepted.includes(h.id);
        return (
          <label
            key={h.id}
            style={{
              display: "block",
              marginLeft: 18,
              marginTop: 4,
              cursor: locked ? "default" : "pointer",
              opacity: on ? 1 : 0.5,
              borderLeft: `2px solid ${on ? "var(--accent)" : "var(--border-subtle)"}`,
              paddingLeft: 6,
            }}
          >
            <input
              type="checkbox"
              checked={on}
              disabled={locked}
              onChange={() => toggle(file.uri, h.id)}
              aria-label={`hunk ${h.id}`}
            />
            <pre
              style={{
                margin: "2px 0 0",
                fontSize: "0.72rem",
                fontFamily: "var(--font-mono, monospace)",
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
              }}
            >
              {h.oldLines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positionally stable
                <div key={`o${i}`} style={{ color: "var(--danger)" }}>
                  {`- ${l}`}
                </div>
              ))}
              {h.newLines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positionally stable
                <div key={`n${i}`} style={{ color: "var(--ok)" }}>
                  {`+ ${l}`}
                </div>
              ))}
            </pre>
          </label>
        );
      })}
    </div>
  );
}

/** The per-file outcome of an Apply: successes proceed, failures stay reviewable. */
interface ApplyOutcome {
  /** uris written successfully. */
  applied: string[];
  /** per-file write/read failures (their hunks stay selected for a retry). */
  failures: { uri: string; message: string }[];
  /** successfully WRITTEN AI-authored new files — these must reach the run-gate. */
  gated: string[];
}

/** Apply the accepted hunks: read each file, splice via the PURE applyReviewFile, fsWrite.
 *  Failures are contained PER FILE — one EACCES never aborts the rest of the plan. */
async function applyChangeSet(
  cs: ReviewChangeSet,
  selection: Record<string, string[]>,
): Promise<ApplyOutcome> {
  const plan = buildApplyPlan(cs, selection);
  if (plan.empty) return { applied: [], failures: [], gated: [] };
  const api = ide();
  // the bridge being absent means NOTHING was written — throw so onApply surfaces the
  // error and keeps the panel open, instead of clearing the set as if it applied (#16b).
  if (!api) throw new Error("editor bridge unavailable — no changes were written");
  const out: ApplyOutcome = { applied: [], failures: [], gated: [] };
  for (const f of plan.files) {
    const edit = cs.edits.find((e) => e.uri === f.uri);
    if (!edit) continue;
    try {
      let before = "";
      if (edit.isNew) {
        // creating a file that ALREADY exists would silently overwrite whatever
        // appeared between propose and apply — fail that file closed instead.
        const probe = await api.fsRead(f.uri);
        if (probe.ok) throw new Error("file already exists on disk — re-propose against it");
      } else {
        const read = await api.fsRead(f.uri);
        // an unreadable base must NOT silently splice against "" (that would rewrite
        // the file from scratch) — it is a per-file failure, hunks stay pending.
        if (!read.ok || read.text === undefined) {
          throw new Error(read.error ?? "could not read the current file");
        }
        before = read.text;
        // FAIL-CLOSED drift guard: hunks are anchored to the content they were
        // computed against; a stale anchor would splice garbage silently.
        const drift = verifyHunksAgainstBase(before, edit, f.acceptedHunkIds);
        if (drift) throw new Error(drift);
      }
      // a FULLY-accepted delete really deletes (the red badge must not mean
      // "truncate to zero bytes"); a partial accept splices like any other edit.
      const fullDelete =
        edit.isDelete === true &&
        edit.hunks.length > 0 &&
        f.acceptedHunkIds.length === edit.hunks.length;
      if (fullDelete) {
        const gone = await api.fsDelete(
          f.uri.startsWith("file://") ? f.uri.slice("file://".length) : f.uri,
        );
        if (!gone.ok) throw new Error(gone.error ?? "delete failed");
      } else {
        // the deterministic, node:test-ed bottom-up splice (positions come from core).
        const after = applyReviewFile(before, edit, f.acceptedHunkIds);
        const wrote = await api.fsWrite(f.uri, after);
        if (!wrote.ok) throw new Error(wrote.error ?? "write failed");
      }
      out.applied.push(f.uri);
      if (edit.isNew) out.gated.push(f.uri);
    } catch (err) {
      out.failures.push({ uri: f.uri, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** The DiffReview pane: header controls + the file→hunk tree + Apply. */
/** Describe every file the plan would touch, for the §3 permission queue. */
function pendingWrites(
  cs: ReviewChangeSet,
  selection: Record<string, string[]>,
  roots: readonly string[],
): PendingWrite[] {
  const plan = buildApplyPlan(cs, selection);
  if (plan.empty) return [];
  const out: PendingWrite[] = [];
  for (const f of plan.files) {
    const edit = cs.edits.find((e) => e.uri === f.uri);
    if (!edit) continue;
    const path = toPath(f.uri);
    const fullDelete =
      edit.isDelete === true &&
      edit.hunks.length > 0 &&
      f.acceptedHunkIds.length === edit.hunks.length;
    out.push({
      uri: f.uri,
      path,
      insideWorkingSet: isInsideRoots(path, roots),
      change: fullDelete ? "delete" : edit.isNew ? "new file" : "modify",
      magnitude: `${f.acceptedHunkIds.length} hunk${f.acceptedHunkIds.length === 1 ? "" : "s"}`,
    });
  }
  return out;
}

export function DiffReview(): ReactElement | null {
  const activeId = useAiSessionStore((s) => s.activeId);
  const cs = useAiSessionStore((s) => s.sessions[s.activeId]?.changeSet ?? null);
  const selection = useAiSessionStore((s) => s.sessions[s.activeId]?.selection ?? {});
  const clear = useAiSessionStore((s) => s.clearChangeSet);
  const setSelection = useAiSessionStore((s) => s.setSelection);

  // apply state is PER SESSION — one pane instance renders whichever tab is active,
  // so a flat boolean would let tab A's in-flight apply disable tab B's controls and
  // paint A's error under B's changeset.
  const [applyingBy, setApplyingBy] = useState<Record<string, boolean>>({});
  /**
   * §3: the permission QUEUE — the writes still awaiting a human, KEYED BY SESSION.
   *
   * This was flat component state while `applyingBy`/`errorBy` above were already per-session,
   * with a comment explaining exactly why. A card raised for tab A therefore stayed on screen
   * after switching to tab B, and approving it ran the apply against B's ChangeSet: B's files
   * written on a permission granted for a path in tab A, with B's own paths never shown, while
   * A's approved apply silently never happened. Per-session, switching tabs shows that tab's own
   * queue — so there is no card to mis-answer.
   */
  const [pendingBy, setPendingBy] = useState<PermissionQueues<PendingWrite>>({});
  const pending = pendingBy[activeId] ?? [];
  const authLevel = useAuthorisationStore((st) => st.level);
  const workspaceRoot = useTabsStore((st) => st.workspaceRoot);
  const roots = useMemo(() => (workspaceRoot ? [workspaceRoot] : []), [workspaceRoot]);
  const [errorBy, setErrorBy] = useState<Record<string, string | null>>({});
  const applying = applyingBy[activeId] === true;
  const applyError = errorBy[activeId] ?? null;

  const plan = useMemo(() => (cs ? buildApplyPlan(cs, selection) : null), [cs, selection]);
  if (!cs) return null;
  const tri = changeSetTriState(cs, selection);
  const totalHunks = cs.edits.reduce((n, f) => n + f.hunks.length, 0);

  // Apply the accepted hunks; failures are contained per file — the panel stays open
  // with ONLY the failed files' hunks still selected (applied files must never be
  // re-appliable: their anchors are stale once the file changed on disk). The OWNING
  // session id + changeset snapshot are captured at CLICK time: the user may switch
  // tabs (or the agent may re-dispatch) while fsWrite is in flight, and the
  // continuation must never clear or re-select whatever is live by then.
  /** Write, for real. Only ever called once every pending write has been answered. */
  const runApply = (): void => {
    const sid = activeId;
    const appliedCs = cs;
    setErrorBy((m) => ({ ...m, [sid]: null }));
    setApplyingBy((m) => ({ ...m, [sid]: true }));
    void applyChangeSet(appliedCs, selection)
      .then((out) => {
        // written new files are untrusted-until-gated (§5.2) even when a sibling
        // failed — queue first (the editor route's listener may be unmounted).
        if (out.gated.length > 0) {
          enqueueGateUris(out.gated);
          window.dispatchEvent(new CustomEvent("ide:gate-new-files", { detail: out.gated }));
        }
        // only touch the store if the session STILL holds the snapshot we applied —
        // a newer agent dispatch owns the pane otherwise (its anchors are its own).
        const live = useAiSessionStore.getState().sessions[sid]?.changeSet ?? null;
        if (live !== appliedCs) return;
        if (out.failures.length === 0) {
          clear(sid);
          return;
        }
        const failed = new Set(out.failures.map((f) => f.uri));
        const next: DiffSelection = {};
        for (const e of appliedCs.edits)
          next[e.uri] = failed.has(e.uri) ? acceptedOf(selection, e.uri) : [];
        setSelection(next, sid);
        setErrorBy((m) => ({
          ...m,
          [sid]: out.failures.map((f) => `${basename(f.uri)}: ${f.message}`).join(" · "),
        }));
      })
      .catch((err: unknown) => {
        setErrorBy((m) => ({ ...m, [sid]: err instanceof Error ? err.message : String(err) }));
      })
      .finally(() => setApplyingBy((m) => ({ ...m, [sid]: false })));
  };

  /**
   * §3: NOTHING reaches disk before the human has seen the exact absolute path. Apply
   * first asks core's ladder which of the planned writes need asking about; if any do,
   * it raises the permission card instead of writing. The applier guard in MAIN is
   * still on either way — this is the visible half, not the enforcing half.
   */
  const onApply = (): void => {
    if (!cs) return;
    const sid = activeId; // the session this card belongs to, captured now
    const asks = pendingWrites(cs, selection, roots).filter(needsPermission);
    if (asks.length > 0) {
      setPendingBy((m) => raiseFor(m, sid, asks));
      return;
    }
    runApply();
  };

  /** Answer the card at the head of the queue. Deny cancels the WHOLE apply. */
  const answer = (decision: "once" | "session" | "deny"): void => {
    // The card on screen is the ACTIVE session's own head — that is what per-session keying
    // buys — so the sid captured here is the one the permission was granted for.
    const sid = activeId;
    const head = headFor(pendingBy, sid);
    if (!head) return;
    if (decision === "deny") {
      setPendingBy((m) => clearFor(m, sid));
      setErrorBy((m) => ({ ...m, [sid]: `denied: ${head.path} was not written` }));
      return;
    }
    void grant(head, decision).then(() => {
      // Computed from the queue we READ, not captured inside the updater — a state updater may
      // be invoked more than once, so a variable assigned inside it is not a reliable signal.
      const { drained } = answerHeadFor(pendingBy, sid);
      setPendingBy((m) => answerHeadFor(m, sid).queues);
      if (drained) runApply();
    });
  };

  return (
    <Panel
      title={`AI changes · ${cs.rationale}`}
      elevation="e2"
      actions={
        <div style={{ display: "flex", gap: 6 }}>
          <Button
            size="sm"
            variant="ghost"
            disabled={applying}
            onClick={() => setSelection(acceptAll(cs))}
          >
            {tri === "all" ? "Accept all ✓" : "Accept all"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={applying}
            onClick={() => setSelection(rejectAll(cs))}
          >
            Reject all
          </Button>
          <Button size="sm" variant="ghost" disabled={applying} onClick={() => clear()}>
            ✕ Discard
          </Button>
        </div>
      }
    >
      {/* §9: no fixed-px pane height. The changeset list grows with the rail and caps at
          a fraction of the VIEWPORT, so a tall window shows more files instead of the
          same 320px slice. */}
      <div style={{ maxHeight: "min(52vh, 720px)", overflow: "auto" }}>
        {totalHunks === 0 && (
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.78rem" }}>
            no changes — the proposal matches the current file content.
          </p>
        )}
        {cs.edits.map((f) => (
          <FileNode key={f.uri} file={f} locked={applying} />
        ))}
      </div>
      {/* §3: the permission card — one exact path at a time, ahead of any write. */}
      {pending[0] && (
        <div style={{ marginTop: 8 }}>
          <PermissionCard
            kind={pending[0].change === "delete" ? "delete file" : "write file"}
            target={pending[0].path}
            insideWorkingSet={pending[0].insideWorkingSet}
            change={pending[0].change}
            {...(pending[0].magnitude ? { magnitude: pending[0].magnitude } : {})}
            authLevel={authLevel}
            authVar={authLevelVar(authLevel)}
            onAllowOnce={() => answer("once")}
            onAllowSession={() => answer("session")}
            onDeny={() => answer("deny")}
          >
            {pending.length > 1 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {pending.length - 1} more file{pending.length - 1 === 1 ? "" : "s"} after this one
              </span>
            )}
          </PermissionCard>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <Button
          variant="primary"
          disabled={!plan || plan.empty || applying || pending.length > 0}
          onClick={onApply}
        >
          {applying ? "Applying…" : pending.length > 0 ? "Awaiting permission…" : "Apply selected"}
        </Button>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.75rem" }}>
          {plan ? `${plan.files.length} file(s)` : ""}
          {plan && plan.newFilesToGate.length > 0
            ? ` · ${plan.newFilesToGate.length} new → run-gate`
            : ""}
        </span>
        {applyError ? (
          <span style={{ color: "var(--danger)", fontSize: "0.75rem" }} role="alert">
            apply failed: {applyError}
          </span>
        ) : null}
      </div>
    </Panel>
  );
}

export default DiffReview;

// re-export so AgentPane can seed an accept-all selection without a second import.
export { acceptAll };
