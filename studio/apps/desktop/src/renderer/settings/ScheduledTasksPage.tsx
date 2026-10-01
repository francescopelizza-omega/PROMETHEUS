// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ScheduledTasksPage.tsx — Settings ▸ Scheduled Tasks.
 *
 * Before this page, "run this unattended, on a schedule, at a bounded autonomy level" was
 * infrastructure only — packages/core/src/agent/schedule.ts, the CLI's `session/schedule-store.ts`,
 * and this app's own `main/schedule-store.ts` — with no surface a user could actually see, add,
 * remove, or enable/disable a task from. This page is that surface.
 *
 * Every scheduled task defaults to READ-ONLY, mirroring the headless one-shot path
 * (session/one-shot.ts's `headlessAuthLevel`) this feature reuses rather than inventing a
 * second autonomy mechanism: `readonly` ⇒ no flags, `edits` ⇒ `--allow-writes`, `commands` ⇒
 * `--allow-commands`. The autonomy `StatusPill` (`autonomyPillStatus`) intentionally borrows
 * Settings' health-style ok/degraded/down coloring as a WARNING signal here, not a health one —
 * a user should feel a louder visual cue the more autonomy a schedule has been granted.
 *
 * Matches ModelHealthPage.tsx's conventions for the READ side (a live-polled table backed by
 * `useSchedules`) and HooksPage.tsx's for the WRITE side (an add/edit form with proactive
 * validation feedback gating Save): `Panel` from "@prometheus/ui" as the outer container,
 * plain inline `CSSProperties` objects (no CSS-in-JS/Tailwind), `var(--...)` tokens for every
 * color/space, and explicit loading/error/empty states rather than a blank screen.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the local `useSchedules` hook
 * (window.prometheus.schedule) + this dir's own pure `schedule-view.ts` only.
 */
import { EmptyState, Panel, StatusPill } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, type ReactNode, useState } from "react";

import { type ScheduledTaskView, useSchedules } from "../shared/schedule/useSchedules.js";
import {
  EMPTY_TASK_DRAFT,
  SCHEDULE_AUTONOMY_OPTIONS,
  type ScheduleTaskDraft,
  autonomyPillStatus,
  buildTaskFromDraft,
  describeNextRun,
  taskToDraft,
  validateCronField,
  validateTaskDraft,
} from "./schedule-view.js";

export function ScheduledTasksPage(): ReactElement {
  const { tasks, loading, error, refresh, upsert, remove } = useSchedules();
  const [draft, setDraft] = useState<ScheduleTaskDraft>(EMPTY_TASK_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nowMs = Date.now();

  const errors = validateTaskDraft(draft);

  const resetForm = (): void => {
    setDraft(EMPTY_TASK_DRAFT);
    setEditingId(null);
  };

  const editTask = (task: ScheduledTaskView): void => {
    setDraft(taskToDraft(task));
    setEditingId(task.id);
  };

  const save = async (): Promise<void> => {
    if (errors.length > 0) return;
    setPending(true);
    try {
      const existing = editingId ? tasks.find((t) => t.id === editingId) : undefined;
      const ok = await upsert(buildTaskFromDraft(draft, existing));
      if (ok) resetForm();
    } finally {
      setPending(false);
    }
  };

  const removeTask = async (id: string): Promise<void> => {
    setPending(true);
    try {
      await remove(id);
      if (editingId === id) resetForm();
    } finally {
      setPending(false);
    }
  };

  const toggleEnabled = async (task: ScheduledTaskView): Promise<void> => {
    setPending(true);
    try {
      await upsert({ ...task, enabled: !task.enabled });
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel
      title="Scheduled Tasks"
      elevation="e1"
      actions={
        <button type="button" style={refreshBtn} onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
        <p style={hintStyle}>
          Schedule the agent to run a task automatically, unattended, on a cron schedule. Every
          scheduled task defaults to{" "}
          <strong style={{ color: "var(--text-primary)" }}>READ-ONLY</strong> — it can look, but
          cannot change anything, unless you explicitly grant it more.
        </p>
        <p style={hintStyle}>
          A task added here is saved to the same store the <code>prometheus</code> CLI uses, but
          something still has to WAKE it up on schedule: run{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>prometheus tasks install-cron</code> in a
          terminal once to wire up the periodic check that actually executes due tasks. Without that
          cron entry installed, a task listed below will never run on its own.
        </p>

        {error && (
          <div style={{ color: "var(--danger)", padding: "var(--space-2, 4px) 0" }}>{error}</div>
        )}

        {!error && loading && tasks.length === 0 && (
          <div style={{ color: "var(--text-secondary)", padding: "var(--space-4, 8px) 0" }}>
            loading…
          </div>
        )}

        {!error && !loading && tasks.length === 0 && (
          <EmptyState
            title="No scheduled tasks yet"
            hint="Add one below — it stays read-only until you explicitly grant it more."
          />
        )}

        {tasks.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Schedule</th>
                  <th style={thStyle}>Autonomy</th>
                  <th style={thStyle}>Enabled</th>
                  <th style={thStyle}>Next run</th>
                  <th style={thStyle}>Last result</th>
                  <th style={thStyle} aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    nowMs={nowMs}
                    pending={pending}
                    onEdit={() => editTask(task)}
                    onRemove={() => void removeTask(task.id)}
                    onToggle={() => void toggleEnabled(task)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div
          style={{
            borderTop: "1px solid var(--border-subtle, var(--border-strong))",
            paddingTop: "var(--space-4, 8px)",
          }}
        >
          <TaskForm
            draft={draft}
            editingId={editingId}
            errors={errors}
            pending={pending}
            onChange={setDraft}
            onSave={() => void save()}
            onCancel={resetForm}
          />
        </div>
      </div>
    </Panel>
  );
}

function TaskRow({
  task,
  nowMs,
  pending,
  onEdit,
  onRemove,
  onToggle,
}: {
  task: ScheduledTaskView;
  nowMs: number;
  pending: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onToggle: () => void;
}): ReactElement {
  return (
    <tr style={{ ...rowStyle, opacity: task.enabled ? 1 : 0.55 }}>
      <td style={tdStyle}>
        <div style={{ fontWeight: 600 }}>{task.name}</div>
        {task.cwd && (
          <div
            style={{
              color: "var(--text-secondary)",
              fontSize: "0.68rem",
              fontFamily: "var(--font-mono)",
            }}
          >
            {task.cwd}
          </div>
        )}
      </td>
      <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{task.cronExpr}</td>
      <td style={tdStyle}>
        <StatusPill
          status={autonomyPillStatus(task.autonomy)}
          label={task.autonomy}
          title={SCHEDULE_AUTONOMY_OPTIONS.find((o) => o.value === task.autonomy)?.hint}
        />
      </td>
      <td style={tdStyle}>
        <input
          type="checkbox"
          checked={task.enabled}
          onChange={onToggle}
          disabled={pending}
          aria-label={`enabled: ${task.name}`}
        />
      </td>
      <td style={tdStyle}>{task.enabled ? describeNextRun(task.cronExpr, nowMs) : "—"}</td>
      <td style={tdStyle}>
        {task.lastResult ? (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2, 4px)" }}>
            <StatusPill
              status={task.lastResult.ok ? "ok" : "down"}
              label={task.lastResult.ok ? "ok" : "failed"}
              title={task.lastResult.ranIso}
            />
            <span
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.72rem",
                maxWidth: 220,
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                whiteSpace: "nowrap",
              }}
              title={task.lastResult.summary}
            >
              {task.lastResult.summary}
            </span>
          </div>
        ) : (
          <span style={{ color: "var(--text-secondary)" }}>never run</span>
        )}
      </td>
      <td style={tdStyle}>
        <button
          type="button"
          style={linkBtn}
          disabled={pending}
          onClick={onEdit}
          aria-label={`edit ${task.name}`}
        >
          Edit
        </button>
        <button
          type="button"
          style={linkBtn}
          disabled={pending}
          onClick={onRemove}
          aria-label={`remove ${task.name}`}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

function TaskForm({
  draft,
  editingId,
  errors,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ScheduleTaskDraft;
  editingId: string | null;
  errors: string[];
  pending: boolean;
  onChange: (draft: ScheduleTaskDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}): ReactElement {
  const cronError = validateCronField(draft.cronExpr);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
      <strong style={{ fontSize: "0.8125rem" }}>{editingId ? "Edit task" : "Add task"}</strong>

      <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
        <Field label="Name" style={{ flex: "1 1 200px" }}>
          <input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.currentTarget.value })}
            aria-label="name"
            placeholder="Summarize today's commits"
            style={inputStyle}
          />
        </Field>
        <Field
          label="Cron expression (minute hour day-of-month month day-of-week)"
          style={{ flex: "1 1 220px" }}
        >
          <input
            value={draft.cronExpr}
            onChange={(e) => onChange({ ...draft, cronExpr: e.currentTarget.value })}
            aria-label="cron expression"
            placeholder="0 9 * * *"
            style={{
              ...inputStyle,
              fontFamily: "var(--font-mono)",
              borderColor: cronError ? "var(--danger)" : undefined,
            }}
          />
          {cronError && (
            <span style={{ color: "var(--danger)", fontSize: "0.7rem" }}>{cronError}</span>
          )}
        </Field>
        <Field label="Autonomy" style={{ flex: "0 0 160px" }}>
          <select
            value={draft.autonomy}
            onChange={(e) =>
              onChange({
                ...draft,
                autonomy: e.currentTarget.value as ScheduleTaskDraft["autonomy"],
              })
            }
            aria-label="autonomy"
            style={inputStyle}
          >
            {SCHEDULE_AUTONOMY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} title={opt.hint}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Working directory (optional)" style={{ flex: "1 1 200px" }}>
          <input
            value={draft.cwd}
            onChange={(e) => onChange({ ...draft, cwd: e.currentTarget.value })}
            aria-label="working directory"
            placeholder="wherever the runner itself runs"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
          />
        </Field>
      </div>

      <Field label="Task prompt">
        <textarea
          value={draft.task}
          onChange={(e) => onChange({ ...draft, task: e.currentTarget.value })}
          aria-label="task prompt"
          placeholder="Summarize today's commits and post to #eng-updates"
          rows={3}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-ui)" }}
        />
      </Field>

      {errors.length > 0 && (
        <ul
          aria-label="validation errors"
          style={{ margin: 0, paddingLeft: "var(--space-5, 10px)", color: "var(--danger)" }}
        >
          {errors.map((e) => (
            <li key={e} style={{ fontSize: "0.75rem" }}>
              {e}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: "var(--space-2, 4px)" }}>
        <button
          type="button"
          disabled={errors.length > 0 || pending}
          onClick={onSave}
          style={primaryBtn}
        >
          {editingId ? "Save changes" : "Add task"}
        </button>
        <button type="button" onClick={onCancel} style={secondaryBtn} disabled={pending}>
          Clear
        </button>
      </div>
    </div>
  );
}

function Field({
  label: l,
  children,
  style,
}: {
  label: string;
  children: ReactNode;
  style?: CSSProperties;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, ...style }}>
      <span style={fieldLabelStyle}>{l}</span>
      {children}
    </div>
  );
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8125rem",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  color: "var(--text-secondary)",
  fontWeight: 500,
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  borderBottom: "1px solid var(--border-strong)",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  borderBottom: "1px solid var(--border-subtle, var(--border-strong))",
  verticalAlign: "middle",
};

const rowStyle: CSSProperties = {
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const refreshBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "0.75rem",
};

const fieldLabelStyle: CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-ui)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg-inset)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px)",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const linkBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--accent)",
  cursor: "pointer",
  fontSize: "0.72rem",
  fontFamily: "var(--font-ui)",
  padding: "0 var(--space-1, 2px)",
};

const primaryBtn: CSSProperties = {
  background: "var(--accent)",
  color: "var(--bg-app)",
  border: "none",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const secondaryBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

export default ScheduledTasksPage;
