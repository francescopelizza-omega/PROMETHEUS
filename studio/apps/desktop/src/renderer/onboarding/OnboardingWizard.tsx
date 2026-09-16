/**
 * onboarding/OnboardingWizard.tsx — the first-run wizard modal (APP-064).
 *
 * A token-styled modal that walks welcome → interpreter → model → theme → tokens. Each step
 * ORCHESTRATES an already-shipped flow (detectBins + LSP set-interpreter for the interpreter,
 * the AI-Providers / ollama surfaces for the model, ThemeProvider's `setScheme` for the
 * theme, the token-economy toolkit for the opt-in) — the wizard rebuilds none of them. The
 * step machine + persistence are the PURE onboarding-state.ts (node:test-covered); Back/Next/
 * Skip all resolve to a persisted result so a mid-wizard skip is remembered.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + ThemeProvider + window.prometheus only.
 */
import { themes } from "@prometheus/ui";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Z, useFocusTrap } from "@prometheus/ui";
import { PrometheusMark } from "../shell/PrometheusMark.js";
import { useTheme } from "../shell/ThemeProvider.js";
import {
  type ModelChoice,
  type OnboardingResult,
  type OnboardingStep,
  nextStep,
  prevStep,
} from "./onboarding-state.js";

export interface OnboardingWizardProps {
  /** the active workspace root, if any (interpreter apply needs it; absent → record only). */
  workspaceRoot?: string;
  /** finish/skip → persist the collected choices (the App writes the flag). */
  onComplete(result: Omit<OnboardingResult, "completed">, skipped: boolean): void;
  /** deep-link the token-economy toolkit ("learn more"). */
  onOpenTokens?(): void;
}

const btn: CSSProperties = {
  padding: "var(--space-2, 4px) var(--space-6, 12px)",
  borderRadius: "var(--radius-md, 6px)",
  border: "1px solid var(--border-strong)",
  background: "var(--bg-surface-2)",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "var(--text-small-size, 0.8125rem)",
};
const field: CSSProperties = {
  background: "var(--bg-inset)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px)",
  fontFamily: "var(--font-mono)",
};

export function OnboardingWizard({
  workspaceRoot,
  onComplete,
  onOpenTokens,
}: OnboardingWizardProps): ReactElement {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [interpreter, setInterpreter] = useState("");
  const [modelChoice, setModelChoice] = useState<ModelChoice>("later");
  const [bins, setBins] = useState<Record<string, boolean>>({});
  const [applyNote, setApplyNote] = useState<string | null>(null);

  const { activeSchemeId, setScheme } = useTheme();
  const registry = useMemo(() => themes.createThemeRegistry(), []);
  const schemes = useMemo(() => themes.listSchemes(registry), [registry]);

  // detect which python binaries exist (a hint for the interpreter step).
  useEffect(() => {
    void window.prometheus?.ide?.detectBins?.(["python3", "python"]).then((r) => setBins(r ?? {}));
  }, []);

  const collect = (): Omit<OnboardingResult, "completed"> => ({
    ...(interpreter ? { interpreter } : {}),
    modelChoice,
    ...(activeSchemeId ? { theme: activeSchemeId } : {}),
  });

  const finish = (skipped: boolean): void => onComplete(collect(), skipped);
  // §9.2: this is the only surface in the app that DECLARES `aria-modal="true"`, and it was
  // the only one with no trap at all — so assistive tech was told the workbench behind it
  // was inert while Tab still walked straight into it. There is no click-outside and no ✕
  // either, which made it dismiss-proof from the keyboard; Escape now skips the wizard,
  // matching the visible "Skip" button rather than inventing a third outcome.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // read `finish` through a ref so the trap's effect does not re-run — and re-move focus —
  // on every keystroke that changes the wizard's state.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const skip = useCallback(() => finishRef.current(true), []);
  useFocusTrap(rootRef, true, skip);
  const advance = (): void => {
    const next = nextStep(step);
    if (next === "done") finish(false);
    else setStep(next);
  };

  const applyInterpreter = async (): Promise<void> => {
    const path = interpreter.trim();
    const api = window.prometheus?.ide;
    if (!path) return;
    if (!api || !workspaceRoot) {
      setApplyNote("saved — it applies when you open a project folder");
      return;
    }
    // ensure the Python language server, then restart it against the chosen interpreter
    // (async, can take seconds — the wizard never blocks Next on it, per the plan).
    setApplyNote("restarting the language server…");
    const ens = await api.lspEnsure?.("python", workspaceRoot).catch(() => undefined);
    if (!ens?.ok || !ens.serverId) {
      setApplyNote("saved (no Python language server to restart here)");
      return;
    }
    const r = await api
      .lspSetInterpreter?.(ens.serverId, workspaceRoot, path)
      .catch(() => undefined);
    setApplyNote(r?.ok ? "interpreter applied" : "saved (couldn't restart the server)");
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="First-run setup"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--bg-app) 70%, transparent)",
        zIndex: Z.modal,
      }}
    >
      <div
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "86vh",
          overflow: "auto",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg, 12px)",
          boxShadow: "var(--elevation-e3, 0 10px 40px rgba(0,0,0,0.4))",
          padding: "var(--space-8, 16px)",
          fontFamily: "var(--font-ui)",
          color: "var(--text-primary)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4, 8px)",
        }}
      >
        {step === "welcome" && (
          <>
            {/* §8.2: the brand mark leads the first thing anyone ever sees of the app. */}
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <PrometheusMark height={28} />
              <h2 style={{ margin: 0 }}>Welcome to Prometheus Studio</h2>
            </span>
            <p style={{ color: "var(--text-secondary)" }}>
              A quick setup: pick a Python interpreter, choose how you'll run models, set a theme,
              and (optionally) enable the token-economy toolkit. You can skip any step.
            </p>
          </>
        )}

        {step === "interpreter" && (
          <>
            <h2 style={{ margin: 0 }}>Python interpreter</h2>
            <p style={{ color: "var(--text-secondary)" }}>
              Detected on PATH:{" "}
              {Object.entries(bins)
                .filter(([, ok]) => ok)
                .map(([n]) => n)
                .join(", ") || "none"}
              . Paste the interpreter to use for language features.
            </p>
            <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
              <input
                value={interpreter}
                onChange={(e) => setInterpreter(e.target.value)}
                placeholder="/path/to/venv/bin/python"
                aria-label="python interpreter path"
                style={{ ...field, flex: 1 }}
              />
              <button type="button" onClick={() => void applyInterpreter()} style={btn}>
                Apply
              </button>
            </div>
            {applyNote && (
              <span style={{ color: "var(--text-secondary)", fontSize: "0.75rem" }}>
                {applyNote}
              </span>
            )}
          </>
        )}

        {step === "model" && (
          <>
            <h2 style={{ margin: 0 }}>Models</h2>
            {(
              [
                ["local", "Local (ollama) — private, free, runs on your machine"],
                ["api", "Cloud API endpoint — configure in AI Providers"],
                ["later", "Decide later"],
              ] as [ModelChoice, string][]
            ).map(([id, label]) => (
              <label
                key={id}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-2, 4px)" }}
              >
                <input
                  type="radio"
                  name="model"
                  checked={modelChoice === id}
                  onChange={() => setModelChoice(id)}
                />
                {label}
              </label>
            ))}
          </>
        )}

        {step === "theme" && (
          <>
            <h2 style={{ margin: 0 }}>Theme</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2, 4px)" }}>
              {schemes.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setScheme(s.id)}
                  aria-pressed={activeSchemeId === s.id}
                  style={{
                    ...btn,
                    borderColor: activeSchemeId === s.id ? "var(--accent)" : "var(--border-strong)",
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </>
        )}

        {step === "tokens" && (
          <>
            <h2 style={{ margin: 0 }}>Token economy</h2>
            <p style={{ color: "var(--text-secondary)" }}>
              Curated tricks to cut token spend (prompt trimming, caching, local-first routing).
            </p>
            {/* The "Enable the token-economy toolkit" checkbox lived here and enabled
                nothing. Its value was recorded into the onboarding blob and no code anywhere
                read it back, so ticking it was a promise the app never kept — the toolkit was
                reached only through the button below, whether it was ticked or not. A control
                that reports success and does nothing is worse than no control, so it is gone
                rather than left as a placeholder. `tokensOptIn` stays in OnboardingResult and
                its tolerant parse so blobs already in localStorage still load. */}
            {onOpenTokens && (
              <button
                type="button"
                onClick={onOpenTokens}
                style={{ ...btn, alignSelf: "flex-start" }}
              >
                learn more
              </button>
            )}
          </>
        )}

        {/* footer: back / skip / next|finish — pinned so the primary CTA stays visible while
            a tall step (e.g. the 40+ theme grid) scrolls above it at the min window height. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3, 6px)",
            marginTop: "var(--space-4, 8px)",
            position: "sticky",
            bottom: 0,
            background: "var(--bg-surface)",
            paddingTop: "var(--space-3, 6px)",
          }}
        >
          <button
            type="button"
            onClick={() => setStep(prevStep(step))}
            disabled={step === "welcome"}
            style={btn}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => finish(true)}
            style={{ ...btn, marginLeft: "auto", color: "var(--text-secondary)" }}
          >
            Skip
          </button>
          <button
            type="button"
            onClick={advance}
            // The label sits ON the `--brand` fill, so it needs the computed `--on-brand`.
            // `--brand-fg` is #ffffff on the dark scheme and measures 3.96:1 over `--brand` —
            // under the 4.5:1 a label carries. It stays in use where it is a FILL, not a label
            // (the Toggle knob), which is why this is a call-site change and not a token change.
            style={{ ...btn, background: "var(--brand)", color: "var(--on-brand)" }}
          >
            {step === "tokens" ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default OnboardingWizard;
