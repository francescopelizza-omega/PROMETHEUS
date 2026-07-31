/**
 * CustomThemeEditor.tsx — author your own theme (file 13 §3.3/§3.4).
 *
 * Pick a base → tweak the UI-token swatches → watch a live preview (scoped CSS vars, no
 * global flip) → a WCAG contrast badge updates per edit → Save runs the §3.4 gate. The
 * gate is fail-CLOSED on verdict tokens: a theme that makes ok/warn/danger/info
 * illegible CANNOT be saved (security legibility never yields to aesthetics); each
 * failure offers a one-click auto-fix. All logic is @prometheus/ui's `themes` namespace.
 */
import { Button, type ColorScheme, resolveScheme, themes } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useMemo, useState } from "react";

/** The UI-token rows the editor exposes (a representative subset of 08 SemanticColors). */
const EDITABLE: { key: string; label: string; group: string }[] = [
  { key: "bg-app", label: "bg-app", group: "Surfaces" },
  { key: "bg-surface", label: "bg-surface", group: "Surfaces" },
  { key: "bg-inset", label: "bg-inset", group: "Surfaces" },
  { key: "text-primary", label: "text-primary", group: "Text" },
  { key: "text-secondary", label: "text-secondary", group: "Text" },
  { key: "brand", label: "brand", group: "Brand / Accent" },
  { key: "accent", label: "accent", group: "Brand / Accent" },
  { key: "ok", label: "ok", group: "Verdict (locked legibility)" },
  { key: "warn", label: "warn", group: "Verdict (locked legibility)" },
  { key: "danger", label: "danger", group: "Verdict (locked legibility)" },
  { key: "info", label: "info", group: "Verdict (locked legibility)" },
];

// A native <input type="color"> REQUIRES a concrete #rrggbb value — it cannot take a
// CSS token. This is the one sanctioned hex in the renderer (the design-token rule is
// for paint, not for a color-picker's own control value).
const COLOR_INPUT_FALLBACK = "#000000"; // no-hex-allow

export interface CustomThemeEditorProps {
  baseScheme: ColorScheme;
  onCancel: () => void;
  onSaved: (file: themes.CustomThemeFile) => void;
}

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

/** The §3.3 custom-theme editor. */
export function CustomThemeEditor({
  baseScheme,
  onCancel,
  onSaved,
}: CustomThemeEditorProps): ReactElement {
  const [name, setName] = useState(`${baseScheme.name} (custom)`);
  const [overrides, setOverrides] = useState<Record<string, string>>({ ...baseScheme.tokens });

  // the working scheme = base + edits; everything below derives from it.
  const scheme: ColorScheme = useMemo(
    () => ({
      id: `custom-${baseScheme.id}`,
      name,
      base: baseScheme.base,
      builtin: false,
      filled: true,
      tokens: overrides,
    }),
    [baseScheme, name, overrides],
  );
  const resolved = useMemo(() => resolveScheme(scheme), [scheme]);
  const report = useMemo(() => themes.checkContrast(scheme), [scheme]);
  const previewVars = useMemo(() => themes.schemeAssets(scheme).cssVars, [scheme]);

  const file: themes.CustomThemeFile = useMemo(
    () => themes.schemeToCustomFile(scheme, { createdAt: nowIso(), baseScheme: baseScheme.id }),
    [scheme, baseScheme.id],
  );

  const setToken = (key: string, value: string): void =>
    setOverrides((o) => ({ ...o, [key]: value }));

  const save = (): void => {
    const outcome = themes.prepareSave(file);
    if (outcome.ok) onSaved(outcome.file);
  };

  const badgeRole = report.badge === "fail" ? "danger" : "ok";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4, 8px)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          flexWrap: "wrap",
        }}
      >
        <strong>Custom theme</strong>
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          aria-label="Theme name"
          style={{
            background: "var(--bg-inset)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "var(--space-1, 2px) var(--space-2, 4px)",
          }}
        />
        <span
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          base: {baseScheme.name}
        </span>
        <span
          style={{
            marginLeft: "auto",
            color: `var(--${badgeRole})`,
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          contrast:{" "}
          {report.badge === "fail" ? `✕ ${report.failures.length} fail` : `✓ ${report.badge}`} (
          {report.passCount}/{report.total} pass)
        </span>
      </header>

      <div
        style={{
          display: "flex",
          gap: "var(--space-4, 8px)",
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        {/* token editor */}
        <div
          style={{
            flex: "1 1 280px",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2, 4px)",
          }}
        >
          {EDITABLE.map((row) => {
            const value =
              overrides[row.key] ??
              resolved[row.key as keyof typeof resolved] ??
              COLOR_INPUT_FALLBACK;
            const fail = report.failures.find((f) => f.role === row.key);
            // APP-094: the live per-token WCAG verdict against its effective background.
            const verdict = themes.contrastVerdictFor(row.key, scheme);
            return (
              <div
                key={row.key}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-2, 4px)" }}
              >
                <input
                  type="color"
                  value={value.startsWith("#") ? value.slice(0, 7) : COLOR_INPUT_FALLBACK}
                  onChange={(e) => setToken(row.key, e.currentTarget.value)}
                  aria-label={`${row.label} color`}
                />
                <span
                  style={{
                    flex: 1,
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-small-size, 0.8125rem)",
                  }}
                >
                  {row.label}
                </span>
                {verdict.level !== "na" && (
                  <span
                    aria-label={`${row.label} contrast ${verdict.level}`}
                    title={`${verdict.ratio.toFixed(2)}:1 (needs ≥${verdict.required})`}
                    style={{
                      fontSize: "var(--text-small-size, 0.8125rem)",
                      fontVariantNumeric: "tabular-nums",
                      color:
                        verdict.level === "FAIL"
                          ? "var(--danger)"
                          : verdict.level === "AAA"
                            ? "var(--ok)"
                            : "var(--text-secondary)",
                    }}
                  >
                    {verdict.level}
                  </span>
                )}
                {fail && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setToken(
                        row.key,
                        themes.autoFix(fail.fg, fail.bg, fail.kind === "body" ? "text" : "ui"),
                      )
                    }
                  >
                    ⚠{fail.ratio.toFixed(1)} auto-fix
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {/* live preview — scoped CSS vars (no global flip) */}
        <div
          style={{
            ...(previewVars as unknown as CSSProperties),
            flex: "1 1 280px",
            minWidth: 0,
            background: "var(--bg-app)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-md, 6px)",
            padding: "var(--space-4, 8px)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <div style={{ color: "var(--text-primary)" }}>1 import os</div>
          <div style={{ color: "var(--text-primary)" }}>2 def run(cmd): ...</div>
          <div style={{ color: "var(--danger)" }}>3 os.system(cmd) ⛔ PROM-OS-EXEC-001</div>
          <div style={{ color: "var(--text-secondary)", marginTop: "var(--space-2, 4px)" }}>
            chrome · prom py3.12 · ⎇ main
          </div>
          <div style={{ color: "var(--ok)" }}>● 4 passed</div>
        </div>
      </div>

      {!themes.canSave(report) && (
        <p
          style={{
            color: "var(--danger)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            margin: 0,
          }}
        >
          {themes.blockReason(report)} — fix the verdict tokens (auto-fix above) to save.
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--space-3, 6px)", justifyContent: "flex-end" }}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!themes.canSave(report)} onClick={save}>
          Save to picker
        </Button>
      </div>
    </div>
  );
}

export default CustomThemeEditor;
