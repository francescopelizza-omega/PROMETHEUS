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
  tight: { text: "tight fit", color: "var(--warn, var(--text-secondary))" },
  "too-big": { text: "too big", color: "var(--danger)" },
};

const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  lmstudio: "LM Studio",
  mlx: "MLX-LM",
  airllm: "AirLLM",
  colibri: "colibri",
};

/** The one step the app hands to the terminal, with the exact command to run there. */
function terminalOnly(plan: { ref: { section: string; id?: string; runtime?: string } }): string {
  const ref = plan.ref;
  const r =
    ref.section === "local" && ref.id
      ? `local:${ref.id}${ref.runtime ? `@${ref.runtime}` : ""}`
      : "";
  return `This model is prepared in the terminal — run \`prometheus\`, then /models use ${r} (it asks before every install and download).`;
}

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
        {badge && <span style={{ fontSize: "0.75rem", color: badge.color }}>{badge.text}</span>}
        {r.current && <span style={{ fontSize: "0.75rem", color: "var(--ok)" }}>← current</span>}
      </span>
      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{r.detail}</span>
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
  const [replanning, setReplanning] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [pct, setPct] = useState<number | undefined>(undefined);
  const [key, setKey] = useState("");
  const [live, setLive] = useState<string[]>([]);
  /** a nemesis WARN waiting for the user: the model name to type, and what nemesis found. */
  const [warn, setWarn] = useState<{
    name: string;
    reasons: string[];
    /** "pull": the model is IN Ollama now — a refusal removes it. "gguf": nothing admitted. */
    kind: "pull" | "gguf";
  } | null>(null);
  const [typed, setTyped] = useState("");
  /** set ONLY by the confirm button after the name was typed; read by the next `run`. */
  const acceptWarnFor = useRef<string | null>(null);
  /** Navigation, Cancel or a new plan ends a pending WARN: an armed acceptance must never
   *  carry over to a later run (it would skip the typed confirmation for that model). */
  /**
   * A WARNED Ollama pull is already IN Ollama's store. Every way out of the warn that is not
   * "Use it anyway" — Refuse, Back, Cancel, a new step, closing the wizard — must remove it:
   * otherwise the next pick finds it "installed" and adopts it without the scan it failed.
   * Only Refuse used to do that.
   */
  const pendingPull = useRef<string | null>(null);
  const discardPendingPull = useCallback((): string | null => {
    const tag = pendingPull.current;
    pendingPull.current = null;
    if (tag) {
      void modelsApi()
        ?.discardOllama?.({ tag })
        .catch(() => undefined);
    }
    return tag;
  }, []);
  const dropWarn = useCallback((): void => {
    acceptWarnFor.current = null;
    discardPendingPull();
    setWarn(null);
    setTyped("");
  }, [discardPendingPull]);
  // closing the wizard mid-warn is a refusal too
  useEffect(() => () => void discardPendingPull(), [discardPendingPull]);
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
      dropWarn();
      setPlan(null);
      setLive([]);
      setMsg("");
      const r = await api.step({ step: id, showAll });
      if (ticket !== nav.current) return;
      if (r.ok) setStep(r.step);
      else setMsg(`✗ ${r.error}`);
    },
    [api, dropWarn],
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
    dropWarn();
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
    if (p.ok) {
      dropWarn();
      setPlan(p.plan);
    } else setMsg(`✗ ${p.error}`);
  };

  /** Re-plan the same local model on another runtime (Ollama / llama.cpp / LM Studio). The ref
   *  and the plan change TOGETHER, when the new plan arrives — set apart, "Prepare" could run
   *  the old plan's actions under the new runtime (fetch without the Ollama import, then adopt
   *  a model nothing serves). Prepare is disabled while this is in flight. */
  const replan = async (runtime: "ollama" | "llamacpp" | "lmstudio"): Promise<void> => {
    if (!plan || plan.ref.section !== "local" || busy || replanning) return;
    const id = plan.ref.id;
    const next = runtime === "ollama" ? `local:${id}` : `local:${id}@${runtime}`;
    const ticket = ++nav.current;
    setReplanning(true);
    try {
      const p = await api.plan({ ref: next });
      if (ticket !== nav.current) return;
      if (p.ok) {
        dropWarn();
        setRefStr(next);
        setPlan(p.plan);
      } else setMsg(`✗ ${p.error}`);
    } finally {
      setReplanning(false);
    }
  };
  /** the runtime of the plan ON SCREEN (never derived from a ref that may be ahead of it) */
  const planRuntime =
    plan?.ref.section === "local" ? (plan.ref.runtime ?? plan.runtime) : undefined;
  const refRuntime: "llamacpp" | "lmstudio" | undefined =
    planRuntime === "llamacpp" || planRuntime === "lmstudio" ? planRuntime : undefined;

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
    if (!plan || running.current) {
      acceptWarnFor.current = null; // never left armed by a run that did not happen
      return;
    }
    running.current = true;
    // Back (or any navigation) during a long Prepare bumps `nav`: the run then stops before it
    // adopts anything — it used to switch the chat and the global default server for a model
    // the user had backed out of.
    const runTicket = nav.current;
    setBusy(true);
    setPct(undefined);
    setWarn(null);
    const accepted = acceptWarnFor.current;
    acceptWarnFor.current = null;
    // this run's own progress only: the Models page's downloads used to overwrite it
    const runId = `wiz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const off = modelsApi()?.onProgress?.((e: ModelProgressEvent) => {
      if (e.runId !== undefined && e.runId !== runId) return;
      if (e.message) setMsg(e.message);
      if (typeof e.pct === "number") setPct(e.pct);
    });
    try {
      // A retry with a model the provider's live list offered skips straight to the switch:
      // the key and every download already happened on the first pass.
      const actions = chosenModel ? plan.actions.filter((a) => a.kind === "adopt") : plan.actions;
      /** the Ollama tag an imported GGUF got (fetch-gguf) — the adopt step uses it. */
      let importedTag: string | undefined;
      /** the name a llama.cpp / LM Studio server lists the model under (the adopt step uses it). */
      let servedName: string | undefined;
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
          const r = await modelsApi()?.pull({
            id: a.tag,
            runId,
            ...(accepted === a.tag ? { acceptWarn: true } : {}),
          });
          if (r?.needsConfirm) {
            pendingPull.current = a.tag;
            setWarn({ name: a.tag, reasons: r.gateReasons ?? [], kind: "pull" });
            setMsg(`⚠ nemesis WARN on ${a.tag} — it is downloaded but NOT used until you accept`);
            return;
          }
          if (!r?.ok || !r.installed) {
            setMsg(`✗ download: ${r?.error ?? "failed"}`);
            return;
          }
          done("pull");
        } else if (a.kind === "fetch-gguf") {
          // no Ollama-registry build: gated Hugging Face download → nemesis → library → Ollama
          setMsg(
            `Downloading ${a.repo} · ${a.file} (about ${a.sizeGb} GB) — verified against Hugging Face's sha256 and scanned by nemesis…`,
          );
          const r = await modelsApi()?.fetchGguf?.({
            runId,
            id: a.id,
            repo: a.repo,
            file: a.file,
            ...(accepted === a.id ? { acceptWarn: true } : {}),
            // llama.cpp / LM Studio serve the admitted file in place — no Ollama import
            ...(refRuntime ? { runtime: refRuntime } : {}),
          });
          if (r?.needsConfirm) {
            setWarn({ name: a.id, reasons: r.gateReasons ?? [], kind: "gguf" });
            setMsg(`⚠ nemesis WARN on ${a.id} — nothing is admitted until you accept`);
            return;
          }
          if (!r?.ok || (!refRuntime && !r.tag)) {
            setMsg(`✗ ${r?.stage ? `${r.stage}: ` : ""}${r?.error ?? "not admitted"}`);
            return;
          }
          if (r.tag) importedTag = r.tag;
          done("fetch-gguf");
        } else if (a.kind === "install-runtime") {
          if (a.runtime !== "llamacpp" && a.runtime !== "lmstudio") {
            setMsg(terminalOnly(plan));
            return;
          }
          const name = a.runtime === "llamacpp" ? "llama.cpp" : "LM Studio";
          setMsg(`Installing ${name} through its official package channel…`);
          const r = await modelsApi()?.installRuntime?.({ runtime: a.runtime });
          if (!r?.ok) {
            setMsg(
              `✗ ${name}: ${r?.error ?? "install failed"}${r?.manual ? ` — run it yourself after reading it: ${r.manual}` : ""}`,
            );
            return;
          }
          done("install-runtime");
        } else if (a.kind === "serve-gguf" && a.stream) {
          // streaming a model larger than RAM: the terminal asks for the typed confirmation
          setMsg(terminalOnly(plan));
          return;
        } else if (a.kind === "serve-gguf") {
          setMsg(`Starting llama.cpp on the admitted file (offline, ${a.ctx} tokens)…`);
          const r = await modelsApi()?.serveGguf?.({ id: a.id, ctx: a.ctx });
          if (!r?.ok) {
            setMsg(`✗ llama.cpp: ${r?.error ?? "did not start"}`);
            return;
          }
          servedName = r.model;
          done("serve-gguf");
        } else if (a.kind === "link-lmstudio") {
          setMsg("Linking the admitted file into LM Studio…");
          const r = await modelsApi()?.linkLmstudio?.({ id: a.id });
          if (!r?.ok) {
            setMsg(`✗ LM Studio link: ${r?.error ?? "failed"}`);
            return;
          }
          done("link-lmstudio");
        } else if (a.kind === "start-runtime") {
          const id = plan.ref.section === "local" ? plan.ref.id : "";
          setMsg("Starting LM Studio's server…");
          const r = await modelsApi()?.startLmstudio?.({ id });
          if (!r?.ok) {
            setMsg(`✗ LM Studio: ${r?.error ?? "did not start"}`);
            return;
          }
          servedName = r.model;
          done("start-runtime");
        } else if (a.kind === "import-ollama") {
          // done together with fetch-gguf in main (one queued mutation); nothing left to run
          done("import-ollama");
        } else if (
          a.kind === "install-offload" ||
          a.kind === "confirm-insist" ||
          a.kind === "fetch-snapshot" ||
          a.kind === "serve-mlx" ||
          a.kind === "serve-stream" ||
          a.kind === "serve-colibri"
        ) {
          // MLX builds and the "run it anyway, streaming from disk" path (AirLLM, colibri,
          // llama.cpp from SSD) are prepared by the terminal, which asks for the typed
          // confirmation they need; the app never half-runs them
          setMsg(terminalOnly(plan));
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
          if (runTicket !== nav.current) {
            setMsg("Stopped — you went back, so nothing was switched.");
            return;
          }
          const ref = plan.ref;
          if (ref.section === "local" || ref.section === "served") {
            const tag =
              ref.section === "served"
                ? ref.model
                : (servedName ?? importedTag ?? plan.localTag ?? ref.id);
            // main re-checks the pick (an Ollama model must pass nemesis NOW, whatever put it
            // on disk) — a refusal stops here instead of switching the chat anyway
            const chosen = await api.choose({ ref: refStr });
            if (!chosen.ok) {
              setMsg(`✗ ${chosen.error}`);
              return;
            }
            const ok = await selectLocal(tag);
            // the pick needed another server than the default: the default follows it, in the
            // shared settings.json the terminal's /server reads too
            let moved = "";
            if (plan.switchDefault) {
              const r = await window.prometheus?.settings
                ?.set("localModels.defaultServer", plan.switchDefault.to, "global")
                .catch(() => undefined);
              if (r?.ok)
                moved = ` · default server → ${RUNTIME_NAMES[plan.switchDefault.to] ?? plan.switchDefault.to}`;
            }
            setMsg(
              ok
                ? `✓ chat now uses ${tag}${moved}`
                : `✓ ${tag} is ready — pick it in the chat's model menu${moved}`,
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
        } else {
          // Every kind the planner emits today is handled above. A kind added later that this
          // surface does not know yet stops the run rather than adopting a model that was never
          // prepared.
          const unknown = (a as { kind: string }).kind;
          setMsg(
            `✗ "${unknown}" is not available in the app yet — run /models use in the terminal`,
          );
          return;
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
          <Button size="sm" variant="ghost" onClick={back} disabled={busy}>
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
            {plan.ref.section === "local" && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                  Serve with:
                </span>
                {(["ollama", "llamacpp", "lmstudio"] as const).map((rt) => (
                  <Button
                    key={rt}
                    size="sm"
                    // highlight the runtime the PLAN uses (MLX picks showed "Ollama" selected)
                    variant={
                      (refRuntime ?? plan.runtime ?? "ollama") === rt ? "secondary" : "ghost"
                    }
                    aria-pressed={(refRuntime ?? plan.runtime ?? "ollama") === rt}
                    disabled={busy || replanning}
                    onClick={() => void replan(rt)}
                  >
                    {rt === "ollama" ? "Ollama" : rt === "llamacpp" ? "llama.cpp" : "LM Studio"}
                  </Button>
                ))}
              </div>
            )}
            {plan.runtimeReason && !plan.blocked && (
              <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                Runs on {RUNTIME_NAMES[plan.runtime ?? "ollama"] ?? plan.runtime}:{" "}
                {plan.runtimeReason}
              </span>
            )}
            {plan.switchDefault && !plan.blocked && (
              <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                Your default local server will become{" "}
                {RUNTIME_NAMES[plan.switchDefault.to] ?? plan.switchDefault.to} (it is{" "}
                {RUNTIME_NAMES[plan.switchDefault.from] ?? plan.switchDefault.from} now)
              </span>
            )}
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
                {(plan.insist ?? []).length > 0 && (
                  <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                    It can still run, slowly, by streaming its weights from disk — from the terminal
                    (it asks you to type the model's name first):{" "}
                    {(plan.insist ?? []).map((o) => (
                      <code key={o.ref} style={{ marginRight: 8 }}>
                        prometheus /models use {o.ref}
                      </code>
                    ))}
                    ({plan.insist?.[0]?.name}: {plan.insist?.[0]?.speed})
                  </span>
                )}
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
                    {a.kind === "pull" &&
                      `· download ${a.tag} (about ${a.sizeGb} GB), then scan it with nemesis`}
                    {a.kind === "fetch-gguf" &&
                      `· download ${a.repo} (about ${a.sizeGb} GB) from Hugging Face — sha256-verified and nemesis-scanned`}
                    {a.kind === "import-ollama" && `· serve it through Ollama as ${a.tag}`}
                    {a.kind === "install-runtime" &&
                      `· install ${RUNTIME_NAMES[a.runtime] ?? a.runtime} (official package channel)`}
                    {a.kind === "serve-gguf" &&
                      `· serve the admitted file with llama.cpp (offline, ${a.ctx} tokens)`}
                    {a.kind === "link-lmstudio" &&
                      "· put the admitted file in LM Studio's own models folder (one copy on disk)"}
                    {a.kind === "start-runtime" && "· start LM Studio's server"}
                    {a.kind === "set-key" &&
                      `· verify and store your key in the OS keychain${a.signupUrl ? ` — free key: ${a.signupUrl}` : ""}`}
                    {a.kind === "install-offload" &&
                      `· set up ${a.runtime.name}: ${a.runtime.mechanism} ${a.runtime.speed}`}
                    {a.kind === "confirm-insist" &&
                      `· too big for this machine — runs only by streaming from disk through ${a.runtimeName} (${a.speed})`}
                    {a.kind === "fetch-snapshot" &&
                      `· download ${a.repo} (weights, config, tokenizer) — sha256-verified and nemesis-scanned`}
                    {a.kind === "serve-mlx" && "· serve it with MLX-LM (offline)"}
                    {a.kind === "serve-stream" &&
                      "· serve it with AirLLM (offline, minutes per token)"}
                    {a.kind === "serve-colibri" &&
                      "· serve it with colibri (experts streamed from disk)"}
                  </span>
                ))}
                {needsKey && (
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste your API key"
                    aria-label="API key"
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
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || replanning}
                    onClick={() => void run()}
                  >
                    {heavy.length > 0 ? "Prepare and switch" : "Switch to it"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      nav.current += 1;
                      dropWarn();
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
        {warn && !busy && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: "0.78rem", color: "var(--warn)" }}>
              nemesis found something to review in {warn.name}:
            </span>
            {(warn.reasons.length ? warn.reasons : ["(no detail reported)"]).map((r) => (
              <span
                key={r}
                style={{
                  fontSize: "0.75rem",
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-secondary)",
                }}
              >
                · {r}
              </span>
            ))}
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-label="type the model name to use it anyway"
              placeholder={`type ${warn.name} to use it anyway`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
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
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Button
                size="sm"
                variant="danger"
                disabled={typed.trim() !== warn.name}
                onClick={() => {
                  acceptWarnFor.current = warn.name;
                  // accepted: the pulled model stays — nothing may discard it on the way out
                  pendingPull.current = null;
                  setTyped("");
                  void run();
                }}
              >
                Use it anyway
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const refused = warn;
                  // dropWarn removes a warned pull from Ollama's store (see `pendingPull`)
                  dropWarn();
                  if (refused.kind === "pull") {
                    setMsg(`refused — ${refused.name} removed from Ollama.`);
                  } else {
                    setMsg("refused — nothing is used.");
                  }
                }}
              >
                Refuse
              </Button>
            </div>
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
