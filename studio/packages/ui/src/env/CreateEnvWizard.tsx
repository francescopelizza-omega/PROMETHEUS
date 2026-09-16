/**
 * CreateEnvWizard.tsx — the three-step Create-Environment wizard (file 04 §3.3).
 *
 *   ① Interpreter   base interpreter + kind (venv/virtualenv/conda) + name + location
 *   ② Template      pick a template; edit its package list (check/uncheck/edit rows)
 *   ③ Review & gate per-package gate PLAN — "Will: create → gate N fetches → install"
 *
 * The "Create & scan" button NEVER installs blind: step ③ shows the gate plan the
 * host built (one item per checked package), and the host runs the REAL nemesis on
 * each before installing the cleared subset. This component is PRESENTATIONAL: it
 * owns only the wizard's local form state; the interpreters / templates / gpu and
 * the `onCreate` commit are PROPS. It performs NO IPC and renders every engine
 * string as inert text (C5). Imports only react + this package.
 */

import { type ReactElement, useMemo, useState } from "react";
import { GateBadge } from "./GateBadge.js";
import type { GatePlanItemData, GpuInfoData, TemplateData } from "./types.js";
import { type WizardPkgRow, createStepValid, inert, plannedCount, roleVar } from "./util.js";

/** An interpreter the host detected (display path + version). */
export interface DetectedInterpreter {
  path: string;
  version: string;
}

/** The committed wizard payload the host turns into an `env.create` call. */
export interface CreateEnvPayload {
  name: string;
  base: string;
  kind: "venv" | "virtualenv" | "conda";
  location: "project" | "global";
  templateId?: string;
  /** the literal pip specs the user checked (editable rows). */
  specs: string[];
}

export interface CreateEnvWizardProps {
  interpreters: DetectedInterpreter[];
  templates: TemplateData[];
  gpu?: GpuInfoData;
  /** the gate plan the host built from the checked rows (step ③ preview). Optional
   *  — when absent the wizard derives a plan-less preview from the checked specs. */
  gatePlan?: GatePlanItemData[];
  onCreate?(payload: CreateEnvPayload): void;
  onCancel?(): void;
  className?: string;
}

type Step = 1 | 2 | 3;

/** Build the editable wizard rows from a template (optional → unchecked). */
function rowsFromTemplate(t: TemplateData | undefined): WizardPkgRow[] {
  if (!t) return [];
  return t.packages.map((p) => {
    const extras = p.extras && p.extras.length > 0 ? `[${p.extras.join(",")}]` : "";
    const version = p.version ?? "";
    const versionPart = version ? (/^[<>=!~]/.test(version) ? version : `==${version}`) : "";
    return {
      name: p.name,
      spec: `${p.name}${extras}${versionPart}`,
      optional: Boolean(p.optional),
      checked: !p.optional,
      note: p.note,
    };
  });
}

export function CreateEnvWizard({
  interpreters,
  templates,
  gpu,
  gatePlan,
  onCreate,
  onCancel,
  className,
}: CreateEnvWizardProps): ReactElement {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [base, setBase] = useState(interpreters[0]?.path ?? "");
  const [kind, setKind] = useState<"venv" | "virtualenv" | "conda">("venv");
  const [location, setLocation] = useState<"project" | "global">("project");
  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? "");
  const [rows, setRows] = useState<WizardPkgRow[]>(() =>
    rowsFromTemplate(templates.find((t) => t.id === (templates[0]?.id ?? ""))),
  );

  const step1 = createStepValid({ name, base });
  const checkedSpecs = useMemo(() => rows.filter((r) => r.checked).map((r) => r.spec), [rows]);

  function applyTemplate(id: string): void {
    setTemplateId(id);
    setRows(rowsFromTemplate(templates.find((t) => t.id === id)));
  }

  function commit(): void {
    if (!step1.ok || !onCreate) return;
    const payload: CreateEnvPayload = {
      name: name.trim(),
      base,
      kind,
      location,
      specs: checkedSpecs,
    };
    if (templateId) payload.templateId = templateId;
    onCreate(payload);
  }

  return (
    <section
      className={className}
      aria-label="New environment"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg, 10px)",
        padding: "var(--space-8, 16px)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-6, 10px)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
        background: "var(--bg-surface)",
      }}
    >
      <header style={{ display: "flex", gap: "var(--space-6, 10px)", fontSize: "0.85rem" }}>
        <StepTab n={1} cur={step} label="Name & interpreter" />
        <StepTab n={2} cur={step} label="Template & packages" />
        <StepTab n={3} cur={step} label="Review & gate" />
      </header>

      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
          <Field label="Base interpreter">
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              style={selectStyle}
              aria-label="Base interpreter"
            >
              {interpreters.length === 0 && <option value="">no interpreter detected</option>}
              {interpreters.map((it) => (
                <option key={it.path} value={it.path}>
                  {inert(`Python ${it.version} (${it.path})`)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Kind">
            <div style={{ display: "flex", gap: "var(--space-6, 10px)" }}>
              {(["venv", "virtualenv", "conda"] as const).map((k) => (
                <label key={k} style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                  <input
                    type="radio"
                    name="env-kind"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  {k}
                </label>
              ))}
            </div>
          </Field>

          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="llm-serving"
              aria-label="Environment name"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              style={inputStyle}
            />
          </Field>

          <Field label="Location">
            <div style={{ display: "flex", gap: "var(--space-6, 10px)" }}>
              {(["project", "global"] as const).map((loc) => (
                <label key={loc} style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                  <input
                    type="radio"
                    name="env-location"
                    checked={location === loc}
                    onChange={() => setLocation(loc)}
                  />
                  {loc === "project" ? "project (.venvs/…)" : "global (~/.prometheus/envs)"}
                </label>
              ))}
            </div>
          </Field>

          {!step1.ok && step1.reason && (
            <p style={{ margin: 0, color: roleVar("warn"), fontSize: "0.8rem" }}>{step1.reason}</p>
          )}
        </div>
      )}

      {step === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
          <Field label="Template">
            <select
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
              style={selectStyle}
              aria-label="Template"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {inert(t.title)}
                </option>
              ))}
            </select>
          </Field>

          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "4px" }}>
            {rows.map((r, i) => (
              <li
                key={r.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3, 6px)",
                  padding: "var(--space-2, 4px) var(--space-3, 6px)",
                  borderRadius: "var(--radius-md, 6px)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <input
                  type="checkbox"
                  checked={r.checked}
                  aria-label={`include ${r.name}`}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)),
                    )
                  }
                />
                <input
                  value={r.spec}
                  aria-label={`spec for ${r.name}`}
                  spellCheck={false}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, spec: e.target.value } : x)),
                    )
                  }
                  style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)" }}
                />
                {r.optional && (
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.78rem" }}>
                    optional
                  </span>
                )}
                {r.note && (
                  <span style={{ color: roleVar("warn"), fontSize: "0.78rem" }}>
                    {inert(r.note)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {gpu && !gpu.hasNvidia && (
            <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.78rem" }}>
              No NVIDIA GPU detected — torch resolves to the CPU/MPS wheel.
            </p>
          )}
        </div>
      )}

      {step === 3 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
          <p style={{ margin: 0, fontSize: "0.85rem" }}>
            Will: create {kind}{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>{inert(name)}</code> → nemesis-gate{" "}
            {plannedCount(rows)} fetch{plannedCount(rows) === 1 ? "" : "es"} → install the cleared
            subset → bind to the editor.
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "2px" }}>
            {(gatePlan ?? checkedSpecs.map((spec) => ({ name: spec, spec, source: "pypi" }))).map(
              (item: GatePlanItemData | { name: string; spec: string; source: string }, i) => (
                <li
                  key={`${item.spec}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-4, 8px)",
                    padding: "var(--space-2, 4px) var(--space-3, 6px)",
                    fontSize: "0.85rem",
                  }}
                >
                  <code style={{ fontFamily: "var(--font-mono)", flex: 1 }}>
                    {inert(item.spec)}
                  </code>
                  <span style={{ color: "var(--text-secondary)" }}>{inert(item.source)}</span>
                  <GateBadge gate={"gate" in item ? item.gate : undefined} />
                </li>
              ),
            )}
          </ul>
        </div>
      )}

      {/* ── footer nav ────────────────────────────────────────────────────── */}
      <footer
        style={{
          display: "flex",
          gap: "var(--space-3, 6px)",
          justifyContent: "flex-end",
          marginTop: "var(--space-3, 6px)",
        }}
      >
        <NavButton label="Cancel" onClick={onCancel} variant="ghost" />
        {step > 1 && (
          <NavButton label="Back" onClick={() => setStep((s) => (s - 1) as Step)} variant="ghost" />
        )}
        {step < 3 && (
          <NavButton
            label="Next"
            onClick={() => setStep((s) => (s + 1) as Step)}
            disabled={step === 1 && !step1.ok}
          />
        )}
        {step === 3 && (
          <NavButton label="Create & scan ▶" onClick={commit} disabled={!step1.ok || !onCreate} />
        )}
      </footer>
    </section>
  );
}

const inputStyle = {
  padding: "6px 8px",
  borderRadius: "var(--radius-md, 6px)",
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-surface-2)",
  color: "var(--text-primary)",
  fontSize: "0.85rem",
  fontFamily: "var(--font-ui)",
} as const;

const selectStyle = { ...inputStyle, minWidth: "16rem" } as const;

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  // a row, not a <label>: each inner control carries its own aria-label, so a
  // wrapping <label> would be a label-without-a-single-control (biome a11y).
  return (
    <div style={{ display: "flex", gap: "var(--space-4, 8px)", alignItems: "center" }}>
      <span style={{ minWidth: "8rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function StepTab({ n, cur, label }: { n: Step; cur: Step; label: string }): ReactElement {
  const active = n === cur;
  return (
    <span
      style={{
        display: "flex",
        gap: "4px",
        alignItems: "center",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontWeight: active ? 700 : 400,
      }}
    >
      <span
        aria-hidden="true"
        style={{ color: active ? roleVar("accent") : "var(--text-secondary)" }}
      >
        {["①", "②", "③"][n - 1]}
      </span>
      {label}
    </span>
  );
}

function NavButton({
  label,
  onClick,
  disabled,
  variant,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "ghost";
}): ReactElement {
  const ghost = variant === "ghost";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      style={{
        background: ghost ? "transparent" : "var(--accent)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md, 6px)",
        // `--on-accent` is the computed label colour for the `--accent` FILL (tokens/contrast.ts `onFill`).
        // The old `--brand-fg` here was WHITE on the dark scheme over a saturated light fill (~2:1),
        // and a plain `--bg-app` would be near-white over the same fill on the LIGHT scheme.
        color: ghost ? "var(--text-primary)" : "var(--on-accent)",
        cursor: disabled || !onClick ? "default" : "pointer",
        opacity: disabled || !onClick ? 0.45 : 1,
        padding: "var(--space-3, 6px) var(--space-6, 10px)",
        fontSize: "0.85rem",
        fontFamily: "var(--font-ui)",
      }}
    >
      {label}
    </button>
  );
}

export default CreateEnvWizard;
