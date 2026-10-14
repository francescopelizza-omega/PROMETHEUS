// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/model-wizard.tsx — "Choose a model": the desktop face of the CLI's `/models`.
 *
 *   Local (always free) | Cloud  →  Free cloud | Paid cloud | Endless free rotation
 *   →  models with two lines each  →  prepare (install Ollama / download / key)  →  switch
 *
 * Every step is BUILT IN MAIN from core (`main/model-wizard.ts` → `ai/model-catalog/wizard.ts`),
 * so a row here reads exactly as it does in the terminal. This component only draws the rows
 * and runs the listed preparation, one consented step at a time, through the Model Hub's
 * existing channels (`models.installRunner`, `models.ollamaStart`, `models.pull`).
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + window.prometheus only. API keys go in
 * through `modelWizard.setKey` (main verifies, then stores in the OS keychain) and never come
 * back; the input is a password field and is cleared the moment it is submitted.
 */
import { Button, Panel, Progress } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { expandServedModels } from "../renderer/ide/ai/endpoint-hook.js";
import { toEndpoints } from "../renderer/ide/ai/endpoints.js";
import { useAiSessionStore } from "../renderer/ide/state/stores.js";
import type {
  ModelProgressEvent,
  WizardPreparePlan,
  WizardRowView,
  WizardStepId,
  WizardStepView,
} from "../shared/ipc-contract.js";

function wizardApi(): Window["prometheus"]["modelWizard"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.modelWizard : undefined;
}
function modelsApi(): Window["prometheus"]["models"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.models : undefined;
}

const BADGE: Record<string, { text: string; color: string }> = {
  ready: { text: "ready", color: "var(--ok)" },
  installed: { text: "installed", color: "var(--ok)" },
  "needs-install": { text: "download", color: "var(--text-secondary)" },
  "needs-key": { text: "needs key", color: "var(--warn, var(--text-secondary))" },
  keyless: { text: "no key needed", color: "var(--ok)" },
  "needs-offload": { text: "needs offload runtime", color: "var(--warn, var(--text-secondary))" },
  slow: { text: "very slow here", color: "var(--warn, var(--text-secondary))" },
  "too-big": { text: "too big", color: "var(--danger)" },
};

const row = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 4,
  padding: "var(--space-4, 8px) var(--space-6, 12px)",
  borderRadius: "var(--radius-md, 6px)",
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-surface-2)",
  textAlign: "left" as const,
  cursor: "pointer",
  color: "var(--text-primary)",
  overflowWrap: "break-word" as const,
};

function RowCard({
  r,
  onPick,
}: {
  r: WizardRowView;
  onPick: (r: WizardRowView) => void;
}): ReactElement {
  const badge = r.badge ? BADGE[r.badge] : undefined;
  const disabled = Boolean(r.disabled);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(r)}
      style={{ ...row, opacity: disabled ? 0.55 : 1, cursor: disabled ? "default" : "pointer" }}
    >
      <span style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: "0.86rem" }}>{r.label}</strong>
        {badge && <span style={{ fontSize: "0.72rem", color: badge.color }}>{badge.text}</span>}
        {r.current && <span style={{ fontSize: "0.72rem", color: "var(--ok)" }}>← current</span>}
      </span>
      <span style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>{r.detail}</span>
      {disabled ? (
        <span style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>{r.disabled}</span>
      ) : (
        r.lines.map((l) => (
          <span key={l} style={{ fontSize: "0.76rem", color: "var(--text-secondary)" }}>
            {l}
          </span>
        ))
      )}
    </button>
  );
}

export function ModelWizardPanel(): ReactElement | null {
  const api = wizardApi();
  const selectEndpoint = useAiSessionStore((s) => s.selectEndpoint);
  const [stepId, setStepId] = useState<WizardStepId>("root");
  const [trail, setTrail] = useState<WizardStepId[]>([]);
  const [step, setStep] = useState<WizardStepView | null>(null);
  const [plan, setPlan] = useState<WizardPreparePlan | null>(null);
  const [refStr, setRefStr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [pct, setPct] = useState<number | undefined>(undefined);
  const [key, setKey] = useState("");
  const [live, setLive] = useState<string[]>([]);
  /**
   * Every navigation bumps this; an IPC answer that comes back for an older one is dropped.
   * Without it a quick Cloud → Back let the slower reply overwrite the step on screen, and a
   * plan fetched before Back appeared over the wrong step.
   */
  const nav = useRef(0);
  /** A synchronous guard: `busy` is state, so two quick clicks both saw it false. */
  const running = useRef(false);

  const load = useCallback(
    async (id: WizardStepId, showAll = false): Promise<void> => {
      if (!api) return;
      const ticket = ++nav.current;
      setPlan(null);
      setLive([]);
      setMsg("");
      const r = await api.step({ step: id, showAll });
      if (ticket !== nav.current) return;
      if (r.ok) setStep(r.step);
      else setMsg(`✗ ${r.error}`);
    },
    [api],
  );

  useEffect(() => {
    void load(stepId);
  }, [load, stepId]);

  if (!api) return null;

  const go = (next: WizardStepId): void => {
    setTrail((t) => [...t, stepId]);
    setStepId(next);
  };
  const back = (): void => {
    nav.current += 1;
    setPlan(null);
    setLive([]);
    const prev = trail.at(-1);
    if (!prev) return;
    setTrail((t) => t.slice(0, -1));
    setStepId(prev);
  };

  const pick = async (r: WizardRowView): Promise<void> => {
    if (r.next) {
      go(r.next);
      return;
    }
    if (!r.ref) return;
    const ticket = ++nav.current;
    setRefStr(r.ref);
    setLive([]);
    const p = await api.plan({ ref: r.ref });
    if (ticket !== nav.current) return;
    if (p.ok) setPlan(p.plan);
    else setMsg(`✗ ${p.error}`);
  };

  /** Drop a finished preparation step, so a retry never repeats a download or asks for a key again. */
  const done = (kind: string): void =>
    setPlan((p) => (p ? { ...p, actions: p.actions.filter((x) => x.kind !== kind) } : p));

  /** Select the local endpoint serving `tag` in the chat pane, once the runner lists it. */
  const selectLocal = async (tag: string): Promise<boolean> => {
    const eps = await expandServedModels(toEndpoints(await modelsApi()?.endpoints()));
    const hit = eps.find((e) => e.locality === "local" && e.model === tag);
    if (!hit) return false;
    selectEndpoint(hit.id);
    return true;
  };

  /** Run the plan's actions in order; every heavy one was shown to the user before this ran. */
  const run = async (chosenModel?: string): Promise<void> => {
    if (!plan || running.current) return;
    running.current = true;
    setBusy(true);
    setPct(undefined);
    const off = modelsApi()?.onProgress?.((e: ModelProgressEvent) => {
      if (e.message) setMsg(e.message);
      if (typeof e.pct === "number") setPct(e.pct);
    });
    try {
      // A retry with a model the provider's live list offered skips straight to the switch:
      // the key and every download already happened on the first pass.
      const actions = chosenModel ? plan.actions.filter((a) => a.kind === "adopt") : plan.actions;
      for (const a of actions) {
        if (a.kind === "install-runner") {
          setMsg("Installing Ollama for your OS…");
          const r = await modelsApi()?.installRunner();
          if (!r?.ok || !r.installed) {
            setMsg(`✗ Ollama install: ${r?.error ?? r?.install ?? "failed"}`);
            return;
          }
          await modelsApi()?.ollamaStart?.();
          done("install-runner");
        } else if (a.kind === "start-runner") {
          setMsg("Starting Ollama…");
          const r = await modelsApi()?.ollamaStart?.();
          if (r && !r.ok) {
            setMsg(`✗ Ollama did not start (${r.reason ?? "unknown"})`);
            return;
          }
          done("start-runner");
        } else if (a.kind === "pull") {
          setMsg(`Downloading ${a.tag} (about ${a.sizeGb} GB)…`);
          const r = await modelsApi()?.pull({ id: a.tag });
          if (!r?.ok || !r.installed) {
            setMsg(`✗ download: ${r?.error ?? "failed"}`);
            return;
          }
          done("pull");
        } else if (a.kind === "install-offload") {
          const rt = a.plan.runtime;
          setMsg(
            rt.installCommand
              ? `${rt.name}: run \`${rt.installCommand}\` in a terminal (nemesis-gated). ${rt.speed}`
              : `${rt.name}: ${(rt.manualSteps ?? []).join("  ·  ")}${a.model.colibri ? `  (model id: ${a.model.colibri})` : ""}`,
          );
          return;
        } else if (a.kind === "set-key") {
          if (!key.trim()) {
            setMsg("Paste the key first.");
            return;
          }
          setMsg("Verifying the key with the provider…");
          const r = await api.setKey({ providerId: a.providerId, key });
          setKey("");
          if (!r.ok) {
            setMsg(`✗ ${r.error}`);
            return;
          }
          done("set-key");
        } else if (a.kind === "adopt") {
          const ref = plan.ref;
          if (ref.section === "local" || ref.section === "served") {
            const tag = ref.section === "served" ? ref.model : (plan.localTag ?? ref.id);
            await api.choose({ ref: refStr });
            const ok = await selectLocal(tag);
            setMsg(
              ok
                ? `✓ chat now uses ${tag}`
                : `✓ ${tag} is ready — pick it in the chat's model menu`,
            );
          } else {
            const r = await api.choose({
              ref: refStr,
              ...(chosenModel ? { model: chosenModel } : {}),
            });
            if (!r.ok) {
              setLive(r.live ?? []);
              setMsg(`✗ ${r.error}`);
              return;
            }
            if (r.endpoint) selectEndpoint(r.endpoint.id);
            setMsg(`✓ chat now uses ${r.label}`);
          }
          setLive([]);
          setPlan(null);
        }
      }
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      off?.();
      running.current = false;
      setBusy(false);
      setPct(undefined);
    }
  };

  const needsKey = plan?.actions.find((a) => a.kind === "set-key");
  const heavy = plan?.actions.filter((a) => a.kind !== "adopt") ?? [];

  return (
    <Panel
      title="★ Choose a model"
      raised
      actions={
        trail.length > 0 || plan ? (
          <Button size="sm" variant="ghost" onClick={back}>
            ← Back
          </Button>
        ) : undefined
      }
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4, 8px)",
          minWidth: 0,
        }}
      >
        {!plan && step && (
          <>
            <strong style={{ fontSize: "0.9rem" }}>{step.title}</strong>
            {step.intro.map((l) => (
              <span key={l} style={{ fontSize: "0.76rem", color: "var(--text-muted)" }}>
                {l}
              </span>
            ))}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
                gap: "var(--space-4, 8px)",
              }}
            >
              {step.rows.map((r) => (
                <RowCard
                  key={`${r.label}${r.ref ?? r.next ?? ""}`}
                  r={r}
                  onPick={(x) => void pick(x)}
                />
              ))}
            </div>
            {step.id === "local" && (
              <Button size="sm" variant="ghost" onClick={() => void load("local", true)}>
                Show models too big for this machine
              </Button>
            )}
          </>
        )}

        {plan && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {plan.warnings.map((w) => (
              <span
                key={w}
                style={{ fontSize: "0.78rem", color: "var(--warn, var(--text-secondary))" }}
              >
                ⚠ {w}
              </span>
            ))}
            {plan.blocked ? (
              <>
                <span style={{ fontSize: "0.8rem", color: "var(--danger)" }}>✗ {plan.blocked}</span>
                {(plan.alternatives ?? []).length > 0 && (
                  <span style={{ fontSize: "0.78rem" }}>Models that DO run on this machine:</span>
                )}
                {(plan.alternatives ?? []).map((m) => (
                  <Button
                    key={m.id}
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void pick({ label: m.label, detail: "", lines: [], ref: `local:${m.id}` })
                    }
                  >
                    {m.label} — {m.q4Gb} GB
                  </Button>
                ))}
              </>
            ) : (
              <>
                {heavy.length > 0 && (
                  <span style={{ fontSize: "0.8rem" }}>Prometheus will, in order:</span>
                )}
                {heavy.map((a) => (
                  <span
                    key={a.kind}
                    style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}
                  >
                    {a.kind === "install-runner" && "· install Ollama (OS package manager, gated)"}
                    {a.kind === "start-runner" && "· start Ollama"}
                    {a.kind === "pull" && `· download ${a.tag} (about ${a.sizeGb} GB)`}
                    {a.kind === "set-key" &&
                      `· verify and store your key in the OS keychain${a.signupUrl ? ` — free key: ${a.signupUrl}` : ""}`}
                    {a.kind === "install-offload" &&
                      `· set up ${a.plan.runtime.name}: ${a.plan.runtime.mechanism} ${a.plan.runtime.speed}`}
                  </span>
                ))}
                {needsKey && (
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste your API key"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    style={{
                      padding: "6px 8px",
                      borderRadius: "var(--radius-md, 6px)",
                      border: "1px solid var(--border-subtle)",
                      background: "var(--bg-inset)",
                      color: "var(--text-primary)",
                      fontFamily: "var(--font-mono)",
                      minWidth: 0,
                    }}
                  />
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void run()}>
                    {heavy.length > 0 ? "Prepare and switch" : "Switch to it"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      nav.current += 1;
                      setPlan(null);
                      setLive([]);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {live.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {live.map((m) => (
              <Button
                key={m}
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void run(m)}
              >
                {m}
              </Button>
            ))}
          </div>
        )}
        {busy && (
          <Progress
            {...(pct !== undefined ? { value: pct } : {})}
            aria-label="preparing the model"
          />
        )}
        {msg && <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{msg}</span>}
      </div>
    </Panel>
  );
}
